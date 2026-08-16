const express = require('express');
const router = express.Router();
const dealController = require('../controllers/dealController');
const { authenticateJWT, requireAdmin } = require('../middleware/auth');

// Public or POS Client access
router.get('/', authenticateJWT, dealController.getDeals);
router.get('/:id', authenticateJWT, dealController.getDealById);

// Admin-only mutation endpoints
router.post('/', authenticateJWT, requireAdmin, dealController.createDeal);
router.put('/:id', authenticateJWT, requireAdmin, dealController.updateDeal);
router.patch('/:id/status', authenticateJWT, requireAdmin, dealController.toggleDealStatus);
router.delete('/:id', authenticateJWT, requireAdmin, dealController.deleteDeal);

module.exports = router;
