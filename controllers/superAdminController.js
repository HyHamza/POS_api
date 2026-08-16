const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { mainPool } = require('../config/db');

require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

const login = async (req, res) => {
  const { username = 'admin', password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Username and password are required.'
    });
  }

  try {
    const [rows] = await mainPool.query('SELECT * FROM super_admins WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials.'
      });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials.'
      });
    }

    const token = jwt.sign({ role: 'super_admin', username: admin.username }, JWT_SECRET, { expiresIn: '1d' });

    return res.json({
      success: true,
      data: { token }
    });
  } catch (err) {
    console.error('Super Admin login error:', err);
    return res.status(500).json({
      success: false,
      error: 'An internal server error occurred during login.'
    });
  }
};

const getRestaurants = async (req, res) => {
  try {
    const [rows] = await mainPool.query('SELECT * FROM restaurants ORDER BY created_at DESC');
    
    // Check and update expiration status dynamically
    const now = new Date();
    for (const r of rows) {
      if (r.expires_at && now > new Date(r.expires_at) && r.status === 'active') {
        r.status = 'expired';
        await mainPool.query('UPDATE restaurants SET status = ? WHERE id = ?', ['expired', r.id]);
        
        // Update pos settings base
        await mainPool.query(
          'INSERT INTO _pos_settings_base (restaurant_id, `key`, `value`) VALUES (?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE `value` = ?',
          [r.id, 'licenseStatus', 'expired', 'expired']
        );
      }
    }

    return res.json({
      success: true,
      data: rows
    });
  } catch (err) {
    console.error('Failed to fetch restaurants:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch restaurants list.'
    });
  }
};

