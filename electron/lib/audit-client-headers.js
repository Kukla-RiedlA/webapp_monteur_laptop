'use strict';

/**
 * Audit-Log-Client-Kontext für Dispo-Server (X-Kukla-Client-*).
 * Siehe dispo/inc/audit_log_client.php
 */
const path = require('path');

const CLIENT_PLATFORM = 'monteur_laptop';
let cachedVersion = null;

function getClientVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const v = require(path.join(__dirname, '..', 'version.json'));
    cachedVersion = v && v.version ? String(v.version).trim() : '';
  } catch (_) {
    cachedVersion = '';
  }
  return cachedVersion;
}

function applyKuklaAuditHeaders(headers) {
  const h = headers && typeof headers === 'object' ? { ...headers } : {};
  if (!h['X-Kukla-Client-Platform']) {
    h['X-Kukla-Client-Platform'] = CLIENT_PLATFORM;
  }
  const ver = getClientVersion();
  if (ver && !h['X-Kukla-Client-Version']) {
    h['X-Kukla-Client-Version'] = ver;
  }
  return h;
}

module.exports = {
  CLIENT_PLATFORM,
  getClientVersion,
  applyKuklaAuditHeaders,
};
