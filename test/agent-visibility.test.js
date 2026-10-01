/**
 * @file        packages/coordinator/test/agent-visibility.test.js
 * @description Tests: which jobs an agent token may see — a cli token only its own, a ci token all
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

test('a cli agent sees only its own jobs (others look like unknown ids); a ci agent sees all', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-vis-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 } }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] });

  const base = `http://127.0.0.1:${server.address().port}/api/v1`,
    alice = services.agents.create({ name: 'alice', kind: 'cli' }).token,
    bob = services.agents.create({ name: 'bob', kind: 'cli' }).token,
    ci = services.agents.create({ name: 'pipeline', kind: 'ci' }).token,
    call = async (token, method, url, body) => {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
    },
    submit = async (token) => (await call(token, 'POST', '/jobs', { target: { type: 'sw' }, command: './t.sh' })).body.jobId,
    aliceJob = await submit(alice),
    bobJob = await submit(bob),
    ciJob = await submit(ci);

  // Alice: her own job, every way of reading it.
  assert.equal((await call(alice, 'GET', `/jobs/${aliceJob}`)).status, 200);
  assert.equal((await call(alice, 'GET', `/jobs/${aliceJob}/logs`)).status, 200);
  assert.equal((await call(alice, 'GET', `/jobs/${aliceJob}/artifacts`)).status, 200);

  // Anyone else's job (a colleague's, a pipeline's): exactly like an id that doesn't exist.
  const unknown = await call(alice, 'GET', '/jobs/M-99999');
  for (const id of [bobJob, ciJob]){
    for (const url of [`/jobs/${id}`, `/jobs/${id}/logs`, `/jobs/${id}/logs/stream`, `/jobs/${id}/artifacts`]){
      const r = await call(alice, 'GET', url);
      assert.equal(r.status, 404, url);
      assert.deepEqual(r.body, unknown.body, url);
    }
    assert.equal((await call(alice, 'POST', `/jobs/${id}/cancel`)).status, 404);
  }
  assert.equal(services.jobs.get(bobJob).state, 'QUEUED'); // untouched

  // Her list is her own jobs, --mine or not.
  const ids = async (token, q = '') => (await call(token, 'GET', `/jobs${q}`)).body.jobs.map((j) => j.id).sort();
  assert.deepEqual(await ids(alice), [aliceJob]);
  assert.deepEqual(await ids(alice, '?mine=true'), [aliceJob]);

  // A ci agent reads every job (and lists them all, or its own with --mine)…
  assert.equal((await call(ci, 'GET', `/jobs/${aliceJob}`)).status, 200);
  assert.equal((await call(ci, 'GET', `/jobs/${bobJob}/logs`)).status, 200);
  assert.deepEqual(await ids(ci), [aliceJob, bobJob, ciJob].sort());
  assert.deepEqual(await ids(ci, '?mine=1'), [ciJob]);
  // …but still cancels only its own.
  assert.equal((await call(ci, 'POST', `/jobs/${aliceJob}/cancel`)).status, 403);
  assert.equal((await call(alice, 'POST', `/jobs/${aliceJob}/cancel`)).status, 200);
});
