-- Client capabilities edited from the dashboard (README §10, resource card
-- Config tab). `client_config` is the editable part of the Client's config
-- (its hw or sw section, secrets excluded) as it last reported it at
-- registration; `config_desired` is what an admin saved, at
-- `config_revision`. While the Client reports an older applied revision
-- (`config_applied_revision`), every heartbeat reply carries a set-config
-- command. `config_error` is why it last refused one (NULL: none).
ALTER TABLE resources ADD COLUMN client_config TEXT;
ALTER TABLE resources ADD COLUMN config_desired TEXT;
ALTER TABLE resources ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN config_applied_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN config_error TEXT;
