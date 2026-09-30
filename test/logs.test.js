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

test('RAW: the whole log as plain text; the console.log artifact once lines are purged', async (t) => {
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

  // Purged lines (retention): the console.log artifact instead.
  finish();
  services.artifacts.storeGenerated(job.id, 'console.log', Buffer.from('[t] [runner] from artifact\n'), 'text/plain');
  services.db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(job.id);
  assert.equal(await (await get(`/jobs/${job.id}/log.txt`)).text(), '[t] [runner] from artifact\n');

  assert.equal((await get('/jobs/M-99999/log.txt')).status, 404);
});
