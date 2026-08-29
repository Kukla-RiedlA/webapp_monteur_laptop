/**
 * Dispo-Erreichbarkeitsprobe: keine implizite Monteur-ID 1 (Admin).
 * Erstinstallation: Host gilt als erreichbar, sobald die Dispo HTTP antwortet
 * (400/401/403/429), auch ohne gültige technician_id.
 */

function parseTechnicianId(technicianId) {
  if (technicianId == null || technicianId === '') return null;
  const n = Number(technicianId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isDispoReachableHttpStatus(status) {
  const s = Number(status);
  return s === 200 || s === 400 || s === 401 || s === 403 || s === 429;
}

/**
 * @param {number} status
 * @param {boolean} hasTechnicianId
 * @returns {'ok' | 'reachable' | 'auth' | 'fail'}
 */
function classifyDispoProbeStatus(status, hasTechnicianId) {
  const s = Number(status);
  if (s === 200) return 'ok';
  if (!hasTechnicianId && isDispoReachableHttpStatus(s)) return 'reachable';
  if (s === 401 || s === 429) return 'auth';
  return 'fail';
}

function dispoProbeUrls(baseUrlRaw, technicianId) {
  const base = (baseUrlRaw || '').toString().trim().replace(/\/$/, '');
  const techId = parseTechnicianId(technicianId);
  const q = techId != null ? '?technician_id=' + encodeURIComponent(String(techId)) : '';
  return {
    base,
    technicianId: techId,
    myJobs: base ? base + '/api/my_jobs.php' + q : '',
    jobsOpen: base ? base + '/dispo_api/api/jobs_open.php' + q : '',
  };
}

module.exports = {
  parseTechnicianId,
  isDispoReachableHttpStatus,
  classifyDispoProbeStatus,
  dispoProbeUrls,
};
