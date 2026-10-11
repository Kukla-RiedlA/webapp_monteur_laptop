'use strict';

/**
 * Einheitliche Auth-/Kontext-Header für Dispo-Upstream-Aufrufe vom Monteur-Laptop.
 * Apache/FPM liefert Authorization oft nicht an PHP — daher X-Kukla-Authorization / X-Authorization.
 */
const { applyKuklaAuditHeaders } = require('./audit-client-headers');

/**
 * @param {object|string|null|undefined} authHeader
 *   Entweder `{ Authorization: 'Basic …' }` oder der Basic-String selbst.
 * @returns {string}
 */
function normalizeAuthValue(authHeader) {
  if (authHeader == null) return '';
  if (typeof authHeader === 'string') return String(authHeader).trim();
  if (typeof authHeader === 'object' && authHeader.Authorization != null) {
    return String(authHeader.Authorization).trim();
  }
  return '';
}

/**
 * @param {object} [opts]
 * @param {string|number|null} [opts.technicianId]
 * @param {object|string|null} [opts.authHeader]
 * @param {string|null} [opts.deviceId]  lap-… Device-Id (device-id.js / multiDeviceApi.deviceId())
 * @param {object} [opts.extra]  zusätzliche Header (z. B. Content-Type, Accept)
 * @returns {Record<string, string>}
 */
function buildDispoMonteurHeaders(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const authHeader = o.authHeader;
  const extra = o.extra && typeof o.extra === 'object' ? o.extra : {};
  const authObj =
    authHeader && typeof authHeader === 'object' && !Array.isArray(authHeader)
      ? Object.assign({}, authHeader)
      : {};
  const a = normalizeAuthValue(authHeader);
  if (a) authObj.Authorization = a;

  const base = {};
  if (o.technicianId != null && String(o.technicianId).trim() !== '') {
    base['X-Technician-Id'] = String(o.technicianId);
  }

  const h = applyKuklaAuditHeaders(Object.assign(base, authObj, extra));

  if (a) {
    h.Authorization = a;
    h['X-Kukla-Authorization'] = a;
    h['X-Authorization'] = a;
  }

  const did = o.deviceId != null ? String(o.deviceId).trim() : '';
  if (did) {
    h['X-Kukla-Device-Id'] = did;
  }

  return h;
}

module.exports = {
  buildDispoMonteurHeaders,
  normalizeAuthValue,
};
