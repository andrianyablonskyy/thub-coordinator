'use strict';

const crypto = require('node:crypto');
const { hashToken } = require('./services/tokens');

// §3.1 / §12: bearer tokens are hashed with SHA-256 and carry a role
// (agent | resource); admin is authenticated via the dashboard session
// instead of an API token (§10).
function requireRole(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    const tokenHash = hashToken(token);

    if (role === 'agent') {
      const agent = req.app.locals.services.agents.getByTokenHash(tokenHash);
      if (!agent) return res.status(401).json({ error: 'Invalid or revoked agent token' });
      req.app.locals.services.agents.touchLastUsed(agent.id);
      req.agent = agent;
      return next();
    }

    if (role === 'resource') {
      const resource = req.app.locals.services.registry.getByTokenHash(tokenHash);
      if (!resource) return res.status(401).json({ error: 'Invalid resource token' });
      req.resource = resource;
      return next();
    }

    return res.status(500).json({ error: `Unknown role ${role}` });
  };
}

// Gates self-service Client registration (see api/resource.js). A shared
// secret rather than a per-resource token, since the whole point is that
// no admin action is needed to let a new Client in — every Client just
// carries the same key from its own config/env.
function requireJoinKey(config) {
  return (req, res, next) => {
    if (!config.clientJoinKey) {
      return res.status(503).json({ error: 'Coordinator has no clientJoinKey configured; auto-registration is disabled' });
    }
    const header = req.headers.authorization || '';
    const [scheme, key] = header.split(' ');
    if (scheme !== 'Bearer' || !key) {
      return res.status(401).json({ error: 'Missing bearer join key' });
    }
    const a = crypto.createHash('sha256').update(key).digest();
    const b = crypto.createHash('sha256').update(config.clientJoinKey).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid join key' });
    }
    next();
  };
}

function requireAdminSession(req, res, next) {
  if (!req.session?.user) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Login required' });
  }
  next();
}

function requireAdminRole(req, res, next) {
  if (req.session?.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
}

module.exports = { requireRole, requireJoinKey, requireAdminSession, requireAdminRole };
