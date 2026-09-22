/**
 * @file        packages/coordinator/src/api/resource.js
 * @description Resource (Client) API routes: register, heartbeat, job long-poll, result/log upload (README §6.2)
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
  multer = require('multer'),
  { requireRole, requireJoinKey } = require('../auth'),
  { JOB_STATES } = require('@andrian.yablonskyy/thub-common');

const upload = multer({ dest: require('node:os').tmpdir() });

function requireOwnResource(req, res, next){
  if (req.resource.id !== req.params.id){
    return res.status(403).json({ error: 'Token does not match resource' });
  }
  next();
}

function requireOwnJob(services){
  return (req, res, next) => {
    const job = services.jobs.get(req.params.id);
    if (!job){
      return res.status(404).json({ error: 'Unknown job' });
    }
    if (job.resource_id !== req.resource.id){
      return res.status(403).json({ error: 'Job is not assigned to this resource' });
    }
    req.job = job;
    next();
  };
}

// §6.2 Resource (Client) endpoints.
function createResourceRouter({ services, config }){
  const router = express.Router();

  // Self-service registration: no admin action required. A Client proves
  // it belongs by presenting the shared clientJoinKey (config/env on its
  // side) and declares its own name/type/labels; the Coordinator upserts
  // the resource by name (see registry.registerAuto).
  router.post('/resources/register', requireJoinKey(config), (req, res, next) => {
    try {
      const { clientId, name, type, labels, groups, hostInfo, capabilities } = req.body;
      if (!clientId){
        return res.status(400).json({ error: 'clientId is required (persisted in the Client\'s .client-id file)' });
      }
      if (!name || !['hw', 'sw'].includes(type)){
        return res.status(400).json({ error: 'name and type (hw|sw) are required' });
      }
      const { resourceId, resourceToken } = services.registry.registerAuto({
        clientId,
        name,
        type,
        labels: labels || capabilities?.labels || [],
        groups: groups || [],
        hostInfo
      });
      res.json({ resourceId, resourceToken, heartbeatIntervalSec: config.heartbeat.intervalSec });
    }
    catch (err){
      next(err);
    }
  });

  // Applied per-route, not via router.use() — this router shares the
  // /api/v1 prefix with the agent and admin routers, and a blanket
  // router-level middleware would run for their paths too before route
  // matching happens (see the same note in api/agent.js).
  const auth = requireRole('resource');

  router.post('/resources/:id/heartbeat', auth, requireOwnResource, (req, res, next) => {
    try {
      const { state, activeJobId, localLock, metrics } = req.body;
      services.registry.heartbeat(req.params.id, { state, activeJobId, localLock, metrics });
      const commands = services.commands.drain(req.params.id);
      res.json({ serverTime: new Date().toISOString(), commands });
    }
    catch (err){
      next(err);
    }
  });

  router.post('/resources/:id/status', auth, requireOwnResource, (req, res, next) => {
    try {
      const { busy, source, reason } = req.body;
      if (source && source !== 'local'){
        return res.status(400).json({ error: 'Only source=local may be set explicitly' });
      }
      const resource = services.registry.setLocalLock(req.params.id, { locked: !!busy, reason });
      res.json(resource);
    }
    catch (err){
      next(err);
    }
  });

  router.get('/resources/:id/jobs/next', auth, requireOwnResource, async (req, res) => {
    const waitSec = Math.min(Number(req.query.wait) || 0, 60),

      existing = services.jobs.list({ state: JOB_STATES.ASSIGNED, resourceId: req.params.id, limit: 1 })[0];
    if (existing){
      return res.json(existing);
    }

    if (waitSec <= 0){
      return res.status(204).end();
    }

    const jobId = await waitForAssignment(services.bus, req.params.id, waitSec);
    if (!jobId){
      return res.status(204).end();
    }
    res.json(services.jobs.get(jobId));
  });

  router.post('/jobs/:id/accept', auth, requireOwnJob(services), (req, res, next) => {
    try {
      if (req.job.state !== JOB_STATES.ASSIGNED){
        return res.status(409).json({ error: `Cannot accept job in state ${req.job.state}` });
      }
      const job = services.jobs.setState(req.params.id, JOB_STATES.PREPARING);
      res.json(job);
    }
    catch (err){
      next(err);
    }
  });

  router.post('/jobs/:id/state', auth, requireOwnJob(services), (req, res, next) => {
    try {
      const { state, message } = req.body;
      if (![JOB_STATES.PREPARING, JOB_STATES.RUNNING].includes(state)){
        return res.status(400).json({ error: 'state must be PREPARING or RUNNING' });
      }
      const job = services.jobs.setState(req.params.id, state, { message });
      res.json(job);
    }
    catch (err){
      next(err);
    }
  });

  router.post('/jobs/:id/logs', auth, requireOwnJob(services), (req, res, next) => {
    try {
      const lines = Array.isArray(req.body) ? req.body : req.body.lines;
      if (!Array.isArray(lines)){
        return res.status(400).json({ error: 'Expected an array of log lines' });
      }
      const inserted = services.logs.appendBatch(req.params.id, lines);
      res.status(202).json({ accepted: inserted.length });
    }
    catch (err){
      next(err);
    }
  });

  router.post('/jobs/:id/artifacts', auth, requireOwnJob(services), upload.any(), (req, res, next) => {
    try {
      const stored = services.artifacts.storeUploaded(req.params.id, req.files || []);
      res.status(201).json({ artifacts: stored.map((a) => ({ id: a.id, name: a.name, size: a.size })) });
    }
    catch (err){
      next(err);
    }
  });

  router.post('/jobs/:id/result', auth, requireOwnJob(services), (req, res, next) => {
    try {
      const { state, exitCode, summary } = req.body,
        job = services.jobs.applyResult(req.params.id, req.resource.id, { state, exitCode, summary });
      res.json(job);
    }
    catch (err){
      next(err);
    }
  });

  return router;
}

function waitForAssignment(bus, resourceId, waitSec){
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bus.off('job.assigned', onAssigned);
      resolve(null);
    }, waitSec * 1000);

    function onAssigned(evt){
      if (evt.resourceId !== resourceId){
        return;
      }
      clearTimeout(timer);
      bus.off('job.assigned', onAssigned);
      resolve(evt.jobId);
    }
    bus.on('job.assigned', onAssigned);
  });
}

module.exports = { createResourceRouter };
