const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authLimiter } = require('../middleware/rateLimit');
const { authenticateJWT, requireRider } = require('../middleware/auth');

router.post('/login', authLimiter, authController.unifiedLogin);
router.post('/staff/login', authLimiter, authController.staffLogin);
router.post('/rider/login', authLimiter, authController.riderLogin);
router.post('/admin/login', authLimiter, authController.adminLogin);
router.post('/refresh', authLimiter, authController.refreshToken);
router.post('/rider/logout', authenticateJWT, requireRider, authController.riderLogout);
router.get('/rider/duty-status', authenticateJWT, requireRider, authController.getRiderDutyStatus);
router.post('/rider/clock-in', authenticateJWT, requireRider, authController.riderClockIn);
router.post('/rider/clock-out', authenticateJWT, requireRider, authController.riderClockOut);
router.get('/rider/attendance', authenticateJWT, requireRider, authController.getRiderAttendance);
router.get('/rider/salary', authenticateJWT, requireRider, authController.getRiderSalary);
router.get('/rider/profile', authenticateJWT, requireRider, authController.getRiderProfile);
router.get('/verify-license', authController.verifyLicense);

module.exports = router;
