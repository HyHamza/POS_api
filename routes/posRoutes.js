const express = require('express');
const router = express.Router();
const posController = require('../controllers/posController');
const { authenticateJWT, enforceCloudReadOnlyForNonRiders } = require('../middleware/auth');

// Sync endpoints: export is open for read; import enforces read-only for direct staff connections
router.get('/sync/export',      posController.exportData);
router.get('/sync/full-export', posController.fullExportData);  // initial install full-fetch
router.post('/sync/import',     (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticateJWT(req, res, () => {
      enforceCloudReadOnlyForNonRiders(req, res, next);
    });
  }
  next();
}, posController.importData);
router.get('/network/cloud-devices', posController.getCloudDevices);

module.exports = router;
