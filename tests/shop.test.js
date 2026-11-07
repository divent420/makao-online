'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const Shop = require('../shop');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);');
  db.prepare('INSERT INTO users(id,username) VALUES(1,?)').run('alice');
  Shop.initialize(db);
  return db;
}

test('wallet starts at zero and completed matches award soft currency', () => {
  const db = setup();
  assert.equal(Shop.getShop(db,1).coins,0);
  assert.equal(Shop.awardMatchCoins(db,1,false,false,1000),10);
  assert.equal(Shop.awardMatchCoins(db,1,true,false,2000),15);
  assert.equal(Shop.awardMatchCoins(db,1,true,true,3000),8);
  assert.equal(Shop.getShop(db,1).coins,33);
  db.close();
});

test('cosmetic purchase debits coins once and equips only owned items', () => {
  const db = setup();
  Shop.awardMatchCoins(db,1,false,false,1000);
  assert.equal(Shop.equip(db,1,'back_nebula').error,'You do not own this cosmetic');
  assert.equal(Shop.buy(db,1,'back_nebula').error,'Not enough coins');
  Shop.awardMatchCoins(db,1,true,false,2000);
  for (let i=0;i<16;i++) Shop.awardMatchCoins(db,1,false,false,2100+i);
  const bought = Shop.buy(db,1,'back_nebula',3000);
  assert.equal(bought.ok,true);
  assert.equal(bought.shop.coins,5);
  assert.equal(bought.shop.items.find(x=>x.id==='back_nebula').owned,true);
  assert.equal(Shop.buy(db,1,'back_nebula').error,'You already own this cosmetic');
  const equipped = Shop.equip(db,1,'back_nebula',4000);
  assert.equal(equipped.shop.equipped.card_back,'back_nebula');
  assert.equal(equipped.shop.items.find(x=>x.id==='back_nebula').equipped,true);
  db.close();
});

test('unknown cosmetics cannot be purchased or equipped', () => {
  const db = setup();
  assert.equal(Shop.buy(db,1,'made_up_item').error,'Cosmetic not found');
  assert.equal(Shop.equip(db,1,'made_up_item').error,'Cosmetic not found');
  db.close();
});
