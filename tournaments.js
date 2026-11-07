'use strict';
const crypto=require('crypto');

function mondayUtc(now=Date.now()) {
  const d=new Date(now); const day=(d.getUTCDay()+6)%7;
  d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-day); return d.toISOString().slice(0,10);
}
function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','in_progress','completed')),
      max_players INTEGER NOT NULL DEFAULT 4, created_at INTEGER NOT NULL, winner_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS tournament_entries(
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seed INTEGER NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(tournament_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS tournament_matches(
      id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      round INTEGER NOT NULL, slot INTEGER NOT NULL, player1_id INTEGER NOT NULL REFERENCES users(id),
      player2_id INTEGER NOT NULL REFERENCES users(id), winner_id INTEGER REFERENCES users(id),
      room_id TEXT, status TEXT NOT NULL CHECK(status IN ('ready','playing','completed')),
      created_at INTEGER NOT NULL, UNIQUE(tournament_id,round,slot)
    );
  `);
}
function ensureWeekly(db,now=Date.now()) {
  const date=mondayUtc(now), id='weekly-'+date;
  db.prepare("INSERT OR IGNORE INTO tournaments(id,title,status,max_players,created_at) VALUES(?,?,'open',4,?)")
    .run(id,'Weekly Makao Cup · '+date,now);
  return id;
}
function getTournaments(db,userId,now=Date.now()) {
  const currentId=ensureWeekly(db,now);
  const rows=db.prepare("SELECT * FROM tournaments WHERE id=? OR status='in_progress' ORDER BY created_at DESC LIMIT 5").all(currentId);
  return {tournaments:rows.map(t=>{
    const entries=db.prepare(`SELECT e.user_id,u.username,u.display_name,u.avatar,e.seed FROM tournament_entries e JOIN users u ON u.id=e.user_id WHERE e.tournament_id=? ORDER BY e.seed`).all(t.id);
    const matches=db.prepare(`SELECT m.*,u1.username AS p1_name,u2.username AS p2_name,uw.username AS winner_name FROM tournament_matches m JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id LEFT JOIN users uw ON uw.id=m.winner_id WHERE m.tournament_id=? ORDER BY m.round,m.slot`).all(t.id);
    return {...t,entries:entries.map(e=>({id:e.user_id,username:e.username,displayName:e.display_name||e.username,avatar:e.avatar||'🂡',seed:e.seed})),matches:matches.map(m=>({...m,canStart:m.status==='ready'&&(m.player1_id===userId||m.player2_id===userId)})),joined:entries.some(e=>e.user_id===userId)};
  })};
}
function join(db,userId,tournamentId,now=Date.now()) {
  ensureWeekly(db,now);
  const t=db.prepare('SELECT * FROM tournaments WHERE id=?').get(String(tournamentId||''));
  if(!t||t.status!=='open') return {error:'Tournament registration is closed'};
  const count=db.prepare('SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id=?').get(t.id).n;
  if(count>=t.max_players) return {error:'Tournament is full'};
  try { db.prepare('INSERT INTO tournament_entries(tournament_id,user_id,seed,joined_at) VALUES(?,?,?,?)').run(t.id,userId,count+1,now); }
  catch(e) { if(/UNIQUE/i.test(e.message)) return {error:'You already joined this tournament'}; throw e; }
  const entries=db.prepare('SELECT user_id FROM tournament_entries WHERE tournament_id=? ORDER BY seed').all(t.id);
  if(entries.length===t.max_players) {
    // Four-player single-elimination: seeded 1v4 and 2v3.
    const pairs=[[entries[0].user_id,entries[3].user_id],[entries[1].user_id,entries[2].user_id]];
    pairs.forEach((p,i)=>db.prepare("INSERT INTO tournament_matches(id,tournament_id,round,slot,player1_id,player2_id,status,created_at) VALUES(?,?,1,?,?,?,'ready',?)")
      .run(crypto.randomBytes(12).toString('hex'),t.id,i+1,p[0],p[1],now));
    db.prepare("UPDATE tournaments SET status='in_progress' WHERE id=?").run(t.id);
  }
  return {ok:true,tournamentId:t.id};
}
function getMatchForStart(db,userId,matchId) {
  return db.prepare("SELECT * FROM tournament_matches WHERE id=? AND status='ready' AND room_id IS NULL AND (player1_id=? OR player2_id=?)").get(String(matchId||''),userId,userId)||null;
}
function setMatchRoom(db,matchId,roomId) {
  const r=db.prepare("UPDATE tournament_matches SET room_id=?,status='playing' WHERE id=? AND status='ready' AND room_id IS NULL").run(roomId,matchId);
  return Number(r.changes)===1;
}
function completeMatch(db,tournamentId,matchId,winnerId,now=Date.now()) {
  const m=db.prepare("SELECT * FROM tournament_matches WHERE id=? AND tournament_id=? AND status='playing'").get(matchId,tournamentId);
  if(!m||![m.player1_id,m.player2_id].includes(Number(winnerId))) return {error:'Tournament match could not be advanced'};
  db.prepare("UPDATE tournament_matches SET winner_id=?,status='completed' WHERE id=?").run(winnerId,matchId);
  const roundMatches=db.prepare('SELECT * FROM tournament_matches WHERE tournament_id=? AND round=? ORDER BY slot').all(tournamentId,m.round);
  if(roundMatches.every(x=>x.status==='completed')) {
    if(m.round===1) {
      const winners=roundMatches.sort((a,b)=>a.slot-b.slot).map(x=>x.winner_id);
      db.prepare("INSERT INTO tournament_matches(id,tournament_id,round,slot,player1_id,player2_id,status,created_at) VALUES(?,?,2,1,?,?,? ,?)")
        .run(crypto.randomBytes(12).toString('hex'),tournamentId,winners[0],winners[1],'ready',now);
    } else {
      db.prepare("UPDATE tournaments SET status='completed',winner_id=? WHERE id=?").run(winnerId,tournamentId);
    }
  }
  return {ok:true};
}
module.exports={initialize,mondayUtc,ensureWeekly,getTournaments,join,getMatchForStart,setMatchRoom,completeMatch};
