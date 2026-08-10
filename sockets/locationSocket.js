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

function getConnectedDeviceCounts(restaurantId) {
  return activeDevices[restaurantId] || { rider: 0, pos: 0 };
}

module.exports = (io) => {
  // Expose getConnectedDeviceCounts as a static method on the exported function
  module.exports.getConnectedDeviceCounts = getConnectedDeviceCounts;

  // Handshake middleware to authenticate the license key first
  io.use(async (socket, next) => {
    const licenseKey = socket.handshake.query.licenseKey || socket.handshake.headers['x-license-key'];
    if (!licenseKey) {
      return next(new Error('Authentication error: licenseKey query parameter or x-license-key header is required.'));
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

    // Immediately authorize and join rider to their room if query params are present in the handshake
    const { token, riderId } = socket.handshake.query;
    if (token && riderId) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'rider' && String(decoded.id) === String(riderId)) {
          socket.riderId = decoded.id;
          socket.role = 'rider';
          socket.username = decoded.username;

          // Join tenant-scoped rider rooms instantly on handshake
          socket.join(`rider:${socket.licenseKey}:${decoded.id}`);
          socket.join(`riders:${socket.licenseKey}`);
          socket.join(`rider_${decoded.id}`);

          console.log(`[Handshake Auth] Rider ${decoded.id} instantly joined tenant ${socket.licenseKey} rooms.`);

          // Update database session state asynchronously in tenant context
          asyncLocalStorage.run(
            { pool, licenseKey: socket.licenseKey, restaurantId: socket.restaurantId },
            async () => {
              try {
                await pool.query(
                  'INSERT INTO rider_sessions (rider_id, socket_id, connected_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE socket_id = VALUES(socket_id), connected_at = NOW()',
                  [decoded.id, socket.id]
                );
                await pool.query('UPDATE riders SET status = ? WHERE id = ? AND status = ?', ['idle', decoded.id, 'offline']);
                socket.emit('connected:confirmed', { success: true, role: 'rider' });
                io.to(`admin:${socket.licenseKey}`).emit('rider:online', { riderId: decoded.id });
                io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId: decoded.id, status: 'idle' });
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

    // Rider Authentication
    // FIX (Bug #16): If the rider was already authenticated during the handshake
    // (token + riderId query params), skip the full re-auth flow to avoid duplicate
    // session inserts and double rider:online emissions to admins.
    socket.on('rider:connect', runInContext(async (payload) => {
      const { token } = payload || {};
      if (!token) {
        return socket.emit('auth:error', { error: 'No token provided.' });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'rider') {
          return socket.emit('auth:error', { error: 'Unauthorized role.' });
        }

        const riderId = decoded.id;

        // If already authenticated via handshake for the same rider, only update
        // the FCM token if provided and confirm — skip duplicate DB writes.
        if (socket.riderId && String(socket.riderId) === String(riderId)) {
          if (payload.fcmToken) {
            try {
              await pool.query('UPDATE _riders_base SET fcm_token = ? WHERE id = ?', [payload.fcmToken, riderId]);
            } catch (colErr) {
              await pool.query('ALTER TABLE _riders_base ADD COLUMN fcm_token VARCHAR(255) DEFAULT NULL').catch(() => {});
              await pool.query('UPDATE _riders_base SET fcm_token = ? WHERE id = ?', [payload.fcmToken, riderId]).catch(() => {});
            }
          }
          socket.emit('connected:confirmed', { success: true, role: 'rider' });
          console.log(`Rider ${riderId} re-confirmed via rider:connect (already authenticated via handshake).`);
          return;
        }

        // Check if rider is active
        const [riders] = await pool.query('SELECT is_active FROM riders WHERE id = ?', [riderId]);
        if (riders.length === 0 || !riders[0].is_active) {
          return socket.emit('auth:error', { error: 'Rider deactivated or not found.' });
        }

        // Store state on socket object
        socket.riderId = riderId;
        socket.role = 'rider';
        socket.username = decoded.username;

        // Join tenant-scoped rider rooms
        socket.join(`rider:${socket.licenseKey}:${riderId}`);
        socket.join(`riders:${socket.licenseKey}`);

        // Save session in DB
        await pool.query(
          'INSERT INTO rider_sessions (rider_id, socket_id, connected_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE socket_id = VALUES(socket_id), connected_at = NOW()',
          [riderId, socket.id]
        );

        if (payload.fcmToken) {
          try {
            await pool.query('UPDATE _riders_base SET fcm_token = ? WHERE id = ?', [payload.fcmToken, riderId]);
          } catch (colErr) {
            // Self-healing: if column is missing on existing running DB, add it dynamically
            await pool.query('ALTER TABLE _riders_base ADD COLUMN fcm_token VARCHAR(255) DEFAULT NULL').catch(() => {});
            await pool.query('UPDATE _riders_base SET fcm_token = ? WHERE id = ?', [payload.fcmToken, riderId]).catch(() => {});
          }
        }

        // Update status to idle if offline
        await pool.query('UPDATE riders SET status = ? WHERE id = ? AND status = ?', ['idle', riderId, 'offline']);

        // Confirm auth
        socket.emit('connected:confirmed', { success: true, role: 'rider' });

        // Notify admins of this tenant
        io.to(`admin:${socket.licenseKey}`).emit('rider:online', { riderId });
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });

        console.log(`Rider ${riderId} authenticated and joined tenant ${socket.licenseKey} rooms.`);
      } catch (err) {
        console.error('Socket auth error (rider):', err);
        socket.emit('auth:error', { error: 'Authentication failed.' });
      }
    }));

    // Admin Authentication
    socket.on('admin:connect', runInContext(async (payload) => {
      const { token } = payload || {};
      if (!token && socket.licenseKey) {
        // Authenticate via license key (e.g. from POS_win)
        socket.role = 'admin';
        socket.adminId = 'pos_client';
        socket.join(`admin:${socket.licenseKey}`);
        socket.emit('connected:confirmed', { success: true, role: 'admin' });

        // Emit riders:snapshot containing ALL riders' current location and status immediately
        const query = `
          SELECT r.id, r.username, r.full_name, r.phone, r.status, r.is_active,
                 l.latitude, l.longitude, l.speed, l.heading, l.accuracy, l.updated_at
          FROM riders r
          LEFT JOIN rider_latest_location l ON r.id = l.rider_id
        `;
        const [rows] = await pool.query(query);
        socket.emit('riders:snapshot', rows);

        console.log(`Admin authenticated via license key ${socket.licenseKey}, joined tenant admin room, and snapshot emitted.`);
        return;
      }
      if (!token) {
        return socket.emit('auth:error', { error: 'No token provided.' });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
          return socket.emit('auth:error', { error: 'Unauthorized role.' });
        }

        socket.role = 'admin';
        socket.adminId = decoded.id;

        // Join tenant-scoped admin room
        socket.join(`admin:${socket.licenseKey}`);

        // Confirm auth
        socket.emit('connected:confirmed', { success: true, role: 'admin' });

        // Emit riders:snapshot containing ALL riders' current location and status immediately
        const query = `
          SELECT r.id, r.username, r.full_name, r.phone, r.status, r.is_active,
                 l.latitude, l.longitude, l.speed, l.heading, l.accuracy, l.updated_at
          FROM riders r
          LEFT JOIN rider_latest_location l ON r.id = l.rider_id
        `;
        const [rows] = await pool.query(query);
        socket.emit('riders:snapshot', rows);

        console.log(`Admin ${decoded.id} authenticated, joined tenant ${socket.licenseKey} admin room, and snapshot emitted.`);
      } catch (err) {
        console.error('Socket auth error (admin):', err);
        socket.emit('auth:error', { error: 'Authentication failed.' });
      }
    }));

    // POS Terminal Authentication
    socket.on('pos:connect', runInContext(async (payload) => {
      const { token, clientId } = payload || {};
      if (!token && socket.licenseKey) {
        socket.role = 'pos_client';
        socket.clientId = clientId || 'unknown';
        socket.join(`pos_clients:${socket.licenseKey}`);
        socket.emit('connected:confirmed', { success: true, role: 'pos_client' });
        console.log(`POS Client authenticated via license key ${socket.licenseKey} (clientId: ${clientId}) and joined tenant room.`);
        return;
      }
      if (!token) {
        return socket.emit('auth:error', { error: 'No token provided.' });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
          return socket.emit('auth:error', { error: 'Unauthorized role. Admin/Manager token required.' });
        }

        socket.role = 'pos_client';
        socket.clientId = clientId || 'unknown';
        socket.join(`pos_clients:${socket.licenseKey}`);

        // Confirm auth
        socket.emit('connected:confirmed', { success: true, role: 'pos_client' });
        console.log(`POS Client authenticated (clientId: ${clientId}) and joined tenant ${socket.licenseKey} room.`);
      } catch (err) {
        console.error('Socket auth error (pos):', err);
        socket.emit('auth:error', { error: 'Authentication failed.' });
      }
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

      // 3. Broadcast real-time update to all tenant admins
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

              // Broadcast update to riders
              if (updatedTask.rider_id) {
                // If a rider is already assigned, send to that rider
                io.to(`rider:${socket.licenseKey}:${updatedTask.rider_id}`).emit('task:new', updatedTask);
              } else {
                // Otherwise broadcast to all riders
                io.to(`riders:${socket.licenseKey}`).emit('task:available', updatedTask);
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
      if (socket.role !== 'rider' || !socket.riderId) {
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
        // Case 2: Task is unassigned (pending, cooking, processing, or ready) and can be claimed by any available rider
        else if (task.rider_id === null && ['pending', 'cooking', 'processing', 'ready'].includes(task.status)) {
          let targetStatus = 'accepted';
          if (task.status === 'cooking' || task.status === 'processing') {
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
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
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
        io.to(`admin:${socket.licenseKey}`).emit('rider:status:update', { riderId, status: 'idle' });
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
        // Verify rider
        const [riderRows] = await pool.query('SELECT is_active FROM riders WHERE id = ?', [riderId]);
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

        // Notify rider via Socket.IO
        io.to(`rider:${socket.licenseKey}:${riderId}`).emit('task:new', task);

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
