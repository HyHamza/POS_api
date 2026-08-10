const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticateJWT, requireAdmin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes
router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', taskController.getAllTasks);
router.get('/my-stats', taskController.getMyRiderStats);
router.get('/:id', taskController.getTaskById);
router.post('/', requireAdmin, taskController.createTask);
router.put('/:id', taskController.updateTaskStatus);

module.exports = router;
