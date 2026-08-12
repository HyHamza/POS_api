/**
 * Run migration v8 — create app_releases table.
 * Usage: node run_migration_v8.js
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
      multipleStatements: true,
    });
    console.log('[Migration] Connected. Reading migration file...');
    const sql = fs.readFileSync('./migration_v8_app_releases.sql', 'utf8');
    console.log('[Migration] Executing migration...');
    await connection.query(sql);
    console.log('[Migration] ✅ v8 (app_releases) completed.');
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
