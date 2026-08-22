/**
 * autoMigrate.js — Autonomous Multi-Tenant Schema Assurance & Migration Engine
 * 
 * Guarantees that EVERY database (new, existing, local, or cloud) automatically
 * contains 100% of required tables, columns, indexes, and tenant views.
 * 
 * Runs idempotently on server startup and caches table columns in memory for zero-overhead
 * runtime lookups.
 */

'use strict';

const CANONICAL_TABLES = {
  restaurants: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      name: 'VARCHAR(255) NOT NULL',
      license_key: 'VARCHAR(64) UNIQUE NOT NULL',
      status: "ENUM('active', 'suspended', 'disabled', 'expired') DEFAULT 'active'",
      plan_type: "VARCHAR(64) DEFAULT 'basic'",
      expires_at: 'DATETIME DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP'
    }
  },
  _admins_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      username: 'VARCHAR(64) NOT NULL',
      password_hash: 'VARCHAR(255) NOT NULL',
      email: 'VARCHAR(255) DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_settings_base: {
    columns: {
      restaurant_id: 'INT NOT NULL',
      key: 'VARCHAR(64) NOT NULL',
      value: 'TEXT DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_floors_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(64) NOT NULL',
      display_order: 'INT DEFAULT 0',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_sections_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      floor_id: 'INT DEFAULT NULL',
      name: 'VARCHAR(64) NOT NULL',
      display_order: 'INT DEFAULT 0',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_tables_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      number: 'VARCHAR(64) NOT NULL',
      capacity: 'INT DEFAULT 4',
      status: "VARCHAR(32) DEFAULT 'available'",
      section_id: 'INT DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_roles_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(64) NOT NULL',
      description: 'TEXT DEFAULT NULL',
      is_system: 'TINYINT DEFAULT 0',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_permissions_base: {
    columns: {
      id: 'VARCHAR(64) NOT NULL PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      label: 'VARCHAR(128) NOT NULL',
      desc: 'TEXT DEFAULT NULL',
      category: 'VARCHAR(64) DEFAULT NULL',
      parent_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_role_permissions_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      role_id: 'INT NOT NULL',
      permission_id: 'VARCHAR(64) NOT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_staff_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(128) NOT NULL',
      username: 'VARCHAR(64) NOT NULL',
      pin_hash: 'VARCHAR(255) DEFAULT NULL',
      role: 'VARCHAR(64) NOT NULL',
      phone: 'VARCHAR(32) DEFAULT NULL',
      email: 'VARCHAR(128) DEFAULT NULL',
      hire_date: 'DATE DEFAULT NULL',
      salary_type: "VARCHAR(32) DEFAULT 'monthly'",
      salary_amount: 'DECIMAL(10,2) DEFAULT 0',
      status: "VARCHAR(32) DEFAULT 'active'",
      permissions: 'TEXT DEFAULT NULL',
      daily_duty_hours: 'DECIMAL(4,2) DEFAULT 8.0',
      attendance_pin_hash: 'TEXT DEFAULT NULL',
      fingerprint_template: 'TEXT DEFAULT NULL',
      role_id: 'INT DEFAULT NULL',
      assigned_categories: 'TEXT DEFAULT NULL',
      assigned_items: 'TEXT DEFAULT NULL',
      assigned_order_types: 'TEXT DEFAULT NULL',
      custom_view_config: 'TEXT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_attendance_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      staff_id: 'INT NOT NULL',
      clock_in: 'DATETIME DEFAULT NULL',
      clock_out: 'DATETIME DEFAULT NULL',
      date: 'DATE DEFAULT NULL',
      verification_method: "VARCHAR(64) DEFAULT 'Face'",
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_menu_categories_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(128) NOT NULL',
      display_order: 'INT DEFAULT 0',
      is_visible: 'TINYINT DEFAULT 1',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_menu_items_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      category_id: 'INT DEFAULT NULL',
      name: 'VARCHAR(128) NOT NULL',
      description: 'TEXT DEFAULT NULL',
      price: 'DECIMAL(10,2) DEFAULT 0',
      cost_price: 'DECIMAL(10,2) DEFAULT 0',
      image_path: 'TEXT DEFAULT NULL',
      dietary_tags: 'TEXT DEFAULT NULL',
      variants: 'LONGTEXT DEFAULT NULL',
      is_available: 'TINYINT DEFAULT 1',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      price_hlc: 'VARCHAR(64) DEFAULT NULL',
      description_hlc: 'VARCHAR(64) DEFAULT NULL',
      is_available_hlc: 'VARCHAR(64) DEFAULT NULL',
      category_id_hlc: 'VARCHAR(64) DEFAULT NULL',
      cost_price_hlc: 'VARCHAR(64) DEFAULT NULL',
      image_path_hlc: 'VARCHAR(64) DEFAULT NULL',
      dietary_tags_hlc: 'VARCHAR(64) DEFAULT NULL',
      variants_hlc: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_deals_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(128) NOT NULL',
      description: 'TEXT DEFAULT NULL',
      price: 'DECIMAL(10,2) DEFAULT 0',
      cost_price: 'DECIMAL(10,2) DEFAULT 0',
      image_path: 'TEXT DEFAULT NULL',
      is_active: 'TINYINT DEFAULT 1',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      price_hlc: 'VARCHAR(64) DEFAULT NULL',
      description_hlc: 'VARCHAR(64) DEFAULT NULL',
      is_active_hlc: 'VARCHAR(64) DEFAULT NULL',
      cost_price_hlc: 'VARCHAR(64) DEFAULT NULL',
      image_path_hlc: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_deal_items_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      deal_id: 'INT NOT NULL',
      menu_item_id: 'INT NOT NULL',
      quantity: 'INT DEFAULT 1',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_orders_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      order_number: 'VARCHAR(64) NOT NULL',
      type: "VARCHAR(32) DEFAULT 'Dine-In'",
      table_id: 'INT DEFAULT NULL',
      staff_id: 'INT DEFAULT NULL',
      customer_name: 'VARCHAR(128) DEFAULT NULL',
      customer_phone: 'VARCHAR(32) DEFAULT NULL',
      customer_address: 'TEXT DEFAULT NULL',
      status: "VARCHAR(32) DEFAULT 'pending'",
      subtotal: 'DECIMAL(10,2) DEFAULT 0',
      tax: 'DECIMAL(10,2) DEFAULT 0',
      discount: 'DECIMAL(10,2) DEFAULT 0',
      total: 'DECIMAL(10,2) DEFAULT 0',
      notes: 'TEXT DEFAULT NULL',
      rider_name: 'VARCHAR(128) DEFAULT NULL',
      payment_received: 'TINYINT DEFAULT 0',
      payment_received_at: 'VARCHAR(64) DEFAULT NULL',
      payment_received_by: 'INT DEFAULT NULL',
      payment_method: "VARCHAR(64) DEFAULT 'Cash'",
      dispatched_by: 'INT DEFAULT NULL',
      dispatched_by_name: 'VARCHAR(255) DEFAULT NULL',
      dispatched_by_role: 'VARCHAR(100) DEFAULT NULL',
      dispatched_at: 'VARCHAR(64) DEFAULT NULL',
      settled_by: 'INT DEFAULT NULL',
      settled_by_name: 'VARCHAR(255) DEFAULT NULL',
      settled_by_role: 'VARCHAR(100) DEFAULT NULL',
      settled_at: 'VARCHAR(64) DEFAULT NULL',
      returned_by: 'INT DEFAULT NULL',
      returned_by_name: 'VARCHAR(255) DEFAULT NULL',
      returned_by_role: 'VARCHAR(100) DEFAULT NULL',
      returned_at: 'VARCHAR(64) DEFAULT NULL',
      return_reason: 'TEXT DEFAULT NULL',
      return_type: 'VARCHAR(64) DEFAULT NULL',
      is_staff_order: 'TINYINT DEFAULT 0',
      staff_member_id: 'INT DEFAULT NULL',
      staff_member_name: 'VARCHAR(255) DEFAULT NULL',
      staff_member_role: 'VARCHAR(100) DEFAULT NULL',
      edit_count: 'INT DEFAULT 0',
      is_return: 'TINYINT DEFAULT 0',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      status_hlc: 'VARCHAR(64) DEFAULT NULL',
      subtotal_hlc: 'VARCHAR(64) DEFAULT NULL',
      total_hlc: 'VARCHAR(64) DEFAULT NULL',
      notes_hlc: 'VARCHAR(64) DEFAULT NULL',
      rider_name_hlc: 'VARCHAR(64) DEFAULT NULL',
      edit_count_hlc: 'VARCHAR(64) DEFAULT NULL',
      is_return_hlc: 'VARCHAR(64) DEFAULT NULL',
      payment_received_hlc: 'VARCHAR(64) DEFAULT NULL',
      payment_received_at_hlc: 'VARCHAR(64) DEFAULT NULL',
      payment_received_by_hlc: 'VARCHAR(64) DEFAULT NULL',
      payment_method_hlc: 'VARCHAR(64) DEFAULT NULL',
      dispatched_by_hlc: 'VARCHAR(64) DEFAULT NULL',
      dispatched_at_hlc: 'VARCHAR(64) DEFAULT NULL',
      settled_by_hlc: 'VARCHAR(64) DEFAULT NULL',
      settled_at_hlc: 'VARCHAR(64) DEFAULT NULL',
      dispatched_by_name_hlc: 'VARCHAR(64) DEFAULT NULL',
      dispatched_by_role_hlc: 'VARCHAR(64) DEFAULT NULL',
      settled_by_name_hlc: 'VARCHAR(64) DEFAULT NULL',
      settled_by_role_hlc: 'VARCHAR(64) DEFAULT NULL',
      returned_by_hlc: 'VARCHAR(64) DEFAULT NULL',
      returned_by_name_hlc: 'VARCHAR(64) DEFAULT NULL',
      returned_by_role_hlc: 'VARCHAR(64) DEFAULT NULL',
      returned_at_hlc: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_order_items_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      order_id: 'INT NOT NULL',
      menu_item_id: 'INT DEFAULT NULL',
      deal_id: 'INT DEFAULT NULL',
      name: 'VARCHAR(128) NOT NULL',
      price: 'DECIMAL(10,2) DEFAULT 0',
      quantity: 'INT DEFAULT 1',
      notes: 'TEXT DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_inventory_items_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      name: 'VARCHAR(128) NOT NULL',
      category: "VARCHAR(64) DEFAULT 'General'",
      unit: "VARCHAR(32) DEFAULT 'pieces'",
      quantity: 'DECIMAL(10,2) DEFAULT 0',
      min_threshold: 'DECIMAL(10,2) DEFAULT 10',
      cost_per_unit: 'DECIMAL(10,2) DEFAULT 0',
      supplier_name: 'VARCHAR(128) DEFAULT NULL',
      supplier_contact: 'VARCHAR(64) DEFAULT NULL',
      updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL',
      quantity_hlc: 'VARCHAR(64) DEFAULT NULL',
      min_threshold_hlc: 'VARCHAR(64) DEFAULT NULL',
      cost_per_unit_hlc: 'VARCHAR(64) DEFAULT NULL'
    }
  },
  _pos_inventory_log_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      item_id: 'INT NOT NULL',
      change_type: 'VARCHAR(32) NOT NULL',
      quantity_change: 'DECIMAL(10,2) NOT NULL',
      reason: 'TEXT DEFAULT NULL',
      staff_id: 'INT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_expenses_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      category: "VARCHAR(64) DEFAULT 'Other'",
      description: 'TEXT DEFAULT NULL',
      amount: 'DECIMAL(10,2) DEFAULT 0',
      staff_id: 'INT DEFAULT NULL',
      receipt_path: 'TEXT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_payroll_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      staff_id: 'INT NOT NULL',
      period_start: 'DATE NOT NULL',
      period_end: 'DATE NOT NULL',
      base_salary: 'DECIMAL(10,2) DEFAULT 0',
      days_present: 'INT DEFAULT 0',
      advances: 'DECIMAL(10,2) DEFAULT 0',
      deductions: 'DECIMAL(10,2) DEFAULT 0',
      overtime_hours: 'DECIMAL(5,2) DEFAULT 0',
      overtime_salary: 'DECIMAL(10,2) DEFAULT 0',
      net_pay: 'DECIMAL(10,2) DEFAULT 0',
      status: "VARCHAR(32) DEFAULT 'pending'",
      paid_at: 'DATETIME DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_customers_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      phone: 'VARCHAR(32) NOT NULL',
      name: 'VARCHAR(128) NOT NULL',
      address: 'TEXT DEFAULT NULL',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_notifications_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      type: "VARCHAR(32) DEFAULT 'info'",
      title: 'VARCHAR(128) NOT NULL',
      message: 'TEXT NOT NULL',
      is_read: 'TINYINT DEFAULT 0',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_activity_logs_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      user_id: 'INT DEFAULT NULL',
      user_type: "VARCHAR(32) DEFAULT 'Staff'",
      user_name: 'VARCHAR(128) DEFAULT NULL',
      section: 'VARCHAR(64) DEFAULT NULL',
      action_type: 'VARCHAR(64) NOT NULL',
      description: 'TEXT DEFAULT NULL',
      metadata: 'LONGTEXT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _pos_face_descriptors_base: {
    columns: {
      staff_id: 'INT NOT NULL',
      restaurant_id: 'INT NOT NULL',
      descriptor: 'LONGTEXT NOT NULL',
      photo: 'LONGTEXT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP'
    }
  },
  _riders_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      username: 'VARCHAR(64) NOT NULL',
      password_hash: 'VARCHAR(255) NOT NULL',
      full_name: 'VARCHAR(128) NOT NULL',
      phone: 'VARCHAR(32) DEFAULT NULL',
      status: "VARCHAR(32) DEFAULT 'offline'",
      is_active: 'TINYINT DEFAULT 1',
      fcm_token: 'TEXT DEFAULT NULL',
      refresh_token_hash: 'VARCHAR(255) DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _tasks_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      rider_id: 'INT DEFAULT NULL',
      customer_name: 'VARCHAR(128) DEFAULT NULL',
      customer_phone: 'VARCHAR(32) DEFAULT NULL',
      delivery_address: 'TEXT DEFAULT NULL',
      delivery_lat: 'DECIMAL(10,8) DEFAULT NULL',
      delivery_lng: 'DECIMAL(11,8) DEFAULT NULL',
      order_details: 'TEXT DEFAULT NULL',
      order_number: 'VARCHAR(64) DEFAULT NULL',
      status: "VARCHAR(32) DEFAULT 'pending'",
      assigned_at: 'DATETIME DEFAULT NULL',
      accepted_at: 'DATETIME DEFAULT NULL',
      delivered_at: 'DATETIME DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
      hlc: 'VARCHAR(64) DEFAULT NULL',
      origin_device_id: 'VARCHAR(64) DEFAULT NULL',
      sync_device_id: 'VARCHAR(64) DEFAULT NULL',
      is_deleted: 'TINYINT DEFAULT 0',
      deleted_at: 'DATETIME DEFAULT NULL'
    }
  },
  _rider_locations_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      rider_id: 'INT NOT NULL',
      latitude: 'DECIMAL(10,8) NOT NULL',
      longitude: 'DECIMAL(11,8) NOT NULL',
      speed: 'DECIMAL(6,2) DEFAULT NULL',
      heading: 'DECIMAL(5,2) DEFAULT NULL',
      accuracy: 'DECIMAL(6,2) DEFAULT NULL',
      recorded_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP'
    }
  },
  _rider_latest_location_base: {
    columns: {
      rider_id: 'INT NOT NULL',
      restaurant_id: 'INT NOT NULL',
      latitude: 'DECIMAL(10,8) NOT NULL',
      longitude: 'DECIMAL(11,8) NOT NULL',
      speed: 'DECIMAL(6,2) DEFAULT NULL',
      heading: 'DECIMAL(5,2) DEFAULT NULL',
      accuracy: 'DECIMAL(6,2) DEFAULT NULL',
      updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    }
  },
  _rider_sessions_base: {
    columns: {
      rider_id: 'INT NOT NULL',
      restaurant_id: 'INT NOT NULL',
      socket_id: 'VARCHAR(64) NOT NULL',
      connected_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP'
    }
  },
  _pos_system_logs_base: {
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      restaurant_id: 'INT NOT NULL',
      device_type: 'VARCHAR(32) DEFAULT NULL',
      endpoint: 'VARCHAR(255) DEFAULT NULL',
      method: 'VARCHAR(16) DEFAULT NULL',
      status_code: 'INT DEFAULT NULL',
      error_details: 'LONGTEXT DEFAULT NULL',
      request_payload: 'LONGTEXT DEFAULT NULL',
      created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP'
    }
  },
  sync_events: {
    columns: {
      sync_device_id: 'VARCHAR(64) NOT NULL',
      restaurant_id: 'INT NOT NULL',
      processed_at: 'DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)'
    }
  }
};

