/**
 * @file        packages/coordinator/test/cleanup.test.js
 * @description Tests: database cleanup before a cutoff, job retention settings, and the retention task
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
  { createArtifactsService } = require('../src/services/artifacts'),
  { createJobsService } = require('../src/services/jobs'),
  { createCleanupService, retentionCutoff } = require('../src/services/cleanup'),
  { JOB_STATES } = require('@andrian.yablonskyy/thub-common');

const NOW = new Date('2026-09-28T12:00:00Z');

function setup(jobRetention = 'forever'){
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-cleanup-')),
    config = {
      dataDir,
      dbPath: path.join(dataDir, 'thub.db'),
      artifactsDir: path.join(dataDir, 'artifacts'),
      artifacts: { linkTtlHours: 1 },
      sessionSecret: 's',
      publicUrl: 'http://x',
      scheduler: { maxQueuedPerAgent: 1000 },
      jobs: { defaultTimeoutSec: 60, maxTimeoutSec: 60 },
      retention: { jobRetention }
    },
    db = openDb(config.dbPath),
    bus = new EventEmitter(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    { agent } = createAgentsService(db, { events }).create({ name: 'ci', kind: 'ci' }),
    artifacts = createArtifactsService(db, { config }),
    jobs = createJobsService(db, { bus, events, registry, artifacts, config }),
    cleanup = createCleanupService(db, { jobs, config, now: () => NOW });
  registry.registerAuto({ clientId: 'c', name: 'lab', type: 'sw', labels: [] });

  // A job that finished at `finishedAt` (or is still queued, if null), with a log line.
  function job(finishedAt){
    const spec = { target: { type: 'sw' }, command: './run.sh' },
      j = jobs.create({ agentId: agent.id, source: 'cli', spec });
    db.prepare('INSERT INTO job_logs (job_id, seq, ts, stream, line) VALUES (?, 1, ?, \'runner\', ?)').run(j.id, NOW.toISOString(), 'x'.repeat(2000));
    if (finishedAt){
      jobs.setState(j.id, JOB_STATES.PASSED);
      db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(finishedAt, j.id);
    }
    return j.id;
  }
  const exists = (id) => !!jobs.get(id),
    eventAt = (entity, ts) => db.prepare('INSERT INTO events (ts, entity, entity_id, type) VALUES (?, ?, \'x\', \'t\')').run(ts, entity).lastInsertRowid;
  return { db, jobs, cleanup, job, exists, eventAt };
}

test('retentionCutoff: days, calendar months, and forever', () => {
  assert.equal(retentionCutoff('1w', NOW).toISOString(), '2026-09-21T12:00:00.000Z');
  assert.equal(retentionCutoff('2w', NOW).toISOString(), '2026-09-14T12:00:00.000Z');
  assert.equal(retentionCutoff('1m', NOW).toISOString(), '2026-08-28T12:00:00.000Z');
  assert.equal(retentionCutoff('6m', NOW).toISOString(), '2026-03-28T12:00:00.000Z');
  assert.equal(retentionCutoff('forever', NOW), null);
  assert.throws(() => retentionCutoff('1y', NOW), /must be one of/);
});

test('cleanup wipes finished jobs and history before the cutoff, keeps the rest, and compacts the file', () => {
  const { db, cleanup, job, exists, eventAt } = setup(),
    old = Array.from({ length: 40 }, () => job('2026-01-10T00:00:00Z')),
    recent = job('2026-09-27T00:00:00Z'),
    active = job(null),
    oldResourceEvent = eventAt('resource', '2026-01-01T00:00:00Z'),
    newResourceEvent = eventAt('resource', '2026-09-27T00:00:00Z'),

    r = cleanup.cleanup({ before: new Date('2026-06-01T00:00:00Z') });
  assert.equal(r.jobs, 40);
  assert.ok(old.every((id) => !exists(id)));
  assert.ok(exists(recent) && exists(active));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_logs').get().n, 2); // recent + active only
  const eventIds = db.prepare('SELECT id FROM events').all().map((e) => e.id);
  assert.ok(!eventIds.includes(oldResourceEvent) && eventIds.includes(newResourceEvent));
  assert.equal(r.vacuumed, true);
  assert.ok(r.bytesAfter < r.bytesBefore, `${r.bytesAfter} < ${r.bytesBefore}`);
});

test('an old but still active job is never wiped, nor its events', () => {
  const { db, cleanup, job, exists } = setup(),
    active = job(null);
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', active);
  db.prepare('UPDATE events SET ts = ? WHERE entity_id = ?').run('2020-01-01T00:00:00Z', active);
  cleanup.cleanup({ before: NOW });
  assert.ok(exists(active));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM events WHERE entity_id = ?').get(active).n > 0);
});

test('the retention task wipes per jobRetention, and does nothing for forever', () => {
  const kept = setup('forever'),
    id = kept.job('2025-01-01T00:00:00Z');
  assert.equal(kept.cleanup.prune(), null);
  assert.ok(kept.exists(id));

  const pruned = setup('1m'),
    tooOld = pruned.job('2026-08-01T00:00:00Z'),
    young = pruned.job('2026-09-01T00:00:00Z'),
    r = pruned.cleanup.prune();
  assert.equal(r.before, '2026-08-28T12:00:00.000Z');
  assert.ok(!pruned.exists(tooOld) && pruned.exists(young));
  assert.equal(r.vacuumed, true); // first automatic run: compacts
  pruned.job('2026-08-02T00:00:00Z');
  assert.equal(pruned.cleanup.prune().vacuumed, false); // at most once a day
});
