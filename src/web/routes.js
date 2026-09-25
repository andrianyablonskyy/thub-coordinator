/**
 * @file        packages/coordinator/src/web/routes.js
 * @description Dashboard (Pug) routes: overview, resources, groups, jobs, agents, profile pages (README §10)
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

const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  express = require('express'),
  multer = require('multer'),
  { requireAdminSession, requireAdminRole } = require('../auth'),
  { attachJobStream } = require('../api/sse'),
  { RESOURCE_STATES, JOB_STATES, ACTIVE_JOB_STATES } = require('@andrian.yablonskyy/thub-common');

// §10.1: avatar uploads are small, single images — a hard size cap and an
// allow-list of image mimetypes, same spirit as the join-key/token checks
// elsewhere (reject outright rather than trying to sanitize).
const AVATAR_MAX_BYTES = 2 * 1024 * 1024,
  AVATAR_EXT_BY_MIMETYPE = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
  },
  avatarUpload = multer({ dest: os.tmpdir(), limits: { fileSize: AVATAR_MAX_BYTES } });

// §10 Web dashboard: server-rendered Pug + Bootstrap 5.3, with the live
// views hitting the same kind of SSE stream the Agent uses (§6.4), just
// authenticated by session cookie instead of a bearer token.
function createWebRouter({ services, config }){
  const router = express.Router();

  function flash(req, type, text){
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  }

  // Where a resource action (maintenance, rotate token) came from — the
  // Resources page or the Overview's resource card. Only a local path,
  // never another site.
  function returnTo(req, fallback){
    const target = req.body.returnTo;
    return typeof target === 'string' && /^\/(?![\/\\])/.test(target) ? target : fallback;
  }

  router.use((req, res, next) => {
    const user = req.session?.user || null;
    res.locals.user = user;
    res.locals.messages = req.session?.flash || [];
    if (req.session){
      req.session.flash = [];
    }

    // Every dashboard timestamp is rendered here on the server (Pug), so
    // without this every user would see the *server's* local time — not
    // their own (§10.1). Falls back to UTC for the (rare) pre-login page.
    const tz = user?.timezone || 'UTC';
    res.locals.fmtDate = (iso, fallback = '—') =>
      iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz }) : fallback;

    // Idle timeout (§10.1): re-applied on every request (not just login)
    // so a mid-session profile change takes effect immediately, and so
    // `rolling: true` (server.js) actually extends by *this* user's chosen
    // duration each time, not whatever the session happened to start with.
    if (req.session && user){
      req.session.cookie.maxAge = user.sessionTimeoutMin * 60 * 1000;
    }

    next();
  });

  router.get('/login', (req, res) => {
    if (req.session.user){
      return res.redirect('/');
    }
    res.render('login', { title: 'Sign in' });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body,
      user = services.adminUsers.verify(username, password);
    if (!user){
      return res.status(401).render('login', { title: 'Sign in', error: 'Invalid credentials' });
    }
    req.session.user = user;
    req.session.cookie.maxAge = user.sessionTimeoutMin * 60 * 1000;
    res.redirect('/');
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.use(requireAdminSession);

  // §10.1: every logged-in user (admin or viewer) manages their own
  // profile — display name, avatar, timezone, theme and idle session
  // timeout. Not gated by requireAdminRole: this only ever touches the
  // caller's own account (req.session.user.id), never another user's.
  router.get('/profile', (req, res) => {
    res.render('profile', {
      title: 'Profile',
      timezones: Intl.supportedValuesOf('timeZone'),
      sessionTimeoutOptions: services.adminUsers.SESSION_TIMEOUT_OPTIONS_MIN
    });
  });

  router.post('/profile', (req, res) => {
    avatarUpload.single('avatar')(req, res, (uploadErr) => {
      if (uploadErr){
        flash(
          req,
          'danger',
          uploadErr.code === 'LIMIT_FILE_SIZE'
            ? `Avatar image must be under ${AVATAR_MAX_BYTES / (1024 * 1024)}MB.`
            : uploadErr.message
        );
        return res.redirect('/profile');
      }

      const userId = req.session.user.id,
        fields = {
          username: req.body.username,
          firstName: req.body.firstName || null,
          lastName: req.body.lastName || null,
          timezone: req.body.timezone,
          sessionTimeoutMin: Number(req.body.sessionTimeoutMin)
        };

      if (req.file){
        const ext = AVATAR_EXT_BY_MIMETYPE[req.file.mimetype];
        if (!ext){
          fs.rmSync(req.file.path, { force: true });
          flash(req, 'danger', `Unsupported image type "${req.file.mimetype}" — use PNG, JPEG, GIF or WebP.`);
        }
        else {
          // Clear any previous avatar under a different extension so
          // switching PNG -> JPEG doesn't leave the old file behind.
          for (const e of Object.values(AVATAR_EXT_BY_MIMETYPE)){
            fs.rmSync(path.join(config.avatarsDir, `${userId}.${e}`), { force: true });
          }
          fs.renameSync(req.file.path, path.join(config.avatarsDir, `${userId}.${ext}`));
          fields.avatarPath = `/avatars/${userId}.${ext}`;
        }
      }

      try {
        req.session.user = services.adminUsers.updateProfile(userId, fields);
        flash(req, 'success', 'Profile updated.');
      }
      catch (err){
        flash(req, 'danger', err.message);
      }
      res.redirect('/profile');
    });
  });

  // Quick theme toggle (navbar button, §10.1) — a separate, minimal
  // endpoint so switching theme doesn't require resubmitting the whole
  // profile form. Persists per-account so it's the same on every device,
  // not just the browser that clicked it (public/js/theme.js).
  router.post('/profile/theme', (req, res) => {
    try {
      req.session.user = services.adminUsers.updateProfile(req.session.user.id, { theme: req.body.theme });
      res.json({ ok: true, theme: req.session.user.theme });
    }
    catch (err){
      res.status(err.status || 400).json({ ok: false, error: err.message });
    }
  });

  // Self-service password change (§10.1) — separate from the rest of the
  // profile form since it needs the *current* password re-entered, and a
  // mismatch between newPassword/confirmPassword is a form-level check
  // that has nothing to do with the other fields.
  router.post('/profile/password', (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword){
      flash(req, 'danger', 'New password and confirmation do not match.');
      return res.redirect('/profile');
    }
    try {
      services.adminUsers.changePassword(req.session.user.id, currentPassword, newPassword);
      flash(req, 'success', 'Password changed.');
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect('/profile');
  });

  router.get('/', (req, res) => {
    const resources = services.registry.list(),
      queueLength = services.jobs.list({ state: JOB_STATES.QUEUED, limit: 1000 }).length,
      dayAgo = new Date(Date.now() - 86400 * 1000).toISOString(),
      jobsLast24h = services.jobs
        .list({ limit: 1000 })
        .filter((j) => j.created_at >= dayAgo).length,
      onlineCount = resources.filter((r) => r.status !== RESOURCE_STATES.OUT_OF_SERVICE && r.status !== RESOURCE_STATES.REGISTERED).length,
      groupsById = Object.fromEntries(services.groups.list().map((g) => [g.id, g]));
    res.render('index', { title: 'Overview', active: 'overview', resources, queueLength, jobsLast24h, onlineCount, groupsById });
  });

  router.get('/resources', (req, res) => {
    const groupsById = Object.fromEntries(services.groups.list().map((g) => [g.id, g]));
    res.render('resources/list', {
      title: 'Resources',
      active: 'resources',
      resources: services.registry.list(),
      groupsById
    });
  });

  router.post('/resources/:id/maintenance', requireAdminRole, (req, res) => {
    services.registry.setMaintenance(req.params.id, req.body.enabled === '1');
    res.redirect(returnTo(req, '/resources'));
  });

  router.post('/resources/:id/rotate-token', requireAdminRole, (req, res) => {
    const { generateToken, hashToken } = require('../services/tokens');
    const token = generateToken('res');
    services.db.prepare('UPDATE resources SET token_hash = ? WHERE id = ?').run(hashToken(token), req.params.id);
    services.events.record('resource', req.params.id, 'resource.token_rotated', {});
    flash(req, 'warning', `New resource token (copy it now): ${token}`);
    res.redirect(returnTo(req, '/resources'));
  });

  router.get('/jobs', (req, res) => {
    const filters = { state: req.query.state || undefined, source: req.query.source || undefined },
      jobs = services.jobs.list({ ...filters, limit: 200 }).map((j) => ({
        ...j,
        resource: j.resource_id ? services.registry.get(j.resource_id) : null
      }));
    res.render('jobs/list', {
      title: 'Jobs',
      active: 'jobs',
      jobs,
      filters,
      canManage: req.session.user.role === 'admin'
    });
  });

  // "Reset" the queue: cancel everything active. "Clean": delete finished
  // job history. Two distinct, deliberately separate destructive actions
  // (§13.1) — reset stops in-flight work, clean clears past work.
  router.post('/jobs/reset-queue', requireAdminRole, (req, res) => {
    const canceled = services.jobs.resetQueue();
    flash(req, 'warning', `Canceled ${canceled} active job(s).`);
    res.redirect('/jobs');
  });

  router.post('/jobs/clean-history', requireAdminRole, (req, res) => {
    const deleted = services.jobs.cleanHistory();
    flash(req, 'warning', `Deleted ${deleted} finished job(s) and their logs/artifacts.`);
    res.redirect('/jobs');
  });

  router.get('/jobs/:id', (req, res) => {
    const job = services.jobs.get(req.params.id);
    if (!job){
      return res.status(404).send('Not found');
    }
    job.resource = job.resource_id ? services.registry.get(job.resource_id) : null;
    const artifacts = services.artifacts.listForJob(job.id).map((a) => ({ ...a, url: services.artifacts.signedUrl(a) })),
      jobActive = ACTIVE_JOB_STATES.has(job.state);
    res.render('jobs/show', {
      title: job.id,
      active: 'jobs',
      job,
      artifacts,
      jobActive,
      canCancel: req.session.user.role === 'admin' && jobActive
    });
  });

  router.post('/jobs/:id/cancel', requireAdminRole, (req, res) => {
    services.jobs.cancel(req.params.id, { isAdmin: true });
    res.redirect(`/jobs/${req.params.id}`);
  });

  // Plain, one-shot fetch — used by the log viewer for a job that's
  // already finished, so it doesn't open a live connection (§SSE) for
  // output that will never change again.
  router.get('/jobs/:id/logs', (req, res) => {
    res.json({ lines: services.logs.listSince(req.params.id, 0) });
  });

  router.get('/jobs/:id/stream', (req, res) => {
    attachJobStream(req, res, { jobId: req.params.id, services, config });
  });

  // Resource groups (§13.1) — their own page since they're a distinct
  // concept from both Resources (which declare membership in their own
  // Client config) and Agents. Viewable by anyone logged in; only admins
  // can create/rename/delete.
  router.get('/groups', (req, res) => {
    const groups = services.groups.list().map((g) => ({
      ...g,
      resourceCount: services.registry.list().filter((r) => r.group_ids.includes(g.id)).length
    }));
    res.render('groups/list', {
      title: 'Groups',
      active: 'groups',
      groups,
      canManage: req.session.user.role === 'admin'
    });
  });

  router.post('/groups', requireAdminRole, (req, res) => {
    services.groups.create({ name: req.body.name, comment: req.body.comment });
    res.redirect('/groups');
  });

  router.post('/groups/:id', requireAdminRole, (req, res) => {
    services.groups.update(req.params.id, { name: req.body.name, comment: req.body.comment });
    res.redirect('/groups');
  });

  router.post('/groups/:id/delete', requireAdminRole, (req, res) => {
    services.groups.remove(req.params.id);
    flash(req, 'warning', 'Group deleted; any resource that listed it just stopped matching on it.');
    res.redirect('/groups');
  });

  router.get('/admin/agents', requireAdminRole, (req, res) => {
    res.render('admin/agents', { title: 'Agents', active: 'agents', agents: services.agents.list() });
  });

  router.post('/admin/agents', requireAdminRole, (req, res) => {
    const { agent, token } = services.agents.create({ name: req.body.name, kind: req.body.kind });
    res.render('admin/agents', { title: 'Agents', active: 'agents', agents: services.agents.list(), newToken: token });
  });

  router.post('/admin/agents/:id/revoke', requireAdminRole, (req, res) => {
    services.agents.revoke(req.params.id);
    res.redirect('/admin/agents');
  });

  return router;
}

module.exports = { createWebRouter };
