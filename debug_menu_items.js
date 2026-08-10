/**
 * Debug script to check menu_items data in database
 * Run: node debug_menu_items.js
 */

const mysql = require('mysql2/promise');

async function checkDatabase() {
  console.log('🔍 Connecting to database...\n');
  
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });

  try {
    console.log('✅ Connected!\n');
    console.log('=' .repeat(80));
    
    // 1. Check total rows in base table
    console.log('\n📊 1. Total rows in _pos_menu_items_base (all restaurants):');
    const [[row1]] = await connection.query('SELECT COUNT(*) as total FROM _pos_menu_items_base');
    console.log(`   Total: ${row1.total} rows`);
    
    // 2. Check rows for restaurant 3
    console.log('\n📊 2. Total rows for restaurant_id = 3:');
    const [[row2]] = await connection.query('SELECT COUNT(*) as total FROM _pos_menu_items_base WHERE restaurant_id = 3');
    console.log(`   Total: ${row2.total} rows`);
    
    // 3. Show all rows in base table
    console.log('\n📋 3. All rows in _pos_menu_items_base:');
    const [rows] = await connection.query('SELECT id, name, category_id, restaurant_id, hlc FROM _pos_menu_items_base LIMIT 20');
    if (rows.length === 0) {
      console.log('   ❌ NO ROWS FOUND!');
    } else {
      console.table(rows);
    }
    
    // 4. Check if pos_menu_items is a VIEW or TABLE
    console.log('\n🔍 4. Checking pos_menu_items type:');
    const [[tableInfo]] = await connection.query(
      "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'pos' AND TABLE_NAME = 'pos_menu_items'"
    );
    console.log(`   Type: ${tableInfo.TABLE_TYPE}`);
    
    // 5. If it's a VIEW, show the VIEW definition
    if (tableInfo.TABLE_TYPE === 'VIEW') {
      console.log('\n📜 5. VIEW definition for pos_menu_items:');
      const [[viewDef]] = await connection.query('SHOW CREATE VIEW pos_menu_items');
      console.log(viewDef['Create View']);
    }
    
    // 6. Check sync_events for menu_items
    console.log('\n📊 6. Sync events for menu_items (table_name = "menu_items"):');
    const [syncEvents] = await connection.query(
      'SELECT change_id, restaurant_id, table_name, row_id, device_id FROM sync_events WHERE table_name = "menu_items" ORDER BY processed_at DESC LIMIT 10'
    );
    if (syncEvents.length === 0) {
      console.log('   ❌ NO SYNC EVENTS FOUND!');
    } else {
      console.table(syncEvents);
    }
    
    // 7. Check if @current_restaurant_id is set
    console.log('\n🔍 7. Testing @current_restaurant_id session variable:');
    await connection.query('SET @current_restaurant_id = 3');
    const [[varCheck]] = await connection.query('SELECT @current_restaurant_id as restaurant_id');
    console.log(`   Session variable: ${varCheck.restaurant_id}`);
    
    // 8. Test INSERT with @current_restaurant_id
    console.log('\n🧪 8. Testing INSERT with @current_restaurant_id:');
    try {
      await connection.query('SET @current_restaurant_id = 3');
      await connection.query(`
        INSERT INTO _pos_menu_items_base 
        (name, category_id, restaurant_id, price, cost_price, is_available, created_at, hlc, origin_device_id)
        VALUES ('TEST_ITEM', 1, 3, 100, 50, 1, NOW(), '1786186400000:0:test', 'test-device')
      `);
      console.log('   ✅ INSERT succeeded!');
      
      // Check if it persisted
      const [[check]] = await connection.query(
        "SELECT id, name, restaurant_id FROM _pos_menu_items_base WHERE name = 'TEST_ITEM'"
      );
      if (check) {
        console.log(`   ✅ Row found in database: id=${check.id}, name=${check.name}, restaurant_id=${check.restaurant_id}`);
        // Clean up
        await connection.query(`DELETE FROM _pos_menu_items_base WHERE name = 'TEST_ITEM'`);
        console.log('   🧹 Cleaned up test row');
      } else {
        console.log('   ❌ Row NOT FOUND after insert! (Possible trigger/constraint issue)');
      }
    } catch (err) {
      console.log(`   ❌ INSERT failed: ${err.message}`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ Diagnostic complete!');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
  } finally {
    await connection.end();
  }
}

checkDatabase().catch(console.error);