const VIEW_MAP = {
  pos_settings: '_pos_settings_base',
  pos_floors: '_pos_floors_base',
  pos_sections: '_pos_sections_base',
  pos_tables: '_pos_tables_base',
  pos_roles: '_pos_roles_base',
  pos_permissions: '_pos_permissions_base',
  pos_role_permissions: '_pos_role_permissions_base',
  pos_staff: '_pos_staff_base',
  pos_attendance: '_pos_attendance_base',
  pos_menu_categories: '_pos_menu_categories_base',
  pos_menu_items: '_pos_menu_items_base',
  pos_deals: '_pos_deals_base',
  pos_deal_items: '_pos_deal_items_base',
  pos_orders: '_pos_orders_base',
  pos_order_items: '_pos_order_items_base',
  pos_inventory_items: '_pos_inventory_items_base',
  pos_inventory_log: '_pos_inventory_log_base',
  pos_expenses: '_pos_expenses_base',
  pos_payroll: '_pos_payroll_base',
  pos_customers: '_pos_customers_base',
  pos_notifications: '_pos_notifications_base',
  pos_activity_logs: '_pos_activity_logs_base',
  pos_face_descriptors: '_pos_face_descriptors_base',
  pos_system_logs: '_pos_system_logs_base',
  riders: '_riders_base',
  tasks: '_tasks_base',
  rider_locations: '_rider_locations_base',
  rider_latest_location: '_rider_latest_location_base',
  rider_sessions: '_rider_sessions_base',
  admins: '_admins_base'
};

