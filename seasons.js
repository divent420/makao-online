'use strict';

function seasonKey(now=Date.now()) {
  const d=new Date(now);
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
function seasonLabel(key) {
  const [year,month]=String(key).split('-').map(Number);
  return new Date(Date.UTC(year,month-1,1)).toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
}
function tierFor(rating) {
  const n=Number(rating)||1000;
  if(n>=1800)return {id:'diamond',name:'Diamond',icon:'💎'};
  if(n>=1600)return {id:'platinum',name:'Platinum',icon:'🏆'};
  if(n>=1400)return {id:'gold',name:'Gold',icon:'🥇'};
  if(n>=1200)return {id:'silver',name:'Silver',icon:'🥈'};
  return {id:'bronze',name:'Bronze',icon:'🥉'};
}
function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ranked_seasons(
      season_key TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranked_season_players(
      season_key TEXT NOT NULL REFERENCES ranked_seasons(season_key) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL DEFAULT 1000, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY(season_key,user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ranked_season_standings
      ON ranked_season_players(season_key,rating DESC,wins DESC,games ASC);
  `);
}
function ensureCurrent(db,now=Date.now()) {
  const key=seasonKey(now), [year,month]=key.split('-').map(Number);
  const starts=Date.UTC(year,month-1,1), ends=Date.UTC(year,month,1);
  db.prepare('INSERT OR IGNORE INTO ranked_seasons(season_key,title,starts_at,ends_at,created_at) VALUES(?,?,?,?,?)')
    .run(key,'Season '+key,starts,ends,now);
  return db.prepare('SELECT * FROM ranked_seasons WHERE season_key=?').get(key);
}
function recordRankedGame(db,players,winnerIndex,eloFn,now=Date.now()) {
  const season=ensureCurrent(db,now);
  const rows=players.map(p=>{
    db.prepare('INSERT OR IGNORE INTO ranked_season_players(season_key,user_id,rating,updated_at) VALUES(?,?,1000,?)')
      .run(season.season_key,p.id,now);
    return db.prepare('SELECT rating FROM ranked_season_players WHERE season_key=? AND user_id=?').get(season.season_key,p.id);
  });
  const deltas=eloFn(rows.map(r=>r.rating),winnerIndex);
  const result=[];
  players.forEach((p,i)=>{
    const old=rows[i].rating, rating=Math.max(100,old+deltas[i]), won=i===winnerIndex;
    db.prepare('UPDATE ranked_season_players SET rating=?,games=games+1,wins=wins+?,updated_at=? WHERE season_key=? AND user_id=?')
      .run(rating,won?1:0,now,season.season_key,p.id);
    result.push({userId:p.id,rating,delta:rating-old,wins:won});
  });
  return {seasonKey:season.season_key,seasonTitle:season.title,rows:result};
}
function getSeasonData(db,userId,now=Date.now()) {
  const current=ensureCurrent(db,now);
  const rows=db.prepare(`SELECT p.user_id AS id,u.username,u.display_name,u.avatar,p.rating,p.games,p.wins
    FROM ranked_season_players p JOIN users u ON u.id=p.user_id
    WHERE p.season_key=? AND p.games>0 ORDER BY p.rating DESC,p.wins DESC,p.games ASC LIMIT 50`).all(current.season_key);
  const ranked=rows.map((r,i)=>({...r,rank:i+1,tier:tierFor(r.rating),displayName:r.display_name||r.username,avatar:r.avatar||'🂡'}));
  const me=db.prepare('SELECT rating,games,wins FROM ranked_season_players WHERE season_key=? AND user_id=?').get(current.season_key,userId);
  const previous=db.prepare('SELECT season_key,title,starts_at,ends_at FROM ranked_seasons WHERE season_key<? ORDER BY season_key DESC LIMIT 6').all(current.season_key).map(s=>{
    const podium=db.prepare(`SELECT u.username,u.display_name,u.avatar,p.rating,p.wins FROM ranked_season_players p JOIN users u ON u.id=p.user_id
      WHERE p.season_key=? AND p.games>0 ORDER BY p.rating DESC,p.wins DESC,p.games ASC LIMIT 3`).all(s.season_key)
      .map((p,i)=>({...p,place:i+1,displayName:p.display_name||p.username,avatar:p.avatar||'🂡',tier:tierFor(p.rating)}));
    return {...s,podium};
  });
  const myRank=ranked.find(r=>r.id===userId)?.rank||null;
  return {current:{key:current.season_key,title:current.title,startsAt:current.starts_at,endsAt:current.ends_at,
    daysRemaining:Math.max(0,Math.ceil((current.ends_at-now)/86400000)),rating:me?.rating??1000,
    games:me?.games??0,wins:me?.wins??0,rank:myRank,tier:tierFor(me?.rating??1000)},
    leaderboard:ranked,previous};
}
module.exports={seasonKey,seasonLabel,tierFor,initialize,ensureCurrent,recordRankedGame,getSeasonData};
