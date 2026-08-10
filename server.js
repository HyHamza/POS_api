const express = require('express');
// trigger nodemon restart to update schema views
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');
const pool = require('./config/db');
const { asyncLocalStorage } = require('./config/db');

require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const riderRoutes = require('./routes/riderRoutes');
const taskRoutes = require('./routes/taskRoutes');
const posRoutes = require('./routes/posRoutes');
const healthRoutes = require('./routes/healthRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const tenantMiddleware = require('./middleware/tenant');
const apiLogger = require('./middleware/logger');

const app = express();
// Trust the first proxy (e.g. Nginx/Load Balancer) to resolve client IPs correctly for rate-limiting
app.set('trust proxy', 1);
const server = http.createServer(app);

// Configure CORS using environment whitelist
const corsOriginEnv = process.env.CORS_ORIGIN || '';
const whitelist = corsOriginEnv.split(',').map(item => item.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin || whitelist.includes(origin) || whitelist.includes('*')) {
      return callback(null, true);
    }

    try {
      const url = new URL(origin);
      // Allow local loopback addresses and localhost on any port for local development and testing
      if (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]'
      ) {
        return callback(null, true);
      }
    } catch (err) {
      // If parsing fails, fall through to reject
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(helmet({
  contentSecurityPolicy: false // Disable CSP for easier local super admin panel UI load
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Incoming Request: ${req.method} ${req.originalUrl} from ${req.ip}`);
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Super Admin Static hosting and API routes (unaffected by tenantMiddleware)
app.use('/api/super-admin', superAdminRoutes);

// Apply Tenant routing middleware globally for all standard business APIs
app.use(tenantMiddleware);
app.use(apiLogger);

// Attach standard business routes
app.use('/api/auth', authRoutes);
app.use('/api/riders', riderRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/health', healthRoutes);

// Database connection sanity test & auto schema generation on startup
async function testDbConnection() {
  try {
    const [rows] = await pool.query('SELECT 1');
    console.log(`[${new Date().toISOString()}] Database pool connected successfully.`);

    // Always execute schema.sql to ensure idempotent creation of missing views, triggers, functions and tables
    console.log('[Startup] Verifying unified database schema (tables, views, triggers, functions)...');
    const fs = require('fs');
    let schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      schemaPath = path.join(__dirname, '..', 'schema.sql');
    }
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');

      // FIX (Bug #9): Simple split(';') breaks stored procedures and triggers that
      // contain semicolons inside BEGIN...END blocks. Use a depth-aware splitter
      // that only splits on ';' when we are outside a BEGIN/END block.
      const splitSqlStatements = (sql) => {
        const stmts = [];
        let depth = 0;
        let current = '';
        // Tokenise by keywords and semicolons (case-insensitive)
        const tokenRe = /BEGIN|END|;/gi;
        let lastIndex = 0;
        let match;
        while ((match = tokenRe.exec(sql)) !== null) {
          const token = match[0].toUpperCase();
          if (token === 'BEGIN') {
            depth++;
            current += sql.slice(lastIndex, match.index + match[0].length);
            lastIndex = match.index + match[0].length;
          } else if (token === 'END') {
            if (depth > 0) depth--;
            current += sql.slice(lastIndex, match.index + match[0].length);
            lastIndex = match.index + match[0].length;
          } else if (token === ';' && depth === 0) {
            current += sql.slice(lastIndex, match.index);
            lastIndex = match.index + 1;
            const trimmed = current.trim();
            if (trimmed.length > 0) stmts.push(trimmed);
            current = '';
          }
        }
        // Capture any trailing content after the last ';'
        current += sql.slice(lastIndex);
        const trimmed = current.trim();
        if (trimmed.length > 0) stmts.push(trimmed);
        return stmts;
      };

      const statements = splitSqlStatements(schemaSql);

      // Disable FK checks during schema creation so table order doesn't matter
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (stmtErr) {
          // Ignore duplicate index/key errors and already-exists errors on existing database
          if (stmtErr.code !== 'ER_DUP_KEYNAME' && stmtErr.code !== 'ER_TABLE_EXISTS_ERROR') {
            console.warn(`[Startup] Schema stmt warning (${stmtErr.code}): ${stmtErr.message.slice(0, 120)}`);
          }
        }
      }
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log('[Startup] Unified schema verified.');
    }

    // Run V2 Sync Migration (Adds HLC, soft-delete columns)
    let v2MigrationPath = path.join(__dirname, 'migration_v2_cloud.sql');
    if (fs.existsSync(v2MigrationPath)) {
      console.log('[Startup] Running migration_v2_cloud.sql...');
      const v2Sql = fs.readFileSync(v2MigrationPath, 'utf8');
      try {
        // Parse the migration file using RegEx to extract the intent of CALL statements.
        // This avoids MariaDB-specific DELIMITER syntax errors when executing through mysql2.
        
        // Match CALL _add_column_if_not_exists('table', 'col', 'def')
        const colRegex = /CALL _add_column_if_not_exists\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
        let colMatch;
        let colAdded = 0;
        while ((colMatch = colRegex.exec(v2Sql)) !== null) {
          const [, table, col, def] = colMatch;
          try {
            await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
            colAdded++;
          } catch (e) {
            // ER_DUP_FIELDNAME (1060) is expected and safe to ignore
            if (e.code !== 'ER_DUP_FIELDNAME') {
              console.warn(`[Startup] Warning adding column ${table}.${col}:`, e.message);
            }
          }
        }

        // Match CALL _add_index_if_not_exists('table', 'idx_name', 'cols')
        const idxRegex = /CALL _add_index_if_not_exists\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
        let idxMatch;
        let idxAdded = 0;
        while ((idxMatch = idxRegex.exec(v2Sql)) !== null) {
          const [, table, idxName, cols] = idxMatch;
          try {
            await pool.query(`CREATE INDEX \`${idxName}\` ON \`${table}\` (${cols})`);
            idxAdded++;
          } catch (e) {
            // ER_DUP_KEYNAME (1061) is expected and safe to ignore
            if (e.code !== 'ER_DUP_KEYNAME') {
              console.warn(`[Startup] Warning adding index ${idxName} on ${table}:`, e.message);
            }
          }
        }
        
        console.log(`[Startup] migration_v2_cloud.sql verified. Added ${colAdded} columns and ${idxAdded} indexes.`);
      } catch (mErr) {
        console.error('[Startup Warning] migration_v2_cloud.sql failed:', mErr.message);
      }
    }

    // Run V3 Cashier & Dispatcher Migration (Adds payment tracking columns)
    let v3MigrationPath = path.join(__dirname, 'migration_v3_cashier.sql');
    if (fs.existsSync(v3MigrationPath)) {
      console.log('[Startup] Running migration_v3_cashier.sql...');
      const v3Sql = fs.readFileSync(v3MigrationPath, 'utf8');
      try {
        // Parse the migration file using RegEx to extract the intent of CALL statements.
        
        // Match CALL _add_column_if_not_exists('table', 'col', 'def')
        const colRegex = /CALL _add_column_if_not_exists\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
        let colMatch;
        let colAdded = 0;
        while ((colMatch = colRegex.exec(v3Sql)) !== null) {
          const [, table, col, def] = colMatch;
          try {
            await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
            colAdded++;
          } catch (e) {
            // ER_DUP_FIELDNAME (1060) is expected and safe to ignore
            if (e.code !== 'ER_DUP_FIELDNAME') {
              console.warn(`[Startup] Warning adding column ${table}.${col}:`, e.message);
            }
          }
        }

        // Run other queries in the v3 sql file that are not _add_column_if_not_exists (e.g. constraints, indexes, updates)
        const v3Statements = v3Sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.toLowerCase().includes('_add_column_if_not_exists'));
        for (const stmt of v3Statements) {
          if (stmt.toLowerCase().startsWith('call _add_index_if_not_exists')) {
            // CALL _add_index_if_not_exists('table', 'idx_name', 'cols')
            const idxRegex = /CALL _add_index_if_not_exists\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/gi;
            const match = idxRegex.exec(stmt);
            if (match) {
              const [, table, idxName, cols] = match;
              try {
                await pool.query(`CREATE INDEX \`${idxName}\` ON \`${table}\` (${cols})`);
              } catch (e) {
                if (e.code !== 'ER_DUP_KEYNAME') {
                  console.warn(`[Startup] Warning adding index ${idxName} on ${table}:`, e.message);
                }
              }
            }
          } else if (stmt.toLowerCase().startsWith('set @') || stmt.toLowerCase().startsWith('prepare') || stmt.toLowerCase().startsWith('execute') || stmt.toLowerCase().startsWith('deallocate')) {
            continue;
          } else if (stmt.toLowerCase().includes('alter table _pos_orders_base add constraint fk_payment_staff')) {
            try {
              await pool.query(`
                ALTER TABLE _pos_orders_base 
                ADD CONSTRAINT fk_payment_staff 
                FOREIGN KEY (payment_received_by) 
                REFERENCES _pos_staff_base(id) 
                ON DELETE SET NULL
              `);
            } catch (e) {
              if (!e.message.toLowerCase().includes('duplicate') && !e.message.toLowerCase().includes('already exists')) {
                console.warn('[Startup] Constraint warning:', e.message);
              }
            }
          } else {
            try {
              await pool.query(stmt);
            } catch (e) {
              console.warn('[Startup] V3 Migration stmt warning:', e.message);
            }
          }
        }
        console.log(`[Startup] migration_v3_cashier.sql verified. Added ${colAdded} columns.`);
      } catch (mErr) {
        console.error('[Startup Warning] migration_v3_cashier.sql failed:', mErr.message);
      }
    }

    // Check and add plan_type and expires_at to restaurants table if they don't exist
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurants' AND COLUMN_NAME = 'plan_type'
    `);
    if (columns.length === 0) {
      console.log('[Startup] Adding plan_type and expires_at columns to restaurants table...');
      await pool.query(`
        ALTER TABLE restaurants 
        ADD COLUMN plan_type VARCHAR(50) DEFAULT 'lifetime',
        ADD COLUMN expires_at DATETIME DEFAULT NULL;
      `);
    }

    const [serverCols] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurants' AND COLUMN_NAME = 'active_server_id'
    `);
    if (serverCols.length === 0) {
      console.log('[Startup] Adding active_server_id and active_server_epoch columns to restaurants table...');
      await pool.query(`
        ALTER TABLE restaurants 
        ADD COLUMN active_server_id VARCHAR(50) DEFAULT NULL,
        ADD COLUMN active_server_epoch INT DEFAULT 0;
      `);
    }


    // Check and add order_number column to _tasks_base table if it doesn't exist
    const [tasksTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_tasks_base'
    `);
    if (tasksTableExists.length > 0) {
      const [taskColumns] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_tasks_base' AND COLUMN_NAME = 'order_number'
      `);
      if (taskColumns.length === 0) {
        console.log('[Startup] Adding order_number column to _tasks_base table...');
        await pool.query(`ALTER TABLE _tasks_base ADD COLUMN order_number VARCHAR(255) DEFAULT NULL`);
      }
    }

    // Check and add rider_name column to _pos_orders_base table if it doesn't exist
    const [ordersTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_orders_base'
    `);
    if (ordersTableExists.length > 0) {
      const [orderColumns] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_orders_base' AND COLUMN_NAME = 'rider_name'
      `);
      if (orderColumns.length === 0) {
        console.log('[Startup] Adding rider_name column to _pos_orders_base table...');
        await pool.query(`ALTER TABLE _pos_orders_base ADD COLUMN rider_name VARCHAR(255) DEFAULT NULL`);
      }
    }

    // Check and add permissions column to _pos_staff_base table if it doesn't exist
    const [staffTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_staff_base'
    `);
    if (staffTableExists.length > 0) {
      const [staffColumns] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_staff_base' AND COLUMN_NAME = 'permissions'
      `);
      if (staffColumns.length === 0) {
        console.log('[Startup] Adding permissions column to _pos_staff_base table...');
        await pool.query(`ALTER TABLE _pos_staff_base ADD COLUMN permissions TEXT DEFAULT NULL`);
      }

      const [dutyHoursColumns] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_staff_base' AND COLUMN_NAME = 'daily_duty_hours'
      `);
      if (dutyHoursColumns.length === 0) {
        console.log('[Startup] Adding daily_duty_hours column to _pos_staff_base table...');
        try {
          await pool.query(`ALTER TABLE _pos_staff_base ADD COLUMN daily_duty_hours INT DEFAULT 8`);
        } catch (e) {
          if (e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
          await pool.query(`CREATE OR REPLACE VIEW pos_staff AS SELECT * FROM _pos_staff_base WHERE restaurant_id = current_restaurant_id()`);
        } catch (e) {
          console.warn('[Startup Warning] Failed to recreate pos_staff view:', e.message);
        }
      }
    }

    // Check and add overtime columns to _pos_payroll_base table if they don't exist
    const [payrollTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_payroll_base'
    `);
    if (payrollTableExists.length > 0) {
      const [overtimeColumns] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_payroll_base' AND COLUMN_NAME = 'overtime_hours'
      `);
      if (overtimeColumns.length === 0) {
        console.log('[Startup] Adding overtime_hours and overtime_salary columns to _pos_payroll_base table...');
        try {
          await pool.query(`ALTER TABLE _pos_payroll_base ADD COLUMN overtime_hours DOUBLE DEFAULT 0, ADD COLUMN overtime_salary DOUBLE DEFAULT 0`);
        } catch (e) {
          if (e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
        try {
          await pool.query(`CREATE OR REPLACE VIEW pos_payroll AS SELECT * FROM _pos_payroll_base WHERE restaurant_id = current_restaurant_id()`);
        } catch (e) {
          console.warn('[Startup Warning] Failed to recreate pos_payroll view:', e.message);
        }
      }
    }


    // FIX (Bug #6): Ensure refresh_token_hash column exists on _riders_base
    const [ridersTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_riders_base'
    `);
    if (ridersTableExists.length > 0) {
      const [riderTokenCols] = await pool.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_riders_base' AND COLUMN_NAME = 'refresh_token_hash'
      `);
      if (riderTokenCols.length === 0) {
        console.log('[Startup] Adding refresh_token_hash column to _riders_base table...');
        await pool.query(`ALTER TABLE _riders_base ADD COLUMN refresh_token_hash VARCHAR(64) DEFAULT NULL`);
      }
    }

    // Check and create _pos_customers_base table if it doesn't exist
    const [customersTableExists] = await pool.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_pos_customers_base'
    `);
    if (customersTableExists.length === 0) {
      console.log('[Startup] Creating _pos_customers_base table, views, and triggers...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS _pos_customers_base (
          id VARCHAR(64) PRIMARY KEY,
          restaurant_id INT NULL DEFAULT NULL,
          phone VARCHAR(32) NOT NULL,
          name VARCHAR(255) DEFAULT NULL,
          address TEXT DEFAULT NULL,
          hlc VARCHAR(64) DEFAULT NULL,
          is_deleted TINYINT DEFAULT 0,
          origin_device_id VARCHAR(64) DEFAULT NULL,
          sync_device_id VARCHAR(64) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_customer_phone_rest (restaurant_id, phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      
      await pool.query(`
        CREATE OR REPLACE VIEW pos_customers AS 
        SELECT * FROM _pos_customers_base 
        WHERE restaurant_id = current_restaurant_id() WITH CHECK OPTION
      `);
      
      await pool.query(`DROP TRIGGER IF EXISTS t_pos_customers_insert`);
      await pool.query(`
        CREATE TRIGGER t_pos_customers_insert BEFORE INSERT ON _pos_customers_base 
        FOR EACH ROW SET NEW.restaurant_id = IF(NEW.restaurant_id IS NULL OR NEW.restaurant_id = 0, @current_restaurant_id, NEW.restaurant_id)
      `);
    }

    // Ensure restaurant_id permits NULL across base tables so BEFORE INSERT triggers can auto-populate tenant ID
    const baseTables = [
      '_admins_base', '_pos_settings_base', '_pos_staff_base', '_pos_attendance_base',
      '_pos_menu_categories_base', '_pos_menu_items_base', '_pos_floors_base',
      '_pos_sections_base', '_pos_tables_base', '_pos_orders_base', '_pos_order_items_base',
      '_pos_inventory_items_base', '_pos_inventory_log_base', '_pos_expenses_base',
      '_pos_payroll_base', '_pos_activity_logs_base', '_riders_base',
      '_rider_latest_location_base', '_rider_locations_base', '_rider_sessions_base', '_tasks_base',
      '_pos_customers_base'
    ];
    for (const tbl of baseTables) {
      try {
        await pool.query(`ALTER TABLE \`${tbl}\` MODIFY \`restaurant_id\` INT NULL DEFAULT NULL`);
      } catch (_) {}
    }

      // Ensure super_admins table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS super_admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);


  } catch (err) {
    console.error(`[${new Date().toISOString()}] Database connection or migration error on startup:`, err);
    process.exit(1);
  }
}
testDbConnection();

