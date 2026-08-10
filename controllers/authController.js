const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = '8h';
const REFRESH_TOKEN_EXPIRY = '7d';

const riderLogin = async (req, res) => {
  const { username, password } = req.body;
  // FIX (Bug #1): Riders must provide a license_key to authenticate against the correct tenant
  const licenseKey = req.headers['x-license-key'] || req.query.license_key || req.body.license_key;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Username and password are required.'
    });
  }

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'License key (x-license-key header or license_key parameter) is required.'
    });
  }

  try {
    // Resolve restaurant from license key
    const { resolvePoolForLicense } = require('../config/db');
    const resolved = await resolvePoolForLicense(licenseKey);
    
    if (!resolved || resolved.error || resolved.status !== 'active') {
      return res.status(403).json({
        success: false,
        data: null,
        error: resolved?.error || 'Invalid or inactive license key.'
      });
    }

    const restaurantId = resolved.restaurantId;

    // Query _riders_base with explicit restaurant_id filter
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, full_name, phone, status, is_active, restaurant_id FROM _riders_base WHERE username = ? AND restaurant_id = ?',
      [username, restaurantId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid credentials.'
      });
    }

    const rider = rows[0];

    if (!rider.is_active) {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Account deactivated. Please contact administrator.'
      });
    }

    const isMatch = await bcrypt.compare(password, rider.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid credentials.'
      });
    }

    // Generate tokens
    const payload = { id: rider.id, role: 'rider', username: rider.username, restaurantId: rider.restaurant_id };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

    // FIX (Bug #6): Store a hash of the refresh token so we can invalidate it on logout.
    const crypto = require('crypto');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(
      'UPDATE _riders_base SET status = ?, refresh_token_hash = ? WHERE id = ? AND restaurant_id = ?',
      ['idle', refreshTokenHash, rider.id, restaurantId]
    );

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        rider: {
          id: rider.id,
          username: rider.username,
          full_name: rider.full_name,
          phone: rider.phone,
          status: 'idle',
          restaurantId: rider.restaurant_id
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Rider login error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const adminLogin = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Username and password are required.'
    });
  }

  try {
    // FIX (Bug #1 - CRITICAL): Scope admin login to the current tenant to prevent
    // cross-tenant credential leakage. Get restaurantId from AsyncLocalStorage.
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

    // Query _admins_base table with restaurant_id filter
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, restaurant_id FROM _admins_base WHERE username = ? AND restaurant_id = ?',
      [username, restaurantId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid credentials.'
      });
    }

    const admin = rows[0];

    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid credentials.'
      });
    }

    const payload = { id: admin.id, role: 'admin', username: admin.username, restaurantId: admin.restaurant_id };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        admin: {
          id: admin.id,
          username: admin.username,
          restaurantId: admin.restaurant_id
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const refreshToken = async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Refresh token is required.'
    });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);

    // If it's a rider, check if they are still active AND the token hasn't been invalidated
    if (decoded.role === 'rider') {
      const crypto = require('crypto');
      const incomingHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      // FIX (Bug #1): Add restaurant_id filter if available in decoded token
      const restaurantId = decoded.restaurantId;
      let query = 'SELECT is_active, refresh_token_hash FROM _riders_base WHERE id = ?';
      const params = [decoded.id];
      
      if (restaurantId) {
        query += ' AND restaurant_id = ?';
        params.push(restaurantId);
      }

      const [rows] = await pool.query(query, params);
      
      if (rows.length === 0 || !rows[0].is_active) {
        return res.status(403).json({
          success: false,
          data: null,
          error: 'User deactivated or not found.'
        });
      }
      if (rows[0].refresh_token_hash !== incomingHash) {
        return res.status(403).json({
          success: false,
          data: null,
          error: 'Refresh token has been invalidated. Please log in again.'
        });
      }
    }

    const payload = { 
      id: decoded.id, 
      role: decoded.role, 
      username: decoded.username,
      restaurantId: decoded.restaurantId || null
    };
    const newAccessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const newRefreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

    // FIX (Bug #6): Rotate the stored refresh token hash on every refresh
    if (decoded.role === 'rider') {
      const crypto = require('crypto');
      const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
      
      let updateQuery = 'UPDATE _riders_base SET refresh_token_hash = ? WHERE id = ?';
      const updateParams = [newHash, decoded.id];
      
      if (decoded.restaurantId) {
        updateQuery += ' AND restaurant_id = ?';
        updateParams.push(decoded.restaurantId);
      }
      
      await pool.query(updateQuery, updateParams);
    }

    return res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      },
      error: null
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Invalid or expired refresh token.'
    });
  }
};

