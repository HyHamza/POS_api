const { mainPool } = require('../config/db');

const VERSION_RE = /^\d+\.\d+\.\d+([-.].+)?$/;   // semver-ish
const SHA256_RE  = /^[a-fA-F0-9]{64}$/;

function isValidExeUrl(url) {
  const str = String(url || '').trim();
  return /^https:\/\//i.test(str) || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(str);
}

// GET /api/super-admin/app-releases  → list all (super admin)
const listReleases = async (req, res) => {
  try {
    const [rows] = await mainPool.query('SELECT * FROM app_releases ORDER BY created_at DESC');
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[AppReleases] list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch app releases.' });
  }
};

// POST /api/super-admin/app-releases  → create (super admin)
const createRelease = async (req, res) => {
  const {
    version, platform = 'win', exe_url, changelog = null,
    file_size = null, sha256 = null, is_active = 1, mandatory = 0,
  } = req.body || {};

  if (!version || !exe_url)
    return res.status(400).json({ success: false, error: 'version and exe_url are required.' });
  if (!VERSION_RE.test(String(version).trim()))
    return res.status(400).json({ success: false, error: 'version must look like 1.2.3' });
  if (!isValidExeUrl(exe_url))
    return res.status(400).json({ success: false, error: 'exe_url must be an https URL (or http://localhost for testing).' });
  if (sha256 && !SHA256_RE.test(String(sha256).trim()))
    return res.status(400).json({ success: false, error: 'sha256 must be 64 hex chars.' });

  const conn = await mainPool.getConnection();
  let txStarted = false;
  try {
    await conn.beginTransaction();
    txStarted = true;
    if (Number(is_active) === 1) {
      await conn.query('UPDATE app_releases SET is_active = 0 WHERE platform = ?', [platform]);
    }
    const [result] = await conn.query(
      `INSERT INTO app_releases (version, platform, exe_url, changelog, file_size, sha256, mandatory, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(version).trim(), platform, String(exe_url).trim(), changelog,
       file_size || null, sha256 ? String(sha256).trim().toLowerCase() : null,
       Number(mandatory) ? 1 : 0, Number(is_active) ? 1 : 0]
    );
    await conn.commit();
    const [rows] = await conn.query('SELECT * FROM app_releases WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (txStarted) await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, error: 'That version already exists for this platform.' });
    console.error('[AppReleases] create error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create release.' });
  } finally {
    conn.release();
  }
};

// PUT /api/super-admin/app-releases/:id  → update (super admin)
const updateRelease = async (req, res) => {
  const { id } = req.params;
  const fields = ['version', 'platform', 'exe_url', 'changelog', 'file_size', 'sha256', 'mandatory', 'is_active'];
  const sets = [], vals = [];
  let is_active_val = undefined;
  let platform_val = undefined;

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      let v = req.body[f];
      if (f === 'sha256' && v) v = String(v).trim().toLowerCase();
      if (f === 'sha256' && v && !SHA256_RE.test(v))
        return res.status(400).json({ success: false, error: 'sha256 must be 64 hex chars.' });
      if (f === 'version' && !VERSION_RE.test(String(v).trim()))
        return res.status(400).json({ success: false, error: 'version must look like 1.2.3' });
      if (f === 'exe_url' && !isValidExeUrl(v))
        return res.status(400).json({ success: false, error: 'exe_url must be an https URL (or http://localhost for testing).' });
      
      if (f === 'is_active') is_active_val = Number(v);
      if (f === 'platform') platform_val = String(v).trim();
      
      sets.push(`${f} = ?`); vals.push(v);
    }
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update.' });

  const conn = await mainPool.getConnection();
  let txStarted = false;
  try {
    await conn.beginTransaction();
    txStarted = true;

    if (is_active_val === 1) {
      let plat = platform_val;
      if (!plat) {
        const [rows] = await conn.query('SELECT platform FROM app_releases WHERE id = ?', [id]);
        if (rows.length) plat = rows[0].platform;
      }
      if (plat) {
        await conn.query('UPDATE app_releases SET is_active = 0 WHERE platform = ?', [plat]);
      }
    }

    vals.push(id);
    const [r] = await conn.query(`UPDATE app_releases SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (!r.affectedRows) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ success: false, error: 'Release not found.' });
    }

    await conn.commit();
    const [rows] = await mainPool.query('SELECT * FROM app_releases WHERE id = ?', [id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (txStarted) await conn.rollback().catch(() => {});
    console.error('[AppReleases] update error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update release.' });
  } finally {
    conn.release();
  }
};

// PUT /api/super-admin/app-releases/:id/activate  → make this the single active release for its platform
const activateRelease = async (req, res) => {
  const { id } = req.params;
  const conn = await mainPool.getConnection();
  let txStarted = false;
  try {
    const [rows] = await conn.query('SELECT platform FROM app_releases WHERE id = ?', [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Release not found.' });
    }
    await conn.beginTransaction();
    txStarted = true;
    await conn.query('UPDATE app_releases SET is_active = 0 WHERE platform = ?', [rows[0].platform]);
    await conn.query('UPDATE app_releases SET is_active = 1 WHERE id = ?', [id]);
    await conn.commit();
    return res.json({ success: true, data: { id: Number(id), is_active: 1 } });
  } catch (err) {
    if (txStarted) await conn.rollback().catch(() => {});
    console.error('[AppReleases] activate error:', err);
    return res.status(500).json({ success: false, error: 'Failed to activate release.' });
  } finally {
    conn.release();
  }
};

// DELETE /api/super-admin/app-releases/:id
const deleteRelease = async (req, res) => {
  try {
    const [r] = await mainPool.query('DELETE FROM app_releases WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, error: 'Release not found.' });
    return res.json({ success: true, data: { id: Number(req.params.id) } });
  } catch (err) {
    console.error('[AppReleases] delete error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete release.' });
  }
};

// GET /api/app-updates/latest?platform=win  → PUBLIC (no license required). Used by POS_win.
const getLatestPublic = async (req, res) => {
  const platform = (req.query.platform || 'win').toString();
  try {
    const [rows] = await mainPool.query(
      `SELECT version, platform, exe_url, changelog, file_size, sha256, mandatory, created_at
       FROM app_releases WHERE platform = ? AND is_active = 1
       ORDER BY created_at DESC LIMIT 1`,
      [platform]
    );
    if (!rows.length) return res.json({ success: true, data: null });   // no release published yet
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[AppReleases] public latest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch latest version.' });
  }
};

module.exports = { listReleases, createRelease, updateRelease, activateRelease, deleteRelease, getLatestPublic };
