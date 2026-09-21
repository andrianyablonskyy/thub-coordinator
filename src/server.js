'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { bus } = require('./services/bus');
const { createEventsService } = require('./services/events');
const { createRegistryService } = require('./services/registry');
const { createAgentsService } = require('./services/agents');
const { createAdminUsersService } = require('./services/admin-users');
const { createJobsService } = require('./services/jobs');
const { createScheduler } = require('./services/scheduler');
const { createHeartbeatMonitor } = require('./services/heartbeat');
const { createLogsService } = require('./services/logs');
const { createArtifactsService } = require('./services/artifacts');
const { createCommandsService } = require('./services/commands');
const { createRetentionService } = require('./services/retention');

const { createAgentRouter } = require('./api/agent');
const { createResourceRouter } = require('./api/resource');
const { createAdminRouter } = require('./api/admin');
const { createWebRouter } = require('./web/routes');

function buildServices(config) {
  const db = openDb(config.dbPath);
  const events = createEventsService(db);
  const registry = createRegistryService(db, { bus, events });
  const agents = createAgentsService(db, { events });
  const adminUsers = createAdminUsersService(db);
  const commands = createCommandsService({ bus });
  const jobs = createJobsService(db, { bus, events, registry, config });
  const logs = createLogsService(db, { bus });
  const artifacts = createArtifactsService(db, { config });
  const scheduler = createScheduler(db, { bus, events, registry, config });
  const heartbeatMonitor = createHeartbeatMonitor(db, { bus, events, registry, jobs, config });
  const retention = createRetentionService(db, { bus, logs, artifacts, config });

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
    adminUsers,
    commands,
    jobs,
    logs,
    artifacts,
    scheduler,
    heartbeatMonitor,
    retention,
  };
}

function createApp(config, services) {
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
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/v1', createAgentRouter({ services, config }));
  app.use('/api/v1', createResourceRouter({ services, config }));
  app.use('/api/v1/admin', createAdminRouter({ services }));

  // HMAC-signed artifact downloads (§3.1, §12) — no session or bearer token.
  app.get('/artifacts/download/:token', (req, res, next) => {
    try {
      const artifact = services.artifacts.verify(req.params.token);
      res.download(artifact.path, artifact.name);
    } catch (err) {
      next(err);
    }
  });

  app.use('/', createWebRouter({ services, config }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });
    res.status(status).send(err.message);
  });

  return app;
}

function start(configPath) {
  const config = loadConfig(configPath);
  const services = buildServices(config);
  const app = createApp(config, services);

  ensureBootstrapAdmin(services, config);

  const server = app.listen(config.port, config.host, () => {
    console.log(`TestHub Coordinator listening on http://${config.host}:${config.port}`);
  });

  return { app, server, services, config };
}

function ensureBootstrapAdmin(services, config) {
  if (services.adminUsers.count() > 0) return;
  const username = process.env.THUB_BOOTSTRAP_ADMIN_USER || 'admin';
  const password = process.env.THUB_BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) {
    console.warn(
      'No admin_users exist and THUB_BOOTSTRAP_ADMIN_PASSWORD is not set — ' +
        'create one with: node packages/coordinator/bin/thub-admin.js create-admin <user> <password>'
    );
    return;
  }
  services.adminUsers.create({ username, password, role: 'admin' });
  console.log(`Bootstrapped admin user "${username}" from THUB_BOOTSTRAP_ADMIN_PASSWORD`);
}

if (require.main === module) {
  start();
}

module.exports = { start, buildServices, createApp };
