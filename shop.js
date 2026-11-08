'use strict';

// Cosmetics are gameplay-neutral. Real-money checkout is intentionally not enabled here.
const CATALOG = [
  { id: 'back_nebula', name: 'Nebula Card Back', description: 'A violet starfield for the back of your cards.', category: 'card_back', price: 180, icon: '🌌', effect: 'nebula' },
  { id: 'back_sunset', name: 'Sunset Card Back', description: 'Warm sunset stripes on every hidden card.', category: 'card_back', price: 180, icon: '🌅', effect: 'sunset' },
  { id: 'back_gold', name: 'Gilded Card Back', description: 'A gold geometric card-back pattern.', category: 'card_back', price: 350, icon: '✨', effect: 'gold' },
  { id: 'back_prism', name: 'Prism Card Back', description: 'Shifting rainbow bands with a glass-like finish.', category: 'card_back', price: 320, icon: '🌈', effect: 'prism' },
  { id: 'back_obsidian', name: 'Obsidian Card Back', description: 'A sleek black card back with silver lines.', category: 'card_back', price: 380, icon: '🖤', effect: 'obsidian' },
  { id: 'back_koi', name: 'Koi Card Back', description: 'A deep-water pattern with bright koi accents.', category: 'card_back', price: 420, icon: '🐟', effect: 'koi' },
  { id: 'back_toxic', name: 'Toxic Grid', description: 'Acid-green geometry over a dark graphite base.', category: 'card_back', price: 390, icon: '☣️', effect: 'toxic' },
  { id: 'back_regal', name: 'Regal Crest', description: 'Deep navy with a crisp metallic gold lattice.', category: 'card_back', price: 460, icon: '♛', effect: 'regal' },
  { id: 'back_glacier', name: 'Glacier', description: 'Icy blue facets over a frozen midnight finish.', category: 'card_back', price: 440, icon: '❄️', effect: 'glacier' },
  { id: 'felt_sakura', name: 'Sakura Table', description: 'A soft rose-coloured table felt.', category: 'table_theme', price: 250, icon: '🌸', effect: 'sakura' },
  { id: 'felt_aurora', name: 'Aurora Table', description: 'A cool teal and northern-light table.', category: 'table_theme', price: 300, icon: '🌌', effect: 'aurora' },
  { id: 'felt_volcano', name: 'Volcano Table', description: 'A molten red and ember-orange playing surface.', category: 'table_theme', price: 360, icon: '🌋', effect: 'volcano' },
  { id: 'felt_amethyst', name: 'Royal Amethyst Table', description: 'A rich violet felt with a midnight edge.', category: 'table_theme', price: 380, icon: '💜', effect: 'amethyst' },
  { id: 'felt_arctic', name: 'Arctic Table', description: 'A crisp glacial-blue playing surface.', category: 'table_theme', price: 410, icon: '🧊', effect: 'arctic' },
  { id: 'felt_copper', name: 'Copper Table', description: 'Warm copper tones with a dark bronze edge.', category: 'table_theme', price: 430, icon: '🟠', effect: 'copper' },
  { id: 'frame_flame', name: 'Flame Avatar Frame', description: 'A fiery frame around your player avatar.', category: 'avatar_frame', price: 220, icon: '🔥', effect: 'flame' },
  { id: 'frame_ice', name: 'Frost Avatar Frame', description: 'An icy frame around your player avatar.', category: 'avatar_frame', price: 220, icon: '❄️', effect: 'ice' },
  { id: 'frame_crown', name: 'Royal Avatar Frame', description: 'A golden frame for your profile.', category: 'avatar_frame', price: 400, icon: '👑', effect: 'crown' },
  { id: 'frame_neon', name: 'Neon Avatar Frame', description: 'A bright electric glow around your avatar.', category: 'avatar_frame', price: 340, icon: '💠', effect: 'neon' },
  { id: 'frame_emerald', name: 'Emerald Avatar Frame', description: 'A polished green gemstone frame.', category: 'avatar_frame', price: 360, icon: '💚', effect: 'emerald' },
  { id: 'frame_solar', name: 'Solar Avatar Frame', description: 'A bright amber ring with a warm outer glow.', category: 'avatar_frame', price: 390, icon: '☀️', effect: 'solar' },
  { id: 'frame_void', name: 'Void Avatar Frame', description: 'A deep indigo ring with a cool violet glow.', category: 'avatar_frame', price: 420, icon: '🌑', effect: 'void' },
  { id: 'frame_crimson', name: 'Crimson Avatar Frame', description: 'A sharp crimson ring with a red edge glow.', category: 'avatar_frame', price: 400, icon: '', effect: 'crimson' },
  { id: 'back_cyber', name: 'Cyber Circuit', description: 'Electric cyan circuitry on a midnight base.', category: 'card_back', price: 480, icon: '', effect: 'cyber' },
  { id: 'back_magma', name: 'Magma Core', description: 'Glowing molten cracks across volcanic stone.', category: 'card_back', price: 520, icon: '', effect: 'magma' },
  { id: 'back_marble', name: 'Royal Marble', description: 'Polished ivory marble with fine gold veins.', category: 'card_back', price: 560, icon: '', effect: 'marble' },
  { id: 'felt_nightcity', name: 'Neon District', description: 'A deep urban blue with electric neon edges.', category: 'table_theme', price: 480, icon: '', effect: 'nightcity' },
  { id: 'felt_sand', name: 'Desert Dusk', description: 'Warm sand and sunset-brown playing surface.', category: 'table_theme', price: 460, icon: '', effect: 'sand' },
  { id: 'frame_royalblue', name: 'Sapphire Frame', description: 'A bright sapphire edge around your avatar.', category: 'avatar_frame', price: 460, icon: '', effect: 'royalblue' },
  { id: 'frame_rose', name: 'Rose Gold Frame', description: 'A warm rose-gold avatar outline.', category: 'avatar_frame', price: 440, icon: '', effect: 'rose' },
];

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_wallets(
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      coins INTEGER NOT NULL DEFAULT 1000 CHECK(coins >= 0), updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cosmetics(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
      icon TEXT NOT NULL, effect TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_cosmetics(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), purchased_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, cosmetic_id)
    );
    CREATE TABLE IF NOT EXISTS admin_coin_adjustments(
      id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_equipped_cosmetics(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL, cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
      equipped_at INTEGER NOT NULL, PRIMARY KEY(user_id, category)
    );
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO cosmetics(id,name,description,category,price,icon,effect) VALUES(?,?,?,?,?,?,?)');
  for (const item of CATALOG) insert.run(item.id,item.name,item.description,item.category,item.price,item.icon,item.effect);
  db.prepare('UPDATE cosmetics SET icon=\'\' WHERE id IN ('+CATALOG.map(()=>'?').join(',')+')').run(...CATALOG.map(item=>item.id));
}

