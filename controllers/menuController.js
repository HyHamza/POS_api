/**
 * menuController.js — Menu Categories & Items REST Controller for POS_api
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
    console.warn('[MenuController] Socket broadcast error:', err.message);
  }
}

// ─── Categories ─────────────────────────────────────────────────────────────

const getCategories = async (req, res) => {
  try {
    const [cats] = await pool.query(
      'SELECT * FROM pos_menu_categories WHERE (is_deleted = 0 OR is_deleted IS NULL) ORDER BY display_order ASC'
    );
    for (const cat of cats) {
      cat.is_visible = cat.is_visible === 1 || cat.is_visible === true || cat.is_visible === '1';
    }
    return res.json({ success: true, data: cats });
  } catch (err) {
    console.error('[MenuController] getCategories error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createCategory = async (req, res) => {
  try {
    const { name, display_order = 99 } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Category name is required' });

    const [result] = await pool.query(
      'INSERT INTO pos_menu_categories (name, display_order, is_visible) VALUES (?, ?, 1)',
      [name, display_order]
    );

    const [rows] = await pool.query('SELECT * FROM pos_menu_categories WHERE id = ?', [result.insertId]);
    const cat = rows[0];
    if (cat) cat.is_visible = true;

    broadcastTenantEvent('menu:updated', { type: 'category', action: 'create', data: cat });
    broadcastTenantEvent('sync:complete', { table: 'menu_categories' });

    return res.status(201).json({ success: true, data: cat });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'A category with this name already exists' });
    }
    console.error('[MenuController] createCategory error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, display_order, is_visible } = req.body;

    const [existing] = await pool.query('SELECT * FROM pos_menu_categories WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, error: 'Category not found' });

    const current = existing[0];
    const newName = name !== undefined ? name : current.name;
    const newOrder = display_order !== undefined ? display_order : current.display_order;
    const newVisible = is_visible !== undefined ? (is_visible ? 1 : 0) : current.is_visible;

    await pool.query(
      'UPDATE pos_menu_categories SET name = ?, display_order = ?, is_visible = ? WHERE id = ?',
      [newName, newOrder, newVisible, id]
    );

    const [rows] = await pool.query('SELECT * FROM pos_menu_categories WHERE id = ?', [id]);
    const cat = rows[0];
    if (cat) cat.is_visible = cat.is_visible === 1;

    broadcastTenantEvent('menu:updated', { type: 'category', action: 'update', data: cat });
    broadcastTenantEvent('sync:complete', { table: 'menu_categories' });

    return res.json({ success: true, data: cat });
  } catch (err) {
    console.error('[MenuController] updateCategory error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_menu_categories SET is_deleted = 1, deleted_at = NOW() WHERE id = ?', [id]);

    broadcastTenantEvent('menu:updated', { type: 'category', action: 'delete', id });
    broadcastTenantEvent('sync:complete', { table: 'menu_categories' });

    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[MenuController] deleteCategory error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const reorderCategories = async (req, res) => {
  try {
    const { items = [] } = req.body;
    for (const item of items) {
      await pool.query('UPDATE pos_menu_categories SET display_order = ? WHERE id = ?', [item.order, item.id]);
    }

    broadcastTenantEvent('menu:updated', { type: 'category', action: 'reorder' });
    broadcastTenantEvent('sync:complete', { table: 'menu_categories' });

    return res.json({ success: true });
  } catch (err) {
    console.error('[MenuController] reorderCategories error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Menu Items ─────────────────────────────────────────────────────────────

const getItems = async (req, res) => {
  try {
    const { category_id, available_only } = req.query;
    let query = `
      SELECT mi.*, mc.name as category_name
      FROM pos_menu_items mi
      LEFT JOIN pos_menu_categories mc ON mi.category_id = mc.id
      WHERE (mi.is_deleted = 0 OR mi.is_deleted IS NULL)
    `;
    const params = [];

    if (category_id && category_id !== 'all') {
      query += ' AND mi.category_id = ?';
      params.push(category_id);
    }
    if (available_only === 'true' || available_only === true || available_only === '1') {
      query += ' AND mi.is_available = 1';
    }

    query += ' ORDER BY mc.display_order ASC, mi.name ASC';

    const [items] = await pool.query(query, params);

    for (const item of items) {
      item.is_available = item.is_available === 1 || item.is_available === true || item.is_available === '1';
      if (item.dietary_tags && typeof item.dietary_tags === 'string') {
        try { item.dietary_tags = JSON.parse(item.dietary_tags); } catch (_) { item.dietary_tags = []; }
      } else if (!item.dietary_tags || !Array.isArray(item.dietary_tags)) {
        item.dietary_tags = [];
      }
      if (item.variants && typeof item.variants === 'string') {
        try { item.variants = JSON.parse(item.variants); } catch (_) { item.variants = []; }
      } else if (!item.variants || !Array.isArray(item.variants)) {
        item.variants = [];
      }
    }

    return res.json({ success: true, data: items });
  } catch (err) {
    console.error('[MenuController] getItems error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createItem = async (req, res) => {
  try {
    const {
      category_id, name, description, price, cost_price = 0,
      image_path, dietary_tags, variants, is_available = 1
    } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ success: false, error: 'Item name and price are required' });
    }

    const tagsJson = Array.isArray(dietary_tags) ? JSON.stringify(dietary_tags) : (dietary_tags || '[]');
    const variantsJson = Array.isArray(variants) ? JSON.stringify(variants) : (variants || '[]');

    const [result] = await pool.query(`
      INSERT INTO pos_menu_items 
      (category_id, name, description, price, cost_price, image_path, dietary_tags, variants, is_available, created_at, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)
    `, [category_id || null, name, description || null, price, cost_price, image_path || null, tagsJson, variantsJson, is_available ? 1 : 0]);

    const [rows] = await pool.query('SELECT * FROM pos_menu_items WHERE id = ?', [result.insertId]);
    const item = rows[0];
    if (item) {
      item.is_available = item.is_available === 1;
      try { item.dietary_tags = JSON.parse(item.dietary_tags); } catch (_) { item.dietary_tags = []; }
      try { item.variants = JSON.parse(item.variants); } catch (_) { item.variants = []; }
    }

    broadcastTenantEvent('menu:updated', { type: 'item', action: 'create', data: item });
    broadcastTenantEvent('sync:complete', { table: 'menu_items' });

    return res.status(201).json({ success: true, data: item });
  } catch (err) {
    console.error('[MenuController] createItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category_id, name, description, price, cost_price,
      image_path, dietary_tags, variants, is_available
    } = req.body;

    const [existing] = await pool.query('SELECT * FROM pos_menu_items WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, error: 'Item not found' });

    const current = existing[0];
    const newCategory = category_id !== undefined ? category_id : current.category_id;
    const newName = name !== undefined ? name : current.name;
    const newDesc = description !== undefined ? description : current.description;
    const newPrice = price !== undefined ? price : current.price;
    const newCost = cost_price !== undefined ? cost_price : current.cost_price;
    const newImg = image_path !== undefined ? image_path : current.image_path;
    const newTags = dietary_tags !== undefined
      ? (Array.isArray(dietary_tags) ? JSON.stringify(dietary_tags) : dietary_tags)
      : current.dietary_tags;
    const newVariants = variants !== undefined
      ? (Array.isArray(variants) ? JSON.stringify(variants) : variants)
      : current.variants;
    const newAvail = is_available !== undefined ? (is_available ? 1 : 0) : current.is_available;

    await pool.query(`
      UPDATE pos_menu_items 
      SET category_id = ?, name = ?, description = ?, price = ?, 
          cost_price = ?, image_path = ?, dietary_tags = ?, variants = ?, is_available = ?
      WHERE id = ?
    `, [newCategory, newName, newDesc, newPrice, newCost, newImg, newTags, newVariants, newAvail, id]);

    const [rows] = await pool.query('SELECT * FROM pos_menu_items WHERE id = ?', [id]);
    const item = rows[0];
    if (item) {
      item.is_available = item.is_available === 1;
      try { item.dietary_tags = JSON.parse(item.dietary_tags); } catch (_) { item.dietary_tags = []; }
      try { item.variants = JSON.parse(item.variants); } catch (_) { item.variants = []; }
    }

    broadcastTenantEvent('menu:updated', { type: 'item', action: 'update', data: item });
    broadcastTenantEvent('sync:complete', { table: 'menu_items' });

    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('[MenuController] updateItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE pos_menu_items SET is_deleted = 1, deleted_at = NOW() WHERE id = ?', [id]);

    broadcastTenantEvent('menu:updated', { type: 'item', action: 'delete', id });
    broadcastTenantEvent('sync:complete', { table: 'menu_items' });

    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[MenuController] deleteItem error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const toggleAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT is_available FROM pos_menu_items WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, error: 'Item not found' });

    const newStatus = existing[0].is_available === 1 ? 0 : 1;
    await pool.query('UPDATE pos_menu_items SET is_available = ? WHERE id = ?', [newStatus, id]);

    broadcastTenantEvent('menu:updated', { type: 'item', action: 'toggleAvailability', id, is_available: newStatus === 1 });

    return res.json({ success: true, data: { id, is_available: newStatus === 1 } });
  } catch (err) {
    console.error('[MenuController] toggleAvailability error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const exportJSON = async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM pos_menu_categories WHERE is_deleted = 0 OR is_deleted IS NULL ORDER BY display_order');
    const [items] = await pool.query('SELECT * FROM pos_menu_items WHERE is_deleted = 0 OR is_deleted IS NULL');
    for (const item of items) {
      try { item.dietary_tags = JSON.parse(item.dietary_tags || '[]'); } catch (_) { item.dietary_tags = []; }
      try { item.variants = JSON.parse(item.variants || '[]'); } catch (_) { item.variants = []; }
    }
    return res.json({ success: true, data: JSON.stringify({ categories, items }, null, 2) });
  } catch (err) {
    console.error('[MenuController] exportJSON error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const importJSON = async (req, res) => {
  try {
    const { json } = req.body || {};
    const data = typeof json === 'string' ? JSON.parse(json) : (json || {});

    if (data.categories && Array.isArray(data.categories)) {
      for (const cat of data.categories) {
        await pool.query(
          'INSERT INTO pos_menu_categories (name, display_order, is_visible) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE display_order = VALUES(display_order), is_visible = VALUES(is_visible)',
          [cat.name, cat.display_order || 0, cat.is_visible !== undefined ? (cat.is_visible ? 1 : 0) : 1]
        );
      }
    }

    if (data.items && Array.isArray(data.items)) {
      for (const item of data.items) {
        await pool.query(`
          INSERT INTO pos_menu_items 
          (category_id, name, description, price, cost_price, image_path, dietary_tags, variants, is_available, created_at, is_deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)
        `, [
          item.category_id || null, item.name, item.description || null,
          item.price || 0, item.cost_price || 0, item.image_path || null,
          JSON.stringify(item.dietary_tags || []), JSON.stringify(item.variants || []),
          item.is_available !== undefined ? (item.is_available ? 1 : 0) : 1
        ]);
      }
    }

    broadcastTenantEvent('menu:updated', { type: 'menu', action: 'import' });
    broadcastTenantEvent('sync:complete', { table: 'menu_items' });

    return res.json({ success: true, message: 'Menu imported successfully' });
  } catch (err) {
    console.error('[MenuController] importJSON error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const importFullJSON = async (req, res) => {
  try {
    const { json } = req.body || {};
    if (!json) return res.status(400).json({ success: false, error: 'JSON payload is required' });

    const data = typeof json === 'string' ? JSON.parse(json) : json;

    // Delete existing menu items and categories for this restaurant
    await pool.query('DELETE FROM pos_menu_items');
    await pool.query('DELETE FROM pos_menu_categories');

    let orderCat = 1;

    // 1. Standard categories & items
    if (data.menu) {
      for (const [catKey, catObj] of Object.entries(data.menu)) {
        const catLabel = catObj.label || catKey;
        const [catResult] = await pool.query(
          'INSERT INTO pos_menu_categories (name, display_order, is_visible) VALUES (?, ?, 1)',
          [catLabel, orderCat++]
        );
        const catId = catResult.insertId;

        if (catObj.items && Array.isArray(catObj.items)) {
          for (const item of catObj.items) {
            let basePrice = item.price || 0;
            let itemVariants = [];

            if (item.prices) {
              for (const [sizeKey, priceVal] of Object.entries(item.prices)) {
                if (priceVal !== null && priceVal !== undefined) {
                  let variantName = sizeKey;
                  if (catObj.sizes && Array.isArray(catObj.sizes)) {
                    const matchedSize = catObj.sizes.find(s => s.toLowerCase().startsWith(sizeKey.toLowerCase()));
                    if (matchedSize) variantName = matchedSize;
                  }
                  itemVariants.push({
                    name: variantName,
                    price: parseFloat(priceVal)
                  });
                }
              }
              if (itemVariants.length > 0 && !basePrice) {
                basePrice = itemVariants[0].price;
              }
            }

            await pool.query(`
              INSERT INTO pos_menu_items 
              (category_id, name, description, price, variants, is_available, created_at, is_deleted)
              VALUES (?, ?, ?, ?, ?, 1, NOW(), 0)
            `, [catId, item.name, item.note || item.description || null, basePrice, JSON.stringify(itemVariants)]);
          }
        }
      }
    }

    // 2. Deals
    if (data.deals) {
      const dealCatLabel = data.deals.label || 'Deals';
      const [catResult] = await pool.query(
        'INSERT INTO pos_menu_categories (name, display_order, is_visible) VALUES (?, ?, 1)',
        [dealCatLabel, orderCat++]
      );
      const catId = catResult.insertId;

      const processDeals = async (dealsArray) => {
        if (Array.isArray(dealsArray)) {
          for (const deal of dealsArray) {
            const desc = Array.isArray(deal.includes) ? `Includes: ${deal.includes.join(', ')}` : (deal.description || null);
            await pool.query(`
              INSERT INTO pos_menu_items 
              (category_id, name, description, price, variants, is_available, created_at, is_deleted)
              VALUES (?, ?, ?, ?, '[]', 1, NOW(), 0)
            `, [catId, deal.name, desc, deal.price || 0]);
          }
        }
      };

      await processDeals(data.deals.standard_deals);
      await processDeals(data.deals.special_deals);
      await processDeals(data.deals.promotion_deals);
      await processDeals(data.deals.special_platters);
    }

    // 3. Fallback direct categories / items format
    if (data.categories && Array.isArray(data.categories)) {
      for (const cat of data.categories) {
        const [catRes] = await pool.query(
          'INSERT INTO pos_menu_categories (name, display_order, is_visible) VALUES (?, ?, ?)',
          [cat.name, cat.display_order || 0, cat.is_visible !== undefined ? (cat.is_visible ? 1 : 0) : 1]
        );
        const catId = catRes.insertId;
        const matchingItems = (data.items || []).filter(i => i.category_id === cat.id || i.category_name === cat.name);
        for (const item of matchingItems) {
          await pool.query(`
            INSERT INTO pos_menu_items 
            (category_id, name, description, price, cost_price, image_path, dietary_tags, variants, is_available, created_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)
          `, [
            catId, item.name, item.description || null, item.price || 0, item.cost_price || 0,
            item.image_path || null, JSON.stringify(item.dietary_tags || []), JSON.stringify(item.variants || []),
            item.is_available !== undefined ? (item.is_available ? 1 : 0) : 1
          ]);
        }
      }
    }

    broadcastTenantEvent('menu:updated', { type: 'menu', action: 'import' });
    broadcastTenantEvent('sync:complete', { table: 'menu_items' });

    return res.json({ success: true, message: 'Menu imported successfully' });
  } catch (err) {
    console.error('[MenuController] importFullJSON error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  getItems,
  createItem,
  updateItem,
  deleteItem,
  toggleAvailability,
  exportJSON,
  importJSON,
  importFullJSON
};

