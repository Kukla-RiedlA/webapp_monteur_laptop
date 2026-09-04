'use strict';

/**
 * Laptop-Formulare senden jobs.id (lokal). Dispo-APIs erwarten jobs.id vom Server (server_id).
 * local_job_id bleibt die SQLite-ID; job_id wird auf die Dispo-ID gesetzt.
 */
function applyDispoServerJobIdToPayload(db, payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const localHint = parseInt(src.local_job_id, 10);
  const jobHint = parseInt(src.job_id, 10);
  const lookupId = Number.isFinite(localHint) && localHint > 0 ? localHint : jobHint;
  if (!db || !Number.isFinite(lookupId) || lookupId <= 0) return src;
  try {
    const byLocal = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(lookupId);
    if (byLocal && byLocal.server_id != null && String(byLocal.server_id).trim() !== '') {
      const sid = parseInt(byLocal.server_id, 10);
      if (Number.isFinite(sid) && sid > 0) {
        src.job_id = sid;
        if (!Number.isFinite(parseInt(src.local_job_id, 10)) || parseInt(src.local_job_id, 10) <= 0) {
          src.local_job_id = lookupId;
        }
        return src;
      }
    }
    if (Number.isFinite(jobHint) && jobHint > 0) {
      const byServer = db
        .prepare('SELECT server_id FROM jobs WHERE CAST(server_id AS TEXT) = CAST(? AS TEXT)')
        .get(jobHint);
      if (byServer && byServer.server_id != null && String(byServer.server_id).trim() !== '') {
        const sid = parseInt(byServer.server_id, 10);
        if (Number.isFinite(sid) && sid > 0) src.job_id = sid;
      }
    }
  } catch (_) {
    /* Schema/DB nicht bereit */
  }
  return src;
}

module.exports = { applyDispoServerJobIdToPayload };
