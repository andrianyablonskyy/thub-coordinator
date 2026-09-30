/**
 * @file        packages/coordinator/test/search.test.js
 * @description Tests: dashboard list search (?q=) — query parsing, in-memory matching and the Jobs page's SQL search
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
  { createEventsService } = require('../src/services/events'),
  { createRegistryService } = require('../src/services/registry'),
  { createAgentsService } = require('../src/services/agents'),
  { createJobsService } = require('../src/services/jobs'),
  { parseTerms, normalizeQuery, matches, likeClause, MAX_QUERY } = require('../src/services/search');

test('parseTerms splits into lower-case, unique words, capped', () => {
  assert.deepEqual(parseTerms('  Lab-HW   nucleo lab-hw '), ['lab-hw', 'nucleo']);
  assert.deepEqual(parseTerms(''), []);
  assert.deepEqual(parseTerms(undefined), []);
  assert.deepEqual(parseTerms(['a']), []); // ?q=a&q=b arrives as an array: ignored
  assert.equal(parseTerms(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')).length, 10);
  assert.equal(normalizeQuery(`  ${'x'.repeat(500)}`).length, MAX_QUERY - 2);
});

test('matches needs every word somewhere in the fields', () => {
  const fields = ['lab-hw-01', 'IDLE', ['board:nucleo-f401re', 'uart'], null, [['10.0.0.7']]];
  assert.ok(matches(fields, []));
  assert.ok(matches(fields, parseTerms('NUCLEO idle')));
  assert.ok(matches(fields, parseTerms('10.0.0')));
  assert.ok(!matches(fields, parseTerms('nucleo busy')));
});

test('likeClause ANDs the words, ORs the columns and matches % and _ literally', () => {
  const { sql, params } = likeClause(['a', 'b'], ['x', '50%_off']);
  assert.equal(sql, '(COALESCE(a, \'\') LIKE ? ESCAPE \'\\\' OR COALESCE(b, \'\') LIKE ? ESCAPE \'\\\') AND ' +
    '(COALESCE(a, \'\') LIKE ? ESCAPE \'\\\' OR COALESCE(b, \'\') LIKE ? ESCAPE \'\\\')');
  assert.deepEqual(params, ['%x%', '%x%', '%50\\%\\_off%', '%50\\%\\_off%']);
  assert.deepEqual(likeClause(['a'], []), { sql: '', params: [] });
});

test('jobs.page searches ids, users, resources, agents and spec fields — never --env values', () => {
  const db = openDb(':memory:'),
    bus = new EventEmitter(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    ci = agents.create({ name: 'ci-firmware', kind: 'ci' }).agent,
    dev = agents.create({ name: 'alice-laptop', kind: 'cli' }).agent,
    config = { scheduler: { maxQueuedPerAgent: 100 }, jobs: { defaultTimeoutSec: 60, maxTimeoutSec: 60 } },
    jobs = createJobsService(db, { bus, events, registry, artifacts: {}, config });
  registry.registerAuto({ clientId: 'c', name: 'lab-sw-01', type: 'sw', labels: [] });

  const a = jobs.create({
      agentId: ci.id,
      source: 'ci',
      spec: {
        target: { type: 'sw' },
        command: './ci/smoke.sh',
        git: { url: 'git@github.com:yourorg/firmware-tests.git', ref: 'release/1.4' },
        meta: { ciJobId: '9165432107' },
        env: { API_TOKEN: 'hunter2-secret' }
      }
    }).id,
    m = jobs.create({
      agentId: dev.id,
      source: 'cli',
      spec: { target: { type: 'sw' }, command: 'make test', user: 'Alice Smith', suite: 'regression_50%' }
    }).id,
    ids = (q, extra = {}) => jobs.page({ q, size: 'all', ...extra }).rows.map((j) => j.id).sort();

  assert.deepEqual(ids(''), [a, m].sort());
  assert.deepEqual(ids(a.toLowerCase()), [a]); // job id, any case
  assert.deepEqual(ids('alice'), [m]); // user and agent name
  assert.deepEqual(ids('ci-firmware'), [a]); // agent name
  assert.deepEqual(ids('firmware-tests release/1.4'), [a]); // git url + ref, both words
  assert.deepEqual(ids('9165432107'), [a]); // meta
  assert.deepEqual(ids('smoke alice'), []); // words must all match the same job
  assert.deepEqual(ids('regression_50%'), [m]); // % and _ are literal…
  assert.deepEqual(ids('regression_5%'), []); // …not wildcards
  assert.deepEqual(ids('queued', { source: 'cli' }), [m]); // combines with filters
  assert.equal(jobs.page({ q: 'make', size: 'all' }).pagination.total, 1);

  // --env values are secrets (README §7.2): searching them must find nothing,
  // or the search box would be an oracle for them.
  assert.deepEqual(ids('hunter2'), []);
  assert.deepEqual(ids('API_TOKEN'), []);
});
