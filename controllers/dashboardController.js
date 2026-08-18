/**
 * dashboardController.js — Dashboard Aggregation REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getDashboardData = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    const revenueCondition = "status != 'cancelled' AND (is_deleted = 0 OR is_deleted IS NULL)";

    const [todayRev] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) as v, COUNT(id) as c FROM pos_orders WHERE DATE(created_at) = ? AND ${revenueCondition}`,
      [today]
    );

    const [yesterdayRev] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) as v FROM pos_orders WHERE DATE(created_at) = ? AND ${revenueCondition}`,
      [yesterday]
    );

    const [monthRev] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) as v FROM pos_orders WHERE DATE(created_at) >= ? AND ${revenueCondition}`,
      [monthStart]
    );

    const [totalOrders] = await pool.query(
      `SELECT COUNT(id) as v FROM pos_orders WHERE status != 'cancelled' AND (is_deleted = 0 OR is_deleted IS NULL)`
    );

    const todaySales = todayRev[0]?.v || 0;
    const todayOrdersCount = todayRev[0]?.c || 0;
    const avgOrderValue = todayOrdersCount > 0 ? todaySales / todayOrdersCount : 0;

    const kpis = {
      today_revenue: todaySales,
      today_orders: todayOrdersCount,
      total_orders: totalOrders[0]?.v || 0,
      yesterday_revenue: yesterdayRev[0]?.v || 0,
      month_revenue: monthRev[0]?.v || 0,
      avg_order_value: avgOrderValue
    };

    const [byType] = await pool.query(`
      SELECT type, COUNT(id) as count 
      FROM pos_orders 
      WHERE DATE(created_at) = ? AND status != 'cancelled' AND (is_deleted = 0 OR is_deleted IS NULL)
      GROUP BY type
    `, [today]);

    const [topItems] = await pool.query(`
      SELECT oi.name, SUM(oi.quantity) as qty
      FROM pos_order_items oi
      JOIN pos_orders o ON oi.order_id = o.id
      WHERE DATE(o.created_at) = ? AND o.status != 'cancelled' AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5
    `, [today]);

    const days = parseInt(req.query.days || '7', 10);
    const [revenueChart] = await pool.query(`
      SELECT DATE(created_at) as date, COALESCE(SUM(total), 0) as revenue
      FROM pos_orders 
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND ${revenueCondition}
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [days]);

    const [recentOrders] = await pool.query(`
      SELECT o.*, t.number as table_number, s.name as section_name
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_sections s ON t.section_id = s.id
      WHERE (o.is_deleted = 0 OR o.is_deleted IS NULL)
      ORDER BY o.created_at DESC LIMIT 10
    `);

    const [onDuty] = await pool.query(`
      SELECT s.id, s.name, s.role, MIN(a.clock_in) as clock_in
      FROM pos_staff s
      JOIN pos_attendance a ON s.id = a.staff_id
      WHERE a.clock_out IS NULL
        AND (a.is_deleted IS NULL OR a.is_deleted = 0)
        AND (s.is_deleted IS NULL OR s.is_deleted = 0)
        AND s.status = 'Active'
      GROUP BY s.id, s.name, s.role
      ORDER BY MIN(a.clock_in) ASC
    `);

    const [lowStock] = await pool.query(`
      SELECT * FROM pos_inventory_items
      WHERE quantity <= min_threshold AND (is_deleted = 0 OR is_deleted IS NULL)
      ORDER BY quantity ASC LIMIT 10
    `);

    return res.json({
      success: true,
      data: {
        kpis,
        byType,
        topItems,
        revenueChart,
        recentOrders,
        onDuty,
        lowStock
      }
    });
  } catch (err) {
    console.error('[DashboardController] getDashboardData error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getDashboardData
};
