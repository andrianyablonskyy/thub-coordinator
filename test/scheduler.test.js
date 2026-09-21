'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDb } = require('../src/db');
const { bus } = require('../src/services/bus');
const { createEventsService } = require('../src/services/events');
const { createRegistryService } = require('../src/services/registry');
const { createAgentsService } = require('../src/services/agents');
const { createJobsService } = require('../src/services/jobs');
const { createScheduler } = require('../src/services/scheduler');
const { createHeartbeatMonitor } = require('../src/services/heartbeat');
const { JOB_STATES, RESOURCE_STATES } = require('@thub/shared');

function buildTestServices(overrides = {}) {
  const db = openDb(':memory:');
  const events = createEventsService(db);
  const registry = createRegistryService(db, { bus, events });
  const agents = createAgentsService(db, { events });
  const config = {
    scheduler: { assignAckTimeoutSec: 15, requeueOnLost: true, maxQueuedPerAgent: 20, tickIntervalSec: 3600 },
    jobs: { defaultTimeoutSec: 1800, maxTimeoutSec: 14400 },
    heartbeat: { intervalSec: 10, missedLimit: 3, sweepIntervalSec: 3600 },
    ...overrides,
  };
  const jobs = createJobsService(db, { bus, events, registry, config });
  const scheduler = createScheduler(db, { bus, events, registry, config });
  const heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config });
  return { db, registry, agents, jobs, scheduler, heartbeatMonitor };
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
