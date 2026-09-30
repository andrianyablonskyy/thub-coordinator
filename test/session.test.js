/**
 * @file        packages/coordinator/test/session.test.js
 * @description Tests: dashboard sessions — the SQLite session store, sessions surviving a restart, and the Secure cookie flag
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
  { promisify } = require('node:util'),
  { openDb } = require('../src/db'),
  { SqliteSessionStore } = require('../src/services/session-store'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp, cookieSecure } = require('../src/server');

test('session store: get/set/touch/destroy, expired sessions dropped and pruned', async () => {
  let now = Date.parse('2026-09-30T12:00:00Z');
  const store = new SqliteSessionStore(openDb(':memory:'), { pruneIntervalMs: 0, now: () => now }),
    get = promisify(store.get.bind(store)),
    set = promisify(store.set.bind(store)),
    touch = promisify(store.touch.bind(store)),
    destroy = promisify(store.destroy.bind(store)),
    length = promisify(store.length.bind(store)),
    sess = (minutes) => ({ cookie: { expires: new Date(now + minutes * 60_000).toISOString() }, user: { id: 'u1' } });

  await set('a', sess(60));
  await set('b', sess(5));
  assert.deepEqual((await get('a')).user, { id: 'u1' });
  assert.equal(await get('nope'), null);
  assert.equal(await length(), 2);

  now += 10 * 60_000; // b's 5 minutes are up
  assert.equal(await get('b'), null); // expired: gone on read
  await touch('a', sess(60)); // activity moves a's expiry out
  now += 55 * 60_000;
  assert.ok(await get('a'));

  await set('c', sess(1));
  now += 2 * 60_000;
  assert.equal(store.prune(), 1); // c, never read again, swept
  assert.equal(await length(), 1);

  await destroy('a'); // logout
  assert.equal(await get('a'), null);
});

test('cookieSecure: Secure for an https publicUrl, per-request otherwise, or as configured', () => {
  assert.equal(cookieSecure({ publicUrl: 'https://thub.example.com', session: { secureCookie: 'auto' } }), true);
  assert.equal(cookieSecure({ publicUrl: 'http://localhost:8080', session: { secureCookie: 'auto' } }), 'auto');
  assert.equal(cookieSecure({ publicUrl: 'https://thub.example.com', session: { secureCookie: false } }), false);
  assert.equal(cookieSecure({ publicUrl: 'http://lab', session: { secureCookie: true } }), true);
});

// --- over HTTP ------------------------------------------------------------

function writeConfig(dir, extra = {}){
  const file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 }, ...extra
  }));
  return file;
}

async function start(t, file){
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const stop = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  });
  t.after(stop);
  return { base: `http://127.0.0.1:${server.address().port}`, services, stop };
}

const login = (base, headers = {}) => fetch(`${base}/login`, {
  method: 'POST', headers, body: new URLSearchParams({ username: 'admin', password: 'pw' }), redirect: 'manual'
});

test('a signed-in session survives a Coordinator restart', async (t) => {
  const file = writeConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-sess-'))),
    first = await start(t, file);
  first.services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  const cookie = (await login(first.base)).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${first.base}/jobs`, { headers: { cookie }, redirect: 'manual' })).status, 200);
  await first.stop();

  const second = await start(t, file); // same database, new process state
  assert.equal((await fetch(`${second.base}/jobs`, { headers: { cookie }, redirect: 'manual' })).status, 200);

  await fetch(`${second.base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal((await fetch(`${second.base}/jobs`, { headers: { cookie }, redirect: 'manual' })).status, 302);
});

test('https publicUrl: the session cookie is Secure; plain HTTP gets an explanation, not a login loop', async (t) => {
  const file = writeConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-sess-')), { publicUrl: 'https://thub.example.com' }),
    { base, services } = await start(t, file);
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });

  // Behind the (loopback, trusted) reverse proxy terminating TLS.
  const viaProxy = await login(base, { 'X-Forwarded-Proto': 'https' }),
    setCookie = viaProxy.headers.get('set-cookie');
  assert.equal(viaProxy.status, 302);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);

  // The proxy forgot X-Forwarded-Proto: no cookie could come back — say so.
  const plain = await login(base);
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get('set-cookie'), null);
  assert.match(await plain.text(), /Signing in needs HTTPS/);
  assert.match(await (await fetch(`${base}/login`)).text(), /X-Forwarded-Proto: https/);
});

test('config: session.secureCookie must be "auto", true or false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-sess-'));
  assert.equal(loadConfig(writeConfig(dir)).session.secureCookie, 'auto');
  assert.throws(() => loadConfig(writeConfig(dir, { session: { secureCookie: 'yes' } })), /session\.secureCookie must be/);
});
