-- Renaming a Client from the dashboard (README §10): `name_override` is the
-- name an admin gave it, which registrations keep using (a Client presents
-- its own name — config `name` or systemd instance — on every start, which
-- would otherwise undo the rename). `reported_name` is that own name, shown
-- as a hint and restored by clearing the override. NULL: no override.
ALTER TABLE resources ADD COLUMN name_override TEXT;
ALTER TABLE resources ADD COLUMN reported_name TEXT;
