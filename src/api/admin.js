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

  return router;
}

module.exports = { createAdminRouter };
