/**
 * @file        packages/coordinator/test/users.test.js
 * @description Tests: user management (§10.3) — migration, roles, blocking, the last admin, access keys, the Agent API and the dashboard
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
  Database = require('better-sqlite3'),
  { openDb } = require('../src/db'),
  { hashToken } = require('../src/services/tokens'),
  { loadConfig } = require('../src/config'),
  { buildServices, createApp } = require('../src/server');

const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');

test('migration: dashboard accounts and developer tokens become users; every existing key keeps working', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-mig-')), 'thub.db'),
    old = new Database(file);
  // The schema just before user management.
  old.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '026').sort()){
    old.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x');
  }
  const t = '2026-01-01T00:00:00.000Z',
    addAccount = (id, username, role) => old
      .prepare('INSERT INTO admin_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, 'salt:hash', role, t),
    addAgent = (id, name, kind, token, revoked = null, created = t) => old.prepare(
      'INSERT INTO agents (id, name, kind, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, kind, hashToken(token), created, revoked);
  addAccount('usr_a', 'admin', 'admin');
  addAccount('usr_v', 'vera', 'viewer');
  addAgent('agt_aaaaaaaa-1', 'alice', 'cli', 'agt_key-alice');
  addAgent('agt_bbbbbbbb-2', 'alice', 'cli', 'agt_key-alice-2', null, '2026-02-01T00:00:00.000Z'); // same name, later
  addAgent('agt_cccccccc-3', 'admin', 'cli', 'agt_key-taken'); // clashes with a dashboard account
  addAgent('agt_dddddddd-4', 'bob', 'cli', 'agt_key-bob', '2026-03-01T00:00:00.000Z'); // revoked
  addAgent('agt_eeeeeeee-5', 'pipeline', 'ci', 'agt_key-ci');
  old.close();

  const db = openDb(file),
    users = Object.fromEntries(db.prepare('SELECT * FROM users').all().map((u) => [u.username, u]));
  assert.equal(users.admin.role, 'admin');
  assert.equal(users.vera.role, 'maintainer'); // viewer → maintainer
  assert.equal(users.alice.role, 'user');
  assert.ok(users['alice-bbbbbb'], 'a second "alice" gets a suffix');
  assert.ok(users['admin-cccccc'], 'a token named like a dashboard account gets a suffix');
  assert.equal(users.bob.blocked_at, '2026-03-01T00:00:00.000Z'); // revoked → blocked, kept for history
  assert.equal(users.alice.password_hash, null); // no dashboard
  // The keys: still the same agents rows, now owned by their users; CI stays a CI token.
  const owner = (token) => db.prepare('SELECT a.kind, u.username FROM agents a LEFT JOIN users u ON u.id = a.user_id WHERE token_hash = ?')
    .get(hashToken(token));
  assert.deepEqual({ ...owner('agt_key-alice') }, { kind: 'cli', username: 'alice' });
  assert.deepEqual({ ...owner('agt_key-ci') }, { kind: 'ci', username: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = \'admin_users\'').get().n, 0);
});

function start(t, extra = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-users-')),
    file = path.join(dir, 'coordinator.json');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), updates: { checkIntervalMin: 0 }, rateLimit: { loginPerMinute: 0 }, ...extra }));
  const config = loadConfig(file),
    services = buildServices(config),
    server = createApp(config, services).listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  return new Promise((r) => server.on('listening', () => r({ base: `http://127.0.0.1:${server.address().port}`, services, file })));
}

test('users: temporary passwords, the last admin can\'t be locked out, delete keeps job history', async (t) => {
  const { services } = await start(t),
    u = services.adminUsers,
    root = u.create({ username: 'root', email: 'root@example.com', role: 'admin', password: 'pw' }),
    ops = u.create({ username: 'ops', email: 'ops@example.com', role: 'maintainer' }),
    dev = u.create({ username: 'dev', email: 'dev@example.com', role: 'user' });

  assert.ok(ops.tempPassword); // maintainers get one to change
  assert.equal(u.getById(ops.id).mustChangePassword, true);
  assert.equal(dev.tempPassword, null); // a user has no dashboard password
  assert.throws(() => u.create({ username: 'x', role: 'user', requireEmail: true }), /Email/);
  assert.throws(() => u.create({ username: 'y', email: 'ROOT@example.com', role: 'user' }), /already used/);
  assert.throws(() => u.create({ username: 'bad name', email: 'z@example.com', role: 'user' }), /Username/);

  // The only admin: not blockable, demotable or deletable — not even by themselves.
  assert.throws(() => u.setBlocked(root.id, true, { actorId: ops.id }), /last active admin/);
  assert.throws(() => u.update(root.id, { role: 'maintainer' }, { actorId: ops.id }), /last active admin/);
  assert.throws(() => u.remove(root.id, { actorId: root.id }), /your own account/);
  // With a second admin, the first can go — by someone else.
  u.update(ops.id, { role: 'admin' }, { actorId: root.id });
  u.setBlocked(root.id, true, { actorId: ops.id });
  assert.equal(u.getById(root.id).blocked, true);

  // Delete: the account goes, the key row stays (revoked) under the name.
  const key = u.issueKey(dev.id),
    keyRow = u.keyOf(dev.id);
  assert.ok(key.startsWith('thk_'));
  u.remove(dev.id, { actorId: ops.id });
  const kept = services.db.prepare('SELECT * FROM agents WHERE id = ?').get(keyRow.id);
  assert.equal(kept.name, 'dev');
  assert.ok(kept.revoked_at);
  assert.equal(kept.user_id, null);
  // The audit log has it.
  assert.ok(u.recentEvents().some((e) => e.type === 'user.deleted' && e.data.username === 'dev'));
});

test('Agent API: a user sees and cancels only their own jobs; maintainers all; blocked keys stop; keys rotate', async (t) => {
  const { base, services } = await start(t),
    u = services.adminUsers,
    alice = u.create({ username: 'alice', email: 'a@example.com', role: 'user' }),
    bob = u.create({ username: 'bob', email: 'b@example.com', role: 'user' }),
    maint = u.create({ username: 'mo', email: 'm@example.com', role: 'maintainer', password: 'pw' }),
    keys = { alice: u.issueKey(alice.id), bob: u.issueKey(bob.id), mo: u.issueKey(maint.id) },
    call = async (key, method, url, body) => {
      const res = await fetch(`${base}/api/v1${url}`, {
        method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body)
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] });
  const submit = async (key) => (await call(key, 'POST', '/jobs', { target: { type: 'sw' }, command: './t.sh' })).body.jobId,
    aliceJob = await submit(keys.alice),
    bobJob = await submit(keys.bob);

  assert.equal((await call(keys.alice, 'GET', `/jobs/${aliceJob}`)).status, 200);
  assert.equal((await call(keys.alice, 'GET', `/jobs/${bobJob}`)).status, 404); // like an unknown id
  assert.deepEqual((await call(keys.alice, 'GET', '/jobs')).body.jobs.map((j) => j.id), [aliceJob]);
  assert.equal((await call(keys.mo, 'GET', `/jobs/${bobJob}`)).status, 200); // a maintainer sees all
  assert.equal((await call(keys.mo, 'POST', `/jobs/${bobJob}/cancel`)).status, 200); // …and cancels any

  // whoami / key show.
  const me = (await call(keys.alice, 'GET', '/me')).body;
  assert.deepEqual(me.user, { username: 'alice', email: 'a@example.com', role: 'user' });
  assert.equal(me.key.hint, keys.alice.slice(-4));

  // Rotate: the old key stops at once, the new one works — and the jobs stay hers.
  const rotated = (await call(keys.alice, 'POST', '/me/key/rotate')).body.key;
  assert.equal((await call(keys.alice, 'GET', '/me')).status, 401);
  assert.equal((await call(rotated, 'GET', `/jobs/${aliceJob}`)).status, 200);

  // Blocked: the key stops; unblocked: it works again.
  u.setBlocked(alice.id, true);
  const blocked = await call(rotated, 'GET', '/me');
  assert.equal(blocked.status, 401);
  assert.match(blocked.body.error, /alice is blocked/);
  u.setBlocked(alice.id, false);
  assert.equal((await call(rotated, 'GET', '/me')).status, 200);

  // A CI token isn't rotated by itself.
  const ci = services.agents.create({ name: 'pipeline', kind: 'ci' }).token;
  assert.equal((await call(ci, 'POST', '/me/key/rotate')).status, 403);
  assert.equal((await call(ci, 'GET', `/jobs/${bobJob}`)).status, 200); // CI reads every job, as before
});

test('dashboard: only maintainers and admins sign in; security pages are admins\'; blocking signs out at once', async (t) => {
  const { base, services } = await start(t),
    u = services.adminUsers,
    admin = u.create({ username: 'root', email: 'r@example.com', role: 'admin', password: 'pw' }),
    maint = u.create({ username: 'mo', email: 'm@example.com', role: 'maintainer', password: 'pw' }),
    temp = u.create({ username: 'newbie', email: 'n@example.com', role: 'maintainer' }),
    signIn = async (username, password) => {
      const res = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username, password }), redirect: 'manual' });
      return { status: res.status, location: res.headers.get('location'), cookie: res.headers.get('set-cookie')?.split(';')[0], text: await res.text() };
    },
    get = (cookie, url) => fetch(`${base}${url}`, { headers: { cookie }, redirect: 'manual' });
  u.create({ username: 'dev', email: 'd@example.com', role: 'user', password: 'pw' });

  const dev = await signIn('dev', 'pw');
  assert.equal(dev.status, 403);
  assert.match(dev.text, /no dashboard access/);

  const mo = await signIn('mo', 'pw');
  assert.equal((await get(mo.cookie, '/runners')).status, 200);
  assert.equal((await get(mo.cookie, '/admin/settings')).status, 403); // admins' only
  for (const url of ['/admin/users', '/admin/agents']){
    assert.equal((await get(mo.cookie, url)).status, 200, url); // within limits — see below
  }
  const root = await signIn('root', 'pw');
  assert.equal((await get(root.cookie, '/admin/users')).status, 200);

  // Blocked while signed in: the next click goes to the sign-in page.
  u.setBlocked(maint.id, true, { actorId: admin.id });
  const after = await get(mo.cookie, '/runners');
  assert.equal(after.status, 302);
  assert.equal(after.headers.get('location'), '/login');
  assert.match((await signIn('mo', 'pw')).text, /blocked/);

  // A temporary password: the profile first, until it's changed.
  const nb = await signIn('newbie', temp.tempPassword);
  assert.equal(nb.location, '/profile');
  assert.equal((await get(nb.cookie, '/jobs')).headers.get('location'), '/profile');
  await fetch(`${base}/profile/password`, {
    method: 'POST', headers: { cookie: nb.cookie }, redirect: 'manual',
    body: new URLSearchParams({ currentPassword: temp.tempPassword, newPassword: 'mine-now', confirmPassword: 'mine-now' })
  });
  assert.equal((await get(nb.cookie, '/jobs')).status, 200);

  // The Users page creates a user and shows their key once.
  const created = await (await fetch(`${base}/admin/users`, {
    method: 'POST', headers: { cookie: root.cookie },
    body: new URLSearchParams({ username: 'carol', email: 'c@example.com', role: 'user', issueKey: '1' })
  })).text();
  assert.match(created, /User carol created/);
  assert.match(created, /value="thk_[A-Za-z0-9_-]+"/);
});

test('thub-admin user: add, list, block, key — from the Coordinator host', async (t) => {
  const { file } = await start(t),
    run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'thub-admin.js'), 'user', ...args], {
      env: { ...process.env, THUB_COORDINATOR_CONFIG: file }, encoding: 'utf8'
    }),
    added = run('add', 'ops', '--email', 'ops@example.com', '--role', 'maintainer', '--key');
  assert.match(added.stdout, /Created Maintainer "ops"/);
  assert.match(added.stdout, /Temporary password \(shown once/);
  assert.match(added.stdout, /Access key \(shown once\): thk_/);
  assert.match(run('list').stdout, /ops\s+Maintainer\s+active\s+ops@example\.com\s+key: …/);
  assert.match(run('block', 'ops').stdout, /Blocked "ops"/);
  assert.match(run('add', 'x').stderr + run('add', 'x').stdout, /Usage|email/);
});

test('Users page: quick filter by role with counts, sorting and pages; role descriptions under the picker', async (t) => {
  const { base, services } = await start(t),
    u = services.adminUsers;
  u.create({ username: 'root', email: 'r@example.com', role: 'admin', password: 'pw' });
  for (let i = 1; i <= 12; i++){
    u.create({ username: `dev${String(i).padStart(2, '0')}`, email: `d${i}@example.com`, role: 'user' });
  }
  const mo = u.create({ username: 'mo', email: 'm@example.com', role: 'maintainer' });
  u.setBlocked(mo.id, true);
  const cookie = (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'root', password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    page = (q) => fetch(`${base}/admin/users${q}`, { headers: { cookie } }).then((r) => r.text()),
    names = (html) => [...html.matchAll(/<a class="fw-medium" href="#editUser-[^"]+"[^>]*>([^<]+)/g)].map((m) => m[1]),

    users = await page('?role=user&size=10');
  assert.match(users, /Showing 1–10 of 12 users/); // before the two below are added
  assert.deepEqual(names(users).slice(0, 2), ['dev01', 'dev02']);
  u.create({ username: 'dev9', email: 'd9x@example.com', role: 'user' });
  u.create({ username: 'dev100', email: 'd100x@example.com', role: 'user' });
  const natural = names(await page('?role=user&size=all')).filter((n) => ['dev9', 'dev100', 'dev12'].includes(n));
  assert.deepEqual(natural, ['dev9', 'dev12', 'dev100']); // natural order
  assert.ok(names(users).every((n) => n.startsWith('dev')));
  assert.match(users, /aria-current="page"[^>]*>User<span class="badge text-bg-light ms-1">12/); // the active filter, with its count
  assert.match(users, /href="\/admin\/users\?role=user&amp;size=10&amp;sort=username&amp;dir=asc&amp;page=2"/); // pages keep the filter
  assert.deepEqual(names(await page('?role=blocked')), ['mo']);
  assert.match(users, />Maintainer<span class="badge/); // filter buttons
  const filterNav = users.slice(users.indexOf('aria-label="Filter by role"'), users.indexOf('</nav>', users.indexOf('aria-label="Filter by role"')));
  assert.deepEqual([...filterNav.matchAll(/<a [^>]*>([^<]+)</g)].map((m) => m[1].trim()), ['All', 'Admin', 'Maintainer', 'User', 'Blocked']);
  assert.doesNotMatch(users, /d1@example\.com<\/div>|>Edit<\/button>/); // the name only; it opens Edit
  assert.match(users, /href="[^"]*role=maintainer/); // …while values stay lowercase
  assert.deepEqual(names(await page('?role=admin&size=all')), ['root']);
  assert.deepEqual(names(await page('?role=&sort=role&dir=desc&size=all')).slice(0, 2), ['root', 'mo']); // admin, maintainer, users…

  // The role picker: names only, the chosen role's description below it.
  assert.match(users, /<option value="user" selected="selected" data-help="Agent only[^"]*">User<\/option>/);
  assert.match(users, /<div class="form-text" id="new-role-help" aria-live="polite">Agent only/);
});

test('Users page: the User column shows first and last name, sorts by it, and opens Edit', async (t) => {
  const { base, services } = await start(t),
    u = services.adminUsers;
  u.create({ username: 'root', email: 'r@example.com', role: 'admin', password: 'pw' });
  const zed = u.create({ username: 'aaa', email: 'a@example.com', role: 'user', firstName: 'Zed', lastName: 'Young' });
  u.create({ username: 'zzz', email: 'z@example.com', role: 'user', firstName: 'Ann' });
  const cookie = (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'root', password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    html = await (await fetch(`${base}/admin/users?sort=username&dir=asc&size=all`, { headers: { cookie } })).text(),
    cells = [...html.matchAll(/<a class="fw-medium" href="#editUser-([^"]+)"[^>]*>([^<]+)/g)];
  assert.deepEqual(cells.map((m) => m[2]), ['Ann', 'root', 'Zed Young']); // no name → the username
  assert.equal(cells[2][1], zed.id);
  assert.match(html, new RegExp(`id="editUser-${zed.id}"`)); // the modal it opens
});

test('maintainers manage Agent-only users, their own account and CI tokens — never admins or other maintainers', async (t) => {
  const { base, services } = await start(t),
    u = services.adminUsers,
    root = u.create({ username: 'root', email: 'r@example.com', role: 'admin', password: 'pw' }),
    ops = u.create({ username: 'ops', email: 'o@example.com', role: 'maintainer', password: 'pw' }),
    ops2 = u.create({ username: 'ops2', email: 'o2@example.com', role: 'maintainer', password: 'pw' }),
    dev = u.create({ username: 'dev', email: 'd@example.com', role: 'user' }),
    cookie = (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'ops', password: 'pw' }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    get = (p) => fetch(`${base}${p}`, { headers: { cookie } }).then((r) => r.text()),
    post = (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body), redirect: 'manual' })
      .then(async (r) => (r.status === 302 ? get(r.headers.get('location')) : r.text()));

  // The list: Agent-only users and themselves; filters without Admin/Maintainer; only User to give.
  let page = await get('/admin/users?size=all');
  assert.match(page, /href="\/admin\/users"[^>]*>(<i [^>]*><\/i>)?Users</); // in the navbar
  assert.match(page, /href="\/admin\/agents"[^>]*>(<i [^>]*><\/i>)?CI tokens</);
  assert.doesNotMatch(page, /href="\/admin\/settings"/);
  const ids = [...page.matchAll(/href="#editUser-([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [ops.id, dev.id].sort());
  const filterNav = page.slice(page.indexOf('aria-label="Filter by role"'), page.indexOf('</nav>', page.indexOf('aria-label="Filter by role"')));
  assert.deepEqual([...filterNav.matchAll(/<a [^>]*>([^<]+)</g)].map((m) => m[1].trim()), ['All', 'User', 'Blocked']);
  assert.doesNotMatch(page.slice(page.indexOf('id="addUserModal"')), /<option value="(maintainer|admin)"/);
  assert.match(page, new RegExp(`id="u-${ops.id}-role" value="Maintainer" disabled`)); // their own role, no picker

  // Users: create, edit, key, block, delete.
  page = await post('/admin/users', { username: 'dev2', email: 'd2@example.com', role: 'user', issueKey: '1' });
  assert.match(page, /User dev2 created/);
  assert.match(page, /value="thk_/);
  const dev2 = u.getByUsername('dev2');
  assert.match(await post(`/admin/users/${dev2.id}`, { username: 'dev2', email: 'd2@example.com', role: 'user', firstName: 'Dee' }), /Saved dev2/);
  assert.match(await post(`/admin/users/${dev.id}/key`), /Access key for dev/);
  assert.match(await post(`/admin/users/${dev.id}/key/revoke`), /Revoked the access key of dev/);
  assert.match(await post(`/admin/users/${dev.id}/block`), /Blocked dev/);
  assert.match(await post(`/admin/users/${dev.id}/unblock`), /Unblocked dev/);
  assert.match(await post(`/admin/users/${dev2.id}/delete`), /Deleted dev2/);

  // …but never a dashboard role.
  assert.match(await post('/admin/users', { username: 'boss', email: 'b@example.com', role: 'admin' }), /Only an admin can create a maintainer or an admin/);
  assert.match(await post('/admin/users', { username: 'm2', email: 'm2@example.com', role: 'maintainer' }), /Only an admin can create/);
  assert.equal(u.getByUsername('boss'), undefined);
  assert.match(await post(`/admin/users/${dev.id}`, { username: 'dev', email: 'd@example.com', role: 'maintainer' }), /Only an admin can change a role/);
  assert.equal(u.getById(dev.id).role, 'user');

  // Admins and other maintainers: as if they didn't exist.
  for (const other of [root, ops2]){
    for (const action of ['', '/block', '/reset-password', '/key', '/key/revoke', '/delete']){
      assert.match(await post(`/admin/users/${other.id}${action}`, { username: 'x', email: 'x@example.com' }), /Unknown user/, `${other.username}${action}`);
    }
  }
  assert.equal(u.getById(root.id).blocked, false);
  assert.equal(u.getById(ops2.id).username, 'ops2');

  // Their own account: edit, key, new temporary password — not block or delete, not a new role.
  assert.match(await post(`/admin/users/${ops.id}`, { username: 'ops', email: 'o@example.com', firstName: 'Olga' }), /Saved ops/);
  assert.equal(u.getById(ops.id).role, 'maintainer');
  assert.match(await post(`/admin/users/${ops.id}`, { username: 'ops', email: 'o@example.com', role: 'admin' }), /Only an admin can change a role/);
  assert.match(await post(`/admin/users/${ops.id}/key`), /Access key for ops/);
  assert.match(await post(`/admin/users/${ops.id}/block`), /can&#39;t block your own account|can't block your own account/);
  assert.match(await post(`/admin/users/${ops.id}/delete`), /can&#39;t delete your own account|can't delete your own account/);

  // Recent activity: nothing about admins or other maintainers.
  page = await get('/admin/users');
  const activity = page.slice(page.indexOf('Recent activity'), page.indexOf('id="addUserModal"'));
  assert.doesNotMatch(activity, /\b(root|ops2)\b/);
  assert.match(activity, /dev2/);

  // CI tokens: issue, rename, revoke.
  page = await post('/admin/agents', { name: 'ci-nightly' });
  assert.match(page, /Token \(shown once\):[\s\S]*?value="agt_/);
  const ci = services.agents.list().find((a) => a.name === 'ci-nightly');
  await post(`/admin/agents/${ci.id}/rename`, { name: 'ci-night' });
  await post(`/admin/agents/${ci.id}/revoke`);
  assert.equal(services.agents.get(ci.id).name, 'ci-night');
  assert.ok(services.agents.get(ci.id).revoked_at);

  // Still admin-only: Settings.
  assert.equal((await fetch(`${base}/admin/settings`, { headers: { cookie } })).status, 403);

  // Every job and its details, whoever submitted it.
  services.registry.registerAuto({ clientId: 'c1', name: 'lab-sw-01', type: 'sw', labels: [] });
  const ciAgent = services.agents.create({ name: 'ci-x', kind: 'ci' }).agent,
    ciJob = services.jobs.create({ agentId: ciAgent.id, source: 'ci', spec: { target: { type: 'sw' }, command: './ci.sh' } }),
    devKey = u.issueKey(dev.id, { by: 'root' }),
    devAgent = services.agents.list().find((a) => a.user_id === dev.id),
    devJob = services.jobs.create({ agentId: devAgent.id, source: 'cli', spec: { target: { type: 'sw' }, command: './dev.sh' } });
  assert.ok(devKey);
  const jobs = await get('/jobs?size=all');
  assert.ok(jobs.includes(ciJob.id) && jobs.includes(devJob.id));
  for (const job of [devJob, ciJob]){
    const r = await fetch(`${base}/jobs/${job.id}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), new RegExp(`<title>${job.id} `));
  }
});

test('audit log: Timestamp, User (who did it — always), Action — from the dashboard, the profile, the Agent and thub-admin', async (t) => {
  const { base, services, file } = await start(t),
    u = services.adminUsers;
  u.create({ username: 'root', email: 'r@example.com', role: 'admin', password: 'pw' }, { by: 'root' });
  const login = async (name, pw) => (await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ username: name, password: pw }), redirect: 'manual'
    })).headers.get('set-cookie').split(';')[0],
    root = await login('root', 'pw'),
    post = (cookie, p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body), redirect: 'manual' });

  // Dashboard (an admin), then the profile (the user themselves).
  await post(root, '/admin/users', { username: 'dev', email: 'd@example.com', role: 'user', issueKey: '1' });
  const dev = u.getByUsername('dev');
  await post(root, '/admin/users', { username: 'ops', email: 'o@example.com', role: 'maintainer' });
  const ops = u.getByUsername('ops');
  await post(root, `/admin/users/${ops.id}`, { username: 'ops', email: 'ops@example.com', role: 'admin', firstName: 'Olga' });
  const temp = u.adminResetPassword(ops.id, { by: 'root' }),
    opsCookie = await login('ops', temp);
  await post(opsCookie, '/profile/password', { currentPassword: temp, newPassword: 'Ops-own-1', confirmPassword: 'Ops-own-1' });

  // The Agent rotating its own key.
  const devKey = u.issueKey(dev.id, { by: 'root' });
  assert.equal((await fetch(`${base}/api/v1/me/key/rotate`, { method: 'POST', headers: { authorization: `Bearer ${devKey}` } })).status, 200);

  // thub-admin on the Coordinator host, and an internal call naming no one.
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'thub-admin.js'), 'user', 'block', 'dev'], {
    env: { ...process.env, THUB_COORDINATOR_CONFIG: file, SUDO_USER: 'alice' }, encoding: 'utf8'
  });
  assert.match(cli.stdout, /Blocked "dev"/);
  u.setBlocked(dev.id, false);

  // Every recorded event names who did it.
  assert.ok(u.recentEvents(100).every((e) => e.data.by), 'every user event has `by`');

  const html = await (await fetch(`${base}/admin/users`, { headers: { cookie: root } })).text(),
    log = html.slice(html.indexOf('Recent activity'), html.indexOf('id="addUserModal"')),
    rows = [...log.matchAll(/<tr><td[^>]*>[^<]*<\/td><td[^>]*>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)]
      .map((m) => [m[1], m[2].replace(/&#39;/g, '\'').replace(/&gt;/g, '>')]).reverse(); // oldest first
  assert.match(log, /<th[^>]*>Timestamp<\/th><th>User<\/th><th>Action<\/th>/);
  assert.deepEqual(rows, [
    ['root', 'Created root (Admin)'],
    ['root', 'Created dev (User)'],
    ['root', 'Created dev\'s access key'],
    ['root', 'Created ops (Maintainer)'],
    ['root', 'Edited ops: role Maintainer → Admin; email, first name'],
    ['root', 'Issued a temporary password for ops'],
    ['ops', 'Changed their own password'],
    ['root', 'Replaced dev\'s access key'],
    ['dev', 'Replaced their own access key'],
    ['thub-admin (alice)', 'Blocked dev'],
    ['system', 'Unblocked dev']
  ]);
});
