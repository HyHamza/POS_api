const express = require('express');
const router = express.Router();
const appReleaseController = require('../controllers/appReleaseController');

// GET /api/app-updates/latest
router.get('/latest', appReleaseController.getLatestPublic);

module.exports = router;
