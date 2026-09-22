-- Per-user dashboard profile settings (README §10.1): display name, avatar,
-- timezone (used to render every dashboard timestamp), theme preference
-- (synced across devices instead of living only in browser localStorage),
-- and an idle session timeout the user picks for their own account.
ALTER TABLE admin_users ADD COLUMN first_name TEXT;
ALTER TABLE admin_users ADD COLUMN last_name TEXT;
ALTER TABLE admin_users ADD COLUMN avatar_path TEXT;
ALTER TABLE admin_users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE admin_users ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark'));
ALTER TABLE admin_users ADD COLUMN session_timeout_min INTEGER NOT NULL DEFAULT 60;
