-- Scheduled host reboot per Client (README §10): a 5-field cron expression
-- in the Client host's local time, set on the resource card. `reboot_schedule`
-- is what an admin saved; `reboot_schedule_applied` what the Client last
-- reported applying — while they differ, every heartbeat reply carries a
-- set-reboot-schedule command (api/resource.js). NULL = no scheduled reboot.
ALTER TABLE resources ADD COLUMN reboot_schedule TEXT;
ALTER TABLE resources ADD COLUMN reboot_schedule_applied TEXT;
