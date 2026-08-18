/**
 * settingController.js — Settings & Theme REST Controller for POS_api
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
    console.warn('[SettingController] Socket broadcast error:', err.message);
  }
}

const getAllSettings = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT `key`, `value` FROM pos_settings');
    const settingsMap = {};
    for (const r of rows) {
      settingsMap[r.key] = r.value;
    }
    return res.json({ success: true, data: settingsMap });
  } catch (err) {
    console.error('[SettingController] getAllSettings error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const [rows] = await pool.query('SELECT `value` FROM pos_settings WHERE `key` = ?', [key]);
    if (rows.length === 0) return res.json({ success: true, data: null });
    return res.json({ success: true, data: rows[0].value });
  } catch (err) {
    console.error('[SettingController] getSetting error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const setSetting = async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'Setting key is required' });

    const valStr = value !== undefined && value !== null ? String(value) : '';

    await pool.query(`
      INSERT INTO _pos_settings_base (restaurant_id, \`key\`, \`value\`)
      VALUES (@current_restaurant_id, ?, ?)
      ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)
    `, [key, valStr]);

    return res.json({ success: true, data: { key, value: valStr } });
  } catch (err) {
    console.error('[SettingController] setSetting error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const broadcastTheme = async (req, res) => {
  try {
    const themeConfig = req.body;
    broadcastTenantEvent('theme:change', themeConfig);
    return res.json({ success: true });
  } catch (err) {
    console.error('[SettingController] broadcastTheme error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllSettings,
  getSetting,
  setSetting,
  broadcastTheme
};
