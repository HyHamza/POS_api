-- migration_v4_atomicity.sql — BUG 3 Atomicity Fix: Transaction Batching
-- 
-- Adds txn_id tracking to sync_events table for atomic transaction processing.
-- Ensures order + order_items sync together, preventing missing items on remote devices.
--
-- Transaction IDs format: `${deviceId}-${timestamp}-${randomSuffix}`
-- All changes in a transaction share the same txn_id for atomic delivery.

-- Add txn_id column to sync_events (transaction batching)
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS txn_id VARCHAR(64);

-- Create index for efficient txn_id lookups
-- Note: MariaDB doesn't support partial indexes (WHERE clause)
CREATE INDEX IF NOT EXISTS idx_sync_events_txn_id 
  ON sync_events(txn_id);

-- Composite index for transaction-aware queries
CREATE INDEX IF NOT EXISTS idx_sync_events_restaurant_txn 
  ON sync_events(restaurant_id, txn_id);

-- Note: No backfill needed - old events already processed
-- New events will have txn_id from payload
