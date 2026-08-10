/**
 * posController.js — Cloud API Sync Endpoints
 *
 * Changes in this version:
 *  - sync_device_id: every incoming row carries a client-assigned UUID.
 *    We use it as a unique key so re-submitting the same change is a no-op.
 *  - fullExportData: new endpoint that fetches ALL rows across ALL tables
 *    in one shot (paginated) with per-table progress metadata so the client
 *    can show accurate progress bars during the initial install sync.
 *  - broadcastChange helper: all mutations (orders, menu, staff…) now call
 *    webSocketBroadcaster.broadcast() so every connected client sees the
 *    change in real time without polling.
 */

'use strict';

const pool = require('../config/db');
const hlcLib = require('../utils/hlc');
const logger = require('../utils/logger');

// ─── Role-based filter helper ─────────────────────────────────────────────────
function getRoleFilters(role, tableAlias) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  if (role === 'Kitchen') {
    return { condition: `${prefix}status NOT IN ('completed', 'cancelled')`, params: [] };
  }
  if (role === 'Rider') {
    return { condition: `${prefix}type IN ('Delivery', 'Takeaway')`, params: [] };
  }
  return null;
}

// ─── Convenience: emit a change to all connected WebSocket peers ──────────────
function broadcastChange(restaurantId, payload, excludeDeviceId) {
  try {
    const broadcaster = require('../sockets/WebSocketBroadcaster');
    broadcaster.broadcast(restaurantId, payload, excludeDeviceId || null);
  } catch (_) {}
}

// ─── Full initial export (all tables, all rows, with counts) ─────────────────
/**
 * GET /api/pos/sync/full-export
 *
 * Returns every row across every synced table for this tenant.
 * Cursor-paginated per table using HLC so the client can resume interrupted
 * initial syncs.  Also returns per-table total row counts so the renderer
 * can show accurate progress percentages.
 *
 * Query params:
 *   cursor      – HLC string, resume from here (default: start)
 *   limit       – rows per table per page (default: 500, max: 2000)
 *   table       – if supplied, only fetch this one table (for resume)
 */
