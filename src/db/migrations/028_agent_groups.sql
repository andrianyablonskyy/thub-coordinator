-- The resource group an agent's jobs run in (§13.1), set on the dashboard
-- only — no longer `thub run --group`: a user's (Users, kept across key
-- rotations) or a CI token's (CI tokens). NULL: any resource.
ALTER TABLE users ADD COLUMN group_id TEXT;
ALTER TABLE agents ADD COLUMN group_id TEXT;
