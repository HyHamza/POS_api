/**
 * tableRoutes.js — Floors, Sections & Tables REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const tableController = require('../controllers/tableController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

// Tables
router.get('/', tableController.getTables);
router.post('/', checkPermission('tables.manage'), tableController.createTable);
router.put('/:id', checkPermission('tables.manage'), tableController.updateTable);
router.patch('/:id/status', tableController.updateTableStatus);
router.delete('/:id', checkPermission('tables.manage'), tableController.deleteTable);

// Floors
router.get('/floors', tableController.getFloors);
router.post('/floors', checkPermission('tables.manage'), tableController.createFloor);
router.put('/floors/:id', checkPermission('tables.manage'), tableController.updateFloor);
router.delete('/floors/:id', checkPermission('tables.manage'), tableController.deleteFloor);

// Sections
router.get('/sections', tableController.getSections);
router.post('/sections', checkPermission('tables.manage'), tableController.createSection);
router.put('/sections/:id', checkPermission('tables.manage'), tableController.updateSection);
router.delete('/sections/:id', checkPermission('tables.manage'), tableController.deleteSection);

module.exports = router;
