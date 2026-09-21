'use strict';

const { validateJobSpec, JOB_STATES, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES } = require('@thub/shared');

function rowToJob(row) {
  if (!row) return row;
  return {
    ...row,
    spec: JSON.parse(row.spec),
    summary: row.summary ? JSON.parse(row.summary) : null,
  };
}

function nextJobId(db) {
  const run = db.transaction(() => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'job_id'").run();
    const { value } = db.prepare("SELECT value FROM counters WHERE name = 'job_id'").get();
    return value;
  });
  const n = run();
  return `J-${String(n).padStart(6, '0')}`;
}

function createJobsService(db, { bus, events, registry, config }) {
  function get(id) {
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  function list({ state, source, agentId, resourceId, mine, limit = 50 } = {}) {
    let sql = 'SELECT * FROM jobs WHERE 1=1';
    const params = [];
    if (state) {
      sql += ' AND state = ?';
      params.push(state);
    }
    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }
    if (agentId && mine) {
      sql += ' AND agent_id = ?';
      params.push(agentId);
    }
    if (resourceId) {
      sql += ' AND resource_id = ?';
      params.push(resourceId);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params).map(rowToJob);
  }

  function countQueuedForAgent(agentId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent_id = ? AND state IN ('QUEUED','ASSIGNED')")
      .get(agentId).n;
  }

  // Agent: POST /jobs (§6.1, §4.3). Rejects unsatisfiable label requests
  // immediately (§5.4) instead of letting them starve in the queue.
  function create({ agentId, source, spec: rawSpec }) {
    const { valid, spec, errors } = validateJobSpec(rawSpec);
    if (!valid) {
      throw Object.assign(new Error(`Invalid job spec: ${errors.join('; ')}`), { status: 400 });
    }
    spec.source = source;

    if (!registry.everSatisfiable(spec.target.type, spec.target.labels)) {
      throw Object.assign(
        new Error(
          `No registered resource can ever satisfy type=${spec.target.type} labels=${spec.target.labels.join(',')}`
        ),
        { status: 422 }
      );
    }

    if (countQueuedForAgent(agentId) >= config.scheduler.maxQueuedPerAgent) {
      throw Object.assign(new Error('Too many queued jobs for this agent'), { status: 429 });
    }

    const timeoutSec = Math.min(
      spec.timeoutSec || config.jobs.defaultTimeoutSec,
      config.jobs.maxTimeoutSec
    );
    const id = nextJobId(db);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO jobs (id, agent_id, source, state, spec, priority, attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, agentId, source, JOB_STATES.QUEUED, JSON.stringify({ ...spec, timeoutSec }), spec.priority, now);

    events.record('job', id, 'job.created', { source, target: spec.target });
    bus.emit('job.queued', { jobId: id });
    return get(id);
  }

  function setState(id, state, extra = {}) {
    const job = get(id);
    if (!job) throw Object.assign(new Error('Unknown job'), { status: 404 });

    const fields = ['state = ?'];
    const params = [state];
    const now = new Date().toISOString();

    if (state === JOB_STATES.ASSIGNED) {
      fields.push('resource_id = ?', 'assigned_at = ?');
      params.push(extra.resourceId, now);
    }
    if (state === JOB_STATES.RUNNING && !job.started_at) {
      fields.push('started_at = ?');
      params.push(now);
    }
    if (TERMINAL_JOB_STATES.has(state)) {
      fields.push('finished_at = ?');
      params.push(now);
    }
    if (extra.message !== undefined) {
      fields.push('message = ?');
      params.push(extra.message);
    }
    if (extra.exitCode !== undefined) {
      fields.push('exit_code = ?');
      params.push(extra.exitCode);
    }
    if (extra.summary !== undefined) {
      fields.push('summary = ?');
      params.push(JSON.stringify(extra.summary));
    }
    if (state === JOB_STATES.QUEUED) {
      // Requeue: drop the previous assignment so the scheduler treats it fresh.
      fields.push('resource_id = ?', 'assigned_at = ?', 'attempt = attempt + 1');
      params.push(null, null);
    }

    params.push(id);
    db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    events.record('job', id, 'job.state', { from: job.state, to: state, ...extra });
    bus.emit('job.state', { jobId: id, state, resourceId: job.resource_id, ...extra });

    if (state === JOB_STATES.QUEUED) bus.emit('job.queued', { jobId: id });
    if (TERMINAL_JOB_STATES.has(state)) {
      bus.emit('job.finished', { jobId: id, state });
      // LOST means the resource is presumed OUT_OF_SERVICE (that's why the
      // job went LOST) — it only comes back via a real heartbeat (§4.1),
      // not by virtue of its job ending.
      if (job.resource_id && state !== JOB_STATES.LOST) registry.markIdleAfterJob(job.resource_id);
    }
    return get(id);
  }

  // Agent: POST /jobs/:id/cancel
  function cancel(id, { agentId, isAdmin }) {
    const job = get(id);
    if (!job) throw Object.assign(new Error('Unknown job'), { status: 404 });
    if (!isAdmin && job.agent_id !== agentId) {
      throw Object.assign(new Error('Not your job'), { status: 403 });
    }
    if (!ACTIVE_JOB_STATES.has(job.state)) return job;

    if (job.resource_id) {
      bus.emit('command', { resourceId: job.resource_id, command: 'cancel-job', jobId: id });
    }
    return setState(id, JOB_STATES.CANCELED);
  }

  // Resource: POST /jobs/:id/result — final verdict from the test runner.
  function applyResult(id, resourceId, { state, exitCode, summary }) {
    const job = get(id);
    if (!job || job.resource_id !== resourceId) {
      throw Object.assign(new Error('Job not assigned to this resource'), { status: 403 });
    }
    if (![JOB_STATES.PASSED, JOB_STATES.FAILED, JOB_STATES.ERROR].includes(state)) {
      throw Object.assign(new Error('Invalid result state'), { status: 400 });
    }
    return setState(id, state, { exitCode, summary });
  }

  // Called by the sweeper for ASSIGNED jobs whose accept deadline passed,
  // and by the timeout checker for PREPARING/RUNNING jobs.
  function requeueUnacked(id) {
    return setState(id, JOB_STATES.QUEUED);
  }

  function markLost(id) {
    const job = get(id);
    if (job.state === JOB_STATES.LOST || TERMINAL_JOB_STATES.has(job.state)) return job;
    const spec = job.spec;
    setState(id, JOB_STATES.LOST);
    if (config.scheduler.requeueOnLost && job.attempt < 2) {
      return setState(id, JOB_STATES.QUEUED);
    }
    return get(id);
  }

  function checkTimeouts() {
    const now = Date.now();
    const active = db
      .prepare(
        `SELECT * FROM jobs WHERE state IN ('PREPARING','RUNNING') AND started_at IS NOT NULL`
      )
      .all()
      .map(rowToJob);
    for (const job of active) {
      const timeoutSec = job.spec.timeoutSec || config.jobs.defaultTimeoutSec;
      const startedAt = new Date(job.started_at).getTime();
      if (now - startedAt > timeoutSec * 1000) {
        if (job.resource_id) {
          bus.emit('command', { resourceId: job.resource_id, command: 'cancel-job', jobId: job.id });
        }
        setState(job.id, JOB_STATES.TIMEOUT);
      }
    }

    // QUEUED jobs also expire against their own timeout so they don't wait forever (§5.4).
    const queued = db.prepare("SELECT * FROM jobs WHERE state = 'QUEUED'").all().map(rowToJob);
    for (const job of queued) {
      const timeoutSec = job.spec.timeoutSec || config.jobs.defaultTimeoutSec;
      const createdAt = new Date(job.created_at).getTime();
      if (now - createdAt > timeoutSec * 1000) {
        setState(job.id, JOB_STATES.TIMEOUT);
      }
    }
  }

  function checkAssignAcks() {
    const cutoff = new Date(Date.now() - config.scheduler.assignAckTimeoutSec * 1000).toISOString();
    const stale = db
      .prepare("SELECT * FROM jobs WHERE state = 'ASSIGNED' AND assigned_at <= ?")
      .all(cutoff)
      .map(rowToJob);
    for (const job of stale) {
      requeueUnacked(job.id);
    }
  }

  // Coordinator restart reconciliation (§15): ASSIGNED -> QUEUED immediately;
  // PREPARING/RUNNING keep their state and wait for the Client's next heartbeat.
  function reconcileOnStartup() {
    const stuck = db.prepare("SELECT id FROM jobs WHERE state = 'ASSIGNED'").all();
    for (const { id } of stuck) requeueUnacked(id);
  }

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
  };
}

module.exports = { createJobsService };
