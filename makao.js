'use strict';
// Makao rules engine (classic Polish rules). Pure logic, no I/O.
//
// Cards are strings like "10H", "QS", "AD": rank + suit (S=spades H=hearts D=diamonds C=clubs).
//
// Rules implemented
//  - 2-4 players, 5 cards each. Match the top card by suit or rank.
//  - You may play several cards of the same rank in one turn (first must be legal).
//  - 2 / 3 / K of hearts / K of spades: next player draws 2 / 3 / 5. These stack with each
//    other: while a penalty is pending you may answer with any 2, 3, K-hearts or K-spades.
//  - 4: next player waits a turn. 4s stack: answer with another 4 or wait.
//  - Jack: demand a rank 5-10 for one full round (everyone must play it, another Jack, or draw).
//  - Ace: choose the suit.
//  - Queen: wild, goes on anything, and anything goes on a Queen (outside penalties/demands).
//  - Draw one card if you can't (or don't want to) play; you may play that drawn card.
//  - Say "Makao" when you play down to one card, or draw 2 as a penalty.
//  - You can't finish on a functional card (2, 3, 4, J, A, K-hearts, K-spades).
//  - First to empty their hand wins.

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const DEMAND_RANKS = ['5', '6', '7', '8', '9', '10'];

const rank = (c) => c.slice(0, -1);
const suit = (c) => c.slice(-1);

// Table rules. The host can change these before a game starts. A game played with any
// rule other than the defaults is "casual" and does not change ratings (turnSeconds excepted).
const DEFAULT_RULES = {
  handSize: 5,                 // 3-7 cards dealt
  draw2: true,                 // 2: next player draws 2
  draw3: true,                 // 3: next player draws 3
  kings: true,                 // K of hearts / spades: next player draws 5
  stackPenalties: true,        // answer a pending penalty/wait with another one
  four: true,                  // 4: next player waits
  jack: true,                  // Jack demands a rank
  ace: true,                   // Ace chooses the suit
  queenWild: true,             // Queen on anything, anything on Queen
  multiPlay: true,             // several cards of one rank per turn
  playAfterDraw: true,         // may play the card you just drew
  makaoCall: true,             // must say Makao on the second-to-last card
  noFinishOnFunctional: true,  // can't win with a special card
  turnSeconds: 60,             // time before an idle player is auto-played (10-300)
};
const BOOL_RULES = Object.keys(DEFAULT_RULES).filter((k) => typeof DEFAULT_RULES[k] === 'boolean');

function sanitizeRules(inp) {
  const r = { ...DEFAULT_RULES };
  inp = inp && typeof inp === 'object' ? inp : {};
  for (const k of BOOL_RULES) if (k in inp) r[k] = !!inp[k];
  if ('handSize' in inp) r.handSize = Math.min(7, Math.max(3, Math.round(Number(inp.handSize)) || DEFAULT_RULES.handSize));
  if ('turnSeconds' in inp) r.turnSeconds = Math.min(300, Math.max(10, Math.round(Number(inp.turnSeconds)) || DEFAULT_RULES.turnSeconds));
  return r;
}
const isRanked = (rules) =>
  rules.handSize === DEFAULT_RULES.handSize && BOOL_RULES.every((k) => rules[k] === DEFAULT_RULES[k]);

const isPenalty = (c, R) => {
  const r = rank(c), s = suit(c);
  return (r === '2' && R.draw2) || (r === '3' && R.draw3) || (r === 'K' && R.kings && (s === 'H' || s === 'S'));
};
const isFunctional = (c, R = DEFAULT_RULES) =>
  isPenalty(c, R) || (rank(c) === '4' && R.four) || (rank(c) === 'J' && R.jack) || (rank(c) === 'A' && R.ace);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function fullDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return shuffle(d);
}

function newGame(list, rulesIn) {
  const rules = sanitizeRules(rulesIn);
  const deck = fullDeck();
  const players = list.map((p) => ({ id: p.id, name: p.name, hand: [], wait: 0, out: false }));
  for (let i = 0; i < rules.handSize; i++) for (const p of players) p.hand.push(deck.pop());
  const idx = deck.findIndex((c) => !isFunctional(c, rules) && !(rules.queenWild && rank(c) === 'Q'));
  const top = deck.splice(idx, 1)[0];
  return {
    rules, players, deck, discard: [top], suit: suit(top), turn: 0,
    pending: null, demand: null, drew: null, winner: null, log: [], deadline: 0,
  };
}

