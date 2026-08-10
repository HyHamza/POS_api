const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

const authenticateSuperAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Access denied. Super Admin token required.'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super Admin role required.'
      });
    }
    req.superAdmin = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: 'Invalid or expired Super Admin token.'
    });
  }
};

router.post('/login', superAdminController.login);
router.get('/restaurants', authenticateSuperAdmin, superAdminController.getRestaurants);
router.post('/restaurants', authenticateSuperAdmin, superAdminController.createRestaurant);
router.put('/restaurants/:id/status', authenticateSuperAdmin, superAdminController.toggleStatus);
router.put('/restaurants/:id/plan', authenticateSuperAdmin, superAdminController.updatePlan);
router.put('/restaurants/:id/extend', authenticateSuperAdmin, superAdminController.extendPlan);
router.delete('/restaurants/:id', authenticateSuperAdmin, superAdminController.deleteRestaurant);
router.get('/health', authenticateSuperAdmin, superAdminController.getHealth);

// New comprehensive data endpoints
router.get('/dashboard/restaurants', authenticateSuperAdmin, superAdminController.getRestaurantsOverview);
router.get('/dashboard/employees', authenticateSuperAdmin, superAdminController.getAllEmployees);
router.get('/dashboard/sales', authenticateSuperAdmin, superAdminController.getSalesAnalytics);
router.get('/dashboard/inventory', authenticateSuperAdmin, superAdminController.getAllInventory);
router.get('/dashboard/menus', authenticateSuperAdmin, superAdminController.getAllMenus);
router.get('/dashboard/orders', authenticateSuperAdmin, superAdminController.getAllOrders);
router.get('/dashboard/devices', authenticateSuperAdmin, superAdminController.getActiveDevices);
router.get('/dashboard/activity-logs', authenticateSuperAdmin, superAdminController.getActivityLogs);
router.get('/dashboard/customers', authenticateSuperAdmin, superAdminController.getAllCustomers);

module.exports = router;
