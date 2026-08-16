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

    const isOnDuty = await isRiderDutyActive(rider.id, restaurantId);
    const initialStatus = isOnDuty ? 'idle' : 'offline';

    // FIX (Bug #6): Store a hash of the refresh token so we can invalidate it on logout.
    const crypto = require('crypto');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(
      'UPDATE _riders_base SET status = ?, refresh_token_hash = ? WHERE id = ? AND restaurant_id = ?',
      [initialStatus, refreshTokenHash, rider.id, restaurantId]
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
          status: initialStatus,
          isClockedIn: isOnDuty,
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

async function isRiderDutyActive(riderId, restaurantId) {
  try {
    if (!riderId || !restaurantId) return false;

    // Strict check: Open attendance record in _pos_attendance_base
    const [rows] = await pool.query(
      `SELECT a.id, a.clock_in FROM _pos_attendance_base a
       LEFT JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
       LEFT JOIN _riders_base r ON (s.username = r.username OR a.staff_id = r.id) AND r.restaurant_id = a.restaurant_id
       WHERE a.restaurant_id = ?
         AND (a.clock_out IS NULL OR a.clock_out = '' OR a.clock_out = 'null')
         AND (a.is_deleted IS NULL OR a.is_deleted = 0)
         AND (r.id = ? OR a.staff_id = ?)
       LIMIT 1`,
      [restaurantId, riderId, riderId]
    );

    return rows.length > 0;
  } catch (err) {
    console.error('[isRiderDutyActive Error]', err);
    return false;
  }
}

const getRiderDutyStatus = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId; // Should be in JWT payload
  
  try {
    const isOnDuty = await isRiderDutyActive(riderId, restaurantId);

    // Get clock in time if available
    let clockInTime = null;
    try {
      const [rows] = await pool.query(
        `SELECT a.clock_in FROM _pos_attendance_base a
         LEFT JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
         LEFT JOIN _riders_base r ON (s.username = r.username OR a.staff_id = r.id) AND r.restaurant_id = a.restaurant_id
         WHERE a.restaurant_id = ?
           AND (a.clock_out IS NULL OR a.clock_out = '' OR a.clock_out = 'null')
           AND (a.is_deleted IS NULL OR a.is_deleted = 0)
           AND (r.id = ? OR a.staff_id = ?)
         ORDER BY a.id DESC LIMIT 1`,
        [restaurantId, riderId, riderId]
      );
      if (rows.length > 0) clockInTime = rows[0].clock_in;
    } catch (_) {}

    return res.json({
      success: true,
      data: {
        isOnDuty,
        clockInTime: clockInTime || (isOnDuty ? new Date().toISOString() : null)
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
    const isOnDuty = await isRiderDutyActive(riderId, restaurantId);

    if (isOnDuty) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'You are currently clocked in (on duty). You cannot log out until you clock out from the POS system.'
      });
    }

    // Invalidate the refresh token by clearing its stored hash
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
        restaurantId: id,
        restaurant_id: id,
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

const staffLogin = async (req, res) => {
  const { username, pin, password } = req.body;
  const credential = pin || password;
  const licenseKey = req.headers['x-license-key'] || req.query.license_key || req.body.license_key;

  if (!username || !credential) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Username and PIN/password are required.'
    });
  }

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'License key (x-license-key header) is required.'
    });
  }

  try {
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
    const crypto = require('crypto');
    const inputPinHash = crypto.createHash('sha256').update(String(credential).trim()).digest('hex');

    const [rows] = await pool.query(
      `SELECT id, restaurant_id, name, username, pin_hash, role_id, role, status, permissions, 
              assigned_categories, assigned_items, assigned_order_types 
       FROM _pos_staff_base 
       WHERE username = ? AND restaurant_id = ?`,
      [username.trim(), restaurantId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid username or PIN.'
      });
    }

    const staff = rows[0];

    if (staff.status !== 'Active') {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Staff account is deactivated or inactive.'
      });
    }

    // Compare PIN hash
    if (staff.pin_hash !== inputPinHash) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid username or PIN.'
      });
    }

    // Parse permissions
    let parsedPermissions = [];
    if (staff.permissions) {
      try {
        parsedPermissions = typeof staff.permissions === 'string' ? JSON.parse(staff.permissions) : staff.permissions;
      } catch (_) {
        parsedPermissions = [];
      }
    }

    // Check attendance status (any active open session)
    const [attRows] = await pool.query(
      `SELECT id, clock_in FROM _pos_attendance_base 
       WHERE (staff_id = ? OR staff_id = ?) AND restaurant_id = ?
         AND (clock_out IS NULL OR clock_out = '' OR clock_out = 'null')
         AND (is_deleted IS NULL OR is_deleted = 0)
       ORDER BY id DESC LIMIT 1`,
      [staff.id, staff.username, restaurantId]
    );

    const isClockedIn = attRows.length > 0;
    const attendanceRecord = isClockedIn ? attRows[0] : null;

    const payload = {
      id: staff.id,
      role: staff.role,
      username: staff.username,
      restaurantId: staff.restaurant_id,
      permissions: parsedPermissions
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          name: staff.name,
          username: staff.username,
          role: staff.role,
          status: staff.status,
          permissions: parsedPermissions,
          isClockedIn,
          attendanceRecord,
          assigned_categories: staff.assigned_categories,
          assigned_items: staff.assigned_items,
          assigned_order_types: staff.assigned_order_types,
          restaurantId: staff.restaurant_id
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Staff login error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const unifiedLogin = async (req, res) => {
  const { username, credential } = req.body;
  const licenseKey = req.headers['x-license-key'] || req.query.license_key;

  if (!username || !credential) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Username and credential (PIN or Password) are required.'
    });
  }

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'License key (x-license-key header) is required.'
    });
  }

  try {
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
    const cleanUsername = username.trim();
    const cleanCred = String(credential).trim();

    // 1. Try Staff PIN
    const crypto = require('crypto');
    const inputPinHash = crypto.createHash('sha256').update(cleanCred).digest('hex');

    const [staffRows] = await pool.query(
      `SELECT id, restaurant_id, name, username, pin_hash, role_id, role, status, permissions,
              assigned_categories, assigned_items, assigned_order_types
       FROM _pos_staff_base
       WHERE username = ? AND restaurant_id = ?`,
      [cleanUsername, restaurantId]
    );

    if (staffRows.length > 0) {
      const staff = staffRows[0];
      if (staff.status === 'Active' && staff.pin_hash === inputPinHash) {
        let parsedPermissions = [];
        if (staff.permissions) {
          try {
            parsedPermissions = typeof staff.permissions === 'string' ? JSON.parse(staff.permissions) : staff.permissions;
          } catch (_) {
            parsedPermissions = [];
          }
        }

        const [attRows] = await pool.query(
          `SELECT id, clock_in FROM _pos_attendance_base 
           WHERE (staff_id = ? OR staff_id = ?) AND restaurant_id = ?
             AND (clock_out IS NULL OR clock_out = '' OR clock_out = 'null')
             AND (is_deleted IS NULL OR is_deleted = 0)
           ORDER BY id DESC LIMIT 1`,
          [staff.id, staff.username, restaurantId]
        );

        const isClockedIn = attRows.length > 0;
        const payload = {
          id: staff.id,
          role: staff.role,
          username: staff.username,
          restaurantId: staff.restaurant_id,
          permissions: parsedPermissions
        };

        const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
        const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

        return res.json({
          success: true,
          data: {
            userType: 'staff',
            role: staff.role,
            accessToken,
            refreshToken,
            user: {
              id: staff.id,
              name: staff.name,
              username: staff.username,
              role: staff.role,
              status: staff.status,
              permissions: parsedPermissions,
              isClockedIn,
              attendanceRecord: isClockedIn ? attRows[0] : null,
              assigned_categories: staff.assigned_categories,
              assigned_items: staff.assigned_items,
              assigned_order_types: staff.assigned_order_types,
              restaurantId: staff.restaurant_id
            }
          },
          error: null
        });
      }
    }

    // 2. Try Rider Password
    const [riderRows] = await pool.query(
      'SELECT id, username, password_hash, full_name, phone, status, is_active, restaurant_id FROM _riders_base WHERE username = ? AND restaurant_id = ?',
      [cleanUsername, restaurantId]
    );

    if (riderRows.length > 0) {
      const rider = riderRows[0];
      if (rider.is_active) {
        const isMatch = await bcrypt.compare(cleanCred, rider.password_hash);
        if (isMatch) {
          const payload = { id: rider.id, role: 'rider', username: rider.username, restaurantId: rider.restaurant_id };
          const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
          const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

          const isOnDuty = await isRiderDutyActive(rider.id, restaurantId);
          const initialStatus = isOnDuty ? 'idle' : 'offline';

          const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
          await pool.query(
            'UPDATE _riders_base SET status = ?, refresh_token_hash = ? WHERE id = ? AND restaurant_id = ?',
            [initialStatus, refreshTokenHash, rider.id, restaurantId]
          );

          let clockInTime = null;
          if (isOnDuty) {
            try {
              const [attRows] = await pool.query(
                `SELECT a.clock_in FROM _pos_attendance_base a
                 LEFT JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
                 LEFT JOIN _riders_base r ON (s.username = r.username OR a.staff_id = r.id) AND r.restaurant_id = a.restaurant_id
                 WHERE a.restaurant_id = ?
                   AND (a.clock_out IS NULL OR a.clock_out = '' OR a.clock_out = 'null')
                   AND (a.is_deleted IS NULL OR a.is_deleted = 0)
                   AND (r.id = ? OR a.staff_id = ?)
                 ORDER BY a.id DESC LIMIT 1`,
                [restaurantId, rider.id, rider.id]
              );
              if (attRows.length > 0) clockInTime = attRows[0].clock_in;
            } catch (_) {}
          }

          return res.json({
            success: true,
            data: {
              userType: 'rider',
              role: 'rider',
              accessToken,
              refreshToken,
              user: {
                id: rider.id,
                username: rider.username,
                full_name: rider.full_name,
                phone: rider.phone,
                status: initialStatus,
                isClockedIn: isOnDuty,
                clockInTime: isOnDuty ? (clockInTime || new Date().toISOString()) : null,
                restaurantId: rider.restaurant_id
              }
            },
            error: null
          });
        }
      }
    }

    // 3. Try Admin Password
    const [adminRows] = await pool.query(
      'SELECT id, username, password_hash, restaurant_id FROM _admins_base WHERE username = ? AND restaurant_id = ?',
      [cleanUsername, restaurantId]
    );

    if (adminRows.length > 0) {
      const admin = adminRows[0];
      const isMatch = await bcrypt.compare(cleanCred, admin.password_hash);
      if (isMatch) {
        const payload = { id: admin.id, role: 'admin', username: admin.username, restaurantId: admin.restaurant_id };
        const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
        const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

        return res.json({
          success: true,
          data: {
            userType: 'admin',
            role: 'Admin',
            accessToken,
            refreshToken,
            user: {
              id: admin.id,
              username: admin.username,
              role: 'Admin',
              restaurantId: admin.restaurant_id
            }
          },
          error: null
        });
      }
    }

    return res.status(401).json({
      success: false,
      data: null,
      error: 'Invalid credentials.'
    });

  } catch (error) {
    console.error('Unified login error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const riderClockIn = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId;

  try {
    const [riderRows] = await pool.query(
      'SELECT id, username, full_name, restaurant_id FROM _riders_base WHERE id = ? AND restaurant_id = ?',
      [riderId, restaurantId]
    );

    if (riderRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Rider profile not found.' });
    }

    const rider = riderRows[0];

    // Find or create matching record in _pos_staff_base for attendance tracking
    let staffId = null;
    const [staffRows] = await pool.query(
      'SELECT id FROM _pos_staff_base WHERE username = ? AND restaurant_id = ?',
      [rider.username, restaurantId]
    );

    if (staffRows.length > 0) {
      staffId = staffRows[0].id;
    } else {
      const [insStaff] = await pool.query(
        `INSERT INTO _pos_staff_base (restaurant_id, name, username, role, status)
         VALUES (?, ?, ?, 'Rider', 'Active')`,
        [restaurantId, rider.full_name || rider.username, rider.username]
      );
      staffId = insStaff.insertId;
    }

    // Check if already has open attendance session
    const [openAttendance] = await pool.query(
      `SELECT id, clock_in FROM _pos_attendance_base 
       WHERE (staff_id = ? OR staff_id = ?) AND restaurant_id = ?
         AND (clock_out IS NULL OR clock_out = '' OR clock_out = 'null')
         AND (is_deleted IS NULL OR is_deleted = 0)
       ORDER BY id DESC LIMIT 1`,
      [staffId, riderId, restaurantId]
    );

    let attId = null;
    let clockInTime = null;

    if (openAttendance.length > 0) {
      attId = openAttendance[0].id;
      clockInTime = openAttendance[0].clock_in;
    } else {
      const [insAtt] = await pool.query(
        `INSERT INTO _pos_attendance_base (restaurant_id, staff_id, date, clock_in, verification_method)
         VALUES (?, ?, CURDATE(), NOW(), 'Mobile')`,
        [restaurantId, staffId]
      );
      attId = insAtt.insertId;
      clockInTime = new Date().toISOString();
    }

    // Update rider status to idle
    await pool.query(
      'UPDATE _riders_base SET status = ? WHERE id = ? AND restaurant_id = ?',
      ['idle', riderId, restaurantId]
    );

    // Broadcast socket event and join rider to dispatch rooms
    const io = req.app.get('io');
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    if (io && licenseKey) {
      io.to(`rider:${licenseKey}:${riderId}`).emit('rider:duty:change', {
        riderId,
        isClockedIn: true,
        clockInTime
      });
      io.to(`admin:${licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
      io.to(`admin:${licenseKey}`).emit('attendance:change', { staff_id: staffId, clocked_in: true });
    }

    return res.json({
      success: true,
      data: {
        isClockedIn: true,
        clockInTime,
        attendanceId: attId
      }
    });
  } catch (error) {
    console.error('Rider clock-in error:', error);
    return res.status(500).json({ success: false, error: 'Failed to clock in.' });
  }
};

const riderClockOut = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId;

  try {
    const [riderRows] = await pool.query(
      'SELECT id, username, restaurant_id FROM _riders_base WHERE id = ? AND restaurant_id = ?',
      [riderId, restaurantId]
    );

    if (riderRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Rider profile not found.' });
    }

    const rider = riderRows[0];

    // Find matching staff record
    const [staffRows] = await pool.query(
      'SELECT id FROM _pos_staff_base WHERE username = ? AND restaurant_id = ?',
      [rider.username, restaurantId]
    );

    let staffId = staffRows.length > 0 ? staffRows[0].id : null;

    // Close any open attendance sessions for this rider
    await pool.query(
      `UPDATE _pos_attendance_base 
       SET clock_out = NOW() 
       WHERE (staff_id = ? OR staff_id = ?) AND restaurant_id = ?
         AND (clock_out IS NULL OR clock_out = '' OR clock_out = 'null')`,
      [staffId || riderId, riderId, restaurantId]
    );

    // Set rider status to offline
    await pool.query(
      'UPDATE _riders_base SET status = ? WHERE id = ? AND restaurant_id = ?',
      ['offline', riderId, restaurantId]
    );

    const io = req.app.get('io');
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    if (io && licenseKey) {
      io.to(`rider:${licenseKey}:${riderId}`).emit('rider:duty:change', {
        riderId,
        isClockedIn: false
      });
      io.to(`admin:${licenseKey}`).emit('rider:status:update', { riderId, status: 'offline' });
      if (staffId) {
        io.to(`admin:${licenseKey}`).emit('attendance:change', { staff_id: staffId, clocked_in: false });
      }
    }

    return res.json({
      success: true,
      data: {
        isClockedIn: false
      }
    });
  } catch (error) {
    console.error('Rider clock-out error:', error);
    return res.status(500).json({ success: false, error: 'Failed to clock out.' });
  }
};

module.exports = {
  riderLogin,
  adminLogin,
  staffLogin,
  unifiedLogin,
  refreshToken,
  riderLogout,
  getRiderDutyStatus,
  riderClockIn,
  riderClockOut,
  verifyLicense,
  isRiderDutyActive
};
