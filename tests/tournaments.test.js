'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const T=require('../tournaments');
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,avatar TEXT,rating INTEGER);
    INSERT INTO users VALUES(1,'alice','Alice','🂡',1100),(2,'bob','Bob','🐺',1000),(3,'cara','Cara','🦊',900),(4,'dave','Dave','🐼',800);`);
  T.initialize(db); return db;
}
test('weekly tournament is created for Monday UTC and is stable during the week',()=>{
  const db=setup(); const mon=Date.UTC(2026,10,2,12); const thu=Date.UTC(2026,10,5,12);
  assert.equal(T.ensureWeekly(db,mon),'weekly-2026-11-02');
  assert.equal(T.ensureWeekly(db,thu),'weekly-2026-11-02');
  assert.equal(T.ensureWeekly(db,Date.UTC(2026,10,9)),'weekly-2026-11-09');
  db.close();
});
test('four players create a seeded single-elimination bracket and only participants can start',()=>{
  const db=setup(); const now=Date.UTC(2026,10,7); const id=T.ensureWeekly(db,now);
  for(let i=1;i<=4;i++) assert.equal(T.join(db,i,id,now+i).ok,true);
  const cup=T.getTournaments(db,1,now).tournaments[0];
  assert.equal(cup.status,'in_progress'); assert.equal(cup.entries.length,4); assert.equal(cup.matches.length,2);
  assert.deepEqual([cup.matches[0].player1_id,cup.matches[0].player2_id],[1,4]);
  assert.equal(cup.matches[0].canStart,true); assert.equal(cup.matches[1].canStart,false);
  assert.equal(T.join(db,1,id,now+10).error,'Tournament registration is closed');
  assert.equal(T.getMatchForStart(db,3,cup.matches[0].id),null);
  assert.ok(T.getMatchForStart(db,1,cup.matches[0].id));
  db.close();
});
test('match room claim is one-time and match winners advance to the final',()=>{
  const db=setup(); const now=Date.UTC(2026,10,7); const id=T.ensureWeekly(db,now);
  for(let i=1;i<=4;i++) T.join(db,i,id,now+i);
  const first=T.getTournaments(db,1,now).tournaments[0].matches;
  assert.equal(T.setMatchRoom(db,first[0].id,'room-a'),true);
  assert.equal(T.setMatchRoom(db,first[0].id,'room-b'),false);
  assert.equal(T.setMatchRoom(db,first[1].id,'room-b'),true);
  assert.equal(T.completeMatch(db,id,first[0].id,1,now+10).ok,true);
  assert.equal(T.completeMatch(db,id,first[1].id,2,now+11).ok,true);
  const cup=T.getTournaments(db,1,now).tournaments[0];
  assert.equal(cup.matches.length,3); assert.equal(cup.matches[2].round,2);
  assert.deepEqual([cup.matches[2].player1_id,cup.matches[2].player2_id],[1,2]);
  assert.equal(T.setMatchRoom(db,cup.matches[2].id,'final-room'),true);
  assert.equal(T.completeMatch(db,id,cup.matches[2].id,2,now+20).ok,true);
  const finished=T.getTournaments(db,1,now).tournaments[0];
  assert.equal(finished.status,'completed'); assert.equal(finished.winner_id,2);
  db.close();
});