const fullExportData = async (req, res) => {
  try {
    const cursor = (req.query.cursor && req.query.cursor !== 'start') ? req.query.cursor : null;
    const limit  = Math.min(parseInt(req.query.limit || '500', 10), 2000);
    const onlyTable = req.query.table || null;

    // Get restaurant_id from AsyncLocalStorage (set by tenant middleware)
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Restaurant context not found. License key required.' 
      });
    }

    // All tables the client needs for a complete initial dataset
    const ALL_TABLES = [
      'pos_settings',
      'admins',               // login credentials for offline auth
      'pos_staff',
      'pos_customers',
      'pos_menu_categories',
      'pos_menu_items',
      'pos_floors',
      'pos_sections',
      'pos_tables',
      'pos_orders',
      'pos_order_items',
      'pos_inventory_items',
      'pos_inventory_log',
      'pos_expenses',
      'pos_payroll',
      'pos_attendance',
      'pos_activity_logs',
      'pos_notifications',
      'riders',
      'tasks',
    ];

    const syncTables = onlyTable ? [onlyTable] : ALL_TABLES;

    // Gather total counts first (cheap — uses index scan)
    // FIX (Bug #1): Add restaurant_id filter to ALL count queries
    const counts = {};
    for (const table of ALL_TABLES) {
      try {
        const baseTable = getBaseTable(table);
        const [[row]] = await pool.query(
          `SELECT COUNT(*) as c FROM \`${baseTable}\` WHERE restaurant_id = ?`,
          [restaurantId]
        );
        counts[table] = row.c;
      } catch (_) {
        counts[table] = 0;
      }
    }

    const data = {};
    let highestHlc = cursor;

    for (const table of syncTables) {
      const rows = await fetchTableRows(table, cursor, limit, restaurantId);
      if (rows.length > 0) {
        const clientKey = table.startsWith('pos_') ? table.substring(4) : table;
        data[clientKey] = rows;
        const maxHlc = rows[rows.length - 1].hlc;
        if (maxHlc && (!highestHlc || hlcLib.compare(maxHlc, highestHlc) > 0)) {
          highestHlc = maxHlc;
        }
      }
    }

    const totalRows = Object.values(data).reduce((s, a) => s + a.length, 0);
    const has_more  = Object.values(data).some(a => a.length >= limit);
    const next_cursor = (totalRows > 0 && highestHlc && highestHlc !== cursor)
      ? highestHlc
      : cursor;

    res.json({
      success: true,
      data,
      counts,          // { pos_orders: 1234, pos_staff: 8, … }
      next_cursor,
      has_more,
      total_tables: ALL_TABLES.length,
    });
  } catch (err) {
    console.error('[Full Export] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/** Map view/alias name → actual base table name */
function getBaseTable(table) {
  const map = {
    admins:                   '_admins_base',
    pos_settings:             '_pos_settings_base',
    pos_staff:                '_pos_staff_base',
    pos_customers:            '_pos_customers_base',
    pos_attendance:           '_pos_attendance_base',
    pos_menu_categories:      '_pos_menu_categories_base',
    pos_menu_items:           '_pos_menu_items_base',
    pos_floors:               '_pos_floors_base',
    pos_sections:             '_pos_sections_base',
    pos_tables:               '_pos_tables_base',
    pos_orders:               '_pos_orders_base',
    pos_order_items:          '_pos_order_items_base',
    pos_inventory_items:      '_pos_inventory_items_base',
    pos_inventory_log:        '_pos_inventory_log_base',
    pos_expenses:             '_pos_expenses_base',
    pos_payroll:              '_pos_payroll_base',
    pos_activity_logs:        '_pos_activity_logs_base',
    pos_notifications:        '_pos_notifications_base',
    riders:                   '_riders_base',
    tasks:                    '_tasks_base',
  };
  return map[table] || table;
}

/** Fetch rows for a single table with optional HLC cursor */
async function fetchTableRows(table, cursor, limit, restaurantId) {
  const base = getBaseTable(table);
  let query = `SELECT t.* FROM \`${base}\` t`;
  const params = [];

  // FIX (Bug #1): Add restaurant_id filter to ALL queries
  // Augment with join data for foreign key resolution
  if (table === 'pos_sections') {
    query = `SELECT t.*, f.name AS floor_name 
             FROM \`${base}\` t 
             LEFT JOIN _pos_floors_base f ON t.floor_id = f.id AND f.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'pos_menu_items') {
    query = `SELECT t.*, c.name AS category_name 
             FROM \`${base}\` t 
             LEFT JOIN _pos_menu_categories_base c ON t.category_id = c.id AND c.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'pos_order_items') {
    query = `SELECT t.*, o.order_number, m.name AS menu_item_name 
             FROM \`${base}\` t 
             LEFT JOIN _pos_orders_base o ON t.order_id = o.id AND o.restaurant_id = t.restaurant_id
             LEFT JOIN _pos_menu_items_base m ON t.menu_item_id = m.id AND m.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'pos_attendance' || table === 'pos_expenses' || table === 'pos_payroll') {
    query = `SELECT t.*, s.username AS staff_username 
             FROM \`${base}\` t 
             LEFT JOIN _pos_staff_base s ON t.staff_id = s.id AND s.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'pos_orders') {
    query = `SELECT t.*, s.username AS staff_username, tb.number AS table_number, 
             tb.section_id AS table_section_id, 
             ps.username AS payment_staff_username 
             FROM \`${base}\` t 
             LEFT JOIN _pos_staff_base s ON t.staff_id = s.id AND s.restaurant_id = t.restaurant_id
             LEFT JOIN _pos_tables_base tb ON t.table_id = tb.id AND tb.restaurant_id = t.restaurant_id
             LEFT JOIN _pos_staff_base ps ON t.payment_received_by = ps.id AND ps.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'pos_inventory_log') {
    query = `SELECT t.*, i.name AS item_name, s.username AS staff_username 
             FROM \`${base}\` t 
             LEFT JOIN _pos_inventory_items_base i ON t.item_id = i.id AND i.restaurant_id = t.restaurant_id
             LEFT JOIN _pos_staff_base s ON t.staff_id = s.id AND s.restaurant_id = t.restaurant_id
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else if (table === 'admins') {
    // FIX (Bug #1 - CRITICAL): Only export THIS tenant's admin credentials, not all tenants
    query = `SELECT t.id, t.restaurant_id, t.username, t.password_hash, t.email, t.hlc, t.sync_device_id, t.origin_device_id, t.is_deleted, t.deleted_at 
             FROM \`${base}\` t
             WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  } else {
    // Default case: simple restaurant_id filter
    query += ` WHERE t.restaurant_id = ?`;
    params.push(restaurantId);
  }

  // Add HLC cursor filter
  if (cursor) {
    query += ' AND t.hlc > ?';
    params.push(cursor);
  }
  
  query += ` ORDER BY t.hlc ASC LIMIT ?`;
  params.push(limit);

  try {
    const [rows] = await pool.query(query, params);
    return rows;
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') {
      console.warn(`[Full Export] Table ${table} error:`, e.message);
    }
    return [];
  }
}

// ─── Cursor-paginated export (incremental sync) ───────────────────────────────
const exportData = async (req, res) => {
  try {
    const cursor = (req.query.cursor && req.query.cursor !== 'start') ? req.query.cursor : null;
    const limit  = parseInt(req.query.limit || '500', 10);
    const role   = req.query.role || 'Admin';

    // FIX (Bug #1): Get restaurant_id from AsyncLocalStorage
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Restaurant context not found. License key required.' 
      });
    }

    let syncTables = [
      'pos_settings', 'pos_floors', 'pos_sections', 'pos_tables',
      'pos_menu_categories', 'pos_menu_items', 'pos_staff', 'pos_attendance',
      'pos_orders', 'pos_order_items', 'pos_inventory_items', 'pos_inventory_log',
      'pos_expenses', 'pos_payroll', 'pos_activity_logs', 'pos_notifications',
      'riders', 'tasks', 'admins',
    ];

    if (role === 'Kitchen') {
      syncTables = ['pos_settings', 'pos_menu_categories', 'pos_menu_items', 'pos_orders', 'pos_order_items', 'pos_notifications'];
    } else if (role === 'Rider') {
      syncTables = ['pos_settings', 'pos_orders', 'pos_order_items', 'riders', 'tasks', 'pos_notifications'];
    } else if (role === 'Waiter' || role === 'Cashier') {
      syncTables = syncTables.filter(t => !['pos_inventory_items', 'pos_inventory_log', 'pos_payroll', 'riders', 'tasks'].includes(t));
    }

    const data = {};
    let highestHlc = cursor;

    for (const table of syncTables) {
      const rows = await fetchTableRows(table, cursor, limit, restaurantId);
      if (rows.length > 0) {
        const clientKey = table.startsWith('pos_') ? table.substring(4) : table;
        data[clientKey] = rows;
        const maxHlc = rows[rows.length - 1].hlc;
        if (maxHlc && (!highestHlc || hlcLib.compare(maxHlc, highestHlc) > 0)) {
          highestHlc = maxHlc;
        }
      }
    }

    const totalRows = Object.values(data).reduce((s, a) => s + a.length, 0);
    let next_cursor = cursor;
    let has_more    = false;

    if (totalRows > 0 && highestHlc && highestHlc !== cursor) {
      next_cursor = highestHlc;
      has_more    = Object.values(data).some(a => a.length >= limit);
    }

    res.json({ success: true, data, next_cursor, has_more });
  } catch (err) {
    console.error('[Export] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Core import/merge with idempotent sync_device_id upserts ────────────────
/**
 * Merges an incoming sync payload into MySQL.
 *
 * For every row that carries a `sync_device_id` the server checks the
 * `sync_events` table.  If the ID was already processed it skips that row
 * entirely — this makes every push idempotent regardless of network retries
 * or duplicate submissions from multiple offline devices coming back online.
 *
 * After a successful commit it broadcasts the payload to every other
 * WebSocket peer for this tenant so they get the data in real time.
 */
const mergeImportPayload = async (peerData, senderClientId, restaurantId) => {
  if (!peerData || Object.keys(peerData).length === 0) {
    return { success: false, processed: 0, error: 'No data provided' };
  }

  const importErrors = [];
  const connection = await pool.getConnection();
  try {
    if (restaurantId !== null && restaurantId !== undefined) {
      await connection.query('SET @current_restaurant_id = ?', [restaurantId]);
    }

    logger.client(`Receiving sync push from device ${senderClientId}`);

    const tableMap = {
      settings:        '_pos_settings_base',
      menu_categories: '_pos_menu_categories_base',
      menu_items:      '_pos_menu_items_base',
      floors:          '_pos_floors_base',
      sections:        '_pos_sections_base',
      tables:          '_pos_tables_base',
      staff:           '_pos_staff_base',
      customers:       '_pos_customers_base',
      attendance:      '_pos_attendance_base',
      orders:          '_pos_orders_base',
      order_items:     '_pos_order_items_base',
      inventory_items: '_pos_inventory_items_base',
      inventory_log:   '_pos_inventory_log_base',
      expenses:        '_pos_expenses_base',
      payroll:         '_pos_payroll_base',
      activity_logs:   '_pos_activity_logs_base',
      notifications:   '_pos_notifications_base',
      riders:          '_riders_base',
      tasks:           '_tasks_base',
    };

    const FIELD_LEVEL_TABLES = {
      _pos_menu_items_base:      ['price', 'description', 'is_available', 'category_id', 'cost_price', 'image_path', 'dietary_tags', 'variants'],
      _pos_orders_base:          ['status', 'subtotal', 'total', 'notes', 'rider_name', 'payment_received', 'payment_received_at', 'payment_received_by'],
      _pos_inventory_items_base: ['quantity', 'min_threshold', 'cost_per_unit'],
    };

    // V4 FIX: Deterministic table order (parents before children)
    const tableOrder = [
      'settings', 'floors', 'sections', 'menu_categories', 'menu_items',
      'tables', 'staff', 'customers', 'admins', 'riders', 'attendance',
      'orders',        // CRITICAL: orders BEFORE items (FK dependency)
      'order_items',   // Items depend on orders
      'inventory_items', 'inventory_log', 'expenses', 'payroll',
      'activity_logs', 'notifications', 'tasks',
    ];

    // V4 FIX: Group all rows by txn_id for atomic processing
    const txnGroups = new Map(); // txn_id -> [{clientTable, cloudTable, row}]
    const noTxnRows = []; // Rows without txn_id (legacy)
    
    for (const clientTable of tableOrder) {
      const rows = peerData[clientTable];
      if (!rows || rows.length === 0) continue;
      
      const cloudTable = tableMap[clientTable];
      
      for (const row of rows) {
        const txnId = row.txn_id || row._txn_id;
        
        if (txnId) {
          if (!txnGroups.has(txnId)) {
            txnGroups.set(txnId, []);
          }
          txnGroups.get(txnId).push({ clientTable, cloudTable, row });
        } else {
          noTxnRows.push({ clientTable, cloudTable, row });
        }
      }
    }

    let totalChangesCount = 0;
    const syncedChangeIds = [];

    // V4 FIX: Process each transaction atomically (all-or-nothing)
    for (const [txnId, txnRows] of txnGroups.entries()) {
      logger.info(`Processing transaction ${txnId} with ${txnRows.length} rows`);
      
      await connection.beginTransaction();
      
      try {
        let txnChangesCount = 0;
        
        for (const { clientTable, cloudTable, row } of txnRows) {
          const processed = await processRow(
            connection, clientTable, cloudTable, row, senderClientId, 
            restaurantId, FIELD_LEVEL_TABLES, importErrors
          );
          
          if (processed) {
            txnChangesCount++;
            const changeId = row.change_id || row._change_id;
            if (changeId) syncedChangeIds.push(changeId);
          }
        }
        
        // Commit entire transaction atomically
        await connection.commit();
        totalChangesCount += txnChangesCount;
        logger.success(`Transaction ${txnId} committed successfully (${txnChangesCount} changes)`);
        
      } catch (txnErr) {
        await connection.rollback();
        logger.error(`Transaction ${txnId} rolled back: ${txnErr.message}`);
        importErrors.push(`Transaction ${txnId}: ${txnErr.message}`);
      }
    }

    // Process non-transactional rows (legacy compatibility)
    if (noTxnRows.length > 0) {
      logger.info(`Processing ${noTxnRows.length} non-transactional rows`);
      
      await connection.beginTransaction();
      
      try {
        for (const { clientTable, cloudTable, row } of noTxnRows) {
          const processed = await processRow(
            connection, clientTable, cloudTable, row, senderClientId,
            restaurantId, FIELD_LEVEL_TABLES, importErrors
          );
          
          if (processed) {
            totalChangesCount++;
            const changeId = row.change_id || row._change_id;
            if (changeId) syncedChangeIds.push(changeId);
          }
        }
        
        await connection.commit();
        logger.success(`Non-transactional rows committed successfully (${noTxnRows.length} rows processed, ${totalChangesCount} changes saved)`);
        
        // Verify commit succeeded by checking connection state
        const [[txnState]] = await connection.query('SELECT @@in_transaction as in_txn');
        if (txnState.in_txn) {
          logger.error(`WARNING: Still in transaction after commit! Rolling back.`);
          await connection.rollback();
        } else {
          logger.debug(`Transaction state verified: not in transaction after commit`);
        }
        
      } catch (err) {
        await connection.rollback();
        logger.error(`Non-transactional rows rolled back: ${err.message}`);
        importErrors.push(`Non-transactional: ${err.message}`);
      }
    }

    // Broadcast to other WS clients (excludes sender)
    if (totalChangesCount > 0 && (restaurantId !== null && restaurantId !== undefined)) {
      broadcastChange(restaurantId, peerData, senderClientId);
    }

    return { 
      success: true, 
      processed: totalChangesCount, 
      errors: importErrors,
      synced_change_ids: syncedChangeIds,
    };
  } catch (err) {
    logger.error(`Fatal import error: ${err.message}`);
    return { success: false, processed: 0, error: err.message };
  } finally {
    connection.release();
  }
};

// ─── Helpers for mergeImportPayload ──────────────────────────────────────────

/**
 * Process a single row (idempotency check + insert/update + sync event registration)
 * Returns true if processed, false if skipped
 */
async function processRow(connection, clientTable, cloudTable, row, senderClientId, restaurantId, FIELD_LEVEL_TABLES, importErrors) {
  // ── Idempotency gate with change_id deduplication ──────────────
  const syncId = row.sync_device_id || row._sync_device_id;
  const changeId = row.change_id || row._change_id;
  const txnId = row.txn_id || row._txn_id;
  
  logger.debug(`Processing row: table=${clientTable}, changeId=${changeId}, syncId=${syncId}, txnId=${txnId}`);
  
  if (restaurantId !== null && restaurantId !== undefined) {
    // Check both change_id (primary) and sync_device_id (fallback)
    if (changeId) {
      const [[existing]] = await connection.query(
        'SELECT 1 FROM sync_events WHERE change_id = ? AND restaurant_id = ? LIMIT 1',
        [changeId, restaurantId]
      );
      if (existing) {
        logger.debug(`Skipping duplicate change_id: ${changeId}`);
        return false; // already processed
      }
    } else if (syncId) {
      const [[existing]] = await connection.query(
        'SELECT 1 FROM sync_events WHERE sync_device_id = ? AND restaurant_id = ? LIMIT 1',
        [syncId, restaurantId]
      );
      if (existing) {
        logger.debug(`Skipping duplicate sync_device_id: ${syncId}`);
        return false; // already processed
      }
    }
  } else {
    logger.error(`restaurantId is null/undefined! Cannot process row.`);
    return false;
  }

  if (restaurantId !== null && restaurantId !== undefined) {
    row.restaurant_id = restaurantId;
  }

  // ── Resolve foreign keys from natural-key hints ───────────────────
  await resolveNaturalKeys(connection, clientTable, row);

  // ── Determine match column for upsert logic ───────────────────────
  const APPEND_ONLY = ['inventory_log', 'attendance', 'order_items', 'activity_logs'];

  let matchCol = 'id';
  let matchVal = row.id;

  if (clientTable === 'settings')                                           { matchCol = 'key';          matchVal = row.key; }
  else if (clientTable === 'staff' || clientTable === 'riders')             { matchCol = 'username';     matchVal = row.username; }
  else if (['menu_categories', 'menu_items', 'floors', 'inventory_items'].includes(clientTable)) { matchCol = 'name'; matchVal = row.name; }
  else if (clientTable === 'orders')                                        { matchCol = 'order_number'; matchVal = row.order_number; }
  else if (APPEND_ONLY.includes(clientTable))                               { matchCol = null;           matchVal = null; }

  // ── Fetch existing row ────────────────────────────────────────────
  let existing = null;
  try {
    if (clientTable === 'attendance') {
      existing = await findAttendanceMatch(connection, cloudTable, row);
    } else if (matchVal !== undefined && matchVal !== null) {
      // CRITICAL FIX (Bug #1): Add restaurant_id filter to ALL match queries
      const [[r]] = await connection.query(
        `SELECT * FROM \`${cloudTable}\` WHERE \`${matchCol}\` = ? AND restaurant_id = @current_restaurant_id LIMIT 1`, 
        [matchVal]
      );
      existing = r || null;
    }
  } catch (_) { return false; }

  const incomingHlc = row._hlc || row.hlc || '';

  if (!existing) {
    logger.info(`Inserting into ${cloudTable}: ${matchVal || 'APPEND_ONLY'}`);
    await doInsert(connection, cloudTable, clientTable, row, incomingHlc, senderClientId, importErrors);
  } else {
    logger.info(`Updating ${cloudTable}: ${matchVal}`);
    await doUpdate(connection, cloudTable, clientTable, existing, row, incomingHlc, senderClientId, FIELD_LEVEL_TABLES, importErrors);
  }

  // ── Register event as processed ───────────────────────────────────
  if (restaurantId !== null && restaurantId !== undefined) {
    // V4 FIX: Store change_id, sync_device_id, AND txn_id
    if (changeId && syncId) {
      logger.success(`Registering sync_event: changeId=${changeId}, syncId=${syncId}, txnId=${txnId}`);
      await connection.query(
        'INSERT IGNORE INTO sync_events (change_id, sync_device_id, txn_id, restaurant_id, device_id, table_name, row_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [changeId, syncId, txnId, restaurantId, senderClientId, clientTable, row.id, incomingHlc]
      );
    } else if (syncId) {
      logger.success(`Registering sync_event (no changeId): syncId=${syncId}, txnId=${txnId}`);
      await connection.query(
        'INSERT IGNORE INTO sync_events (sync_device_id, txn_id, restaurant_id, device_id, table_name, row_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [syncId, txnId, restaurantId, senderClientId, clientTable, row.id, incomingHlc]
      );
    } else {
      logger.error(`Cannot register sync_event - missing both changeId and syncId!`);
    }
  } else {
    logger.error(`Cannot register sync_event - restaurantId is null/undefined!`);
  }

  return true; // Successfully processed
}

