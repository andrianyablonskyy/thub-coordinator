/**
 * @file        packages/coordinator/test/dev-mode.test.js
 * @description Tests: DEV mode (virtual agent, Clients and jobs) — only with DEV_MODE=1 and a bootstrap password
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
  { loadConfig } = require('../src/config'),
  { buildServices } = require('../src/server'),
  { startDevMode, isDevMode, DEV_AGENT_TOKEN } = require('../src/dev/virtual'),
  { hashToken } = require('../src/services/tokens');

test('DEV mode needs both DEV_MODE=1 and THUB_BOOTSTRAP_ADMIN_PASSWORD', () => {
  assert.equal(isDevMode({ DEV_MODE: '1', THUB_BOOTSTRAP_ADMIN_PASSWORD: 'pw' }), true);
  assert.equal(isDevMode({ DEV_MODE: '1' }), false);
  assert.equal(isDevMode({ THUB_BOOTSTRAP_ADMIN_PASSWORD: 'pw' }), false);
  assert.equal(isDevMode({ DEV_MODE: 'true', THUB_BOOTSTRAP_ADMIN_PASSWORD: 'pw' }), false);
});

test('seeds a virtual agent, virtual Clients and jobs once; nothing outside DEV mode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-dev-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 } }));
  const config = loadConfig(file),
    services = buildServices(config),
    count = (table) => services.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    warn = t.mock.method(console, 'warn', () => {});

  assert.equal(startDevMode(services, config, {}), null);
  assert.equal(count('agents') + count('resources') + count('jobs'), 0);

  const env = { DEV_MODE: '1', THUB_BOOTSTRAP_ADMIN_PASSWORD: 'pw' },
    first = startDevMode(services, config, env);
  t.after(() => first.stop());
  assert.equal(services.agents.getByTokenHash(hashToken(DEV_AGENT_TOKEN)).name, 'virtual-agent');
  assert.deepEqual(services.registry.list().map((r) => r.name).sort(), ['virtual-hw-01', 'virtual-sw-01']);
  const jobs = count('jobs'),
    states = new Set(services.db.prepare('SELECT state FROM jobs').all().map((r) => r.state));
  assert.equal(jobs, 15);
  for (const s of ['PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELED', 'LOST', 'QUEUED']){
    assert.ok(states.has(s), s);
  }

  const second = startDevMode(services, config, env); // a restart
  t.after(() => second.stop());
  assert.equal(count('jobs'), jobs);
  assert.equal(count('agents'), 1);
  assert.equal(count('resources'), 2);
  assert.equal(warn.mock.callCount(), 2);
});
