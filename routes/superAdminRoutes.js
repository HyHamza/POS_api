const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');
const { authenticateJWT } = require('../middleware/auth');

// Super Admin Authentication Middleware
const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Super Admin role required.'
    });
  }
  next();
};

// Public Routes
router.post('/login', superAdminController.login);

// Protected Routes (Super Admin only)
router.use(authenticateJWT);
router.use(requireSuperAdmin);

router.get('/restaurants', superAdminController.getRestaurants);
router.post('/restaurants', superAdminController.createRestaurant);
router.post('/restaurants/:id/admins', superAdminController.createAdminForRestaurant);
router.put('/restaurants/:id/plan', superAdminController.updatePlan);
router.put('/restaurants/:id/status', superAdminController.toggleStatus);
router.put('/restaurants/:id/extend', superAdminController.extendPlan);
router.delete('/restaurants/:id', superAdminController.deleteRestaurant);
router.get('/health', superAdminController.getHealth);

// Dashboard routes
router.get('/dashboard/restaurants', superAdminController.getRestaurantsOverview);
router.get('/dashboard/employees', superAdminController.getAllEmployees);
router.get('/dashboard/sales', superAdminController.getSalesAnalytics);
router.get('/dashboard/inventory', superAdminController.getAllInventory);
router.get('/dashboard/menus', superAdminController.getAllMenus);
router.get('/dashboard/orders', superAdminController.getAllOrders);
router.get('/dashboard/devices', superAdminController.getActiveDevices);
router.get('/dashboard/activity-logs', superAdminController.getActivityLogs);
router.get('/dashboard/customers', superAdminController.getAllCustomers);

module.exports = router;