const IGNORED_COLS = ['category_name', 'floor_name', 'order_number', 'menu_item_name',
                      'staff_username', 'table_number', 'table_section_id', 'item_name',
                      'change_id', 'sync_device_id', 'txn_id', 'payment_staff_username'];

async function resolveNaturalKeys(conn, clientTable, row) {
  // FIX (Bug #1): Use @current_restaurant_id session variable set by the pool proxy
  // All queries now explicitly filter by restaurant_id
  if (clientTable === 'sections' && row.floor_name) {
    const [[f]] = await conn.query(
      `SELECT id FROM _pos_floors_base WHERE restaurant_id = @current_restaurant_id AND name = ?`, 
      [row.floor_name]
    );
    if (f) row.floor_id = f.id;
  } else if (clientTable === 'menu_items' && row.category_name) {
    const [[c]] = await conn.query(
      `SELECT id FROM _pos_menu_categories_base WHERE restaurant_id = @current_restaurant_id AND name = ?`, 
      [row.category_name]
    );
    if (c) row.category_id = c.id;
  } else if (clientTable === 'order_items') {
    if (row.order_number !== undefined && row.order_number !== null) {
      const [[o]] = await conn.query(
        `SELECT id FROM _pos_orders_base WHERE restaurant_id = @current_restaurant_id AND order_number = ?`, 
        [row.order_number]
      );
      if (o) row.order_id = o.id;
    }
    if (row.menu_item_name) {
      const [[m]] = await conn.query(
        `SELECT id FROM _pos_menu_items_base WHERE restaurant_id = @current_restaurant_id AND name = ?`, 
        [row.menu_item_name]
      );
      if (m) row.menu_item_id = m.id;
    }
  } else if (['attendance', 'expenses', 'payroll'].includes(clientTable) && row.staff_username) {
    const [[s]] = await conn.query(
      `SELECT id FROM _pos_staff_base WHERE restaurant_id = @current_restaurant_id AND username = ?`, 
      [row.staff_username]
    );
    if (s) row.staff_id = s.id;
  } else if (clientTable === 'orders') {
    if (row.staff_username) {
      const [[s]] = await conn.query(
        `SELECT id FROM _pos_staff_base WHERE restaurant_id = @current_restaurant_id AND username = ?`, 
        [row.staff_username]
      );
      if (s) row.staff_id = s.id;
    }
    if (row.payment_staff_username) {
      const [[s]] = await conn.query(
        `SELECT id FROM _pos_staff_base WHERE restaurant_id = @current_restaurant_id AND username = ?`, 
        [row.payment_staff_username]
      );
      if (s) row.payment_received_by = s.id;
    }
    if (row.table_number) {
      let q = `SELECT id FROM _pos_tables_base WHERE restaurant_id = @current_restaurant_id AND number = ?`;
      const p = [row.table_number];
      if (row.table_section_id) { q += ` AND section_id = ?`; p.push(row.table_section_id); }
      const [[t]] = await conn.query(q, p);
      if (t) row.table_id = t.id;
    }
  } else if (clientTable === 'inventory_log') {
    if (row.item_name) {
      const [[i]] = await conn.query(
        `SELECT id FROM _pos_inventory_items_base WHERE restaurant_id = @current_restaurant_id AND name = ?`, 
        [row.item_name]
      );
      if (i) row.item_id = i.id;
    }
    if (row.staff_username) {
      const [[s]] = await conn.query(
        `SELECT id FROM _pos_staff_base WHERE restaurant_id = @current_restaurant_id AND username = ?`, 
        [row.staff_username]
      );
      if (s) row.staff_id = s.id;
    }
  }
}

