-- Deleting a CI token (dashboard): its token stops working and it leaves the
-- CI tokens list, but the row stays — its jobs reference it and keep its name.
ALTER TABLE agents ADD COLUMN deleted_at TEXT;
