'use strict';

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
      created_at INTEGER NOT NULL,
      UNIQUE(sender_id, recipient_id), CHECK(sender_id <> recipient_id)
    );
    CREATE TABLE IF NOT EXISTS friendships(
      user_low INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_low,user_high), CHECK(user_low < user_high)
    );
    CREATE TABLE IF NOT EXISTS user_blocks(
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id <> blocked_id)
    );
    CREATE TABLE IF NOT EXISTS room_invites(
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      UNIQUE(room_id,recipient_id), CHECK(sender_id <> recipient_id)
    );
    CREATE TABLE IF NOT EXISTS player_reports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      CHECK(reporter_id <> reported_id)
    );
  `);
}

function pair(a,b) { return [Math.min(Number(a),Number(b)),Math.max(Number(a),Number(b))]; }
function isBlocked(db,a,b) {
  return !!db.prepare('SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a,b,b,a);
}
function areFriends(db,a,b) {
  const [lo,hi]=pair(a,b);
  return !!db.prepare('SELECT 1 FROM friendships WHERE user_low=? AND user_high=?').get(lo,hi);
}
function request(db,senderId,username,now=Date.now()) {
  const name=String(username||'').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return {error:'Enter a valid username (3-16 letters, digits or _)'};
  const target=db.prepare('SELECT id,username,display_name,avatar FROM users WHERE username=? COLLATE NOCASE').get(name);
  if (!target) return {error:'Player not found'};
  if (target.id===senderId) return {error:'You cannot add yourself'};
  if (isBlocked(db,senderId,target.id)) return {error:'This player is blocked'};
  if (areFriends(db,senderId,target.id)) return {error:'You are already friends'};
  const reverse=db.prepare("SELECT id,status FROM friend_requests WHERE sender_id=? AND recipient_id=?").get(target.id,senderId);
  if (reverse && reverse.status==='pending') return {error:'This player has already sent you a request'};
  const existing=db.prepare('SELECT id,status FROM friend_requests WHERE sender_id=? AND recipient_id=?').get(senderId,target.id);
  if (existing && existing.status==='pending') return {error:'Friend request already sent'};
  if (existing) db.prepare('DELETE FROM friend_requests WHERE id=?').run(existing.id);
  db.prepare("INSERT INTO friend_requests(sender_id,recipient_id,status,created_at) VALUES(?,?,'pending',?)").run(senderId,target.id,now);
  return {ok:true,player:{id:target.id,username:target.username,displayName:target.display_name||target.username,avatar:target.avatar||'🂡'}};
}
function respond(db,userId,requestId,accept,now=Date.now()) {
  const req=db.prepare("SELECT * FROM friend_requests WHERE id=? AND recipient_id=? AND status='pending'").get(Number(requestId),userId);
  if (!req) return {error:'Friend request no longer exists'};
  if (isBlocked(db,userId,req.sender_id)) return {error:'This player is blocked'};
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE friend_requests SET status=? WHERE id=?').run(accept?'accepted':'declined',req.id);
    if (accept) { const [lo,hi]=pair(userId,req.sender_id); db.prepare('INSERT OR IGNORE INTO friendships(user_low,user_high,created_at) VALUES(?,?,?)').run(lo,hi,now); }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  return {ok:true};
}
function removeFriend(db,userId,friendId) {
  const [lo,hi]=pair(userId,Number(friendId));
  const r=db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(lo,hi);
  return {ok:Number(r.changes)>0};
}
function block(db,userId,otherId,now=Date.now()) {
  otherId=Number(otherId);
  if (!Number.isSafeInteger(otherId)||otherId<1||otherId===userId||!db.prepare('SELECT 1 FROM users WHERE id=?').get(otherId)) return {error:'Invalid player'};
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO user_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(userId,otherId,now);
    const [lo,hi]=pair(userId,otherId);
    db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(lo,hi);
    db.prepare('DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)').run(userId,otherId,otherId,userId);
    db.prepare('DELETE FROM room_invites WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)').run(userId,otherId,otherId,userId);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  return {ok:true};
}
function report(db,reporterId,reportedId,reason,details='',now=Date.now()) {
  reportedId=Number(reportedId); reason=String(reason||'').trim(); details=String(details||'').trim().slice(0,500);
  const allowed=['harassment','cheating','offensive_name','spam','other'];
  if (!Number.isSafeInteger(reportedId)||reportedId<1||reportedId===reporterId||!db.prepare('SELECT 1 FROM users WHERE id=?').get(reportedId)) return {error:'Invalid player'};
  if (!allowed.includes(reason)) return {error:'Choose a valid report reason'};
  db.prepare('INSERT INTO player_reports(reporter_id,reported_id,reason,details,created_at) VALUES(?,?,?,?,?)').run(reporterId,reportedId,reason,details,now);
  return {ok:true};
}
function list(db,userId,isOnline=()=>false,now=Date.now()) {
  const friends=db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,u.rating FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END WHERE f.user_low=? OR f.user_high=? ORDER BY u.username`).all(userId,userId,userId)
    .map(u=>({id:u.id,username:u.username,displayName:u.display_name||u.username,avatar:u.avatar||'🂡',rating:u.rating,online:!!isOnline(u.id)}));
  const incoming=db.prepare(`SELECT r.id,r.created_at,u.id AS userId,u.username,u.display_name,u.avatar FROM friend_requests r JOIN users u ON u.id=r.sender_id WHERE r.recipient_id=? AND r.status='pending' ORDER BY r.created_at`).all(userId)
    .map(r=>({id:r.id,user:{id:r.userId,username:r.username,displayName:r.display_name||r.username,avatar:r.avatar||'🂡'},createdAt:r.created_at}));
  const outgoing=db.prepare(`SELECT r.id,r.created_at,u.username FROM friend_requests r JOIN users u ON u.id=r.recipient_id WHERE r.sender_id=? AND r.status='pending' ORDER BY r.created_at`).all(userId);
  const invites=db.prepare(`SELECT i.id,i.room_id,i.created_at,i.expires_at,u.username,u.display_name,u.avatar FROM room_invites i JOIN users u ON u.id=i.sender_id WHERE i.recipient_id=? AND i.accepted_at IS NULL AND i.expires_at>? ORDER BY i.created_at DESC`).all(userId,now)
    .map(i=>({id:i.id,roomId:i.room_id,createdAt:i.created_at,expiresAt:i.expires_at,from:{username:i.username,displayName:i.display_name||i.username,avatar:i.avatar||'🂡'}}));
  return {friends,incoming,outgoing,invites};
}
function createInvite(db,senderId,recipientId,roomId,now=Date.now()) {
  recipientId=Number(recipientId); roomId=String(roomId||'');
  if (!Number.isSafeInteger(recipientId)||recipientId<1||recipientId===senderId) return {error:'Invalid player'};
  if (!areFriends(db,senderId,recipientId)||isBlocked(db,senderId,recipientId)) return {error:'You can invite friends only'};
  if (!roomId) return {error:'Invalid room'};
  const id=require('crypto').randomBytes(16).toString('hex');
  db.prepare('DELETE FROM room_invites WHERE expires_at<=?').run(now);
  try { db.prepare('INSERT INTO room_invites(id,room_id,sender_id,recipient_id,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id,roomId,senderId,recipientId,now,now+10*60*1000); }
  catch(e) { if (/UNIQUE/i.test(e.message)) return {error:'An invitation is already pending'}; throw e; }
  return {ok:true,id};
}
function getInvite(db,inviteId,userId,now=Date.now()) {
  return db.prepare('SELECT * FROM room_invites WHERE id=? AND recipient_id=? AND accepted_at IS NULL AND expires_at>?').get(String(inviteId||''),userId,now)||null;
}
function markInviteAccepted(db,inviteId,now=Date.now()) { db.prepare('UPDATE room_invites SET accepted_at=? WHERE id=?').run(now,String(inviteId)); }
module.exports={initialize,request,respond,removeFriend,block,report,list,areFriends,isBlocked,createInvite,getInvite,markInviteAccepted};