const createRestaurant = async (req, res) => {
  const { name, adminUsername, adminPassword, adminEmail, planType, customDays } = req.body;

  if (!name || !adminUsername || !adminPassword) {
    return res.status(400).json({
      success: false,
      error: 'Restaurant name, admin username, and admin password are required.'
    });
  }

  // Calculate expires_at based on planType
  let expiresAt = null;
  const pType = planType || 'lifetime';
  if (pType === 'monthly') {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
  } else if (pType === 'yearly') {
    expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  } else if (pType === 'trial') {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
  } else if (pType === 'custom') {
    const days = parseInt(customDays, 10) || 30;
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
  }

  // Generate licenseKey
  const licenseKey = `LIC-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  try {
    // 1. Insert record into main registry database
    const [result] = await mainPool.query(
      'INSERT INTO restaurants (name, license_key, status, plan_type, expires_at) VALUES (?, ?, ?, ?, ?)',
      [name, licenseKey, 'active', pType, expiresAt]
    );

    const restaurantId = result.insertId;

    // 2. Create the initial admin user in the base admins table
    console.log(`[Super Admin] Creating admin user '${adminUsername}' for restaurant ID ${restaurantId}...`);
    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
    await mainPool.query(
      'INSERT INTO _admins_base (restaurant_id, username, password_hash, email) VALUES (?, ?, ?, ?)',
      [restaurantId, adminUsername, adminPasswordHash, adminEmail || null]
    );

    // 3. Hash pin for POS admin staff user
    const pin = /^\d+$/.test(adminPassword) ? adminPassword : '0000';
    const pinHash = crypto.createHash('sha256').update(String(pin)).digest('hex');

    // 4. Create initial admin staff user in _pos_staff_base
    await mainPool.query(
      'INSERT INTO _pos_staff_base (restaurant_id, name, username, pin_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      [restaurantId, 'Admin User', adminUsername, pinHash, 'Admin', 'Active']
    );

    // 5. Seed default settings in _pos_settings_base
    const expiresAtStr = expiresAt ? expiresAt.toISOString().slice(0, 19).replace('T', ' ') : '';
    const settingsToSeed = [
      ['restaurantName', name],
      ['currency', 'PKR'],
      ['currencyPlacement', 'before'],
      ['taxRate', '0'],
      ['taxName', 'Tax'],
      ['tableCount', '10'],
      ['setupComplete', '1'],
      ['networkMode', 'admin'],
      ['licenseKey', licenseKey],
      ['licenseStatus', 'active'],
      ['expiresAt', expiresAtStr],
      ['planType', pType]
    ];
    for (const [key, val] of settingsToSeed) {
      await mainPool.query(
        'INSERT INTO _pos_settings_base (restaurant_id, \`key\`, \`value\`) VALUES (?, ?, ?)',
        [restaurantId, key, val]
      );
    }

    // 6. Seed default categories in _pos_menu_categories_base
    const categoriesToSeed = [
      ['Drinks', 1],
      ['Pizza', 2],
      ['Wraps', 3],
      ['Burgers', 4],
      ['Desserts', 5],
      ['Sides', 6]
    ];
    for (const [catName, displayOrder] of categoriesToSeed) {
      await mainPool.query(
        'INSERT INTO _pos_menu_categories_base (restaurant_id, name, display_order) VALUES (?, ?, ?)',
        [restaurantId, catName, displayOrder]
      );
    }

    // 7. Seed default Floor and Section
    const [floorResult] = await mainPool.query(
      'INSERT INTO _pos_floors_base (restaurant_id, name, display_order) VALUES (?, ?, ?)',
      [restaurantId, 'Ground Floor', 1]
    );
    const floorId = floorResult.insertId;

    const [sectionResult] = await mainPool.query(
      'INSERT INTO _pos_sections_base (restaurant_id, floor_id, name, display_order) VALUES (?, ?, ?, ?)',
      [restaurantId, floorId, 'Main Hall', 1]
    );
    const sectionId = sectionResult.insertId;

    // 8. Seed default tables in _pos_tables_base (1 to 10) linked to Section
    for (let i = 1; i <= 10; i++) {
      await mainPool.query(
        'INSERT INTO _pos_tables_base (restaurant_id, number, capacity, status, section_id) VALUES (?, ?, ?, ?, ?)',
        [restaurantId, String(i), 4, 'available', sectionId]
      );
    }

    console.log(`[Super Admin] Restaurant '${name}' successfully registered with license: ${licenseKey} and default data seeded.`);
    return res.status(201).json({
      success: true,
      data: {
        name,
        licenseKey,
        restaurantId,
        adminUsername,
        planType: pType,
        expiresAt
      }
    });
  } catch (err) {
    console.error('[Super Admin] Error creating restaurant:', err);
    return res.status(500).json({
      success: false,
      error: `Failed to initialize restaurant: ${err.message}`
    });
  }
};
const toggleStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'active' | 'inactive' | 'suspended' | 'expired'

  const allowed = ['active', 'inactive', 'suspended', 'expired'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      error: `Status must be one of: ${allowed.join(', ')}`
    });
  }

  try {
    const [result] = await mainPool.query(
      'UPDATE restaurants SET status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found.'
      });
    }

    // Update pos settings base
    const syncStatus = status === 'inactive' ? 'suspended' : status;
    await mainPool.query(
      'INSERT INTO _pos_settings_base (restaurant_id, `key`, `value`) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE `value` = ?',
      [id, 'licenseStatus', syncStatus, syncStatus]
    );

    // Retrieve license_key and metadata to broadcast instantly
    const [rows] = await mainPool.query(
      'SELECT license_key, plan_type, expires_at FROM restaurants WHERE id = ?',
      [id]
    );
    if (rows.length > 0) {
      const { license_key, plan_type, expires_at } = rows[0];
      const io = req.app.get('io');
      if (io) {
        const payload = {
          status: syncStatus,
          planType: plan_type,
          expiresAt: expires_at ? expires_at.toISOString() : null
        };
        console.log(`[Super Admin] Broadcasting license:status to ${license_key}:`, payload);
        io.to(`admin:${license_key}`).emit('license:status', payload);
        io.to(`pos_clients:${license_key}`).emit('license:status', payload);
      }
    }

    return res.json({
      success: true,
      message: `Restaurant status updated to '${status}'.`
    });
  } catch (err) {
    console.error('Failed to toggle restaurant status:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to update restaurant status.'
    });
  }
};

const updatePlan = async (req, res) => {
  const { id } = req.params;
  const { planType, customDays, name, expiresAt: bodyExpiresAt } = req.body;

  const allowedPlans = ['monthly', 'yearly', 'lifetime', 'trial', 'custom'];
  if (!planType || !allowedPlans.includes(planType)) {
    return res.status(400).json({
      success: false,
      error: `Plan type must be one of: ${allowedPlans.join(', ')}`
    });
  }

  let expiresAt = null;
  if (bodyExpiresAt !== undefined) {
    expiresAt = bodyExpiresAt ? new Date(bodyExpiresAt) : null;
  } else {
    if (planType === 'monthly') {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
    } else if (planType === 'yearly') {
      expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else if (planType === 'trial') {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
    } else if (planType === 'custom') {
      const days = parseInt(customDays, 10) || 30;
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);
    }
  }

  try {
    let updateFields = 'plan_type = ?, expires_at = ?, status = ?';
    let queryParams = [planType, expiresAt, 'active'];

    if (name) {
      updateFields += ', name = ?';
      queryParams.push(name);
    }
    queryParams.push(id);

    const [result] = await mainPool.query(
      `UPDATE restaurants SET ${updateFields} WHERE id = ?`,
      queryParams
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found.'
      });
    }

    // Sync to pos settings base
    const expiresAtStr = expiresAt ? expiresAt.toISOString().slice(0, 19).replace('T', ' ') : '';
    await mainPool.query(
      'INSERT INTO _pos_settings_base (restaurant_id, `key`, `value`) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [
        id, 'licenseStatus', 'active',
        id, 'planType', planType,
        id, 'expiresAt', expiresAtStr
      ]
    );

    if (name) {
      await mainPool.query(
        'INSERT INTO _pos_settings_base (restaurant_id, `key`, `value`) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `value` = ?',
        [id, 'restaurantName', name, name]
      );
    }

    // Retrieve license_key to broadcast
    const [rows] = await mainPool.query(
      'SELECT license_key FROM restaurants WHERE id = ?',
      [id]
    );
    if (rows.length > 0) {
      const license_key = rows[0].license_key;
      const io = req.app.get('io');
      if (io) {
        const payload = {
          status: 'active',
          planType,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          restaurantName: name || undefined
        };
        console.log(`[Super Admin] Broadcasting plan update to ${license_key}:`, payload);
        io.to(`admin:${license_key}`).emit('license:status', payload);
        io.to(`pos_clients:${license_key}`).emit('license:status', payload);
      }
    }

    return res.json({
      success: true,
      message: 'Plan updated and license activated successfully.',
      data: { planType, expiresAt, name }
    });
  } catch (err) {
    console.error('Failed to update plan:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to update restaurant plan.'
    });
  }
};

const extendPlan = async (req, res) => {
  const { id } = req.params;
  const { days } = req.body;

  const daysInt = parseInt(days, 10);
  if (isNaN(daysInt) || daysInt <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Number of extension days must be a positive integer.'
    });
  }

  try {
    const [rows] = await mainPool.query('SELECT expires_at, status FROM restaurants WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurant not found.' });
    }

    let currentExpiresAt = rows[0].expires_at;
    let newExpiresAt;

    if (!currentExpiresAt || new Date(currentExpiresAt) < new Date()) {
      newExpiresAt = new Date();
    } else {
      newExpiresAt = new Date(currentExpiresAt);
    }
    newExpiresAt.setDate(newExpiresAt.getDate() + daysInt);

    const nextStatus = rows[0].status === 'expired' ? 'active' : rows[0].status;

    await mainPool.query(
      'UPDATE restaurants SET expires_at = ?, status = ? WHERE id = ?',
      [newExpiresAt, nextStatus, id]
    );

    const expiresAtStr = newExpiresAt.toISOString().slice(0, 19).replace('T', ' ');
    await mainPool.query(
      'INSERT INTO _pos_settings_base (restaurant_id, `key`, `value`) VALUES (?, ?, ?), (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [
        id, 'expiresAt', expiresAtStr,
        id, 'licenseStatus', nextStatus
      ]
    );

    // Broadcast update
    const [licRows] = await mainPool.query('SELECT license_key FROM restaurants WHERE id = ?', [id]);
    if (licRows.length > 0) {
      const license_key = licRows[0].license_key;
      const io = req.app.get('io');
      if (io) {
        const payload = { status: nextStatus, expiresAt: newExpiresAt.toISOString() };
        io.to(`admin:${license_key}`).emit('license:status', payload);
        io.to(`pos_clients:${license_key}`).emit('license:status', payload);
      }
    }

    return res.json({
      success: true,
      message: `License extended by ${daysInt} days successfully.`,
      data: { expiresAt: newExpiresAt }
    });
  } catch (err) {
    console.error('Failed to extend license:', err);
    return res.status(500).json({ success: false, error: 'Failed to extend license.' });
  }
};

const createAdminForRestaurant = async (req, res) => {
  const { id } = req.params;
  const { adminUsername, adminPassword, adminEmail } = req.body;

  if (!adminUsername || !adminPassword) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  const connection = await mainPool.getConnection();
  try {
    await connection.beginTransaction();

    // Verify restaurant exists
    const [restaurants] = await connection.query('SELECT id FROM restaurants WHERE id = ?', [id]);
    if (restaurants.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Restaurant not found.' });
    }

    // Check if username is taken for this restaurant
    const [existing] = await connection.query('SELECT id FROM _admins_base WHERE restaurant_id = ? AND username = ?', [id, adminUsername]);
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Admin username already exists for this restaurant.' });
    }

    // Create the admin user in the base admins table
    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
    await connection.query(
      'INSERT INTO _admins_base (restaurant_id, username, password_hash, email) VALUES (?, ?, ?, ?)',
      [id, adminUsername, adminPasswordHash, adminEmail || null]
    );

    // Hash pin for POS admin staff user
    const crypto = require('crypto');
    const pin = /^\\d+$/.test(adminPassword) ? adminPassword : '0000';
    const pinHash = crypto.createHash('sha256').update(String(pin)).digest('hex');

    // Create initial admin staff user in _pos_staff_base
    await connection.query(
      'INSERT INTO _pos_staff_base (restaurant_id, name, username, pin_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'Admin User', adminUsername, pinHash, 'Admin', 'Active']
    );

    await connection.commit();
    return res.status(201).json({ success: true, message: 'Admin account created successfully.' });
  } catch (err) {
    await connection.rollback();
    console.error('Failed to create admin:', err);
    return res.status(500).json({ success: false, error: `Failed to create admin: ${err.message}` });
  } finally {
    connection.release();
  }
};

const deleteRestaurant = async (req, res) => {
  const { id } = req.params;

  const connection = await mainPool.getConnection();
  try {
    await connection.beginTransaction();

    const baseTables = [
      '_admins_base',
      '_pos_attendance_base',
      '_pos_expenses_base',
      '_pos_floors_base',
      '_pos_inventory_items_base',
      '_pos_inventory_log_base',
      '_pos_menu_categories_base',
      '_pos_menu_items_base',
      '_pos_order_items_base',
      '_pos_orders_base',
      '_pos_payroll_base',
      '_pos_sections_base',
      '_pos_settings_base',
      '_pos_staff_base',
      '_pos_tables_base',
      '_rider_latest_location_base',
      '_rider_locations_base',
      '_rider_sessions_base',
      '_riders_base',
      '_tasks_base'
    ];

    for (const table of baseTables) {
      await connection.query(`DELETE FROM \`${table}\` WHERE restaurant_id = ?`, [id]);
    }

    const [result] = await connection.query('DELETE FROM restaurants WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Restaurant not found.' });
    }

    await connection.commit();
    console.log(`[Super Admin] Restaurant ID ${id} and all associated data deleted.`);
    return res.json({
      success: true,
      message: 'Restaurant license and all associated data deleted successfully.'
    });
  } catch (err) {
    await connection.rollback();
    console.error('Failed to delete restaurant:', err);
    return res.status(500).json({ success: false, error: `Failed to delete restaurant: ${err.message}` });
  } finally {
    connection.release();
  }
};

