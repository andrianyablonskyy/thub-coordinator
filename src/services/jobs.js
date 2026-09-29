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

const { validateJobSpec, maskEnv, JOB_STATES, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES, RESOURCE_STATES } = require('@andrian.yablonskyy/thub-common'),
  { paginate } = require('./list-prefs'),
  // Named in spec errors: a field the Agent sends but this thub-common
  // doesn't know means the Coordinator needs an update.
  VERSIONS = `Coordinator v${require('../../package.json').version}, ` +
    `thub-common v${require('@andrian.yablonskyy/thub-common/package.json').version}`;

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
const JOB_ID_PREFIXES = { ci: 'A', cli: 'M' },
  // Default priority when the spec doesn't set one (§7.1): a developer's
  // manual run jumps ahead of CI's queue.
  DEFAULT_PRIORITY = { ci: 50, cli: 60 };

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

  // Dashboard /jobs (§10): one sorted page plus the total, both in SQL so a
  // long history never has to be loaded whole. `sort` is a list-prefs key.
  const PAGE_SORT_SQL = {
    id: 'jobs.id',
    source: 'jobs.source',
    user: 'json_extract(jobs.spec, \'$.user\')',
    state: 'jobs.state',
    resource: 'COALESCE(r.name, jobs.resource_name)',
    created: 'jobs.created_at',
    duration: 'jobs.duration_sec'
  };

  function page({ state, source, sort = 'created', dir = 'desc', size = 25, page: pageNo = 1 } = {}){
    const where = [],
      params = [];
    if (state){
      where.push('jobs.state = ?');
      params.push(state);
    }
    if (source){
      where.push('jobs.source = ?');
      params.push(source);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '',
      column = PAGE_SORT_SQL[sort] || PAGE_SORT_SQL.created,
      order = dir === 'asc' ? 'ASC' : 'DESC',
      total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...params).n,
      pagination = paginate(total, size, pageNo),
      // Empty values (no user, never ran, …) last either way; created_at
      // breaks ties so paging is stable.
      rows = db.prepare(
        `SELECT jobs.* FROM jobs LEFT JOIN resources r ON r.id = jobs.resource_id ${whereSql}
         ORDER BY ${column} IS NULL, ${column} ${order}, jobs.created_at DESC
         LIMIT ? OFFSET ?`
      ).all(...params, pagination.limit, pagination.offset);
    return { rows: rows.map(rowToJob), pagination };
  }

  function countQueuedForAgent(agentId){
    return db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE agent_id = ? AND state IN (\'QUEUED\',\'ASSIGNED\')')
      .get(agentId).n;
  }

  // Agent: POST /jobs (§6.1, §4.3). Rejects unsatisfiable label requests
  // immediately (§5.4) instead of letting them starve in the queue.
  function create({ agentId, source, spec: rawSpec }){
    const { valid, spec, errors } = validateJobSpec(
      rawSpec?.priority === undefined ? { ...rawSpec, priority: DEFAULT_PRIORITY[source] } : rawSpec
    );
    if (!valid){
      throw Object.assign(new Error(`Invalid job spec (${VERSIONS}): ${errors.join('; ')}`), { status: 400 });
    }
    spec.source = source;

    // `target.client` (thub run --client) accepts a resource id or name;
    // store the id so the job stays pinned to the same Client across renames.
    if (spec.target.client){
      const resource = registry.get(spec.target.client) || registry.getByName(spec.target.client);
      if (!resource){
        throw Object.assign(new Error(`Unknown client "${spec.target.client}"`), { status: 422 });
      }
      spec.target.client = resource.id;
    }

    // A job-supplied Docker image needs an SW Client that opted in — say so,
    // rather than the generic "no resource can satisfy".
    const needs = { jobImage: Boolean(spec.image) },
      { type, labels, group, client } = spec.target;
    if (needs.jobImage && registry.everSatisfiable(type, labels, group, client) && !registry.everSatisfiable(type, labels, group, client, needs)){
      throw Object.assign(
        new Error(
          `No matching SW Client runs job-supplied Docker images (${spec.image}) — enable it on a Client ` +
            'with "sw": { "allowJobImages": true } in its config'
        ),
        { status: 422 }
      );
    }
    if (!registry.everSatisfiable(type, labels, group, client, needs)){
      throw Object.assign(
        new Error(
          `No registered resource can ever satisfy type=${spec.target.type} labels=${spec.target.labels.join(',')}` +
            (spec.target.group ? ` group=${spec.target.group}` : '') +
            (spec.target.client ? ` client=${spec.target.client}` : '')
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
      // Duration is computed once, here, and stored — never derived at
      // display time. Measured from started_at (RUNNING), like the timeout.
      fields.push('finished_at = ?', 'duration_sec = ?');
      params.push(now, job.started_at ? Math.max(0, Math.round((Date.parse(now) - Date.parse(job.started_at)) / 1000)) : null);
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
      // Requeue: drop the previous assignment (and its start time, so the
      // next attempt's duration/timeout count from its own start) so the
      // scheduler treats it fresh.
      fields.push('resource_id = ?', 'assigned_at = ?', 'started_at = ?', 'attempt = attempt + 1');
      params.push(null, null, null);
    }

    params.push(id);
    db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    events.record('job', id, 'job.state', { from: job.state, to: state, ...extra });
    bus.emit('job.state', { jobId: id, state, resourceId: job.resource_id, ...extra });

    if (state === JOB_STATES.QUEUED){
      bus.emit('job.queued', { jobId: id });
    }
    if (TERMINAL_JOB_STATES.has(state)){
      // A LOST job may be requeued (markLost), and needs its env for that.
      if (state !== JOB_STATES.LOST){
        forgetEnv(id);
      }
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
  // `reason`: shown as the job's message (e.g. "Canceled: user reboot request").
  function cancel(id, { agentId, isAdmin, reason }){
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
    return setState(id, JOB_STATES.CANCELED, reason ? { message: reason } : {});
  }

  // Admin "Reboot" on a Client (resource card): its running job is canceled
  // first (the host is going down anyway), then a `reboot` command goes out
  // with its next heartbeat — the Client reboots the host through its root
  // reboot helper once nothing on it is busy. Refused for a Client that's
  // offline (it would reboot whenever it next reconnects) or can't reboot.
  function requestReboot(resourceId, { by } = {}){
    const r = registry.get(resourceId);
    if (!r){
      throw Object.assign(new Error('Unknown resource'), { status: 404 });
    }
    if (r.status === RESOURCE_STATES.OUT_OF_SERVICE || !r.last_heartbeat_at){
      throw Object.assign(new Error(`${r.name} is offline — it can only be rebooted while it's connected`), { status: 409 });
    }
    if (r.capabilities?.rebootSupported === false){
      throw Object.assign(
        new Error(`${r.name}'s host has no reboot helper — reinstall the Client as root (sudo npm i -g @andrian.yablonskyy/thub-client)`),
        { status: 409 }
      );
    }
    const job = activeForResource(resourceId);
    if (job){
      cancel(job.id, { isAdmin: true, reason: 'Canceled: user reboot request' });
    }
    bus.emit('command', { resourceId, command: 'reboot', reason: `user reboot request${by ? ` by ${by}` : ''}` });
    events.record('resource', resourceId, 'resource.reboot_requested', { by, canceledJob: job?.id || null });
    return { resource: r, canceledJob: job?.id || null };
  }

  // Queued jobs pinned to a resource (`target.client`) can never run once it's
  // removed, so they're canceled rather than left in the queue forever.
  function cancelPinnedTo(resourceId, message){
    const queued = db.prepare('SELECT id, spec FROM jobs WHERE state = ?').all(JOB_STATES.QUEUED)
      .filter((row) => JSON.parse(row.spec).target?.client === resourceId);
    for (const { id }of queued){
      setState(id, JOB_STATES.CANCELED, { message });
    }
    return queued.map((row) => row.id);
  }

  // Admin "Remove" (dashboard, DELETE /admin/resources/:id). A resource
  // that's running a job needs `stopJob`: the job is canceled at once, but
  // the Client only hears that in its next heartbeat's commands — so the
  // resource (and with it the Client's token) is deleted only after that
  // (completeRemoval, from the heartbeat route or the sweeper's timeout).
  function removeResource(resourceId, { by, stopJob = false } = {}){
    const r = registry.get(resourceId);
    if (!r){
      throw Object.assign(new Error('Unknown resource'), { status: 404 });
    }
    const job = activeForResource(resourceId);
    if (job && !stopJob){
      throw Object.assign(new Error(`${r.name} is running job ${job.id}`), { status: 409, jobId: job.id });
    }
    if (job){
      cancel(job.id, { isAdmin: true });
      registry.requestRemoval(resourceId, { by });
      return { resource: r, pending: true, stoppedJob: job.id, canceledJobs: [] };
    }
    return { resource: r, pending: false, stoppedJob: null, canceledJobs: completeRemoval(resourceId, { by }) };
  }

  function completeRemoval(resourceId, { by } = {}){
    const r = registry.remove(resourceId, { by });
    return cancelPinnedTo(resourceId, `Client ${r.name} was removed`);
  }

  // The job a resource is working on (ASSIGNED through RUNNING), if any —
  // for the resource card's Cancel button.
  function activeForResource(resourceId){
    const placeholders = [...ACTIVE_JOB_STATES].map(() => '?').join(','),
      row = db.prepare(
        `SELECT id FROM jobs WHERE resource_id = ? AND state IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`
      ).get(resourceId, ...ACTIVE_JOB_STATES);
    return row ? get(row.id) : null;
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
    setState(id, JOB_STATES.LOST);
    if (config.scheduler.requeueOnLost && job.attempt < 2){
      return setState(id, JOB_STATES.QUEUED);
    }
    forgetEnv(id);
    return get(id);
  }

  // A finished job's `--env` values (registry passwords etc.) aren't kept:
  // only the names stay, masked.
  function forgetEnv(id){
    const row = db.prepare('SELECT spec FROM jobs WHERE id = ?').get(id),
      spec = row && JSON.parse(row.spec);
    if (spec?.env){
      db.prepare('UPDATE jobs SET spec = ? WHERE id = ?').run(JSON.stringify({ ...spec, env: maskEnv(spec.env) }), id);
    }
  }

  // A job as the Agent API shows it: `--env` values masked (any Agent token
  // can read any job; only the Client running it gets them).
  function publicJob(job){
    return job?.spec?.env ? { ...job, spec: { ...job.spec, env: maskEnv(job.spec.env) } } : job;
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

  // How many jobs Reset queue / Clean history would touch — shown in their
  // confirmation modals on /jobs.
  function countActiveAndFinished(){
    const count = (states) => db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN (${[...states].map(() => '?').join(',')})`)
      .get(...states).n;
    return { active: count(ACTIVE_JOB_STATES), finished: count(TERMINAL_JOB_STATES) };
  }

  // Admin: "clean the queue" — permanently delete finished jobs (and their
  // logs/artifacts, on disk and in the DB), for when the history itself,
  // not just active work, needs clearing out. Unlike the nightly retention
  // sweep (§9), this runs on demand and isn't limited to old jobs.
  function cleanHistory(){
    return purgeFinishedBefore(null);
  }

  // Finished jobs that ended before `beforeIso` (null: all of them), with
  // their logs, artifacts (files too) and events — manual cleanup and the
  // job retention task (services/cleanup.js). Active jobs are never touched.
  function purgeFinishedBefore(beforeIso){
    const placeholders = [...TERMINAL_JOB_STATES].map(() => '?').join(','),
      rows = beforeIso
        ? db.prepare(`SELECT id FROM jobs WHERE state IN (${placeholders}) AND COALESCE(finished_at, created_at) < ?`)
          .all(...TERMINAL_JOB_STATES, beforeIso)
        : db.prepare(`SELECT id FROM jobs WHERE state IN (${placeholders})`).all(...TERMINAL_JOB_STATES),
      ids = rows.map((r) => r.id);
    if (ids.length === 0){
      return 0;
    }

    const deleteArtifacts = db.prepare('DELETE FROM artifacts WHERE job_id = ?'),
      deleteLogs = db.prepare('DELETE FROM job_logs WHERE job_id = ?'),
      deleteEvents = db.prepare('DELETE FROM events WHERE entity = \'job\' AND entity_id = ?'),
      deleteJob = db.prepare('DELETE FROM jobs WHERE id = ?'),
      tx = db.transaction(() => {
        for (const id of ids){
          artifacts.deleteJobArtifacts(id);
          deleteArtifacts.run(id);
          deleteLogs.run(id);
          deleteEvents.run(id);
          deleteJob.run(id);
        }
      });
    tx();
    events.record('job', 'bulk', 'jobs.cleaned', { count: ids.length, before: beforeIso });
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
    publicJob,
    list,
    page,
    create,
    setState,
    cancel,
    cancelPinnedTo,
    requestReboot,
    removeResource,
    completeRemoval,
    activeForResource,
    applyResult,
    requeueUnacked,
    markLost,
    checkTimeouts,
    checkAssignAcks,
    reconcileOnStartup,
    resetQueue,
    countActiveAndFinished,
    cleanHistory,
    purgeFinishedBefore
  };
}

module.exports = { createJobsService };
