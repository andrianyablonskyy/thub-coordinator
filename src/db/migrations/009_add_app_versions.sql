-- App version each Agent / Client last reported (User-Agent header
-- "thub-agent/<version>" / "thub-client/<version>"), shown on the
-- dashboard's Agents page and resource card (README §10).
ALTER TABLE agents ADD COLUMN version TEXT;
ALTER TABLE resources ADD COLUMN client_version TEXT;
