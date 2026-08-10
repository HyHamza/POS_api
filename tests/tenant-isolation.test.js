/**
 * Tenant Isolation Test Suite
 * 
 * Verifies that the multi-tenant POS system correctly isolates data between restaurants.
 * Tests the fixes applied in BUG 1.
 * 
 * Requirements:
 * - Jest test framework
 * - Test database with 2+ restaurants configured
 * - License keys for each test restaurant
 */

const request = require('supertest');
const { mainPool } = require('../config/db');

// Test configuration
const TEST_RESTAURANTS = [
  {
    name: 'Restaurant Alpha',
    licenseKey: process.env.TEST_LICENSE_KEY_1 || 'TEST-ALPHA-LICENSE-KEY',
    adminUsername: 'admin_alpha',
    adminPassword: 'test1234',
  },
  {
    name: 'Restaurant Beta',
    licenseKey: process.env.TEST_LICENSE_KEY_2 || 'TEST-BETA-LICENSE-KEY',
    adminUsername: 'admin_beta',
    adminPassword: 'test1234',
  },
];

let app;
let restaurant1Id, restaurant2Id;

// Setup: Create test restaurants and seed data
beforeAll(async () => {
  // Import app after environment is set
  app = require('../server');
  
  // Create test restaurants
  for (const restaurant of TEST_RESTAURANTS) {
    const [result] = await mainPool.query(
      'INSERT INTO restaurants (name, license_key, status, plan_type) VALUES (?, ?, ?, ?)',
      [restaurant.name, restaurant.licenseKey, 'active', 'lifetime']
    );
    
    const restaurantId = result.insertId;
    if (restaurant.licenseKey === TEST_RESTAURANTS[0].licenseKey) {
      restaurant1Id = restaurantId;
    } else {
      restaurant2Id = restaurantId;
    }
    
    // Create admin user
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(restaurant.adminPassword, 10);
    await mainPool.query(
      'INSERT INTO _admins_base (restaurant_id, username, password_hash) VALUES (?, ?, ?)',
      [restaurantId, restaurant.adminUsername, passwordHash]
    );
    
    // Seed test data
    await seedTestData(restaurantId, restaurant.name);
  }
});

// Teardown: Clean up test data
afterAll(async () => {
  // Delete test restaurants and cascade delete all related data
  for (const restaurant of TEST_RESTAURANTS) {
    await mainPool.query('DELETE FROM restaurants WHERE license_key = ?', [restaurant.licenseKey]);
  }
  
  await mainPool.end();
});

// Helper: Seed test data for a restaurant
async function seedTestData(restaurantId, restaurantName) {
  // Create staff
  await mainPool.query(
    'INSERT INTO _pos_staff_base (restaurant_id, name, username, pin_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
    [restaurantId, `Manager ${restaurantName}`, `manager_${restaurantId}`, 'hash123', 'Manager', 'Active']
  );
  
  // Create menu category
  await mainPool.query(
    'INSERT INTO _pos_menu_categories_base (restaurant_id, name, display_order) VALUES (?, ?, ?)',
    [restaurantId, `Drinks ${restaurantName}`, 1]
  );
  
  // Create order
  await mainPool.query(
    'INSERT INTO _pos_orders_base (restaurant_id, order_number, type, status, subtotal, total) VALUES (?, ?, ?, ?, ?, ?)',
    [restaurantId, `ORD-${restaurantId}-001`, 'Dine-In', 'completed', 100, 100]
  );
  
  // Create rider
  const bcrypt = require('bcryptjs');
  const riderPasswordHash = await bcrypt.hash('rider1234', 10);
  await mainPool.query(
    'INSERT INTO _riders_base (restaurant_id, username, password_hash, full_name, status, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [restaurantId, `rider_${restaurantId}`, riderPasswordHash, `Rider ${restaurantName}`, 'offline', 1]
  );
}

