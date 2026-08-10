-- File: POS_api/migration_v3_cashier.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration V3: Cashier & Dispatcher Features
-- Adds payment tracking fields to orders table
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Add payment tracking columns ────────────────────────────────────────────
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received', 'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received_at', 'DATETIME DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received_by', 'INT DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received_hlc', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received_at_hlc', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base', 'payment_received_by_hlc', 'VARCHAR(64) DEFAULT NULL');

-- ── Add foreign key constraint ──────────────────────────────────────────────
-- Note: This will fail silently if constraint already exists
SET @sql = '
  ALTER TABLE _pos_orders_base 
  ADD CONSTRAINT fk_payment_staff 
  FOREIGN KEY (payment_received_by) 
  REFERENCES _pos_staff_base(id) 
  ON DELETE SET NULL
';

-- Check if constraint exists before adding
SET @constraint_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS 
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND CONSTRAINT_NAME = 'fk_payment_staff'
    AND TABLE_NAME = '_pos_orders_base'
);

SET @sql = IF(@constraint_exists = 0, @sql, 'SELECT "Foreign key already exists" AS message');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── Add index for payment queries ───────────────────────────────────────────
CALL _add_idx('_pos_orders_base', 'idx_orders_payment', 'payment_received, payment_received_at');

-- ── Migrate legacy order statuses ───────────────────────────────────────────
-- Convert old "preparing" and "ready" statuses to new "ready_for_dispatch"
UPDATE _pos_orders_base 
SET status = 'ready_for_dispatch' 
WHERE status IN ('preparing', 'ready');

-- ── Recreate pos_orders view to include new columns ─────────────────────────
CREATE OR REPLACE VIEW pos_orders AS SELECT * FROM _pos_orders_base WHERE restaurant_id = current_restaurant_id();
