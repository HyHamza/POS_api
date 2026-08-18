/**
 * activityRoutes.js — Activity Logs REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', checkPermission('settings.view'), activityController.getAllActivities);
router.post('/', activityController.logActivity);

module.exports = router;
