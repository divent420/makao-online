'use strict';
// Deterministic, inexpensive rule-based Makao opponents. All decisions still pass
// through makao.js so bots cannot bypass the authoritative game rules.
const M = require('./makao');
const rank = M.rank;
const suit = M.suit;
const SUIT_ORDER = ['S', 'H', 'D', 'C'];

function chooseSuit(hand) {
  const counts = Object.fromEntries(SUIT_ORDER.map(s => [s, 0]));
  for (const c of hand) counts[suit(c)]++;
  return SUIT_ORDER.sort((a, b) => counts[b] - counts[a])[0];
}

function scoreCard(card, hand, difficulty, game) {
  const r = rank(card);
  let score = 0;
  if (r === '2' || r === '3' || r === 'K') score += game.pending ? 12 : 5;
  if (r === '4') score += game.pending?.type === 'skip' ? 12 : 3;
  if (r === 'J') score += game.demand ? 10 : 4;
  if (r === 'A') score += 5;
  if (r === 'Q') score += 4;
  if (difficulty === 'hard') {
    // Prefer shedding ranks for which the bot has duplicates, but keep useful
    // control cards when the hand is otherwise balanced.
    score += hand.filter(c => c !== card && rank(c) === r).length * 2;
    if (hand.length <= 2 && ['2', '3', '4', 'J', 'A', 'K'].includes(r)) score -= 3;
  }
  return score;
}

function decide(game, botId, difficulty = 'normal') {
  const p = game.players.find(x => x.id === botId);
  if (!p || game.winner != null || game.players[game.turn]?.id !== botId) return null;
  const legal = p.hand.filter(c => M.legalFirst(game, c) && (!game.drew || c === game.drew));

  if (legal.length) {
    if (difficulty === 'easy') {
      for (let i = legal.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [legal[i], legal[j]] = [legal[j], legal[i]]; }
    } else legal.sort((a, b) => scoreCard(b, p.hand, difficulty, game) - scoreCard(a, p.hand, difficulty, game));
    const first = legal[0];
    const cards = game.rules.multiPlay ? legal.filter(c => rank(c) === rank(first)).slice(0, 4) : [first];
    const remaining = p.hand.length - cards.length;
    const opts = { makao: remaining === 1 || !game.rules.makaoCall };
    if (rank(first) === 'J' && game.rules.jack) {
      const counts = Object.fromEntries(M.DEMAND_RANKS.map(r => [r, p.hand.filter(c => rank(c) === r && !cards.includes(c)).length]));
      opts.demand = M.DEMAND_RANKS.sort((a, b) => counts[b] - counts[a])[0];
    }
    if (rank(first) === 'A' && game.rules.ace) opts.suit = chooseSuit(p.hand.filter(c => !cards.includes(c)));
    return { type: 'play', cards, ...opts };
  }
  if (game.pending?.type === 'skip') return { type: 'wait' };
  if (game.drew) return { type: 'pass' };
  return { type: 'draw' };
}

module.exports = { decide, chooseSuit };
