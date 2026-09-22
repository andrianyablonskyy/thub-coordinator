/**
 * @file        packages/coordinator/src/services/retention.js
 * @description Deletes finished jobs' logs/artifacts past their retention window (README §9)
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

const path = require('node:path');

const DAY_MS = 86400 * 1000;

// §9: fold job_logs into a console.log artifact when a job finishes, purge
// old logs/artifacts on the configured retention windows, and take a nightly
// consistent backup via VACUUM INTO.
function createRetentionService(db, { bus, logs, artifacts, config }) {
  bus.on('job.finished', ({ jobId }) => {
    const text = logs.renderConsoleLog(jobId);
    if (text) artifacts.storeGenerated(jobId, 'console.log', Buffer.from(text, 'utf8'), 'text/plain');
  });

  function runDaily() {
    logs.purgeOlderThan(config.retention.logRetentionDays);
    artifacts.purgeOlderThan(config.retention.artifactRetentionDays);
    const backupPath = path.join(config.dataDir, `backup-${new Date().toISOString().slice(0, 10)}.db`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }

  const timer = setInterval(runDaily, DAY_MS);
  timer.unref?.();

  return { runDaily, stop: () => clearInterval(timer) };
}

module.exports = { createRetentionService };
