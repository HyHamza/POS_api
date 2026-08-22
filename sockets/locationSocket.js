const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { asyncLocalStorage, resolvePoolForLicense } = require('../config/db');
const { sendTaskNotification } = require('../utils/notifications');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

// In-memory active device tracking
const activeDevices = {
  // restaurantId: { rider: 0, pos: 0 }
};

// In-memory rate limiting map for location writes: Map<riderId, lastWriteTimestampMs>
const lastLocationWriteTimes = new Map();
const LOCATION_WRITE_MIN_INTERVAL_MS = 2500; // max 1 DB write per 2.5s per rider

function getConnectedDeviceCounts(restaurantId) {
  return activeDevices[restaurantId] || { rider: 0, pos: 0 };
}

async function isRiderClockedIn(riderId, restaurantId) {
  try {
    if (!riderId || !restaurantId) return false;

    // Strict check: Open attendance record in _pos_attendance_base
    const [rows] = await pool.query(
      `SELECT a.id, a.clock_in FROM _pos_attendance_base a
       LEFT JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
       LEFT JOIN _riders_base r ON (s.username = r.username OR a.staff_id = r.id) AND r.restaurant_id = a.restaurant_id
       WHERE a.restaurant_id = ?
         AND a.clock_out IS NULL
         AND (a.is_deleted IS NULL OR a.is_deleted = 0)
         AND (r.id = ? OR a.staff_id = ?)
       LIMIT 1`,
      [restaurantId, riderId, riderId]
    );

    return rows.length > 0;
  } catch (err) {
    console.error('[isRiderClockedIn Error]', err);
    return false;
  }
}

