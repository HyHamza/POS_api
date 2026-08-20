/**
 * tableController.js — Floors, Sections & Tables REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');
const { asyncLocalStorage } = require('../config/db');

async function broadcastTenantEvent(eventName, payload) {
  try {
    const store = asyncLocalStorage.getStore();
    const licenseKey = store?.licenseKey;
    if (licenseKey && global.socketIoInstance) {
      global.socketIoInstance.to(`pos_clients:${licenseKey}`).emit(eventName, payload);
      global.socketIoInstance.to(`admin:${licenseKey}`).emit(eventName, payload);
    }
  } catch (err) {
    console.warn('[TableController] Socket broadcast error:', err.message);
  }
}

// ─── Floors ─────────────────────────────────────────────────────────────────

const getFloors = async (req, res) => {
  try {
    const [floors] = await pool.query('SELECT * FROM pos_floors WHERE (is_deleted = 0 OR is_deleted IS NULL) ORDER BY display_order ASC');
    return res.json({ success: true, data: floors });
  } catch (err) {
    console.error('[TableController] getFloors error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createFloor = async (req, res) => {
  try {
    const { name, display_order = 0 } = req.body;
    const [result] = await pool.query('INSERT INTO pos_floors (name, display_order) VALUES (?, ?)', [name, display_order]);
    const [rows] = await pool.query('SELECT * FROM pos_floors WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] createFloor error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateFloor = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, display_order } = req.body;
    await pool.query('UPDATE pos_floors SET name = ?, display_order = ? WHERE id = ?', [name, display_order, id]);
    const [rows] = await pool.query('SELECT * FROM pos_floors WHERE id = ?', [id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] updateFloor error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteFloor = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_floors SET is_deleted = 1 WHERE id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[TableController] deleteFloor error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Sections ───────────────────────────────────────────────────────────────

const getSections = async (req, res) => {
  try {
    const [sections] = await pool.query('SELECT * FROM pos_sections WHERE (is_deleted = 0 OR is_deleted IS NULL) ORDER BY display_order ASC');
    return res.json({ success: true, data: sections });
  } catch (err) {
    console.error('[TableController] getSections error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createSection = async (req, res) => {
  try {
    const { floor_id, name, display_order = 0 } = req.body;
    const [result] = await pool.query('INSERT INTO pos_sections (floor_id, name, display_order) VALUES (?, ?, ?)', [floor_id, name, display_order]);
    const [rows] = await pool.query('SELECT * FROM pos_sections WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] createSection error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateSection = async (req, res) => {
  try {
    const { id } = req.params;
    const { floor_id, name, display_order } = req.body;
    await pool.query('UPDATE pos_sections SET floor_id = ?, name = ?, display_order = ? WHERE id = ?', [floor_id, name, display_order, id]);
    const [rows] = await pool.query('SELECT * FROM pos_sections WHERE id = ?', [id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] updateSection error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteSection = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_sections SET is_deleted = 1 WHERE id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[TableController] deleteSection error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Tables ─────────────────────────────────────────────────────────────────

const getTables = async (req, res) => {
  try {
    const [tables] = await pool.query(`
      SELECT t.*, s.name as section_name, f.name as floor_name, f.id as floor_id
      FROM pos_tables t
      LEFT JOIN pos_sections s ON t.section_id = s.id
      LEFT JOIN pos_floors f ON s.floor_id = f.id
      WHERE (t.is_deleted = 0 OR t.is_deleted IS NULL)
      ORDER BY t.number ASC
    `);
    return res.json({ success: true, data: tables });
  } catch (err) {
    console.error('[TableController] getTables error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createTable = async (req, res) => {
  try {
    if (Array.isArray(req.body.tables)) {
      const created = [];
      for (const t of req.body.tables) {
        const { number, capacity = 4, section_id, status = 'available' } = t;
        const [result] = await pool.query(
          'INSERT INTO pos_tables (number, capacity, section_id, status) VALUES (?, ?, ?, ?)',
          [number, capacity, section_id || null, status]
        );
        const [rows] = await pool.query('SELECT * FROM pos_tables WHERE id = ?', [result.insertId]);
        if (rows[0]) created.push(rows[0]);
      }
      broadcastTenantEvent('table:updated', created[created.length - 1]);
      return res.status(201).json({ success: true, data: created });
    }

    const { number, capacity = 4, section_id, status = 'available' } = req.body;
    const [result] = await pool.query(
      'INSERT INTO pos_tables (number, capacity, section_id, status) VALUES (?, ?, ?, ?)',
      [number, capacity, section_id || null, status]
    );
    const [rows] = await pool.query('SELECT * FROM pos_tables WHERE id = ?', [result.insertId]);

    broadcastTenantEvent('table:updated', rows[0]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] createTable error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateTable = async (req, res) => {
  try {
    const { id } = req.params;
    const { number, capacity, section_id, status } = req.body;
    await pool.query(
      'UPDATE pos_tables SET number = ?, capacity = ?, section_id = ?, status = ? WHERE id = ?',
      [number, capacity, section_id || null, status, id]
    );
    const [rows] = await pool.query('SELECT * FROM pos_tables WHERE id = ?', [id]);

    broadcastTenantEvent('table:updated', rows[0]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] updateTable error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateTableStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await pool.query('UPDATE pos_tables SET status = ? WHERE id = ?', [status, id]);
    const [rows] = await pool.query('SELECT * FROM pos_tables WHERE id = ?', [id]);

    broadcastTenantEvent('table:statusChange', rows[0]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[TableController] updateTableStatus error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteTable = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_tables SET is_deleted = 1 WHERE id = ?', [id]);
    broadcastTenantEvent('table:deleted', { id });
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[TableController] deleteTable error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getFloors,
  createFloor,
  updateFloor,
  deleteFloor,
  getSections,
  createSection,
  updateSection,
  deleteSection,
  getTables,
  createTable,
  updateTable,
  updateTableStatus,
  deleteTable
};
