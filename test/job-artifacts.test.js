/**
 * @file        packages/coordinator/test/job-artifacts.test.js
 * @description Tests: artifacts a job reports (metadata only) — validation, storage with the result, the job page and the Agent API
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
  { sanitizeArtifacts, normalizeTimestamp, formatBytes, MAX_ARTIFACTS } = require('../src/services/job-artifacts'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

test('formatBytes: B, KB, MB, GB …, 1024-based', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1233), '1.2 KB');
  assert.equal(formatBytes(15 * 1024), '15 KB');
  assert.equal(formatBytes(5.5 * 1024 ** 2), '5.5 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
  assert.equal(formatBytes(2 * 1024 ** 4), '2.0 TB');
  assert.equal(formatBytes(-1), '—');
});

test('timestamps: Unix seconds, Unix milliseconds or ISO dates', () => {
  assert.equal(normalizeTimestamp(1790000000), '2026-09-21T14:13:20.000Z');
  assert.equal(normalizeTimestamp(1790000000123), '2026-09-21T14:13:20.123Z');
  assert.equal(normalizeTimestamp('1790000000'), '2026-09-21T14:13:20.000Z');
  assert.equal(normalizeTimestamp('2026-09-21T14:13:20Z'), '2026-09-21T14:13:20.000Z');
  assert.equal(normalizeTimestamp(1234), '1970-01-01T00:20:34.000Z'); // small numbers are seconds
  assert.equal(normalizeTimestamp('soon'), null);
  assert.equal(normalizeTimestamp(undefined), null);
});

test('sanitizeArtifacts keeps valid entries, only http(s) links, and drops the rest', () => {
  const { artifacts, dropped } = sanitizeArtifacts([
    { name: 'app.bin', size: 1233, link: 'https://artifactory.example.com/fw/app.bin', timestamp: 1790000000 },
    { name: ' report.html ', link: 'http://files.lab/r.html' }, // size/timestamp optional
    { name: 'evil', size: 1, link: 'javascript:alert(1)' },
    { name: 'data', link: 'data:text/html,<script>x</script>' },
    { name: '', link: 'https://x.example/a' },
    { name: 'no-link' },
    { name: 'neg', size: -5, link: 'https://x.example/n' }, // bad size: kept, size unknown
    'not an object'
  ]);
  assert.equal(dropped, 5);
  assert.deepEqual(artifacts, [
    { name: 'app.bin', size: 1233, link: 'https://artifactory.example.com/fw/app.bin', timestamp: '2026-09-21T14:13:20.000Z' },
    { name: 'report.html', size: null, link: 'http://files.lab/r.html', timestamp: null },
    { name: 'neg', size: null, link: 'https://x.example/n', timestamp: null }
  ]);
  const many = sanitizeArtifacts(Array.from({ length: MAX_ARTIFACTS + 3 }, (_, i) => ({ name: `f${i}`, link: `https://x.example/${i}` })));
  assert.equal(many.artifacts.length, MAX_ARTIFACTS);
  assert.equal(many.dropped, 3);
  assert.deepEqual(sanitizeArtifacts(undefined), { artifacts: [], dropped: 0 });
});

test('a finished job\'s reported artifacts: stored with the result, on the job page and via the Agent API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-art-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 }, rateLimit: { loginPerMinute: 0 } }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`,
    { resourceId, resourceToken } = services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] }),
    { agent, token } = services.agents.create({ name: 'ci', kind: 'ci' }),
    job = services.jobs.create({ agentId: agent.id, source: 'ci', spec: { target: { type: 'sw' }, command: './t.sh' } }),
    asClient = (url, body) => fetch(`${base}/api/v1${url}`, {
      method: 'POST', headers: { authorization: `Bearer ${resourceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  services.db.prepare('UPDATE jobs SET resource_id = ?, state = ? WHERE id = ?').run(resourceId, 'RUNNING', job.id);

  const result = await asClient(`/jobs/${job.id}/result`, {
    state: 'PASSED', exitCode: 0, summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
    artifacts: [
      { name: 'app.bin', size: 1233, link: 'https://artifactory.example.com/fw/app.bin', timestamp: 1790000000 },
      { name: 'x', link: 'javascript:alert(1)' }
    ]
  });
  assert.equal(result.status, 200);
  assert.deepEqual(services.jobs.get(job.id).artifacts.map((a) => a.name), ['app.bin']);

  // Agent API: in the job, and on its own (with `url` for older Agents).
  const agentGet = (url) => fetch(`${base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.equal((await agentGet(`/jobs/${job.id}`)).artifacts[0].link, 'https://artifactory.example.com/fw/app.bin');
  assert.equal((await agentGet(`/jobs/${job.id}/artifacts`)).artifacts[0].url, 'https://artifactory.example.com/fw/app.bin');

  // The job page.
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  const cookie = (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    html = await (await fetch(`${base}/jobs/${job.id}`, { headers: { cookie } })).text();
  assert.match(html, /<a href="https:\/\/artifactory\.example\.com\/fw\/app\.bin" target="_blank" rel="noopener noreferrer">app\.bin<\/a>/);
  assert.match(html, />1\.2 KB</);
  assert.match(html, /21\/09\/2026 14:13:20/); // the admin's time zone (UTC)
  assert.doesNotMatch(html, /javascript:alert/);
});
