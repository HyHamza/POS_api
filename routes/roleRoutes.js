/**
 * roleRoutes.js — Roles & Permissions REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const roleController = require('../controllers/roleController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', roleController.getRoles);
router.post('/', checkPermission('settings.view'), roleController.createRole);
router.put('/:id', checkPermission('settings.view'), roleController.updateRole);
router.delete('/:id', checkPermission('settings.view'), roleController.deleteRole);

module.exports = router;
