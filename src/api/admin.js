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

const express = require('express');
const { requireAdminSession, requireAdminRole } = require('../auth');
const { generateToken, hashToken } = require('../services/tokens');

// §6.3 Admin endpoints. Authenticated via the dashboard session (§10),
// not an API bearer token.
function createAdminRouter({ services }) {
  const router = express.Router();
  router.use(requireAdminSession, requireAdminRole);

  router.post('/agents', (req, res, next) => {
    try {
      const { name, kind } = req.body;
      if (!name || !['ci', 'cli'].includes(kind)) {
        return res.status(400).json({ error: 'name and kind (ci|cli) are required' });
      }
      const { agent, token } = services.agents.create({ name, kind });
      res.status(201).json({ agent, token });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/agents/:id', (req, res) => {
    services.agents.revoke(req.params.id);
    res.status(204).end();
  });

  router.post('/resources/:id/maintenance', (req, res, next) => {
    try {
      const resource = services.registry.setMaintenance(req.params.id, !!req.body.enabled);
      res.json(resource);
    } catch (err) {
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

  // Cancels every QUEUED/ASSIGNED/PREPARING/RUNNING job (§13.1).
  router.post('/jobs/reset-queue', (req, res) => {
    const canceled = services.jobs.resetQueue();
    res.json({ canceled });
  });

  // Permanently deletes finished jobs and their logs/artifacts (§13.1).
  router.post('/jobs/clean-history', (req, res) => {
    const deleted = services.jobs.cleanHistory();
    res.json({ deleted });
  });

  // Resource groups (§13.1) — membership itself is declared by each
  // Client's own config (`groups: [...]`), not managed here.
  router.get('/groups', (req, res) => {
    res.json({ groups: services.groups.list() });
  });

  router.post('/groups', (req, res, next) => {
    try {
      const { name, comment } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      res.status(201).json(services.groups.create({ name, comment }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/groups/:id', (req, res, next) => {
    try {
      const { name, comment } = req.body;
      res.json(services.groups.update(req.params.id, { name, comment }));
    } catch (err) {
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