// Initialize Socket.IO with relaxed ping settings for mobile networks (Bug #8)
const io = socketIo(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: {
    origin: whitelist.includes('*') ? '*' : whitelist,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});
app.set('io', io);

// Helper to scope Socket.IO rooms dynamically by license key in Express controller contexts
function getTenantIo(originalIo, licenseKey) {
  return new Proxy(originalIo, {
    get(target, prop) {
      if (prop === 'to' || prop === 'in') {
        return (room) => {
          let scopedRoom = room;
          // Only append the licenseKey if the room string is not already scoped (either ending with it or containing it)
          if (room && typeof room === 'string' && !room.endsWith(`:${licenseKey}`) && !room.includes(`:${licenseKey}:`)) {
            scopedRoom = `${room}:${licenseKey}`;
          }
          return getTenantIo(target.to(scopedRoom), licenseKey);
        };
      }
      const val = Reflect.get(target, prop);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    }
  });
}

// FIX (Bug #10): The previous override replaced app.get entirely, which could
// interfere with Express's own app.get(path, handler) route registration.
// We now only intercept the single-string settings-lookup form (app.get('io'))
// and pass through all other calls (route registration with 2+ args) untouched.
const originalGet = app.get.bind(app);
app.get = function (name, ...rest) {
  // If called as a route registration (app.get('/path', handler)), delegate directly
  if (rest.length > 0) {
    return originalGet(name, ...rest);
  }
  // Settings lookup: intercept 'io' to return tenant-scoped proxy
  if (name === 'io') {
    const originalIo = originalGet('io');
    const store = asyncLocalStorage.getStore();
    if (store && store.licenseKey) {
      return getTenantIo(originalIo, store.licenseKey);
    }
    return originalIo;
  }
  return originalGet(name);
};

