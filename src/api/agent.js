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
    auth = requireRole('agent');

  router.post('/jobs', auth, (req, res, next) => {
    try {
      const job = services.jobs.create({ agentId: req.agent.id, source: req.body.source || 'cli', spec: req.body });
      res.status(201).json({ jobId: job.id, state: job.state, webUrl: `${config.publicUrl}/jobs/${job.id}` });
    }
    catch (err){
      next(err);
    }
  });

  router.get('/jobs/:id', auth, (req, res) => {
    const job = services.jobs.get(req.params.id);
    if (!job){
      return res.status(404).json({ error: 'Unknown job' });
    }
    const resource = job.resource_id ? services.registry.get(job.resource_id) : null;
    res.json({ ...job, resource: resource ? { id: resource.id, name: resource.name } : null });
  });

  router.get('/jobs', auth, (req, res) => {
    const jobs = services.jobs.list({
      state: req.query.state,
      source: req.query.source,
      agentId: req.agent.id,
      mine: req.query.mine === 'true' || req.query.mine === '1',
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });
    res.json({ jobs });
  });

  router.post('/jobs/:id/cancel', auth, (req, res, next) => {
    try {
      const job = services.jobs.cancel(req.params.id, { agentId: req.agent.id, isAdmin: false });
      res.json(job);
    }
    catch (err){
      next(err);
    }
  });

  router.get('/jobs/:id/logs', auth, (req, res) => {
    const after = Number(req.query.after || 0),
      limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ lines: services.logs.listSince(req.params.id, after, limit) });
  });

  router.get('/jobs/:id/logs/stream', auth, (req, res) => {
    attachJobStream(req, res, { jobId: req.params.id, services, config });
  });

  router.get('/jobs/:id/artifacts', auth, (req, res) => {
    const artifacts = services.artifacts.listForJob(req.params.id).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      contentType: a.content_type,
      url: services.artifacts.signedUrl(a)
    }));
    res.json({ artifacts });
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
