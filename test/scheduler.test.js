/**
 * @file        packages/coordinator/test/scheduler.test.js
 * @description Tests: scheduler, registry, groups, client pinning, job id allocation, and admin queue operations
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
  { createGroupsService } = require('../src/services/groups'),
  { createAdminUsersService } = require('../src/services/admin-users'),
  { createJobsService } = require('../src/services/jobs'),
  { createLogsService } = require('../src/services/logs'),
  { createScheduler } = require('../src/services/scheduler'),
  { createHeartbeatMonitor } = require('../src/services/heartbeat'),
  { JOB_STATES, RESOURCE_STATES } = require('@andrian.yablonskyy/thub-common');

function buildTestServices(overrides = {}){
  const db = openDb(':memory:'),
    // Own bus per test, not the module-level singleton (production's
    // there's-only-one-Coordinator-process bus) — sharing it across every
    // test in this file would pile up listeners test after test with no
    // teardown, eventually tripping Node's MaxListenersExceededWarning.
    bus = new EventEmitter(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    groups = createGroupsService(db, { events, registry }),
    config = {
      scheduler: { assignAckTimeoutSec: 15, requeueOnLost: true, maxQueuedPerAgent: 20, tickIntervalSec: 3600 },
      jobs: { defaultTimeoutSec: 1800, maxTimeoutSec: 14400 },
      heartbeat: { intervalSec: 10, missedLimit: 3, sweepIntervalSec: 3600 },
      sessionSecret: 'test-secret',
      publicUrl: 'http://localhost:8080',
      ...overrides
    },
    logs = createLogsService(db, { bus }),
    jobs = createJobsService(db, { bus, events, registry, config }),
    scheduler = createScheduler(db, { bus, events, registry, config }),
    heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config });
  return { db, bus, registry, agents, groups, logs, jobs, scheduler, heartbeatMonitor };
}

function registerResource(registry, { name, type, labels = [], groups = [], clientId } = {}){
  const { resourceId } = registry.registerAuto({ clientId: clientId || `client-${name}`, name, type, labels, groups });
  return registry.get(resourceId);
}

function makeSpec(overrides = {}){
  return {
    target: { type: 'sw', labels: [] },
    command: './run.sh',
    ...overrides
  };
}

test('scheduler assigns a queued job to a matching idle resource', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
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
  const { registry, agents, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: ['board:a'] });

  assert.throws(
    () =>
      jobs.create({
        agentId: agent.id,
        source: 'cli',
        spec: makeSpec({ target: { type: 'sw', labels: ['board:b'] } })
      }),
    /No registered resource/
  );
});

test('a job stays QUEUED while its only matching resource is busy', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: ['board:a'] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const first = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: ['board:a'] } }) }),
    second = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: ['board:a'] } }) });
  scheduler.runPass();

  assert.equal(jobs.get(first.id).state, JOB_STATES.ASSIGNED);
  assert.equal(jobs.get(second.id).state, JOB_STATES.QUEUED);
});

test('heartbeat sweeper marks a silent resource OUT_OF_SERVICE and requeues its active job', () => {
  const { db, registry, agents, jobs, scheduler, heartbeatMonitor } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
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
  const { registry, agents, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'mixed', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });

  const ciJob = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec() }),
    cliJob = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() }),
    ciJob2 = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec() });

  assert.match(ciJob.id, /^A-\d{5}$/);
  assert.match(cliJob.id, /^M-\d{5}$/);
  // Independent counters: the second ci job increments the A series only.
  assert.equal(Number(ciJob2.id.slice(2)), Number(ciJob.id.slice(2)) + 1);
});

test('default priority follows the job source; an explicit one is kept', () => {
  const { agents, registry, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw' });

  assert.equal(jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec() }).priority, 50);
  assert.equal(jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() }).priority, 60);
  assert.equal(jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec({ priority: 90 }) }).priority, 90);
});

test('duration is stored once when a job finishes, from its start; none if it never ran', () => {
  const { registry, agents, jobs, scheduler, db } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    r = registerResource(registry, { name: 'lab-sw-01', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });

  const ran = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  jobs.setState(ran.id, JOB_STATES.RUNNING);
  db.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 125e3).toISOString(), ran.id);
  jobs.setState(ran.id, JOB_STATES.PASSED);
  assert.equal(jobs.get(ran.id).duration_sec, 125);

  const never = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  jobs.cancel(never.id, { isAdmin: true });
  assert.equal(jobs.get(never.id).duration_sec, null);
});

test('admin resetQueue cancels every active job and leaves finished ones alone', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    resource = registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });

  const assigned = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  assert.equal(jobs.get(assigned.id).state, JOB_STATES.ASSIGNED);

  const queued = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() }),
    finished = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  jobs.setState(finished.id, JOB_STATES.PASSED);

  const canceled = jobs.resetQueue();

  assert.equal(canceled, 2);
  assert.equal(jobs.get(assigned.id).state, JOB_STATES.CANCELED);
  assert.equal(jobs.get(queued.id).state, JOB_STATES.CANCELED);
  assert.equal(jobs.get(finished.id).state, JOB_STATES.PASSED); // untouched
});

test('admin cleanHistory deletes finished jobs with their log lines, and leaves active jobs alone', () => {
  const { db, registry, agents, logs, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw-01', type: 'sw', labels: [] });

  const finished = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  jobs.setState(finished.id, JOB_STATES.PASSED);
  logs.appendBatch(finished.id, [{ stream: 'runner', line: 'hello' }]);
  const logLines = (id) => db.prepare('SELECT COUNT(*) AS n FROM job_logs WHERE job_id = ?').get(id).n;
  assert.equal(logLines(finished.id), 1);

  const active = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() }),

    deleted = jobs.cleanHistory();

  assert.equal(deleted, 1);
  assert.equal(jobs.get(finished.id), undefined);
  assert.equal(logLines(finished.id), 0);
  assert.ok(jobs.get(active.id)); // active job untouched
});

test('resource re-registration overwrites type/labels/status and marks its stale active job LOST', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    resource = registerResource(registry, { name: 'lab-hw-01', type: 'hw', labels: ['board:a'] });
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
    labels: ['board:b']
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
  const { registry } = buildTestServices(),
    resource = registerResource(registry, { name: 'lab-sw-02', type: 'sw', labels: [] });
  registry.heartbeat(resource.id, { state: 'idle' });
  registry.setMaintenance(resource.id, true);

  registry.registerAuto({ clientId: 'client-lab-sw-02', name: 'lab-sw-02', type: 'sw', labels: [] });

  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.MAINTENANCE);
});

test('renaming a Client (same clientId, new name) updates the same resource in place', () => {
  const { registry } = buildTestServices(),
    resource = registerResource(registry, { clientId: 'stable-uuid-1', name: 'old-name', type: 'sw', labels: [] }),

    { resourceId } = registry.registerAuto({ clientId: 'stable-uuid-1', name: 'new-name', type: 'sw', labels: [] });

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
  const { registry } = buildTestServices(),
    abandoned = registerResource(registry, { clientId: 'old-uuid', name: 'lab-01', type: 'sw', labels: [] });
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
  const { registry } = buildTestServices(),
    abandoned = registerResource(registry, { clientId: 'old-uuid', name: 'lab-02', type: 'sw', labels: [] });
  registry.markOutOfService(abandoned.id);
  const renaming = registerResource(registry, { clientId: 'live-uuid', name: 'my-bench', type: 'sw', labels: [] }),

    { resourceId } = registry.registerAuto({ clientId: 'live-uuid', name: 'lab-02', type: 'sw', labels: [] });

  assert.equal(resourceId, renaming.id);
  assert.equal(registry.get(renaming.id).name, 'lab-02');
  // The abandoned row is still there (history preserved), just renamed out of the way.
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get(abandoned.id).name, `lab-02__stale-${abandoned.id}`);
});

test('a legacy resource with no clientId (pre-dates the feature) is adopted by name on first registration', () => {
  const { db, registry } = buildTestServices(),
    resource = registerResource(registry, { clientId: 'will-be-overwritten', name: 'legacy-01', type: 'sw', labels: [] });
  // Simulate a pre-migration row: no client_id yet.
  db.prepare('UPDATE resources SET client_id = NULL WHERE id = ?').run(resource.id);

  const { resourceId } = registry.registerAuto({ clientId: 'brand-new-uuid', name: 'legacy-01', type: 'sw', labels: ['x'] });

  assert.equal(resourceId, resource.id); // adopted, not duplicated
  assert.equal(registry.get(resource.id).client_id, 'brand-new-uuid');
  assert.equal(registry.list().length, 1);
});

test('an agent given a group (dashboard) runs its jobs only on that group\'s resources; whatever the Agent sends is replaced', () => {
  const { db, registry, agents, groups, jobs, scheduler } = buildTestServices(),
    users = createAdminUsersService(db, {}),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    groupA = groups.create({ name: 'group-a' }),
    groupB = groups.create({ name: 'group-b' }),
    inGroupA = registerResource(registry, { name: 'lab-a', type: 'sw', groups: [groupA.id] }),
    inGroupB = registerResource(registry, { name: 'lab-b', type: 'sw', groups: [groupB.id] });
  registry.heartbeat(inGroupA.id, { state: 'idle' });
  registry.heartbeat(inGroupB.id, { state: 'idle' });

  // A CI token in group B, whose (older) Agent still asks for group A.
  agents.setGroup(agent.id, groupB.id);
  const job = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec({ target: { type: 'sw', labels: [], group: groupA.id } }) });
  assert.equal(jobs.get(job.id).spec.target.group, groupB.id);
  scheduler.runPass();
  assert.equal(jobs.get(job.id).resource_id, inGroupB.id);

  // A user's group follows their key (kept across rotations); none = any resource.
  const dev = users.create({ username: 'dev', email: 'd@example.com', role: 'user', groupId: groupA.id }, { by: 't' });
  users.issueKey(dev.id, { by: 't' });
  const devAgent = agents.list().find((a) => a.user_id === dev.id),
    devJob = jobs.create({ agentId: devAgent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: [] } }) });
  assert.equal(jobs.get(devJob.id).spec.target.group, groupA.id);
  users.issueKey(dev.id, { by: 't' }); // rotated
  const rotatedJob = jobs.create({ agentId: devAgent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: [] } }) });
  assert.equal(jobs.get(rotatedJob.id).spec.target.group, groupA.id);
  users.update(dev.id, { groupId: '' }, { by: 't' });
  const anyJob = jobs.create({ agentId: devAgent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: [] } }) });
  assert.equal(jobs.get(anyJob.id).spec.target.group, undefined);

  // Deleting a group sends its agents back to any resource.
  groups.remove(groupB.id);
  assert.equal(agents.get(agent.id).group_id, null);
  assert.throws(() => agents.setGroup(agent.id, 'no-such-group'), /Unknown group/);
});

test('a job is rejected (422) when no resource is ever a member of its agent\'s group — named, not by id', () => {
  const { registry, agents, groups, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    group = groups.create({ name: 'empty-group' });
  registerResource(registry, { name: 'lab-01', type: 'sw', groups: [] }); // exists, but not a member
  agents.setGroup(agent.id, group.id);
  assert.throws(
    () => jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', labels: [] } }) }),
    /No registered resource can ever satisfy type=sw labels= group=empty-group \(this agent's group, set on the dashboard\)/
  );
});

test('a job with target.client (by name) waits for that client even when another matching one is idle', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    pinned = registerResource(registry, { name: 'lab-pinned', type: 'sw' }),
    other = registerResource(registry, { name: 'lab-other', type: 'sw' });
  registry.heartbeat(other.id, { state: 'idle' }); // pinned is still REGISTERED, not IDLE

  const job = jobs.create({
    agentId: agent.id,
    source: 'cli',
    spec: makeSpec({ target: { type: 'sw', labels: [], client: 'lab-pinned' } })
  });
  assert.equal(job.spec.target.client, pinned.id); // name resolved to the stable resource id

  scheduler.runPass();
  assert.equal(jobs.get(job.id).state, JOB_STATES.QUEUED); // not grabbed by lab-other

  registry.heartbeat(pinned.id, { state: 'idle' });
  scheduler.runPass();
  const assigned = jobs.get(job.id);
  assert.equal(assigned.state, JOB_STATES.ASSIGNED);
  assert.equal(assigned.resource_id, pinned.id);
});

test('an unpinned job prefers a resource no queued job is pinned to', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    pinned = registerResource(registry, { name: 'lab-pinned', type: 'sw' }),
    other = registerResource(registry, { name: 'lab-other', type: 'sw' });
  registry.heartbeat(pinned.id, { state: 'idle' });
  registry.heartbeat(other.id, { state: 'idle' });

  // Unpinned job has higher priority, so it's considered first; it must not
  // take lab-pinned (which is also least-recently-used) away from the pinned job.
  const unpinned = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ priority: 90 }) }),
    pinnedJob = jobs.create({
      agentId: agent.id,
      source: 'cli',
      spec: makeSpec({ target: { type: 'sw', labels: [], client: pinned.id }, priority: 10 })
    });
  scheduler.runPass();

  assert.equal(jobs.get(unpinned.id).resource_id, other.id);
  assert.equal(jobs.get(pinnedJob.id).resource_id, pinned.id);
});

test('a job with target.client is rejected (422) when the client is unknown or cannot satisfy the target', () => {
  const { registry, agents, jobs } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' });
  registerResource(registry, { name: 'lab-sw', type: 'sw', labels: ['board:a'] });

  assert.throws(
    () => jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', client: 'nope' } }) }),
    /Unknown client "nope"/
  );
  assert.throws(
    () => jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'hw', client: 'lab-sw' } }) }),
    /No registered resource/
  );
  assert.throws(
    () =>
      jobs.create({
        agentId: agent.id,
        source: 'cli',
        spec: makeSpec({ target: { type: 'sw', labels: ['board:b'], client: 'lab-sw' } })
      }),
    /No registered resource/
  );
});

test('removing a resource keeps its job history by name and cancels jobs pinned to it', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    r = registerResource(registry, { name: 'lab-old', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });

  const done = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  assert.throws(() => registry.remove(r.id), /working on job/); // ASSIGNED: refused
  jobs.setState(done.id, JOB_STATES.PASSED);
  registry.heartbeat(r.id, { state: 'busy' }); // keep it from taking the pinned job below

  const pinned = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', client: r.id } }) });
  registry.remove(r.id);
  assert.deepEqual(jobs.cancelPinnedTo(r.id, 'removed'), [pinned.id]);

  assert.equal(registry.get(r.id), undefined);
  const kept = jobs.get(done.id);
  assert.equal(kept.resource_id, null);
  assert.equal(kept.resource_name, 'lab-old');
  assert.equal(jobs.get(pinned.id).state, JOB_STATES.CANCELED);
  assert.throws(() => registry.remove(r.id), /Unknown resource/);
});

test('removing a resource running a job: stops the job now, removes once the Client confirms', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    r = registerResource(registry, { name: 'lab-busy', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });
  const running = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  jobs.setState(running.id, JOB_STATES.RUNNING);

  assert.throws(() => jobs.removeResource(r.id), /running job/); // needs stopJob

  const res = jobs.removeResource(r.id, { stopJob: true });
  assert.equal(res.pending, true);
  assert.equal(res.stoppedJob, running.id);
  assert.equal(jobs.get(running.id).state, JOB_STATES.CANCELED);
  assert.ok(registry.get(r.id).remove_requested_at); // still there: the Client hasn't heard yet

  // Pending removal takes no new work, even once it reports idle.
  registry.heartbeat(r.id, { state: 'idle' });
  const next = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  assert.equal(jobs.get(next.id).state, JOB_STATES.QUEUED);

  jobs.completeRemoval(r.id); // what the heartbeat route does on the Client's "no active job"
  assert.equal(registry.get(r.id), undefined);
  assert.equal(jobs.get(running.id).resource_name, 'lab-busy');
});

test('the sweeper finishes a pending removal whose Client never confirms', () => {
  const { registry, agents, jobs, scheduler, heartbeatMonitor, db } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    r = registerResource(registry, { name: 'lab-silent', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });
  jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec() });
  scheduler.runPass();
  jobs.removeResource(r.id, { stopJob: true });

  heartbeatMonitor.sweepRemovals();
  assert.ok(registry.get(r.id)); // not timed out yet

  db.prepare('UPDATE resources SET remove_requested_at = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString(), r.id);
  heartbeatMonitor.sweepRemovals();
  assert.equal(registry.get(r.id), undefined);
});

test('a removed Client re-registers as a fresh resource under the same name', () => {
  const { registry } = buildTestServices(),
    r = registerResource(registry, { name: 'lab-back', type: 'sw', clientId: 'c-back' });
  registry.remove(r.id);
  const again = registerResource(registry, { name: 'lab-back', type: 'sw', clientId: 'c-back' });
  assert.notEqual(again.id, r.id);
  assert.equal(again.name, 'lab-back');
});

test('a job-supplied Docker image runs on any matching SW Client (no opt-in any more)', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'dev', kind: 'cli' }),
    r = registerResource(registry, { name: 'sw-any', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });
  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: { target: { type: 'sw', labels: [] }, image: 'alpine', command: './run.sh' } });
  scheduler.runPass();
  assert.equal(jobs.get(job.id).resource_id, r.id);
  // An older Client still reporting its sw settings: they're dropped.
  const { resourceId } = registry.registerAuto({
    clientId: 'c-old', name: 'sw-old', type: 'sw', labels: [], capabilities: { sw: { image: 'emu', allowJobImages: false } }
  });
  assert.deepEqual(registry.get(resourceId).capabilities.sw, {});
});

test('waiting reason: says why a queued job has no Client — every match taken, or none matching', () => {
  const { registry } = buildTestServices(),
    reason = () => registry.waitingReason('sw', [], undefined, undefined),
    a = registerResource(registry, { name: 'sw-a', type: 'sw' }),
    b = registerResource(registry, { name: 'sw-b', type: 'sw' });
  registry.heartbeat(a.id, { state: 'idle' });
  assert.equal(reason(), null); // sw-a can take it

  registry.assignToJob(a.id, 'cli');
  assert.equal(reason(), 'every matching SW Client is taken: sw-a (busy), sw-b (not connected yet)');
  assert.equal(registry.waitingReason('hw', [], undefined, undefined), 'no HW Client matches this job\'s target');
});

test('--env: the Client gets the values; the Agent API sees them masked; they\'re dropped when the job ends (not on a requeued LOST)', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'dev', kind: 'cli' }),
    r = registerResource(registry, { name: 'sw-env', type: 'sw' }),
    env = { DOCKER_REGISTRY: 'registry.lab:5000', DOCKER_USERNAME: 'ci', DOCKER_PASSWORD: 's3cret' };
  registry.heartbeat(r.id, { state: 'idle' });

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ env }) });
  assert.deepEqual(jobs.get(job.id).spec.env, env); // what the Client is handed
  assert.deepEqual(jobs.publicJob(jobs.get(job.id)).spec.env, { DOCKER_REGISTRY: '***', DOCKER_USERNAME: '***', DOCKER_PASSWORD: '***' });

  scheduler.runPass();
  jobs.markLost(job.id); // requeued: still needs them
  assert.equal(jobs.get(job.id).state, JOB_STATES.QUEUED);
  assert.deepEqual(jobs.get(job.id).spec.env, env);

  jobs.cancel(job.id, { isAdmin: true });
  assert.deepEqual(jobs.get(job.id).spec.env, { DOCKER_REGISTRY: '***', DOCKER_USERNAME: '***', DOCKER_PASSWORD: '***' });
});

test('every job carries its command and runs on any matching Client; an old-Agent spec is refused', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'dev', kind: 'cli' }),
    r = registerResource(registry, { name: 'sw-any', type: 'sw' });
  registry.heartbeat(r.id, { state: 'idle' });

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ command: 'make test', args: ['-j4'] }) });
  scheduler.runPass();
  assert.equal(jobs.get(job.id).resource_id, r.id);
  assert.equal(jobs.get(job.id).spec.command, 'make test');

  assert.throws(
    () => jobs.create({ agentId: agent.id, source: 'cli', spec: { target: { type: 'sw' }, firmware: { url: 'https://x/a' }, tests: { url: 'https://x/t' } } }),
    /older Agent.*--command/
  );
  assert.throws(() => jobs.create({ agentId: agent.id, source: 'cli', spec: { target: { type: 'sw' } } }), /command/);
});

test('reboot schedule: validated, then resent on heartbeats until the Client reports applying it', () => {
  const { registry } = buildTestServices(),
    r = registerResource(registry, { name: 'lab-reboot', type: 'sw' });

  assert.throws(() => registry.setRebootSchedule(r.id, '61 3 * * *'), /Invalid reboot schedule.*minute: 61/);
  assert.equal(registry.pendingRebootSchedule(r.id), null); // nothing set, nothing applied

  registry.setRebootSchedule(r.id, '  30   3 * * sun ');
  assert.deepEqual(registry.pendingRebootSchedule(r.id), { cron: '30 3 * * sun' });
  registry.heartbeat(r.id, { state: 'idle' }); // an older Client: reports nothing
  assert.deepEqual(registry.pendingRebootSchedule(r.id), { cron: '30 3 * * sun' });
  registry.heartbeat(r.id, { state: 'idle', rebootSchedule: '30 3 * * sun' });
  assert.equal(registry.pendingRebootSchedule(r.id), null);

  registry.setRebootSchedule(r.id, '');
  assert.deepEqual(registry.pendingRebootSchedule(r.id), { cron: null }); // tell it to clear
  registry.heartbeat(r.id, { state: 'idle', rebootSchedule: null });
  assert.equal(registry.pendingRebootSchedule(r.id), null);
});

test('reboot now: refused offline or without a helper; cancels a running job first, then sends reboot', () => {
  const { bus, registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'dev', kind: 'cli' }),
    reg = (name, rebootSupported) => registry.get(registry.registerAuto({
      clientId: `c-${name}`, name, type: 'sw', labels: [], capabilities: { sw: { image: 'emu' }, rebootSupported }
    }).resourceId),
    offline = reg('rb-offline', true),
    noHelper = reg('rb-nohelper', false),
    idle = reg('rb-idle', true),
    busy = reg('rb-busy', true),
    commands = [];
  for (const r of [noHelper, idle, busy]){
    registry.heartbeat(r.id, { state: 'idle' });
  }
  bus.on('command', (c) => commands.push(c));

  assert.throws(() => jobs.requestReboot(offline.id), /offline/);
  assert.throws(() => jobs.requestReboot(noHelper.id), /no reboot helper/);

  assert.equal(jobs.requestReboot(idle.id).canceledJob, null);
  assert.deepEqual(commands.map((c) => [c.resourceId, c.command]), [[idle.id, 'reboot']]);
  commands.length = 0;

  const job = jobs.create({ agentId: agent.id, source: 'cli', spec: makeSpec({ target: { type: 'sw', client: busy.id } }) });
  scheduler.runPass();
  jobs.setState(job.id, JOB_STATES.RUNNING);
  assert.equal(jobs.requestReboot(busy.id, { by: 'admin' }).canceledJob, job.id);
  assert.deepEqual(commands.map((c) => c.command), ['cancel-job', 'reboot']); // same heartbeat reply, in order
  assert.equal(commands[1].reason, 'user reboot request by admin');
  const after = jobs.get(job.id);
  assert.equal(after.state, JOB_STATES.CANCELED);
  assert.equal(after.message, 'Canceled: user reboot request');
});

test('devices from the dashboard: reported hw-devices stored, saved at a new revision, resent until applied', () => {
  const { registry } = buildTestServices(),
    { resourceId } = registry.registerAuto({
      clientId: 'c-cfg', name: 'lab-cfg', type: 'hw', labels: [], capabilities: { hw: { stlinks: [], uarts: [], usbs: [] } },
      config: { stlinks: [], uarts: [{ index: 1 }], usbs: [] }
    });
  assert.deepEqual(registry.get(resourceId).client_config, { stlinks: [], uarts: [{ index: 1 }], usbs: [] });
  assert.equal(registry.pendingConfig(resourceId), null);

  assert.throws(() => registry.setClientConfig(resourceId, { uarts: [{ path: '/tmp/x' }] }), /Invalid HW config: hw-devices\.uarts\.0\.path/);
  const saved = registry.setClientConfig(resourceId, { uarts: [{ index: 2, baudRate: 9600 }] });
  assert.equal(saved.config_revision, 1);
  assert.deepEqual(registry.pendingConfig(resourceId), { revision: 1, type: 'hw', config: { uarts: [{ index: 2, baudRate: 9600 }] } });

  registry.heartbeat(resourceId, { state: 'idle' }); // an older Client: reports nothing
  assert.equal(registry.pendingConfig(resourceId).revision, 1);
  registry.heartbeat(resourceId, { state: 'idle', configRevision: 1 });
  assert.equal(registry.pendingConfig(resourceId), null);

  registry.setClientConfig(resourceId, { usbs: [{ index: 1 }] });
  registry.heartbeat(resourceId, { state: 'idle', configRevision: 2, configError: 'Config revision 2 refused: bad' });
  assert.equal(registry.pendingConfig(resourceId), null); // refused ones aren't resent
  assert.match(registry.get(resourceId).config_error, /refused: bad/);

  // An SW Client has no settings: only an empty section is accepted.
  const sw = registerResource(registry, { name: 'sw1', type: 'sw' });
  assert.throws(() => registry.setClientConfig(sw.id, { image: 'emu' }), /SW Client has no settings of its own/);
});

test('config export/import: exported from the reported file (+ what\'s pending); an import goes out with set-config until applied', () => {
  const { registry } = buildTestServices(),
    { resourceId } = registry.registerAuto({
      clientId: 'c-io', name: 'dut1', type: 'hw', labels: [], capabilities: { hw: { stlinks: [], uarts: [], usbs: [] } },
      config: { uarts: [{ index: 1 }] },
      // An older Client: `hw`, plus legacy sections that never show up again.
      configFile: { coordinatorUrl: 'https://c', name: 'dut1', joinKey: 'k', type: 'hw', labels: [], hw: { uarts: [{ index: 1 }] },
        sw: { image: 'emu:1', registryAuth: { password: 'x' } }, artifactory: { token: 'secret', allowedArtifactPrefixes: [] } }
    });
  assert.deepEqual(registry.exportClientConfig(resourceId), { // never the joinKey
    coordinatorUrl: 'https://c', name: 'dut1', type: 'hw', labels: [], 'hw-devices': { uarts: [{ index: 1 }] }
  });

  const { resource, ignored } = registry.importClientConfig(resourceId, {
    coordinatorUrl: 'https://evil', name: 'other', joinKey: 'x', type: 'hw', labels: ['board:b'], sources: { allowedPrefixes: ['*'] },
    'hw-devices': { usbs: [{ index: 2 }] }
  }, { by: 'admin' });
  assert.deepEqual(ignored, ['sources', 'coordinatorUrl', 'name', 'joinKey']);
  assert.equal(resource.config_revision, 1);
  assert.deepEqual(registry.pendingConfig(resourceId),
    { revision: 1, type: 'hw', config: { usbs: [{ index: 2 }] }, file: { labels: ['board:b'] } });
  const exported = registry.exportClientConfig(resourceId);
  assert.deepEqual([exported.coordinatorUrl, exported.name, exported.labels, exported['hw-devices'], exported.hw],
    ['https://c', 'dut1', ['board:b'], { usbs: [{ index: 2 }] }, undefined]);

  registry.setClientConfig(resourceId, { usbs: [{ index: 3 }] }); // a Config tab Save meanwhile: the import still goes with it
  assert.deepEqual(registry.pendingConfig(resourceId).file, { labels: ['board:b'] });
  registry.heartbeat(resourceId, { state: 'idle', configRevision: 2 });
  assert.equal(registry.pendingConfig(resourceId), null);

  assert.throws(() => registry.importClientConfig(resourceId, { type: 'sw' }), /SW Client config, but this is a HW Client/);
  assert.throws(() => registry.importClientConfig(resourceId, { 'hw-devices': { uarts: [{ path: '/tmp/x' }] } }), /hw-devices\.uarts/);

  // An SW Client: nothing of its own to import or export, the rest applies.
  const sw = registry.registerAuto({ clientId: 'c-sw', name: 'sw1', type: 'sw', labels: [], capabilities: { sw: {} }, config: {},
    configFile: { name: 'sw1', type: 'sw', labels: [] } }).resourceId;
  assert.deepEqual(registry.importClientConfig(sw, { type: 'sw', labels: ['x'], sw: { image: 'emu' } }).ignored, ['sw']);
  assert.deepEqual(registry.pendingConfig(sw), { revision: 1, type: 'sw', config: {}, file: { labels: ['x'] } });
  assert.deepEqual(registry.exportClientConfig(sw), { name: 'sw1', type: 'sw', labels: ['x'] });
});

test('HW capabilities: no power control — reported relays/power dropped, and refused on Save', () => {
  const { registry } = buildTestServices(),
    { resourceId } = registry.registerAuto({
      clientId: 'c-hw', name: 'hw1', type: 'hw', labels: [],
      capabilities: { hw: { stlinks: [], uarts: [], usbs: [], relays: [{ channel: 0 }], power: { method: 'uhubctl', hub: '1-1', port: 2 } } }
    });
  assert.deepEqual(registry.get(resourceId).capabilities.hw, { stlinks: [], uarts: [], usbs: [] });
  assert.throws(() => registry.setClientConfig(resourceId, { relays: [{ channel: 0 }] }), /must NOT have additional properties/);
  assert.throws(() => registry.setClientConfig(resourceId, { power: null }), /must NOT have additional properties/);
});

test('Docker availability from registration is kept (and sanitized) for the resource card', () => {
  const { registry } = buildTestServices(),
    reg = (docker) => registry.get(registry.registerAuto({
      clientId: `c-${Math.random()}`, name: `n${Math.random()}`.slice(0, 12), type: 'hw', labels: [],
      capabilities: { hw: {}, ...(docker === undefined ? {} : { docker }) }
    }).resourceId).capabilities.docker;
  assert.deepEqual(reg({ available: true, version: '27.1.1', extra: 'x' }), { available: true, version: '27.1.1' });
  assert.deepEqual(reg({ available: false, reason: 'docker isn\'t installed' }), { available: false, reason: 'docker isn\'t installed' });
  assert.equal(reg(undefined), null); // an older Client
});

test('rename from the dashboard: kept across re-registration, unique, and resettable to the Client\'s own name', () => {
  const { registry } = buildTestServices(),
    reg = (name) => registry.get(registry.registerAuto({ clientId: 'c-ren', name, type: 'sw', labels: [] }).resourceId),
    r = reg('dut1');
  registerResource(registry, { name: 'taken', type: 'sw' });

  assert.equal(registry.rename(r.id, ' bench-7 ').name, 'bench-7');
  assert.equal(reg('dut1').name, 'bench-7'); // the Client restarts, still presenting "dut1"
  assert.equal(registry.get(r.id).reported_name, 'dut1');

  assert.throws(() => registry.rename(r.id, 'taken'), /already used by another Client/);
  assert.throws(() => registry.rename(r.id, 'has space'), /1-64 letters/);

  const reset = registry.rename(r.id, '');
  assert.deepEqual([reset.name, reset.name_override], ['dut1', null]);
  assert.equal(reg('dut2').name, 'dut2'); // no override: the Client's own name again
});

test('USB scan: only while connected; the answer is kept for the pending request only', () => {
  const { bus, registry } = buildTestServices(),
    commands = [],
    offline = registerResource(registry, { name: 'usb-off', type: 'hw' }),
    r = registerResource(registry, { name: 'usb-on', type: 'hw' });
  registry.heartbeat(r.id, { state: 'idle' });
  bus.on('command', (c) => commands.push(c));

  assert.throws(() => registry.requestUsbScan(offline.id), /offline/);
  const { requestId } = registry.requestUsbScan(r.id, { by: 'admin' });
  assert.deepEqual(commands, [{ resourceId: r.id, command: 'scan-usb', requestId }]);

  assert.equal(registry.storeUsbScan(r.id, { requestId: 'stale', output: 'x' }), false);
  assert.equal(registry.get(r.id).usb_scan, null);
  assert.equal(registry.storeUsbScan(r.id, { requestId, output: 'Bus 001 Device 004: ID 0483:3748 ST-LINK/V2', error: null }), true);
  const stored = registry.get(r.id);
  assert.match(stored.usb_scan.output, /ST-LINK/);
  assert.equal(stored.usb_scan_request_id, null); // no longer pending
  assert.equal(registry.storeUsbScan(r.id, { requestId, output: 'again' }), false); // answered once
});

test('a resource can belong to several groups at once', () => {
  const { registry, groups } = buildTestServices(),
    g1 = groups.create({ name: 'g1' }),
    g2 = groups.create({ name: 'g2' }),

    resource = registerResource(registry, { name: 'multi-group', type: 'sw', groups: [g1.id, g2.id] });

  assert.deepEqual(registry.get(resource.id).group_ids, [g1.id, g2.id]);
});

test('deleting a group strips it from every resource that listed it, without touching the resource otherwise', () => {
  const { registry, groups } = buildTestServices(),
    g1 = groups.create({ name: 'to-delete' }),
    g2 = groups.create({ name: 'keep-me' }),
    resource = registerResource(registry, { name: 'lab-01', type: 'sw', labels: ['x'], groups: [g1.id, g2.id] });

  groups.remove(g1.id);

  const after = registry.get(resource.id);
  assert.deepEqual(after.group_ids, [g2.id]);
  assert.deepEqual(after.labels, ['x']); // untouched
  assert.equal(groups.get(g1.id), undefined);
  assert.ok(groups.get(g2.id));
});

test('config import: what each Client can take — a whole file, an older HW Client\'s devices only, or nothing', () => {
  const { registry } = buildTestServices(),
    reg = (clientId, type, clientVersion, extra = {}) =>
      registry.registerAuto({ clientId, name: clientId, type, labels: [], clientVersion, ...extra }).resourceId,
    // Never reported its file (no joinKey: it doesn't re-register), but new enough to apply one.
    fresh = reg('fresh', 'hw', '1.1.1', { config: { uarts: [{ index: 1 }] } }),
    oldHw = reg('old-hw', 'hw', '1.0.20', { config: { uarts: [{ index: 1 }] } }),
    oldSw = reg('old-sw', 'sw', '1.0.20');
  assert.deepEqual([fresh, oldHw, oldSw].map((id) => registry.get(id).config_support), ['file', 'section', null]);

  const file = { type: 'hw', labels: ['board:b'], heartbeatIntervalSec: 20, 'hw-devices': { usbs: [{ index: 2 }] } };
  assert.deepEqual(registry.importClientConfig(fresh, file, { by: 'a' }).ignored, []);
  assert.deepEqual(registry.pendingConfig(fresh).file, { labels: ['board:b'], heartbeatIntervalSec: 20 });

  const { ignored } = registry.importClientConfig(oldHw, file, { by: 'a' }),
    why = '(this Client applies only its devices — update it for the rest)';
  assert.deepEqual(ignored, [`labels ${why}`, `heartbeatIntervalSec ${why}`]);
  assert.deepEqual(registry.pendingConfig(oldHw), { revision: 1, type: 'hw', config: { usbs: [{ index: 2 }] } }); // no `file` for it
  assert.throws(() => registry.importClientConfig(oldSw, { type: 'sw' }, { by: 'a' }), /too old to apply one/);

  // Reported later (POST /resources/:id/config-report): kept without the joinKey.
  registry.reportClientConfig(oldSw, { configFile: { coordinatorUrl: 'https://c', name: 'old-sw', type: 'sw', joinKey: 'secret', labels: [] } });
  assert.equal(registry.get(oldSw).client_config_file.joinKey, undefined);
  assert.equal(registry.get(oldSw).config_support, 'file');
  assert.equal(registry.exportClientConfig(oldSw).joinKey, undefined);
});

test('migration 027 drops joinKey copies from stored config files', () => {
  const Database = require('better-sqlite3'),
    db = new Database(':memory:');
  db.exec('CREATE TABLE resources (id TEXT, client_config_file TEXT)');
  db.prepare('INSERT INTO resources VALUES (?, ?)').run('a', JSON.stringify({ name: 'a', joinKey: 'k', labels: [] }));
  db.prepare('INSERT INTO resources VALUES (?, ?)').run('b', null);
  db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/db/migrations/027_scrub_config_file_secrets.sql'), 'utf8'));
  assert.deepEqual(JSON.parse(db.prepare('SELECT client_config_file FROM resources WHERE id = ?').get('a').client_config_file), { name: 'a', labels: [] });
  assert.equal(db.prepare('SELECT client_config_file FROM resources WHERE id = ?').get('b').client_config_file, null);
});

test('a job runs only on a runner that has every label it asks for', () => {
  const { registry, agents, jobs, scheduler } = buildTestServices(),
    { agent } = agents.create({ name: 'ci', kind: 'ci' }),
    some = registerResource(registry, { name: 'lab-some', type: 'hw', labels: ['board:nucleo', 'uart'] }),
    all = registerResource(registry, { name: 'lab-all', type: 'hw', labels: ['board:nucleo', 'uart', 'stlink', 'extra'] });
  registry.heartbeat(some.id, { state: 'idle' });
  registry.heartbeat(all.id, { state: 'idle' });
  const job = jobs.create({ agentId: agent.id, source: 'ci', spec: makeSpec({ target: { type: 'hw', labels: ['board:nucleo', 'uart', 'stlink'] } }) });
  scheduler.runPass();
  assert.equal(jobs.get(job.id).resource_id, all.id); // lab-some lacks stlink, though it's idle too
});
