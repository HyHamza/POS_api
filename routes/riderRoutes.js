const express = require('express');
const router = express.Router();
const riderController = require('../controllers/riderController');
const { authenticateJWT, requireAdmin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes as admin-only
router.use(apiLimiter);
router.use(authenticateJWT);
router.use(requireAdmin);

router.get('/stats', riderController.getRiderStats);
router.get('/', riderController.getAllRiders);
router.post('/', riderController.createRider);
router.put('/:id', riderController.updateRider);
router.delete('/:id', riderController.deactivateRider);
router.get('/:id/location-history', riderController.getLocationHistory);

module.exports = router;
