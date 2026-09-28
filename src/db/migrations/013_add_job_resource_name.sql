-- Name of the resource a job ran on, kept once that resource is removed
-- from the dashboard (registry.remove): jobs.resource_id is then NULLed
-- (it's a foreign key), and this is what the job's history shows instead.
ALTER TABLE jobs ADD COLUMN resource_name TEXT;
