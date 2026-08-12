/**
 * Run migration v7 to sync tasks with order status
 * Usage: node run_migration_v7.js
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

async function runMigration() {
  let connection;
  
  try {
    console.log('[Migration] Connecting to database...');
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos',
      password: process.env.DB_PASSWORD || 'pos',
      database: process.env.DB_NAME || 'pos',
      multipleStatements: true
    });
    
    console.log('[Migration] Connected. Reading migration file...');
    const sql = fs.readFileSync('./migration_v7_sync_tasks.sql', 'utf8');
    
    console.log('[Migration] Executing migration...');
    const [results] = await connection.query(sql);
    
    console.log('[Migration] ✅ Migration v7 completed successfully!');
    console.log('[Migration] Tasks are now synced with order status.');
    
    // Show updated tasks
    const [tasks] = await connection.query(`
      SELECT t.id, t.order_number, t.status as task_status, o.status as order_status
      FROM _tasks_base t
      JOIN _pos_orders_base o ON t.order_number = o.order_number AND t.restaurant_id = o.restaurant_id
      WHERE t.restaurant_id = 3
      ORDER BY t.id DESC
      LIMIT 10
    `);
    
    console.log('\n[Migration] Sample of updated tasks:');
    console.table(tasks);
    
  } catch (error) {
    console.error('[Migration] ❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('[Migration] Database connection closed.');
    }
  }
}

runMigration();