const getHealth = async (req, res) => {
  try {
    const { getConnectedDeviceCounts } = require('../sockets/locationSocket');
    
    // Get all system logs globally
    const [logs] = await mainPool.query(`
      SELECT l.*, r.name as restaurant_name, r.license_key
      FROM _pos_system_logs_base l
      LEFT JOIN restaurants r ON l.restaurant_id = r.id
      ORDER BY l.created_at DESC LIMIT 500
    `);

    // Get active device counts
    const [restaurants] = await mainPool.query('SELECT id, name, license_key FROM restaurants WHERE status = "active"');
    
    let totalRiders = 0;
    let totalPOS = 0;
    const deviceCountsByLicense = {};

    for (const rest of restaurants) {
      const counts = getConnectedDeviceCounts(rest.id);
      if (counts.rider > 0 || counts.pos > 0) {
        deviceCountsByLicense[rest.license_key] = {
          name: rest.name,
          ...counts
        };
        totalRiders += counts.rider;
        totalPOS += counts.pos;
      }
    }

    return res.json({
      success: true,
      data: {
        logs,
        activeDevices: {
          totalRiders,
          totalPOS,
          byLicense: deviceCountsByLicense
        }
      }
    });
  } catch (err) {
    console.error('Super Admin getHealth error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch health data.' });
  }
};

