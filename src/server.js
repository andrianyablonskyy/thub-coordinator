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

const path = require('node:path'),
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
  { createArtifactsService } = require('./services/artifacts'),
  { createCommandsService } = require('./services/commands'),
  { createRetentionService } = require('./services/retention'),

  { createAgentRouter } = require('./api/agent'),
  { createResourceRouter } = require('./api/resource'),
  { createAdminRouter } = require('./api/admin'),
  { createWebRouter } = require('./web/routes');

function buildServices(config){
  const db = openDb(config.dbPath),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    groups = createGroupsService(db, { events, registry }),
    adminUsers = createAdminUsersService(db),
    commands = createCommandsService({ bus }),
    logs = createLogsService(db, { bus }),
    artifacts = createArtifactsService(db, { config }),
    jobs = createJobsService(db, { bus, events, registry, artifacts, config }),
    scheduler = createScheduler(db, { bus, events, registry, config }),
    heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config }),
    retention = createRetentionService(db, { bus, logs, artifacts, config });

  jobs.reconcileOnStartup();

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
    artifacts,
    scheduler,
    heartbeatMonitor,
    retention
  };
}

function createApp(config, services){
  const app = express();
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.services = services;

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      // Idle timeout, not a fixed one (§10.1): `rolling` re-sends a fresh
      // Set-Cookie on every response, so the session survives as long as
      // the user stays active and only actually expires `sessionTimeoutMin`
      // (routes.js) after their *last* request. Each user's own preference
      // is applied per-request in web/routes.js, since it isn't known here.
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax' }
    })
  );
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/avatars', express.static(config.avatarsDir));

  app.use('/api/v1', createAgentRouter({ services, config }));
  app.use('/api/v1', createResourceRouter({ services, config }));
  app.use('/api/v1/admin', createAdminRouter({ services }));

  // HMAC-signed artifact downloads (§3.1, §12) — no session or bearer token.
  app.get('/artifacts/download/:token', (req, res, next) => {
    try {
      const artifact = services.artifacts.verify(req.params.token);
      res.download(artifact.path, artifact.name);
    }
    catch (err){
      next(err);
    }
  });

  app.use('/', createWebRouter({ services, config }));

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

  const server = app.listen(config.port, config.host, () => {
    console.log(`Config: ${config.configPath || '(built-in defaults)'}; data: ${config.dataDir}`);
    console.log(`TestHub Coordinator listening on http://${config.host}:${config.port}`);
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

module.exports = { start, buildServices, createApp };
