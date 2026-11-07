'use strict';

// For an existing installation with users but no configured administrator,
// safely grant the role to the oldest account, never to a later visitor.
function ensureExistingFirstAdmin(db) {
  return db.prepare(`
    UPDATE users
    SET is_admin = 1
    WHERE id = (
      SELECT id FROM users ORDER BY id ASC LIMIT 1
    )
    AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)
  `).run();
}

// SQLite evaluates NOT EXISTS as part of the INSERT statement. This makes
// first-account promotion atomic even when registrations arrive concurrently.
function insertUserWithFirstAdmin(db, username, salt, hash, created) {
  return db.prepare(`
    INSERT INTO users(username, salt, hash, created, is_admin)
    VALUES (?, ?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 1 ELSE 0 END)
  `).run(username, salt, hash, created);
}

module.exports = { ensureExistingFirstAdmin, insertUserWithFirstAdmin };
