'use strict';

function parsePositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {import('better-sqlite3').Database} dbConn
 * @param {number|string} localJobId
 * @param {number|string} technicianId
 */
function jobAssignmentViewMeta(dbConn, localJobId, technicianId) {
  const assigned = isJobAssignedToTechnician(dbConn, localJobId, technicianId);
  if (assigned) {
    return {
      assignment_writable: true,
      assigned_to_me: true,
      assignment_read_only_reason: '',
    };
  }
  const lid = parsePositiveInt(localJobId);
  let hasAny = false;
  if (lid) {
    const row = dbConn.prepare('SELECT COUNT(*) AS n FROM job_technicians WHERE job_id = ?').get(lid);
    hasAny = !!(row && Number(row.n) > 0);
  }
  return {
    assignment_writable: false,
    assigned_to_me: false,
    assignment_read_only_reason: hasAny
      ? 'Nur Ansicht – Auftrag ist einem anderen Techniker zugeteilt.'
      : 'Nur Ansicht – Auftrag ist nicht zugeteilt.',
  };
}

function isJobAssignedToTechnician(dbConn, localJobId, technicianId) {
  const lid = parsePositiveInt(localJobId);
  const tid = parsePositiveInt(technicianId);
  if (!lid || !tid) return false;
  const row = dbConn
    .prepare(
      `SELECT 1 FROM job_technicians WHERE job_id = ? AND technician_id = ? LIMIT 1`,
    )
    .get(lid, tid);
  return !!row;
}

/**
 * @returns {null | { error: string, status: number }}
 */
function requireJobAssignedToTechnician(dbConn, localJobId, technicianId) {
  const lid = parsePositiveInt(localJobId);
  const tid = parsePositiveInt(technicianId);
  if (!lid) return { error: 'job_id (lokal) ungültig.', status: 400 };
  if (!tid) return { error: 'technician_id fehlt.', status: 400 };
  if (!isJobAssignedToTechnician(dbConn, lid, tid)) {
    return {
      error: 'Auftrag ist diesem Monteur nicht zugeordnet — Sync abgebrochen.',
      status: 403,
    };
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} dbConn
 * @param {number|string} technicianId
 * @param {number|string} ref
 * @param {{ mode?: 'local'|'server'|'auto', requireAssignment?: boolean }} [opts]
 * @returns {{ ok: true, localId: number, serverId: number|null, status: string|null } | { ok: false, error: string, status: number, conflict?: boolean }}
 */
function resolveLocalJobIdForTechnician(dbConn, technicianId, ref, opts) {
  opts = opts || {};
  const mode = opts.mode || 'auto';
  const requireAssignment = opts.requireAssignment !== false;
  const n = parsePositiveInt(ref);
  const tid = parsePositiveInt(technicianId);
  if (!n) return { ok: false, error: 'job_id ungültig.', status: 400 };
  if (requireAssignment && !tid) return { ok: false, error: 'technician_id fehlt.', status: 400 };

  const assignSql = requireAssignment
    ? ` AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)`
    : '';
  const assignParams = requireAssignment ? [tid] : [];

  if (mode === 'local') {
    const row = dbConn
      .prepare(
        `SELECT j.id, j.server_id, j.status FROM jobs j WHERE j.id = ?${assignSql} LIMIT 1`,
      )
      .get(n, ...assignParams);
    if (!row) return { ok: false, error: 'Auftrag nicht gefunden.', status: 404 };
    return {
      ok: true,
      localId: row.id,
      serverId: row.server_id != null ? row.server_id : null,
      status: row.status != null ? String(row.status) : null,
    };
  }

  if (mode === 'server') {
    const row = dbConn
      .prepare(
        `SELECT j.id, j.server_id, j.status FROM jobs j
         WHERE CAST(j.server_id AS TEXT) = CAST(? AS TEXT)${assignSql} LIMIT 1`,
      )
      .get(n, ...assignParams);
    if (!row) return { ok: false, error: 'Auftrag nicht gefunden.', status: 404 };
    return {
      ok: true,
      localId: row.id,
      serverId: row.server_id != null ? row.server_id : null,
      status: row.status != null ? String(row.status) : null,
    };
  }

  const byLocal = dbConn
    .prepare(`SELECT j.id, j.server_id, j.status FROM jobs j WHERE j.id = ? LIMIT 1`)
    .get(n);
  const byServer = dbConn
    .prepare(
      `SELECT j.id, j.server_id, j.status FROM jobs j
       WHERE CAST(j.server_id AS TEXT) = CAST(? AS TEXT) LIMIT 1`,
    )
    .get(n);

  if (byLocal && byServer && byLocal.id !== byServer.id) {
    console.warn('[resolveLocalJobIdForTechnician] ID-Konflikt ref=' + n, {
      local_match_id: byLocal.id,
      server_match_id: byServer.id,
      server_id_local: byLocal.server_id,
      server_id_server_row: byServer.server_id,
    });
    return {
      ok: false,
      error:
        'Job-ID-Konflikt (lokale ID und Server-ID verweisen auf verschiedene Aufträge). Bitte Dispo-Sync ausführen oder Support.',
      status: 409,
      conflict: true,
    };
  }

  const row = byLocal || byServer;
  if (!row) return { ok: false, error: 'Auftrag nicht gefunden.', status: 404 };
  if (requireAssignment && !isJobAssignedToTechnician(dbConn, row.id, tid)) {
    return {
      ok: false,
      error: 'Auftrag ist diesem Monteur nicht zugeordnet.',
      status: 403,
    };
  }
  return {
    ok: true,
    localId: row.id,
    serverId: row.server_id != null ? row.server_id : null,
    status: row.status != null ? String(row.status) : null,
  };
}

module.exports = {
  isJobAssignedToTechnician,
  requireJobAssignedToTechnician,
  resolveLocalJobIdForTechnician,
  jobAssignmentViewMeta,
};