async function findAttendanceMatch(conn, cloudTable, row) {
  // FIX (Bug #1): All queries use @current_restaurant_id session variable
  if (!row.clock_out && row.staff_id) {
    const [[r]] = await conn.query(
      `SELECT * FROM \`${cloudTable}\` WHERE restaurant_id = @current_restaurant_id AND staff_id = ? AND clock_out IS NULL LIMIT 1`, 
      [row.staff_id]
    );
    if (r) return r;
  }
  if (row.staff_id && row.clock_in) {
    const [rows] = await conn.query(
      `SELECT * FROM \`${cloudTable}\` WHERE restaurant_id = @current_restaurant_id AND staff_id = ? ORDER BY id DESC LIMIT 20`, 
      [row.staff_id]
    );
    const t = new Date(row.clock_in).getTime();
    for (const r of rows) {
      const ct = new Date(r.clock_in).getTime();
      if (!isNaN(t) && !isNaN(ct) && Math.abs(t - ct) < 120000) return r;
    }
  }
  if (row.id) {
    const [[r]] = await conn.query(
      `SELECT * FROM \`${cloudTable}\` WHERE id = ? AND restaurant_id = @current_restaurant_id LIMIT 1`, 
      [row.id]
    );
    if (r) return r;
  }
  return null;
}

