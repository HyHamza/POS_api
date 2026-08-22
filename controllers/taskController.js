const pool = require('../config/db');
const { sendTaskNotification } = require('../utils/notifications');

const getAllTasks = async (req, res) => {
  const { id, role } = req.user;
  const normalizedRole = (role || '').toLowerCase();
  const { from_date, to_date, rider_id } = req.query;

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage for admin queries
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId || req.user.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found.'
      });
    }

    let query;
    let params = [];

    if (normalizedRole === 'admin' || normalizedRole === 'superadmin') {
      query = `
        SELECT t.*, r.full_name as rider_name 
        FROM _tasks_base t 
        LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id
        WHERE t.restaurant_id = ?
      `;
      params.push(restaurantId);
      
      let conditions = [];
      if (rider_id) {
        conditions.push('t.rider_id = ?');
        params.push(rider_id);
      }
      if (from_date) {
        conditions.push('t.created_at >= ?');
        params.push(`${from_date} 00:00:00`);
      }
      if (to_date) {
        conditions.push('t.created_at <= ?');
        params.push(`${to_date} 23:59:59`);
      }
      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }
      query += ' ORDER BY t.created_at DESC';
    } else {
      // For riders: Return rider's own tasks AND unassigned active tasks so they can view and claim them
      query = `
        SELECT t.*, r.full_name as rider_name 
        FROM _tasks_base t 
        LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id
        WHERE t.restaurant_id = ? AND (t.rider_id = ? OR ((t.rider_id IS NULL OR t.rider_id = 0) AND t.status IN ('pending', 'cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched', 'ready', 'accepted'))) 
        ORDER BY t.created_at DESC
      `;
      params.push(restaurantId, id);
    }

    const [rows] = await pool.query(query, params);

    return res.json({
      success: true,
      data: rows,
      error: null
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const getTaskById = async (req, res) => {
  const { id } = req.params;
  const { id: userId, role } = req.user;
  const normalizedRole = (role || '').toLowerCase();

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId || req.user.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found.'
      });
    }

    const [rows] = await pool.query(
      `SELECT t.*, r.full_name as rider_name 
       FROM _tasks_base t 
       LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
       WHERE t.id = ? AND t.restaurant_id = ?`,
      [id, restaurantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Task not found.'
      });
    }

    const task = rows[0];

    // Authorize: Rider can only view their own tasks
    if (normalizedRole === 'rider' && task.rider_id !== userId) {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Access denied. You can only view your own tasks.'
      });
    }

    return res.json({
      success: true,
      data: task,
      error: null
    });
  } catch (error) {
    console.error('Error fetching task details:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const createTask = async (req, res) => {
  const {
    customer_name,
    customer_phone,
    delivery_address,
    delivery_lat,
    delivery_lng,
    order_details,
    rider_id,
    order_number
  } = req.body;

  if (!customer_name || !delivery_address) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Customer name and delivery address are required.'
    });
  }

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found. License key required.'
      });
    }

    let status = order_number ? 'cooking' : 'pending';
    let assignedAt = null;

    if (rider_id) {
      // Validate that the rider exists and is active FOR THIS TENANT
      const [riderRows] = await pool.query(
        'SELECT is_active FROM _riders_base WHERE id = ? AND restaurant_id = ?', 
        [rider_id, restaurantId]
      );
      if (riderRows.length === 0 || !riderRows[0].is_active) {
        return res.status(400).json({
          success: false,
          data: null,
          error: 'Assigned rider does not exist or is inactive.'
        });
      }
      status = 'assigned';
      assignedAt = new Date();
    }

    const [result] = await pool.query(
      `INSERT INTO _tasks_base (restaurant_id, rider_id, customer_name, customer_phone, delivery_address, delivery_lat, delivery_lng, order_details, status, assigned_at, order_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [restaurantId, rider_id || null, customer_name, customer_phone || null, delivery_address, delivery_lat || null, delivery_lng || null, order_details || null, status, assignedAt, order_number || null]
    );

    const taskId = result.insertId;

    // Fetch the created task
    const [taskRows] = await pool.query(
      `SELECT t.*, r.full_name as rider_name 
       FROM _tasks_base t 
       LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
       WHERE t.id = ? AND t.restaurant_id = ?`,
      [taskId, restaurantId]
    );
    const createdTask = taskRows[0];

    console.log(`[Rider API] Task successfully created. ID: ${taskId}, Status: ${status}, Rider ID: ${rider_id || 'None (Broadcasted)'}`);

    // Trigger Socket.IO and FCM
    const io = req.app.get('io');
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    const { isRiderDutyActive } = require('./authController');

    if (rider_id) {
      // Server-Side Duty Verification for specific rider
      const isClockedIn = await isRiderDutyActive(rider_id, restaurantId);

      if (isClockedIn) {
        if (io) {
          // Emit task:new to specific rider's room
          io.to(`rider:${licenseKey}:${rider_id}`).emit('task:new', createdTask);
          console.log(`[Rider API] Sent socket event 'task:new' to rider:${licenseKey}:${rider_id} for Task ID: ${taskId}`);
        }
        // Send background push notification alert
        sendTaskNotification(rider_id, createdTask)
          .then(() => console.log(`[Rider API] Push notification triggered for rider:${rider_id} on Task ID: ${taskId}`))
          .catch(err => console.error('Notification error:', err));
      } else {
        console.log(`[Rider API] Rider ${rider_id} is OFF DUTY (not clocked in). Suppressed task:new socket event and push notification.`);
      }
    } else {
      if (io) {
        // Broadcast task:available to all connected riders in the general room
        io.to(`riders:${licenseKey}`).emit('task:available', createdTask);
        console.log(`[Rider API] Broadcasted socket event 'task:available' to riders:${licenseKey} room for Task ID: ${taskId}`);
      }
      // Send background push notification only to active AND clocked-in riders of this restaurant
      pool.query(
        `SELECT r.id FROM _riders_base r
         WHERE r.restaurant_id = ? AND r.is_active = 1 AND r.fcm_token IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM _pos_attendance_base a
             WHERE a.restaurant_id = r.restaurant_id
               AND (a.staff_id = r.id OR a.staff_id IN (
                 SELECT s.id FROM _pos_staff_base s WHERE s.username = r.username AND s.restaurant_id = r.restaurant_id
               ))
               AND a.clock_out IS NULL
               AND (a.is_deleted IS NULL OR a.is_deleted = 0)
           )`,
        [restaurantId]
      )
        .then(([riders]) => {
          for (const r of riders) {
            sendTaskNotification(r.id, createdTask).catch(err => console.error('Notification error:', err));
          }
        })
        .catch(err => console.error('Error broadcasting push:', err));
    }

    return res.status(201).json({
      success: true,
      data: createdTask,
      error: null
    });
  } catch (error) {
    console.error('Error creating task:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const updateTaskStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { id: userId, role } = req.user;
  const normalizedRole = (role || '').toLowerCase();
  const isRider = normalizedRole === 'rider';
  const isAdmin = ['admin', 'superadmin', 'manager'].includes(normalizedRole);

  const validStatuses = ['pending', 'assigned', 'accepted', 'cooking', 'processing', 'ready', 'prepared', 'ready_for_dispatch', 'dispatched', 'delivering', 'delivered', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'Invalid or missing status.'
    });
  }

  try {
    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId || req.user.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found.'
      });
    }

    // Verify rider is authenticated
    if (isRider && !userId) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Rider authentication required.'
      });
    }

    // Fetch current task with restaurant_id filter
    const [rows] = await pool.query(
      'SELECT * FROM _tasks_base WHERE id = ? AND restaurant_id = ?', 
      [id, restaurantId]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Task not found.'
      });
    }

    const task = rows[0];
    let alreadyUpdated = false;

    // Guard: Riders cannot start delivery if the order has been cancelled or completed
    if (isRider && status === 'delivering') {
      if (['cancelled', 'delivered'].includes(task.status)) {
        return res.status(400).json({
          success: false,
          data: null,
          error: 'Cannot start delivery on cancelled or already delivered orders.'
        });
      }
    }

    // FIX (Bug #8): Move the 'cancelled' admin-only guard BEFORE the rider path so it
    // applies universally regardless of which branch executes below.
    if (status === 'cancelled' && !isAdmin) {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Access denied. Only administrators can cancel tasks.'
      });
    }

    // Role-based validation
    const isTaskUnassigned = (task.rider_id === null || task.rider_id === 0 || String(task.rider_id) === 'null' || !task.rider_id);
    const isTaskMine = (task.rider_id !== null && String(task.rider_id) === String(userId));

    if (isRider && !isTaskMine) {
      // Allow the rider to accept/claim the task if it is currently unassigned
      if (isTaskUnassigned && (status === 'accepted' || status === 'delivering')) {
        let targetStatus = 'accepted';
        if (['cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched'].includes(task.status)) {
          targetStatus = task.status;
        }

        // Attempt atomic claiming with restaurant_id filter
        const [result] = await pool.query(
          'UPDATE _tasks_base SET rider_id = ?, status = ?, assigned_at = NOW(), accepted_at = NOW() WHERE id = ? AND restaurant_id = ? AND (rider_id IS NULL OR rider_id = 0)',
          [userId, targetStatus, id, restaurantId]
        );
        if (result.affectedRows === 0) {
          return res.status(400).json({
            success: false,
            data: null,
            error: 'This task has already been accepted by another rider.'
          });
        }

        // Succeeded! Broadcast claim via Socket.IO so other riders clear it from their screens
        const io = req.app.get('io');
        const licenseKey = req.headers['x-license-key'] || req.query.license_key;
        if (io) {
          io.to(`riders:${licenseKey}`).emit('task:claimed', { taskId: parseInt(id), riderId: userId });
          console.log(`[Rider API] Broadcasted socket event 'task:claimed' for Task ID: ${id} by Rider ID: ${userId} in room riders:${licenseKey}`);
        }
        console.log(`[Rider API] Rider ${userId} claimed task ${id} via REST API.`);

        // Log action
        await pool.query(
          'INSERT INTO _pos_activity_logs_base (restaurant_id, user_id, user_type, user_name, section, action_type, description, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [restaurantId, userId, 'Rider', req.user.username || 'Rider', 'Tasks', 'Claim', `Rider claimed task ${id}`, null]
        );
        alreadyUpdated = true;
      } else {
        return res.status(403).json({
          success: false,
          data: null,
          error: 'Access denied. You can only update your assigned tasks.'
        });
      }
    }

    if (!alreadyUpdated) {
      // Prepare update parameters
      let updateQuery = 'UPDATE _tasks_base SET status = ?';
      const params = [status];

      if (req.body.rider_id !== undefined && isAdmin) {
        updateQuery += ', rider_id = ?';
        params.push(req.body.rider_id || null);
        if (req.body.rider_id) {
          updateQuery += ', assigned_at = NOW()';
        }
      }

      if (status === 'accepted') {
        updateQuery += ', accepted_at = NOW()';
      } else if (status === 'delivered') {
        updateQuery += ', delivered_at = NOW()';
      } else if (status === 'assigned') {
        updateQuery += ', assigned_at = NOW()';
      }

      updateQuery += ' WHERE id = ? AND restaurant_id = ?';
      params.push(id, restaurantId);

      await pool.query(updateQuery, params);

      // Log action
      await pool.query(
        'INSERT INTO _pos_activity_logs_base (restaurant_id, user_id, user_type, user_name, section, action_type, description, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [restaurantId, userId, isAdmin ? 'Admin' : 'Rider', req.user.username || role, 'Tasks', 'Update', `${isAdmin ? 'Admin' : 'Rider'} updated task ${id} to ${status}`, null]
      );
    }

    // Sync order status
    if (task.order_number) {
      const io = req.app.get('io');
      const licenseKey = req.headers['x-license-key'] || req.query.license_key;
      await syncOrderStatusWithTask(pool, restaurantId, task.order_number, status, licenseKey, io);
    }

    // If status updates affect rider state
    let newRiderStatus = null;
    const activeRiderId = req.body.rider_id || task.rider_id || userId;
    if (activeRiderId) {
      if (status === 'accepted') {
        newRiderStatus = 'idle'; // stays idle but preparing
      } else if (status === 'delivering') {
        newRiderStatus = 'delivering';
      } else if (status === 'delivered') {
        newRiderStatus = 'idle';
      } else if (status === 'cancelled') {
        newRiderStatus = 'idle';
      }

      if (newRiderStatus) {
        await pool.query(
          'UPDATE _riders_base SET status = ? WHERE id = ? AND restaurant_id = ?', 
          [newRiderStatus, activeRiderId, restaurantId]
        );
      }
    }

    // Fetch final task details to return
    const [updatedRows] = await pool.query(
      `SELECT t.*, r.full_name as rider_name 
       FROM _tasks_base t 
       LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
       WHERE t.id = ? AND t.restaurant_id = ?`,
      [id, restaurantId]
    );
    const updatedTask = updatedRows[0];

    // Real-time broadcasts
    const io = req.app.get('io');
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    if (io) {
      // Broadcast to admin and pos_clients rooms about task status change
      io.to(`admin:${licenseKey}`).emit('task:status:update', updatedTask);
      io.to(`pos_clients:${licenseKey}`).emit('task:status:update', updatedTask);
      console.log(`[Rider API] Broadcasted socket event 'task:status:update' to admin:${licenseKey} and pos_clients:${licenseKey} for Task ID: ${id}, Status: ${status}`);

      // Broadcast task update to all riders in this restaurant
      io.to(`riders:${licenseKey}`).emit('task:updated', updatedTask);
      io.to(`pos_clients:${licenseKey}`).emit('task:updated', updatedTask);

      // If assigned to a rider specifically
      if (updatedTask && updatedTask.rider_id) {
        io.to(`rider:${licenseKey}:${updatedTask.rider_id}`).emit('task:new', updatedTask);
        io.to(`rider:${licenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
        io.to(`riders:${licenseKey}`).emit('task:claimed', { taskId: parseInt(id), riderId: updatedTask.rider_id, task: updatedTask });
        io.to(`admin:${licenseKey}`).emit('task:claimed', { taskId: parseInt(id), riderId: updatedTask.rider_id, task: updatedTask });
        io.to(`pos_clients:${licenseKey}`).emit('task:claimed', { taskId: parseInt(id), riderId: updatedTask.rider_id, task: updatedTask });

        if (isAdmin && req.body.rider_id) {
          sendTaskNotification(updatedTask.rider_id, updatedTask).catch(err => console.error('Notification error:', err));
        }
      }

      if (task.rider_id) {
        // If task was cancelled by admin, notify the rider
        if (status === 'cancelled') {
          io.to(`rider:${licenseKey}:${task.rider_id}`).emit('task:cancelled', { taskId: id });
          console.log(`[Rider API] Sent socket event 'task:cancelled' to rider:${licenseKey}:${task.rider_id} for Task ID: ${id}`);
        }

        // Broadcast rider status update if changed
        if (newRiderStatus) {
          io.to(`admin:${licenseKey}`).emit('rider:status:update', {
            riderId: task.rider_id,
            status: newRiderStatus
          });
          console.log(`[Rider API] Broadcasted socket event 'rider:status:update' to admin:${licenseKey} for Rider ID: ${task.rider_id}, Status: ${newRiderStatus}`);
        }
      }
    }

    return res.json({
      success: true,
      data: updatedTask,
      error: null
    });
  } catch (error) {
    console.error('Error updating task status:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const updateTaskByOrderNumber = async (req, res) => {
  const { orderNumber } = req.params;

  try {
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId || req.user.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found.'
      });
    }

    const [rows] = await pool.query(
      'SELECT id FROM _tasks_base WHERE order_number = ? AND restaurant_id = ? ORDER BY id DESC LIMIT 1',
      [orderNumber, restaurantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: `No task found for order #${orderNumber}`
      });
    }

    req.params.id = rows[0].id;
    return updateTaskStatus(req, res);
  } catch (error) {
    console.error('Error updating task by order number:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const getMyRiderStats = async (req, res) => {
  const riderId = req.user.id;
  const restaurantId = req.user.restaurantId; // Should be in JWT payload
  
  try {
    const [rows] = await pool.query(`
      SELECT 
        COUNT(CASE WHEN status = 'delivered' AND DATE(delivered_at) = CURDATE() THEN 1 END) as today_count,
        COUNT(CASE WHEN status = 'delivered' AND YEARWEEK(delivered_at, 1) = YEARWEEK(CURDATE(), 1) THEN 1 END) as weekly_count,
        COUNT(CASE WHEN status = 'delivered' AND MONTH(delivered_at) = MONTH(CURDATE()) AND YEAR(delivered_at) = YEAR(CURDATE()) THEN 1 END) as monthly_count,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as total_count
      FROM _tasks_base
      WHERE rider_id = ? AND restaurant_id = ?
    `, [riderId, restaurantId]);

    return res.json({
      success: true,
      data: rows[0],
      error: null
    });
  } catch (error) {
    console.error('Error fetching rider personal stats:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const isLockTimeoutOrDeadlock = (err) => {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  const errno = err.errno || 0;
  return (
    code === 'ER_LOCK_WAIT_TIMEOUT' ||
    code === 'ER_LOCK_DEADLOCK' ||
    errno === 1205 ||
    errno === 1213 ||
    msg.includes('lock wait timeout exceeded') ||
    msg.includes('deadlock found when trying to get lock')
  );
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const syncOrderStatusWithTask = async (dbPool, restaurantId, orderNumber, taskStatus, licenseKey, io) => {
  if (!orderNumber || !restaurantId) return;
  
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      // 1. Fetch the task to get the current rider_id
      const [taskRows] = await dbPool.query('SELECT rider_id FROM _tasks_base WHERE restaurant_id = ? AND order_number = ? LIMIT 1', [restaurantId, orderNumber]);
      let riderName = null;
      if (taskRows.length > 0 && taskRows[0].rider_id) {
        const [riderRows] = await dbPool.query('SELECT full_name FROM _riders_base WHERE restaurant_id = ? AND id = ? LIMIT 1', [restaurantId, taskRows[0].rider_id]);
        if (riderRows.length > 0) {
          riderName = riderRows[0].full_name;
        }
      }

      let orderStatus = null;
      if (taskStatus === 'delivering') {
        orderStatus = 'delivering';
      } else if (taskStatus === 'delivered') {
        orderStatus = 'completed';
      } else if (taskStatus === 'cancelled') {
        orderStatus = 'cancelled';
      }

      // 2. Prepare and execute update query
      let updateQuery = 'UPDATE _pos_orders_base SET rider_name = ?, updated_at = NOW()';
      const params = [riderName];
      if (orderStatus) {
        updateQuery += ', status = ?';
        params.push(orderStatus);
      }
      updateQuery += ' WHERE restaurant_id = ? AND order_number = ?';
      params.push(restaurantId, orderNumber);

      await dbPool.query(updateQuery, params);
      
      let finalLicenseKey = licenseKey;
      if (!finalLicenseKey && restaurantId) {
        const [restRows] = await dbPool.query('SELECT license_key FROM restaurants WHERE id = ? LIMIT 1', [restaurantId]);
        if (restRows.length > 0) {
          finalLicenseKey = restRows[0].license_key;
        }
      }

      if (io && finalLicenseKey) {
        const [orderRows] = await dbPool.query('SELECT * FROM _pos_orders_base WHERE restaurant_id = ? AND order_number = ? LIMIT 1', [restaurantId, orderNumber]);
        const updatedOrder = orderRows[0];
        if (updatedOrder) {
          io.to(`admin:${finalLicenseKey}`).emit('order:updated', updatedOrder);
          io.to(`pos_clients:${finalLicenseKey}`).emit('order:updated', updatedOrder);
        }
        io.to(`pos_clients:${finalLicenseKey}`).emit('pos:sync_required');
        io.to(`admin:${finalLicenseKey}`).emit('pos:sync_required');
      }
      break; // Success
    } catch (err) {
      if (isLockTimeoutOrDeadlock(err) && attempts < 3) {
        const backoff = 50 * Math.pow(2, attempts) + Math.random() * 40;
        await delay(backoff);
      } else {
        console.error('[Sync Helper] Error updating order status/rider:', err.message);
        break;
      }
    }
  }
};

const syncTaskWithOrderStatus = async (dbPool, restaurantId, orderNumber, orderStatus, licenseKey, io) => {
  if (!orderNumber || !orderStatus || !restaurantId) return;

  let taskStatus = null;
  const lower = orderStatus.toLowerCase();
  if (lower === 'ready_for_dispatch' || lower === 'prepared' || lower === 'ready') {
    taskStatus = 'prepared';
  } else if (lower === 'delivering' || lower === 'dispatched') {
    taskStatus = 'dispatched';
  } else if (lower === 'completed') {
    taskStatus = 'delivered';
  } else if (lower === 'cancelled') {
    taskStatus = 'cancelled';
  }

  if (!taskStatus) return;

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const [taskRows] = await dbPool.query(
        'SELECT id, status, rider_id FROM _tasks_base WHERE restaurant_id = ? AND order_number = ? LIMIT 1',
        [restaurantId, orderNumber]
      );

      if (taskRows.length === 0) return;
      const currentTask = taskRows[0];

      // If task is already in the target status, avoid redundant updates and socket emissions
      if (currentTask.status === taskStatus) {
        return;
      }

      // Avoid regressing state if already delivering/delivered
      if (currentTask.status === 'delivering' && taskStatus === 'dispatched') {
        return;
      }
      if (currentTask.status === 'delivered' && taskStatus !== 'delivered') {
        return;
      }

      await dbPool.query(
        'UPDATE _tasks_base SET status = ? WHERE id = ? AND restaurant_id = ?',
        [taskStatus, currentTask.id, restaurantId]
      );

      const [updatedRows] = await dbPool.query(
        `SELECT t.*, r.full_name as rider_name 
         FROM _tasks_base t 
         LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
         WHERE t.id = ? AND t.restaurant_id = ? LIMIT 1`,
        [currentTask.id, restaurantId]
      );
      const updatedTask = updatedRows[0];

      let finalLicenseKey = licenseKey;
      if (!finalLicenseKey && restaurantId) {
        const [restRows] = await dbPool.query('SELECT license_key FROM restaurants WHERE id = ? LIMIT 1', [restaurantId]);
        if (restRows.length > 0) finalLicenseKey = restRows[0].license_key;
      }

      if (io && finalLicenseKey && updatedTask) {
        io.to(`admin:${finalLicenseKey}`).emit('task:status:update', updatedTask);
        io.to(`riders:${finalLicenseKey}`).emit('task:updated', updatedTask);
        if (updatedTask.rider_id) {
          io.to(`rider:${finalLicenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
        }
      }
      break; // Success
    } catch (err) {
      if (isLockTimeoutOrDeadlock(err) && attempts < 3) {
        const backoff = 50 * Math.pow(2, attempts) + Math.random() * 40;
        await delay(backoff);
      } else {
        console.error('[Sync Helper] Error syncing task with order status:', err.message);
        break;
      }
    }
  }
};

module.exports = {
  getAllTasks,
  getTaskById,
  createTask,
  updateTaskStatus,
  updateTaskByOrderNumber,
  getMyRiderStats,
  syncOrderStatusWithTask,
  syncTaskWithOrderStatus
};

