/**
 * dealController.js — Cloud API Deal & Combo Management
 * Authoritative controller for creating, updating, toggling, and listing deals.
 */

'use strict';

const pool = require('../config/db');
const hlcLib = require('../utils/hlc');
const logger = require('../utils/logger');

// Helper to get current restaurant_id
function getRestaurantId(req) {
  const { asyncLocalStorage } = require('../config/db');
  const store = asyncLocalStorage.getStore();
  return store?.restaurantId || req.user?.restaurant_id || req.user?.restaurantId || null;
}

// Helper to broadcast deal changes
async function broadcastDealChange(restaurantId, eventName, dealData) {
  try {
    if (restaurantId && global.socketIoInstance) {
      const [rows] = await pool.query('SELECT license_key FROM restaurants WHERE id = ?', [restaurantId]);
      if (rows.length > 0) {
        const licenseKey = rows[0].license_key;
        const io = global.socketIoInstance;
        io.to(`admin:${licenseKey}`).emit(eventName, dealData);
        io.to(`pos_clients:${licenseKey}`).emit(eventName, dealData);
        io.to(`pos_clients:${licenseKey}`).emit('sync_push', { type: 'deal_sync', data: dealData });
      }
    }
  } catch (err) {
    console.error('[DealController Broadcast Error]:', err.message);
  }
}

/**
 * GET /api/deals
 * Query params: active_only (boolean), search (string)
 */
