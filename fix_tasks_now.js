/**
 * IMMEDIATE FIX: Mark all tasks as delivered if their orders are completed
 * Usage: node fix_tasks_now.js
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixTasks() {
  let connection;
  
  try {
    console.log('[Fix] Connecting to database...');
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos',
      password: process.env.DB_PASSWORD || 'pos',
      database: process.env.DB_NAME || 'pos'
    });
    
    console.log('[Fix] Connected. Finding tasks with completed orders...');
    
    // Find tasks where order is completed but task is not delivered
    const [tasksToFix] = await connection.query(`
      SELECT t.id, t.order_number, t.status as task_status, o.status as order_status
      FROM _tasks_base t
      JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
      WHERE o.status = 'completed'
        AND t.status != 'delivered'
        AND t.restaurant_id = 3
    `);
    
    console.log(`[Fix] Found ${tasksToFix.length} tasks to fix`);
    
    if (tasksToFix.length > 0) {
      console.log('[Fix] Updating tasks to delivered status...');
      
      // Update all tasks where order is completed
      const [result] = await connection.query(`
        UPDATE _tasks_base t
        JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
        SET t.status = 'delivered',
            t.delivered_at = NOW()
        WHERE o.status = 'completed'
          AND t.status != 'delivered'
          AND t.restaurant_id = 3
      `);
      
      console.log(`[Fix] ✅ Updated ${result.affectedRows} tasks to delivered status`);
    } else {
      console.log('[Fix] ✅ No tasks need fixing - all are in sync!');
    }
    
    // Show current state
    const [allTasks] = await connection.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status NOT IN ('delivered', 'cancelled') THEN 1 ELSE 0 END) as active
      FROM _tasks_base
      WHERE restaurant_id = 3
    `);
    
    console.log('\n[Fix] Current task status summary:');
    console.table(allTasks);
    
  } catch (error) {
    console.error('[Fix] ❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('[Fix] Database connection closed.');
    }
  }
}

fixTasks();
