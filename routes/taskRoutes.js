const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes
router.use(apiLimiter);
router.use(authenticateJWT);

// GET /api/tasks - Riders can view their own tasks without dispatcher permission
// Admins need dispatcher.view permission
router.get('/', (req, res, next) => {
  // Riders can always fetch their own tasks
  if (req.user.role === 'rider') {
    return taskController.getAllTasks(req, res, next);
  }
  // Admins need dispatcher.view permission
  return checkPermission('dispatcher.view')(req, res, next);
}, taskController.getAllTasks);

router.get('/my-stats', taskController.getMyRiderStats); // Handled dynamically in controller based on rider session

// GET /api/tasks/:id - Similar logic for individual task
router.get('/:id', (req, res, next) => {
  if (req.user.role === 'rider') {
    return taskController.getTaskById(req, res, next);
  }
  return checkPermission('dispatcher.view')(req, res, next);
}, taskController.getTaskById);

router.post('/', checkPermission('dispatcher.start'), taskController.createTask);
router.put('/:id', taskController.updateTaskStatus); // Handled dynamically in controller based on task state & rider assignment

module.exports = router;
