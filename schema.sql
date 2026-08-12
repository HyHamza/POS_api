-- RestaurantOS MySQL/MariaDB Schema
-- Multi-tenant schema with Views and Triggers

-- ─── Main Registry Tables ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  license_key VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) DEFAULT 'active',
  plan_type VARCHAR(50) DEFAULT 'lifetime',
  expires_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS super_admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_releases (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  version               VARCHAR(50)  NOT NULL,
  platform              VARCHAR(20)  NOT NULL DEFAULT 'win',
  exe_url               TEXT         NOT NULL,
  changelog             TEXT         NULL,
  file_size             BIGINT       NULL,
  sha256                VARCHAR(64)  NULL,
  mandatory             TINYINT(1)   NOT NULL DEFAULT 0,
  min_supported_version VARCHAR(50)  NULL,
  is_active             TINYINT(1)   NOT NULL DEFAULT 1,
  release_notes_url     VARCHAR(500) NULL,
  created_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_version_platform (version, platform),
  INDEX idx_active_platform (platform, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── Tenant-specific Base Tables ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _admins_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (restaurant_id, username),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_settings_base (
  restaurant_id INT NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `value` TEXT,
  PRIMARY KEY (restaurant_id, `key`),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_staff_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  pin_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'Waiter',
  phone VARCHAR(50),
  email VARCHAR(255),
  hire_date DATE,
  salary_type VARCHAR(50) DEFAULT 'Monthly',
  salary_amount DOUBLE DEFAULT 0,
  status VARCHAR(50) DEFAULT 'Active',
  permissions TEXT DEFAULT NULL,
  daily_duty_hours INT DEFAULT 8,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (restaurant_id, username),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_attendance_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  staff_id INT NOT NULL,
  clock_in DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clock_out DATETIME,
  date DATE NOT NULL,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES _pos_staff_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_menu_categories_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_order INT DEFAULT 0,
  is_visible TINYINT DEFAULT 1,
  UNIQUE KEY (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_menu_items_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  category_id INT,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DOUBLE NOT NULL DEFAULT 0,
  cost_price DOUBLE DEFAULT 0,
  image_path VARCHAR(255),
  dietary_tags TEXT,
  is_available TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES _pos_menu_categories_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_floors_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_order INT DEFAULT 0,
  UNIQUE KEY (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_sections_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  floor_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_order INT DEFAULT 0,
  UNIQUE KEY (restaurant_id, floor_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (floor_id) REFERENCES _pos_floors_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_tables_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  number VARCHAR(255) NOT NULL,
  capacity INT DEFAULT 4,
  status VARCHAR(50) DEFAULT 'available',
  section_id INT,
  UNIQUE KEY (restaurant_id, section_id, number),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (section_id) REFERENCES _pos_sections_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_orders_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  order_number VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'Dine-In',
  table_id INT,
  staff_id INT,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(255),
  customer_address TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  subtotal DOUBLE DEFAULT 0,
  tax DOUBLE DEFAULT 0,
  discount DOUBLE DEFAULT 0,
  total DOUBLE DEFAULT 0,
  notes TEXT,
  rider_name VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY (restaurant_id, order_number),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (table_id) REFERENCES _pos_tables_base(id) ON DELETE SET NULL,
  FOREIGN KEY (staff_id) REFERENCES _pos_staff_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_order_items_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  order_id INT NOT NULL,
  menu_item_id INT,
  name VARCHAR(255) NOT NULL,
  price DOUBLE NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  notes TEXT,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES _pos_orders_base(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES _pos_menu_items_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_inventory_items_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(255) DEFAULT 'General',
  unit VARCHAR(50) DEFAULT 'pieces',
  quantity DOUBLE DEFAULT 0,
  min_threshold DOUBLE DEFAULT 10,
  cost_per_unit DOUBLE DEFAULT 0,
  supplier_name VARCHAR(255),
  supplier_contact VARCHAR(255),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_inventory_log_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  item_id INT NOT NULL,
  change_type VARCHAR(50) NOT NULL,
  quantity_change DOUBLE NOT NULL,
  reason TEXT,
  staff_id INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES _pos_inventory_items_base(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES _pos_staff_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_expenses_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  category VARCHAR(255) NOT NULL DEFAULT 'Other',
  description TEXT,
  amount DOUBLE NOT NULL DEFAULT 0,
  staff_id INT,
  receipt_path VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES _pos_staff_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_payroll_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  staff_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  base_salary DOUBLE DEFAULT 0,
  days_present INT DEFAULT 0,
  advances DOUBLE DEFAULT 0,
  deductions DOUBLE DEFAULT 0,
  overtime_hours DOUBLE DEFAULT 0,
  overtime_salary DOUBLE DEFAULT 0,
  net_pay DOUBLE DEFAULT 0,
  status VARCHAR(50) DEFAULT 'Pending',
  paid_at DATETIME,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES _pos_staff_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Rider Base Tables ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _pos_activity_logs_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  user_id VARCHAR(255),
  user_type VARCHAR(50),
  user_name VARCHAR(255),
  section VARCHAR(100),
  action_type VARCHAR(100),
  description TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_notifications_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  title VARCHAR(255) NOT NULL,
  message TEXT,
  is_read TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _pos_system_logs_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  device_type VARCHAR(50) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  status_code INT,
  error_details TEXT,
  request_payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _riders_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(255),
  status VARCHAR(50) DEFAULT 'offline',
  is_active TINYINT DEFAULT 1,
  fcm_token VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (restaurant_id, username),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _rider_latest_location_base (
  rider_id INT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  speed DOUBLE DEFAULT 0,
  heading DOUBLE DEFAULT 0,
  accuracy DOUBLE DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES _riders_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _rider_locations_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  rider_id INT NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  speed DOUBLE DEFAULT 0,
  heading DOUBLE DEFAULT 0,
  accuracy DOUBLE DEFAULT 0,
  recorded_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES _riders_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _rider_sessions_base (
  rider_id INT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  socket_id VARCHAR(255) NOT NULL,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES _riders_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS _tasks_base (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  rider_id INT,
  customer_name VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(255),
  delivery_address TEXT NOT NULL,
  delivery_lat DECIMAL(10, 8),
  delivery_lng DECIMAL(11, 8),
  order_details TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  assigned_at DATETIME,
  accepted_at DATETIME,
  delivered_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES _riders_base(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Database Indexes ────────────────────────────────────────────────────────
CREATE INDEX idx_pos_orders_status ON _pos_orders_base(status);
CREATE INDEX idx_pos_orders_created_at ON _pos_orders_base(created_at);
CREATE INDEX idx_rider_locations_rider ON _rider_locations_base(rider_id, recorded_at);
CREATE INDEX idx_tasks_status ON _tasks_base(status);

-- ─── Stored Function for Session Variable Access ──────────────────────────────
DROP FUNCTION IF EXISTS current_restaurant_id;
CREATE FUNCTION current_restaurant_id() RETURNS INT DETERMINISTIC NO SQL RETURN @current_restaurant_id;

-- ─── Scoped Multi-Tenant Views ───────────────────────────────────────────────
CREATE OR REPLACE VIEW admins AS SELECT * FROM _admins_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_attendance AS SELECT * FROM _pos_attendance_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_expenses AS SELECT * FROM _pos_expenses_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_floors AS SELECT * FROM _pos_floors_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_inventory_items AS SELECT * FROM _pos_inventory_items_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_inventory_log AS SELECT * FROM _pos_inventory_log_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_menu_categories AS SELECT * FROM _pos_menu_categories_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_menu_items AS SELECT * FROM _pos_menu_items_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_order_items AS SELECT * FROM _pos_order_items_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_orders AS SELECT * FROM _pos_orders_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_payroll AS SELECT * FROM _pos_payroll_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_sections AS SELECT * FROM _pos_sections_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_settings AS SELECT * FROM _pos_settings_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_staff AS SELECT * FROM _pos_staff_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_tables AS SELECT * FROM _pos_tables_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW rider_latest_location AS SELECT * FROM _rider_latest_location_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW rider_locations AS SELECT * FROM _rider_locations_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW rider_sessions AS SELECT * FROM _rider_sessions_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW riders AS SELECT * FROM _riders_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW tasks AS SELECT * FROM _tasks_base WHERE restaurant_id = current_restaurant_id();
CREATE OR REPLACE VIEW pos_system_logs AS SELECT * FROM _pos_system_logs_base WHERE restaurant_id = current_restaurant_id() WITH CHECK OPTION;
CREATE OR REPLACE VIEW pos_activity_logs AS SELECT * FROM _pos_activity_logs_base WHERE restaurant_id = current_restaurant_id() WITH CHECK OPTION;
CREATE OR REPLACE VIEW pos_notifications AS SELECT * FROM _pos_notifications_base WHERE restaurant_id = current_restaurant_id() WITH CHECK OPTION;

-- ─── Single-Statement Tenant Identity Triggers ────────────────────────────────
DROP TRIGGER IF EXISTS t_admins_insert;
CREATE TRIGGER t_admins_insert BEFORE INSERT ON _admins_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_attendance_insert;
CREATE TRIGGER t_pos_attendance_insert BEFORE INSERT ON _pos_attendance_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_expenses_insert;
CREATE TRIGGER t_pos_expenses_insert BEFORE INSERT ON _pos_expenses_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_floors_insert;
CREATE TRIGGER t_pos_floors_insert BEFORE INSERT ON _pos_floors_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_inventory_items_insert;
CREATE TRIGGER t_pos_inventory_items_insert BEFORE INSERT ON _pos_inventory_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_inventory_log_insert;
CREATE TRIGGER t_pos_inventory_log_insert BEFORE INSERT ON _pos_inventory_log_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_menu_categories_insert;
CREATE TRIGGER t_pos_menu_categories_insert BEFORE INSERT ON _pos_menu_categories_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_menu_items_insert;
CREATE TRIGGER t_pos_menu_items_insert BEFORE INSERT ON _pos_menu_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_order_items_insert;
CREATE TRIGGER t_pos_order_items_insert BEFORE INSERT ON _pos_order_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_orders_insert;
CREATE TRIGGER t_pos_orders_insert BEFORE INSERT ON _pos_orders_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_payroll_insert;
CREATE TRIGGER t_pos_payroll_insert BEFORE INSERT ON _pos_payroll_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_sections_insert;
CREATE TRIGGER t_pos_sections_insert BEFORE INSERT ON _pos_sections_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_settings_insert;
CREATE TRIGGER t_pos_settings_insert BEFORE INSERT ON _pos_settings_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_staff_insert;
CREATE TRIGGER t_pos_staff_insert BEFORE INSERT ON _pos_staff_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_tables_insert;
CREATE TRIGGER t_pos_tables_insert BEFORE INSERT ON _pos_tables_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_riders_insert;
CREATE TRIGGER t_riders_insert BEFORE INSERT ON _riders_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_rider_latest_location_insert;
CREATE TRIGGER t_rider_latest_location_insert BEFORE INSERT ON _rider_latest_location_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_rider_locations_insert;
CREATE TRIGGER t_rider_locations_insert BEFORE INSERT ON _rider_locations_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_rider_sessions_insert;
CREATE TRIGGER t_rider_sessions_insert BEFORE INSERT ON _rider_sessions_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_notifications_insert;
CREATE TRIGGER t_pos_notifications_insert BEFORE INSERT ON _pos_notifications_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_tasks_insert;
CREATE TRIGGER t_tasks_insert BEFORE INSERT ON _tasks_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_system_logs_insert;
CREATE TRIGGER t_pos_system_logs_insert BEFORE INSERT ON _pos_system_logs_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_activity_logs_insert;
CREATE TRIGGER t_pos_activity_logs_insert BEFORE INSERT ON _pos_activity_logs_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_attendance_insert;
CREATE TRIGGER t_pos_attendance_insert BEFORE INSERT ON _pos_attendance_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_menu_categories_insert;
CREATE TRIGGER t_pos_menu_categories_insert BEFORE INSERT ON _pos_menu_categories_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_menu_items_insert;
CREATE TRIGGER t_pos_menu_items_insert BEFORE INSERT ON _pos_menu_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_floors_insert;
CREATE TRIGGER t_pos_floors_insert BEFORE INSERT ON _pos_floors_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_order_items_insert;
CREATE TRIGGER t_pos_order_items_insert BEFORE INSERT ON _pos_order_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_inventory_items_insert;
CREATE TRIGGER t_pos_inventory_items_insert BEFORE INSERT ON _pos_inventory_items_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_inventory_log_insert;
CREATE TRIGGER t_pos_inventory_log_insert BEFORE INSERT ON _pos_inventory_log_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

DROP TRIGGER IF EXISTS t_pos_expenses_insert;
CREATE TRIGGER t_pos_expenses_insert BEFORE INSERT ON _pos_expenses_base FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id);

-- ─── Seed Data ───────────────────────────────────────────────────────────────
INSERT INTO super_admins (username, password_hash)
VALUES ('admin', '$2a$10$CEWQoPZYoXI8N5B/GlClK.mXjh8LQINY18EXjbmkDHj6YQx7Nf846')
ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash);