const activeCount = (st) => st.players.filter((p) => !p.out).length;
function nextActive(st, i) {
  const n = st.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (!st.players[j].out) return j;
  }
  return i;
}
const cur = (st) => st.players[st.turn];
const log = (st, s) => { st.log.push(s); if (st.log.length > 30) st.log.shift(); };

function drawCards(st, p, n) {
  let got = 0;
  for (let i = 0; i < n; i++) {
    if (!st.deck.length && st.discard.length > 1) {
      const top = st.discard.pop();
      st.deck = shuffle(st.discard);
      st.discard = [top];
    }
    if (!st.deck.length) break;
    p.hand.push(st.deck.pop());
    got++;
  }
  return got;
}

function legalFirst(st, c) {
  const R = st.rules, r = rank(c), s = suit(c);
  if (st.pending) {
    if (!R.stackPenalties) return false;
    if (st.pending.type === 'draw') return isPenalty(c, R);
    return r === '4';
  }
  if (st.demand) return r === st.demand.rank || (r === 'J' && R.jack);
  const top = st.discard[st.discard.length - 1];
  if (R.queenWild && (r === 'Q' || rank(top) === 'Q')) return true;
  return s === st.suit || r === rank(top);
}

function advance(st, skipTick) {
  st.drew = null;
  if (st.demand && !skipTick && --st.demand.left <= 0) st.demand = null;
  for (let guard = 0; guard < 100; guard++) {
    st.turn = nextActive(st, st.turn);
    const p = cur(st);
    if (p.wait > 0) {
      p.wait--;
      log(st, p.name + ' waits');
      if (st.demand && --st.demand.left <= 0) st.demand = null;
      continue;
    }
    break;
  }
}

function addPending(st, type, n) {
  if (st.pending && st.pending.type === type) st.pending.n += n;
  else st.pending = { type, n };
}

const err = (error) => ({ error });
const ok = () => ({ ok: true });

function checkTurn(st, pid) {
  if (st.winner != null) return 'The game is over';
  if (cur(st).id !== pid) return 'Not your turn';
  return null;
}

function play(st, pid, cards, opts = {}) {
  const e = checkTurn(st, pid);
  if (e) return err(e);
  const p = cur(st);
  if (!Array.isArray(cards) || !cards.length || cards.length > 4) return err('Pick some cards');
  if (!st.rules.multiPlay && cards.length > 1) return err('One card at a time at this table');
  if (new Set(cards).size !== cards.length || !cards.every((c) => p.hand.includes(c))) return err('Invalid cards');
  const r = rank(cards[0]);
  if (!cards.every((c) => rank(c) === r)) return err('Cards in one play must share a rank');
  if (st.drew && !(cards.length === 1 && cards[0] === st.drew)) return err('You can only play the card you just drew');
  if (!legalFirst(st, cards[0])) return err("That card can't be played now");
  if (st.pending && !cards.every((c) => legalFirst(st, c))) return err("That card can't be played now");
  const last = cards[cards.length - 1];
  if (st.rules.noFinishOnFunctional && p.hand.length === cards.length && isFunctional(last, st.rules)) {
    return err("You can't finish on a functional card");
  }
  if (r === 'J' && st.rules.jack && !DEMAND_RANKS.includes(opts.demand)) return err('Choose a rank to demand (5-10)');
  if (r === 'A' && st.rules.ace && !SUITS.includes(opts.suit)) return err('Choose a suit');

  p.hand = p.hand.filter((c) => !cards.includes(c));
  let jack = false;
  for (const c of cards) {
    st.discard.push(c);
    st.suit = suit(c);
    const cr = rank(c), cs = suit(c);
    const R = st.rules;
    if (cr === '2' && R.draw2) addPending(st, 'draw', 2);
    else if (cr === '3' && R.draw3) addPending(st, 'draw', 3);
    else if (cr === 'K' && R.kings && (cs === 'H' || cs === 'S')) addPending(st, 'draw', 5);
    else if (cr === '4' && R.four) addPending(st, 'skip', 1);
    else if (cr === 'J' && R.jack) jack = true;
  }
  if (r === 'A' && st.rules.ace) st.suit = opts.suit;
  if (jack) st.demand = { rank: opts.demand, left: activeCount(st) - 1 };

  let msg = p.name + ' played ' + cards.join(' ');
  if (jack) msg += ' and demands ' + opts.demand;
  if (r === 'A' && st.rules.ace) msg += ' and chose ' + opts.suit;
  log(st, msg);

  if (!p.hand.length) {
    st.winner = st.turn;
    log(st, p.name + ' wins!');
    return ok();
  }
  if (p.hand.length === 1 && st.rules.makaoCall) {
    if (opts.makao) log(st, p.name + ' says Makao!');
    else { drawCards(st, p, 2); log(st, p.name + ' forgot to say Makao and draws 2'); }
  }
  advance(st, jack);
  return ok();
}

