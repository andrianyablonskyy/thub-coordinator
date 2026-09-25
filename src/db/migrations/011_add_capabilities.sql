-- What the Client reported it can drive at registration (README §5.1,
-- §10): its udev devices (with whether each is present), relays and power
-- control for HW, or emulator image and limits for SW. JSON, NULL for
-- Clients too old to report it.
ALTER TABLE resources ADD COLUMN capabilities TEXT;
