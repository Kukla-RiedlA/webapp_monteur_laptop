'use strict';

/**
 * Hilfen für Offline-First im Electron-Gateway: lokal zuerst, Sync optional.
 */

const DISPO_FETCH_TIMEOUT_MS = 2500;

function normalizeBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

/** Max. Retries für nicht-permanente Serverfehler (z. B. 500), danach Dead-Letter. */
const SYNC_PUSH_MAX_ATTEMPTS = 5;

/** Netzwerk-/Erreichbarkeitsfehler (Finish/Release-Fallback). */
function isLikelyOfflineSyncError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|Zeitüberschreitung|nicht erreichbar|502|503|504/i.test(msg)) {
    return true;
  }
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')) {
    return true;
  }
  return false;
}

/**
 * Fehler, die durch erneutes Pushen derselben Pending-Zeile nicht heilbar sind
 * (Parse-/Syntaxfehler, Auth, Validierung, 4xx). Sofort Dead-Letter statt Endlos-Retry.
 */
function isPermanentSyncPushError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '');
  if (!msg) return false;
  if (isLikelyOfflineSyncError(err)) return false;
  if (
    /syntax error|parse error|unexpected identifier|unexpected token|ParseError|CompileError/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/\b(401|403|404|405|409|410|422)\b/.test(msg)) return true;
  if (/^Dispo:\s*(401|403|404|405|409|410|422)\b/i.test(msg)) return true;
  if (
    /nicht erlaubt|Method not allowed|unautorisiert|unauthorized|forbidden|nicht gefunden|not found|erforderlich|ungültig|ungueltig|JSON-Body|Validierung|validation/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (err && Number.isFinite(err.status) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
    return true;
  }
  return false;
}

/**
 * @param {{ hasBaseUrl?: boolean, hasAuth?: boolean, forceOffline?: boolean }} opts
 */
function shouldDeferDispoSync(opts) {
  const o = opts || {};
  if (o.forceOffline) return true;
  if (o.localOnly) return true;
  if (!o.hasBaseUrl) return true;
  return false;
}

function wantsLocalOnlyRequest(src) {
  const s = src && typeof src === 'object' ? src : {};
  return (
    s.local_only === '1' ||
    s.local_only === 1 ||
    s.local_only === true ||
    s.skip_dispo === '1' ||
    s.skip_dispo === 1 ||
    s.skip_dispo === true ||
    s.skip_dispo_sync === '1' ||
    s.skip_dispo_sync === 1 ||
    s.skip_dispo_sync === true
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : DISPO_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('Dispo-Zeitüberschreitung (' + ms + ' ms)');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DISPO_FETCH_TIMEOUT_MS,
  SYNC_PUSH_MAX_ATTEMPTS,
  normalizeBaseUrl,
  isLikelyOfflineSyncError,
  isPermanentSyncPushError,
  shouldDeferDispoSync,
  wantsLocalOnlyRequest,
  fetchWithTimeout,
};
