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
  {
    RESOURCE_STATES, JOB_STATES, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES, isNewer, compareVersions, formatDateTime, parseDateTime,
    nextCronRun
  } = require('@andrian.yablonskyy/thub-common'),
  { retentionCutoff, JOB_RETENTION } = require('../services/cleanup'),
  listPrefs = require('../services/list-prefs');

// Resources page sort keys (list-prefs.js) -> comparators. Empty values
// (never heartbeated, no version reported) sort last in both directions.
const RESOURCE_SORT_VALUE = {
    name: (r) => r.name,
    type: (r) => r.type,
    version: (r) => r.client_version,
    status: (r) => r.status,
    heartbeat: (r) => r.last_heartbeat_at
  },
  compareResourceValues = (sort, a, b) =>
    sort === 'version' ? compareVersions(a, b) : String(a).localeCompare(String(b), undefined, { numeric: true }),

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
  const router = express.Router();

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
    res.locals.messages = req.session?.flash || [];
    // Latest published versions (README §10.2) — navbar, Agents, Resources.
    res.locals.updates = services.updates.status();
    // A failed Coordinator self-update: shown to each admin once, as an
    // error toast (never auto-closes) — on a page view, not the polling
    // endpoint or a POST whose redirect would drop it.
    const updateError = res.locals.updates.coordinatorUpdateError;
    if (updateError && user?.role === 'admin' && req.method === 'GET' && req.path !== '/updates/status' &&
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
    res.locals.currentPath = req.originalUrl;
    if (req.session){
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
    res.locals.userTimeZone = tz;

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
      return res.status(401).render('login', { title: 'Sign in', messages: [{ type: 'danger', text: 'Invalid credentials' }] });
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
    const resources = withActiveJobs(services.registry.list()),
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
    const groupsById = Object.fromEntries(services.groups.list().map((g) => [g.id, g])),
      view = listView(req, res, 'resources'),
      { sort, dir, size } = view.prefs,
      value = RESOURCE_SORT_VALUE[sort],
      sorted = services.registry.list().sort((a, b) => {
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
      resources: withActiveJobs(sorted.slice(pagination.offset, pagination.offset + pagination.limit)),
      groupsById,
      list: { ...view, pagination, pageUrl }
    });
  });

  router.post('/resources/:id/maintenance', requireAdminRole, (req, res) => {
    services.registry.setMaintenance(req.params.id, req.body.enabled === '1');
    res.redirect(returnTo(req, '/resources'));
  });

  // Cancel whatever the Client is doing (resource card): its job, a manual
  // local lock, or a self-update hold (README §10). The Client applies the
  // lock/update ones via heartbeat commands; a job is canceled right here.
  router.post('/resources/:id/cancel-activity', requireAdminRole, (req, res) => {
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

  router.post('/resources/:id/remove', requireAdminRole, (req, res) => {
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
  router.post('/resources/:id/reboot', requireAdminRole, (req, res) => {
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

  router.post('/resources/:id/usb-scan', requireAdminRole, (req, res) => {
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
  router.post('/resources/:id/rename', requireAdminRole, (req, res) => {
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
  router.post('/resources/:id/config', requireAdminRole, (req, res) => {
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

  // Scheduled host reboot (resource card): save a cron expression, or clear
  // it; the Client applies it on its next heartbeat.
  router.post('/resources/:id/reboot-schedule', requireAdminRole, (req, res) => {
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
  router.post('/updates/check', requireAdminRole, updateAction(async () => {
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

  router.post('/resources/update-all', requireAdminRole, updateAction(async () => {
    const version = await services.updates.targetVersion('client'),
      n = services.registry.requestUpdateAll(version);
    return `Requested update to client v${version} on ${n} resource(s).`;
  }));

  router.post('/resources/:id/update', requireAdminRole, updateAction(async (req) => {
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

  router.post('/admin/agents/update-all', requireAdminRole, updateAction(async () => {
    const version = await services.updates.targetVersion('agent'),
      n = services.agents.requestUpdateAll(version);
    return `Requested update to agent v${version} for ${n} agent(s) — each updates on its next run.`;
  }));

  router.post('/admin/agents/:id/update', requireAdminRole, updateAction(async (req) => {
    if (req.body.cancel === '1'){
      services.agents.setUpdateTo(req.params.id, null);
      return 'Update request canceled.';
    }
    const version = await services.updates.targetVersion('agent');
    services.agents.setUpdateTo(req.params.id, version);
    return `Requested update to agent v${version} — it updates on its next run.`;
  }));

  router.get('/jobs', (req, res) => {
    const filters = { state: req.query.state || undefined, source: req.query.source || undefined },
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
      jobs,
      filters,
      list: { ...view, pagination, pageUrl },
      // A row's Cancel comes back to this exact view (filters, sort, page).
      returnTo: pageUrl(),
      canManage: req.session.user.role === 'admin',
      // For the Reset queue / Clean up database confirmation modals.
      jobCounts: req.session.user.role === 'admin' ? services.jobs.countActiveAndFinished() : null,
      cleanupInfo: req.session.user.role === 'admin' ? cleanupInfo(req) : null
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

  // "Clean up database" (§9): everything before the given time — finished
  // jobs with their logs/artifacts, and older history — then VACUUM. The
  // time is dd/mm/yyyy HH:MM:SS in the user's own time zone.
  router.post('/jobs/clean-history', requireAdminRole, (req, res) => {
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
    const artifacts = services.artifacts.listForJob(job.id).map((a) => ({ ...a, url: services.artifacts.signedUrl(a) })),
      jobActive = ACTIVE_JOB_STATES.has(job.state);
    res.render('jobs/show', {
      title: job.id,
      active: 'jobs',
      job,
      pinnedClient: job.spec.target.client ? services.registry.get(job.spec.target.client) : null,
      waitingReason: job.state === JOB_STATES.QUEUED
        ? services.registry.waitingReason(job.spec.target.type, job.spec.target.labels || [], job.spec.target.group,
          job.spec.target.client, { jobImage: Boolean(job.spec.image) })
        : null,
      artifacts,
      jobActive,
      canCancel: req.session.user.role === 'admin' && jobActive
    });
  });

  // From the job page or a row on /jobs (returnTo says which).
  router.post('/jobs/:id/cancel', requireAdminRole, (req, res) => {
    try {
      services.jobs.cancel(req.params.id, { isAdmin: true });
      flash(req, 'warning', `Canceled job ${req.params.id}.`);
    }
    catch (err){
      flash(req, 'danger', err.message);
    }
    res.redirect(returnTo(req, `/jobs/${req.params.id}`));
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

  router.post('/admin/agents/:id/rename', requireAdminRole, (req, res) => {
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
    res.redirect('/admin/agents');
  });

  router.post('/admin/agents/:id/revoke', requireAdminRole, (req, res) => {
    services.agents.revoke(req.params.id);
    res.redirect('/admin/agents');
  });

  return router;
}

module.exports = { createWebRouter };
