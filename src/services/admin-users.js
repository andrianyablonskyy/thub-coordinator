/**
 * @file        packages/coordinator/src/services/admin-users.js
 * @description Admin user accounts: password hashing and verification for the dashboard login
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

const crypto = require('node:crypto'),
  { v4: uuid } = require('uuid');

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex'),
    derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored){
  const [salt, derived] = stored.split(':'),
    check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(derived, 'hex'));
}

// §10: dashboard login uses its own admin/viewer account table with
// session cookies — deliberately separate from the API bearer tokens.
function createAdminUsersService(db){
  function getByUsername(username){
    return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  }

  function count(){
    return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  }

  function create({ username, password, role }){
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

  function verify(username, password){
    const user = getByUsername(username);
    if (!user){
      return null;
    }
    if (!verifyPassword(password, user.password_hash)){
      return null;
    }
    return { id: user.id, username: user.username, role: user.role };
  }

  return { getByUsername, count, create, verify };
}

module.exports = { createAdminUsersService };
