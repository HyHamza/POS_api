-- File: POS_api/migration_v9_role_assignments.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration V9: Multi-Station & Role-Based Order Assignment System
-- Adds assigned_categories, assigned_items, and assigned_order_types to staff.
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Add assigned_categories (JSON array of assigned menu category IDs for Kitchen staff)
ALTER TABLE _pos_staff_base ADD COLUMN IF NOT EXISTS assigned_categories TEXT DEFAULT NULL;

-- 2. Add assigned_items (JSON array of assigned specific menu item IDs for Kitchen staff)
ALTER TABLE _pos_staff_base ADD COLUMN IF NOT EXISTS assigned_items TEXT DEFAULT NULL;

-- 3. Add assigned_order_types (JSON array of assigned order types: Dine-In, Delivery, Takeaway)
ALTER TABLE _pos_staff_base ADD COLUMN IF NOT EXISTS assigned_order_types TEXT DEFAULT NULL;

-- 4. Recreate tenant-scoped pos_staff view to include new assignment columns
CREATE OR REPLACE VIEW pos_staff AS 
SELECT * FROM _pos_staff_base 
WHERE restaurant_id = current_restaurant_id();
