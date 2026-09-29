-- "Connected USB devices" (resource card tab, README §10): the Client runs
-- `lsusb` only when an admin presses Refresh — a scan-usb command with its
-- next heartbeat — and posts the output back. `usb_scan` is the last result
-- (JSON {output, error, at}); `usb_scan_requested_at`/`_request_id` the
-- pending request, so the tab can tell a fresh result from an old one.
ALTER TABLE resources ADD COLUMN usb_scan TEXT;
ALTER TABLE resources ADD COLUMN usb_scan_requested_at TEXT;
ALTER TABLE resources ADD COLUMN usb_scan_request_id TEXT;
