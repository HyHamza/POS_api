const { asyncLocalStorage, resolvePoolForLicense } = require('../config/db');

const tenantMiddleware = async (req, res, next) => {
  // Bypass tenant resolution for super-admin, verify-license and app-updates endpoints
  if (
    req.path.startsWith('/api/super-admin') || 
    req.path === '/api/auth/verify-license' ||
    req.path.startsWith('/api/app-updates')
  ) {
    return next();
  }

  const licenseKey = req.headers['x-license-key'] || req.query.license_key;

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'x-license-key header or license_key query parameter is required.'
    });
  }

  try {
    const result = await resolvePoolForLicense(licenseKey);
    if (!result || result.error) {
      const errStatus = result?.status || 'disabled';
      const errCode = result?.code || 403;
      return res.status(errCode).json({
        success: false,
        data: {
          licenseKey,
          licenseStatus: errStatus,
          planType: result?.planType || null,
          expiresAt: result?.expiresAt || null,
          serverTime: Date.now()
        },
        error: result?.error || 'Invalid or inactive restaurant license key.'
      });
    }

    // Run within AsyncLocalStorage context with resolved restaurantId
    asyncLocalStorage.run({ pool: result.pool, licenseKey, restaurantId: result.restaurantId }, () => {
      next();
    });
  } catch (err) {
    console.error(`[Tenant Middleware] Error resolving pool for license '${licenseKey}':`, err);
    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal database resolution error.'
    });
  }
};

module.exports = tenantMiddleware;
