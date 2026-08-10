/**
 * Test client to simulate menu item sync
 * Run: node test_menu_sync.js
 */

const axios = require('axios');
const mysql = require('mysql2/promise');

const API_URL = 'http://localhost:3000';
const LICENSE_KEY = 'LIC-E41054859E880F9C';
const DEVICE_ID = 'test-device-' + Date.now();

async function testMenuSync() {
  console.log('🧪 Starting Menu Sync Test\n');
  console.log('=' .repeat(80));
  
  // Create database connection for verification
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });
  
  try {
    // Step 1: Check initial state
    console.log('\n📊 STEP 1: Checking initial database state');
    const [[before]] = await db.query('SELECT COUNT(*) as cnt FROM _pos_menu_items_base WHERE restaurant_id = 3');
    console.log(`   Initial count: ${before.cnt} items`);
    
    // Step 2: Prepare menu item payload
    console.log('\n📦 STEP 2: Preparing test menu item');
    const testItem = {
      menu_items: [{
        id: 999,
        category_id: 4,
        name: 'TEST_BURGER_' + Date.now(),
        description: 'Test item',
        price: 500,
        cost_price: 200,
        image_path: null,
        dietary_tags: '[]',
        variants: '[]',
        is_available: 1,
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        is_deleted: 0,
        deleted_at: null,
        hlc: null,
        origin_device_id: null,
        sync_device_id: 'test-sync-' + Date.now(),
        price_hlc: null,
        description_hlc: null,
        is_available_hlc: null,
        category_id_hlc: null,
        cost_price_hlc: null,
        image_path_hlc: null,
        dietary_tags_hlc: null,
        variants_hlc: null,
        category_name: 'Burgers',
        _operation: 'INSERT',
        _hlc: Date.now() + ':0:' + DEVICE_ID,
        _origin_device_id: DEVICE_ID,
        _sync_device_id: 'test-sync-' + Date.now(),
        _change_id: 'test-change-' + Date.now(),
        _txn_id: null,
        _changed_fields: null,
        change_id: 'test-change-' + Date.now(),
        txn_id: null
      }]
    };
    
    console.log(`   Item name: ${testItem.menu_items[0].name}`);
    console.log(`   Change ID: ${testItem.menu_items[0].change_id}`);
    
    // Step 3: Send to API
    console.log('\n📤 STEP 3: Sending POST /api/pos/sync/import');
    const response = await axios.post(
      `${API_URL}/api/pos/sync/import`,
      testItem,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-license-key': LICENSE_KEY,
          'x-client-id': DEVICE_ID
        }
      }
    );
    
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, JSON.stringify(response.data, null, 2));
    
    // Step 4: Wait a moment for commit
    console.log('\n⏳ STEP 4: Waiting 1 second for transaction to complete...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 5: Check if item exists in database
    console.log('\n🔍 STEP 5: Checking if item exists in database');
    const [[after]] = await db.query('SELECT COUNT(*) as cnt FROM _pos_menu_items_base WHERE restaurant_id = 3');
    console.log(`   Final count: ${after.cnt} items`);
    console.log(`   Difference: ${after.cnt - before.cnt} (should be +1)`);
    
    // Step 6: Try to find the specific item
    const [[found]] = await db.query(
      'SELECT id, name, category_id, price, restaurant_id FROM _pos_menu_items_base WHERE name = ?',
      [testItem.menu_items[0].name]
    );
    
    if (found) {
      console.log(`   ✅ SUCCESS! Item found in database:`);
      console.log(`      ID: ${found.id}`);
      console.log(`      Name: ${found.name}`);
      console.log(`      Restaurant ID: ${found.restaurant_id}`);
      console.log(`      Price: ${found.price}`);
    } else {
      console.log(`   ❌ FAILURE! Item NOT found in database!`);
      console.log(`      This means the INSERT was rolled back or never committed.`);
    }
    
    // Step 7: Check sync_events
    console.log('\n🔍 STEP 6: Checking sync_events table');
    const [[syncEvent]] = await db.query(
      'SELECT change_id, restaurant_id, table_name, row_id FROM sync_events WHERE change_id = ?',
      [testItem.menu_items[0].change_id]
    );
    
    if (syncEvent) {
      console.log(`   ✅ Sync event registered:`);
      console.log(`      Change ID: ${syncEvent.change_id}`);
      console.log(`      Table: ${syncEvent.table_name}`);
      console.log(`      Row ID: ${syncEvent.row_id}`);
      console.log(`      Restaurant ID: ${syncEvent.restaurant_id}`);
    } else {
      console.log(`   ❌ No sync event found!`);
    }
    
    console.log('\n' + '='.repeat(80));
    
    if (found) {
      console.log('✅ TEST PASSED: Menu item synced successfully!');
      // Clean up
      await db.query('DELETE FROM _pos_menu_items_base WHERE name = ?', [testItem.menu_items[0].name]);
      console.log('🧹 Cleaned up test item');
    } else {
      console.log('❌ TEST FAILED: Menu item did not persist in database!');
      console.log('\n🔧 DIAGNOSIS:');
      console.log('   - API returned success but data is not in database');
      console.log('   - Possible causes:');
      console.log('     1. Transaction was rolled back after insert');
      console.log('     2. INSERT went to wrong table');
      console.log('     3. Trigger or constraint preventing insert');
      console.log('     4. Connection pool issue causing transaction isolation problems');
    }
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
  } finally {
    await db.end();
  }
}

testMenuSync().catch(console.error);
