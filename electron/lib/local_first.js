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
  // Apache liefert den Login oft nicht an PHP — Retry, nicht sofort aufgeben.
  if (/Token fehlt/i.test(msg)) return false;
  if (
    /syntax error|parse error|unexpected identifier|unexpected token|ParseError|CompileError/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/\b(401|403|404|405|409|410|422)\b/.test(msg) && !/Token fehlt/i.test(msg)) return true;
  if (/^Dispo:\s*(401|403|404|405|409|410|422)\b/i.test(msg) && !/Token fehlt/i.test(msg)) return true;
  if (
    /nicht erlaubt|Method not allowed|unautorisiert|unauthorized|forbidden|nicht gefunden|not found|erforderlich|ungültig|ungueltig|JSON-Body|Validierung|validation/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/SQLSTATE\[23000\]|Integrity constraint|foreign key constraint/i.test(msg)) {
    return true;
  }
  if (err && Number.isFinite(err.status) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
    if (err.status === 401 && /Token fehlt/i.test(msg)) return false;
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

/** pending_changes-Typen, die pushToServer abarbeiten muss (Queue ohne Handler = Dead-Letter). */
const HANDLED_PENDING_ENTITY_TYPES = [
  'job',
  'absence',
  'anlagenstamm',
  'textbausteine',
  'arbeitsschritte',
  'serviceprotokoll',
  'kontrollwiegung',
  'schleppketten',
  'pruefzertifikat',
  'protocol_draft',
  'signature',
  'rams',
  'arbeitsnachweis',
];

function isHandledPendingEntityType(entityType) {
  return HANDLED_PENDING_ENTITY_TYPES.indexOf(String(entityType || '')) >= 0;
}

const SYNC_TS_TOLERANCE_MS = 2000;

function parseSyncTimestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value > 1e9 ? value : 0;
  }
  const s = String(value).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
  }
  const ms = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Lokal gilt als neuer, wenn der lokale Zeitstempel nach Toleranz über dem Remote liegt.
 * Fehlt einer der Stempel, ist das Ergebnis unsicher (null) — dann nicht Remote-only gewinnen.
 * @returns {boolean|null} true = lokal neuer, false = remote neuer/gleich, null = unsicher
 */
function isLocalFresher(localTs, remoteTs, toleranceMs) {
  const tol = Number.isFinite(toleranceMs) ? toleranceMs : SYNC_TS_TOLERANCE_MS;
  const localMs = parseSyncTimestampMs(localTs);
  const remoteMs = parseSyncTimestampMs(remoteTs);
  if (!localMs && !remoteMs) return null;
  if (localMs && !remoteMs) return true;
  if (!localMs && remoteMs) return false;
  if (localMs > remoteMs + tol) return true;
  if (remoteMs > localMs + tol) return false;
  return false;
}

function timestampsAreUncertain(localTs, remoteTs) {
  const localMs = parseSyncTimestampMs(localTs);
  const remoteMs = parseSyncTimestampMs(remoteTs);
  return !localMs && !remoteMs;
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

/**
 * Verdächtiger Jobs-Pull: Dispo liefert 0 oder stark weniger als lokal vorhanden.
 * Dann kein Massen-Löschen lokaler Zuordnungen (Schutz gegen leere/fehlerhafte API-Antwort).
 * @returns {{ skipRemoval: boolean, warning: string|null, localCount: number, receivedCount: number }}
 */
function evaluateJobPullRemovalGuard(localAssignedCount, receivedUniqueCount) {
  const localCount = Number(localAssignedCount) || 0;
  const receivedCount = Number(receivedUniqueCount) || 0;
  if (localCount > 0 && receivedCount === 0) {
    return {
      skipRemoval: true,
      warning:
        'Dispo lieferte 0 Aufträge bei ' +
        localCount +
        ' lokal zugewiesenen — Löschen übersprungen (vermutlich unvollständiger Pull)',
      localCount,
      receivedCount,
    };
  }
  if (localCount >= 3 && receivedCount < Math.ceil(localCount * 0.2)) {
    return {
      skipRemoval: true,
      warning:
        'Dispo lieferte nur ' +
        receivedCount +
        ' von ' +
        localCount +
        ' lokalen Aufträgen — Massen-Löschen übersprungen',
      localCount,
      receivedCount,
    };
  }
  return { skipRemoval: false, warning: null, localCount, receivedCount };
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
  SYNC_TS_TOLERANCE_MS,
  HANDLED_PENDING_ENTITY_TYPES,
  normalizeBaseUrl,
  isLikelyOfflineSyncError,
  isPermanentSyncPushError,
  shouldDeferDispoSync,
  wantsLocalOnlyRequest,
  evaluateJobPullRemovalGuard,
  fetchWithTimeout,
  isHandledPendingEntityType,
  parseSyncTimestampMs,
  isLocalFresher,
  timestampsAreUncertain,
};