function ensureWallet(db, userId, now = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO shop_wallets(user_id,coins,updated) VALUES(?,1000,?)').run(userId, now);
}

// Earn a small amount for playing; AI practice earns half. This is soft currency only.
function awardMatchCoins(db, userId, won, aiGame, now = Date.now()) {
  ensureWallet(db, userId, now);
  const coins = (aiGame ? 5 : 10) + (won ? (aiGame ? 3 : 5) : 0);
  db.prepare('UPDATE shop_wallets SET coins=coins+?,updated=? WHERE user_id=?').run(coins, now, userId);
  return coins;
}

function grantCoins(db, userId, amount, adminId, reason = '', now = Date.now()) {
  if (!Number.isSafeInteger(userId) || userId <= 0) return { error: 'Invalid player' };
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000) return { error: 'Coin amount must be between 1 and 10,000' };
  if (!db.prepare('SELECT 1 AS ok FROM users WHERE id=?').get(userId)) return { error: 'Player not found' };
  ensureWallet(db, userId, now);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE shop_wallets SET coins=coins+?,updated=? WHERE user_id=?').run(amount, now, userId);
    db.prepare('INSERT INTO admin_coin_adjustments(admin_id,user_id,amount,reason,created_at) VALUES(?,?,?,?,?)')
      .run(adminId, userId, amount, String(reason || '').slice(0,200), now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); return { error: 'Could not grant coins' }; }
  return { ok: true, coins: getShop(db, userId, now).coins };
}

function getShop(db, userId, now = Date.now()) {
  ensureWallet(db, userId, now);
  const wallet = db.prepare('SELECT coins FROM shop_wallets WHERE user_id=?').get(userId);
  const ownedRows = db.prepare('SELECT cosmetic_id FROM user_cosmetics WHERE user_id=?').all(userId);
  const equippedRows = db.prepare('SELECT category,cosmetic_id FROM user_equipped_cosmetics WHERE user_id=?').all(userId);
  const owned = new Set(ownedRows.map(r => r.cosmetic_id));
  const equipped = Object.fromEntries(equippedRows.map(r => [r.category, r.cosmetic_id]));
  return {
    coins: wallet.coins,
    items: CATALOG.map(item => ({ ...item, owned: owned.has(item.id), equipped: equipped[item.category] === item.id })),
    equipped,
  };
}

function buy(db, userId, cosmeticId, now = Date.now()) {
  const item = CATALOG.find(x => x.id === String(cosmeticId || ''));
  if (!item) return { error: 'Cosmetic not found' };
  ensureWallet(db, userId, now);
  if (db.prepare('SELECT 1 AS ok FROM user_cosmetics WHERE user_id=? AND cosmetic_id=?').get(userId,item.id)) {
    return { error: 'You already own this cosmetic' };
  }
  const wallet = db.prepare('SELECT coins FROM shop_wallets WHERE user_id=?').get(userId);
  if (wallet.coins < item.price) return { error: 'Not enough coins' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const debit = db.prepare('UPDATE shop_wallets SET coins=coins-?,updated=? WHERE user_id=? AND coins>=?').run(item.price,now,userId,item.price);
    if (Number(debit.changes) !== 1) throw new Error('Not enough coins');
    db.prepare('INSERT INTO user_cosmetics(user_id,cosmetic_id,purchased_at) VALUES(?,?,?)').run(userId,item.id,now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return { error: error.message === 'Not enough coins' ? error.message : 'Purchase could not be completed' };
  }
  return { ok: true, shop: getShop(db,userId,now) };
}

function equip(db, userId, cosmeticId, now = Date.now()) {
  const item = CATALOG.find(x => x.id === String(cosmeticId || ''));
  if (!item) return { error: 'Cosmetic not found' };
  const owned = db.prepare('SELECT 1 AS ok FROM user_cosmetics WHERE user_id=? AND cosmetic_id=?').get(userId,item.id);
  if (!owned) return { error: 'You do not own this cosmetic' };
  db.prepare(`INSERT INTO user_equipped_cosmetics(user_id,category,cosmetic_id,equipped_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id,category) DO UPDATE SET cosmetic_id=excluded.cosmetic_id,equipped_at=excluded.equipped_at`)
    .run(userId,item.category,item.id,now);
  return { ok: true, shop: getShop(db,userId,now) };
}

module.exports = { CATALOG, initialize, awardMatchCoins, grantCoins, getShop, buy, equip };
