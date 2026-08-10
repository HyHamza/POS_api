const WebSocket = require('ws');
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * WebSocketBroadcaster
 * 
 * Strict multi-tenant WebSocket broker using an in-memory Map<restaurant_id, Set<WebSocket>>.
 * Single instance constraint: This design expects a single Node.js process.
 * If this application is scaled horizontally (multiple instances behind a load balancer),
 * broadcasts will only reach clients connected to the same instance as the HTTP request.
 * For horizontal scaling, a Redis pub/sub backplane (or similar fan-out broker) must be implemented.
 */
class WebSocketBroadcaster {
  constructor() {
    // Structure: Map<restaurant_id, Set<WebSocket>>
    this.tenantSockets = new Map();
    this.wss = null;

    // Rate limit configuration per socket
    this.RATE_LIMIT_TOKENS = 50; // max bursts
    this.RATE_LIMIT_REFILL_RATE = 10; // tokens per second

    // Heartbeat configuration
    this.HEARTBEAT_INTERVAL = 30000; // 30 seconds
  }

  attach(server) {
    this.wss = new WebSocket.Server({ noServer: true });

    // Handle HTTP Upgrade manually for authentication and routing
    server.on('upgrade', async (request, socket, head) => {
      const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`);
      
      if (pathname === '/pos-sync') {
        const licenseKey = searchParams.get('license_key');
        const deviceId = searchParams.get('device_id');

        if (!licenseKey || !deviceId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        try {
          // Authenticate and get restaurant_id
          const { resolvePoolForLicense } = require('../config/db');
          const authResult = await resolvePoolForLicense(licenseKey);
          
          if (!authResult || authResult.status === 'invalid') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }

          const restaurantId = authResult.restaurantId;

          // Prevent wildly excessive connections from a single tenant
          const currentCount = this.tenantSockets.get(restaurantId)?.size || 0;
          if (currentCount > 50) { // Sane cap per restaurant
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            socket.destroy();
            return;
          }

          this.wss.handleUpgrade(request, socket, head, (ws) => {
            const hostname = searchParams.get('hostname') || 'Unknown';
            this.wss.emit('connection', ws, request, restaurantId, deviceId, hostname);
          });
        } catch (err) {
          console.error('[WebSocket] Upgrade error:', err);
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        }
      }
    });

    this.wss.on('connection', (ws, request, restaurantId, deviceId, hostname) => {
      // Store context explicitly on the socket (prevent spoofing)
      ws.restaurantId = restaurantId;
      ws.deviceId = deviceId;
      ws.hostname = hostname || 'Unknown';
      ws.isAlive = true;
      ws.tokens = this.RATE_LIMIT_TOKENS;
      ws.lastTokenRefill = Date.now();

      // Add to tenant Set
      if (!this.tenantSockets.has(restaurantId)) {
        this.tenantSockets.set(restaurantId, new Set());
      }
      this.tenantSockets.get(restaurantId).add(ws);

      logger.client(`Device ${deviceId} connected to Restaurant ${restaurantId}`);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (message) => {
        // Enforce rate limit
        const now = Date.now();
        const elapsed = (now - ws.lastTokenRefill) / 1000;
        ws.tokens = Math.min(this.RATE_LIMIT_TOKENS, ws.tokens + elapsed * this.RATE_LIMIT_REFILL_RATE);
        ws.lastTokenRefill = now;

        if (ws.tokens < 1) {
          console.warn(`[WebSocket] Device ${ws.deviceId} rate-limited.`);
          return; // Drop excess messages
        }
        ws.tokens -= 1;

        try {
          const data = JSON.parse(message);

          if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (data.type === 'sync_push' && data.data) {
            // Real-time sync push from a device — merge into MySQL and broadcast
            this._handleSyncPush(ws, data.data);
          }
        } catch (e) {
          // Ignore invalid JSON
        }
      });

      ws.on('close', () => {
        this._removeSocket(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WebSocket] Error from device ${ws.deviceId}:`, err.message);
        this._removeSocket(ws);
      });
    });

    // Start heartbeat interval
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  _removeSocket(ws) {
    if (ws.restaurantId) {
      const room = this.tenantSockets.get(ws.restaurantId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          this.tenantSockets.delete(ws.restaurantId);
        }
      }
    }
  }

  /**
   * Handle an incoming sync_push message from a device.
   * Merges the payload into MySQL and broadcasts to all other devices
   * in the same restaurant room.
   *
   * Security: Uses ws.restaurantId (set during handshake auth), NOT client-supplied data.
   */
  async _handleSyncPush(ws, payload) {
    const restaurantId = ws.restaurantId;
    const deviceId = ws.deviceId;

    if (!restaurantId || !payload || typeof payload !== 'object') return;

    try {
      const { mergeImportPayload } = require('../controllers/posController');
      const { asyncLocalStorage, mainPool } = require('../config/db');

      // Must run inside asyncLocalStorage context so the pool proxy sets
      // @current_restaurant_id before every query — without this the tenant
      // filter is missing and all inserts/updates go to the wrong scope.
      const result = await new Promise((resolve, reject) => {
        asyncLocalStorage.run({ pool: mainPool, restaurantId }, async () => {
          try {
            resolve(await mergeImportPayload(payload, deviceId, restaurantId));
          } catch (err) {
            reject(err);
          }
        });
      });

      if (result.success && result.processed > 0) {
        logger.success(`Device ${deviceId} pushed ${result.processed} changes via WebSocket`);
        // Broadcast to all other devices in this restaurant (exclude sender)
        this.broadcast(restaurantId, payload, deviceId);

        // V4 FIX: Acknowledge with change_ids for client deduplication
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'sync_ack', 
            processed: result.processed,
            change_ids: result.synced_change_ids || [], // Return change_ids
          }));
        }
      } else if (result.success) {
        // No changes (all data was up-to-date via HLC comparison)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'sync_ack', 
            processed: 0,
            change_ids: result.synced_change_ids || [],
          }));
        }
      }
    } catch (err) {
      logger.error(`Failed to process sync_push from ${deviceId}: ${err.message}`);
    }
  }

  /**
   * Broadcast a payload strictly to a specific restaurant.
   * @param {number} restaurantId - The strict tenant ID
   * @param {object} payload - The sync data payload
   * @param {string} excludeDeviceId - The device ID to skip (sender)
   */
  broadcast(restaurantId, payload, excludeDeviceId = null) {
    const room = this.tenantSockets.get(restaurantId);
    if (!room) return;

    const message = JSON.stringify({
      type: 'sync_push',
      data: payload
    });

    room.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN && ws.deviceId !== excludeDeviceId) {
        // Fire-and-forget, non-blocking send
        ws.send(message, (err) => {
          if (err) {
            console.error(`[WebSocket] Failed to push to ${ws.deviceId}:`, err.message);
          }
        });
      }
    });
  }

  /**
   * Get an array of currently connected devices for a specific restaurant.
   */
  getConnectedDevices(restaurantId) {
    const room = this.tenantSockets.get(restaurantId);
    if (!room) return [];

    const devicesMap = new Map();
    room.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        devicesMap.set(ws.deviceId, { deviceId: ws.deviceId, hostname: ws.hostname });
      }
    });
    return Array.from(devicesMap.values());
  }

  shutdown() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.wss) {
      this.wss.clients.forEach(ws => ws.terminate());
      this.wss.close();
    }
  }
}

const instance = new WebSocketBroadcaster();
module.exports = instance;
