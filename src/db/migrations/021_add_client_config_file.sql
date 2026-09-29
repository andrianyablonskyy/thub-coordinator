-- Client config Export / Import (README §10, resource card Actions).
-- `client_config_file` is the Client's whole config file as it last
-- reported it at registration, its secrets (artifactory.token,
-- sw.registryAuth) left out. `config_import` is an imported file's fields
-- beyond the hw/sw section, as JSON { revision, fields }: sent with every
-- set-config until the Client reports applying that revision.
ALTER TABLE resources ADD COLUMN client_config_file TEXT;
ALTER TABLE resources ADD COLUMN config_import TEXT;
