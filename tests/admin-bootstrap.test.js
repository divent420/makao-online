'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ensureExistingFirstAdmin, insertUserWithFirstAdmin } = require('../admin-bootstrap');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created INTEGER NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

test('first successful registration becomes the only administrator', () => {
  const db = makeDb();
  insertUserWithFirstAdmin(db, 'firstPlayer', 's1', 'h1', 1);
  insertUserWithFirstAdmin(db, 'secondPlayer', 's2', 'h2', 2);
  insertUserWithFirstAdmin(db, 'thirdPlayer', 's3', 'h3', 3);

  const users = db.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
  assert.deepEqual(users.map(u => u.is_admin), [1, 0, 0]);
  db.close();
});

test('existing database users prevent a later registrant from becoming admin', () => {
  const db = makeDb();
  db.prepare('INSERT INTO users(username,salt,hash,created,is_admin) VALUES(?,?,?,?,?)')
    .run('existingPlayer', 's0', 'h0', 0, 0);

  insertUserWithFirstAdmin(db, 'newPlayer', 's1', 'h1', 1);
  const users = db.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
  assert.deepEqual(users.map(u => u.is_admin), [0, 0]);
  db.close();
});

test('duplicate username does not create another administrator', () => {
  const db = makeDb();
  insertUserWithFirstAdmin(db, 'firstPlayer', 's1', 'h1', 1);
  assert.throws(() => insertUserWithFirstAdmin(db, 'FIRSTPLAYER', 's2', 'h2', 2));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').get().n, 1);
  db.close();
});

test('existing installation promotes its oldest account when no admin exists', () => {
  const db = makeDb();
  db.prepare('INSERT INTO users(username,salt,hash,created,is_admin) VALUES(?,?,?,?,?)')
    .run('oldest', 's0', 'h0', 10, 0);
  db.prepare('INSERT INTO users(username,salt,hash,created,is_admin) VALUES(?,?,?,?,?)')
    .run('newer', 's1', 'h1', 20, 0);

  ensureExistingFirstAdmin(db);
  const users = db.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
  assert.deepEqual(users.map(u => [u.username, u.is_admin]), [['oldest', 1], ['newer', 0]]);
  db.close();
});

test('existing administrator is never replaced by bootstrap migration', () => {
  const db = makeDb();
  db.prepare('INSERT INTO users(username,salt,hash,created,is_admin) VALUES(?,?,?,?,?)')
    .run('oldest', 's0', 'h0', 10, 0);
  db.prepare('INSERT INTO users(username,salt,hash,created,is_admin) VALUES(?,?,?,?,?)')
    .run('currentAdmin', 's1', 'h1', 20, 1);

  ensureExistingFirstAdmin(db);
  const users = db.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
  assert.deepEqual(users.map(u => u.is_admin), [0, 1]);
  db.close();
});
