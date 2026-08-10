const express = require('express');
const router = express.Router();
const riderController = require('../controllers/riderController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

// Apply general API rate limiter and authenticate all routes
router.use(apiLimiter);
router.use(authenticateJWT);

router.get('/stats', checkPermission('reports.financial.view'), riderController.getRiderStats);
router.get('/', checkPermission('staff.view'), riderController.getAllRiders);
router.post('/', checkPermission('staff.create'), riderController.createRider);
router.put('/:id', checkPermission('staff.edit'), riderController.updateRider);
router.delete('/:id', checkPermission('staff.delete'), riderController.deactivateRider);
router.get('/:id/location-history', checkPermission('staff.view'), riderController.getLocationHistory);

module.exports = router;
