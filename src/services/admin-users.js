/**
 * @file        packages/coordinator/src/services/admin-users.js
 * @description User accounts (§10.3): roles, blocking, passwords, each user's access key, and per-user profile settings (§10.1)
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
  { promisify } = require('node:util'),
  { v4: uuid } = require('uuid'),
  { normalize: normalizeListPrefs } = require('./list-prefs'),
  { generateToken, hashToken } = require('./tokens');

// Stored as "<salt hex>:<scrypt hex>". The synchronous one is only for the
// CLI and startup (thub-admin create-admin, the bootstrap password); every
// request uses the async versions, which run scrypt on libuv's thread pool —
// scryptSync would stall every request for each sign-in attempt.
const scrypt = promisify(crypto.scrypt);

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex'),
    derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

async function hashPasswordAsync(password){
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

async function verifyPassword(password, stored){
  const [salt, derived] = (stored || DUMMY_HASH).split(':'),
    check = await scrypt(String(password ?? ''), salt, 64);
  return crypto.timingSafeEqual(check, Buffer.from(derived, 'hex'));
}

// Checked instead of a real hash when the username doesn't exist, so that
// answer takes as long as a wrong password and doesn't reveal which
// usernames exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex')),

  // Presets offered on the profile page (§10.1) — a fixed list rather than a
  // free-text field, so a user can't accidentally set a 3-second or 10-year
  // idle timeout.
  SESSION_TIMEOUT_OPTIONS_MIN = [15, 30, 60, 120, 240, 480, 1440],
  THEMES = ['auto', 'light', 'dark'],

  // §10.3. user: the Agent only (submit jobs, read their own results);
  // maintainer: + the dashboard, without its security features; admin: all.
  ROLES = ['user', 'maintainer', 'admin'],
  DASHBOARD_ROLES = ['maintainer', 'admin'],
  USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/,
  EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/,
  // Access keys: thk_ + 256 random bits, stored hashed like every token (§12).
  KEY_PREFIX = 'thk';

// How a role is shown: User, Maintainer, Admin (stored and typed lowercase).
function roleLabel(role){
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : role;
}

// The role a request names, in any case: `viewer` (before §10.3) is now
// maintainer.
function normalizeRole(role){
  const lower = String(role ?? '').trim().toLowerCase(),
    r = lower === 'viewer' ? 'maintainer' : lower;
  if (!ROLES.includes(r)){
    throw Object.assign(new Error(`role must be one of: ${ROLES.join(', ')}`), { status: 400 });
  }
  return r;
}

function bad(message, status = 400){
  return Object.assign(new Error(message), { status });
}

// A readable one-time password: shown once to the admin, changed at the
// first sign-in.
function tempPassword(){
  return crypto.randomBytes(12).toString('base64url');
}

function toProfile(row){
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    role: row.role,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarPath: row.avatar_path,
    timezone: row.timezone,
    theme: row.theme,
    sessionTimeoutMin: row.session_timeout_min,
    listPrefs: parseListPrefs(row.list_prefs),
    blocked: Boolean(row.blocked_at),
    blockedAt: row.blocked_at || null,
    mustChangePassword: Boolean(row.must_change_password),
    hasPassword: Boolean(row.password_hash),
    canUseDashboard: DASHBOARD_ROLES.includes(row.role)
  };
}

function parseListPrefs(json){
  try {
    const prefs = JSON.parse(json || '{}');
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  }
  catch {
    return {};
  }
}

// §10.3: every account — dashboard sign-in for maintainers and admins, an
// access key for the Agent for anyone. `events` (the audit log) is optional
// so the profile/password functions can be used on their own (tests).
function createAdminUsersService(db, { events } = {}){
  const audit = (id, type, data) => events?.record('user', id, type, data);

  function getByUsername(username){
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  function getById(id){
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toProfile(row) : null;
  }

  function count(){
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  function activeAdmins(){
    return db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\' AND blocked_at IS NULL').get().n;
  }

  // The access key of a user: its agents row (hash, hint, last use, the Agent
  // version it reported), or null.
  function keyOf(userId){
    return db.prepare('SELECT * FROM agents WHERE user_id = ?').get(userId) || null;
  }

  // Users page: every user with their key's state.
  function list(){
    return db.prepare(
      `SELECT u.*, a.id AS key_id, a.token_hint, a.token_created_at, a.last_used_at AS key_last_used_at,
              a.revoked_at AS key_revoked_at, a.version AS agent_version, a.update_to AS agent_update_to
       FROM users u LEFT JOIN agents a ON a.user_id = u.id
       ORDER BY u.username COLLATE NOCASE`
    ).all().map((row) => ({
      ...toProfile(row),
      createdAt: row.created_at,
      key: row.key_id && !row.key_revoked_at
        ? { id: row.key_id, hint: row.token_hint, createdAt: row.token_created_at, lastUsedAt: row.key_last_used_at,
          version: row.agent_version, updateTo: row.agent_update_to }
        : null
    }));
  }

  function checkUsername(username, exceptId){
    const name = String(username ?? '').trim();
    if (!USERNAME_RE.test(name)){
      throw bad('Username: 1–64 letters, digits or . _ @ + -');
    }
    const owner = getByUsername(name);
    if (owner && owner.id !== exceptId){
      throw bad(`Username "${name}" is already taken`, 409);
    }
    return name;
  }

  function checkEmail(email, exceptId){
    const value = String(email ?? '').trim();
    if (!EMAIL_RE.test(value)){
      throw bad('Email: a valid address, like jane@example.com');
    }
    const owner = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(value);
    if (owner && owner.id !== exceptId){
      throw bad(`Email "${value}" is already used by another user`, 409);
    }
    return value;
  }

  // Nobody may remove the last way in: the last active admin can't be
  // blocked, demoted or deleted, and an admin can't do that to themselves.
  function guardAdmins(target, { actorId, losesAdmin }){
    if (!losesAdmin || target.role !== 'admin' || target.blocked_at){
      return;
    }
    if (actorId && actorId === target.id){
      throw bad('You can\'t block, demote or delete your own account — ask another admin', 409);
    }
    if (activeAdmins() <= 1){
      throw bad('This is the last active admin — make someone else an admin first', 409);
    }
  }

  // `email` is required where people create users (dashboard, thub-admin
  // user add); the bootstrap admin (THUB_BOOTSTRAP_ADMIN_PASSWORD) and older
  // callers may leave it out — the Users page flags a missing one.
  // A dashboard role without a password gets a temporary one, returned
  // once, to be changed at the first sign-in.
  function create({ username, email, role, password, firstName, lastName, requireEmail = false }, { by } = {}){
    const id = `usr_${uuid()}`,
      name = checkUsername(username),
      r = normalizeRole(role),
      mail = email || requireEmail ? checkEmail(email) : '',
      temp = !password && DASHBOARD_ROLES.includes(r) ? tempPassword() : null,
      pw = password || temp;
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, first_name, last_name, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, mail, pw ? hashPassword(pw) : null, r, firstName || null, lastName || null, temp ? 1 : 0, new Date().toISOString());
    audit(id, 'user.created', { by, username: name, role: r });
    return { id, username: name, role: r, tempPassword: temp };
  }

  // Exceptional password reset (README §13.1): resets an *existing*
  // user's password without touching their role (a reset shouldn't
  // silently promote anyone to admin), or creates one as admin if the
  // named account doesn't exist yet — the original first-run bootstrap
  // case, now handled by the same path.
  function resetPassword({ username, password, role = 'admin' }){
    const existing = getByUsername(username);
    if (existing){
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(password), existing.id);
      return { id: existing.id, username, role: existing.role };
    }
    return create({ username, password, role });
  }

  // Users page: a new temporary password for someone who lost theirs.
  function adminResetPassword(id, { by } = {}){
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target){
      throw bad('Unknown user', 404);
    }
    if (!DASHBOARD_ROLES.includes(target.role)){
      throw bad(`${target.username} has no dashboard access (role User) — there's no password to reset`);
    }
    const temp = tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(temp), id);
    audit(id, 'user.password_reset', { by });
    return temp;
  }

  // Self-service password change (§10.1) — requires knowing the *current*
  // password, unlike the resets above. Clears "must change".
  async function changePassword(id, currentPassword, newPassword){
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash)) || !row.password_hash){
      throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
    }
    if (!newPassword){
      throw Object.assign(new Error('New password must not be empty'), { status: 400 });
    }
    if (newPassword === currentPassword){
      throw bad('Choose a password different from the current one');
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPasswordAsync(newPassword), id);
    audit(id, 'user.password_changed', {});
  }

  // Async (thread pool); the same work whether or not the user exists, or
  // has a password at all.
  async function verify(username, password){
    const user = getByUsername(String(username ?? '')),
      ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    return user && user.password_hash && ok ? toProfile(user) : null;
  }

  // Users page edit: username, email, role, names. Guards the last admin.
  function update(id, fields, { by, actorId } = {}){
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target){
      throw bad('Unknown user', 404);
    }
    const next = {
      username: fields.username !== undefined ? checkUsername(fields.username, id) : target.username,
      email: fields.email !== undefined ? checkEmail(fields.email, id) : target.email,
      role: fields.role !== undefined ? normalizeRole(fields.role) : target.role,
      first_name: fields.firstName !== undefined ? fields.firstName || null : target.first_name,
      last_name: fields.lastName !== undefined ? fields.lastName || null : target.last_name
    };
    guardAdmins(target, { actorId, losesAdmin: next.role !== 'admin' });
    // Promoted to the dashboard without a password: a temporary one.
    const temp = DASHBOARD_ROLES.includes(next.role) && !target.password_hash ? tempPassword() : null;
    db.transaction(() => {
      db.prepare('UPDATE users SET username = ?, email = ?, role = ?, first_name = ?, last_name = ? WHERE id = ?')
        .run(next.username, next.email, next.role, next.first_name, next.last_name, id);
      if (temp){
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(temp), id);
      }
      // The key's agents row carries the name the job lists show.
      db.prepare('UPDATE agents SET name = ? WHERE user_id = ?').run(next.username, id);
    })();
    const changed = Object.keys(next).filter((k) => next[k] !== target[k]);
    if (changed.length){
      audit(id, 'user.updated', { by, changed, ...(next.role !== target.role ? { role: { from: target.role, to: next.role } } : {}) });
    }
    return { user: getById(id), tempPassword: temp };
  }

  // Block: no sign-in, no Agent — at once (the session check and the key
  // check read it on every request). Unblock gives both back.
  function setBlocked(id, blocked, { by, actorId } = {}){
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target){
      throw bad('Unknown user', 404);
    }
    if (blocked){
      guardAdmins(target, { actorId, losesAdmin: true });
    }
    db.prepare('UPDATE users SET blocked_at = ? WHERE id = ?').run(blocked ? new Date().toISOString() : null, id);
    audit(id, blocked ? 'user.blocked' : 'user.unblocked', { by });
    return getById(id);
  }

  // Delete: the account goes; its jobs stay, still listed under its name —
  // its key's agents row is kept, revoked and unlinked.
  function remove(id, { by, actorId } = {}){
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target){
      throw bad('Unknown user', 404);
    }
    guardAdmins(target, { actorId, losesAdmin: true });
    db.transaction(() => {
      db.prepare('UPDATE agents SET user_id = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(new Date().toISOString(), id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
    audit(id, 'user.deleted', { by, username: target.username });
  }

  // A new access key for the user — their first, or one replacing the old
  // (which stops working at once). Returned once; only its hash and last
  // characters are kept. The key's row stays the same, so the user's jobs
  // stay theirs.
  function issueKey(userId, { by } = {}){
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user){
      throw bad('Unknown user', 404);
    }
    const key = generateToken(KEY_PREFIX),
      now = new Date().toISOString(),
      existing = keyOf(userId);
    if (existing){
      db.prepare('UPDATE agents SET token_hash = ?, token_hint = ?, token_created_at = ?, revoked_at = NULL, name = ? WHERE id = ?')
        .run(hashToken(key), key.slice(-4), now, user.username, existing.id);
    }
    else {
      db.prepare(`INSERT INTO agents (id, name, kind, token_hash, token_hint, token_created_at, created_at, user_id)
                  VALUES (?, ?, 'cli', ?, ?, ?, ?, ?)`)
        .run(`agt_${uuid()}`, user.username, hashToken(key), key.slice(-4), now, now, userId);
    }
    audit(userId, existing ? 'user.key_rotated' : 'user.key_created', { by });
    return key;
  }

  function revokeKey(userId, { by } = {}){
    const n = db.prepare('UPDATE agents SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), userId).changes;
    if (n){
      audit(userId, 'user.key_revoked', { by });
    }
    return n > 0;
  }

  // Partial update — only the fields present in `fields` are touched, so a
  // theme-only PATCH (the navbar toggle, §10.1) doesn't require resending
  // the whole profile. Username is unique like at creation time; changing
  // it to one already held by a *different* account is a conflict, not a
  // silent overwrite.
  function updateProfile(id, fields){
    if (fields.username !== undefined){
      checkUsername(fields.username, id);
    }
    if (fields.email !== undefined && fields.email !== ''){
      checkEmail(fields.email, id);
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
        email: fields.email !== undefined ? String(fields.email).trim() : undefined,
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

    db.prepare(`UPDATE users SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...set.map(([, v]) => v),
      id
    );
    if (fields.username !== undefined){
      db.prepare('UPDATE agents SET name = ? WHERE user_id = ?').run(fields.username, id);
    }
    return getById(id);
  }

  // Remembers one list page's view (size/sort/dir, §10.1) for this user;
  // stored normalized, so only valid values ever reach the profile.
  function setListPrefs(id, list, prefs){
    const row = db.prepare('SELECT list_prefs FROM users WHERE id = ?').get(id);
    if (!row){
      throw Object.assign(new Error('Unknown user'), { status: 404 });
    }
    const all = { ...parseListPrefs(row.list_prefs), [list]: normalizeListPrefs(list, prefs) };
    db.prepare('UPDATE users SET list_prefs = ? WHERE id = ?').run(JSON.stringify(all), id);
    return getById(id);
  }

  // Users page: recent account events (who did what to which user).
  function recentEvents(limit = 30){
    return db.prepare('SELECT * FROM events WHERE entity = \'user\' ORDER BY id DESC LIMIT ?').all(limit)
      .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : {} }));
  }

  return {
    getByUsername,
    getById,
    count,
    list,
    keyOf,
    create,
    update,
    setBlocked,
    remove,
    resetPassword,
    adminResetPassword,
    changePassword,
    verify,
    updateProfile,
    setListPrefs,
    issueKey,
    revokeKey,
    recentEvents,
    SESSION_TIMEOUT_OPTIONS_MIN,
    THEMES,
    ROLES
  };
}

module.exports = { createAdminUsersService, SESSION_TIMEOUT_OPTIONS_MIN, THEMES, ROLES, DASHBOARD_ROLES, normalizeRole, roleLabel };