module.exports = {
  login,
  getRestaurants,
  createRestaurant,
  toggleStatus,
  updatePlan,
  extendPlan,
  deleteRestaurant,
  getHealth
};


// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSIVE DATA ENDPOINTS FOR ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get overview of all restaurants with aggregated metrics
 */
const getRestaurantsOverview = async (req, res) => {
  try {
    const [restaurants] = await mainPool.query(`
      SELECT 
        r.id,
        r.name,
        r.license_key,
        r.status,
        r.plan_type,
        r.expires_at,
        r.created_at,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currencyPlacement' LIMIT 1) as currency_placement,
        (SELECT COUNT(*) FROM _pos_staff_base WHERE restaurant_id = r.id AND (is_deleted = 0 OR is_deleted IS NULL)) as employee_count,
        (SELECT COUNT(*) FROM _pos_orders_base WHERE restaurant_id = r.id AND status = 'completed') as total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM _pos_orders_base WHERE restaurant_id = r.id AND status = 'completed') as total_sales,
        (SELECT COUNT(*) FROM _pos_inventory_items_base WHERE restaurant_id = r.id AND (is_deleted = 0 OR is_deleted IS NULL)) as inventory_items_count,
        (SELECT COUNT(*) FROM _pos_menu_items_base WHERE restaurant_id = r.id AND (is_deleted = 0 OR is_deleted IS NULL)) as menu_items_count
      FROM restaurants r
      ORDER BY r.created_at DESC
    `);

    // Get active device counts
    const { getConnectedDeviceCounts } = require('../sockets/locationSocket');
    const broadcaster = require('../sockets/WebSocketBroadcaster');
    
    for (const restaurant of restaurants) {
      const riderCounts = getConnectedDeviceCounts(restaurant.id);
      const posDevices = broadcaster.getConnectedDevices(restaurant.id);
      restaurant.active_riders = riderCounts.rider;
      restaurant.active_pos_devices = posDevices.length;
    }

    return res.json({
      success: true,
      data: restaurants
    });
  } catch (err) {
    console.error('Failed to fetch restaurants overview:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch restaurants overview.'
    });
  }
};

