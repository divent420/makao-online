'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const Seasons=require('../seasons');
const M=require('../makao');
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,avatar TEXT);
    INSERT INTO users VALUES(1,'alice','Alice','🂡'),(2,'bob','Bob','🐺'),(3,'cara','Cara','🦊');`);
  db.exec('CREATE TABLE shop_wallets(user_id INTEGER PRIMARY KEY,coins INTEGER NOT NULL,updated INTEGER NOT NULL);');
  Seasons.initialize(db); return db;
}
test('season keys roll over monthly in UTC',()=>{
  assert.equal(Seasons.seasonKey(Date.UTC(2026,10,30,23)),'2026-11');
  assert.equal(Seasons.seasonKey(Date.UTC(2026,11,1)),'2026-12');
});
test('rank tiers follow rating thresholds',()=>{
  assert.equal(Seasons.tierFor(1000).name,'Bronze');
  assert.equal(Seasons.tierFor(1200).name,'Silver');
  assert.equal(Seasons.tierFor(1400).name,'Gold');
  assert.equal(Seasons.tierFor(1600).name,'Platinum');
  assert.equal(Seasons.tierFor(1800).name,'Diamond');
});
test('ranked match updates separate seasonal Elo and standings',()=>{
  const db=setup(),now=Date.UTC(2026,10,8);
  const result=Seasons.recordRankedGame(db,[{id:1},{id:2}],0,M.elo,now);
  assert.equal(result.seasonKey,'2026-11');
  assert.ok(result.rows[0].delta>0);
  assert.ok(result.rows[1].delta<0);
  const data=Seasons.getSeasonData(db,1,now);
  assert.equal(data.current.games,1);
  assert.equal(data.current.wins,1);
  assert.equal(data.current.rank,1);
  assert.equal(data.leaderboard.length,2);
  assert.equal(Seasons.getSeasonData(db,2,now).current.wins,0);
  db.close();
});
test('season history preserves previous month standings',()=>{
  const db=setup(),nov=Date.UTC(2026,10,8),dec=Date.UTC(2026,11,2);
  Seasons.recordRankedGame(db,[{id:1},{id:2}],0,M.elo,nov);
  Seasons.ensureCurrent(db,dec);
  const data=Seasons.getSeasonData(db,1,dec);
  assert.equal(data.previous.length,1);
  assert.equal(data.previous[0].season_key,'2026-11');
  assert.equal(data.previous[0].podium[0].username,'alice');
  assert.equal(data.previous[0].podium[0].rewardCoins,1000);
  assert.equal(db.prepare('SELECT coins FROM shop_wallets WHERE user_id=1').get().coins,2000);
  // Calling the season API again must not grant the podium reward twice.
  Seasons.getSeasonData(db,1,dec+1000);
  assert.equal(db.prepare('SELECT coins FROM shop_wallets WHERE user_id=1').get().coins,2000);
  db.close();
});
