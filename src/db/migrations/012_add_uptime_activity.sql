-- Reported on every heartbeat (README §10), converted to the
-- Coordinator's clock: when the Client's host booted (host uptime), and
-- what the Client is doing since when (JSON {state, jobId, since}; state
-- idle | job | locked | update-hold) for the "Task / status" duration.
-- NULL for Clients too old to report them.
ALTER TABLE resources ADD COLUMN host_booted_at TEXT;
ALTER TABLE resources ADD COLUMN activity TEXT;