// Wire up Socket.IO event controllers
require('./sockets/locationSocket')(io);

// Daily midnight cron job to prune location history older than 7 days (runs on base table)
cron.schedule('0 0 * * *', async () => {
  console.log(`[${new Date().toISOString()}] Running daily midnight retention pruning...`);
  try {
    const [result] = await pool.query(
      'DELETE FROM _rider_locations_base WHERE recorded_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)'
    );
    console.log(`[${new Date().toISOString()}] Pruning complete. Deleted ${result.affectedRows} coordinates.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Pruning failed:`, err);
  }
});

// ─── Staleness Watchdog (Unified Database Base Table Scan) ────────────────────
setInterval(async () => {
  try {
    const [staleRiders] = await pool.query(`
      SELECT r.id, r.status, r.restaurant_id, rest.license_key
      FROM _riders_base r
      JOIN restaurants rest ON r.restaurant_id = rest.id
      WHERE r.status != 'offline'
        AND r.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM _rider_sessions_base rs WHERE rs.rider_id = r.id
        )
    `);

    if (staleRiders.length === 0) return;

    for (const rider of staleRiders) {
      const riderId = rider.id;
      const { license_key, restaurant_id } = rider;

      // Update status in base DB table directly
      await pool.query('UPDATE _riders_base SET status = ? WHERE id = ?', ['offline', riderId]);

      // Broadcast to that tenant's admin room specifically
      io.to(`admin:${license_key}`).emit('rider:offline', { riderId });
      io.to(`admin:${license_key}`).emit('rider:status:update', { riderId, status: 'offline' });

      console.log(`[Watchdog] Tenant ${restaurant_id} Rider ${riderId} (was: ${rider.status}) marked offline.`);
    }
  } catch (err) {
    console.error('[Watchdog] Error during staleness check:', err);
  }
}, 15000); // Run every 15 seconds

// JSON 404 Route handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    data: null,
    error: 'Endpoint not found.'
  });
});

// General JSON Error handling middleware
app.use((err, req, res, next) => {
  console.error('API Error:', err);
  res.status(500).json({
    success: false,
    data: null,
    error: 'An internal server error occurred.'
  });
});

const PORT = process.env.PORT || 3000;

// Attach Custom Strict Tenant WebSocket Push Layer
const webSocketBroadcaster = require('./sockets/WebSocketBroadcaster');
webSocketBroadcaster.attach(server);

// Listen on 0.0.0.0 for external network access
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Server running on http://0.0.0.0:${PORT}`);
});

// Graceful Shutdown implementation
const shutdown = () => {
  console.log(`[${new Date().toISOString()}] Shutting down server gracefully...`);

  webSocketBroadcaster.shutdown();

  server.close(() => {
    console.log('HTTP and Socket server closed.');

    pool.end().then(() => {
      console.log('Database pool closed.');
      process.exit(0);
    }).catch(err => {
      console.error('Error closing database pool:', err);
      process.exit(1);
    });
  });

  setTimeout(() => {
    console.error('Forcefully terminating server.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = server;
// Touch to restart server for migration v3 HLC columns update (v3)