// In-memory cache of table columns: tableName -> Set(columnNamesLower)
const tableColumnsCache = new Map();
let migrationPromise = null;

/**
 * Ensures the multi-tenant context function exists.
 */
async function ensureSessionFunctions(pool) {
  try {
    await pool.query(`
      CREATE FUNCTION IF NOT EXISTS current_restaurant_id() RETURNS INT
      DETERMINISTIC NO SQL
      BEGIN
        RETURN @current_restaurant_id;
      END
    `);
  } catch (err) {
    if (!err.message.includes('already exists') && err.code !== 'ER_SP_ALREADY_EXISTS') {
      console.warn('[AutoMigrate] Warning creating current_restaurant_id function:', err.message);
    }
  }
}

/**
 * Loads all column names into memory for instant lookup and dynamic filtering.
 */
async function refreshColumnsCache(pool) {
  try {
    const [rows] = await pool.query(
      'SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
    );
    tableColumnsCache.clear();
    for (const r of rows) {
      const tbl = r.TABLE_NAME.toLowerCase();
      const col = r.COLUMN_NAME.toLowerCase();
      if (!tableColumnsCache.has(tbl)) {
        tableColumnsCache.set(tbl, new Set());
      }
      tableColumnsCache.get(tbl).add(col);
    }
  } catch (err) {
    console.error('[AutoMigrate] Failed to load columns into cache:', err.message);
  }
}

