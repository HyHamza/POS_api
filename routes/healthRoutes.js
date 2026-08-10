const express = require('express');
const router = express.Router();
const { mainPool: db, asyncLocalStorage } = require('../config/db');
const locationSocket = require('../sockets/locationSocket');

// GET /api/health (Sanity Ping)
router.get('/', (req, res) => {
  res.json({ success: true, message: 'Server is healthy' });
});

// GET /api/health/metrics
router.get('/metrics', async (req, res) => {
  try {
    const restaurantId = asyncLocalStorage.getStore()?.restaurantId;
    if (!restaurantId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Calculate total errors today
    const [errorCountResult] = await db.execute(`
      SELECT COUNT(*) as count 
      FROM _pos_system_logs_base 
      WHERE restaurant_id = ? AND status_code >= 400 AND created_at >= CURDATE()
    `, [restaurantId]);
    
    const totalErrorsToday = errorCountResult[0].count;

    // Get live WebSocket connections from the socket.io store
    let deviceCounts = { rider: 0, pos: 0 };
    if (typeof locationSocket.getConnectedDeviceCounts === 'function') {
      deviceCounts = locationSocket.getConnectedDeviceCounts(restaurantId);
    }

    res.json({
      success: true,
      data: {
        totalErrorsToday,
        activeDevices: deviceCounts,
        websocketHealth: 'Healthy',
      }
    });
  } catch (err) {
    console.error('[Health API] Metrics error:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// GET /api/health/logs
router.get('/logs', async (req, res) => {
  try {
    const restaurantId = asyncLocalStorage.getStore()?.restaurantId;
    if (!restaurantId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const limit = parseInt(req.query.limit) || 100;
    const deviceType = req.query.deviceType;
    const status = req.query.status;

    let query = 'SELECT * FROM _pos_system_logs_base WHERE restaurant_id = ?';
    const params = [restaurantId];

    if (deviceType && deviceType !== 'all') {
      query += ' AND device_type = ?';
      params.push(deviceType);
    }
    
    if (status === 'error') {
      query += ' AND status_code >= 400';
    } else if (status === 'success') {
      query += ' AND status_code < 400';
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [logs] = await db.execute(query, params);

    res.json({
      success: true,
      data: logs
    });
  } catch (err) {
    console.error('[Health API] Logs error:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

module.exports = router;
