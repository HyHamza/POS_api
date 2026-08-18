/**
 * roleController.js — Roles & Permissions REST Controller for POS_api
 */

'use strict';

const pool = require('../config/db');

const getRoles = async (req, res) => {
  try {
    const [roles] = await pool.query(
      'SELECT * FROM _pos_roles_base WHERE restaurant_id = @current_restaurant_id AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY name ASC'
    );

    const formatted = [];
    for (const r of roles) {
      const [perms] = await pool.query(
        'SELECT permission_id FROM _pos_role_permissions_base WHERE role_id = ? AND restaurant_id = @current_restaurant_id AND (is_deleted = 0 OR is_deleted IS NULL)',
        [r.id]
      );
      formatted.push({
        ...r,
        permissions: perms.map(p => p.permission_id)
      });
    }

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[RoleController] getRoles error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const createRole = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { name, description, permissions = [] } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Role name is required' });

    await conn.beginTransaction();

    const [existing] = await conn.query(
      'SELECT id FROM _pos_roles_base WHERE restaurant_id = @current_restaurant_id AND name = ? AND (is_deleted = 0 OR is_deleted IS NULL)',
      [name]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, error: 'Role name already exists' });
    }

    const [result] = await conn.query(
      'INSERT INTO _pos_roles_base (restaurant_id, name, description, is_system, created_at) VALUES (@current_restaurant_id, ?, ?, 0, NOW())',
      [name, description || null]
    );
    const roleId = result.insertId;

    for (const p of permissions) {
      await conn.query(
        'INSERT INTO _pos_role_permissions_base (restaurant_id, role_id, permission_id, is_deleted) VALUES (@current_restaurant_id, ?, ?, 0)',
        [roleId, p]
      );
    }

    await conn.commit();

    return res.status(201).json({
      success: true,
      data: { id: roleId, name, description, is_system: 0, permissions }
    });
  } catch (err) {
    await conn.rollback();
    console.error('[RoleController] createRole error:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

const updateRole = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { name, description, permissions = [] } = req.body;

    await conn.beginTransaction();

    const [existing] = await conn.query(
      'SELECT * FROM _pos_roles_base WHERE restaurant_id = @current_restaurant_id AND id = ?',
      [id]
    );
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'Role not found' });
    }

    const role = existing[0];
    if (role.is_system === 0 && name && name !== role.name) {
      const [conflict] = await conn.query(
        'SELECT id FROM _pos_roles_base WHERE restaurant_id = @current_restaurant_id AND name = ? AND id != ? AND (is_deleted = 0 OR is_deleted IS NULL)',
        [name, id]
      );
      if (conflict.length > 0) {
        await conn.rollback();
        return res.status(400).json({ success: false, error: 'Role name already exists' });
      }
      await conn.query(
        'UPDATE _pos_roles_base SET name = ?, description = ?, updated_at = NOW() WHERE id = ?',
        [name, description || null, id]
      );
    } else {
      await conn.query(
        'UPDATE _pos_roles_base SET description = ?, updated_at = NOW() WHERE id = ?',
        [description || null, id]
      );
    }

    await conn.query(
      'DELETE FROM _pos_role_permissions_base WHERE restaurant_id = @current_restaurant_id AND role_id = ?',
      [id]
    );

    for (const p of permissions) {
      await conn.query(
        'INSERT INTO _pos_role_permissions_base (restaurant_id, role_id, permission_id, is_deleted) VALUES (@current_restaurant_id, ?, ?, 0)',
        [id, p]
      );
    }

    await conn.commit();
    return res.json({ success: true, data: { id, name, description, permissions } });
  } catch (err) {
    await conn.rollback();
    console.error('[RoleController] updateRole error:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE _pos_roles_base SET is_deleted = 1 WHERE restaurant_id = @current_restaurant_id AND id = ?', [id]);
    return res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[RoleController] deleteRole error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getRoles,
  createRole,
  updateRole,
  deleteRole
};
