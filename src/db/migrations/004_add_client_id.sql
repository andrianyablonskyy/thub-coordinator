-- Stable per-Client identity (a UUID a Client generates once and persists
-- in its .client-id file, README §5.1/§8.6), separate from `name` so a
-- Client can rename/retype itself on restart and still be recognized as
-- the same resource (registry.registerAuto matches on this, not name).
-- Nullable: resources created before this existed have no client_id and
-- get adopted by name on that Client's next registration.
ALTER TABLE resources ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_resources_client_id ON resources(client_id) WHERE client_id IS NOT NULL;
