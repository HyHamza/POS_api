const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes
router.use(apiLimiter);
router.use(authenticateJWT);

// Middleware to bypass permission check for riders
const bypassForRiders = (permission) => {
  return (req, res, next) => {
    // Riders can access without permission checks
    if (req.user && req.user.role === 'rider') {
      console.log(`[TaskRoutes] Rider ${req.user.id} bypassing permission check for ${permission}`);
      return next();
    }
    // Others need the permission
    console.log(`[TaskRoutes] Non-rider user (${req.user.role}) checking permission: ${permission}`);
    return checkPermission(permission)(req, res, next);
  };
};

// GET /api/tasks - Riders can view their own tasks without dispatcher permission
router.get('/', bypassForRiders('dispatcher.view'), taskController.getAllTasks);

router.get('/my-stats', taskController.getMyRiderStats);

// GET /api/tasks/:id - Riders can view tasks assigned to them
router.get('/:id', bypassForRiders('dispatcher.view'), taskController.getTaskById);

router.post('/', checkPermission('dispatcher.start'), taskController.createTask);
router.put('/order/:orderNumber/status', taskController.updateTaskByOrderNumber);
router.put('/by-order/:orderNumber', taskController.updateTaskByOrderNumber);
router.put('/:id', taskController.updateTaskStatus);

module.exports = router;
