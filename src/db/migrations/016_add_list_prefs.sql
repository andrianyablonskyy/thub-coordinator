-- Per-user list view preferences (README §10.1): page size and sort
-- column/direction for each dashboard list, as JSON keyed by page —
-- {"jobs": {"size": 25, "sort": "created", "dir": "desc"}, "resources": {...}}.
-- NULL/missing keys fall back to each page's defaults (services/list-prefs.js).
ALTER TABLE admin_users ADD COLUMN list_prefs TEXT;
