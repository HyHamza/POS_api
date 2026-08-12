-- Migration v7 (Simple): Sync tasks status when orders status changes
-- Run this in phpMyAdmin or MySQL CLI

-- Step 1: Drop existing trigger if it exists
DROP TRIGGER IF EXISTS sync_order_status_to_tasks;

-- Step 2: Create trigger to sync order status changes to tasks table
DELIMITER $$
CREATE TRIGGER sync_order_status_to_tasks
AFTER UPDATE ON _pos_orders_base
FOR EACH ROW
BEGIN
    -- Only process if status or rider_name changed
    IF (NEW.status != OLD.status OR NEW.rider_name != OLD.rider_name) THEN
        
        IF NEW.status = 'completed' THEN
            UPDATE _tasks_base 
            SET status = 'delivered', 
                delivered_at = NOW()
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'cancelled' THEN
            UPDATE _tasks_base 
            SET status = 'cancelled'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'delivering' THEN
            UPDATE _tasks_base 
            SET status = 'delivering'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'ready' OR NEW.status = 'ready_for_dispatch' THEN
            UPDATE _tasks_base 
            SET status = 'ready'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'preparing' THEN
            UPDATE _tasks_base 
            SET status = 'processing'
            WHERE order_number = NEW.order_number 
              AND restaurant_id = NEW.restaurant_id
              AND status NOT IN ('delivered', 'cancelled');
              
        ELSEIF NEW.status = 'pending' THEN
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

-- Step 3: One-time sync - Update existing tasks to match their order status
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

-- Step 4: Also sync rider assignments
UPDATE _tasks_base t
JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
JOIN _riders_base r ON r.full_name = o.rider_name AND r.restaurant_id = o.restaurant_id
SET t.rider_id = r.id,
    t.assigned_at = COALESCE(t.assigned_at, NOW())
WHERE o.rider_name IS NOT NULL 
  AND o.rider_name != ''
  AND t.rider_id IS NULL;

-- Done! Verify the results
SELECT 
    'Trigger installed!' as status,
    COUNT(*) as total_tasks,
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
    SUM(CASE WHEN status NOT IN ('delivered', 'cancelled') THEN 1 ELSE 0 END) as active
FROM _tasks_base
WHERE restaurant_id = 3;
