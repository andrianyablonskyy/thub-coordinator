/**
 * @file        packages/coordinator/src/services/admin-users.js
 * @description Admin user accounts: password hashing/verification and per-user profile settings (§10.1)
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

// Presets offered on the profile page (§10.1) — a fixed list rather than a
// free-text field, so a user can't accidentally set a 3-second or 10-year
// idle timeout.
const SESSION_TIMEOUT_OPTIONS_MIN = [15, 30, 60, 120, 240, 480, 1440],
  THEMES = ['auto', 'light', 'dark'];

function toProfile(row){
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarPath: row.avatar_path,
    timezone: row.timezone,
    theme: row.theme,
    sessionTimeoutMin: row.session_timeout_min
  };
}

// §10: dashboard login uses its own admin/viewer account table with
// session cookies — deliberately separate from the API bearer tokens.
function createAdminUsersService(db){
  function getByUsername(username){
    return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  }

  function getById(id){
    const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    return row ? toProfile(row) : null;
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

  // Exceptional password reset (README §13.1): resets an *existing*
  // user's password without touching their role (a reset shouldn't
  // silently promote a viewer to admin), or creates one as admin if the
  // named account doesn't exist yet — the original first-run bootstrap
  // case, now handled by the same path.
  function resetPassword({ username, password, role = 'admin' }){
    const existing = getByUsername(username);
    if (existing){
      db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
      return { id: existing.id, username, role: existing.role };
    }
    return create({ username, password, role });
  }

  // Self-service password change (§10.1) — requires knowing the *current*
  // password, unlike resetPassword() above (that's the admin/operator
  // break-glass path, which deliberately doesn't need it).
  function changePassword(id, currentPassword, newPassword){
    const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    if (!row || !verifyPassword(currentPassword, row.password_hash)){
      throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
    }
    if (!newPassword){
      throw Object.assign(new Error('New password must not be empty'), { status: 400 });
    }
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id);
  }

  function verify(username, password){
    const user = getByUsername(username);
    if (!user){
      return null;
    }
    if (!verifyPassword(password, user.password_hash)){
      return null;
    }
    return toProfile(user);
  }

  // Partial update — only the fields present in `fields` are touched, so a
  // theme-only PATCH (the navbar toggle, §10.1) doesn't require resending
  // the whole profile. Username is unique like at creation time; changing
  // it to one already held by a *different* account is a conflict, not a
  // silent overwrite.
  function updateProfile(id, fields){
    if (fields.username !== undefined){
      const owner = getByUsername(fields.username);
      if (owner && owner.id !== id){
        throw Object.assign(new Error(`Username "${fields.username}" is already taken`), { status: 409 });
      }
    }
    if (fields.theme !== undefined && !THEMES.includes(fields.theme)){
      throw Object.assign(new Error(`theme must be one of: ${THEMES.join(', ')}`), { status: 400 });
    }
    if (fields.sessionTimeoutMin !== undefined && !SESSION_TIMEOUT_OPTIONS_MIN.includes(fields.sessionTimeoutMin)){
      throw Object.assign(new Error(`sessionTimeoutMin must be one of: ${SESSION_TIMEOUT_OPTIONS_MIN.join(', ')}`), {
        status: 400
      });
    }

    const columns = {
        username: fields.username,
        first_name: fields.firstName,
        last_name: fields.lastName,
        avatar_path: fields.avatarPath,
        timezone: fields.timezone,
        theme: fields.theme,
        session_timeout_min: fields.sessionTimeoutMin
      },
      set = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (set.length === 0){
      return getById(id);
    }

    db.prepare(`UPDATE admin_users SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...set.map(([, v]) => v),
      id
    );
    return getById(id);
  }

  return {
    getByUsername,
    getById,
    count,
    create,
    resetPassword,
    changePassword,
    verify,
    updateProfile,
    SESSION_TIMEOUT_OPTIONS_MIN,
    THEMES
  };
}

module.exports = { createAdminUsersService, SESSION_TIMEOUT_OPTIONS_MIN, THEMES };
