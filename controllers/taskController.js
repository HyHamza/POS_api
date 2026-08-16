const pool = require('../config/db');
const { sendTaskNotification } = require('../utils/notifications');

const getAllTasks = async (req, res) => {
  const { id, role } = req.user;
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

    if (role === 'admin') {
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
      // Riders see their own tasks AND unassigned tasks that are pending, cooking, processing, prepared, ready_for_dispatch, dispatched, or ready so they can claim them
      query = `SELECT * FROM _tasks_base 
               WHERE restaurant_id = ? AND (rider_id = ? OR (rider_id IS NULL AND status IN ('pending', 'cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched', 'ready'))) 
               ORDER BY created_at DESC`;
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
    if (role === 'rider' && task.rider_id !== userId) {
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
    if (rider_id) {
      // Server-Side Clock-In Verification for specific rider
      const [attRows] = await pool.query(
        `SELECT a.id FROM _pos_attendance_base a
         JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
         JOIN _riders_base r ON s.username = r.username AND r.restaurant_id = s.restaurant_id
         WHERE r.id = ? AND r.restaurant_id = ? AND a.date = CURDATE() AND a.clock_out IS NULL`,
        [rider_id, restaurantId]
      );
      const isClockedIn = attRows.length > 0;

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
         JOIN _pos_staff_base s ON r.username = s.username AND r.restaurant_id = s.restaurant_id
         JOIN _pos_attendance_base a ON a.staff_id = s.id AND a.restaurant_id = s.restaurant_id
         WHERE r.restaurant_id = ? AND r.is_active = 1 AND r.fcm_token IS NOT NULL
           AND a.date = CURDATE() AND a.clock_out IS NULL`,
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

    // Server-side Rider Duty Check: Riders must be clocked in to accept or update tasks
    if (role === 'rider') {
      const [dutyRows] = await pool.query(
        `SELECT a.id FROM _pos_attendance_base a
         JOIN _pos_staff_base s ON a.staff_id = s.id AND s.restaurant_id = a.restaurant_id
         JOIN _riders_base r ON s.username = r.username AND r.restaurant_id = s.restaurant_id
         WHERE r.id = ? AND r.restaurant_id = ? AND a.date = CURDATE() AND a.clock_out IS NULL`,
        [userId, restaurantId]
      );
      if (dutyRows.length === 0) {
        return res.status(403).json({
          success: false,
          data: null,
          error: 'Duty clock-in required. You must clock in before accepting or handling orders.'
        });
      }
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

    // Guard: Riders cannot start delivery if the order has not been dispatched yet
    if (role === 'rider' && status === 'delivering') {
      if (!['dispatched', 'ready', 'ready_for_dispatch'].includes(task.status)) {
        return res.status(400).json({
          success: false,
          data: null,
          error: 'Cannot start delivery until the order has been dispatched by staff.'
        });
      }
    }

    // FIX (Bug #8): Move the 'cancelled' admin-only guard BEFORE the rider path so it
    // applies universally regardless of which branch executes below.
    if (status === 'cancelled' && role !== 'admin') {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Access denied. Only administrators can cancel tasks.'
      });
    }

    // Role-based validation
    if (role === 'rider' && task.rider_id !== userId) {
      // Allow the rider to accept/claim the task if it is currently unassigned (null)
      if (status === 'accepted' && task.rider_id === null && ['pending', 'cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched', 'ready'].includes(task.status)) {
        let targetStatus = 'accepted';
        if (['cooking', 'processing', 'prepared', 'ready_for_dispatch', 'dispatched'].includes(task.status)) {
          targetStatus = task.status;
        }

        // Attempt atomic claiming with restaurant_id filter
        const [result] = await pool.query(
          'UPDATE _tasks_base SET rider_id = ?, status = ?, assigned_at = NOW(), accepted_at = NOW() WHERE id = ? AND restaurant_id = ? AND rider_id IS NULL AND status = ?',
          [userId, targetStatus, id, restaurantId, task.status]
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

      if (req.body.rider_id !== undefined && role === 'admin') {
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
        [restaurantId, userId, role === 'admin' ? 'Admin' : 'Rider', req.user.username || role, 'Tasks', 'Update', `${role === 'admin' ? 'Admin' : 'Rider'} updated task ${id} to ${status}`, null]
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
      // Broadcast to admin room about task status change
      io.to(`admin:${licenseKey}`).emit('task:status:update', updatedTask);
      console.log(`[Rider API] Broadcasted socket event 'task:status:update' to admin:${licenseKey} for Task ID: ${id}, Status: ${status}`);

      // Broadcast task update to all riders in this restaurant
      io.to(`riders:${licenseKey}`).emit('task:updated', updatedTask);

      // If assigned to a rider specifically
      if (updatedTask && updatedTask.rider_id) {
        io.to(`rider:${licenseKey}:${updatedTask.rider_id}`).emit('task:new', updatedTask);
        io.to(`rider:${licenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
        io.to(`riders:${licenseKey}`).emit('task:claimed', { taskId: parseInt(id), riderId: updatedTask.rider_id });

        if (role === 'admin' && req.body.rider_id) {
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

const syncOrderStatusWithTask = async (pool, restaurantId, orderNumber, taskStatus, licenseKey, io) => {
  if (!orderNumber) return;
  try {
    // 1. Fetch the task to get the current rider_id
    const [taskRows] = await pool.query('SELECT rider_id FROM _tasks_base WHERE restaurant_id = ? AND order_number = ?', [restaurantId, orderNumber]);
    let riderName = null;
    if (taskRows.length > 0 && taskRows[0].rider_id) {
      const [riderRows] = await pool.query('SELECT full_name FROM _riders_base WHERE restaurant_id = ? AND id = ?', [restaurantId, taskRows[0].rider_id]);
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

    await pool.query(updateQuery, params);
    console.log(`[Sync Helper] Updated order ${orderNumber}: status = ${orderStatus || 'unchanged'}, rider_name = ${riderName}`);
    
    let finalLicenseKey = licenseKey;
    if (!finalLicenseKey && restaurantId) {
      const [restRows] = await pool.query('SELECT license_key FROM restaurants WHERE id = ?', [restaurantId]);
      if (restRows.length > 0) {
        finalLicenseKey = restRows[0].license_key;
      }
    }

    if (io && finalLicenseKey) {
      io.to(`pos_clients:${finalLicenseKey}`).emit('pos:sync_required');
      console.log(`[Sync Helper] Broadcasted pos:sync_required to pos_clients:${finalLicenseKey}`);
    }
  } catch (err) {
    console.error('[Sync Helper] Error updating order status/rider:', err);
  }
};

const updateTaskByOrderNumber = async (req, res) => {
  const { orderNumber } = req.params;
  const { status, rider_id } = req.body;

  try {
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId || req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Restaurant context not found.'
      });
    }

    const [taskRows] = await pool.query(
      'SELECT * FROM _tasks_base WHERE order_number = ? AND restaurant_id = ? LIMIT 1',
      [orderNumber, restaurantId]
    );

    if (taskRows.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Task not found for this order number.'
      });
    }

    const task = taskRows[0];
    let updateQuery = 'UPDATE _tasks_base SET status = ?';
    const params = [status];

    if (rider_id !== undefined) {
      updateQuery += ', rider_id = ?';
      params.push(rider_id || null);
      if (rider_id) {
        updateQuery += ', assigned_at = NOW()';
      }
    }

    if (status === 'accepted') {
      updateQuery += ', accepted_at = NOW()';
    } else if (status === 'delivered') {
      updateQuery += ', delivered_at = NOW()';
    }

    updateQuery += ' WHERE id = ? AND restaurant_id = ?';
    params.push(task.id, restaurantId);

    await pool.query(updateQuery, params);

    const [updatedRows] = await pool.query(
      `SELECT t.*, r.full_name as rider_name 
       FROM _tasks_base t 
       LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
       WHERE t.id = ? AND t.restaurant_id = ?`,
      [task.id, restaurantId]
    );
    const updatedTask = updatedRows[0];

    const io = req.app.get('io');
    const licenseKey = req.headers['x-license-key'] || req.query.license_key;
    if (io && licenseKey) {
      io.to(`admin:${licenseKey}`).emit('task:status:update', updatedTask);
      io.to(`riders:${licenseKey}`).emit('task:updated', updatedTask);
      if (updatedTask && updatedTask.rider_id) {
        io.to(`rider:${licenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
      }
    }

    return res.json({
      success: true,
      data: updatedTask,
      error: null
    });
  } catch (error) {
    console.error('Error updating task by order number:', error);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'An internal server error occurred.'
    });
  }
};

const syncTaskWithOrderStatus = async (pool, restaurantId, orderNumber, orderStatus, licenseKey, io) => {
  if (!orderNumber || !orderStatus) return;
  try {
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

    const [taskRows] = await pool.query(
      'SELECT id, status, rider_id FROM _tasks_base WHERE restaurant_id = ? AND order_number = ? LIMIT 1',
      [restaurantId, orderNumber]
    );

    if (taskRows.length === 0) return;
    const currentTask = taskRows[0];

    // Avoid regressing state if already delivering/delivered
    if (currentTask.status === 'delivering' && taskStatus === 'dispatched') {
      return;
    }
    if (currentTask.status === 'delivered' && taskStatus !== 'delivered') {
      return;
    }

    await pool.query(
      'UPDATE _tasks_base SET status = ? WHERE id = ? AND restaurant_id = ?',
      [taskStatus, currentTask.id, restaurantId]
    );

    const [updatedRows] = await pool.query(
      `SELECT t.*, r.full_name as rider_name 
       FROM _tasks_base t 
       LEFT JOIN _riders_base r ON t.rider_id = r.id AND r.restaurant_id = t.restaurant_id 
       WHERE t.id = ? AND t.restaurant_id = ?`,
      [currentTask.id, restaurantId]
    );
    const updatedTask = updatedRows[0];

    let finalLicenseKey = licenseKey;
    if (!finalLicenseKey && restaurantId) {
      const [restRows] = await pool.query('SELECT license_key FROM restaurants WHERE id = ?', [restaurantId]);
      if (restRows.length > 0) finalLicenseKey = restRows[0].license_key;
    }

    if (io && finalLicenseKey && updatedTask) {
      io.to(`admin:${finalLicenseKey}`).emit('task:status:update', updatedTask);
      io.to(`riders:${finalLicenseKey}`).emit('task:updated', updatedTask);
      if (updatedTask.rider_id) {
        io.to(`rider:${finalLicenseKey}:${updatedTask.rider_id}`).emit('task:updated', updatedTask);
      }
    }
    console.log(`[Sync Helper] Synced task for order ${orderNumber} -> status: ${taskStatus}`);
  } catch (err) {
    console.error('[Sync Helper] Error syncing task with order status:', err.message);
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

