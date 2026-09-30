/**
 * @file        packages/coordinator/test/logs.test.js
 * @description Tests: job log paging for the dashboard viewer, the full SSE replay, and the raw log (RAW button)
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
  { buildServices, createApp } = require('../src/server');

// A Coordinator on a random port, an admin session, and one job with `n`
// log lines ("line 1".."line n").
async function setup(t, n){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-logs-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 }
  }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  const login = await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'pw' }), redirect: 'manual'
    }),
    cookie = login.headers.get('set-cookie').split(';')[0],
    { agent } = services.agents.create({ name: 'ci', kind: 'ci' });
  services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] });
  const job = services.jobs.create({ agentId: agent.id, source: 'ci', spec: { target: { type: 'sw' }, command: './t.sh' } });
  for (let i = 0; i < n; i += 500){
    services.logs.appendBatch(job.id, Array.from({ length: Math.min(500, n - i) }, (_, k) => ({ stream: 'runner', line: `line ${i + k + 1}` })));
  }
  const finish = () => services.db.prepare('UPDATE jobs SET state = ?, finished_at = ? WHERE id = ?').run('PASSED', new Date().toISOString(), job.id);
  return { base, cookie, services, job, finish, get: (p) => fetch(`${base}${p}`, { headers: { cookie } }) };
}

test('log pages: the end first, then earlier pages until the start', async (t) => {
  const { get, job } = await setup(t, 2500),
    last = await (await get(`/jobs/${job.id}/logs?limit=1000`)).json();
  assert.equal(last.total, 2500);
  assert.equal(last.hasMore, true);
  assert.equal(last.lines.length, 1000);
  assert.equal(last.lines[0].line, 'line 1501');
  assert.equal(last.lines.at(-1).line, 'line 2500');

  const earlier = await (await get(`/jobs/${job.id}/logs?limit=1000&before=${last.lines[0].seq}`)).json();
  assert.deepEqual([earlier.lines[0].line, earlier.lines.at(-1).line, earlier.hasMore], ['line 501', 'line 1500', true]);

  const first = await (await get(`/jobs/${job.id}/logs?limit=1000&before=${earlier.lines[0].seq}`)).json();
  assert.deepEqual([first.lines.length, first.lines[0].line, first.hasMore], [500, 'line 1', false]);

  // Limits are clamped: never more than 5000 a request.
  assert.equal((await (await get(`/jobs/${job.id}/logs?limit=999999`)).json()).lines.length, 2500);
});

test('log stream replays every line, not just the first 500', async (t) => {
  const { get, job, finish } = await setup(t, 1234);
  finish();
  const text = await (await get(`/jobs/${job.id}/stream`)).text(),
    lines = [...text.matchAll(/^event: log$/gm)].length;
  assert.equal(lines, 1234);
  assert.match(text, /"line":"line 1234"/);
  assert.match(text, /event: end/);

  // Resuming after a seq replays only what follows it.
  const resumed = await (await get(`/jobs/${job.id}/stream?after=1200`)).text();
  assert.equal([...resumed.matchAll(/^event: log$/gm)].length, 34);
});

test('RAW: the whole log as plain text, for as long as the job exists', async (t) => {
  const { get, job, finish, services } = await setup(t, 6001),
    res = await get(`/jobs/${job.id}/log.txt`),
    text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-disposition'), new RegExp(`inline; filename="${job.id}.log"`));
  const rows = text.trimEnd().split('\n');
  assert.equal(rows.length, 6001); // more than one 5000-line page
  assert.match(rows[0], /^\[\d{4}-\d\d-\d\dT[^\]]+\] \[runner\] line 1$/);
  assert.match(rows.at(-1), /\] \[runner\] line 6001$/);

  // Still complete once the job has finished — no retention of its own
  // (log lines go with the job), and no artifact to fall back to.
  finish();
  assert.equal((await (await get(`/jobs/${job.id}/log.txt`)).text()).trimEnd().split('\n').length, 6001);
  services.db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(job.id);
  assert.equal(await (await get(`/jobs/${job.id}/log.txt`)).text(), '');

  assert.equal((await get('/jobs/M-99999/log.txt')).status, 404);
});

test('artifacts are gone: old Clients\' uploads are discarded, old Agents get none, the store is removed', async (t) => {
  const { base, services, job } = await setup(t, 3),
    { resourceId, resourceToken } = services.registry.registerAuto({ clientId: 'c9', name: 'lab-hw-09', type: 'hw', labels: [] }),
    { token: agentToken } = services.agents.create({ name: 'old-agent', kind: 'cli' });
  services.db.prepare('UPDATE jobs SET resource_id = ? WHERE id = ?').run(resourceId, job.id);

  // An old Client still uploads its results after the job: accepted (so the
  // job doesn't end in ERROR), stored nowhere.
  const form = new FormData();
  form.append('files', new Blob(['<testsuite tests="1"/>']), 'results.xml');
  const upload = await fetch(`${base}/api/v1/jobs/${job.id}/artifacts`, {
    method: 'POST', headers: { authorization: `Bearer ${resourceToken}` }, body: form
  });
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), { artifacts: [] });
  assert.equal(fs.existsSync(path.join(path.dirname(services.db.name), 'artifacts')), false);

  // An old Agent's `thub status` still asks: none.
  const listed = await fetch(`${base}/api/v1/jobs/${job.id}/artifacts`, { headers: { authorization: `Bearer ${agentToken}` } });
  assert.deepEqual(await listed.json(), { artifacts: [] });

  // No table, no download route.
  assert.equal(services.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get('artifacts').n, 0);
  assert.equal((await fetch(`${base}/artifacts/download/x.y.z`, { redirect: 'manual' })).status, 302); // just the login redirect
});

test('upgrade: a leftover <dataDir>/artifacts is deleted on startup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-legacy-')),
    file = path.join(dir, 'coordinator.json'),
    legacy = path.join(dir, 'data', 'artifacts', 'M-00001');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'console.log'), 'old');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 } }));
  const log = t.mock.method(console, 'log', () => {});
  buildServices(loadConfig(file));
  assert.equal(fs.existsSync(path.join(dir, 'data', 'artifacts')), false);
  assert.match(log.mock.calls[0].arguments[0], /no longer stores job artifacts/);
});
