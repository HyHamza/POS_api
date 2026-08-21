/**
 * reportController.js — Cloud Reporting API Endpoints for RestaurantOS POS_api
 * 
 * Multi-tenant report generation directly querying MySQL database for all 21 reports.
 * Fully compatible with MySQL ONLY_FULL_GROUP_BY and timezone offsets.
 */

'use strict';

const pool = require('../config/db');
const { asyncLocalStorage } = require('../config/db');

function getContext(req) {
  const store = asyncLocalStorage.getStore();
  const db = store?.pool || pool;
  const restaurantId = store?.restaurantId || req.query.restaurant_id || req.body?.restaurant_id || req.user?.restaurantId || 2;
  return { pool: db, restaurantId };
}

function getTodayRange() {
  const today = new Date().toISOString().slice(0, 10);
  return { start: today, end: today };
}

// ─── 1. Rider Wise Report ───────────────────────────────────────────────────
const getRiderWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, rider_name } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let summaryQuery = `
      SELECT 
        COALESCE(o.rider_name, 'Unassigned') as rider_name,
        COUNT(o.id) as total_orders,
        SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered_orders,
        SUM(CASE WHEN o.status = 'cancelled' OR (o.is_return IS NOT NULL AND o.is_return = 1) THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN o.status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) as active_orders,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total ELSE 0 END), 0) as total_sales,
        COALESCE(SUM(CASE WHEN o.status = 'completed' AND COALESCE(o.payment_method, 'Cash') = 'Cash' THEN o.total ELSE 0 END), 0) as cash_collected,
        COALESCE(AVG(CASE WHEN o.status = 'completed' THEN o.total ELSE NULL END), 0) as average_order_value
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND o.type = 'Delivery' AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (rider_name && rider_name !== 'All') {
      summaryQuery += ' AND o.rider_name = ?';
      params.push(rider_name);
    }
    summaryQuery += " GROUP BY COALESCE(o.rider_name, 'Unassigned') ORDER BY total_sales DESC";

    const [summary] = await pool.query(summaryQuery, params);

    let ordersQuery = `
      SELECT 
        o.id, o.order_number, o.created_at, o.customer_name, o.customer_phone,
        o.customer_address, o.status, o.total, o.payment_received,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        COALESCE(o.rider_name, 'Unassigned') as rider_name
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND o.type = 'Delivery' AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const orderParams = [restaurantId, sd, ed];
    if (rider_name && rider_name !== 'All') {
      ordersQuery += ' AND o.rider_name = ?';
      orderParams.push(rider_name);
    }
    ordersQuery += ' ORDER BY o.created_at DESC LIMIT 500';

    const [orders] = await pool.query(ordersQuery, orderParams);

    return res.json({
      success: true,
      data: { period: { start: sd, end: ed }, summary: summary || [], orders: orders || [] }
    });
  } catch (err) {
    console.error('getRiderWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 2. Custom Sales Report ─────────────────────────────────────────────────
const getCustomSales = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, order_type, status, staff_id, dispatched_by, settled_by, payment_method, min_amount, max_amount } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let query = `
      SELECT 
        o.id, o.order_number, o.type, o.created_at, o.status, o.subtotal, o.tax, o.discount, o.total,
        o.customer_name, o.customer_phone, o.customer_address, o.rider_name, o.payment_received,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        t.number as table_number,
        o.staff_id,
        COALESCE(o.staff_name, s.name, 'Admin') as staff_name,
        COALESCE(s.role, 'Staff') as staff_role,
        o.dispatched_by,
        COALESCE(o.dispatched_by_name, s_disp.name) as dispatched_by_name,
        COALESCE(o.dispatched_by_role, s_disp.role) as dispatched_by_role,
        o.dispatched_at,
        COALESCE(o.settled_by, o.payment_received_by) as settled_by,
        COALESCE(o.settled_by_name, s_sett.name) as settled_by_name,
        COALESCE(o.settled_by_role, s_sett.role) as settled_by_role,
        COALESCE(o.settled_at, o.payment_received_at) as settled_at
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      LEFT JOIN _pos_staff_base s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN _pos_staff_base s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.restaurant_id = ? AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (order_type && order_type !== 'All') {
      query += ' AND o.type = ?';
      params.push(order_type);
    }
    if (status && status !== 'All') {
      query += ' AND o.status = ?';
      params.push(status);
    }
    if (staff_id && staff_id !== 'All') {
      query += ' AND o.staff_id = ?';
      params.push(staff_id);
    }
    if (dispatched_by && dispatched_by !== 'All') {
      query += ' AND o.dispatched_by = ?';
      params.push(dispatched_by);
    }
    if (settled_by && settled_by !== 'All') {
      query += ' AND (COALESCE(o.settled_by, o.payment_received_by) = ?)';
      params.push(settled_by);
    }
    if (payment_method && payment_method !== 'All') {
      query += " AND COALESCE(o.payment_method, 'Cash') = ?";
      params.push(payment_method);
    }
    if (min_amount) {
      query += ' AND o.total >= ?';
      params.push(parseFloat(min_amount));
    }
    if (max_amount) {
      query += ' AND o.total <= ?';
      params.push(parseFloat(max_amount));
    }

    query += ' ORDER BY o.created_at DESC LIMIT 1000';
    const [orders] = await pool.query(query, params);

    let totalGross = 0, totalTax = 0, totalDiscount = 0, totalNet = 0;
    for (const ord of orders) {
      if (ord.status !== 'cancelled') {
        totalGross += parseFloat(ord.subtotal || 0);
        totalTax += parseFloat(ord.tax || 0);
        totalDiscount += parseFloat(ord.discount || 0);
        totalNet += parseFloat(ord.total || 0);
      }
    }

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_orders: orders.length,
        total_gross: totalGross,
        total_tax: totalTax,
        total_discount: totalDiscount,
        total_net: totalNet,
        average_order_value: orders.length > 0 ? totalNet / orders.length : 0,
        orders: orders || []
      }
    });
  } catch (err) {
    console.error('getCustomSales error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 3. Daily Sales Report ──────────────────────────────────────────────────
const getDailySales = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const [summaryRows] = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN subtotal ELSE 0 END), 0) as gross_sales,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN discount ELSE 0 END), 0) as total_discount,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN tax ELSE 0 END), 0) as total_tax,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) as net_sales,
        COALESCE(AVG(CASE WHEN status = 'completed' THEN total ELSE NULL END), 0) as average_ticket
      FROM _pos_orders_base
      WHERE restaurant_id = ? AND DATE(created_at) = ?
    `, [restaurantId, targetDate]);

    const [hourly] = await pool.query(`
      SELECT 
        HOUR(created_at) as hour,
        COUNT(id) as order_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) as total_sales
      FROM _pos_orders_base
      WHERE restaurant_id = ? AND DATE(created_at) = ?
      GROUP BY HOUR(created_at)
      ORDER BY hour ASC
    `, [restaurantId, targetDate]);

    const [byType] = await pool.query(`
      SELECT 
        type,
        COUNT(*) as order_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) as total_sales
      FROM _pos_orders_base
      WHERE restaurant_id = ? AND DATE(created_at) = ?
      GROUP BY type
    `, [restaurantId, targetDate]);

    const [topItems] = await pool.query(`
      SELECT 
        oi.name,
        COALESCE(MAX(mc.name), 'Other') as category_name,
        SUM(oi.quantity) as quantity_sold,
        SUM(oi.price * oi.quantity) as total_revenue
      FROM _pos_order_items_base oi
      JOIN _pos_orders_base o ON oi.order_id = o.id
      LEFT JOIN _pos_menu_items_base mi ON oi.menu_item_id = mi.id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id
      WHERE o.restaurant_id = ? AND DATE(o.created_at) = ? AND o.status = 'completed' AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
      GROUP BY oi.name
      ORDER BY total_revenue DESC
      LIMIT 10
    `, [restaurantId, targetDate]);

    return res.json({
      success: true,
      data: {
        date: targetDate,
        summary: summaryRows[0] || {},
        hourly: hourly || [],
        byType: byType || [],
        topItems: topItems || []
      }
    });
  } catch (err) {
    console.error('getDailySales error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 4. Item Wise Thermal Report ────────────────────────────────────────────
const getItemWiseThermal = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, category_id } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let query = `
      SELECT 
        oi.name,
        COALESCE(MAX(mc.name), (CASE WHEN MAX(oi.deal_id) IS NOT NULL THEN 'Deals' ELSE 'General' END)) as category_name,
        AVG(oi.price) as unit_price,
        SUM(oi.quantity) as total_qty,
        SUM(oi.price * oi.quantity) as total_amount
      FROM _pos_order_items_base oi
      JOIN _pos_orders_base o ON oi.order_id = o.id
      LEFT JOIN _pos_menu_items_base mi ON oi.menu_item_id = mi.id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id
      WHERE o.restaurant_id = ? AND o.status = 'completed' 
        AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
        AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (category_id && category_id !== 'All') {
      query += ' AND mi.category_id = ?';
      params.push(category_id);
    }

    query += ' GROUP BY oi.name ORDER BY total_amount DESC';
    const [items] = await pool.query(query, params);

    const totalQuantity = (items || []).reduce((acc, it) => acc + (parseFloat(it.total_qty) || 0), 0);
    const grandTotal = (items || []).reduce((acc, it) => acc + (parseFloat(it.total_amount) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_items_sold: totalQuantity,
        grand_total: grandTotal,
        items: items || []
      }
    });
  } catch (err) {
    console.error('getItemWiseThermal error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 5. Monthly Sales Report ────────────────────────────────────────────────
const getMonthlySales = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { year_month } = req.query;
    const targetMonth = year_month || new Date().toISOString().slice(0, 7);

    const [daysInMonth] = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        MAX(DAYNAME(created_at)) as day_of_week,
        COUNT(id) as total_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN subtotal ELSE 0 END), 0) as gross_sales,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN discount ELSE 0 END), 0) as discount,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN tax ELSE 0 END), 0) as tax,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) as net_sales
      FROM _pos_orders_base
      WHERE restaurant_id = ? AND DATE_FORMAT(created_at, '%Y-%m') = ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [restaurantId, targetMonth]);

    const [monthSummary] = await pool.query(`
      SELECT 
        COUNT(id) as total_orders,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN subtotal ELSE 0 END), 0) as total_gross,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN discount ELSE 0 END), 0) as total_discount,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN tax ELSE 0 END), 0) as total_tax,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) as total_net,
        COALESCE(AVG(CASE WHEN status = 'completed' THEN total ELSE NULL END), 0) as average_order_value
      FROM _pos_orders_base
      WHERE restaurant_id = ? AND DATE_FORMAT(created_at, '%Y-%m') = ?
    `, [restaurantId, targetMonth]);

    return res.json({
      success: true,
      data: {
        month: targetMonth,
        summary: monthSummary[0] || {},
        daily_breakdown: daysInMonth || []
      }
    });
  } catch (err) {
    console.error('getMonthlySales error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 6. Employee Wise Report ────────────────────────────────────────────────
const getEmployeeWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [employees] = await pool.query(`
      SELECT 
        s.id as staff_id,
        s.name as staff_name,
        s.role as staff_role,
        COUNT(DISTINCT CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.id END) as order_count,
        SUM(CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        COALESCE(SUM(CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.total ELSE 0 END), 0) as total_sales,
        COALESCE(SUM(CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.discount ELSE 0 END), 0) as total_discounts_given,
        COALESCE(AVG(CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.total ELSE NULL END), 0) as average_ticket,
        COUNT(DISTINCT CASE WHEN o.dispatched_by = s.id AND o.status = 'completed' THEN o.id END) as dispatched_count,
        COUNT(DISTINCT CASE WHEN (COALESCE(o.settled_by, o.payment_received_by) = s.id) AND (o.payment_received = 1 OR o.status = 'completed') THEN o.id END) as settled_count,
        COALESCE(SUM(CASE WHEN (COALESCE(o.settled_by, o.payment_received_by) = s.id) AND (o.payment_received = 1 OR o.status = 'completed') THEN o.total ELSE 0 END), 0) as settled_sales
      FROM _pos_staff_base s
      LEFT JOIN _pos_orders_base o ON (o.staff_id = s.id OR o.dispatched_by = s.id OR COALESCE(o.settled_by, o.payment_received_by) = s.id)
        AND o.restaurant_id = ? AND DATE(o.created_at) BETWEEN ? AND ?
      WHERE s.restaurant_id = ? AND (s.is_deleted = 0 OR s.is_deleted IS NULL)
      GROUP BY s.id, s.name, s.role
      ORDER BY total_sales DESC, settled_sales DESC
    `, [restaurantId, sd, ed, restaurantId]);

    const [orders] = await pool.query(`
      SELECT 
        o.id, o.order_number, o.created_at, o.updated_at, o.type, o.status,
        o.subtotal, o.tax, o.discount, o.total, o.notes, o.rider_name,
        o.customer_name, o.customer_phone, o.customer_address, o.payment_received,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        t.number as table_number,
        o.staff_id,
        COALESCE(o.staff_name, s_taken.name, 'Admin') as staff_name,
        COALESCE(s_taken.role, 'Staff') as staff_role,
        o.dispatched_by,
        COALESCE(o.dispatched_by_name, s_disp.name) as dispatched_by_name,
        COALESCE(o.dispatched_by_role, s_disp.role) as dispatched_by_role,
        o.dispatched_at,
        COALESCE(o.settled_by, o.payment_received_by) as settled_by,
        COALESCE(o.settled_by_name, s_sett.name) as settled_by_name,
        COALESCE(o.settled_by_role, s_sett.role) as settled_by_role,
        COALESCE(o.settled_at, o.payment_received_at) as settled_at
      FROM _pos_orders_base o
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      LEFT JOIN _pos_staff_base s_taken ON o.staff_id = s_taken.id
      LEFT JOIN _pos_staff_base s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN _pos_staff_base s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.restaurant_id = ? AND o.status = 'completed' AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.created_at DESC LIMIT 1000
    `, [restaurantId, sd, ed]);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        summary: employees || [],
        employees: employees || [],
        orders: orders || []
      }
    });
  } catch (err) {
    console.error('getEmployeeWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 7. Order Return Report ─────────────────────────────────────────────────
const getOrderReturn = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [returns] = await pool.query(`
      SELECT 
        o.id, o.order_number, o.type, o.created_at, o.updated_at,
        o.status, o.subtotal, o.tax, o.discount, o.total as return_amount,
        o.customer_name, o.customer_phone, o.notes as return_reason,
        s.name as staff_name, s.role as staff_role
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      WHERE o.restaurant_id = ? AND (o.is_return = 1 OR o.status = 'cancelled')
        AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.updated_at DESC
    `, [restaurantId, sd, ed]);

    const totalReturnAmount = (returns || []).reduce((acc, r) => acc + (parseFloat(r.return_amount) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_returns: returns.length,
        total_return_amount: totalReturnAmount,
        returns: returns || []
      }
    });
  } catch (err) {
    console.error('getOrderReturn error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 8. Customer Wise Report ────────────────────────────────────────────────
const getCustomerWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, min_orders } = req.query;
    const def = getTodayRange();
    const sd = start_date || '2020-01-01';
    const ed = end_date || def.end;

    const [customers] = await pool.query(`
      SELECT 
        COALESCE(o.customer_phone, 'Walk-in') as customer_phone,
        MAX(o.customer_name) as customer_name,
        MAX(o.customer_address) as customer_address,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total ELSE 0 END), 0) as total_spent,
        COALESCE(AVG(CASE WHEN o.status = 'completed' THEN o.total ELSE NULL END), 0) as average_order_value,
        MIN(DATE(o.created_at)) as first_order_date,
        MAX(DATE(o.created_at)) as last_order_date
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND o.customer_phone IS NOT NULL AND TRIM(o.customer_phone) != ''
        AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY o.customer_phone
      HAVING COUNT(o.id) >= ?
      ORDER BY total_spent DESC
    `, [restaurantId, sd, ed, parseInt(min_orders || 1, 10)]);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_customers: customers.length,
        customers: customers || []
      }
    });
  } catch (err) {
    console.error('getCustomerWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 9. Menu Wise Report ────────────────────────────────────────────────────
const getMenuWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [categories] = await pool.query(`
      SELECT 
        COALESCE(mc.id, 0) as category_id,
        COALESCE(mc.name, (CASE WHEN oi.deal_id IS NOT NULL THEN 'Deals' ELSE 'Uncategorized' END)) as category_name,
        COUNT(DISTINCT oi.name) as unique_items_count,
        SUM(oi.quantity) as total_quantity_sold,
        SUM(oi.price * oi.quantity) as total_revenue
      FROM _pos_order_items_base oi
      JOIN _pos_orders_base o ON oi.order_id = o.id
      LEFT JOIN _pos_menu_items_base mi ON oi.menu_item_id = mi.id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id
      WHERE o.restaurant_id = ? AND o.status = 'completed'
        AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
        AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY COALESCE(mc.id, 0), COALESCE(mc.name, (CASE WHEN oi.deal_id IS NOT NULL THEN 'Deals' ELSE 'Uncategorized' END))
      ORDER BY total_revenue DESC
    `, [restaurantId, sd, ed]);

    const totalRevenue = (categories || []).reduce((acc, c) => acc + (parseFloat(c.total_revenue) || 0), 0);
    for (const cat of categories) {
      cat.revenue_share_pct = totalRevenue > 0 ? ((cat.total_revenue / totalRevenue) * 100).toFixed(1) : '0.0';
    }

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_revenue: totalRevenue,
        categories: categories || []
      }
    });
  } catch (err) {
    console.error('getMenuWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 10. Hourly Sales Report ────────────────────────────────────────────────
const getHourlySales = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { date, start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || date || def.start;
    const ed = end_date || date || def.end;

    const [rows] = await pool.query(`
      SELECT 
        HOUR(o.created_at) as hour_of_day,
        COUNT(o.id) as order_count,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total ELSE 0 END), 0) as total_revenue,
        COALESCE(AVG(CASE WHEN o.status = 'completed' THEN o.total ELSE NULL END), 0) as average_order_value
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY HOUR(o.created_at)
      ORDER BY hour_of_day ASC
    `, [restaurantId, sd, ed]);

    const hourlyData = [];
    const rowMap = new Map();
    for (const r of rows) rowMap.set(r.hour_of_day, r);

    let peakHour = 0;
    let maxRevenue = 0;
    let totalDayRevenue = 0;

    for (let h = 0; h < 24; h++) {
      const found = rowMap.get(h) || { hour_of_day: h, order_count: 0, total_revenue: 0, average_order_value: 0 };
      const label = `${String(h).padStart(2, '0')}:00 - ${String((h + 1) % 24).padStart(2, '0')}:00`;
      const rev = parseFloat(found.total_revenue || 0);
      if (rev > maxRevenue) {
        maxRevenue = rev;
        peakHour = h;
      }
      totalDayRevenue += rev;
      hourlyData.push({
        hour: h,
        label,
        order_count: parseInt(found.order_count || 0, 10),
        total_revenue: rev,
        average_order_value: parseFloat(found.average_order_value || 0)
      });
    }

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        peak_hour: `${String(peakHour).padStart(2, '0')}:00`,
        total_revenue: totalDayRevenue,
        hourly: hourlyData
      }
    });
  } catch (err) {
    console.error('getHourlySales error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 11. Sub Menu Wise Report ───────────────────────────────────────────────
const getSubMenuWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, category_id } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let query = `
      SELECT 
        COALESCE(MAX(mc.name), (CASE WHEN MAX(oi.deal_id) IS NOT NULL THEN 'Deals' ELSE 'General' END)) as category_name,
        oi.name as item_name,
        oi.price as unit_price,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.price * oi.quantity) as total_sales,
        COUNT(DISTINCT oi.order_id) as order_appearances
      FROM _pos_order_items_base oi
      JOIN _pos_orders_base o ON oi.order_id = o.id
      LEFT JOIN _pos_menu_items_base mi ON oi.menu_item_id = mi.id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id
      WHERE o.restaurant_id = ? AND o.status = 'completed'
        AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
        AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (category_id && category_id !== 'All') {
      query += ' AND mi.category_id = ?';
      params.push(category_id);
    }

    query += ' GROUP BY oi.name, oi.price ORDER BY total_sales DESC';
    const [items] = await pool.query(query, params);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_items: items.length,
        items: items || []
      }
    });
  } catch (err) {
    console.error('getSubMenuWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 12. Void Wise Report ───────────────────────────────────────────────────
const getVoidWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [voidOrders] = await pool.query(`
      SELECT 
        o.id, o.order_number, o.created_at, o.type, o.status,
        o.total as voided_amount, o.notes as void_reason,
        s.name as staff_name, s.role as staff_role
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      WHERE o.restaurant_id = ? AND o.status = 'cancelled'
        AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.created_at DESC
    `, [restaurantId, sd, ed]);

    const totalVoidedAmount = (voidOrders || []).reduce((acc, v) => acc + (parseFloat(v.voided_amount) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_voids: voidOrders.length,
        total_voided_amount: totalVoidedAmount,
        voids: voidOrders || []
      }
    });
  } catch (err) {
    console.error('getVoidWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 13. Refund Wise Report ─────────────────────────────────────────────────
const getRefundWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [refunds] = await pool.query(`
      SELECT 
        o.id, o.order_number, o.created_at, o.updated_at as refund_date,
        o.total as refund_amount,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        o.customer_name, o.customer_phone, o.notes as refund_notes,
        s.name as staff_name
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      WHERE o.restaurant_id = ? AND (o.is_return = 1 OR o.status = 'cancelled')
        AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.updated_at DESC
    `, [restaurantId, sd, ed]);

    const totalRefunded = (refunds || []).reduce((acc, r) => acc + (parseFloat(r.refund_amount) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_refunds: refunds.length,
        total_refund_amount: totalRefunded,
        refunds: refunds || []
      }
    });
  } catch (err) {
    console.error('getRefundWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 14. Discount Wise Report ───────────────────────────────────────────────
const getDiscountWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [discounts] = await pool.query(`
      SELECT 
        o.id, o.order_number, o.created_at, o.subtotal, o.discount as discount_amount,
        o.tax, o.total, o.customer_name,
        s.name as staff_name, s.role as staff_role,
        ROUND((o.discount / NULLIF(o.subtotal, 0)) * 100, 1) as discount_percentage
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      WHERE o.restaurant_id = ? AND o.discount > 0 AND o.status != 'cancelled'
        AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.discount DESC
    `, [restaurantId, sd, ed]);

    const totalDiscountGiven = (discounts || []).reduce((acc, d) => acc + (parseFloat(d.discount_amount) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_discounted_orders: discounts.length,
        total_discount_given: totalDiscountGiven,
        discounts: discounts || []
      }
    });
  } catch (err) {
    console.error('getDiscountWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 15. MOP Wise Report (Method of Payment Summary) ────────────────────────
const getMopWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [methods] = await pool.query(`
      SELECT 
        COALESCE(o.payment_method, 'Cash') as payment_method,
        COUNT(o.id) as transaction_count,
        COALESCE(SUM(o.total), 0) as total_amount,
        COALESCE(AVG(o.total), 0) as average_transaction
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND o.status = 'completed'
        AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY COALESCE(o.payment_method, 'Cash')
      ORDER BY total_amount DESC
    `, [restaurantId, sd, ed]);

    const grandTotal = (methods || []).reduce((acc, m) => acc + (parseFloat(m.total_amount) || 0), 0);
    for (const m of methods) {
      m.share_pct = grandTotal > 0 ? ((m.total_amount / grandTotal) * 100).toFixed(1) : '0.0';
    }

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_collected: grandTotal,
        methods: methods || []
      }
    });
  } catch (err) {
    console.error('getMopWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 16. MOP Wise Detail Report (Itemized Transaction Register) ─────────────
const getMopWiseDetail = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date, payment_method } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let query = `
      SELECT 
        o.id, o.order_number, o.created_at, o.type, o.status,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        o.subtotal, o.tax, o.discount, o.total as amount_paid,
        o.customer_name, o.customer_phone,
        t.number as table_number,
        o.staff_id,
        COALESCE(o.staff_name, s.name, 'Admin') as staff_name,
        COALESCE(s.role, 'Staff') as staff_role,
        o.dispatched_by,
        COALESCE(o.dispatched_by_name, s_disp.name) as dispatched_by_name,
        COALESCE(o.dispatched_by_role, s_disp.role) as dispatched_by_role,
        o.dispatched_at,
        COALESCE(o.settled_by, o.payment_received_by) as settled_by,
        COALESCE(o.settled_by_name, s_sett.name) as settled_by_name,
        COALESCE(o.settled_by_role, s_sett.role) as settled_by_role,
        COALESCE(o.settled_at, o.payment_received_at) as settled_at
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      LEFT JOIN _pos_staff_base s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN _pos_staff_base s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.restaurant_id = ? AND o.status = 'completed'
        AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (payment_method && payment_method !== 'All') {
      query += " AND COALESCE(o.payment_method, 'Cash') = ?";
      params.push(payment_method);
    }

    query += ' ORDER BY o.created_at DESC LIMIT 1000';
    const [transactions] = await pool.query(query, params);

    const totalAmount = (transactions || []).reduce((acc, t) => acc + (parseFloat(t.amount_paid) || 0), 0);

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_transactions: transactions.length,
        total_amount: totalAmount,
        transactions: transactions || []
      }
    });
  } catch (err) {
    console.error('getMopWiseDetail error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 17. Order Type Wise Report ─────────────────────────────────────────────
const getOrderTypeWise = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { start_date, end_date } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    const [types] = await pool.query(`
      SELECT 
        o.type as order_type,
        COUNT(o.id) as total_orders,
        SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.subtotal ELSE 0 END), 0) as gross_revenue,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.discount ELSE 0 END), 0) as total_discount,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.tax ELSE 0 END), 0) as total_tax,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total ELSE 0 END), 0) as net_revenue,
        COALESCE(AVG(CASE WHEN o.status = 'completed' THEN o.total ELSE NULL END), 0) as average_ticket
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY o.type
      ORDER BY net_revenue DESC
    `, [restaurantId, sd, ed]);

    const grandTotal = (types || []).reduce((acc, t) => acc + (parseFloat(t.net_revenue) || 0), 0);
    for (const t of types) {
      t.share_pct = grandTotal > 0 ? ((t.net_revenue / grandTotal) * 100).toFixed(1) : '0.0';
    }

    return res.json({
      success: true,
      data: {
        period: { start: sd, end: ed },
        total_revenue: grandTotal,
        types: types || []
      }
    });
  } catch (err) {
    console.error('getOrderTypeWise error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 18. Inventory Reports ──────────────────────────────────────────────────
const getInventory = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { category } = req.query;

    let itemsQuery = `
      SELECT 
        id, name, category, unit, quantity, min_threshold, cost_per_unit,
        (quantity * cost_per_unit) as total_value,
        supplier_name, supplier_contact, updated_at
      FROM _pos_inventory_items_base
      WHERE restaurant_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
    `;
    const params = [restaurantId];
    if (category && category !== 'All') {
      itemsQuery += ' AND category = ?';
      params.push(category);
    }
    itemsQuery += ' ORDER BY name ASC';
    const [items] = await pool.query(itemsQuery, params);

    const lowStock = (items || []).filter(it => (parseFloat(it.quantity) || 0) <= (parseFloat(it.min_threshold) || 10));
    const totalValuation = (items || []).reduce((acc, it) => acc + (parseFloat(it.total_value) || 0), 0);

    const [logs] = await pool.query(`
      SELECT 
        l.id, l.created_at, l.change_type, l.quantity_change, l.reason,
        i.name as item_name, i.unit,
        s.name as staff_name
      FROM _pos_inventory_log_base l
      JOIN _pos_inventory_items_base i ON l.item_id = i.id
      LEFT JOIN _pos_staff_base s ON l.staff_id = s.id
      WHERE l.restaurant_id = ?
      ORDER BY l.created_at DESC LIMIT 50
    `, [restaurantId]);

    return res.json({
      success: true,
      data: {
        total_items: items.length,
        low_stock_count: lowStock.length,
        total_valuation: totalValuation,
        items: items || [],
        low_stock_items: lowStock || [],
        recent_logs: logs || []
      }
    });
  } catch (err) {
    console.error('getInventory error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 19. Customer Ledger ────────────────────────────────────────────────────
const getCustomerLedger = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { search, phone } = req.query;

    if (phone) {
      const [customers] = await pool.query(
        'SELECT * FROM _pos_customers_base WHERE restaurant_id = ? AND phone = ? LIMIT 1',
        [restaurantId, phone]
      );
      const customer = customers.length > 0 ? customers[0] : { phone, name: 'Customer' };

      const [orders] = await pool.query(`
        SELECT 
          id, order_number, created_at, type, status, total as debit,
          payment_received, COALESCE(payment_method, 'Cash') as payment_method
        FROM _pos_orders_base
        WHERE restaurant_id = ? AND customer_phone = ? AND status != 'cancelled'
        ORDER BY created_at DESC
      `, [restaurantId, phone]);

      let totalBilled = 0, totalPaid = 0;
      for (const ord of orders) {
        totalBilled += parseFloat(ord.debit || 0);
        if (ord.payment_received === 1) {
          totalPaid += parseFloat(ord.debit || 0);
        }
      }
      const balance = totalBilled - totalPaid;

      return res.json({
        success: true,
        data: {
          customer,
          total_billed: totalBilled,
          total_paid: totalPaid,
          current_balance: balance,
          transactions: orders || []
        }
      });
    }

    let query = `
      SELECT 
        o.customer_phone,
        MAX(o.customer_name) as customer_name,
        MAX(o.customer_address) as customer_address,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_billed,
        COALESCE(SUM(CASE WHEN o.payment_received = 1 THEN o.total ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN o.payment_received = 0 OR o.payment_received IS NULL THEN o.total ELSE 0 END), 0) as outstanding_balance,
        MAX(DATE(o.created_at)) as last_transaction_date
      FROM _pos_orders_base o
      WHERE o.restaurant_id = ? AND o.customer_phone IS NOT NULL AND TRIM(o.customer_phone) != '' AND o.status != 'cancelled'
    `;
    const params = [restaurantId];

    if (search) {
      query += ' AND (o.customer_phone LIKE ? OR o.customer_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' GROUP BY o.customer_phone ORDER BY outstanding_balance DESC, total_billed DESC';
    const [ledgers] = await pool.query(query, params);

    const totalReceivable = (ledgers || []).reduce((acc, l) => acc + (parseFloat(l.outstanding_balance) || 0), 0);

    return res.json({
      success: true,
      data: {
        total_accounts: ledgers.length,
        total_outstanding_receivable: totalReceivable,
        ledgers: ledgers || []
      }
    });
  } catch (err) {
    console.error('getCustomerLedger error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 20. Receipts Archive ───────────────────────────────────────────────────
const getReceipts = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { search, start_date, end_date, limit = 100, offset = 0 } = req.query;
    const def = getTodayRange();
    const sd = start_date || def.start;
    const ed = end_date || def.end;

    let query = `
      SELECT 
        o.id, o.order_number, o.created_at, o.type, o.status,
        o.subtotal, o.tax, o.discount, o.total,
        COALESCE(o.payment_method, 'Cash') as payment_method,
        o.payment_received, o.customer_name, o.customer_phone,
        t.number as table_number,
        o.staff_id,
        COALESCE(o.staff_name, s.name, 'Admin') as staff_name,
        COALESCE(s.role, 'Staff') as staff_role,
        o.dispatched_by,
        COALESCE(o.dispatched_by_name, s_disp.name) as dispatched_by_name,
        COALESCE(o.dispatched_by_role, s_disp.role) as dispatched_by_role,
        o.dispatched_at,
        COALESCE(o.settled_by, o.payment_received_by) as settled_by,
        COALESCE(o.settled_by_name, s_sett.name) as settled_by_name,
        COALESCE(o.settled_by_role, s_sett.role) as settled_by_role,
        COALESCE(o.settled_at, o.payment_received_at) as settled_at
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      LEFT JOIN _pos_staff_base s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN _pos_staff_base s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.restaurant_id = ? AND DATE(o.created_at) BETWEEN ? AND ?
    `;
    const params = [restaurantId, sd, ed];

    if (search) {
      query += ' AND (o.order_number LIKE ? OR o.customer_phone LIKE ? OR o.customer_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const [receipts] = await pool.query(query, params);

    return res.json({
      success: true,
      data: { period: { start: sd, end: ed }, receipts: receipts || [] }
    });
  } catch (err) {
    console.error('getReceipts error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── 21. Single Receipt Detail ──────────────────────────────────────────────
const getReceiptDetails = async (req, res) => {
  try {
    const { pool, restaurantId } = getContext(req);
    const { id } = req.params;

    const [rows] = await pool.query(`
      SELECT 
        o.*, 
        COALESCE(o.staff_name, s.name, 'Admin') as staff_name, 
        COALESCE(s.role, 'Staff') as staff_role,
        t.number as table_number, sec.name as section_name, fl.name as floor_name,
        COALESCE(o.dispatched_by_name, s_disp.name) as dispatched_by_name,
        COALESCE(o.dispatched_by_role, s_disp.role) as dispatched_by_role,
        COALESCE(o.settled_by_name, s_sett.name) as settled_by_name,
        COALESCE(o.settled_by_role, s_sett.role) as settled_by_role
      FROM _pos_orders_base o
      LEFT JOIN _pos_staff_base s ON o.staff_id = s.id
      LEFT JOIN _pos_tables_base t ON o.table_id = t.id
      LEFT JOIN _pos_sections_base sec ON t.section_id = sec.id
      LEFT JOIN _pos_floors_base fl ON sec.floor_id = fl.id
      LEFT JOIN _pos_staff_base s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN _pos_staff_base s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.restaurant_id = ? AND o.id = ?
    `, [restaurantId, id]);

    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Receipt not found' });
    const order = rows[0];

    const [items] = await pool.query(`
      SELECT oi.*, COALESCE(mc.name, 'General') as category_name
      FROM _pos_order_items_base oi
      LEFT JOIN _pos_menu_items_base mi ON oi.menu_item_id = mi.id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id
      WHERE oi.order_id = ? AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
    `, [id]);

    order.items = items || [];
    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('getReceiptDetails error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getRiderWise,
  getCustomSales,
  getDailySales,
  getItemWiseThermal,
  getMonthlySales,
  getEmployeeWise,
  getOrderReturn,
  getCustomerWise,
  getMenuWise,
  getHourlySales,
  getSubMenuWise,
  getVoidWise,
  getRefundWise,
  getDiscountWise,
  getMopWise,
  getMopWiseDetail,
  getOrderTypeWise,
  getInventory,
  getCustomerLedger,
  getReceipts,
  getReceiptDetails
};
