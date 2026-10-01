/**
 * @file        packages/coordinator/test/groups-tab.test.js
 * @description Tests: a Client's group membership set from the resource card's Groups tab
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

async function start(t){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-grp-')),
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
  const base = `http://127.0.0.1:${server.address().port}`;
  services.adminUsers.create({ username: 'admin', password: 'pw', role: 'admin' });
  services.adminUsers.create({ username: 'view', password: 'pw', role: 'maintainer' });
  const login = async (u) => (await fetch(`${base}/login`, {
    method: 'POST', body: new URLSearchParams({ username: u, password: 'pw' }), redirect: 'manual'
  })).headers.get('set-cookie').split(';')[0];
  return { base, services, admin: await login('admin'), viewer: await login('view') };
}

// A Client recent enough to report its config file (what Import needs too).
const register = (services, name, { configFile = { name, type: 'sw' } } = {}) => services.registry.registerAuto({
  clientId: `id-${name}`, name, type: 'sw', labels: [], config: {}, ...(configFile ? { configFile } : {})
}).resourceId;

test('Groups tab: in effect at once, sent to the Client as its next config revision', async (t) => {
  const { base, services, admin, viewer } = await start(t),
    nightly = services.groups.create({ name: 'nightly' }),
    pr = services.groups.create({ name: 'pr-pool', comment: 'pull requests' }),
    id = register(services, 'lab-sw-01'),
    save = (cookie, groups) => fetch(`${base}/resources/${id}/groups`, {
      method: 'POST', headers: { cookie }, body: new URLSearchParams([...groups.map((g) => ['groups', g]), ['returnTo', '/resources']]), redirect: 'manual'
    }),
    page = async () => (await fetch(`${base}/resources`, { headers: { cookie: admin } })).text();

  assert.equal((await save(viewer, [nightly.id])).status, 302); // a maintainer may (§10.3)
  assert.equal((await save(admin, [nightly.id, pr.id])).status, 302);
  const r = services.registry.get(id);
  assert.deepEqual(r.group_ids.sort(), [nightly.id, pr.id].sort()); // scheduling follows now
  const pending = services.registry.pendingConfig(id);
  assert.equal(pending.revision, 2); // the maintainer's save was revision 1
  assert.deepEqual(pending.file.groups.sort(), [nightly.id, pr.id].sort()); // the Client writes it to its file
  assert.match(await page(), /Groups of lab-sw-01 saved: 2 group\(s\) — in effect now/);

  // The tab, with every group as a checkbox; no Groups line on Details any more.
  const html = await page();
  assert.match(html, new RegExp(`name="groups" value="${pr.id}" checked`));
  assert.match(html, /data-config-tab="groups"/);
  assert.match(html, /not written to the Client yet/);
  assert.doesNotMatch(html, /<dt class="col-sm-4">Groups<\/dt>/);

  // None at all: allowed.
  await save(admin, []);
  assert.deepEqual(services.registry.get(id).group_ids, []);
});

test('Groups tab: keeps other pending changes; refuses unknown groups and Clients too old for it', async (t) => {
  const { services } = await start(t),
    g = services.groups.create({ name: 'g' }),
    id = register(services, 'lab-sw-02');

  // An Import not applied yet: its fields go along with the groups.
  services.registry.importClientConfig(id, { labels: ['board:x'] }, { by: 'admin' });
  services.registry.setClientGroups(id, [g.id], { by: 'admin', knownGroupIds: [g.id] });
  assert.deepEqual(services.registry.pendingConfig(id).file, { labels: ['board:x'], groups: [g.id] });
  // A device save meanwhile doesn't drop them either.
  services.registry.setClientConfig(id, {}, { by: 'admin' });
  assert.deepEqual(services.registry.pendingConfig(id).file.groups, [g.id]);

  assert.throws(() => services.registry.setClientGroups(id, ['no-such-group'], { knownGroupIds: [g.id] }), /Unknown group/);
  const old = register(services, 'lab-old', { configFile: null });
  assert.throws(() => services.registry.setClientGroups(old, [g.id], { knownGroupIds: [g.id] }), /too old to take its groups/);
});
