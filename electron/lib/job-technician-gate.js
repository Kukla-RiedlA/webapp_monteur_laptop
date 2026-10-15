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
function formatJobIdConflictMessage(dbConn, ref, localRow, serverRow) {
  function label(row) {
    if (!row || row.id == null) return 'unbekannt';
    let num = '';
    let name = '';
    try {
      const extra = dbConn.prepare(
        `SELECT j.job_number, c.name AS customer_name
         FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
         WHERE j.id = ?`,
      ).get(row.id);
      num = extra && extra.job_number != null ? String(extra.job_number).trim() : '';
      name = extra && extra.customer_name != null ? String(extra.customer_name).trim() : '';
    } catch (_) { /* Anzeige ohne Zusatzfelder */ }
    const head = num !== '' ? num : ('ohne ERP-Nummer, lokale ID ' + row.id);
    return name !== '' ? (head + ', ' + name) : head;
  }
  return 'Konflikt: Die Zahl ' + ref
    + ' trifft zwei Aufträge. Lokal: ' + label(localRow)
    + '. Über die Dispo-ID: ' + label(serverRow)
    + '. Es wurde kein Auftrag geöffnet.';
}

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
 * Laptop-PATCH: Kalender-Vorschau hat oft Dispo-`id`. Explizites `local_job_id` gewinnt.
 * @param {{ job_id?: *, local_job_id?: *, server_id?: * }} body
 * @returns {{ ref: number|null, mode: 'local'|'server'|'auto' }}
 */
function resolvePatchJobRef(body) {
  const src = body && typeof body === 'object' ? body : {};
  const localHint = parsePositiveInt(src.local_job_id);
  const jobHint = parsePositiveInt(src.job_id);
  const serverHint = parsePositiveInt(src.server_id);
  if (localHint) return { ref: localHint, mode: 'local' };
  if (serverHint && jobHint && jobHint === serverHint) return { ref: serverHint, mode: 'server' };
  if (jobHint) return { ref: jobHint, mode: 'auto' };
  if (serverHint) return { ref: serverHint, mode: 'server' };
  return { ref: null, mode: 'auto' };
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
      error: formatJobIdConflictMessage(dbConn, n, byLocal, byServer),
      status: 409,
      conflict: true,
      code: 'job_id_conflict',
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
  formatJobIdConflictMessage,
  isJobAssignedToTechnician,
  requireJobAssignedToTechnician,
  resolveLocalJobIdForTechnician,
  resolvePatchJobRef,
  jobAssignmentViewMeta,
};
