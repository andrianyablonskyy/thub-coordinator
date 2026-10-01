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
  { once } = require('node:events'),
  express = require('express'),
  multer = require('multer'),
  { requireAdminSession, requireAdminRole } = require('../auth'),
  { attachJobStream } = require('../api/sse'),
  {
    RESOURCE_STATES, JOB_STATES, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES, isNewer, compareVersions, formatDateTime, parseDateTime,
    nextCronRun
  } = require('@andrian.yablonskyy/thub-common'),
  { retentionCutoff, JOB_RETENTION } = require('../services/cleanup'),
  listPrefs = require('../services/list-prefs'),
  search = require('../services/search'),
  { createLoginGuard } = require('../login-guard'),
  { formatBytes } = require('../services/job-artifacts'),
  { roleLabel, normalizeRole } = require('../services/admin-users');

// When this process started: the settings page tells a restart happened by it changing.
const STARTED_AT = new Date().toISOString(),
  // Job log viewer: lines per page it loads (and the most one request may ask for).
  LOG_PAGE = 1000,
  LOG_PAGE_MAX = 5000,

  // Resources page sort keys (list-prefs.js) -> comparators. Empty values
  // (never heartbeated, no version reported) sort last in both directions.
  RESOURCE_SORT_VALUE = {
    name: (r) => r.name,
    type: (r) => r.type,
    version: (r) => r.client_version,
    status: (r) => r.status,
    heartbeat: (r) => r.last_heartbeat_at
  },
  compareResourceValues = (sort, a, b) =>
    sort === 'version' ? compareVersions(a, b) : String(a).localeCompare(String(b), undefined, { numeric: true }),
  // Agents page (list-prefs `agents`): never-used / never-reported last.
  AGENT_SORT_VALUE = {
    name: (a) => a.name,
    kind: (a) => a.kind,
    version: (a) => a.version,
    created: (a) => a.created_at,
    used: (a) => a.last_used_at,
    status: (a) => (a.revoked_at ? 'revoked' : 'active')
  },

  // §10.1: avatar uploads are small, single images — a hard size cap and an
  // allow-list of image mimetypes, same spirit as the join-key/token checks
  // elsewhere (reject outright rather than trying to sanitize).
  AVATAR_MAX_BYTES = 2 * 1024 * 1024,
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
  const router = express.Router(),
    loginGuard = createLoginGuard();

  // Shown as a toast (layout.pug): `danger` stays until closed, `warning`
  // closes after 30 s, `info`/`success` after 10 s — unless `sticky`.
  function flash(req, type, text, { sticky = false } = {}){
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text, ...(sticky ? { sticky } : {}) });
  }

  // Where a resource action (maintenance, rotate token) came from — the
  // Resources page or the Overview's resource card. Only a local path,
  // never another site.
  function returnTo(req, fallback){
    const target = req.body.returnTo;
    return typeof target === 'string' && /^\/(?![\/\\])/.test(target) ? target : fallback;
  }

  // A list page's view (§10.1): the user's stored size/sort/dir, overridden
  // by ?size/?sort/?dir — and a change is saved straight to their profile,
  // so it's what they get next time on any device. ?page isn't saved.
  function listView(req, res, list, extraQuery = {}){
    const user = req.session.user,
      { prefs, changed } = listPrefs.fromQuery(list, req.query, user.listPrefs?.[list]);
    if (changed){
      req.session.user = services.adminUsers.setListPrefs(user.id, list, prefs);
      res.locals.user = req.session.user;
    }
    const base = { ...extraQuery, size: prefs.size, sort: prefs.sort, dir: prefs.dir },
      // Link to this list with some params changed; changing size or sort
      // restarts at page 1. Empty params are dropped.
      urlFor = (changes = {}) => {
        const q = { ...base, ...changes };
        if (('size' in changes || 'sort' in changes) && !('page' in changes)){
          delete q.page;
        }
        const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
        return `${req.baseUrl}${req.path}${qs ? `?${qs}` : ''}`;
      };
    return { prefs, urlFor, pageSizes: listPrefs.PAGE_SIZES };
  }

  // What the Clean up database modal shows: current size, the oldest
  // finished job, the retention setting, and quick-pick cutoffs — all
  // formatted in the user's time zone, like the cutoff field itself.
  function cleanupInfo(req){
    const tz = req.session.user.timezone || 'UTC',
      fmt = (d) => formatDateTime(d, { timeZone: tz }),
      now = new Date(),
      oldest = services.db.prepare(
        `SELECT MIN(COALESCE(finished_at, created_at)) AS at FROM jobs
         WHERE state IN (${[...TERMINAL_JOB_STATES].map(() => '?').join(',')})`
      ).get(...TERMINAL_JOB_STATES).at,
      retention = config.retention.jobRetention;
    return {
      size: `${(services.cleanup.databaseBytes() / 1024 / 1024).toFixed(1)} MB`,
      oldestFinished: oldest ? fmt(oldest) : null,
      now: fmt(now),
      retention,
      retentionLabel: JOB_RETENTION[retention]?.label,
      presets: [
        { label: 'Everything (now)', value: fmt(now) },
        ...['1w', '1m', '3m', '6m'].map((k) => ({ label: `Older than ${JOB_RETENTION[k].label}`, value: fmt(retentionCutoff(k, now)) }))
      ]
    };
  }

  // The job each resource is on (if any), for the resource card's Cancel.
  function withActiveJobs(resources){
    return resources.map((r) => ({ ...r, activeJob: services.jobs.activeForResource(r.id) }));
  }

  // Express 5 leaves req.body undefined for a POST without a form body (a
  // browser always sends one; curl or a script may not) — treat it as an
  // empty form rather than crashing every handler that reads a field.
  router.use((req, res, next) => {
    req.body ??= {};
    next();
  });

  router.use((req, res, next) => {
    const user = req.session?.user || null;
    res.locals.user = user;
    // What the signed-in user may do (§10.3): `operate` — the dashboard's
    // actions (maintainer, admin); `admin` — its security features too.
    res.locals.can = { operate: Boolean(user?.canUseDashboard), admin: user?.role === 'admin' };
    res.locals.messages = req.session?.flash || [];
    // Latest published versions (README §10.2) — navbar, Agents, Resources.
    res.locals.updates = services.updates.status();
    // A failed Coordinator self-update: shown to each admin once, as an
    // error toast (never auto-closes) — on a page view, not the polling
    // endpoint or a POST whose redirect would drop it.
    const updateError = res.locals.updates.coordinatorUpdateError;
    if (updateError && user?.role === 'admin' && req.method === 'GET' && req.path !== '/updates/status' && !req.thubPassive &&
      req.session.seenUpdateError !== updateError.at){
      req.session.seenUpdateError = updateError.at;
      res.locals.messages = [
        ...res.locals.messages,
        { type: 'danger', text: `Coordinator update to v${updateError.version} failed: ${updateError.message}` }
      ];
    }
    res.locals.isNewer = isNewer;
    res.locals.nextCronRun = nextCronRun;
    res.locals.formatDateTime = formatDateTime;
    // 1233 -> "1.2 KB" (job artifacts).
    res.locals.fmtBytes = formatBytes;
    // user -> "User" (§10.3): how roles are shown.
    res.locals.roleLabel = roleLabel;
    res.locals.currentPath = req.originalUrl;
    // A live-update re-fetch (server.js, req.thubPassive) renders the page
    // only for its data: flash messages stay for the next real page view.
    if (req.session && !req.thubPassive){
      req.session.flash = [];
    }

    // Every dashboard timestamp is rendered here on the server (Pug), so
    // without this every user would see the *server's* local time — not
    // their own (§10.1). Falls back to UTC for the (rare) pre-login page.
    const tz = user?.timezone || 'UTC';
    // "3d 4h", "5h 12m", "12m 5s", "8s" — resource card uptime/durations.
    res.locals.fmtDuration = (ms) => {
      const s = Math.max(0, Math.floor(ms / 1000)),
        d = Math.floor(s / 86400),
        h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60);
      return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
    };
    // dd/mm/yyyy HH:MM:SS, 24-hour (thub-common formatDateTime) — the one
    // format for every date/time label.
    res.locals.fmtDate = (iso, fallback = '—') => formatDateTime(iso, { timeZone: tz, fallback });
    // Why a Client's config can't be edited or imported on its card
    // (registry.js configSupport, README §10).
    res.locals.noConfigReport = 'this Client is too old to report or apply its config from the dashboard — update it.';
    res.locals.userTimeZone = tz;

    // Idle timeout (§10.1): re-applied on every request (not just login)
    // so a mid-session profile change takes effect immediately, and so
    // `rolling: true` (server.js) actually extends by *this* user's chosen
    // duration each time, not whatever the session happened to start with.
    if (req.session && user && !req.thubPassive){
      req.session.cookie.maxAge = user.sessionTimeoutMin * 60 * 1000;
    }
    if (req.thubPassive){
      res.set('Cache-Control', 'no-store');
    }

    next();
  });

  // A Secure-only session cookie (server.js cookieSecure, §12) is never
  // sent back over plain HTTP, so signing in would just loop back here.
  // Say why instead — usually a proxy not passing X-Forwarded-Proto.
  function httpsProblem(req){
    if (req.session.cookie.secure !== true || req.secure){
      return null;
    }
    return {
      type: 'danger',
      sticky: true,
      text: `Signing in needs HTTPS: this Coordinator's session cookie is sent only over HTTPS (publicUrl is ${config.publicUrl}), ` +
        'but this request reached it as plain HTTP. Open the dashboard through that https:// address; behind a reverse proxy, ' +
        'make it send "X-Forwarded-Proto: https" and check trustProxy. To allow plain HTTP, set session.secureCookie to false.'
    };
  }

  router.get('/login', (req, res) => {
    if (req.session.user){
      return res.redirect('/');
    }
    const problem = httpsProblem(req);
    res.render('login', { title: 'Sign in', ...(problem ? { messages: [problem] } : {}) });
  });

  // Backoff after failed attempts, per IP and per username, checked before
  // any hashing; a cap on password checks running at once (login-guard.js).
  // The answer to a wrong password and to an unknown user is the same, and
  // takes as long (admin-users.js).
  function throttled(res, { reason, retryAfterSec }, what){
    res.set('Retry-After', String(retryAfterSec));
    const text = reason === 'busy'
      ? 'The Coordinator is busy checking other sign-ins — try again in a moment.'
      : `Too many failed ${what} — try again in ${retryAfterSec} s.`;
    return { status: reason === 'busy' ? 503 : 429, text };
  }

  router.post('/login', async (req, res) => {
    const problem = httpsProblem(req);
    if (problem){
      return res.status(400).render('login', { title: 'Sign in', messages: [problem] });
    }
    const { username, password } = req.body,
      allowed = loginGuard.check(req.ip, username);
    if (!allowed.ok){
      const { status, text } = throttled(res, allowed, 'sign-ins');
      return res.status(status).render('login', { title: 'Sign in', messages: [{ type: 'danger', text }] });
    }
    const user = await loginGuard.run(() => services.adminUsers.verify(username, password));
    if (!user){
      loginGuard.failure(req.ip, username);
      return res.status(401).render('login', { title: 'Sign in', messages: [{ type: 'danger', text: 'Invalid credentials' }] });
    }
    loginGuard.success(req.ip, username);
    // Right password, but no dashboard for this account (§10.3).
    if (user.blocked || !user.canUseDashboard){
      return res.status(403).render('login', { title: 'Sign in', messages: [{ type: 'danger', text: user.blocked
        ? 'This account is blocked — ask an admin.'
        : 'This account has no dashboard access — use the Agent with your access key.' }] });
    }
    req.session.user = user;
    req.session.cookie.maxAge = user.sessionTimeoutMin * 60 * 1000;
    res.redirect(user.mustChangePassword ? '/profile' : '/');
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.use(requireAdminSession);
  router.use((req, res, next) => {
    const u = req.session.user;
    res.locals.can = { operate: true, admin: u.role === 'admin' };
    next();
  });

  // §10.1: every logged-in user (admin or viewer) manages their own
  // profile — display name, avatar, timezone, theme and idle session
  // timeout. Not gated by requireAdminRole: this only ever touches the
  // caller's own account (req.session.user.id), never another user's.
  function renderProfile(req, res, extra = {}){
    const key = services.adminUsers.keyOf(req.session.user.id);
    res.render('profile', {
      title: 'Profile',
      timezones: Intl.supportedValuesOf('timeZone'),
      sessionTimeoutOptions: services.adminUsers.SESSION_TIMEOUT_OPTIONS_MIN,
      accessKey: key && !key.revoked_at ? key : null,
      ...extra
    });
  }

  router.get('/profile', (req, res) => renderProfile(req, res));

  // Your own access key (§10.3): created or replaced here, shown once.
  router.post('/profile/key', (req, res) => {
    const { id, username } = req.session.user,
      had = services.adminUsers.keyOf(id),
      key = services.adminUsers.issueKey(id, { by: username });
    renderProfile(req, res, { secret: { key, title: had && !had.revoked_at ? 'Your new access key — the old one has stopped working' : 'Your access key' } });
  });

  router.post('/profile/key/revoke', (req, res) => {
    services.adminUsers.revokeKey(req.session.user.id, { by: req.session.user.username });
    flash(req, 'warning', 'Your access key is revoked.');
    res.redirect('/profile');
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
          ...(req.body.email !== undefined ? { email: req.body.email } : {}),
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
  // The current password is checked like a sign-in: the same backoff, so a
  // stolen session can't be used to guess it.
  router.post('/profile/password', async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body,
      { username } = req.session.user;
    if (newPassword !== confirmPassword){
      flash(req, 'danger', 'New password and confirmation do not match.');
      return res.redirect('/profile');
    }
    const allowed = loginGuard.check(req.ip, username);
    if (!allowed.ok){
      flash(req, 'danger', throttled(res, allowed, 'password checks').text);
      return res.redirect('/profile');
    }
    try {
      await loginGuard.run(() => services.adminUsers.changePassword(req.session.user.id, currentPassword, newPassword));
      loginGuard.success(req.ip, username);
      flash(req, 'success', 'Password changed.');
    }
    catch (err){
      if (err.status === 401){
        loginGuard.failure(req.ip, username);
      }
      flash(req, 'danger', err.message);
    }
    res.redirect('/profile');
  });

  // Live updates (services/live.js, public/js/live.js): which topics
  // changed — `resources`, `agents`, `jobs` — never the data itself; the
  // page re-fetches itself for that, with the same session and templates.
  // A passive request (server.js): it doesn't extend the idle timeout, and
  // it ends with `session-ended` once the session expires or logs out.
  const LIVE_PING_MS = 25_000,
    LIVE_SESSION_CHECK_MS = 15_000;
  router.get('/live', (req, res) => {
    // HEAD (live.js asks it whether the session is still alive): answer and
    // finish. Express sends HEAD to this GET handler, and a stream opened
    // for it would never end: the browser — or a proxy — reuses the
    // connection once the headers are in, and every later request on it
    // would queue behind that response forever (stuck page loads).
    if (req.method === 'HEAD'){
      return res.status(204).end();
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // retry: how soon EventSource reconnects after the connection drops.
    res.write('retry: 5000\n\n');
    write('hello', { topics: services.live.TOPICS });

    const unsubscribe = services.live.subscribe((topics) => write('changed', { topics })),
      // Comment lines keep proxies from timing the idle stream out.
      ping = setInterval(() => res.write(': ping\n\n'), LIVE_PING_MS),
      sessionCheck = setInterval(() => {
        req.sessionStore.get(req.sessionID, (err, sess) => {
          const fresh = sess?.user && services.adminUsers.getById(sess.user.id);
          if (!err && (!fresh || fresh.blocked || !fresh.canUseDashboard)){
            write('session-ended', {});
            res.end();
          }
        });
      }, LIVE_SESSION_CHECK_MS);
    req.on('close', () => {
      unsubscribe();
      clearInterval(ping);
      clearInterval(sessionCheck);
    });
  });

  // Help (views/help/): product guide and setup reference for every
  // signed-in user. Examples use this Coordinator's URL — the configured
  // publicUrl, unless that's still the localhost default and the page was
  // opened from elsewhere.
  router.get('/help', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`,
      coordinatorUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(config.publicUrl || '') ? origin : config.publicUrl;
    res.render('help/index', { title: 'Help', active: 'help', coordinatorUrl: String(coordinatorUrl).replace(/\/+$/, '') });
  });

  router.get('/', (req, res) => {
    const resources = withActiveJobs(services.registry.list()),
      queueLength = services.jobs.list({ state: JOB_STATES.QUEUED, limit: 1000 }).length,
      dayAgo = new Date(Date.now() - 86400 * 1000).toISOString(),
      jobsLast24h = services.jobs
        .list({ limit: 1000 })
        .filter((j) => j.created_at >= dayAgo).length,
      onlineCount = resources.filter((r) => r.status !== RESOURCE_STATES.OUT_OF_SERVICE && r.status !== RESOURCE_STATES.REGISTERED).length,
      groupsById = Object.fromEntries(services.groups.list().map((g) => [g.id, g]));
    res.render('index', { title: 'Overview', active: 'overview', liveTopics: 'resources jobs', resources, queueLength, jobsLast24h, onlineCount, groupsById });
  });

  router.get('/resources', (req, res) => {
    const groupsById = Object.fromEntries(services.groups.list().map((g) => [g.id, g])),
      q = search.normalizeQuery(req.query.q),
      terms = search.parseTerms(q),
      view = listView(req, res, 'resources', { q }),
      { sort, dir, size } = view.prefs,
      value = RESOURCE_SORT_VALUE[sort],
      sorted = services.registry.list().filter((r) => search.matches([
        r.id, r.name, r.reported_name, r.type, r.status, r.busy_source, r.busy_reason, r.client_version, r.remote_addr,
        r.labels, r.group_ids, r.group_ids.map((id) => groupsById[id]?.name),
        r.host_info?.hostname, (r.host_info?.addresses || []).map((a) => a.address)
      ], terms)).sort((a, b) => {
        const va = value(a),
          vb = value(b);
        if (va == null || vb == null){
          return (va == null) - (vb == null);
        }
        return (dir === 'asc' ? 1 : -1) * compareResourceValues(sort, va, vb) || a.name.localeCompare(b.name);
      }),
      pagination = listPrefs.paginate(sorted.length, size, req.query.page),
      pageUrl = (changes) => view.urlFor({ page: pagination.page, ...changes });
    res.render('resources/list', {
      title: 'Resources',
      active: 'resources',
      liveTopics: 'resources',
      resources: withActiveJobs(sorted.slice(pagination.offset, pagination.offset + pagination.limit)),
      groupsById,
      list: { ...view, pagination, pageUrl, q }
    });
  });

  router.post('/resources/:id/maintenance', (req, res) => {
    services.registry.setMaintenance(req.params.id, req.body.enabled === '1');
    res.redirect(returnTo(req, '/resources'));
  });

  // Cancel whatever the Client is doing (resource card): its job, a manual
  // local lock, or a self-update hold (README §10). The Client applies the
  // lock/update ones via heartbeat commands; a job is canceled right here.
  router.post('/resources/:id/cancel-activity', (req, res) => {
    const r = services.registry.get(req.params.id),
      job = r && services.jobs.activeForResource(r.id),
      activity = r?.activity?.state;
    try {
      if (!r){
        throw Object.assign(new Error('Unknown resource'), { status: 404 });
      }
      if (job){
        services.jobs.cancel(job.id, { isAdmin: true });
        flash(req, 'warning', `Canceled job ${job.id} on ${r.name}.`);
      }
      else if (activity === 'locked'){
        services.commands.push(r.id, { command: 'unlock' });
        flash(req, 'warning', `Releasing the local lock on ${r.name} (on its next heartbeat).`);
      }
      else if (activity === 'reboot-hold'){
        services.commands.push(r.id, { command: 'cancel-reboot' });
        flash(req, 'warning', `Canceling the scheduled reboot of ${r.name}'s host (on its next heartbeat).`);
      }
      else if (activity === 'update-hold'){
        services.commands.push(r.id, { command: 'cancel-update' });
        if (r.update_to){
          services.registry.setUpdateTo(r.id, null);
        }
        flash(req, 'warning', `Canceling the self-update on ${r.name}'s host (on its next heartbeat).`);
      }
      else {
        flash(req, 'info', `${r.name} isn't doing anything to cancel.`);
      }
      if (!job && ['locked', 'update-hold', 'reboot-hold'].includes(activity)){
        services.events.record('resource', r.id, 'resource.activity_canceled', { activity, by: req.session.user.username });
      }
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  router.post('/resources/:id/remove', (req, res) => {
    try {
      const { resource: r, pending, stoppedJob, canceledJobs } = services.jobs.removeResource(req.params.id, {
        by: req.session.user.username,
        stopJob: req.body.stopJob === '1'
      });
      flash(
        req,
        'warning',
        pending
          ? `Stopped job ${stoppedJob} on ${r.name}; ${r.name} is removed as soon as its Client confirms the job ended.`
          : `Removed ${r.name}.` + (canceledJobs.length ? `\nCanceled job(s) queued for it: ${canceledJobs.join(', ')}.` : '')
      );
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // Reboot now (resource card footer): cancels a running job, then the
  // Client reboots its host on its next heartbeat (jobs.requestReboot).
  router.post('/resources/:id/reboot', (req, res) => {
    try {
      const { resource: r, canceledJob } = services.jobs.requestReboot(req.params.id, { by: req.session.user.username });
      flash(req, 'warning', `Rebooting ${r.name}'s host on its next heartbeat.` + (canceledJob ? `\nCanceled its running job ${canceledJob}.` : ''));
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // "Connected USB devices" tab (public/js/usb-scan.js): Refresh queues a
  // scan-usb for the Client's next heartbeat; the tab then polls the GET
  // until the answer is in. JSON both ways — the modal stays open.
  function usbScanView(req, r){
    const tz = req.session.user.timezone || 'UTC',
      scan = r.usb_scan;
    return {
      pending: Boolean(r.usb_scan_request_id),
      requestedAt: r.usb_scan_requested_at,
      scan: scan ? { ...scan, atText: formatDateTime(scan.at, { timeZone: tz }) } : null
    };
  }

  router.post('/resources/:id/usb-scan', (req, res) => {
    try {
      services.registry.requestUsbScan(req.params.id, { by: req.session.user.username });
      res.json(usbScanView(req, services.registry.get(req.params.id)));
    }
    catch (err){
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/resources/:id/usb-scan', (req, res) => {
    const r = services.registry.get(req.params.id);
    if (!r){
      return res.status(404).json({ error: 'Unknown resource' });
    }
    res.set('Cache-Control', 'no-store').json(usbScanView(req, r));
  });

  // Rename (resource card, Name row); empty = back to the Client's own name.
  router.post('/resources/:id/rename', (req, res) => {
    try {
      const before = services.registry.get(req.params.id)?.name,
        r = services.registry.rename(req.params.id, req.body.name, { by: req.session.user.username });
      if (r.name !== before){
        flash(req, 'success', `Renamed "${before}" to "${r.name}".` + (r.name_override ? '' : '\nThat\'s the Client\'s own name again.'));
      }
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // Capabilities (resource card, Config tab): public/js/client-config.js
  // sends the edited hw/sw section as JSON in `config`. Applied by the Client
  // on its next heartbeat, then it restarts once idle.
  router.post('/resources/:id/config', (req, res) => {
    try {
      let config;
      try {
        config = JSON.parse(req.body.config || '');
      }
      catch {
        throw Object.assign(new Error('The config form sent no valid JSON — reload the page and try again'), { status: 400 });
      }
      const r = services.registry.setClientConfig(req.params.id, config, { by: req.session.user.username });
      flash(req, 'success', `Capabilities of ${r.name} saved (revision ${r.config_revision}).\n` +
        'The Client applies them on its next heartbeat, then restarts once it has no job running.');
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // Groups tab (resource card): the Client's group membership, as a config
  // revision the Client writes to its file (registry.setClientGroups).
  router.post('/resources/:id/groups', (req, res) => {
    try {
      const ids = [].concat(req.body.groups || []).filter((g) => typeof g === 'string' && g),
        r = services.registry.setClientGroups(req.params.id, ids, {
          by: req.session.user.username,
          knownGroupIds: services.groups.list().map((g) => g.id)
        });
      flash(req, 'success', `Groups of ${r.name} saved: ${r.group_ids.length ? `${r.group_ids.length} group(s)` : 'none'} — in effect now.\n` +
        'The Client writes them to its config file on its next heartbeat, then restarts once it has no job running.');
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // Export (resource card, admins — the file holds the join key): the
  // Client's config file as JSON, secrets excluded.
  router.get('/resources/:id/config/export', (req, res) => {
    try {
      const r = services.registry.get(req.params.id),
        file = services.registry.exportClientConfig(req.params.id);
      res.attachment(`${r.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`).type('application/json').send(JSON.stringify(file, null, 2) + '\n');
    }
    catch (err){
      flash(req, 'danger', err.message);
      res.redirect('/resources');
    }
  });

  // Import (resource card, public/js/config-import.js): a config file, applied
  // by the Client on its next heartbeat like a Config tab Save.
  router.post('/resources/:id/config/import', (req, res) => {
    try {
      let file;
      try {
        file = JSON.parse(req.body.file || '');
      }
      catch (err){
        throw Object.assign(new Error(`${req.body.fileName || 'The file'} isn't valid JSON: ${err.message}`), { status: 400 });
      }
      const { resource: r, ignored } = services.registry.importClientConfig(req.params.id, file, { by: req.session.user.username });
      flash(req, 'success', `Config imported into ${r.name} (revision ${r.config_revision}).\n` +
        'The Client applies it on its next heartbeat, then restarts once it has no job running.' +
        (ignored.length ? `\nIgnored: ${ignored.join(', ')}.` : ''));
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  // Scheduled host reboot (resource card): save a cron expression, or clear
  // it; the Client applies it on its next heartbeat.
  router.post('/resources/:id/reboot-schedule', (req, res) => {
    try {
      const cron = req.body.clear === '1' ? '' : req.body.cron,
        r = services.registry.setRebootSchedule(req.params.id, cron, { by: req.session.user.username });
      flash(req, 'success', r.reboot_schedule
        ? `Reboot schedule for ${r.name} saved: ${r.reboot_schedule}.\nThe Client applies it on its next heartbeat.`
        : `Scheduled reboot for ${r.name} cleared.\nThe Client applies it on its next heartbeat.`);
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/resources'));
  });

  router.post('/resources/:id/rotate-token', requireAdminRole, (req, res) => {
    const { generateToken, hashToken } = require('../services/tokens');
    const token = generateToken('res');
    services.db.prepare('UPDATE resources SET token_hash = ? WHERE id = ?').run(hashToken(token), req.params.id);
    services.events.record('resource', req.params.id, 'resource.token_rotated', {});
    // Sticky: shown only once, so it mustn't close before it's copied.
    flash(req, 'warning', `New resource token (copy it now):\n${token}`, { sticky: true });
    res.redirect(returnTo(req, '/resources'));
  });

  // Self-update (README §10.2). Clients get a `self-update` heartbeat
  // command, Agents update on their next run; both target the latest
  // published version. The Coordinator itself is only ever updated by hand.
  function updateAction(fn){
    return async (req, res) => {
      try {
        // `fn` returns the message, or { type, text } for another severity.
        const result = await fn(req),
          { type, text } = typeof result === 'string' ? { type: 'info', text: result } : result;
        flash(req, type, text);
      }
      catch (err){
        flash(req, 'danger', err.message);
      }
      res.redirect(returnTo(req, '/'));
    };
  }

  // Check now (navbar, Agents and Resources pages): fetch the latest
  // versions, then report whether the Coordinator and the connected
  // (heartbeating) Clients are behind — as a warning if anything is.
  router.post('/updates/check', updateAction(async () => {
    const s = await services.updates.checkNow(),
      parts = [];
    if (!s.fetched.length){
      return { type: 'danger', text: `Update check failed — the npm registry couldn't be reached (${s.error}). Nothing was checked.` };
    }

    parts.push(s.coordinatorUpdate
      ? `Coordinator v${s.coordinatorVersion} → v${s.coordinatorUpdate} available.`
      : `Coordinator is up to date (v${s.coordinatorVersion}).`);

    const connected = services.registry.list().filter((r) => r.status !== RESOURCE_STATES.OUT_OF_SERVICE && r.last_heartbeat_at),
      outdated = connected.filter((r) => r.client_version && isNewer(s.latest.client, r.client_version)),
      unknown = connected.filter((r) => !r.client_version),
      names = (list) => list.slice(0, 5).map((r) => `${r.name}${r.client_version ? ` (v${r.client_version})` : ''}`).join(', ') +
        (list.length > 5 ? `, +${list.length - 5} more` : '');
    if (!s.latest.client){
      parts.push('Latest Client version unknown.');
    }
    else if (!connected.length){
      parts.push('No connected resources.');
    }
    else if (outdated.length){
      parts.push(`${outdated.length} of ${connected.length} connected resource(s) can update to Client v${s.latest.client}: ${names(outdated)}.`);
    }
    else {
      parts.push(`All ${connected.length} connected resource(s) run the latest Client (v${s.latest.client}).`);
    }
    if (unknown.length){
      parts.push(`Version unknown (Client too old to report it): ${names(unknown)}.`);
    }
    if (s.error){
      parts.push(`Some checks failed: ${s.error}`);
    }
    const behind = s.coordinatorUpdate || outdated.length || unknown.length;
    return { type: behind || s.error ? 'warning' : 'success', text: parts.join('\n') };
  }));

  router.post('/updates/coordinator', requireAdminRole, updateAction(async (req) => {
    const version = services.updates.requestCoordinatorUpdate(req.session.user.username);
    console.log(`Coordinator self-update to v${version} requested by ${req.session.user.username}`);
    return `Updating the Coordinator to v${version} — this page reloads by itself once it's back up.`;
  }));

  // Polled by public/js/update-watch.js while a Coordinator update is
  // pending: a new `coordinatorVersion` (the restart happened) or a cleared
  // `pending` (it failed) tells the page to reload.
  router.get('/updates/status', (req, res) => {
    const s = services.updates.status();
    res.set('Cache-Control', 'no-store').json({
      coordinatorVersion: s.coordinatorVersion,
      pending: s.coordinatorPending,
      error: s.coordinatorUpdateError
    });
  });

  router.post('/resources/update-all', updateAction(async () => {
    const version = await services.updates.targetVersion('client'),
      n = services.registry.requestUpdateAll(version);
    return `Requested update to client v${version} on ${n} resource(s).`;
  }));

  router.post('/resources/:id/update', updateAction(async (req) => {
    // Cancel (next to the version): withdraw the request and, if the host is
    // already holding for the update, abort that too (the Client's next
    // heartbeat) — the one control for canceling a Client update.
    if (req.body.cancel === '1'){
      const r = services.registry.get(req.params.id);
      if (!r){
        throw Object.assign(new Error('Unknown resource'), { status: 404 });
      }
      services.registry.setUpdateTo(r.id, null);
      if (r.activity?.state === 'update-hold'){
        services.commands.push(r.id, { command: 'cancel-update' });
        services.events.record('resource', r.id, 'resource.activity_canceled', { activity: 'update-hold', by: req.session.user.username });
        return { type: 'warning', text: `Canceling the self-update on ${r.name}'s host (on its next heartbeat).` };
      }
      return 'Update request canceled.';
    }
    const version = await services.updates.targetVersion('client');
    services.registry.setUpdateTo(req.params.id, version);
    return `Requested update to client v${version} — it starts on the Client's next heartbeat.`;
  }));

  router.post('/admin/agents/update-all', updateAction(async () => {
    const version = await services.updates.targetVersion('agent'),
      n = services.agents.requestUpdateAll(version);
    return `Requested update to agent v${version} for ${n} agent(s) — each updates on its next run.`;
  }));

  router.post('/admin/agents/:id/update', updateAction(async (req) => {
    if (req.body.cancel === '1'){
      services.agents.setUpdateTo(req.params.id, null);
      return 'Update request canceled.';
    }
    const version = await services.updates.targetVersion('agent');
    services.agents.setUpdateTo(req.params.id, version);
    return `Requested update to agent v${version} — it updates on its next run.`;
  }));

  router.get('/jobs', (req, res) => {
    const filters = {
        state: req.query.state || undefined,
        source: req.query.source || undefined,
        q: search.normalizeQuery(req.query.q) || undefined
      },
      view = listView(req, res, 'jobs', filters),
      { rows, pagination } = services.jobs.page({ ...filters, ...view.prefs, page: req.query.page }),
      jobs = rows.map((j) => ({
        ...j,
        resource: j.resource_id ? services.registry.get(j.resource_id) : null,
        active: ACTIVE_JOB_STATES.has(j.state)
      })),
      pageUrl = (changes) => view.urlFor({ page: pagination.page, ...changes });
    res.render('jobs/list', {
      title: 'Jobs',
      active: 'jobs',
      liveTopics: 'jobs',
      jobs,
      filters,
      list: { ...view, pagination, pageUrl, q: filters.q },
      // A row's Cancel comes back to this exact view (filters, sort, page).
      returnTo: pageUrl(),
      canManage: true,
      // For the Reset queue / Clean up database confirmation modals.
      jobCounts: services.jobs.countActiveAndFinished(),
      cleanupInfo: cleanupInfo(req)
    });
  });

  // "Reset" the queue: cancel everything active. "Clean": delete finished
  // job history. Two distinct, deliberately separate destructive actions
  // (§13.1) — reset stops in-flight work, clean clears past work.
  router.post('/jobs/reset-queue', (req, res) => {
    const canceled = services.jobs.resetQueue();
    flash(req, 'warning', `Canceled ${canceled} active job(s).`);
    res.redirect('/jobs');
  });

  // "Clean up database" (§9): everything before the given time — finished
  // jobs with their logs, and older history — then VACUUM. The
  // time is dd/mm/yyyy HH:MM:SS in the user's own time zone.
  router.post('/jobs/clean-history', (req, res) => {
    const tz = req.session.user.timezone || 'UTC',
      text = String(req.body.before || '').trim(),
      before = text ? parseDateTime(text, { timeZone: tz }) : new Date();
    if (!before){
      flash(req, 'danger', `"${text}" isn't a date/time in the dd/mm/yyyy HH:MM:SS format — nothing was deleted.`);
      return res.redirect('/jobs');
    }
    try {
      const r = services.cleanup.cleanup({ before }),
        mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      flash(
        req,
        'warning',
        `Deleted ${r.jobs} finished job(s) and ${r.events} history record(s) from before ` +
          `${formatDateTime(r.before, { timeZone: tz })}.\nDatabase: ${mb(r.bytesBefore)} → ${mb(r.bytesAfter)}.`
      );
    }
    catch (err){
      flash(req, 'danger', `Cleanup failed: ${err.message}`);
    }
    res.redirect('/jobs');
  });

  router.get('/jobs/:id', (req, res) => {
    const job = services.jobs.get(req.params.id);
    if (!job){
      return res.status(404).send('Not found');
    }
    job.resource = job.resource_id ? services.registry.get(job.resource_id) : null;
    const jobActive = ACTIVE_JOB_STATES.has(job.state);
    res.render('jobs/show', {
      title: job.id,
      active: 'jobs',
      job,
      pinnedClient: job.spec.target.client ? services.registry.get(job.spec.target.client) : null,
      waitingReason: job.state === JOB_STATES.QUEUED
        ? services.registry.waitingReason(job.spec.target.type, job.spec.target.labels || [], job.spec.target.group,
          job.spec.target.client)
        : null,
      jobActive,
      canCancel: jobActive
    });
  });

  // From the job page or a row on /jobs (returnTo says which).
  router.post('/jobs/:id/cancel', (req, res) => {
    try {
      services.jobs.cancel(req.params.id, { isAdmin: true });
      flash(req, 'warning', `Canceled job ${req.params.id}.`);
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, `/jobs/${req.params.id}`));
  });

  // The log viewer's pages (public/js/log-viewer.js): the last `limit`
  // lines first, then earlier ones (`before` = the oldest seq it has) as the
  // reader scrolls up. `total` is how many lines the job has in all.
  router.get('/jobs/:id/logs', (req, res) => {
    const before = Number.parseInt(req.query.before, 10),
      limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || LOG_PAGE, 1), LOG_PAGE_MAX),
      page = services.logs.pageBefore(req.params.id, before > 0 ? before : undefined, limit);
    res.json({ ...page, total: services.logs.count(req.params.id) });
  });

  // RAW (log viewer): the whole log as plain text, for a new tab, a
  // download or grep. Streamed in pages, waiting for the socket to drain,
  // so a huge log never sits in memory. Log lines live as long as their job
  // (§9), so this is always the complete log.
  router.get('/jobs/:id/log.txt', async (req, res, next) => {
    try {
      const job = services.jobs.get(req.params.id);
      if (!job){
        return res.status(404).type('text/plain').send('Unknown job');
      }
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        // The log is whatever the job printed: never let a browser sniff it
        // into HTML.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${job.id}.log"`,
        'Cache-Control': 'no-store'
      });
      for (let seq = 0, page; (page = services.logs.listSince(job.id, seq, LOG_PAGE_MAX)).length;){
        const chunk = page.map((l) => `[${l.ts}] [${l.stream}] ${l.line}\n`).join('');
        seq = page.at(-1).seq;
        if (!res.write(chunk)){
          await once(res, 'drain');
        }
        if (res.destroyed){
          return;
        }
      }
      res.end();
    }
    catch (err){
      next(err);
    }
  });

  router.get('/jobs/:id/stream', (req, res) => {
    attachJobStream(req, res, { jobId: req.params.id, services });
  });

  // Resource groups (§13.1) — their own page since they're a distinct
  // concept from both Resources (which declare membership in their own
  // Client config) and Agents. Viewable by anyone logged in; only admins
  // can create/rename/delete.
  router.get('/groups', (req, res) => {
    const q = search.normalizeQuery(req.query.q),
      terms = search.parseTerms(q),
      resources = services.registry.list(),
      all = services.groups.list(),
      groups = all
        .filter((g) => search.matches([g.id, g.name, g.comment], terms))
        .map((g) => ({ ...g, resourceCount: resources.filter((r) => r.group_ids.includes(g.id)).length }));
    res.render('groups/list', {
      title: 'Groups',
      active: 'groups',
      groups,
      q,
      totalCount: all.length,
      canManage: true
    });
  });

  router.post('/groups', (req, res) => {
    services.groups.create({ name: req.body.name, comment: req.body.comment });
    res.redirect('/groups');
  });

  router.post('/groups/:id', (req, res) => {
    services.groups.update(req.params.id, { name: req.body.name, comment: req.body.comment });
    res.redirect('/groups');
  });

  router.post('/groups/:id/delete', (req, res) => {
    services.groups.remove(req.params.id);
    flash(req, 'warning', 'Group deleted; any resource that listed it just stopped matching on it.');
    res.redirect('/groups');
  });

  // Agents page: searched (?q=), sorted and paged like Resources (§10.1).
  // Also what registering one renders, with its token shown once.
  function renderAgents(req, res, extra = {}){
    const q = search.normalizeQuery(req.query.q),
      terms = search.parseTerms(q),
      view = listView(req, res, 'agents', { q }),
      { sort, dir, size } = view.prefs,
      value = AGENT_SORT_VALUE[sort],
      // CI tokens only: a person's key belongs to their user (Users, §10.3).
      sorted = services.agents.list()
        .filter((a) => !a.user_id)
        .filter((a) => search.matches([a.id, a.name, a.kind, a.version, a.revoked_at ? 'revoked' : 'active'], terms))
        .sort((a, b) => {
          const va = value(a),
            vb = value(b);
          if (va == null || vb == null){
            return (va == null) - (vb == null);
          }
          return (dir === 'asc' ? 1 : -1) * compareResourceValues(sort, va, vb) || b.created_at.localeCompare(a.created_at);
        }),
      pagination = listPrefs.paginate(sorted.length, size, req.query.page),
      pageUrl = (changes) => view.urlFor({ page: pagination.page, ...changes });
    res.render('admin/agents', {
      title: 'CI tokens',
      active: 'agents',
      liveTopics: 'agents',
      agents: sorted.slice(pagination.offset, pagination.offset + pagination.limit),
      q,
      list: { ...view, pagination, pageUrl, q },
      ...extra
    });
  }

  // Coordinator settings (services/settings.js, README §13.2): stored in
  // the database over the config file. "Restart now" only under systemd,
  // whose Restart=always brings the process back (INVOCATION_ID is set for
  // every unit it starts); run by hand, exiting would just stop it.
  const canRestart = Boolean(process.env.INVOCATION_ID);

  router.get('/admin/settings', requireAdminRole, (req, res) => {
    const items = services.settings.list(),
      groups = [...new Set(items.map((s) => s.group))].map((name) => ({ name, items: items.filter((s) => s.group === name) }));
    res.render('admin/settings', {
      title: 'Settings',
      active: 'settings',
      groups,
      pendingRestart: items.filter((s) => s.pendingRestart),
      canRestart,
      startedAt: STARTED_AT,
      restarting: req.query.restarting || null,
      readOnly: {
        listen: config.listen,
        dataDir: config.dataDir,
        configPath: config.configPath || '(built-in defaults)'
      }
    });
  });

  router.post('/admin/settings', requireAdminRole, (req, res) => {
    const posted = req.body.s || {},
      changes = {},
      reset = [].concat(req.body.reset || []);
    for (const s of services.settings.SETTINGS){
      if (s.type === 'secret'){
        // Empty means "unchanged": the current secret is never put in the page.
        if (req.body.clear?.[s.key] === '1'){
          changes[s.key] = '';
        }
        else if (posted[s.key]){
          changes[s.key] = posted[s.key];
        }
      }
      else if (s.key in posted){
        // A checkbox posts a hidden "false" and, when checked, "true" after it.
        changes[s.key] = [].concat(posted[s.key]).at(-1);
      }
    }
    try {
      const result = services.settings.save({ changes, reset }, {
        by: req.session.user.username,
        // Don't let an admin lock everyone out: an HTTPS-only cookie
        // can't come back over the plain-HTTP connection they're using.
        guard: (after) => {
          const secureCookie = after['session.secureCookie'],
            httpsOnly = secureCookie === true || (secureCookie === 'auto' && /^https:\/\//i.test(after.publicUrl || ''));
          return httpsOnly && !req.secure
            ? 'Secure session cookie: you\'re connected over plain HTTP, so with this setting nobody could sign in this way ' +
              'after the restart. Open the dashboard over https:// first (behind a proxy: it must send X-Forwarded-Proto: https), ' +
              'or set it to false.'
            : null;
        }
      });
      if (!result.changed.length){
        flash(req, 'info', 'Nothing changed.');
      }
      else {
        const label = (k) => services.settings.SETTINGS.find((s) => s.key === k).label;
        flash(req, result.restart.length ? 'warning' : 'success', [
          result.now.length ? `Saved and applied: ${result.now.map(label).join(', ')}.` : '',
          result.restart.length ? `Saved, applies after a restart: ${result.restart.map(label).join(', ')}.` : ''
        ].filter(Boolean).join('\n'));
      }
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect('/admin/settings');
  });

  router.post('/admin/settings/restart', requireAdminRole, (req, res) => {
    if (!canRestart){
      flash(req, 'danger', 'This Coordinator isn\'t running under systemd, so it can\'t restart itself — restart it by hand.');
      return res.redirect('/admin/settings');
    }
    res.redirect(`/admin/settings?restarting=${encodeURIComponent(STARTED_AT)}`);
    // After the redirect is out; systemd (Restart=always) starts it again.
    res.on('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500));
  });

  // Polled by the settings page while restarting (public/js/settings.js).
  router.get('/admin/settings/status', requireAdminRole, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ startedAt: STARTED_AT });
  });

  // Users (§10.3, admins): accounts, roles, blocking, passwords and each
  // user's access key. A new key or temporary password is shown once, on
  // the page the action returns — never stored anywhere.
  // Searched (?q=), filtered by role (?role=user|maintainer|admin|blocked),
  // sorted and paged like the other lists (§10.1).
  const USER_ROLE_FILTERS = ['admin', 'maintainer', 'user', 'blocked'],
    ROLE_ORDER = { user: 0, maintainer: 1, admin: 2 },
    // What the User column shows: first and last name, else the username.
    userDisplayName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username,
    USER_SORT_VALUE = {
      username: (u) => userDisplayName(u).toLowerCase(),
      role: (u) => ROLE_ORDER[u.role],
      status: (u) => (u.blocked ? 1 : 0),
      used: (u) => u.key?.lastUsedAt || null
    },
    // Who manages whom on Users (§10.3): an admin everyone; a maintainer
    // Agent-only users and their own account. Admins and other maintainers
    // aren't even listed for them, and only an admin gives anyone a
    // dashboard role.
    isAdmin = (actor) => actor.role === 'admin',
    managesUser = (actor, u) => Boolean(u) && (isAdmin(actor) || u.role === 'user' || u.id === actor.id),
    userFiltersFor = (actor) => (isAdmin(actor) ? USER_ROLE_FILTERS : ['user', 'blocked']),
    // The audit log's Action column names changed fields like this.
    FIELD_LABEL = { username: 'username', email: 'email', role: 'role', first_name: 'first name', last_name: 'last name' };

  // The audit log's Action column: what was done, to whom. `nameOf` gives
  // the account's current username (else the one its events recorded).
  function describeUserEvent(e, nameOf){
    const name = nameOf(e.entity_id),
      whose = e.data.by === name ? 'their own' : `${name}'s`;
    switch (e.type){
      case 'user.created': return `Created ${name} (${roleLabel(e.data.role)})`;
      case 'user.updated': {
        const parts = [];
        if (e.data.role?.from){
          parts.push(`role ${roleLabel(e.data.role.from)} → ${roleLabel(e.data.role.to)}`);
        }
        const fields = (e.data.changed || []).filter((f) => f !== 'role').map((f) => FIELD_LABEL[f] || f);
        if (fields.length){
          parts.push(fields.join(', '));
        }
        return `Edited ${name}${parts.length ? `: ${parts.join('; ')}` : ''}`;
      }
      case 'user.blocked': return `Blocked ${name}`;
      case 'user.unblocked': return `Unblocked ${name}`;
      case 'user.deleted': return `Deleted ${name}`;
      case 'user.password_reset': return `Issued a temporary password for ${name}`;
      case 'user.password_set': return `Set ${whose} password`;
      case 'user.password_changed': return `Changed ${whose} password`;
      case 'user.key_created': return `Created ${whose} access key`;
      case 'user.key_rotated': return `Replaced ${whose} access key`;
      case 'user.key_revoked': return `Revoked ${whose} access key`;
      default: return `${e.type.replace('user.', '').replace(/_/g, ' ')} ${name}`;
    }
  }

  // Rows for the audit log: Timestamp, User (who did it — always shown;
  // events from before it was recorded for everything say `system`, or the
  // account itself for its own password change), Action.
  function auditRows(events){
    const names = new Map(services.adminUsers.list().map((u) => [u.id, u.username]));
    for (const e of services.adminUsers.recentEvents(1000)){
      if (!names.has(e.entity_id) && e.data.username){
        names.set(e.entity_id, e.data.username);
      }
    }
    const nameOf = (id) => names.get(id) || id;
    return events.map((e) => ({
      ts: e.ts,
      by: e.data.by || (e.type === 'user.password_changed' ? nameOf(e.entity_id) : 'system'),
      action: describeUserEvent(e, nameOf)
    }));
  }

  // A maintainer's Recent activity: about the users they see, and deleted
  // ones that were Agent-only users when created — nothing about admins or
  // other maintainers.
  function visibleEvents(me, visibleIds){
    const events = services.adminUsers.recentEvents(500),
      existing = new Set(services.adminUsers.list().map((u) => u.id)),
      createdAsUser = new Set(events.filter((e) => e.type === 'user.created' && e.data.role === 'user').map((e) => e.entity_id));
    return events.filter((e) => visibleIds.has(e.entity_id) || (!existing.has(e.entity_id) && createdAsUser.has(e.entity_id))).slice(0, 30);
  }

  function renderUsers(req, res, extra = {}){
    const me = req.session.user,
      filters = userFiltersFor(me),
      q = search.normalizeQuery(req.query.q),
      terms = search.parseTerms(q),
      role = filters.includes(req.query.role) ? req.query.role : undefined,
      view = listView(req, res, 'users', { q, role }),
      { sort, dir, size } = view.prefs,
      value = USER_SORT_VALUE[sort],
      visible = services.adminUsers.list().filter((u) => managesUser(me, u)),
      visibleIds = new Set(visible.map((u) => u.id)),
      searched = visible
        .filter((u) => search.matches([u.username, u.email, u.firstName, u.lastName, u.role, u.blocked ? 'blocked' : 'active'], terms)),
      // Counts for the filter buttons: within the search, before the role filter.
      roleCounts = Object.fromEntries(filters.map((r) => [r, searched.filter((u) => (r === 'blocked' ? u.blocked : u.role === r)).length])),
      sorted = searched
        .filter((u) => !role || (role === 'blocked' ? u.blocked : u.role === role))
        .sort((a, b) => {
          const va = value(a),
            vb = value(b);
          if (va == null || vb == null){
            return (va == null) - (vb == null);
          }
          // Names naturally (dev2 before dev10); other values as they are.
          const cmp = typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : (va < vb ? -1 : va > vb ? 1 : 0);
          return (dir === 'asc' ? 1 : -1) * cmp || a.username.localeCompare(b.username, undefined, { numeric: true });
        }),
      pagination = listPrefs.paginate(sorted.length, size, req.query.page),
      pageUrl = (changes) => view.urlFor({ page: pagination.page, ...changes });
    res.status(extra.status || 200).render('admin/users', {
      title: 'Users',
      active: 'users',
      users: sorted.slice(pagination.offset, pagination.offset + pagination.limit),
      total: searched.length,
      roleFilter: role,
      roleFilters: filters,
      userDisplayName,
      roleCounts,
      list: { ...view, pagination, pageUrl, q },
      q,
      me,
      // The roles this admin or maintainer may give.
      roles: isAdmin(me) ? services.adminUsers.ROLES : ['user'],
      roleHelp: {
        user: 'Agent only: submits jobs, reads their own results; no dashboard',
        maintainer: 'Agent + the dashboard without Settings; manages Agent-only users and CI tokens; sees and cancels every job',
        admin: 'Everything'
      },
      roleTone: { user: 'secondary', maintainer: 'info', admin: 'primary' },
      audit: auditRows(isAdmin(me) ? services.adminUsers.recentEvents(30) : visibleEvents(me, visibleIds)),
      ...extra
    });
  }

  const userAction = (fn) => (req, res) => {
      const actor = req.session.user,
        by = actor.username,
        actorId = actor.id;
      try {
      // Someone this admin or maintainer may not manage answers like an
      // unknown id.
        if (req.params.id && !managesUser(actor, services.adminUsers.getById(req.params.id))){
          throw Object.assign(new Error('Unknown user'), { status: 404 });
        }
        const result = fn(req, { by, actorId, actor });
        if (result?.secret){
          return renderUsers(req, res, { secret: result.secret });
        }
        if (result?.message){
          flash(req, 'success', result.message);
        }
      }
      catch (err){
        flash(req, 'danger', err.message);
      }
      res.redirect(returnTo(req, '/admin/users')); // the same filter, sort and page
    },
    notOwnAccount = (req, { actorId }, what) => {
      if (req.params.id === actorId){
        throw Object.assign(new Error(`You can't ${what} your own account.`), { status: 409 });
      }
    };

  // Users and CI tokens: admins and maintainers (everyone who has a
  // dashboard session), each within managesUser.
  router.get('/admin/users', (req, res) => renderUsers(req, res));

  router.post('/admin/users', userAction((req, ctx) => {
    const { username, email, role, firstName, lastName } = req.body;
    if (!isAdmin(ctx.actor) && normalizeRole(role) !== 'user'){
      throw new Error('Only an admin can create a maintainer or an admin.');
    }
    const
      created = services.adminUsers.create({ username, email, role, firstName, lastName, requireEmail: true }, ctx),
      key = req.body.issueKey === '1' ? services.adminUsers.issueKey(created.id, ctx) : null;
    if (!key && !created.tempPassword){
      return { message: `User ${created.username} created.` };
    }
    return { secret: { title: `User ${created.username} created`, key, password: created.tempPassword, username: created.username } };
  }));

  router.post('/admin/users/:id', userAction((req, ctx) => {
    const { username, email, role, firstName, lastName } = req.body;
    if (!isAdmin(ctx.actor) && role !== undefined && normalizeRole(role) !== services.adminUsers.getById(req.params.id).role){
      throw new Error('Only an admin can change a role.');
    }
    const
      { user, tempPassword } = services.adminUsers.update(req.params.id, { username, email, role, firstName, lastName }, ctx);
    return tempPassword
      ? { secret: { title: `${user.username} can now use the dashboard`, password: tempPassword, username: user.username } }
      : { message: `Saved ${user.username}.` };
  }));

  router.post('/admin/users/:id/block', userAction((req, ctx) => {
    notOwnAccount(req, ctx, 'block');
    const u = services.adminUsers.setBlocked(req.params.id, true, ctx);
    return { message: `Blocked ${u.username}: no sign-in, and their access key stops working.` };
  }));

  router.post('/admin/users/:id/unblock', userAction((req, ctx) => {
    const u = services.adminUsers.setBlocked(req.params.id, false, ctx);
    return { message: `Unblocked ${u.username}.` };
  }));

  router.post('/admin/users/:id/reset-password', userAction((req, ctx) => {
    const u = services.adminUsers.getById(req.params.id),
      password = services.adminUsers.adminResetPassword(req.params.id, ctx);
    return { secret: { title: `New temporary password for ${u.username}`, password, username: u.username } };
  }));

  router.post('/admin/users/:id/key', userAction((req, ctx) => {
    const u = services.adminUsers.getById(req.params.id);
    if (!u){
      throw Object.assign(new Error('Unknown user'), { status: 404 });
    }
    const current = services.adminUsers.keyOf(u.id),
      hadKey = Boolean(current && !current.revoked_at),
      key = services.adminUsers.issueKey(u.id, ctx),
      title = hadKey ? `New access key for ${u.username} — the old one has stopped working` : `Access key for ${u.username}`;
    return { secret: { title, key, username: u.username } };
  }));

  router.post('/admin/users/:id/key/revoke', userAction((req, ctx) => {
    const u = services.adminUsers.getById(req.params.id);
    services.adminUsers.revokeKey(req.params.id, ctx);
    return { message: `Revoked the access key of ${u?.username}.` };
  }));

  router.post('/admin/users/:id/delete', userAction((req, ctx) => {
    notOwnAccount(req, ctx, 'delete');
    const u = services.adminUsers.getById(req.params.id);
    services.adminUsers.remove(req.params.id, ctx);
    return { message: `Deleted ${u?.username}. Their jobs stay, listed under their name.` };
  }));

  router.get('/admin/agents', (req, res) => renderAgents(req, res));

  router.post('/admin/agents', (req, res) => {
    // CI tokens only; people get their key from their user (§10.3).
    const { token } = services.agents.create({ name: req.body.name, kind: 'ci' });
    renderAgents(req, res, { newToken: token });
  });

  router.post('/admin/agents/:id/rename', (req, res) => {
    try {
      const before = services.agents.get(req.params.id)?.name,
        agent = services.agents.rename(req.params.id, req.body.name);
      if (before !== agent.name){
        flash(req, 'success', `Renamed agent "${before}" to "${agent.name}".`);
      }
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, '/admin/agents'));
  });

  router.post('/admin/agents/:id/revoke', (req, res) => {
    services.agents.revoke(req.params.id);
    res.redirect(returnTo(req, '/admin/agents'));
  });

  return router;
}

module.exports = { createWebRouter };
