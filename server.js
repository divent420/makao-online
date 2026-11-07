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
  bio TEXT NOT NULL DEFAULT 'Ready to play Makao');
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS games(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished INTEGER NOT NULL, winner_id INTEGER, players TEXT NOT NULL);
`);
// Safe migrations for databases created by earlier versions.
for (const [name, def] of [['display_name', "TEXT NOT NULL DEFAULT ''"], ['avatar', "TEXT NOT NULL DEFAULT '🂡'"], ['bio', "TEXT NOT NULL DEFAULT 'Ready to play Makao'"]]) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
}

const q = {
  insUser: db.prepare('INSERT INTO users(username,salt,hash,created) VALUES(?,?,?,?)'),
  byName: db.prepare('SELECT * FROM users WHERE username=?'),
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  insSession: db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)'),
  byToken: db.prepare('SELECT u.*, s.created AS s_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'),
  delToken: db.prepare('DELETE FROM sessions WHERE token=?'),
  top: db.prepare('SELECT username,rating,games,wins FROM users WHERE games>0 ORDER BY rating DESC, wins DESC, games ASC LIMIT 50'),
  upd: db.prepare('UPDATE users SET rating=?, games=games+1, wins=wins+? WHERE id=?'),
  insGame: db.prepare('INSERT INTO games(finished,winner_id,players) VALUES(?,?,?)'),
};

// ---------- accounts ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const userView = (u) => ({ id: u.id, username: u.username, displayName: u.display_name || u.username, avatar: u.avatar || '🂡', bio: u.bio || '', rating: u.rating, games: u.games, wins: u.wins });

function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return { error: 'Username: 3-16 letters, digits or _' };
  if (password.length < 6 || password.length > 100) return { error: 'Password must be 6-100 characters' };
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = q.insUser.run(username, salt, hashPw(password, salt), Date.now());
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
const uname = (id) => { const u = q.byId.get(id); return u ? u.username : '?'; };
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

function roomView(r) {
  return {
    id: r.id, name: r.name, host: r.host, max: r.max, playing: !!r.game,
    rules: r.rules, ranked: M.isRanked(r.rules),
    members: r.members.map((id) => { const u = q.byId.get(id); return { id, username: u.username, displayName: u.display_name || u.username, avatar: u.avatar || '🂡', rating: u.rating, online: online.has(id) }; }),
    chat: r.chat.slice(-40), result: r.result,
  };
}
function stateFor(uid) {
  const u = q.byId.get(uid);
  const room = rooms.get(userRoom.get(uid));
  return {
    t: 'state', me: userView(u),
    lobbies: [...rooms.values()].map((r) => ({
      id: r.id, name: r.name, host: uname(r.host), count: r.members.length, max: r.max, playing: !!r.game,
      ranked: M.isRanked(r.rules),
    })),
    room: room ? roomView(room) : null,
    game: room && room.game ? M.view(room.game, uid) : null,
  };
}
function pushAll() {
  for (const [uid, c] of online) {
    try { c.res.write('data: ' + JSON.stringify(stateFor(uid)) + '\n\n'); } catch (e) { /* closed */ }
  }
}

// ---------- game flow ----------
function armTimer(room) {
  clearTimeout(room.timer);
  if (!room.game || room.game.winner != null) return;
  const ms = room.rules.turnSeconds * 1000;
  room.game.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    if (!room.game) return;
    M.autoPlay(room.game);
    afterAction(room);
  }, ms);
}

function finishGame(room) {
  clearTimeout(room.timer);
  const st = room.game;
  const rows = st.players.map((p) => q.byId.get(p.id));
  // Games with changed rules are casual: recorded, but ratings and stats stay untouched.
  const ranked = M.isRanked(room.rules);
  const deltas = M.elo(rows.map((u) => u.rating), st.winner);
  const result = { id: Date.now(), ranked, winner: st.players[st.winner].name, winnerId: st.players[st.winner].id, rows: [] };
  db.exec('BEGIN');
  try {
    rows.forEach((u, i) => {
      const won = i === st.winner;
      if (ranked) {
        const nr = Math.max(100, u.rating + deltas[i]);
        q.upd.run(nr, won ? 1 : 0, u.id);
        result.rows.push({ username: u.username, delta: nr - u.rating, rating: nr, won });
      } else {
        result.rows.push({ username: u.username, delta: 0, rating: u.rating, won });
      }
    });
    q.insGame.run(Date.now(), result.winnerId, JSON.stringify({ ranked, rules: room.rules, rows: result.rows }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  room.result = result;
  room.game = null;
}

function afterAction(room) {
  if (room.game && room.game.winner != null) finishGame(room);
  else armTimer(room);
  pushAll();
}

function leaveRoom(uid) {
  const room = rooms.get(userRoom.get(uid));
  if (!room) return;
  if (room.game) M.forfeit(room.game, uid);
  room.members = room.members.filter((id) => id !== uid);
  userRoom.delete(uid);
  if (!room.members.length) {
    clearTimeout(room.timer);
    rooms.delete(room.id);
  } else {
    if (room.host === uid) room.host = room.members[0];
    if (room.game && room.game.winner != null) finishGame(room);
    else armTimer(room);
  }
  pushAll();
}

function handleAct(user, m) {
  const uid = user.id;
  const room = rooms.get(userRoom.get(uid));
  switch (m.t) {
    case 'createRoom': {
      if (room) return { error: 'You are already at a table' };
      const id = crypto.randomBytes(4).toString('hex');
      rooms.set(id, {
        id, name: str(m.name, 30).trim() || user.username + "'s table",
        host: uid, max: Math.min(4, Math.max(2, m.max | 0 || 4)),
        members: [uid], game: null, chat: [], result: null, timer: null,
        rules: { ...M.DEFAULT_RULES, turnSeconds: TURN_MS / 1000 },
      });
      userRoom.set(uid, id);
      break;
    }
    case 'joinRoom': {
      if (room) return { error: 'You are already at a table' };
      const r = rooms.get(str(m.id, 20));
      if (!r) return { error: 'That table no longer exists' };
      if (r.game) return { error: 'That game already started' };
      if (r.members.length >= r.max) return { error: 'That table is full' };
      r.members.push(uid); userRoom.set(uid, r.id);
      r.result = null;
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
      room.result = null;
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
      if (text) { room.chat.push({ from: user.username, text, ts: Date.now() }); if (room.chat.length > 100) room.chat.shift(); }
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
    if (t) q.delToken.run(String(t));
    return send(res, 200, { ok: true });
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
      send(res, 200, handleAct(q.byId.get(user.id), m));
    });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log('Makao running on http://localhost:' + PORT));
