/**
 * @file        packages/coordinator/test/live.test.js
 * @description Tests: dashboard live updates — change detection per topic, the GET /live stream, and passive re-fetches that leave the session alone
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
  { EventEmitter } = require('node:events'),
  { openDb } = require('../src/db'),
  { createEventsService } = require('../src/services/events'),
  { createRegistryService } = require('../src/services/registry'),
  { createAgentsService } = require('../src/services/agents'),
  { createLiveService } = require('../src/services/live'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

test('live: reports exactly the topics whose data changed, only while subscribed', async () => {
  const db = openDb(':memory:'),
    bus = new EventEmitter(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    live = createLiveService(db, { bus, intervalMs: 60_000, debounceMs: 10 }),
    seen = [];

  assert.deepEqual(live.check(), []); // nobody listening: nothing computed
  const unsubscribe = live.subscribe((topics) => seen.push(topics));
  assert.equal(live.subscriberCount(), 1);
  assert.deepEqual(live.check(), []); // nothing changed yet

  registry.registerAuto({ clientId: 'c1', name: 'lab-hw-01', type: 'hw', labels: [] });
  assert.deepEqual(live.check(), ['resources']);
  agents.create({ name: 'ci', kind: 'ci' });
  assert.deepEqual(live.check(), ['agents']);
  assert.deepEqual(live.check(), []);

  // A bus event triggers a check by itself (debounced), without the timer.
  db.prepare('INSERT INTO jobs (id, agent_id, source, state, spec, priority, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('M-00001', agents.list()[0].id, 'cli', 'QUEUED', '{}', 60, 0, new Date().toISOString());
  bus.emit('job.queued', { jobId: 'M-00001' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen.at(-1), ['jobs']);

  unsubscribe();
  assert.equal(live.subscriberCount(), 0);
  assert.equal(bus.listenerCount('job.queued'), 0); // stopped listening
});

// --- over HTTP: /live and passive re-fetches ------------------------------

function startApp(t){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-live-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(dir, 'data'), sessionSecret: 'test-secret-test-secret', updates: { checkIntervalMin: 0 }
  }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  return new Promise((r) => server.on('listening', () => r({ base: `http://127.0.0.1:${server.address().port}`, services })));
}

const expiresOf = (res) => {
  const m = /Expires=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  return m ? Date.parse(m[1]) : null;
};

async function login(base){
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: 'admin', password: 'pw' }),
    redirect: 'manual'
  });
  return { cookie: res.headers.get('set-cookie').split(';')[0], expires: expiresOf(res) };
}

test('live: /live streams hello and changes; passive re-fetches keep the idle timeout and flash', async (t) => {
  const { base, services } = await startApp(t),
    { cookie, expires } = await login(base);
  assert.ok(expires);

  // The stream: hello, then `changed` when a resource appears.
  const ctrl = new AbortController(),
    stream = await fetch(`${base}/live`, { headers: { cookie }, signal: ctrl.signal }),
    reader = stream.body.getReader(),
    decoder = new TextDecoder();
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  let text = '';
  const until = async (re) => {
    while (!re.test(text)){
      const { value, done } = await reader.read();
      if (done){
        break;
      }
      text += decoder.decode(value);
    }
    return re.exec(text);
  };
  assert.ok(await until(/event: hello/));
  assert.equal(services.live.subscriberCount(), 1);
  services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] });
  services.live.check();
  assert.match((await until(/event: changed\ndata: (.*)\n/))[1], /"resources"/);
  ctrl.abort();

  // A flash waiting for the next page view (a real request: it sets the
  // expiry the passive one below must leave alone)…
  const flashing = await fetch(`${base}/profile/password`, {
      method: 'POST', headers: { cookie }, body: new URLSearchParams({ currentPassword: 'wrong', newPassword: 'a', confirmPassword: 'b' }),
      redirect: 'manual'
    }),
    lastActive = expiresOf(flashing);
  assert.ok(lastActive >= expires);
  // Wait past a whole second, so a refreshed expiry would differ.
  await new Promise((r) => setTimeout(r, 1100));

  // …survives a passive re-fetch, which also doesn't push the expiry out.
  const passive = await fetch(`${base}/runners`, { headers: { cookie, 'X-Thub-Live': '1' } });
  assert.equal(passive.status, 200);
  assert.match(passive.headers.get('cache-control'), /no-store/);
  const passiveExpires = expiresOf(passive);
  assert.ok(passiveExpires === null || passiveExpires === lastActive, 'passive request must not extend the session');
  assert.match(await passive.text(), /data-live="rows"/);

  // A real page view gets the flash, and extends the session as before.
  const real = await fetch(`${base}/profile`, { headers: { cookie } });
  assert.ok(expiresOf(real) > lastActive);
  assert.match(await real.text(), /data-thub-toast="danger"/);

  // Signed out: the stream is refused (EventSource then stops), and a
  // passive re-fetch is redirected to the login page.
  await fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal((await fetch(`${base}/live`, { headers: { cookie, accept: 'text/event-stream' } })).status, 401);
  assert.equal((await fetch(`${base}/runners`, { headers: { cookie, 'X-Thub-Live': '1' }, redirect: 'manual' })).status, 302);
});
