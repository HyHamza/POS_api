/**
 * staffController.js — Staff, Attendance & Face Biometrics REST Controller for POS_api
 */

'use strict';

const crypto = require('crypto');
const pool = require('../config/db');
const { asyncLocalStorage } = require('../config/db');

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

async function broadcastTenantEvent(eventName, payload) {
  try {
    const store = asyncLocalStorage.getStore();
    const licenseKey = store?.licenseKey;
    if (licenseKey && global.socketIoInstance) {
      global.socketIoInstance.to(`pos_clients:${licenseKey}`).emit(eventName, payload);
      global.socketIoInstance.to(`admin:${licenseKey}`).emit(eventName, payload);
    }
  } catch (err) {
    console.warn('[StaffController] Socket broadcast error:', err.message);
  }
}

// ─── Staff CRUD ─────────────────────────────────────────────────────────────

const getAllStaff = async (req, res) => {
  try {
    const [staffList] = await pool.query(`
      SELECT s.*, r.name as role_name 
      FROM pos_staff s
      LEFT JOIN _pos_roles_base r ON s.role_id = r.id AND s.restaurant_id = r.restaurant_id
      WHERE (s.is_deleted = 0 OR s.is_deleted IS NULL)
      ORDER BY s.name ASC
    `);

    for (const staff of staffList) {
      try { staff.permissions = JSON.parse(staff.permissions || '[]'); } catch (_) { staff.permissions = []; }
      try { staff.assigned_categories = JSON.parse(staff.assigned_categories || '[]'); } catch (_) { staff.assigned_categories = []; }
      try { staff.assigned_items = JSON.parse(staff.assigned_items || '[]'); } catch (_) { staff.assigned_items = []; }
      try { staff.assigned_order_types = JSON.parse(staff.assigned_order_types || '[]'); } catch (_) { staff.assigned_order_types = []; }
    }

    return res.json({ success: true, data: staffList });
  } catch (err) {
    console.error('[StaffController] getAllStaff error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getStaffById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM pos_staff WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Staff member not found' });

    const staff = rows[0];
    try { staff.permissions = JSON.parse(staff.permissions || '[]'); } catch (_) { staff.permissions = []; }
    try { staff.assigned_categories = JSON.parse(staff.assigned_categories || '[]'); } catch (_) { staff.assigned_categories = []; }
    try { staff.assigned_items = JSON.parse(staff.assigned_items || '[]'); } catch (_) { staff.assigned_items = []; }
    try { staff.assigned_order_types = JSON.parse(staff.assigned_order_types || '[]'); } catch (_) { staff.assigned_order_types = []; }

    return res.json({ success: true, data: staff });
  } catch (err) {
    console.error('[StaffController] getStaffById error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createStaff = async (req, res) => {
  try {
    const {
      name, username, pin, role = 'Waiter', role_id, phone, email,
      salary_type = 'Monthly', salary_amount = 0, daily_duty_hours = 8, permissions
    } = req.body;

    if (!name || !username || !pin) {
      return res.status(400).json({ success: false, error: 'Name, username and PIN are required' });
    }

    const pinHash = hashPin(pin);
    const permsJson = Array.isArray(permissions) ? JSON.stringify(permissions) : (permissions || null);

    const [result] = await pool.query(`
      INSERT INTO pos_staff 
      (name, username, pin_hash, role, role_id, phone, email, salary_type, salary_amount, daily_duty_hours, permissions, status, created_at, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', NOW(), 0)
    `, [name, username, pinHash, role, role_id || null, phone || null, email || null, salary_type, salary_amount, daily_duty_hours, permsJson]);

    const [rows] = await pool.query('SELECT * FROM pos_staff WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[StaffController] createStaff error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, username, pin, role, role_id, phone, email, status,
      salary_type, salary_amount, daily_duty_hours, permissions
    } = req.body;

    const [existing] = await pool.query('SELECT * FROM pos_staff WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, error: 'Staff member not found' });

    const current = existing[0];
    const newName = name !== undefined ? name : current.name;
    const newUsername = username !== undefined ? username : current.username;
    const newPinHash = pin ? hashPin(pin) : current.pin_hash;
    const newRole = role !== undefined ? role : current.role;
    const newRoleId = role_id !== undefined ? role_id : current.role_id;
    const newPhone = phone !== undefined ? phone : current.phone;
    const newEmail = email !== undefined ? email : current.email;
    const newStatus = status !== undefined ? status : current.status;
    const newSalaryType = salary_type !== undefined ? salary_type : current.salary_type;
    const newSalaryAmount = salary_amount !== undefined ? salary_amount : current.salary_amount;
    const newDutyHours = daily_duty_hours !== undefined ? daily_duty_hours : current.daily_duty_hours;
    const newPerms = permissions !== undefined
      ? (Array.isArray(permissions) ? JSON.stringify(permissions) : permissions)
      : current.permissions;

    await pool.query(`
      UPDATE pos_staff 
      SET name = ?, username = ?, pin_hash = ?, role = ?, role_id = ?, 
          phone = ?, email = ?, status = ?, salary_type = ?, salary_amount = ?, 
          daily_duty_hours = ?, permissions = ?
      WHERE id = ?
    `, [newName, newUsername, newPinHash, newRole, newRoleId, newPhone, newEmail, newStatus, newSalaryType, newSalaryAmount, newDutyHours, newPerms, id]);

    const [rows] = await pool.query('SELECT * FROM pos_staff WHERE id = ?', [id]);
    const updated = rows[0];

    // Broadcast permission change if relevant
    if (permissions !== undefined) {
      let parsedPerms = [];
      try { parsedPerms = JSON.parse(newPerms || '[]'); } catch (_) {}
      broadcastTenantEvent('staff:permissionsUpdated', { staffId: parseInt(id, 10), permissions: parsedPerms });
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[StaffController] updateStaff error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_staff SET is_deleted = 1, status = "Inactive" WHERE id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[StaffController] deleteStaff error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateAssignments = async (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_categories, assigned_items, assigned_order_types } = req.body;

    const catsJson = Array.isArray(assigned_categories) ? JSON.stringify(assigned_categories) : (assigned_categories || '[]');
    const itemsJson = Array.isArray(assigned_items) ? JSON.stringify(assigned_items) : (assigned_items || '[]');
    const typesJson = Array.isArray(assigned_order_types) ? JSON.stringify(assigned_order_types) : (assigned_order_types || '[]');

    await pool.query(`
      UPDATE pos_staff 
      SET assigned_categories = ?, assigned_items = ?, assigned_order_types = ?
      WHERE id = ?
    `, [catsJson, itemsJson, typesJson, id]);

    broadcastTenantEvent('staff:assignmentsUpdated', {
      staffId: parseInt(id, 10),
      assigned_categories: Array.isArray(assigned_categories) ? assigned_categories : [],
      assigned_items: Array.isArray(assigned_items) ? assigned_items : [],
      assigned_order_types: Array.isArray(assigned_order_types) ? assigned_order_types : []
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[StaffController] updateAssignments error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Attendance & Clock In/Out ───────────────────────────────────────────────

const checkClockIn = async (req, res) => {
  try {
    const staffId = req.query.staff_id || req.user?.id;
    if (!staffId) return res.status(400).json({ success: false, error: 'Staff ID is required' });

    const [rows] = await pool.query(`
      SELECT id, clock_in, date FROM pos_attendance 
      WHERE (staff_id = ? OR staff_id = ?) 
        AND clock_out IS NULL 
        AND (is_deleted IS NULL OR is_deleted = 0) 
      ORDER BY id DESC LIMIT 1
    `, [staffId, String(staffId)]);

    return res.json({ success: true, clockedIn: rows.length > 0, record: rows[0] || null });
  } catch (err) {
    console.error('[StaffController] checkClockIn error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const clockIn = async (req, res) => {
  try {
    const { staff_id, verification_method = 'PIN' } = req.body;
    const sid = staff_id || req.user?.id;

    if (!sid) return res.status(400).json({ success: false, error: 'Staff ID is required' });

    // Check if already clocked in
    const [active] = await pool.query(`
      SELECT id FROM pos_attendance 
      WHERE (staff_id = ? OR staff_id = ?) 
        AND clock_out IS NULL 
        AND (is_deleted IS NULL OR is_deleted = 0) 
      LIMIT 1
    `, [sid, String(sid)]);

    if (active.length > 0) {
      return res.json({ success: true, message: 'Already clocked in', id: active[0].id });
    }

    const today = new Date().toISOString().slice(0, 10);
    const [result] = await pool.query(`
      INSERT INTO pos_attendance (staff_id, clock_in, date, verification_method)
      VALUES (?, NOW(), ?, ?)
    `, [sid, today, verification_method]);

    broadcastTenantEvent('attendance:change', { staff_id: parseInt(sid, 10), clocked_in: true });

    return res.json({ success: true, id: result.insertId, clockedIn: true });
  } catch (err) {
    console.error('[StaffController] clockIn error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const clockOut = async (req, res) => {
  try {
    const { staff_id, verification_method = 'PIN' } = req.body;
    const sid = staff_id || req.user?.id;

    if (!sid) return res.status(400).json({ success: false, error: 'Staff ID is required' });

    await pool.query(`
      UPDATE pos_attendance 
      SET clock_out = NOW() 
      WHERE (staff_id = ? OR staff_id = ?) 
        AND clock_out IS NULL
        AND (is_deleted IS NULL OR is_deleted = 0)
    `, [sid, String(sid)]);

    broadcastTenantEvent('attendance:change', { staff_id: parseInt(sid, 10), clocked_in: false });

    return res.json({ success: true, clockedIn: false });
  } catch (err) {
    console.error('[StaffController] clockOut error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getAttendance = async (req, res) => {
  try {
    const { start_date, end_date, staff_id } = req.query;
    let query = `
      SELECT a.*, s.name as staff_name, s.role as staff_role, s.daily_duty_hours
      FROM pos_attendance a
      JOIN pos_staff s ON a.staff_id = s.id
      WHERE (a.is_deleted = 0 OR a.is_deleted IS NULL)
    `;
    const params = [];

    if (start_date && end_date) {
      query += ' AND a.date BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }
    if (staff_id) {
      query += ' AND a.staff_id = ?';
      params.push(staff_id);
    }

    query += ' ORDER BY a.date DESC, a.clock_in DESC';

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[StaffController] getAttendance error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getOnDutyStaff = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.name, s.role, a.clock_in, a.verification_method
      FROM pos_attendance a
      JOIN pos_staff s ON a.staff_id = s.id
      WHERE a.clock_out IS NULL
        AND (a.is_deleted IS NULL OR a.is_deleted = 0)
        AND s.status = 'Active'
      ORDER BY a.clock_in ASC
    `);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[StaffController] getOnDutyStaff error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Face Recognition Descriptors ───────────────────────────────────────────

const saveFaceDescriptor = async (req, res) => {
  try {
    const { staff_id, descriptor, photo } = req.body;
    if (!staff_id || !descriptor) {
      return res.status(400).json({ success: false, error: 'Staff ID and descriptor are required' });
    }

    const descStr = typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor);

    await pool.query(`
      INSERT INTO _pos_face_descriptors_base (staff_id, restaurant_id, descriptor, photo, created_at)
      VALUES (?, @current_restaurant_id, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE descriptor = VALUES(descriptor), photo = VALUES(photo), created_at = NOW()
    `, [staff_id, descStr, photo || null]);

    return res.json({ success: true });
  } catch (err) {
    console.error('[StaffController] saveFaceDescriptor error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getFaceDescriptors = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT fd.staff_id, fd.descriptor, fd.photo, s.name, s.username, s.role, s.status
      FROM pos_face_descriptors fd
      JOIN pos_staff s ON fd.staff_id = s.id
      WHERE s.status = 'Active'
    `);

    for (const r of rows) {
      try { r.descriptor = JSON.parse(r.descriptor); } catch (_) {}
    }

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[StaffController] getFaceDescriptors error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteFaceDescriptor = async (req, res) => {
  try {
    const { staff_id } = req.params;
    await pool.query('DELETE FROM pos_face_descriptors WHERE staff_id = ?', [staff_id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[StaffController] deleteFaceDescriptor error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const verifyPinAndClock = async (req, res) => {
  try {
    const { username, pin, action } = req.body;
    if (!username || !pin || !action) {
      return res.status(400).json({ success: false, error: 'Username, PIN, and action are required' });
    }

    const [rows] = await pool.query(
      "SELECT id, name, role, pin_hash FROM pos_staff WHERE username = ? AND status = 'Active' AND (is_deleted = 0 OR is_deleted IS NULL)",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid username or PIN.' });
    }

    const employee = rows[0];
    const hashed = hashPin(pin);
    if (employee.pin_hash !== hashed && employee.pin_hash !== pin) {
      return res.status(401).json({ success: false, error: 'Invalid username or PIN.' });
    }

    const [openAtt] = await pool.query(
      "SELECT id FROM pos_attendance WHERE (staff_id = ? OR staff_id = ?) AND clock_out IS NULL AND (is_deleted = 0 OR is_deleted IS NULL)",
      [employee.id, String(employee.id)]
    );

    if (action === 'clock_in') {
      if (openAtt.length > 0) {
        return res.status(400).json({ success: false, error: 'Employee is already clocked in.' });
      }
      await pool.query(
        "INSERT INTO pos_attendance (staff_id, date, clock_in, verification_method, is_deleted) VALUES (?, CURDATE(), NOW(), 'PIN', 0)",
        [employee.id]
      );
      broadcastTenantEvent('attendance:change', { staff_id: employee.id, clocked_in: true });
      return res.json({ success: true, message: `${employee.name} clocked in successfully.`, employee, clockedIn: true });
    } else if (action === 'clock_out') {
      if (openAtt.length === 0) {
        return res.status(400).json({ success: false, error: 'Employee is not clocked in.' });
      }
      await pool.query(
        "UPDATE pos_attendance SET clock_out = NOW(), verification_method = 'PIN' WHERE id = ?",
        [openAtt[0].id]
      );
      broadcastTenantEvent('attendance:change', { staff_id: employee.id, clocked_in: false });
      return res.json({ success: true, message: `${employee.name} clocked out successfully.`, employee, clockedIn: false });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }
  } catch (err) {
    console.error('[StaffController] verifyPinAndClock error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const changeLoginPin = async (req, res) => {
  try {
    const { currentPin, newPin, userId } = req.body;
    const staffId = userId || req.user?.id;
    if (!staffId || !currentPin || !newPin) {
      return res.status(400).json({ success: false, error: 'Current PIN, new PIN, and user are required' });
    }

    const [rows] = await pool.query('SELECT id, pin_hash FROM pos_staff WHERE id = ?', [staffId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }

    const curHashed = hashPin(currentPin);
    if (rows[0].pin_hash !== curHashed && rows[0].pin_hash !== currentPin) {
      return res.status(401).json({ success: false, error: 'Incorrect current PIN' });
    }

    const newHashed = hashPin(newPin);
    await pool.query('UPDATE pos_staff SET pin_hash = ? WHERE id = ?', [newHashed, staffId]);

    return res.json({ success: true, message: 'PIN updated successfully' });
  } catch (err) {
    console.error('[StaffController] changeLoginPin error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_attendance SET is_deleted = 1 WHERE id = ?', [id]);
    return res.json({ success: true, message: 'Attendance record deleted' });
  } catch (err) {
    console.error('[StaffController] deleteAttendance error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  updateAssignments,
  checkClockIn,
  clockIn,
  clockOut,
  getAttendance,
  getOnDutyStaff,
  saveFaceDescriptor,
  getFaceDescriptors,
  deleteFaceDescriptor,
  verifyPinAndClock,
  changeLoginPin,
  deleteAttendance
};
