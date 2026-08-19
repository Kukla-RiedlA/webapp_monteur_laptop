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
  const cause = err && err.cause;
  const code = (cause && cause.code) || err.code || '';
  const causeMsg = cause && cause.message ? String(cause.message) : '';
  const combined = (msg + ' ' + causeMsg + ' ' + String(code)).toLowerCase();
  const urlHint = baseUrl ? String(baseUrl) : '';
  const suffix = urlHint ? ': ' + urlHint : '';
  if (code === 'ECONNREFUSED' || combined.includes('econnrefused')) {
    return 'Verbindung abgelehnt' + suffix + ' — Server läuft nicht oder Port falsch.';
  }
  if (code === 'ENOTFOUND' || combined.includes('enotfound')) {
    return 'Host nicht erreichbar' + suffix + ' — DNS/Netzwerk prüfen.';
  }
  if (code === 'ETIMEDOUT' || combined.includes('etimedout') || combined.includes('und_err_connect_timeout')) {
    return 'Zeitüberschreitung' + suffix + ' — VPN/Firewall prüfen.';
  }
  if (combined.includes('econnreset') || combined.includes('und_err_socket')) {
    return 'Verbindung unterbrochen' + suffix + ' — VPN/Netzwerk prüfen und erneut versuchen.';
  }
  if (combined.includes('certificate') || combined.includes('unable_to_verify') || combined.includes('cert')) {
    return 'TLS-Zertifikat abgelehnt' + suffix + ' — HTTPS mit selbstsigniertem Zertifikat: in Einstellungen erlauben oder http:// nutzen.';
  }
  if (combined.includes('fetch failed') || combined.includes('failed to fetch')) {
    return 'Keine Verbindung zur Dispo' + suffix + ' — Netzwerk, VPN oder Firewall prüfen.';
  }
  return urlHint ? msg + ' (' + urlHint + ')' : msg;
}

module.exports = { applyDispoTlsPreference, formatFetchError, isPinnedDispoHost, PINNED_DISPO_HOSTS };
