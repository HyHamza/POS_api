const express = require('express');
const router = express.Router();
const posController = require('../controllers/posController');

// Sync endpoints are authenticated via tenantMiddleware (license key) which runs globally for all tenant routes.
router.get('/sync/export',      posController.exportData);
router.get('/sync/full-export', posController.fullExportData);  // initial install full-fetch
router.post('/sync/import',     posController.importData);
router.get('/network/cloud-devices', posController.getCloudDevices);

module.exports = router;
