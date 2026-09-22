/**
 * @file        packages/coordinator/src/services/jobs.js
 * @description Job lifecycle service: creation, state transitions, and validation against the job spec
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

const { validateJobSpec, JOB_STATES, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES } = require('@andrian.yablonskyy/test-hub');

function rowToJob(row){
  if (!row){
    return row;
  }
  return {
    ...row,
    spec: JSON.parse(row.spec),
    summary: row.summary ? JSON.parse(row.summary) : null
  };
}

// A-00001.. for CI/CD jobs, M-00001.. for manual `thub run` jobs from a
// developer's own machine — separate series (each own counter row) rather
// than a shared counter with just a different letter, so e.g. A-00042
// doesn't imply 41 manual runs happened first.
const JOB_ID_PREFIXES = { ci: 'A', cli: 'M' };

function nextJobId(db, source){
  const prefix = JOB_ID_PREFIXES[source];
  if (!prefix){
    throw new Error(`Unknown job source "${source}"`);
  }
  const counterName = `job_id_${prefix.toLowerCase()}`,
    run = db.transaction(() => {
      db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counterName);
      const { value } = db.prepare('SELECT value FROM counters WHERE name = ?').get(counterName);
      return value;
    }),
    n = run();
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

function createJobsService(db, { bus, events, registry, artifacts, config }){
  function get(id){
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  function list({ state, source, agentId, resourceId, mine, limit = 50 } = {}){
    let sql = 'SELECT * FROM jobs WHERE 1=1';
    const params = [];
    if (state){
      sql += ' AND state = ?';
      params.push(state);
    }
    if (source){
      sql += ' AND source = ?';
      params.push(source);
    }
    if (agentId && mine){
      sql += ' AND agent_id = ?';
      params.push(agentId);
    }
    if (resourceId){
      sql += ' AND resource_id = ?';
      params.push(resourceId);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params).map(rowToJob);
  }

  function countQueuedForAgent(agentId){
    return db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE agent_id = ? AND state IN (\'QUEUED\',\'ASSIGNED\')')
      .get(agentId).n;
  }

  // Agent: POST /jobs (§6.1, §4.3). Rejects unsatisfiable label requests
  // immediately (§5.4) instead of letting them starve in the queue.
  function create({ agentId, source, spec: rawSpec }){
    const { valid, spec, errors } = validateJobSpec(rawSpec);
    if (!valid){
      throw Object.assign(new Error(`Invalid job spec: ${errors.join('; ')}`), { status: 400 });
    }
    spec.source = source;

    if (!registry.everSatisfiable(spec.target.type, spec.target.labels, spec.target.group)){
      throw Object.assign(
        new Error(
          `No registered resource can ever satisfy type=${spec.target.type} labels=${spec.target.labels.join(',')}` +
            (spec.target.group ? ` group=${spec.target.group}` : '')
        ),
        { status: 422 }
      );
    }

    if (countQueuedForAgent(agentId) >= config.scheduler.maxQueuedPerAgent){
      throw Object.assign(new Error('Too many queued jobs for this agent'), { status: 429 });
    }

    const timeoutSec = Math.min(
        spec.timeoutSec || config.jobs.defaultTimeoutSec,
        config.jobs.maxTimeoutSec
      ),
      id = nextJobId(db, source),
      now = new Date().toISOString();

    db.prepare(
      `INSERT INTO jobs (id, agent_id, source, state, spec, priority, attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, agentId, source, JOB_STATES.QUEUED, JSON.stringify({ ...spec, timeoutSec }), spec.priority, now);

    events.record('job', id, 'job.created', { source, target: spec.target });
    bus.emit('job.queued', { jobId: id });
    return get(id);
  }

  function setState(id, state, extra = {}){
    const job = get(id);
    if (!job){
      throw Object.assign(new Error('Unknown job'), { status: 404 });
    }

    const fields = ['state = ?'],
      params = [state],
      now = new Date().toISOString();

    if (state === JOB_STATES.ASSIGNED){
      fields.push('resource_id = ?', 'assigned_at = ?');
      params.push(extra.resourceId, now);
    }
    if (state === JOB_STATES.RUNNING && !job.started_at){
      fields.push('started_at = ?');
      params.push(now);
    }
    if (TERMINAL_JOB_STATES.has(state)){
      fields.push('finished_at = ?');
      params.push(now);
    }
    if (extra.message !== undefined){
      fields.push('message = ?');
      params.push(extra.message);
    }
    if (extra.exitCode !== undefined){
      fields.push('exit_code = ?');
      params.push(extra.exitCode);
    }
    if (extra.summary !== undefined){
      fields.push('summary = ?');
      params.push(JSON.stringify(extra.summary));
    }
    if (state === JOB_STATES.QUEUED){
      // Requeue: drop the previous assignment so the scheduler treats it fresh.
      fields.push('resource_id = ?', 'assigned_at = ?', 'attempt = attempt + 1');
      params.push(null, null);
    }

    params.push(id);
    db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    events.record('job', id, 'job.state', { from: job.state, to: state, ...extra });
    bus.emit('job.state', { jobId: id, state, resourceId: job.resource_id, ...extra });

    if (state === JOB_STATES.QUEUED){
      bus.emit('job.queued', { jobId: id });
    }
    if (TERMINAL_JOB_STATES.has(state)){
      bus.emit('job.finished', { jobId: id, state });
      // LOST means the resource is presumed OUT_OF_SERVICE (that's why the
      // job went LOST) — it only comes back via a real heartbeat (§4.1),
      // not by virtue of its job ending.
      if (job.resource_id && state !== JOB_STATES.LOST){
        registry.markIdleAfterJob(job.resource_id);
      }
    }
    return get(id);
  }

  // Agent: POST /jobs/:id/cancel
  function cancel(id, { agentId, isAdmin }){
    const job = get(id);
    if (!job){
      throw Object.assign(new Error('Unknown job'), { status: 404 });
    }
    if (!isAdmin && job.agent_id !== agentId){
      throw Object.assign(new Error('Not your job'), { status: 403 });
    }
    if (!ACTIVE_JOB_STATES.has(job.state)){
      return job;
    }

    if (job.resource_id){
      bus.emit('command', { resourceId: job.resource_id, command: 'cancel-job', jobId: id });
    }
    return setState(id, JOB_STATES.CANCELED);
  }

  // Resource: POST /jobs/:id/result — final verdict from the test runner.
  function applyResult(id, resourceId, { state, exitCode, summary }){
    const job = get(id);
    if (!job || job.resource_id !== resourceId){
      throw Object.assign(new Error('Job not assigned to this resource'), { status: 403 });
    }
    if (![JOB_STATES.PASSED, JOB_STATES.FAILED, JOB_STATES.ERROR].includes(state)){
      throw Object.assign(new Error('Invalid result state'), { status: 400 });
    }
    return setState(id, state, { exitCode, summary });
  }

  // Called by the sweeper for ASSIGNED jobs whose accept deadline passed,
  // and by the timeout checker for PREPARING/RUNNING jobs.
  function requeueUnacked(id){
    return setState(id, JOB_STATES.QUEUED);
  }

  function markLost(id){
    const job = get(id);
    if (job.state === JOB_STATES.LOST || TERMINAL_JOB_STATES.has(job.state)){
      return job;
    }
    const spec = job.spec;
    setState(id, JOB_STATES.LOST);
    if (config.scheduler.requeueOnLost && job.attempt < 2){
      return setState(id, JOB_STATES.QUEUED);
    }
    return get(id);
  }

  function checkTimeouts(){
    const now = Date.now(),
      active = db
        .prepare(
          'SELECT * FROM jobs WHERE state IN (\'PREPARING\',\'RUNNING\') AND started_at IS NOT NULL'
        )
        .all()
        .map(rowToJob);
    for (const job of active){
      const timeoutSec = job.spec.timeoutSec || config.jobs.defaultTimeoutSec,
        startedAt = new Date(job.started_at).getTime();
      if (now - startedAt > timeoutSec * 1000){
        if (job.resource_id){
          bus.emit('command', { resourceId: job.resource_id, command: 'cancel-job', jobId: job.id });
        }
        setState(job.id, JOB_STATES.TIMEOUT);
      }
    }

    // QUEUED jobs also expire against their own timeout so they don't wait forever (§5.4).
    const queued = db.prepare('SELECT * FROM jobs WHERE state = \'QUEUED\'').all().map(rowToJob);
    for (const job of queued){
      const timeoutSec = job.spec.timeoutSec || config.jobs.defaultTimeoutSec,
        createdAt = new Date(job.created_at).getTime();
      if (now - createdAt > timeoutSec * 1000){
        setState(job.id, JOB_STATES.TIMEOUT);
      }
    }
  }

  function checkAssignAcks(){
    const cutoff = new Date(Date.now() - config.scheduler.assignAckTimeoutSec * 1000).toISOString(),
      stale = db
        .prepare('SELECT * FROM jobs WHERE state = \'ASSIGNED\' AND assigned_at <= ?')
        .all(cutoff)
        .map(rowToJob);
    for (const job of stale){
      requeueUnacked(job.id);
    }
  }

  // Coordinator restart reconciliation (§15): ASSIGNED -> QUEUED immediately;
  // PREPARING/RUNNING keep their state and wait for the Client's next heartbeat.
  function reconcileOnStartup(){
    const stuck = db.prepare('SELECT id FROM jobs WHERE state = \'ASSIGNED\'').all();
    for (const { id }of stuck){
      requeueUnacked(id);
    }
  }

  // Admin: "reset the queue" — cancel every job that's currently queued,
  // assigned or running. Each cancel() already notifies the resource
  // holding a job (if any) via the usual cancel-job command.
  function resetQueue(){
    const placeholders = [...ACTIVE_JOB_STATES].map(() => '?').join(','),
      active = db.prepare(`SELECT id FROM jobs WHERE state IN (${placeholders})`).all(...ACTIVE_JOB_STATES);
    for (const { id }of active){
      cancel(id, { isAdmin: true });
    }
    return active.length;
  }

  // Admin: "clean the queue" — permanently delete finished jobs (and their
  // logs/artifacts, on disk and in the DB), for when the history itself,
  // not just active work, needs clearing out. Unlike the nightly retention
  // sweep (§9), this runs on demand and isn't limited to old jobs.
  function cleanHistory(){
    const placeholders = [...TERMINAL_JOB_STATES].map(() => '?').join(','),
      rows = db.prepare(`SELECT id FROM jobs WHERE state IN (${placeholders})`).all(...TERMINAL_JOB_STATES),
      ids = rows.map((r) => r.id);
    if (ids.length === 0){
      return 0;
    }

    const tx = db.transaction(() => {
      for (const id of ids){
        artifacts.deleteJobArtifacts(id);
        db.prepare('DELETE FROM artifacts WHERE job_id = ?').run(id);
        db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(id);
        db.prepare('DELETE FROM events WHERE entity = \'job\' AND entity_id = ?').run(id);
        db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      }
    });
    tx();
    events.record('job', 'bulk', 'jobs.cleaned', { count: ids.length });
    return ids.length;
  }

  // A Client re-registering (fresh process, §5.1) is a definitive signal
  // that whatever the previous process was doing is abandoned — mark any
  // job still pointing at that resource LOST instead of leaving it
  // orphaned until the heartbeat sweeper eventually notices.
  bus.on('resource.reregistered', ({ resourceId }) => {
    const placeholders = [...ACTIVE_JOB_STATES].map(() => '?').join(','),
      stale = db
        .prepare(`SELECT id FROM jobs WHERE resource_id = ? AND state IN (${placeholders})`)
        .all(resourceId, ...ACTIVE_JOB_STATES);
    for (const { id }of stale){
      markLost(id);
    }
  });

  return {
    get,
    list,
    create,
    setState,
    cancel,
    applyResult,
    requeueUnacked,
    markLost,
    checkTimeouts,
    checkAssignAcks,
    reconcileOnStartup,
    resetQueue,
    cleanHistory
  };
}

module.exports = { createJobsService };
