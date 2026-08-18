/**
 * settingRoutes.js — Settings & Theme REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const settingController = require('../controllers/settingController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', settingController.getAllSettings);
router.get('/:key', settingController.getSetting);
router.post('/', checkPermission('settings.view'), settingController.setSetting);
router.post('/theme/broadcast', settingController.broadcastTheme);

module.exports = router;
