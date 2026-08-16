-- File: POS_api/migration_v12_deals.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration V12: Deals & Combo Package System
-- Adds _pos_deals_base, _pos_deal_items_base, views, and order_items deal linkage.
-- ═════════════════════════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Create _pos_deals_base table
CREATE TABLE IF NOT EXISTS _pos_deals_base (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id    INT NOT NULL,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  price            DOUBLE NOT NULL DEFAULT 0,
  cost_price       DOUBLE DEFAULT 0,
  image_path       VARCHAR(255) DEFAULT NULL,
  is_active        TINYINT DEFAULT 1,
  is_deleted       TINYINT DEFAULT 0,
  deleted_at       DATETIME DEFAULT NULL,
  hlc              VARCHAR(255) DEFAULT NULL,
  sync_device_id   VARCHAR(64) DEFAULT NULL,
  origin_device_id VARCHAR(255) DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_deals_rest_name (restaurant_id, name),
  INDEX idx_deals_active (restaurant_id, is_active, is_deleted),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Create _pos_deal_items_base table
CREATE TABLE IF NOT EXISTS _pos_deal_items_base (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id    INT NOT NULL,
  deal_id          INT NOT NULL,
  menu_item_id     INT NOT NULL,
  quantity         INT NOT NULL DEFAULT 1,
  is_deleted       TINYINT DEFAULT 0,
  deleted_at       DATETIME DEFAULT NULL,
  hlc              VARCHAR(255) DEFAULT NULL,
  sync_device_id   VARCHAR(64) DEFAULT NULL,
  origin_device_id VARCHAR(255) DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_deal_items_deal (restaurant_id, deal_id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (deal_id) REFERENCES _pos_deals_base(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES _pos_menu_items_base(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Add deal_id to _pos_order_items_base if not exists
ALTER TABLE _pos_order_items_base ADD COLUMN IF NOT EXISTS deal_id INT DEFAULT NULL;

-- 4. Create tenant-scoped views
CREATE OR REPLACE VIEW pos_deals AS
SELECT * FROM _pos_deals_base
WHERE restaurant_id = current_restaurant_id();

CREATE OR REPLACE VIEW pos_deal_items AS
SELECT * FROM _pos_deal_items_base
WHERE restaurant_id = current_restaurant_id();

-- 5. Create multi-tenant triggers for pos_deals view
DROP TRIGGER IF EXISTS pos_deals_insert_trigger;
DELIMITER $$
CREATE TRIGGER pos_deals_insert_trigger
INSTEAD OF INSERT ON pos_deals
FOR EACH ROW
BEGIN
  INSERT INTO _pos_deals_base (
    restaurant_id, name, description, price, cost_price, image_path,
    is_active, is_deleted, deleted_at, hlc, sync_device_id, origin_device_id,
    created_at, updated_at
  ) VALUES (
    current_restaurant_id(), NEW.name, NEW.description, NEW.price, NEW.cost_price, NEW.image_path,
    COALESCE(NEW.is_active, 1), COALESCE(NEW.is_deleted, 0), NEW.deleted_at, NEW.hlc, NEW.sync_device_id, NEW.origin_device_id,
    COALESCE(NEW.created_at, CURRENT_TIMESTAMP), COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
  );
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS pos_deal_items_insert_trigger;
DELIMITER $$
CREATE TRIGGER pos_deal_items_insert_trigger
INSTEAD OF INSERT ON pos_deal_items
FOR EACH ROW
BEGIN
  INSERT INTO _pos_deal_items_base (
    restaurant_id, deal_id, menu_item_id, quantity,
    is_deleted, deleted_at, hlc, sync_device_id, origin_device_id,
    created_at, updated_at
  ) VALUES (
    current_restaurant_id(), NEW.deal_id, NEW.menu_item_id, COALESCE(NEW.quantity, 1),
    COALESCE(NEW.is_deleted, 0), NEW.deleted_at, NEW.hlc, NEW.sync_device_id, NEW.origin_device_id,
    COALESCE(NEW.created_at, CURRENT_TIMESTAMP), COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
  );
END$$
DELIMITER ;

SET FOREIGN_KEY_CHECKS = 1;
