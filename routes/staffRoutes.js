/**
 * staffRoutes.js — Staff, Attendance & Face Biometrics REST Routes for POS_api
 */

'use strict';

const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const { authenticateJWT, checkPermission } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');

router.use(apiLimiter);
router.use(authenticateJWT);

// Staff Directory
router.get('/', staffController.getAllStaff);
router.get('/on-duty', staffController.getOnDutyStaff);
router.get('/check-clock-in', staffController.checkClockIn);
router.get('/attendance', staffController.getAttendance);
router.get('/:id', staffController.getStaffById);

router.post('/', checkPermission('staff.create'), staffController.createStaff);
router.put('/:id', checkPermission('staff.edit'), staffController.updateStaff);
router.delete('/:id', checkPermission('staff.delete'), staffController.deleteStaff);
router.put('/:id/assignments', checkPermission('staff.edit'), staffController.updateAssignments);

// Clock In / Out
router.post('/clock-in', staffController.clockIn);
router.post('/clock-out', staffController.clockOut);
router.post('/verify-pin-clock', staffController.verifyPinAndClock);
router.post('/change-pin', staffController.changeLoginPin);
router.delete('/attendance/:id', staffController.deleteAttendance);

// Face Recognition
router.get('/face/descriptors', staffController.getFaceDescriptors);
router.post('/face/descriptor', staffController.saveFaceDescriptor);
router.delete('/face/descriptor/:staff_id', staffController.deleteFaceDescriptor);

module.exports = router;
