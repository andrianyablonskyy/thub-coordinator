/**
 * @file        packages/coordinator/test/security.test.js
 * @description Tests: security headers on every response, and the same-origin (CSRF) check on the dashboard's POSTs
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

async function start(t, extra = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-sec-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 }, ...extra
  }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  await new Promise((r) => server.on('listening', r));
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  return { base: `http://127.0.0.1:${server.address().port}`, services };
}

test('security headers on pages, the API and static files; HSTS only over HTTPS', async (t) => {
  const { base } = await start(t);
  for (const url of ['/login', '/api/v1/resources', '/css/thub.css']){
    const res = await fetch(`${base}${url}`),
      csp = res.headers.get('content-security-policy');
    assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', url);
    assert.equal(res.headers.get('x-powered-by'), null, url);
    assert.equal(res.headers.get('strict-transport-security'), null, url); // plain HTTP
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net(;|$)/); // no 'unsafe-inline' for scripts
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' https:\/\/cdn\.jsdelivr\.net(;|$)/); // DevTools: Bootstrap's source maps
    assert.match(csp, /object-src 'none'/);
  }
  // Behind the (loopback, trusted) TLS proxy.
  const tls = await fetch(`${base}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(tls.headers.get('strict-transport-security'), /^max-age=\d+$/);
});

test('same-origin check: POSTs from other sites are refused; own pages, publicUrl and non-browser clients pass', async (t) => {
  const { base, services } = await start(t, { publicUrl: 'http://thub.lab.example' }),
    post = (url, headers = {}) => fetch(`${base}${url}`, {
      method: 'POST', headers, body: new URLSearchParams({ username: 'admin', password: 'pw' }), redirect: 'manual'
    }),

    // A forged cross-site form post (login CSRF here; any dashboard action alike).
    evil = await post('/login', { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.match(await evil.text(), /came from https:\/\/evil\.example, not from this dashboard \(http:\/\/thub\.lab\.example\)/);
  assert.equal((await post('/login', { Origin: 'null' })).status, 403); // sandboxed iframe, data: URL
  assert.equal((await post('/login', { Referer: 'https://evil.example/page' })).status, 403); // no Origin: Referer decides
  assert.equal((await post('/login', { Origin: 'http://thub.lab.example:8443' })).status, 403); // another port is another origin

  // The dashboard's own pages: the address it was opened at, or publicUrl
  // (a reverse proxy that rewrites Host).
  assert.equal((await post('/login', { Origin: base })).status, 302);
  assert.equal((await post('/login', { Origin: 'http://thub.lab.example' })).status, 302);
  assert.equal((await post('/login', { Referer: `${base}/login` })).status, 302);
  // Neither header: not a browser page (curl, a script) — nothing to forge.
  assert.equal((await post('/login')).status, 302);

  // Reading is never blocked.
  assert.equal((await fetch(`${base}/login`, { headers: { Origin: 'https://evil.example' } })).status, 200);

  // The session-authenticated admin API is covered too (JSON answer)…
  const admin = await fetch(`${base}/api/v1/admin/jobs/reset-queue`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(admin.status, 403);
  assert.match((await admin.json()).error, /Blocked/);
  // …the bearer-token Agent API isn't: a browser never attaches that token by itself.
  const { token } = services.agents.create({ name: 'ci', kind: 'ci' }),
    agent = await fetch(`${base}/api/v1/jobs`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
  assert.notEqual(agent.status, 403); // 400 invalid spec — got past the check
});

test('templates carry no inline event handlers (the CSP would block them)', () => {
  const views = path.join(__dirname, '..', 'views'),
    files = fs.readdirSync(views, { recursive: true }).filter((f) => f.endsWith('.pug'));
  for (const f of files){
    assert.doesNotMatch(fs.readFileSync(path.join(views, f), 'utf8'), /\bon[a-z]+="/, f);
  }
});
