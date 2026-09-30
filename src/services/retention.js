/**
 * @file        packages/coordinator/src/services/retention.js
 * @description Nightly consistent database backup (VACUUM INTO, README §9)
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

// §9: a nightly consistent backup via VACUUM INTO. (A job's log lines live
// as long as the job itself — retention.jobRetention / Clean up database,
// services/cleanup.js — and there are no artifacts to purge any more.)
function createRetentionService(db, { config }){
  function runDaily(){
    const backupPath = path.join(config.dataDir, `backup-${new Date().toISOString().slice(0, 10)}.db`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, '\'\'')}'`);
  }

  const timer = setInterval(runDaily, DAY_MS);
  timer.unref?.();

  return { runDaily, stop: () => clearInterval(timer) };
}

module.exports = { createRetentionService };