async function doInsert(conn, cloudTable, clientTable, row, hlc, deviceId, errors) {
  const cols = [], vals = [], ph = [];
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || k === 'id' || (IGNORED_COLS.includes(k) && !(k === 'order_number' && clientTable === 'orders'))) continue;
    cols.push(`\`${k}\``); vals.push(v); ph.push('?');
  }
  if (row._hlc && !cols.includes('`hlc`')) {
    cols.push('`hlc`');             vals.push(row._hlc);                    ph.push('?');
    cols.push('`origin_device_id`');vals.push(row._origin_device_id || deviceId); ph.push('?');
  }
  if (cols.length === 0) {
    logger.warn(`No columns to insert for ${clientTable} - all columns were filtered out`);
    return;
  }
  
  // CRITICAL: Check if @current_restaurant_id is set
  const [[sessionVar]] = await conn.query('SELECT @current_restaurant_id as rid');
  logger.debug(`Session variable @current_restaurant_id = ${sessionVar.rid}`);
  
  const sql = `INSERT IGNORE INTO \`${cloudTable}\` (${cols.join(',')}) VALUES (${ph.join(',')})`;
  logger.info(`Inserting into ${cloudTable}: ${row.name || 'unnamed'}`);
  logger.debug(`SQL: ${sql}`);
  logger.debug(`Columns: ${cols.join(', ')}`);
  logger.debug(`Values: ${JSON.stringify(vals)}`);
  
  try {
    const [result] = await conn.query(sql, vals);
    logger.success(`Inserted ${result.affectedRows} row(s) into ${cloudTable} (insertId: ${result.insertId})`);
    
    // DIAGNOSTIC: Immediately check if row exists with the insertId
    if (result.insertId && result.affectedRows > 0) {
      try {
        const [[verifyRow]] = await conn.query(
          `SELECT id, restaurant_id FROM \`${cloudTable}\` WHERE id = ?`,
          [result.insertId]
        );
        
        if (verifyRow) {
          logger.success(`✅ VERIFIED: Row ${result.insertId} exists with restaurant_id=${verifyRow.restaurant_id}`);
        } else {
          logger.error(`❌ CRITICAL: Row ${result.insertId} NOT FOUND immediately after INSERT!`);
        }
      } catch (verifyErr) {
        // Verification failed, but insert may have succeeded - don't treat as fatal
        logger.debug(`Verification query failed: ${verifyErr.message}`);
      }
    } else if (result.affectedRows === 0) {
      logger.warn(`INSERT IGNORE had 0 affected rows - likely duplicate key`);
    }
  } catch (e) {
    logger.error(`Insert ${clientTable} failed: ${e.message}`);
    logger.debug(`SQL: ${sql}`);
    logger.debug(`Values: ${JSON.stringify(vals)}`);
    errors.push(`Insert ${clientTable}: ${e.message}`);
  }
}

