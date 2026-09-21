'use strict';

// §3.1 Log service: accepts batched log lines, assigns a monotonically
// increasing seq per job, stores them, and fans them out over the bus for
// SSE subscribers (§6.4). Retention is handled separately (§9).
function createLogsService(db, { bus }) {
  const insert = db.prepare(
    'INSERT INTO job_logs (job_id, seq, ts, stream, line) VALUES (?, ?, ?, ?, ?)'
  );
  const nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM job_logs WHERE job_id = ?');

  function appendBatch(jobId, lines) {
    const tx = db.transaction((batch) => {
      let seq = nextSeqStmt.get(jobId).maxSeq;
      const inserted = [];
      for (const line of batch) {
        seq += 1;
        const ts = line.ts || new Date().toISOString();
        insert.run(jobId, seq, ts, line.stream || 'runner', line.line);
        inserted.push({ jobId, seq, ts, stream: line.stream || 'runner', line: line.line });
      }
      return inserted;
    });
    const inserted = tx(lines);
    for (const entry of inserted) bus.emit('job.log', entry);
    return inserted;
  }

  function listSince(jobId, afterSeq = 0, limit = 500) {
    return db
      .prepare('SELECT * FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(jobId, afterSeq, limit);
  }

  // Used when a job finishes: fold job_logs into a flat console.log artifact.
  function renderConsoleLog(jobId) {
    const rows = db
      .prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY seq ASC')
      .all(jobId);
    return rows.map((r) => `[${r.ts}] [${r.stream}] ${r.line}`).join('\n') + (rows.length ? '\n' : '');
  }

  function purgeOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    db.prepare(
      `DELETE FROM job_logs WHERE job_id IN (
         SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at <= ?
       )`
    ).run(cutoff);
  }

  return { appendBatch, listSince, renderConsoleLog, purgeOlderThan };
}

module.exports = { createLogsService };
