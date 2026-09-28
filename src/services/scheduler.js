/**
 * @file        packages/coordinator/src/services/scheduler.js
 * @description Scheduler: matches queued jobs to idle resources by type/labels/group/client (README §5.4)
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

const { JOB_STATES, BUSY_SOURCES } = require('@andrian.yablonskyy/thub-common');

function rowToJob(row){
  return { ...row, spec: JSON.parse(row.spec) };
}

// §5.4: a single SQLite write transaction picks the oldest highest-priority
// queued job for each idle, label-matching resource. Running it inside
// BEGIN IMMEDIATE plus better-sqlite3's synchronous execution is what makes
// double-assignment impossible.
function createScheduler(db, { bus, events, registry, config }){
  let scheduled = false;

  function runPass(){
    const tx = db.transaction(() => {
        const queued = db
            .prepare('SELECT * FROM jobs WHERE state = \'QUEUED\' ORDER BY priority DESC, created_at ASC')
            .all()
            .map(rowToJob),

          assignments = [],
          claimedResourceIds = new Set(),
          // Resources that some queued job is pinned to (`target.client`) —
          // an unpinned job only takes one of these when nothing else fits,
          // so it doesn't jump the pinned job's per-client queue.
          reservedResourceIds = new Set(queued.map((j) => j.spec.target.client).filter(Boolean));

        for (const job of queued){
          const { type, labels = [], group, client } = job.spec.target,
            candidates = registry
              .findIdleCandidates(type, labels, group, client, { jobImage: Boolean(job.spec.firmware?.image) })
              .filter((r) => !claimedResourceIds.has(r.id));
          if (candidates.length === 0){
            continue;
          }

          // Unreserved first, then least-recently-used: spread wear across benches (§5.4).
          candidates.sort((a, b) => {
            const ra = reservedResourceIds.has(a.id) ? 1 : 0,
              rb = reservedResourceIds.has(b.id) ? 1 : 0,
              ta = a.last_job_finished_at ? new Date(a.last_job_finished_at).getTime() : 0,
              tb = b.last_job_finished_at ? new Date(b.last_job_finished_at).getTime() : 0;
            return ra - rb || ta - tb;
          });
          const resource = candidates[0];
          claimedResourceIds.add(resource.id);

          const busySource = job.source === 'ci' ? BUSY_SOURCES.CI : BUSY_SOURCES.CLI,
            now = new Date().toISOString();

          db.prepare('UPDATE jobs SET state = ?, resource_id = ?, assigned_at = ? WHERE id = ?').run(
            JOB_STATES.ASSIGNED,
            resource.id,
            now,
            job.id
          );
          registry.assignToJob(resource.id, busySource);
          events.record('job', job.id, 'job.state', { from: JOB_STATES.QUEUED, to: JOB_STATES.ASSIGNED, resourceId: resource.id });

          assignments.push({ jobId: job.id, resourceId: resource.id });
        }

        return assignments;
      }),

      assignments = tx();
    for (const { jobId, resourceId }of assignments){
      bus.emit('job.assigned', { jobId, resourceId });
    }
    return assignments;
  }

  function scheduleSoon(){
    if (scheduled){
      return;
    }
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      runPass();
    });
  }

  bus.on('job.queued', scheduleSoon);
  bus.on('resource.idle', scheduleSoon);

  const tickInterval = setInterval(runPass, (config.scheduler.tickIntervalSec || 10) * 1000);
  tickInterval.unref?.();

  return { runPass, stop: () => clearInterval(tickInterval) };
}

module.exports = { createScheduler };
