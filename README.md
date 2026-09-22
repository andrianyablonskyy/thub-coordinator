# @andrian.yablonskyy/thub-coordinator

The Coordinator component of [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. The Coordinator owns the job queue, the resource registry, the scheduler, log/artifact storage and the web dashboard. It's the one component you self-host on a reachable server; the [Agent](https://github.com/andrianyablonskyy/thub-agent) and [Client](https://github.com/andrianyablonskyy/thub-client) both talk to it over HTTPS and don't need to be anywhere near it.

See the [main TestHub repo](https://github.com/andrianyablonskyy/thub) for the full system architecture, deployment diagrams, and how this fits together with the Agent and Client.

## Install

```bash
npm install -g @andrian.yablonskyy/thub-coordinator
```

This gives you two global commands: `thub-coordinator` (the server itself) and `thub-admin` (the local operator CLI, below). Or clone this repo directly and run it from source (see below).

## Configuration

The Coordinator loads a plain **JSON** config file (no YAML support). Resolution order, first match wins: `THUB_COORDINATOR_CONFIG` env var path → `~/.config/thub/coordinator.json` → the bundled `config.json` default.

```json
{
  "listen": "127.0.0.1:8080",
  "publicUrl": "https://thub.example.com",
  "dataDir": "/var/lib/thub",
  "sessionSecret": "change-me-to-a-long-random-string",
  "clientJoinKey": "change-me-to-a-long-random-string",
  "heartbeat": { "intervalSec": 10, "missedLimit": 3, "sweepIntervalSec": 5 },
  "scheduler": { "assignAckTimeoutSec": 15, "requeueOnLost": true, "maxQueuedPerAgent": 20, "tickIntervalSec": 10 },
  "jobs": { "defaultTimeoutSec": 1800, "maxTimeoutSec": 14400 },
  "retention": { "logRetentionDays": 14, "artifactRetentionDays": 30 },
  "artifacts": { "maxUploadMb": 512, "linkTtlHours": 168 }
}
```

`sessionSecret` signs the dashboard's session cookie and the HMAC on artifact download links; `clientJoinKey` is the shared secret Clients self-register with — omit or leave `null` to disable auto-registration entirely. Individual `THUB_LISTEN` / `THUB_PUBLIC_URL` / `THUB_DATA_DIR` / `THUB_SESSION_SECRET` / `THUB_CLIENT_JOIN_KEY` env vars override whatever the file set.

`npm install -g` creates `~/.config/thub/coordinator.json` for you if it doesn't already exist, with a home-anchored `dataDir` and a freshly generated random `sessionSecret` (not the placeholder above) — a re-install never overwrites it or regenerates the secret. Set `publicUrl` and `clientJoinKey` yourself before relying on auto-registration.

## Running it

```bash
# First run: no admin_users row exists yet, so either set a bootstrap
# password (creates user "admin") or use thub-admin afterwards.
THUB_COORDINATOR_CONFIG=/etc/thub/coordinator.json \
THUB_BOOTSTRAP_ADMIN_PASSWORD=correct-horse-battery-staple \
thub-coordinator
# -> Reset password for admin user "admin" from THUB_BOOTSTRAP_ADMIN_PASSWORD
# -> TestHub Coordinator listening on http://127.0.0.1:8080
```

`thub-coordinator` is the global command from `npm install -g`; from a local checkout of this repo it's `node src/server.js` or `npm start`/`npm run dev` (auto-restart on change) — all equivalent, all reading config the same way (above).

`THUB_BOOTSTRAP_ADMIN_PASSWORD` is more than a first-run convenience — it's an **exceptional password reset**, checked on every startup, not only when `admin_users` is empty. Whenever it's set, the named account (`THUB_BOOTSTRAP_ADMIN_USER`, default `admin`) has its password forced to it — creating that user as `admin` if it doesn't exist yet, or just resetting the password (never the role) if it does. With it unset, login uses whatever's already in the DB, as normal — unset it again once you're back in, or every subsequent restart re-applies it.

## `thub-admin` — the local operator CLI

Talks to the Coordinator's SQLite database directly — no running server required, and no HTTP auth of its own, so it's meant to be run on the Coordinator host itself. `thub-admin` is the global command from `npm install -g`; from a local checkout it's `node bin/thub-admin.js`:

```bash
# Create additional dashboard users (first one can also come from
# THUB_BOOTSTRAP_ADMIN_PASSWORD above).
thub-admin create-admin alice s3cret --role admin

# Register a CI or developer identity — the only credential still issued
# by an admin; the token is shown once.
thub-admin agent add ci-firmware --kind ci
# -> Agent agt_... created. Token (shown once): agt_...

# Mint the shared secret Clients use to self-register, and put it in both
# the Coordinator's clientJoinKey and every Client's joinKey.
thub-admin join-key generate

# Take a resource out of rotation without an active job (or bring it back).
thub-admin resource maintenance res_abc123 --on

# Cancel every queued/assigned/preparing/running job.
thub-admin jobs reset --yes

# Permanently delete every finished job, plus its logs and artifacts on disk.
thub-admin jobs clean --yes

# Resource groups: constrain which resources a job can schedule onto.
thub-admin group add ci-nightly --comment "shared CI pool"
thub-admin group list
thub-admin group remove <groupId>
```

Both `jobs reset` and `jobs clean` refuse to run without `--yes` — there's no undo for either, especially `clean`.

## API

All endpoints are under `/api/v1`, JSON, and require `Authorization: Bearer <token>` (the dashboard is a separate session-based auth path).

**Agent endpoints** (used by [thub-agent](https://github.com/andrianyablonskyy/thub-agent)):

| Method | Path | Description |
|---|---|---|
| `POST` | `/jobs` | Submit a job spec. Returns `201 {jobId, state, webUrl}`. |
| `GET` | `/jobs/:id` | Job details and current state. |
| `GET` | `/jobs?state=&source=&limit=` | List jobs. |
| `POST` | `/jobs/:id/cancel` | Cancel a job (owner or admin). |
| `GET` | `/jobs/:id/logs?after=<seq>&limit=` | Paged log lines (polling fallback). |
| `GET` | `/jobs/:id/logs/stream` | Server-Sent Events: `log`, `state`, `end`. Honors `Last-Event-ID` for resume. |
| `GET` | `/jobs/:id/artifacts` | Artifact list with signed download URLs. |
| `GET` | `/resources` | Resources with status (read-only). |

**Resource (Client) endpoints** (used by [thub-client](https://github.com/andrianyablonskyy/thub-client)):

| Method | Path | Description |
|---|---|---|
| `POST` | `/resources/register` | Self-register (every start/restart) using the shared `clientJoinKey`; upserts by `clientId`. |
| `POST` | `/resources/:id/heartbeat` | Heartbeat and self-reported state; response may carry `commands[]`. |
| `POST` | `/resources/:id/status` | Explicit status change, e.g. a local lock. |
| `GET` | `/resources/:id/jobs/next?wait=30` | Long-poll for an assigned job; `204` when nothing arrived within `wait` seconds. |
| `POST` | `/jobs/:id/accept` | Acknowledge assignment. |
| `POST` | `/jobs/:id/state` | Progress: `PREPARING`, `RUNNING`, plus optional `message`. |
| `POST` | `/jobs/:id/logs` | Batch of log lines. |
| `POST` | `/jobs/:id/artifacts` | Multipart upload of result files. |
| `POST` | `/jobs/:id/result` | Final verdict `{state, exitCode, summary}`. |

**Admin endpoints** (dashboard-session-authenticated, not bearer tokens): `/admin/agents`, `/admin/resources/:id/maintenance`, `/admin/resources/:id/rotate-token`, `/admin/jobs/reset-queue`, `/admin/jobs/clean-history`, `/admin/groups`.

## Web dashboard

Server-rendered Pug templates styled with Bootstrap 5.3, with a little vanilla JavaScript for live updates via the same SSE endpoints the Agent uses.

| Page | Content |
|---|---|
| `/` | Resource cards by status, queue length, jobs in the last 24 h. |
| `/resources` | Type, labels, groups, status, busy source/reason, last heartbeat age; admin maintenance/rotate-token actions. |
| `/groups` | Resource groups — id/name/comment, member count; admin create/rename/delete. Membership itself is set per-resource in the Client's own config. |
| `/jobs` | Filterable job list (state, source, resource), with the job's `user` label if set; admin **Reset queue** / **Clean history**. |
| `/jobs/:id` | Spec, timeline, live log viewer with stream filter, artifact downloads, cancel button. |
| `/admin/agents` | Register/revoke CI and developer agents; token shown once. |
| `/profile` | Every logged-in user's own account settings: display name, avatar, timezone (renders every dashboard timestamp), theme, idle session timeout, password change. |

## Data storage

SQLite via `better-sqlite3`, WAL mode. Schema migrations are plain numbered SQL files in `src/db/migrations/`, applied automatically at startup. `job_logs` rows are compacted into `artifacts/<jobId>/console.log` when a job finishes and deleted after `logRetentionDays`; artifacts are deleted after `artifactRetentionDays`. See the [main repo's ER diagram](https://github.com/andrianyablonskyy/thub#9-data-storage-sqlite) for the full schema.

## Security notes

- No inbound exposure needed for Clients — they connect outbound only.
- Tokens (agent, resource) are 256-bit random, stored as SHA-256 hashes, shown once, revocable.
- A resource token can only act on its own resource and jobs assigned to it; an agent can cancel only its own jobs unless admin.
- Job specs contain no shell commands — only the fixed entry point of a downloaded test package is ever executed.
- Artifact downloads are HMAC-signed URLs with expiry.
- Every state change is written to the `events` table and visible on the dashboard.

## Development

```bash
npm install
npm test    # node --test test/*.test.js
npm run lint
```

## License

Proprietary — see the header comment in each source file.
