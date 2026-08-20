/**
 * customerController.js — Customer Directory & Order History REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getAllCustomers = async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT c.*, 
             COUNT(o.id) as total_orders,
             COALESCE(SUM(o.total), 0) as total_spent,
             MAX(o.created_at) as last_order_date
      FROM pos_customers c
      LEFT JOIN pos_orders o ON c.phone = o.customer_phone AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
      WHERE (c.is_deleted = 0 OR c.is_deleted IS NULL)
    `;
    const params = [];

    if (search) {
      query += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' GROUP BY c.id ORDER BY last_order_date DESC';

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[CustomerController] getAllCustomers error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const searchCustomers = async (req, res) => {
  try {
    const { query: searchQuery } = req.query;
    if (!searchQuery || !searchQuery.trim()) return res.json({ success: true, data: [] });
    const q = searchQuery.trim();

    // 1. Search registered Customers
    const [customers] = await pool.query(`
      SELECT c.id, c.name, c.phone, c.address, 'customer' as type,
             (SELECT COUNT(*) FROM pos_orders o WHERE o.customer_phone = c.phone AND (o.is_deleted = 0 OR o.is_deleted IS NULL)) as total_orders
      FROM pos_customers c
      WHERE (c.is_deleted = 0 OR c.is_deleted IS NULL) 
        AND (c.name LIKE ? OR c.phone LIKE ?) 
      ORDER BY total_orders DESC, c.name ASC LIMIT 6
    `, [`%${q}%`, `%${q}%`]);

    // 2. Search active Staff Members
    const [staffList] = await pool.query(`
      SELECT id as staff_id, name, phone, role, username, 'staff' as type
      FROM pos_staff
      WHERE status = 'Active'
        AND (phone LIKE ? OR name LIKE ? OR username LIKE ?)
      ORDER BY name ASC LIMIT 6
    `, [`%${q}%`, `%${q}%`, `%${q}%`]);

    const results = [
      ...customers.map(c => ({ ...c, is_staff: false })),
      ...staffList.map(s => ({
        id: `staff-${s.staff_id}`,
        staff_id: s.staff_id,
        name: s.name,
        phone: s.phone || '',
        role: s.role,
        username: s.username,
        type: 'staff',
        is_staff: true
      }))
    ];

    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('[CustomerController] searchCustomers error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getCustomerOrders = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone parameter is required' });

    const [rows] = await pool.query(`
      SELECT o.*, t.number as table_number
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      WHERE o.customer_phone = ? AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
      ORDER BY o.created_at DESC LIMIT 50
    `, [phone]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[CustomerController] getCustomerOrders error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllCustomers,
  searchCustomers,
  getCustomerOrders
};
