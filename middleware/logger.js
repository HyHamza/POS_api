const { mainPool: db } = require('../config/db');

/**
 * Middleware to intercept API requests and save them to _pos_system_logs_base
 */
async function apiLogger(req, res, next) {
  // Capture start time to potentially calculate latency
  const start = Date.now();
  
  // Capture original end and send methods
  const originalEnd = res.end;
  const originalSend = res.send;
  let responseBody = '';

  res.send = function (body) {
    responseBody = body;
    originalSend.apply(res, arguments);
  };

  res.end = function (chunk, encoding) {
    if (chunk) {
      responseBody += chunk.toString('utf8');
    }
    originalEnd.apply(res, arguments);

    // Run logging asynchronously to avoid blocking the response
    setImmediate(async () => {
      try {
        const restaurantId = req.restaurant?.id || req.user?.restaurant_id || null;
        if (!restaurantId) return; // Do not log if restaurant context is unknown

        const deviceType = req.headers['x-device-type'] || 'Unknown';
        
        // Don't log the log fetching endpoint itself to prevent infinite loop of logs
        if (req.originalUrl.includes('/api/admin/logs')) return;

        let errorDetails = null;
        if (res.statusCode >= 400) {
          errorDetails = responseBody || res.statusMessage;
        }

        // Limit payload logging size to prevent huge DB bloat (e.g. max 2KB)
        let payload = '';
        if (req.body && Object.keys(req.body).length > 0) {
          payload = JSON.stringify(req.body);
          if (payload.length > 2000) {
            payload = payload.substring(0, 2000) + '... (truncated)';
          }
        }

        const query = `
          INSERT INTO _pos_system_logs_base 
          (restaurant_id, device_type, endpoint, method, status_code, error_details, request_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const params = [
          restaurantId,
          deviceType,
          req.originalUrl,
          req.method,
          res.statusCode,
          errorDetails,
          payload
        ];

        await db.execute(query, params);
      } catch (err) {
        console.error('[System Logger] Failed to save log:', err.message);
      }
    });
  };

  next();
}

module.exports = apiLogger;
