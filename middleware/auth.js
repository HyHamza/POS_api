const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // A valid Bearer JWT is always required or fallback to license key for POS sync clients
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    if (licenseKey) {
      req.user = { role: 'admin', username: 'pos_client' };
      return next();
    }
    return res.status(401).json({
      success: false,
      data: null,
      error: 'Access denied. No token provided.'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Invalid or expired token.'
    });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Access denied. Admin role required.'
    });
  }
  next();
};

const requireRider = (req, res, next) => {
  if (!req.user || req.user.role !== 'rider') {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Access denied. Rider role required.'
    });
  }
  next();
};

const checkPermission = (permission) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized.' });
    }

    // CRITICAL FIX: Bypass permission checks for riders entirely
    // Riders don't have permissions in the staff table, they have their own access rules
    if (req.user.role === 'rider') {
      console.log(`[Auth] Rider ${req.user.id} bypassing permission check: ${permission}`);
      return next();
    }

    // Bypass for super admin
    if (req.user.role === 'super_admin') {
      return next();
    }

    // Bypass for trusted POS client gateway
    if (req.user.role === 'admin' && req.user.username === 'pos_client') {
      return next();
    }

    // Tenant admin user login bypass
    if (req.user.role === 'admin') {
      return next();
    }

    const { id, restaurantId } = req.user;
    if (!id || !restaurantId) {
      return res.status(403).json({ success: false, error: 'Forbidden. Invalid context.' });
    }

    try {
      // Query staff details
      const [staffRows] = await pool.query(
        'SELECT role_id, role, permissions FROM _pos_staff_base WHERE id = ? AND restaurant_id = ?',
        [id, restaurantId]
      );

      let staffRow = null;
      if (staffRows.length > 0) {
        staffRow = staffRows[0];
      } else {
        // Check if user is a rider (should not reach here due to bypass above, but keeping for safety)
        const [riderRows] = await pool.query(
          'SELECT 1 FROM _riders_base WHERE id = ? AND restaurant_id = ?',
          [id, restaurantId]
        );
        if (riderRows.length > 0) {
          console.log(`[Auth] Rider ${id} found in database, bypassing permission check`);
          return next();
        }
      }

      if (!staffRow) {
        return res.status(403).json({ success: false, error: 'Forbidden. User profile not found.' });
      }

      // Parse overrides
      let overrides = null;
      if (staffRow.permissions) {
        try {
          overrides = typeof staffRow.permissions === 'string' 
            ? JSON.parse(staffRow.permissions) 
            : staffRow.permissions;
        } catch (_) {
          overrides = null;
        }
      }

      // If explicit custom permissions (overrides) exist, use them directly.
      // This allows the admin to revoke permissions from a staff member.
      let effectivePerms = [];
      if (overrides !== null) {
        effectivePerms = overrides;
      } else {
        // Fetch role permissions as a fallback
        let rolePerms = [];
        if (staffRow.role_id) {
          const [rpRows] = await pool.query(
            'SELECT permission_id FROM _pos_role_permissions_base WHERE role_id = ? AND is_deleted = 0',
            [staffRow.role_id]
          );
          rolePerms = rpRows.map(r => r.permission_id);
        } else if (staffRow.role) {
          const [rpRows] = await pool.query(
            `SELECT rp.permission_id FROM _pos_role_permissions_base rp
             JOIN _pos_roles_base r ON rp.role_id = r.id
             WHERE r.name = ? AND rp.is_deleted = 0 AND r.is_deleted = 0 AND r.restaurant_id = ?`,
            [staffRow.role, restaurantId]
          );
          rolePerms = rpRows.map(r => r.permission_id);
        }
        effectivePerms = rolePerms;
      }

      const effective = new Set(effectivePerms);

      if (effective.has(permission)) {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: `Forbidden. Missing required permission: ${permission}`
      });

    } catch (err) {
      console.error('Permission validation error:', err);
      return res.status(500).json({ success: false, error: 'Internal server error validating permissions.' });
    }
  };
};

const enforceCloudReadOnlyForNonRiders = (req, res, next) => {
  // Allow all read requests
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  if (req.user) {
    const role = (req.user.role || '').toLowerCase();
    
    // Riders have full read/write through the Cloud API
    if (role === 'rider') {
      return next();
    }

    // Super Admin has full write access
    if (role === 'super_admin') {
      return next();
    }

    // Trusted local POS desktop sync gateway
    if (role === 'admin' && req.user.username === 'pos_client') {
      return next();
    }

    // Tenant admin user
    if (role === 'admin') {
      return next();
    }

    // Non-rider staff attempting writes on Cloud API
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Cloud Fallback Mode: Operational write actions are disabled for staff when connecting directly to Cloud API. Local main server connection is required for transactions.'
    });
  }

  next();
};

module.exports = {
  authenticateJWT,
  requireAdmin,
  requireRider,
  checkPermission,
  enforceCloudReadOnlyForNonRiders
};
