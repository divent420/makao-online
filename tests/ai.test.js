'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../makao');
const AI = require('../ai');

function game(overrides = {}) {
  return {
    rules: M.sanitizeRules(),
    players: [
      { id: -1, name: 'Bot', hand: ['5H', '2S', 'AS'], wait: 0, out: false },
      { id: 1, name: 'Human', hand: ['6H', '3D'], wait: 0, out: false },
    ], deck: ['7C', '8D'], discard: ['4H'], suit: 'H', turn: 0,
    pending: null, demand: null, drew: null, winner: null, log: [], deadline: 0,
    ...overrides,
  };
}

test('AI chooses a legal card and provides Makao when it will have one card left', () => {
  const st = game({ players: [
    { id: -1, name: 'Bot', hand: ['5H', '2S'], wait: 0, out: false },
    { id: 1, name: 'Human', hand: ['6H'], wait: 0, out: false },
  ] });
  const action = AI.decide(st, -1, 'normal');
  assert.equal(action.type, 'play');
  assert.equal(action.makao, true);
  assert.equal(M.play(st, -1, action.cards, action).error, undefined);
});

test('AI answers a pending draw penalty with a legal penalty card', () => {
  const st = game({ pending: { type: 'draw', n: 2 }, discard: ['2H'] });
  const action = AI.decide(st, -1, 'hard');
  assert.equal(action.type, 'play');
  assert.ok(action.cards.every(c => M.isFunctional(c, st.rules) && ['2','3','K'].includes(M.rank(c))));
});

test('AI waits on a pending skip rather than drawing', () => {
  const st = game({ pending: { type: 'skip', n: 1 }, discard: ['4H'] });
  assert.deepEqual(AI.decide(st, -1), { type: 'wait' });
});

test('AI chooses a suit with the most cards after an ace', () => {
  const st = game({ players: [
    { id: -1, name: 'Bot', hand: ['AH', '5S', '6S', '7D'], wait: 0, out: false },
    { id: 1, name: 'Human', hand: ['6H'], wait: 0, out: false },
  ] });
  const action = AI.decide(st, -1);
  assert.equal(action.type, 'play');
  assert.equal(action.suit, 'S');
});
