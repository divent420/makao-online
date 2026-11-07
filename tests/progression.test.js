'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const P = require('../progression');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT); CREATE TABLE games(id INTEGER PRIMARY KEY, finished INTEGER, winner_id INTEGER, players TEXT);`);
  db.prepare('INSERT INTO users(id,username) VALUES(1,?)').run('alice');
  P.initialize(db);
  return db;
}

test('level thresholds calculate progress and next-level XP', () => {
  assert.deepEqual(P.xpLevel(0), { level: 1, xpIntoLevel: 0, xpForNextLevel: 100 });
  assert.deepEqual(P.xpLevel(100), { level: 2, xpIntoLevel: 0, xpForNextLevel: 150 });
  assert.deepEqual(P.xpLevel(140), { level: 2, xpIntoLevel: 40, xpForNextLevel: 150 });
  assert.deepEqual(P.xpLevel(250), { level: 3, xpIntoLevel: 0, xpForNextLevel: 200 });
});

test('a first AI win awards XP, unlocks achievements and completes daily challenges', () => {
  const db = setup();
  db.prepare('INSERT INTO games(id,finished,winner_id,players) VALUES(1,?,?,?)').run(Date.UTC(2026,10,7),1,'{}');
  const playedAt = Date.UTC(2026,10,7,12);
  const award = P.awardProgress(db,1,1,true,true,false,['Mako Bot'],playedAt);
  const data = P.getProgression(db,1,playedAt);
  assert.equal(award.xpEarned, 140); // match + two daily challenges + three first-win achievements
  assert.equal(data.progress.xp, 140);
  assert.equal(data.progress.level, 2);
  assert.equal(data.progress.totalGames, 1);
  assert.equal(data.progress.totalWins, 1);
  assert.equal(data.progress.currentStreak, 1);
  assert.equal(data.achievements.filter(a => a.unlockedAt).length, 3);
  assert.equal(data.dailyChallenges.find(c => c.id === 'win_1').completed, true);
  assert.equal(data.dailyChallenges.find(c => c.id === 'ai_1').completed, true);
  assert.equal(data.history.length, 1);
  assert.deepEqual(data.history[0].opponents, ['Mako Bot']);
  db.close();
});

test('daily play challenge rewards only once and match history is idempotent', () => {
  const db = setup();
  const day = Date.UTC(2026,10,7,12);
  for (let id=1; id<=2; id++) db.prepare('INSERT INTO games(id,finished,winner_id,players) VALUES(?,?,?,?)').run(id,day+id,1,'{}');
  P.awardProgress(db,1,1,false,false,false,['Bob'],day);
  const second = P.awardProgress(db,1,2,false,false,false,['Carol'],day+1000);
  const duplicate = P.awardProgress(db,1,2,true,false,false,['Carol'],day+2000);
  const data = P.getProgression(db,1,day+3000);
  assert.equal(second.xpEarned, 45); // 15 match XP + 30 for completing play_2
  assert.equal(duplicate.duplicate, true);
  assert.equal(data.progress.totalGames, 2);
  assert.equal(data.progress.totalWins, 0);
  assert.equal(data.history.length, 2);
  assert.equal(data.dailyChallenges.find(c => c.id === 'play_2').completed, true);
  db.close();
});

test('a loss resets the current streak but preserves the best streak', () => {
  const db = setup();
  const day = Date.UTC(2026,10,7,12);
  for (let id=1; id<=4; id++) db.prepare('INSERT INTO games(id,finished,winner_id,players) VALUES(?,?,?,?)').run(id,day+id,1,'{}');
  P.awardProgress(db,1,1,true,false,false,['B'],day);
  P.awardProgress(db,1,2,true,false,false,['B'],day+1000);
  P.awardProgress(db,1,3,true,false,false,['B'],day+2000);
  P.awardProgress(db,1,4,false,false,false,['B'],day+3000);
  const p = P.getProgression(db,1,day+4000).progress;
  assert.equal(p.currentStreak,0);
  assert.equal(p.bestStreak,3);
  assert.equal(p.totalWins,3);
  db.close();
});
