/**
 * @file        packages/coordinator/src/api/sse.js
 * @description Server-Sent Events helper: streams a job's log/state/end events, resumable by seq (README §6.4)
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

const { TERMINAL_JOB_STATES } = require('@andrian.yablonskyy/thub-common');

// §6.4: log / state / end events, resumable via Last-Event-ID (§7: "the
// Agent reconnects with exponential backoff and resumes from the last seq").
function attachJobStream(req, res, { jobId, services, config }){
  const { jobs, logs, registry, bus } = services,

    job = jobs.get(jobId);
  if (!job){
    res.status(404).json({ error: 'Unknown job' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const lastEventId = req.get('Last-Event-ID'),
    afterSeq = Number(lastEventId ?? req.query.after ?? 0) || 0;

  function writeEvent(event, data, id){
    if (id !== undefined){
      res.write(`id: ${id}\n`);
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  for (const line of logs.listSince(jobId, afterSeq)){
    writeEvent('log', { ts: line.ts, stream: line.stream, line: line.line }, line.seq);
  }

  function artifactsUrl(){
    return `${config.publicUrl}/jobs/${jobId}#artifacts`;
  }

  const current = jobs.get(jobId);
  if (TERMINAL_JOB_STATES.has(current.state)){
    writeEvent('end', { state: current.state, artifactsUrl: artifactsUrl() });
    return res.end();
  }

  const resourceName = (id) => (id ? registry.get(id)?.name : undefined);
  writeEvent('state', { state: current.state, resource: resourceName(current.resource_id) });

  const onLog = (entry) => {
      if (entry.jobId === jobId){
        writeEvent('log', { ts: entry.ts, stream: entry.stream, line: entry.line }, entry.seq);
      }
    },
    onState = (evt) => {
      if (evt.jobId === jobId){
        writeEvent('state', { state: evt.state, resource: resourceName(evt.resourceId) });
      }
    },
    onFinished = (evt) => {
      if (evt.jobId !== jobId){
        return;
      }
      writeEvent('end', { state: evt.state, artifactsUrl: artifactsUrl() });
      cleanup();
      res.end();
    };

  function cleanup(){
    bus.off('job.log', onLog);
    bus.off('job.state', onState);
    bus.off('job.finished', onFinished);
  }

  bus.on('job.log', onLog);
  bus.on('job.state', onState);
  bus.on('job.finished', onFinished);
  req.on('close', cleanup);
}

module.exports = { attachJobStream };
