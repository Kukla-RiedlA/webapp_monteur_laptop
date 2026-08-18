/**
 * TLS für Dispo-HTTP(S) — analog Monteur-Laptop.
 */
const fs = require('fs');
const path = require('path');

const PINNED_DISPO_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.0.180',
  'fsm.kukla.co.at',
  'kukla-montageplattform.local',
]);

function isPinnedDispoHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return PINNED_DISPO_HOSTS.has(h);
}

function applyDispoTlsPreference(userDataDir, allowInsecure) {
  const flag = path.join(userDataDir, 'dispo_tls_insecure');
  const on = allowInsecure === true || process.env.KUKLA_DISP_TLS_INSECURE === '1';
  if (on) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      fs.writeFileSync(flag, '1', 'utf8');
    } catch (_) {}
    return;
  }
  try {
    if (fs.existsSync(flag)) fs.unlinkSync(flag);
  } catch (_) {}
  if (process.env.KUKLA_DISP_TLS_INSECURE !== '1') {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}

function formatFetchError(err, baseUrl) {
  const msg = (err && err.message) ? String(err.message) : 'fetch failed';
  const code = err && err.cause && err.cause.code ? err.cause.code : (err.code || '');
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return `Verbindung abgelehnt: ${baseUrl} — Server läuft nicht oder Port falsch.`;
  }
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
    return `Host nicht erreichbar: ${baseUrl} — DNS/Netzwerk prüfen.`;
  }
  if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT')) {
    return `Zeitüberschreitung: ${baseUrl} — VPN/Firewall prüfen.`;
  }
  if (msg.toLowerCase().includes('certificate') || msg.includes('UNABLE_TO_VERIFY')) {
    return `TLS-Zertifikat abgelehnt für ${baseUrl} — HTTPS mit selbstsigniertem Zertifikat: in Einstellungen erlauben oder http:// nutzen.`;
  }
  return `${msg} (${baseUrl})`;
}

module.exports = { applyDispoTlsPreference, formatFetchError, isPinnedDispoHost, PINNED_DISPO_HOSTS };