/**
 * Get all employees across all restaurants
 */
const getAllEmployees = async (req, res) => {
  try {
    const { restaurant_id, role, status } = req.query;
    
    let query = `
      SELECT 
        s.id,
        s.name,
        s.username,
        s.role,
        s.phone,
        s.email,
        s.hire_date,
        s.salary_type,
        s.salary_amount,
        s.status,
        s.created_at,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency
      FROM _pos_staff_base s
      JOIN restaurants r ON s.restaurant_id = r.id
      WHERE (s.is_deleted = 0 OR s.is_deleted IS NULL)
    `;
    
    const params = [];
    
    if (restaurant_id) {
      query += ' AND s.restaurant_id = ?';
      params.push(restaurant_id);
    }
    
    if (role) {
      query += ' AND s.role = ?';
      params.push(role);
    }
    
    if (status) {
      query += ' AND s.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY r.name, s.name';
    
    const [employees] = await mainPool.query(query, params);

    return res.json({
      success: true,
      data: employees,
      count: employees.length
    });
  } catch (err) {
    console.error('Failed to fetch employees:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch employees data.'
    });
  }
};

/**
 * Get sales analytics across all restaurants
 */
const getSalesAnalytics = async (req, res) => {
  try {
    const { restaurant_id, start_date, end_date, groupBy, sortBy = 'revenue' } = req.query;
    const sortColumn = sortBy === 'quantity' ? 'total_quantity' : 'total_revenue';
    
    // Get total sales by restaurant
    let salesQuery = `
      SELECT 
        r.id as restaurant_id,
        r.name as restaurant_name,
        r.license_key,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currencyPlacement' LIMIT 1) as currency_placement,
        COUNT(o.id) as order_count,
        COALESCE(SUM(o.total), 0) as total_sales,
        COALESCE(SUM(o.subtotal), 0) as subtotal,
        COALESCE(SUM(o.tax), 0) as total_tax,
        COALESCE(SUM(o.discount), 0) as total_discount,
        COALESCE(AVG(o.total), 0) as average_order_value
      FROM restaurants r
      LEFT JOIN _pos_orders_base o ON r.id = o.restaurant_id AND o.status = 'completed'
    `;
    
    const params = [];
    const conditions = [];
    
    if (restaurant_id) {
      conditions.push('r.id = ?');
      params.push(restaurant_id);
    }
    
    if (start_date) {
      conditions.push('o.created_at >= ?');
      params.push(start_date);
    }
    
    if (end_date) {
      conditions.push('o.created_at <= ?');
      params.push(end_date);
    }
    
    if (conditions.length > 0) {
      salesQuery += ' WHERE ' + conditions.join(' AND ');
    }
    
    salesQuery += ' GROUP BY r.id ORDER BY total_sales DESC';
    
    const [salesByRestaurant] = await mainPool.query(salesQuery, params);

    // Get top selling items globally (sorted by revenue or quantity)
    const [topItems] = await mainPool.query(`
      SELECT 
        oi.name as item_name,
        oi.price,
        r.name as restaurant_name,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        COUNT(oi.id) as times_ordered,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.price * oi.quantity) as total_revenue
      FROM _pos_order_items_base oi
      JOIN _pos_orders_base o ON oi.order_id = o.id
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.status = 'completed'
      ${restaurant_id ? 'AND o.restaurant_id = ?' : ''}
      ${start_date ? 'AND o.created_at >= ?' : ''}
      ${end_date ? 'AND o.created_at <= ?' : ''}
      GROUP BY oi.name, r.id
      ORDER BY ${sortColumn} DESC
      LIMIT 50
    `, params);

    // Get sales trend data
    let trendQuery = '';
    if (groupBy === 'day') {
      trendQuery = `
        SELECT 
          DATE(o.created_at) as date,
          COUNT(o.id) as order_count,
          SUM(o.total) as total_sales
        FROM _pos_orders_base o
        WHERE o.status = 'completed'
        ${restaurant_id ? 'AND o.restaurant_id = ?' : ''}
        ${start_date ? 'AND o.created_at >= ?' : ''}
        ${end_date ? 'AND o.created_at <= ?' : ''}
        GROUP BY DATE(o.created_at)
        ORDER BY date DESC
        LIMIT 30
      `;
    } else if (groupBy === 'month') {
      trendQuery = `
        SELECT 
          DATE_FORMAT(o.created_at, '%Y-%m') as month,
          COUNT(o.id) as order_count,
          SUM(o.total) as total_sales
        FROM _pos_orders_base o
        WHERE o.status = 'completed'
        ${restaurant_id ? 'AND o.restaurant_id = ?' : ''}
        ${start_date ? 'AND o.created_at >= ?' : ''}
        ${end_date ? 'AND o.created_at <= ?' : ''}
        GROUP BY DATE_FORMAT(o.created_at, '%Y-%m')
        ORDER BY month DESC
        LIMIT 12
      `;
    }
    
    let trend = [];
    if (trendQuery) {
      const [trendResults] = await mainPool.query(trendQuery, params);
      trend = trendResults;
    }

    return res.json({
      success: true,
      data: {
        salesByRestaurant,
        topItems,
        trend,
        summary: {
          totalRestaurants: salesByRestaurant.length,
          totalOrders: salesByRestaurant.reduce((sum, r) => sum + r.order_count, 0),
          totalRevenue: salesByRestaurant.reduce((sum, r) => sum + parseFloat(r.total_sales), 0)
        }
      }
    });
  } catch (err) {
    console.error('Failed to fetch sales analytics:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch sales analytics.'
    });
  }
};

