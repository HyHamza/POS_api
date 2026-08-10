/**
 * Check for triggers on _pos_menu_items_base table
 * Run: node check_triggers.js
 */

const mysql = require('mysql2/promise');

async function checkTriggers() {
  console.log('🔍 Checking for triggers and constraints\n');
  
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });

  try {
    // Check for triggers
    console.log('📋 1. Checking TRIGGERS on _pos_menu_items_base:');
    const [triggers] = await connection.query(`
      SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT
      FROM information_schema.TRIGGERS 
      WHERE EVENT_OBJECT_SCHEMA = 'pos' 
      AND EVENT_OBJECT_TABLE = '_pos_menu_items_base'
    `);
    
    if (triggers.length === 0) {
      console.log('   ✅ No triggers found\n');
    } else {
      console.log(`   ⚠️  Found ${triggers.length} trigger(s):\n`);
      triggers.forEach(t => {
        console.log(`   Trigger: ${t.TRIGGER_NAME}`);
        console.log(`   Timing: ${t.ACTION_TIMING} ${t.EVENT_MANIPULATION}`);
        console.log(`   Statement: ${t.ACTION_STATEMENT}`);
        console.log('');
      });
    }
    
    // Check table structure
    console.log('📋 2. Table structure:');
    const [columns] = await connection.query('DESCRIBE _pos_menu_items_base');
    console.table(columns);
    
    // Check for foreign key constraints
    console.log('\n📋 3. Foreign key constraints:');
    const [fks] = await connection.query(`
      SELECT 
        CONSTRAINT_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = 'pos'
      AND TABLE_NAME = '_pos_menu_items_base'
      AND REFERENCED_TABLE_NAME IS NOT NULL
    `);
    
    if (fks.length === 0) {
      console.log('   ✅ No foreign key constraints\n');
    } else {
      console.table(fks);
    }
    
    // Check for unique constraints
    console.log('\n📋 4. Indexes and unique constraints:');
    const [indexes] = await connection.query(`
      SHOW INDEXES FROM _pos_menu_items_base
    `);
    console.table(indexes.map(i => ({
      Key_name: i.Key_name,
      Column: i.Column_name,
      Non_unique: i.Non_unique,
      Type: i.Index_type
    })));
    
    // Try a direct INSERT and see what happens
    console.log('\n🧪 5. Testing direct INSERT:');
    await connection.beginTransaction();
    
    try {
      const testName = 'DIRECT_TEST_' + Date.now();
      console.log(`   Attempting to insert: ${testName}`);
      
      const [result] = await connection.query(`
        INSERT INTO _pos_menu_items_base 
        (name, category_id, restaurant_id, price, cost_price, is_available, created_at)
        VALUES (?, 1, 3, 100, 50, 1, NOW())
      `, [testName]);
      
      console.log(`   ✅ INSERT succeeded, insertId: ${result.insertId}, affectedRows: ${result.affectedRows}`);
      
      // Check if it exists
      const [[check1]] = await connection.query(
        'SELECT id, name FROM _pos_menu_items_base WHERE name = ?',
        [testName]
      );
      
      if (check1) {
        console.log(`   ✅ Row exists BEFORE commit: id=${check1.id}, name=${check1.name}`);
      } else {
        console.log(`   ❌ Row NOT found before commit (trigger deleted it?)`);
      }
      
      // Commit
      await connection.commit();
      console.log(`   ✅ Transaction COMMITTED`);
      
      // Check if it still exists after commit
      const [[check2]] = await connection.query(
        'SELECT id, name FROM _pos_menu_items_base WHERE name = ?',
        [testName]
      );
      
      if (check2) {
        console.log(`   ✅ Row exists AFTER commit: id=${check2.id}, name=${check2.name}`);
        console.log(`   ✅ SUCCESS - Direct INSERT works!`);
        
        // Clean up
        await connection.query('DELETE FROM _pos_menu_items_base WHERE name = ?', [testName]);
        console.log(`   🧹 Cleaned up test row`);
      } else {
        console.log(`   ❌ Row DISAPPEARED after commit!`);
        console.log(`   🔧 This indicates a COMMIT TRIGGER or constraint issue`);
      }
      
    } catch (err) {
      await connection.rollback();
      console.log(`   ❌ INSERT failed: ${err.message}`);
      console.log(`   Code: ${err.code}`);
      console.log(`   SQL State: ${err.sqlState}`);
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await connection.end();
  }
}

checkTriggers().catch(console.error);