async function doUpdate(conn, cloudTable, clientTable, existing, row, incomingHlc, deviceId, FIELD_LEVEL, errors) {
  const localHlc = existing.hlc || '';
  // If neither side has an HLC yet (legacy data), always accept the incoming row
  const incomingWins = !localHlc || !incomingHlc || hlcLib.compare(incomingHlc, localHlc) >= 0;
  const updates = {};
  if (FIELD_LEVEL[cloudTable]) {
    for (const field of FIELD_LEVEL[cloudTable]) {
      const hlcCol = `${field}_hlc`;
      const rowHlc = row._hlc || row.hlc || incomingHlc;
      const inFHlc = (row[hlcCol] && hlcLib.compare(row[hlcCol], rowHlc) >= 0) ? row[hlcCol] : rowHlc;
      const locFHlc = existing[hlcCol] || localHlc;
      // Accept if: incoming wins globally, OR incoming field HLC is >=
      if ((!locFHlc || hlcLib.compare(inFHlc, locFHlc) >= 0) && row[field] !== undefined && !IGNORED_COLS.includes(field)) {
        updates[field] = row[field];
        updates[hlcCol] = inFHlc || incomingHlc;
      }
    }
    if (incomingWins) {
      if (row.is_deleted !== undefined) updates.is_deleted = row.is_deleted;
      if (row.deleted_at !== undefined) updates.deleted_at = row.deleted_at;
      updates.hlc = incomingHlc || `${Date.now()}:0:cloud`;
      updates.origin_device_id = row._origin_device_id || deviceId;
    }
  } else {
    if (incomingWins) {
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('_') || k === 'id' || k === 'created_at' || (IGNORED_COLS.includes(k) && !(k === 'order_number' && clientTable === 'orders'))) continue;
        updates[k] = v;
      }
      updates.hlc = incomingHlc || `${Date.now()}:0:cloud`;
      updates.origin_device_id = row._origin_device_id || deviceId;
    }
  }
  if (Object.keys(updates).length === 0) return;
  const setCols = Object.keys(updates).map(k => `\`${k}\` = ?`);
  try {
    if (clientTable === 'settings') {
      const setVals = [...Object.values(updates), existing.key, existing.restaurant_id];
      await conn.query(`UPDATE \`${cloudTable}\` SET ${setCols.join(', ')} WHERE \`key\` = ? AND restaurant_id = ?`, setVals);
    } else {
      const setVals = [...Object.values(updates), existing.id];
      await conn.query(`UPDATE \`${cloudTable}\` SET ${setCols.join(', ')} WHERE id = ?`, setVals);
    }
  } catch (e) {
    errors.push(`Update ${clientTable}: ${e.message}`);
  }
}