const getRiderDutyStatus = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId; // Should be in JWT payload
  
  try {
    // FIX (Bug #1): Add explicit restaurant_id filters to all queries
    const [rows] = await pool.query(
      `SELECT a.id, a.clock_in 
       FROM _pos_attendance_base a
       JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
       JOIN _riders_base r ON s.username = r.username AND r.restaurant_id = s.restaurant_id
       WHERE r.id = ? AND r.restaurant_id = ? AND a.restaurant_id = ? AND a.date = CURDATE() AND a.clock_out IS NULL`,
      [riderId, restaurantId, restaurantId]
    );

    const isOnDuty = rows.length > 0;

    return res.json({
      success: true,
      data: {
        isOnDuty,
        clockInTime: isOnDuty ? rows[0].clock_in : null
      },
      error: null
    });
  } catch (error) {
    console.error('Error fetching rider duty status:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const riderLogout = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId; // Should be in JWT payload

  try {
    // FIX (Bug #1): Add restaurant_id filters to all queries
    // Check if clocked in (on duty)
    const [attendance] = await pool.query(
      `SELECT a.id FROM _pos_attendance_base a
       JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
       JOIN _riders_base r ON s.username = r.username AND r.restaurant_id = s.restaurant_id
       WHERE r.id = ? AND r.restaurant_id = ? AND a.restaurant_id = ? AND a.date = CURDATE() AND a.clock_out IS NULL`,
      [riderId, restaurantId, restaurantId]
    );

    if (attendance.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'You are currently clocked in (on duty). You cannot log out until you clock out from the POS system.'
      });
    }

    // FIX (Bug #6): Invalidate the refresh token by clearing its stored hash,
    // preventing post-logout token reuse for the 7-day JWT lifetime.
    await pool.query(
      'UPDATE _riders_base SET status = ?, refresh_token_hash = NULL WHERE id = ? AND restaurant_id = ?',
      ['offline', riderId, restaurantId]
    );
    await pool.query(
      'DELETE FROM _rider_sessions_base WHERE rider_id = ? AND restaurant_id = ?', 
      [riderId, restaurantId]
    );

    return res.json({
      success: true,
      data: { message: 'Logged out successfully.' },
      error: null
    });
  } catch (error) {
    console.error('Rider logout error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const verifyLicense = async (req, res) => {
  const licenseKey = req.headers['x-license-key'] || req.query.license_key || req.query.licenseKey;

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'License key is required.'
    });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, name, status, plan_type, expires_at FROM restaurants WHERE license_key = ?',
      [licenseKey]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'License key not found.'
      });
    }

    let { id, name, status, plan_type, expires_at } = rows[0];

    // Check for expiration
    const expiresAtMs = expires_at ? new Date(expires_at).getTime() : null;
    const isExpired = expiresAtMs && Date.now() > expiresAtMs;
    const finalStatus = (status !== 'suspended' && status !== 'disabled' && isExpired) ? 'expired' : status;

    if (finalStatus === 'expired' && status !== 'expired') {
      await pool.query('UPDATE restaurants SET status = ? WHERE id = ?', ['expired', id]);
    }

    // Lookup all staff details for local SQLite seeding
    const [staffRows] = await pool.query(
      'SELECT username, pin_hash, name, role, phone, email, status FROM _pos_staff_base WHERE restaurant_id = ?',
      [id]
    );

    const responseBody = {
      success: finalStatus === 'active',
      data: {
        licenseKey,
        licenseStatus: finalStatus,
        planType: plan_type,
        expiresAt: expiresAtMs,
        serverTime: Date.now(),
        restaurantName: name,
        staffList: staffRows.map(s => ({
          username: s.username,
          pinHash: s.pin_hash,
          name: s.name,
          role: s.role,
          phone: s.phone,
          email: s.email,
          status: s.status
        }))
      },
      error: finalStatus === 'active' ? null : `License key is ${finalStatus}.`
    };

    if (finalStatus === 'suspended' || finalStatus === 'disabled') {
      return res.status(403).json(responseBody);
    } else if (finalStatus === 'expired') {
      return res.status(401).json(responseBody);
    }

    return res.json(responseBody);
  } catch (error) {
    console.error('Verify license error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

module.exports = {
  riderLogin,
  adminLogin,
  refreshToken,
  riderLogout,
  getRiderDutyStatus,
  verifyLicense
};
