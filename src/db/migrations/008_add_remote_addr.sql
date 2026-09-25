-- Address the Coordinator last saw this resource's Client connect from
-- (register or heartbeat) — its external IP from the Coordinator's point
-- of view, shown on the dashboard's resource card next to the Client's own
-- interface addresses (host_info.addresses).
ALTER TABLE resources ADD COLUMN remote_addr TEXT;
