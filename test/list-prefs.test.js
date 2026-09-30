/**
 * @file        packages/coordinator/test/list-prefs.test.js
 * @description Tests: list view preferences (page size/sort), their storage in the user profile, and paged job queries
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
  { EventEmitter } = require('node:events'),
  { openDb } = require('../src/db'),
  { createAdminUsersService } = require('../src/services/admin-users'),
  { createEventsService } = require('../src/services/events'),
  { createRegistryService } = require('../src/services/registry'),
  { createAgentsService } = require('../src/services/agents'),
  { createJobsService } = require('../src/services/jobs'),
  { normalize, fromQuery, paginate } = require('../src/services/list-prefs');

test('normalize fills defaults and drops invalid values', () => {
  assert.deepEqual(normalize('jobs'), { size: 25, sort: 'created', dir: 'desc' });
  assert.deepEqual(normalize('resources', { size: '100', sort: 'status', dir: 'desc' }), { size: 100, sort: 'status', dir: 'desc' });
  assert.deepEqual(normalize('resources', { size: 7, sort: 'labels', dir: 'up' }), { size: 25, sort: 'name', dir: 'asc' });
  assert.equal(normalize('jobs', { size: 'all' }).size, 'all');
  assert.throws(() => normalize('nope'), /Unknown list/);
});

test('fromQuery overrides stored prefs and reports whether anything changed', () => {
  const stored = { size: 50, sort: 'state', dir: 'asc' };
  assert.deepEqual(fromQuery('jobs', {}, stored), { prefs: stored, changed: false });
  assert.deepEqual(fromQuery('jobs', { size: '10', page: '3' }, stored), { prefs: { ...stored, size: 10 }, changed: true });
  assert.equal(fromQuery('jobs', { sort: 'bogus', size: '11' }, stored).changed, false); // invalid: ignored
});

test('paginate clamps the page and computes the window', () => {
  assert.deepEqual(paginate(112, 25, '3'), { page: 3, pages: 5, total: 112, offset: 50, limit: 25, from: 51, to: 75 });
  assert.equal(paginate(112, 25, '99').page, 5);
  assert.equal(paginate(112, 25, 'x').page, 1);
  assert.deepEqual(paginate(112, 'all', 1), { page: 1, pages: 1, total: 112, offset: 0, limit: 112, from: 1, to: 112 });
  assert.deepEqual(paginate(0, 10, 1), { page: 1, pages: 1, total: 0, offset: 0, limit: 10, from: 0, to: 0 });
});

test('list prefs are stored per page in the user profile', () => {
  const users = createAdminUsersService(openDb(':memory:')),
    { id } = users.create({ username: 'alice', password: 'pw', role: 'admin' });
  assert.deepEqual(users.getById(id).listPrefs, {});

  users.setListPrefs(id, 'jobs', { size: 100, sort: 'duration', dir: 'asc' });
  const profile = users.setListPrefs(id, 'resources', { size: 'all', sort: 'nonsense' });
  assert.deepEqual(profile.listPrefs, {
    jobs: { size: 100, sort: 'duration', dir: 'asc' },
    resources: { size: 'all', sort: 'name', dir: 'asc' }
  });
});

test('jobs.page sorts and pages in SQL, with empty values last', () => {
  const db = openDb(':memory:'),
    bus = new EventEmitter(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    { agent } = createAgentsService(db, { events }).create({ name: 'ci', kind: 'ci' }),
    config = { scheduler: { maxQueuedPerAgent: 100 }, jobs: { defaultTimeoutSec: 60, maxTimeoutSec: 60 } },
    jobs = createJobsService(db, { bus, events, registry, artifacts: {}, config });
  registry.registerAuto({ clientId: 'c', name: 'lab', type: 'sw', labels: [] });

  const ids = ['carol', 'alice', null, 'bob'].map((user) =>
      jobs.create({
        agentId: agent.id,
        source: 'cli',
        spec: { target: { type: 'sw' }, command: './run.sh', ...(user ? { user } : {}) }
      }).id),

    byUser = (dir) => jobs.page({ sort: 'user', dir, size: 'all' }).rows.map((j) => j.spec.user ?? null);
  assert.deepEqual(byUser('asc'), ['alice', 'bob', 'carol', null]);
  assert.deepEqual(byUser('desc'), ['carol', 'bob', 'alice', null]);

  const second = jobs.page({ sort: 'id', dir: 'asc', size: 2, page: 2 });
  assert.deepEqual(second.rows.map((j) => j.id), ids.slice(2));
  assert.equal(second.pagination.total, 4);
  assert.equal(second.pagination.pages, 2);
  assert.equal(jobs.page({ state: 'PASSED' }).pagination.total, 0);
});

test('agents list: sortable columns, newest first by default', () => {
  assert.deepEqual(normalize('agents'), { size: 25, sort: 'created', dir: 'desc' });
  assert.deepEqual(normalize('agents', { size: 10, sort: 'used', dir: 'asc' }), { size: 10, sort: 'used', dir: 'asc' });
  assert.equal(normalize('agents', { sort: 'token' }).sort, 'created'); // not a column: default
});
