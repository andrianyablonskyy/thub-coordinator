/**
 * @file        packages/coordinator/test/rate-limit.test.js
 * @description Tests: request rate limiting — token buckets per credential (IP without one), the sign-in limit, configuration
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
  { createBuckets } = require('../src/rate-limit'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

test('token bucket: a burst up to the limit, then refills at limit per minute', () => {
  const b = createBuckets(),
    t0 = 1_000_000;
  for (let i = 0; i < 5; i++){
    assert.equal(b.take('k', 5, t0).ok, true);
  }
  const refused = b.take('k', 5, t0);
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterSec, 12); // one token per 60/5 s
  assert.equal(b.take('k', 5, t0 + 12_000).ok, true); // refilled one
  assert.equal(b.take('k', 5, t0 + 12_000).ok, false);
  assert.equal(b.take('other', 5, t0).ok, true); // its own bucket
  b.prune(() => 5, t0 + 120_000); // full again = forgotten
  assert.equal(b.size(), 0);
});

async function start(t, rateLimit){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-rl-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 }, rateLimit
  }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, services, config };
}

test('per credential: each token has its own budget, even from one IP; unknown tokens count by IP', async (t) => {
  const { base, services } = await start(t, { requestsPerMinute: 3, loginPerMinute: 0 }),
    tokenA = services.agents.create({ name: 'a', kind: 'ci' }).token,
    tokenB = services.agents.create({ name: 'b', kind: 'ci' }).token,
    get = (token) => fetch(`${base}/api/v1/resources`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  for (let i = 0; i < 3; i++){
    assert.equal((await get(tokenA)).status, 200);
  }
  const refused = await get(tokenA);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '20');
  assert.equal(refused.headers.get('ratelimit-limit'), '3');
  assert.match((await refused.json()).error, /Too many requests: try again in 20 s/);
  assert.equal((await get(tokenB)).status, 200); // a Client behind the same NAT isn't affected

  // Random tokens all land in the one IP bucket — no dodging the limit.
  for (let i = 0; i < 3; i++){
    assert.equal((await get(`agt_fake${i}`)).status, 401);
  }
  assert.equal((await get('agt_fake9')).status, 429);
});

test('sign-in attempts have their own small limit; 0 turns limits off; a dashboard change applies at once', async (t) => {
  const { base, services, config } = await start(t, { requestsPerMinute: 500, loginPerMinute: 3 }),
    login = () => fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'x', password: 'y' }), redirect: 'manual' });
  for (let i = 0; i < 3; i++){
    assert.equal((await login()).status, 401);
  }
  const refused = await login();
  assert.equal(refused.status, 429);
  assert.match(await refused.text(), /Too many sign-in attempts/);
  assert.equal((await fetch(`${base}/login`)).status, 200); // viewing the page isn't an attempt

  services.settings.save({ changes: { 'rateLimit.loginPerMinute': '0', 'rateLimit.requestsPerMinute': '0' } });
  assert.equal(config.rateLimit.loginPerMinute, 0);
  assert.equal((await login()).status, 401); // no longer limited
  assert.equal((await fetch(`${base}/login`)).headers.get('ratelimit-limit'), null);
});

test('config: rateLimit values must be whole numbers, 0 or more', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-rl-')),
    file = path.join(dir, 'coordinator.json'),
    write = (rateLimit) => fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), rateLimit }));
  write(undefined);
  assert.deepEqual(loadConfig(file).rateLimit, { requestsPerMinute: 500, loginPerMinute: 10 });
  write({ requestsPerMinute: -1 });
  assert.throws(() => loadConfig(file), /rateLimit\.requestsPerMinute must be a whole number/);
});
