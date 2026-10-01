/**
 * @file        packages/coordinator/test/settings.test.js
 * @description Tests: Coordinator settings from the dashboard — precedence, validation, applying now vs after a restart, the page, thub-admin reset
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
  { spawnSync } = require('node:child_process'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

function configFile(extra = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-settings-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 },
    publicUrl: 'http://thub.lab', jobs: { defaultTimeoutSec: 1800, maxTimeoutSec: 14400 }, ...extra
  }));
  return file;
}

const byKey = (list) => Object.fromEntries(list.map((s) => [s.key, s]));

test('settings: dashboard values override the file, "now" ones apply at once, "restart" ones at the next start', () => {
  const file = configFile(),
    config = loadConfig(file),
    { settings } = buildServices(config);

  assert.equal(byKey(settings.list())['jobs.maxTimeoutSec'].source, 'file');
  const result = settings.save(
    { changes: { 'jobs.maxTimeoutSec': '3600', 'scheduler.tickIntervalSec': '30', 'scheduler.requeueOnLost': 'false' } },
    { by: 'alice' }
  );
  assert.deepEqual(result.now.sort(), ['jobs.maxTimeoutSec', 'scheduler.requeueOnLost']);
  assert.deepEqual(result.restart, ['scheduler.tickIntervalSec']);

  // Applied now: every service reads the same config object.
  assert.equal(config.jobs.maxTimeoutSec, 3600);
  assert.equal(config.scheduler.requeueOnLost, false);
  // Not yet: shown as pending.
  assert.equal(config.scheduler.tickIntervalSec, 10);
  const list = byKey(settings.list());
  assert.equal(list['scheduler.tickIntervalSec'].pendingRestart, true);
  assert.equal(list['jobs.maxTimeoutSec'].source, 'dashboard');
  assert.equal(list['jobs.maxTimeoutSec'].updatedBy, 'alice');

  // The next start (same database) runs with them all.
  const config2 = loadConfig(file),
    { settings: settings2 } = buildServices(config2);
  assert.equal(config2.scheduler.tickIntervalSec, 30);
  assert.equal(config2.jobs.maxTimeoutSec, 3600);
  assert.equal(byKey(settings2.list())['scheduler.tickIntervalSec'].pendingRestart, false);

  // Reset: back to the config file's value.
  settings2.save({ reset: ['jobs.maxTimeoutSec'] });
  assert.equal(config2.jobs.maxTimeoutSec, 14400);
  assert.equal(byKey(settings2.list())['jobs.maxTimeoutSec'].source, 'file');
});

test('settings: validated all-or-nothing; env-locked ones can\'t change; bad stored values are skipped at startup', (t) => {
  const file = configFile(),
    config = loadConfig(file),
    { settings, db } = buildServices(config);

  assert.throws(() => settings.save({ changes: { 'jobs.maxTimeoutSec': '600', publicUrl: 'not a url' } }), /Public URL: must be a URL/);
  assert.equal(config.jobs.maxTimeoutSec, 14400); // nothing saved
  assert.throws(() => settings.save({ changes: { 'jobs.defaultTimeoutSec': '7200', 'jobs.maxTimeoutSec': '3600' } }), /longer than the maximum/);
  assert.throws(() => settings.save({ changes: { clientJoinKey: 'short' } }), /at least 16 characters/);
  assert.throws(() => settings.save({ changes: { 'retention.jobRetention': '5y' } }), /must be one of/);
  settings.save({ changes: { publicUrl: 'https://thub.example.com/', clientJoinKey: 'jk_0123456789abcdef' } });
  assert.equal(config.publicUrl, 'https://thub.example.com'); // trailing slash dropped
  assert.equal(config.clientJoinKey, 'jk_0123456789abcdef');
  settings.save({ changes: { clientJoinKey: '' } }); // cleared: registration off
  assert.equal(config.clientJoinKey, null);

  // A value an older version stored that this one rejects: ignored, warned.
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('retention.jobRetention', '"5y"', 'x');
  const warn = t.mock.method(console, 'warn', () => {}),
    config2 = loadConfig(file);
  buildServices(config2);
  assert.equal(config2.retention.jobRetention, 'forever');
  assert.match(warn.mock.calls[0].arguments[0], /Ignoring dashboard setting retention\.jobRetention/);

  // The environment wins, and the dashboard can't override it.
  const prev = process.env.THUB_PUBLIC_URL;
  process.env.THUB_PUBLIC_URL = 'https://from-env.example';
  t.after(() => (prev === undefined ? delete process.env.THUB_PUBLIC_URL : (process.env.THUB_PUBLIC_URL = prev)));
  const config3 = loadConfig(file),
    { settings: settings3 } = buildServices(config3);
  assert.equal(config3.publicUrl, 'https://from-env.example');
  assert.equal(byKey(settings3.list()).publicUrl.source, 'env');
  assert.deepEqual(settings3.save({ changes: { publicUrl: 'https://other.example' } }).changed, []);
  assert.equal(config3.publicUrl, 'https://from-env.example');
});

test('settings page: admins only; saves; refuses a setting that would lock everyone out', async (t) => {
  const config = loadConfig(configFile()),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  services.adminUsers.create({ username: 'view', password: 'pw', role: 'viewer' });
  const login = async (u) => (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: u, password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    admin = await login('admin'),
    viewer = await login('view'),
    post = (body) => fetch(`${base}/admin/settings`, { method: 'POST', headers: { cookie: admin }, body: new URLSearchParams(body), redirect: 'manual' }),
    page = async () => (await fetch(`${base}/admin/settings`, { headers: { cookie: admin } })).text();

  assert.equal((await fetch(`${base}/admin/settings`, { headers: { cookie: viewer } })).status, 403);
  const html = await page();
  assert.match(html, /name="s\[jobs\.maxTimeoutSec\]"/);
  assert.match(html, /href="\/admin\/settings"/); // navbar link
  assert.doesNotMatch(html, /test-secret-test-secret/); // secrets never in the page

  // A checkbox posts "false" then (checked) "true"; the last one wins.
  await post([['s[jobs.maxTimeoutSec]', '7200'], ['s[scheduler.requeueOnLost]', 'false']]);
  assert.equal(config.jobs.maxTimeoutSec, 7200);
  assert.equal(config.scheduler.requeueOnLost, false);
  assert.match(await page(), /Saved and applied: Maximum job timeout \(s\), Retry lost jobs\./);

  // An empty secret field leaves the key alone; "clear" removes it.
  await post({ 's[clientJoinKey]': 'jk_0123456789abcdef' });
  await post({ 's[clientJoinKey]': '' });
  assert.equal(config.clientJoinKey, 'jk_0123456789abcdef');
  await post({ 'clear[clientJoinKey]': '1' });
  assert.equal(config.clientJoinKey, null);

  // Over plain HTTP, an HTTPS-only cookie would lock everyone out: refused.
  await post({ 's[session.secureCookie]': 'true' });
  assert.match(await page(), /you&#39;re connected over plain HTTP|you're connected over plain HTTP/);
  assert.equal(services.settings.list().find((s) => s.key === 'session.secureCookie').source, 'file');

  // Not under systemd: no restart.
  assert.equal((await fetch(`${base}/admin/settings/restart`, { method: 'POST', headers: { cookie: admin }, redirect: 'manual' })).status, 302);
  assert.match(await page(), /isn&#39;t running under systemd|isn't running under systemd/);
});

test('thub-admin settings reset: the way back from a bad setting', () => {
  const file = configFile(),
    config = loadConfig(file),
    { settings } = buildServices(config);
  settings.save({ changes: { 'jobs.maxTimeoutSec': '3600', 'scheduler.maxQueuedPerAgent': '5' } });
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'thub-admin.js'), 'settings', ...args], {
    env: { ...process.env, THUB_COORDINATOR_CONFIG: file }, encoding: 'utf8'
  });
  assert.match(run('list').stdout, /jobs\.maxTimeoutSec = 3600/);
  assert.match(run('reset', 'jobs.maxTimeoutSec').stdout, /Removed 1 dashboard setting/);
  assert.match(run('reset').stdout, /Removed 1 dashboard setting/);
  assert.match(run('list').stdout, /No settings changed from the dashboard/);
});

test('heartbeat interval from Settings: sent in every reply; lowering it gives Clients time to switch', async (t) => {
  const config = loadConfig(configFile()),
    services = buildServices(config),
    { settings, registry, heartbeatMonitor, db } = services,
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  const { resourceId, resourceToken } = registry.registerAuto({ clientId: 'c1', name: 'lab-1', type: 'sw', labels: [] }),
    beat = () => fetch(`http://127.0.0.1:${server.address().port}/api/v1/resources/${resourceId}/heartbeat`, {
      method: 'POST', headers: { authorization: `Bearer ${resourceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'idle' })
    }).then((r) => r.json()),
    status = () => registry.get(resourceId).status;

  assert.equal((await beat()).heartbeatIntervalSec, 10);
  settings.save({ changes: { 'heartbeat.intervalSec': '5' } });
  assert.equal((await beat()).heartbeatIntervalSec, 5); // the next reply carries it

  // Last heard from 25 s ago, still on the old 10 s interval: within 3 × 10 s.
  const now = Date.now(),
    lastBeat = (ageSec) => db.prepare('UPDATE resources SET last_heartbeat_at = ? WHERE id = ?').run(new Date(now - ageSec * 1000).toISOString(), resourceId);
  lastBeat(25);
  heartbeatMonitor.sweepOnce(now); // 3 × 5 s alone would call it gone
  assert.notEqual(status(), 'OUT_OF_SERVICE');
  // Once every Client has had (missedLimit + 1) old intervals to switch, the new one counts.
  heartbeatMonitor.sweepOnce(now + 41_000);
  assert.equal(status(), 'OUT_OF_SERVICE');

  // missedLimit applies at once, too.
  settings.save({ changes: { 'heartbeat.missedLimit': '6', 'heartbeat.sweepIntervalSec': '2' } });
  assert.equal(config.heartbeat.missedLimit, 6);
  assert.equal(config.heartbeat.sweepIntervalSec, 5); // a timer: after a restart
});
