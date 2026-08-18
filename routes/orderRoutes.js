/**
 * orderRoutes.js — Order REST API Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/', orderController.getAllOrders);
router.get('/held', orderController.getHeldOrders);
router.get('/recent', orderController.getRecentOrders);
router.get('/cashier-stats', orderController.getCashierStats);
router.get('/:id', orderController.getOrderById);

router.post('/', checkPermission('orders.create'), orderController.createOrder);
router.put('/:id/status', checkPermission('orders.edit'), orderController.updateOrderStatus);
router.put('/:id/hold', checkPermission('orders.edit'), orderController.holdOrder);
router.put('/:id/unhold', checkPermission('orders.edit'), orderController.unholdOrder);
router.post('/:id/pay', checkPermission('orders.edit'), orderController.markPaymentReceived);
router.post('/:id/assign-rider', checkPermission('dispatcher.start'), orderController.assignRider);
router.post('/:id/return', checkPermission('orders.edit'), orderController.returnOrder);

module.exports = router;