/**
 * Get inventory data across all restaurants
 */
const getAllInventory = async (req, res) => {
  try {
    const { restaurant_id, low_stock_only } = req.query;
    
    let query = `
      SELECT 
        i.id,
        i.name,
        i.category,
        i.quantity,
        i.unit,
        i.min_threshold,
        i.cost_per_unit,
        i.supplier_name,
        i.supplier_contact,
        i.updated_at,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        CASE WHEN i.quantity <= i.min_threshold THEN 1 ELSE 0 END as is_low_stock
      FROM _pos_inventory_items_base i
      JOIN restaurants r ON i.restaurant_id = r.id
      WHERE (i.is_deleted = 0 OR i.is_deleted IS NULL)
    `;
    
    const params = [];
    
    if (restaurant_id) {
      query += ' AND i.restaurant_id = ?';
      params.push(restaurant_id);
    }
    
    if (low_stock_only === 'true') {
      query += ' AND i.quantity <= i.min_threshold';
    }
    
    query += ' ORDER BY r.name, i.name';
    
    const [inventory] = await mainPool.query(query, params);

    // Get inventory summary
    const [summary] = await mainPool.query(`
      SELECT 
        r.name as restaurant_name,
        r.id as restaurant_id,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        COUNT(i.id) as total_items,
        SUM(CASE WHEN i.quantity <= i.min_threshold THEN 1 ELSE 0 END) as low_stock_count,
        SUM(i.quantity * i.cost_per_unit) as total_inventory_value
      FROM restaurants r
      LEFT JOIN _pos_inventory_items_base i ON r.id = i.restaurant_id AND (i.is_deleted = 0 OR i.is_deleted IS NULL)
      ${restaurant_id ? 'WHERE r.id = ?' : ''}
      GROUP BY r.id
      ORDER BY r.name
    `, restaurant_id ? [restaurant_id] : []);

    return res.json({
      success: true,
      data: {
        items: inventory,
        summary
      }
    });
  } catch (err) {
    console.error('Failed to fetch inventory:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch inventory data.'
    });
  }
};

/**
 * Get menu data across all restaurants
 */
