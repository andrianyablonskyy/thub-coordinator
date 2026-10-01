/**
 * @file        packages/coordinator/test/login-guard.test.js
 * @description Tests: sign-in protection — backoff per IP and per username, async password checks, no username enumeration by timing
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
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { createLoginGuard } = require('../src/login-guard'),
  { openDb } = require('../src/db'),
  { createAdminUsersService } = require('../src/services/admin-users'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

test('backoff: per IP from the 5th failure, doubling up to 15 min; a success clears it', () => {
  let t = 0;
  const guard = createLoginGuard({ now: () => t });
  for (let i = 0; i < 4; i++){
    guard.failure('10.0.0.1', `u${i}`); // different names: only the IP counts up
    assert.equal(guard.check('10.0.0.1', 'any').ok, true);
  }
  guard.failure('10.0.0.1', 'u4'); // 5th
  assert.deepEqual(guard.check('10.0.0.1', 'any'), { ok: false, reason: 'backoff', retryAfterSec: 1 });
  assert.equal(guard.check('10.0.0.2', 'any').ok, true); // another address isn't affected
  t += 1000;
  guard.failure('10.0.0.1', 'u5'); // 6th: 2 s
  assert.equal(guard.check('10.0.0.1', 'any').retryAfterSec, 2);
  for (let i = 0; i < 20; i++){
    guard.failure('10.0.0.1', `v${i}`);
  }
  assert.equal(guard.check('10.0.0.1', 'any').retryAfterSec, 15 * 60); // capped
  guard.success('10.0.0.1', 'admin');
  assert.equal(guard.check('10.0.0.1', 'any').ok, true);
});

test('backoff: per username from the 10th failure, from any address, up to 5 min; forgotten after an hour', () => {
  let t = 0;
  const guard = createLoginGuard({ now: () => t });
  for (let i = 0; i < 9; i++){
    guard.failure(`10.0.1.${i}`, 'Admin'); // one guess per address
  }
  assert.equal(guard.check('10.0.9.9', 'admin').ok, true);
  guard.failure('10.0.1.9', ' ADMIN '); // 10th, any spelling
  assert.equal(guard.check('10.0.9.9', 'admin').ok, false); // even from a fresh address
  for (let i = 0; i < 30; i++){
    guard.failure(`10.0.2.${i}`, 'admin');
  }
  assert.equal(guard.check('10.0.9.9', 'admin').retryAfterSec, 5 * 60); // capped, its owner isn't locked out for long
  t += 61 * 60 * 1000;
  assert.equal(guard.check('10.0.9.9', 'admin').ok, true);
});

test('a limit on password checks running at once', async () => {
  const guard = createLoginGuard({ maxConcurrent: 1 });
  let release;
  const running = guard.run(() => new Promise((r) => (release = r)));
  assert.deepEqual(guard.check('ip', 'u'), { ok: false, reason: 'busy', retryAfterSec: 1 });
  release();
  await running;
  assert.equal(guard.check('ip', 'u').ok, true);
});

test('password checks don\'t block the event loop, and an unknown user takes as long as a wrong password', async () => {
  const users = createAdminUsersService(openDb(':memory:'));
  users.create({ username: 'alice', password: 'correct horse', role: 'admin' });

  // Timers keep firing while four checks run (scryptSync would stall them all).
  let last = performance.now(),
    worstGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, 5);
  await Promise.all([1, 2, 3, 4].map(() => users.verify('alice', 'wrong')));
  clearInterval(ticker);
  assert.ok(worstGap < 60, `event loop stalled for ${worstGap.toFixed(0)} ms`);

  const time = async (name) => {
      const start = performance.now();
      for (let i = 0; i < 4; i++){
        assert.equal(await users.verify(name, 'wrong'), null);
      }
      return performance.now() - start;
    },
    known = await time('alice'),
    unknown = await time('nobody');
  assert.ok(unknown > known * 0.5 && unknown < known * 2, `unknown user ${unknown.toFixed(0)} ms vs wrong password ${known.toFixed(0)} ms`);
  assert.ok((await users.verify('alice', 'correct horse')).id);
});

test('sign-in page: a locked-out guesser gets 429 with Retry-After, before any password is checked', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-guard-')),
    file = path.join(dir, 'coordinator.json');
  // The per-IP sign-in budget off, to see the backoff on its own.
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 }, rateLimit: { loginPerMinute: 0 } }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  services.adminUsers.create({ username: 'admin', password: 'right', role: 'admin' });
  const base = `http://127.0.0.1:${server.address().port}`,
    // The test reaches the Coordinator over loopback, which trustProxy
    // trusts: X-Forwarded-For stands in for different client addresses.
    login = (ip, username, password) => fetch(`${base}/login`, {
      method: 'POST', headers: { 'X-Forwarded-For': ip }, body: new URLSearchParams({ username, password }), redirect: 'manual'
    }),
    verify = t.mock.method(services.adminUsers, 'verify');

  for (let i = 0; i < 5; i++){
    assert.equal((await login('203.0.113.7', `guess${i}`, 'x')).status, 401);
  }
  const locked = await login('203.0.113.7', 'admin', 'right'); // even the right password waits
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '1');
  assert.match(await locked.text(), /Too many failed sign-ins — try again in 1 s/);
  assert.equal(verify.mock.callCount(), 5); // the 6th never reached a password check

  assert.equal((await login('198.51.100.1', 'admin', 'right')).status, 302); // the owner, elsewhere, signs in
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await login('203.0.113.7', 'admin', 'right')).status, 302); // after the wait, and a success clears it
  assert.equal((await login('203.0.113.7', 'nobody', 'x')).status, 401); // counting starts over
});
