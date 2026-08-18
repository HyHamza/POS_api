/**
 * activityController.js — Activity Logs REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getAllActivities = async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const [rows] = await pool.query(`
      SELECT * FROM pos_activity_logs 
      ORDER BY created_at DESC LIMIT ?
    `, [parseInt(limit, 10)]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[ActivityController] getAllActivities error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const logActivity = async (req, res) => {
  try {
    const {
      user_id, user_type, user_name, section, action_type, description, metadata
    } = req.body;

    const metaStr = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;

    await pool.query(`
      INSERT INTO pos_activity_logs 
      (user_id, user_type, user_name, section, action_type, description, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      user_id || req.user?.id || null,
      user_type || req.user?.role || 'Staff',
      user_name || req.user?.name || req.user?.username || 'User',
      section || 'General',
      action_type || 'Action',
      description || '',
      metaStr || null
    ]);

    return res.json({ success: true });
  } catch (err) {
    console.error('[ActivityController] logActivity error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllActivities,
  logActivity
};
