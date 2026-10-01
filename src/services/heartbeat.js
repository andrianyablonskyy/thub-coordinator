/**
 * @file        packages/coordinator/src/services/heartbeat.js
 * @description Heartbeat sweeper: marks silent resources OUT_OF_SERVICE and requeues their jobs
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

const { RESOURCE_STATES, ACTIVE_JOB_STATES } = require('@andrian.yablonskyy/thub-common');

// §5.1 sweeper: runs every sweepIntervalSec, marks resources OUT_OF_SERVICE
// after missedLimit missed heartbeats and moves any active job to LOST.
function createHeartbeatMonitor(db, { bus, events, registry, jobs, config }){
  // heartbeat.intervalSec can change while running (dashboard Settings,
  // §13.2). Clients learn the new one from their next heartbeat reply, so
  // right after it's *lowered* they're still on the old, longer one: keep
  // judging by that until every Client has had time to switch over.
  let seenInterval = config.heartbeat.intervalSec,
    graceInterval = 0,
    graceUntil = 0;
  function effectiveInterval(now){
    const current = config.heartbeat.intervalSec;
    if (current !== seenInterval){
      if (current < seenInterval){
        graceInterval = seenInterval;
        graceUntil = now + (config.heartbeat.missedLimit + 1) * seenInterval * 1000;
      }
      seenInterval = current;
    }
    return now < graceUntil ? Math.max(current, graceInterval) : current;
  }

  function sweepOnce(now = Date.now()){
    const { missedLimit } = config.heartbeat,
      intervalSec = effectiveInterval(now),
      cutoff = new Date(now - missedLimit * intervalSec * 1000).toISOString(),

      stale = db
        .prepare(
          `SELECT * FROM resources
         WHERE status NOT IN (?, ?)
           AND last_heartbeat_at IS NOT NULL
           AND last_heartbeat_at <= ?`
        )
        .all(RESOURCE_STATES.OUT_OF_SERVICE, RESOURCE_STATES.MAINTENANCE, cutoff);

    for (const resource of stale){
      registry.markOutOfService(resource.id);

      const activeJob = db
        .prepare(
          `SELECT id, state FROM jobs WHERE resource_id = ? AND state IN (${[...ACTIVE_JOB_STATES]
            .map(() => '?')
            .join(',')})`
        )
        .get(resource.id, ...ACTIVE_JOB_STATES);
      if (activeJob){
        jobs.markLost(activeJob.id);
      }
    }
  }

  // Resources an admin removed while they ran a job (jobs.removeResource):
  // normally deleted by the heartbeat route once the Client reports the job
  // stopped; this covers a Client that's gone (OUT_OF_SERVICE) or never
  // confirms — after the time a cancel plus the runner's kill grace needs.
  function sweepRemovals(){
    const timeoutMs = Math.max(60, 6 * config.heartbeat.intervalSec) * 1000;
    for (const r of registry.pendingRemovals()){
      if (r.status === RESOURCE_STATES.OUT_OF_SERVICE || Date.now() - new Date(r.remove_requested_at).getTime() >= timeoutMs){
        try {
          jobs.completeRemoval(r.id, { by: 'removal-timeout' });
        }
        catch (err){
          console.error(`removing ${r.name}: ${err.message}`);
        }
      }
    }
  }

  const timer = setInterval(() => {
    sweepOnce();
    sweepRemovals();
  }, config.heartbeat.sweepIntervalSec * 1000);
  timer.unref?.();

  return { sweepOnce, sweepRemovals, stop: () => clearInterval(timer) };
}

module.exports = { createHeartbeatMonitor };
