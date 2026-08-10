-- ─── migration_v2_cloud.sql ────────────────────────────────────────────────
-- Adds HLC, sync_device_id, soft-delete columns to all tenant base tables
-- All operations use the safe ADD-IF-NOT-EXISTS helper procedures.
-- This file is parsed by server.js at startup; it is intentionally idempotent.

-- ── Helper Procedures ────────────────────────────────────────────────────────
DROP PROCEDURE IF EXISTS _add_column_if_not_exists;
CREATE PROCEDURE _add_column_if_not_exists(IN tbl VARCHAR(128), IN col VARCHAR(128), IN def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME  = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END;

DROP PROCEDURE IF EXISTS _add_index_if_not_exists;
CREATE PROCEDURE _add_index_if_not_exists(IN tbl VARCHAR(128), IN idx_name VARCHAR(128), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME  = tbl
      AND INDEX_NAME  = idx_name
  ) THEN
    SET @sql = CONCAT('CREATE INDEX `', idx_name, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END;

-- ── Idempotency / duplicate-event tracking table ─────────────────────────────
CREATE TABLE IF NOT EXISTS sync_events (
  sync_device_id VARCHAR(64)  NOT NULL,
  restaurant_id  INT          NOT NULL,
  processed_at   DATETIME(3)  DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sync_device_id, restaurant_id),
  INDEX idx_sync_events_rid (restaurant_id),
  INDEX idx_sync_events_time (processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── HLC + sync_device_id columns on all base tables ──────────────────────────
-- (sync_device_id: client-assigned UUID per-row, used for idempotent upserts)

CALL _add_column_if_not_exists('_admins_base',                'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_admins_base',                'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_admins_base',                'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_admins_base',                'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_admins_base',                'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_settings_base',          'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_settings_base',          'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_settings_base',          'sync_device_id', 'VARCHAR(64) DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_staff_base',             'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_staff_base',             'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_staff_base',             'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_staff_base',             'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_staff_base',             'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_attendance_base',        'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_attendance_base',        'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_attendance_base',        'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_attendance_base',        'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_attendance_base',        'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_menu_categories_base',   'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_categories_base',   'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_categories_base',   'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_categories_base',   'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_menu_categories_base',   'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_menu_items_base',        'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'deleted_at',     'DATETIME DEFAULT NULL');
-- Field-level HLC for menu_items
CALL _add_column_if_not_exists('_pos_menu_items_base',        'price_hlc',       'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'description_hlc', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'is_available_hlc','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'category_id_hlc', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'cost_price_hlc',  'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'image_path_hlc',  'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'dietary_tags_hlc','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'variants',        'TEXT DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_menu_items_base',        'variants_hlc',    'VARCHAR(64) DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_floors_base',            'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_floors_base',            'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_floors_base',            'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_floors_base',            'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_floors_base',            'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_sections_base',          'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_sections_base',          'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_sections_base',          'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_sections_base',          'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_sections_base',          'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_tables_base',            'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_tables_base',            'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_tables_base',            'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_tables_base',            'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_tables_base',            'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_orders_base',            'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_orders_base',            'deleted_at',     'DATETIME DEFAULT NULL');
-- Field-level HLC for orders
CALL _add_column_if_not_exists('_pos_orders_base',            'status_hlc',     'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'subtotal_hlc',   'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'total_hlc',      'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'notes_hlc',      'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_orders_base',            'rider_name_hlc', 'VARCHAR(64) DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_order_items_base',       'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_order_items_base',       'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_order_items_base',       'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_order_items_base',       'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_order_items_base',       'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_inventory_items_base',   'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'deleted_at',     'DATETIME DEFAULT NULL');
-- Field-level HLC for inventory_items
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'quantity_hlc',       'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'min_threshold_hlc',  'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_items_base',   'cost_per_unit_hlc',  'VARCHAR(64) DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_inventory_log_base',     'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_log_base',     'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_log_base',     'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_inventory_log_base',     'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_inventory_log_base',     'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_expenses_base',          'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_expenses_base',          'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_expenses_base',          'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_expenses_base',          'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_expenses_base',          'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_payroll_base',           'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_payroll_base',           'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_payroll_base',           'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_payroll_base',           'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_payroll_base',           'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_activity_logs_base',     'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_activity_logs_base',     'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_activity_logs_base',     'sync_device_id', 'VARCHAR(64) DEFAULT NULL');

CALL _add_column_if_not_exists('_pos_notifications_base',     'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_notifications_base',     'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_notifications_base',     'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_pos_notifications_base',     'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_pos_notifications_base',     'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_riders_base',                'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_riders_base',                'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_riders_base',                'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_riders_base',                'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_riders_base',                'deleted_at',     'DATETIME DEFAULT NULL');

CALL _add_column_if_not_exists('_tasks_base',                 'hlc',            'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_tasks_base',                 'origin_device_id','VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_tasks_base',                 'sync_device_id', 'VARCHAR(64) DEFAULT NULL');
CALL _add_column_if_not_exists('_tasks_base',                 'is_deleted',     'TINYINT DEFAULT 0');
CALL _add_column_if_not_exists('_tasks_base',                 'deleted_at',     'DATETIME DEFAULT NULL');

-- ── HLC indexes for cursor-paginated export ───────────────────────────────────
CALL _add_index_if_not_exists('_pos_settings_base',         'idx_settings_hlc',       '`hlc`');
CALL _add_index_if_not_exists('_pos_staff_base',            'idx_staff_hlc',          '`hlc`');
CALL _add_index_if_not_exists('_pos_attendance_base',       'idx_attendance_hlc',     '`hlc`');
CALL _add_index_if_not_exists('_pos_menu_categories_base',  'idx_menu_cats_hlc',      '`hlc`');
CALL _add_index_if_not_exists('_pos_menu_items_base',       'idx_menu_items_hlc',     '`hlc`');
CALL _add_index_if_not_exists('_pos_floors_base',           'idx_floors_hlc',         '`hlc`');
CALL _add_index_if_not_exists('_pos_sections_base',         'idx_sections_hlc',       '`hlc`');
CALL _add_index_if_not_exists('_pos_tables_base',           'idx_tables_hlc',         '`hlc`');
CALL _add_index_if_not_exists('_pos_orders_base',           'idx_orders_hlc',         '`hlc`');
CALL _add_index_if_not_exists('_pos_order_items_base',      'idx_order_items_hlc',    '`hlc`');
CALL _add_index_if_not_exists('_pos_inventory_items_base',  'idx_inv_items_hlc',      '`hlc`');
CALL _add_index_if_not_exists('_pos_inventory_log_base',    'idx_inv_log_hlc',        '`hlc`');
CALL _add_index_if_not_exists('_pos_expenses_base',         'idx_expenses_hlc',       '`hlc`');
CALL _add_index_if_not_exists('_pos_payroll_base',          'idx_payroll_hlc',        '`hlc`');
CALL _add_index_if_not_exists('_pos_activity_logs_base',    'idx_activity_hlc',       '`hlc`');
CALL _add_index_if_not_exists('_pos_notifications_base',    'idx_notif_hlc',          '`hlc`');
CALL _add_index_if_not_exists('_riders_base',               'idx_riders_hlc',         '`hlc`');
CALL _add_index_if_not_exists('_tasks_base',                'idx_tasks_hlc',          '`hlc`');
CALL _add_index_if_not_exists('_admins_base',               'idx_admins_hlc',         '`hlc`');
