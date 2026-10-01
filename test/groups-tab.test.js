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

test('device tabs show what the Client runs — not an old saved revision; groups/import/export build on it', async (t) => {
  const { base, services, admin } = await start(t),
    reg = services.registry,
    register = (devpath) => reg.registerAuto({
      clientId: 'hw1', name: 'lab-hw-01', type: 'hw', labels: [],
      config: { stlinks: [{ index: 1, devpath }] }, configFile: { name: 'lab-hw-01', type: 'hw' }
    }).resourceId,
    id = register('1.1'),
    devpaths = async () => {
      const html = await (await fetch(`${base}/resources`, { headers: { cookie: admin } })).text(),
        table = html.slice(html.indexOf(`id="cfg-${id}-stlinks"`), html.indexOf(`id="cfg-${id}-uarts"`));
      return [...table.matchAll(/data-f="devpath" value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean); // not the blank add-row template
    };
  assert.deepEqual(await devpaths(), ['1.1']); // as the Client reported it

  // Saved on the dashboard, not applied yet: the tab shows the saved one.
  reg.setClientConfig(id, { stlinks: [{ index: 1, devpath: '2.2' }] }, { by: 'admin' });
  assert.deepEqual(await devpaths(), ['2.2']);

  // Applied — and later the file was edited on the host; the Client restarts
  // and reports 3.3. That's what the tab shows now, not the old 2.2.
  services.db.prepare('UPDATE resources SET config_applied_revision = config_revision WHERE id = ?').run(id);
  register('3.3');
  assert.deepEqual(await devpaths(), ['3.3']);

  // …and what a groups save, an export and an Import without a section send.
  const g = services.groups.create({ name: 'g' });
  reg.setClientGroups(id, [g.id], { by: 'admin', knownGroupIds: [g.id] });
  assert.deepEqual(reg.pendingConfig(id).config, { stlinks: [{ index: 1, devpath: '3.3' }] }); // not 2.2 again
  assert.deepEqual(reg.exportClientConfig(id)['hw-devices'], { stlinks: [{ index: 1, devpath: '3.3' }] });
});

test('ST-Link tab has no Serial field; a serial set in the config file is kept on Save', async (t) => {
  const { base, services, admin } = await start(t),
    id = services.registry.registerAuto({
      clientId: 'hw2', name: 'lab-hw-02', type: 'hw', labels: [],
      config: { stlinks: [{ index: 1, serial: '066DFF48', devpath: '1.2' }] }, configFile: { name: 'lab-hw-02', type: 'hw' }
    }).resourceId,
    html = await (await fetch(`${base}/resources`, { headers: { cookie: admin } })).text(),
    table = html.slice(html.indexOf(`id="cfg-${id}-stlinks"`), html.indexOf(`id="cfg-${id}-uarts"`));
  assert.doesNotMatch(table, /data-f="serial"|>Serial</);
  // Rides along in data-extra, which public/js/client-config.js spreads back into the row.
  assert.match(table, /data-extra="\{&quot;serial&quot;:&quot;066DFF48&quot;\}"/);
});

test('resource card: USB actions update live and every disabled button says why', async (t) => {
  const { base, services, admin } = await start(t),
    reg = services.registry.registerAuto({
      clientId: 'hw3', name: 'lab-hw-03', type: 'hw', labels: [], config: { stlinks: [{ index: 1 }] }, configFile: { name: 'lab-hw-03', type: 'hw' }
    }),
    card = async () => {
      const html = await (await fetch(`${base}/resources`, { headers: { cookie: admin } })).text();
      return html.slice(html.indexOf(`id="resource-card-${reg.resourceId}"`));
    };
  let html = await card();
  // A live region, so a Client coming back online gets Refresh back without a reload.
  assert.match(html, new RegExp(`data-live="rc-usb-actions-${reg.resourceId}"`));
  assert.match(html, /"Offline — a Client can only be scanned while it(&#39;|.)s connected" data-usb-refresh-wrap(="[^"]*")?><button[^>]*disabled/);
  assert.match(html, /data-bs-title="Nothing to import yet — press Refresh to scan the Client first"[^>]*><button[^>]*disabled/);

  services.registry.heartbeat(reg.resourceId, { state: 'IDLE' });
  html = await card();
  assert.match(html, /data-bs-title="Run lsusb -tvv on the Client now[^"]*" data-usb-refresh-wrap(="[^"]*")?><button [^>]*data-usb-refresh="">/);
  assert.doesNotMatch(html, /data-usb-refresh-wrap(="[^"]*")?><button[^>]*disabled/);
  // Every disabled button in the card sits in a tooltip wrapper that says why.
  const disabled = [...html.matchAll(/(<span[^>]*data-bs-title="([^"]*)"[^>]*>)?<button[^>]*\sdisabled[^>]*>/g)];
  assert.ok(disabled.every((m) => m[2]), disabled.filter((m) => !m[2]).map((m) => m[0]).join('\n'));
});

test('Import and Export work for a Client that doesn\'t re-register (no joinKey): it reports its config on start', async (t) => {
  const { base, services, admin } = await start(t),
    { resourceId, resourceToken } = services.registry.registerAuto({ clientId: 'hw4', name: 'lab-hw-04', type: 'hw', labels: [] }),
    card = async () => {
      const html = await (await fetch(`${base}/resources`, { headers: { cookie: admin } })).text();
      return html.slice(html.indexOf(`id="resource-card-${resourceId}"`));
    };
  assert.match(await card(), /Import unavailable: this Client is too old/); // nothing reported, no version known

  const res = await fetch(`${base}/api/v1/resources/${resourceId}/config-report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${resourceToken}`, 'content-type': 'application/json', 'x-thub-client-version': '1.1.1' },
    body: JSON.stringify({
      config: { stlinks: [{ index: 1, devpath: '1.1' }] },
      configFile: {
        coordinatorUrl: 'https://c', name: 'lab-hw-04', type: 'hw', joinKey: 'secret', labels: [], 'hw-devices': { stlinks: [{ index: 1, devpath: '1.1' }] }
      }
    })
  });
  assert.equal(res.status, 204);
  const html = await card();
  assert.match(html, /data-config-import-pick/); // Import enabled
  assert.doesNotMatch(html, /Import unavailable/);
  const exported = await (await fetch(`${base}/resources/${resourceId}/config/export`, { headers: { cookie: admin } })).json();
  assert.equal(exported.joinKey, undefined);
  assert.deepEqual(exported['hw-devices'], { stlinks: [{ index: 1, devpath: '1.1' }] });

  // Another resource's token can't report for it.
  const other = services.registry.registerAuto({ clientId: 'hw5', name: 'lab-hw-05', type: 'hw', labels: [] });
  assert.equal((await fetch(`${base}/api/v1/resources/${resourceId}/config-report`, {
    method: 'POST', headers: { authorization: `Bearer ${other.resourceToken}`, 'content-type': 'application/json' }, body: '{}'
  })).status, 403);
});

test('resource card CSS: stacked tabs let only the visible one take the mouse (else the device tabs\' form covers Details)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/thub.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
    off = css.slice(css.indexOf('.thub-resource-card .tab-content > form,'));
  assert.match(off, /^[^{]*> form > fieldset,[^{]*\.tab-pane \{\s*pointer-events: none;/);
  assert.match(css, /\.thub-resource-card \.tab-content \.tab-pane\.active \{[^}]*pointer-events: auto;/);
});

test('agent groups are set on the dashboard (Users, CI tokens) and shown by name — never a group id', async (t) => {
  const { base, services, admin, viewer } = await start(t),
    g = services.groups.create({ name: 'nightly-pool', comment: 'night runs' }),
    form = (cookie, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body), redirect: 'manual' }),
    page = async (cookie, p) => (await fetch(`${base}${p}`, { headers: { cookie } })).text();
  services.registry.registerAuto({ clientId: 'sw9', name: 'lab-sw-09', type: 'sw', labels: [], groups: [g.id] });

  // A maintainer puts an Agent-only user in the group, an admin a CI token.
  await form(viewer, '/admin/users', { username: 'dev', email: 'd@example.com', role: 'user', groupId: g.id });
  const dev = services.adminUsers.getByUsername('dev');
  assert.equal(services.adminUsers.getById(dev.id).groupId, g.id);
  await form(admin, '/admin/agents', { name: 'ci-night', groupId: g.id });
  const ci = services.agents.list().find((a) => a.name === 'ci-night');
  assert.equal(ci.group_id, g.id);
  await form(admin, `/admin/agents/${ci.id}/rename`, { name: 'ci-night', groupId: '' });
  assert.equal(services.agents.get(ci.id).group_id, null);
  await form(admin, `/admin/agents/${ci.id}/rename`, { name: 'ci-night', groupId: g.id });

  // A job from the user lands in the group; its page names it.
  services.adminUsers.issueKey(dev.id, { by: 'admin' });
  const devAgent = services.agents.list().find((a) => a.user_id === dev.id),
    job = services.jobs.create({ agentId: devAgent.id, source: 'cli', spec: { target: { type: 'sw', labels: [] }, command: './t.sh' } });
  assert.match(await page(admin, `/jobs/${job.id}`), /<dt class="col-sm-2">Group<\/dt><dd class="col-sm-10">nightly-pool<\/dd>/);

  const users = await page(admin, '/admin/users'),
    agents = await page(admin, '/admin/agents'),
    groups = await page(admin, '/groups');
  assert.match(users, /<span class="badge text-bg-info">nightly-pool<\/span>/);
  assert.match(users, new RegExp(`<option value="${g.id}" selected="selected">nightly-pool</option>`)); // the picker (a value, not shown)
  assert.match(agents, /<span class="badge text-bg-info">nightly-pool<\/span>/);
  assert.match(groups, /data-bs-title="dev, ci-night"[^>]*>2</); // Agents column: users, then CI tokens
  // The id is never shown as text on a page (it's only in values and URLs).
  for (const html of [users, agents, groups, await page(admin, '/resources'), await page(admin, `/jobs/${job.id}`)]){
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.ok(!text.includes(g.id), 'a group id shows as text');
  }
});

test('CI tokens: the name opens Edit; a new token replaces the old one; delete keeps its jobs', async (t) => {
  const { base, services, admin } = await start(t),
    form = (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie: admin }, body: new URLSearchParams(body), redirect: 'manual' }),
    { agent, token } = services.agents.create({ name: 'ci-fw', kind: 'ci' }),
    me = (tok) => fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${tok}` } });
  services.registry.registerAuto({ clientId: 'sw7', name: 'lab-sw-07', type: 'sw', labels: [] });
  const job = services.jobs.create({ agentId: agent.id, source: 'ci', spec: { target: { type: 'sw', labels: [] }, command: './t.sh' } });

  let html = await (await fetch(`${base}/admin/agents`, { headers: { cookie: admin } })).text();
  assert.match(html, new RegExp(`<a class="fw-medium" href="#editAgentModal-${agent.id}" data-bs-toggle="modal" role="button">ci-fw</a>`));
  assert.doesNotMatch(html, />Edit<\/button>/);

  // New token: shown once, the old one stops at once.
  const res = await form(`/admin/agents/${agent.id}/token`);
  html = await res.text();
  const fresh = /value="(agt_[^"]+)" readonly/.exec(html)?.[1];
  assert.ok(fresh, 'the new token is shown');
  assert.match(html, /New token for ci-fw \(shown once — the old one has stopped working\)/);
  assert.equal((await me(token)).status, 401);
  assert.equal((await me(fresh)).status, 200);

  // Delete: gone from the list and from the API; its job keeps its name.
  await form(`/admin/agents/${agent.id}/delete`);
  html = await (await fetch(`${base}/admin/agents`, { headers: { cookie: admin } })).text();
  assert.match(html, /Deleted CI token &quot;ci-fw&quot;|Deleted CI token "ci-fw"/); // the flash
  assert.doesNotMatch(html.slice(html.indexOf('<tbody')), /ci-fw/); // the list
  assert.equal((await me(fresh)).status, 401);
  assert.ok((await (await fetch(`${base}/jobs?q=ci-fw`, { headers: { cookie: admin } })).text()).includes(job.id)); // still found by its name
  assert.match(await (await form(`/admin/agents/${agent.id}/token`)).headers.get('location'), /agents/); // can't come back
  assert.equal(services.agents.get(agent.id).revoked_at !== null, true);
});
