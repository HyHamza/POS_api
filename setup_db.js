/**
 * setup_db.js — One-shot database setup script
 * Run with: node setup_db.js
 *
 * Creates all missing tables, columns, indexes, views, triggers, and functions.
 * Safe to run multiple times — fully idempotent.
 */

'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const cfg = {
  host:     process.env.DB_HOST || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pos',
  multipleStatements: false,
};

async function run() {
  const conn = await mysql.createConnection(cfg);
  console.log(`Connected to MySQL at ${cfg.host}:${cfg.port}/${cfg.database}`);

  // Helper: add column if it doesn't exist
  async function addCol(table, col, def) {
    const [rows] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    if (rows.length === 0) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
      console.log(`  + ${table}.${col}`);
    }
  }

  // Helper: add index if it doesn't exist
  async function addIdx(table, idxName, cols) {
    const [rows] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, idxName]
    );
    if (rows.length === 0) {
      await conn.query(`CREATE INDEX \`${idxName}\` ON \`${table}\` (${cols})`);
      console.log(`  + index ${idxName} on ${table}`);
    }
  }

  // Helper: check if table exists
  async function tableExists(table) {
    const [rows] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    return rows.length > 0;
  }

  // ── Step 1: Core registry tables ────────────────────────────────────────────
  console.log('\n[1/6] Creating core registry tables...');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      license_key VARCHAR(255) NOT NULL UNIQUE,
      status      VARCHAR(50)  DEFAULT 'active',
      plan_type   VARCHAR(50)  DEFAULT 'lifetime',
      expires_at  DATETIME     DEFAULT NULL,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS sync_events (
      sync_device_id VARCHAR(64) NOT NULL,
      restaurant_id  INT         NOT NULL,
      change_id      VARCHAR(64) DEFAULT NULL,
      device_id      VARCHAR(64) DEFAULT NULL,
      table_name     VARCHAR(64) DEFAULT NULL,
      row_id         INT         DEFAULT NULL,
      hlc            VARCHAR(128) DEFAULT NULL,
      txn_id         VARCHAR(64) DEFAULT NULL,
      processed_at   DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (sync_device_id, restaurant_id),
      INDEX idx_sync_events_rid  (restaurant_id),
      INDEX idx_sync_events_time (processed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('  Core tables OK');

  // ── Step 2: Tenant base tables ───────────────────────────────────────────────
  console.log('\n[2/6] Creating tenant base tables...');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _admins_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      username      VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      email         VARCHAR(255),
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admins (restaurant_id, username),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_settings_base (
      restaurant_id INT          NOT NULL,
      \`key\`       VARCHAR(255) NOT NULL,
      \`value\`     TEXT,
      PRIMARY KEY (restaurant_id, \`key\`),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_roles_base (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id    INT          NOT NULL,
      name             VARCHAR(100) NOT NULL,
      description      VARCHAR(255) DEFAULT NULL,
      is_system        TINYINT      DEFAULT 0,
      is_deleted       TINYINT      DEFAULT 0,
      deleted_at       DATETIME     DEFAULT NULL,
      hlc              VARCHAR(64)  DEFAULT NULL,
      origin_device_id VARCHAR(64)  DEFAULT NULL,
      sync_device_id   VARCHAR(64)  DEFAULT NULL,
      UNIQUE KEY uq_roles (restaurant_id, name),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_permissions_base (
      id               VARCHAR(100) NOT NULL,
      restaurant_id    INT          NOT NULL,
      label            VARCHAR(100) NOT NULL,
      \`desc\`           VARCHAR(255) DEFAULT NULL,
      category         VARCHAR(100) NOT NULL,
      parent_id        VARCHAR(100) DEFAULT NULL,
      is_deleted       TINYINT      DEFAULT 0,
      deleted_at       DATETIME     DEFAULT NULL,
      hlc              VARCHAR(64)  DEFAULT NULL,
      origin_device_id VARCHAR(64)  DEFAULT NULL,
      sync_device_id   VARCHAR(64)  DEFAULT NULL,
      PRIMARY KEY (restaurant_id, id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_role_permissions_base (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id    INT          NOT NULL,
      role_id          INT          NOT NULL,
      permission_id    VARCHAR(100) NOT NULL,
      is_deleted       TINYINT      DEFAULT 0,
      deleted_at       DATETIME     DEFAULT NULL,
      hlc              VARCHAR(64)  DEFAULT NULL,
      origin_device_id VARCHAR(64)  DEFAULT NULL,
      sync_device_id   VARCHAR(64)  DEFAULT NULL,
      UNIQUE KEY uq_role_perm (restaurant_id, role_id, permission_id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id)       REFERENCES _pos_roles_base(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_staff_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      name          VARCHAR(255) NOT NULL,
      username      VARCHAR(255) NOT NULL,
      pin_hash      VARCHAR(255) NOT NULL,
      role          VARCHAR(50)  NOT NULL DEFAULT 'Waiter',
      phone         VARCHAR(50),
      email         VARCHAR(255),
      hire_date     DATE,
      salary_type   VARCHAR(50)  DEFAULT 'Monthly',
      salary_amount DOUBLE       DEFAULT 0,
      status        VARCHAR(50)  DEFAULT 'Active',
      permissions   TEXT         DEFAULT NULL,
      daily_duty_hours INT       DEFAULT 8,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_staff (restaurant_id, username),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_attendance_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT      NOT NULL,
      staff_id      INT      NOT NULL,
      clock_in      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      clock_out     DATETIME,
      date          DATE     NOT NULL,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (staff_id)      REFERENCES _pos_staff_base(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_menu_categories_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      name          VARCHAR(255) NOT NULL,
      display_order INT          DEFAULT 0,
      is_visible    TINYINT      DEFAULT 1,
      UNIQUE KEY uq_menu_cat (restaurant_id, name),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_menu_items_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      category_id   INT,
      name          VARCHAR(255) NOT NULL,
      description   TEXT,
      price         DOUBLE       NOT NULL DEFAULT 0,
      cost_price    DOUBLE       DEFAULT 0,
      image_path    VARCHAR(255),
      dietary_tags  TEXT,
      variants      TEXT,
      is_available  TINYINT      DEFAULT 1,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id)   REFERENCES _pos_menu_categories_base(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_floors_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      name          VARCHAR(255) NOT NULL,
      display_order INT          DEFAULT 0,
      UNIQUE KEY uq_floor (restaurant_id, name),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_sections_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      floor_id      INT          NOT NULL,
      name          VARCHAR(255) NOT NULL,
      display_order INT          DEFAULT 0,
      UNIQUE KEY uq_section (restaurant_id, floor_id, name),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (floor_id)      REFERENCES _pos_floors_base(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_tables_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          DEFAULT NULL,
      number        VARCHAR(255) NOT NULL,
      capacity      INT          DEFAULT 4,
      status        VARCHAR(50)  DEFAULT 'available',
      section_id    INT          DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_orders_base (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id    INT          NOT NULL,
      order_number     VARCHAR(255) NOT NULL,
      type             VARCHAR(50)  NOT NULL DEFAULT 'Dine-In',
      table_id         INT,
      staff_id         INT,
      customer_name    VARCHAR(255),
      customer_phone   VARCHAR(255),
      customer_address TEXT,
      status           VARCHAR(50)  NOT NULL DEFAULT 'pending',
      subtotal         DOUBLE       DEFAULT 0,
      tax              DOUBLE       DEFAULT 0,
      discount         DOUBLE       DEFAULT 0,
      total            DOUBLE       DEFAULT 0,
      notes            TEXT,
      rider_name       VARCHAR(255) DEFAULT NULL,
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_order (restaurant_id, order_number),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (table_id)      REFERENCES _pos_tables_base(id) ON DELETE SET NULL,
      FOREIGN KEY (staff_id)      REFERENCES _pos_staff_base(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_order_items_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      order_id      INT          NOT NULL,
      menu_item_id  INT,
      name          VARCHAR(255) NOT NULL,
      price         DOUBLE       NOT NULL,
      quantity      INT          NOT NULL DEFAULT 1,
      notes         TEXT,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id)      REFERENCES _pos_orders_base(id) ON DELETE CASCADE,
      FOREIGN KEY (menu_item_id)  REFERENCES _pos_menu_items_base(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_inventory_items_base (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id    INT          NOT NULL,
      name             VARCHAR(255) NOT NULL,
      category         VARCHAR(255) DEFAULT 'General',
      unit             VARCHAR(50)  DEFAULT 'pieces',
      quantity         DOUBLE       DEFAULT 0,
      min_threshold    DOUBLE       DEFAULT 10,
      cost_per_unit    DOUBLE       DEFAULT 0,
      supplier_name    VARCHAR(255),
      supplier_contact VARCHAR(255),
      updated_at       DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_inv (restaurant_id, name),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_inventory_log_base (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id   INT    NOT NULL,
      item_id         INT    NOT NULL,
      change_type     VARCHAR(50)  NOT NULL,
      quantity_change DOUBLE       NOT NULL,
      reason          TEXT,
      staff_id        INT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id)       REFERENCES _pos_inventory_items_base(id) ON DELETE CASCADE,
      FOREIGN KEY (staff_id)      REFERENCES _pos_staff_base(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_expenses_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      category      VARCHAR(255) NOT NULL DEFAULT 'Other',
      description   TEXT,
      amount        DOUBLE       NOT NULL DEFAULT 0,
      staff_id      INT,
      receipt_path  VARCHAR(255),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (staff_id)      REFERENCES _pos_staff_base(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_payroll_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT  NOT NULL,
      staff_id      INT  NOT NULL,
      period_start  DATE NOT NULL,
      period_end    DATE NOT NULL,
      base_salary   DOUBLE  DEFAULT 0,
      days_present  INT     DEFAULT 0,
      advances      DOUBLE  DEFAULT 0,
      deductions    DOUBLE  DEFAULT 0,
      overtime_hours DOUBLE DEFAULT 0,
      overtime_salary DOUBLE DEFAULT 0,
      net_pay       DOUBLE  DEFAULT 0,
      status        VARCHAR(50) DEFAULT 'Pending',
      paid_at       DATETIME,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (staff_id)      REFERENCES _pos_staff_base(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_activity_logs_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT NOT NULL,
      user_id       VARCHAR(255),
      user_type     VARCHAR(50),
      user_name     VARCHAR(255),
      section       VARCHAR(100),
      action_type   VARCHAR(100),
      description   TEXT,
      metadata      TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_notifications_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT          NOT NULL,
      type          VARCHAR(50)  NOT NULL DEFAULT 'info',
      title         VARCHAR(255) NOT NULL,
      message       TEXT,
      is_read       TINYINT      DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _pos_customers_base (
      id               VARCHAR(64) PRIMARY KEY,
      restaurant_id    INT NULL DEFAULT NULL,
      phone            VARCHAR(32) NOT NULL,
      name             VARCHAR(255) DEFAULT NULL,
      address          TEXT DEFAULT NULL,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const createIfNotExists = async (sql) => {
    try { await conn.query(sql); }
    catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERROR' && !e.message.includes('Tablespace for table')) {
        throw e;
      }
    }
  };

  await createIfNotExists(`
    CREATE TABLE IF NOT EXISTS _pos_system_logs_base (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id   INT          NOT NULL,
      device_type     VARCHAR(50)  NOT NULL,
      endpoint        VARCHAR(255) NOT NULL,
      method          VARCHAR(10)  NOT NULL,
      status_code     INT,
      error_details   TEXT,
      request_payload TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _riders_base (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id      INT          DEFAULT NULL,
      username           VARCHAR(255) NOT NULL,
      password_hash      VARCHAR(255) NOT NULL,
      full_name          VARCHAR(255) NOT NULL,
      phone              VARCHAR(255),
      status             VARCHAR(50)  DEFAULT 'offline',
      is_active          TINYINT      DEFAULT 1,
      fcm_token          VARCHAR(255) DEFAULT NULL,
      refresh_token_hash VARCHAR(64)  DEFAULT NULL,
      created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _rider_latest_location_base (
      rider_id      INT PRIMARY KEY,
      restaurant_id INT DEFAULT NULL,
      latitude      DECIMAL(10,8),
      longitude     DECIMAL(11,8),
      speed         DOUBLE DEFAULT 0,
      heading       DOUBLE DEFAULT 0,
      accuracy      DOUBLE DEFAULT 0,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _rider_locations_base (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id INT DEFAULT NULL,
      rider_id      INT NOT NULL,
      latitude      DECIMAL(10,8),
      longitude     DECIMAL(11,8),
      speed         DOUBLE DEFAULT 0,
      heading       DOUBLE DEFAULT 0,
      accuracy      DOUBLE DEFAULT 0,
      recorded_at   TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _rider_sessions_base (
      rider_id      INT PRIMARY KEY,
      restaurant_id INT          DEFAULT NULL,
      socket_id     VARCHAR(255) NOT NULL,
      connected_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS _tasks_base (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      restaurant_id    INT          DEFAULT NULL,
      rider_id         INT,
      customer_name    VARCHAR(255) NOT NULL,
      customer_phone   VARCHAR(255),
      delivery_address TEXT         NOT NULL,
      delivery_lat     DECIMAL(10,8),
      delivery_lng     DECIMAL(11,8),
      order_details    TEXT,
      order_number     VARCHAR(255) DEFAULT NULL,
      status           VARCHAR(50)  DEFAULT 'pending',
      assigned_at      DATETIME,
      accepted_at      DATETIME,
      delivered_at     DATETIME,
      created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('  Tenant base tables OK');

  // ── Step 3: Add any missing columns ─────────────────────────────────────────
  console.log('\n[3/6] Adding missing columns...');

  // Sync / HLC columns on all tables
  const syncTables = [
    '_admins_base', '_pos_settings_base', '_pos_staff_base', '_pos_attendance_base',
    '_pos_menu_categories_base', '_pos_menu_items_base', '_pos_floors_base',
    '_pos_sections_base', '_pos_tables_base', '_pos_orders_base', '_pos_order_items_base',
    '_pos_inventory_items_base', '_pos_inventory_log_base', '_pos_expenses_base',
    '_pos_payroll_base', '_pos_activity_logs_base', '_pos_notifications_base',
    '_riders_base', '_tasks_base', '_pos_customers_base',
  ];

  for (const t of syncTables) {
    if (!(await tableExists(t))) { console.warn(`  SKIP (missing): ${t}`); continue; }
    await addCol(t, 'hlc',              'VARCHAR(64) DEFAULT NULL');
    await addCol(t, 'origin_device_id', 'VARCHAR(64) DEFAULT NULL');
    await addCol(t, 'sync_device_id',   'VARCHAR(64) DEFAULT NULL');
    // soft-delete (not on settings)
    if (t !== '_pos_settings_base') {
      await addCol(t, 'is_deleted', 'TINYINT DEFAULT 0');
      await addCol(t, 'deleted_at', 'DATETIME DEFAULT NULL');
    }
  }

  // Field-level HLC columns
  const fieldHlc = {
    _pos_menu_items_base:     ['price','description','is_available','category_id','cost_price','image_path','dietary_tags','variants'],
    _pos_orders_base:         ['status','subtotal','total','notes','rider_name','edit_count','is_return'],
    _pos_inventory_items_base:['quantity','min_threshold','cost_per_unit'],
  };
  for (const [t, fields] of Object.entries(fieldHlc)) {
    if (!(await tableExists(t))) continue;
    for (const f of fields) {
      await addCol(t, `${f}_hlc`, 'VARCHAR(64) DEFAULT NULL');
    }
  }

  // Extra one-off columns
  await addCol('sync_events',      'change_id',          'VARCHAR(64) DEFAULT NULL');
  await addCol('sync_events',      'device_id',          'VARCHAR(64) DEFAULT NULL');
  await addCol('sync_events',      'table_name',         'VARCHAR(64) DEFAULT NULL');
  await addCol('sync_events',      'row_id',             'INT DEFAULT NULL');
  await addCol('sync_events',      'hlc',                'VARCHAR(128) DEFAULT NULL');
  await addCol('sync_events',      'txn_id',             'VARCHAR(64) DEFAULT NULL');
  await addCol('_tasks_base',      'order_number',       'VARCHAR(255) DEFAULT NULL');
  await addCol('_pos_orders_base', 'rider_name',         'VARCHAR(255) DEFAULT NULL');
  await addCol('_pos_orders_base', 'edit_count',         'INT DEFAULT 0');
  await addCol('_pos_orders_base', 'is_return',          'TINYINT DEFAULT 0');
  await addCol('_pos_staff_base',  'permissions',        'TEXT DEFAULT NULL');
  await addCol('_pos_staff_base',  'role_id',            'INT DEFAULT NULL');
  await addCol('_riders_base',     'refresh_token_hash', 'VARCHAR(64) DEFAULT NULL');
  await addCol('restaurants',      'plan_type',          "VARCHAR(50) DEFAULT 'lifetime'");
  await addCol('restaurants',      'expires_at',         'DATETIME DEFAULT NULL');
  await addCol('restaurants',      'active_server_id',   "VARCHAR(50) DEFAULT NULL");
  await addCol('restaurants',      'active_server_epoch',"INT DEFAULT 0");

  console.log('  Columns OK');

  // ── Step 4: HLC indexes ──────────────────────────────────────────────────────
  console.log('\n[4/6] Adding HLC indexes...');
  const hlcIndexes = [
    ['_pos_settings_base',        'idx_settings_hlc',    '`hlc`'],
    ['_pos_roles_base',           'idx_roles_hlc',       '`hlc`'],
    ['_pos_permissions_base',     'idx_permissions_hlc', '`hlc`'],
    ['_pos_role_permissions_base', 'idx_role_perms_hlc',  '`hlc`'],
    ['_pos_staff_base',           'idx_staff_hlc',       '`hlc`'],
    ['_pos_attendance_base',      'idx_attendance_hlc',  '`hlc`'],
    ['_pos_menu_categories_base', 'idx_menu_cats_hlc',   '`hlc`'],
    ['_pos_menu_items_base',      'idx_menu_items_hlc',  '`hlc`'],
    ['_pos_floors_base',          'idx_floors_hlc',      '`hlc`'],
    ['_pos_sections_base',        'idx_sections_hlc',    '`hlc`'],
    ['_pos_tables_base',          'idx_tables_hlc',      '`hlc`'],
    ['_pos_orders_base',          'idx_orders_hlc',      '`hlc`'],
    ['_pos_order_items_base',     'idx_order_items_hlc', '`hlc`'],
    ['_pos_inventory_items_base', 'idx_inv_items_hlc',   '`hlc`'],
    ['_pos_inventory_log_base',   'idx_inv_log_hlc',     '`hlc`'],
    ['_pos_expenses_base',        'idx_expenses_hlc',    '`hlc`'],
    ['_pos_payroll_base',         'idx_payroll_hlc',     '`hlc`'],
    ['_pos_activity_logs_base',   'idx_activity_hlc',    '`hlc`'],
    ['_pos_notifications_base',   'idx_notif_hlc',       '`hlc`'],
    ['_pos_customers_base',       'idx_customers_hlc',   '`hlc`'],
    ['_riders_base',              'idx_riders_hlc',      '`hlc`'],
    ['_tasks_base',               'idx_tasks_hlc',       '`hlc`'],
    ['_admins_base',              'idx_admins_hlc',      '`hlc`'],
  ];
  for (const [t, idx, cols] of hlcIndexes) {
    if (await tableExists(t)) await addIdx(t, idx, cols);
  }

  // Indexes for sync_events
  await addIdx('sync_events', 'idx_sync_events_change_id', '`change_id`');
  await addIdx('sync_events', 'idx_sync_events_device_table_row', '`device_id`, `table_name`, `row_id`');
  await addIdx('sync_events', 'idx_sync_events_rid_change', '`restaurant_id`, `change_id`');
  await addIdx('sync_events', 'idx_sync_events_txn_id', '`txn_id`');
  await addIdx('sync_events', 'idx_sync_events_restaurant_txn', '`restaurant_id`, `txn_id`');

  console.log('  Indexes OK');

  // ── Step 5: Views, function, and triggers ────────────────────────────────────
  console.log('\n[5/6] Creating/replacing views, function, and triggers...');

  await conn.query(`DROP FUNCTION IF EXISTS current_restaurant_id`);
  await conn.query(`CREATE FUNCTION current_restaurant_id() RETURNS INT DETERMINISTIC NO SQL RETURN @current_restaurant_id`);

  const views = [
    ['admins',                '_admins_base'],
    ['pos_settings',          '_pos_settings_base'],
    ['pos_roles',             '_pos_roles_base'],
    ['pos_permissions',       '_pos_permissions_base'],
    ['pos_role_permissions',  '_pos_role_permissions_base'],
    ['pos_staff',             '_pos_staff_base'],
    ['pos_attendance',        '_pos_attendance_base'],
    ['pos_menu_categories',   '_pos_menu_categories_base'],
    ['pos_menu_items',        '_pos_menu_items_base'],
    ['pos_floors',            '_pos_floors_base'],
    ['pos_sections',          '_pos_sections_base'],
    ['pos_tables',            '_pos_tables_base'],
    ['pos_orders',            '_pos_orders_base'],
    ['pos_order_items',       '_pos_order_items_base'],
    ['pos_inventory_items',   '_pos_inventory_items_base'],
    ['pos_inventory_log',     '_pos_inventory_log_base'],
    ['pos_expenses',          '_pos_expenses_base'],
    ['pos_payroll',           '_pos_payroll_base'],
    ['pos_activity_logs',     '_pos_activity_logs_base'],
    ['pos_notifications',     '_pos_notifications_base'],
    ['pos_customers',         '_pos_customers_base'],
    ['pos_system_logs',       '_pos_system_logs_base'],
    ['riders',                '_riders_base'],
    ['rider_latest_location', '_rider_latest_location_base'],
    ['rider_locations',       '_rider_locations_base'],
    ['rider_sessions',        '_rider_sessions_base'],
    ['tasks',                 '_tasks_base'],
  ];
  for (const [view, base] of views) {
    if (!(await tableExists(base))) { console.warn(`  SKIP view ${view} (base table missing)`); continue; }
    // Drop table with same name if it exists (may have been created as a plain table previously)
    try { await conn.query(`DROP TABLE IF EXISTS \`${view}\``); } catch (_) {}
    await conn.query(`CREATE OR REPLACE VIEW \`${view}\` AS SELECT * FROM \`${base}\` WHERE restaurant_id = current_restaurant_id()`);
  }
  console.log('  Views OK');

  // Triggers — one per base table
  const triggers = [
    ['t_admins_insert',              '_admins_base'],
    ['t_pos_settings_insert',        '_pos_settings_base'],
    ['t_pos_roles_insert',           '_pos_roles_base'],
    ['t_pos_permissions_insert',       '_pos_permissions_base'],
    ['t_pos_role_permissions_insert',  '_pos_role_permissions_base'],
    ['t_pos_staff_insert',           '_pos_staff_base'],
    ['t_pos_attendance_insert',      '_pos_attendance_base'],
    ['t_pos_menu_categories_insert', '_pos_menu_categories_base'],
    ['t_pos_menu_items_insert',      '_pos_menu_items_base'],
    ['t_pos_floors_insert',          '_pos_floors_base'],
    ['t_pos_sections_insert',        '_pos_sections_base'],
    ['t_pos_tables_insert',          '_pos_tables_base'],
    ['t_pos_orders_insert',          '_pos_orders_base'],
    ['t_pos_order_items_insert',     '_pos_order_items_base'],
    ['t_pos_inventory_items_insert', '_pos_inventory_items_base'],
    ['t_pos_inventory_log_insert',   '_pos_inventory_log_base'],
    ['t_pos_expenses_insert',        '_pos_expenses_base'],
    ['t_pos_payroll_insert',         '_pos_payroll_base'],
    ['t_pos_activity_logs_insert',   '_pos_activity_logs_base'],
    ['t_pos_notifications_insert',   '_pos_notifications_base'],
    ['t_pos_customers_insert',       '_pos_customers_base'],
    ['t_pos_system_logs_insert',     '_pos_system_logs_base'],
    ['t_riders_insert',              '_riders_base'],
    ['t_rider_latest_location_insert','_rider_latest_location_base'],
    ['t_rider_locations_insert',     '_rider_locations_base'],
    ['t_rider_sessions_insert',      '_rider_sessions_base'],
    ['t_tasks_insert',               '_tasks_base'],
  ];
  for (const [trig, base] of triggers) {
    if (!(await tableExists(base))) { console.warn(`  SKIP trigger ${trig} (base table missing)`); continue; }
    await conn.query(`DROP TRIGGER IF EXISTS \`${trig}\``);
    await conn.query(
      `CREATE TRIGGER \`${trig}\` BEFORE INSERT ON \`${base}\`
       FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id)`
    );
  }
  console.log('  Triggers OK');

  // ── Step 6: Seed super admin ─────────────────────────────────────────────────
  console.log('\n[6/6] Seeding default super admin...');
  await conn.query(`
    INSERT INTO super_admins (username, password_hash)
    VALUES ('admin', '$2a$10$CEWQoPZYoXI8N5B/GlClK.mXjh8LQINY18EXjbmkDHj6YQx7Nf846')
    ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)
  `);
  console.log('  Seed OK');

  await conn.end();
  console.log('\n✓ Database setup complete. All tables, columns, indexes, views and triggers are in place.\n');
}

run().catch(err => {
  console.error('\n✗ Setup failed:', err.message);
  process.exit(1);
});