// ─── HTTP endpoint wrappers ───────────────────────────────────────────────────

const importData = async (req, res) => {
  const peerData = req.body;
  if (!peerData || Object.keys(peerData).length === 0) {
    return res.status(400).json({ success: false, error: 'No data provided' });
  }
  const senderClientId = req.headers['x-client-id'] || 'unknown';
  const { asyncLocalStorage: als } = require('../config/db');
  const tenantStore = als.getStore();
  const restaurantId = tenantStore?.restaurantId ?? null;

  // V5: Validate Active Server lease and epoch if headers are present
  const incomingEpochStr = req.headers['x-server-epoch'];
  const incomingServerId = req.headers['x-server-id'];

  if (incomingEpochStr && incomingServerId && restaurantId) {
    try {
      const incomingEpoch = parseInt(incomingEpochStr, 10);
      const [rows] = await pool.query(
        'SELECT active_server_id, active_server_epoch FROM restaurants WHERE id = ?',
        [restaurantId]
      );
      
      if (rows.length > 0) {
        const { active_server_id, active_server_epoch } = rows[0];
        const registeredEpoch = active_server_epoch || 0;
        
        if (incomingEpoch < registeredEpoch) {
          console.warn(`[Epoch Conflict] Rejecting sync from server ${incomingServerId} with outdated epoch ${incomingEpoch} (cloud registered: ${registeredEpoch})`);
          return res.status(409).json({
            success: false,
            error: 'EPOCH_CONFLICT',
            message: `Server epoch (${incomingEpoch}) is outdated. Current active epoch is ${registeredEpoch}.`,
            currentEpoch: registeredEpoch,
            currentServerId: active_server_id
          });
        }

        // Update active server mapping if epoch advanced or server changed
        if (incomingEpoch > registeredEpoch || active_server_id !== incomingServerId) {
          await pool.query(
            'UPDATE restaurants SET active_server_id = ?, active_server_epoch = ? WHERE id = ?',
            [incomingServerId, incomingEpoch, restaurantId]
          );
          console.log(`[Replication Lease] Server ${incomingServerId} lease updated on cloud: epoch=${incomingEpoch}`);
        }
      }
    } catch (dbErr) {
      console.error('[Cloud Sync] Lease validation error:', dbErr.message);
      return res.status(500).json({ success: false, error: 'Cloud lease validation failed' });
    }
  }

  const result = await mergeImportPayload(peerData, senderClientId, restaurantId);
  if (!result.success) {
    return res.status(500).json({ success: false, error: result.error });
  }
  res.json({ success: true, processed: result.processed, errors: result.errors });
};


const getCloudDevices = async (req, res) => {
  try {
    const { asyncLocalStorage } = require('../config/db');
    const store = asyncLocalStorage.getStore();
    const restaurantId = store?.restaurantId ?? null;
    if (!restaurantId) return res.status(400).json({ success: false, error: 'No restaurant ID found.' });
    const broadcaster = require('../sockets/WebSocketBroadcaster');
    const devices = broadcaster.getConnectedDevices(restaurantId);
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  exportData,
  fullExportData,
  importData,
  mergeImportPayload,
  getCloudDevices,
  broadcastChange,
};
