/**
 * customerRoutes.js — Customer REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', checkPermission('customers.view'), customerController.getAllCustomers);
router.get('/search', customerController.searchCustomers);
router.get('/orders', checkPermission('customers.view'), customerController.getCustomerOrders);

module.exports = router;
