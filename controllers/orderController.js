/**
 * orderController.js — Cloud REST Order Controller for POS_api
 */

'use strict';

const pool = require('../config/db');
const { asyncLocalStorage } = require('../config/db');

// Helper to emit Socket.IO events to tenant room
async function broadcastTenantEvent(eventName, payload) {
  try {
    const store = asyncLocalStorage.getStore();
    const licenseKey = store?.licenseKey;
    if (licenseKey && global.socketIoInstance) {
      global.socketIoInstance.to(`pos_clients:${licenseKey}`).emit(eventName, payload);
      global.socketIoInstance.to(`admin:${licenseKey}`).emit(eventName, payload);
    }
  } catch (err) {
    console.warn('[OrderController] Socket broadcast error:', err.message);
  }
}

// Helper to fetch order items with deals breakdown
async function getOrderItems(orderId) {
  const [rawItems] = await pool.query(`
    SELECT oi.*, 
           COALESCE(oi.notes, mi.description, d.description, (SELECT description FROM pos_menu_items WHERE name = oi.name AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1)) as description,
           COALESCE(mi.category_id, (SELECT category_id FROM pos_menu_items WHERE name = oi.name AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1)) as category_id,
           COALESCE(mc.name, (CASE WHEN oi.deal_id IS NOT NULL THEN 'Deals' ELSE NULL END)) as category_name,
           d.name as deal_name
    FROM pos_order_items oi
    LEFT JOIN pos_menu_items mi ON oi.menu_item_id = mi.id
    LEFT JOIN pos_deals d ON oi.deal_id = d.id
    LEFT JOIN pos_menu_categories mc ON COALESCE(mi.category_id, (SELECT category_id FROM pos_menu_items WHERE name = oi.name AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1)) = mc.id
    WHERE oi.order_id = ? AND (oi.is_deleted = 0 OR oi.is_deleted IS NULL)
  `, [orderId]);

  const itemsWithDeals = [];
  for (const item of rawItems) {
    let resolvedDealId = item.deal_id;
    if (!resolvedDealId && (!item.menu_item_id || item.category_name === 'Deals')) {
      const [foundDeals] = await pool.query(
        'SELECT id, name, description FROM pos_deals WHERE name = ? AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1',
        [item.name]
      );
      if (foundDeals.length > 0) {
        resolvedDealId = foundDeals[0].id;
        item.deal_id = resolvedDealId;
      }
    }

    if (resolvedDealId) {
      try {
        const [dealSubItems] = await pool.query(`
          SELECT di.quantity, mi.name, mi.price, mi.category_id, mc.name as category_name
          FROM pos_deal_items di
          JOIN pos_menu_items mi ON di.menu_item_id = mi.id
          LEFT JOIN pos_menu_categories mc ON mi.category_id = mc.id
          WHERE di.deal_id = ? AND (di.is_deleted = 0 OR di.is_deleted IS NULL)
        `, [resolvedDealId]);

        if (dealSubItems.length > 0) {
          item.deal_items = dealSubItems.map(di => ({
            name: di.name,
            quantity: di.quantity,
            price: di.price,
            category_name: di.category_name
          }));
          const summary = dealSubItems.map(di => `${di.quantity}x ${di.name}`).join(', ');
          item.deal_summary = summary;
          item.is_deal = true;
          if (!item.description || item.description.trim() === '' || item.description === item.notes) {
            item.description = summary;
          }
        }
      } catch (dealErr) {
        console.warn('[OrderController] Error fetching deal sub-items:', dealErr.message);
      }
    }
    itemsWithDeals.push(item);
  }

  return itemsWithDeals;
}

