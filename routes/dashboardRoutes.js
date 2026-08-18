/**
 * dashboardRoutes.js — Dashboard REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticateJWT } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', dashboardController.getDashboardData);

module.exports = router;
