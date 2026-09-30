/**
 * @file        packages/coordinator/src/services/cleanup.js
 * @description Database cleanup: wipe finished jobs (logs, events) and old events before a cutoff, then
 *              VACUUM to shrink the file — on demand from the dashboard, and hourly per retention.jobRetention (README §9)
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

const fs = require('node:fs');

// retention.jobRetention values: how long a finished job is kept. `forever`
// means only a manual cleanup (dashboard / POST /admin/jobs/clean-history)
// removes jobs. Months are calendar months.
const JOB_RETENTION = {
    '1w': { days: 7, label: '1 week' },
    '2w': { days: 14, label: '2 weeks' },
    '1m': { months: 1, label: '1 month' },
    '3m': { months: 3, label: '3 months' },
    '6m': { months: 6, label: '6 months' },
    forever: { label: 'indefinitely' }
  },
  PRUNE_INTERVAL_MS = 3600 * 1000,
  FIRST_PRUNE_DELAY_MS = 60 * 1000,
  // VACUUM rewrites the whole file and blocks meanwhile — the automatic
  // task does it at most this often; a manual cleanup always does.
  AUTO_VACUUM_MIN_INTERVAL_MS = 24 * 3600 * 1000;

// `now` minus `amount` ({days} or {months}), in UTC so the server's own
// time zone and its DST changes don't shift the cutoff by an hour.
function subtract(now, { days, months }){
  const d = new Date(now);
  if (months){
    d.setUTCMonth(d.getUTCMonth() - months);
  }
  if (days){
    d.setUTCDate(d.getUTCDate() - days);
  }
  return d;
}

// Cutoff for a retention setting: jobs that finished before it go. null for
// `forever`. Throws on an unknown setting (config.js validates it at load).
function retentionCutoff(setting, now = new Date()){
  const def = JOB_RETENTION[setting];
  if (!def){
    throw new Error(`retention.jobRetention must be one of: ${Object.keys(JOB_RETENTION).join(', ')} (got "${setting}")`);
  }
  return def.days || def.months ? subtract(now, def) : null;
}

function createCleanupService(db, { jobs, config, now = () => new Date() }){
  let lastVacuumAt = 0,
    timer = null,
    firstRun = null;

  // thub.db plus its WAL — what the database takes on disk.
  function databaseBytes(){
    return [config.dbPath, `${config.dbPath}-wal`].reduce((sum, file) => {
      try {
        return sum + fs.statSync(file).size;
      }
      catch {
        return sum;
      }
    }, 0);
  }

  function vacuum(){
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    lastVacuumAt = Date.now();
  }

  // Wipe everything older than `before` (a Date; default now): finished
  // jobs that ended before it, with their logs and events, and
  // the other audit events (resource/agent/group) logged before it. Events
  // of jobs that stay (still active, or newer) are kept. `vacuum`: true,
  // false, or 'auto' (only if something was deleted and the last VACUUM is
  // over a day old). Returns what was done, with the size before/after.
  function cleanup({ before = now(), vacuum: doVacuum = true } = {}){
    const cutoff = before.toISOString(),
      bytesBefore = config.dbPath ? databaseBytes() : 0,
      deletedJobs = jobs.purgeFinishedBefore(cutoff),
      deletedEvents = db.prepare(
        `DELETE FROM events WHERE ts < ?
           AND NOT (entity = 'job' AND entity_id IN (SELECT id FROM jobs))
           AND NOT (entity = 'job' AND entity_id = 'bulk' AND type = 'jobs.cleaned')`
      ).run(cutoff).changes,
      vacuumed = doVacuum === true ||
        (doVacuum === 'auto' && deletedJobs + deletedEvents > 0 && Date.now() - lastVacuumAt >= AUTO_VACUUM_MIN_INTERVAL_MS);
    if (vacuumed){
      vacuum();
    }
    return { before: cutoff, jobs: deletedJobs, events: deletedEvents, vacuumed, bytesBefore, bytesAfter: config.dbPath ? databaseBytes() : 0 };
  }

  // The retention task: hourly (first run a minute after start), wipes jobs
  // older than retention.jobRetention. Does nothing for `forever`.
  function prune(){
    const cutoff = retentionCutoff(config.retention.jobRetention, now());
    if (!cutoff){
      return null;
    }
    const result = cleanup({ before: cutoff, vacuum: 'auto' });
    if (result.jobs || result.events){
      console.log(
        `Retention (${JOB_RETENTION[config.retention.jobRetention].label}): removed ${result.jobs} job(s) and ${result.events} event(s) ` +
          `from before ${result.before}${result.vacuumed ? `; database ${result.bytesBefore} -> ${result.bytesAfter} bytes` : ''}`
      );
    }
    return result;
  }

  function safePrune(){
    try {
      prune();
    }
    catch (err){
      console.error(`Retention cleanup failed: ${err.message}`);
    }
  }

  function start(){
    firstRun = setTimeout(safePrune, FIRST_PRUNE_DELAY_MS);
    firstRun.unref?.();
    timer = setInterval(safePrune, PRUNE_INTERVAL_MS);
    timer.unref?.();
  }

  function stop(){
    clearTimeout(firstRun);
    clearInterval(timer);
  }

  return { cleanup, prune, databaseBytes, start, stop };
}

module.exports = { createCleanupService, retentionCutoff, JOB_RETENTION };
