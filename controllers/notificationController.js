/**
 * notificationController.js — Notifications REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getAllNotifications = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM pos_notifications 
      ORDER BY created_at DESC LIMIT 100
    `);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[NotificationController] getAllNotifications error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const markRead = async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('UPDATE pos_notifications SET is_read = 1 WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[NotificationController] markRead error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const markAllRead = async (req, res) => {
  try {
    await pool.query('UPDATE pos_notifications SET is_read = 1 WHERE 1=1');
    return res.json({ success: true });
  } catch (err) {
    console.error('[NotificationController] markAllRead error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pos_notifications WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[NotificationController] deleteNotification error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const clearAll = async (req, res) => {
  try {
    await pool.query('DELETE FROM pos_notifications WHERE 1=1');
    return res.json({ success: true });
  } catch (err) {
    console.error('[NotificationController] clearAll error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllNotifications,
  markRead,
  markAllRead,
  deleteNotification,
  clearAll
};
