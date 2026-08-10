const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes
router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', checkPermission('dispatcher.view'), taskController.getAllTasks);
router.get('/my-stats', taskController.getMyRiderStats); // Handled dynamically in controller based on rider session
router.get('/:id', checkPermission('dispatcher.view'), taskController.getTaskById);
router.post('/', checkPermission('dispatcher.start'), taskController.createTask);
router.put('/:id', taskController.updateTaskStatus); // Handled dynamically in controller based on task state & rider assignment

module.exports = router;
