/**
 * financeController.js — Finance, Expenses, Payroll & P&L REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getSummary = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const sd = start_date || today;
    const ed = end_date || today;

    const [revenueRows] = await pool.query(`
      SELECT COALESCE(SUM(total), 0) as total_revenue, COUNT(id) as total_orders
      FROM pos_orders 
      WHERE DATE(created_at) BETWEEN ? AND ? AND status = 'completed'
    `, [sd, ed]);

    const [expenseRows] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_expenses, COUNT(id) as expense_count
      FROM pos_expenses
      WHERE DATE(created_at) BETWEEN ? AND ?
    `, [sd, ed]);

    const totalRevenue = revenueRows[0]?.total_revenue || 0;
    const totalExpenses = expenseRows[0]?.total_expenses || 0;
    const netProfit = totalRevenue - totalExpenses;

    return res.json({
      success: true,
      data: {
        total_revenue: totalRevenue,
        total_orders: revenueRows[0]?.total_orders || 0,
        total_expenses: totalExpenses,
        expense_count: expenseRows[0]?.expense_count || 0,
        net_profit: netProfit,
        period: { start: sd, end: ed }
      }
    });
  } catch (err) {
    console.error('[FinanceController] getSummary error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getRevenueChart = async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const [rows] = await pool.query(`
      SELECT DATE(created_at) as date, COALESCE(SUM(total), 0) as revenue, COUNT(id) as orders
      FROM pos_orders
      WHERE status = 'completed' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [days]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[FinanceController] getRevenueChart error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getExpenses = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let query = `
      SELECT e.*, s.name as staff_name 
      FROM pos_expenses e
      LEFT JOIN pos_staff s ON e.staff_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (start_date && end_date) {
      query += ' AND DATE(e.created_at) BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }

    query += ' ORDER BY e.created_at DESC';

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[FinanceController] getExpenses error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const addExpense = async (req, res) => {
  try {
    const { category = 'Other', description, amount, receipt_path } = req.body;
    const staffId = req.user?.id || null;

    if (!amount) return res.status(400).json({ success: false, error: 'Expense amount is required' });

    const [result] = await pool.query(`
      INSERT INTO pos_expenses (category, description, amount, staff_id, receipt_path, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [category, description || null, parseFloat(amount), staffId, receipt_path || null]);

    const [rows] = await pool.query('SELECT * FROM pos_expenses WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[FinanceController] addExpense error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pos_expenses WHERE id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[FinanceController] deleteExpense error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getPayroll = async (req, res) => {
  try {
    const { period_start, period_end } = req.query;
    let query = `
      SELECT p.*, s.name as staff_name, s.role as staff_role, s.salary_type, s.salary_amount
      FROM pos_payroll p
      JOIN pos_staff s ON p.staff_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (period_start && period_end) {
      query += ' AND p.period_start >= ? AND p.period_end <= ?';
      params.push(period_start, period_end);
    }

    query += ' ORDER BY p.period_end DESC, s.name ASC';

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[FinanceController] getPayroll error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const processPayroll = async (req, res) => {
  try {
    const { period_start, period_end } = req.body;
    if (!period_start || !period_end) {
      return res.status(400).json({ success: false, error: 'Period start and end dates are required' });
    }

    const [staffList] = await pool.query("SELECT * FROM pos_staff WHERE status = 'Active'");

    for (const staff of staffList) {
      const [att] = await pool.query(`
        SELECT COUNT(DISTINCT date) as days_present, 
               COALESCE(SUM(TIMESTAMPDIFF(MINUTE, clock_in, COALESCE(clock_out, clock_in))), 0) as total_minutes
        FROM pos_attendance
        WHERE staff_id = ? AND date BETWEEN ? AND ?
      `, [staff.id, period_start, period_end]);

      const daysPresent = att[0]?.days_present || 0;
      const totalMinutes = att[0]?.total_minutes || 0;
      const dutyHours = staff.daily_duty_hours || 8;
      const expectedMinutes = daysPresent * dutyHours * 60;
      const overtimeMinutes = Math.max(0, totalMinutes - expectedMinutes);
      const overtimeHours = Math.round((overtimeMinutes / 60) * 10) / 10;

      let baseSalary = staff.salary_amount || 0;
      let overtimeSalary = 0;
      let netPay = baseSalary;

      if (staff.salary_type === 'Hourly') {
        const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
        netPay = totalHours * baseSalary;
      } else {
        const hourlyRate = baseSalary / (30 * dutyHours);
        overtimeSalary = Math.round(overtimeHours * hourlyRate * 1.5);
        netPay = baseSalary + overtimeSalary;
      }

      // Query staff advances in current period
      const [advRows] = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total_advances
        FROM pos_expenses
        WHERE category = 'Advance' AND staff_id = ? AND DATE(created_at) BETWEEN ? AND ?
      `, [staff.id, period_start, period_end]);

      const totalAdvances = Number(advRows[0]?.total_advances || 0);
      netPay = Math.max(0, netPay - totalAdvances);

      await pool.query(`
        INSERT INTO pos_payroll 
        (staff_id, period_start, period_end, base_salary, days_present, overtime_hours, overtime_salary, net_pay, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
        ON DUPLICATE KEY UPDATE 
          base_salary = VALUES(base_salary), days_present = VALUES(days_present),
          overtime_hours = VALUES(overtime_hours), overtime_salary = VALUES(overtime_salary),
          net_pay = VALUES(net_pay)
      `, [staff.id, period_start, period_end, baseSalary, daysPresent, overtimeHours, overtimeSalary, netPay]);
    }

    const [rows] = await pool.query(`
      SELECT p.*, s.name as staff_name, s.role as staff_role
      FROM pos_payroll p
      JOIN pos_staff s ON p.staff_id = s.id
      WHERE p.period_start = ? AND p.period_end = ?
    `, [period_start, period_end]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[FinanceController] processPayroll error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const markPaid = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE pos_payroll SET status = 'Paid', paid_at = NOW() WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[FinanceController] markPaid error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getPL = async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const [monthlyRevenue] = await pool.query(`
      SELECT MONTH(created_at) as month, COALESCE(SUM(total), 0) as revenue
      FROM pos_orders
      WHERE YEAR(created_at) = ? AND status = 'completed'
      GROUP BY MONTH(created_at)
    `, [year]);

    const [monthlyExpenses] = await pool.query(`
      SELECT MONTH(created_at) as month, COALESCE(SUM(amount), 0) as expenses
      FROM pos_expenses
      WHERE YEAR(created_at) = ?
      GROUP BY MONTH(created_at)
    `, [year]);

    const months = [];
    for (let m = 1; m <= 12; m++) {
      const rev = monthlyRevenue.find(r => r.month === m)?.revenue || 0;
      const exp = monthlyExpenses.find(e => e.month === m)?.expenses || 0;
      months.push({
        month: m,
        revenue: rev,
        expenses: exp,
        net_profit: rev - exp
      });
    }

    return res.json({ success: true, data: months });
  } catch (err) {
    console.error('[FinanceController] getPL error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getStaffSalesReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const sd = start_date || today;
    const ed = end_date || today;

    const [summary] = await pool.query(`
      SELECT s.id as staff_id, s.name as staff_name, s.role as staff_role,
             COUNT(DISTINCT CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.id END) as order_count,
             COALESCE(SUM(CASE WHEN o.staff_id = s.id AND o.status = 'completed' THEN o.total ELSE 0 END), 0) as total_sales,
             COUNT(DISTINCT CASE WHEN o.dispatched_by = s.id AND o.status = 'completed' THEN o.id END) as dispatched_count,
             COUNT(DISTINCT CASE WHEN (COALESCE(o.settled_by, o.payment_received_by) = s.id) AND (o.payment_received = 1 OR o.status = 'completed') THEN o.id END) as settled_count,
             COALESCE(SUM(CASE WHEN (COALESCE(o.settled_by, o.payment_received_by) = s.id) AND (o.payment_received = 1 OR o.status = 'completed') THEN o.total ELSE 0 END), 0) as settled_sales
      FROM pos_staff s
      LEFT JOIN pos_orders o ON (o.staff_id = s.id OR o.dispatched_by = s.id OR COALESCE(o.settled_by, o.payment_received_by) = s.id)
        AND DATE(o.created_at) BETWEEN ? AND ?
      WHERE (s.is_deleted = 0 OR s.is_deleted IS NULL)
      GROUP BY s.id, s.name, s.role
      HAVING (order_count > 0 OR dispatched_count > 0 OR settled_count > 0)
      ORDER BY total_sales DESC, settled_sales DESC
    `, [sd, ed]);

    const [ordersRaw] = await pool.query(`
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
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_staff s_taken ON o.staff_id = s_taken.id
      LEFT JOIN pos_staff s_disp ON o.dispatched_by = s_disp.id
      LEFT JOIN pos_staff s_sett ON (COALESCE(o.settled_by, o.payment_received_by) = s_sett.id)
      WHERE o.status = 'completed' AND DATE(o.created_at) BETWEEN ? AND ?
      ORDER BY o.created_at DESC LIMIT 1000
    `, [sd, ed]);

    return res.json({ success: true, data: { summary: summary || [], orders: ordersRaw || [] } });
  } catch (err) {
    console.error('[FinanceController] getStaffSalesReport error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getSummary,
  getRevenueChart,
  getExpenses,
  addExpense,
  deleteExpense,
  getPayroll,
  processPayroll,
  markPaid,
  getPL,
  getStaffSalesReport
};
