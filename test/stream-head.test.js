/**
 * @file        packages/coordinator/test/stream-head.test.js
 * @description Tests: a HEAD request to a stream endpoint (/live, job log streams) finishes, and doesn't block its keep-alive connection
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
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

// What a browser does: one keep-alive connection, reused as soon as a
// response is complete — and a HEAD response is complete with its headers.
function oneConnection(port){
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }),
    request = (method, url, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.setTimeout(3000, () => req.destroy(new Error(`${method} ${url}: no answer within 3 s — the connection is blocked`)));
      req.on('error', reject);
      req.end();
    });
  return { request, close: () => agent.destroy() };
}

test('HEAD on a stream endpoint answers at once and leaves the connection usable (no stuck page loads)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-head-')),
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
  const port = server.address().port;
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  const cookie = (await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    { agent, token } = services.agents.create({ name: 'ci', kind: 'ci' }),
    // A Client the job can wait for (a job nothing could ever run is refused).
    registered = services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] }),
    // An active job: its streams stay open for a GET.
    job = registered && services.jobs.create({ agentId: agent.id, source: 'ci', spec: { target: { type: 'sw' }, command: './t.sh' } });

  for (const [url, headers]of [
    ['/live', { cookie, 'X-Thub-Live': '1' }], // what live.js probes
    [`/jobs/${job.id}/stream`, { cookie }],
    [`/api/v1/jobs/${job.id}/logs/stream`, { authorization: `Bearer ${token}` }]
  ]){
    const conn = oneConnection(port);
    t.after(conn.close);
    assert.equal(await conn.request('HEAD', url, headers), 204, url);
    // The next request on the very same connection: answered, not queued forever.
    assert.equal(await conn.request('GET', '/js/copy-to-clipboard.js'), 200, `after HEAD ${url}`);
  }
});
