-- migration_v4_latency.sql — BUG 2 Latency Fix: Change-ID Deduplication
-- 
-- Adds change_id tracking to sync_events table for idempotent cloud WS push.
-- Prevents duplicate processing when same change arrives via both WebSocket and HTTP.
--
-- Change IDs are deterministic hashes: SHA-256(deviceId|tableName|rowId|hlc)
-- This ensures the same change always gets the same ID, enabling deduplication.

-- Add new columns to sync_events table
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS change_id VARCHAR(64);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS table_name VARCHAR(64);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS row_id INT;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS hlc VARCHAR(128);

-- Create unique index on change_id to prevent duplicate processing
-- Note: MariaDB doesn't support partial indexes, so we index all rows
-- The UNIQUE constraint will allow multiple NULLs (standard SQL behavior)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_change_id 
  ON sync_events(change_id);

-- Add composite index for efficient lookups (only if columns exist)
CREATE INDEX IF NOT EXISTS idx_sync_events_device_table_row 
  ON sync_events(device_id, table_name, row_id);

-- Add index on restaurant_id and change_id for tenant-scoped lookups
CREATE INDEX IF NOT EXISTS idx_sync_events_rid_change 
  ON sync_events(restaurant_id, change_id);

-- Note: Backfilling change_id for existing events is optional
-- New events will have change_id from payload
-- Existing rows will have NULL change_id, which is fine
