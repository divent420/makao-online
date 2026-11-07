'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const Social=require('../social');
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,display_name TEXT DEFAULT '',avatar TEXT DEFAULT '🂡',rating INTEGER DEFAULT 1000);
    INSERT INTO users(id,username,display_name,rating) VALUES(1,'alice','Alice',1100),(2,'bob','Bob',900),(3,'cara','Cara',1000);`);
  Social.initialize(db); return db;
}
test('friend request, acceptance and online-aware friend list',()=>{
  const db=setup();
  assert.equal(Social.request(db,1,'bob',1000).ok,true);
  assert.match(Social.request(db,1,'bob',1001).error,/already sent/i);
  const incoming=Social.list(db,2,()=>false,1002).incoming;
  assert.equal(incoming.length,1);
  assert.equal(Social.respond(db,2,incoming[0].id,true,1003).ok,true);
  const friends=Social.list(db,1,id=>id===2,1004).friends;
  assert.equal(friends.length,1); assert.equal(friends[0].online,true); assert.equal(friends[0].rating,900);
  assert.equal(Social.request(db,1,'bob').error,'You are already friends');
  db.close();
});
test('self requests, unknown users and malformed names are rejected',()=>{
  const db=setup();
  assert.match(Social.request(db,1,'alice').error,/yourself/i);
  assert.match(Social.request(db,1,'missing').error,/not found/i);
  assert.match(Social.request(db,1,'x').error,/valid username/i);
  db.close();
});
test('blocking removes friendship and pending requests and prevents new requests',()=>{
  const db=setup();
  Social.request(db,1,'bob',1000); const req=Social.list(db,2,()=>false,1001).incoming[0];
  Social.respond(db,2,req.id,true,1002);
  assert.equal(Social.block(db,1,2,1003).ok,true);
  assert.equal(Social.list(db,1).friends.length,0);
  assert.match(Social.request(db,1,'bob').error,/blocked/i);
  assert.equal(Social.block(db,1,1).error,'Invalid player');
  db.close();
});
test('private room invites are friend-only, expire, and can be marked accepted',()=>{
  const db=setup();
  assert.match(Social.createInvite(db,1,2,'room1',1000).error,/friends only/i);
  Social.request(db,1,'bob',1000); const req=Social.list(db,2).incoming[0]; Social.respond(db,2,req.id,true,1001);
  const invite=Social.createInvite(db,1,2,'room1',2000); assert.equal(invite.ok,true);
  assert.equal(Social.createInvite(db,1,2,'room1',2001).error,'An invitation is already pending');
  assert.equal(Social.getInvite(db,invite.id,2,2002).room_id,'room1');
  assert.equal(Social.getInvite(db,invite.id,2,700000),null);
  Social.markInviteAccepted(db,invite.id,3000);
  assert.equal(Social.getInvite(db,invite.id,2,3001),null);
  db.close();
});
test('reports accept only valid targets and reasons',()=>{
  const db=setup();
  assert.equal(Social.report(db,1,2,'harassment','bad chat',1000).ok,true);
  assert.match(Social.report(db,1,2,'invalid').error,/reason/i);
  assert.match(Social.report(db,1,1,'spam').error,/invalid player/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM player_reports').get().n,1);
  db.close();
});
test('reports are rate limited and moderation queue can be updated',()=>{
  const db=setup();
  assert.equal(Social.report(db,1,2,'harassment','bad chat',1000).ok,true);
  assert.equal(Social.report(db,1,2,'harassment','again',1001).ok,true);
  assert.equal(Social.listReports(db,'open').reports.length,2);
  const id=Social.listReports(db,'open').reports[0].id;
  assert.equal(Social.updateReport(db,id,3,'reviewing','checking',2000).ok,true);
  assert.equal(Social.listReports(db,'reviewing').reports[0].moderator_username,'cara');
  assert.equal(Social.updateReport(db,id,3,'resolved','action taken',3000).ok,true);
  assert.equal(Social.listReports(db,'resolved').reports.length,1);
  assert.match(Social.updateReport(db,id,3,'ban').error,/status/i);
  for(let i=0;i<3;i++) Social.report(db,1,2,'spam','',4000+i);
  assert.match(Social.report(db,1,2,'spam','',4004).error,/too many/i);
  db.close();
});
