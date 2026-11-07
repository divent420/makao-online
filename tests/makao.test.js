'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../makao');

function state(overrides = {}) {
  return {
    rules: M.sanitizeRules(),
    players: [
      { id: 1, name: 'Alice', hand: ['5H', '2S'], wait: 0, out: false },
      { id: 2, name: 'Bob', hand: ['6H', '3D'], wait: 0, out: false },
    ],
    deck: ['7C', '8D', '9S'], discard: ['4H'], suit: 'H', turn: 0,
    pending: null, demand: null, drew: null, winner: null, log: [], deadline: 0,
    ...overrides,
  };
}

test('newGame deals the configured hand size and starts with a non-functional top card', () => {
  const game = M.newGame([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  assert.equal(game.players.length, 2);
  assert.deepEqual(game.players.map(p => p.hand.length), [5, 5]);
  assert.equal(game.deck.length + game.discard.length + game.players.reduce((n, p) => n + p.hand.length, 0), 52);
  assert.equal(M.isFunctional(game.discard.at(-1), game.rules), false);
  assert.notEqual(M.rank(game.discard.at(-1)), 'Q');
});

test('only the player whose turn it is can play', () => {
  const game = state();
  assert.deepEqual(M.play(game, 2, ['5H']), { error: 'Not your turn' });
  assert.deepEqual(M.play(game, 1, ['5H']), { ok: true });
  assert.equal(game.turn, 1);
});

test('rejects cards that are not in hand or are not legal', () => {
  const game = state();
  assert.equal(M.play(game, 1, ['9S']).error, 'Invalid cards');
  assert.equal(M.play(game, 1, ['2S']).error, "That card can't be played now");
  assert.deepEqual(game.players[0].hand, ['5H', '2S']);
});

test('a player can play a legal card they just drew', () => {
  const game = state({ players: [
    { id: 1, name: 'Alice', hand: ['8C'], wait: 0, out: false },
    { id: 2, name: 'Bob', hand: ['6D'], wait: 0, out: false },
  ], deck: ['7H'], rules: M.sanitizeRules({ makaoCall: false }) });
  assert.deepEqual(M.draw(game, 1), { ok: true });
  assert.equal(game.drew, '7H');
  assert.deepEqual(M.play(game, 1, ['7H']), { ok: true });
  assert.equal(game.turn, 1);
});

test('draw penalty can be stacked with another penalty', () => {
  const game = state({ pending: { type: 'draw', n: 2 } });
  assert.deepEqual(M.play(game, 1, ['2S']), { ok: true });
  assert.deepEqual(game.pending, { type: 'draw', n: 4 });
  assert.equal(game.turn, 1);
});

test('a player facing a draw penalty draws the accumulated amount', () => {
  const game = state({ pending: { type: 'draw', n: 2 } });
  assert.deepEqual(M.draw(game, 1), { ok: true });
  assert.equal(game.players[0].hand.length, 4);
  assert.equal(game.pending, null);
  assert.equal(game.turn, 1);
});

test('Makao call omission draws two cards when left with one card', () => {
  const game = state({
    players: [
      { id: 1, name: 'Alice', hand: ['5H', '8C'], wait: 0, out: false },
      { id: 2, name: 'Bob', hand: ['6H'], wait: 0, out: false },
    ],
  });
  assert.deepEqual(M.play(game, 1, ['5H'], { makao: false }), { ok: true });
  assert.equal(game.players[0].hand.length, 3);
});

test('functional cards cannot be used to finish when that rule is enabled', () => {
  const game = state({ players: [
    { id: 1, name: 'Alice', hand: ['2H'], wait: 0, out: false },
    { id: 2, name: 'Bob', hand: ['6H'], wait: 0, out: false },
  ] });
  assert.equal(M.play(game, 1, ['2H']).error, "You can't finish on a functional card");
  assert.equal(game.winner, null);
});

test('view exposes the current player hand but never opponents hands', () => {
  const game = state();
  const view = M.view(game, 1);
  assert.deepEqual(view.hand, ['5H', '2S'].sort());
  assert.equal(JSON.stringify(view).includes('6H'), false);
  assert.equal(JSON.stringify(view).includes('3D'), false);
});

test('Elo deltas are zero-sum and award the winner', () => {
  const deltas = M.elo([1000, 1000, 1000], 0);
  assert.ok(deltas[0] > 0);
  assert.ok(deltas[1] < 0);
  assert.ok(deltas[2] < 0);
  assert.equal(deltas.reduce((a, b) => a + b, 0), 0);
});


test('terminal game view exposes winner so clients can keep the final board visible', () => {
  const st = M.newGame([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
  st.winner = 0;
  const view = M.view(st, 1);
  assert.equal(view.winner, 0);
  assert.equal(view.myTurn, false);
});


test('supports multiple decks and larger starting hands', () => {
  const game = M.newGame([{ id: 1, name: 'A' }, { id: 2, name: 'B' }], { deckCount: 3, handSize: 12 });
  assert.deepEqual(game.players.map(p => p.hand.length), [12, 12]);
  assert.equal(game.deck.length + game.discard.length + game.players.reduce((n, p) => n + p.hand.length, 0), 156);
  assert.equal(game.rules.deckCount, 3);
  assert.equal(game.rules.handSize, 12);
});

test('clamps deck count and hand size to supported limits', () => {
  const rules = M.sanitizeRules({ deckCount: 99, handSize: 99 });
  assert.equal(rules.deckCount, 4);
  assert.equal(rules.handSize, 12);
});


test('duplicate physical cards in multi-deck games remain individually playable', () => {
  const game = state({
    rules: M.sanitizeRules({ deckCount: 2, makaoCall: false }),
    players: [
      { id: 1, name: 'Alice', hand: ['5H', '5H~2', '2S'], wait: 0, out: false },
      { id: 2, name: 'Bob', hand: ['6H'], wait: 0, out: false },
    ],
    discard: ['4H'], suit: 'H',
  });
  assert.deepEqual(M.play(game, 1, ['5H']), { ok: true });
  assert.deepEqual(game.players[0].hand, ['5H~2', '2S']);
  assert.equal(M.rank('5H~2'), '5');
  assert.equal(M.suit('5H~2'), 'H');
});
