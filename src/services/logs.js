/**
 * @file        packages/coordinator/src/services/logs.js
 * @description Job log service: stores batched log lines with a per-job sequence and fans them out (README §3.1)
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

// §3.1 Log service: accepts batched log lines, assigns a monotonically
// increasing seq per job, stores them, and fans them out over the bus for
// SSE subscribers (§6.4). Lines are deleted with their job (§9).
function createLogsService(db, { bus }){
  const insert = db.prepare(
      'INSERT INTO job_logs (job_id, seq, ts, stream, line) VALUES (?, ?, ?, ?, ?)'
    ),
    nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM job_logs WHERE job_id = ?');

  function appendBatch(jobId, lines){
    const tx = db.transaction((batch) => {
        let seq = nextSeqStmt.get(jobId).maxSeq;
        const inserted = [];
        for (const line of batch){
          seq += 1;
          const ts = line.ts || new Date().toISOString();
          insert.run(jobId, seq, ts, line.stream || 'runner', line.line);
          inserted.push({ jobId, seq, ts, stream: line.stream || 'runner', line: line.line });
        }
        return inserted;
      }),
      inserted = tx(lines);
    for (const entry of inserted){
      bus.emit('job.log', entry);
    }
    return inserted;
  }

  function listSince(jobId, afterSeq = 0, limit = 500){
    return db
      .prepare('SELECT * FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(jobId, afterSeq, limit);
  }

  // The dashboard log viewer's pages (views/mixins/log-viewer.pug): the
  // `limit` lines just before `beforeSeq` (the end of the log when omitted),
  // oldest first, and whether there are earlier ones to scroll up to.
  function pageBefore(jobId, beforeSeq, limit){
    const rows = db
        .prepare('SELECT seq, ts, stream, line FROM job_logs WHERE job_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(jobId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1),
      hasMore = rows.length > limit;
    return { lines: rows.slice(0, limit).reverse(), hasMore };
  }

  function count(jobId){
    return db.prepare('SELECT COUNT(*) AS n FROM job_logs WHERE job_id = ?').get(jobId).n;
  }

  return { appendBatch, listSince, pageBefore, count };
}

module.exports = { createLogsService };
