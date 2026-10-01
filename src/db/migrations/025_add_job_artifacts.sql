-- Artifacts a finished job reports (services/job-artifacts.js): metadata
-- only — name, size, a download link elsewhere, a time — as a JSON array.
-- The files themselves never reach the Coordinator (README §7.3, §9).
ALTER TABLE jobs ADD COLUMN artifacts TEXT;
