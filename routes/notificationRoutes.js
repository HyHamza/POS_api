/**
 * notificationRoutes.js — Notifications REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticateJWT } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', notificationController.getAllNotifications);
router.post('/mark-read', notificationController.markRead);
router.post('/mark-all-read', notificationController.markAllRead);
router.delete('/clear-all', notificationController.clearAll);
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;