module.exports = (io) => {
  // Expose getConnectedDeviceCounts and isRiderClockedIn
  module.exports.getConnectedDeviceCounts = getConnectedDeviceCounts;
  module.exports.isRiderClockedIn = isRiderClockedIn;

  // Handshake middleware to authenticate the license key first
  io.use(async (socket, next) => {
    let licenseKey = socket.handshake.auth?.licenseKey || socket.handshake.query?.licenseKey || socket.handshake.headers?.['x-license-key'];
    if (!licenseKey && socket.handshake.headers?.cookie) {
      const cookies = socket.handshake.headers.cookie.split(';').map(c => c.trim());
      for (const c of cookies) {
        if (c.startsWith('pos_license_key=')) {
          licenseKey = decodeURIComponent(c.substring('pos_license_key='.length));
          break;
        }
      }
    }
    if (!licenseKey) {
      return next(new Error('Authentication error: licenseKey query parameter, auth payload, cookie or x-license-key header is required.'));
    }
    try {
      const result = await resolvePoolForLicense(licenseKey);
      if (!result || result.status === 'invalid') {
        return next(new Error('Authentication error: Invalid restaurant license key.'));
      }
      socket.licenseKey = licenseKey;
      socket.restaurantId = result.restaurantId;
      socket.licenseStatus = result.status;
      socket.licenseExpiresAt = result.expiresAt;
      socket.licensePlanType = result.planType;
      next();
    } catch (err) {
      console.error('[Socket IO Middleware] Error resolving license:', err);
      next(new Error('Authentication error: Internal database resolution error.'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id} (License: ${socket.licenseKey})`);

    // Automatically join the socket to tenant rooms
    socket.join(`pos_clients:${socket.licenseKey}`);
    socket.join(`admin:${socket.licenseKey}`);

    // Track device connection
    const deviceType = socket.handshake.query.deviceType === 'rider' ? 'rider' : 'pos';
    socket.deviceType = deviceType;
    if (socket.restaurantId) {
      if (!activeDevices[socket.restaurantId]) activeDevices[socket.restaurantId] = { rider: 0, pos: 0 };
      activeDevices[socket.restaurantId][deviceType]++;
    }

    // Immediately authorize and configure rider rooms if query params are present in the handshake
    const { token, riderId } = socket.handshake.query;
    if (token && riderId) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'rider' && String(decoded.id) === String(riderId)) {
          socket.riderId = decoded.id;
          socket.role = 'rider';
          socket.username = decoded.username;

          // Check if rider is clocked in before joining active dispatch rooms
          asyncLocalStorage.run(
            { pool, licenseKey: socket.licenseKey, restaurantId: socket.restaurantId },
            async () => {
              try {
                const isOnDuty = await isRiderClockedIn(decoded.id, socket.restaurantId);
                socket.isOnDuty = isOnDuty;

                if (isOnDuty) {
                  socket.join(`rider:${socket.licenseKey}:${decoded.id}`);
                  socket.join(`riders:${socket.licenseKey}`);
                  socket.join(`rider_${decoded.id}`);
                  console.log(`[Handshake Auth] Rider ${decoded.id} (ON DUTY) joined tenant ${socket.licenseKey} dispatch rooms.`);
                } else {
                  console.log(`[Handshake Auth] Rider ${decoded.id} (OFF DUTY) connected — dispatch rooms suppressed until clock-in.`);
                }

                await pool.query(
                  'INSERT INTO rider_sessions (rider_id, socket_id, connected_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE socket_id = VALUES(socket_id), connected_at = NOW()',
                  [decoded.id, socket.id]
                );
                const riderStatus = isOnDuty ? 'idle' : 'offline';
                await pool.query('UPDATE riders SET status = ? WHERE id = ?', [riderStatus, decoded.id]);
                socket.emit('connected:confirmed', { success: true, role: 'rider', isOnDuty });
                io.to(`admin:${socket.licenseKey}`).emit('rider:online', { riderId: decoded.id });
                io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId: decoded.id, status: riderStatus });
              } catch (dbErr) {
                console.error('[Handshake Auth DB Error]', dbErr);
              }
            }
          );
        }
      } catch (err) {
        console.error('[Handshake Auth Token Verification Failed]', err.message);
      }
    }

    // Always emit the license status upon connection to sync client state
    if (socket.licenseStatus) {
      console.log(`[Socket Connection] Syncing license status (${socket.licenseStatus}) with socket ${socket.id}. Emitting license:status...`);
      socket.emit('license:status', {
        status: socket.licenseStatus,
        licenseStatus: socket.licenseStatus,
        expiresAt: socket.licenseExpiresAt,
        planType: socket.licensePlanType
      });
    }

    // Helper wrapper to run handlers in tenant context
    const runInContext = (handler) => {
      return (...args) => {
        asyncLocalStorage.run(
          { pool, licenseKey: socket.licenseKey, restaurantId: socket.restaurantId },
          async () => {
            try {
              await handler(...args);
            } catch (err) {
              console.error(`Error in socket event handler:`, err);
            }
          }
        );
      };
    };

    // Rider Authentication via message
    socket.on('rider:connect', runInContext(async (payload) => {
      const { token } = payload || {};

      try {
        let riderId = null;
        let username = 'rider';

        if (token) {
          try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.role === 'rider') {
              riderId = decoded.id;
              username = decoded.username || username;
            }
          } catch (jwtErr) {
            console.warn('[Socket Auth] Rider JWT verification failed, falling back to license key context:', jwtErr.message);
          }
        }

        if (socket.riderId) {
          riderId = socket.riderId;
        }

        if (riderId) {
          socket.riderId = riderId;
          socket.role = 'rider';
          socket.username = username;

          const isOnDuty = await isRiderClockedIn(riderId, socket.restaurantId);
          socket.isOnDuty = isOnDuty;

          if (isOnDuty) {
            socket.join(`rider:${socket.licenseKey}:${riderId}`);
            socket.join(`riders:${socket.licenseKey}`);
            socket.join(`rider_${riderId}`);
          } else {
            socket.leave(`rider:${socket.licenseKey}:${riderId}`);
            socket.leave(`riders:${socket.licenseKey}`);
            socket.leave(`rider_${riderId}`);
          }

          if (payload.fcmToken) {
            try {
              await pool.query('UPDATE _riders_base SET fcm_token = ? WHERE id = ?', [payload.fcmToken, riderId]);
            } catch (_) {}
          }

          socket.emit('connected:confirmed', { success: true, role: 'rider', isOnDuty });
          io.to(`admin:${socket.licenseKey}`).emit('rider:online', { riderId });
          console.log(`Rider ${riderId} connected (isOnDuty: ${isOnDuty}).`);
          return;
        }

        // Fallback for tenant clients
        if (socket.licenseKey) {
          socket.role = 'pos_client';
          socket.join(`pos_clients:${socket.licenseKey}`);
          socket.emit('connected:confirmed', { success: true, role: 'pos_client' });
          console.log(`Client authenticated via licenseKey ${socket.licenseKey}`);
          return;
        }

        socket.emit('auth:error', { error: 'Authentication failed.' });
      } catch (err) {
        console.error('Socket auth error (rider):', err);
        socket.emit('auth:error', { error: 'Authentication failed.' });
      }
    }));

    // Dynamic Clock-In / Duty status change over Socket
    socket.on('rider:duty:change', runInContext(async (payload) => {
      if (socket.role !== 'rider' || !socket.riderId) return;
      const { isClockedIn } = payload || {};
      socket.isOnDuty = !!isClockedIn;

      if (socket.isOnDuty) {
        socket.join(`rider:${socket.licenseKey}:${socket.riderId}`);
        socket.join(`riders:${socket.licenseKey}`);
        socket.join(`rider_${socket.riderId}`);
        await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['idle', socket.riderId]);
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId: socket.riderId, status: 'idle' });
        console.log(`[Socket Duty] Rider ${socket.riderId} joined active dispatch rooms (ON DUTY).`);
      } else {
        socket.leave(`rider:${socket.licenseKey}:${socket.riderId}`);
        socket.leave(`riders:${socket.licenseKey}`);
        socket.leave(`rider_${socket.riderId}`);
        await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['offline', socket.riderId]);
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId: socket.riderId, status: 'offline' });
        console.log(`[Socket Duty] Rider ${socket.riderId} left active dispatch rooms (OFF DUTY).`);
      }
      socket.emit('rider:duty:confirmed', { isClockedIn: socket.isOnDuty });
    }));

    // Admin Authentication
    socket.on('admin:connect', runInContext(async (payload) => {
      const { token } = payload || {};

      if (socket.licenseKey) {
        socket.role = 'admin';
        socket.adminId = 'pos_client';
        socket.join(`admin:${socket.licenseKey}`);
        socket.emit('connected:confirmed', { success: true, role: 'admin' });

        try {
          const query = `
            SELECT r.id, r.username, r.full_name, r.phone, r.status, r.is_active,
                   l.latitude, l.longitude, l.speed, l.heading, l.accuracy, l.updated_at
            FROM riders r
            LEFT JOIN rider_latest_location l ON r.id = l.rider_id
          `;
          const [rows] = await pool.query(query);
          socket.emit('riders:snapshot', rows);
        } catch (_) {}

        console.log(`Admin authenticated via license key ${socket.licenseKey}, joined tenant admin room.`);
        return;
      }

      if (!token) {
        return socket.emit('auth:error', { error: 'No token provided.' });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.role = 'admin';
        socket.adminId = decoded.id;

        socket.join(`admin:${socket.licenseKey}`);
        socket.emit('connected:confirmed', { success: true, role: 'admin' });
      } catch (err) {
        console.error('Socket auth error (admin):', err);
        socket.emit('auth:error', { error: 'Authentication failed.' });
      }
    }));

    // POS Terminal Authentication
    socket.on('pos:connect', runInContext(async (payload) => {
      const { clientId } = payload || {};

      if (socket.licenseKey) {
        socket.role = 'pos_client';
        socket.clientId = clientId || 'unknown';
        socket.join(`pos_clients:${socket.licenseKey}`);
        socket.join(`admin:${socket.licenseKey}`);
        socket.emit('connected:confirmed', { success: true, role: 'pos_client' });
        console.log(`POS Client authenticated via license key ${socket.licenseKey} (clientId: ${clientId}).`);
        return;
      }

      socket.emit('auth:error', { error: 'No license key provided.' });
    }));

    // Rider Location Update
    socket.on('rider:location', runInContext(async (payload) => {
      if (socket.role !== 'rider' || !socket.riderId) {
        return socket.emit('auth:error', { error: 'Unauthenticated.' });
      }

      const { lat, lng, speed, heading, accuracy } = payload || {};
      if (lat === undefined || lng === undefined) {
        return;
      }

      const riderId = socket.riderId;
      const timestamp = new Date();
      const nowMs = Date.now();
      const lastWriteMs = lastLocationWriteTimes.get(riderId) || 0;

      // Rate limit high-write DB operations (at most 1 write per 2.5s per rider)
      if (nowMs - lastWriteMs >= LOCATION_WRITE_MIN_INTERVAL_MS) {
        lastLocationWriteTimes.set(riderId, nowMs);

        // NON-BLOCKING database writes (do not await, catch errors)
        // 1. Upsert into latest location cache table
        pool.query(
          `INSERT INTO rider_latest_location (rider_id, latitude, longitude, speed, heading, accuracy, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(3))
           ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude),
           speed=VALUES(speed), heading=VALUES(heading), accuracy=VALUES(accuracy), updated_at=NOW(3)`,
          [riderId, lat, lng, speed || 0, heading || 0, accuracy || 0]
        ).catch(err => console.error('Rider location upsert error:', err));

        // 2. Insert into high-write location history log
        pool.query(
          `INSERT INTO rider_locations (rider_id, latitude, longitude, speed, heading, accuracy, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
          [riderId, lat, lng, speed || 0, heading || 0, accuracy || 0]
        ).catch(err => console.error('Rider location history log error:', err));
      }

      // 3. Broadcast real-time update immediately to all tenant admins
      io.to(`admin:${socket.licenseKey}`).emit('rider:location:update', {
        riderId,
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        accuracy: accuracy || 0,
        timestamp: timestamp.toISOString()
      });
    }));

    // Rider Status Update
    socket.on('rider:status', runInContext(async (payload) => {
      if (socket.role !== 'rider' || !socket.riderId) {
        return socket.emit('auth:error', { error: 'Unauthenticated.' });
      }

      const { status } = payload || {};
      const validStatuses = ['idle', 'delivering'];
      if (!status || !validStatuses.includes(status)) {
        return;
      }

      const riderId = socket.riderId;

      try {
        await pool.query('UPDATE riders SET status = ? WHERE id = ?', [status, riderId]);
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status });
        console.log(`Rider ${riderId} updated status to ${status}`);
      } catch (err) {
        console.error('Rider status update DB error:', err);
      }
    }));

    // KDS Status Change (relayed from POS client)
    socket.on('kds:statusChange', runInContext(async (payload) => {
      const { order_number, status } = payload || {};
      if (!order_number || !status) return;

      console.log(`[KDS Status Change] Order ${order_number} status updated to: ${status}`);

      let taskStatus = null;
      if (status === 'pending') {
        taskStatus = 'cooking';
      } else if (status === 'preparing') {
        taskStatus = 'processing';
      } else if (status === 'ready') {
        taskStatus = 'ready';
      } else if (status === 'delivering') {
        taskStatus = 'delivering';
      } else if (status === 'completed') {
        taskStatus = 'delivered';
      } else if (status === 'cancelled') {
        taskStatus = 'cancelled';
      }

      if (taskStatus) {
        try {
          // Find the task for this order_number
          const [tasks] = await pool.query('SELECT * FROM tasks WHERE order_number = ?', [order_number]);
          if (tasks.length > 0) {
            const task = tasks[0];
            
            const isFinalState = ['delivered', 'cancelled'].includes(task.status);

            // Only update if status is different and not in final states
            if (task.status !== taskStatus && !isFinalState) {
              await pool.query('UPDATE tasks SET status = ? WHERE id = ?', [taskStatus, task.id]);
              
              if (taskStatus === 'delivered') {
                await pool.query('UPDATE tasks SET delivered_at = NOW() WHERE id = ?', [task.id]);
                if (task.rider_id) {
                  await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['idle', task.rider_id]);
                }
              }

              // Fetch updated task
              const [updated] = await pool.query(
                'SELECT t.*, r.full_name as rider_name FROM tasks t LEFT JOIN riders r ON t.rider_id = r.id WHERE t.id = ?',
                [task.id]
              );
              const updatedTask = updated[0];

              // Broadcast task status update to all admins
              io.to(`admin:${socket.licenseKey}`).emit('task:status:update', updatedTask);

              // Broadcast update to riders using task:updated for consistency
              if (updatedTask.rider_id) {
                // If a rider is already assigned, send to that rider
                io.to(`rider:${socket.licenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
                console.log(`[KDS Status Change] Sent task:updated to rider:${socket.licenseKey}:${updatedTask.rider_id} for task ${updatedTask.id}`);
              } else {
                // Otherwise broadcast to all riders
                io.to(`riders:${socket.licenseKey}`).emit('task:updated', updatedTask);
                console.log(`[KDS Status Change] Broadcasted task:updated to riders:${socket.licenseKey} for task ${updatedTask.id}`);
              }

              // Send push notification trigger
              if (taskStatus === 'ready') {
                if (updatedTask.rider_id) {
                  sendTaskNotification(updatedTask.rider_id, {
                    ...updatedTask,
                    notification_title: "Food is Ready! 🍕",
                    notification_body: `Order #${updatedTask.id} is ready for pickup! Please proceed to the kitchen.`
                  }).catch(err => console.error('Notification error:', err));
                } else {
                  // Broadcast notification to all active riders of this restaurant
                  const [activeRiders] = await pool.query('SELECT id FROM _riders_base WHERE restaurant_id = ? AND is_active = 1 AND fcm_token IS NOT NULL', [updatedTask.restaurant_id]);
                  for (const rider of activeRiders) {
                    sendTaskNotification(rider.id, {
                      ...updatedTask,
                      notification_title: "New Delivery Ready! 🍕",
                      notification_body: `Order #${updatedTask.id} is ready for pickup! Claim it now.`
                    }).catch(err => console.error('Notification error:', err));
                  }
                }
              } else if (taskStatus === 'cooking') {
                if (updatedTask.rider_id) {
                  sendTaskNotification(updatedTask.rider_id, {
                    ...updatedTask,
                    notification_title: "New Order Cooking 🍳",
                    notification_body: `Order #${updatedTask.id} is being prepared in the kitchen.`
                  }).catch(err => console.error('Notification error:', err));
                }
              }
            }
          }
        } catch (err) {
          console.error('[KDS Status Change] Error updating task status:', err);
        }
      }
    }));

    // Rider Accepts Task
    socket.on('rider:task:accept', runInContext(async (payload) => {
      const normalizedRole = (socket.role || '').toLowerCase();
      if (normalizedRole !== 'rider' || !socket.riderId) {
        return socket.emit('auth:error', { error: 'Unauthenticated.' });
      }

      const { taskId } = payload || {};
      const riderId = socket.riderId;

      try {
        const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
        if (taskRows.length === 0) {
          return socket.emit('task:accept:error', { taskId, error: 'Task not found.' });
        }

        const task = taskRows[0];

        // Case 1: Task was assigned specifically to this rider
        if (task.rider_id === riderId && task.status === 'assigned') {
          await pool.query('UPDATE tasks SET status = ?, accepted_at = NOW() WHERE id = ?', ['accepted', taskId]);
          await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['idle', riderId]);
        }
        // Case 2: Task is unassigned and can be claimed by any available rider
        else if (task.rider_id === null && ['pending', 'cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched', 'ready'].includes(task.status)) {
          let targetStatus = 'accepted';
          if (['cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched'].includes(task.status)) {
            targetStatus = task.status;
          }

          // Attempt atomic claiming
          const [result] = await pool.query(
            'UPDATE tasks SET rider_id = ?, status = ?, assigned_at = NOW(), accepted_at = NOW() WHERE id = ? AND rider_id IS NULL AND status = ?',
            [riderId, targetStatus, taskId, task.status]
          );

          if (result.affectedRows === 0) {
            // Claiming failed because another rider claimed it first
            return socket.emit('task:accept:error', { taskId, error: 'This task has already been accepted by another rider.' });
          }

          // Claiming succeeded! Notify other riders that this task is no longer available
          io.to(`riders:${socket.licenseKey}`).emit('task:claimed', { taskId, riderId });
          console.log(`[Rider API] Broadcasted socket event 'task:claimed' for Task ID: ${taskId} by Rider ID: ${riderId}`);
          await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['idle', riderId]);
        }
        // Case 3: Task is already accepted by someone else, or is in an invalid state
        else {
          return socket.emit('task:accept:error', { taskId, error: 'This task has already been accepted by another rider.' });
        }

        const [updatedRows] = await pool.query(
          'SELECT t.*, r.full_name as rider_name FROM tasks t LEFT JOIN riders r ON t.rider_id = r.id WHERE t.id = ?',
          [taskId]
        );

        // Sync order status/rider info
        if (updatedRows[0].order_number) {
          const { syncOrderStatusWithTask } = require('../controllers/taskController');
          await syncOrderStatusWithTask(pool, updatedRows[0].restaurant_id, updatedRows[0].order_number, updatedRows[0].status, socket.licenseKey, io);
        }

        io.to(`admin:${socket.licenseKey}`).emit('task:status:update', updatedRows[0]);
        io.to(`pos_clients:${socket.licenseKey}`).emit('task:status:update', updatedRows[0]);
        io.to(`riders:${socket.licenseKey}`).emit('task:claimed', { taskId, riderId, task: updatedRows[0] });
        io.to(`admin:${socket.licenseKey}`).emit('task:claimed', { taskId, riderId, task: updatedRows[0] });
        io.to(`pos_clients:${socket.licenseKey}`).emit('task:claimed', { taskId, riderId, task: updatedRows[0] });
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
        io.to(`pos_clients:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
        socket.emit('task:accept:success', { taskId, task: updatedRows[0] });

        console.log(`Rider ${riderId} accepted task ${taskId}`);
      } catch (err) {
        console.error('Rider task accept DB error:', err);
        socket.emit('task:accept:error', { taskId, error: 'An error occurred while accepting the task.' });
      }
    }));

    // Rider Completes Task (Delivered)
    socket.on('rider:task:delivered', runInContext(async (payload) => {
      if (socket.role !== 'rider' || !socket.riderId) {
        return socket.emit('auth:error', { error: 'Unauthenticated.' });
      }

      const { taskId } = payload || {};
      const riderId = socket.riderId;

      try {
        const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
        if (taskRows.length === 0 || taskRows[0].rider_id !== riderId) {
          return;
        }

        // Complete task and reset rider status to idle
        await pool.query('UPDATE tasks SET status = ?, delivered_at = NOW() WHERE id = ?', ['delivered', taskId]);
        await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['idle', riderId]);

        // Sync order status
        if (taskRows[0].order_number) {
          const { syncOrderStatusWithTask } = require('../controllers/taskController');
          await syncOrderStatusWithTask(pool, taskRows[0].restaurant_id, taskRows[0].order_number, 'delivered', socket.licenseKey, io);
        }

        const [updatedRows] = await pool.query(
          'SELECT t.*, r.full_name as rider_name FROM tasks t LEFT JOIN riders r ON t.rider_id = r.id WHERE t.id = ?',
          [taskId]
        );

        io.to(`admin:${socket.licenseKey}`).emit('task:status:update', updatedRows[0]);
        io.to(`pos_clients:${socket.licenseKey}`).emit('task:status:update', updatedRows[0]);
        io.to(`riders:${socket.licenseKey}`).emit('task:updated', updatedRows[0]);
        io.to(`pos_clients:${socket.licenseKey}`).emit('task:updated', updatedRows[0]);
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
        io.to(`pos_clients:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
        console.log(`Rider ${riderId} completed delivery for task ${taskId}`);
      } catch (err) {
        console.error('Rider task delivered DB error:', err);
      }
    }));

    // Admin Assigns Task
    socket.on('admin:task:assign', runInContext(async (payload) => {
      if (socket.role !== 'admin') {
        return socket.emit('auth:error', { error: 'Unauthorized.' });
      }

      const { taskId, riderId } = payload || {};
      if (!taskId || !riderId) {
        return;
      }

      try {
        // Verify rider — use _riders_base directly with restaurant_id
        const [riderRows] = await pool.query(
          'SELECT is_active FROM _riders_base WHERE id = ? AND restaurant_id = ?',
          [riderId, socket.restaurantId]
        );
        if (riderRows.length === 0 || !riderRows[0].is_active) {
          return socket.emit('error', { message: 'Rider is deactivated or does not exist.' });
        }

        // Update task
        await pool.query(
          'UPDATE tasks SET rider_id = ?, status = ?, assigned_at = NOW() WHERE id = ?',
          [riderId, 'assigned', taskId]
        );

        // Fetch task details
        const [taskRows] = await pool.query(
          'SELECT t.*, r.full_name as rider_name FROM tasks t LEFT JOIN riders r ON t.rider_id = r.id WHERE t.id = ?',
          [taskId]
        );

        const task = taskRows[0];

        // Sync order status/rider info
        if (task.order_number) {
          const { syncOrderStatusWithTask } = require('../controllers/taskController');
          await syncOrderStatusWithTask(pool, task.restaurant_id, task.order_number, task.status, socket.licenseKey, io);
        }

        // Notify assigned rider via Socket.IO
        io.to(`rider:${socket.licenseKey}:${riderId}`).emit('task:new', task);
        io.to(`rider:${socket.licenseKey}:${riderId}`).emit('task:updated', task);

        // Notify all riders that task is assigned/claimed
        io.to(`riders:${socket.licenseKey}`).emit('task:claimed', { taskId: parseInt(taskId), riderId: parseInt(riderId) });
        io.to(`riders:${socket.licenseKey}`).emit('task:updated', task);

        // Broadcast task status update to all tenant admins
        io.to(`admin:${socket.licenseKey}`).emit('task:status:update', task);

        // Push notification trigger
        sendTaskNotification(riderId, task).catch(err => console.error('Notification error:', err));
        console.log(`Admin assigned task ${taskId} to Rider ${riderId} under tenant ${socket.licenseKey}`);
      } catch (err) {
        console.error('Admin task assignment error:', err);
      }
    }));

    // FIX (Bug #3): Merged the two duplicate 'disconnect' handlers into one.
    // The previous code registered two separate handlers — one wrapped in runInContext
    // for rider offline logic, and a second plain one for device count decrement.
    // Both fired on every disconnect, causing double logging and a race condition.
    // Now a single handler runs the device-count decrement synchronously first,
    // then delegates the async rider DB logic via runInContext.
    socket.on('disconnect', (...args) => {
      // Decrement active device count synchronously (no DB needed)
      if (socket.restaurantId && activeDevices[socket.restaurantId]) {
        activeDevices[socket.restaurantId][socket.deviceType] = Math.max(
          0,
          activeDevices[socket.restaurantId][socket.deviceType] - 1
        );
      }
      console.log(`Socket disconnected: ${socket.id}`);

      // Delegate async rider offline logic inside tenant context
      runInContext(async () => {
        if (socket.role === 'rider' && socket.riderId) {
          const riderId = socket.riderId;
          try {
            // Verify if session socket ID matches this socket ID before removing/marking offline.
            const [sessions] = await pool.query(
              'SELECT socket_id FROM rider_sessions WHERE rider_id = ?',
              [riderId]
            );

            if (sessions.length === 0 || sessions[0].socket_id !== socket.id) {
              console.log(`[Disconnect] Rider ${riderId} already reconnected on a new socket. Skipping offline mark.`);
              return;
            }

            // Check if the rider is currently clocked in (on duty) via POS attendance.
            const [attendanceRows] = await pool.query(
              `SELECT a.id FROM pos_attendance a
               JOIN pos_staff s ON a.staff_id = s.id
               JOIN riders r ON s.username = r.username
               WHERE r.id = ? AND a.date = CURDATE() AND a.clock_out IS NULL
               LIMIT 1`,
              [riderId]
            );

            const isOnDuty = attendanceRows.length > 0;

            if (isOnDuty) {
              await pool.query('DELETE FROM rider_sessions WHERE rider_id = ?', [riderId]);
              console.log(`[Disconnect] Rider ${riderId} is ON DUTY. Session cleared but status preserved.`);
            } else {
              await pool.query('UPDATE riders SET status = ? WHERE id = ?', ['offline', riderId]);
              await pool.query('DELETE FROM rider_sessions WHERE rider_id = ?', [riderId]);

              io.to(`admin:${socket.licenseKey}`).emit('rider:offline', { riderId });
              io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'offline' });
              console.log(`[Disconnect] Rider ${riderId} marked offline (not on duty).`);
            }
          } catch (err) {
            console.error('[Disconnect] Error handling rider socket disconnect:', err);
          }
        }
      })(...args);
    });
  });
};
