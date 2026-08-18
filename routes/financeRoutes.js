/**
 * financeRoutes.js — Finance & Payroll REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const financeController = require('../controllers/financeController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/summary', checkPermission('finance.view'), financeController.getSummary);
router.get('/revenue-chart', checkPermission('finance.view'), financeController.getRevenueChart);
router.get('/expenses', checkPermission('finance.view'), financeController.getExpenses);
router.post('/expenses', checkPermission('finance.create'), financeController.addExpense);
router.delete('/expenses/:id', checkPermission('finance.delete'), financeController.deleteExpense);

router.get('/payroll', checkPermission('finance.payroll.view'), financeController.getPayroll);
router.post('/payroll/process', checkPermission('finance.payroll.process'), financeController.processPayroll);
router.post('/payroll/:id/pay', checkPermission('finance.payroll.process'), financeController.markPaid);

router.get('/pl', checkPermission('finance.view'), financeController.getPL);
router.get('/staff-sales', checkPermission('finance.view'), financeController.getStaffSalesReport);

module.exports = router;
