-- Self-update requests (README §10.2): the version an admin asked this
-- Agent / Client to update to, cleared once it reports that version (or
-- newer). NULL = no update pending.
ALTER TABLE agents ADD COLUMN update_to TEXT;
ALTER TABLE resources ADD COLUMN update_to TEXT;
