const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const getAllRiders = async (req, res) => {
  try {
    // FIX (Bug #1): Add restaurant_id filter from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    const query = `
      SELECT r.id, r.username, r.full_name, r.phone, r.status, r.is_active, r.created_at,
             l.latitude, l.longitude, l.speed, l.heading, l.accuracy, l.updated_at as location_updated_at
      FROM _riders_base r
      LEFT JOIN _rider_latest_location_base l ON r.id = l.rider_id AND l.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = ?
    `;
    const [rows] = await pool.query(query, [restaurantId]);

    return res.json({
      success: true,
      data: rows,
      error: null
    });
  } catch (error) {
    console.error('Error fetching riders:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const createRider = async (req, res) => {
  const { username, password, full_name, phone } = req.body;

  if (!username || !password || !full_name) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Username, password, and full name are required.'
    });
  }

  if (password.length < 4) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Password/PIN must be at least 4 characters long.'
    });
  }

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    // Check if username already exists FOR THIS TENANT
    const [existing] = await pool.query(
      'SELECT id FROM _riders_base WHERE username = ? AND restaurant_id = ?', 
      [username, restaurantId]
    );
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Username is already taken.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Insert into _riders_base with restaurant_id
    const [result] = await pool.query(
      'INSERT INTO _riders_base (restaurant_id, username, password_hash, full_name, phone, status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [restaurantId, username, passwordHash, full_name, phone || null, 'offline', 1]
    );

    // FIX (Bug #7): Initialize with NULL coordinates instead of hardcoded London
    // coordinates. The frontend/map should treat NULL lat/lng as "no location yet"
    // and not plot the rider until a real GPS update arrives.
    await pool.query(
      'INSERT INTO _rider_latest_location_base (restaurant_id, rider_id, latitude, longitude, speed, heading, accuracy) VALUES (?, ?, NULL, NULL, 0, 0, 0)',
      [restaurantId, result.insertId]
    );

    // ALSO CREATE IN _pos_staff_base with restaurant_id!
    // Compute SHA-256 hash of password (PIN) for pos_staff
    const crypto = require('crypto');
    const pinHash = crypto.createHash('sha256').update(String(password)).digest('hex');
    await pool.query(
      'INSERT INTO _pos_staff_base (restaurant_id, name, username, pin_hash, role, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), pin_hash = VALUES(pin_hash), phone = VALUES(phone), status = VALUES(status)',
      [restaurantId, full_name, username, pinHash, 'Rider', phone || null, 'Active']
    );

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        username,
        full_name,
        phone,
        status: 'offline',
        is_active: 1,
        restaurant_id: restaurantId
      },
      error: null
    });
  } catch (error) {
    console.error('Error creating rider:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const updateRider = async (req, res) => {
  const { id } = req.params;
  const { password, full_name, phone, is_active } = req.body;

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    // Check if rider exists FOR THIS TENANT
    const [existing] = await pool.query(
      'SELECT id, password_hash FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Rider not found.'
      });
    }

    // FIX (Bug #14): Build the SET clauses as an array of {col, val} pairs first,
    // validate everything upfront, then construct and execute the query once.
    // This eliminates the fragile trailing-comma slice and the mid-build early-return risk.
    const setClauses = [];
    const params = [];

    if (full_name) {
      setClauses.push('full_name = ?');
      params.push(full_name);
    }
    if (phone !== undefined) {
      setClauses.push('phone = ?');
      params.push(phone);
    }
    if (is_active !== undefined) {
      setClauses.push('is_active = ?');
      params.push(is_active);
    }
    if (password) {
      if (password.length < 4) {
        return res.status(400).json({
          success: false,
          data: null,
          error: 'Password/PIN must be at least 4 characters long.'
        });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      setClauses.push('password_hash = ?');
      params.push(passwordHash);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'No update data provided.'
      });
    }

    // Handle side-effects after validation passes
    if (is_active !== undefined && Number(is_active) === 0) {
      await pool.query(
        'UPDATE _riders_base SET status = ? WHERE id = ? AND restaurant_id = ?', 
        ['offline', id, restaurantId]
      );
      await pool.query(
        'DELETE FROM _rider_sessions_base WHERE rider_id = ? AND restaurant_id = ?', 
        [id, restaurantId]
      );
    }

    const query = `UPDATE _riders_base SET ${setClauses.join(', ')} WHERE id = ? AND restaurant_id = ?`;
    params.push(id, restaurantId);

    await pool.query(query, params);

    // ALSO UPDATE IN _pos_staff_base!
    const [riders] = await pool.query(
      'SELECT username, full_name, phone, is_active FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    if (riders.length > 0) {
      const rider = riders[0];
      const name = full_name || rider.full_name;
      const uPhone = phone !== undefined ? phone : rider.phone;
      const active = is_active !== undefined ? is_active : rider.is_active;
      const statusStr = Number(active) === 1 ? 'Active' : 'Terminated';

      let posStaffUpdateQuery = 'UPDATE _pos_staff_base SET name = ?, phone = ?, status = ?';
      const posStaffParams = [name, uPhone || null, statusStr];

      if (password) {
        const crypto = require('crypto');
        const pinHash = crypto.createHash('sha256').update(String(password)).digest('hex');
        posStaffUpdateQuery += ', pin_hash = ?';
        posStaffParams.push(pinHash);
      }

      posStaffUpdateQuery += ' WHERE username = ? AND restaurant_id = ?';
      posStaffParams.push(rider.username, restaurantId);

      await pool.query(posStaffUpdateQuery, posStaffParams);
    }

    // Fetch updated rider
    const [updated] = await pool.query(
      'SELECT id, username, full_name, phone, status, is_active FROM _riders_base WHERE id = ? AND restaurant_id = ?',
      [id, restaurantId]
    );

    return res.json({
      success: true,
      data: updated[0],
      error: null
    });
  } catch (error) {
    console.error('Error updating rider:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const deactivateRider = async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      connection.release();
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT username FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    if (existing.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Rider not found.'
      });
    }
    const username = existing[0].username;

    // Delete associated locations, sessions, latest locations, and update tasks to NULL
    // All scoped by restaurant_id
    await connection.query(
      'DELETE FROM _rider_sessions_base WHERE rider_id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    await connection.query(
      'DELETE FROM _rider_locations_base WHERE rider_id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    await connection.query(
      'DELETE FROM _rider_latest_location_base WHERE rider_id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    await connection.query(
      'UPDATE _tasks_base SET rider_id = NULL WHERE rider_id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );

    // Delete from _pos_staff_base and _riders_base (scoped by restaurant_id)
    await connection.query(
      'DELETE FROM _pos_staff_base WHERE username = ? AND restaurant_id = ?', 
      [username, restaurantId]
    );
    await connection.query(
      'DELETE FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );

    await connection.commit();

    return res.json({
      success: true,
      data: { message: 'Rider deleted and pruned successfully.' },
      error: null
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting rider:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  } finally {
    connection.release();
  }
};

const getLocationHistory = async (req, res) => {
  const { id } = req.params;
  const { limit } = req.query;

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    const [existing] = await pool.query(
      'SELECT id FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Rider not found.'
      });
    }

    let query;
    let params = [id, restaurantId];

    if (limit) {
      const parsedLimit = parseInt(limit, 10);
      query = `
        SELECT latitude, longitude, speed, heading, accuracy, recorded_at
        FROM _rider_locations_base
        WHERE rider_id = ? AND restaurant_id = ?
        ORDER BY recorded_at DESC
        LIMIT ?
      `;
      params.push(parsedLimit);
    } else {
      // Default: Last 30 minutes of location history, sorted ascendingly (chronologically) for polylines
      query = `
        SELECT latitude, longitude, speed, heading, accuracy, recorded_at
        FROM _rider_locations_base
        WHERE rider_id = ? AND restaurant_id = ? AND recorded_at >= DATE_SUB(NOW(3), INTERVAL 30 MINUTE)
        ORDER BY recorded_at ASC
      `;
    }

    const [rows] = await pool.query(query, params);

    // If query by limit was used, reverse it to chronological order for polyline drawing
    if (limit) {
      rows.reverse();
    }

    return res.json({
      success: true,
      data: rows,
      error: null
    });
  } catch (error) {
    console.error('Error fetching location history:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const getRiderStats = async (req, res) => {
  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage and scope query
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    const query = `
      SELECT 
        r.id as rider_id,
        r.username,
        r.full_name,
        COUNT(CASE WHEN t.status = 'delivered' AND DATE(t.delivered_at) = CURDATE() THEN 1 END) as today_count,
        COUNT(CASE WHEN t.status = 'delivered' AND YEARWEEK(t.delivered_at, 1) = YEARWEEK(CURDATE(), 1) THEN 1 END) as weekly_count,
        COUNT(CASE WHEN t.status = 'delivered' AND MONTH(t.delivered_at) = MONTH(CURDATE()) AND YEAR(t.delivered_at) = YEAR(CURDATE()) THEN 1 END) as monthly_count,
        COUNT(CASE WHEN t.status = 'delivered' THEN 1 END) as total_count
      FROM _riders_base r
      LEFT JOIN _tasks_base t ON r.id = t.rider_id AND t.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = ?
      GROUP BY r.id, r.username, r.full_name
    `;
    const [rows] = await pool.query(query, [restaurantId]);

    return res.json({
      success: true,
      data: rows,
      error: null
    });
  } catch (error) {
    console.error('Error fetching rider delivery stats:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

module.exports = {
  getAllRiders,
  createRider,
  updateRider,
  deactivateRider,
  getLocationHistory,
  getRiderStats
};