const getAllMenus = async (req, res) => {
  try {
    const { restaurant_id } = req.query;
    
    // Get all categories
    let catQuery = `
      SELECT 
        c.id,
        c.name,
        c.display_order,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key
      FROM _pos_menu_categories_base c
      JOIN restaurants r ON c.restaurant_id = r.id
      WHERE (c.is_deleted = 0 OR c.is_deleted IS NULL)
    `;
    
    if (restaurant_id) {
      catQuery += ' AND c.restaurant_id = ?';
    }
    
    catQuery += ' ORDER BY r.name, c.display_order, c.name';
    
    const [categories] = await mainPool.query(catQuery, restaurant_id ? [restaurant_id] : []);

    // Get all menu items
    let itemQuery = `
      SELECT 
        i.id,
        i.name,
        i.description,
        i.price,
        i.cost_price,
        i.category_id,
        i.is_available,
        i.image_path,
        i.dietary_tags,
        c.name as category_name,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency
      FROM _pos_menu_items_base i
      JOIN _pos_menu_categories_base c ON i.category_id = c.id
      JOIN restaurants r ON i.restaurant_id = r.id
      WHERE (i.is_deleted = 0 OR i.is_deleted IS NULL)
    `;
    
    if (restaurant_id) {
      itemQuery += ' AND i.restaurant_id = ?';
    }
    
    itemQuery += ' ORDER BY r.name, c.name, i.name';
    
    const [items] = await mainPool.query(itemQuery, restaurant_id ? [restaurant_id] : []);

    // Get menu summary
    const [summary] = await mainPool.query(`
      SELECT 
        r.name as restaurant_name,
        r.id as restaurant_id,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        COUNT(DISTINCT c.id) as category_count,
        COUNT(i.id) as item_count,
        SUM(CASE WHEN i.is_available = 1 THEN 1 ELSE 0 END) as available_items,
        AVG(i.price) as average_price
      FROM restaurants r
      LEFT JOIN _pos_menu_categories_base c ON r.id = c.restaurant_id AND (c.is_deleted = 0 OR c.is_deleted IS NULL)
      LEFT JOIN _pos_menu_items_base i ON c.id = i.category_id AND (i.is_deleted = 0 OR i.is_deleted IS NULL)
      ${restaurant_id ? 'WHERE r.id = ?' : ''}
      GROUP BY r.id
      ORDER BY r.name
    `, restaurant_id ? [restaurant_id] : []);

    return res.json({
      success: true,
      data: {
        categories,
        items,
        summary
      }
    });
  } catch (err) {
    console.error('Failed to fetch menus:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch menu data.'
    });
  }
};

/**
 * Get all orders with filtering
 */
