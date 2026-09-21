'use strict';

const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, derived] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(derived, 'hex'));
}

// §10: dashboard login uses its own admin/viewer account table with
// session cookies — deliberately separate from the API bearer tokens.
function createAdminUsersService(db) {
  function getByUsername(username) {
    return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  }

  function count() {
    return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  }

  function create({ username, password, role }) {
    const id = `usr_${uuid()}`;
    db.prepare('INSERT INTO admin_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      username,
      hashPassword(password),
      role,
      new Date().toISOString()
    );
    return { id, username, role };
  }

  function verify(username, password) {
    const user = getByUsername(username);
    if (!user) return null;
    if (!verifyPassword(password, user.password_hash)) return null;
    return { id: user.id, username: user.username, role: user.role };
  }

  return { getByUsername, count, create, verify };
}

module.exports = { createAdminUsersService };