describe('Tenant Isolation - BUG 1 Verification', () => {
  
  describe('1. Full Export Data Isolation', () => {
    test('Restaurant 1 receives only its own data', async () => {
      const response = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      // Verify all rows belong to restaurant1Id
      for (const [table, rows] of Object.entries(response.body.data)) {
        for (const row of rows) {
          if (row.restaurant_id) {
            expect(row.restaurant_id).toBe(restaurant1Id);
          }
        }
      }
      
      // Verify counts match only restaurant 1's data
      expect(response.body.counts).toBeDefined();
      const staffCount = response.body.counts.pos_staff || 0;
      
      // Query actual count for restaurant 1
      const [[actual]] = await mainPool.query(
        'SELECT COUNT(*) as c FROM _pos_staff_base WHERE restaurant_id = ?',
        [restaurant1Id]
      );
      expect(staffCount).toBe(actual.c);
    });
    
    test('Restaurant 2 receives only its own data', async () => {
      const response = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[1].licenseKey)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      // Verify all rows belong to restaurant2Id
      for (const [table, rows] of Object.entries(response.body.data)) {
        for (const row of rows) {
          if (row.restaurant_id) {
            expect(row.restaurant_id).toBe(restaurant2Id);
          }
        }
      }
    });
    
    test('Admin credentials are isolated per tenant', async () => {
      const response1 = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .expect(200);
      
      const response2 = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[1].licenseKey)
        .expect(200);
      
      const admins1 = response1.body.data.admins || [];
      const admins2 = response2.body.data.admins || [];
      
      // Each restaurant should only see its own admin
      expect(admins1.every(a => a.restaurant_id === restaurant1Id)).toBe(true);
      expect(admins2.every(a => a.restaurant_id === restaurant2Id)).toBe(true);
      
      // Should not see each other's admins
      expect(admins1.some(a => a.restaurant_id === restaurant2Id)).toBe(false);
      expect(admins2.some(a => a.restaurant_id === restaurant1Id)).toBe(false);
    });
    
    test('Zero cross-tenant data leakage', async () => {
      const response1 = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .expect(200);
      
      let crossTenantLeaks = 0;
      for (const [table, rows] of Object.entries(response1.body.data)) {
        for (const row of rows) {
          if (row.restaurant_id && row.restaurant_id !== restaurant1Id) {
            crossTenantLeaks++;
            console.error(`LEAK DETECTED: ${table} row ${row.id} belongs to restaurant ${row.restaurant_id}`);
          }
        }
      }
      
      expect(crossTenantLeaks).toBe(0);
    });
  });
  
  describe('2. Admin Login Isolation', () => {
    test('Admin can log in with correct license key', async () => {
      const response = await request(app)
        .post('/api/auth/admin/login')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .send({
          username: TEST_RESTAURANTS[0].adminUsername,
          password: TEST_RESTAURANTS[0].adminPassword,
        })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.admin.restaurantId).toBe(restaurant1Id);
    });
    
    test('Admin cannot log in with wrong license key', async () => {
      const response = await request(app)
        .post('/api/auth/admin/login')
        .set('x-license-key', TEST_RESTAURANTS[1].licenseKey) // Wrong license key
        .send({
          username: TEST_RESTAURANTS[0].adminUsername, // Restaurant 1's admin
          password: TEST_RESTAURANTS[0].adminPassword,
        })
        .expect(401);
      
      expect(response.body.success).toBe(false);
    });
    
    test('Admin login requires license key', async () => {
      const response = await request(app)
        .post('/api/auth/admin/login')
        // No license key header
        .send({
          username: TEST_RESTAURANTS[0].adminUsername,
          password: TEST_RESTAURANTS[0].adminPassword,
        })
        .expect(400);
      
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Restaurant context');
    });
  });
  
  describe('3. Rider Login Isolation', () => {
    test('Rider can log in with correct license key', async () => {
      const response = await request(app)
        .post('/api/auth/rider/login')
        .send({
          username: `rider_${restaurant1Id}`,
          password: 'rider1234',
          license_key: TEST_RESTAURANTS[0].licenseKey,
        })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.rider.restaurantId).toBe(restaurant1Id);
    });
    
    test('Rider cannot log in with wrong license key', async () => {
      const response = await request(app)
        .post('/api/auth/rider/login')
        .send({
          username: `rider_${restaurant1Id}`, // Restaurant 1's rider
          password: 'rider1234',
          license_key: TEST_RESTAURANTS[1].licenseKey, // Wrong license key
        })
        .expect(401);
      
      expect(response.body.success).toBe(false);
    });
    
    test('Rider login requires license key', async () => {
      const response = await request(app)
        .post('/api/auth/rider/login')
        .send({
          username: `rider_${restaurant1Id}`,
          password: 'rider1234',
          // No license_key
        })
        .expect(400);
      
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('License key');
    });
  });
  
  describe('4. Data Query Isolation', () => {
    test('getAllRiders returns only tenant riders', async () => {
      const response = await request(app)
        .get('/api/riders')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      const riders = response.body.data;
      
      // All riders should belong to restaurant1Id
      expect(riders.every(r => r.restaurant_id === restaurant1Id)).toBe(true);
      expect(riders.some(r => r.restaurant_id === restaurant2Id)).toBe(false);
    });
    
    test('getAllTasks returns only tenant tasks', async () => {
      // Create a task for restaurant 1
      await mainPool.query(
        'INSERT INTO _tasks_base (restaurant_id, customer_name, delivery_address, status) VALUES (?, ?, ?, ?)',
        [restaurant1Id, 'Test Customer', '123 Main St', 'pending']
      );
      
      // Admin login to get token
      const loginResponse = await request(app)
        .post('/api/auth/admin/login')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .send({
          username: TEST_RESTAURANTS[0].adminUsername,
          password: TEST_RESTAURANTS[0].adminPassword,
        });
      
      const token = loginResponse.body.data.accessToken;
      
      const response = await request(app)
        .get('/api/tasks')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      const tasks = response.body.data;
      
      // All tasks should belong to restaurant1Id
      expect(tasks.every(t => t.restaurant_id === restaurant1Id)).toBe(true);
      expect(tasks.some(t => t.restaurant_id === restaurant2Id)).toBe(false);
    });
  });
  
  describe('5. Data Mutation Isolation', () => {
    test('Cannot create rider for different restaurant', async () => {
      // This test verifies that createRider scopes by tenant
      const response = await request(app)
        .post('/api/riders')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .send({
          username: 'test_rider_alpha',
          password: 'test1234',
          full_name: 'Test Rider Alpha',
          phone: '1234567890',
        })
        .expect(201);
      
      expect(response.body.success).toBe(true);
      const riderId = response.body.data.id;
      
      // Verify rider belongs to restaurant1Id
      const [[rider]] = await mainPool.query(
        'SELECT restaurant_id FROM _riders_base WHERE id = ?',
        [riderId]
      );
      expect(rider.restaurant_id).toBe(restaurant1Id);
      
      // Verify restaurant 2 cannot see this rider
      const response2 = await request(app)
        .get('/api/riders')
        .set('x-license-key', TEST_RESTAURANTS[1].licenseKey)
        .expect(200);
      
      const riders2 = response2.body.data;
      expect(riders2.some(r => r.id === riderId)).toBe(false);
    });
  });
  
  describe('6. Count Accuracy', () => {
    test('Export counts match actual database counts', async () => {
      const response = await request(app)
        .get('/api/pos/sync/full-export')
        .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
        .expect(200);
      
      const counts = response.body.counts;
      
      // Verify each table's count
      const tables = ['pos_staff', 'pos_orders', 'pos_menu_categories', 'riders'];
      for (const table of tables) {
        const baseTable = `_${table.replace('pos_', 'pos_')}_base`;
        const [[actual]] = await mainPool.query(
          `SELECT COUNT(*) as c FROM \`${baseTable}\` WHERE restaurant_id = ?`,
          [restaurant1Id]
        );
        
        expect(counts[table]).toBe(actual.c);
      }
    });
  });
});

describe('Performance - Tenant Isolation Overhead', () => {
  test('Full export completes within acceptable time', async () => {
    const startTime = Date.now();
    
    await request(app)
      .get('/api/pos/sync/full-export')
      .set('x-license-key', TEST_RESTAURANTS[0].licenseKey)
      .expect(200);
    
    const duration = Date.now() - startTime;
    
    // Should complete within 5 seconds for test data
    expect(duration).toBeLessThan(5000);
  }, 10000);
});
