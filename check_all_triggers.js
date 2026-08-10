/**
 * Check ALL triggers on _pos_menu_items_base
 */

const mysql = require('mysql2/promise');

async function checkAllTriggers() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });

  try {
    console.log('🔍 Checking ALL triggers on _pos_menu_items_base\n');
    
    const [triggers] = await conn.query(`
      SELECT 
        TRIGGER_NAME,
        EVENT_MANIPULATION,
        ACTION_TIMING,
        ACTION_STATEMENT
      FROM information_schema.TRIGGERS 
      WHERE EVENT_OBJECT_SCHEMA = 'pos' 
      AND EVENT_OBJECT_TABLE = '_pos_menu_items_base'
      ORDER BY ACTION_TIMING, EVENT_MANIPULATION
    `);
    
    if (triggers.length === 0) {
      console.log('✅ No triggers found');
    } else {
      console.log(`⚠️  Found ${triggers.length} trigger(s):\n`);
      triggers.forEach((t, i) => {
        console.log(`\n━━━ Trigger ${i + 1}: ${t.TRIGGER_NAME} ━━━`);
        console.log(`Timing: ${t.ACTION_TIMING} ${t.EVENT_MANIPULATION}`);
        console.log(`Statement:`);
        console.log(t.ACTION_STATEMENT);
        console.log('━'.repeat(60));
      });
    }
    
    // Also check for any CASCADE deletes or foreign keys
    console.log('\n\n🔍 Checking for foreign key constraints:\n');
    const [fks] = await conn.query(`
      SELECT 
        CONSTRAINT_NAME,
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME,
        UPDATE_RULE,
        DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = 'pos'
      AND (TABLE_NAME = '_pos_menu_items_base' OR REFERENCED_TABLE_NAME = '_pos_menu_items_base')
      AND REFERENCED_TABLE_NAME IS NOT NULL
    `);
    
    if (fks.length === 0) {
      console.log('✅ No foreign key constraints');
    } else {
      console.table(fks);
    }
    
  } finally {
    await conn.end();
  }
}

checkAllTriggers().catch(console.error);
