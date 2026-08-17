const { mainPool: db } = require('../config/db');

/**
 * Middleware to intercept API requests and save them to _pos_system_logs_base.
 * PROTECTED: Only logs errors (status >= 400) to prevent database bloat and excessive IOPS.
 */
async function apiLogger(req, res, next) {
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

    // Only record in database if an actual error occurred (status >= 400)
    // Routine 200/304 requests, location updates, and health checks are skipped to save DB size.
    const isError = res.statusCode >= 400;
    const verboseLogging = process.env.ENABLE_VERBOSE_DB_LOGGING === 'true';

    if (!isError && !verboseLogging) {
      return;
    }

    // Run logging asynchronously to avoid blocking the response
    setImmediate(async () => {
      try {
        const restaurantId = req.restaurant?.id || req.user?.restaurant_id || null;
        if (!restaurantId) return; // Do not log if restaurant context is unknown

        const deviceType = req.headers['x-device-type'] || 'Unknown';
        
        // Don't log the log fetching or health endpoints to prevent infinite loops
        if (req.originalUrl.includes('/api/admin/logs') || req.originalUrl.includes('/api/health')) return;

        let errorDetails = null;
        if (res.statusCode >= 400) {
          errorDetails = typeof responseBody === 'string' ? responseBody.substring(0, 1000) : res.statusMessage;
        }

        // Limit payload logging size to max 500 chars to prevent DB bloat
        let payload = '';
        if (req.body && Object.keys(req.body).length > 0) {
          try {
            payload = JSON.stringify(req.body);
            if (payload.length > 500) {
              payload = payload.substring(0, 500) + '... (truncated)';
            }
          } catch (_) {}
        }

        const query = `
          INSERT INTO _pos_system_logs_base 
          (restaurant_id, device_type, endpoint, method, status_code, error_details, request_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const params = [
          restaurantId,
          deviceType,
          req.originalUrl.substring(0, 255),
          req.method,
          res.statusCode,
          errorDetails,
          payload
        ];

        await db.execute(query, params);
      } catch (err) {
        console.error('[System Logger] Failed to save error log:', err.message);
      }
    });
  };

  next();
}

module.exports = apiLogger;