const getAllOrders = async (req, res) => {
  try {
    const { restaurant_id, status, start_date, end_date, customer_phone, limit = 100 } = req.query;
    
    let query = `
      SELECT 
        o.id,
        o.order_number,
        o.type,
        o.customer_name,
        o.customer_phone,
        o.status,
        o.subtotal,
        o.tax,
        o.discount,
        o.total,
        o.notes,
        o.created_at,
        o.updated_at,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currency' LIMIT 1) as currency,
        (SELECT value FROM _pos_settings_base WHERE restaurant_id = r.id AND \`key\` = 'currencyPlacement' LIMIT 1) as currency_placement,
        s.name as staff_name,
        t.number as table_number
      FROM _pos_orders_base o
      JOIN restaurants r ON o.restaurant_id = r.id
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (restaurant_id) {
      query += ' AND o.restaurant_id = ?';
      params.push(restaurant_id);
    }
    
    if (status) {
      query += ' AND o.status = ?';
      params.push(status);
    }

    if (customer_phone) {
      query += ' AND o.customer_phone = ?';
      params.push(customer_phone);
    }
    
    if (start_date) {
      query += ' AND o.created_at >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      query += ' AND o.created_at <= ?';
      params.push(end_date);
    }
    
    query += ' ORDER BY o.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    
    const [orders] = await mainPool.query(query, params);

    // Get order items for each order (limited to avoid too much data)
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [items] = await mainPool.query(`
        SELECT 
          oi.order_id,
          oi.name,
          oi.price,
          oi.quantity,
          oi.notes
        FROM _pos_order_items_base oi
        WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})
      `, orderIds);
      
      // Attach items to orders
      const itemsByOrder = {};
      items.forEach(item => {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      });
      
      orders.forEach(order => {
        order.items = itemsByOrder[order.id] || [];
      });
    }

    return res.json({
      success: true,
      data: orders,
      count: orders.length
    });
  } catch (err) {
    console.error('Failed to fetch orders:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch orders data.'
    });
  }
};

/**
 * Get active devices (POS and Riders)
 */
const getActiveDevices = async (req, res) => {
  try {
    const { getConnectedDeviceCounts } = require('../sockets/locationSocket');
    const broadcaster = require('../sockets/WebSocketBroadcaster');
    
    const [restaurants] = await mainPool.query('SELECT id, name, license_key, status FROM restaurants ORDER BY name');
    
    const devices = {
      posDevices: [],
      riderDevices: [],
      summary: {
        totalPOS: 0,
        totalRiders: 0,
        totalRestaurants: restaurants.length
      }
    };
    
    for (const restaurant of restaurants) {
      // Get POS devices
      const posDevices = broadcaster.getConnectedDevices(restaurant.id);
      posDevices.forEach(device => {
        devices.posDevices.push({
          deviceId: device.deviceId,
          hostname: device.hostname,
          restaurant_name: restaurant.name,
          restaurant_id: restaurant.id,
          license_key: restaurant.license_key,
          connected_at: device.connectedAt || new Date()
        });
      });
      devices.summary.totalPOS += posDevices.length;
      
      // Get Rider devices
      const riderCounts = getConnectedDeviceCounts(restaurant.id);
      if (riderCounts.rider > 0) {
        // Note: locationSocket doesn't expose individual rider device details
        // so we're showing aggregated count
        devices.riderDevices.push({
          restaurant_name: restaurant.name,
          restaurant_id: restaurant.id,
          license_key: restaurant.license_key,
          active_riders: riderCounts.rider
        });
        devices.summary.totalRiders += riderCounts.rider;
      }
    }

    return res.json({
      success: true,
      data: devices
    });
  } catch (err) {
    console.error('Failed to fetch active devices:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch active devices.'
    });
  }
};

/**
 * Get all activity logs across all restaurants
 */
const getActivityLogs = async (req, res) => {
  try {
    const { restaurant_id, section, action_type, user_name, limit } = req.query;
    
    let query = `
      SELECT 
        l.id,
        l.user_id,
        l.user_type,
        l.user_name,
        l.section,
        l.action_type,
        l.description,
        l.metadata,
        l.created_at,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key
      FROM _pos_activity_logs_base l
      JOIN restaurants r ON l.restaurant_id = r.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (restaurant_id) {
      query += ' AND l.restaurant_id = ?';
      params.push(restaurant_id);
    }
    
    if (section && section.toLowerCase() !== 'all') {
      query += ' AND l.section = ?';
      params.push(section);
    }
    
    if (action_type && action_type.toLowerCase() !== 'all') {
      query += ' AND l.action_type = ?';
      params.push(action_type);
    }
    
    if (user_name) {
      query += ' AND l.user_name LIKE ?';
      params.push('%' + user_name + '%');
    }
    
    const maxLimit = parseInt(limit, 10) || 500;
    query += ` ORDER BY l.created_at DESC LIMIT ?`;
    params.push(maxLimit);
    
    const [logs] = await mainPool.query(query, params);

    return res.json({
      success: true,
      data: logs,
      count: logs.length
    });
  } catch (err) {
    console.error('Failed to fetch activity logs:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch activity logs.'
    });
  }
};

/**
 * Get all customers across all restaurants with order summaries
 */
const getAllCustomers = async (req, res) => {
  try {
    const { restaurant_id, search } = req.query;
    
    let query = `
      SELECT 
        c.id,
        c.phone,
        c.name,
        c.address,
        c.created_at,
        r.name as restaurant_name,
        r.id as restaurant_id,
        r.license_key,
        (SELECT COUNT(*) FROM _pos_orders_base o WHERE o.customer_phone = c.phone AND o.restaurant_id = c.restaurant_id) as total_orders,
        (SELECT MAX(o.created_at) FROM _pos_orders_base o WHERE o.customer_phone = c.phone AND o.restaurant_id = c.restaurant_id) as last_order_date
      FROM _pos_customers_base c
      JOIN restaurants r ON c.restaurant_id = r.id
      WHERE (c.is_deleted = 0 OR c.is_deleted IS NULL)
    `;
    
    const params = [];
    
    if (restaurant_id) {
      query += ' AND c.restaurant_id = ?';
      params.push(restaurant_id);
    }
    
    if (search) {
      query += ' AND (c.phone LIKE ? OR c.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY last_order_date DESC, c.name ASC';
    
    const [customers] = await mainPool.query(query, params);

    return res.json({
      success: true,
      data: customers,
      count: customers.length
    });
  } catch (err) {
    console.error('Failed to fetch customers:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch customer reports.'
    });
  }
};

module.exports = {
  login,
  getRestaurants,
  createRestaurant,
  createAdminForRestaurant,
  toggleStatus,
  updatePlan,
  extendPlan,
  deleteRestaurant,
  getHealth,
  // New comprehensive endpoints
  getRestaurantsOverview,
  getAllEmployees,
  getSalesAnalytics,
  getAllInventory,
  getAllMenus,
  getAllOrders,
  getActiveDevices,
  getActivityLogs,
  getAllCustomers
};

