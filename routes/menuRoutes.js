/**
 * menuRoutes.js — Menu REST API Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menuController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

// Categories
router.get('/categories', menuController.getCategories);
router.post('/categories', checkPermission('menu.edit'), menuController.createCategory);
router.put('/categories/reorder', checkPermission('menu.edit'), menuController.reorderCategories);
router.put('/categories/:id', checkPermission('menu.edit'), menuController.updateCategory);
router.delete('/categories/:id', checkPermission('menu.edit'), menuController.deleteCategory);

// Items
router.get('/items', menuController.getItems);
router.post('/items', checkPermission('menu.edit'), menuController.createItem);
router.put('/items/:id', checkPermission('menu.edit'), menuController.updateItem);
router.patch('/items/:id/availability', checkPermission('menu.edit'), menuController.toggleAvailability);
router.delete('/items/:id', checkPermission('menu.edit'), menuController.deleteItem);

// Import & Export
router.get('/export', checkPermission('menu.edit'), menuController.exportJSON);
router.post('/import', checkPermission('menu.edit'), menuController.importJSON);
router.post('/import-full', checkPermission('menu.edit'), menuController.importFullJSON);

module.exports = router;
