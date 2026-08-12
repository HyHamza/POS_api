-- Migration v7: Sync tasks status when orders status changes
-- This ensures that when orders are marked as completed/cancelled in POS_win,
-- the corresponding delivery tasks are automatically updated

USE pos;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS sync_order_status_to_tasks;

-- Create trigger to sync order status changes to tasks table
DELIMITER $$
CREATE TRIGGER sync_order_status_to_tasks
AFTER UPDATE ON _pos_orders_base
FOR EACH ROW
BEGIN
    -- Only process if status or rider_name changed
    IF (NEW.status != OLD.status OR NEW.rider_name != OLD.rider_name) THEN
        
        -- Map order status to task status
        -- Order status: pending, preparing, ready, delivering, completed, cancelled
        -- Task status: pending, cooking, processing, ready, delivering, delivered, cancelled
        
        IF NEW.status = 'completed' THEN
            -- Order completed -> Task delivered
            UPDATE _tasks_base 
            SET status = 'delivered', 
                delivered_at = NOW()
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'cancelled' THEN
            -- Order cancelled -> Task cancelled
            UPDATE _tasks_base 
            SET status = 'cancelled'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'delivering' THEN
            -- Order out for delivery -> Task delivering
            UPDATE _tasks_base 
            SET status = 'delivering'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'ready' OR NEW.status = 'ready_for_dispatch' THEN
            -- Order ready -> Task ready
            UPDATE _tasks_base 
            SET status = 'ready'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'preparing' THEN
            -- Order preparing -> Task processing
            UPDATE _tasks_base 
            SET status = 'processing'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'pending' THEN
            -- Order pending -> Task cooking
            UPDATE _tasks_base 
            SET status = 'cooking'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
        END IF;
        
        -- Sync rider_name to rider_id if provided
        IF NEW.rider_name IS NOT NULL AND NEW.rider_name != '' THEN
            UPDATE _tasks_base t
            JOIN _riders_base r ON r.full_name = NEW.rider_name AND r.restaurant_id = NEW.restaurant_id
            SET t.rider_id = r.id,
                t.assigned_at = NOW()
            WHERE t.order_number = NEW.order_number 
              AND t.restaurant_id = NEW.restaurant_id
              AND t.rider_id IS NULL;
        END IF;
    END IF;
END$$
DELIMITER ;

-- One-time sync: Update existing tasks to match their order status
UPDATE _tasks_base t
JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
SET t.status = CASE
    WHEN o.status = 'completed' THEN 'delivered'
    WHEN o.status = 'cancelled' THEN 'cancelled'
    WHEN o.status = 'delivering' THEN 'delivering'
    WHEN o.status = 'ready' OR o.status = 'ready_for_dispatch' THEN 'ready'
    WHEN o.status = 'preparing' THEN 'processing'
    WHEN o.status = 'pending' THEN 'cooking'
    ELSE t.status
END,
t.delivered_at = IF(o.status = 'completed' AND t.delivered_at IS NULL, NOW(), t.delivered_at)
WHERE t.status NOT IN ('delivered', 'cancelled');

-- Also sync rider assignments
UPDATE _tasks_base t
JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
JOIN _riders_base r ON r.full_name = o.rider_name AND r.restaurant_id = o.restaurant_id
SET t.rider_id = r.id,
    t.assigned_at = COALESCE(t.assigned_at, NOW())
WHERE o.rider_name IS NOT NULL 
  AND o.rider_name != ''
  AND t.rider_id IS NULL;

-- Create schema_migrations table if it doesn't exist
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Log migration
INSERT INTO schema_migrations (version, applied_at) 
VALUES ('v7_sync_tasks', NOW())
ON DUPLICATE KEY UPDATE applied_at = NOW();

SELECT 'Migration v7 completed: Tasks will now auto-sync with order status changes' AS status;
