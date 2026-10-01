-- A Client's reported config file is kept for Export (README §10), but
-- never its credentials: drop the joinKey copies stored before that.
UPDATE resources SET client_config_file = json_remove(client_config_file, '$.joinKey')
  WHERE client_config_file IS NOT NULL AND json_extract(client_config_file, '$.joinKey') IS NOT NULL;
