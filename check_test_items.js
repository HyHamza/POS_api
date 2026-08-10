/**
 * Check for existing test items that might be blocking inserts
 */

const mysql = require('mysql2/promise');

async function checkTestItems() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });

  try {
    console.log('🔍 Checking for existing TEST_ items in database\n');
    
    // Check for any TEST items
    const [testItems] = await conn.query(`
      SELECT id, name, restaurant_id, created_at 
      FROM _pos_menu_items_base 
      WHERE name LIKE 'TEST_%' OR name LIKE 'DIRECT_%' OR name LIKE 'POOL_%'
      ORDER BY created_at DESC
    `);
    
    if (testItems.length > 0) {
      console.log(`⚠️  Found ${testItems.length} test item(s):`);
      console.table(testItems);
      
      // Delete them
      const [result] = await conn.query(`
        DELETE FROM _pos_menu_items_base 
        WHERE name LIKE 'TEST_%' OR name LIKE 'DIRECT_%' OR name LIKE 'POOL_%'
      `);
      console.log(`\n🧹 Deleted ${result.affectedRows} test item(s)`);
    } else {
      console.log('✅ No test items found');
    }
    
    // Check for items with restaurant_id = 3
    console.log('\n📊 All items for restaurant_id = 3:');
    const [allItems] = await conn.query(`
      SELECT id, name, category_id, restaurant_id, created_at 
      FROM _pos_menu_items_base 
      WHERE restaurant_id = 3
      ORDER BY created_at DESC
      LIMIT 20
    `);
    
    if (allItems.length > 0) {
      console.table(allItems);
    } else {
      console.log('   (empty - no items found)');
    }
    
    // Check sync_events for menu_items
    console.log('\n📋 Recent sync_events for menu_items:');
    const [syncEvents] = await conn.query(`
      SELECT * 
      FROM sync_events 
      WHERE table_name = 'menu_items' AND restaurant_id = 3
      ORDER BY hlc DESC
      LIMIT 10
    `);
    
    if (syncEvents.length > 0) {
      console.table(syncEvents);
    } else {
      console.log('   (no sync events found)');
    }
    
  } finally {
    await conn.end();
  }
}

checkTestItems().catch(console.error);