/**
 * Get verified columns for a table.
 */
async function getTableColumns(pool, tableName) {
  const tbl = tableName.toLowerCase();
  if (!tableColumnsCache.has(tbl)) {
    await refreshColumnsCache(pool);
  }
  return tableColumnsCache.get(tbl) || new Set();
}

/**
 * Automatically migrate all tables, add missing columns, and recreate views.
 */
async function autoMigrate(pool) {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    console.log('[AutoMigrate] Checking database schema completeness...');
    await ensureSessionFunctions(pool);
    await refreshColumnsCache(pool);

    // 1. Ensure all base tables and columns exist
    for (const [tableName, spec] of Object.entries(CANONICAL_TABLES)) {
      const tbl = tableName.toLowerCase();
      const existingCols = tableColumnsCache.get(tbl) || new Set();

      if (existingCols.size === 0) {
        // Create Table from scratch
        console.log(`[AutoMigrate] Creating table ${tableName}...`);
        const colDefs = Object.entries(spec.columns).map(([col, def]) => {
          const cleanCol = col.replace(/\`/g, '');
          return `\`${cleanCol}\` ${def}`;
        });
        const createSql = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (${colDefs.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
        try {
          await pool.query(createSql);
          console.log(`[AutoMigrate] Created table ${tableName} successfully.`);
        } catch (err) {
          console.error(`[AutoMigrate] Failed to create table ${tableName}:`, err.message);
        }
      } else {
        // Table exists -> Add missing columns
        for (const [colName, colDef] of Object.entries(spec.columns)) {
          const cleanCol = colName.replace(/\`/g, '');
          if (!existingCols.has(cleanCol.toLowerCase())) {
            console.log(`[AutoMigrate] Adding missing column ${tableName}.${cleanCol} (${colDef})...`);
            try {
              // Strip PRIMARY KEY from column definition if adding via ALTER TABLE
              const safeDef = colDef.replace(/PRIMARY KEY/gi, '').replace(/AUTO_INCREMENT/gi, '').trim();
              await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${cleanCol}\` ${safeDef}`);
              existingCols.add(cleanCol.toLowerCase());
            } catch (err) {
              if (err.code !== 'ER_DUP_FIELDNAME') {
                console.warn(`[AutoMigrate] Warning adding column ${tableName}.${cleanCol}:`, err.message);
              }
            }
          }
        }
      }
    }

    // 2. Recreate / ensure all tenant views are up to date
    for (const [viewName, baseTable] of Object.entries(VIEW_MAP)) {
      try {
        const viewSql = `CREATE OR REPLACE VIEW \`${viewName}\` AS SELECT * FROM \`${baseTable}\` WHERE restaurant_id = current_restaurant_id()`;
        await pool.query(viewSql);
      } catch (vErr) {
        console.warn(`[AutoMigrate] Warning updating view ${viewName}:`, vErr.message);
      }
    }

    // Refresh cache after migrations
    await refreshColumnsCache(pool);
    console.log('[AutoMigrate] Database schema verified and in sync with canonical specification.');
  })();

  return migrationPromise;
}

module.exports = {
  autoMigrate,
  getTableColumns,
  tableColumnsCache
};
