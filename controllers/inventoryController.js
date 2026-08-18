/**
 * inventoryController.js — Inventory Management REST Controller for POS_api
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
    console.warn('[InventoryController] Socket broadcast error:', err.message);
  }
}

const getAllItems = async (req, res) => {
  try {
    const [items] = await pool.query(`
      SELECT * FROM pos_inventory_items 
      WHERE (is_deleted = 0 OR is_deleted IS NULL)
      ORDER BY name ASC
    `);
    return res.json({ success: true, data: items });
  } catch (err) {
    console.error('[InventoryController] getAllItems error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createItem = async (req, res) => {
  try {
    const { name, category = 'General', unit = 'pieces', quantity = 0, min_threshold = 10, cost_per_unit = 0, supplier_name, supplier_contact } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Item name is required' });

    const [result] = await pool.query(`
      INSERT INTO pos_inventory_items 
      (name, category, unit, quantity, min_threshold, cost_per_unit, supplier_name, supplier_contact, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [name, category, unit, quantity, min_threshold, cost_per_unit, supplier_name || null, supplier_contact || null]);

    const [rows] = await pool.query('SELECT * FROM pos_inventory_items WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[InventoryController] createItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, unit, quantity, min_threshold, cost_per_unit, supplier_name, supplier_contact } = req.body;

    await pool.query(`
      UPDATE pos_inventory_items 
      SET name = ?, category = ?, unit = ?, quantity = ?, min_threshold = ?, 
          cost_per_unit = ?, supplier_name = ?, supplier_contact = ?, updated_at = NOW()
      WHERE id = ?
    `, [name, category, unit, quantity, min_threshold, cost_per_unit, supplier_name || null, supplier_contact || null, id]);

    const [rows] = await pool.query('SELECT * FROM pos_inventory_items WHERE id = ?', [id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[InventoryController] updateItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const adjustStock = async (req, res) => {
  try {
    const { item_id, quantity_change, change_type = 'Manual Adjustment', reason } = req.body;
    const staffId = req.user?.id || null;

    if (!item_id || quantity_change === undefined) {
      return res.status(400).json({ success: false, error: 'Item ID and quantity change are required' });
    }

    await pool.query(
      'UPDATE pos_inventory_items SET quantity = quantity + ?, updated_at = NOW() WHERE id = ?',
      [quantity_change, item_id]
    );

    await pool.query(`
      INSERT INTO pos_inventory_log (item_id, change_type, quantity_change, reason, staff_id, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [item_id, change_type, quantity_change, reason || null, staffId]);

    const [rows] = await pool.query('SELECT * FROM pos_inventory_items WHERE id = ?', [item_id]);
    const updated = rows[0];

    // Check low stock
    if (updated && updated.quantity <= updated.min_threshold) {
      broadcastTenantEvent('inventory:lowStock', updated);
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[InventoryController] adjustStock error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getLog = async (req, res) => {
  try {
    const { item_id, limit = 100 } = req.query;
    let query = `
      SELECT l.*, i.name as item_name, i.unit, s.name as staff_name
      FROM pos_inventory_log l
      JOIN pos_inventory_items i ON l.item_id = i.id
      LEFT JOIN pos_staff s ON l.staff_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (item_id) {
      query += ' AND l.item_id = ?';
      params.push(item_id);
    }

    query += ' ORDER BY l.created_at DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[InventoryController] getLog error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getLowStock = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM pos_inventory_items 
      WHERE quantity <= min_threshold AND (is_deleted = 0 OR is_deleted IS NULL)
      ORDER BY quantity ASC
    `);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[InventoryController] getLowStock error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_inventory_items SET is_deleted = 1 WHERE id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[InventoryController] deleteItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllItems,
  createItem,
  updateItem,
  adjustStock,
  getLog,
  getLowStock,
  deleteItem
};