const getDeals = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    if (!restaurantId) {
      return res.status(400).json({ success: false, error: 'Restaurant context not found' });
    }

    const activeOnly = req.query.active_only === 'true' || req.query.active_only === '1';
    const search = req.query.search?.trim();

    let query = `
      SELECT d.* 
      FROM _pos_deals_base d
      WHERE d.restaurant_id = ? AND (d.is_deleted = 0 OR d.is_deleted IS NULL)
    `;
    const params = [restaurantId];

    if (activeOnly) {
      query += ' AND d.is_active = 1';
    }
    if (search) {
      query += ' AND (d.name LIKE ? OR d.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY d.name ASC';

    const [deals] = await pool.query(query, params);

    // Fetch deal items for all deals in one shot
    if (deals.length > 0) {
      const dealIds = deals.map(d => d.id);
      const [dealItems] = await pool.query(`
        SELECT di.*, mi.name as menu_item_name, mi.price as menu_item_price, 
               mi.description as menu_item_description, mc.name as category_name
        FROM _pos_deal_items_base di
        LEFT JOIN _pos_menu_items_base mi ON di.menu_item_id = mi.id AND mi.restaurant_id = di.restaurant_id
        LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id AND mc.restaurant_id = di.restaurant_id
        WHERE di.restaurant_id = ? AND di.deal_id IN (?) AND (di.is_deleted = 0 OR di.is_deleted IS NULL)
        ORDER BY di.id ASC
      `, [restaurantId, dealIds]);

      const itemsByDealId = {};
      for (const item of dealItems) {
        if (!itemsByDealId[item.deal_id]) itemsByDealId[item.deal_id] = [];
        itemsByDealId[item.deal_id].push({
          id: item.id,
          deal_id: item.deal_id,
          menu_item_id: item.menu_item_id,
          name: item.menu_item_name || 'Unknown Item',
          price: item.menu_item_price || 0,
          quantity: item.quantity || 1,
          description: item.menu_item_description || '',
          category_name: item.category_name || '',
        });
      }

      for (const deal of deals) {
        deal.is_active = deal.is_active === 1 || deal.is_active === true;
        deal.items = itemsByDealId[deal.id] || [];
      }
    }

    res.json({ success: true, data: deals });
  } catch (err) {
    logger.error(`[DealController] getDeals error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/deals/:id
 */
const getDealById = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const { id } = req.params;

    const [[deal]] = await pool.query(
      'SELECT * FROM _pos_deals_base WHERE id = ? AND restaurant_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)',
      [id, restaurantId]
    );

    if (!deal) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }

    const [items] = await pool.query(`
      SELECT di.*, mi.name as menu_item_name, mi.price as menu_item_price, 
             mi.description as menu_item_description, mc.name as category_name
      FROM _pos_deal_items_base di
      LEFT JOIN _pos_menu_items_base mi ON di.menu_item_id = mi.id AND mi.restaurant_id = di.restaurant_id
      LEFT JOIN _pos_menu_categories_base mc ON mi.category_id = mc.id AND mc.restaurant_id = di.restaurant_id
      WHERE di.restaurant_id = ? AND di.deal_id = ? AND (di.is_deleted = 0 OR di.is_deleted IS NULL)
    `, [restaurantId, id]);

    deal.is_active = deal.is_active === 1 || deal.is_active === true;
    deal.items = items.map(item => ({
      id: item.id,
      deal_id: item.deal_id,
      menu_item_id: item.menu_item_id,
      name: item.menu_item_name || 'Unknown Item',
      price: item.menu_item_price || 0,
      quantity: item.quantity || 1,
      description: item.menu_item_description || '',
      category_name: item.category_name || '',
    }));

    res.json({ success: true, data: deal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/deals
 * Body: { name, description, price, cost_price, image_path, is_active, items: [{ menu_item_id, quantity }] }
 */
const createDeal = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const restaurantId = getRestaurantId(req);
    if (!restaurantId) {
      return res.status(400).json({ success: false, error: 'Restaurant context not found' });
    }

    const {
      name,
      description = '',
      price,
      cost_price = 0,
      image_path = null,
      is_active = true,
      items = [],
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Deal name is required' });
    }
    if (price === undefined || isNaN(price) || parseFloat(price) < 0) {
      return res.status(400).json({ success: false, error: 'Valid price is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Deal must include at least one menu item' });
    }

    // Validate that all included menu items exist
    const menuItemIds = items.map(i => i.menu_item_id).filter(Boolean);
    const [existingItems] = await conn.query(
      'SELECT id, name, price FROM _pos_menu_items_base WHERE restaurant_id = ? AND id IN (?) AND (is_deleted = 0 OR is_deleted IS NULL)',
      [restaurantId, menuItemIds]
    );

    if (existingItems.length !== menuItemIds.length) {
      return res.status(400).json({ success: false, error: 'One or more selected menu items do not exist' });
    }

    await conn.beginTransaction();

    const hlc = `${Date.now()}:0:cloud`;

    const [dealResult] = await conn.query(`
      INSERT INTO _pos_deals_base 
      (restaurant_id, name, description, price, cost_price, image_path, is_active, is_deleted, hlc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NOW(), NOW())
    `, [
      restaurantId,
      name.trim(),
      description ? description.trim() : null,
      parseFloat(price),
      parseFloat(cost_price) || 0,
      image_path || null,
      is_active ? 1 : 0,
      hlc
    ]);

    const dealId = dealResult.insertId;

    for (const item of items) {
      const qty = parseInt(item.quantity || 1, 10);
      await conn.query(`
        INSERT INTO _pos_deal_items_base
        (restaurant_id, deal_id, menu_item_id, quantity, is_deleted, hlc, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW())
      `, [restaurantId, dealId, item.menu_item_id, qty > 0 ? qty : 1, hlc]);
    }

    await conn.commit();

    // Fetch newly created deal with items
    const [[newDeal]] = await pool.query('SELECT * FROM _pos_deals_base WHERE id = ?', [dealId]);
    const [createdItems] = await pool.query(`
      SELECT di.*, mi.name as menu_item_name, mi.price as menu_item_price
      FROM _pos_deal_items_base di
      LEFT JOIN _pos_menu_items_base mi ON di.menu_item_id = mi.id
      WHERE di.deal_id = ? AND di.is_deleted = 0
    `, [dealId]);

    newDeal.is_active = newDeal.is_active === 1 || newDeal.is_active === true;
    newDeal.items = createdItems.map(i => ({
      id: i.id,
      deal_id: i.deal_id,
      menu_item_id: i.menu_item_id,
      name: i.menu_item_name,
      price: i.menu_item_price,
      quantity: i.quantity,
    }));

    broadcastDealChange(restaurantId, 'deal:created', newDeal);

    res.status(201).json({ success: true, data: newDeal });
  } catch (err) {
    await conn.rollback();
    logger.error(`[DealController] createDeal error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

/**
 * PUT /api/deals/:id
 */
const updateDeal = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const restaurantId = getRestaurantId(req);
    const { id } = req.params;

    const [[existing]] = await conn.query(
      'SELECT * FROM _pos_deals_base WHERE id = ? AND restaurant_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)',
      [id, restaurantId]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }

    const {
      name,
      description,
      price,
      cost_price,
      image_path,
      is_active,
      items,
    } = req.body;

    await conn.beginTransaction();

    const hlc = `${Date.now()}:0:cloud`;

    await conn.query(`
      UPDATE _pos_deals_base
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          price = COALESCE(?, price),
          cost_price = COALESCE(?, cost_price),
          image_path = COALESCE(?, image_path),
          is_active = COALESCE(?, is_active),
          hlc = ?,
          updated_at = NOW()
      WHERE id = ? AND restaurant_id = ?
    `, [
      name ? name.trim() : null,
      description !== undefined ? description : null,
      price !== undefined ? parseFloat(price) : null,
      cost_price !== undefined ? parseFloat(cost_price) : null,
      image_path !== undefined ? image_path : null,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      hlc,
      id,
      restaurantId
    ]);

    // If items are provided, replace deal items
    if (Array.isArray(items)) {
      // Soft-delete removed items
      await conn.query(`
        UPDATE _pos_deal_items_base
        SET is_deleted = 1, deleted_at = NOW(), hlc = ?
        WHERE deal_id = ? AND restaurant_id = ?
      `, [hlc, id, restaurantId]);

      for (const item of items) {
        const qty = parseInt(item.quantity || 1, 10);
        await conn.query(`
          INSERT INTO _pos_deal_items_base
          (restaurant_id, deal_id, menu_item_id, quantity, is_deleted, hlc, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), is_deleted = 0, deleted_at = NULL, hlc = VALUES(hlc), updated_at = NOW()
        `, [restaurantId, id, item.menu_item_id, qty > 0 ? qty : 1, hlc]);
      }
    }

    await conn.commit();

    const [[updatedDeal]] = await pool.query('SELECT * FROM _pos_deals_base WHERE id = ?', [id]);
    const [dealItems] = await pool.query(`
      SELECT di.*, mi.name as menu_item_name, mi.price as menu_item_price
      FROM _pos_deal_items_base di
      LEFT JOIN _pos_menu_items_base mi ON di.menu_item_id = mi.id
      WHERE di.deal_id = ? AND (di.is_deleted = 0 OR di.is_deleted IS NULL)
    `, [id]);

    updatedDeal.is_active = updatedDeal.is_active === 1 || updatedDeal.is_active === true;
    updatedDeal.items = dealItems.map(i => ({
      id: i.id,
      deal_id: i.deal_id,
      menu_item_id: i.menu_item_id,
      name: i.menu_item_name,
      price: i.menu_item_price,
      quantity: i.quantity,
    }));

    broadcastDealChange(restaurantId, 'deal:updated', updatedDeal);

    res.json({ success: true, data: updatedDeal });
  } catch (err) {
    await conn.rollback();
    logger.error(`[DealController] updateDeal error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

/**
 * PATCH /api/deals/:id/status
 */
const toggleDealStatus = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const { id } = req.params;
    const { is_active } = req.body;

    const hlc = `${Date.now()}:0:cloud`;
    await pool.query(`
      UPDATE _pos_deals_base
      SET is_active = ?, hlc = ?, updated_at = NOW()
      WHERE id = ? AND restaurant_id = ?
    `, [is_active ? 1 : 0, hlc, id, restaurantId]);

    const [[deal]] = await pool.query('SELECT * FROM _pos_deals_base WHERE id = ?', [id]);
    if (deal) {
      deal.is_active = deal.is_active === 1 || deal.is_active === true;
      broadcastDealChange(restaurantId, 'deal:updated', deal);
    }

    res.json({ success: true, data: deal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/deals/:id
 */
const deleteDeal = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const { id } = req.params;

    const hlc = `${Date.now()}:0:cloud`;

    await pool.query(`
      UPDATE _pos_deals_base
      SET is_deleted = 1, deleted_at = NOW(), hlc = ?
      WHERE id = ? AND restaurant_id = ?
    `, [hlc, id, restaurantId]);

    await pool.query(`
      UPDATE _pos_deal_items_base
      SET is_deleted = 1, deleted_at = NOW(), hlc = ?
      WHERE deal_id = ? AND restaurant_id = ?
    `, [hlc, id, restaurantId]);

    broadcastDealChange(restaurantId, 'deal:deleted', { id: parseInt(id, 10) });

    res.json({ success: true, message: 'Deal deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getDeals,
  getDealById,
  createDeal,
  updateDeal,
  toggleDealStatus,
  deleteDeal,
};
