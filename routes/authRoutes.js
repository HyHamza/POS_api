const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authLimiter } = require('../middleware/rateLimit');
const { authenticateJWT, requireRider } = require('../middleware/auth');

router.post('/rider/login', authLimiter, authController.riderLogin);
router.post('/admin/login', authLimiter, authController.adminLogin);
router.post('/refresh', authLimiter, authController.refreshToken);
router.post('/rider/logout', authenticateJWT, requireRider, authController.riderLogout);
router.get('/rider/duty-status', authenticateJWT, requireRider, authController.getRiderDutyStatus);
router.get('/verify-license', authController.verifyLicense);

module.exports = router;
