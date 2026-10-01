/**
 * @file        packages/coordinator/src/api/agent.js
 * @description Agent API routes: job submission, status, cancel, log streaming (README §6.1)
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

const express = require('express'),
  { requireRole } = require('../auth'),
  { attachJobStream } = require('./sse');

// §6.1 Agent endpoints.
function createAgentRouter({ services, config }){
  const router = express.Router(),
    // Applied per-route (not via router.use()) because this router shares
    // the /api/v1 prefix with the resource and admin routers — a blanket
    // router-level middleware would run for their paths too, before route
    // matching even happens, and reject them for lacking an agent token.
    auth = requireRole('agent'),

    // Which jobs a key may see (README §12, §10.3): a CI token all of them;
    // a user's key all of them for maintainers and admins, only their own
    // for the `user` role. Anyone else's job is answered exactly like a job
    // that doesn't exist (404), so a user can't tell which ids are in use.
    seesAll = (req) => req.agent.kind === 'ci' || ['maintainer', 'admin'].includes(req.user?.role),
    canSee = (req, job) => seesAll(req) || job.agent_id === req.agent.id,
    // Cancelling: maintainers and admins any job; anyone else their own.
    cancelsAll = (req) => ['maintainer', 'admin'].includes(req.user?.role),
    visibleJob = (req, res, next) => {
      const job = services.jobs.get(req.params.id);
      if (!job || !canSee(req, job)){
        return res.status(404).json({ error: 'Unknown job' });
      }
      req.job = job;
      next();
    };

  router.post('/jobs', auth, (req, res, next) => {
    try {
      // The job source (A-/M- id series, default priority) is the agent
      // token's admin-assigned kind alone — never taken from the request,
      // so it can't be spoofed or mis-detected on the Agent side.
      const source = req.agent.kind,
        job = services.jobs.create({ agentId: req.agent.id, source, spec: req.body });
      res.status(201).json({ jobId: job.id, state: job.state, webUrl: `${config.publicUrl}/jobs/${job.id}` });
    }
    catch (err){
      next(err);
    }
  });

  router.get('/jobs/:id', auth, visibleJob, (req, res) => {
    const { job } = req,
      resource = job.resource_id ? services.registry.get(job.resource_id) : null;
    res.json({
      ...services.jobs.publicJob(job),
      resource: resource ? { id: resource.id, name: resource.name } : job.resource_name ? { id: null, name: job.resource_name } : null
    });
  });

  router.get('/jobs', auth, (req, res) => {
    const jobs = services.jobs.list({
      state: req.query.state,
      source: req.query.source,
      agentId: req.agent.id,
      // A `user`'s list is always their own jobs (canSee above).
      mine: !seesAll(req) || req.query.mine === 'true' || req.query.mine === '1',
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });
    res.json({ jobs: jobs.map(services.jobs.publicJob) });
  });

  router.post('/jobs/:id/cancel', auth, visibleJob, (req, res, next) => {
    try {
      const job = services.jobs.cancel(req.params.id, { agentId: req.agent.id, isAdmin: cancelsAll(req) });
      res.json(services.jobs.publicJob(job));
    }
    catch (err){
      next(err);
    }
  });

  router.get('/jobs/:id/logs', auth, visibleJob, (req, res) => {
    const after = Number(req.query.after || 0),
      limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ lines: services.logs.listSince(req.params.id, after, limit) });
  });

  router.get('/jobs/:id/logs/stream', auth, visibleJob, (req, res) => {
    attachJobStream(req, res, { jobId: req.params.id, services });
  });

  // What the job reported (README §7.3): metadata and links only. `url` is
  // `link` again, for Agents from before, which print `url`.
  router.get('/jobs/:id/artifacts', auth, visibleJob, (req, res) => {
    res.json({ artifacts: req.job.artifacts.map((a) => ({ ...a, url: a.link })) });
  });

  // `thub whoami` / `thub key show` (§10.3): who this key belongs to.
  router.get('/me', auth, (req, res) => {
    // The group its jobs run in (set on the dashboard, §13.1), by name.
    const groupId = req.user ? services.adminUsers.getById(req.user.id)?.groupId : services.agents.get(req.agent.id)?.group_id,
      group = groupId ? services.groups.get(groupId)?.name || null : null;
    if (!req.user){
      return res.json({ kind: req.agent.kind, name: req.agent.name, group });
    }
    const { username, email, role } = req.user,
      key = services.adminUsers.keyOf(req.user.id);
    res.json({
      kind: req.agent.kind,
      group,
      user: { username, email, role },
      key: { hint: key.token_hint, createdAt: key.token_created_at || key.created_at, lastUsedAt: key.last_used_at }
    });
  });

  // `thub key rotate`: a user replaces their own key — the one sending this
  // stops working at once, the new one is in the answer (only there).
  // A CI token is replaced by an admin, on the dashboard.
  router.post('/me/key/rotate', auth, (req, res) => {
    if (!req.user){
      return res.status(403).json({ error: 'A CI token is replaced by an admin on the dashboard (CI tokens)' });
    }
    res.json({ key: services.adminUsers.issueKey(req.user.id, { by: req.user.username }), username: req.user.username });
  });

  router.get('/resources', auth, (req, res) => {
    res.json({ resources: services.registry.list().map(publicResource) });
  });

  // Checked by the Agent at the start of every run (README §10.2): the
  // version an admin asked it to self-update to, if still newer than the
  // one it runs (auth has already recorded that from its User-Agent).
  router.get('/agents/me/update', auth, (req, res) => {
    const agent = services.agents.get(req.agent.id);
    res.json({ updateTo: agent.update_to || null, latest: services.updates.status().latest.agent || null });
  });

  return router;
}

function publicResource(r){
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    busySource: r.busy_source,
    labels: r.labels,
    lastHeartbeatAt: r.last_heartbeat_at
  };
}

module.exports = { createAgentRouter };
