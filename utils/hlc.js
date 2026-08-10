/**
 * hlc.js — Hybrid Logical Clock (HLC)
 *
 * Implements the HLC algorithm from Kulkarni et al. for causality-preserving
 * timestamps across distributed devices with bounded clock skew.
 *
 * HLC format: "<physical_ms>:<logical_counter>:<device_id>"
 *   - physical_ms:     wall-clock milliseconds (UTC)
 *   - logical_counter: monotonic counter for events within the same ms
 *   - device_id:       unique terminal identifier (UUID from settings)
 *
 * Properties:
 *   - Monotonically increasing on each device
 *   - Causality-preserving across devices (recv merges remote HLC)
 *   - Tolerates bounded clock skew (logical counter compensates)
 *   - Deterministic total order (breaks ties by device_id)
 */

'use strict';

/**
 * Parse an HLC string into its components.
 * @param {string} hlcStr - Format: "physical:logical:deviceId"
 * @returns {{ physical: number, logical: number, deviceId: string }}
 */
function parse(hlcStr) {
  if (!hlcStr || typeof hlcStr !== 'string') {
    return { physical: 0, logical: 0, deviceId: '' };
  }
  const parts = hlcStr.split(':');
  return {
    physical: parseInt(parts[0], 10) || 0,
    logical:  parseInt(parts[1], 10) || 0,
    deviceId: parts.slice(2).join(':') || '', // deviceId may contain colons (UUIDs don't, but be safe)
  };
}

/**
 * Serialize HLC components to string.
 * @param {number} physical
 * @param {number} logical
 * @param {string} deviceId
 * @returns {string}
 */
function serialize(physical, logical, deviceId) {
  return `${physical}:${logical}:${deviceId}`;
}

/**
 * Compare two HLC strings. Returns -1, 0, or 1.
 * Total order: physical > logical > deviceId (lexicographic tiebreak).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);

  if (pa.physical !== pb.physical) return pa.physical < pb.physical ? -1 : 1;
  if (pa.logical  !== pb.logical)  return pa.logical  < pb.logical  ? -1 : 1;
  if (pa.deviceId < pb.deviceId)   return -1;
  if (pa.deviceId > pb.deviceId)   return 1;
  return 0;
}

/**
 * Generate a new HLC timestamp for a local event.
 *
 * Algorithm:
 *   l' = max(l.physical, pt)
 *   if l' == l.physical:
 *     c' = l.logical + 1
 *   else:
 *     c' = 0
 *   l = (l', c', deviceId)
 *
 * @param {{ physical: number, logical: number }} state - Mutable local HLC state
 * @param {string} deviceId
 * @param {number} [nowMs] - Override wall clock for testing
 * @returns {string} New HLC string
 */
function now(state, deviceId, nowMs) {
  const pt = nowMs !== undefined ? nowMs : Date.now();
  const prevPhysical = state.physical;

  state.physical = Math.max(prevPhysical, pt);

  if (state.physical === prevPhysical) {
    state.logical += 1;
  } else {
    state.logical = 0;
  }

  return serialize(state.physical, state.logical, deviceId);
}

/**
 * Merge a received remote HLC with local state (on receive event).
 *
 * Algorithm:
 *   l' = max(l.physical, msg.physical, pt)
 *   if l' == l.physical == msg.physical:
 *     c' = max(l.logical, msg.logical) + 1
 *   elif l' == l.physical:
 *     c' = l.logical + 1
 *   elif l' == msg.physical:
 *     c' = msg.logical + 1
 *   else:
 *     c' = 0
 *   l = (l', c', deviceId)
 *
 * @param {{ physical: number, logical: number }} state - Mutable local HLC state
 * @param {string} remoteHlcStr - The incoming HLC string
 * @param {string} deviceId - Local device ID
 * @param {number} [nowMs] - Override wall clock for testing
 * @returns {string} New local HLC string (post-merge)
 */
function recv(state, remoteHlcStr, deviceId, nowMs) {
  const pt = nowMs !== undefined ? nowMs : Date.now();
  const remote = parse(remoteHlcStr);
  const prevPhysical = state.physical;
  const prevLogical = state.logical;

  state.physical = Math.max(prevPhysical, remote.physical, pt);

  if (state.physical === prevPhysical && state.physical === remote.physical) {
    state.logical = Math.max(prevLogical, remote.logical) + 1;
  } else if (state.physical === prevPhysical) {
    state.logical = prevLogical + 1;
  } else if (state.physical === remote.physical) {
    state.logical = remote.logical + 1;
  } else {
    state.logical = 0;
  }

  return serialize(state.physical, state.logical, deviceId);
}

/**
 * Create an HLC state manager backed by a SQLite database.
 * Persists state across restarts via the `hlc_state` table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} deviceId
 * @returns {{ now: () => string, recv: (remoteHlc: string) => string, getState: () => { physical: number, logical: number }, deviceId: string }}
 */
function createHLC(db, deviceId) {
  // Ensure hlc_state table exists (migration may not have run yet in test environments)
  db.exec(`
    CREATE TABLE IF NOT EXISTS hlc_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      physical_ms INTEGER NOT NULL DEFAULT 0,
      logical_counter INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL
    );
  `);

  // Load or initialize persisted state
  let row = db.prepare('SELECT physical_ms, logical_counter FROM hlc_state WHERE id = 1').get();
  const state = {
    physical: row ? row.physical_ms : 0,
    logical:  row ? row.logical_counter : 0,
  };

  if (!row) {
    db.prepare('INSERT INTO hlc_state (id, physical_ms, logical_counter, device_id) VALUES (1, ?, ?, ?)').run(
      state.physical, state.logical, deviceId
    );
  }

  // Persist state after each update (batched — only writes if state changed)
  let lastPersistedPhysical = state.physical;
  let lastPersistedLogical = state.logical;
  const persistStmt = db.prepare('UPDATE hlc_state SET physical_ms = ?, logical_counter = ? WHERE id = 1');

  function persistIfNeeded() {
    if (state.physical !== lastPersistedPhysical || state.logical !== lastPersistedLogical) {
      persistStmt.run(state.physical, state.logical);
      lastPersistedPhysical = state.physical;
      lastPersistedLogical = state.logical;
    }
  }

  return {
    deviceId,

    /**
     * Generate a new HLC for a local event.
     * @param {number} [nowMs] - Override wall clock for testing
     * @returns {string}
     */
    now(nowMs) {
      const result = now(state, deviceId, nowMs);
      persistIfNeeded();
      return result;
    },

    /**
     * Merge a received remote HLC into local state.
     * @param {string} remoteHlc
     * @param {number} [nowMs] - Override wall clock for testing
     * @returns {string} New local HLC
     */
    recv(remoteHlc, nowMs) {
      const result = recv(state, remoteHlc, deviceId, nowMs);
      persistIfNeeded();
      return result;
    },

    /**
     * Get current state (for debugging/testing).
     */
    getState() {
      return { physical: state.physical, logical: state.logical };
    },
  };
}

module.exports = {
  parse,
  serialize,
  compare,
  now,
  recv,
  createHLC,
};
