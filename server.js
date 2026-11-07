'use strict';
// Makao online - zero-dependency server (Node 22+).
// Accounts (scrypt + sessions), lobbies, live games over SSE, Elo rankings in SQLite.
// Run: node server.js  ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const M = require('./makao');
const AI = require('./ai');
const Progression = require('./progression');
const Shop = require('./shop');
const Social = require('./social');
const Tournaments = require('./tournaments');
const { ensureExistingFirstAdmin, insertUserWithFirstAdmin } = require('./admin-bootstrap');

const PORT = process.env.PORT || 3000;
const TURN_MS = Number(process.env.TURN_MS) || 60000;          // time to act before auto-play
const GAME_GRACE_MS = 60000;                                    // reconnect window during a game
const LOBBY_GRACE_MS = 15000;                                   // reconnect window in a lobby
const SESSION_MS = 30 * 24 * 3600 * 1000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'makao.db');

// ---------- database ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt TEXT NOT NULL, hash TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1000,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '🂡',
  bio TEXT NOT NULL DEFAULT 'Ready to play Makao',
  is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS games(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished INTEGER NOT NULL, winner_id INTEGER, players TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS active_rooms(
  room_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated INTEGER NOT NULL);
`);
Progression.initialize(db);
Shop.initialize(db);
Social.initialize(db);
Tournaments.initialize(db);
// Safe migrations for databases created by earlier versions.
for (const [name, def] of [['is_admin', 'INTEGER NOT NULL DEFAULT 0'], ['display_name', "TEXT NOT NULL DEFAULT ''"], ['avatar', "TEXT NOT NULL DEFAULT '🂡'"], ['bio', "TEXT NOT NULL DEFAULT 'Ready to play Makao'"]]) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
}
// Preserve existing accounts: if no admin exists yet, promote the oldest account.
ensureExistingFirstAdmin(db);

const q = {
  byName: db.prepare('SELECT * FROM users WHERE username=?'),
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  insSession: db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)'),
  byToken: db.prepare('SELECT u.*, s.created AS s_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'),
  delToken: db.prepare('DELETE FROM sessions WHERE token=?'),
  top: db.prepare('SELECT id,username,display_name,avatar,rating,games,wins FROM users WHERE games>0 ORDER BY rating DESC, wins DESC, games ASC LIMIT 50'),
  upd: db.prepare('UPDATE users SET rating=?, games=games+1, wins=wins+? WHERE id=?'),
  insGame: db.prepare('INSERT INTO games(finished,winner_id,players) VALUES(?,?,?)'),
  saveRoom: db.prepare('INSERT INTO active_rooms(room_id,snapshot,updated) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET snapshot=excluded.snapshot, updated=excluded.updated'),
  delRoom: db.prepare('DELETE FROM active_rooms WHERE room_id=?'),
  activeRooms: db.prepare('SELECT room_id,snapshot FROM active_rooms ORDER BY updated'),
};



// ---------- accounts ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const userView = (u) => ({ id: u.id, username: u.username, displayName: u.display_name || u.username, avatar: u.avatar || '🂡', bio: u.bio || '', rating: u.rating, games: u.games, wins: u.wins, isAdmin: !!u.is_admin });

function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return { error: 'Username: 3-16 letters, digits or _' };
  if (password.length < 6 || password.length > 100) return { error: 'Password must be 6-100 characters' };
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = insertUserWithFirstAdmin(db, username, salt, hashPw(password, salt), Date.now());
    return { user: q.byId.get(Number(r.lastInsertRowid)) };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return { error: 'That username is taken' };
    throw e;
  }
}
function login(username, password) {
  const u = q.byName.get(String(username || '').trim());
  const salt = u ? u.salt : '0'.repeat(32);
  const h = Buffer.from(hashPw(String(password || ''), salt), 'hex');
  if (!u || !crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return { error: 'Wrong username or password' };
  return { user: u };
}
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insSession.run(token, uid, Date.now());
  return token;
}
function userByToken(token) {
  if (!token) return null;
  const u = q.byToken.get(String(token));
  if (!u) return null;
  if (Date.now() - u.s_created > SESSION_MS) { q.delToken.run(token); return null; }
  return u;
}

// crude brute-force limiter for login/register: 20 tries / 10 min per IP
const tries = new Map();
function limited(ip) {
  const now = Date.now();
  const t = tries.get(ip) || { n: 0, reset: now + 600000 };
  if (now > t.reset) { t.n = 0; t.reset = now + 600000; }
  t.n++; tries.set(ip, t);
  return t.n > 20;
}

// ---------- rooms & presence ----------
const rooms = new Map();        // roomId -> room
const userRoom = new Map();     // userId -> roomId
const online = new Map();       // userId -> { res }
const dcTimers = new Map();     // userId -> timeout
const matchmakingQueue = new Map(); // userId -> queuedAt
const actionWindows = new Map(); // userId -> { startedAt, count }
const uname = (id) => { const u = q.byId.get(id); return u ? u.username : '?'; };
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

// Persist only serializable room state. Timers and live HTTP responses are rebuilt
// after a restart; game state, membership, rules and chat survive.
function persistRoom(room) {
  if (!room) return;
  const snapshot = {
    id: room.id, name: room.name, host: room.host, max: room.max,
    members: room.members, game: room.game, lastGame: room.lastGame || null, rematchVotes: room.rematchVotes || [], chat: room.chat,
    result: room.result, rules: room.rules, aiGame: !!room.aiGame, aiDifficulty: room.aiDifficulty || 'normal',
    tournamentId: room.tournamentId || null, tournamentMatchId: room.tournamentMatchId || null,
  };
  q.saveRoom.run(room.id, JSON.stringify(snapshot), Date.now());
}
function deleteRoomSnapshot(roomId) {
  q.delRoom.run(roomId);
}

function roomView(r) {
  return {
    id: r.id, name: r.name, host: r.host, max: r.max, playing: !!r.game || !!r.result, aiGame: !!r.aiGame, tournament: !!r.tournamentId,
    rules: r.rules, ranked: !r.aiGame && !r.tournamentId && M.isRanked(r.rules),
    members: r.members.map((id) => { const u = q.byId.get(id); return { id, username: u.username, displayName: u.display_name || u.username, avatar: u.avatar || '🂡', rating: u.rating, online: online.has(id) }; }),
    chat: r.chat.slice(-40), result: r.result, rematchVotes: r.rematchVotes || [],
  };
}
function stateFor(uid) {
  const u = q.byId.get(uid);
  const room = rooms.get(userRoom.get(uid));
  return {
    t: 'state', me: userView(u),
    lobbies: [...rooms.values()].map((r) => ({
      id: r.id, name: r.name, host: uname(r.host), count: r.members.length, max: r.max, playing: !!r.game || !!r.result,
      ranked: !r.tournamentId && M.isRanked(r.rules),
    })),
    room: room ? roomView(room) : null,
    matchmaking: matchmakingQueue.has(uid) ? { waiting: true, since: matchmakingQueue.get(uid) } : { waiting: false },
    game: room && (room.game || (room.result && room.lastGame)) ? M.view(room.game || room.lastGame, uid) : null,
  };
}
function pushAll() {
  for (const [uid, c] of online) {
    try { c.res.write('data: ' + JSON.stringify(stateFor(uid)) + '\n\n'); } catch (e) { /* closed */ }
  }
}

// ---------- game flow ----------
function runBotTurn(room) {
  if (!room.game || room.game.winner != null) return;
  const current = room.game.players[room.game.turn];
  if (!current || current.id >= 0) return;
  const action = AI.decide(room.game, current.id, room.aiDifficulty || 'normal');
  if (!action) return;
  let result;
  if (action.type === 'play') result = M.play(room.game, current.id, action.cards, action);
  else result = M[action.type](room.game, current.id);
  if (result && !result.error) afterAction(room);
  else { // Fail safe: avoid a bot holding the table forever if an edge case occurs.
    const fallback = M.autoPlay(room.game);
    if (!fallback.error) afterAction(room);
  }
}

function armTimer(room, restoring = false) {
  clearTimeout(room.timer);
  if (!room.game || room.game.winner != null) return;
  const current = room.game.players[room.game.turn];
  const isBot = current && current.id < 0;
  const now = Date.now();
  const savedDeadline = Number(room.game.deadline);
  const ms = isBot ? 900 : (restoring && Number.isFinite(savedDeadline)
    ? Math.max(0, savedDeadline - now)
    : room.rules.turnSeconds * 1000);
  room.game.deadline = now + ms;
  room.timer = setTimeout(() => {
    if (!room.game) return;
    if (isBot) runBotTurn(room);
    else { M.autoPlay(room.game); afterAction(room); }
  }, ms);
  persistRoom(room);
}

// Recover active rooms before accepting connections. A corrupt snapshot is
// discarded safely rather than preventing the server from starting.
function restoreRooms() {
  for (const row of q.activeRooms.all()) {
    try {
      const saved = JSON.parse(row.snapshot);
      if (!saved || saved.id !== row.room_id || !Array.isArray(saved.members) ||
          !saved.members.length || !saved.rules ||
          saved.members.some((id) => !q.byId.get(id))) {
        throw new Error('Invalid room snapshot');
      }
      if (saved.game && (!Array.isArray(saved.game.players) ||
          saved.game.players.some((p) => p.id > 0 && !q.byId.get(p.id)))) {
        throw new Error('Invalid saved game');
      }
      const room = {
        id: saved.id, name: str(saved.name, 30), host: saved.members.includes(saved.host) ? saved.host : saved.members[0],
        max: Math.min(4, Math.max(2, Number(saved.max) || 4)),
        members: saved.members, game: saved.game || null,
        chat: Array.isArray(saved.chat) ? saved.chat.slice(-100) : [],
        result: saved.result || null, lastGame: saved.lastGame || null, rematchVotes: Array.isArray(saved.rematchVotes) ? saved.rematchVotes : [], timer: null, aiGame: !!saved.aiGame, aiDifficulty: saved.aiDifficulty || 'normal',
        tournamentId: saved.tournamentId || null, tournamentMatchId: saved.tournamentMatchId || null,
        rules: M.sanitizeRules(saved.rules),
      };
      if (room.members.some((id) => userRoom.has(id))) throw new Error('Player appears in multiple rooms');
      rooms.set(room.id, room);
      for (const id of room.members) {
        userRoom.set(id, room.id);
        dcTimers.set(id, setTimeout(() => { if (!online.has(id)) leaveRoom(id); }, room.game ? GAME_GRACE_MS : LOBBY_GRACE_MS));
      }
      if (room.game && room.game.winner == null) armTimer(room, true);
      else persistRoom(room);
    } catch (error) {
      console.warn('Discarding invalid active room snapshot:', row.room_id, error.message);
      deleteRoomSnapshot(row.room_id);
    }
  }
  if (rooms.size) console.log('Restored ' + rooms.size + ' active Makao room(s)');
}

function finishGame(room) {
  clearTimeout(room.timer);
  const st = room.game;
  const players = st.players;
  const humanRows = players.filter((p) => p.id > 0).map((p) => q.byId.get(p.id)).filter(Boolean);
  const ranked = !room.aiGame && !room.tournamentId && M.isRanked(room.rules);
  const deltas = ranked ? M.elo(humanRows.map((u) => u.rating), players.findIndex(p => p.id === players[st.winner].id)) : humanRows.map(() => 0);
  const playedAt = Date.now();
  const result = { id: playedAt, ranked, tournament: !!room.tournamentId, winner: st.players[st.winner].name, winnerId: st.players[st.winner].id, rows: [] };
  db.exec('BEGIN');
  try {
    humanRows.forEach((u, i) => {
      const player = players.find(p => p.id === u.id);
      const won = player && players.indexOf(player) === st.winner;
      if (ranked) {
        const nr = Math.max(100, u.rating + deltas[i]);
        q.upd.run(nr, won ? 1 : 0, u.id);
        result.rows.push({ username: u.username, delta: nr - u.rating, rating: nr, won });
      } else result.rows.push({ username: u.username, delta: 0, rating: u.rating, won });
    });
    for (const bot of players.filter(p => p.id < 0)) result.rows.push({ username: bot.name, delta: 0, rating: 0, won: players.indexOf(bot) === st.winner });
    const gameInsert = q.insGame.run(playedAt, result.winnerId, JSON.stringify({ ranked, aiGame: !!room.aiGame, rules: room.rules, rows: result.rows }));
    const gameId = Number(gameInsert.lastInsertRowid);
    for (const player of players.filter(p => p.id > 0)) {
      const won = players.indexOf(player) === st.winner;
      const opponents = players.filter(p => p.id !== player.id).map(p => p.name);
      Progression.awardProgress(db,player.id,gameId,won,!!room.aiGame,ranked,opponents,playedAt);
      Shop.awardMatchCoins(db,player.id,won,!!room.aiGame,playedAt);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (room.tournamentId && result.winnerId > 0) {
    const advanced = Tournaments.completeMatch(db, room.tournamentId, room.tournamentMatchId, result.winnerId, playedAt);
    if (advanced.error) console.warn('Tournament advancement failed:', advanced.error);
  }
  room.lastGame = structuredClone(st); // Keep the terminal board visible after the final move.
  room.result = result;
  room.rematchVotes = [];
  room.game = null;
}
function afterAction(room) {
  if (room.game && room.game.winner != null) finishGame(room);
  else armTimer(room);
  persistRoom(room);
  pushAll();
}

function leaveRoom(uid) {
  clearTimeout(dcTimers.get(uid));
  dcTimers.delete(uid);
  const room = rooms.get(userRoom.get(uid));
  if (!room) return;
  if (room.game) M.forfeit(room.game, uid);
  room.members = room.members.filter((id) => id !== uid);
  room.rematchVotes = (room.rematchVotes || []).filter((id) => id !== uid);
  userRoom.delete(uid);
  if (!room.members.length) {
    clearTimeout(room.timer);
    rooms.delete(room.id);
    deleteRoomSnapshot(room.id);
  } else {
    if (room.host === uid) room.host = room.members[0];
    if (room.game && room.game.winner != null) finishGame(room);
    else armTimer(room);
    persistRoom(room);
  }
  pushAll();
}

function handleAct(user, m) {
  const uid = user.id;
  const room = rooms.get(userRoom.get(uid));
  switch (m.t) {
    case 'quickMatch': {
      if (room) return { error: 'Leave your current table first' };
      if (matchmakingQueue.has(uid)) return { ok: true, waiting: true };
      matchmakingQueue.set(uid, Date.now());
      // Remove abandoned queue entries, then widen the Elo window as players wait.
      for (const [id, joinedAt] of matchmakingQueue) if (Date.now() - joinedAt > 120000 || !online.has(id)) matchmakingQueue.delete(id);
      const myRating = q.byId.get(uid).rating;
      const candidates = [...matchmakingQueue.entries()].filter(([id, joinedAt]) => {
        if (id === uid || userRoom.has(id) || !online.has(id) || Social.isBlocked(db, uid, id)) return false;
        const other = q.byId.get(id);
        if (!other) return false;
        const waited = Math.max(Date.now() - joinedAt, Date.now() - matchmakingQueue.get(uid));
        const maxGap = waited < 10000 ? 150 : waited < 20000 ? 250 : waited < 30000 ? 400 : Infinity;
        return Math.abs(myRating - other.rating) <= maxGap;
      });
      if (candidates.length) {
        const [otherId] = candidates.sort((a, b) => Math.abs(myRating - q.byId.get(a[0]).rating) - Math.abs(myRating - q.byId.get(b[0]).rating) || a[1] - b[1])[0];
        matchmakingQueue.delete(uid); matchmakingQueue.delete(otherId);
        const id = crypto.randomBytes(4).toString('hex');
        const ids = [otherId, uid];
        const members = ids.map(id => q.byId.get(id)).filter(Boolean);
        const r = { id, name: 'Quick Match', host: otherId, max: 2, members: ids,
          game: null, lastGame: null, rematchVotes: [], chat: [], result: null, timer: null, aiGame: false, aiDifficulty: 'normal',
          rules: { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 } };
        const list = members.map(u => ({ id: u.id, name: u.display_name || u.username }));
        for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
        r.game = M.newGame(list, r.rules); rooms.set(id, r); ids.forEach(x => userRoom.set(x, id));
        persistRoom(r);
      }
      pushAll(); return { ok: true, waiting: matchmakingQueue.has(uid) };
    }
    case 'cancelMatch': matchmakingQueue.delete(uid); pushAll(); return { ok: true };
    case 'playAI': {
      if (room) return { error: 'Leave your current table first' };
      matchmakingQueue.delete(uid);
      const count = Math.min(3, Math.max(1, Number(m.count) || 2));
      const difficulty = ['easy', 'normal', 'hard'].includes(m.difficulty) ? m.difficulty : 'normal';
      const id = crypto.randomBytes(4).toString('hex');
      const list = [{ id: uid, name: user.display_name || user.username }];
      for (let i = 0; i < count; i++) list.push({ id: -(i + 1), name: ['Mako Bot', 'Card Shark', 'The Dealer'][i] });
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      const r = { id, name: 'AI Practice', host: uid, max: list.length, members: [uid], game: M.newGame(list, { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 }),
        chat: [], result: null, lastGame: null, rematchVotes: [], timer: null, aiGame: true, aiDifficulty: difficulty,
        rules: { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 } };
      rooms.set(id, r); userRoom.set(uid, id); persistRoom(r); armTimer(r); pushAll();
      return { ok: true };
    }
    case 'rematchAI': {
      if (!room || !room.aiGame || room.game) return { error: 'AI rematch is not available' };
      const human = q.byId.get(uid);
      const bots = room.result?.rows?.filter(x => x.username && x.username !== human.username) || [];
      const count = Math.min(3, Math.max(1, bots.length || room.max - 1 || 2));
      const list = [{ id: uid, name: human.display_name || human.username }];
      for (let i = 0; i < count; i++) list.push({ id: -(i + 1), name: ['Mako Bot', 'Card Shark', 'The Dealer'][i] });
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      room.game = M.newGame(list, room.rules); room.lastGame = null; room.rematchVotes = []; room.result = null; persistRoom(room); armTimer(room); pushAll();
      return { ok: true };
    }
    case 'rematch': {
      if (!room || room.game || !room.result || room.aiGame || room.tournamentId) return { error: 'A player rematch is not available' };
      if (room.members.length < 2) return { error: 'At least two players are required' };
      if (!room.rematchVotes.includes(uid)) room.rematchVotes.push(uid);
      const votes = room.rematchVotes.length;
      if (votes >= room.members.length) {
        const list = room.members.map((id) => { const u=q.byId.get(id); return { id, name:u.display_name || u.username }; });
        for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
        room.game = M.newGame(list, room.rules); room.lastGame = null; room.result = null; room.rematchVotes = [];
        armTimer(room); persistRoom(room); pushAll(); return { ok: true, started: true };
      }
      persistRoom(room); pushAll(); return { ok: true, votes, required: room.members.length };
    }
    case 'createRoom': {
      if (room) return { error: 'You are already at a table' };
      const id = crypto.randomBytes(4).toString('hex');
      rooms.set(id, {
        id, name: str(m.name, 30).trim() || user.username + "'s table",
        host: uid, max: Math.min(4, Math.max(2, m.max | 0 || 4)),
        members: [uid], game: null, lastGame: null, rematchVotes: [], chat: [], result: null, timer: null,
        rules: { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 }, aiGame: false, aiDifficulty: 'normal',
      });
      userRoom.set(uid, id);
      persistRoom(rooms.get(id));
      break;
    }
    case 'joinRoom': {
      if (room) return { error: 'You are already at a table' };
      const r = rooms.get(str(m.id, 20));
      if (!r) return { error: 'That table no longer exists' };
      if (r.game || r.result) return { error: 'That table has already played; create a new table or request a rematch' };
      if (r.members.some(id => Social.isBlocked(db, uid, id))) return { error: 'You cannot join a table with a player you have blocked or who blocked you' };
      if (r.members.length >= r.max) return { error: 'That table is full' };
      r.members.push(uid); userRoom.set(uid, r.id);
      r.result = null; r.lastGame = null; r.rematchVotes = [];
      persistRoom(r);
      break;
    }
    case 'setRules': {
      if (!room || room.host !== uid) return { error: 'Only the host can change the rules' };
      if (room.game) return { error: "Rules can't change during a game" };
      const next = M.sanitizeRules(m.rules);
      if (JSON.stringify(next) !== JSON.stringify(room.rules)) {
        room.rules = next;
        const note = user.username + ' changed the rules';
        const last = room.chat[room.chat.length - 1];
        if (last && last.from === 'Table' && last.text === note) last.ts = Date.now();
        else room.chat.push({ from: 'Table', text: note, ts: Date.now() });
        persistRoom(room);
      }
      break;
    }
    case 'leaveRoom': leaveRoom(uid); return { ok: true };
    case 'start': {
      if (!room || room.host !== uid) return { error: 'Only the host can start' };
      if (room.game) return { error: 'Already started' };
      if (room.members.length < 2) return { error: 'Need at least 2 players' };
      const list = room.members.map((id) => { const u=q.byId.get(id); return { id, name:u.display_name || u.username }; });
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      room.game = M.newGame(list, room.rules);
      room.lastGame = null; room.rematchVotes = []; room.result = null;
      armTimer(room);
      break;
    }
    case 'play': case 'draw': case 'wait': case 'pass': {
      if (!room || !room.game) return { error: 'No game running' };
      const st = room.game;
      const r = m.t === 'play'
        ? M.play(st, uid, Array.isArray(m.cards) ? m.cards.map((c) => str(c, 3)) : [], { demand: str(m.demand, 3), suit: str(m.suit, 1), makao: !!m.makao })
        : M[m.t](st, uid);
      if (r.error) return r;
      afterAction(room);
      return { ok: true };
    }
    case 'chat': {
      if (!room) return { error: 'Join a table first' };
      const text = str(m.text, 200).trim();
      if (text) { room.chat.push({ from: user.username, text, ts: Date.now() }); if (room.chat.length > 100) room.chat.shift(); persistRoom(room); }
      break;
    }
    default: return { error: 'Unknown action' };
  }
  pushAll();
  return { ok: true };
}

// ---------- http ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); } });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(url.pathname.slice('/assets/'.length));
    const base = path.resolve(__dirname, 'assets');
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    const types = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2' };
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('asset not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'public, max-age=86400' });
      res.end(buf);
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'makao-online', uptimeSeconds: Math.floor(process.uptime()), timestamp: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
    if (limited(ipOf(req))) return send(res, 429, { error: 'Too many attempts, try again later' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const r = url.pathname === '/api/register' ? register(m.username, m.password) : login(m.username, m.password);
      if (r.error) return send(res, 400, { error: r.error });
      send(res, 200, { token: newSession(r.user.id), user: userView(r.user) });
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const u = userByToken(req.headers['x-token']);
    return u ? send(res, 200, { user: userView(u) }) : send(res, 401, { error: 'Not signed in' });
  }

  // Public player cards: expose only fields intended for the in-game profile.
  if (req.method === 'GET' && url.pathname.startsWith('/api/players/')) {
    const viewer = userByToken(req.headers['x-token']);
    if (!viewer) return send(res, 401, { error: 'Not signed in' });
    const id = Number(url.pathname.slice('/api/players/'.length));
    if (!Number.isSafeInteger(id) || id < 1) return send(res, 400, { error: 'Invalid player' });
    const player = q.byId.get(id);
    if (!player) return send(res, 404, { error: 'Player not found' });
    return send(res, 200, { user: userView(player) });
  }

  if (req.method === 'POST' && url.pathname === '/api/profile') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const displayName = String(m.displayName || '').trim().slice(0, 20);
      const bio = String(m.bio || '').trim().slice(0, 80);
      const allowed = ['🂡','😎','🦊','🐺','🐱','🐼','🐸','👑','🔥','🎯','🦄','🐉'];
      const avatar = allowed.includes(m.avatar) ? m.avatar : '🂡';
      if (displayName.length < 2) return send(res, 400, { error: 'Display name must be 2-20 characters' });
      db.prepare('UPDATE users SET display_name=?, avatar=?, bio=? WHERE id=?').run(displayName, avatar, bio, user.id);
      const updated = q.byId.get(user.id);
      pushAll();
      return send(res, 200, { user: userView(updated) });
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const t = req.headers['x-token'];
    if (t) { const u = userByToken(t); if (u) matchmakingQueue.delete(u.id); q.delToken.run(String(t)); }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/progression') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, Progression.getProgression(db, user.id));
  }

  if (req.method === 'GET' && url.pathname === '/api/tournaments') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, Tournaments.getTournaments(db, user.id));
  }

  if (req.method === 'POST' && url.pathname === '/api/tournaments/join') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Tournaments.join(db, user.id, m.tournamentId);
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/tournaments/start-match') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      if (userRoom.has(user.id)) return send(res, 400, { error: 'Leave your current table first' });
      const match = Tournaments.getMatchForStart(db, user.id, m.matchId);
      if (!match) return send(res, 404, { error: 'No ready tournament match found for you' });
      if (userRoom.has(match.player1_id) || userRoom.has(match.player2_id)) return send(res, 400, { error: 'Both players must leave their current tables first' });
      if (Social.isBlocked(db, match.player1_id, match.player2_id)) return send(res, 403, { error: 'These players have blocked one another; contact support to resolve this bracket pairing' });
      const ids = [match.player1_id, match.player2_id];
      const players = ids.map(id => q.byId.get(id));
      if (players.some(p => !p)) return send(res, 400, { error: 'A tournament player account is unavailable' });
      const roomId = crypto.randomBytes(5).toString('hex');
      const rules = { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 };
      const list = players.map(u => ({ id:u.id, name:u.display_name || u.username }));
      for (let i=list.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
      const room = { id:roomId, name:'Weekly Cup · Round '+match.round, host:match.player1_id, max:2, members:ids,
        game:M.newGame(list,rules), chat:[], result:null, timer:null, aiGame:false, aiDifficulty:'normal', rules,
        tournamentId:match.tournament_id, tournamentMatchId:match.id };
      if (!Tournaments.setMatchRoom(db, match.id, roomId)) return send(res, 409, { error:'This tournament match was just claimed' });
      rooms.set(roomId,room); ids.forEach(id=>userRoom.set(id,roomId));
      persistRoom(room); armTimer(room); pushAll();
      return send(res,200,{ok:true,roomId});
    });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const admin = userByToken(req.headers['x-token']);
    if (!admin) return send(res, 401, { error: 'Not signed in' });
    if (!admin.is_admin) return send(res, 403, { error: 'Administrator access required' });
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      const users = db.prepare(`SELECT u.id,u.username,u.display_name,u.rating,u.games,u.wins,u.created,u.is_admin,COALESCE(w.coins,0) AS coins
        FROM users u LEFT JOIN shop_wallets w ON w.user_id=u.id ORDER BY u.created ASC LIMIT 500`).all();
      return send(res, 200, { users });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/coins') {
      return readBody(req, (m) => {
        if (!m) return send(res,400,{error:'Bad request'});
        const result = Shop.grantCoins(db, Number(m.userId), Number(m.amount), admin.id, m.reason);
        if (result.error) return send(res,400,result);
        return send(res,200,result);
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/reports') {
      return send(res, 200, Social.listReports(db, url.searchParams.get('status') || 'open'));
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/reports/update') {
      return readBody(req, (m) => {
        if (!m) return send(res, 400, { error: 'Bad request' });
        const result = Social.updateReport(db, m.reportId, admin.id, m.status, m.resolution);
        return result.error ? send(res, 400, result) : send(res, 200, result);
      });
    }
    return send(res, 404, { error: 'Admin endpoint not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/social') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, Social.list(db, user.id, (id) => online.has(id)));
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/request') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Social.request(db, user.id, m.username);
      if (!result.error) pushAll();
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/respond') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Social.respond(db, user.id, m.requestId, !!m.accept);
      if (!result.error) pushAll();
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/friends/remove') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Social.removeFriend(db, user.id, m.userId);
      pushAll(); return send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/players/block') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Social.block(db, user.id, m.userId);
      if (!result.error) pushAll();
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/players/report') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Social.report(db, user.id, m.userId, m.reason, m.details);
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms/invite') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const room = rooms.get(userRoom.get(user.id));
      if (!room || room.game || room.host !== user.id) return send(res, 400, { error: 'Only the host of a waiting table can invite friends' });
      if (room.members.length >= room.max) return send(res, 400, { error: 'This table is full' });
      if (room.members.includes(Number(m.userId))) return send(res, 400, { error: 'That player is already at your table' });
      const result = Social.createInvite(db, user.id, m.userId, room.id);
      if (!result.error) pushAll();
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms/invite/accept') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      if (userRoom.has(user.id)) return send(res, 400, { error: 'Leave your current table first' });
      const invite = Social.getInvite(db, m.inviteId, user.id);
      if (!invite) return send(res, 404, { error: 'Invitation expired or no longer available' });
      if (!Social.areFriends(db, user.id, invite.sender_id) || Social.isBlocked(db, user.id, invite.sender_id)) return send(res, 403, { error: 'You are no longer friends with the inviter' });
      const room = rooms.get(invite.room_id);
      if (!room || room.game || room.result || room.members.length >= room.max || !room.members.includes(invite.sender_id)) {
        return send(res, 400, { error: 'That table is no longer available' });
      }
      room.members.push(user.id); userRoom.set(user.id, room.id); room.result = null;
      Social.markInviteAccepted(db, invite.id);
      persistRoom(room); pushAll();
      return send(res, 200, { ok: true, roomId: room.id });
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/shop') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, Shop.getShop(db, user.id));
  }

  if (req.method === 'POST' && url.pathname === '/api/shop/buy') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Shop.buy(db,user.id,m.cosmeticId);
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/shop/equip') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      const result = Shop.equip(db,user.id,m.cosmeticId);
      return result.error ? send(res, 400, result) : send(res, 200, result);
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    return send(res, 200, { rows: q.top.all() });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const user = userByToken(url.searchParams.get('token'));
    if (!user) { res.writeHead(401); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const old = online.get(user.id);
    if (old) old.res.end();
    online.set(user.id, { res });
    clearTimeout(dcTimers.get(user.id));
    dcTimers.delete(user.id);
    res.write('data: ' + JSON.stringify(stateFor(user.id)) + '\n\n');
    pushAll();
    const beat = setInterval(() => res.write(': hb\n\n'), 20000);
    req.on('close', () => {
      clearInterval(beat);
      const c = online.get(user.id);
      if (!c || c.res !== res) return;
      online.delete(user.id);
      const room = rooms.get(userRoom.get(user.id));
      if (room) {
        dcTimers.set(user.id, setTimeout(() => { if (!online.has(user.id)) leaveRoom(user.id); },
          room.game ? GAME_GRACE_MS : LOBBY_GRACE_MS));
      }
      pushAll();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/act') {
    const user = userByToken(req.headers['x-token']);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    return readBody(req, (m) => {
      if (!m) return send(res, 400, { error: 'Bad request' });
      // Protect the authoritative game engine from scripted request floods while
      // allowing normal rapid card selection and ordinary play.
      const now = Date.now();
      const window = actionWindows.get(user.id) || { startedAt: now, count: 0 };
      if (now - window.startedAt >= 2000) { window.startedAt = now; window.count = 0; }
      window.count++;
      actionWindows.set(user.id, window);
      if (window.count > 24) return send(res, 429, { error: 'Too many actions. Please slow down.' });
      if (actionWindows.size > 5000) for (const [id, w] of actionWindows) if (now - w.startedAt > 60000) actionWindows.delete(id);
      send(res, 200, handleAct(q.byId.get(user.id), m));
    });
  }

  res.writeHead(404); res.end('not found');
});

restoreRooms();
server.listen(PORT, () => console.log('Makao running on http://localhost:' + PORT));
