/**
 * @file        packages/coordinator/src/auth.js
 * @description Bearer token and admin session authentication/authorization middleware (README §12)
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

const crypto = require('node:crypto'),
  { hashToken } = require('./services/tokens');

// §3.1 / §12: bearer tokens are hashed with SHA-256 and carry a role
// App version from a "thub-<app>/<version>" User-Agent (shared ApiClient),
// or null for anything else (curl, an older Agent/Client).
function appVersion(req, app){
  const m = new RegExp(`^thub-${app}/([0-9A-Za-z.+-]{1,32})(?:\\s|$)`).exec(req.get('user-agent') || '');
  return m ? m[1] : null;
}

// (agent | resource); admin is authenticated via the dashboard session
// instead of an API token (§10).
function requireRole(role){
  return (req, res, next) => {
    const header = req.headers.authorization || '',
      [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token){
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    const tokenHash = hashToken(token);

    if (role === 'agent'){
      const { agents, adminUsers } = req.app.locals.services,
        agent = agents.getByTokenHash(tokenHash);
      if (!agent){
        return res.status(401).json({ error: 'Invalid or revoked access key' });
      }
      // A user's access key (§10.3) works only while its user may use it.
      if (agent.user_id){
        const user = adminUsers.getById(agent.user_id);
        if (!user || user.blocked){
          return res.status(401).json({ error: user ? `User ${user.username} is blocked — ask an admin` : 'Invalid or revoked access key' });
        }
        req.user = user;
      }
      agents.touchLastUsed(agent.id, appVersion(req, 'agent'));
      req.agent = agent;
      return next();
    }

    if (role === 'resource'){
      const resource = req.app.locals.services.registry.getByTokenHash(tokenHash);
      if (!resource){
        return res.status(401).json({ error: 'Invalid resource token' });
      }
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
function requireJoinKey(config){
  return (req, res, next) => {
    if (!config.clientJoinKey){
      return res.status(503).json({ error: 'Coordinator has no clientJoinKey configured; auto-registration is disabled' });
    }
    const header = req.headers.authorization || '',
      [scheme, key] = header.split(' ');
    if (scheme !== 'Bearer' || !key){
      return res.status(401).json({ error: 'Missing bearer join key' });
    }
    const a = crypto.createHash('sha256').update(key).digest(),
      b = crypto.createHash('sha256').update(config.clientJoinKey).digest();
    if (!crypto.timingSafeEqual(a, b)){
      return res.status(401).json({ error: 'Invalid join key' });
    }
    next();
  };
}

// Dashboard session (§10.3): the user is read again on every request, so
// blocking, deleting or demoting someone to `user` ends their session at
// their next click, and a role change applies at once. A temporary password
// must be changed (on the profile page) before anything else.
const MUST_CHANGE_ALLOWED = ['/profile', '/profile/password', '/logout', '/live'];
function requireAdminSession(req, res, next){
  const fresh = req.session?.user && req.app.locals.services.adminUsers.getById(req.session.user.id);
  if (!fresh || fresh.blocked || !fresh.canUseDashboard){
    const reason = !req.session?.user ? null
      : !fresh ? 'Your account no longer exists.'
        : fresh.blocked ? 'Your account is blocked — ask an admin.' : 'Your account has no dashboard access — use the Agent with your access key.';
    if (req.session?.user){
      req.session.user = null;
      if (reason){
        req.session.flash = [{ type: 'danger', text: reason }];
      }
    }
    if (req.accepts('html')){
      return res.redirect('/login');
    }
    return res.status(401).json({ error: reason || 'Login required' });
  }
  req.session.user = fresh;
  res.locals.user = fresh;
  if (fresh.mustChangePassword && !MUST_CHANGE_ALLOWED.includes(req.path) && req.method === 'GET'){
    return res.redirect('/profile');
  }
  next();
}

// The dashboard's security features (§10.3): Settings, restarting and
// updating the Coordinator, rotating a Client's token. (Users and CI tokens
// are maintainers' too, within web/routes.js managesUser.)
function requireAdminRole(req, res, next){
  if (req.session?.user?.role !== 'admin'){
    const text = 'Only admins can open this — it\'s one of the Coordinator\'s security features.';
    return req.originalUrl.startsWith('/api/') || !req.accepts('html')
      ? res.status(403).json({ error: text })
      : res.status(403).type('text/plain').send(text);
  }
  next();
}

module.exports = { requireRole, requireJoinKey, requireAdminSession, requireAdminRole, appVersion };
