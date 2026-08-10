const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

const asyncLocalStorage = new AsyncLocalStorage();

// Connection parameters for database server
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rider_tracking',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0
};

// Main pool pointing to the unified database
const mainPool = mysql.createPool(dbConfig);

// Helper to resolve a restaurant by its license key
async function resolvePoolForLicense(licenseKey) {
  if (!licenseKey) return null;

  try {
    // Query the unified database's restaurants table
    const [rows] = await mainPool.query(
      'SELECT id, name, status, plan_type, expires_at FROM restaurants WHERE license_key = ?',
      [licenseKey]
    );

    if (rows.length === 0) {
      console.warn(`[Tenant DB] License key '${licenseKey}' not found.`);
      return { error: 'License key not found.', status: 'invalid', code: 404 };
    }

    let { id, name, status, plan_type, expires_at } = rows[0];

    // Check expiration
    const expiresAtMs = expires_at ? new Date(expires_at).getTime() : null;
    const isExpired = expiresAtMs && Date.now() > expiresAtMs;
    const finalStatus = (status !== 'suspended' && status !== 'disabled' && isExpired) ? 'expired' : status;

    if (finalStatus === 'expired') {
      if (status !== 'expired') {
        await mainPool.query(
          'UPDATE restaurants SET status = ? WHERE id = ?',
          ['expired', id]
        );
      }
      console.warn(`[Tenant DB] License key '${licenseKey}' has expired.`);
      return {
        error: 'Plan expired and renew your plan.',
        status: 'expired',
        code: 401,
        planType: plan_type,
        expiresAt: expiresAtMs
      };
    }

    if (finalStatus !== 'active') {
      console.warn(`[Tenant DB] Restaurant ID '${id}' status is '${finalStatus}' (not active).`);
      return {
        error: `License key has been ${finalStatus}.`,
        status: finalStatus,
        code: 403,
        planType: plan_type,
        expiresAt: expiresAtMs
      };
    }

    // Return the unified pool alongside the resolved restaurant ID
    return {
      pool: mainPool,
      restaurantId: id,
      status: 'active'
    };
  } catch (err) {
    console.error(`[Tenant DB] Error resolving database for license '${licenseKey}':`, err);
    throw err;
  }
}

// Proxy handler to intercept pool calls and delegate to the active context pool
const poolProxy = new Proxy(mainPool, {
  get(target, prop) {
    const store = asyncLocalStorage.getStore();
    const activePool = mainPool;
    const restaurantId = store ? store.restaurantId : null;

    if (restaurantId !== null && restaurantId !== undefined) {
      // Intercept query and execute to set session variable @current_restaurant_id
      if (prop === 'query' || prop === 'execute') {
        return async (sql, values) => {
          let conn;
          try {
            conn = await activePool.getConnection();
            await conn.query('SET @current_restaurant_id = ?', [restaurantId]);
            return await conn[prop](sql, values);
          } finally {
            if (conn) conn.release();
          }
        };
      }

      // Intercept getConnection to set session variable @current_restaurant_id.
      // FIX (Bug #15): We also reset the variable to NULL on release() so that
      // a recycled connection from the pool never leaks a previous tenant's ID
      // to a subsequent request that doesn't go through this proxy.
      if (prop === 'getConnection') {
        return async () => {
          const conn = await activePool.getConnection();
          await conn.query('SET @current_restaurant_id = ?', [restaurantId]);

          // Wrap release() to clear the session variable before returning to pool
          const originalRelease = conn.release.bind(conn);
          conn.release = () => {
            // Use synchronous approach - query THEN release
            conn.query('SET @current_restaurant_id = NULL')
              .catch(() => {}) // Best-effort cleanup
              .finally(() => originalRelease());
          };

          return conn;
        };
      }
    }

    const value = Reflect.get(activePool, prop);
    if (typeof value === 'function') {
      return value.bind(activePool);
    }
    return value;
  }
});

module.exports = poolProxy;
module.exports.asyncLocalStorage = asyncLocalStorage;
module.exports.resolvePoolForLicense = resolvePoolForLicense;
module.exports.mainPool = mainPool;
module.exports.dbConfig = dbConfig;
