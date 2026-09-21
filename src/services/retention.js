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
