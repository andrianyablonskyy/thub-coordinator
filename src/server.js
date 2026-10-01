#!/usr/bin/env node

/**
 * @file        packages/coordinator/src/server.js
 * @description Coordinator entry point: wires services, mounts routes, and starts the HTTP server
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
  path = require('node:path'),
  express = require('express'),
  session = require('express-session'),

  { loadConfig } = require('./config'),
  { openDb } = require('./db'),
  { bus } = require('./services/bus'),
  { createEventsService } = require('./services/events'),
  { createRegistryService } = require('./services/registry'),
  { createAgentsService } = require('./services/agents'),
  { createGroupsService } = require('./services/groups'),
  { createAdminUsersService } = require('./services/admin-users'),
  { createJobsService } = require('./services/jobs'),
  { createScheduler } = require('./services/scheduler'),
  { createHeartbeatMonitor } = require('./services/heartbeat'),
  { createLogsService } = require('./services/logs'),
  { createCommandsService } = require('./services/commands'),
  { createRetentionService } = require('./services/retention'),
  { createCleanupService } = require('./services/cleanup'),
  { startDevMode } = require('./dev/virtual'),
  { createUpdatesService } = require('./services/updates'),
  { createLiveService } = require('./services/live'),
  { SqliteSessionStore } = require('./services/session-store'),
  { securityHeaders, sameOriginOnly } = require('./security'),
  { createSettingsService } = require('./services/settings'),
  { createRateLimiter } = require('./rate-limit'),

  { createAgentRouter } = require('./api/agent'),
  { createResourceRouter } = require('./api/resource'),
  { createAdminRouter } = require('./api/admin'),
  { createWebRouter } = require('./web/routes');

// Artifacts are no longer stored on the Coordinator (README §9): an
// upgraded one frees the space the old <dataDir>/artifacts took, once.
function removeLegacyArtifacts(config){
  const dir = path.join(config.dataDir, 'artifacts');
  if (fs.existsSync(dir)){
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Removed ${dir}: the Coordinator no longer stores job artifacts`);
  }
}

function buildServices(config){
  removeLegacyArtifacts(config);
  const db = openDb(config.dbPath),
    // First: dashboard settings (README §13.2) go into `config` before any
    // service reads it — some read theirs only once, at creation.
    settings = createSettingsService(db, { config }).applyAtStartup(),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    groups = createGroupsService(db, { events, registry }),
    adminUsers = createAdminUsersService(db),
    commands = createCommandsService({ bus }),
    logs = createLogsService(db, { bus }),
    jobs = createJobsService(db, { bus, events, registry, config }),
    scheduler = createScheduler(db, { bus, events, registry, config }),
    heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config }),
    retention = createRetentionService(db, { config }),
    cleanup = createCleanupService(db, { jobs, config }),
    updates = createUpdatesService({ config }),
    live = createLiveService(db, { bus, updates }),
    sessionStore = new SqliteSessionStore(db);

  jobs.reconcileOnStartup();
  updates.start();
  cleanup.start();

  const sweepInterval = setInterval(() => {
    jobs.checkAssignAcks();
    jobs.checkTimeouts();
  }, config.heartbeat.sweepIntervalSec * 1000);
  sweepInterval.unref?.();

  return {
    db,
    bus,
    events,
    registry,
    agents,
    groups,
    adminUsers,
    commands,
    jobs,
    logs,
    scheduler,
    heartbeatMonitor,
    retention,
    cleanup,
    updates,
    live,
    sessionStore,
    settings
  };
}

function commonPath(){
  return path.dirname(require.resolve('@andrian.yablonskyy/thub-common/package.json'));
}

function commonVersion(){
  return require('@andrian.yablonskyy/thub-common/package.json').version;
}

// The session cookie's Secure flag (config session.secureCookie, §12).
// "auto": always Secure for an https:// publicUrl — the cookie must never
// travel over plain HTTP there — else express-session's per-request 'auto'
// (Secure on HTTPS connections), so plain-HTTP development still works.
function cookieSecure(config){
  const setting = config.session?.secureCookie ?? 'auto';
  if (setting === true || setting === false){
    return setting;
  }
  return /^https:\/\//i.test(config.publicUrl || '') ? true : 'auto';
}

function createApp(config, services){
  const app = express();
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // CSP, framing, nosniff, Referrer-Policy, HSTS on HTTPS (security.js, §12).
  app.use(securityHeaders);
  app.locals.services = services;
  // Shown in every dashboard page's footer (layout.pug).
  app.locals.coordinatorVersion = require('../package.json').version;
  // The thub-common this process actually loaded (it validates job specs):
  // installs keep the one they got, so it can lag behind — shown on the
  // dashboard and logged at startup to make that visible.
  app.locals.commonVersion = commonVersion();

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: config.sessionSecret,
      // In the SQLite database (services/session-store.js), not in memory:
      // survives restarts, and expired sessions are pruned.
      store: services.sessionStore,
      resave: false,
      saveUninitialized: false,
      // Idle timeout, not a fixed one (§10.1): `rolling` re-sends a fresh
      // Set-Cookie on every response, so the session survives as long as
      // the user stays active and only actually expires `sessionTimeoutMin`
      // (routes.js) after their *last* request. Each user's own preference
      // is applied per-request in web/routes.js, since it isn't known here.
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: cookieSecure(config) }
    })
  );
  // Background requests of the dashboard's live updates (public/js/live.js):
  // the GET /live stream and the page re-fetches it triggers (header
  // X-Thub-Live: 1). They must not count as activity — otherwise an open
  // tab would keep the session alive forever and the idle timeout (§10.1)
  // would never fire — so they don't extend it (`touch` is what `rolling`
  // uses to push the expiry out) and web/routes.js leaves the session alone.
  app.use((req, res, next) => {
    if (req.session && (req.path === '/live' || req.get('X-Thub-Live') === '1')){
      req.thubPassive = true;
      req.session.touch = function (){
        return this;
      };
    }
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/avatars', express.static(config.avatarsDir));
  // Everything below (API, dashboard, sign-in) — static files above aren't
  // counted. Per credential, else per IP (rate-limit.js, §12).
  app.use(createRateLimiter(config, services));

  app.use('/api/v1', createAgentRouter({ services, config }));
  app.use('/api/v1', createResourceRouter({ services, config }));
  // Session-authenticated, like the dashboard: same-origin requests only.
  app.use('/api/v1/admin', sameOriginOnly(config), createAdminRouter({ services }));

  app.use('/', sameOriginOnly(config), createWebRouter({ services, config }));

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500){
      console.error(err);
    }
    if (req.path.startsWith('/api/')){
      return res.status(status).json({ error: err.message });
    }
    res.status(status).send(err.message);
  });

  return app;
}

function start(configPath){
  const config = loadConfig(configPath),
    services = buildServices(config),
    app = createApp(config, services);

  ensureBootstrapAdmin(services);
  // DEV_MODE=1 plus THUB_BOOTSTRAP_ADMIN_PASSWORD only: virtual agent,
  // Clients and jobs to work on the dashboard with (src/dev/virtual.js).
  services.dev = startDevMode(services, config);

  const server = app.listen(config.port, config.host, () => {
    console.log(`Config: ${config.configPath || '(built-in defaults)'}; data: ${config.dataDir}`);
    console.log(`TestHub Coordinator listening on http://${config.host}:${config.port}`);
    console.log(`Coordinator v${require('../package.json').version}, thub-common v${commonVersion()} (${commonPath()})`);
  });

  return { app, server, services, config };
}

// THUB_BOOTSTRAP_ADMIN_PASSWORD is an exceptional password reset, not just
// a first-run convenience (README §13.1): whenever it's set, it wins over
// whatever's in the DB for THUB_BOOTSTRAP_ADMIN_USER (or "admin") — reset
// that user's password if the account exists, or create it fresh as admin
// if it doesn't — on *every* startup, not only when admin_users is empty.
// Unset it again once you're back in; otherwise every restart re-applies
// it. With it unset, login uses whatever's already in the DB, as normal.
function ensureBootstrapAdmin(services){
  const password = process.env.THUB_BOOTSTRAP_ADMIN_PASSWORD;
  if (!password){
    if (services.adminUsers.count() === 0){
      console.warn(
        'No admin_users exist and THUB_BOOTSTRAP_ADMIN_PASSWORD is not set — ' +
          'create one with: thub-admin create-admin <user> <password> (or node bin/thub-admin.js ... from a checkout)'
      );
    }
    return;
  }
  const username = process.env.THUB_BOOTSTRAP_ADMIN_USER || 'admin';
  services.adminUsers.resetPassword({ username, password });
  console.log(`Reset password for admin user "${username}" from THUB_BOOTSTRAP_ADMIN_PASSWORD`);
}

if (require.main === module){
  start();
}

module.exports = { start, buildServices, createApp, cookieSecure };
