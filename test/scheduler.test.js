'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../src/db');
const { bus } = require('../src/services/bus');
const { createEventsService } = require('../src/services/events');
const { createRegistryService } = require('../src/services/registry');
const { createAgentsService } = require('../src/services/agents');
const { createArtifactsService } = require('../src/services/artifacts');
const { createJobsService } = require('../src/services/jobs');
const { createScheduler } = require('../src/services/scheduler');
const { createHeartbeatMonitor } = require('../src/services/heartbeat');
const { JOB_STATES, RESOURCE_STATES } = require('@thub/shared');

function buildTestServices(overrides = {}) {
  const db = openDb(':memory:');
  const events = createEventsService(db);
  const registry = createRegistryService(db, { bus, events });
  const agents = createAgentsService(db, { events });
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
  return { db, registry, agents, artifacts, jobs, scheduler, heartbeatMonitor, artifactsDir };
}

function registerResource(registry, { name, type, labels = [] }) {
  const { resourceId } = registry.registerAuto({ name, type, labels });
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
  const { resourceId } = registry.registerAuto({ name: 'lab-hw-01', type: 'sw', labels: ['board:b'] });
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

  registry.registerAuto({ name: 'lab-sw-02', type: 'sw', labels: [] });

  assert.equal(registry.get(resource.id).status, RESOURCE_STATES.MAINTENANCE);
});