// ─── Get all orders ───────────────────────────────────────────────────────────
const getAllOrders = async (req, res) => {
  try {
    const { status, type, date, limit = 100, offset = 0 } = req.query;
    let query = `
      SELECT o.*, t.number as table_number, s.name as staff_name, s.role as staff_role, sec.name as section_name, fl.name as floor_name
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_sections sec ON t.section_id = sec.id
      LEFT JOIN pos_floors fl ON sec.floor_id = fl.id
      LEFT JOIN pos_staff s ON o.staff_id = s.id
      WHERE (o.is_deleted = 0 OR o.is_deleted IS NULL)
    `;
    const params = [];

    if (status) { query += ' AND o.status = ?'; params.push(status); }
    if (type) { query += ' AND o.type = ?'; params.push(type); }
    if (date) { query += ' AND DATE(o.created_at) = ?'; params.push(date); }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const [orders] = await pool.query(query, params);

    for (const order of orders) {
      order.items = await getOrderItems(order.id);
    }

    return res.json({ success: true, data: orders });
  } catch (err) {
    console.error('[OrderController] getAllOrders error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Get order by ID ─────────────────────────────────────────────────────────
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT o.*, t.number as table_number, s.name as staff_name, s.role as staff_role, sec.name as section_name, fl.name as floor_name
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_sections sec ON t.section_id = sec.id
      LEFT JOIN pos_floors fl ON sec.floor_id = fl.id
      LEFT JOIN pos_staff s ON o.staff_id = s.id
      WHERE o.id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = rows[0];
    order.items = await getOrderItems(order.id);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] getOrderById error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Get held orders ──────────────────────────────────────────────────────────
const getHeldOrders = async (req, res) => {
  try {
    const [orders] = await pool.query(`
      SELECT o.*, t.number as table_number, sec.name as section_name, fl.name as floor_name
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_sections sec ON t.section_id = sec.id
      LEFT JOIN pos_floors fl ON sec.floor_id = fl.id
      WHERE o.status = 'held' AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
      ORDER BY o.created_at DESC
    `);

    for (const order of orders) {
      order.items = await getOrderItems(order.id);
    }

    return res.json({ success: true, data: orders });
  } catch (err) {
    console.error('[OrderController] getHeldOrders error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Get recent orders ────────────────────────────────────────────────────────
const getRecentOrders = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const [orders] = await pool.query(`
      SELECT o.*, t.number as table_number, s.name as staff_name, s.role as staff_role, sec.name as section_name, fl.name as floor_name
      FROM pos_orders o
      LEFT JOIN pos_tables t ON o.table_id = t.id
      LEFT JOIN pos_sections sec ON t.section_id = sec.id
      LEFT JOIN pos_floors fl ON sec.floor_id = fl.id
      LEFT JOIN pos_staff s ON o.staff_id = s.id
      WHERE o.status != 'held' AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
      ORDER BY o.created_at DESC LIMIT ?
    `, [limit]);

    return res.json({ success: true, data: orders });
  } catch (err) {
    console.error('[OrderController] getRecentOrders error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Create new order ─────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const {
      type = 'Dine-In',
      table_id,
      staff_id,
      customer_name,
      customer_phone,
      customer_address,
      items = [],
      subtotal = 0,
      tax = 0,
      discount = 0,
      total = 0,
      notes,
      status = 'pending',
    } = req.body;

    await conn.beginTransaction();

    // 1. Resolve order prefix from settings
    const [settingRows] = await conn.query("SELECT `value` FROM pos_settings WHERE `key` = 'orderPrefix' LIMIT 1");
    const prefix = settingRows.length > 0 ? (settingRows[0].value || 'ORD') : 'ORD';

    // 2. Generate daily sequential order number (atomic with FOR UPDATE lock)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [lastOrderRows] = await conn.query(
      'SELECT order_number FROM pos_orders WHERE order_number LIKE ? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [`${prefix}-${today}-%`]
    );

    let seq = 1;
    if (lastOrderRows.length > 0 && lastOrderRows[0].order_number) {
      const parts = lastOrderRows[0].order_number.split('-');
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const orderNumber = `${prefix}-${today}-${String(seq).padStart(4, '0')}`;

    // 3. Resolve foreign keys
    let resolvedTableId = null;
    if (table_id) {
      const [tableExists] = await conn.query('SELECT id FROM pos_tables WHERE id = ?', [table_id]);
      if (tableExists.length > 0) resolvedTableId = table_id;
    }

    let resolvedStaffId = req.user?.id || staff_id || null;
    if (resolvedStaffId) {
      const [staffExists] = await conn.query('SELECT id FROM pos_staff WHERE id = ?', [resolvedStaffId]);
      if (staffExists.length === 0) resolvedStaffId = null;
    }

    const paymentReceived = status === 'completed' ? 1 : 0;
    const paymentReceivedAt = status === 'completed' ? new Date() : null;
    const paymentReceivedBy = status === 'completed' ? resolvedStaffId : null;

    // 4. Insert Order
    const [orderResult] = await conn.query(`
      INSERT INTO pos_orders 
      (order_number, type, table_id, staff_id, customer_name, customer_phone, 
       customer_address, subtotal, tax, discount, total, notes, status,
       payment_received, payment_received_at, payment_received_by,
       created_at, updated_at, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)
    `, [
      orderNumber, type, resolvedTableId, resolvedStaffId,
      customer_name || null, customer_phone || null,
      customer_address || null, subtotal, tax, discount, total, notes || null, status,
      paymentReceived, paymentReceivedAt, paymentReceivedBy
    ]);

    const orderId = orderResult.insertId;

    // 5. Insert Order Items & deduct inventory
    for (const item of items) {
      let resolvedMenuItemId = item.menu_item_id || null;
      let resolvedDealId = item.deal_id || null;

      if (!resolvedDealId && (item.is_deal || item.category_name === 'Deals' || item.deal_items)) {
        const [dealRows] = await conn.query('SELECT id FROM pos_deals WHERE name = ? LIMIT 1', [item.name]);
        if (dealRows.length > 0) resolvedDealId = dealRows[0].id;
      }

      await conn.query(`
        INSERT INTO pos_order_items (order_id, menu_item_id, deal_id, name, price, quantity, notes, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `, [orderId, resolvedMenuItemId, resolvedDealId, item.name, item.price, item.quantity || 1, item.notes || null]);

      // Deduct inventory if not held
      if (status !== 'held') {
        if (resolvedDealId) {
          const [dealItems] = await conn.query(`
            SELECT di.quantity as deal_qty, mi.name as item_name
            FROM pos_deal_items di
            JOIN pos_menu_items mi ON di.menu_item_id = mi.id
            WHERE di.deal_id = ? AND (di.is_deleted = 0 OR di.is_deleted IS NULL)
          `, [resolvedDealId]);

          for (const dItem of dealItems) {
            const deductQty = (dItem.deal_qty || 1) * (item.quantity || 1);
            const [invRows] = await conn.query('SELECT id, quantity FROM pos_inventory_items WHERE name = ? LIMIT 1', [dItem.item_name]);
            if (invRows.length > 0) {
              const inv = invRows[0];
              await conn.query('UPDATE pos_inventory_items SET quantity = quantity - ?, updated_at = NOW() WHERE id = ?', [deductQty, inv.id]);
              await conn.query(
                'INSERT INTO pos_inventory_log (item_id, change_type, quantity_change, reason, staff_id, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                [inv.id, 'Sale (Deal)', -deductQty, `Sale: Deal #${orderNumber} (${item.name})`, resolvedStaffId]
              );
            }
          }
        }
      }
    }

    // 6. Update Table Status if Dine-In
    if (type === 'Dine-In' && resolvedTableId && status !== 'held') {
      const targetStatus = (status === 'completed' || status === 'cancelled') ? 'available' : 'occupied';
      await conn.query('UPDATE pos_tables SET status = ? WHERE id = ?', [targetStatus, resolvedTableId]);
    }

    await conn.commit();

    // 7. Fetch newly created order with relations
    const [newOrderRows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [orderId]);
    const newOrder = newOrderRows[0];
    newOrder.items = await getOrderItems(orderId);

    // 8. Broadcast real-time Socket.IO event to all terminals
    if (status !== 'held') {
      broadcastTenantEvent('order:new', newOrder);
    }

    return res.status(201).json({ success: true, data: newOrder });
  } catch (err) {
    await conn.rollback();
    console.error('[OrderController] createOrder error:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

// ─── Update Order Status ──────────────────────────────────────────────────────
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    await pool.query('UPDATE pos_orders SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = rows[0];
    order.items = await getOrderItems(order.id);

    // Free table if completed or cancelled
    if (['completed', 'cancelled'].includes(status) && order.table_id) {
      await pool.query("UPDATE pos_tables SET status = 'available' WHERE id = ?", [order.table_id]);
    }

    // Broadcast to connected web terminals & KDS screens
    broadcastTenantEvent('order:updated', order);
    broadcastTenantEvent('kds:statusChange', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] updateOrderStatus error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Hold Order ───────────────────────────────────────────────────────────────
const holdOrder = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE pos_orders SET status = 'held', updated_at = NOW() WHERE id = ?", [id]);
    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = rows[0];
    order.items = await getOrderItems(id);

    broadcastTenantEvent('order:updated', order);
    broadcastTenantEvent('kds:statusChange', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] holdOrder error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Unhold Order ─────────────────────────────────────────────────────────────
const unholdOrder = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE pos_orders SET status = 'pending', updated_at = NOW() WHERE id = ?", [id]);
    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = rows[0];
    order.items = await getOrderItems(id);

    broadcastTenantEvent('order:updated', order);
    broadcastTenantEvent('kds:statusChange', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] unholdOrder error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Mark Payment Received ───────────────────────────────────────────────────
const markPaymentReceived = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id || req.body.staffId || null;
    const paymentMethod = req.body.paymentMethod || 'Cash';

    await pool.query(`
      UPDATE pos_orders 
      SET payment_received = 1,
          payment_received_at = NOW(),
          payment_received_by = ?,
          payment_method = ?,
          status = CASE WHEN status = 'pending' THEN 'completed' ELSE status END,
          updated_at = NOW()
      WHERE id = ?
    `, [staffId, paymentMethod, id]);

    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = rows[0];
    order.items = await getOrderItems(id);

    broadcastTenantEvent('order:paymentReceived', order);
    broadcastTenantEvent('order:updated', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] markPaymentReceived error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Get Cashier Stats ────────────────────────────────────────────────────────
const getCashierStats = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const [salesSummary] = await pool.query(`
      SELECT 
        COALESCE(SUM(total), 0) as total_sales,
        COUNT(id) as total_orders,
        COALESCE(SUM(CASE WHEN payment_received = 1 THEN total ELSE 0 END), 0) as paid_sales,
        COALESCE(SUM(CASE WHEN payment_received = 0 THEN total ELSE 0 END), 0) as unpaid_sales
      FROM pos_orders
      WHERE DATE(created_at) = ? AND (is_deleted = 0 OR is_deleted IS NULL) AND status != 'cancelled'
    `, [targetDate]);

    const [mopBreakdown] = await pool.query(`
      SELECT 
        COALESCE(payment_method, 'Cash') as payment_method,
        COUNT(id) as order_count,
        COALESCE(SUM(total), 0) as total_amount
      FROM pos_orders
      WHERE DATE(created_at) = ? AND (is_deleted = 0 OR is_deleted IS NULL) AND payment_received = 1 AND status != 'cancelled'
      GROUP BY COALESCE(payment_method, 'Cash')
    `, [targetDate]);

    return res.json({
      success: true,
      data: {
        date: targetDate,
        summary: salesSummary[0] || {},
        mopBreakdown
      }
    });
  } catch (err) {
    console.error('[OrderController] getCashierStats error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Assign Rider ─────────────────────────────────────────────────────────────
const assignRider = async (req, res) => {
  try {
    const { id } = req.params;
    const { rider_id, rider_name } = req.body;

    await pool.query('UPDATE pos_orders SET rider_name = ?, updated_at = NOW() WHERE id = ?', [rider_name, id]);
    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = rows[0];
    order.items = await getOrderItems(id);

    broadcastTenantEvent('order:updated', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] assignRider error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Return / Void Order ──────────────────────────────────────────────────────
const returnOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, return_type = 'void' } = req.body;

    await pool.query(`
      UPDATE pos_orders 
      SET is_return = 1, return_reason = ?, return_type = ?, status = 'cancelled', updated_at = NOW() 
      WHERE id = ?
    `, [reason || 'Returned', return_type, id]);

    const [rows] = await pool.query('SELECT * FROM pos_orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = rows[0];
    order.items = await getOrderItems(id);

    broadcastTenantEvent('order:returned', order);
    broadcastTenantEvent('order:updated', order);

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[OrderController] returnOrder error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllOrders,
  getOrderById,
  getHeldOrders,
  getRecentOrders,
  createOrder,
  updateOrderStatus,
  holdOrder,
  unholdOrder,
  markPaymentReceived,
  getCashierStats,
  assignRider,
  returnOrder,
  getOrderItems
};
