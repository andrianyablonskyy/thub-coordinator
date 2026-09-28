-- Set when an admin removes a resource that is running a job: the job is
-- canceled right away, and the resource itself is deleted once its Client
-- confirms the job stopped (next heartbeat with no active job) or after a
-- timeout (heartbeat.js). Meanwhile the scheduler never assigns it work.
ALTER TABLE resources ADD COLUMN remove_requested_at TEXT;
