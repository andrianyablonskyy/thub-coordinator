/**
 * @file        packages/coordinator/test/scheduler.test.js
 * @description Tests: scheduler, registry, groups, job id allocation, and admin queue operations
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { openDb } = require('../src/db');
const { createEventsService } = require('../src/services/events');
const { createRegistryService } = require('../src/services/registry');
const { createAgentsService } = require('../src/services/agents');
const { createGroupsService } = require('../src/services/groups');
const { createArtifactsService } = require('../src/services/artifacts');
const { createJobsService } = require('../src/services/jobs');
const { createScheduler } = require('../src/services/scheduler');
const { createHeartbeatMonitor } = require('../src/services/heartbeat');
const { JOB_STATES, RESOURCE_STATES } = require('@andrian.yablonskyy/test-hub');

function buildTestServices(overrides = {}) {
  const db = openDb(':memory:');
  // Own bus per test, not the module-level singleton (production's
  // there's-only-one-Coordinator-process bus) — sharing it across every
  // test in this file would pile up listeners test after test with no
  // teardown, eventually tripping Node's MaxListenersExceededWarning.
  const bus = new EventEmitter();
  const events = createEventsService(db);
  const registry = createRegistryService(db, { bus, events });
  const agents = createAgentsService(db, { events });
  const groups = createGroupsService(db, { events, registry });
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-test-artifacts-'));
  const config = {
    scheduler: { assignAckTimeoutSec: 15, requeueOnLost: true, maxQueuedPerAgent: 20, tickIntervalSec: 3600 },
    jobs: { defaultTimeoutSec: 1800, maxTimeoutSec: 14400 },
    heartbeat: { intervalSec: 10, missedLimit: 3, sweepIntervalSec: 3600 },
    artifactsDir,
    sessionSecret: 'test-secret',
    publicUrl: 'http://localhost:8080',
    artifacts: { linkTtlHours: 1 },
    ...overrides,
  };
  const artifacts = createArtifactsService(db, { config });
  const jobs = createJobsService(db, { bus, events, registry, artifacts, config });
  const scheduler = createScheduler(db, { bus, events, registry, config });
  const heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config });
  return { db, registry, agents, groups, artifacts, jobs, scheduler, heartbeatMonitor, artifactsDir };
}

function registerResource(registry, { name, type, labels = [], groups = [], clientId } = {}) {
  const { resourceId } = registry.registerAuto({ clientId: clientId || `client-${name}`, name, type, labels, groups });
  return registry.get(resourceId);
}

function makeSpec(overrides = {}) {
  return {
    target: { type: 'sw', labels: [] },
    firmware: { url: 'https://x/app.bin' },
    tests: { url: 'https://x/tests.tar.gz' },
    ...overrides,
  };
}

test('scheduler assigns a queued job to a matching idle resource', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  assert.equal(job.state, JOB_STATES.QUEUED);

  scheduler.runPass();

  const assigned = jobs.get(job.id);
  assert.equal(assigned.state, JOB_STATES.ASSIGNED);
  assert.equal(assigned.resource_id, resource.id);
  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.BUSY);
});

test('job submission is rejected (422) when no resource could ever satisfy its labels', () => {
  const { registry, agents, jobs } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: ['board:a'] });

  assert.throws(
    () =>
      jobs.create({
        agentId: agent.id,
        source: 'cli',
        spec: makeSpec({ target: { type: 'sw', labels: ['board:b'] } }),
      }),
    /No registered resource/
  );
});

test('a job stays QUEUED while its only matching resource is busy', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: ['board:a'] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const first = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: ['board:a'] } }) });
  const second = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: ['board:a'] } }) });
  scheduler.runPass();

  assert.equal(jobs.get(first.id).state, JOB_STATES.ASSIGNED);
  assert.equal(jobs.get(second.id).state, JOB_STATES.QUEUED);
});

test('heartbeat sweeper marks a silent resource OUT_OF_SERVICE and requeues its active job', () => {
  const { db, registry, agents, jobs, scheduler, heartbeatMonitor } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  assert.equal(jobs.get(job.id).state, JOB_STATES.ASSIGNED);

  // Simulate 3+ missed heartbeats (heartbeatIntervalSec=10) by backdating last_heartbeat_at.
  const staleTs = new Date(Date.now() - 60_000).toISOString();
  db.prepare('UPDATE resources SET last_heartbeat_at = ? WHERE id = ?').run(staleTs, resource.id);

  heartbeatMonitor.sweepOnce();

  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.OUT_OF_SERVICE);
  // requeueOnLost defaults true and attempt was 1, so LOST -> QUEUED.
  assert.equal(jobs.get(job.id).state, JOB_STATES.QUEUED);
});

test('job ids are split by source: A-##### for ci, M-##### for cli', () => {
  const { registry, agents, jobs } = buildTestServices();
  const { agent } = agents.create({ name: 'mixed', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });

  const ciJob = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec() });
  const cliJob = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  const ciJob2 = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec() });

  assert.match(ciJob.id, /^A-\d{5}$/);
  assert.match(cliJob.id, /^M-\d{5}$/);
  // Independent counters: the second ci job increments the A series only.
  assert.equal(Number(ciJob2.id.slice(2)), Number(ciJob.id.slice(2)) + 1);
});

test('admin resetQueue cancels every active job and leaves finished ones alone', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const assigned = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  assert.equal(jobs.get(assigned.id).state, JOB_STATES.ASSIGNED);

  const queued = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  const finished = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  jobs.setState(finished.id, JOB_STATES.PASSED);

  const canceled = jobs.resetQueue();

  assert.equal(canceled, 2);
  assert.equal(jobs.get(assigned.id).state, JOB_STATES.CANCELED);
  assert.equal(jobs.get(queued.id).state, JOB_STATES.CANCELED);
  assert.equal(jobs.get(finished.id).state, JOB_STATES.PASSED); // untouched
});

test('admin cleanHistory deletes finished jobs, their artifacts on disk, and leaves active jobs alone', () => {
  const { registry, agents, artifacts, jobs, artifactsDir } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });

  const finished = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  jobs.setState(finished.id, JOB_STATES.PASSED);
  artifacts.storeGenerated(finished.id, 'console.log', Buffer.from('hello'), 'text/plain');
  assert.ok(fs.existsSync(path.join(artifactsDir, finished.id)));

  const active = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });

  const deleted = jobs.cleanHistory();

  assert.equal(deleted, 1);
  assert.equal(jobs.get(finished.id), undefined);
  assert.equal(fs.existsSync(path.join(artifactsDir, finished.id)), false);
  assert.ok(jobs.get(active.id)); // active job untouched
});

test('resource re-registration overwrites type/labels/status and marks its stale active job LOST', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const resource = registerResource(registry, { name: 'lab-hw-01', type: 'hw', labels: ['board:a'] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'hw', labels: ['board:a'] } }) });
  scheduler.runPass();
  assert.equal(jobs.get(job.id).state, JOB_STATES.ASSIGNED);
  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.BUSY);

  // Simulate the daemon crashing and restarting with a changed config.
  const { resourceId } = registry.registerAuto({
    clientId: 'client-lab-hw-01',
    name: 'lab-hw-01',
    type: 'sw',
    labels: ['board:b'],
  });
  assert.equal(resourceId, resource.id);

  const reregistered = registry.get(resource.id);
  assert.equal(reregistered.type, 'sw');
  assert.deepEqual(reregistered.labels, ['board:b']);
  assert.equal(reregistered.status, RESOURCE_STATES.REGISTERED);
  assert.equal(reregistered.busy_source, null);

  // The stale job it was holding is now LOST (then requeued, since attempt < 2).
  assert.equal(jobs.get(job.id).state, JOB_STATES.QUEUED);
});

test('resource re-registration does not clear an admin-set MAINTENANCE status', () => {
  const { registry } = buildTestServices();
  const resource = registerResource(registry, { name: 'lab-sw-02', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });
  registry.setMaintenance(resource.id, true);

  registry.registerAuto({ clientId: 'client-lab-sw-02', name: 'lab-sw-02', type: 'sw', labels: [] });

  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.MAINTENANCE);
});

test('renaming a Client (same clientId, new name) updates the same resource in place', () => {
  const { registry } = buildTestServices();
  const resource = registerResource(registry, { clientId: 'stable-uuid-1', name: 'old-name', type: 'sw', labels: [] });

  const { resourceId } = registry.registerAuto({ clientId: 'stable-uuid-1', name: 'new-name', type: 'sw', labels: [] });

  assert.equal(resourceId, resource.id);
  assert.equal(registry.get(resource.id).name, 'new-name');
  assert.equal(registry.list().length, 1); // not a second resource
});

test('a name already claimed by a different clientId is rejected, whether new or a rename', () => {
  const { registry } = buildTestServices();
  registerResource(registry, { clientId: 'uuid-a', name: 'shared-name', type: 'sw', labels: [] });
  registerResource(registry, { clientId: 'uuid-b', name: 'other-name', type: 'sw', labels: [] });

  assert.throws(
    () => registry.registerAuto({ clientId: 'uuid-c', name: 'shared-name', type: 'sw', labels: [] }),
    /already registered by a different client/
  );
  assert.throws(
    () => registry.registerAuto({ clientId: 'uuid-b', name: 'shared-name', type: 'sw', labels: [] }),
    /already used by another client/
  );
});

test('a name held by an OUT_OF_SERVICE (abandoned) client can be reclaimed by a new registration', () => {
  const { registry } = buildTestServices();
  const abandoned = registerResource(registry, { clientId: 'old-uuid', name: 'lab-01', type: 'sw', labels: [] });
  registry.markOutOfService(abandoned.id);

  const { resourceId } = registry.registerAuto({ clientId: 'new-uuid', name: 'lab-01', type: 'hw', labels: ['x'] });

  assert.equal(resourceId, abandoned.id); // took over the same row, not a duplicate
  const reclaimed = registry.get(resourceId);
  assert.equal(reclaimed.client_id, 'new-uuid');
  assert.equal(reclaimed.type, 'hw');
  assert.equal(reclaimed.status, RESOURCE_STATES.REGISTERED);
  assert.equal(registry.list().length, 1);
});

test('a name held by an OUT_OF_SERVICE client can be reclaimed via a rename too, without duplicating the row', () => {
  const { registry } = buildTestServices();
  const abandoned = registerResource(registry, { clientId: 'old-uuid', name: 'lab-02', type: 'sw', labels: [] });
  registry.markOutOfService(abandoned.id);
  const renaming = registerResource(registry, { clientId: 'live-uuid', name: 'my-bench', type: 'sw', labels: [] });

  const { resourceId } = registry.registerAuto({ clientId: 'live-uuid', name: 'lab-02', type: 'sw', labels: [] });

  assert.equal(resourceId, renaming.id);
  assert.equal(registry.get(renaming.id).name, 'lab-02');
  // The abandoned row is still there (history preserved), just renamed out of the way.
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get(abandoned.id).name, `lab-02__stale-${abandoned.id}`);
});

test('a legacy resource with no clientId (pre-dates the feature) is adopted by name on first registration', () => {
  const { db, registry } = buildTestServices();
  const resource = registerResource(registry, { clientId: 'will-be-overwritten', name: 'legacy-01', type: 'sw', labels: [] });
  // Simulate a pre-migration row: no client_id yet.
  db.prepare('UPDATE resources SET client_id = NULL WHERE id = ?').run(resource.id);

  const { resourceId } = registry.registerAuto({ clientId: 'brand-new-uuid', name: 'legacy-01', type: 'sw', labels: ['x'] });

  assert.equal(resourceId, resource.id); // adopted, not duplicated
  assert.equal(registry.get(resource.id).client_id, 'brand-new-uuid');
  assert.equal(registry.list().length, 1);
});

test('a job with target.group only schedules onto resources that are members of that group', () => {
  const { registry, agents, groups, jobs, scheduler } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const groupA = groups.create({ name: 'group-a' });
  const groupB = groups.create({ name: 'group-b' });

  const inGroupA = registerResource(registry, { name: 'lab-a', type: 'sw', groups: [groupA.id] });
  const inGroupB = registerResource(registry, { name: 'lab-b', type: 'sw', groups: [groupB.id] });
  registry.heartbeat(inGroupA.id, { state: 'idle' });
  registry.heartbeat(inGroupB.id, { state: 'idle' });

  const job = jobs.create({
    agentId: agent.id,
    source: 'cli',
    spec: makeSpec({ target: { type: 'sw', labels: [], group: groupA.id } }),
  });
  scheduler.runPass();

  const assigned = jobs.get(job.id);
  assert.equal(assigned.state, JOB_STATES.ASSIGNED);
  assert.equal(assigned.resource_id, inGroupA.id); // not inGroupB, despite being IDLE and type-matching
});

test('a job with target.group is rejected (422) when no resource is ever a member of that group', () => {
  const { registry, agents, groups, jobs } = buildTestServices();
  const { agent } = agents.create({ name: 'ci', kind: 'ci' });
  const group = groups.create({ name: 'empty-group' });
  registerResource(registry, { name: 'lab-01', type: 'sw', groups: [] }); // exists, but not a member

  assert.throws(
    () =>
      jobs.create({
        agentId: agent.id,
        source: 'cli',
        spec: makeSpec({ target: { type: 'sw', labels: [], group: group.id } }),
      }),
    /No registered resource/
  );
});

test('a resource can belong to several groups at once', () => {
  const { registry, groups } = buildTestServices();
  const g1 = groups.create({ name: 'g1' });
  const g2 = groups.create({ name: 'g2' });

  const resource = registerResource(registry, { name: 'multi-group', type: 'sw', groups: [g1.id, g2.id] });

  assert.deepEqual(registry.get(resource.id).group_ids, [g1.id, g2.id]);
});

test('deleting a group strips it from every resource that listed it, without touching the resource otherwise', () => {
  const { registry, groups } = buildTestServices();
  const g1 = groups.create({ name: 'to-delete' });
  const g2 = groups.create({ name: 'keep-me' });
  const resource = registerResource(registry, { name: 'lab-01', type: 'sw', labels: ['x'], groups: [g1.id, g2.id] });

  groups.remove(g1.id);

  const after = registry.get(resource.id);
  assert.deepEqual(after.group_ids, [g2.id]);
  assert.deepEqual(after.labels, ['x']); // untouched
  assert.equal(groups.get(g1.id), undefined);
  assert.ok(groups.get(g2.id));
});
