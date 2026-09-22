/**
 * @file        packages/coordinator/test/admin-users.test.js
 * @description Tests: admin user profile defaults, partial updates, and username/theme/timeout validation
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  { openDb } = require('../src/db'),
  { createAdminUsersService } = require('../src/services/admin-users');

function buildService(){
  const db = openDb(':memory:');
  return createAdminUsersService(db);
}

test('a newly created user gets profile defaults (UTC, auto theme, 60min timeout)', () => {
  const adminUsers = buildService();
  adminUsers.create({ username: 'alice', password: 'hunter2', role: 'admin' });

  const user = adminUsers.verify('alice', 'hunter2');
  assert.equal(user.timezone, 'UTC');
  assert.equal(user.theme, 'auto');
  assert.equal(user.sessionTimeoutMin, 60);
  assert.equal(user.firstName, null);
  assert.equal(user.avatarPath, null);
});

test('updateProfile only touches the fields passed, leaving the rest as-is', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'bob', password: 'hunter2', role: 'viewer' });

  adminUsers.updateProfile(id, { firstName: 'Bob', lastName: 'Builder', timezone: 'America/New_York' });
  const afterFirst = adminUsers.getById(id);
  assert.equal(afterFirst.firstName, 'Bob');
  assert.equal(afterFirst.timezone, 'America/New_York');
  assert.equal(afterFirst.username, 'bob'); // untouched

  adminUsers.updateProfile(id, { theme: 'dark' });
  const afterSecond = adminUsers.getById(id);
  assert.equal(afterSecond.theme, 'dark');
  assert.equal(afterSecond.firstName, 'Bob'); // still there — partial update didn't clobber it
});

test('renaming a user to a username already held by someone else is rejected (409)', () => {
  const adminUsers = buildService();
  adminUsers.create({ username: 'alice', password: 'x', role: 'admin' });
  const { id: bobId } = adminUsers.create({ username: 'bob', password: 'x', role: 'viewer' });

  assert.throws(() => adminUsers.updateProfile(bobId, { username: 'alice' }), (err) => err.status === 409);
});

test('renaming a user to their own current username is not a conflict', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'alice', password: 'x', role: 'admin' });

  assert.doesNotThrow(() => adminUsers.updateProfile(id, { username: 'alice' }));
});

test('an invalid theme is rejected (400)', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'alice', password: 'x', role: 'admin' });

  assert.throws(() => adminUsers.updateProfile(id, { theme: 'rainbow' }), (err) => err.status === 400);
});

test('a session timeout outside the offered presets is rejected (400)', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'alice', password: 'x', role: 'admin' });

  assert.throws(() => adminUsers.updateProfile(id, { sessionTimeoutMin: 7 }), (err) => err.status === 400);
});

test('resetPassword creates the user as admin when the username does not exist yet', () => {
  const adminUsers = buildService();

  adminUsers.resetPassword({ username: 'admin', password: 'newpass' });
  const user = adminUsers.verify('admin', 'newpass');
  assert.ok(user);
  assert.equal(user.role, 'admin');
});

test('resetPassword on an existing user changes only the password, not the role', () => {
  const adminUsers = buildService();
  adminUsers.create({ username: 'carol', password: 'oldpass', role: 'viewer' });

  adminUsers.resetPassword({ username: 'carol', password: 'newpass' });

  assert.equal(adminUsers.verify('carol', 'oldpass'), null);
  const user = adminUsers.verify('carol', 'newpass');
  assert.ok(user);
  assert.equal(user.role, 'viewer'); // not silently promoted to admin
});

test('changePassword succeeds with the correct current password', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'dave', password: 'oldpass', role: 'admin' });

  adminUsers.changePassword(id, 'oldpass', 'newpass');

  assert.equal(adminUsers.verify('dave', 'oldpass'), null);
  assert.ok(adminUsers.verify('dave', 'newpass'));
});

test('changePassword is rejected (401) with the wrong current password, leaving it unchanged', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'dave', password: 'oldpass', role: 'admin' });

  assert.throws(() => adminUsers.changePassword(id, 'wrongpass', 'newpass'), (err) => err.status === 401);
  assert.ok(adminUsers.verify('dave', 'oldpass'));
});

test('changePassword rejects an empty new password (400)', () => {
  const adminUsers = buildService(),
    { id } = adminUsers.create({ username: 'dave', password: 'oldpass', role: 'admin' });

  assert.throws(() => adminUsers.changePassword(id, 'oldpass', ''), (err) => err.status === 400);
});
