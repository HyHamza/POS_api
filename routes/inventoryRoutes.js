/**
 * inventoryRoutes.js — Inventory REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', inventoryController.getAllItems);
router.get('/log', inventoryController.getLog);
router.get('/low-stock', inventoryController.getLowStock);

router.post('/', checkPermission('inventory.edit'), inventoryController.createItem);
router.put('/:id', checkPermission('inventory.edit'), inventoryController.updateItem);
router.post('/adjust', checkPermission('inventory.edit'), inventoryController.adjustStock);
router.delete('/:id', checkPermission('inventory.edit'), inventoryController.deleteItem);

module.exports = router;
