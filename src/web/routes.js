'use strict';

const express = require('express');
const { requireAdminSession, requireAdminRole } = require('../auth');
const { attachJobStream } = require('../api/sse');
const { RESOURCE_STATES, JOB_STATES, ACTIVE_JOB_STATES } = require('@thub/shared');

// §10 Web dashboard: server-rendered Pug + Bootstrap 5.3, with the live
// views hitting the same kind of SSE stream the Agent uses (§6.4), just
// authenticated by session cookie instead of a bearer token.
function createWebRouter({ services, config }) {
  const router = express.Router();

  function flash(req, type, text) {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  }

  router.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    res.locals.messages = req.session?.flash || [];
    if (req.session) req.session.flash = [];
    next();
  });

  router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { title: 'Sign in' });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = services.adminUsers.verify(username, password);
    if (!user) return res.status(401).render('login', { title: 'Sign in', error: 'Invalid credentials' });
    req.session.user = user;
    res.redirect('/');
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.use(requireAdminSession);

  router.get('/', (req, res) => {
    const resources = services.registry.list();
    const queueLength = services.jobs.list({ state: JOB_STATES.QUEUED, limit: 1000 }).length;
    const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    const jobsLast24h = services.jobs
      .list({ limit: 1000 })
      .filter((j) => j.created_at >= dayAgo).length;
    const onlineCount = resources.filter((r) => r.status !== RESOURCE_STATES.OUT_OF_SERVICE && r.status !== RESOURCE_STATES.REGISTERED).length;
    res.render('index', { title: 'Overview', active: 'overview', resources, queueLength, jobsLast24h, onlineCount });
  });

  router.get('/resources', (req, res) => {
    res.render('resources/list', { title: 'Resources', active: 'resources', resources: services.registry.list() });
  });

  router.post('/resources/:id/maintenance', requireAdminRole, (req, res) => {
    services.registry.setMaintenance(req.params.id, req.body.enabled === '1');
    res.redirect('/resources');
  });

  router.post('/resources/:id/rotate-token', requireAdminRole, (req, res) => {
    const { generateToken, hashToken } = require('../services/tokens');
    const token = generateToken('res');
    services.db.prepare('UPDATE resources SET token_hash = ? WHERE id = ?').run(hashToken(token), req.params.id);
    services.events.record('resource', req.params.id, 'resource.token_rotated', {});
    flash(req, 'warning', `New resource token (copy it now): ${token}`);
    res.redirect('/resources');
  });

  router.get('/jobs', (req, res) => {
    const filters = { state: req.query.state || undefined, source: req.query.source || undefined };
    const jobs = services.jobs.list({ ...filters, limit: 200 }).map((j) => ({
      ...j,
      resource: j.resource_id ? services.registry.get(j.resource_id) : null,
    }));
    res.render('jobs/list', {
      title: 'Jobs',
      active: 'jobs',
      jobs,
      filters,
      canManage: req.session.user.role === 'admin',
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
    if (!job) return res.status(404).send('Not found');
    job.resource = job.resource_id ? services.registry.get(job.resource_id) : null;
    const artifacts = services.artifacts.listForJob(job.id).map((a) => ({ ...a, url: services.artifacts.signedUrl(a) }));
    const jobActive = ACTIVE_JOB_STATES.has(job.state);
    res.render('jobs/show', {
      title: job.id,
      active: 'jobs',
      job,
      artifacts,
      jobActive,
      canCancel: req.session.user.role === 'admin' && jobActive,
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
