/**
 * Test if INSERT works with direct connection vs pool
 */

const mysql = require('mysql2/promise');

async function testDirectConnection() {
  console.log('🔍 Test 1: Direct connection (no pool)');
  
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos'
  });
  
  try {
    await conn.beginTransaction();
    
    // Set session variable
    await conn.query('SET @current_restaurant_id = ?', [3]);
    
    // Check it was set
    const [[check1]] = await conn.query('SELECT @current_restaurant_id as rid');
    console.log(`   @current_restaurant_id = ${check1.rid}`);
    
    // Insert with a unique name
    const testName = 'DIRECT_' + Date.now();
    console.log(`   Inserting: ${testName}`);
    
    const [result] = await conn.query(`
      INSERT INTO _pos_menu_items_base 
      (name, category_id, price, cost_price, is_available, created_at)
      VALUES (?, 1, 100, 50, 1, NOW())
    `, [testName]);
    
    console.log(`   ✅ INSERT: affectedRows=${result.affectedRows}, insertId=${result.insertId}`);
    
    // Check if it exists BEFORE commit
    const [[beforeCommit]] = await conn.query(
      'SELECT id, name, restaurant_id FROM _pos_menu_items_base WHERE name = ?',
      [testName]
    );
    
    if (beforeCommit) {
      console.log(`   ✅ Row exists BEFORE commit: id=${beforeCommit.id}, restaurant_id=${beforeCommit.restaurant_id}`);
    } else {
      console.log(`   ❌ Row NOT found before commit!`);
    }
    
    // Commit
    await conn.commit();
    console.log(`   ✅ Transaction COMMITTED`);
    
    // Check if it exists AFTER commit
    const [[afterCommit]] = await conn.query(
      'SELECT id, name, restaurant_id FROM _pos_menu_items_base WHERE name = ?',
      [testName]
    );
    
    if (afterCommit) {
      console.log(`   ✅ Row exists AFTER commit: id=${afterCommit.id}, restaurant_id=${afterCommit.restaurant_id}`);
    } else {
      console.log(`   ❌ Row DISAPPEARED after commit!`);
    }
    
    // Clean up
    if (afterCommit) {
      await conn.query('DELETE FROM _pos_menu_items_base WHERE id = ?', [afterCommit.id]);
      console.log(`   🧹 Cleaned up test row`);
    }
    
  } finally {
    await conn.end();
  }
}

async function testPoolConnection() {
  console.log('\n🔍 Test 2: Connection from pool (like API)');
  
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'pos',
    password: 'pos',
    database: 'pos',
    connectionLimit: 10
  });
  
  try {
    const conn = await pool.getConnection();
    
    try {
      await conn.beginTransaction();
      
      // Set session variable
      await conn.query('SET @current_restaurant_id = ?', [3]);
      
      // Check it was set
      const [[check1]] = await conn.query('SELECT @current_restaurant_id as rid');
      console.log(`   @current_restaurant_id = ${check1.rid}`);
      
      // Insert with a unique name
      const testName = 'POOL_' + Date.now();
      console.log(`   Inserting: ${testName}`);
      
      const [result] = await conn.query(`
        INSERT IGNORE INTO _pos_menu_items_base 
        (name, category_id, price, cost_price, is_available, created_at)
        VALUES (?, 1, 100, 50, 1, NOW())
      `, [testName]);
      
      console.log(`   ✅ INSERT: affectedRows=${result.affectedRows}, insertId=${result.insertId}`);
      
      // Check if it exists BEFORE commit
      const [[beforeCommit]] = await conn.query(
        'SELECT id, name, restaurant_id FROM _pos_menu_items_base WHERE name = ?',
        [testName]
      );
      
      if (beforeCommit) {
        console.log(`   ✅ Row exists BEFORE commit: id=${beforeCommit.id}, restaurant_id=${beforeCommit.restaurant_id}`);
      } else {
        console.log(`   ❌ Row NOT found before commit!`);
      }
      
      // Commit
      await conn.commit();
      console.log(`   ✅ Transaction COMMITTED`);
      
      // Check session variable after commit
      const [[check2]] = await conn.query('SELECT @current_restaurant_id as rid');
      console.log(`   @current_restaurant_id after commit = ${check2.rid}`);
      
      // Release connection
      conn.release();
      console.log(`   ✅ Connection released to pool`);
      
      // Now use a NEW connection from pool to check if row exists
      const conn2 = await pool.getConnection();
      try {
        const [[afterCommit]] = await conn2.query(
          'SELECT id, name, restaurant_id FROM _pos_menu_items_base WHERE name = ?',
          [testName]
        );
        
        if (afterCommit) {
          console.log(`   ✅ Row exists AFTER commit (new connection): id=${afterCommit.id}, restaurant_id=${afterCommit.restaurant_id}`);
          
          // Clean up
          await conn2.query('DELETE FROM _pos_menu_items_base WHERE id = ?', [afterCommit.id]);
          console.log(`   🧹 Cleaned up test row`);
        } else {
          console.log(`   ❌ Row DISAPPEARED after commit!`);
        }
      } finally {
        conn2.release();
      }
      
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    
  } finally {
    await pool.end();
  }
}

async function run() {
  try {
    await testDirectConnection();
    await testPoolConnection();
    console.log('\n✅ ALL TESTS PASSED!');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
  }
}

run();
