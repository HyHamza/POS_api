-- Migration V6: Staff Overtime Salary Tracking
-- Adds daily_duty_hours to staff, and overtime columns to payroll.

ALTER TABLE _pos_staff_base ADD COLUMN IF NOT EXISTS daily_duty_hours INT DEFAULT 8;
ALTER TABLE _pos_payroll_base ADD COLUMN IF NOT EXISTS overtime_hours DOUBLE DEFAULT 0;
ALTER TABLE _pos_payroll_base ADD COLUMN IF NOT EXISTS overtime_salary DOUBLE DEFAULT 0;

-- Recreate views to ensure columns are visible in tenant-isolated views
DROP VIEW IF EXISTS pos_staff;
CREATE VIEW pos_staff AS SELECT * FROM _pos_staff_base WHERE restaurant_id = current_restaurant_id();

DROP VIEW IF EXISTS pos_payroll;
CREATE VIEW pos_payroll AS SELECT * FROM _pos_payroll_base WHERE restaurant_id = current_restaurant_id();
