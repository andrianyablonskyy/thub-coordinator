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

const { RESOURCE_STATES, ACTIVE_JOB_STATES } = require('@andrian.yablonskyy/test-hub');

// §5.1 sweeper: runs every sweepIntervalSec, marks resources OUT_OF_SERVICE
// after missedLimit missed heartbeats and moves any active job to LOST.
function createHeartbeatMonitor(db, { bus, events, registry, jobs, config }){
  function sweepOnce(){
    const { intervalSec, missedLimit } = config.heartbeat,
      cutoff = new Date(Date.now() - missedLimit * intervalSec * 1000).toISOString(),

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

  const timer = setInterval(sweepOnce, config.heartbeat.sweepIntervalSec * 1000);
  timer.unref?.();

  return { sweepOnce, stop: () => clearInterval(timer) };
}

module.exports = { createHeartbeatMonitor };
