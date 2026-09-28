-- How long a finished job ran (README §9): seconds from started_at (RUNNING)
-- to finished_at, computed once when it reaches a terminal state
-- (jobs.setState) and shown instead of the finish time. NULL for a job
-- that never ran (e.g. canceled while queued). finished_at itself stays:
-- log/artifact retention is keyed on it. Backfilled for existing jobs.
ALTER TABLE jobs ADD COLUMN duration_sec INTEGER;
UPDATE jobs
   SET duration_sec = MAX(0, CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400) AS INTEGER))
 WHERE finished_at IS NOT NULL AND started_at IS NOT NULL;
