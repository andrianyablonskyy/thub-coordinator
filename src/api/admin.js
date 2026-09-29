/**
 * @file        packages/coordinator/src/api/admin.js
 * @description Admin API routes: agents, join key, resource maintenance, job queue reset/clean (README §6.3)
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
  { requireAdminSession, requireAdminRole } = require('../auth'),
  { generateToken, hashToken } = require('../services/tokens');

// §6.3 Admin endpoints. Authenticated via the dashboard session (§10),
// not an API bearer token.
function createAdminRouter({ services }){
  const router = express.Router();
  router.use(requireAdminSession, requireAdminRole);

  router.post('/agents', (req, res, next) => {
    try {
      const { name, kind } = req.body;
      if (!name || !['ci', 'cli'].includes(kind)){
        return res.status(400).json({ error: 'name and kind (ci|cli) are required' });
      }
      const { agent, token } = services.agents.create({ name, kind });
      res.status(201).json({ agent, token });
    }
    catch (err){
      next(err);
    }
  });

  router.post('/agents/:id', (req, res, next) => {
    try {
      res.json(services.agents.rename(req.params.id, req.body?.name));
    }
    catch (err){
      next(err);
    }
  });

  router.delete('/agents/:id', (req, res) => {
    services.agents.revoke(req.params.id);
    res.status(204).end();
  });

  // Reboot a Client's host now (its running job is canceled first).
  router.post('/resources/:id/reboot', (req, res, next) => {
    try {
      const { resource, canceledJob } = services.jobs.requestReboot(req.params.id);
      res.json({ id: resource.id, rebooting: true, canceledJob });
    }
    catch (err){
      next(err);
    }
  });

  // Scheduled host reboot: { cron } (5-field, host local time; "" clears).
  router.post('/resources/:id/reboot-schedule', (req, res, next) => {
    try {
      const r = services.registry.setRebootSchedule(req.params.id, req.body?.cron ?? '');
      res.json({ id: r.id, rebootSchedule: r.reboot_schedule, applied: r.reboot_schedule_applied });
    }
    catch (err){
      next(err);
    }
  });

  router.post('/resources/:id/maintenance', (req, res, next) => {
    try {
      const resource = services.registry.setMaintenance(req.params.id, !!req.body.enabled);
      res.json(resource);
    }
    catch (err){
      next(err);
    }
  });

  // Referenced in §10's dashboard resource actions.
  router.post('/resources/:id/rotate-token', (req, res) => {
    const token = generateToken('res');
    services.db.prepare('UPDATE resources SET token_hash = ? WHERE id = ?').run(hashToken(token), req.params.id);
    services.events.record('resource', req.params.id, 'resource.token_rotated', {});
    res.json({ resourceToken: token });
  });

  // Removes a resource; 409 while it runs a job unless ?stopJob=1, which
  // cancels the job and removes the resource once the Client confirms
  // (`pending: true`). Queued jobs pinned to it are canceled on removal.
  router.delete('/resources/:id', (req, res, next) => {
    try {
      const { resource, pending, stoppedJob, canceledJobs } = services.jobs.removeResource(req.params.id, {
        stopJob: req.query.stopJob === '1'
      });
      res.json({ removed: resource.id, pending, stoppedJob, canceledJobs });
    }
    catch (err){
      next(err);
    }
  });

  // Cancels every QUEUED/ASSIGNED/PREPARING/RUNNING job (§13.1).
  router.post('/jobs/reset-queue', (req, res) => {
    const canceled = services.jobs.resetQueue();
    res.json({ canceled });
  });

  // Permanently deletes finished jobs and their logs/artifacts (§13.1).
  // Database cleanup (§9): optional `before` (ISO 8601; default now) —
  // finished jobs that ended before it, older history, then VACUUM.
  router.post('/jobs/clean-history', (req, res) => {
    const before = req.body?.before ? new Date(req.body.before) : new Date();
    if (Number.isNaN(before.getTime())){
      return res.status(400).json({ error: 'before must be an ISO 8601 date/time' });
    }
    const r = services.cleanup.cleanup({ before });
    res.json({ deleted: r.jobs, events: r.events, before: r.before, bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter });
  });

  // Resource groups (§13.1) — membership itself is declared by each
  // Client's own config (`groups: [...]`), not managed here.
  router.get('/groups', (req, res) => {
    res.json({ groups: services.groups.list() });
  });

  router.post('/groups', (req, res, next) => {
    try {
      const { name, comment } = req.body;
      if (!name){
        return res.status(400).json({ error: 'name is required' });
      }
      res.status(201).json(services.groups.create({ name, comment }));
    }
    catch (err){
      next(err);
    }
  });

  router.post('/groups/:id', (req, res, next) => {
    try {
      const { name, comment } = req.body;
      res.json(services.groups.update(req.params.id, { name, comment }));
    }
    catch (err){
      next(err);
    }
  });

  router.delete('/groups/:id', (req, res) => {
    services.groups.remove(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createAdminRouter };
