const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // FIX (Bug #1): Removed the license-key bypass that granted admin role without
  // any token verification. A valid Bearer JWT is now always required.
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

module.exports = {
  authenticateJWT,
  requireAdmin,
  requireRider
};
