/**
 * reportRoutes.js — Cloud Reporting API Routes for RestaurantOS POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

// 17 Sale Reports
router.get('/sales/rider-wise',         reportController.getRiderWise);
router.get('/sales/custom',             reportController.getCustomSales);
router.get('/sales/daily',              reportController.getDailySales);
router.get('/sales/item-wise-thermal',  reportController.getItemWiseThermal);
router.get('/sales/monthly',            reportController.getMonthlySales);
router.get('/sales/employee-wise',      reportController.getEmployeeWise);
router.get('/sales/order-return',       reportController.getOrderReturn);
router.get('/sales/customer-wise',      reportController.getCustomerWise);
router.get('/sales/menu-wise',          reportController.getMenuWise);
router.get('/sales/hourly',             reportController.getHourlySales);
router.get('/sales/sub-menu-wise',      reportController.getSubMenuWise);
router.get('/sales/void-wise',          reportController.getVoidWise);
router.get('/sales/refund-wise',        reportController.getRefundWise);
router.get('/sales/discount-wise',      reportController.getDiscountWise);
router.get('/sales/mop-wise',           reportController.getMopWise);
router.get('/sales/mop-wise-detail',    reportController.getMopWiseDetail);
router.get('/sales/order-type-wise',    reportController.getOrderTypeWise);

// Inventory, Ledger, Receipts
router.get('/inventory',                reportController.getInventory);
router.get('/customer-ledger',          reportController.getCustomerLedger);
router.get('/receipts',                 reportController.getReceipts);
router.get('/receipts/:id',             reportController.getReceiptDetails);

module.exports = router;
