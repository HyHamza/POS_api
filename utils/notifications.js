// NOTIFICATION PLACEHOLDER
// Replace this module with Firebase Cloud Messaging (FCM) or
// OneSignal when push notifications are ready.
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const pool = require('../config/db');

// Initialize Firebase Admin SDK
let fcmInitialized = false;
try {
  const serviceAccount = require('../config/serviceAccountKey.json');
  initializeApp({
    credential: cert(serviceAccount)
  });
  fcmInitialized = true;
  console.log('[Notification] Firebase Admin SDK initialized successfully.');
} catch (err) {
  console.warn('[Notification] Failed to initialize Firebase Admin SDK:', err.message);
}

async function sendTaskNotification(riderId, task) {
  if (!fcmInitialized) {
    console.log(`[Notification Placeholder (FCM not initialized)] Task ${task.id} → Rider ${riderId}`);
    return;
  }

  try {
    // Check if the rider is on duty (clocked in)
    const [attendanceRows] = await pool.query(
      `SELECT a.id FROM _pos_attendance_base a
       JOIN _pos_staff_base s ON a.staff_id = s.id
       JOIN _riders_base r ON s.username = r.username AND s.restaurant_id = r.restaurant_id
       WHERE r.id = ? AND r.restaurant_id = ? AND a.date = CURDATE() AND a.clock_out IS NULL`,
      [riderId, task.restaurant_id]
    );

    if (attendanceRows.length === 0) {
      console.log(`[Notification] Rider ${riderId} is off-duty. Skipping push notification.`);
      return;
    }

    const [rows] = await pool.query('SELECT fcm_token FROM _riders_base WHERE id = ?', [riderId]);
    if (rows.length === 0 || !rows[0].fcm_token) {
      console.log(`[Notification] No FCM token found in DB for Rider ${riderId}.`);
      return;
    }

    const token = rows[0].fcm_token;
    const message = {
      token: token,
      notification: {
        title: task.notification_title || 'New Delivery Task!',
        body: task.notification_body || `Task #${task.id || ''}: Delivery to ${task.delivery_address || 'Customer'}`
      },
      data: {
        taskId: String(task.id || ''),
        type: 'TASK_ASSIGNED'
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          sound: 'default'
        }
      }
    };

    const response = await getMessaging().send(message);
    console.log(`[Notification] Successfully sent push notification to Rider ${riderId}:`, response);
  } catch (error) {
    console.error(`[Notification] Error sending push notification to Rider ${riderId}:`, error.message);
  }
}

async function sendAdminAlert(message) {
  console.log(`[Admin Alert] ${message}`);
}

module.exports = { sendTaskNotification, sendAdminAlert };