function draw(st, pid) {
  const e = checkTurn(st, pid);
  if (e) return err(e);
  const p = cur(st);
  if (st.pending && st.pending.type === 'skip') return err('Play a 4 or wait');
  if (st.drew) return err('You already drew: play that card or pass');
  if (st.pending) {
    const got = drawCards(st, p, st.pending.n);
    log(st, p.name + ' draws ' + got);
    st.pending = null;
    advance(st, false);
    return ok();
  }
  const got = drawCards(st, p, 1);
  if (!got) { log(st, p.name + " can't draw"); advance(st, false); return ok(); }
  log(st, p.name + ' draws a card');
  const c = p.hand[p.hand.length - 1];
  if (st.rules.playAfterDraw && legalFirst(st, c)) st.drew = c; else advance(st, false);
  return ok();
}

function wait(st, pid) {
  const e = checkTurn(st, pid);
  if (e) return err(e);
  if (!(st.pending && st.pending.type === 'skip')) return err('Nothing to wait for');
  const p = cur(st);
  p.wait = st.pending.n - 1;
  log(st, p.name + ' waits' + (st.pending.n > 1 ? ' (' + st.pending.n + ' turns)' : ''));
  st.pending = null;
  advance(st, false);
  return ok();
}

function pass(st, pid) {
  const e = checkTurn(st, pid);
  if (e) return err(e);
  if (!st.drew) return err('Draw a card first');
  log(st, cur(st).name + ' passes');
  advance(st, false);
  return ok();
}

// Used when a turn times out.
function autoPlay(st) {
  const id = cur(st).id;
  if (st.drew) return pass(st, id);
  if (st.pending && st.pending.type === 'skip') return wait(st, id);
  const r = draw(st, id);
  if (st.drew && st.winner == null) pass(st, id);
  return r;
}

function forfeit(st, pid) {
  const idx = st.players.findIndex((p) => p.id === pid);
  if (idx < 0 || st.players[idx].out || st.winner != null) return;
  const p = st.players[idx];
  log(st, p.name + ' left the game');
  p.out = true;
  st.deck.unshift(...p.hand);
  p.hand = [];
  if (activeCount(st) === 1) {
    st.winner = st.players.findIndex((x) => !x.out);
    log(st, st.players[st.winner].name + ' wins!');
    return;
  }
  if (st.turn === idx) advance(st, false);
}

function view(st, pid) {
  const me = st.players.find((p) => p.id === pid);
  const myTurn = !!me && st.winner == null && cur(st).id === pid;
  const hand = me ? [...me.hand].sort((a, b) =>
    SUITS.indexOf(suit(a)) - SUITS.indexOf(suit(b)) || RANKS.indexOf(rank(a)) - RANKS.indexOf(rank(b))) : [];
  return {
    players: st.players.map((p, i) => ({
      id: p.id, name: p.name, count: p.hand.length, wait: p.wait, out: p.out,
      turn: i === st.turn && st.winner == null,
    })),
    hand, myTurn,
    legal: myTurn ? hand.filter((c) => legalFirst(st, c) && (!st.drew || c === st.drew)) : [],
    top: st.discard[st.discard.length - 1], suit: st.suit,
    pending: st.pending, demand: st.demand ? { rank: st.demand.rank } : null,
    drew: myTurn ? st.drew : null,
    deckCount: st.deck.length, log: st.log.slice(-8), deadline: st.deadline, rules: st.rules,
  };
}

// Rating changes: winner beats every opponent; zero-sum, scaled by table size.
function elo(ratings, winnerIdx) {
  const n = ratings.length, K = 32 / (n - 1), d = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === winnerIdx) continue;
    const expected = 1 / (1 + Math.pow(10, (ratings[i] - ratings[winnerIdx]) / 400));
    const delta = K * (1 - expected);
    d[winnerIdx] += delta; d[i] -= delta;
  }
  return d.map(Math.round);
}

module.exports = {
  SUITS, RANKS, DEMAND_RANKS, DEFAULT_RULES, sanitizeRules, isRanked,
  rank, suit, isFunctional, newGame, legalFirst,
  play, draw, wait, pass, autoPlay, forfeit, view, elo,
};
