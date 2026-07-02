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
  normalizeBaseUrl,
  isLikelyOfflineSyncError,
  shouldDeferDispoSync,
  wantsLocalOnlyRequest,
  fetchWithTimeout,
};
