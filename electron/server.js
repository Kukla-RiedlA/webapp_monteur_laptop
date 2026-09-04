/**
 * Lokaler API-Server für die Monteur WebApp (Offline).
 * SQLite via better-sqlite3 (WAL) im Electron-Hauptprozess.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const WebSocket = require('ws');
const FormData = require('form-data');
const csvToPdfPath = path.join(__dirname, 'lib', 'csv-to-pdf.js');
const { postalCodeNormalize } = require(path.join(__dirname, 'lib', 'postal_code_util.js'));

function getCsvToPdfBuffer() {
  try {
    delete require.cache[require.resolve(csvToPdfPath)];
  } catch (_) {}
  return require(csvToPdfPath).csvToPdfBuffer;
}

const PORT = 39678;
/** Schreibbarer DB-Ordner (bei installierter App: userData, nicht asar). */
let DB_DIR = path.join(__dirname, 'db');
let DB_PATH = path.join(DB_DIR, 'monteur.db');

function lastTechnicianIdPath() {
  return path.join(DB_DIR, 'monteur_last_technician.json');
}

function readLastTechnicianId() {
  try {
    const p = lastTechnicianIdPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const n = parseInt(j && (j.id != null ? j.id : j.technician_id), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function writeLastTechnicianId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(
      lastTechnicianIdPath(),
      JSON.stringify({ id: n, saved_at: new Date().toISOString() }),
      'utf8',
    );
  } catch (_) {
    /* ignore */
  }
}

/** Electron: DB unter userData (beschreibbar). Keine Dev-monteur.db aus dem Installer übernehmen. */
function configurePersistentDbDir() {
  try {
    const { app } = require('electron');
    if (!app || typeof app.getPath !== 'function') return;
    const targetDir = path.join(app.getPath('userData'), 'db');
    const targetDb = path.join(targetDir, 'monteur.db');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const bundledDb = path.join(__dirname, 'db', 'monteur.db');
    if (fs.existsSync(bundledDb)) {
      console.warn(
        '[monteur-db] Bundle enthält monteur.db — wird ignoriert (Neuinstallation = leere DB unter userData).',
      );
    }
    const dienstreiseCfg = path.join(targetDir, 'dienstreise_config.json');
    if (!fs.existsSync(dienstreiseCfg)) {
      fs.writeFileSync(dienstreiseCfg, JSON.stringify({ basePath: '' }, null, 2), 'utf8');
    }
    const appCfgPath = path.join(targetDir, 'app_config.json');
    if (!fs.existsSync(appCfgPath)) {
      fs.writeFileSync(
        appCfgPath,
        JSON.stringify({ acceptSelfSignedDispoTls: true }, null, 2),
        'utf8',
      );
    }
    DB_DIR = targetDir;
    DB_PATH = targetDb;
    console.log('[monteur-db] Persistenz:', DB_PATH);
  } catch (e) {
    console.warn('[monteur-db] configurePersistentDbDir:', e && e.message ? e.message : e);
  }
}
const { registerAbrechnungRoutes, flushAbrechnungOutbox, runAbrechnungRefreshCore, queueAbrechnungLocalFile } = require('./lib/abrechnung-routes');
const { copyProtocolsToLocalAbrechnung } = require('./lib/abrechnung-protocol-copy');
const { registerZeitschreibungRoutes, flushZeitschreibungOutbox, pullRecentLohnLocks, ensureTables: ensureZeitschreibungTables } = require('./lib/zeitschreibung-routes');
const { registerHinweiseRoutes } = require('./lib/hinweise-routes');
const { createBackgroundJobService } = require('./lib/background_jobs');
const {
  isJobAssignedToTechnician,
  requireJobAssignedToTechnician,
  resolveLocalJobIdForTechnician,
  jobAssignmentViewMeta,
} = require('./lib/job-technician-gate');
const { createDbLock } = require('./lib/db-lock');
const hangDiag = require('./lib/hang-diagnostics');
const { openMonteurDatabase, flushDb, getLastPersistError, getDb: getNativeDb } = require('./lib/db');
const { createDbCompat } = require('./lib/db-compat');
const {
  proxyAnlagenstammSearch,
  proxyAnlagenstammSave,
  proxyAnlagenstammDelete,
  proxyAnlagenstammParameterFilesList,
  proxyAnlagenstammParameterTrend,
  proxyAnlagenstammParameterIngest,
  proxyAnlagenstammParameterDownload,
} = require('./lib/anlagenstamm-dispo-proxy');
const {
  buildDispoBaseCandidates,
  normalizeDispoBase,
  normalizeDispoBasePair,
  pickReachableDispoBase,
  tryDispoBasesInOrder,
  isFetchNetworkError,
  isPrivateLanHostname,
  safeHostname,
} = require('./lib/dispo-base-fallback');
const { classifyDispoProbeStatus, dispoProbeUrls, parseTechnicianId } = require('./lib/dispo-probe');
const { formatFetchError } = require('./lib/dispo-tls');
const {
  resolveProjekteNeuRoot,
  resolveCanonicalFolderFromDirList,
  scanProjekteNeuTree,
  safeResolveUnderRoot,
  isIgnorableDirEntry,
  findMonteurFolderForFab,
  folderNameMatchesFab,
  isDatePrefixedProjectFolderName,
  isFnFolderAlias,
} = require('./lib/projekte-neu-local');
const {
  buildMonteurMontageFolderName,
  buildFnProjectFolderName,
  buildMonteurWorkRelPath,
  buildMonteurWorkAbsDir,
  isMonteurWorkRelPath,
  ensureAnlageFnDirs,
  ensureMonteurMontageDirs,
  alignMonteurMontageDirs,
  ensureMonteurPhotoCategoryDirs,
  buildMonteurPhotoCategoryRelDir,
  expandTopLevelMontageRelToFnFolders,
  migrateTopLevelMontageIntoFnFolders,
  isDokumenteMonteurReservedTopDir,
  removeLegacyMonteurAuftragsordnerTopLevel,
  removeStaleBareFabMonteurDirs,
  isBareFabFolderName,
  mapServerManifestPathToLocalAnlageRel,
  getMonteurWorkRoot,
  buildTedAnlageRelPath,
  resolveCanonicalProjekteNeuFolderName,
  buildOfflinePreviewTree,
  migrateBareFabAnlageDirs,
  migrateAliasFnFolders,
  resolveFabMapLocal,
  sanitizeDienstreiseFolderPart,
  sanitizeExportFileBase,
} = require('./lib/monteur-montage-paths');
const kundenDokumentation = require('./lib/kunden-dokumentation');
const {
  ensureJobOfflinePullSchema,
  getOfflinePullConfig,
  getOfflinePullPathsByFab,
  filterManifestForPull,
  normalizeOfflinePathsInput,
  saveOfflinePullSelection,
  mergeOfflinePullSelection,
  removeOfflinePullFab,
  updateOfflinePullFabMap,
  ensureMontageFolderNameInConfig,
  updateMontageFolderNameInConfig,
} = require('./lib/job-offline-pull');
const {
  DOKUMENTE_MONTEUR,
  listProtectedPaths,
  seedDokumenteMonteurProtectedPaths,
  setProtectedPathState,
  protectPathIfUnderDokumenteMonteur,
  buildPrefixProtectedMatcher,
  canRmSyncTopLevelEntryExact,
  normalizeRelPath: normalizeProtectedRelPath,
  isProtectedPathsInitialized,
} = require('./lib/job-protected-paths');
const {
  isAnlageDbExplorerSubpath,
  buildAnlageExplorerEntries,
  folderNameForFab,
} = require('./lib/anlage-explorer-tree');
const {
  resolveTedExcelLocal,
  isExcelFilePath,
  tedLocalFileLooksComplete,
  safeTedFileName,
  safeTedLocalFileName,
} = require('./lib/ted-excel-local');
const { replaceFileWithoutUnlink } = require('./lib/replace-file-cloud-safe');
const { applyKuklaAuditHeaders } = require('./lib/audit-client-headers');

/** Apache/FPM liefert Authorization oft nicht an PHP — Dispo liest X-Kukla-Authorization. */
function dispoMonteurFetchHeaders(technicianId, authHeader) {
  const h = applyKuklaAuditHeaders(
    Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {}),
  );
  const a = authHeader && authHeader.Authorization;
  if (a) {
    h['X-Kukla-Authorization'] = a;
    h['X-Authorization'] = a;
  }
  return h;
}

const {
  isLikelyOfflineSyncError,
  isPermanentSyncPushError,
  SYNC_PUSH_MAX_ATTEMPTS,
  shouldDeferDispoSync,
  normalizeBaseUrl,
  wantsLocalOnlyRequest,
  evaluateJobPullRemovalGuard,
  fetchWithTimeout,
  DISPO_FETCH_TIMEOUT_MS,
  isHandledPendingEntityType,
} = require('./lib/local_first');
const textbausteineLocal = require('./lib/textbausteine-local');
const arbeitsschritteLocal = require('./lib/arbeitsschritte-local');
const protocolPdf = require('./lib/protocol_pdf');
const technicianSignature = require('./lib/technician-signature');
const kontrollwiegungLocal = require('./lib/kontrollwiegung-local');
const schleppkettenLocal = require('./lib/schleppketten-local');
const pruefzertifikatLocal = require('./lib/pruefzertifikat-local');
const {
  resolveMonteurDraftJsonPath,
  isMonteurDraftJsonBasename,
  MONTEUR_DRAFT_BASENAMES,
  DRAFT_JSON_ENDPOINTS,
  readLocalDraftFile,
  stripDraftMeta,
  pruneEmptyMonteurDraftJsons,
  isEmptyMonteurDraftPayload,
} = require('./lib/multi-device-sync');
const protocolDrafts = require('./lib/protocol-drafts-local');
const {
  ensureAnlagenstammLocalSchema,
  rowCount: anlagenstammLocalRowCount,
  searchLocal: anlagenstammSearchLocal,
  lookupByFab: anlagenstammLookupByFab,
  dedupeAnlagenstammLocalByFab,
  getRowsByFabs: anlagenstammGetRowsByFabs,
  saveLocal: anlagenstammSaveLocal,
  syncAnlagenstammFromDispo,
  clampForDispoAnlagenstamm,
  clampForDispoJobFabrikation,
  clampFabrikationsnummernJson,
  mergeAnlagenstammPayload,
  hasNonemptyStammField,
  stripEmptyStammFieldsForDispoPush,
  uploadCachePath,
  upsertParameterFile,
  cacheParameterFilesFromDispo,
  listParameterFilesByFab,
  markMissingProjekteNeuFiles,
  compareParameterFilesById,
  buildParameterTrendChain,
  syncProjekteNeuTreesFromDispo,
  ensureAnlagenstammTreeCacheSchema,
  readAnlagenstammTreeCacheRow,
  upsertAnlagenstammTreeCacheRow,
  parseKraftaufnehmerExtra,
  normalizeMotorRows,
  listMotorsForStamm,
  syncProtocolMotorsToStamm,
  getAnlagenstammSyncResumeState,
  prepareAnlagenstammSyncRun,
  finalizeAnlagenstammSyncRun,
} = require('./lib/anlagenstamm-local');
const {
  readCachedProjekteNeuFile,
  writeCachedProjekteNeuFile,
  readCachedProjekteNeuThumb,
  writeCachedProjekteNeuThumb,
} = require('./lib/projekte-neu-file-cache');
const {
  readImageThumbCache,
  writeImageThumbCache,
  THUMB_KIND_DIENSTREISE,
} = require('./lib/image-thumb-cache');
const {
  isSupportedParameterFileName,
  parseParameterFile,
  normalizeFabDigits: normalizeParameterFab,
} = require('./lib/anlagenstamm-parameter-parser');

/** Felder Leistungszeile / Anlagenstamm (Abgleich Projektdaten ↔ Sync). */
const JOB_FAB_STAMM_KEYS = [
  'type',
  'leistung',
  'nenngeschwindigkeit',
  'kraftaufnehmer',
  'kraftaufnehmer_extra',
  'dms_nr',
  'dms_position',
  'vers_spannung',
  'sensitivitaet',
  'tacho',
  'elektronik',
  'material',
  'position',
  'geliefert_ueber',
  'projekt',
  'bemerkungen',
];

function normJobFabKey(rowOrFn) {
  if (rowOrFn == null) return '';
  if (typeof rowOrFn === 'string' || typeof rowOrFn === 'number') return String(rowOrFn).trim();
  return String(rowOrFn.fabrikationsnummer ?? rowOrFn.Fabrikationsnummer ?? '').trim();
}

/** Fabrikationsnummern aufsteigend (numerisch wenn möglich). */
function compareFabrikationsnummerKeys(a, b) {
  const sa = normJobFabKey(a);
  const sb = normJobFabKey(b);
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : NaN;
  const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return sa.localeCompare(sb, 'de', { numeric: true, sensitivity: 'base' });
}

function sortJobFabRows(rows) {
  return [...(rows || [])].sort((a, b) => compareFabrikationsnummerKeys(a, b));
}

/** Leere DB-/JSON-Werte (inkl. Literal-String "null") nicht in Leistungszeilen übernehmen. */
function stammFieldTrim(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s;
}

function stammJobFieldsChanged(before, after) {
  const a = before || {};
  const b = after || {};
  for (const k of JOB_FAB_STAMM_KEYS) {
    if (stammFieldTrim(a[k]) !== stammFieldTrim(b[k])) return true;
  }
  return false;
}

function parseJobFabrikationsnummernRows(raw) {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (!s) return [];
  let rows = [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      rows = parsed
        .map((r) => {
          if (r && typeof r === 'object') return r;
          const fn = normJobFabKey(r);
          return fn ? { fabrikationsnummer: fn } : null;
        })
        .filter(Boolean);
    } else if (parsed && typeof parsed === 'object') {
      rows = [parsed];
    }
  } catch (_) {
    /* Semikolon-/Komma-Liste */
  }
  if (!rows.length) {
    rows = s
      .split(/[\s;,]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((fn) => ({ fabrikationsnummer: fn }));
  }
  return sortJobFabRows(rows);
}

/**
 * Stammdaten (Type/Leistung/…) in eine Job-FN-Zeile mergen.
 * Default: Anlagenstamm (local, dann api) vor Job – korrigiert vertauschte Types aus dem Dispo-Index-Bug.
 * opts.preferJob=true: Job-Wert behalten wenn gesetzt (nur Pull lokal↔Server ohne Stamm).
 */
function mergeStammIntoJobRow(jobRow, apiRow, localRow, localDirty, opts) {
  const preferJob = !!(opts && opts.preferJob);
  const fn = normJobFabKey(jobRow);
  const merged = jobRow && typeof jobRow === 'object' ? Object.assign({}, jobRow) : { fabrikationsnummer: fn };
  const api = apiRow && typeof apiRow === 'object' ? apiRow : {};
  const local = localRow && typeof localRow === 'object' ? localRow : {};
  for (const k of JOB_FAB_STAMM_KEYS) {
    const jobVal = stammFieldTrim(merged[k]);
    const localVal = stammFieldTrim(local[k]);
    const apiVal = stammFieldTrim(api[k]);
    if (localDirty && localVal !== '') {
      merged[k] = localVal;
      continue;
    }
    if (preferJob) {
      if (jobVal !== '') {
        merged[k] = jobVal;
        continue;
      }
      if (localVal !== '') {
        merged[k] = localVal;
      } else if (apiVal !== '') {
        merged[k] = apiVal;
      } else {
        merged[k] = '';
      }
      continue;
    }
    if (localVal !== '') {
      merged[k] = localVal;
    } else if (apiVal !== '') {
      merged[k] = apiVal;
    } else {
      merged[k] = jobVal;
    }
  }
  if (fn) merged.fabrikationsnummer = fn;
  return merged;
}

function mergeFabRowsPreferLocal(localRows, serverRows) {
  const localList = Array.isArray(localRows) ? localRows : [];
  const serverList = Array.isArray(serverRows) ? serverRows : [];
  if (localList.length === 0) {
    return serverList.length ? JSON.stringify(serverList) : null;
  }
  const serverByFn = {};
  for (const r of serverList) {
    const fn = normJobFabKey(r);
    if (fn) serverByFn[fn] = r;
  }
  const order = [];
  const seen = new Set();
  for (const r of localList) {
    const fn = normJobFabKey(r);
    if (fn && !seen.has(fn)) {
      seen.add(fn);
      order.push(fn);
    }
  }
  for (const r of serverList) {
    const fn = normJobFabKey(r);
    if (fn && !seen.has(fn)) {
      seen.add(fn);
      order.push(fn);
    }
  }
  const mergedRows = order.map((fn) => {
    const localR = localList.find((r) => normJobFabKey(r) === fn) || { fabrikationsnummer: fn };
    const serverR = serverByFn[fn] || {};
    return mergeStammIntoJobRow(localR, serverR, null, false, { preferJob: true });
  });
  return JSON.stringify(mergedRows);
}

function mergeJobFabrikationsnummernJson(localRaw, serverRaw) {
  const pendingFromLocal = parseJobFabrikationsnummernRows(localRaw);
  const fromServer = parseJobFabrikationsnummernRows(serverRaw);
  return mergeFabRowsPreferLocal(pendingFromLocal, fromServer);
}

/** Leistungszeilen in jobs.fabrikationsnummern mit lokalem Anlagenstamm (dirty bevorzugt) abgleichen. */
function enrichFabJsonWithLocalAnlagenstamm(db, fabJson) {
  if (fabJson == null || fabJson === '') return fabJson;
  ensureAnlagenstammLocalSchema(db);
  const rows = parseJobFabrikationsnummernRows(fabJson);
  if (!rows.length) return fabJson;
  const out = rows.map((r) => {
    const fn = normJobFabKey(r);
    if (!fn) return r;
    const localRow = anlagenstammLookupByFab(db, fn);
    if (!localRow) return r;
    const localDirty = Number(localRow.dirty) === 1 && hasNonemptyStammField(localRow);
    // Dirty-Stamm gewinnt. Sonst Job-Wert behalten (Projektdaten-Edit), leere Felder aus Stamm füllen.
    return mergeStammIntoJobRow(r, {}, localRow, localDirty, { preferJob: !localDirty });
  });
  return JSON.stringify(out);
}

function yieldStammJobFanout() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Nach lokalem Stamm-Save: alle Aufträge mit dieser FN in jobs.fabrikationsnummern aktualisieren. */
async function applyLocalAnlagenstammToMatchingJobs(db, fab) {
  ensureAnlagenstammLocalSchema(db);
  const stamm = anlagenstammLookupByFab(db, String(fab || '').trim());
  if (!stamm) return 0;
  const fn = normJobFabKey({ fabrikationsnummer: fab });
  if (!fn) return 0;
  const localDirty = Number(stamm.dirty) === 1;
  const like = '%' + String(fn).replace(/%/g, '').replace(/_/g, '') + '%';
  const jobRows = db
    .prepare(
      `SELECT id, fabrikationsnummern FROM jobs
       WHERE fabrikationsnummern IS NOT NULL AND TRIM(fabrikationsnummern) != ''
         AND fabrikationsnummern LIKE ?`,
    )
    .all(like);
  let updated = 0;
  for (let i = 0; i < jobRows.length; i++) {
    const j = jobRows[i];
    const parsed = parseJobFabrikationsnummernRows(j.fabrikationsnummern);
    let touched = false;
    const next = parsed.map((r) => {
      if (normJobFabKey(r) !== fn) return r;
      touched = true;
      return mergeStammIntoJobRow(r, {}, stamm, localDirty);
    });
    if (touched) {
      db.prepare(`UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now') WHERE id = ?`).run(
        JSON.stringify(next),
        j.id,
      );
      updated++;
    }
    if (i > 0 && i % 8 === 0) await yieldStammJobFanout();
  }
  return updated;
}

/** Neu hinzugefügte FNs gegen bisherige jobs.fabrikationsnummern (nur Diff – kein Massen-Sync). */
function computeAddedJobFabNums(oldFabJson, newFabJson) {
  const oldSet = new Set(
    parseJobFabrikationsnummernRows(oldFabJson)
      .map((r) => normJobFabKey(r))
      .filter(Boolean),
  );
  const added = [];
  const seen = new Set();
  for (const r of parseJobFabrikationsnummernRows(newFabJson)) {
    const fn = normJobFabKey(r);
    if (!fn || oldSet.has(fn) || seen.has(fn)) continue;
    seen.add(fn);
    added.push(fn);
  }
  return added;
}

/** FNs, deren Stammfelder in der Job-JSON geändert wurden (nicht neu hinzugefügt). */
function computeChangedJobStammFns(oldFabJson, newFabJson) {
  const oldBy = {};
  for (const r of parseJobFabrikationsnummernRows(oldFabJson)) {
    const fn = normJobFabKey(r);
    if (fn) oldBy[fn] = r;
  }
  const changed = [];
  const seen = new Set();
  for (const r of parseJobFabrikationsnummernRows(newFabJson)) {
    const fn = normJobFabKey(r);
    if (!fn || seen.has(fn) || !oldBy[fn]) continue;
    seen.add(fn);
    const prev = oldBy[fn];
    for (const k of JOB_FAB_STAMM_KEYS) {
      if (stammFieldTrim(r[k]) !== stammFieldTrim(prev[k])) {
        changed.push(fn);
        break;
      }
    }
  }
  return changed;
}

function computeRemovedJobFabNums(oldFabJson, newFabJson) {
  const newSet = new Set(
    parseJobFabrikationsnummernRows(newFabJson)
      .map((r) => normJobFabKey(r))
      .filter(Boolean),
  );
  const removed = [];
  const seen = new Set();
  for (const r of parseJobFabrikationsnummernRows(oldFabJson)) {
    const fn = normJobFabKey(r);
    if (!fn || newSet.has(fn) || seen.has(fn)) continue;
    seen.add(fn);
    removed.push(fn);
  }
  return removed;
}

function parseOnlyFabsFilter(raw) {
  if (raw == null || raw === '') return null;
  const set = new Set();
  String(raw)
    .split(/[,;\s]+/)
    .forEach((p) => {
      const t = String(p || '').trim();
      if (t) set.add(t);
    });
  return set.size ? set : null;
}

function filterFabNumsByOnlyFabs(fabNums, onlyFabs) {
  if (!onlyFabs || !onlyFabs.size) return fabNums;
  return fabNums.filter((fn) => onlyFabs.has(String(fn)));
}

function jobFabRowFilterByOnlyFns(rows, onlyFns) {
  if (onlyFns == null) return rows;
  const set = new Set((Array.isArray(onlyFns) ? onlyFns : []).map((f) => normJobFabKey(f)).filter(Boolean));
  if (!set.size) return [];
  return rows.filter((r) => set.has(normJobFabKey(r)));
}

/**
 * Projektdaten: nur leere Stammfelder aus Job-Leistungszeilen füllen.
 * Bestehende Type/Leistung etc. nie aus dem Job überschreiben (Job kann Index-Bug haben).
 * opts.onlyFns: nur diese FN (z. B. beim PATCH fabrikationsnummern).
 */
function syncJobFabRowsToAnlagenstammLocal(db, fabJson, opts) {
  ensureAnlagenstammLocalSchema(db);
  let rows = parseJobFabrikationsnummernRows(fabJson);
  rows = jobFabRowFilterByOnlyFns(rows, opts && opts.onlyFns);
  let n = 0;
  for (const r of rows) {
    const fn = normJobFabKey(r);
    if (!fn) continue;
    const existing = anlagenstammLookupByFab(db, fn);
    const incoming = {
      id: existing && existing.id ? existing.id : 0,
      fabrikationsnummer: fn,
    };
    for (const k of JOB_FAB_STAMM_KEYS) {
      const jobVal = stammFieldTrim(r[k]);
      const exVal = existing ? stammFieldTrim(existing[k]) : '';
      if (jobVal && !exVal) incoming[k] = jobVal;
    }
    const clamped = clampForDispoAnlagenstamm(incoming);
    if (!hasNonemptyStammField(clamped)) continue;
    const payload = mergeAnlagenstammPayload(existing || {}, clamped);
    const saved = anlagenstammSaveLocal(db, payload);
    if (saved.ok) n++;
  }
  return n;
}

/**
 * Explizite Projektdaten-Edits: Job-Stammfelder in anlagenstamm_local schreiben,
 * auch wenn dort schon ein älterer Wert steht (sonst überschreibt der nächste Pull).
 */
function applyJobFabEditsToAnlagenstammLocal(db, fabJson, opts) {
  ensureAnlagenstammLocalSchema(db);
  let rows = parseJobFabrikationsnummernRows(fabJson);
  rows = jobFabRowFilterByOnlyFns(rows, opts && opts.onlyFns);
  let n = 0;
  for (const r of rows) {
    const fn = normJobFabKey(r);
    if (!fn) continue;
    const existing = anlagenstammLookupByFab(db, fn);
    const incoming = {
      id: existing && existing.id ? existing.id : 0,
      fabrikationsnummer: fn,
    };
    let changed = false;
    for (const k of JOB_FAB_STAMM_KEYS) {
      const jobVal = stammFieldTrim(r[k]);
      const exVal = existing ? stammFieldTrim(existing[k]) : '';
      if (jobVal && jobVal !== exVal) {
        incoming[k] = jobVal;
        changed = true;
      }
    }
    if (!changed) continue;
    const clamped = clampForDispoAnlagenstamm(incoming);
    if (!hasNonemptyStammField(clamped)) continue;
    const payload = mergeAnlagenstammPayload(existing || {}, clamped);
    const saved = anlagenstammSaveLocal(db, payload);
    if (saved.ok) n++;
  }
  return n;
}

/** Pending für Dispo-Stamm – nur neue FN mit Stamm-Inhalt (keine leeren Voll-Pushes). */
function enqueueAnlagenstammPendingFromFabJson(db, fabJson, opts) {
  ensureAnlagenstammLocalSchema(db);
  let rows = parseJobFabrikationsnummernRows(fabJson);
  rows = jobFabRowFilterByOnlyFns(rows, opts && opts.onlyFns);
  for (const r of rows) {
    const fn = normJobFabKey(r);
    if (!fn) continue;
    const existing = anlagenstammLookupByFab(db, fn);
    const incoming = clampForDispoAnlagenstamm(
      Object.assign(
        {
          id: existing && existing.id ? existing.id : 0,
          fabrikationsnummer: fn,
        },
        r,
      ),
    );
    const merged = mergeAnlagenstammPayload(existing || {}, incoming);
    if (!hasNonemptyStammField(merged)) continue;
    const pushPayload = stripEmptyStammFieldsForDispoPush(incoming, existing || {});
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'save'`,
    ).run(fn);
    db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
      'anlagenstamm',
      fn,
      'save',
      JSON.stringify(pushPayload),
    );
  }
}

function hasPendingOrDirtyAnlagenstamm(db) {
  ensureAnlagenstammLocalSchema(db);
  const dirty = db.prepare('SELECT COUNT(*) AS c FROM anlagenstamm_local WHERE dirty = 1').get();
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM pending_changes WHERE entity_type = 'anlagenstamm' AND action = 'save'`,
    )
    .get();
  return (dirty && Number(dirty.c) > 0) || (pending && Number(pending.c) > 0);
}


/** Schreiben mit Retry bei EBUSY (OneDrive/Word sperrt Datei). */
function writeFileWithRetry(filePath, data, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(filePath, data);
      return;
    } catch (e) {
      const isBusy = e.code === 'EBUSY' || e.errno === -4082;
      if (isBusy && i < maxRetries - 1) {
        const delay = 400 * (i + 1);
        const end = Date.now() + delay;
        while (Date.now() < end) { /* warten */ }
      } else if (isBusy) {
        throw new Error('Datei ist gesperrt (z. B. durch OneDrive-Sync oder geöffnetes Word). Bitte schließen und erneut versuchen.');
      } else {
        throw e;
      }
    }
  }
}

function keepExistingLocalPdf(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    // Dispo-Download darf eine vorhandene lokale PDF nie überschreiben.
    return !!(st && st.isFile() && st.size > 0);
  } catch (_) {
    return false;
  }
}

function monteurDbSaveErrorMessage() {
  const e = getLastPersistError();
  if (!e) {
    return 'Datenbank konnte nicht auf die Festplatte geschrieben werden.';
  }
  const msg = e && e.message ? String(e.message) : String(e);
  const p = DB_PATH ? ' Pfad: ' + DB_PATH : '';
  return msg + p;
}

/** Selbstsigniertes HTTPS zum Dispo (Kukla-Standard: an, nicht in der UI abschaltbar). */
const DISPO_TLS_INSECURE_FLAG = path.join(DB_DIR, '.dispo-insecure-tls');
const DISPO_TLS_PREF = path.join(DB_DIR, '.dispo-tls-insecure');
const DISPO_ACCEPT_SELF_SIGNED_TLS_DEFAULT = true;

function getUserAppConfigPath() {
  return path.join(DB_DIR, 'app_config.json');
}

function readUserAppConfig() {
  try {
    const p = getUserAppConfigPath();
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function writeUserAppConfig(patch) {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const cur = readUserAppConfig();
  Object.assign(cur, patch);
  fs.writeFileSync(getUserAppConfigPath(), JSON.stringify(cur, null, 2), 'utf8');
}

/** Cache-TTL fuer serverRebootPolicy in app_config.json (7 Tage). */
const SERVER_REBOOT_POLICY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readServerRebootPolicyCache() {
  const cfg = readUserAppConfig();
  const p = cfg && cfg.serverRebootPolicy;
  return p && typeof p === 'object' ? p : null;
}

function writeServerRebootPolicyCache(payload) {
  const cur = readServerRebootPolicyCache() || {};
  const next = {
    sync_version:
      payload && payload.sync_version != null ? payload.sync_version : cur.sync_version,
    reboot_enabled:
      payload && payload.reboot_enabled != null ? !!payload.reboot_enabled : !!cur.reboot_enabled,
    allowed_usernames:
      payload && Array.isArray(payload.allowed_usernames)
        ? payload.allowed_usernames
        : Array.isArray(cur.allowed_usernames)
          ? cur.allowed_usernames
          : [],
    is_allowed_for_current_user:
      payload && payload.is_allowed_for_current_user != null
        ? !!payload.is_allowed_for_current_user
        : cur.is_allowed_for_current_user,
    cached_at: new Date().toISOString(),
  };
  writeUserAppConfig({ serverRebootPolicy: next });
  return next;
}

function isServerRebootPolicyCacheStale(policy) {
  if (!policy || !policy.cached_at) return true;
  const ts = Date.parse(String(policy.cached_at));
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > SERVER_REBOOT_POLICY_CACHE_TTL_MS;
}

function isUserAllowedByRebootPolicy(policy, username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || !policy) return false;
  if (policy.is_allowed_for_current_user === true) return true;
  if (policy.is_allowed_for_current_user === false) return false;
  const list = Array.isArray(policy.allowed_usernames) ? policy.allowed_usernames : [];
  return list.some(function (name) {
    return String(name || '').trim().toLowerCase() === u;
  });
}

function isDispoInsecureTlsAllowed() {
  if (process.env.KUKLA_DISP_TLS_INSECURE === '1') return true;
  if (process.env.KUKLA_DISP_TLS_INSECURE === '0') return false;
  const cfg = readUserAppConfig();
  if (cfg.acceptSelfSignedDispoTls === false) return false;
  if (cfg.acceptSelfSignedDispoTls === true) return true;
  if (fs.existsSync(DISPO_TLS_INSECURE_FLAG)) return true;
  try {
    if (fs.existsSync(DISPO_TLS_PREF)) {
      return fs.readFileSync(DISPO_TLS_PREF, 'utf8').trim() !== '0';
    }
  } catch (_) {}
  return DISPO_ACCEPT_SELF_SIGNED_TLS_DEFAULT;
}

function applyDispoInsecureTlsPreference() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!isDispoInsecureTlsAllowed()) {
    try {
      if (fs.existsSync(DISPO_TLS_INSECURE_FLAG)) fs.unlinkSync(DISPO_TLS_INSECURE_FLAG);
    } catch (_) {}
    fs.writeFileSync(DISPO_TLS_PREF, '0');
    if (process.env.KUKLA_DISP_TLS_INSECURE !== '1') {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
    return;
  }
  fs.writeFileSync(DISPO_TLS_PREF, '1');
  fs.writeFileSync(DISPO_TLS_INSECURE_FLAG, '1');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  writeUserAppConfig({ acceptSelfSignedDispoTls: true });
}


function logAbsenceRequestError(info) {
  try {
    const line = new Date().toISOString() + ' ' + JSON.stringify(info) + '\n';
    const logPath = path.join(DB_DIR, 'absence_request_errors.log');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch (e) {
    // Logging-Fehler ignorieren
  }
}

/** Sync-Push-Fehler in Datei und Konsole (zum Debuggen: Log liegt im Ordner der monteur.db). */
function logSyncPushError(info) {
  const line = new Date().toISOString() + ' [sync_push] ' + JSON.stringify(info, null, 0) + '\n';
  console.error('[sync_push]', info);
  try {
    const logPath = path.join(DB_DIR, 'sync_push_errors.log');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch (e) {
    // Logging-Fehler ignorieren
  }
}

/**
 * Permanenter/ausgeschöpfter Push-Fehler → Dead-Letter, Queue freimachen.
 * @returns {'offline'|'retry'|'dead'}
 */
function resolveSyncPushFailure(db, pendingRow, err, reason) {
  const msg = err && err.message ? String(err.message) : String(err || '');
  const status = err && Number.isFinite(err.status) ? err.status : undefined;
  logSyncPushError({
    reason,
    error: msg,
    status,
    pending_id: pendingRow && pendingRow.id,
    entity_type: pendingRow && pendingRow.entity_type,
    action: pendingRow && pendingRow.action,
  });
  if (!pendingRow || pendingRow.id == null) return 'dead';
  if (isLikelyOfflineSyncError(err)) {
    return 'offline';
  }
  const prevAttempts = Number(pendingRow.attempts) || 0;
  const attempts = prevAttempts + 1;
  const permanent = isPermanentSyncPushError(err);
  if (permanent || attempts >= SYNC_PUSH_MAX_ATTEMPTS) {
    try {
      db.prepare(
        `INSERT INTO pending_changes_failed (
          original_pending_id, entity_type, entity_id, action, payload,
          attempts, last_error, fail_reason, created_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        pendingRow.id,
        String(pendingRow.entity_type || ''),
        String(pendingRow.entity_id != null ? pendingRow.entity_id : ''),
        String(pendingRow.action || ''),
        pendingRow.payload != null ? String(pendingRow.payload) : null,
        attempts,
        msg.slice(0, 4000),
        permanent
          ? 'permanent:' + reason
          : 'max_attempts:' + reason,
        pendingRow.created_at != null ? String(pendingRow.created_at) : null,
      );
    } catch (insErr) {
      console.warn(
        '[sync_push] dead-letter insert failed:',
        insErr && insErr.message ? insErr.message : insErr,
      );
    }
    try {
      db.prepare('DELETE FROM pending_changes WHERE id = ?').run(pendingRow.id);
    } catch (_) {
      /* ignore */
    }
    console.warn('[sync_push] dead-letter (queue cleared):', {
      pending_id: pendingRow.id,
      reason,
      attempts,
      permanent,
      error: msg.slice(0, 200),
    });
    return 'dead';
  }
  try {
    db.prepare(
      `UPDATE pending_changes SET attempts = ?, last_error = ?, last_attempt_at = datetime('now') WHERE id = ?`,
    ).run(attempts, msg.slice(0, 4000), pendingRow.id);
  } catch (_) {
    /* Spalten fehlen vor Migration – Eintrag bleibt, nächster Start migriert */
  }
  pendingRow.attempts = attempts;
  console.warn('[sync_push] transient error, keep for retry:', {
    pending_id: pendingRow.id,
    attempt: attempts,
    max: SYNC_PUSH_MAX_ATTEMPTS,
    error: msg.slice(0, 200),
  });
  return 'retry';
}

function sanitizeHotelAddressPendingPayload(rawPayload) {
  let payload = rawPayload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      return rawPayload;
    }
  }
  if (!payload || typeof payload !== 'object') {
    return typeof rawPayload === 'string' ? rawPayload : '';
  }
  payload.hotel_country = payload.hotel_country != null ? String(payload.hotel_country) : '';
  return JSON.stringify(payload);
}

function requeueFailedPendingChanges(dbConn) {
  const rows = dbConn.prepare('SELECT * FROM pending_changes_failed ORDER BY id ASC').all() || [];
  if (!rows.length) return 0;
  const ins = dbConn.prepare(
    `INSERT INTO pending_changes (entity_type, entity_id, action, payload, created_at, attempts, last_error, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
  );
  const del = dbConn.prepare('DELETE FROM pending_changes_failed WHERE id = ?');
  let n = 0;
  const apply = () => {
    n = 0;
    for (const row of rows) {
      let payload = row.payload != null ? String(row.payload) : null;
      if (String(row.action || '') === 'hotel_address' && payload) {
        payload = sanitizeHotelAddressPendingPayload(payload);
      }
      ins.run(
        String(row.entity_type || ''),
        row.entity_id != null ? String(row.entity_id) : '',
        String(row.action || ''),
        payload,
        row.created_at != null ? String(row.created_at) : null,
      );
      del.run(row.id);
      n += 1;
    }
  };
  if (typeof dbConn.transaction === 'function') {
    const ret = dbConn.transaction(apply);
    if (typeof ret === 'function') ret();
  } else {
    apply();
  }
  return n;
}

function requeueFailedPendingByTypes(dbConn, types) {
  const list = Array.isArray(types) ? types.map((t) => String(t || '')).filter(Boolean) : [];
  if (!dbConn || !list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  let rows = [];
  try {
    rows =
      dbConn
        .prepare(
          `SELECT * FROM pending_changes_failed WHERE entity_type IN (${placeholders}) ORDER BY id ASC`,
        )
        .all(...list) || [];
  } catch (_) {
    return 0;
  }
  if (!rows.length) return 0;
  const ins = dbConn.prepare(
    `INSERT INTO pending_changes (entity_type, entity_id, action, payload, created_at, attempts, last_error, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
  );
  const del = dbConn.prepare('DELETE FROM pending_changes_failed WHERE id = ?');
  let n = 0;
  const apply = () => {
    for (const row of rows) {
      ins.run(
        String(row.entity_type || ''),
        row.entity_id != null ? String(row.entity_id) : '',
        String(row.action || ''),
        row.payload != null ? String(row.payload) : null,
        row.created_at != null ? String(row.created_at) : null,
      );
      del.run(row.id);
      n += 1;
    }
  };
  if (typeof dbConn.transaction === 'function') {
    const ret = dbConn.transaction(apply);
    if (typeof ret === 'function') ret();
  } else {
    apply();
  }
  return n;
}

/** Laufzeit-Kontext für IPC / Flush (gesetzt in getDb und createApp). */
const monteurRuntime = { db: null, save: null, bgJobs: null };
let getDbPromise = null;

function getMonteurDb() {
  return monteurRuntime.db;
}

async function getDb() {
  if (getDbPromise) return getDbPromise;
  getDbPromise = loadDbOnce();
  return getDbPromise;
}

function ensureDienstreisePushCacheSchema(dbOrSql) {
  const run = (sql) => {
    if (dbOrSql && typeof dbOrSql.run === 'function' && !dbOrSql.prepare) {
      dbOrSql.run(sql);
    } else if (dbOrSql && dbOrSql.prepare) {
      dbOrSql.prepare(sql).run();
    }
  };
  run(`CREATE TABLE IF NOT EXISTS dienstreise_push_cache (
    local_job_id INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    local_mtime_ms INTEGER NOT NULL DEFAULT 0,
    local_size INTEGER NOT NULL DEFAULT 0,
    synced_mtime_ms INTEGER NOT NULL DEFAULT 0,
    synced_size INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT,
    PRIMARY KEY (local_job_id, rel_path)
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_dienstreise_push_cache_job ON dienstreise_push_cache(local_job_id)');
  if (dbOrSql && dbOrSql.prepare) {
    ensureJobOfflinePullSchema(dbOrSql);
  }
}

async function loadDbOnce() {
  configurePersistentDbDir();
  try {
    applyDispoInsecureTlsPreference();
  } catch (tlsErr) {
    console.warn('[dispo-tls] apply:', tlsErr && tlsErr.message ? tlsErr.message : tlsErr);
  }
  await openMonteurDatabase({ dbPath: DB_PATH });
  ensureDienstreisePushCacheSchema(getNativeDb());
  const wrapper = createDbCompat();
  try {
    ensureAnlagenstammLocalSchema(wrapper);
    ensureAnlagenstammTreeCacheSchema(wrapper);
  } catch (e) {
    console.warn('[anlagenstamm_local] schema:', e && e.message ? e.message : e);
  }
  monteurRuntime.db = wrapper;
  monteurRuntime.save = () => wrapper.save();
  try {
    const n = requeueFailedPendingByTypes(wrapper, ['schleppketten', 'pruefzertifikat', 'protocol_draft']);
    if (n > 0) {
      console.log('[sync] requeued dead-letter:', n, 'schleppketten/pruefzertifikat/protocol_draft');
      wrapper.save();
    }
  } catch (requeueErr) {
    console.warn('[sync] requeue dead-letter:', requeueErr && requeueErr.message ? requeueErr.message : requeueErr);
  }
  return wrapper;
}

function flushMonteurDb() {
  flushDb();
  if (monteurRuntime.save) return monteurRuntime.save();
  return true;
}

/**
 * Lokales Anlagenstamm-Speichern (SQLite + pending) – für HTTP und IPC, immer vor Dispo.
 * @param {object} body
 * @param {number|null} technicianIdFromHeader
 */
async function performAnlagenstammSave(body, technicianIdFromHeader) {
  const db = monteurRuntime.db;
  const save = monteurRuntime.save;
  const bgJobs = monteurRuntime.bgJobs;
  if (!db || !save) {
    return { ok: false, error: 'Lokale Datenbank nicht bereit (App startet noch).' };
  }
  const technicianId =
    technicianIdFromHeader ??
    (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
  if (!technicianId) {
    return { ok: false, error: 'technician_id erforderlich.' };
  }
  ensureAnlagenstammLocalSchema(db);
  const bodyNorm = clampForDispoAnlagenstamm(body || {});
  const hasMotorPayload = Object.prototype.hasOwnProperty.call(body || {}, 'motoren')
    || Object.prototype.hasOwnProperty.call(body || {}, 'motor')
    || Object.keys(body || {}).some((k) => /^motor\[\d+]\[/.test(k));
  if (hasMotorPayload) {
    bodyNorm.motoren = normalizeMotorRows(body || {});
  }
  const fabForLookup = String(bodyNorm.fabrikationsnummer || '').trim();
  const existingBeforeSave = fabForLookup ? anlagenstammLookupByFab(db, fabForLookup) : null;
  const bodyMerged = mergeAnlagenstammPayload(existingBeforeSave || {}, bodyNorm);
  if (hasMotorPayload) {
    bodyMerged.motoren = bodyNorm.motoren;
  }
  const localResult = anlagenstammSaveLocal(db, bodyMerged);
  if (!localResult.ok) {
    return localResult;
  }
  const fabKey = String(localResult.fabrikationsnummer || '').trim();
  const existingAfterSave = fabKey ? anlagenstammLookupByFab(db, fabKey) : null;
  if (fabKey && stammJobFieldsChanged(existingBeforeSave, existingAfterSave || bodyMerged)) {
    await applyLocalAnlagenstammToMatchingJobs(db, fabKey);
  }
  const baseCandidates = buildDispoBaseCandidates({
    baseUrl: body.baseUrl,
    externalUrl: body.externalUrl,
    internalUrl: body.internalUrl,
  });
  const defaultBase = baseCandidates.length ? baseCandidates[0] : '';
  const pushStamm = stripEmptyStammFieldsForDispoPush(bodyNorm, existingBeforeSave || existingAfterSave || {});
  const pushPayload = Object.assign({}, pushStamm, {
    fabrikationsnummer: localResult.fabrikationsnummer,
    serverUsername: body.serverUsername,
    baseUrl: body.baseUrl || defaultBase,
    externalUrl: body.externalUrl,
    internalUrl: body.internalUrl,
    technician_id: technicianId,
  });
  // Lokal speichern ist Source of Truth; Dispo nur asynchron über pending_changes + sync_push.
  const pendingSync = true;
  const hasDispoBase = baseCandidates.length > 0;
  if (fabKey) {
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'save'`,
    ).run(fabKey);
    db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
      'anlagenstamm',
      fabKey,
      'save',
      JSON.stringify(pushPayload),
    );
  }
  if (!save()) {
    return {
      ok: false,
      error:
        'Lokale Datenbank konnte nicht auf die Festplatte geschrieben werden. ' +
        monteurDbSaveErrorMessage() +
        ' Bitte App mit Schreibrechten auf den Benutzerordner starten.',
    };
  }
  if (bgJobs && hasDispoBase) {
    const baseForPush = (pushPayload.baseUrl || defaultBase || '').toString().trim().replace(/\/$/, '');
    if (baseForPush) {
      try {
        bgJobs.enqueue(
          'sync_push',
          {
            baseUrl: baseForPush,
            externalUrl: body.externalUrl,
            internalUrl: body.internalUrl,
            technicianId,
            serverUsername: body.serverUsername,
            serverPassword: body.serverPassword,
          },
          'sync_push:' + technicianId + ':' + fingerprintDispoBaseForRuntime(baseForPush),
        );
        if (typeof bgJobs.kick === 'function') bgJobs.kick();
      } catch (enqueueErr) {
        console.warn(
          '[anlagenstamm_save] sync_push enqueue:',
          enqueueErr && enqueueErr.message ? enqueueErr.message : enqueueErr,
        );
      }
    }
  }
  const kept = fabKey ? anlagenstammLookupByFab(db, fabKey) : null;
  return {
    ok: true,
    id: kept && kept.id ? kept.id : localResult.id,
    fabrikationsnummer: localResult.fabrikationsnummer,
    pending_sync: pendingSync,
    push_error: null,
    _source: 'local',
  };
}

/**
 * Lokales Anlagenstamm-Löschen (SQLite + pending) – für HTTP und IPC.
 * @param {object} body
 * @param {number|null} technicianIdFromHeader
 */
async function performAnlagenstammDelete(body, technicianIdFromHeader) {
  const db = monteurRuntime.db;
  const save = monteurRuntime.save;
  const bgJobs = monteurRuntime.bgJobs;
  if (!db || !save) {
    return { success: false, error: 'Lokale Datenbank nicht bereit (App startet noch).' };
  }
  const technicianId =
    technicianIdFromHeader ??
    (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
  const id = parseInt(String(body.id ?? ''), 10);
  if (!technicianId) {
    return { success: false, error: 'technician_id erforderlich.' };
  }
  if (!Number.isFinite(id) || id <= 0) {
    return { success: false, error: 'id erforderlich.' };
  }
  ensureAnlagenstammLocalSchema(db);
  const row = db.prepare('SELECT id, fabrikationsnummer FROM anlagenstamm_local WHERE id = ?').get(id);
  if (!row) {
    return { success: false, error: 'Anlage nicht gefunden' };
  }
  const fab = String(row.fabrikationsnummer || '').trim();
  const baseCandidates = buildDispoBaseCandidates({
    baseUrl: body.baseUrl,
    externalUrl: body.externalUrl,
    internalUrl: body.internalUrl,
  });
  const defaultBase = baseCandidates.length ? baseCandidates[0] : '';
  const pushPayload = {
    id: row.id,
    fabrikationsnummer: fab,
    serverUsername: body.serverUsername,
    serverPassword: body.serverPassword,
    baseUrl: body.baseUrl || defaultBase,
    externalUrl: body.externalUrl,
    internalUrl: body.internalUrl,
    technician_id: technicianId,
  };
  let pendingSync = false;
  let pushError = null;
  const hasDispoBase = baseCandidates.length > 0 && row.id > 0;
  if (hasDispoBase) {
    try {
      const remote = await proxyAnlagenstammDelete(pushPayload);
      if (remote && remote.ok !== false) {
        pendingSync = false;
      } else {
        pendingSync = true;
        pushError = (remote && remote.error) || 'Dispo hat Löschen abgelehnt.';
      }
    } catch (e) {
      pendingSync = true;
      pushError = e && e.message ? e.message : String(e);
    }
  } else {
    pendingSync = true;
    if (!row.id) {
      pushError = 'Keine Server-ID – Löschen nur lokal.';
    }
  }
  db.prepare('DELETE FROM anlagenstamm_local WHERE id = ?').run(id);
  if (fab) {
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'save'`,
    ).run(fab);
    try {
      db.prepare('DELETE FROM anlagenstamm_tree_cache WHERE fab = ?').run(fab);
    } catch (_) {
      /* ignore */
    }
  }
  const pendingKey = fab || String(id);
  if (pendingSync && pendingKey) {
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'delete'`,
    ).run(pendingKey);
    db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
      'anlagenstamm',
      pendingKey,
      'delete',
      JSON.stringify(pushPayload),
    );
  } else if (!pendingSync && pendingKey) {
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'delete'`,
    ).run(pendingKey);
  }
  if (!save()) {
    return {
      success: false,
      error:
        'Lokale Datenbank konnte nicht auf die Festplatte geschrieben werden. ' +
        monteurDbSaveErrorMessage(),
    };
  }
  if (pendingSync && bgJobs && hasDispoBase) {
    const baseForPush = (pushPayload.baseUrl || defaultBase || '').toString().trim().replace(/\/$/, '');
    if (baseForPush) {
      try {
        bgJobs.enqueue(
          'sync_push',
          {
            baseUrl: baseForPush,
            externalUrl: body.externalUrl,
            internalUrl: body.internalUrl,
            technicianId,
            serverUsername: body.serverUsername,
            serverPassword: body.serverPassword,
          },
          'sync_push:' + technicianId + ':' + fingerprintDispoBaseForRuntime(baseForPush),
        );
      } catch (enqueueErr) {
        console.warn(
          '[anlagenstamm_delete] sync_push enqueue:',
          enqueueErr && enqueueErr.message ? enqueueErr.message : enqueueErr,
        );
      }
    }
  }
  return {
    success: true,
    id,
    fabrikationsnummer: fab,
    pending_sync: pendingSync,
    push_error: pushError,
    source: 'local_cache',
  };
}

/** Dispo-Dateizeitstempel (Sekunden oder ms, ISO) → ms seit Epoch; null wenn unbekannt. */
function parseDispoFileMtimeMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = value;
    return n > 0 && n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const s = String(value).trim();
  if (!s) return null;
  const num = Number(s);
  if (Number.isFinite(num) && num > 0) {
    return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

function dispoEntryMtimeMs(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return parseDispoFileMtimeMs(
    entry.mtime != null
      ? entry.mtime
      : entry.mtime_ms != null
        ? entry.mtime_ms
        : entry.modified != null
          ? entry.modified
          : entry.modified_at != null
            ? entry.modified_at
            : entry.file_mtime,
  );
}

/** Lokale mtime an Dispo anlehnen, damit Delta-Sync nicht bei jedem Lauf erneut lädt. */
function applyLocalFileMtimeFromDispo(filePath, mtimeMs) {
  if (mtimeMs == null || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return;
  try {
    const sec = mtimeMs / 1000;
    fs.utimesSync(filePath, sec, sec);
  } catch (_) {
    /* ignore */
  }
}

/** Hash für sync_push dedupe (createApp setzt ggf. eigene Variante – hier minimal). */
function fingerprintDispoBaseForRuntime(urlRaw) {
  const base = (urlRaw || '').trim().replace(/\/$/, '');
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 24);
}

/** Wird in createApp auf multiDeviceApi.pushJsonDraft gesetzt (pending protocol_draft). */
let protocolDraftPushImpl = null;

function createApp(db) {
  const app = express();
  app.use(require('./lib/local-gateway-auth').localGatewayExpressMiddleware);
  app.get(['/api/health', '/health'], (_req, res) => {
    res.json({ ok: true });
  });

  const getTechnicianId = (req) => {
    const raw = req.query.technician_id || req.headers['x-technician-id'];
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) {
        writeLastTechnicianId(n);
        return n;
      }
    }
    return readLastTechnicianId();
  };

  function loadDispoWebSessionCreds() {
    try {
      const s = loadWebSession(DB_DIR) || {};
      return {
        serverUsername: s.dispo_username || '',
        serverPassword: s.dispo_password || '',
        baseUrl: s.dispo_base || s.dispo_external_url || '',
        externalUrl: s.dispo_external_url || '',
        internalUrl: s.dispo_internal_url || '',
      };
    } catch (_) {
      return {};
    }
  }

  /**
   * Zugangsdaten: Vault zuerst. Body-Passwort nur als Erst-Login / Alt-Client,
   * wenn die Session noch leer ist oder der Nutzer ein neues Passwort sendet.
   */
  function resolveDispoServerCreds(body) {
    const session = loadDispoWebSessionCreds();
    const b = body && typeof body === 'object' ? body : {};
    const bodyUser = String(b.serverUsername || b.dispo_username || b.dispoUsername || '').trim();
    const user = bodyUser || String(session.serverUsername || '').trim();
    const bodyPass = String(b.serverPassword || b.dispoPassword || b.dispo_password || '');
    const pass = bodyPass !== '' ? bodyPass : String(session.serverPassword || '');
    const baseUrl = String(b.baseUrl || session.baseUrl || session.externalUrl || '')
      .trim()
      .replace(/\/$/, '');
    return {
      serverUsername: user,
      serverPassword: pass,
      baseUrl,
      externalUrl: String(b.externalUrl || session.externalUrl || '').trim().replace(/\/$/, ''),
      internalUrl: String(b.internalUrl || session.internalUrl || '').trim().replace(/\/$/, ''),
    };
  }

  const { registerAnlagenstammPhpRoutes } = require('./lib/anlagenstamm-php-routes');
  const { registerAbrechnungPhpRoutes } = require('./lib/abrechnung-php-routes');
  let prewarmAnlagenstammGalleryThumbsImpl = null;
  const { registerMonteurDispoWebRoutes, ensureProxyAuthenticated, saveWebSession, loadWebSession } = require('./lib/monteur-dispo-web-routes');
  const { registerMultiDeviceRoutes } = require('./lib/multi-device-routes');
  let multiDeviceApi = null;
  registerAnlagenstammPhpRoutes(app, {
    db,
    getTechnicianId,
    performAnlagenstammSave,
    performAnlagenstammDelete,
    saveDb: () => (monteurRuntime.save ? monteurRuntime.save() : false),
    ensureProxyAuthenticated: (creds) => ensureProxyAuthenticated(DB_DIR, creds || null),
    resolveDispoServerCreds: (body) => resolveDispoServerCreds(body || {}),
    readAnlagenstammTreeCache,
    upsertAnlagenstammTreeCache,
    buildLocalProjekteNeuTreeForFab: (technicianId, fab) => {
      const f = String(fab || '').trim();
      if (!f) return null;
      const cached = readAnlagenstammTreeCache(db, f);
      if (cached && cached.tree && cached.tree.length) {
        const first = cached.tree[0];
        return {
          enabled: cached.projects_enabled !== false,
          tree: cached.tree,
          root_name: first && (first.name || first.label) ? String(first.name || first.label) : '',
        };
      }
      return null;
    },
    getDispoUsername: () => resolveDispoServerCreds({}).serverUsername || '',
    getDispoPassword: () => resolveDispoServerCreds({}).serverPassword || '',
    getDispoBaseUrl: () => resolveDispoServerCreds({}).baseUrl || '',
    getDispoExternalUrl: () => resolveDispoServerCreds({}).externalUrl || '',
    getDispoInternalUrl: () => resolveDispoServerCreds({}).internalUrl || '',
    prewarmAnlagenstammGalleryThumbs: (fab, gallery, technicianId) => {
      if (typeof prewarmAnlagenstammGalleryThumbsImpl === 'function') {
        prewarmAnlagenstammGalleryThumbsImpl(fab, gallery, technicianId);
      }
    },
  });
  registerAbrechnungPhpRoutes(app, {
    db,
    save: () => (monteurRuntime.save ? monteurRuntime.save() : false),
    dbDir: DB_DIR,
    getTechnicianId,
    loadDispoCreds: loadDispoWebSessionCreds,
    authHeaderFromCredentials,
    resolveDienstreiseReiseDirForJob: (jobIdRef, opts) => resolveDienstreiseReiseDirForJob(jobIdRef, opts),
    getDienstreiseBasePath: () => getDienstreiseBasePath(),
  });
  registerMonteurDispoWebRoutes(app, { db, dbDir: DB_DIR });
  app.use(express.json({ limit: '50mb' }));
  const { registerBugReportRoutes } = require('./lib/bug-report-routes');
  registerBugReportRoutes(app, {
    resolveDispoServerCreds,
    authHeaderFromCredentials,
    fetchWithTimeout,
    getTechnicianId,
    getAppVersion: () => {
      try {
        const v = require('./version.json');
        return (v && (v.version || v.label)) || '';
      } catch (_) {
        return '';
      }
    },
  });

  multiDeviceApi = registerMultiDeviceRoutes({
    app,
    db,
    DB_DIR,
    save: () => save(),
    fetchWithTimeout,
    getTechnicianId,
    resolveDienstreiseReiseDirForJob,
    cleanupDienstreiseReiseDir: (...args) => cleanupDienstreiseReiseDir(...args),
    listProtectedPaths,
    bgJobs: null, // gesetzt nach createBackgroundJobService
    getBgJobs: () => bgJobs,
    getAppVersion: () => {
      try {
        const v = require('./version.json');
        return (v && (v.version || v.label)) || '';
      } catch (_) {
        return '';
      }
    },
  });
  protocolDraftPushImpl = (opts) => multiDeviceApi.pushJsonDraft(opts);

  /**
   * Protokoll-JSON vom Dispo-Draft-API nach Dokumente_Monteur holen (zweiter Laptop).
   * Ohne Session/Creds oder bei local_only: no-op.
   */
  async function pullOneJsonDraftForJob(reiseDir, localJobId, serverJobId, technicianId, basename, reqSrc) {
    if (!multiDeviceApi || !multiDeviceApi.pullJsonDraft) return;
    if (wantsLocalOnlyRequest(reqSrc || {})) return;
    const parsedServer = parseInt(serverJobId, 10);
    if (!Number.isFinite(parsedServer) || parsedServer <= 0 || !technicianId || !reiseDir) return;
    const creds = resolveDispoServerCreds(reqSrc || {});
    if (!creds.baseUrl) return;
    const endpoint = DRAFT_JSON_ENDPOINTS[basename];
    if (!endpoint) return;
    const filePath = resolveMonteurDraftJsonPath(reiseDir, basename, false);
    try {
      await multiDeviceApi.pullJsonDraft({
        dispoBaseUrl: creds.baseUrl,
        endpoint,
        technicianId,
        serverJobId: parsedServer,
        localJobId,
        reiseDir,
        basename,
        filePath,
        username: creds.serverUsername,
        password: creds.serverPassword,
      });
    } catch (e) {
      console.warn('[draft_pull]', basename, e && e.message ? e.message : e);
    }
  }

  /** Schreibzugriff blockiert für „angelegt“ (inkl. Legacy „geplant“) und „abgerechnet“. */
  function localJobWriteBlocked(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'angelegt' || s === 'geplant') {
      return { error: 'Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    if (s === 'abgerechnet') {
      return { error: 'Auftrag ist abgerechnet – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    if (s === 'erledigt') {
      return {
        error: 'Auftrag ist erledigt – nur noch Lesen. Lokale Kopie ggf. über „Lokale Kopie löschen“ entfernen.',
        status: 409,
        code: 'job_closed',
      };
    }
    return null;
  }

  /** Projektordner anlegen/kopieren nur nach Annahme (lokal in_arbeit). */
  function dienstreiseProjectFolderBlocked(status) {
    const s = String(status || '').trim().toLowerCase();
    if (s === 'in_arbeit') return null;
    return {
      error: 'Projektordner erst nach „Auftrag annehmen“ (Status in Arbeit).',
      status: 403,
    };
  }

  /** Lokaler Auftrag für Schreibzugriff; blockiert Status nur Anzeige / abgerechnet. */
  function getWritableLocalJobMetaForPatch(dbConn, technicianId, rawJobId) {
    const resolved = resolveLocalJobIdForTechnician(dbConn, technicianId, rawJobId, { mode: 'auto' });
    if (!resolved.ok) return { error: resolved.error, status: resolved.status };
    const blocked = localJobWriteBlocked(resolved.status);
    if (blocked) return blocked;
    return { localId: resolved.localId };
  }

  /** Dienstreise-/Datei-Schreibzugriff: gleiche Regeln wie PATCH (inkl. Techniker-Zuordnung), sonst nur Status-Prüfung per lokaler ID (z. B. Upload ohne technicianId im Body). */
  function gateDienstreiseWrite(dbConn, technicianId, localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return { error: 'job_id (lokal) erforderlich.', status: 400 };
    const tid = parseInt(technicianId, 10);
    if (Number.isFinite(tid) && tid > 0) {
      const w = getWritableLocalJobMetaForPatch(dbConn, tid, lid);
      if (w.error) return w;
      return null;
    }
    const row = dbConn.prepare(`
      SELECT id, status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
      ORDER BY CASE WHEN j.id = ? THEN 0 ELSE 1 END, j.id ASC
      LIMIT 1
    `).get(lid, lid, lid);
    if (!row) return { error: 'Auftrag nicht gefunden.', status: 404 };
    const blocked = localJobWriteBlocked(row.status);
    if (blocked) return blocked;
    return null;
  }

  const sseClients = new Map();
  const pushWsByTechnician = new Map();
  function getPushWsUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    const u = baseUrl.trim().replace(/\/$/, '');
    try {
      const url = new URL(u);
      // Apache Proxy /push-ws → Node :39679/ws (nicht Port direkt)
      return (url.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + url.host + '/push-ws';
    } catch (e) { return null; }
  }
  function connectPushForTechnician(technicianId, baseUrl) {
    const wsUrl = getPushWsUrl(baseUrl);
    if (!wsUrl || pushWsByTechnician.has(technicianId)) return;
    try {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        let username = '';
        let permAdmin = false;
        try {
          const row = db.prepare('SELECT username, COALESCE(perm_admin, 0) AS perm_admin, role FROM users WHERE id = ? LIMIT 1').get(technicianId);
          if (row) {
            username = String(row.username || '');
            permAdmin = Number(row.perm_admin) === 1 || String(row.role || '') === 'admin';
          }
        } catch (e) {}
        ws.send(JSON.stringify({
          type: 'auth',
          technician_id: technicianId,
          user_id: technicianId,
          username,
          perm_admin: permAdmin || undefined,
          role: permAdmin ? 'admin' : 'monteur',
        }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.channel === 'absence_request_decided' && msg.payload) {
            const requestId = msg.payload.request_id;
            const status = msg.payload.status;
            if (requestId != null && status) {
              try {
                db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE server_id = ? AND technician_id = ?').run(status, requestId, technicianId);
                save();
              } catch (e) {}
            }
            const set = sseClients.get(technicianId);
            if (set) set.forEach((res) => { res.write('data: ' + JSON.stringify(msg) + '\n\n'); });
          } else if (msg.channel === 'server_status' || msg.channel === 'auth_security') {
            const set = sseClients.get(technicianId);
            if (set) set.forEach((res) => { res.write('data: ' + JSON.stringify(msg) + '\n\n'); });
          }
        } catch (e) {}
      });
      ws.on('error', () => {
        // Push-Server nicht erreichbar: Verbindung verwerfen, App aber nicht crashen lassen.
        pushWsByTechnician.delete(technicianId);
      });
      ws.on('close', () => { pushWsByTechnician.delete(technicianId); });
      pushWsByTechnician.set(technicianId, ws);
    } catch (e) {
      // Fehler beim Aufbau der Verbindung ignorieren – App soll ohne Push weiterlaufen.
    }
  }

  function getTechnicianDisplayName(technicianId) {
    const tid = parseInt(technicianId, 10);
    if (!Number.isFinite(tid) || tid <= 0) return null;
    try {
      const row = db.prepare('SELECT full_name, username FROM users WHERE id = ? LIMIT 1').get(tid);
      if (!row) return null;
      const fullName = String(row.full_name || '').trim();
      if (fullName) return fullName;
      const username = String(row.username || '').trim();
      return username || null;
    } catch (_) {
      return null;
    }
  }

  function contentDispositionFilename(headerValue) {
    const raw = String(headerValue || '');
    if (!raw) return null;
    const utf = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf && utf[1]) {
      try {
        return decodeURIComponent(utf[1].trim().replace(/^"|"$/g, ''));
      } catch (_) {}
    }
    const plain = raw.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plain && plain[2]) {
      try {
        return decodeURIComponent(plain[2].trim());
      } catch (_) {
        return plain[2].trim();
      }
    }
    return null;
  }

  function ingestParameterFileIntoAnlagenstamm(opts) {
    ensureAnlagenstammLocalSchema(db);
    const fileName = String((opts && opts.fileName) || '').trim();
    const source = String((opts && opts.source) || '').trim() || 'upload';
    const sourcePath = String((opts && opts.sourcePath) || '').trim() || null;
    const storageRelPath = String((opts && opts.storageRelPath) || '').trim() || null;
    if (!isSupportedParameterFileName(fileName)) return { ok: false, skipped: true, reason: 'unsupported_extension' };
    const buf = opts && opts.buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, skipped: true, reason: 'empty_buffer' };
    const parsed = parseParameterFile(buf, { fileName });
    if (!parsed || !parsed.ok) return { ok: false, skipped: true, reason: 'parse_failed' };
    const usedFab = normalizeParameterFab(parsed.used_fab);
    if (!usedFab) return { ok: false, skipped: true, reason: 'fab_missing' };
    const uploadedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insert = upsertParameterFile(db, {
      fab: usedFab,
      source,
      source_file_status: 'present',
      technician_id: opts && opts.technicianId != null ? Number(opts.technicianId) : null,
      technician_name: opts && opts.technicianName ? String(opts.technicianName) : null,
      uploaded_at: uploadedAt,
      original_filename: parsed.file_name || path.basename(fileName),
      mime: opts && opts.mime ? String(opts.mime) : 'application/octet-stream',
      size: buf.length,
      sha256: parsed.sha256,
      storage_relpath: storageRelPath,
      source_path: sourcePath,
      filename_fn: parsed.filename_fab || null,
      content_fn: parsed.content_fab || null,
      used_fn: usedFab,
      server_file_id: opts && opts.serverFileId != null ? Number(opts.serverFileId) : null,
      entries: parsed.entries || [],
    });
    if (insert && insert.ok) save();
    return Object.assign({ fab: usedFab }, insert || {});
  }

  function flattenProjekteNeuFiles(tree, prefix, out) {
    const list = Array.isArray(tree) ? tree : [];
    const pfx = String(prefix || '').trim();
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const name = String(node.name || '').trim();
      const rel = String(node.rel || '').trim();
      const type = String(node.type || '').trim();
      const nextRel = rel || (pfx && name ? (pfx + '/' + name) : name);
      if (type === 'file') {
        out.push({
          rel: nextRel.replace(/\\/g, '/'),
          name: name || path.basename(nextRel),
          size: node.size != null ? Number(node.size) : 0,
          mtime: node.mtime || null,
        });
        continue;
      }
      if (Array.isArray(node.children) && node.children.length) {
        flattenProjekteNeuFiles(node.children, nextRel, out);
      }
    }
  }

  function ingestProjekteNeuParameterTree(localJobId, fab, tree) {
    const fabNorm = normalizeParameterFab(fab);
    if (!fabNorm) return { scanned: 0, ingested: 0 };
    const flat = [];
    flattenProjekteNeuFiles(tree, '', flat);
    const presentPaths = [];
    let ingested = 0;
    for (const item of flat) {
      if (!isSupportedParameterFileName(item.name)) continue;
      const rel = String(item.rel || '').trim().replace(/\\/g, '/');
      if (!rel) continue;
      presentPaths.push(rel);
      let filePath = null;
      try {
        filePath = resolveProjekteNeuLocalFilePath(localJobId, fabNorm, rel);
      } catch (_) {
        filePath = null;
      }
      if (!filePath || !fs.existsSync(filePath)) continue;
      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch (_) {
        continue;
      }
      const parsed = ingestParameterFileIntoAnlagenstamm({
        fileName: item.name,
        source: 'projekte_neu',
        sourcePath: rel,
        storageRelPath: filePath,
        buffer: buf,
        mime: 'application/octet-stream',
        technicianId: null,
        technicianName: null,
      });
      if (parsed && parsed.ok) ingested += 1;
    }
    markMissingProjekteNeuFiles(db, fabNorm, presentPaths);
    save();
    return { scanned: flat.length, ingested, tracked: presentPaths.length };
  }

  /** Gleiche logische Abwesenheit trotz unterschiedlicher ID (Anfrage vs. Absence) oder T/Space in Datumswerten erkennen. */
  const absencePeriodDedupeKey = (technicianId, start, end) => {
    function normDt(v) {
      if (v == null) return '';
      let s = String(v).replace('T', ' ').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
      return s;
    }
    return String(technicianId || '') + '\t' + normDt(start) + '\t' + normDt(end);
  };

  const dbLock = createDbLock();
  const persistDbToDisk = db.save.bind(db);
  const save = dbLock.wrapSave(persistDbToDisk);
  db.save = save;

  /** @type {ReturnType<typeof createBackgroundJobService> | null} */
  let bgJobs = null;

  function enqueueDienstreisePushChanged(localJobId, technicianId, dispoBaseUrl, username, password, extra) {
    const jobsSvc = bgJobs;
    const lid = parseInt(localJobId, 10);
    const tid = parseInt(technicianId, 10);
    if (!jobsSvc || !Number.isFinite(lid) || lid <= 0 || !Number.isFinite(tid) || tid <= 0) return;
    const base = String(dispoBaseUrl || '').trim().replace(/\/$/, '');
    const payload = Object.assign(
      {
        job_id: lid,
        technicianId: tid,
        technician_id: tid,
        dispo_base_url: base,
        dispoBaseUrl: base,
        dispo_username: username || '',
        dispo_password: password != null ? String(password) : '',
        onlyChanged: true,
      },
      extra && typeof extra === 'object' ? extra : {},
    );
    jobsSvc.enqueue('dienstreise_push', payload, 'dienstreise_push:' + lid);
    if (typeof jobsSvc.kick === 'function') jobsSvc.kick();
  }

  function queueProtocolDraftAndFiles(opts) {
    const o = opts || {};
    const localJobId = parseInt(o.localJobId, 10);
    const technicianId = parseInt(o.technicianId, 10);
    const basename = o.basename;
    const serverJobId = parseInt(o.serverJobId, 10);
    if (
      multiDeviceApi &&
      typeof multiDeviceApi.queueDraftPushPending === 'function' &&
      Number.isFinite(localJobId) &&
      localJobId > 0 &&
      basename &&
      Number.isFinite(serverJobId) &&
      serverJobId > 0
    ) {
      const endpoint = o.endpoint || DRAFT_JSON_ENDPOINTS[basename];
      if (endpoint) {
        multiDeviceApi.queueDraftPushPending({
          dispoBaseUrl: o.dispoBaseUrl,
          endpoint,
          technicianId,
          serverJobId,
          localJobId,
          reiseDir: o.reiseDir,
          filePath:
            o.filePath ||
            (o.reiseDir ? resolveMonteurDraftJsonPath(o.reiseDir, basename, false) : ''),
          basename,
          username: o.username,
          password: o.password,
        });
      }
    }
    enqueueDienstreisePushChanged(localJobId, technicianId, o.dispoBaseUrl, o.username, o.password, o.pushExtra);
  }

  let appVersion = 'V 1.001';
  try {
    const v = require('./version.json');
    if (v && v.version) appVersion = v.version;
  } catch (e) { /* use default */ }

  const DIENSTREISE_CONFIG_PATH = path.join(DB_DIR, 'dienstreise_config.json');

  function getDienstreiseBasePath() {
    try {
      if (fs.existsSync(DIENSTREISE_CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(DIENSTREISE_CONFIG_PATH, 'utf8'));
        const p = (data && data.basePath && typeof data.basePath === 'string') ? data.basePath.trim() : '';
        hangDiag.setDiskRoot(p);
        return p;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function setDienstreiseBasePath(basePath) {
    try {
      if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
      fs.writeFileSync(DIENSTREISE_CONFIG_PATH, JSON.stringify({ basePath: (basePath && typeof basePath === 'string') ? basePath.trim() : '' }, null, 2));
    } catch (e) {
      console.error('dienstreise config write failed:', e.message);
    }
  }

  app.get('/api/version', (req, res) => {
    res.json({
      version: appVersion,
      capabilities: {
        anlagenstamm_search: true,
        anlagenstamm_save: true,
        anlagenstamm_local_sync: true,
        projekte_neu_local: true,
      },
    });
  });

  app.get('/api/dienstreise/config', (req, res) => {
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
  });

  app.post('/api/dienstreise/config', express.json(), (req, res) => {
    const basePath = (req.body && req.body.basePath != null) ? String(req.body.basePath) : '';
    setDienstreiseBasePath(basePath);
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
  });

  app.get('/api/settings_dispo_tls', (req, res) => {
    res.json({
      ok: true,
      allowInsecureTls: isDispoInsecureTlsAllowed(),
      fixed: true,
      hint: 'Selbstsigniertes Dispo-HTTPS ist fest aktiviert (Kukla-Standard).',
    });
  });

  app.post('/api/settings_dispo_tls', express.json(), (req, res) => {
    try {
      applyDispoInsecureTlsPreference();
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
    res.json({
      ok: true,
      allowInsecureTls: true,
      fixed: true,
    });
  });

  /** Profil-Unterschrift: lokal + Dispo-Sync */
  app.get('/api/technician/signature', async (req, res) => {
    try {
      technicianSignature.ensureSchema(db);
      const technicianId = getTechnicianId(req);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const body = {
        baseUrl: (req.query.base_url || req.query.dispoBaseUrl || '').toString(),
        serverUsername: (req.query.username || '').toString(),
        serverPassword: req.query.password != null ? String(req.query.password) : '',
      };
      const creds = resolveDispoServerCreds(body);
      const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
      const dispoBase =
        String(creds.baseUrl || creds.externalUrl || '').replace(/\/$/, '') ||
        String(req.query.base_url || '').replace(/\/$/, '');
      if (dispoBase && auth) {
        try {
          await technicianSignature.syncWithDispo(db, technicianId, dispoBase, auth);
          save();
        } catch (_) {
          /* offline: Cache */
        }
      }
      const local = technicianSignature.getLocal(db, technicianId);
      if (!local) {
        return res.json({ ok: true, has_signature: false, technician_id: technicianId });
      }
      res.json({
        ok: true,
        has_signature: true,
        technician_id: technicianId,
        png_base64: local.png_base64,
        source: local.source || 'draw',
        updated_at: local.updated_at || '',
        dirty: !!local.dirty,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Signatur konnte nicht geladen werden.' });
    }
  });

  app.post('/api/technician/signature', express.json({ limit: '3mb' }), async (req, res) => {
    try {
      technicianSignature.ensureSchema(db);
      const technicianId = getTechnicianId(req);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const body = req.body || {};
      const png = technicianSignature.normalizePngBase64(body.png_base64);
      if (!png) {
        return res.status(400).json({ ok: false, error: 'Ungültige Unterschrift (PNG/JPEG Base64).' });
      }
      const source = body.source === 'upload' ? 'upload' : 'draw';
      const creds = resolveDispoServerCreds(body);
      const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
      const dispoBase = String(creds.baseUrl || body.dispoBaseUrl || body.base_url || '')
        .trim()
        .replace(/\/$/, '');
      let updatedAt = '';
      let dirty = true;
      if (dispoBase && auth) {
        try {
          const pushed = await technicianSignature.pushDispoSignature(dispoBase, auth, png, source);
          if (pushed && pushed.ok) {
            updatedAt = pushed.updated_at || '';
            dirty = false;
          }
        } catch (_) {
          dirty = true;
        }
      }
      const local = technicianSignature.setLocal(db, technicianId, png, source, updatedAt, dirty);
      save();
      res.json({
        ok: true,
        has_signature: true,
        technician_id: technicianId,
        source: local.source,
        updated_at: local.updated_at,
        dirty: !!local.dirty,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Signatur konnte nicht gespeichert werden.' });
    }
  });

  app.delete('/api/technician/signature', express.json({ limit: '100kb' }), async (req, res) => {
    try {
      technicianSignature.ensureSchema(db);
      const technicianId = getTechnicianId(req);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const creds = resolveDispoServerCreds(req.body || req.query || {});
      const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
      const dispoBase = String(creds.baseUrl || req.query.base_url || '')
        .trim()
        .replace(/\/$/, '');
      if (dispoBase && auth) {
        try {
          await technicianSignature.deleteDispoSignature(dispoBase, auth);
        } catch (_) {
          /* lokal trotzdem löschen */
        }
      }
      technicianSignature.deleteLocal(db, technicianId);
      save();
      res.json({ ok: true, has_signature: false, technician_id: technicianId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Signatur konnte nicht gelöscht werden.' });
    }
  });

  const DIENSTREISE_SUBFOLDERS = ['Dokumente_Dispo', 'Dokumente_Monteur', 'Dokumente_Anlage', 'Dokumente_Buchhaltung'];
  const DIENSTREISE_SYNC_FOLDERS = ['Dokumente_Dispo', 'Dokumente_Monteur', 'Dokumente_Anlage', 'Dokumente_Buchhaltung'];
  const FINISH_SYNC_FOLDERS = ['Dokumente_Monteur'];

  /** Relativer Pfad unter Reiseordner; erstes Segment muss Standard-Unterordner sein. */
  function parseDienstreiseRelativeSubpath(relRaw) {
    const rel = String(relRaw || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!rel || rel.includes('..')) return { error: 'Ungültiger Pfad.' };
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) return { error: 'Pfad erforderlich.' };
    if (!DIENSTREISE_SUBFOLDERS.includes(parts[0])) {
      return {
        error:
          'Pfad muss mit Dokumente_Dispo, Dokumente_Monteur, Dokumente_Anlage oder Dokumente_Buchhaltung beginnen.',
      };
    }
    return { parts };
  }

  function assertPathUnderReiseDir(reiseDir, absPath) {
    let realReise;
    let realPath;
    try {
      realReise = fs.realpathSync(reiseDir);
      const parent = path.dirname(absPath);
      if (!fs.existsSync(parent)) return { error: 'Zielordner existiert nicht.' };
      realPath = fs.realpathSync(parent);
    } catch (_) {
      return { error: 'Pfad konnte nicht aufgelöst werden.' };
    }
    if (realPath !== realReise && !realPath.startsWith(realReise + path.sep)) {
      return { error: 'Pfad außerhalb des Projektordners.' };
    }
    return { ok: true };
  }

  function getNextRunningNumber(basePath, year) {
    const yearDir = path.join(basePath, String(year));
    if (!fs.existsSync(yearDir)) return 1;
    let maxNum = 0;
    try {
      const entries = fs.readdirSync(yearDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(/^(\d+)_/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
    } catch (e) { /* ignore */ }
    return maxNum + 1;
  }

  /**
   * rawJobId = lokale jobs.id oder Dispo server_id.
   * Bei Kollision (z. B. Etex server_id 47 vs. Gebtron jobs.id 47): Dispo server_id gewinnt.
   */
  function resolveJobRowByAmbiguousRef(rawJobId, selectSql) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const byLocal = db.prepare(`SELECT ${selectSql} FROM jobs j WHERE j.id = ? LIMIT 1`).get(n);
    const byServer = db
      .prepare(`SELECT ${selectSql} FROM jobs j WHERE CAST(j.server_id AS TEXT) = CAST(? AS TEXT) LIMIT 1`)
      .get(n);
    if (byLocal && byServer && byLocal.id !== byServer.id) {
      console.warn('[resolveJobRowByAmbiguousRef] ID-Konflikt ref=' + n + ' — bevorzuge server_id-Zeile', {
        local_match_id: byLocal.id,
        server_match_id: byServer.id,
      });
      return byServer;
    }
    return byLocal || byServer || null;
  }

  function getJobRowByLocalOrServerId(rawJobId) {
    return resolveJobRowByAmbiguousRef(rawJobId, 'j.id, j.server_id');
  }

  function getJobRowWithStatusByLocalOrServerId(rawJobId) {
    return resolveJobRowByAmbiguousRef(rawJobId, 'j.id, j.server_id, j.status');
  }

  /** Nach Admin-Rücksetzung in Dispo: lokales erledigt + pending erledigt mit Server-Status abgleichen. */
  async function reconcileLocalJobStatusFromDispoBeforeAccept(rawJobId, dispoBaseUrl, technicianId, authHeader) {
    let row = getJobRowWithStatusByLocalOrServerId(rawJobId);
    if (!row) return null;
    const st = String(row.status || '').trim().toLowerCase();
    if (st !== 'erledigt' && st !== 'abgerechnet') return row;
    const serverId = row.server_id != null && String(row.server_id).trim() !== '' ? row.server_id : null;
    if (!serverId || !dispoBaseUrl) return row;
    const base = String(dispoBaseUrl).replace(/\/$/, '');
    const url = `${base}/dispo_api/api/job.php?id=${encodeURIComponent(serverId)}&technician_id=${encodeURIComponent(technicianId)}`;
    try {
      const r = await fetch(url, authHeader && authHeader.Authorization ? { headers: authHeader } : {});
      if (!r.ok) return row;
      const data = await r.json();
      const remote = data && data.job ? data.job : null;
      if (!remote || remote.status == null) return row;
      const remoteSt = String(remote.status).trim().toLowerCase();
      if (remoteSt === 'erledigt' || remoteSt === 'abgerechnet') return row;
      db.prepare(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(remoteSt, row.id);
      clearSupersededPendingJobStatusOnPull(db, row.id, remoteSt);
      save();
      return getJobRowWithStatusByLocalOrServerId(row.id);
    } catch (e) {
      console.warn('[accept_job] reconcile status from dispo:', e && e.message ? e.message : e);
      return row;
    }
  }

  /** Auftrag annehmen: nur aus angelegt/geplant/zugeteilt. */
  function jobStatusAllowsAcceptJob(status) {
    const s = String(status || '').trim().toLowerCase();
    return s === 'angelegt' || s === 'geplant' || s === 'zugeteilt';
  }

  function applyJobStatusInArbeitAfterAccept(localJobId, technicianId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(lid);
    if (!jobStatusAllowsAcceptJob(statusRow && statusRow.status)) return;
    const r = db.prepare(`
      UPDATE jobs SET status = 'in_arbeit', updated_at = datetime('now')
      WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
    `).run(lid, technicianId);
    if (r.changes) {
      db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
        'job', lid, 'status', JSON.stringify({ status: 'in_arbeit' })
      );
      save();
    }
  }

  /**
   * Auftrag offline annehmen: Ordnerstruktur + Status in_arbeit, ohne Dispo-Pull.
   * Projektdateien können später per dienstreise_pull nachgezogen werden.
   */
  async function performAcceptJobOffline(body) {
    const rawJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
    const technicianId = parseInt(
      body.technicianId != null ? body.technicianId : body.technician_id != null ? body.technician_id : 0,
      10,
    );
    if (!rawJobId || !technicianId) {
      throw Object.assign(new Error('job_id (lokal) und technician_id erforderlich.'), { httpStatus: 400 });
    }
    const mapped = getJobRowByLocalOrServerId(rawJobId);
    if (!mapped) {
      throw Object.assign(new Error('Auftrag nicht gefunden.'), { httpStatus: 404 });
    }
    const localJobId = mapped.id;
    const assignGate = requireJobAssignedToTechnician(db, localJobId, technicianId);
    if (assignGate) {
      throw Object.assign(new Error(assignGate.error), { httpStatus: assignGate.status || 403 });
    }
    const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(localJobId);
    if (!jobStatusAllowsAcceptJob(statusRow && statusRow.status)) {
      throw Object.assign(
        new Error('Auftrag kann nur im Status Angelegt, Geplant oder Zugeteilt angenommen werden.'),
        { httpStatus: 409 },
      );
    }
    const targetDir = getOrCreateDienstreiseFolderForJob(localJobId, {
      skipAssignmentCheck: true,
      technicianId,
    });
    if (!targetDir || !fs.existsSync(targetDir)) {
      throw Object.assign(new Error('Zielordner konnte nicht erstellt werden.'), { httpStatus: 400 });
    }
    const jobDetail = lookupDienstreiseJobRow(localJobId);
    let fabMap = Array.isArray(body.fab_map) ? body.fab_map : [];
    if (!fabMap.length && jobDetail) {
      for (const fn of fabNumbersFromJobFabrikationsnummern(jobDetail.fabrikationsnummern)) {
        fabMap.push({
          fab: String(fn),
          folder_name_canonical: buildCanonicalFabFolderName(fn, jobDetail),
        });
      }
    }
    const offlinePaths = Object.prototype.hasOwnProperty.call(body, 'offline_paths')
      ? body.offline_paths
      : {};
    // Zuerst Align (Sticky = alter Name), danach Selection mit Desired speichern.
    const layout = await ensureJobReiseFolderLayout(localJobId, targetDir, technicianId);
    const montageName = layout.montageFolderName
      || buildMonteurMontageFolderName(jobDetail || {}, getTechnicianDisplayName(technicianId));
    saveOfflinePullSelection(
      db,
      localJobId,
      'explicit',
      offlinePaths,
      layout.fabMap && layout.fabMap.length ? layout.fabMap : fabMap,
      montageName,
    );
    save();
    applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
    return {
      ok: true,
      offline: true,
      synced: false,
      local_job_id: localJobId,
      reise_dir: targetDir,
      fab_map: layout.fabMap || fabMap,
      montage_folder_name: montageName,
      hint: 'Lokal angenommen. Projektdateien und Dispo-Status werden bei Verbindung synchronisiert.',
    };
  }

  function queueJobStatusPending(localJobId, status) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    const st = String(status || '').trim().toLowerCase();
    if (!st) return;
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`,
    ).run(lid);
    db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
      'job',
      lid,
      'status',
      JSON.stringify({ status: st }),
    );
    save();
  }

  function enqueueDeferredDienstreisePush(localJobId, pushBody) {
    if (!bgJobs) return null;
    const lid = parseInt(localJobId, 10);
    const body = pushBody || {};
    const dedupeKey = 'dienstreise_push:' + lid + ':defer';
    const { job_id } = bgJobs.enqueue(
      'dienstreise_push',
      {
        job_id: lid,
        dispo_base_url: normalizeBaseUrl(body.dispoBaseUrl || body.dispo_base_url || ''),
        dispo_username: String(body.dispoUsername || body.dispo_username || ''),
        dispo_password:
          body.dispoPassword != null
            ? String(body.dispoPassword)
            : body.dispo_password != null
              ? String(body.dispo_password)
              : '',
        technician_id: parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10) || 0,
        onlyChanged: true,
        externalUrl: body.externalUrl || body.dispoExternalUrl || '',
        internalUrl: body.internalUrl || body.dispoInternalUrl || '',
      },
      dedupeKey,
    );
    bgJobs.kick();
    return job_id;
  }

  /** Freigeben: nur aus in_arbeit — lokale Daten löschen, Status zugeteilt (Dispo + lokal, ohne Datei-Sync). */
  function jobStatusAllowsReleaseJob(status) {
    return String(status || '').trim().toLowerCase() === 'in_arbeit';
  }

  function clearDienstreiseJobLocalReleaseArtifacts(dbConn, localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    dbConn.prepare('DELETE FROM job_offline_pull_paths WHERE local_job_id = ?').run(lid);
    dbConn.prepare('DELETE FROM job_offline_pull_config WHERE local_job_id = ?').run(lid);
    dbConn.prepare('DELETE FROM job_ted_index WHERE local_job_id = ?').run(lid);
    dbConn.prepare('DELETE FROM dienstreise_push_cache WHERE local_job_id = ?').run(lid);
    dbConn.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`,
    ).run(lid);
  }

  function applyJobStatusZugeteiltAfterRelease(localJobId, technicianId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return false;
    const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(lid);
    if (!jobStatusAllowsReleaseJob(statusRow && statusRow.status)) return false;
    const r = db.prepare(`
      UPDATE jobs SET status = 'zugeteilt', updated_at = datetime('now')
      WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
    `).run(lid, technicianId);
    return r.changes > 0;
  }

  function performReleaseDienstreiseJob(localJobId, technicianId) {
    const lid = parseInt(localJobId, 10);
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(lid);
    if (!row || !jobStatusAllowsReleaseJob(row.status)) {
      throw Object.assign(new Error('Freigeben ist nur bei Status „In Arbeit“ möglich.'), { httpStatus: 409 });
    }
    if (bgJobs && typeof bgJobs.cancelRunningDienstreiseForLocalJob === 'function') {
      bgJobs.cancelRunningDienstreiseForLocalJob(lid);
    }
    const reiseDir = resolveDienstreiseReiseDirForJob(lid, { createIfMissing: false });
    if (reiseDir && fs.existsSync(reiseDir)) {
      cleanupDienstreiseReiseDir(reiseDir, [], { fastNoUpload: true });
    }
    clearDienstreiseJobLocalReleaseArtifacts(db, lid);
    const ok = applyJobStatusZugeteiltAfterRelease(lid, technicianId);
    if (!ok) {
      throw Object.assign(new Error('Status konnte nicht zurückgesetzt werden.'), { httpStatus: 409 });
    }
    save();
  }

  async function performReleaseDienstreiseJobWithDispo(localJobId, technicianId, dispoOpts) {
    const lid = parseInt(localJobId, 10);
    const row = db.prepare('SELECT status, server_id FROM jobs WHERE id = ?').get(lid);
    if (!row || !jobStatusAllowsReleaseJob(row.status)) {
      throw Object.assign(new Error('Freigeben ist nur bei Status „In Arbeit“ möglich.'), { httpStatus: 409 });
    }

    const dispoUsername = String((dispoOpts && dispoOpts.dispoUsername) || '').trim();
    const dispoPassword =
      dispoOpts && dispoOpts.dispoPassword != null ? String(dispoOpts.dispoPassword) : '';
    if (!dispoUsername) {
      throw Object.assign(
        new Error(
          'Dispo-Zugangsdaten fehlen: Benutzername und Passwort in den Einstellungen eintragen (erforderlich für Freigeben).',
        ),
        { httpStatus: 400 },
      );
    }
    const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword);
    const resolvedBase = await resolveDispoWorkingBase({
      baseUrl: (dispoOpts && dispoOpts.dispoBaseUrl) || '',
      externalUrl: dispoOpts && dispoOpts.externalUrl,
      internalUrl: dispoOpts && dispoOpts.internalUrl,
      technicianId,
      serverUsername: dispoUsername,
      serverPassword: dispoPassword,
    });
    const dispoBaseUrl = resolvedBase.base;
    if (!dispoBaseUrl) {
      throw Object.assign(
        new Error(resolvedBase.error || 'Keine erreichbare Dispo-URL für Freigeben.'),
        { httpStatus: 502 },
      );
    }

    // Multi-Device: vor Status-Reset Dateien/Drafts pushen (kein silent fastNoUpload).
    try {
      await syncDienstreiseFoldersToDispo(
        lid,
        dispoBaseUrl,
        technicianId,
        dispoUsername,
        dispoPassword,
        { externalUrl: dispoOpts && dispoOpts.externalUrl, internalUrl: dispoOpts && dispoOpts.internalUrl },
      );
    } catch (pushErr) {
      throw Object.assign(
        new Error(
          (pushErr && pushErr.message) ||
            'Datei-Sync vor Freigeben fehlgeschlagen. Freigabe abgebrochen.',
        ),
        { httpStatus: 502 },
      );
    }

    // Presence-Heartbeat für Peer-Warnungen auf anderen Geräten.
    if (multiDeviceApi && multiDeviceApi.heartbeatOnDispo) {
      try {
        await multiDeviceApi.heartbeatOnDispo({
          dispoBaseUrl,
          technicianId,
          username: dispoUsername,
          password: dispoPassword,
          serverJobId: row.server_id,
        });
      } catch (_) {}
    }

    const srvId = row.server_id != null ? row.server_id : lid;
    const pushRes = await pushJobStatusToDispo(dispoBaseUrl, technicianId, srvId, authHeader, 'zugeteilt');
    if (!pushRes.ok) {
      throw Object.assign(
        new Error(pushRes.error || 'Status konnte nicht in der Dispo zurückgesetzt werden.'),
        { httpStatus: 502 },
      );
    }

    performReleaseDienstreiseJob(lid, technicianId);
  }

  async function pushJobStatusToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, status) {
    if (!dispoBaseUrl || !serverJobId) return { ok: false, error: 'Keine Dispo-Verknüpfung.' };
    const st = String(status || '').trim().toLowerCase();
    if (!st) return { ok: false, error: 'Status fehlt.' };
    const base = dispoBaseUrl.replace(/\/$/, '');
    const headerForJob = {
      'Content-Type': 'application/json',
      'X-Technician-Id': String(technicianId),
      ...(authHeader || {}),
    };
    const r = await fetch(`${base}/dispo_api/api/job.php?technician_id=${technicianId}`, {
      method: 'PATCH',
      headers: headerForJob,
      body: JSON.stringify({ job_id: serverJobId, status: st }),
    });
    if (!r.ok) {
      let errMsg = 'Dispo: ' + r.status;
      try {
        const errData = await r.json();
        if (errData && typeof errData.error === 'string') errMsg = errData.error;
      } catch (_) { /* ignore */ }
      return { ok: false, error: errMsg };
    }
    return { ok: true };
  }

  /**
   * Erledigt an Dispo wie Handy-PWA. Dispo erlaubt erledigt nur von zugeteilt/in_arbeit —
   * bei angelegt/geplant zuerst in_arbeit, dann erledigt.
   */
  async function pushJobStatusErledigtToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader) {
    const first = await pushJobStatusToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, 'erledigt');
    if (first.ok) return first;
    const mid = await pushJobStatusToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, 'in_arbeit');
    if (!mid.ok) return first;
    return pushJobStatusToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, 'erledigt');
  }

  async function pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader) {
    return pushJobStatusToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, 'in_arbeit');
  }

  function clearPendingJobStatus(dbConn, localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    try {
      dbConn
        .prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`)
        .run(lid);
      const mapped = dbConn.prepare('SELECT server_id FROM jobs WHERE id = ?').get(lid);
      if (mapped && mapped.server_id != null && String(mapped.server_id).trim() !== '') {
        dbConn
          .prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`)
          .run(mapped.server_id);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function freezeProtocolDraftsIfClosed(localJobId, status) {
    const st = String(status || '').trim().toLowerCase();
    if (st !== 'erledigt' && st !== 'abgerechnet') return;
    try {
      protocolDrafts.freezeJob(db, localJobId);
    } catch (_) {
      /* Schema optional */
    }
  }

  function getServerJobId(localJobIdOrServerId) {
    const row = getJobRowByLocalOrServerId(localJobIdOrServerId);
    if (!row) throw new Error('Auftrag nicht gefunden.');
    return row.server_id != null ? row.server_id : row.id;
  }

  function formatDispoSyncNetworkError(rawMsg, triedBases) {
    let msg = rawMsg != null ? String(rawMsg) : 'Netzwerkfehler';
    if (Array.isArray(triedBases) && triedBases.length) {
      msg += ' Versucht: ' + triedBases.join(' | ');
    }
    return msg;
  }

  function normProjectRelPath(relPath) {
    return String(relPath || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
  }

  function remoteProjectPathSetHas(remoteSet, relPath) {
    const n = normProjectRelPath(relPath);
    if (!n) return false;
    if (remoteSet.has(n)) return true;
    const lower = n.toLowerCase();
    for (const r of remoteSet) {
      if (normProjectRelPath(r).toLowerCase() === lower) return true;
    }
    return false;
  }

  function readLocalFileStatForPush(fullPath) {
    try {
      const st = fs.statSync(fullPath);
      const mtimeMs = st.mtimeMs != null ? st.mtimeMs : st.mtime ? st.mtime.getTime() : 0;
      return { mtimeMs: Number(mtimeMs) || 0, size: Number(st.size) || 0 };
    } catch (_) {
      return { mtimeMs: 0, size: 0 };
    }
  }

  function recordDienstreisePushCache(dbConn, localJobId, relPath, fullPath) {
    ensureDienstreisePushCacheSchema(dbConn);
    const rel = normProjectRelPath(relPath);
    if (!rel || !localJobId) return;
    const st = readLocalFileStatForPush(fullPath);
    const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    dbConn
      .prepare(
        `INSERT INTO dienstreise_push_cache (local_job_id, rel_path, local_mtime_ms, local_size, synced_mtime_ms, synced_size, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_job_id, rel_path) DO UPDATE SET
           local_mtime_ms = excluded.local_mtime_ms,
           local_size = excluded.local_size,
           synced_mtime_ms = excluded.synced_mtime_ms,
           synced_size = excluded.synced_size,
           synced_at = excluded.synced_at`,
      )
      .run(localJobId, rel, st.mtimeMs, st.size, st.mtimeMs, st.size, syncedAt);
  }

  function invalidateDienstreisePushCache(dbConn, localJobId, relPath) {
    ensureDienstreisePushCacheSchema(dbConn);
    const rel = normProjectRelPath(relPath);
    if (!rel || !localJobId) return;
    dbConn.prepare('DELETE FROM dienstreise_push_cache WHERE local_job_id = ? AND rel_path = ?').run(localJobId, rel);
  }

  function localDienstreiseFileNeedsDispoPush(dbConn, localJobId, relPath, fullPath) {
    ensureDienstreisePushCacheSchema(dbConn);
    const rel = normProjectRelPath(relPath);
    if (!rel || !fs.existsSync(fullPath)) return false;
    const st = readLocalFileStatForPush(fullPath);
    const row = dbConn
      .prepare(
        'SELECT synced_mtime_ms, synced_size FROM dienstreise_push_cache WHERE local_job_id = ? AND rel_path = ?',
      )
      .get(localJobId, rel);
    if (!row) return true;
    const syncedMtime = Number(row.synced_mtime_ms) || 0;
    const syncedSize = Number(row.synced_size) || 0;
    if (syncedMtime !== st.mtimeMs || syncedSize !== st.size) return true;
    return false;
  }

  function yieldEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function collectLocalSyncFolderFileEntries(reiseDir, subfolder) {
    const result = [];
    const startDir = path.join(reiseDir, subfolder);
    if (!fs.existsSync(startDir)) return result;
    let seen = 0;
    async function walk(currentDir, relBase) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const e of entries) {
        if (isIgnorableDirEntry(e.name)) continue;
        const full = path.join(currentDir, e.name);
        const rel = relBase ? relBase + '/' + e.name : e.name;
        if (e.isDirectory()) {
          await walk(full, rel);
        } else if (e.isFile()) {
          // Protokoll-Drafts nur über *_draft.php, nicht als generischer Datei-Sync.
          if (isMonteurDraftJsonBasename(e.name)) continue;
          result.push({
            relPathFromRoot: subfolder + (rel ? '/' + rel : ''),
            fullPath: full,
          });
          seen += 1;
          if (seen % 20 === 0) await yieldEventLoop();
        }
      }
    }
    await walk(startDir, '');
    return result;
  }

  /** Nur geänderte Dateien in Sync-Ordnern (gegen letzten erfolgreichen Push/Pull-Stand). */
  async function collectChangedDienstreiseSyncFileEntries(dbConn, reiseDir, localJobId, foldersOpt, relPathPredicate) {
    const folderList = Array.isArray(foldersOpt) && foldersOpt.length ? foldersOpt : DIENSTREISE_SYNC_FOLDERS;
    const pred = typeof relPathPredicate === 'function' ? relPathPredicate : null;
    const out = [];
    let checked = 0;
    for (const folder of folderList) {
      const files = await collectLocalSyncFolderFileEntries(reiseDir, folder);
      for (const f of files) {
        if (pred && !pred(f.relPathFromRoot)) continue;
        if (localDienstreiseFileNeedsDispoPush(dbConn, localJobId, f.relPathFromRoot, f.fullPath)) {
          out.push(f);
        }
        checked += 1;
        if (checked % 20 === 0) await yieldEventLoop();
      }
    }
    return out;
  }

  function resolveMonteurAuftragsordnerName(localJobId, technicianId) {
    const jobRow = lookupDienstreiseJobRow(localJobId);
    if (!jobRow) return '';
    return buildMonteurMontageFolderName(jobRow, getTechnicianDisplayName(technicianId) || 'Monteur');
  }

  /** Sticky nur für Align (previousName); Schreibziel ist immer Desired live. */
  function getStickyMontageFolderName(localJobId) {
    const offlineCfg = getOfflinePullConfig(db, localJobId);
    return offlineCfg && offlineCfg.montage_folder_name
      ? String(offlineCfg.montage_folder_name).trim()
      : '';
  }

  function rewriteDienstreisePushCacheMontageFolder(localJobId, oldName, desiredName) {
    const oldN = String(oldName || '').trim();
    const newN = String(desiredName || '').trim();
    if (!oldN || !newN || oldN === newN) return;
    try {
      const rows = db
        .prepare('SELECT rel_path FROM dienstreise_push_cache WHERE local_job_id = ?')
        .all(localJobId);
      const upd = db.prepare(
        'UPDATE dienstreise_push_cache SET rel_path = ? WHERE local_job_id = ? AND rel_path = ?',
      );
      const needle = '/Montage/' + oldN;
      const repl = '/Montage/' + newN;
      const re = new RegExp('/Montage/' + oldN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/|$)');
      for (const row of rows) {
        const rel = String(row.rel_path || '').replace(/\\/g, '/');
        if (!re.test(rel)) continue;
        const next = rel.split(needle).join(repl);
        if (next !== rel) {
          try {
            upd.run(next, localJobId, rel);
          } catch (_) {
            /* unique conflict */
          }
        }
      }
    } catch (_) {
      /* optional */
    }
  }

  function uploadJobProjectFileToDispo(base, serverJobId, technicianId, authHeader, relPathFromRoot, fullPath) {
    const url = base.replace(/\/$/, '') + '/api/job_project_file_upload.php';
    const fileBuf = fs.readFileSync(fullPath);
    const httpsUploadAgent = isDispoInsecureTlsAllowed() ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('technician_id', String(technicianId));
      form.append('job_id', String(serverJobId));
      const relNorm = normProjectRelPath(relPathFromRoot);
      const lastSlash = relNorm.lastIndexOf('/');
      const folderPart = lastSlash > 0 ? relNorm.slice(0, lastSlash) : '';
      if (folderPart) form.append('path', folderPart);
      form.append('file', fileBuf, path.basename(fullPath));

      const parsed = new URL(url);
      const headers = form.getHeaders({
        ...dispoMonteurFetchHeaders(technicianId, authHeader),
      });
      const options = {
        method: 'POST',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        headers,
      };
      if (httpsUploadAgent && parsed.protocol === 'https:') {
        options.agent = httpsUploadAgent;
      }

      form.submit(options, (err, res) => {
        if (err) return reject(err);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = body ? JSON.parse(body) : {};
              if (data && data.ok === false) {
                reject(new Error(data.error || 'Upload zu Dispo fehlgeschlagen.'));
              } else {
                resolve();
              }
            } catch (e) {
              resolve();
            }
          } else {
            reject(new Error('Upload zu Dispo fehlgeschlagen (' + res.statusCode + '): ' + body));
          }
        });
      });
    });
  }

  /** Alte Montagebericht-Word-Exporte (vor PDF-only). */
  function isLegacyMontageberichtDocxName(name) {
    const n = String(name || '');
    if (!/\.docx$/i.test(n)) return false;
    return /_(?:Montage|report)_(?:DE|EN|GB)\.docx$/i.test(n);
  }

  /** Entfernt Legacy-DOCX lokal im Protokolle-Ordner. Liefert gelöschte Dateinamen. */
  function cleanupLegacyMontageberichtDocxLocal(protokolleDir) {
    const removed = [];
    if (!protokolleDir || !fs.existsSync(protokolleDir)) return removed;
    let entries = [];
    try {
      entries = fs.readdirSync(protokolleDir);
    } catch (_) {
      return removed;
    }
    for (const name of entries) {
      if (!isLegacyMontageberichtDocxName(name)) continue;
      const abs = path.join(protokolleDir, name);
      try {
        if (!fs.statSync(abs).isFile()) continue;
        fs.unlinkSync(abs);
        removed.push(name);
      } catch (e) {
        console.warn(
          '[montagebericht] local docx cleanup:',
          name,
          e && e.message ? e.message : e,
        );
      }
    }
    return removed;
  }

  async function deleteJobProjectFileOnDispo(base, serverJobId, technicianId, authHeader, relPath) {
    const rel = normProjectRelPath(relPath);
    if (!rel) return;
    const formBody = new URLSearchParams();
    formBody.append('technician_id', String(technicianId));
    formBody.append('job_id', String(serverJobId));
    formBody.append('path', rel);
    const r = await fetch(String(base || '').replace(/\/$/, '') + '/api/job_project_file_delete.php', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        dispoMonteurFetchHeaders(technicianId, authHeader),
      ),
      body: formBody.toString(),
    });
    if (r.ok) return;
    const errText = await r.text().catch(() => '');
    let errMsg = errText || r.statusText || String(r.status);
    try {
      const data = errText ? JSON.parse(errText) : {};
      if (data && data.error) errMsg = String(data.error);
    } catch (_) {
      /* raw */
    }
    const err = new Error(errMsg);
    err.status = r.status;
    throw err;
  }

  /**
   * Remote-Dateiliste nur für relevante Unterordner (kein Rekursions-Walk durch ELEKTRO/Anlagen-Mount).
   * Verhindert hunderte API-Aufrufe und „fetch failed“ beim Abschluss-Sync.
   */
  async function listRemoteProjectFilesOnDispo(base, serverJobId, technicianId, authHeader, folderName, localRelPaths) {
    const seen = new Set();
    const urlBase = base + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + serverJobId;
    const dirsToList = new Set([folderName]);
    const folderPrefix = folderName + '/';
    for (const relPathFromRoot of localRelPaths || []) {
      const rel = String(relPathFromRoot || '').replace(/\\/g, '/');
      if (rel !== folderName && !rel.startsWith(folderPrefix)) continue;
      const tail = rel === folderName ? '' : rel.slice(folderPrefix.length);
      if (!tail) continue;
      const parts = tail.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        dirsToList.add(folderName + '/' + parts.slice(0, i).join('/'));
      }
    }
    async function fetchList(pathPart) {
      const url = urlBase + (pathPart ? '&path=' + encodeURIComponent(pathPart) : '');
      const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
      let r;
      try {
        r = await fetch(url, opts);
      } catch (err) {
        const cause = err && err.cause ? err.cause : err;
        const code = cause && cause.code ? String(cause.code) : '';
        throw new Error(
          'Dispo-Dateiliste nicht erreichbar' +
            (code ? ' (' + code + ')' : '') +
            ': ' +
            (err && err.message ? err.message : String(err)) +
            ' — ' +
            url,
        );
      }
      if (!r.ok) throw new Error('Dispo-Dateiliste fehlgeschlagen (' + r.status + '): ' + url);
      const data = await r.json();
      return Array.isArray(data.entries) ? data.entries : [];
    }
    for (const dirPath of dirsToList) {
      const entries = await fetchList(dirPath);
      for (const e of entries) {
        const name = e.name || '';
        if (!name || name === '.' || name === '..') continue;
        if (String(e.type || '').toLowerCase() !== 'file') continue;
        const childPath = normProjectRelPath(dirPath ? dirPath + '/' + name : name);
        if (childPath) seen.add(childPath);
      }
    }
    return seen;
  }

  async function syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword, urlOpts) {
    const opts = urlOpts && typeof urlOpts === 'object' ? urlOpts : {};
    const candidates = buildDispoBaseCandidates({
      baseUrl: dispoBaseUrl,
      externalUrl: opts.externalUrl || opts.dispoExternalUrl,
      internalUrl: opts.internalUrl || opts.dispoInternalUrl,
    });
    if (!localJobId || !technicianId) throw new Error('job_id (lokal) und technicianId erforderlich.');
    if (!candidates.length) throw new Error('Dispo-Server-URL fehlt (Einstellungen).');
    const outcome = await tryDispoBasesInOrder(candidates, (base) =>
      syncDienstreiseFoldersToDispoForBase(localJobId, base, technicianId, dispoUsername, dispoPassword, opts),
    );
    if (outcome.error) {
      throw new Error(formatDispoSyncNetworkError(outcome.error, outcome.tried));
    }
    return outcome.base;
  }

  async function syncDienstreiseFoldersToDispoForBase(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword, syncOpts) {
    const base = (dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!localJobId || !base || !technicianId) throw new Error('job_id (lokal), dispoBaseUrl und technicianId erforderlich.');
    const onlyChanged = !!(syncOpts && syncOpts.onlyChanged);
    const foldersFilter =
      syncOpts && Array.isArray(syncOpts.folders) && syncOpts.folders.length ? syncOpts.folders : DIENSTREISE_SYNC_FOLDERS;
    const jobId = getServerJobId(localJobId);
    const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!reiseDir || !fs.existsSync(reiseDir)) throw new Error('Dienstreise-Ordner existiert nicht.');
    // Vor Push: Auftragsordner auf Desired alignen (Rename statt Parallelordner).
    try {
      await ensureJobReiseFolderLayout(localJobId, reiseDir, technicianId);
    } catch (alignErr) {
      console.warn(
        '[dienstreise_push] Montage-Align:',
        alignErr && alignErr.message ? alignErr.message : alignErr,
      );
    }

    const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};

    async function collectLocalFiles(rootDir, subfolder) {
      const result = [];
      const startDir = path.join(rootDir, subfolder);
      if (!fs.existsSync(startDir)) return result;
      let seen = 0;
      async function walk(currentDir, relBase) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const e of entries) {
          if (isIgnorableDirEntry(e.name)) continue;
          const full = path.join(currentDir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (e.isDirectory()) {
            await walk(full, rel);
          } else if (e.isFile()) {
            if (isMonteurDraftJsonBasename(e.name)) continue;
            result.push({ relPathFromSub: rel, fullPath: full });
            seen += 1;
            if (seen % 20 === 0) await yieldEventLoop();
          }
        }
      }
      await walk(startDir, '');
      return result.map((f) => ({
        relPathFromRoot: subfolder + (f.relPathFromSub ? '/' + f.relPathFromSub : ''),
        fullPath: f.fullPath,
      }));
    }

    async function pushFileBatch(folder, files) {
      if (!files.length) return;
      let remoteFiles;
      const localRelPaths = files.map((f) => f.relPathFromRoot);
      try {
        remoteFiles = await listRemoteProjectFilesOnDispo(base, jobId, technicianId, authHeader, folder, localRelPaths);
      } catch (e) {
        throw e;
      }
      for (const f of files) {
        const relNorm = normProjectRelPath(f.relPathFromRoot);
        const needsPush = localDienstreiseFileNeedsDispoPush(db, localJobId, f.relPathFromRoot, f.fullPath);
        if (relNorm && remoteProjectPathSetHas(remoteFiles, relNorm) && !needsPush) {
          continue;
        }
        await uploadJobProjectFileToDispo(base, jobId, technicianId, authHeader, f.relPathFromRoot, f.fullPath);
        recordDienstreisePushCache(db, localJobId, f.relPathFromRoot, f.fullPath);
        await yieldEventLoop();
      }
    }

    if (onlyChanged) {
      const relPred = syncOpts && typeof syncOpts.relPathPredicate === 'function' ? syncOpts.relPathPredicate : null;
      const changed = await collectChangedDienstreiseSyncFileEntries(db, reiseDir, localJobId, foldersFilter, relPred);
      if (!changed.length) return;
      const byFolder = new Map();
      for (const f of changed) {
        const folder = foldersFilter.find(
          (fd) => f.relPathFromRoot === fd || f.relPathFromRoot.startsWith(fd + '/'),
        );
        if (!folder) continue;
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(f);
      }
      for (const [folder, files] of byFolder) {
        await pushFileBatch(folder, files);
      }
      return;
    }

    for (const folder of foldersFilter) {
      const files = await collectLocalFiles(reiseDir, folder);
      if (!files.length) continue;
      await pushFileBatch(folder, files);
    }
  }

  function createDienstreiseFolder(basePath, startDateISO, companyName, city, countryCode) {
    const base = (basePath && typeof basePath === 'string') ? basePath.trim() : getDienstreiseBasePath();
    if (!base) throw new Error('Speicherort Dienstreise ist nicht konfiguriert.');
    const datePart = (startDateISO && typeof startDateISO === 'string') ? startDateISO.trim().slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) throw new Error('Ungültiges Startdatum (YYYY-MM-DD).');
    const year = datePart.slice(0, 4);
    const nr = getNextRunningNumber(base, year);
    const firm = sanitizeDienstreiseFolderPart(companyName);
    const ort = sanitizeDienstreiseFolderPart(city);
    const lk = sanitizeDienstreiseFolderPart(countryCode);
    const folderName = `${nr}_${datePart}_${firm}_${ort}_${lk}`;
    const yearDir = path.join(base, year);
    const reiseDir = path.join(yearDir, folderName);
    if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });
    if (fs.existsSync(reiseDir)) throw new Error('Reise-Ordner existiert bereits: ' + folderName);
    fs.mkdirSync(reiseDir, { recursive: true });
    try {
      console.log('[dienstreise] Ordner angelegt:', reiseDir);
    } catch (_) {}
    for (const sub of DIENSTREISE_SUBFOLDERS) {
      fs.mkdirSync(path.join(reiseDir, sub), { recursive: true });
    }
    return { folderName, fullPath: reiseDir, year: parseInt(year, 10), runningNumber: nr };
  }

  /** Sucht vorhandenen Reise-Ordner zu Jahr/Datum/Firma/Ort/Land; liefert null wenn keiner existiert. */
  function findExistingReiseDir(base, year, datePart, firm, ort, lk) {
    const yearDir = path.join(base, String(year));
    if (!fs.existsSync(yearDir)) return null;
    const expectedSuffix = `${datePart}_${firm}_${ort}_${lk}`;
    try {
      const entries = fs.readdirSync(yearDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(/^(\d+)_(.+)$/);
        if (m && m[2] === expectedSuffix) return path.join(yearDir, e.name);
      }
    } catch (err) { /* ignore */ }
    return null;
  }

  /**
   * Nach „Auftrag annehmen“: Ordner existiert, aber Kunde/Ort/Datum in der DB kann sich nach Sync unterscheiden.
   * Sucht den Reise-Ordner über vorhandene FN unter Dokumente_Anlage (nach Dienstreise-Pull).
   */
  function findReiseDirByMonteurFabScan(base, row) {
    if (!base || !row) return null;
    const fabs = fabNumbersFromJobFabrikationsnummern(row.fabrikationsnummern);
    if (!fabs || fabs.size === 0) return null;
    const years = new Set();
    const startStr = (row.start_datetime || '').trim().slice(0, 10);
    if (/^\d{4}/.test(startStr)) years.add(startStr.slice(0, 4));
    years.add(String(new Date().getFullYear()));
    const py = new Date().getFullYear() - 1;
    years.add(String(py));
    for (const year of years) {
      const yearDir = path.join(base, String(year));
      if (!fs.existsSync(yearDir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(yearDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const reiseDir = path.join(yearDir, ent.name);
        const da = path.join(reiseDir, 'Dokumente_Anlage');
        if (!fs.existsSync(da) || !fs.statSync(da).isDirectory()) continue;
        for (const fab of fabs) {
          if (resolveProjekteNeuRoot(da, fab)) return reiseDir;
        }
      }
    }
    return null;
  }

  function lookupDienstreiseJobRow(jobIdRef) {
    if (jobIdRef == null || jobIdRef === '') return null;
    const id = typeof jobIdRef === 'number' ? jobIdRef : parseInt(jobIdRef, 10);
    if (!Number.isFinite(id)) return null;
    const joinSql = `
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id`;
    const cols =
      'j.id, j.server_id, j.start_datetime, j.fabrikationsnummern, c.name AS customer_name, ja.city, ja.country';
    const byLocal = db
      .prepare(`SELECT ${cols} ${joinSql} WHERE j.id = ? LIMIT 1`)
      .get(id);
    const byServer = db
      .prepare(`SELECT ${cols} ${joinSql} WHERE CAST(j.server_id AS TEXT) = CAST(? AS TEXT) LIMIT 1`)
      .get(id);
    if (byLocal && byServer && byLocal.id !== byServer.id) {
      console.warn('[lookupDienstreiseJobRow] ID-Konflikt ref=' + id + ' — bevorzuge server_id-Zeile', {
        local_match_id: byLocal.id,
        server_match_id: byServer.id,
      });
      return byServer;
    }
    return byLocal || byServer || null;
  }

  function ensureJobReiseFolderBindingSchema(dbConn) {
    dbConn.prepare(
      `CREATE TABLE IF NOT EXISTS job_reise_folder_binding (
        local_job_id INTEGER PRIMARY KEY,
        folder_path TEXT NOT NULL,
        created_at TEXT
      )`,
    ).run();
  }

  function getBoundReiseDirForJob(localJobId) {
    ensureJobReiseFolderBindingSchema(db);
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return null;
    const row = db.prepare('SELECT folder_path FROM job_reise_folder_binding WHERE local_job_id = ?').get(lid);
    const p = row && row.folder_path ? String(row.folder_path).trim() : '';
    if (p && fs.existsSync(p)) return p;
    if (p) {
      try {
        db.prepare('DELETE FROM job_reise_folder_binding WHERE local_job_id = ?').run(lid);
        save();
      } catch (_) {}
    }
    return null;
  }

  function bindReiseFolderForJob(localJobId, folderPath) {
    ensureJobReiseFolderBindingSchema(db);
    const lid = parseInt(localJobId, 10);
    const p = String(folderPath || '').trim();
    if (!Number.isFinite(lid) || lid <= 0 || !p) return;
    const assigned = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ? LIMIT 1').get(lid);
    if (!assigned) return;
    db.prepare(
      `INSERT OR REPLACE INTO job_reise_folder_binding (local_job_id, folder_path, created_at)
       VALUES (?, ?, datetime('now'))`,
    ).run(lid, p);
  }

  /** Projektordner nur für zugewiesene Aufträge (Ausnahme: Accept-Flow mit skipAssignmentCheck). */
  function requireJobHasTechnicianAssignment(dbConn, localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) {
      return { error: 'job_id (lokal) ungültig.', status: 400 };
    }
    const row = dbConn.prepare('SELECT 1 FROM job_technicians WHERE job_id = ? LIMIT 1').get(lid);
    if (!row) {
      return { error: 'Auftrag ist keinem Monteur zugeordnet — kein Projektordner.', status: 403 };
    }
    return null;
  }

  function purgeOrphanReiseFolderBindings() {
    ensureJobReiseFolderBindingSchema(db);
    const rows = db.prepare('SELECT local_job_id, folder_path FROM job_reise_folder_binding').all();
    let n = 0;
    for (const row of rows) {
      const lid = parseInt(row.local_job_id, 10);
      if (!Number.isFinite(lid) || lid <= 0) continue;
      const assigned = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ? LIMIT 1').get(lid);
      const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(lid);
      const st = statusRow ? String(statusRow.status || '').trim().toLowerCase() : '';
      const folderPath = String(row.folder_path || '').trim();
      const missing = !folderPath || !fs.existsSync(folderPath);
      if (!assigned || (missing && st !== 'in_arbeit')) {
        db.prepare('DELETE FROM job_reise_folder_binding WHERE local_job_id = ?').run(lid);
        n++;
      }
    }
    if (n) save();
    return n;
  }

  /**
   * Acrobat öffnet unter Windows oft still keine PDFs, wenn der Pfad Bullet-Zeichen (•) enthält.
   * Bestehende Reiseordner einmalig umbenennen und Binding aktualisieren.
   */
  function repairAcrobatHostileReiseDir(localJobId, reiseDir) {
    if (!reiseDir || !fs.existsSync(reiseDir)) return reiseDir;
    const parent = path.dirname(reiseDir);
    const baseName = path.basename(reiseDir);
    const fixedName = baseName
      .replace(/[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF\u00B7\u2024\u2027\u2218•▪◦●∙·]/g, '-')
      .replace(/_+/g, '_')
      .replace(/-+/g, '-')
      .replace(/_-|-\_/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
    if (!fixedName || fixedName === baseName) return reiseDir;
    const target = path.join(parent, fixedName);
    if (fs.existsSync(target)) {
      console.warn('[dienstreise] Acrobat-Rename übersprungen (Ziel existiert):', target);
      return reiseDir;
    }
    try {
      fs.renameSync(reiseDir, target);
      const lid = parseInt(localJobId, 10);
      if (Number.isFinite(lid) && lid > 0) bindReiseFolderForJob(lid, target);
      try {
        db.prepare('UPDATE dienstreisen SET folder_name = ? WHERE folder_name = ?').run(fixedName, baseName);
      } catch (_) {
        /* optional */
      }
      save();
      console.log('[dienstreise] Ordner für Acrobat umbenannt:', baseName, '->', fixedName);
      return target;
    } catch (e) {
      console.warn(
        '[dienstreise] Acrobat-Rename fehlgeschlagen:',
        e && e.message ? e.message : e,
      );
      return reiseDir;
    }
  }

  /**
   * Dienstreise-Ordner zu einem Auftrag (lokal oder server_id).
   * @param {number|string} jobIdRef
   * @param {{ createIfMissing?: boolean }} [opts] – nur bei true anlegen (Schreibpfade); PROJEKTE NEU nur lesen.
   * @returns {string|null}
   */
  function resolveDienstreiseReiseDirForJob(jobIdRef, opts) {
    const createIfMissing = !!(opts && opts.createIfMissing);
    const base = getDienstreiseBasePath();
    if (!base) return null;
    const row = lookupDienstreiseJobRow(jobIdRef);
    if (!row) return null;
    if (createIfMissing && !opts.skipFolderStatusGate) {
      const assignGate = requireJobHasTechnicianAssignment(db, row.id);
      if (assignGate) return null;
      const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(row.id);
      if (dienstreiseProjectFolderBlocked(statusRow ? statusRow.status : null)) return null;
    }
    const bound = getBoundReiseDirForJob(row.id);
    if (bound) return repairAcrobatHostileReiseDir(row.id, bound);
    const startStr = (row.start_datetime || '').trim().slice(0, 10);
    const hasValidStart = /^\d{4}-\d{2}-\d{2}$/.test(startStr);
    if (hasValidStart) {
      const year = startStr.slice(0, 4);
      const companyName = (row.customer_name || '').trim() || 'Auftrag';
      const city = (row.city || '').trim();
      const countryRaw = (row.country || '').trim();
      const countryCode = countryRaw.length >= 2 ? countryRaw.slice(0, 2).toUpperCase() : countryRaw;
      const firm = sanitizeDienstreiseFolderPart(companyName);
      const ort = sanitizeDienstreiseFolderPart(city);
      const lk = sanitizeDienstreiseFolderPart(countryCode);
      const existing = findExistingReiseDir(base, year, startStr, firm, ort, lk);
      if (existing) {
        const repaired = repairAcrobatHostileReiseDir(row.id, existing);
        bindReiseFolderForJob(row.id, repaired);
        return repaired;
      }
    }
    if (!createIfMissing) {
      const scanned = findReiseDirByMonteurFabScan(base, row);
      if (scanned) return repairAcrobatHostileReiseDir(row.id, scanned);
      return null;
    }
    if (!hasValidStart) return null;
    try {
      const companyName = (row.customer_name || '').trim() || 'Auftrag';
      const city = (row.city || '').trim();
      const countryRaw = (row.country || '').trim();
      const countryCode = countryRaw.length >= 2 ? countryRaw.slice(0, 2).toUpperCase() : countryRaw;
      const created = createDienstreiseFolder(base, startStr, companyName, city, countryCode);
      bindReiseFolderForJob(row.id, created.fullPath);
      return created.fullPath;
    } catch (_) {
      return null;
    }
  }

  /**
   * Zielordner für einen Auftrag: Jahr = Beginn des Auftrags, Ordner = Laufende Nr._Datum_Firmenname_Ort_LK.
   * Verwendet vorhandenen Ordner falls passend, sonst wird er angelegt.
   */
  function getOrCreateDienstreiseFolderForJob(localJobId, opts) {
    opts = opts || {};
    if (!opts.skipAssignmentCheck) {
      const assignGate = requireJobHasTechnicianAssignment(db, localJobId);
      if (assignGate) throw new Error(assignGate.error);
      const tid = parseInt(opts.technicianId, 10);
      if (Number.isFinite(tid) && tid > 0) {
        const tg = requireJobAssignedToTechnician(db, localJobId, tid);
        if (tg) throw new Error(tg.error);
      }
    }
    const base = getDienstreiseBasePath();
    if (!base) throw new Error('Speicherort Dienstreise ist nicht konfiguriert.');
    const row = lookupDienstreiseJobRow(localJobId);
    if (!row) throw new Error('Auftrag nicht gefunden.');
    const dir = resolveDienstreiseReiseDirForJob(localJobId, {
      createIfMissing: true,
      skipFolderStatusGate: !!opts.skipAssignmentCheck,
    });
    if (!dir) throw new Error('Auftrag hat kein gültiges Startdatum.');
    return dir;
  }

  /** Alle TED-Excel eines Monteurs sofort unter Reiseordner/TED/ (nach TED-Index in sync_pull). Nur in_arbeit. */
  async function pullTedExcelFilesForTechnicianJobsInSync(base, technicianId, authHeader, signal, setProgress, lock) {
    const rows = db
      .prepare(
        `SELECT j.id AS local_id, j.server_id FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id
         WHERE jt.technician_id = ? AND j.status = 'in_arbeit'`,
      )
      .all(technicianId);
    const jobs = [];
    let skippedNoFolder = 0;
    for (const row of rows) {
      try {
        const targetDir = resolveDienstreiseReiseDirForJob(row.local_id, { createIfMissing: false });
        if (targetDir && fs.existsSync(targetDir)) jobs.push({ local_id: row.local_id, server_id: row.server_id, targetDir });
        else skippedNoFolder++;
      } catch (_) {
        skippedNoFolder++;
      }
    }
    const total = jobs.length;
    if (!total) {
      return { downloaded_jobs: 0, attempted_jobs: 0, skipped_no_folder: skippedNoFolder, files_downloaded: 0, files_failed: 0 };
    }
    const noopCheckpoint = () => {};
    let i = 0;
    let filesDownloaded = 0;
    let filesFailed = 0;
    for (const row of jobs) {
      if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
      i++;
      const serverJobId = row.server_id != null ? Number(row.server_id) : Number(row.local_id);
      if (setProgress) setProgress('ted_files', i, total, 'TED-Excel ' + i + '/' + total);
      try {
        const stats = await pullTedExcelIntoReiseDir({
          db,
          dbLock: lock || dbLock,
          dispoBaseUrl: base,
          technicianId,
          serverJobId,
          localJobId: row.local_id,
          targetDir: row.targetDir,
          authHeader,
          signal,
          setProgress: (phase, cur, tot, msg) => {
            if (setProgress && phase === 'ted' && msg) setProgress('ted_files', i, total, msg);
          },
          mergeCheckpoint: noopCheckpoint,
          readCheckpoint: () => ({}),
          force: false,
        });
        filesDownloaded += stats.downloaded || 0;
        filesFailed += stats.failed || 0;
        if (stats.total > 0 && stats.present === 0) {
          console.warn('[sync_pull] ted_files job', serverJobId, '0/' + stats.total + ' lokal nach Pull');
        }
      } catch (err) {
        console.warn('[sync_pull] ted_files job', serverJobId, err && err.message ? err.message : err);
      }
    }
    if (lock && typeof lock.runWithDbLock === 'function') {
      await lock.runWithDbLock(async () => {
        if (typeof db.save === 'function') db.save();
      });
    } else if (typeof db.save === 'function') {
      db.save();
    }
    return {
      downloaded_jobs: total,
      attempted_jobs: total,
      skipped_no_folder: skippedNoFolder,
      files_downloaded: filesDownloaded,
      files_failed: filesFailed,
    };
  }

  app.post('/api/dienstreise/create_folder', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const basePath = body.basePath != null ? body.basePath : getDienstreiseBasePath();
      const startDate = body.startDate || body.start_date || '';
      const companyName = body.companyName || body.company_name || '';
      const city = body.city || '';
      const countryCode = body.countryCode || body.country_code || '';
      const result = createDienstreiseFolder(basePath, startDate, companyName, city, countryCode);
      res.json({ ok: true, folderName: result.folderName, fullPath: result.fullPath, year: result.year, runningNumber: result.runningNumber });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Ordner konnte nicht angelegt werden.' });
    }
  });

  function getDienstreiseFullPath(dienstreiseRow) {
    const base = getDienstreiseBasePath();
    if (!base || !dienstreiseRow || !dienstreiseRow.folder_name) return null;
    return path.join(base, String(dienstreiseRow.year), dienstreiseRow.folder_name);
  }

  /** Dateiname, der für "leer" ignoriert wird (versteckte/Systemdateien). */
  function isIgnorableDirEntry(name) {
    if (!name || name === '.' || name === '..') return true;
    if (name.startsWith('.')) return true;
    const lower = name.toLowerCase();
    if (lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store') return true;
    return false;
  }

  /** True, wenn der Ordner keine sichtbaren Einträge hat (nur ignorierbare = effektiv leer). */
  function isEffectivelyEmptyDir(dirPath) {
    try {
      const names = fs.readdirSync(dirPath);
      const visible = names.filter((n) => !isIgnorableDirEntry(n));
      return visible.length === 0;
    } catch (e) {
      return true;
    }
  }

  app.get('/api/dienstreise/list', (req, res) => {
    try {
      const rows = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen ORDER BY year DESC, running_number DESC').all();
      res.json({ ok: true, dienstreisen: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  function jobMetaForFnFolder(jobDetail) {
    if (!jobDetail) return null;
    return {
      customer_name: jobDetail.customer_name,
      city: jobDetail.city,
      country: jobDetail.country,
    };
  }

  function buildCanonicalFabFolderName(fab, jobDetail) {
    const built = buildFnProjectFolderName({
      fab,
      customer_name: jobDetail && jobDetail.customer_name,
      city: jobDetail && jobDetail.city,
      country: jobDetail && jobDetail.country,
    });
    return built || String(fab);
  }

  /** Speichert vorgeschlagenen Langnamen im lokalen Anlagenstamm-Cache. */
  function rememberSuggestedFnFolder(fab, folderName) {
    const f = String(fab || '').trim();
    const name = String(folderName || '').trim();
    if (!f || !name || isBareFabFolderName(name)) return;
    try {
      upsertAnlagenstammTreeCache(db, f, { enabled: false, tree: [] }, { root_folder_name: name });
    } catch (_) {}
    try {
      db.prepare(
        `UPDATE anlagenstamm_local SET pn_root_name = ?
         WHERE TRIM(fabrikationsnummer) = TRIM(?)`,
      ).run(name, f);
    } catch (_) {}
  }

  /** Kanonische Fileserver-FN-Namen für Explorer/Pfade (Cache + Platte, fab_map persistieren). */
  async function ensureFabMapCanonicalForJob(localJobId, reiseDir) {
    const jobRow = lookupDienstreiseJobRow(localJobId);
    const jobFabs = jobRow ? fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern) : [];
    const offlineCfg = getOfflinePullConfig(db, localJobId);
    const fabMap = resolveFabMapLocal(
      reiseDir,
      offlineCfg.fab_map || [],
      jobFabs,
      (fab) => readAnlagenstammRootFolderName(db, fab),
      jobMetaForFnFolder(jobRow),
    );
    for (const entry of fabMap) {
      if (entry && entry.folder_name_canonical) {
        rememberSuggestedFnFolder(entry.fab, entry.folder_name_canonical);
      }
    }
    if (!fabMapJsonEqual(offlineCfg.fab_map, fabMap)) {
      updateOfflinePullFabMap(db, localJobId, fabMap);
      save();
    }
    if (reiseDir && fs.existsSync(reiseDir)) {
      await migrateBareFabAnlageDirs(reiseDir, fabMap);
      await removeStaleBareFabMonteurDirs(reiseDir, fabMap);
      await migrateAliasFnFolders(reiseDir, fabMap);
      await ensureAnlageFnDirs(reiseDir, fabMap);
    }
    return fabMap;
  }

  function resolveTechnicianIdForLocalJob(localJobId, overrideId) {
    const tid = parseInt(overrideId, 10);
    if (Number.isFinite(tid) && tid > 0) return tid;
    const row = db.prepare('SELECT technician_id FROM job_technicians WHERE job_id = ? LIMIT 1').get(localJobId);
    return row && row.technician_id != null ? parseInt(row.technician_id, 10) : null;
  }

  /**
   * Vorhandene Dokumente_Monteur/<FN>/Montage/<Auftragsordner>/ alignen (Rename/Merge).
   * Keine leeren FN-/Montage-Bäume auf Vorrat.
   */
  async function ensureJobReiseFolderLayout(localJobId, reiseDir, technicianIdOpt) {
    if (!reiseDir || !fs.existsSync(reiseDir)) return { fabMap: [], montageFolderName: '' };
    const fabMap = await ensureFabMapCanonicalForJob(localJobId, reiseDir);
    const techId = resolveTechnicianIdForLocalJob(localJobId, technicianIdOpt);
    const techDisplay = getTechnicianDisplayName(techId) || 'Monteur';
    const previousName = getStickyMontageFolderName(localJobId);
    let montageFolderName = resolveMonteurAuftragsordnerName(localJobId, techId);
    if (!montageFolderName) {
      const jobRow = lookupDienstreiseJobRow(localJobId);
      montageFolderName = buildMonteurMontageFolderName(jobRow || {}, techDisplay);
    }
    if (montageFolderName && (fabMap.length || previousName)) {
      await ensureMonteurMontageDirs(reiseDir, fabMap, montageFolderName, {
        technicianDisplayName: techDisplay,
        previousName: previousName || null,
      });
      await migrateTopLevelMontageIntoFnFolders(reiseDir, fabMap);
      if (previousName && previousName !== montageFolderName) {
        rewriteDienstreisePushCacheMontageFolder(localJobId, previousName, montageFolderName);
      }
      if (updateMontageFolderNameInConfig(db, localJobId, montageFolderName)) save();
      else if (ensureMontageFolderNameInConfig(db, localJobId, montageFolderName)) save();
      // Nur nachziehen, wenn Monteur-Default aktiv (sonst User-Abwahl der Wurzel nicht überschreiben)
      const monteurStillProtected = listProtectedPaths(db, localJobId).includes(DOKUMENTE_MONTEUR);
      if (monteurStillProtected) {
        for (const entry of fabMap) {
          const fnFolder = entry && (entry.folder_name_canonical || entry.folderName);
          if (!fnFolder) continue;
          protectPathIfUnderDokumenteMonteur(
            db,
            localJobId,
            buildMonteurWorkRelPath(fnFolder, montageFolderName),
          );
        }
      }
    }
    if (montageFolderName) {
      ensureMonteurPhotoCategoryDirs(reiseDir, montageFolderName);
      if (listProtectedPaths(db, localJobId).includes(DOKUMENTE_MONTEUR)) {
        const fabForProtect = fabMap.length ? fabMap : [];
        if (fabForProtect.length) {
          for (const entry of fabForProtect) {
            const fnFolder = entry && (entry.folder_name_canonical || entry.folderName);
            if (!fnFolder) continue;
            protectPathIfUnderDokumenteMonteur(
              db,
              localJobId,
              buildMonteurPhotoCategoryRelDir(montageFolderName, 'Allgemein', fnFolder),
            );
            protectPathIfUnderDokumenteMonteur(
              db,
              localJobId,
              buildMonteurPhotoCategoryRelDir(montageFolderName, 'Angebot', fnFolder),
            );
          }
        } else {
          protectPathIfUnderDokumenteMonteur(
            db,
            localJobId,
            buildMonteurPhotoCategoryRelDir(montageFolderName, 'Allgemein'),
          );
          protectPathIfUnderDokumenteMonteur(
            db,
            localJobId,
            buildMonteurPhotoCategoryRelDir(montageFolderName, 'Angebot'),
          );
        }
      }
    }
    return { fabMap, montageFolderName };
  }

  /** Liste der Dateien/Ordner im Projektordner eines Auftrags (Explorer-Ansicht). subpath = relativer Pfad (z. B. "" oder "Dokumente_Monteur"). */
  app.get('/api/dienstreise/project_files', async (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      if (!jobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const technicianId = getTechnicianId(req);
      const resolved =
        technicianId && Number.isFinite(technicianId) && technicianId > 0
          ? resolveLocalJobIdForTechnician(db, technicianId, jobId, { mode: 'auto' })
          : null;
      let localJobId = jobId;
      if (resolved) {
        if (!resolved.ok) {
          return res.status(resolved.status || 404).json({ ok: false, error: resolved.error });
        }
        localJobId = resolved.localId;
      } else {
        const mapped = getJobRowByLocalOrServerId(jobId);
        if (!mapped) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
        localJobId = mapped.id;
      }
      const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(localJobId);
      const statusRaw = statusRow ? String(statusRow.status || '').trim().toLowerCase() : '';
      const isClosedJob = statusRaw === 'erledigt' || statusRaw === 'abgerechnet';
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      const folderExists = !!(reiseDir && fs.existsSync(reiseDir));
      if (!folderExists) {
        const folderGate = dienstreiseProjectFolderBlocked(statusRow ? statusRow.status : null);
        let hint = 'Noch kein Projektordner — bitte Auftrag annehmen.';
        if (isClosedJob) {
          hint = 'Kein lokaler Projektordner mehr vorhanden (nach „erledigt“ gelöscht oder nie angelegt).';
        } else if (folderGate) {
          hint = folderGate.error;
        }
        return res.json({
          ok: true,
          folderPath: reiseDir || '',
          entries: [],
          folder_missing: true,
          hint,
        });
      }
      if (!isClosedJob) {
        try {
          await migrateTopLevelMontageIntoFnFolders(reiseDir, await ensureFabMapCanonicalForJob(localJobId, reiseDir));
        } catch (_) {}
        try {
          pruneEmptyMonteurDraftJsons(reiseDir);
        } catch (_) {}
      }
      let subpath = (req.query.subpath || '').trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
      if (subpath && (subpath.includes('..') || path.isAbsolute(subpath))) return res.status(400).json({ ok: false, error: 'Ungültiger Unterpfad.' });

      if (isAnlageDbExplorerSubpath(subpath)) {
        const offlineCfg = getOfflinePullConfig(db, localJobId);
        const jobRow = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
        const jobFabs = jobRow ? fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern) : [];
        const fabMap = resolveFabMapLocal(reiseDir, offlineCfg.fab_map || [], jobFabs, (fab) =>
          readAnlagenstammRootFolderName(db, fab),
        );
        const anlageResult = buildAnlageExplorerEntries({
          localJobId,
          reiseDir,
          subpath,
          fabMap,
          db,
          readTreeCache: (fab) => readAnlagenstammTreeCache(db, fab),
          resolveLocalFile: (lid, fab, pnRel) =>
            resolveProjekteNeuLocalFilePath(lid, fab, pnRel, { skipDeepSearch: true }),
        });
        if (anlageResult) {
          return res.json({
            ok: true,
            folderPath: reiseDir,
            subpath: subpath || '',
            entries: anlageResult.entries,
            anlage_db: true,
            tree_empty: !!anlageResult.treeEmpty,
          });
        }
      }

      const dirPath = subpath ? path.join(reiseDir, subpath) : reiseDir;
      let dirStat;
      try {
        dirStat = await fs.promises.stat(dirPath);
      } catch (_) {
        return res.json({ ok: true, folderPath: reiseDir, subpath: subpath || '', entries: [] });
      }
      if (!dirStat.isDirectory()) return res.json({ ok: true, folderPath: reiseDir, subpath: subpath || '', entries: [] });
      let dirents;
      try {
        dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Dateiliste konnte nicht gelesen werden.' });
      }
      const entries = [];
      let listed = 0;
      for (const ent of dirents) {
        const name = ent.name;
        if (isIgnorableDirEntry(name)) continue;
        const fullPath = path.join(dirPath, name);
        const isDirectory = ent.isDirectory();
        if (!isDirectory && !ent.isFile()) continue;
        if (isDirectory) {
          const keepEmptyPhotoCategory = name === 'Allgemein' || name === 'Angebot';
          if (subpath && !keepEmptyPhotoCategory && dirents.length <= 24) {
            try {
              const childNames = await fs.promises.readdir(fullPath);
              const visible = childNames.filter((n) => !isIgnorableDirEntry(n));
              if (!visible.length) continue;
            } catch (_) {
              continue;
            }
          }
        }
        let size = null;
        let mtime = null;
        if (!isDirectory) {
          try {
            const st = await fs.promises.stat(fullPath);
            size = st.size;
            mtime = st.mtime ? st.mtime.toISOString() : null;
          } catch (e) {
            continue;
          }
        }
        const relativePath = subpath ? (subpath.replace(/\\/g, '/') + '/' + name) : name;
        entries.push({
          name,
          relativePath,
          fullPath,
          isDirectory,
          size,
          mtime,
        });
        listed += 1;
        if (listed % 8 === 0) await yieldEventLoop();
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });
      res.json({ ok: true, folderPath: reiseDir, subpath: subpath || '', entries });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Dateiliste konnte nicht gelesen werden.' });
    }
  });

  /** PWA-/Projekt-Fotos unter Dokumente_Monteur (Bilder-Ordner + flache Legacy-Fotos). */
  app.get('/api/dienstreise/project_photos', (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      if (!jobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const technicianId = getTechnicianId(req);
      const resolved =
        technicianId && Number.isFinite(technicianId) && technicianId > 0
          ? resolveLocalJobIdForTechnician(db, technicianId, jobId, { mode: 'auto' })
          : null;
      let localJobId = jobId;
      if (resolved) {
        if (!resolved.ok) {
          return res.status(resolved.status || 404).json({ ok: false, error: resolved.error });
        }
        localJobId = resolved.localId;
      } else {
        const mapped = getJobRowByLocalOrServerId(jobId);
        if (!mapped) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
        localJobId = mapped.id;
      }
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.json({
          ok: true,
          photos: [],
          folder_missing: true,
          hint: 'Noch kein Projektordner — bitte Auftrag annehmen.',
        });
      }
      const docMonteur = path.join(reiseDir, 'Dokumente_Monteur');
      if (!fs.existsSync(docMonteur) || !fs.statSync(docMonteur).isDirectory()) {
        return res.json({ ok: true, photos: [], folder_missing: false, hint: 'Keine Dokumente_Monteur vorhanden.' });
      }
      const imgRe = /\.(jpe?g|png|gif|webp|bmp)$/i;
      const photos = [];
      const maxFiles = 400;
      const maxDepth = 8;
      function walk(dir, relBase, depth) {
        if (photos.length >= maxFiles || depth > maxDepth) return;
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch (_) {
          return;
        }
        for (const name of names) {
          if (photos.length >= maxFiles) break;
          if (isIgnorableDirEntry(name)) continue;
          const full = path.join(dir, name);
          let st;
          try {
            st = fs.statSync(full);
          } catch (_) {
            continue;
          }
          const rel = (relBase ? relBase + '/' : '') + name;
          if (st.isDirectory()) {
            walk(full, rel, depth + 1);
            continue;
          }
          if (!st.isFile() || !imgRe.test(name)) continue;
          const norm = rel.replace(/\\/g, '/');
          photos.push({
            name,
            relativePath: 'Dokumente_Monteur/' + norm,
            size: st.size,
            mtime: st.mtime ? st.mtime.toISOString() : null,
            in_bilder: /\/Bilder\//i.test('/' + norm + '/') || /^Bilder\//i.test(norm),
          });
        }
      }
      walk(docMonteur, '', 0);
      photos.sort((a, b) => {
        if (a.in_bilder !== b.in_bilder) return a.in_bilder ? -1 : 1;
        const ta = a.mtime || '';
        const tb = b.mtime || '';
        if (ta !== tb) return ta < tb ? 1 : -1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'de', { sensitivity: 'base' });
      });
      res.json({ ok: true, photos, folder_missing: false });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Fotoliste konnte nicht gelesen werden.' });
    }
  });

  function resolveDienstreiseProjectFilePath(jobIdRef, relPathRaw) {
    const mapped = getJobRowByLocalOrServerId(jobIdRef);
    const jobId = mapped ? mapped.id : parseInt(jobIdRef, 10);
    if (!Number.isFinite(jobId) || jobId <= 0) return null;
    const reiseDir = resolveDienstreiseReiseDirForJob(jobId, { createIfMissing: false });
    if (!reiseDir) return null;
    let rel = String(relPathRaw || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
    if (rel && (rel.includes('..') || path.isAbsolute(rel))) return null;
    const parts = rel ? rel.split(/[/\\]/).filter(Boolean) : [];
    if (!parts.length) return null;
    const filePath = path.join(reiseDir, ...parts);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    let realReise;
    let realFile;
    try {
      realReise = fs.realpathSync(reiseDir);
      realFile = fs.realpathSync(filePath);
    } catch (_) {
      return null;
    }
    if (realFile !== realReise && !realFile.startsWith(realReise + path.sep)) return null;
    return filePath;
  }

  /** Bild/Datei aus lokalem Projektordner (Explorer), optional Thumbnail. */
  app.get('/api/dienstreise/project_file', async (req, res) => {
    try {
      const rawJobId = parseInt(req.query.job_id, 10);
      const relPath = String(req.query.path || '').trim();
      const wantThumb = String(req.query.thumb || '').toLowerCase() === '1' || req.query.thumb === 'true';
      const wantInline = String(req.query.inline || '').toLowerCase() === '1' || req.query.inline === 'true';
      let thumbMax = parseInt(req.query.thumbMax || req.query.thumb_max, 10);
      if (!Number.isFinite(thumbMax)) thumbMax = 256;
      thumbMax = Math.min(512, Math.max(64, thumbMax));
      if (!rawJobId || !relPath) {
        return res.status(400).json({ ok: false, error: 'job_id und path erforderlich.' });
      }
      const filePath = resolveDienstreiseProjectFilePath(rawJobId, relPath);
      if (!filePath) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.', local_unavailable: true });
      }
      const baseName = path.basename(filePath);
      if (wantThumb) {
        const mappedJob = getJobRowByLocalOrServerId(rawJobId);
        const localJobId = mappedJob ? mappedJob.id : rawJobId;
        const cachedThumb = readImageThumbCache(
          db,
          THUMB_KIND_DIENSTREISE,
          String(localJobId),
          relPath,
          thumbMax,
          filePath,
        );
        if (cachedThumb && cachedThumb.buf && cachedThumb.buf.length) {
          res.setHeader('Content-Type', cachedThumb.contentType);
          res.setHeader('Content-Length', String(cachedThumb.buf.length));
          return res.send(cachedThumb.buf);
        }
        try {
          const thumbOut = await buildProjekteNeuThumbnailBuffer(filePath, thumbMax);
          writeImageThumbCache(
            db,
            THUMB_KIND_DIENSTREISE,
            String(localJobId),
            relPath,
            thumbMax,
            thumbOut.buf,
            thumbOut.contentType,
            filePath,
          );
          if (monteurRuntime.save) monteurRuntime.save();
          res.setHeader('Content-Type', thumbOut.contentType);
          res.setHeader('Cache-Control', 'private, max-age=604800');
          res.setHeader('Content-Length', String(thumbOut.buf.length));
          return res.send(thumbOut.buf);
        } catch (thumbErr) {
          return res.status(415).json({ ok: false, error: thumbErr.message || 'thumb_not_image' });
        }
      }
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(baseName).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
        '.pdf': 'application/pdf',
      };
      const ct = mimeMap[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('X-Download-Filename', encodeURIComponent(baseName));
      res.setHeader(
        'Content-Disposition',
        (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
      );
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  function jobFabsForLocalJob(localJobId, extraFab) {
    const jobRow = lookupDienstreiseJobRow(localJobId);
    const set = new Set();
    if (jobRow) {
      for (const n of fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern)) {
        const s = String(n || '').trim();
        if (s) set.add(s);
      }
    }
    const extra = String(extraFab || '').trim();
    if (extra) set.add(extra);
    return [...set];
  }

  function canonicalProjekteNeuFolderForJob(localJobId, fab) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm) return '';
    const jobRow = lookupDienstreiseJobRow(localJobId);
    const jobFabs = jobFabsForLocalJob(localJobId, fabNorm);
    let fabMapIn = [];
    try {
      fabMapIn = getOfflinePullConfig(db, localJobId).fab_map || [];
    } catch (_) {}
    const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
    const fabMap = resolveFabMapLocal(
      reiseDir,
      fabMapIn,
      jobFabs,
      (f) => readAnlagenstammRootFolderName(db, f),
      jobMetaForFnFolder(jobRow),
    );
    const hit = fabMap.find((e) => String(e.fab || '').trim() === fabNorm);
    if (hit && hit.folder_name_canonical) return String(hit.folder_name_canonical).trim();
    return buildCanonicalFabFolderName(fabNorm, jobRow);
  }

  function getProjekteNeuLocalContext(localJobId, fab) {
    const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
    if (!reiseDir) return null;
    const da = path.join(reiseDir, 'Dokumente_Anlage');
    const offlineCfg = getOfflinePullConfig(db, localJobId);
    const montageFolderName = offlineCfg.montage_folder_name || null;
    const jobRow = lookupDienstreiseJobRow(localJobId);
    const jobFabs = jobFabsForLocalJob(localJobId, fab);
    const fabMap = resolveFabMapLocal(
      reiseDir,
      offlineCfg.fab_map || [],
      jobFabs,
      (f) => readAnlagenstammRootFolderName(db, f),
      jobMetaForFnFolder(jobRow),
    );
    const hit = fabMap.find((e) => String(e.fab || '').trim() === String(fab || '').trim());
    const canonical = hit && hit.folder_name_canonical ? String(hit.folder_name_canonical).trim() : '';
    const singleBuilt = buildFnProjectFolderName(
      Object.assign({ fab }, jobMetaForFnFolder(jobRow) || {}),
    );
    const resolved = resolveProjekteNeuRoot(da, fab);
    if (
      resolved &&
      folderNameMatchesFab(resolved.folderName, fab) &&
      !isDatePrefixedProjectFolderName(resolved.folderName)
    ) {
      const genSingle =
        isBareFabFolderName(resolved.folderName) ||
        resolved.folderName === String(fab) ||
        (singleBuilt && isFnFolderAlias(resolved.folderName, singleBuilt));
      if (!genSingle || !canonical || isFnFolderAlias(resolved.folderName, canonical)) {
        return {
          reiseDir,
          dm: da,
          resolved: { ...resolved, montageFolderName },
        };
      }
    }
    if (canonical) {
      const root = path.join(da, canonical);
      try {
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
          return {
            reiseDir,
            dm: da,
            resolved: { root, folderName: canonical, montageFolderName },
          };
        }
      } catch (_) {}
    }
    return null;
  }

  /** FN aus Pfad (Legacy Bilder/11521/…, neu …/Montage/<AO>/Bilder/) und alle FNs des Auftrags. */
  function collectProjekteNeuFabHints(localJobId, fab, relPathRaw) {
    const hints = [];
    const push = (v) => {
      const s = String(v || '').trim();
      if (s && !hints.includes(s)) hints.push(s);
    };
    push(fab);
    const rel = String(relPathRaw || '').replace(/\\/g, '/');
    const m = rel.match(/(?:^|\/)Bilder\/(\d+)\//i);
    if (m) push(m[1]);
    // Neu: Dokumente_Monteur/<FN|Parent>/Montage/<Auftragsordner>/Bilder/…
    const mMontage = rel.match(/(?:^|\/)(\d+)(?:\s*[-_][^/]*)?\/Montage\/[^/]+\/Bilder(?:\/|$)/i);
    if (mMontage) push(mMontage[1]);
    try {
      const jobRow = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
      if (jobRow) {
        for (const n of fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern)) {
          push(n);
        }
      }
    } catch (_) {}
    return hints;
  }

  function resolveProjekteNeuLocalFilePathForCtx(ctx, rel, resolveOpts) {
    const opts = resolveOpts && typeof resolveOpts === 'object' ? resolveOpts : {};
    const candidates = [];
    const underPn = safeResolveUnderRoot(ctx.resolved.root, rel);
    if (underPn) candidates.push(underPn);
    candidates.push(path.join(ctx.resolved.root, ...rel.split('/').filter(Boolean)));
    candidates.push(path.join(ctx.dm, ctx.resolved.folderName, ...rel.split('/').filter(Boolean)));
    candidates.push(path.join(ctx.dm, ...rel.split('/').filter(Boolean)));
    candidates.push(path.join(ctx.reiseDir, ...rel.split('/').filter(Boolean)));
    candidates.push(path.join(ctx.reiseDir, 'Dokumente_Anlage', ...rel.split('/').filter(Boolean)));
    candidates.push(
      path.join(ctx.reiseDir, 'Dokumente_Anlage', ctx.resolved.folderName, ...rel.split('/').filter(Boolean)),
    );
    if (ctx.resolved.montageFolderName) {
      candidates.push(
        path.join(
          ctx.reiseDir,
          'Dokumente_Monteur',
          ctx.resolved.folderName,
          'Montage',
          ctx.resolved.montageFolderName,
          ...rel.split('/').filter(Boolean),
        ),
      );
    }
    const seen = new Set();
    for (const p of candidates) {
      const key = String(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (_) {}
    }
    const baseName = path.basename(rel);
    if (baseName && opts.skipDeepSearch === false) {
      const onOnedrive = hangDiag.classifyPathKind(ctx.reiseDir) === 'onedrive';
      const maxWalk = onOnedrive ? 250 : 8000;
      let walked = 0;
      const stack = [ctx.dm];
      while (stack.length && walked < maxWalk) {
        const dir = stack.pop();
        walked += 1;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const ent of entries) {
          if (!ent.isDirectory() && ent.name === baseName) {
            const hit = path.join(dir, ent.name);
            try {
              if (fs.statSync(hit).isFile()) return hit;
            } catch (_) {}
          } else if (ent.isDirectory() && !isIgnorableDirEntry(ent.name)) {
            stack.push(path.join(dir, ent.name));
          }
        }
      }
    }
    return null;
  }

  /** PROJEKTE-NEU-Datei: Baum-relativer Pfad, ggf. unter Dienstreise-Pull (Dokumente_Monteur/…). */
  function resolveProjekteNeuLocalFilePath(localJobId, fab, relPathRaw, resolveOpts) {
    const rel = String(relPathRaw || '').trim().replace(/\\/g, '/');
    if (!rel || rel.includes('..')) return null;
    const fabHints = collectProjekteNeuFabHints(localJobId, fab, rel);
    for (const fabTry of fabHints) {
      const ctx = getProjekteNeuLocalContext(localJobId, fabTry);
      if (!ctx) continue;
      const hit = resolveProjekteNeuLocalFilePathForCtx(ctx, rel, resolveOpts);
      if (hit) return hit;
    }
    return null;
  }

  const PROJEKTE_NEU_RASTER_EXT = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.bmp',
    '.tif',
    '.tiff',
    '.heic',
    '.heif',
  ]);
  const PROJEKTE_NEU_RASTER_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
  };

  const { createThumbGenerateQueue } = require('./lib/thumb-generate-queue');
  const projekteNeuThumbQueue = createThumbGenerateQueue({ concurrency: 1 });

  /** WebP-Vorschau; bei sharp-Fehler Originalbild (Browser zeigt ggf. kleineres Icon). */
  async function buildProjekteNeuThumbnailBuffer(filePath, thumbMax) {
    try {
      const sharp = require('sharp');
      const buf = await sharp(filePath)
        .rotate()
        .resize(thumbMax, thumbMax, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      return { buf, contentType: 'image/webp' };
    } catch (thumbErr) {
      const ext = path.extname(filePath).toLowerCase();
      if (!PROJEKTE_NEU_RASTER_EXT.has(ext)) throw thumbErr;
      return {
        buf: fs.readFileSync(filePath),
        contentType: PROJEKTE_NEU_RASTER_MIME[ext] || 'image/jpeg',
      };
    }
  }

  function resolveProjekteNeuLocalFilePathAll(technicianId, fabValue, pnPath, jobIdOpt, resolveOpts) {
    let localJobId = jobIdOpt != null ? parseInt(jobIdOpt, 10) : null;
    if (!Number.isFinite(localJobId) || localJobId <= 0) localJobId = null;
    if (localJobId && technicianId) {
      const resolved = resolveLocalJobIdForTechnician(db, technicianId, localJobId, { mode: 'auto' });
      if (resolved.ok) localJobId = resolved.localId;
      else localJobId = null;
    } else if (localJobId) {
      const mapped = getJobRowByLocalOrServerId(localJobId);
      localJobId = mapped ? mapped.id : null;
    }
    if (!localJobId) localJobId = resolveLocalJobIdForFab(technicianId, fabValue);
    if (localJobId) {
      try {
        const dienstreisePath = resolveProjekteNeuLocalFilePath(localJobId, fabValue, pnPath, resolveOpts);
        if (dienstreisePath) return dienstreisePath;
      } catch (_) {
        /* ignore */
      }
    }
    return readCachedProjekteNeuFile(DB_DIR, fabValue, pnPath);
  }

  function cacheKeyProjekteNeuThumb(fabValue, pnPath, thumbMax) {
    return String(fabValue || '') + '\0' + String(pnPath || '') + '\0' + String(thumbMax || 256);
  }

  let thumbDbSaveTimer = null;
  function scheduleThumbDbSave() {
    if (thumbDbSaveTimer) return;
    thumbDbSaveTimer = setTimeout(() => {
      thumbDbSaveTimer = null;
      try {
        if (monteurRuntime.save) monteurRuntime.save();
      } catch (_) {
        /* ignore */
      }
    }, 400);
  }

  function thumbBufferLooksLikeImage(buf, contentType) {
    if (!buf || !buf.length) return false;
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('json') || ct.includes('text/html') || ct.includes('text/plain')) return false;
    if (ct.startsWith('image/')) return true;
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return true;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) return true;
    if (buf[0] === 0x89 && buf[1] === 0x50) return true;
    return false;
  }

  async function fetchDispoProjekteNeuThumb(technicianId, fabValue, pnPath, thumbMax) {
    const creds = loadDispoWebSessionCreds();
    const base = String(creds.baseUrl || '').trim().replace(/\/$/, '');
    if (!base || !technicianId || !fabValue || !pnPath) return null;
    const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
    const url =
      `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}` +
      `&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}` +
      `&thumb=1&thumb_max=${encodeURIComponent(String(thumbMax || 256))}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth), signal: ac.signal });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = String(r.headers.get('content-type') || 'image/webp').split(';')[0].trim();
      if (!thumbBufferLooksLikeImage(buf, ct)) return null;
      return { buf, contentType: ct || 'image/webp' };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateAndCacheProjekteNeuThumb(fabValue, pnPath, thumbMax, filePath) {
    const thumbOut = await buildProjekteNeuThumbnailBuffer(filePath, thumbMax);
    try {
      writeCachedProjekteNeuThumb(
        db,
        DB_DIR,
        fabValue,
        pnPath,
        thumbMax,
        thumbOut.buf,
        thumbOut.contentType,
        filePath,
      );
      scheduleThumbDbSave();
    } catch (_) {
      /* ignore */
    }
    return thumbOut;
  }

  async function fillProjekteNeuThumbCache(technicianId, fabValue, pnPath, thumbMax, filePathOpt) {
    const cached = readCachedProjekteNeuThumb(db, DB_DIR, fabValue, pnPath, thumbMax, null);
    if (cached && cached.buf && cached.buf.length) return cached;
    let filePath = filePathOpt || readCachedProjekteNeuFile(DB_DIR, fabValue, pnPath);
    if (filePath) {
      return generateAndCacheProjekteNeuThumb(fabValue, pnPath, thumbMax, filePath);
    }
    const remote = await fetchDispoProjekteNeuThumb(technicianId, fabValue, pnPath, thumbMax);
    if (remote) {
      try {
        writeCachedProjekteNeuThumb(
          db,
          DB_DIR,
          fabValue,
          pnPath,
          thumbMax,
          remote.buf,
          remote.contentType,
          null,
        );
        scheduleThumbDbSave();
      } catch (_) {
        /* ignore */
      }
      return remote;
    }
    return null;
  }

  function enqueueProjekteNeuThumbFill(technicianId, fabValue, pnPath, thumbMax, filePathOpt) {
    return projekteNeuThumbQueue.enqueue(
      { key: cacheKeyProjekteNeuThumb(fabValue, pnPath, thumbMax) },
      () => fillProjekteNeuThumbCache(technicianId, fabValue, pnPath, thumbMax, filePathOpt),
    );
  }

  function enqueueProjekteNeuThumb(fabValue, pnPath, thumbMax, filePath) {
    return enqueueProjekteNeuThumbFill('', fabValue, pnPath, thumbMax, filePath);
  }

  function sendProjekteNeuThumbResponse(res, thumbOut, cacheStatus) {
    res.setHeader('X-Thumb-Cache', cacheStatus || 'hit');
    res.setHeader('Content-Type', thumbOut.contentType);
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.setHeader('Content-Length', String(thumbOut.buf.length));
    return res.send(thumbOut.buf);
  }

  async function serveProjekteNeuThumb(res, technicianId, fabValue, pnPath, thumbMax, filePathOpt, opts) {
    const preferCache =
      !!(opts && opts.preferCache) ||
      String((opts && opts.preferCacheRaw) || '').toLowerCase() === '1' ||
      String((opts && opts.preferCacheRaw) || '').toLowerCase() === 'true';
    const cachedThumb = readCachedProjekteNeuThumb(db, DB_DIR, fabValue, pnPath, thumbMax, null);
    if (cachedThumb && cachedThumb.buf && cachedThumb.buf.length) {
      return sendProjekteNeuThumbResponse(res, cachedThumb, 'hit');
    }
    if (preferCache) {
      enqueueProjekteNeuThumbFill(technicianId, fabValue, pnPath, thumbMax, filePathOpt).catch(() => {});
      res.setHeader('X-Thumb-Cache', 'miss');
      res.setHeader('Retry-After', '1');
      return res.status(204).end();
    }
    const thumbOut = await enqueueProjekteNeuThumbFill(
      technicianId,
      fabValue,
      pnPath,
      thumbMax,
      filePathOpt,
    );
    if (!thumbOut || !thumbOut.buf || !thumbOut.buf.length) {
      return res.status(404).json({ ok: false, error: 'thumb_not_image', local_unavailable: true });
    }
    return sendProjekteNeuThumbResponse(res, thumbOut, 'generated');
  }

  prewarmAnlagenstammGalleryThumbsImpl = function prewarmAnlagenstammGalleryThumbs(fab, gallery, technicianId) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm || !Array.isArray(gallery) || !gallery.length) return;
    const techId = technicianId || getTechnicianId({ headers: {} }) || '';
    for (const it of gallery) {
      const rel = String((it && (it.rel_path || it.rel)) || '').trim();
      if (!rel) continue;
      const cached = readCachedProjekteNeuThumb(db, DB_DIR, fabNorm, rel, 256, null);
      if (cached && cached.buf && cached.buf.length) continue;
      enqueueProjekteNeuThumbFill(techId, fabNorm, rel, 256, null).catch(() => {});
    }
  };

  function cacheProjekteNeuTreesForJob(localJobId) {
    const jobRow = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
    if (!jobRow) return;
    const fabs = fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern);
    const fabNums = [...fabs].sort((a, b) => compareFabrikationsnummerKeys(a, b));
    for (const fabNum of fabNums) {
      const fab = String(fabNum);
      const cached = readAnlagenstammTreeCache(db, fab);
      if (cached && Array.isArray(cached.tree) && cached.tree.length > 0) {
        ingestProjekteNeuParameterTree(localJobId, fab, cached.tree);
      }
    }
    save();
  }

  function resolveLocalJobIdForFab(technicianId, fab) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm || !technicianId) return null;
    const jobs = db
      .prepare(
        `SELECT j.id FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         ORDER BY j.id DESC`,
      )
      .all(technicianId);
    let bestPullId = null;
    let bestPullTs = 0;
    let bestCtxId = null;
    let bestCtxTs = 0;
    for (const row of jobs) {
      const jid = row.id;
      const pull = db
        .prepare(
          `SELECT updated_at, status FROM background_jobs
           WHERE type = 'dienstreise_pull' AND status = 'completed'
             AND dedupe_key LIKE ? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get('dienstreise_pull:' + jid + ':%');
      const pullTs = pull && pull.updated_at ? Date.parse(String(pull.updated_at).replace(' ', 'T') + 'Z') : 0;
      const ctx = getProjekteNeuLocalContext(jid, fabNorm);
      if (!ctx) continue;
      if (pullTs > 0 && pullTs >= bestPullTs) {
        bestPullId = jid;
        bestPullTs = pullTs;
      }
      const ctxTs = pullTs || Date.now();
      if (!bestCtxId || ctxTs >= bestCtxTs) {
        bestCtxId = jid;
        bestCtxTs = ctxTs;
      }
    }
    return bestPullId != null ? bestPullId : bestCtxId;
  }

  app.get('/api/dienstreise/projekte_neu_tree', (req, res) => {
    try {
      const rawJobId = parseInt(req.query.job_id, 10);
      const fab = String(req.query.fab || '').trim();
      const rescan = req.query.rescan === '1' || req.query.rescan === 'true';
      if (!rawJobId || !fab) return res.status(400).json({ ok: false, error: 'job_id und fab erforderlich.' });
      const calTechId = getTechnicianId(req);
      let jobId = rawJobId;
      if (calTechId) {
        const resolved = resolveLocalJobIdForTechnician(db, calTechId, rawJobId, { mode: 'auto' });
        if (!resolved.ok) {
          return res.status(resolved.status || 404).json({ ok: false, error: resolved.error });
        }
        jobId = resolved.localId;
      } else {
        const mapped = getJobRowByLocalOrServerId(rawJobId);
        jobId = mapped ? mapped.id : rawJobId;
      }
      if (!rescan) {
        const cached = readAnlagenstammTreeCache(db, fab);
        if (cached && cached.tree.length > 0) {
          const folderFromCache =
            (cached.root_folder_name && String(cached.root_folder_name).trim()) ||
            readAnlagenstammRootFolderName(db, fab) ||
            '';
          return res.json({
            ok: true,
            local: true,
            enabled: true,
            tree: cached.tree,
            from_cache: true,
            synced_at: cached.synced_at,
            job_id: jobId,
            folder: folderFromCache,
          });
        }
        const suggested = canonicalProjekteNeuFolderForJob(jobId, fab);
        return res.json({
          ok: true,
          local: false,
          enabled: false,
          tree: [],
          folder: suggested || '',
          from_cache: false,
          message: 'Kein lokaler PROJEKTE-NEU-Cache für diese FN.',
        });
      }
      const ctx = getProjekteNeuLocalContext(jobId, fab);
      if (!ctx) {
        const suggested = canonicalProjekteNeuFolderForJob(jobId, fab);
        return res.json({
          ok: true,
          local: false,
          enabled: false,
          tree: [],
          folder: suggested || '',
          message: 'Kein lokaler PROJEKTE-NEU-Ordner für diese FN.',
        });
      }
      const scanned = scanProjekteNeuTree(ctx.resolved.root, {});
      upsertAnlagenstammTreeCache(
        db,
        fab,
        { enabled: true, tree: scanned.tree, folder_name: ctx.resolved.folderName },
        { root_folder_name: ctx.resolved.folderName },
      );
      ingestProjekteNeuParameterTree(jobId, fab, scanned.tree);
      save();
      return res.json({
        ok: true,
        local: true,
        enabled: true,
        tree: scanned.tree,
        truncated: scanned.truncated,
        folder: ctx.resolved.folderName,
        job_id: jobId,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/anlagenstamm/projekte_neu_resolve_local', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const fab = String(req.query.fab || '').trim();
      if (!technicianId || !fab) return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
      const jobId = resolveLocalJobIdForFab(technicianId, fab);
      if (!jobId) {
        return res.json({ ok: true, found: false, job_id: null });
      }
      return res.json({ ok: true, found: true, job_id: jobId });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/dienstreise/projekte_neu_file', async (req, res) => {
    try {
      const rawJobId = parseInt(req.query.job_id, 10);
      const fab = String(req.query.fab || '').trim();
      const relPath = String(req.query.path || '').trim();
      const wantThumb = String(req.query.thumb || '').toLowerCase() === '1' || req.query.thumb === 'true';
      const wantInline = String(req.query.inline || '').toLowerCase() === '1' || req.query.inline === 'true';
      let thumbMax = parseInt(req.query.thumbMax || req.query.thumb_max, 10);
      if (!Number.isFinite(thumbMax)) thumbMax = 256;
      thumbMax = Math.min(512, Math.max(64, thumbMax));
      if (!rawJobId || !fab || !relPath) {
        return res.status(400).json({ ok: false, error: 'job_id, fab und path erforderlich.' });
      }
      const calTechId = getTechnicianId(req);
      let jobId = rawJobId;
      if (calTechId) {
        const resolved = resolveLocalJobIdForTechnician(db, calTechId, rawJobId, { mode: 'auto' });
        if (!resolved.ok) {
          return res.status(resolved.status || 404).json({ ok: false, error: resolved.error });
        }
        jobId = resolved.localId;
      } else {
        const mapped = getJobRowByLocalOrServerId(rawJobId);
        jobId = mapped ? mapped.id : rawJobId;
      }
      const filePath = resolveProjekteNeuLocalFilePath(jobId, fab, relPath, { skipDeepSearch: wantThumb });
      if (!filePath) {
        return res.status(404).json({ ok: false, error: 'local_unavailable', message: 'Datei nicht lokal gefunden.' });
      }
      const baseName = path.basename(filePath);
      if (wantThumb) {
        return serveProjekteNeuThumb(res, getTechnicianId(req), fab, relPath, thumbMax, filePath);
      }
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(baseName).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.bmp': 'image/bmp',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
      };
      const ct = mimeMap[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader(
        'Content-Disposition',
        (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
      );
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/dienstreise', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const startDate = (body.startDate || body.start_date || '').trim().slice(0, 10);
      const companyName = (body.companyName || body.company_name || '').trim();
      const city = (body.city || '').trim();
      const countryCode = (body.countryCode || body.country_code || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !companyName) {
        return res.status(400).json({ ok: false, error: 'Startdatum (YYYY-MM-DD) und Firmenname erforderlich.' });
      }
      const basePath = body.basePath != null ? body.basePath : getDienstreiseBasePath();
      const result = createDienstreiseFolder(basePath, startDate, companyName, city, countryCode);
      const runResult = db.prepare('INSERT INTO dienstreisen (year, running_number, start_date, company_name, city, country_code, folder_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        result.year, result.runningNumber, startDate, companyName, city, countryCode, result.folderName
      );
      const row = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen WHERE id = ?').get(runResult.lastInsertRowid);
      const fullPath = getDienstreiseFullPath(row);
      res.json({ ok: true, dienstreise: { ...row, fullPath } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Anlegen fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/sync_to_dispo', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id, 10);
      const dispoBaseUrl = (body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technician_id, 10);
      const dispoUsername = (body.dispo_username || '').trim();
      const dispoPassword = (body.dispo_password != null ? String(body.dispo_password) : '');
      const drGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (drGate) return res.status(drGate.status).json({ ok: false, error: drGate.error });
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const dedupeKey = 'dienstreise_push:' + localJobId;
      const { job_id } = bgJobs.enqueue(
        'dienstreise_push',
        {
          job_id: localJobId,
          dispo_base_url: dispoBaseUrl,
          technician_id: technicianId,
          dispo_username: dispoUsername,
          dispo_password: dispoPassword,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Sync zum Dispo-Server fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/copy_project', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const rawJobId = parseInt(body.job_id, 10);
      const dispoBaseUrl = (body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technician_id, 10);
      const dispoUsername = (body.dispo_username || '').trim();
      const dispoPassword = (body.dispo_password != null ? String(body.dispo_password) : '');

      if (!rawJobId || !dispoBaseUrl || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal), dispo_base_url und technician_id erforderlich.' });
      }

      const drGateCopy = gateDienstreiseWrite(db, technicianId, rawJobId);
      if (drGateCopy) return res.status(drGateCopy.status).json({ ok: false, error: drGateCopy.error });

      const jobRow = getJobRowByLocalOrServerId(rawJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobRow.id);
      const folderGate = dienstreiseProjectFolderBlocked(statusRow ? statusRow.status : null);
      if (folderGate) return res.status(folderGate.status).json({ ok: false, error: folderGate.error });
      const jobId = jobRow.server_id != null ? jobRow.server_id : jobRow.id;

      const targetDir = getOrCreateDienstreiseFolderForJob(jobRow.id);
      if (!targetDir || !fs.existsSync(targetDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });

      const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};

      async function listEntries(relPath) {
        const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
        const url = dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + jobId + pathQ;
        const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
        const r = await fetch(url, opts);
        if (!r.ok) {
          const msg = r.status === 404
            ? 'Dispo-Liste fehlgeschlagen: 404 – URL prüfen (Server-Adresse in Einstellungen). Aufgerufene URL: ' + url
            : 'Dispo-Liste fehlgeschlagen: ' + r.status;
          throw new Error(msg);
        }
        const data = await r.json();
        return (data && data.entries) ? data.entries : [];
      }

      async function downloadFile(relPath, localPath) {
        const url = dispoBaseUrl + '/api/job_project_file_download.php?technician_id=' + technicianId + '&job_id=' + jobId + '&path=' + encodeURIComponent(relPath);
        const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error('Download fehlgeschlagen: ' + relPath + ' (' + r.status + ')');
        const buf = Buffer.from(await r.arrayBuffer());
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, buf);
      }

      async function copyRecursive(relPath) {
        const entries = await listEntries(relPath);
        for (const e of entries) {
          const name = e.name || '';
          if (!name || name === '.' || name === '..') continue;
          const childRel = relPath ? relPath + '/' + name : name;
          const localFull = path.join(targetDir, childRel.replace(/\//g, path.sep));
          if (e.type === 'dir') {
            if (!fs.existsSync(localFull)) fs.mkdirSync(localFull, { recursive: true });
            await copyRecursive(childRel);
          } else if (e.type === 'file') {
            await downloadFile(childRel, localFull);
          }
        }
      }

      await copyRecursive('');
      try {
        const layoutCopy = await ensureJobReiseFolderLayout(jobRow.id, targetDir, technicianId);
        await migrateTopLevelMontageIntoFnFolders(targetDir, (layoutCopy && layoutCopy.fabMap) || []);
      } catch (_) {}
      res.json({ ok: true, message: 'Projektordner wurde in den Dienstreise-Ordner kopiert.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Kopieren fehlgeschlagen.' });
    }
  });

  const DIENSTREISE_DELTA_MIN_INTERVAL_MS = 5 * 60 * 1000;

  function parseBackgroundJobTimestamp(ts) {
    if (!ts) return 0;
    const n = Date.parse(String(ts).replace(' ', 'T') + 'Z');
    return Number.isFinite(n) ? n : 0;
  }

  function loadLastCompletedDienstreisePullCheckpoint(localJobId) {
    const row = db
      .prepare(
        `SELECT checkpoint_json FROM background_jobs
         WHERE type = 'dienstreise_pull' AND status = 'completed'
           AND dedupe_key LIKE ? ORDER BY datetime(updated_at) DESC LIMIT 1`,
      )
      .get('dienstreise_pull:' + localJobId + ':%');
    if (!row || !row.checkpoint_json) return null;
    try {
      return JSON.parse(row.checkpoint_json);
    } catch (_) {
      return null;
    }
  }

  function lastDienstreisePullCompletedAtMs(localJobId) {
    const row = db
      .prepare(
        `SELECT updated_at FROM background_jobs
         WHERE type = 'dienstreise_pull' AND status = 'completed'
           AND dedupe_key LIKE ? ORDER BY datetime(updated_at) DESC LIMIT 1`,
      )
      .get('dienstreise_pull:' + localJobId + ':%');
    return parseBackgroundJobTimestamp(row && row.updated_at);
  }

  /** Aufträge mit lokalem Reise-Ordner, die nach regulärem sync_pull Projektdateien nachziehen sollen. */
  function listLocalJobsForPeriodicDienstreisePull(technicianId) {
    const tid = parseInt(technicianId, 10);
    if (!Number.isFinite(tid) || tid <= 0) return [];
    const rows = db
      .prepare(
        `SELECT DISTINCT j.id, j.server_id, j.status
         FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         WHERE j.server_id IS NOT NULL AND TRIM(CAST(j.server_id AS TEXT)) != ''
           AND LOWER(TRIM(COALESCE(j.status, ''))) = 'in_arbeit'
         ORDER BY j.id DESC`,
      )
      .all(tid);
    const out = [];
    for (const row of rows) {
      const reiseDir = resolveDienstreiseReiseDirForJob(row.id, { createIfMissing: false });
      if (!reiseDir || !fs.existsSync(reiseDir)) continue;
      out.push(row);
    }
    return out;
  }

  /**
   * Nach sync_pull: inkrementeller dienstreise_pull (nur Änderungen) für offene Aufträge mit Projektordner.
   * @returns {{ enqueued: number, skipped: number }}
   */
  function enqueuePeriodicDienstreiseDeltaPulls(opts) {
    if (!bgJobs) return { enqueued: 0, skipped: 0, job_ids: [] };
    const dispoBaseUrl = (opts.dispoBaseUrl || '').trim().replace(/\/$/, '');
    const technicianId = parseInt(opts.technicianId, 10);
    const dispoUsername = (opts.dispoUsername || '').trim();
    const dispoPassword = opts.dispoPassword != null ? String(opts.dispoPassword) : '';
    const force = !!(opts && opts.force);
    if (!dispoBaseUrl || !Number.isFinite(technicianId) || technicianId <= 0) {
      return { enqueued: 0, skipped: 0, job_ids: [] };
    }
    if (!dispoUsername && !dispoPassword) return { enqueued: 0, skipped: 0, job_ids: [] };
    const jobs = listLocalJobsForPeriodicDienstreisePull(technicianId);
    let enqueued = 0;
    let skipped = 0;
    const jobIds = [];
    const now = Date.now();
    for (const row of jobs) {
      const localJobId = row.id;
      const lastMs = lastDienstreisePullCompletedAtMs(localJobId);
      if (!force && lastMs > 0 && now - lastMs < DIENSTREISE_DELTA_MIN_INTERVAL_MS) {
        skipped++;
        continue;
      }
      const dedupeKey = 'dienstreise_pull:' + localJobId + ':copy';
      const { job_id: pullJobId } = bgJobs.enqueue(
        'dienstreise_pull',
        {
          job_id: localJobId,
          dispo_base_url: dispoBaseUrl,
          externalUrl: opts.externalUrl,
          internalUrl: opts.internalUrl,
          technician_id: technicianId,
          dispo_username: dispoUsername,
          dispo_password: dispoPassword,
          include_bilder: true,
          accept_job: false,
          periodic_delta: true,
        },
        dedupeKey,
      );
      if (pullJobId) jobIds.push(pullJobId);
      enqueued++;
    }
    return { enqueued, skipped, job_ids: jobIds };
  }

  const PREVIEW_DISPO_TIMEOUT_MS = 20000;
  const PREVIEW_RESOLVE_BASE_MS = 15000;

  function previewFetchSignal(timeoutMs) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), timeoutMs != null ? timeoutMs : PREVIEW_DISPO_TIMEOUT_MS);
    return ac.signal;
  }

  function buildLocalAcceptOfflinePreview(localJobId, technicianId, degradedHint, onlyFabs) {
    const jobDetail = lookupDienstreiseJobRow(localJobId);
    if (!jobDetail) throw new Error('Auftrag nicht gefunden.');
    const montageFolderName = buildMonteurMontageFolderName(jobDetail, getTechnicianDisplayName(technicianId));
    const fabsOut = [];
    const fabNumsPreview = filterFabNumsByOnlyFabs(
      [...fabNumbersFromJobFabrikationsnummern(jobDetail.fabrikationsnummern)].sort((a, b) =>
        compareFabrikationsnummerKeys(a, b),
      ),
      onlyFabs,
    );
    for (const fabNum of fabNumsPreview) {
      const fab = String(fabNum);
      let folder_name_canonical = '';
      const cachedRoot = readAnlagenstammRootFolderName(db, fab);
      if (cachedRoot && !isBareFabFolderName(cachedRoot)) folder_name_canonical = cachedRoot;
      if (!folder_name_canonical || isBareFabFolderName(folder_name_canonical)) {
        folder_name_canonical = buildCanonicalFabFolderName(fab, jobDetail);
      }
      rememberSuggestedFnFolder(fab, folder_name_canonical);
      fabsOut.push({ fab, folder_name_canonical, tree: [] });
    }
    return {
      ok: true,
      preview_degraded: true,
      hint:
        degradedHint ||
        'Server-Ordnerliste nicht verfügbar – „Keine“ für nur Status/Struktur oder erneut versuchen.',
      fabs: fabsOut,
      montage_folder_name: montageFolderName,
      fab_map: fabsOut.map((f) => ({ fab: f.fab, folder_name_canonical: f.folder_name_canonical })),
    };
  }

  async function resolveDispoBaseForPreview(creds, technicianId) {
    const fallback = String(creds.baseUrl || creds.externalUrl || '')
      .trim()
      .replace(/\/$/, '');
    try {
      const resolved = await Promise.race([
        resolveDispoWorkingBase({
          baseUrl: creds.baseUrl,
          externalUrl: creds.externalUrl,
          internalUrl: creds.internalUrl,
          technicianId,
          serverUsername: creds.serverUsername,
          serverPassword: creds.serverPassword,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Dispo-Basis-URL: Zeitüberschreitung')), PREVIEW_RESOLVE_BASE_MS);
        }),
      ]);
      if (resolved && resolved.base) return resolved.base;
    } catch (e) {
      console.warn('[accept_offline_preview] resolve base:', e && e.message ? e.message : e);
    }
    return fallback || null;
  }

  async function listDispoProjectEntries(dispoBaseUrl, serverJobId, technicianId, authHeader, relPath, signal) {
    const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
    const url =
      dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + serverJobId + pathQ;
    const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader), signal });
    const text = await r.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error('Dispo-Liste: ungültige Antwort (' + r.status + ').');
    }
    if (!r.ok || data.ok === false) {
      throw new Error((data && data.error) ? String(data.error) : 'Dispo-Liste fehlgeschlagen (HTTP ' + r.status + ').');
    }
    return Array.isArray(data.entries) ? data.entries : [];
  }

  /**
   * FN-Ordnernamen vom Fileserver (nicht nur Ziffer „7118“), für fab_map / Monteur-Pfade.
   */
  async function resolveFabMapCanonicalFolderNames(
    dispoBaseUrl,
    serverJobId,
    technicianId,
    authHeader,
    fabMapIn,
    jobFabNums,
    signal,
    jobDetail,
  ) {
    let monteurDirNames = [];
    try {
      const entries = await listDispoProjectEntries(
        dispoBaseUrl,
        serverJobId,
        technicianId,
        authHeader,
        'Dokumente_Monteur',
        signal,
      );
      monteurDirNames = entries
        .filter((e) => String(e.type || '').toLowerCase() === 'dir')
        .map((e) => e.name)
        .filter(Boolean);
    } catch (listErr) {
      console.warn(
        '[fab_map] Monteur-Listing:',
        listErr && listErr.message ? listErr.message : listErr,
      );
    }

    const byFab = new Map();
    for (const e of fabMapIn || []) {
      if (e && e.fab != null) byFab.set(String(e.fab).trim(), e);
    }
    const fabNums =
      jobFabNums && jobFabNums.length
        ? jobFabNums.map((f) => String(f).trim()).filter(Boolean)
        : [...byFab.keys()];
    if (!fabNums.length) return [];

    const jobIdQ =
      serverJobId != null && String(serverJobId).trim() !== ''
        ? '&job_id=' + encodeURIComponent(String(serverJobId))
        : '';
    const out = [];
    for (const fab of fabNums) {
      const existing = byFab.get(fab);
      let folder_name_canonical =
        existing && existing.folder_name_canonical != null
          ? String(existing.folder_name_canonical).trim()
          : '';

      if (!folder_name_canonical || folder_name_canonical === fab || isBareFabFolderName(folder_name_canonical)) {
        const fromList =
          resolveCanonicalProjekteNeuFolderName(monteurDirNames, fab) ||
          resolveCanonicalFolderFromDirList(monteurDirNames, fab);
        if (fromList) folder_name_canonical = fromList;
      }

      if (!folder_name_canonical || folder_name_canonical === fab || isBareFabFolderName(folder_name_canonical)) {
        try {
          const anlUrl =
            dispoBaseUrl +
            '/dispo_api/api/anlagenstamm_files_list.php?technician_id=' +
            encodeURIComponent(technicianId) +
            '&fab=' +
            encodeURIComponent(fab) +
            jobIdQ;
          const r = await fetch(anlUrl, {
            headers: dispoMonteurFetchHeaders(technicianId, authHeader),
            signal,
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data && data.projekte_neu) {
            const pn = data.projekte_neu;
            const fromApi =
              (pn.folder_name && String(pn.folder_name).trim()) ||
              (pn.root_name && String(pn.root_name).trim()) ||
              (pn.suggested_folder_name && String(pn.suggested_folder_name).trim()) ||
              '';
            if (fromApi) folder_name_canonical = fromApi;
          }
        } catch (_) {
          /* optional */
        }
      }

      if (!folder_name_canonical || folder_name_canonical === fab || isBareFabFolderName(folder_name_canonical)) {
        folder_name_canonical = buildCanonicalFabFolderName(fab, jobDetail);
      }
      if (!folder_name_canonical) folder_name_canonical = fab;
      rememberSuggestedFnFolder(fab, folder_name_canonical);
      out.push({ fab, folder_name_canonical });
    }
    return out;
  }

  async function buildAcceptOfflinePreview(localJobId, technicianId, dispoBaseUrl, authHeader, urlOpts) {
    const jobDetail = lookupDienstreiseJobRow(localJobId);
    if (!jobDetail) throw new Error('Auftrag nicht gefunden.');
    const serverJobId = jobDetail.server_id != null ? jobDetail.server_id : localJobId;
    const montageFolderName = buildMonteurMontageFolderName(jobDetail, getTechnicianDisplayName(technicianId));
    let monteurDirNames = [];
    try {
      const entries = await listDispoProjectEntries(
        dispoBaseUrl,
        serverJobId,
        technicianId,
        authHeader,
        'Dokumente_Monteur',
        previewFetchSignal(PREVIEW_DISPO_TIMEOUT_MS),
      );
      monteurDirNames = entries
        .filter((e) => String(e.type || '').toLowerCase() === 'dir')
        .map((e) => e.name)
        .filter(Boolean);
    } catch (listErr) {
      console.warn('[accept_offline_preview] Monteur-Listing:', listErr && listErr.message ? listErr.message : listErr);
    }
    const onlyFabs = urlOpts && urlOpts.onlyFabs ? urlOpts.onlyFabs : null;
    const fabNums = filterFabNumsByOnlyFabs(
      [...fabNumbersFromJobFabrikationsnummern(jobDetail.fabrikationsnummern)].sort((a, b) =>
        compareFabrikationsnummerKeys(a, b),
      ),
      onlyFabs,
    );
    const creds = resolveDispoServerCreds(urlOpts || {});
    const hdr =
      authHeader && authHeader.Authorization
        ? authHeader
        : authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);

    async function loadFabPreview(fabNum) {
      const fab = String(fabNum);
      let folder_name_canonical =
        resolveCanonicalProjekteNeuFolderName(monteurDirNames, fab) ||
        resolveCanonicalFolderFromDirList(monteurDirNames, fab);
      if (!folder_name_canonical || isBareFabFolderName(folder_name_canonical)) {
        folder_name_canonical = '';
      }
      let tree = [];
      const anlUrl =
        dispoBaseUrl +
        '/dispo_api/api/anlagenstamm_files_list.php?technician_id=' +
        encodeURIComponent(technicianId) +
        '&fab=' +
        encodeURIComponent(fab) +
        '&job_id=' +
        encodeURIComponent(String(serverJobId));
      try {
        const r = await fetch(anlUrl, {
          headers: dispoMonteurFetchHeaders(technicianId, hdr),
          signal: previewFetchSignal(PREVIEW_DISPO_TIMEOUT_MS),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data && data.projekte_neu) {
          try {
            upsertAnlagenstammTreeCache(db, fab, data.projekte_neu);
          } catch (_) {}
          if (Array.isArray(data.projekte_neu.tree)) {
            tree = buildOfflinePreviewTree(data.projekte_neu.tree);
          }
          const pn = data.projekte_neu;
          const fromApi =
            (pn.folder_name && String(pn.folder_name).trim()) ||
            (pn.root_name && String(pn.root_name).trim()) ||
            (pn.suggested_folder_name && String(pn.suggested_folder_name).trim()) ||
            '';
          if (fromApi) folder_name_canonical = fromApi;
        }
      } catch (anlErr) {
        console.warn('[accept_offline_preview] anlagenstamm', fab, anlErr && anlErr.message ? anlErr.message : anlErr);
      }
      if (!folder_name_canonical || isBareFabFolderName(folder_name_canonical)) {
        folder_name_canonical = buildCanonicalFabFolderName(fab, jobDetail);
      }
      rememberSuggestedFnFolder(fab, folder_name_canonical);
      if (!tree.length && folder_name_canonical) {
        try {
          const subPath = 'Dokumente_Monteur/' + folder_name_canonical;
          const subEntries = await listDispoProjectEntries(
            dispoBaseUrl,
            serverJobId,
            technicianId,
            authHeader,
            subPath,
            previewFetchSignal(PREVIEW_DISPO_TIMEOUT_MS),
          );
          tree = subEntries
            .filter((e) => String(e.type || '').toLowerCase() === 'dir')
            .map((e) => ({ name: e.name, rel: e.name, children: [] }));
        } catch (subErr) {
          console.warn('[accept_offline_preview] subdirs', fab, subErr && subErr.message ? subErr.message : subErr);
        }
      }
      return { fab, folder_name_canonical, tree };
    }

    const fabsOut = await Promise.all(fabNums.map((fn) => loadFabPreview(fn)));
    const anyTree = fabsOut.some((f) => f.tree && f.tree.length > 0);
    return {
      ok: true,
      preview_degraded: !anyTree && monteurDirNames.length === 0,
      hint: !anyTree && monteurDirNames.length === 0
        ? 'Keine Server-Ordner geladen – „Keine“ für nur Status/Struktur oder erneut versuchen.'
        : undefined,
      fabs: fabsOut,
      montage_folder_name: montageFolderName,
      fab_map: fabsOut.map((f) => ({ fab: f.fab, folder_name_canonical: f.folder_name_canonical })),
    };
  }

  app.post('/api/dienstreise/accept_offline', express.json(), async (req, res) => {
    try {
      const result = await performAcceptJobOffline(req.body || {});
      return res.json(result);
    } catch (e) {
      const status = e && e.httpStatus ? e.httpStatus : 500;
      return res.status(status).json({ ok: false, error: e.message || 'Offline-Annahme fehlgeschlagen.' });
    }
  });

  app.get('/api/dienstreise/accept_offline_preview', async (req, res) => {
    try {
      const rawJobId = parseInt(req.query.job_id, 10);
      const technicianId = getTechnicianId(req) || parseInt(req.query.technician_id, 10);
      if (!rawJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const mapped = getJobRowByLocalOrServerId(rawJobId);
      const localJobId = mapped ? mapped.id : rawJobId;
      const onlyFabs = parseOnlyFabsFilter(req.query.only_fabs || req.query.onlyFabs);
      const preferLocal =
        wantsLocalOnlyRequest(req.query) ||
        req.query.local_first === '1' ||
        req.query.local_first === 'true' ||
        String(req.query.prefer_local || '') === '1';
      // Offline-First: View-Open nutzt local_first=1; Dispo nur bei explizitem Sync/ohne Flag
      if (preferLocal) {
        return res.json(
          buildLocalAcceptOfflinePreview(
            localJobId,
            technicianId,
            'Lokale Vorschau — vollständige Dateiliste nach Sync/Online-Accept.',
            onlyFabs,
          ),
        );
      }
      const creds = resolveDispoServerCreds({
        baseUrl: req.query.dispoBaseUrl || req.query.dispo_base_url,
        externalUrl: req.query.externalUrl,
        internalUrl: req.query.internalUrl,
        dispo_username: req.query.dispo_username,
        dispo_password: req.query.dispo_password,
      });
      const authHeader = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword) || {};
      if (!authHeader.Authorization) {
        return res.json(
          buildLocalAcceptOfflinePreview(
            localJobId,
            technicianId,
            'Dispo-Zugangsdaten fehlen – nur lokale Struktur/Status.',
            onlyFabs,
          ),
        );
      }
      const resolved = await resolveDispoBaseForPreview(creds, technicianId);
      if (!resolved) {
        return res.json(
          buildLocalAcceptOfflinePreview(
            localJobId,
            technicianId,
            'Dispo nicht erreichbar – „Keine“ für nur Status offline.',
            onlyFabs,
          ),
        );
      }
      try {
        const preview = await buildAcceptOfflinePreview(localJobId, technicianId, resolved, authHeader, {
          ...creds,
          onlyFabs,
        });
        return res.json(preview);
      } catch (buildErr) {
        console.warn('[accept_offline_preview] build:', buildErr && buildErr.message ? buildErr.message : buildErr);
        return res.json(
          buildLocalAcceptOfflinePreview(
            localJobId,
            technicianId,
            buildErr && buildErr.message ? String(buildErr.message) : 'Vorschau eingeschränkt.',
            onlyFabs,
          ),
        );
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      try {
        const mapped = getJobRowByLocalOrServerId(parseInt(req.query.job_id, 10));
        const technicianId = getTechnicianId(req) || parseInt(req.query.technician_id, 10);
        const onlyFabs = parseOnlyFabsFilter(req.query.only_fabs || req.query.onlyFabs);
        if (mapped && technicianId) {
          return res.json(buildLocalAcceptOfflinePreview(mapped.id, technicianId, msg, onlyFabs));
        }
      } catch (_) {}
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  /** Nach allen festen /api/dienstreise/…-Pfaden — :id würde sonst z. B. accept_offline_preview abfangen. */
  function resolveLocalJobIdForProtectedPaths(reqJobId, technicianId) {
    const jobId = parseInt(reqJobId, 10);
    if (!jobId) return { error: 'job_id erforderlich.', status: 400 };
    if (technicianId && Number.isFinite(technicianId) && technicianId > 0) {
      const resolved = resolveLocalJobIdForTechnician(db, technicianId, jobId, { mode: 'auto' });
      if (!resolved.ok) {
        return { error: resolved.error || 'Auftrag nicht gefunden.', status: resolved.status || 404 };
      }
      return { localJobId: resolved.localId };
    }
    const mapped = getJobRowByLocalOrServerId(jobId);
    if (!mapped) return { error: 'Auftrag nicht gefunden.', status: 404 };
    return { localJobId: mapped.id };
  }

  // Muss VOR /api/dienstreise/:id stehen, sonst matcht :id = "protected_paths".
  app.get('/api/dienstreise/protected_paths', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const resolved = resolveLocalJobIdForProtectedPaths(req.query.job_id, technicianId);
      if (resolved.error) {
        return res.status(resolved.status || 400).json({ ok: false, error: resolved.error });
      }
      const localJobId = resolved.localJobId;
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      const paths = seedDokumenteMonteurProtectedPaths(
        db,
        localJobId,
        reiseDir && fs.existsSync(reiseDir) ? reiseDir : null,
        isIgnorableDirEntry,
      );
      save();
      res.json({ ok: true, job_id: localJobId, paths });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Laden fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/protected_paths', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const resolved = resolveLocalJobIdForProtectedPaths(
        body.job_id != null ? body.job_id : body.jobId,
        technicianId,
      );
      if (resolved.error) {
        return res.status(resolved.status || 400).json({ ok: false, error: resolved.error });
      }
      const localJobId = resolved.localJobId;
      const relativePath = normalizeProtectedRelPath(
        body.relative_path != null ? body.relative_path : body.relativePath,
      );
      if (!relativePath) {
        return res.status(400).json({ ok: false, error: 'relative_path erforderlich.' });
      }
      const protectedFlag =
        body.protected === true ||
        body.protected === 1 ||
        body.protected === '1' ||
        body.protected === 'true';
      const cascade =
        body.cascade === true ||
        body.cascade === 1 ||
        body.cascade === '1' ||
        body.cascade === 'true';
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      if (!isProtectedPathsInitialized(db, localJobId)) {
        seedDokumenteMonteurProtectedPaths(
          db,
          localJobId,
          reiseDir && fs.existsSync(reiseDir) ? reiseDir : null,
          isIgnorableDirEntry,
        );
      }
      const result = setProtectedPathState(db, localJobId, relativePath, protectedFlag, {
        cascade,
        reiseDir: reiseDir && fs.existsSync(reiseDir) ? reiseDir : null,
        isIgnorable: isIgnorableDirEntry,
      });
      save();
      res.json({
        ok: true,
        job_id: localJobId,
        paths: result.paths,
        added: result.added,
        removed: result.removed,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Speichern fehlgeschlagen.' });
    }
  });

  app.get('/api/dienstreise/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'id fehlt.' });
    const row = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Dienstreise nicht gefunden.' });
    const fullPath = getDienstreiseFullPath(row);
    res.json({ ok: true, dienstreise: { ...row, fullPath } });
  });

  /**
   * Queued Hintergrund-Job: Dispo-Refresh, Projektordner kopieren, optional Auftrag annehmen.
   * @param {{ acceptJob?: boolean }} options
   */
  async function enqueueDienstreisePullFromRequest(req, res, options) {
    const acceptJob = !!(options && options.acceptJob);
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const body = req.body || {};
      const rawJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      let dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const externalUrl = (body.externalUrl || body.dispoExternalUrl || '').trim();
      const internalUrl = (body.internalUrl || body.dispoInternalUrl || '').trim();
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword =
        body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '';
      const includeBilder = !!body.include_bilder;

      if (!rawJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal) und technicianId erforderlich.' });
      }

      const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};

      const resolvedBase = await resolveDispoWorkingBase({
        baseUrl: dispoBaseUrl,
        externalUrl,
        internalUrl,
        technicianId,
        serverUsername: dispoUsername,
        serverPassword: dispoPassword,
      });
      if (resolvedBase.base) {
        dispoBaseUrl = resolvedBase.base;
      }
      if (!dispoBaseUrl) {
        if (acceptJob) {
          try {
            const result = await performAcceptJobOffline({
              job_id: rawJobId,
              technician_id: technicianId,
              offline_paths: body.offline_paths,
              fab_map: body.fab_map,
              montage_folder_name: body.montage_folder_name,
            });
            result.hint =
              (result.hint || 'Lokal angenommen.') +
              ' Dateien später nachziehen. (' +
              (resolvedBase.error || 'Dispo nicht erreichbar.') +
              ')';
            return res.json(result);
          } catch (offlineErr) {
            const status = offlineErr && offlineErr.httpStatus ? offlineErr.httpStatus : 500;
            return res.status(status).json({
              ok: false,
              error: offlineErr.message || 'Offline-Annahme fehlgeschlagen.',
            });
          }
        }
        return res.status(502).json({
          ok: false,
          error: resolvedBase.error || 'Keine erreichbare Dispo-URL für Projektordner.',
        });
      }

      const resolvedJob = resolveLocalJobIdForTechnician(db, technicianId, rawJobId, { mode: 'auto' });
      if (!resolvedJob.ok) {
        return res.status(resolvedJob.status).json({ ok: false, error: resolvedJob.error, code: resolvedJob.conflict ? 'job_id_conflict' : undefined });
      }
      const assignGate = requireJobAssignedToTechnician(db, resolvedJob.localId, technicianId);
      if (assignGate) {
        return res.status(assignGate.status).json({ ok: false, error: assignGate.error });
      }

      let jobRowFull = db.prepare('SELECT id, server_id, status FROM jobs WHERE id = ?').get(resolvedJob.localId);
      if (!jobRowFull) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });

      if (acceptJob && authHeader.Authorization) {
        jobRowFull = await reconcileLocalJobStatusFromDispoBeforeAccept(resolvedJob.localId, dispoBaseUrl, technicianId, authHeader);
        if (!jobRowFull) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }

      if (acceptJob) {
        const st = String(jobRowFull.status || '').trim().toLowerCase();
        if (st === 'in_arbeit') {
          return res.status(400).json({ ok: false, error: 'Auftrag ist bereits in Arbeit.' });
        }
        if (st === 'erledigt' || st === 'abgerechnet') {
          return res.status(400).json({ ok: false, error: 'Auftrag kann in diesem Status nicht angenommen werden.' });
        }
        if (!jobStatusAllowsAcceptJob(jobRowFull.status)) {
          return res.status(400).json({ ok: false, error: 'Auftrag kann nur im Status Angelegt oder Zugeteilt angenommen werden.' });
        }
      } else {
        const drGateStream = gateDienstreiseWrite(db, technicianId, resolvedJob.localId);
        if (drGateStream) return res.status(drGateStream.status).json({ ok: false, error: drGateStream.error });
        const folderGate = dienstreiseProjectFolderBlocked(jobRowFull.status);
        if (folderGate) {
          return res.status(folderGate.status).json({ ok: false, error: folderGate.error });
        }
      }

      const localJobId = jobRowFull.id;
      const targetDir = getOrCreateDienstreiseFolderForJob(localJobId, {
        skipAssignmentCheck: true,
        technicianId,
      });
      if (!targetDir || !fs.existsSync(targetDir)) {
        return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });
      }

      if (!authHeader.Authorization) {
        return res.status(400).json({
          ok: false,
          error:
            'Dispo-Zugangsdaten fehlen: Benutzername und Passwort in den Einstellungen eintragen (erforderlich für Projektordner holen).',
        });
      }

      if (acceptJob && bgJobs) {
        bgJobs.cancelRunningOfType('sync_pull');
        bgJobs.cancelUnsafeDienstreisePullsOnAccept(localJobId, technicianId);
      }

      let offlinePullMode = null;
      if (Object.prototype.hasOwnProperty.call(body, 'offline_paths')) {
        const jobDetail = lookupDienstreiseJobRow(localJobId);
        let fabMap = Array.isArray(body.fab_map) ? body.fab_map : [];
        if (!fabMap.length && jobDetail) {
          for (const fn of fabNumbersFromJobFabrikationsnummern(jobDetail.fabrikationsnummern)) {
            fabMap.push({
              fab: String(fn),
              folder_name_canonical: buildCanonicalFabFolderName(fn, jobDetail),
            });
          }
        }
        try {
          const layoutDir = getOrCreateDienstreiseFolderForJob(localJobId, {
            skipAssignmentCheck: true,
            technicianId,
          });
          const layout = await ensureJobReiseFolderLayout(localJobId, layoutDir, technicianId);
          const montageName =
            (layout && layout.montageFolderName) ||
            buildMonteurMontageFolderName(jobDetail || {}, getTechnicianDisplayName(technicianId));
          const fabMapResolved =
            layout && layout.fabMap && layout.fabMap.length ? layout.fabMap : fabMap;
          if (acceptJob) {
            saveOfflinePullSelection(
              db,
              localJobId,
              'explicit',
              body.offline_paths,
              fabMapResolved,
              montageName,
            );
          } else {
            mergeOfflinePullSelection(
              db,
              localJobId,
              body.offline_paths,
              fabMapResolved,
              montageName,
            );
          }
          offlinePullMode = 'explicit';
          save();
        } catch (layoutErr) {
          console.warn(
            '[accept] Montage-Ordner:',
            layoutErr && layoutErr.message ? layoutErr.message : layoutErr,
          );
          const montageName =
            (body.montage_folder_name && String(body.montage_folder_name).trim()) ||
            buildMonteurMontageFolderName(jobDetail || {}, getTechnicianDisplayName(technicianId));
          if (acceptJob) {
            saveOfflinePullSelection(db, localJobId, 'explicit', body.offline_paths, fabMap, montageName);
          } else {
            mergeOfflinePullSelection(db, localJobId, body.offline_paths, fabMap, montageName);
          }
          offlinePullMode = 'explicit';
          save();
        }
      }

      const dedupeKey = 'dienstreise_pull:' + localJobId + ':' + (acceptJob ? 'accept' : 'copy');
      const { job_id } = bgJobs.enqueue(
        'dienstreise_pull',
        {
          job_id: rawJobId,
          dispo_base_url: dispoBaseUrl,
          externalUrl,
          internalUrl,
          technician_id: technicianId,
          dispo_username: dispoUsername,
          dispo_password: dispoPassword,
          include_bilder: includeBilder,
          accept_job: acceptJob,
          offline_pull_mode: offlinePullMode,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      if (acceptJob && isFetchNetworkError(e)) {
        try {
          const b = req.body || {};
          const result = await performAcceptJobOffline({
            job_id: b.job_id != null ? b.job_id : b.jobId,
            technician_id: b.technicianId != null ? b.technicianId : b.technician_id,
            offline_paths: b.offline_paths,
            fab_map: b.fab_map,
            montage_folder_name: b.montage_folder_name,
          });
          result.hint =
            (result.hint || 'Lokal angenommen.') +
            ' Dateien später nachziehen. (' +
            formatFetchError(e, b.dispoBaseUrl || b.dispo_base_url || '') +
            ')';
          return res.json(result);
        } catch (_) {
          /* fall through */
        }
      }
      const msg = isFetchNetworkError(e)
        ? formatFetchError(e, (req.body && (req.body.dispoBaseUrl || req.body.dispo_base_url)) || '')
        : (e.message || 'Job konnte nicht gestartet werden.');
      return res.status(500).json({ ok: false, error: msg });
    }
  }

  /** @deprecated NDJSON entfernt — Antwort 202 + job_id; siehe GET /api/background_jobs/:id */
  app.post('/api/dienstreise/copy_project_stream', express.json(), (req, res) => {
    enqueueDienstreisePullFromRequest(req, res, { acceptJob: false }).catch((e) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || String(e) });
    });
  });

  /** Auftrag annehmen (Hintergrund-Job). */
  app.post('/api/dienstreise/accept_job_stream', express.json(), (req, res) => {
    enqueueDienstreisePullFromRequest(req, res, { acceptJob: true }).catch((e) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || String(e) });
    });
  });

  app.post('/api/dienstreise/upload', (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const subfolder = (body.subfolder || '').trim();
      const relativePathRaw = (body.relative_path || body.relativePath || '').trim().replace(/\\/g, '/');
      const filename = (body.filename || '').trim() || 'datei';
      const content = body.content;
      if (!localJobId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal) erforderlich.' });
      }
      const uploadGate = gateDienstreiseWrite(db, null, localJobId);
      if (uploadGate) return res.status(uploadGate.status).json({ ok: false, error: uploadGate.error });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });

      let relParts;
      if (relativePathRaw) {
        const parsed = parseDienstreiseRelativeSubpath(relativePathRaw);
        if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
        relParts = parsed.parts.slice();
        const safeName = path.basename(filename).replace(/[\/\\:*?"<>|]/g, '_') || 'datei';
        const last = relParts[relParts.length - 1] || '';
        const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(last);
        if (!looksLikeFile) relParts.push(safeName);
      } else if (DIENSTREISE_SUBFOLDERS.includes(subfolder)) {
        const safeName = path.basename(filename).replace(/[\/\\:*?"<>|]/g, '_') || 'datei';
        relParts = [subfolder, safeName];
      } else {
        return res.status(400).json({
          ok: false,
          error: 'subfolder oder relative_path (unter Dokumente_*) erforderlich.',
        });
      }

      const targetPath = path.join(reiseDir, ...relParts);
      const under = assertPathUnderReiseDir(reiseDir, targetPath);
      if (under.error) return res.status(400).json({ ok: false, error: under.error });
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      const safeName = path.basename(targetPath);
      const buf = typeof content === 'string' ? Buffer.from(content, 'base64') : (Buffer.isBuffer(content) ? content : null);
      if (!buf || buf.length === 0) return res.status(400).json({ ok: false, error: 'Dateiinhalt (content, base64) fehlt.' });
      fs.writeFileSync(targetPath, buf);
      invalidateDienstreisePushCache(db, localJobId, relParts.join('/'));
      protectPathIfUnderDokumenteMonteur(db, localJobId, relParts.join('/'));
      save();
      res.json({
        ok: true,
        path: targetPath,
        filename: safeName,
        relative_path: relParts.join('/'),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Upload fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/mkdir', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const parentSubpath = (body.parent_subpath || body.parentSubpath || '').trim().replace(/\\/g, '/');
      const folderName = (body.folder_name || body.folderName || '').trim().replace(/[\/\\:*?"<>|]/g, '_');
      if (!localJobId || !parentSubpath || !folderName) {
        return res.status(400).json({ ok: false, error: 'job_id, parent_subpath und folder_name erforderlich.' });
      }
      const uploadGate = gateDienstreiseWrite(db, null, localJobId);
      if (uploadGate) return res.status(uploadGate.status).json({ ok: false, error: uploadGate.error });
      const parsed = parseDienstreiseRelativeSubpath(parentSubpath);
      if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });
      const parts = parsed.parts.concat([folderName]);
      const targetPath = path.join(reiseDir, ...parts);
      const under = assertPathUnderReiseDir(reiseDir, targetPath);
      if (under.error) return res.status(400).json({ ok: false, error: under.error });
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        return res.status(400).json({ ok: false, error: 'Übergeordneter Ordner existiert nicht.' });
      }
      if (fs.existsSync(targetPath)) {
        return res.status(400).json({ ok: false, error: 'Ordner existiert bereits.' });
      }
      fs.mkdirSync(targetPath, { recursive: false });
      protectPathIfUnderDokumenteMonteur(db, localJobId, parts.join('/'));
      save();
      res.json({ ok: true, relative_path: parts.join('/'), path: targetPath });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Ordner konnte nicht angelegt werden.' });
    }
  });

  app.post('/api/dienstreise/delete_file', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const relativePath = (body.relative_path || body.relativePath || '').trim().replace(/\\/g, '/');
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '');

      if (!localJobId || !relativePath) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal) und relative_path erforderlich.' });
      }

      const delGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (delGate) return res.status(delGate.status).json({ ok: false, error: delGate.error });

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });
      }

      const localFullPath = path.join(reiseDir, relativePath.replace(/\//g, path.sep));
      if (!path.resolve(localFullPath).startsWith(path.resolve(reiseDir))) {
        return res.status(400).json({ ok: false, error: 'Ungültiger Pfad.' });
      }
      if (!fs.existsSync(localFullPath) || !fs.statSync(localFullPath).isFile()) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.' });
      }

      fs.unlinkSync(localFullPath);

      if (dispoBaseUrl && technicianId) {
        const jobId = getServerJobId(localJobId);
        const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};
        const formBody = new URLSearchParams();
        formBody.append('technician_id', String(technicianId));
        formBody.append('job_id', String(jobId));
        formBody.append('path', relativePath);
        try {
          const r = await fetch(dispoBaseUrl + '/api/job_project_file_delete.php', {
            method: 'POST',
            headers: Object.assign(
              { 'Content-Type': 'application/x-www-form-urlencoded' },
              dispoMonteurFetchHeaders(technicianId, authHeader),
            ),
            body: formBody.toString(),
          });
          if (!r.ok) {
            const errText = await r.text();
            let errMsg;
            try {
              const errData = errText ? JSON.parse(errText) : {};
              errMsg = errData.error || errText || 'Löschen auf Dispo fehlgeschlagen.';
            } catch (e) {
              errMsg = errText || 'Löschen auf Dispo fehlgeschlagen.';
            }
            return res.json({ ok: true, warning: 'Lokal gelöscht, aber Dispo: ' + errMsg });
          }
        } catch (e) {
          return res.json({ ok: true, warning: 'Lokal gelöscht, aber Dispo-Verbindung fehlgeschlagen: ' + (e.message || String(e)) });
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Löschen fehlgeschlagen.' });
    }
  });

  const FINISH_CLEANUP_HINT =
    'Lokale Downloads werden entfernt (auf OneDrive/Netzlaufwerk kann das etwas dauern)';

  function buildDienstreiseProtectedMatcher(protectedPaths) {
    // Prefix: „Nicht löschen“ am Ordner schützt auch alle Dateien/Unterordner darunter.
    return buildPrefixProtectedMatcher(protectedPaths);
  }

  /** True wenn ein Top-Level-Eintrag unter reiseDir per rmSync komplett gelöscht werden darf. */
  function canRmSyncTopLevelEntry(relName, protectedPathsNorm) {
    return canRmSyncTopLevelEntryExact(relName, protectedPathsNorm);
  }

  function collectDeletableFilesUnder(reiseDir, isProtected, out) {
    function walk(dir, relBase) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        if (isIgnorableDirEntry(e.name) && e.isFile()) {
          const fullIgn = path.join(dir, e.name);
          const relIgn = relBase ? relBase + '/' + e.name : e.name;
          if (!isProtected(relIgn)) out.push({ full: fullIgn, rel: relIgn });
          continue;
        }
        const full = path.join(dir, e.name);
        const rel = relBase ? relBase + '/' + e.name : e.name;
        if (e.isDirectory()) {
          // Geschützter Ordner (Prefix): Inhalt nicht anfassen — nicht hineinlaufen.
          if (isProtected(rel)) continue;
          walk(full, rel);
        } else if (e.isFile()) {
          if (!isProtected(rel)) out.push({ full, rel });
        }
      }
    }
    walk(reiseDir, '');
  }

  function pruneEmptyDirsUnder(reiseDir, isProtected) {
    let removedAny = false;
    function walk(dir, relBase) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        const rel = relBase ? relBase + '/' + e.name : e.name;
        walk(full, rel);
        if (isProtected(rel)) continue;
        try {
          const names = fs.readdirSync(full);
          const visible = names.filter((n) => !isIgnorableDirEntry(n));
          if (visible.length === 0) {
            for (const n of names) {
              try {
                fs.unlinkSync(path.join(full, n));
              } catch (_) {}
            }
            fs.rmdirSync(full);
            removedAny = true;
          }
        } catch (_) {}
      }
    }
    walk(reiseDir, '');
    return removedAny;
  }

  /**
   * Reiseordner bereinigen (ohne DB-Lock). fastNoUpload: rmSync ganzer Baum wenn nichts geschützt.
   * @param {(cur: number, tot: number, msg: string) => void} onProgress
   */
  function cleanupDienstreiseReiseDir(reiseDir, protectedPaths, opts) {
    const signal = opts && opts.signal;
    const fastNoUpload = !!(opts && opts.fastNoUpload);
    const onProgress =
      opts && typeof opts.onProgress === 'function'
        ? opts.onProgress
        : function () {};
    const isProtected = buildDienstreiseProtectedMatcher(protectedPaths);
    const protNorm = (protectedPaths || [])
      .map((p) => String(p || '').replace(/\\/g, '/'))
      .filter(Boolean);

    if (!reiseDir || !fs.existsSync(reiseDir)) return;

    const finishMsg = (suffix) => FINISH_CLEANUP_HINT + (suffix || ' …');

    if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });

    if (fastNoUpload && protNorm.length === 0) {
      onProgress(0, 1, finishMsg(' …'));
      try {
        fs.rmSync(reiseDir, { recursive: true, force: true });
        onProgress(1, 1, finishMsg(' – fertig.'));
        return;
      } catch (err) {
        console.warn('[finish_cleanup] rmSync:', err && err.message ? err.message : err);
      }
    }

    if (fastNoUpload && protNorm.length > 0) {
      let topEntries;
      try {
        topEntries = fs.readdirSync(reiseDir, { withFileTypes: true });
      } catch (_) {
        topEntries = [];
      }
      for (const e of topEntries) {
        if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
        const full = path.join(reiseDir, e.name);
        if (!canRmSyncTopLevelEntry(e.name, protNorm)) continue;
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch (err) {
          console.warn('[finish_cleanup] rmSync', e.name, err && err.message ? err.message : err);
        }
      }
    }

    const files = [];
    collectDeletableFilesUnder(reiseDir, isProtected, files);
    const total = Math.max(files.length, 1);
    onProgress(
      0,
      total,
      finishMsg(files.length ? ' – 0 / ' + files.length + ' Dateien …' : ' (keine Dateien) …'),
    );

    for (let i = 0; i < files.length; i++) {
      if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
      try {
        fs.unlinkSync(files[i].full);
      } catch (_) {}
      if (files.length <= 1 || i === files.length - 1 || (i + 1) % 8 === 0) {
        onProgress(i + 1, total, finishMsg(' – ' + (i + 1) + ' / ' + files.length + ' Dateien …'));
      }
    }

    for (let pass = 0; pass < 3; pass++) {
      if (!pruneEmptyDirsUnder(reiseDir, isProtected)) break;
    }

    try {
      if (fs.existsSync(reiseDir)) {
        const rest = fs.readdirSync(reiseDir);
        const visible = rest.filter((n) => !isIgnorableDirEntry(n));
        if (visible.length === 0) {
          for (const n of rest) {
            try {
              fs.unlinkSync(path.join(reiseDir, n));
            } catch (_) {}
          }
          fs.rmdirSync(reiseDir);
        }
      }
    } catch (_) {}

    onProgress(total, total, finishMsg(' – fertig.'));
  }

  async function performFinishAndCleanupWork(body, helpers) {
    const setProgress = helpers && helpers.setProgress;
    const signal = helpers && helpers.signal;
    const bumpProgress = (phase, cur, tot, msg) => {
      if (typeof setProgress === 'function') setProgress(phase, cur, tot, msg);
    };
    if (signal && signal.aborted) {
      throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    }
    const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
    // DB ist Quelle der Wahrheit; UI-Liste nur ergänzend (kann unvollständig sein).
    let protectedPaths = [];
    if (localJobId) {
      try {
        protectedPaths = listProtectedPaths(db, localJobId) || [];
      } catch (_) {
        protectedPaths = [];
      }
    }
    if (Array.isArray(body.protectedPaths) && body.protectedPaths.length) {
      const merged = new Set(
        protectedPaths.map((p) => normalizeProtectedRelPath(p)).filter(Boolean),
      );
      for (const raw of body.protectedPaths) {
        const n = normalizeProtectedRelPath(
          String(raw || '').replace(/^[\/\\]+|[\/\\]+$/g, ''),
        );
        if (n) merged.add(n);
      }
      protectedPaths = Array.from(merged);
    }
    const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
    const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
    const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
    const dispoPassword =
      body.dispoPassword != null
        ? String(body.dispoPassword)
        : body.dispo_password != null
          ? String(body.dispo_password)
          : '';
    if (!localJobId) throw new Error('job_id (lokal) erforderlich.');
    const finishGate = gateDienstreiseWrite(db, technicianId, localJobId);
    if (finishGate) {
      const gateErr = new Error(finishGate.error || 'Abschluss nicht erlaubt.');
      gateErr.httpStatus = finishGate.status || 403;
      throw gateErr;
    }
    const jobId = getServerJobId(localJobId);
    const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!reiseDir || !fs.existsSync(reiseDir)) throw new Error('Dienstreise-Ordner nicht gefunden.');

    const auftragsordner = resolveMonteurAuftragsordnerName(localJobId, technicianId);
    const monteurWorkOnly = (rel) => isMonteurWorkRelPath(rel, auftragsordner);
    const changedBeforeFinish = await collectChangedDienstreiseSyncFileEntries(
      db,
      reiseDir,
      localJobId,
      FINISH_SYNC_FOLDERS,
      monteurWorkOnly,
    );
    const verifyPlan = [];
    for (const folder of FINISH_SYNC_FOLDERS) {
      const paths = changedBeforeFinish
        .filter((f) => f.relPathFromRoot === folder || f.relPathFromRoot.startsWith(folder + '/'))
        .map((f) => normProjectRelPath(f.relPathFromRoot))
        .filter(Boolean);
      if (paths.length) verifyPlan.push({ folder, paths });
    }
    const totalSteps = 2 + verifyPlan.length + 2;
    let step = 0;
    const changedCount = changedBeforeFinish.length;
    bumpProgress(
      'finish_sync',
      step,
      totalSteps,
      changedCount
        ? changedCount + ' geänderte Monteur-Datei(en) werden übertragen …'
        : 'Keine geänderten Monteur-Dokumente – Upload übersprungen.',
    );

      // Nur geänderte Dateien (mtime/Größe vs. letzter Pull/Push), nicht den gesamten Ordner.
      let effectiveDispoBase = dispoBaseUrl;
      let syncDeferred = false;
      let deferredPushJobId = null;
      const forceOfflineFinish = body.offline_finish === true || body.force_offline === true;
      if (technicianId && changedCount > 0) {
        const mayTrySync = !forceOfflineFinish && !!(dispoBaseUrl || dispoUsername || dispoPassword);
        if (mayTrySync) {
          try {
            if (!effectiveDispoBase) {
              const resolved = await resolveDispoWorkingBase({
                baseUrl: dispoBaseUrl,
                externalUrl: body.dispoExternalUrl || body.externalUrl,
                internalUrl: body.dispoInternalUrl || body.internalUrl,
                technicianId,
                serverUsername: dispoUsername,
                serverPassword: dispoPassword,
              });
              effectiveDispoBase = resolved.base || '';
            }
            if (!effectiveDispoBase) {
              syncDeferred = true;
            } else {
              effectiveDispoBase = await syncDienstreiseFoldersToDispo(
                localJobId,
                effectiveDispoBase,
                technicianId,
                dispoUsername,
                dispoPassword,
                {
                  onlyChanged: true,
                  folders: FINISH_SYNC_FOLDERS,
                  relPathPredicate: monteurWorkOnly,
                  externalUrl: body.dispoExternalUrl || body.externalUrl,
                  internalUrl: body.dispoInternalUrl || body.internalUrl,
                },
              );
            }
          } catch (syncErr) {
            if (forceOfflineFinish || body.defer_dispo_sync === true || isLikelyOfflineSyncError(syncErr)) {
              syncDeferred = true;
              console.warn(
                '[finish_and_cleanup] Sync verschoben:',
                syncErr && syncErr.message ? syncErr.message : syncErr,
              );
            } else {
              throw new Error(
                'Sync zum Dispo-Server vor Abschluss fehlgeschlagen: ' +
                  (syncErr && syncErr.message ? syncErr.message : String(syncErr)),
              );
            }
          }
        } else {
          syncDeferred = true;
        }
        if (syncDeferred) {
          deferredPushJobId = enqueueDeferredDienstreisePush(localJobId, body);
          bumpProgress(
            'finish_sync',
            step,
            totalSteps,
            changedCount + ' geänderte Datei(en) – Upload bei Verbindung ausstehend.',
          );
        }
      }
      step += 1;
      bumpProgress(
        'finish_verify',
        step,
        totalSteps,
        syncDeferred
          ? 'Abgleich mit Dispo übersprungen (offline).'
          : verifyPlan.length
            ? 'Abgleich geänderter Dateien mit Dispo …'
            : 'Keine geänderten Dateien – Abgleich übersprungen.',
      );

      async function collectRemoteFilesForFolder(folderName, localRelPaths) {
        if (!effectiveDispoBase || !technicianId) return new Set();
        const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};
        return listRemoteProjectFilesOnDispo(
          effectiveDispoBase,
          jobId,
          technicianId,
          authHeader,
          folderName,
          localRelPaths,
        );
      }

      const authHeaderFinish = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};

      if (!syncDeferred) {
      for (const { folder, paths: localFiles } of verifyPlan) {
        if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
        bumpProgress('finish_verify', step, totalSteps, 'Prüfe ' + folder + ' (' + localFiles.length + ') …');
        if (!localFiles.length) continue;
        let remoteFiles = await collectRemoteFilesForFolder(folder, localFiles);
        let missing = localFiles.filter((p) => {
          const full = path.join(reiseDir, p.split('/').join(path.sep));
          if (!remoteProjectPathSetHas(remoteFiles, p)) return true;
          return localDienstreiseFileNeedsDispoPush(db, localJobId, p, full);
        });
        if (missing.length > 0 && effectiveDispoBase && technicianId) {
          for (const rel of missing) {
            const full = path.join(reiseDir, rel.split('/').join(path.sep));
            if (!fs.existsSync(full)) continue;
            try {
              await uploadJobProjectFileToDispo(
                effectiveDispoBase,
                jobId,
                technicianId,
                authHeaderFinish,
                rel,
                full,
              );
              recordDienstreisePushCache(db, localJobId, rel, full);
            } catch (uploadErr) {
              console.warn(
                '[finish_and_cleanup] Nachupload fehlgeschlagen:',
                rel,
                uploadErr && uploadErr.message ? uploadErr.message : uploadErr,
              );
            }
          }
          remoteFiles = await collectRemoteFilesForFolder(folder, localFiles);
          missing = localFiles.filter((p) => {
            const full = path.join(reiseDir, p.split('/').join(path.sep));
            if (!remoteProjectPathSetHas(remoteFiles, p)) return true;
            return localDienstreiseFileNeedsDispoPush(db, localJobId, p, full);
          });
        }
        for (const okRel of localFiles.filter((p) => !missing.includes(p))) {
          const fullOk = path.join(reiseDir, okRel.split('/').join(path.sep));
          if (fs.existsSync(fullOk)) recordDienstreisePushCache(db, localJobId, okRel, fullOk);
        }
        if (missing.length > 0) {
          const syncErr = new Error(
            'Dispo und WebApp sind nicht synchron (fehlende Dateien: ' +
              missing.slice(0, 5).join(', ') +
              (missing.length > 5 ? ', …' : '') +
              '). Bitte Verbindung prüfen, Projektdateien in der Dispo öffnen und erneut „Erledigt“ wählen.',
          );
          syncErr.httpStatus = 409;
          throw syncErr;
        }
        step += 1;
      }
      } else {
        step += verifyPlan.length;
      }

      bumpProgress('finish_abrechnung', step, totalSteps, 'Arbeitsnachweis und Montagebericht in die Abrechnung …');
      let abrechnungCopied = [];
      try {
        abrechnungCopied = copyProtocolsToLocalAbrechnung(reiseDir) || [];
      } catch (copyErr) {
        console.warn(
          '[finish_and_cleanup] Abrechnung-Protokollkopie:',
          copyErr && copyErr.message ? copyErr.message : copyErr,
        );
      }
      for (const item of abrechnungCopied) {
        const n = normalizeProtectedRelPath(item && item.destRel);
        if (n && !protectedPaths.includes(n)) protectedPaths.push(n);
      }
      const abJobId = jobId || getServerJobId(localJobId);
      if (abrechnungCopied.length && technicianId && abJobId) {
        const abCtx = {
          db,
          save,
          dbDir: DB_DIR,
          resolveDienstreiseReiseDirForJob: (jobIdRef, opts) => resolveDienstreiseReiseDirForJob(jobIdRef, opts),
        };
        for (const item of abrechnungCopied) {
          try {
            queueAbrechnungLocalFile(abCtx, {
              jobServerId: abJobId,
              technicianId,
              bucket: 'dispo',
              storedName: item.storedName,
              localPath: item.destAbs,
            });
          } catch (qErr) {
            console.warn(
              '[finish_and_cleanup] Abrechnung-Queue:',
              qErr && qErr.message ? qErr.message : qErr,
            );
          }
        }
        if (!forceOfflineFinish && (effectiveDispoBase || dispoBaseUrl)) {
          try {
            await flushAbrechnungOutbox(
              { db, save, dbDir: DB_DIR, authHeaderFromCredentials },
              effectiveDispoBase || dispoBaseUrl,
              technicianId,
              dispoUsername,
              dispoPassword,
            );
          } catch (flushErr) {
            console.warn(
              '[finish_and_cleanup] Abrechnung-Flush:',
              flushErr && flushErr.message ? flushErr.message : flushErr,
            );
          }
        }
      }

      bumpProgress(
        'finish_cleanup',
        step,
        totalSteps,
        FINISH_CLEANUP_HINT +
          (syncDeferred
            ? ' (Upload ausstehend) …'
            : changedCount === 0
              ? ' …'
              : ' (nach Upload) …'),
      );

      cleanupDienstreiseReiseDir(reiseDir, protectedPaths, {
        signal,
        fastNoUpload: changedCount === 0,
        onProgress(cur, tot, msg) {
          bumpProgress('finish_cleanup', cur, tot, msg);
        },
      });

      step += 1;
      bumpProgress('finish_status', step, totalSteps, 'Auftrag wird als erledigt markiert …');

      // Job lokal als "erledigt" markieren UND Pending anlegen (Fallback falls Sofort-Push scheitert).
      try {
        if (technicianId) {
          const r = db.prepare(`
            UPDATE jobs SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
          `).run('erledigt', localJobId, technicianId);
          if (!r.changes) {
            db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('erledigt', localJobId);
          }
          clearPendingJobStatus(db, localJobId);
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`)
            .run('job', localJobId, 'status', JSON.stringify({ status: 'erledigt' }));
        } else {
          db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('erledigt', localJobId);
        }
        freezeProtocolDraftsIfClosed(localJobId, 'erledigt');
      } catch (statusErr) {
        // Wenn das Status-Update/Pending-Flag scheitert, soll der Abschluss
        // trotzdem nicht komplett fehlschlagen.
      }

      // Sofort an Dispo (wie Handy-PWA), damit der nächste Sync den Auftrag nicht als offen zurückholt.
      if (technicianId && !forceOfflineFinish) {
        try {
          let statusPushBase = (effectiveDispoBase || dispoBaseUrl || '').trim().replace(/\/$/, '');
          if (!statusPushBase) {
            const resolved = await resolveDispoWorkingBase({
              baseUrl: dispoBaseUrl,
              externalUrl: body.dispoExternalUrl || body.externalUrl,
              internalUrl: body.dispoInternalUrl || body.internalUrl,
              technicianId,
              serverUsername: dispoUsername,
              serverPassword: dispoPassword,
            });
            statusPushBase = (resolved && resolved.base) || '';
          }
          const jobRow = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(localJobId);
          const serverJobId =
            jobRow && jobRow.server_id != null && String(jobRow.server_id).trim() !== ''
              ? jobRow.server_id
              : null;
          const techRow = db
            .prepare('SELECT technician_id FROM job_technicians WHERE job_id = ? LIMIT 1')
            .get(localJobId);
          const techIdForPush =
            techRow && techRow.technician_id != null ? techRow.technician_id : technicianId;
          if (statusPushBase && serverJobId) {
            bumpProgress('finish_status', step, totalSteps, 'Status „erledigt“ wird an Dispo gesendet …');
            const authHeaderStatus = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};
            const pushRes = await pushJobStatusErledigtToDispo(
              statusPushBase,
              techIdForPush,
              serverJobId,
              authHeaderStatus,
            );
            if (pushRes.ok) {
              clearPendingJobStatus(db, localJobId);
            } else {
              console.warn(
                '[finish_and_cleanup] Status-Push an Dispo fehlgeschlagen, bleibt pending:',
                pushRes.error || 'unbekannt',
              );
            }
          }
        } catch (statusPushErr) {
          console.warn(
            '[finish_and_cleanup] Status-Push verschoben:',
            statusPushErr && statusPushErr.message ? statusPushErr.message : statusPushErr,
          );
        }
      }
  }

  app.post('/api/dienstreise/finish_and_cleanup', express.json(), async (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      if (!localJobId) return res.status(400).json({ ok: false, error: 'job_id (lokal) erforderlich.' });
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const finishGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (finishGate) return res.status(finishGate.status).json({ ok: false, error: finishGate.error });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });
      }
      bgJobs.reapStuckJobs();
      bgJobs.cancelRunningOfType('sync_pull');
      if (typeof bgJobs.cancelRunningDienstreiseForLocalJob === 'function') {
        bgJobs.cancelRunningDienstreiseForLocalJob(localJobId);
      }
      const dedupeKey = 'dienstreise_finish:' + localJobId;
      const { job_id } = bgJobs.enqueue(
        'dienstreise_finish',
        {
          job_id: localJobId,
          protectedPaths: body.protectedPaths,
          dispoBaseUrl: (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, ''),
          dispo_base_url: (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, ''),
          dispoExternalUrl: body.dispoExternalUrl || body.externalUrl,
          dispoInternalUrl: body.dispoInternalUrl || body.internalUrl,
          externalUrl: body.dispoExternalUrl || body.externalUrl,
          internalUrl: body.dispoInternalUrl || body.internalUrl,
          technicianId,
          technician_id: technicianId,
          dispoUsername: (body.dispoUsername || body.dispo_username || '').trim(),
          dispo_username: (body.dispoUsername || body.dispo_username || '').trim(),
          dispoPassword:
            body.dispoPassword != null
              ? String(body.dispoPassword)
              : body.dispo_password != null
                ? String(body.dispo_password)
                : '',
          dispo_password:
            body.dispoPassword != null
              ? String(body.dispoPassword)
              : body.dispo_password != null
                ? String(body.dispo_password)
                : '',
        },
        dedupeKey,
      );
      bgJobs.kick();
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Abschluss konnte nicht gestartet werden.' });
    }
  });

  app.post('/api/dienstreise/release_job', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      if (!localJobId) return res.status(400).json({ ok: false, error: 'job_id (lokal) erforderlich.' });
      const technicianId = parseInt(
        body.technicianId != null
          ? body.technicianId
          : body.technician_id != null
            ? body.technician_id
            : getTechnicianId(req),
        10,
      );
      if (!Number.isFinite(technicianId) || technicianId <= 0) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const gate = getWritableLocalJobMetaForPatch(db, technicianId, localJobId);
      if (gate.error) return res.status(gate.status).json({ ok: false, error: gate.error });
      const dispoOpts = {
        dispoBaseUrl: (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, ''),
        externalUrl: body.dispoExternalUrl || body.externalUrl,
        internalUrl: body.dispoInternalUrl || body.internalUrl,
        dispoUsername: (body.dispoUsername || body.dispo_username || '').trim(),
        dispoPassword:
          body.dispoPassword != null
            ? String(body.dispoPassword)
            : body.dispo_password != null
              ? String(body.dispo_password)
              : '',
      };
      const forceOffline = body.force_offline === true || body.offline_only === true;
      const releaseLocalWithQueue = () => {
        const jobRow = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(gate.localId);
        performReleaseDienstreiseJob(gate.localId, technicianId);
        let queued = false;
        if (jobRow && jobRow.server_id != null && String(jobRow.server_id).trim() !== '') {
          queueJobStatusPending(gate.localId, 'zugeteilt');
          queued = true;
        }
        return { synced: false, queued };
      };
      if (forceOffline) {
        const localResult = releaseLocalWithQueue();
        return res.json({
          ok: true,
          status: 'zugeteilt',
          offline: true,
          synced: localResult.synced,
          queued: localResult.queued,
        });
      }
      if (dispoOpts.dispoUsername) {
        try {
          const resolvedBase = await resolveDispoWorkingBase({
            baseUrl: dispoOpts.dispoBaseUrl,
            externalUrl: dispoOpts.externalUrl,
            internalUrl: dispoOpts.internalUrl,
            technicianId,
            serverUsername: dispoOpts.dispoUsername,
            serverPassword: dispoOpts.dispoPassword,
          });
          if (resolvedBase.base) {
            try {
              await performReleaseDienstreiseJobWithDispo(gate.localId, technicianId, {
                ...dispoOpts,
                dispoBaseUrl: resolvedBase.base,
              });
              return res.json({ ok: true, status: 'zugeteilt', synced: true });
            } catch (dispoErr) {
              if (body.offline_fallback === false) throw dispoErr;
              console.warn(
                '[release_job] Dispo-Freigabe fehlgeschlagen, lokal fortgesetzt:',
                dispoErr && dispoErr.message ? dispoErr.message : dispoErr,
              );
              const localResult = releaseLocalWithQueue();
              return res.json({
                ok: true,
                status: 'zugeteilt',
                synced: false,
                queued: localResult.queued,
                warning: dispoErr && dispoErr.message ? String(dispoErr.message) : 'Dispo-Sync ausstehend.',
              });
            }
          }
        } catch (resolveErr) {
          if (body.offline_fallback === false) throw resolveErr;
        }
      }
      const localResult = releaseLocalWithQueue();
      return res.json({
        ok: true,
        status: 'zugeteilt',
        offline: true,
        synced: false,
        queued: localResult.queued,
        hint: 'Lokal freigegeben. Dispo-Status wird bei Verbindung synchronisiert.',
      });
    } catch (e) {
      const status = e && e.httpStatus ? e.httpStatus : 500;
      res.status(status).json({ ok: false, error: e.message || 'Freigabe fehlgeschlagen.' });
    }
  });

  app.get('/api/technician', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const row = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(technicianId);
    if (!row) {
      return res.json({ ok: true, id: technicianId, full_name: null, username: null });
    }
    res.json({ ok: true, id: row.id, full_name: row.full_name || null, username: row.username || null });
  });

  app.get('/api/my_jobs', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const includeErledigt = req.query.include_erledigt === '1' || req.query.include_erledigt === 'true';
    const assignedOnly = req.query.assigned_only === '1' || req.query.assigned_only === 'true';
    let sql = `SELECT j.id, j.server_id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
        j.status, j.date_not_fixed, j.required_technicians, j.description, j.fabrikationsnummern,
        (SELECT COUNT(*) FROM job_technicians jt_cnt WHERE jt_cnt.job_id = j.id) AS assigned_count,
        c.name AS customer_name, c.phone AS customer_phone, c.contact_person, c.contact_phone,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      WHERE `;
    if (assignedOnly) {
      sql += `EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)`;
    } else {
      sql += `(
        EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
        OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
      )`;
    }
    const params = [technicianId];
    if (!includeErledigt) {
      sql += ` AND j.status NOT IN ('erledigt', 'abgerechnet')`;
    }
    if (dateFrom) { sql += ' AND j.end_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { sql += ' AND j.start_datetime <= ?'; params.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY j.start_datetime ASC';
    try {
      const rows = db.prepare(sql).all(...params);
      attachJobContactsToJobs(db, rows);
      res.json({ ok: true, technician_id: technicianId, jobs: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/my_jobs_archive', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const yearParam = parseInt(req.query.year, 10);
    const year = Number.isFinite(yearParam) && yearParam > 1900 ? yearParam : currentYear;

    const customer = (req.query.customer || '').trim();
    const monthRaw = (req.query.month || '').trim();
    const fab = (req.query.fabrikationsnummer || '').trim();
    const country = (req.query.country || '').trim();

    let sql = `SELECT j.id, j.server_id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
        j.status, j.required_technicians, j.description, j.fabrikationsnummern,
        c.name AS customer_name, c.phone AS customer_phone, c.contact_person, c.contact_phone,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      WHERE j.status IN ('erledigt', 'abgerechnet')
        AND strftime('%Y', j.end_datetime) = ?
        AND (
          EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
          OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
        )`;
    const params = [String(year), technicianId];

    if (customer) {
      sql += ' AND c.name LIKE ?';
      params.push('%' + customer + '%');
    }

    if (monthRaw) {
      // Erwartet "MM" (01-12) oder "YYYY-MM"
      if (/^\d{4}-\d{2}$/.test(monthRaw)) {
        sql += ' AND strftime(\'%Y-%m\', j.end_datetime) = ?';
        params.push(monthRaw);
      } else if (/^\d{1,2}$/.test(monthRaw)) {
        const mm = monthRaw.padStart(2, '0');
        if (parseInt(mm, 10) >= 1 && parseInt(mm, 10) <= 12) {
          sql += ' AND strftime(\'%m\', j.end_datetime) = ?';
          params.push(mm);
        }
      }
    }

    if (fab) {
      sql += ' AND j.fabrikationsnummern IS NOT NULL AND j.fabrikationsnummern LIKE ?';
      params.push('%' + fab + '%');
    }

    if (country) {
      sql += ' AND (ja.country LIKE ? OR c.country LIKE ?)';
      params.push('%' + country + '%', '%' + country + '%');
    }

    sql += ' ORDER BY j.end_datetime DESC';

    try {
      const rows = db.prepare(sql).all(...params);
      attachJobContactsToJobs(db, rows);
      res.json({ ok: true, technician_id: technicianId, year, jobs: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  function isArchivParameterDocument(type, name) {
    const t = String(type || '');
    const n = String(name || '');
    if (/parameter/i.test(t)) return true;
    if (/\.(csv|pal|pa3|pa4|pa5|txt)$/i.test(n)) return true;
    return false;
  }

  app.get('/api/archiv/job_documents', (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      if (!jobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const technicianId = getTechnicianId(req);
      const resolved =
        technicianId && Number.isFinite(technicianId) && technicianId > 0
          ? resolveLocalJobIdForTechnician(db, technicianId, jobId, { mode: 'auto' })
          : null;
      let localJobId = jobId;
      if (resolved) {
        if (!resolved.ok) {
          return res.status(resolved.status || 404).json({ ok: false, error: resolved.error });
        }
        localJobId = resolved.localId;
      } else {
        const mapped = getJobRowByLocalOrServerId(jobId);
        if (!mapped) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
        localJobId = mapped.id;
      }
      const jobRow = loadKundenDokumentationJobMeta(localJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const catalog = buildKundenDokumentationCatalog(localJobId, technicianId, jobRow);
      const mapDoc = (d, extra) =>
        Object.assign(
          {
            id: d.id,
            type: d.type || '',
            name: d.name || '',
            fab: d.fab || '',
            absPath: d.absPath || null,
            relPath: d.relPath || '',
            size: d.size != null ? d.size : null,
            mtime: d.mtime || null,
            source: 'local_folder',
          },
          extra || {},
        );
      const protokolle = [];
      const parameterlisten = [];
      const seenParamKeys = new Set();
      const seenProtoKeys = new Set();
      for (const d of catalog.documents || []) {
        const item = mapDoc(d);
        const key = String(item.fab || '') + '|' + String(item.name || '').toLowerCase();
        if (isArchivParameterDocument(item.type, item.name)) {
          seenParamKeys.add(key);
          parameterlisten.push(item);
        } else {
          seenProtoKeys.add(key);
          protokolle.push(item);
        }
      }
      const protocolJsonKindLabel = {
        'serviceprotokoll.json': 'Serviceprotokoll',
        'inbetriebnahmeprotokoll.json': 'Inbetriebnahme Protokoll',
        'montagebericht.json': 'Montagebericht JSON',
        'kontrollwiegungsprotokoll.json': 'Kontrollwiegung JSON',
        'schleppkettenprotokoll.json': 'Schleppketten-Test JSON',
        'pruefzertifikat.json': 'Prüfzertifikat JSON',
      };
      const reiseDirForJson = catalog.reiseDir || resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      try {
        const listed = protocolDrafts.listDraftsForJob(db, localJobId);
        for (const item of listed) {
          const baseName = item.basename;
          const key = '|' + String(baseName).toLowerCase();
          if (seenProtoKeys.has(key)) continue;
          seenProtoKeys.add(key);
          protokolle.push(
            mapDoc(
              {
                id: 'json-db:' + baseName,
                type: protocolJsonKindLabel[String(baseName).toLowerCase()] || 'Protokoll JSON',
                name: baseName,
                fab: '',
                absPath: '',
                relPath: 'db:' + baseName,
                size: JSON.stringify(item.payload || {}).length,
                mtime: item.server_updated_at || null,
              },
              { source: 'protocol_json', protocol_json: true, protocol_draft_db: true },
            ),
          );
        }
      } catch (_) {
        /* SQLite optional */
      }
      if (reiseDirForJson && fs.existsSync(reiseDirForJson)) {
        pruneEmptyMonteurDraftJsons(reiseDirForJson);
        for (const baseName of MONTEUR_DRAFT_BASENAMES) {
          let jsonPath = '';
          try {
            jsonPath = resolveMonteurDraftJsonPath(reiseDirForJson, baseName, false);
          } catch (_) {
            jsonPath = '';
          }
          if (!jsonPath || !fs.existsSync(jsonPath)) continue;
          let st = null;
          try {
            st = fs.statSync(jsonPath);
          } catch (_) {
            continue;
          }
          if (!st.isFile()) continue;
          const rel = path
            .relative(reiseDirForJson, jsonPath)
            .split(path.sep)
            .join('/');
          const key = '|' + String(baseName).toLowerCase();
          if (seenProtoKeys.has(key)) continue;
          seenProtoKeys.add(key);
          protokolle.push(
            mapDoc(
              {
                id: 'json:' + rel,
                type: protocolJsonKindLabel[String(baseName).toLowerCase()] || 'Protokoll JSON',
                name: path.basename(jsonPath),
                fab: '',
                absPath: jsonPath,
                relPath: rel,
                size: st.size,
                mtime: st.mtime ? st.mtime.toISOString() : null,
              },
              { source: 'protocol_json', protocol_json: true },
            ),
          );
        }
      }
      const fabs = parseJobFabrikationsnummernRows(jobRow.fabrikationsnummern)
        .map((r) => String((r && (r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer)) || '').trim())
        .filter(Boolean);
      try {
        ensureAnlagenstammLocalSchema(db);
      } catch (_) {
        /* Schema optional */
      }
      for (const fab of fabs) {
        let files = [];
        try {
          files = listParameterFilesByFab(db, fab) || [];
        } catch (_) {
          files = [];
        }
        for (const f of files) {
          const name = String(f.original_filename || '').trim();
          const key = String(fab) + '|' + name.toLowerCase();
          if (seenParamKeys.has(key)) continue;
          seenParamKeys.add(key);
          parameterlisten.push({
            id: 'cache:' + String(f.id),
            type: 'Parameterliste',
            name: name || 'parameterliste',
            fab,
            absPath: f.source_path || null,
            relPath: '',
            file_id: f.server_file_id != null ? Number(f.server_file_id) : Number(f.id),
            local_id: f.id,
            size: f.size != null ? Number(f.size) : null,
            mtime: f.uploaded_at || null,
            source: f.source === 'projekte_neu' ? 'projekte_neu' : 'cache',
            entry_count: f.entry_count != null ? Number(f.entry_count) : 0,
          });
        }
      }
      return res.json({
        ok: true,
        folder_missing: !!catalog.folder_missing,
        hint: catalog.hint || null,
        protokolle,
        parameterlisten,
      });
    } catch (e) {
      console.warn('[archiv/job_documents]', e);
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/api/jobs_open', async (req, res) => {
    const technicianId = getTechnicianId(req);
    const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId) {
      return res.status(400).json({ error: 'technician_id erforderlich.' });
    }
    if (!baseUrl) {
      try {
        const rows = queryJobsOpenLocalRows(db, technicianId, req.query || {});
        return res.json(rows);
      } catch (e) {
        return res.status(500).json({ error: e.message || String(e) });
      }
    }
    const auth = authHeaderFromIncomingBasicOrQuery(req);
    const includeErledigt = (req.query.include_erledigt || '').toString() === '1';
    const filterNoDate = (req.query.filter_no_date || '').toString() === '1';
    const filterNoTechnician = (req.query.filter_no_technician || '').toString() === '1';
    const url =
      `${baseUrl}/dispo_api/api/jobs_open.php?technician_id=${encodeURIComponent(technicianId)}` +
      (includeErledigt ? '&include_erledigt=1' : '') +
      (filterNoDate ? '&filter_no_date=1' : '') +
      (filterNoTechnician ? '&filter_no_technician=1' : '');
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const text = await r.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = null;
        }
      }
      if (!r.ok) {
        const apiErr = data && typeof data.error === 'string' && data.error.trim() ? data.error.trim() : null;
        const snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        return res.status(r.status).json({
          error: apiErr || snippet || r.statusText || 'Dispo-Fehler',
        });
      }
      if (!Array.isArray(data)) {
        return res.status(502).json({
          error: 'Unerwartete Antwort von jobs_open (kein JSON-Array).',
          detail: (text || '').slice(0, 400),
        });
      }
      res.json(data);
    } catch (e) {
      const msg = e.message || String(e);
      console.error('[jobs_open]', msg);
      if (isLikelyOfflineSyncError(e) || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
        try {
          const rows = queryJobsOpenLocalRows(db, technicianId, req.query || {});
          return res.json(rows);
        } catch (localErr) {
          console.warn('[jobs_open] local fallback:', localErr && localErr.message ? localErr.message : localErr);
        }
      }
      let hint = '';
      if (/CERT|TLS|SSL|self-signed|self signed|unable to verify|UNABLE_TO_VERIFY|wrong version number|EPROTO/i.test(msg)) {
        hint =
          'HTTPS-Verbindung zum Dispo-Server fehlgeschlagen (Zertifikat/Netz). IT prüfen: Erreichbarkeit und URL in den Einstellungen.';
      }
      res.status(502).json({
        error: 'Dispo nicht erreichbar: ' + msg,
        hint,
      });
    }
  });

  /** Offene Aufträge aus lokaler SQLite (gleiche Filter wie Dispo jobs_open.php). */
  app.get('/api/jobs_open_local', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ error: 'technician_id fehlt.' });
    }
    try {
      const rows = queryJobsOpenLocalRows(db, technicianId, req.query || {});
      res.json(Array.isArray(rows) ? rows : []);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.get('/api/job', async (req, res) => {
    const technicianId = getTechnicianId(req);
    const jobId = parseInt(req.query.id, 10);
    if (!technicianId || !jobId) {
      return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
    }
    const row = db.prepare(`
      SELECT j.*, c.name AS customer_name, c.street AS customer_street, c.house_number AS customer_house_number,
        c.zip AS customer_zip, c.city AS customer_city, c.phone AS customer_phone,
        c.contact_person, c.contact_phone, c.contact_email,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website,
        jhs.hotel_id AS hotel_id, jhs.comment AS hotel_comment, jhs.rating_stars AS hotel_rating_stars,
        jhs.rating_avg AS hotel_rating_avg, jhs.rating_count AS hotel_rating_count
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      LEFT JOIN job_hotel_selection jhs ON jhs.job_id = j.id
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
      ORDER BY CASE WHEN CAST(j.server_id AS TEXT) = CAST(? AS TEXT) THEN 0 ELSE 1 END, j.id ASC
      LIMIT 1
    `).get(jobId, jobId, jobId);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
    }
    const localJobPk = row.id;
    let job = { ...row };
    job.job_contacts = job.job_contacts || [];
    try {
      const contacts = db.prepare(`${JOB_CONTACTS_SELECT_SQL} WHERE job_id = ? ORDER BY sort_order, id`).all(localJobPk);
      if (contacts && contacts.length > 0) {
        job.job_contacts = contacts;
      }
    } catch (e) {
      // Tabelle job_contacts fehlt ggf. – Fallback auf contact_person/contact_phone/contact_email vom Job/Kunde
    }
    Object.assign(job, jobAssignmentViewMeta(db, localJobPk, technicianId));
    const baseUrl = (req.query.base_url || '').toString().trim();
    const enrich = req.query.enrich_anlagenstamm === '1' || req.query.enrich_anlagenstamm === 'true';
    const enrichLocalOnly = req.query.enrich_local_only === '1' || req.query.enrich_local_only === 'true';
    if (enrich && (baseUrl || enrichLocalOnly)) {
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      job = await enrichJobFabWithAnlagenstamm(job, baseUrl, auth, { localOnly: enrichLocalOnly });
    }
    res.json({ ok: true, job });
  });

  app.post('/api/job_from_dispo', express.json(), async (req, res) => {
    const sendError = (status, msg) => {
      if (!res.headersSent) res.status(status).json({ ok: false, error: msg });
    };
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, externalUrl, internalUrl, jobId: localJobId } = req.body || {};
      const resolved = await resolveDispoWorkingBase({
        baseUrl,
        externalUrl,
        internalUrl,
        technicianId,
        serverUsername: req.body.serverUsername,
        serverPassword: req.body.serverPassword,
      });
      const base = (resolved.base || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || localJobId == null) {
        return res.status(400).json({ ok: false, error: 'jobId und technician_id erforderlich.' });
      }
      if (!base) {
        return res.status(502).json({ ok: false, error: resolved.error || 'Dispo nicht erreichbar.' });
      }
      const localId = parseInt(localJobId, 10);
      if (!Number.isFinite(localId)) {
        return res.status(400).json({ ok: false, error: 'jobId ungültig.' });
      }
      const viewOnly = req.body.viewOnly === true;
      const serverJobIdArg = parseInt(req.body.serverJobId, 10) || 0;
      const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
      const dispoFetchId = serverJobIdArg > 0 ? serverJobIdArg : localId;
      let row = null;
      if (viewOnly || serverJobIdArg > 0) {
        row = db
          .prepare(
            `SELECT j.id, j.server_id FROM jobs j
             WHERE CAST(j.server_id AS TEXT) = CAST(? AS TEXT)
             LIMIT 1`,
          )
          .get(dispoFetchId);
      } else {
        row = db
          .prepare(
            `SELECT j.id, j.server_id FROM jobs j
             WHERE j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT)
             ORDER BY CASE WHEN j.id = ? THEN 0 ELSE 1 END, j.id ASC
             LIMIT 1`,
          )
          .get(localId, localId, localId);
      }
      if (row) {
        row = { id: row.id, server_id: row.server_id };
      }

      async function finishWithDispoJob(data) {
        if (!data.job || typeof data.job !== 'object') {
          return sendError(404, (data && data.error) || 'Auftrag nicht gefunden.');
        }
        if (data.job.fabrikationsnummern == null && data.job.Fabrikationsnummern != null) {
          data.job.fabrikationsnummern = data.job.Fabrikationsnummern;
        }
        // Stamm immer lokal mergen — nicht auf anlagenstamm_by_fab (HTTPS) warten.
        data.job = await enrichJobFabWithAnlagenstamm(data.job, base, auth, { localOnly: true });
        const contacts = normalizeJobContactsFromPayload(data.job);
        data.job.job_contacts = contacts;
        const calendarTechId = parseInt(req.body.calendarTechnicianId, 10) || 0;
        const knownNotAssigned = data.job.assigned_to_me === false;
        const dispoId = Number(data.job.id);
        if (viewOnly) {
          // Fremde/unzugeteilte Kalenderaufträge nicht in SQLite spiegeln:
          // lokale jobs.id und Dispo-server_id können dieselbe Zahl haben (sonst landet CSR statt Alfred).
          if (Number.isFinite(dispoId) && dispoId > 0) {
            data.job.server_id = dispoId;
          }
          data.job.assignment_writable = false;
          data.job.assigned_to_me = false;
          if (!data.job.assignment_read_only_reason) {
            data.job.assignment_read_only_reason = calendarTechId === 0
              ? 'Nur Ansicht – Auftrag ist nicht zugeteilt.'
              : 'Nur Ansicht – Auftrag ist einem anderen Techniker zugeteilt.';
          }
          return res.json(data);
        }
        try {
          const custId = ensureCustomer(db, data.job);
          const localId = insertOrUpdateJob(db, data.job, custId, technicianId, {
            assignTechnician: !knownNotAssigned,
            assignedTechnicianIds: knownNotAssigned && calendarTechId > 0 && calendarTechId !== Number(technicianId)
              ? [calendarTechId]
              : [],
          });
          if (localId) {
            const serverId = data.job.id;
            data.job.id = localId;
            data.job.server_id = serverId;
            Object.assign(data.job, jobAssignmentViewMeta(db, localId, technicianId));
          }
        } catch (persistErr) {
          console.warn('[job_from_dispo] persist:', persistErr && persistErr.message ? persistErr.message : persistErr);
        }
        const localDbId = data.job.id != null ? data.job.id : (row ? row.id : null);
        if (localDbId != null) {
          try {
            const hotel = db.prepare('SELECT endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website FROM job_hotel_addresses WHERE job_id = ?').get(localDbId);
            if (hotel) {
              data.job.hotel_endkunde = hotel.endkunde;
              data.job.hotel_street = hotel.street;
              data.job.hotel_house_number = hotel.house_number;
              data.job.hotel_zip = hotel.zip;
              data.job.hotel_city = hotel.city;
              data.job.hotel_country = hotel.country;
              data.job.hotel_address_extra_1 = hotel.address_extra_1;
              data.job.hotel_address_extra_2 = hotel.address_extra_2;
              data.job.hotel_phone = hotel.phone;
              data.job.hotel_email = hotel.email;
              data.job.hotel_website = hotel.website;
            }
          } catch (e) { /* Tabelle fehlt – ignorieren */ }
          try {
            db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(localDbId);
            for (let i = 0; i < contacts.length; i++) {
              const n = normalizeJobContactPayload(contacts[i]);
              if (!jobContactHasAny(n)) continue;
              insertJobContactRow(db, localDbId, n, i);
            }
          } catch (e) { /* Tabelle fehlt oder Fehler – ignorieren */ }
        }
        res.json(data);
      }

      async function fetchDispoJob(urlToFetch) {
        const headers = auth ? Object.assign({}, auth) : {};
        if (headers.Authorization && !headers['X-Kukla-Authorization']) {
          headers['X-Kukla-Authorization'] = headers.Authorization;
        }
        const r = await fetch(urlToFetch, Object.keys(headers).length ? { headers } : {});
        const raw = await r.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
        if (!r.ok) {
          logSyncPushError({
            reason: 'job_from_dispo_http_error',
            status: r.status,
            statusText: r.statusText,
            url: urlToFetch,
            body_preview: (raw || '').slice(0, 1200),
          });
        }
        return { ok: r.ok, status: r.status, statusText: r.statusText, data, raw };
      }

      async function fetchDispoJobForView(serverJobId) {
        const id = encodeURIComponent(serverJobId);
        const tid = encodeURIComponent(technicianId);
        const mobile = `${base}/api/mobile/job.php?id=${id}`;
        const rsMobile = await fetchDispoJob(mobile);
        if (rsMobile.ok && rsMobile.data && rsMobile.data.job) return rsMobile;
        const primary = `${base}/dispo_api/api/job.php?id=${id}&technician_id=${tid}&debug=1`;
        return fetchDispoJob(primary);
      }

      // Ansicht aus dem Kalender: immer die Dispo-Server-ID holen, nie eine lokale SQLite-ID.
      if (viewOnly || serverJobIdArg > 0) {
        const rsView = await fetchDispoJobForView(dispoFetchId);
        if (!rsView.ok) {
          return sendError(rsView.status, rsView.data.error || rsView.statusText || 'Dispo-Fehler');
        }
        return await finishWithDispoJob({ ok: true, ...rsView.data });
      }

      // Kein lokaler SQLite-Eintrag: jobId ist oft die Dispo-Server-ID (z. B. Liste „Offene Aufträge“ / noch nicht synchronisiert)
      if (!row) {
        const rs0 = await fetchDispoJobForView(localId);
        if (!rs0.ok) {
          return sendError(rs0.status, rs0.data.error || rs0.statusText || 'Dispo-Fehler');
        }
        return await finishWithDispoJob({ ok: true, ...rs0.data });
      }

      const serverJobId = (row.server_id != null && row.server_id !== '') ? row.server_id : row.id;
      const rs = await fetchDispoJobForView(serverJobId);
      if (!rs.ok) {
        return sendError(rs.status, rs.data.error || rs.statusText || 'Dispo-Fehler');
      }
      await finishWithDispoJob(rs.data);
    } catch (e) {
      const cause = e && e.cause && e.cause.message ? e.cause.message : '';
      console.error('[job_from_dispo]', e.message, cause || '', e.stack);
      logSyncPushError({
        reason: 'job_from_dispo',
        message: e.message,
        cause: cause || undefined,
        stack: e.stack,
      });
      sendError(500, e.message || 'Interner Fehler beim Laden von der Dispo');
    }
  });

  /** Proxys: Dispo Signatur-API (dispo_api) mit Basic-Auth wie job_from_dispo */
  app.post('/api/dispo_signature_session_open', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, payload } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      if (!base) {
        return res.json({
          ok: true,
          offline: true,
          session_id: 'local-offline-' + Date.now(),
          session_token: 'local-offline-' + Date.now(),
        });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const url = `${base}/dispo_api/api/signature_session_open.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, auth || {}),
        body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      if (isLikelyOfflineSyncError(e)) {
        return res.json({
          ok: true,
          offline: true,
          session_id: 'local-offline-' + Date.now(),
          session_token: 'local-offline-' + Date.now(),
        });
      }
      res.status(500).json({ ok: false, error: e.message || 'signature_session_open' });
    }
  });

  app.post('/api/dispo_signature_submit', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, payload, localJobId } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const pl = payload && typeof payload === 'object' ? payload : {};
      if (!base) {
        queueDispoProxyPending(db, 'signature', localJobId || technicianId, 'submit', {
          baseUrl: base,
          technician_id: technicianId,
          serverUsername,
          serverPassword,
          payload: pl,
        });
        save();
        return res.json({ ok: true, deferred: true, offline: true });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const url = `${base}/dispo_api/api/signature_submit.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, auth || {}),
        body: JSON.stringify(pl),
      });
      const raw = await r.text();
      if (!r.ok && isLikelyOfflineSyncError(new Error(raw || r.statusText))) {
        queueDispoProxyPending(db, 'signature', localJobId || technicianId, 'submit', {
          baseUrl: base,
          technician_id: technicianId,
          serverUsername,
          serverPassword,
          payload: pl,
        });
        save();
        return res.json({ ok: true, deferred: true, offline: true });
      }
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      if (isLikelyOfflineSyncError(e)) {
        const body = req.body || {};
        queueDispoProxyPending(db, 'signature', body.localJobId || getTechnicianId(req), 'submit', {
          baseUrl: body.baseUrl,
          technician_id: getTechnicianId(req),
          serverUsername: body.serverUsername,
          serverPassword: body.serverPassword,
          payload: body.payload || {},
        });
        save();
        return res.json({ ok: true, deferred: true, offline: true });
      }
      res.status(500).json({ ok: false, error: e.message || 'signature_submit' });
    }
  });

  app.post('/api/dispo_signature_stage_pdf_b64', express.json({ limit: '80mb' }), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, pdfBase64, fileName } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !base || !pdfBase64) {
        return res.status(400).json({ ok: false, error: 'baseUrl, pdfBase64 und technician_id erforderlich.' });
      }
      const buf = Buffer.from(String(pdfBase64), 'base64');
      if (buf.length < 8 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return res.status(400).json({ ok: false, error: 'Kein gültiges PDF (Base64).' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const fd = new FormData();
      fd.append('technician_id', String(technicianId));
      fd.append('file', buf, { filename: (fileName && String(fileName)) || 'upload.pdf', contentType: 'application/pdf' });
      const url = `${base}/dispo_api/api/signature_stage_pdf.php`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({}, auth || {}, fd.getHeaders()),
        body: fd,
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'signature_stage' });
    }
  });

  /**
   * Generischer Proxy fuer die Mobile-RAMS-API (`/api/mobile/rams.php`).
   * Auth: HTTP-Basic gegen `users` (siehe `dispo/auth/require_token.php`).
   * Body: { action, method, queryParams?, payload?, baseUrl }
   * Wird vom Laptop-Frontend (rams_wizard.js) aufgerufen, damit der gleiche
   * Mobile-Endpoint wie in der PWA genutzt werden kann.
   */
  app.all('/api/laptop_rams_proxy', express.json({ limit: '50mb' }), async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const baseUrl = (body.baseUrl || body.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    const action = (body.action || req.query.action || '').toString().trim();
    const method = (body.method || (body.payload ? 'POST' : 'GET')).toString().toUpperCase();
    const queryParams = (body.queryParams && typeof body.queryParams === 'object') ? body.queryParams : {};
    const payload = body.payload;
    try {
      if (!action) {
        return res.status(400).json({ ok: false, error: 'action erforderlich.' });
      }
      if (!baseUrl) {
        if (method !== 'GET' && method !== 'HEAD') {
          queueDispoProxyPending(db, 'rams', action, method.toLowerCase(), {
            action,
            method,
            queryParams,
            payload,
            baseUrl: '',
          });
          save();
          return res.json({ ok: true, deferred: true, offline: true, action });
        }
        return res.status(400).json({ ok: false, error: 'baseUrl erforderlich.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'Basic-Auth erforderlich.' });
      }
      const qs = new URLSearchParams();
      qs.set('action', action);
      Object.keys(queryParams).forEach((k) => {
        if (queryParams[k] !== undefined && queryParams[k] !== null) qs.set(k, String(queryParams[k]));
      });
      const url = `${baseUrl}/api/mobile/rams.php?${qs.toString()}`;
      const headers = Object.assign(
        { Accept: 'application/json' },
        auth || {},
        auth && auth.Authorization ? { 'X-Kukla-Authorization': auth.Authorization } : {}
      );
      const opts = { method: method, headers: headers };
      if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(payload && typeof payload === 'object' ? payload : (payload || {}));
      }
      const r = await fetch(url, opts);
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      if (isLikelyOfflineSyncError(e) && method !== 'GET' && method !== 'HEAD') {
        queueDispoProxyPending(db, 'rams', action, method.toLowerCase(), {
          action,
          method,
          queryParams,
          payload,
          baseUrl,
        });
        save();
        return res.json({ ok: true, deferred: true, offline: true, action });
      }
      res.status(500).json({ ok: false, error: e.message || 'rams_proxy' });
    }
  });

  const anLocal = require('./lib/arbeitsnachweis-local');
  anLocal.ensureArbeitsnachweisLocalSchema(db);

  function anDispoBaseUrl(req, body) {
    const b = body && typeof body === 'object' ? body : {};
    const q = (req.query && req.query.baseUrl) || '';
    const fromBody = b.baseUrl || b.base_url || '';
    const creds = resolveDispoServerCreds(b);
    return String(fromBody || q || creds.baseUrl || '')
      .trim()
      .replace(/\/$/, '');
  }

  function anDispoAuthHeaders(req, extra) {
    const incoming = authHeaderFromIncomingBasicOrQuery(req);
    const headers = Object.assign(
      { Accept: 'application/json' },
      incoming || {},
      extra || {},
    );
    const a = headers.Authorization;
    if (a) {
      headers['X-Kukla-Authorization'] = a;
      headers['X-Authorization'] = a;
    }
    return headers;
  }

  async function tryDispoArbeitsnachweisDraft(req, jobId) {
    const jid = parseInt(jobId, 10) || 0;
    const base = anDispoBaseUrl(req, req.query);
    if (!base || jid <= 0) return null;
    let auth = authHeaderFromIncomingBasicOrQuery(req);
    if (!auth || !auth.Authorization) {
      const creds = resolveDispoServerCreds(req.query || {});
      auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
    }
    if (!auth) return null;
    const url = `${base}/api/mobile/arbeitsnachweis.php?action=draft&job_id=${encodeURIComponent(jid)}`;
    const r = await fetch(url, { method: 'GET', headers: anDispoAuthHeaders(req, auth) });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return null;
    return data;
  }

  async function tryDispoArbeitsnachweisSave(req, dispoPayload) {
    const base = anDispoBaseUrl(req, req.body);
    if (!base) return { ok: false, offline: true };
    let auth = authHeaderFromIncomingBasicOrQuery(req);
    if (!auth || !auth.Authorization) {
      const creds = resolveDispoServerCreds(Object.assign({}, req.body || {}, dispoPayload || {}));
      auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
    }
    if (!auth) return { ok: false, offline: true };
    const url = `${base}/api/mobile/arbeitsnachweis.php?action=save`;
    const headers = anDispoAuthHeaders(req, Object.assign({ 'Content-Type': 'application/json' }, auth));
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ action: 'save' }, dispoPayload || {})),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const err = new Error((data && data.error) || r.statusText || 'Dispo-Speichern fehlgeschlagen');
      err.status = r.status;
      throw err;
    }
    return data;
  }

  app.get('/api/arbeitsnachweis', async (req, res) => {
    try {
      anLocal.ensureArbeitsnachweisLocalSchema(db);
      const latest = req.query.latest === '1' || req.query.latest === 'true';
      const uuid = String(req.query.local_uuid || '').trim();
      const jobId = parseInt(req.query.job_id, 10) || 0;
      const id = parseInt(req.query.id, 10) || 0;
      let loaded = null;
      if (id > 0) loaded = anLocal.loadRow(db, id);
      if (!loaded && uuid) loaded = anLocal.findByUuid(db, uuid);
      if (!loaded && jobId > 0) loaded = anLocal.findByJob(db, jobId);
      if (!loaded && latest) loaded = anLocal.findLatest(db, getTechnicianId(req));
      const pullJobId = jobId
        || (loaded && loaded.document && (loaded.document.server_job_id || loaded.document.local_job_id))
        || 0;
      if (pullJobId > 0) {
        try {
          const remote = await tryDispoArbeitsnachweisDraft(req, pullJobId);
          if (remote && remote.document) {
            const mapped = anLocal.fromDispoPublic(remote);
            if (mapped) {
              const localW = anLocal.contentWeight(loaded || {});
              const remoteW = anLocal.contentWeight(mapped);
              if (loaded && loaded.document && localW > remoteW) {
                const localId = loaded.document.id;
                anLocal.markDirty(db, localId);
                const dispoPayload = anLocal.toDispoSavePayload(loaded);
                if (dispoPayload) {
                  anLocal.queuePending(db, localId, 'save', Object.assign({}, dispoPayload, {
                    technician_id: getTechnicianId(req),
                    baseUrl: anDispoBaseUrl(req, {}),
                  }));
                }
                return res.json(anLocal.toPublic(loaded));
              }
              const loc = (loaded && loaded.arbeitsnachweis) || {};
              const mappedAn = mapped.arbeitsnachweis || {};
              const remoteSigner = String(mapped.signer_name || mappedAn.signer_name || '').trim();
              if (!remoteSigner && loc.signer_name) {
                mapped.signer_name = loc.signer_name;
                mappedAn.signer_name = loc.signer_name;
              }
              if (!String(mapped.signer_email || mappedAn.signer_email || '').trim() && loc.signer_email) {
                mapped.signer_email = loc.signer_email;
                mappedAn.signer_email = loc.signer_email;
              }
              if (!mapped.save_contact && !mappedAn.save_contact && loc.save_contact) {
                mapped.save_contact = true;
                mappedAn.save_contact = true;
              }
              mapped.arbeitsnachweis = mappedAn;
              const keptLocalSigner = !remoteSigner && !!String(loc.signer_name || '').trim();
              return res.json(anLocal.upsertFromPayload(db, mapped, {
                technicianId: getTechnicianId(req),
                dirty: keptLocalSigner,
              }));
            }
          }
        } catch (ePull) {
          // lokal bleibt
        }
      }
      return res.json(anLocal.toPublic(loaded));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'arbeitsnachweis_get' });
    }
  });

  app.get('/api/arbeitsnachweis/list', (req, res) => {
    try {
      anLocal.ensureArbeitsnachweisLocalSchema(db);
      const jobId = parseInt(req.query.job_id, 10) || 0;
      const documents = jobId > 0 ? anLocal.listByJob(db, jobId) : [];
      res.json({ ok: true, documents });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'arbeitsnachweis_list' });
    }
  });

  app.post('/api/arbeitsnachweis', express.json({ limit: '12mb' }), async (req, res) => {
    try {
      anLocal.ensureArbeitsnachweisLocalSchema(db);
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const techId = getTechnicianId(req);
      const local = anLocal.upsertFromPayload(db, payload, { technicianId: techId, dirty: true });
      const localId = local && local.local_id;
      const dispoPayload = anLocal.toDispoSavePayload(anLocal.loadRow(db, localId));
      if (dispoPayload) dispoPayload.baseUrl = anDispoBaseUrl(req, payload);
      let synced = false;
      try {
        const remote = await tryDispoArbeitsnachweisSave(req, dispoPayload);
        if (remote && remote.ok) {
          anLocal.markSynced(db, localId, remote.document_id, {
            number: remote.number,
            status: remote.status,
            content_version: remote.content_version,
            local_uuid: remote.local_uuid,
          });
          synced = true;
          Object.assign(local, anLocal.toPublic(anLocal.loadRow(db, localId)));
          local.server_id = remote.document_id;
          local.document_id = remote.document_id;
          local.synced = true;
          if (remote.local_uuid) local.local_uuid = remote.local_uuid;
        }
      } catch (e) {
        anLocal.queuePending(db, localId, 'save', Object.assign({}, dispoPayload || {}, {
          technician_id: techId,
          baseUrl: anDispoBaseUrl(req, payload),
        }));
      }
      if (!synced && localId) {
        anLocal.queuePending(db, localId, 'save', Object.assign({}, dispoPayload || {}, {
          technician_id: techId,
          baseUrl: anDispoBaseUrl(req, payload),
        }));
      }
      save();
      res.json(Object.assign({ ok: true, document_id: local.server_id || 0, local_id: localId }, local, {
        synced,
        offline: !synced,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'arbeitsnachweis_save' });
    }
  });

  app.all('/api/laptop_arbeitsnachweis_proxy', express.json({ limit: '20mb' }), async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const baseUrl = (body.baseUrl || body.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    const action = (body.action || req.query.action || '').toString().trim();
    const method = (body.method || (body.payload || action === 'save' || action === 'signature' || action === 'pdf_upload' || action === 'timesheet_apply' || action === 'timesheet_preview' || action === 'contact_save' ? 'POST' : 'GET')).toString().toUpperCase();
    const queryParams = (body.queryParams && typeof body.queryParams === 'object') ? body.queryParams : {};
    const payload = body.payload;
    try {
      if (!action) {
        return res.status(400).json({ ok: false, error: 'action erforderlich.' });
      }
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: 'baseUrl erforderlich.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'Basic-Auth erforderlich.' });
      }
      const qs = new URLSearchParams();
      qs.set('action', action);
      Object.keys(queryParams).forEach((k) => {
        if (queryParams[k] !== undefined && queryParams[k] !== null) qs.set(k, String(queryParams[k]));
      });
      const url = `${baseUrl}/api/mobile/arbeitsnachweis.php?${qs.toString()}`;
      const headers = Object.assign(
        { Accept: 'application/json' },
        auth || {},
        auth && auth.Authorization ? { 'X-Kukla-Authorization': auth.Authorization } : {}
      );
      const opts = { method: method, headers: headers };
      if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        const postBody = payload && typeof payload === 'object' ? Object.assign({ action: action }, payload) : { action: action };
        opts.body = JSON.stringify(postBody);
      }
      const r = await fetch(url, opts);
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('pdf') !== -1) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.status(r.status).type('application/pdf').send(buf);
        return;
      }
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'arbeitsnachweis_proxy' });
    }
  });

  app.post('/api/arbeitsnachweis/pdf', express.json({ limit: '12mb' }), async (req, res) => {
    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const lang = payload.language === 'en' || (payload.document && payload.document.language === 'en') ? 'en' : 'de';
      const techId = getTechnicianId(req);
      if (!payload.technician_signature_png && techId) {
        try {
          payload.technician_signature_png = await resolveTechnicianSignaturePng(techId, payload);
        } catch (_) { /* optional */ }
      }
      const pdfBytes = await protocolPdf.generateArbeitsnachweisPdfBuffer(payload, { lang });
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
      const num = (payload.document && payload.document.number) || ('AN-' + Date.now());
      const safe = String(num).replace(/[^\w.-]+/g, '_') || ('AN-' + Date.now());
      const fileName = safe + '.pdf';
      let archivePath = '';
      try {
        const jobId = parseInt(payload.job_id || (payload.document && payload.document.job_id) || 0, 10);
        if (jobId > 0) {
          const reiseDir = resolveDienstreiseReiseDirForJob(jobId, { createIfMissing: true });
          if (reiseDir) {
            const dir = path.join(reiseDir, 'Dokumente_Monteur', 'Arbeitsnachweise');
            fs.mkdirSync(dir, { recursive: true });
            archivePath = path.join(dir, fileName);
            fs.writeFileSync(archivePath, pdfBytes);
          }
        }
      } catch (e) {
        console.error('[arbeitsnachweis/pdf] Archiv-Kopie fehlgeschlagen:', e && e.message);
      }
      const tmpDir = path.join(os.tmpdir(), 'kukla-arbeitsnachweis');
      fs.mkdirSync(tmpDir, { recursive: true });
      const savedPath = path.join(tmpDir, fileName);
      fs.writeFileSync(savedPath, pdfBytes);
      if (!fs.existsSync(savedPath) || fs.statSync(savedPath).size < 8) {
        throw new Error('PDF-Datei konnte nicht gespeichert werden.');
      }
      res.json({
        ok: true,
        pdf_base64: pdfBase64,
        path: savedPath,
        archive_path: archivePath || null,
      });
    } catch (e) {
      console.error('[arbeitsnachweis/pdf]', e);
      res.status(500).json({ ok: false, error: e.message || 'PDF-Erzeugung fehlgeschlagen' });
    }
  });

  app.post('/api/arbeitsnachweis/outlook', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      const result = kundenDokumentation.openOutlookDraft({
        recipients: Array.isArray(body.recipients) ? body.recipients : [],
        attachments,
        subject: body.subject || 'Arbeitsnachweis / Working report',
        body: body.body || '',
        htmlBody: body.html_body || body.htmlBody || '',
      });
      res.json({ ok: true, outlook: result });
    } catch (e) {
      res.json({ ok: false, outlook_error: e && e.message ? e.message : String(e) });
    }
  });

  /**
   * Aktive Auftraege des Technikers fuer "RAMS Erstellen" im Laptop.
   * Liefert das schon vorhandene Dispo-Endpoint `dispo_api/api/jobs_open.php`.
   * Diese Route ist ein Convenience-Wrapper um POST mit JSON-Body, weil das
   * Laptop-Frontend dieselbe Calling-Convention wie der RAMS-Proxy nutzt.
   */
  app.post('/api/laptop_active_jobs_for_rams', express.json(), async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const baseUrl = (body.baseUrl || body.base_url || '').toString().trim().replace(/\/$/, '');
      const technicianId = body.technicianId || body.technician_id || getTechnicianId(req);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technicianId erforderlich.' });
      }
      if (!baseUrl) {
        const rows = queryJobsOpenLocalRows(db, technicianId, {});
        return res.json({ ok: true, jobs: rows, data_source: 'local' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      const url = `${baseUrl}/dispo_api/api/jobs_open.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, { method: 'GET', headers: Object.assign({ Accept: 'application/json' }, auth || {}) });
      const raw = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: (parsed && parsed.error) || 'Dispo-Fehler', raw: raw.slice(0, 400) });
      }
      const jobs = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.jobs) ? parsed.jobs : []);
      res.json({ ok: true, jobs: jobs });
    } catch (e) {
      try {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const technicianId = body.technicianId || body.technician_id || getTechnicianId(req);
        if (technicianId) {
          const rows = queryJobsOpenLocalRows(db, technicianId, {});
          return res.json({ ok: true, jobs: rows, data_source: 'local_fallback' });
        }
      } catch (_) {}
      res.status(500).json({ ok: false, error: e.message || 'jobs_proxy' });
    }
  });

  /**
   * Whitelist-Proxy fuer ausgewaehlte Mobile-API-Skripte (Signatur-Session/Submit).
   * Gleiche Basic-Auth wie laptop_rams_proxy. Pfad relativ zur Dispo-Base.
   */
  app.post('/api/laptop_mobile_post', express.json({ limit: '80mb' }), async (req, res) => {
    try {
      const allowed = new Set([
        '/api/mobile/signature_session_open.php',
        '/api/mobile/signature_submit.php',
      ]);
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const baseUrl = (body.baseUrl || body.base_url || '').toString().trim().replace(/\/$/, '');
      let relPath = (body.path || '').toString().trim();
      if (!relPath.startsWith('/')) {
        relPath = '/' + relPath;
      }
      if (!baseUrl || !allowed.has(relPath)) {
        return res.status(400).json({ ok: false, error: 'baseUrl oder path ungueltig.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'Basic-Auth erforderlich.' });
      }
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      const url = `${baseUrl}${relPath}`;
      const headers = Object.assign(
        { Accept: 'application/json', 'Content-Type': 'application/json' },
        auth || {},
        auth && auth.Authorization ? { 'X-Kukla-Authorization': auth.Authorization } : {}
      );
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'laptop_mobile_post' });
    }
  });

  /** PDF aus lokalem Dienstreise-Ordner stagen (Montagebericht → Dispo-Signatur). */
  app.post('/api/montagebericht_signature_stage', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const {
        localJobId,
        relativePath,
        baseUrl,
        serverUsername,
        serverPassword,
      } = req.body || {};
      const jid = parseInt(String(localJobId || ''), 10);
      const rel = (relativePath || '').toString().trim().replace(/\\/g, '/');
      if (!technicianId || !jid || !rel) {
        return res.status(400).json({ ok: false, error: 'localJobId und relativePath erforderlich.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(jid);
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });
      }
      const fullPath = path.join(reiseDir, rel.split('/').join(path.sep));
      const resolved = path.resolve(fullPath);
      const baseResolved = path.resolve(reiseDir);
      if (!resolved.startsWith(baseResolved)) {
        return res.status(400).json({ ok: false, error: 'Pfad ungültig.' });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ ok: false, error: 'PDF nicht gefunden.' });
      }
      const buf = fs.readFileSync(resolved);
      if (buf.length < 8 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return res.status(400).json({ ok: false, error: 'Kein gültiges PDF.' });
      }
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!base) {
        return res.status(400).json({ ok: false, error: 'Dispo baseUrl erforderlich.' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const fd = new FormData();
      fd.append('technician_id', String(technicianId));
      fd.append('file', buf, {
        filename: path.basename(rel) || 'montage.pdf',
        contentType: 'application/pdf',
      });
      const url = `${base}/dispo_api/api/signature_stage_pdf.php`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({}, auth || {}, fd.getHeaders()),
        body: fd,
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'montagebericht_signature_stage' });
    }
  });

  app.post('/api/anlagenstamm_from_dispo', express.json(), async (req, res) => {
    const { baseUrl, fabs } = req.body || {};
    const list = Array.isArray(fabs) ? fabs.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim()) : [];
    if (list.length === 0) {
      return res.status(400).json({ ok: false, error: 'fabs (Array) erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    const localRows = anlagenstammGetRowsByFabs(db, list);
    if (wantsLocalOnlyRequest(req.body || {})) {
      return res.json({ ok: true, data: localRows, _source: 'local' });
    }
    if (localRows.length > 0 && anlagenstammLocalRowCount(db) > 0) {
      return res.json({ ok: true, data: localRows, _source: 'local' });
    }
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl und fabs (Array) erforderlich.' });
    }
    const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(list.join(','))}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  function attachMotorsToLocalStammRow(dbConn, row) {
    if (!row) return null;
    const out = Object.assign({}, row);
    try {
      out.motoren = listMotorsForStamm(dbConn, row.id);
    } catch (_) {
      out.motoren = [];
    }
    return out;
  }

  app.post('/api/anlagenstamm_lookup', express.json(), async (req, res) => {
    const body = req.body || {};
    const { baseUrl, fab, serverUsername, serverPassword } = body;
    const fabValue = (fab || '').toString().trim();
    if (!fabValue) {
      return res.status(400).json({ ok: false, error: 'fab erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    const syncDispo =
      body.sync_dispo === '1' ||
      body.sync_dispo === 1 ||
      body.sync_dispo === true;
    const localOnly = wantsLocalOnlyRequest(body) || !syncDispo;
    if (localOnly) {
      const row = attachMotorsToLocalStammRow(db, anlagenstammLookupByFab(db, fabValue));
      return res.json({
        ok: true,
        row: row || null,
        anlage: row || null,
        _source: row ? 'local' : 'local_miss',
      });
    }
    if (anlagenstammLocalRowCount(db) > 0) {
      const row = attachMotorsToLocalStammRow(db, anlagenstammLookupByFab(db, fabValue));
      if (row) {
        return res.json({ ok: true, row, anlage: row, _source: 'local' });
      }
    }
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.json({ ok: true, row: null, anlage: null, _source: 'local_miss' });
    }
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!base) {
      return res.json({ ok: true, row: null, anlage: null, _source: 'none' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_lookup.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_search', express.json(), async (req, res) => {
    const body = req.body || {};
    ensureAnlagenstammLocalSchema(db);
    const forceOnline =
      body.force_online === true ||
      body.force_online === 1 ||
      String(body.force_online || '').toLowerCase() === 'true';
    if (!forceOnline && anlagenstammLocalRowCount(db) > 0) {
      const local = anlagenstammSearchLocal(db, body);
      if (local.ok) return res.json(local);
    }
    const technicianId =
      getTechnicianId(req) ??
      (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id erforderlich (kein lokaler Treffer).' });
    }
    const hasBase = buildDispoBaseCandidates({
      baseUrl: body.baseUrl,
      externalUrl: body.externalUrl,
      internalUrl: body.internalUrl,
    }).length > 0;
    if (!hasBase) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
    }
    try {
      const data = await proxyAnlagenstammSearch(Object.assign({}, body, { technician_id: technicianId }));
      if (data && data.ok === false) {
        const code = Number(data._httpStatus) >= 400 ? Number(data._httpStatus) : 502;
        const out = Object.assign({}, data);
        delete out._httpStatus;
        return res.status(code).json(out);
      }
      const ok = Object.assign({}, data);
      delete ok._httpStatus;
      res.json(ok);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const technicianId =
      getTechnicianId(req) ??
      (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
    const result = await performAnlagenstammSave(body, technicianId);
    if (!result.ok) {
      return res.status(result.error && String(result.error).includes('technician') ? 400 : 500).json(result);
    }
    res.json(result);
  });

  app.post('/api/anlagenstamm_files_list', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const { baseUrl, fab, serverUsername, serverPassword } = body;
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    const forceOnline =
      body.force_online === true ||
      body.force_online === 1 ||
      String(body.force_online || '').toLowerCase() === 'true';
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    // Offline-First: Cache zuerst, außer force_online
    try {
      const cached = readAnlagenstammTreeCache(db, fabValue);
      if (cached && cached.tree && cached.tree.length && !forceOnline) {
        const folder =
          (cached.root_folder_name && String(cached.root_folder_name).trim()) ||
          readAnlagenstammRootFolderName(db, fabValue) ||
          '';
        return res.json({
          ok: true,
          fab: fabValue,
          projekte_neu: { enabled: !!cached.projects_enabled, tree: cached.tree },
          data_source: 'cache',
          folder,
          cache_notice: 'Cache – Sync aktualisiert im Hintergrund.',
        });
      }
    } catch (e) {
      if (!base) {
        return res.status(500).json({ ok: false, error: e.message || String(e) });
      }
    }
    if (!base) {
      return res.status(503).json({ ok: false, error: 'Kein Anlagenstamm-Dateibaum im lokalen Cache.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_files_list.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}`;
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      try {
        const pnRaw = data && data.projekte_neu ? data.projekte_neu : { enabled: false, tree: [] };
        upsertAnlagenstammTreeCache(db, fabValue, pnRaw);
        save();
      } catch (_) { /* cache ist best-effort */ }
      res.json(data);
    } catch (e) {
      try {
        const cached = readAnlagenstammTreeCache(db, fabValue);
        if (cached && cached.tree && cached.tree.length) {
          const folder =
            (cached.root_folder_name && String(cached.root_folder_name).trim()) ||
            readAnlagenstammRootFolderName(db, fabValue) ||
            '';
          return res.json({
            ok: true,
            fab: fabValue,
            projekte_neu: { enabled: !!cached.projects_enabled, tree: cached.tree },
            data_source: 'cache',
            folder,
            cache_notice: 'Cache – Dispo nicht erreichbar.',
          });
        }
      } catch (_) {}
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_parameter_files_list', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const fabValue = String(body.fab || '').trim();
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    try {
      const fabNorm = normalizeParameterFab(fabValue);
      if (!fabNorm) return res.status(400).json({ ok: false, error: 'Ungültige Fabrikationsnummer.' });
      ensureAnlagenstammLocalSchema(db);
      const mapLocalFiles = (rows) =>
        rows.map((row) => ({
          id: row.server_file_id != null ? Number(row.server_file_id) : row.id,
          local_id: row.id,
          fab: row.fab,
          source: row.source,
          source_file_status: row.source_file_status || 'present',
          technician_id: row.technician_id,
          technician_name: row.technician_name || null,
          uploaded_at: row.uploaded_at || null,
          original_filename: row.original_filename || '',
          size: row.size != null ? Number(row.size) : 0,
          mime: row.mime || 'application/octet-stream',
          entry_count: row.entry_count != null ? Number(row.entry_count) : 0,
          source_path: row.source_path || null,
        }));
      const candidates = buildDispoBaseCandidates({
        baseUrl: body.baseUrl,
        externalUrl: body.externalUrl,
        internalUrl: body.internalUrl,
      });
      if (candidates.length > 0) {
        try {
          const remote = await proxyAnlagenstammParameterFilesList(
            Object.assign({}, body, { technician_id: technicianId, fab: fabNorm }),
          );
          if (remote && remote.ok !== false && Array.isArray(remote.files)) {
            cacheParameterFilesFromDispo(db, fabNorm, remote.files);
            save();
            return res.json({
              ok: true,
              fab: fabNorm,
              files: remote.files,
              data_source: 'dispo',
            });
          }
        } catch (dispoErr) {
          console.warn('[parameter_files_list] Dispo:', dispoErr && dispoErr.message ? dispoErr.message : dispoErr);
        }
      }
      const files = mapLocalFiles(listParameterFilesByFab(db, fabNorm));
      return res.json({
        ok: true,
        fab: fabNorm,
        files,
        data_source: 'cache',
        cache_notice: 'Cache – nicht mit Dispo synchron (offline oder keine Verbindung).',
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_parameter_trend', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const fabValue = String(body.fab || '').trim();
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    try {
      const fabNorm = normalizeParameterFab(fabValue);
      if (!fabNorm) return res.status(400).json({ ok: false, error: 'Ungültige Fabrikationsnummer.' });
      ensureAnlagenstammLocalSchema(db);
      const candidates = buildDispoBaseCandidates({
        baseUrl: body.baseUrl,
        externalUrl: body.externalUrl,
        internalUrl: body.internalUrl,
      });
      if (candidates.length > 0) {
        try {
          const remote = await proxyAnlagenstammParameterTrend(
            Object.assign({}, body, { technician_id: technicianId, fab: fabNorm }),
          );
          if (remote && remote.ok !== false) {
            return res.json(Object.assign({ data_source: 'dispo' }, remote));
          }
        } catch (dispoErr) {
          console.warn('[parameter_trend] Dispo:', dispoErr && dispoErr.message ? dispoErr.message : dispoErr);
        }
      }
      const mode = String(body.mode || 'pair').toLowerCase().trim();
      if (mode === 'chain' || mode === 'all' || body.chain === true) {
        const chain = buildParameterTrendChain(db, fabNorm);
        if (!chain.ok) return res.status(400).json(chain);
        return res.json(
          Object.assign({ data_source: 'cache', cache_notice: 'Cache – nicht mit Dispo synchron.' }, chain),
        );
      }
      let fromId = parseInt(body.from_file_id, 10);
      let toId = parseInt(body.to_file_id, 10);
      const resolveLocalId = (serverOrLocalId) => {
        const n = parseInt(serverOrLocalId, 10);
        if (!Number.isFinite(n) || n <= 0) return 0;
        const byServer = db
          .prepare('SELECT id FROM anlagenstamm_parameter_files WHERE fab = ? AND server_file_id = ? LIMIT 1')
          .get(fabNorm, n);
        if (byServer && byServer.id) return Number(byServer.id);
        const byLocal = db
          .prepare('SELECT id FROM anlagenstamm_parameter_files WHERE fab = ? AND id = ? LIMIT 1')
          .get(fabNorm, n);
        return byLocal && byLocal.id ? Number(byLocal.id) : 0;
      };
      fromId = resolveLocalId(fromId);
      toId = resolveLocalId(toId);
      const files = listParameterFilesByFab(db, fabNorm);
      if (!fromId || !toId) {
        if (files.length < 2) {
          return res.status(400).json({
            ok: false,
            error: 'Mindestens zwei Parameterlisten nötig. Bitte Von/Zu auswählen.',
          });
        }
        const chron = db
          .prepare(
            `SELECT id FROM anlagenstamm_parameter_files
             WHERE fab = ? ORDER BY datetime(uploaded_at) ASC, id ASC`,
          )
          .all(fabNorm);
        fromId = chron[0].id;
        toId = chron[chron.length - 1].id;
      }
      if (fromId === toId) {
        return res.status(400).json({ ok: false, error: 'Von- und Zu-Liste müssen unterschiedlich sein.' });
      }
      const result = compareParameterFilesById(db, fabNorm, fromId, toId);
      if (!result.ok) return res.status(404).json(result);
      return res.json(
        Object.assign(
          {
            ok: true,
            fab: fabNorm,
            mode: 'pair',
            data_source: 'cache',
            cache_notice: 'Cache – nicht mit Dispo synchron.',
          },
          result,
        ),
      );
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_parameter_download', express.json({ limit: '40mb' }), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const fabValue = String(body.fab || '').trim();
    const fileId = parseInt(body.file_id, 10);
    const openLocal = body.open_local === true || body.open_local === 1 || body.open_local === '1';
    if (!technicianId || !fabValue || !Number.isFinite(fileId) || fileId <= 0) {
      return res.status(400).json({ ok: false, error: 'fab, file_id und technician_id erforderlich.' });
    }
    const fabNorm = normalizeParameterFab(fabValue);
    if (!fabNorm) return res.status(400).json({ ok: false, error: 'Ungültige Fabrikationsnummer.' });
    const candidates = buildDispoBaseCandidates({
      baseUrl: body.baseUrl,
      externalUrl: body.externalUrl,
      internalUrl: body.internalUrl,
    });
    if (candidates.length > 0) {
      try {
        const remote = await proxyAnlagenstammParameterDownload(
          Object.assign({}, body, { technician_id: technicianId, fab: fabNorm, file_id: fileId }),
        );
        if (remote && remote.ok && remote.buffer) {
          const disp = remote.contentDisposition || '';
          const xName = remote.xDownloadFilename || '';
          let fileName = xName || 'parameterliste';
          if (xName) {
            try { fileName = decodeURIComponent(xName); } catch (_) { fileName = xName; }
          } else {
            const m = String(disp).match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
            if (m && m[1]) {
              try { fileName = decodeURIComponent(m[1]); } catch (_) { fileName = m[1]; }
            }
          }
          if (openLocal) {
            const safe = String(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'parameterliste';
            const tmpPath = path.join(os.tmpdir(), 'kukla-param-' + fileId + '-' + Date.now() + '-' + safe);
            try {
              fs.writeFileSync(tmpPath, remote.buffer);
              return res.json({ ok: true, path: tmpPath, file_name: fileName });
            } catch (writeErr) {
              return res.status(500).json({
                ok: false,
                error: writeErr && writeErr.message ? writeErr.message : 'Temp-Datei fehlgeschlagen.',
              });
            }
          }
          if (disp) res.setHeader('Content-Disposition', disp);
          if (xName) res.setHeader('X-Download-Filename', xName);
          res.setHeader('Content-Type', remote.contentType || 'application/octet-stream');
          res.setHeader('Content-Length', String(remote.buffer.length));
          return res.send(remote.buffer);
        }
        if (remote && remote.ok === false && remote._httpStatus !== 404) {
          return res.status(Number(remote._httpStatus) || 502).json(remote);
        }
      } catch (dispoErr) {
        console.warn('[parameter_download] Dispo:', dispoErr && dispoErr.message ? dispoErr.message : dispoErr);
      }
    }
    return res.status(404).json({
      ok: false,
      error: 'Download nur online über Dispo verfügbar (file_id).',
      cache_only: true,
    });
  });

  app.get('/api/anlagenstamm_tree_cached', (req, res) => {
    const fab = String(req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'fab erforderlich.' });
    try {
      const cached = readAnlagenstammTreeCache(db, fab);
      if (!cached || !cached.tree.length) {
        return res.json({ ok: true, found: false, fab: fab, projects_enabled: false, tree: [], folder: '' });
      }
      const folder =
        (cached.root_folder_name && String(cached.root_folder_name).trim()) ||
        readAnlagenstammRootFolderName(db, fab) ||
        '';
      return res.json({
        ok: true,
        found: true,
        fab: cached.fab,
        projects_enabled: cached.projects_enabled,
        tree: cached.tree,
        synced_at: cached.synced_at,
        folder,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_file_download', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const {
      baseUrl,
      fab,
      file,
      path: pnPathRaw,
      source: sourceRaw,
      serverUsername,
      serverPassword,
      thumb: thumbRaw,
      thumbMax: thumbMaxRaw,
      inline: inlineRaw,
      job_id: jobIdRaw,
    } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    const fileValue = (file || '').toString().trim();
    const sourceNorm = String(sourceRaw || '').toLowerCase().trim();
    const pnPath = (pnPathRaw || '').toString().trim();
    const wantThumb =
      thumbRaw === true ||
      thumbRaw === 1 ||
      String(thumbRaw || '').toLowerCase() === 'true';
    const wantInline =
      inlineRaw === true ||
      inlineRaw === 1 ||
      String(inlineRaw || '').toLowerCase() === 'true';
    let thumbMax = parseInt(thumbMaxRaw, 10);
    if (!Number.isFinite(thumbMax)) thumbMax = 256;
    thumbMax = Math.min(512, Math.max(64, thumbMax));
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    if (sourceNorm === 'projekte_neu' && pnPath && wantThumb) {
      return serveProjekteNeuThumb(res, technicianId, fabValue, pnPath, thumbMax, null, {
        preferCache: true,
      });
    }
    if (sourceNorm === 'projekte_neu' && pnPath) {
      const filePath = resolveProjekteNeuLocalFilePathAll(technicianId, fabValue, pnPath, jobIdRaw, {
        skipDeepSearch: false,
      });
      if (filePath) {
        try {
          const buf = fs.readFileSync(filePath);
          const baseName = path.basename(filePath);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('X-Download-Filename', encodeURIComponent(baseName));
          res.setHeader(
            'Content-Disposition',
            (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
          );
          res.setHeader('Content-Length', String(buf.length));
          return res.send(buf);
        } catch (_) {
          /* fall through to Dispo */
        }
      }
    }
    if (sourceNorm !== 'projekte_neu' && fileValue) {
      const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile()) {
        const buf = fs.readFileSync(cacheFile);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Download-Filename', encodeURIComponent(fileValue));
        res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(fileValue) + '"');
        res.setHeader('Content-Length', String(buf.length));
        return res.send(buf);
      }
    }
    if (sourceNorm === 'projekte_neu' && pnPath && !base) {
      return res.status(404).json({
        ok: false,
        error: 'Datei nicht lokal verfügbar (offline). Einmal online öffnen zum Herunterladen.',
        local_unavailable: true,
      });
    }
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl, fab und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    let url;
    if (sourceNorm === 'projekte_neu') {
      if (!pnPath) {
        return res.status(400).json({ ok: false, error: 'path erforderlich für PROJEKTE NEU.' });
      }
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}`;
    } else {
      if (!fileValue) {
        return res.status(400).json({ ok: false, error: 'baseUrl, fab, file und technician_id erforderlich.' });
      }
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&file=${encodeURIComponent(fileValue)}`;
    }
    const qs = [];
    if (wantThumb) {
      qs.push('thumb=1');
      qs.push(`thumb_max=${encodeURIComponent(String(thumbMax))}`);
    }
    if (wantInline) qs.push('inline=1');
    if (qs.length) url += '&' + qs.join('&');
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const fallbackFn = sourceNorm === 'projekte_neu'
        ? (pnPath.split(/[/\\]/).pop() || 'download')
        : fileValue;
      if (sourceNorm !== 'projekte_neu' && fileValue && buf.length) {
        try {
          const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
          const cacheDir = path.dirname(cacheFile);
          if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cacheFile, buf);
        } catch (_) {}
      }
      if (sourceNorm === 'projekte_neu' && pnPath && buf.length) {
        try {
          if (wantThumb) {
            writeCachedProjekteNeuThumb(db, DB_DIR, fabValue, pnPath, thumbMax, buf, 'image/webp', null);
            if (monteurRuntime.save) monteurRuntime.save();
          } else {
            writeCachedProjekteNeuFile(DB_DIR, fabValue, pnPath, buf);
          }
        } catch (_) {}
      }
      const cd = r.headers.get('content-disposition') || ('attachment; filename="' + encodeURIComponent(fallbackFn) + '"');
      const downloadName = contentDispositionFilename(cd) || fallbackFn;
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', cd);
      res.setHeader('X-Download-Filename', encodeURIComponent(downloadName));
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** GET-Variante für Thumbnails/Links in Anlagenstamm-UI (offline: lokaler Projektordner). */
  app.get('/api/anlagenstamm_file_download.php', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const fabValue = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
      const pnPath = String(req.query.path || '').trim();
      const sourceNorm = String(req.query.source || '').toLowerCase().trim();
      const wantThumb =
        String(req.query.thumb || '').toLowerCase() === '1' || req.query.thumb === 'true';
      const wantInline =
        String(req.query.inline || '').toLowerCase() === '1' || req.query.inline === 'true';
      const preferCache =
        String(req.query.prefer_cache || '').toLowerCase() === '1' ||
        String(req.query.prefer_cache || '').toLowerCase() === 'true';
      const thumbOpts = { preferCache };
      let thumbMax = parseInt(req.query.thumbMax || req.query.thumb_max, 10);
      if (!Number.isFinite(thumbMax)) thumbMax = 256;
      thumbMax = Math.min(512, Math.max(64, thumbMax));
      if (!technicianId || !fabValue) {
        return res.status(400).json({ success: false, error: 'fab erforderlich.' });
      }
      if (wantThumb && sourceNorm === 'projekte_neu' && pnPath) {
        return serveProjekteNeuThumb(res, technicianId, fabValue, pnPath, thumbMax, null, thumbOpts);
      }
      if (sourceNorm === 'projekte_neu' && pnPath) {
        const localPath = resolveProjekteNeuLocalFilePathAll(technicianId, fabValue, pnPath, req.query.job_id, {
          skipDeepSearch: false,
        });
        if (localPath) {
          try {
            const buf = fs.readFileSync(localPath);
            const baseName = path.basename(localPath);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader(
              'Content-Disposition',
              (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
            );
            res.setHeader('Content-Length', String(buf.length));
            return res.send(buf);
          } catch (_) {
            /* fall through */
          }
        }
      }
      let localJobId = parseInt(req.query.job_id, 10);
      if (!Number.isFinite(localJobId) || localJobId <= 0) {
        localJobId = resolveLocalJobIdForFab(technicianId, fabValue);
      }
      if (localJobId && pnPath) {
        let filePath = null;
        if (sourceNorm === 'projekte_neu') {
          filePath = resolveProjekteNeuLocalFilePath(localJobId, fabValue, pnPath, { skipDeepSearch: wantThumb });
        }
        if (!filePath) {
          const relNorm = pnPath.replace(/\//g, path.sep);
          filePath = resolveDienstreiseProjectFilePath(localJobId, relNorm);
        }
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          if (wantThumb) {
            return serveProjekteNeuThumb(res, technicianId, fabValue, pnPath, thumbMax, filePath, thumbOpts);
          }
          const buf = fs.readFileSync(filePath);
          const baseName = path.basename(filePath);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader(
            'Content-Disposition',
            (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
          );
          res.setHeader('Content-Length', String(buf.length));
          return res.send(buf);
        }
      }
      const fileValue = String(req.query.file || '').trim();
      if (sourceNorm !== 'projekte_neu' && fileValue) {
        const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
        if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile()) {
          const buf = fs.readFileSync(cacheFile);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('X-Download-Filename', encodeURIComponent(fileValue));
          res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(fileValue) + '"');
          res.setHeader('Content-Length', String(buf.length));
          return res.send(buf);
        }
      }
      const creds = loadDispoWebSessionCreds();
      const base = (creds.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!base) {
        return res.status(404).json({ success: false, error: 'Datei nicht lokal gefunden.' });
      }
      const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
      let url;
      if (sourceNorm === 'projekte_neu') {
        if (!pnPath) {
          return res.status(400).json({ success: false, error: 'path erforderlich für PROJEKTE NEU.' });
        }
        url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}`;
      } else {
        if (!fileValue) {
          return res.status(404).json({ success: false, error: 'Datei nicht lokal gefunden.' });
        }
        url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&file=${encodeURIComponent(fileValue)}`;
      }
      const qs = [];
      if (wantThumb) {
        qs.push('thumb=1');
        qs.push(`thumb_max=${encodeURIComponent(String(thumbMax))}`);
      }
      if (wantInline) qs.push('inline=1');
      if (qs.length) url += '&' + qs.join('&');
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res
          .status(r.status)
          .json(data.ok === false || data.success === false ? data : { success: false, error: data.error || r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const fallbackFn =
        sourceNorm === 'projekte_neu' ? pnPath.split(/[/\\]/).pop() || 'download' : fileValue;
      if (sourceNorm === 'projekte_neu' && pnPath && buf.length) {
        try {
          if (wantThumb) {
            writeCachedProjekteNeuThumb(db, DB_DIR, fabValue, pnPath, thumbMax, buf, 'image/webp', null);
            if (monteurRuntime.save) monteurRuntime.save();
          } else {
            writeCachedProjekteNeuFile(DB_DIR, fabValue, pnPath, buf);
          }
        } catch (_) {}
      }
      const cd = r.headers.get('content-disposition') || ('attachment; filename="' + encodeURIComponent(fallbackFn) + '"');
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', cd);
      res.setHeader('X-Download-Filename', encodeURIComponent(fallbackFn));
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_file_open', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const {
      baseUrl,
      fab,
      file,
      path: pnPathRaw,
      source: sourceRaw,
      fallbackName,
      serverUsername,
      serverPassword,
      job_id: jobIdRaw,
      local_only: localOnlyRaw,
    } = req.body || {};
    const sessionCreds = loadDispoWebSessionCreds();
    const base = (baseUrl || sessionCreds.baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    const fileValue = (file || '').toString().trim();
    const sourceNorm = String(sourceRaw || '').toLowerCase().trim();
    const pnPath = (pnPathRaw || '').toString().trim();
    const localOnly =
      localOnlyRaw === true ||
      localOnlyRaw === 1 ||
      String(localOnlyRaw || '').toLowerCase() === 'true';
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    if (sourceNorm === 'projekte_neu' && pnPath) {
      let localJobId = parseInt(jobIdRaw, 10);
      if (!Number.isFinite(localJobId) || localJobId <= 0) localJobId = null;
      if (localJobId) {
        const mapped = getJobRowByLocalOrServerId(localJobId);
        localJobId = mapped ? mapped.id : null;
      }
      if (!localJobId) localJobId = resolveLocalJobIdForFab(technicianId, fabValue);
      if (localJobId) {
        const localPath = resolveProjekteNeuLocalFilePath(localJobId, fabValue, pnPath);
        if (localPath) {
          try {
            console.log('[anlagenstamm_file_open] local', localPath);
          } catch (_) {}
          return res.json({ ok: true, path: localPath, filename: path.basename(localPath), source: 'local' });
        }
      }
      if (localOnly) {
        return res.status(404).json({
          ok: false,
          code: 'local_miss',
          error: 'Datei nicht lokal gefunden.',
          local_unavailable: true,
        });
      }
      if (!base) {
        return res.status(404).json({
          ok: false,
          error: 'Datei nicht lokal gefunden. Bitte Dispo-Verbindung prüfen.',
          local_unavailable: true,
        });
      }
    } else if (fileValue) {
      const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile()) {
        return res.json({
          ok: true,
          path: cacheFile,
          filename: fileValue,
          source: 'local_cache',
        });
      }
      if (localOnly) {
        return res.status(404).json({
          ok: false,
          code: 'local_miss',
          error: 'Datei nicht lokal gefunden.',
        });
      }
    } else if (localOnly) {
      return res.status(404).json({
        ok: false,
        code: 'local_miss',
        error: 'Datei nicht lokal gefunden.',
      });
    }
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl erforderlich (keine lokale Kopie).' });
    }
    const auth = authHeaderFromCredentials(
      serverUsername || sessionCreds.serverUsername,
      serverPassword || sessionCreds.serverPassword,
    );
    let url;
    if (sourceNorm === 'projekte_neu') {
      if (!pnPath) return res.status(400).json({ ok: false, error: 'path erforderlich für PROJEKTE NEU.' });
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}`;
    } else {
      if (!fileValue) return res.status(400).json({ ok: false, error: 'file erforderlich.' });
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&file=${encodeURIComponent(fileValue)}`;
    }
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        try { console.warn('[anlagenstamm_file_open] upstream error', r.status, data && data.error ? data.error : r.statusText); } catch (_) {}
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return res.status(500).json({ ok: false, error: 'Datei ist leer.' });
      const openDir = path.join(DB_DIR, 'anlagenstamm_open');
      if (!fs.existsSync(openDir)) fs.mkdirSync(openDir, { recursive: true });
      const rawName = sourceNorm === 'projekte_neu'
        ? (pnPath.split(/[/\\]/).pop() || String(fallbackName || '').trim() || 'download')
        : (fileValue || String(fallbackName || '').trim() || 'download');
      const safeName = String(rawName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'download';
      const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
      const targetPath = path.join(openDir, `${stamp}_${safeName}`);
      fs.writeFileSync(targetPath, buf);
      try { console.log('[anlagenstamm_file_open] ready', targetPath, 'bytes=' + buf.length); } catch (_) {}
      return res.json({ ok: true, path: targetPath, filename: safeName, size: buf.length, source: 'dispo' });
    } catch (e) {
      try { console.warn('[anlagenstamm_file_open] fetch exception', e.message); } catch (_) {}
      return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** TED/Mechanik-Excel-Index: gleiche Auth wie andere Dispo-Proxys (Basic über serverUsername/serverPassword). */
  app.post('/api/mechanik_ted_excel_from_dispo', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, jobId: rawJobId, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const jobId = parseInt(rawJobId, 10);
    if (!technicianId || !base || !Number.isFinite(jobId)) {
      return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/mechanik_ted_excel_list.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}`;
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Alle TED-Excel eines Auftrags in Reiseordner/TED/ laden (gleiche Quelle wie FN-Liste). */
  app.post('/api/mechanik_ted_excel_pull_job', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const {
      baseUrl,
      jobId: rawJobId,
      local_job_id: localJobIdRaw,
      serverUsername,
      serverPassword,
      externalUrl,
      internalUrl,
      force,
    } = req.body || {};
    const localJobId = parseInt(localJobIdRaw, 10);
    const serverJobId = parseInt(rawJobId, 10);
    const pair = normalizeDispoBasePair(externalUrl || baseUrl, internalUrl);
    let dispoBase = (baseUrl || pair.external || pair.internal || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !dispoBase || !Number.isFinite(localJobId) || localJobId <= 0 || !Number.isFinite(serverJobId)) {
      return res.status(400).json({
        ok: false,
        error: 'baseUrl, jobId, local_job_id und technician_id erforderlich.',
      });
    }
    if (!localJobStatusAllowsTedFilePull(db, localJobId)) {
      return res.status(403).json({
        ok: false,
        error: 'TED-Dateien werden erst nach „Auftrag annehmen“ (Status in Arbeit) in den Projektordner geladen.',
      });
    }
    const targetDir = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!targetDir || !fs.existsSync(targetDir)) {
      return res.status(400).json({
        ok: false,
        error: 'Projektordner konnte nicht angelegt werden (Startdatum/Kunde in den Auftragsdaten prüfen).',
      });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const authHeader = dispoMonteurFetchHeaders(technicianId, auth);
    try {
      if (pair.external && pair.internal) {
        const pick = await pickReachableDispoBase({
          externalUrl: pair.external,
          internalUrl: pair.internal,
          probe: (url) => probeDispoConnection(url, technicianId, serverUsername, serverPassword),
        });
        if (pick.ok && pick.selected_base_url) dispoBase = pick.selected_base_url;
      }
      const stats = await pullTedExcelIntoReiseDir({
        db,
        dbLock,
        dispoBaseUrl: dispoBase,
        technicianId,
        serverJobId,
        localJobId,
        targetDir,
        authHeader,
        signal: undefined,
        setProgress: null,
        mergeCheckpoint: () => {},
        readCheckpoint: () => ({}),
        force: !!force,
      });
      try {
        save();
      } catch (_) {}
      return res.json({
        ok: true,
        dispo_base_url: dispoBase,
        ted_dir: path.join(targetDir, 'TED'),
        expected: stats.total,
        present: stats.present,
        downloaded: stats.downloaded,
        skipped: stats.skipped,
        failed: stats.failed,
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  /** TED-Excel lokal auflösen (Projektordner/TED, Cache). */
  function tryOpenLocalTedExcel(localJobId, relPath, fab, fileName) {
    const reiseDir =
      localJobId && Number(localJobId) > 0
        ? resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false })
        : null;
    const hit = resolveTedExcelLocal({
      reiseDir,
      relPath,
      fab,
      fileName,
    });
    if (!hit || !isExcelFilePath(hit)) return null;
    const st = fs.statSync(hit);
    return { path: hit, filename: path.basename(hit), size: st.size };
  }

  function resolveServerJobIdForFab(technicianId, fab) {
    const fabStr = String(fab || '').trim();
    if (!fabStr || !technicianId) return null;
    const fabNum = parseInt(fabStr.replace(/\D/g, ''), 10);
    try {
      const tedRow = db
        .prepare(
          `SELECT server_job_id FROM job_ted_index
           WHERE TRIM(COALESCE(fab, '')) = TRIM(?)
           ORDER BY datetime(synced_at) DESC LIMIT 1`,
        )
        .get(fabStr);
      if (tedRow && tedRow.server_job_id != null) {
        const sid = parseInt(tedRow.server_job_id, 10);
        if (Number.isFinite(sid) && sid > 0) return sid;
      }
    } catch (_) { /* ignore */ }
    const jobs = db
      .prepare(
        `SELECT j.id, j.server_id, j.fabrikationsnummern FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         ORDER BY j.id DESC`,
      )
      .all(technicianId);
    for (const row of jobs) {
      const fabs = fabNumbersFromJobFabrikationsnummern(row.fabrikationsnummern);
      if (Number.isFinite(fabNum) && fabNum > 0 && fabs.has(fabNum)) {
        const sid = row.server_id != null ? parseInt(row.server_id, 10) : NaN;
        if (Number.isFinite(sid) && sid > 0) return sid;
      }
    }
    return null;
  }

  function resolveTedOpenJobIds(technicianId, fab, localJobIdRaw, rawJobId) {
    let localJobId = parseInt(localJobIdRaw, 10);
    if (!Number.isFinite(localJobId) || localJobId <= 0) {
      localJobId = fab ? resolveLocalJobIdForFab(technicianId, fab) : null;
    }
    let serverJobId = parseInt(rawJobId, 10);
    if ((!Number.isFinite(serverJobId) || serverJobId <= 0) && localJobId) {
      const row = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(localJobId);
      if (row) {
        const sid = row.server_id != null ? parseInt(row.server_id, 10) : NaN;
        if (Number.isFinite(sid) && sid > 0) serverJobId = sid;
      }
    }
    if ((!Number.isFinite(serverJobId) || serverJobId <= 0) && fab) {
      const fromFab = resolveServerJobIdForFab(technicianId, fab);
      if (fromFab) serverJobId = fromFab;
    }
    return { localJobId, serverJobId };
  }

  async function serveLocalTedExcelGet(req, res, inline) {
    const technicianId = getTechnicianId(req);
    const relPath = String(req.query.rel_path || '').trim().replace(/\\/g, '/');
    const fab = String(req.query.fab || req.query.fabrikationsnummer || '').trim();
    const fileName = String(req.query.file_name || req.query.file || '').trim();
    if (!relPath || relPath.includes('..')) {
      return res.status(400).json({ success: false, error: 'rel_path erforderlich.' });
    }
    const { localJobId } = resolveTedOpenJobIds(technicianId, fab, req.query.local_job_id, req.query.job_id);
    const local = tryOpenLocalTedExcel(localJobId, relPath, fab, fileName);
    if (!local) {
      return res.status(404).json({ success: false, error: 'TED-Datei nicht lokal gefunden.' });
    }
    const buf = fs.readFileSync(local.path);
    const ext = path.extname(local.filename).toLowerCase();
    const mime =
      ext === '.xls'
        ? 'application/vnd.ms-excel'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(local.filename) + '"',
    );
    res.setHeader('Content-Length', String(buf.length));
    return res.send(buf);
  }

  app.get('/api/mechanik_ted_excel_download.php', (req, res) => {
    serveLocalTedExcelGet(req, res, false).catch((e) =>
      res.status(500).json({ success: false, error: e.message || String(e) }),
    );
  });

  app.get('/api/mechanik_ted_excel_view.php', (req, res) => {
    serveLocalTedExcelGet(req, res, true).catch((e) =>
      res.status(500).json({ success: false, error: e.message || String(e) }),
    );
  });

  /** TED-Excel: zuerst lokal, sonst Dispo-Download in Projektordner/TED. */
  app.post('/api/mechanik_ted_excel_open', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const {
      baseUrl,
      jobId: rawJobId,
      local_job_id: localJobIdRaw,
      rel_path: relPathRaw,
      fab: fabRaw,
      file_name: fileNameRaw,
      serverUsername,
      serverPassword,
      local_only: localOnlyRaw,
    } = req.body || {};
    const sessionCreds = loadDispoWebSessionCreds();
    const dispoCreds = resolveDispoServerCreds(req.body || {});
    const base = dispoCreds.baseUrl;
    const relPath = String(relPathRaw || '').trim().replace(/\\/g, '/');
    const fab = String(fabRaw || '').trim();
    const localOnly =
      localOnlyRaw === true ||
      localOnlyRaw === 1 ||
      String(localOnlyRaw || '').toLowerCase() === 'true';
    if (!technicianId || !relPath || relPath.includes('..')) {
      return res.status(400).json({ ok: false, error: 'rel_path erforderlich.' });
    }
    const { localJobId, serverJobId: jobIdResolved } = resolveTedOpenJobIds(
      technicianId,
      fab,
      localJobIdRaw,
      rawJobId,
    );
    let jobId = jobIdResolved;
    const localFirst = tryOpenLocalTedExcel(localJobId, relPath, fab, fileNameRaw);
    if (localFirst) {
      return res.json({ ok: true, ...localFirst, source: 'local' });
    }
    if (localOnly) {
      return res.status(404).json({
        ok: false,
        code: 'local_miss',
        error: 'TED-Datei nicht lokal gefunden.',
      });
    }
    if (!Number.isFinite(jobId) || jobId <= 0) {
      const fromFab = resolveServerJobIdForFab(technicianId, fab);
      if (fromFab) jobId = fromFab;
    }
    const auth = authHeaderFromCredentials(dispoCreds.serverUsername, dispoCreds.serverPassword);
    const fetchHeaders = dispoMonteurFetchHeaders(technicianId, auth);
    let lastDispoError = 'Datei nicht gefunden.';
    let buf = null;
    let disp = '';
    if (!buf && base) {
      try {
        const urls = buildMechanikTedDownloadUrls(base, technicianId, jobId, relPath, fab);
        const dl = await fetchFirstOkBinary(urls, fetchHeaders, 22000);
        buf = dl.buf;
        disp = dl.contentDisposition || '';
      } catch (dlErr) {
        lastDispoError = dlErr.message || String(dlErr);
      }
    }
    if (!buf) {
      try {
        const proxyDl = await downloadMechanikTedViaSessionProxy(DB_DIR, technicianId, jobId, relPath, fab, {
          serverUsername: dispoCreds.serverUsername,
          serverPassword: dispoCreds.serverPassword,
          baseUrl: base,
          externalUrl: dispoCreds.externalUrl,
          internalUrl: dispoCreds.internalUrl,
        });
        if (proxyDl && proxyDl.buf && proxyDl.buf.length) {
          buf = proxyDl.buf;
          disp = proxyDl.contentDisposition || '';
        }
      } catch (proxyErr) {
        lastDispoError = proxyErr.message || String(proxyErr);
      }
    }
    if (buf && buf.length) {
      let rawName = String(fileNameRaw || '').trim() || relPath.split(/[/\\]/).pop() || 'ted.xlsx';
      const fnStar = /filename\*=UTF-8''([^;\s]+)/i.exec(disp);
      const fnPlain = /filename="([^"]+)"/i.exec(disp);
      if (fnStar && fnStar[1]) {
        try {
          rawName = decodeURIComponent(fnStar[1]);
        } catch (_) {
          rawName = fnStar[1];
        }
      } else if (fnPlain && fnPlain[1]) {
        rawName = fnPlain[1];
      }
      const reiseDir =
        localJobId &&
        localJobId > 0 &&
        localJobStatusAllowsTedFilePull(db, localJobId) &&
        !requireJobHasTechnicianAssignment(db, localJobId)
          ? resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: true })
          : null;
      const safeName = safeTedLocalFileName({
        rel_path: relPath,
        file_name: rawName,
        fab,
      });
      if (reiseDir) {
        const tedDir = path.join(reiseDir, 'TED');
        if (!fs.existsSync(tedDir)) fs.mkdirSync(tedDir, { recursive: true });
        const targetPath = path.join(tedDir, safeName);
        await replaceFileWithoutUnlink(targetPath, buf);
        try {
          upsertJobTedIndex(db, localJobId, jobId, [{ rel_path: relPath, file_name: safeName, fab }]);
          save();
        } catch (_) {}
        try {
          console.log('[mechanik_ted_excel_open] projektordner', targetPath, 'bytes=' + buf.length);
        } catch (_) {}
        return res.json({ ok: true, path: targetPath, filename: safeName, size: buf.length, source: 'projektordner' });
      }
      const openDir = path.join(DB_DIR, 'anlagenstamm_open');
      if (!fs.existsSync(openDir)) fs.mkdirSync(openDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
      const targetPath = path.join(openDir, `${stamp}_${safeName}`);
      fs.writeFileSync(targetPath, buf);
      try {
        console.log('[mechanik_ted_excel_open] dispo ok', safeName, 'bytes=' + buf.length);
      } catch (_) {}
      return res.json({ ok: true, path: targetPath, filename: safeName, size: buf.length, source: 'dispo' });
    }

    const reiseDir =
      localJobId && localJobId > 0
        ? resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false })
        : null;
    const localHit = resolveTedExcelLocal({
      reiseDir,
      relPath,
      fab,
      fileName: fileNameRaw,
    });
    if (localHit && isExcelFilePath(localHit)) {
      try {
        console.log('[mechanik_ted_excel_open] local', localHit);
      } catch (_) {}
      const st = fs.statSync(localHit);
      return res.json({
        ok: true,
        path: localHit,
        filename: path.basename(localHit),
        size: st.size,
        source: 'local',
      });
    }

    try {
      console.warn('[mechanik_ted_excel_open] miss', relPath, 'job', jobId, 'reise', reiseDir || '-', lastDispoError);
    } catch (_) {}
    return res.status(404).json({
      ok: false,
      error:
        lastDispoError === 'Datei nicht gefunden.'
          ? 'Datei nicht gefunden (weder auf dem Server noch im lokalen Projektordner). Nach Dienstreise-Pull oder Dispo-Deploy erneut versuchen.'
          : lastDispoError,
    });
  });

  app.post('/api/job_hotels_from_dispo', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, jobId: rawJobId, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const jobId = parseInt(rawJobId, 10);
    if (!technicianId || !base || !Number.isFinite(jobId)) {
      return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/job_hotels_by_fab.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Lädt Montagebericht-Vorlagen von der Dispo und speichert sie lokal (bei sync_to_dispo). */
  async function syncProtokollTemplates(dispoBaseUrl) {
    const base = (dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!base) return;
    const cacheDir = path.join(DB_DIR, 'protokoll_templates');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    for (const lang of ['de', 'en']) {
      const filename = lang === 'en' ? 'Montagebericht_EN.docx' : 'Montagebericht_DE.docx';
      const url = base + '/dispo_api/api/protokoll_template_download.php?language=' + encodeURIComponent(lang);
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0) {
          fs.writeFileSync(path.join(cacheDir, filename), buf);
        }
      } catch (e) {
        console.warn('Protokoll-Vorlage ' + filename + ' Sync fehlgeschlagen:', e.message);
      }
    }
    try {
      const spUrl = base + '/dispo_api/api/protokoll_template_download.php?id=serviceprotokoll';
      const spRes = await fetch(spUrl);
      if (spRes.ok) {
        const spBuf = Buffer.from(await spRes.arrayBuffer());
        if (spBuf.length > 0) {
          fs.writeFileSync(path.join(cacheDir, 'serviceprotokoll_defaults.json'), spBuf);
        }
      }
    } catch (e) {
      console.warn('Serviceprotokoll-Defaults Sync fehlgeschlagen:', e.message);
    }
  }

  /** Liest Montagebericht-Vorlage nur aus lokalem Cache oder gebündelten Fallbacks (kein Download zur Laufzeit). */
  function getProtokollTemplateBuffer(language) {
    const lang = (language || 'de').toLowerCase().slice(0, 2);
    const filename = lang === 'en' ? 'Montagebericht_EN.docx' : 'Montagebericht_DE.docx';
    const cacheDir = path.join(DB_DIR, 'protokoll_templates');
    const cachePath = path.join(cacheDir, filename);
    const bundledPath = path.join(__dirname, 'templates', filename);
    const dispoPath = path.join(__dirname, '..', '..', 'dispo', 'assets', 'templates', 'protokoll', filename);

    // Reihenfolge: Cache (nach Sync), Dispo-Workspace, gebündelt (immer verfügbar)
    for (const p of [cachePath, dispoPath, bundledPath]) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p);
        } catch (e) {
          console.warn('Protokoll-Vorlage lesen fehlgeschlagen:', p, e.message);
        }
      }
    }
    return null;
  }

  function readServiceprotokollDefaultsLocal() {
    const filename = 'serviceprotokoll_defaults.json';
    const cacheDir = path.join(DB_DIR, 'protokoll_templates');
    const bundledPath = path.join(__dirname, 'templates', filename);
    const dispoPath = path.join(__dirname, '..', '..', 'dispo', 'assets', 'templates', 'protokoll', filename);
    for (const p of [path.join(cacheDir, filename), dispoPath, bundledPath]) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p);
        } catch (e) {
          console.warn('Serviceprotokoll-Defaults lesen fehlgeschlagen:', p, e.message);
        }
      }
    }
    return null;
  }

  function parseServiceprotokollDefaultsBuffer(buf) {
    if (!buf || !buf.length) return null;
    try {
      const data = JSON.parse(buf.toString('utf8'));
      if (!data || !Array.isArray(data.arbeitsschritte)) return null;
      const arbeitsschritte = data.arbeitsschritte
        .map((row) => ({ bezeichnung: String((row && row.bezeichnung) || '').trim() }))
        .filter((row) => row.bezeichnung !== '');
      if (!arbeitsschritte.length) return null;
      return { ok: true, source: 'global', arbeitsschritte, kopf: {} };
    } catch (e) {
      return null;
    }
  }

  function buildServiceprotokollDefaultsFromLocal(fab, technicianId, catalogKind) {
    const fn = String(fab || '').trim();
    const kind = String(catalogKind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service';
    let anlagenType = '';
    let kopf = {};
    try {
      ensureAnlagenstammLocalSchema(db);
      if (fn) {
        const row = anlagenstammLookupByFab(db, fn);
        if (row) {
          anlagenType = row.type != null ? String(row.type).trim() : '';
          kopf = {
            kopf_pos_nr: row.position != null ? String(row.position).trim() : '',
            kopf_qmax: row.leistung != null ? String(row.leistung).trim() : '',
            kopf_type: anlagenType,
            kopf_dwc: row.elektronik != null ? String(row.elektronik).trim() : '',
            mess_waegezelle_type: row.kraftaufnehmer != null ? String(row.kraftaufnehmer).trim() : '',
            mess_waegezelle_seriennummer: row.dms_nr != null ? String(row.dms_nr).trim() : '',
            mess_waegezelle_position: row.dms_position != null ? String(row.dms_position).trim() : '',
            mess_vers_spannung: row.vers_spannung != null ? String(row.vers_spannung).trim() : '',
            mess_sensitivitaet: row.sensitivitaet != null ? String(row.sensitivitaet).trim() : '',
            mess_waegezellen_extra: parseKraftaufnehmerExtra(row.kraftaufnehmer_extra),
            projekt: row.projekt != null ? String(row.projekt).trim() : '',
            motoren: listMotorsForStamm(db, row.id),
          };
        }
      }
    } catch (_) { /* optional */ }
    try {
      arbeitsschritteLocal.ensureArbeitsschritteSchema(db);
      const resolved = arbeitsschritteLocal.resolveDefaultsLocal(db, technicianId, anlagenType, kind);
      if (resolved && Array.isArray(resolved.arbeitsschritte) && resolved.arbeitsschritte.length) {
        return Object.assign({ ok: true, kopf, motoren: kopf.motoren || [] }, resolved);
      }
    } catch (_) { /* fallback */ }
    const parsed = parseServiceprotokollDefaultsBuffer(readServiceprotokollDefaultsLocal());
    if (!parsed) {
      return {
        ok: true,
        source: 'builtin',
        arbeitsschritte: kind === 'ibn' ? [] : arbeitsschritteLocal.builtinDefaults(),
        kopf,
        motoren: kopf.motoren || [],
      };
    }
    parsed.kopf = Object.assign({}, parsed.kopf || {}, kopf);
    parsed.motoren = kopf.motoren || [];
    if (fn) parsed.source = 'local_cache';
    return parsed;
  }

  app.get('/api/serviceprotokoll_defaults', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const fab = (req.query.fabrikationsnummer || '').toString().trim();
      const dispoBaseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
      const localOnly = wantsLocalOnlyRequest(req.query);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const catalogKind = String(req.query.catalog_kind || req.query.catalogKind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service';
      const local = buildServiceprotokollDefaultsFromLocal(fab, technicianId, catalogKind);
      if (localOnly || !dispoBaseUrl) {
        if (local) return res.json(local);
        return res.status(400).json({ ok: false, error: 'Kein lokaler Defaults-Cache – bitte einmal online synchronisieren.' });
      }
      const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
      const defaultsPhp = catalogKind === 'ibn' ? 'inbetriebnahme_defaults.php' : 'serviceprotokoll_defaults.php';
      const url =
        dispoBaseUrl +
        '/dispo_api/api/' + defaultsPhp + '?fabrikationsnummer=' +
        encodeURIComponent(fab) +
        '&technician_id=' +
        encodeURIComponent(technicianId) +
        (catalogKind === 'ibn' ? '&catalog_kind=ibn' : '');
      try {
        const r = await fetchWithTimeout(url, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok && Array.isArray(data.arbeitsschritte) && data.arbeitsschritte.length > 0) {
          return res.json(data);
        }
        if (local) {
          if (r.ok && data.ok && data.kopf) local.kopf = Object.assign({}, local.kopf || {}, data.kopf);
          if (r.ok && data.ok && Array.isArray(data.motoren)) local.motoren = data.motoren;
          return res.json(local);
        }
        if (r.ok) return res.json(data);
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      } catch (e) {
        if (local) return res.json(local);
        return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/protokolle/montagebericht', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      await pullOneJsonDraftForJob(
        reiseDir,
        localJobId,
        jobRow.server_id,
        technicianId,
        'montagebericht.json',
        req.query,
      );
      const draftMeta = protocolDrafts.readDraft(db, localJobId, 'montagebericht.json', reiseDir);
      const payload = draftMeta && draftMeta.payload && Object.keys(draftMeta.payload).length ? draftMeta.payload : null;
      const data = payload
        ? Object.assign({}, payload, {
            revision: draftMeta.revision,
            server_updated_at: draftMeta.server_updated_at,
          })
        : null;
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  });

  app.post('/api/protokolle/montagebericht', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const languagesRaw = Array.isArray(body.languages) ? body.languages : null;
      const languages = [];
      const pushLang = (v) => {
        const l = String(v || '').toLowerCase().slice(0, 2);
        if ((l === 'de' || l === 'en') && !languages.includes(l)) languages.push(l);
      };
      if (languagesRaw && languagesRaw.length) {
        languagesRaw.forEach(pushLang);
      } else {
        pushLang(body.language || 'de');
      }
      if (languages.length === 0) languages.push('de');
      const language = languages[0];
      const kopfdaten = body.kopfdaten || {};
      const fabBemerkungen = Array.isArray(body.fabBemerkungen) ? body.fabBemerkungen : [];
      const grundDesEinsatzes = (body.grundDesEinsatzes || '').trim();
      const grundDesEinsatzesHtml = (body.grundDesEinsatzes_html || '').toString().trim();
      const freitext = (body.freitext || '').trim();
      const jsonOnlyEarly = body.jsonOnly === true || body.saveJsonOnly === true;
      const projektPflicht = (kopfdaten.projekt != null ? String(kopfdaten.projekt) : '').trim();
      if (!projektPflicht && !jsonOnlyEarly) {
        return res.status(400).json({ ok: false, error: 'Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm / manuell).' });
      }

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.server_id, j.status, j.start_datetime, j.end_datetime, j.job_number, j.description, j.fabrikationsnummern,
          c.name AS customer_name, c.street AS cust_street, c.house_number AS cust_house, c.zip AS cust_zip, c.city AS cust_city,
          ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country
        FROM jobs j
        INNER JOIN customers c ON c.id = j.customer_id
        LEFT JOIN job_addresses ja ON ja.job_id = j.id
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const toFab = (f) => (f != null && (typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer))) ? String(typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer)).trim() : '';
      let dbFabRows = [];
      const parsedServerJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : NaN;
      const hasServerJobId = Number.isFinite(parsedServerJobId) && parsedServerJobId > 0;
      const serverJobId = hasServerJobId ? parsedServerJobId : null;
      if (dispoBaseUrl && hasServerJobId) {
        try {
          const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
          const url = dispoBaseUrl + '/dispo_api/api/montagebericht_data.php?job_id=' + encodeURIComponent(serverJobId) + '&technician_id=' + encodeURIComponent(technicianId);
          const r = await fetch(url, auth ? { headers: auth } : {});
          const apiData = await r.json().catch(() => ({}));
          if (r.ok && Array.isArray(apiData.data) && apiData.data.length > 0) {
            dbFabRows = apiData.data.map((row) => ({
              fabrikationsnummer: String(row.fabrikationsnummer ?? '').trim(),
              type: String(row.type ?? '').trim(),
              position: String(row.position ?? '').trim(),
              textbausteine: Array.isArray(row.textbausteine) ? row.textbausteine.map((t) => ({ text: String(t && t.text != null ? t.text : '').trim() })).filter((t) => t.text) : [],
            })).filter((row) => row.fabrikationsnummer);
          }
        } catch (_) { /* API-Fehler ignorieren */ }
      }
      const rawFab = (jobRow.fabrikationsnummern || '').toString().trim();
      if (rawFab) {
        try {
          const parsed = JSON.parse(rawFab);
          if (Array.isArray(parsed) && parsed.length > 0) {
            dbFabRows = parsed.map((r) => {
              const fn = (r && (r.fabrikationsnummer ?? r.Fabrikationsnummer) != null) ? String(r.fabrikationsnummer ?? r.Fabrikationsnummer).trim() : '';
              const t = (r && typeof r === 'object' && (r.type ?? r.Type) != null) ? String(r.type ?? r.Type).trim() : '';
              const p = (r && typeof r === 'object' && (r.position ?? r.Position) != null) ? String(r.position ?? r.Position).trim() : '';
              return { fabrikationsnummer: fn, type: t, position: p };
            }).filter((r) => r.fabrikationsnummer);
          }
        } catch (_) { /* kein JSON */ }
        if (dbFabRows.length === 0) {
          const parts = rawFab.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
          dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
        }
      }
      if (dbFabRows.length === 0 && dispoBaseUrl) {
        const reqFabs = (kopfdaten.fabrikationsnummern || []).map(toFab).filter(Boolean);
        const reqFabsAlt = (fabBemerkungen || []).map((fb) => toFab(fb)).filter(Boolean);
        const parts = reqFabs.length > 0 ? reqFabs : reqFabsAlt;
        if (parts.length > 0) {
          try {
            const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
            const url = dispoBaseUrl + '/dispo_api/api/anlagenstamm_by_fab.php?fabs=' + encodeURIComponent(parts.join(','));
            const r = await fetch(url, auth ? { headers: auth } : {});
            const data = await r.json().catch(() => ({}));
            if (r.ok && Array.isArray(data.data) && data.data.length > 0) {
              dbFabRows = data.data.map((row) => ({
                fabrikationsnummer: String(row.fabrikationsnummer ?? '').trim(),
                type: String(row.type ?? '').trim(),
                position: String(row.position ?? '').trim(),
              })).filter((row) => row.fabrikationsnummer);
            } else {
              dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
            }
          } catch (_) {
            dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
          }
        }
      } else if (dbFabRows.length > 0 && dispoBaseUrl) {
        const needsEnrich = dbFabRows.every((r) => !(r.type || r.position));
        if (needsEnrich) {
          try {
            const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
            const fnList = dbFabRows.map((r) => r.fabrikationsnummer).filter(Boolean).join(',');
            const url = dispoBaseUrl + '/dispo_api/api/anlagenstamm_by_fab.php?fabs=' + encodeURIComponent(fnList);
            const r = await fetch(url, auth ? { headers: auth } : {});
            const data = await r.json().catch(() => ({}));
            if (r.ok && Array.isArray(data.data) && data.data.length > 0) {
              const byFn = {};
              for (const row of data.data) {
                const fn = String(row.fabrikationsnummer ?? '').trim();
                if (fn) byFn[fn] = { fabrikationsnummer: fn, type: String(row.type ?? '').trim(), position: String(row.position ?? '').trim() };
              }
              dbFabRows = dbFabRows.map((r) => {
                const enriched = byFn[r.fabrikationsnummer];
                return enriched || r;
              });
            }
          } catch (_) { /* API-Fehler ignorieren */ }
        }
      }
      if (dbFabRows.length === 0) {
        dbFabRows = (kopfdaten.fabrikationsnummern || []).map((f) => {
          const fn = toFab(f);
          const t = (f && typeof f === 'object' && f.type != null) ? String(f.type).trim() : '';
          const p = (f && typeof f === 'object' && f.position != null) ? String(f.position).trim() : '';
          return { fabrikationsnummer: fn, type: t, position: p };
        }).filter((r) => r.fabrikationsnummer);
      }
      if (dbFabRows.length === 0) {
        dbFabRows = (fabBemerkungen || []).map((fb) => {
          const fn = toFab(fb);
          const t = (fb && typeof fb === 'object' && fb.type != null) ? String(fb.type).trim() : '';
          const p = (fb && typeof fb === 'object' && fb.position != null) ? String(fb.position).trim() : '';
          return { fabrikationsnummer: fn, type: t, position: p };
        }).filter((r) => r.fabrikationsnummer);
      }
      if (dbFabRows.length === 0) {
        return res.status(400).json({ ok: false, error: 'Mindestens eine Fabrikationsnummer erforderlich.' });
      }
      dbFabRows = sortJobFabRows(dbFabRows);
      const fabs = dbFabRows.map((r) => r.fabrikationsnummer).filter(Boolean);

      const jsonOnly = body.jsonOnly === true || body.saveJsonOnly === true;

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const montageberichtDataPath = resolveMonteurDraftJsonPath(reiseDir, 'montagebericht.json', false);
      const kopfdatenBemerkungen = (kopfdaten && kopfdaten.bemerkungen != null) ? String(kopfdaten.bemerkungen).trim() : '';
      const kopfdatenBemerkungenHtml = (kopfdaten && kopfdaten.bemerkungen_html != null) ? String(kopfdaten.bemerkungen_html).trim() : '';
      const prevDraft = protocolDrafts.readDraft(db, localJobId, 'montagebericht.json', reiseDir);
      const montagePayload = {
        grundDesEinsatzes,
        grundDesEinsatzes_html: grundDesEinsatzesHtml,
        fabBemerkungen,
        language,
        languages,
        bemerkungen: kopfdatenBemerkungen,
        bemerkungen_html: kopfdatenBemerkungenHtml,
        projekt: projektPflicht,
      };
      protocolDrafts.writeDraft(
        db,
        localJobId,
        'montagebericht.json',
        montagePayload,
        prevDraft.revision,
        prevDraft.server_updated_at,
        reiseDir,
      );
      queueProtocolDraftAndFiles({
        localJobId,
        technicianId,
        serverJobId: parsedServerJobId,
        dispoBaseUrl,
        basename: 'montagebericht.json',
        reiseDir,
        filePath: montageberichtDataPath,
        username: body.dispoUsername || body.serverUsername,
        password: body.dispoPassword ?? body.serverPassword,
      });

      // Dispo-Sync (Netz) erst NACH lokalem PDF – sonst wirkt Speichern „wie Word“ langsam.
      let syncWarning = null;
      const appendSyncWarning = (msg) => {
        syncWarning = syncWarning ? `${syncWarning}\n\n${msg}` : msg;
      };

      const runMontageberichtDispoSync = async () => {
        if (!(dispoBaseUrl && hasServerJobId)) return;
        if (multiDeviceApi && multiDeviceApi.pushJsonDraft) {
          try {
            await multiDeviceApi.pushJsonDraft({
              dispoBaseUrl,
              endpoint: '/dispo_api/api/montagebericht_draft.php',
              technicianId,
              serverJobId,
              localJobId,
              reiseDir,
              filePath: montageberichtDataPath,
              username: body.dispoUsername || body.serverUsername,
              password: body.dispoPassword ?? body.serverPassword,
            });
            if (bgJobs) {
              const dedupeKey = 'dienstreise_push:' + localJobId + ':draft';
              bgJobs.enqueue(
                'dienstreise_push',
                {
                  job_id: localJobId,
                  technicianId,
                  technician_id: technicianId,
                  dispoBaseUrl,
                  dispoUsername: body.dispoUsername || body.serverUsername,
                  dispoPassword: body.dispoPassword ?? body.serverPassword,
                  onlyChanged: true,
                },
                dedupeKey,
              );
              bgJobs.kick();
            }
          } catch (draftErr) {
            console.warn('[montagebericht] draft push:', draftErr && draftErr.message ? draftErr.message : draftErr);
          }
        }
        const authSync = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
        const syncHeaders = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...(authSync || {}) };
        try {
          const idxUrl = dispoBaseUrl + '/dispo_api/api/montagebericht_akte_index.php';
          const idxRes = await fetch(idxUrl, {
            method: 'POST',
            headers: syncHeaders,
            body: JSON.stringify({
              technician_id: technicianId,
              job_id: serverJobId,
              payload: {
                grundDesEinsatzes,
                grundDesEinsatzes_html: grundDesEinsatzesHtml,
                fabBemerkungen,
                language,
                languages,
                bemerkungen: kopfdatenBemerkungen,
                bemerkungen_html: kopfdatenBemerkungenHtml,
                projekt: projektPflicht,
                kopfdaten,
              },
              fabs,
            }),
          });
          const idxData = await idxRes.json().catch(() => ({}));
          if (!idxRes.ok || !idxData.ok) {
            console.warn('[montagebericht] akte index:', idxData.error || idxRes.statusText || idxRes.status);
          }
        } catch (idxErr) {
          console.warn('[montagebericht] akte index:', idxErr && idxErr.message ? idxErr.message : idxErr);
        }
        try {
          const syncUrl = dispoBaseUrl + '/dispo_api/api/anlagenstamm_projekt_job_save.php';
          const syncRes = await fetch(syncUrl, {
            method: 'POST',
            headers: syncHeaders,
            body: JSON.stringify({ technician_id: technicianId, job_id: serverJobId, projekt: projektPflicht }),
          });
          const syncData = await syncRes.json().catch(() => ({}));
          if (!syncRes.ok || !syncData.ok) {
            const msg = 'Projekt: Anlagenstamm auf dem Server konnte nicht angepasst werden: ' + (syncData.error || syncRes.statusText || syncRes.status);
            if (syncRes.status >= 500) console.warn(msg);
            else appendSyncWarning(msg);
          }
        } catch (syncErr) {
          console.warn('Projekt: Dispo für Anlagenstamm-Update nicht erreichbar.');
        }
        const tpRows = (fabBemerkungen || [])
          .map((fb) => {
            const fn = toFab(fb);
            if (!fn) return null;
            const typeVal = (fb && fb.type != null) ? String(fb.type).trim() : '';
            const positionVal = (fb && fb.position != null) ? String(fb.position).trim() : '';
            if (!typeVal && !positionVal) return null;
            return {
              fabrikationsnummer: fn,
              type: typeVal,
              position: positionVal,
            };
          })
          .filter(Boolean);
        if (tpRows.length > 0) {
          try {
            const tpUrl = dispoBaseUrl + '/dispo_api/api/anlagenstamm_type_position_job_save.php';
            const tpRes = await fetch(tpUrl, {
              method: 'POST',
              headers: syncHeaders,
              body: JSON.stringify({ technician_id: technicianId, job_id: serverJobId, rows: tpRows }),
            });
            const tpData = await tpRes.json().catch(() => ({}));
            if (!tpRes.ok || !tpData.ok) {
              const msg = 'Type/Pos.Nr.: Anlagenstamm auf dem Server konnte nicht angepasst werden: ' + (tpData.error || tpRes.statusText || tpRes.status);
              if (tpRes.status >= 500) console.warn(msg);
              else appendSyncWarning(msg);
            }
          } catch (tpErr) {
            console.warn('Type/Pos.Nr.: Dispo für Anlagenstamm-Update nicht erreichbar.');
          }
        }
      };

      if (jsonOnly) {
        if (!wantsLocalOnlyRequest(body)) {
          await runMontageberichtDispoSync();
        }
        return res.json({
          ok: true,
          jsonOnly: true,
          warning: syncWarning || undefined,
        });
      }

      // Dateiname ohne führende Auftrags-Indexnummer; DE → …_Montage_DE, EN → …_report_GB
      const fileBase = sanitizeExportFileBase(String(path.basename(reiseDir) || '').replace(/^\d+_/, ''));
      const fileStemForLang = (lang) =>
        lang === 'en' ? `${fileBase}_report_GB` : `${fileBase}_Montage_DE`;

      const toTextbausteine = (bem) => (bem || '').toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, html: t }));
      const isRichFabHtml = (html) => {
        const h = (html || '').toString();
        if (!h.trim()) return false;
        if (/<img\b/i.test(h) || /<table\b/i.test(h)) return true;
        return h.length > 80 && /<(p|div|br|h[1-6]|ul|ol)\b/i.test(h);
      };
      const toTextbausteineFromRich = (html, plain) => {
        const rawHtml = (html || '').toString();
        if (rawHtml.trim()) {
          /* E-Mail/Richtext mit Bildern/Tabellen: ein Block, nicht zeilenweise zerlegen */
          if (isRichFabHtml(rawHtml)) {
            const text = rawHtml
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n')
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/gi, ' ')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n[ \t]+/g, '\n')
              .replace(/[ \t]{2,}/g, ' ')
              .trim();
            return [{ text: text || ' ', html: rawHtml.trim() }];
          }
          const liMatches = rawHtml.match(/<li[\s\S]*?>[\s\S]*?<\/li>/gi) || [];
          if (liMatches.length > 0) {
            return liMatches
              .map((li) => {
                const inner = li.replace(/^<li[\s\S]*?>/i, '').replace(/<\/li>$/i, '').trim();
                const text = inner.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
                return { text, html: inner };
              })
              .filter((x) => x.text || x.html);
          }
          const textFallback = rawHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
          if (textFallback) {
            return [{ text: textFallback.replace(/^\s*[•▪◦●\-]\s*/, '').trim(), html: rawHtml.trim() }];
          }
        }
        return toTextbausteine(plain || '');
      };
      const bemerkungenByFn = {};
      const bemerkungenHtmlByFn = {};
      const typePosByFn = {};
      for (const fb of fabBemerkungen || []) {
        const fn = toFab(fb);
        if (fn) {
          typePosByFn[fn] = {
            type: (fb && fb.type != null) ? String(fb.type).trim() : '',
            position: (fb && fb.position != null) ? String(fb.position).trim() : '',
          };
          const fbHtml = (fb && fb.bemerkungen_html != null) ? String(fb.bemerkungen_html) : '';
          if (fbHtml.trim()) bemerkungenHtmlByFn[fn] = fbHtml;
          const explicitTb = Array.isArray(fb.textbausteine) && fb.textbausteine.length > 0
            ? fb.textbausteine
              .map((t) => ({
                text: String(t && t.text != null ? t.text : '').trim(),
                html: String(t && t.html != null ? t.html : (t && t.text != null ? t.text : '')).trim(),
              }))
              .filter((t) => t.text || t.html)
            : null;
          /* Rich-HTML (Bilder) hat Vorrang vor zerlegten Textbausteinen ohne img */
          const explicitHasImg = !!(explicitTb && explicitTb.some((t) => /<img\b/i.test(t.html || '')));
          const tb = (isRichFabHtml(fbHtml) && (!explicitTb || !explicitHasImg))
            ? toTextbausteineFromRich(fbHtml, fb && fb.bemerkungen)
            : (explicitTb && explicitTb.length > 0
              ? explicitTb
              : toTextbausteineFromRich(fbHtml, fb && fb.bemerkungen));
          bemerkungenByFn[fn] = tb;
        }
      }
      const tableRows = dbFabRows.map((row) => {
        const fn = (row.fabrikationsnummer || '').toString().trim();
        const fromForm = typePosByFn[fn];
        const type = (fromForm != null)
          ? String(fromForm.type != null ? fromForm.type : '').trim()
          : (row.type || '').toString().trim();
        const position = (fromForm != null)
          ? String(fromForm.position != null ? fromForm.position : '').trim()
          : (row.position || '').toString().trim();
        const userTb = bemerkungenByFn[fn];
        const tb = (userTb && userTb.length > 0)
          ? userTb
          : (Array.isArray(row.textbausteine)
            ? row.textbausteine
              .map((t) => ({
                text: String(t && t.text != null ? t.text : '').trim(),
                html: String(t && t.html != null ? t.html : (t && t.text != null ? t.text : '')).trim(),
              }))
              .filter((t) => t.text || t.html)
            : []);
        const bemerk = tb.map((x) => x.text).join('\n');
        const bemerkHtml = bemerkungenHtmlByFn[fn]
          || (tb.length === 1 && tb[0].html ? tb[0].html : '')
          || '';
        return {
          fabrikationsnummer: fn,
          type,
          position,
          textbausteine: tb,
          bemerkungen: bemerk,
          bemerkungen_html: bemerkHtml,
        };
      });

      const kopfdatenForDocx = { ...kopfdaten };
      try {
        const contacts = db.prepare(`${JOB_CONTACTS_SELECT_SQL} WHERE job_id = ? ORDER BY sort_order, id`).all(localJobId);
        const parts = [];
        contacts.forEach((c) => {
          const n = normalizeJobContactPayload(c);
          if (!jobContactHasAny(n)) return;
          // Montagebericht: nur Name, keine Titel/Telefon/E-Mail-Details.
          const name = (n.contact_name && String(n.contact_name).trim())
            || `${n.first_name || ''} ${n.last_name || ''}`.trim();
          if (name) parts.push(name);
        });
        kopfdatenForDocx.ansprechperson = parts.join('\n');
      } catch (_) {
        kopfdatenForDocx.ansprechperson = '';
      }

      const docMonteurBase = path.join(reiseDir, 'Dokumente_Monteur');
      const docAnlageBase = path.join(reiseDir, 'Dokumente_Anlage');
      const offlineCfgMb = getOfflinePullConfig(db, localJobId);
      await ensureJobReiseFolderLayout(localJobId, reiseDir, technicianId);
      const montageFolderNameMb = resolveMonteurAuftragsordnerName(localJobId, technicianId);

      const targetFolderNames = new Set();
      for (const fab of fabs) {
        let folderName = null;
        const fromMap = (offlineCfgMb.fab_map || []).find((e) => String(e.fab) === String(fab));
        if (fromMap && fromMap.folder_name_canonical) folderName = fromMap.folder_name_canonical;
        if (!folderName) {
          const fnNum = parseInt(String(fab).trim(), 10);
          folderName =
            (Number.isFinite(fnNum) ? findMonteurFolderForFab(docMonteurBase, fnNum) : null) ||
            (Number.isFinite(fnNum) ? findParameterlistenFolder(docAnlageBase, fnNum) : null) ||
            sanitizeDienstreiseFolderPart(fab);
        }
        targetFolderNames.add(folderName);
      }

      const resolveFnFolder = (f) => {
        const fromMap = (offlineCfgMb.fab_map || []).find((e) => String(e.fab) === String(f));
        return (
          (fromMap && fromMap.folder_name_canonical) ||
          findMonteurFolderForFab(docMonteurBase, f) ||
          findParameterlistenFolder(docAnlageBase, f) ||
          sanitizeDienstreiseFolderPart(f)
        );
      };

      const saved = [];
      let firstAbsPdf = '';
      const uniqueAbsPdfs = [];

      for (const lang of languages) {
        let pdfBytes = null;
        try {
          const sigPng = await resolveTechnicianSignaturePng(technicianId, body);
          if (!sigPng) return failMissingSignature(res);
          pdfBytes = await protocolPdf.generateMontageberichtPdfBuffer(
            {
              kopfdaten: kopfdatenForDocx,
              tableRows,
              grundDesEinsatzes,
              grundDesEinsatzes_html: grundDesEinsatzesHtml,
              freitext,
              technician_signature_png: sigPng,
            },
            { lang },
          );
        } catch (pdfErr) {
          console.warn(
            'Montagebericht-PDF fehlgeschlagen (' + lang + '):',
            pdfErr && pdfErr.message ? pdfErr.message : pdfErr,
          );
          if (pdfErr && pdfErr.stack) console.warn('Stack:', pdfErr.stack);
          return res.status(500).json({
            ok: false,
            error:
              `PDF konnte nicht erzeugt werden (${lang === 'en' ? 'Englisch' : 'Deutsch'}): ` +
              (pdfErr && pdfErr.message ? pdfErr.message : 'Unbekannter Fehler'),
          });
        }
        if (!pdfBytes || !pdfBytes.length) {
          return res.status(500).json({
            ok: false,
            error: `PDF konnte nicht erzeugt werden (${lang === 'en' ? 'Englisch' : 'Deutsch'}).`,
          });
        }

        const stem = fileStemForLang(lang);
        const pdfFilename = `${stem}.pdf`;
        let langAbs = '';
        for (const folderName of targetFolderNames) {
          const protokolleDir = buildMonteurWorkAbsDir(
            docMonteurBase,
            folderName,
            montageFolderNameMb,
            'Protokolle',
          );
          if (!fs.existsSync(protokolleDir)) fs.mkdirSync(protokolleDir, { recursive: true });
          const absPdf = path.join(protokolleDir, pdfFilename);
          writeFileWithRetry(absPdf, pdfBytes);
          if (!firstAbsPdf) firstAbsPdf = absPdf;
          if (!langAbs) langAbs = absPdf;
          protectPathIfUnderDokumenteMonteur(
            db,
            localJobId,
            buildMonteurWorkRelPath(folderName, montageFolderNameMb, 'Protokolle/' + pdfFilename),
          );
        }
        if (langAbs) uniqueAbsPdfs.push(langAbs);
        for (const f of fabs) {
          const fnFolder = resolveFnFolder(f);
          saved.push(buildMonteurWorkRelPath(fnFolder, montageFolderNameMb, 'Protokolle/' + pdfFilename));
        }
      }

      // Legacy-DOCX lokal entfernen + Dispo-Löschliste (auch wenn nur remote noch existiert)
      const docxRelsToRemoveOnDispo = new Set();
      for (const folderName of targetFolderNames) {
        const protokolleDir = buildMonteurWorkAbsDir(
          docMonteurBase,
          folderName,
          montageFolderNameMb,
          'Protokolle',
        );
        const removedLocal = cleanupLegacyMontageberichtDocxLocal(protokolleDir);
        for (const name of removedLocal) {
          docxRelsToRemoveOnDispo.add(
            buildMonteurWorkRelPath(folderName, montageFolderNameMb, 'Protokolle/' + name),
          );
        }
        for (const lang of ['de', 'en']) {
          docxRelsToRemoveOnDispo.add(
            buildMonteurWorkRelPath(
              folderName,
              montageFolderNameMb,
              'Protokolle/' + fileStemForLang(lang) + '.docx',
            ),
          );
        }
      }

      const cleanupLegacyMontageberichtDocxOnDispo = async () => {
        if (!(dispoBaseUrl && hasServerJobId) || !docxRelsToRemoveOnDispo.size) return;
        const authDel = authHeaderFromCredentials(
          body.dispoUsername || body.serverUsername,
          body.dispoPassword ?? body.serverPassword,
        );
        for (const rel of docxRelsToRemoveOnDispo) {
          try {
            await deleteJobProjectFileOnDispo(
              dispoBaseUrl,
              serverJobId,
              technicianId,
              authDel,
              rel,
            );
            try {
              invalidateDienstreisePushCache(db, localJobId, rel);
            } catch (_) {
              /* optional */
            }
          } catch (delErr) {
            const st = delErr && delErr.status;
            if (st === 404) continue;
            console.warn(
              '[montagebericht] docx dispo cleanup:',
              rel,
              delErr && delErr.message ? delErr.message : delErr,
            );
          }
        }
      };

      save();

      let absPath = firstAbsPdf || '';
      if (!absPath && saved.length && reiseDir) {
        absPath = path.join(reiseDir, saved[0].replace(/\//g, path.sep));
      }
      if (saved.length) {
        try {
          const prevAfter = protocolDrafts.readDraft(db, localJobId, 'montagebericht.json', reiseDir);
          protocolDrafts.writeDraft(
            db,
            localJobId,
            'montagebericht.json',
            Object.assign({}, prevAfter.payload || {}, {
              grundDesEinsatzes,
              grundDesEinsatzes_html: grundDesEinsatzesHtml,
              fabBemerkungen,
              language,
              languages,
              bemerkungen: kopfdatenBemerkungen,
              bemerkungen_html: kopfdatenBemerkungenHtml,
              projekt: projektPflicht,
              last_pdf_rel: saved[0],
              last_pdf_paths: saved,
              last_pdf_abs: absPath || undefined,
            }),
            prevAfter.revision,
            prevAfter.server_updated_at,
            reiseDir,
          );
          queueProtocolDraftAndFiles({
            localJobId,
            technicianId,
            serverJobId: parsedServerJobId,
            dispoBaseUrl,
            basename: 'montagebericht.json',
            reiseDir,
            filePath: montageberichtDataPath,
            username: body.dispoUsername || body.serverUsername,
            password: body.dispoPassword ?? body.serverPassword,
          });
        } catch (_) { /* Meta optional */ }
      }

      // Antwort sofort; Dispo-Sync im Hintergrund (Netz darf Speichern nicht blockieren)
      res.json({
        ok: true,
        jsonOnly: false,
        languages,
        saved,
        path: absPath || undefined,
        pdf_path: absPath || undefined,
        pdf_paths: uniqueAbsPdfs.length ? uniqueAbsPdfs : (absPath ? [absPath] : []),
        rel: saved[0] || undefined,
      });
      setImmediate(() => {
        cleanupLegacyMontageberichtDocxOnDispo()
          .catch((e) => {
            console.warn('[montagebericht] docx cleanup:', e && e.message ? e.message : e);
          })
          .finally(() => {
            runMontageberichtDispoSync().catch((e) => {
              console.warn('[montagebericht] background sync:', e && e.message ? e.message : e);
            });
          });
      });
      return;
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Montagebericht konnte nicht erstellt werden.' });
    }
  });

  app.get('/api/montagebericht_pdf', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.local_job_id || req.query.job_id, 10);
      const openLocal = String(req.query.open_local || '') === '1';
      if (!technicianId || !Number.isFinite(localJobId) || localJobId <= 0) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      let rel = String(req.query.rel || '').trim().replace(/\\/g, '/');
      let absHint = '';
      if (!rel) {
        try {
          const draft = protocolDrafts.readDraft(db, localJobId, 'montagebericht.json', reiseDir);
          const p = draft && draft.payload ? draft.payload : {};
          if (p.last_pdf_rel) rel = String(p.last_pdf_rel).trim().replace(/\\/g, '/');
          if (p.last_pdf_abs) absHint = String(p.last_pdf_abs).trim();
        } catch (_) { /* optional */ }
      } else {
        try {
          const draft = protocolDrafts.readDraft(db, localJobId, 'montagebericht.json', reiseDir);
          const p = draft && draft.payload ? draft.payload : {};
          if (p.last_pdf_abs) absHint = String(p.last_pdf_abs).trim();
        } catch (_) { /* optional */ }
      }
      let full = '';
      if (absHint && fs.existsSync(absHint)) {
        full = absHint;
        if (!rel) rel = path.relative(reiseDir, absHint).replace(/\\/g, '/');
      }
      if (!full && rel) {
        full = path.join(reiseDir, rel.replace(/\//g, path.sep));
      }
      if (!full || !fs.existsSync(full)) {
        // Fallback: Dateiname unter Dokumente_Monteur suchen
        const wantName = rel ? path.basename(rel) : '';
        if (wantName) {
          const docBase = path.join(reiseDir, 'Dokumente_Monteur');
          const stack = [docBase];
          while (stack.length && (!full || !fs.existsSync(full))) {
            const dir = stack.pop();
            let entries = [];
            try {
              entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (_) {
              continue;
            }
            for (const ent of entries) {
              const p = path.join(dir, ent.name);
              if (ent.isDirectory()) stack.push(p);
              else if (ent.isFile() && ent.name === wantName) {
                full = p;
                rel = path.relative(reiseDir, p).replace(/\\/g, '/');
                break;
              }
            }
          }
        }
      }
      if (!full || !fs.existsSync(full)) {
        return res.status(404).json({
          ok: false,
          error: rel
            ? 'PDF-Datei nicht gefunden: ' + rel
            : 'Kein gespeichertes PDF – bitte zuerst speichern.',
        });
      }
      if (openLocal) {
        return res.json({ ok: true, path: full, rel: rel || path.basename(full), name: path.basename(full) });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(full) + '"');
      return res.send(fs.readFileSync(full));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'PDF konnte nicht geladen werden.' });
    }
  });

  app.get('/api/protokolle/kontrollwiegung', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      await pullOneJsonDraftForJob(
        reiseDir,
        localJobId,
        jobRow.server_id,
        technicianId,
        'kontrollwiegungsprotokoll.json',
        req.query,
      );
      const store = kontrollwiegungLocal.readKontrollwiegungStore(reiseDir, db, localJobId);
      res.json({ ok: true, store: store || { byFab: {}, nextLocalId: 1 }, data: store });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  });

  /** Nur JSON-Draft unter Dokumente_Monteur (ohne PDF) – z. B. beim FN-Wechsel. */
  app.post('/api/protokolle/kontrollwiegung', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      const fab = String(body.fabrikationsnummer || body.fab || '').trim();
      if (!technicianId || !localJobId || !fab) {
        return res.status(400).json({ ok: false, error: 'job_id, fabrikationsnummer und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const entry = {
        technician_id: technicianId,
        job_id: localJobId,
        local_job_id: localJobId,
        fabrikationsnummer: fab,
        durchfuehrungsdatum: body.durchfuehrungsdatum != null ? String(body.durchfuehrungsdatum).trim() : '',
        projekt: body.projekt != null ? String(body.projekt).trim() : '',
        type: body.type != null ? String(body.type).trim() : '',
        leistung: body.leistung != null ? String(body.leistung).trim() : '',
        elektronik: body.elektronik != null ? String(body.elektronik).trim() : '',
        teilung_kontrollwaage: body.teilung_kontrollwaage != null ? String(body.teilung_kontrollwaage).trim() : '',
        bereich_max: body.bereich_max != null ? String(body.bereich_max).trim() : '',
        letzte_eichung: body.letzte_eichung != null ? String(body.letzte_eichung).trim() : '',
        wiegungen: Array.isArray(body.wiegungen) ? body.wiegungen : [],
        languages: parseProtocolLanguages(body),
        pdf_languages: parseProtocolLanguages(body),
      };
      const record = kontrollwiegungLocal.saveKontrollwiegungLocal(reiseDir, fab, entry, db, localJobId);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!wantsLocalOnlyRequest(body) && dispoBaseUrl && multiDeviceApi && multiDeviceApi.pushJsonDraft) {
        const serverJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : 0;
        if (serverJobId > 0) {
          const kwPath = resolveMonteurDraftJsonPath(reiseDir, 'kontrollwiegungsprotokoll.json', true);
          try {
            await multiDeviceApi.pushJsonDraft({
              dispoBaseUrl,
              endpoint: '/dispo_api/api/kontrollwiegungsprotokoll_draft.php',
              technicianId,
              serverJobId,
              localJobId,
              reiseDir,
              filePath: kwPath,
              username: body.serverUsername || body.dispoUsername,
              password: body.serverPassword ?? body.dispoPassword,
            });
          } catch (_) { /* optional */ }
        }
      }
      res.json({ ok: true, protokoll_id: record.protokoll_id, local_protokoll_id: record.protokoll_id, store: kontrollwiegungLocal.readKontrollwiegungStore(reiseDir, db, localJobId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Draft konnte nicht gespeichert werden.' });
    }
  });

  app.post('/api/kontrollwiegungsprotokoll_save', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const payload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: body.job_id,
        local_job_id: localJobId,
        fabrikationsnummer: body.fabrikationsnummer,
        durchfuehrungsdatum: body.durchfuehrungsdatum,
        projekt: body.projekt != null ? String(body.projekt).trim() : '',
        type: body.type != null ? String(body.type).trim() : '',
        leistung: body.leistung != null ? String(body.leistung).trim() : '',
        elektronik: body.elektronik != null ? String(body.elektronik).trim() : '',
        teilung_kontrollwaage: body.teilung_kontrollwaage != null ? String(body.teilung_kontrollwaage).trim() : '',
        bereich_max: body.bereich_max != null ? String(body.bereich_max).trim() : '',
        letzte_eichung: body.letzte_eichung != null ? String(body.letzte_eichung).trim() : '',
        wiegungen: Array.isArray(body.wiegungen) ? body.wiegungen : [],
        dispoBaseUrl,
        serverUsername: body.serverUsername || body.dispoUsername,
        serverPassword: body.serverPassword ?? body.dispoPassword,
      };
      const pdfLangs = parseProtocolLanguages(body);
      payload.languages = pdfLangs;
      payload.pdf_languages = pdfLangs;
      enrichKontrollwiegungPdfPayload(payload, localJobId, technicianId);
      let reiseDir = null;
      if (Number.isFinite(localJobId) && localJobId > 0) {
        reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      }
      let record = null;
      let savedPdf = null;
      let savedPdfPath = null;
      const savedPdfs = [];
      const createPdf = body.create_pdf === true || body.createPdf === true;
      if (reiseDir) {
        record = kontrollwiegungLocal.saveKontrollwiegungLocal(reiseDir, payload.fabrikationsnummer, payload, db, localJobId);
        if (record) {
          payload.gespeichert_am = record.gespeichert_am || record.updated_at || '';
          payload.updated_at = record.updated_at || payload.gespeichert_am;
        }
        if (createPdf) {
        const sigPngKw = await resolveTechnicianSignaturePng(technicianId, body);
        if (!sigPngKw) return failMissingSignature(res);
        payload.technician_signature_png = sigPngKw;
        for (const lang of pdfLangs) {
          const pdfPaths = resolveKontrollwiegungLocalPdfPaths(
            reiseDir,
            localJobId,
            payload.fabrikationsnummer,
            technicianId,
            payload.durchfuehrungsdatum,
            lang,
            pdfLangs,
          );
          const pdfDir = path.dirname(pdfPaths.full);
          if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
          const pdfBuf = await protocolPdf.generateKontrollwiegungPdfBuffer(payload, { lang });
          writeFileWithRetry(pdfPaths.full, pdfBuf);
          savedPdfs.push({ rel: pdfPaths.rel, path: pdfPaths.full, name: pdfPaths.name, lang });
          protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
        }
        savedPdf = savedPdfs[0] ? savedPdfs[0].rel : null;
        savedPdfPath = savedPdfs[0] ? savedPdfs[0].path : null;
        if (record) {
          record.pdf_rel = savedPdf;
          record.pdf_rels = savedPdfs.map((p) => p.rel);
          record.languages = pdfLangs;
          const storeKw = kontrollwiegungLocal.readKontrollwiegungStore(reiseDir, db, localJobId);
          if (storeKw.byFab[payload.fabrikationsnummer]) {
            storeKw.byFab[payload.fabrikationsnummer].pdf_rel = savedPdf;
            storeKw.byFab[payload.fabrikationsnummer].pdf_rels = record.pdf_rels;
            storeKw.byFab[payload.fabrikationsnummer].languages = pdfLangs;
            kontrollwiegungLocal.writeKontrollwiegungStore(reiseDir, storeKw, db, localJobId);
          }
        }
        save();
        }
        const jobRowKw = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
        const serverJobIdKw = jobRowKw && jobRowKw.server_id != null ? parseInt(jobRowKw.server_id, 10) : 0;
        const kwPath = resolveMonteurDraftJsonPath(reiseDir, 'kontrollwiegungsprotokoll.json', true);
        queueProtocolDraftAndFiles({
          localJobId,
          technicianId,
          serverJobId: serverJobIdKw,
          dispoBaseUrl,
          basename: 'kontrollwiegungsprotokoll.json',
          reiseDir,
          filePath: kwPath,
          username: body.serverUsername || body.dispoUsername,
          password: body.serverPassword ?? body.dispoPassword,
        });
        if (dispoBaseUrl && multiDeviceApi && multiDeviceApi.pushJsonDraft && serverJobIdKw > 0 && !wantsLocalOnlyRequest(body)) {
          await multiDeviceApi.pushJsonDraft({
            dispoBaseUrl,
            endpoint: '/dispo_api/api/kontrollwiegungsprotokoll_draft.php',
            technicianId,
            serverJobId: serverJobIdKw,
            localJobId,
            reiseDir,
            filePath: kwPath,
            username: body.serverUsername || body.dispoUsername,
            password: body.serverPassword ?? body.dispoPassword,
          });
        }
      }
      let protokollId = record ? record.protokoll_id : 'local:' + Date.now();
      let deferred = false;
      if (dispoBaseUrl) {
        try {
          const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
          const url = dispoBaseUrl + '/dispo_api/api/kontrollwiegungsprotokoll_save.php';
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
            body: JSON.stringify(payload),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            protokollId = data.protokoll_id || data.id || protokollId;
            if (localJobId) {
              db.prepare(
                `DELETE FROM pending_changes WHERE entity_type = 'kontrollwiegung' AND entity_id = ? AND action = 'save'`,
              ).run(String(localJobId) + ':' + String(payload.fabrikationsnummer || ''));
              save();
            }
            return res.json(Object.assign({}, data, protocolPdfClientFields(savedPdfs), { local_protokoll_id: record && record.protokoll_id }));
          }
          deferred = true;
        } catch (_) {
          deferred = true;
        }
      } else {
        deferred = true;
      }
      if (deferred && localJobId) {
        queueDispoProxyPending(
          db,
          'kontrollwiegung',
          localJobId + ':' + String(payload.fabrikationsnummer || ''),
          'save',
          payload,
        );
        save();
      }
      res.json(Object.assign({
        ok: true,
        protokoll_id: protokollId,
        deferred,
        local_protokoll_id: record && record.protokoll_id,
      }, protocolPdfClientFields(savedPdfs)));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Kontrollwiegung konnte nicht gespeichert werden.' });
    }
  });

  app.get('/api/kontrollwiegungsprotokoll_pdf', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const protokollIdRaw = String(req.query.id || '');
      const protokollId = parseInt(protokollIdRaw.replace(/^local:/, ''), 10);
      const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
      const localJobId = parseInt(req.query.local_job_id || req.query.job_id, 10);
      const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
      if (!technicianId || !protokollIdRaw) {
        return res.status(400).json({ ok: false, error: 'id und technician_id erforderlich.' });
      }
      const openLocal =
        String(req.query.open_local || req.query.resolve_path || '').trim() === '1' ||
        String(req.query.open_local || '').toLowerCase() === 'true';
      if (
        protokollIdRaw.startsWith('local:') ||
        (openLocal && Number.isFinite(localJobId) && localJobId > 0) ||
        (!baseUrl && Number.isFinite(localJobId))
      ) {
        const reiseDir = Number.isFinite(localJobId) ? getOrCreateDienstreiseFolderForJob(localJobId) : null;
        if (!reiseDir) {
          return res.status(404).json({ ok: false, error: 'Lokales Protokoll nicht gefunden (job_id fehlt).' });
        }
        const rec = kontrollwiegungLocal.getKontrollwiegungLocal(reiseDir, fab, protokollIdRaw, db, localJobId);
        if (!rec) {
          return res.status(404).json({ ok: false, error: 'Lokales Protokoll nicht gefunden.' });
        }
        const recLangs = parseProtocolLanguages(rec);
        const pdfPaths = resolveKontrollwiegungLocalPdfPaths(
          reiseDir,
          localJobId,
          rec.fabrikationsnummer,
          technicianId,
          rec.durchfuehrungsdatum,
          recLangs[0],
          recLangs,
        );
        const candidates = [];
        if (rec.pdf_rel) {
          candidates.push({
            full: path.join(reiseDir, String(rec.pdf_rel).replace(/\//g, path.sep)),
            rel: String(rec.pdf_rel).replace(/\\/g, '/'),
          });
        }
        candidates.push({ full: pdfPaths.full, rel: pdfPaths.rel });
        candidates.push({
          full: path.join(reiseDir, 'Dokumente_Monteur', pdfPaths.name),
          rel: 'Dokumente_Monteur/' + pdfPaths.name,
        });
        let existing = null;
        for (const c of candidates) {
          if (c.full && fs.existsSync(c.full)) {
            existing = c;
            break;
          }
        }
        if (openLocal) {
          const pdfPayload = enrichKontrollwiegungPdfPayload(
            Object.assign({}, rec),
            localJobId,
            technicianId,
          );
          const sigKwOpen = await resolveTechnicianSignaturePng(technicianId, rec);
          if (sigKwOpen) pdfPayload.technician_signature_png = sigKwOpen;
          let firstPaths = pdfPaths;
          for (const lang of recLangs) {
            const langPaths = resolveKontrollwiegungLocalPdfPaths(
              reiseDir,
              localJobId,
              rec.fabrikationsnummer,
              technicianId,
              rec.durchfuehrungsdatum,
              lang,
              recLangs,
            );
            const pdfDir = path.dirname(langPaths.full);
            if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
            const pdfBufGen = await protocolPdf.generateKontrollwiegungPdfBuffer(pdfPayload, { lang });
            writeFileWithRetry(langPaths.full, pdfBufGen);
            if (lang === recLangs[0]) firstPaths = langPaths;
            if (Number.isFinite(localJobId) && localJobId > 0) {
              protectPathIfUnderDokumenteMonteur(db, localJobId, langPaths.rel);
            }
          }
          existing = { full: firstPaths.full, rel: firstPaths.rel };
          try {
            const storeKw = kontrollwiegungLocal.readKontrollwiegungStore(reiseDir, db, localJobId);
            const fnKey = String(rec.fabrikationsnummer || fab || '').trim();
            if (fnKey && storeKw.byFab[fnKey]) {
              storeKw.byFab[fnKey].pdf_rel = firstPaths.rel;
              if (!storeKw.byFab[fnKey].monteur_name && pdfPayload.monteur_name) {
                storeKw.byFab[fnKey].monteur_name = pdfPayload.monteur_name;
              }
              if (!storeKw.byFab[fnKey].kunde && pdfPayload.kunde) {
                storeKw.byFab[fnKey].kunde = pdfPayload.kunde;
                storeKw.byFab[fnKey].customer_name = pdfPayload.kunde;
              }
              kontrollwiegungLocal.writeKontrollwiegungStore(reiseDir, storeKw, db, localJobId);
            }
          } catch (_) { /* optional */ }
          if (Number.isFinite(localJobId) && localJobId > 0) save();
          return res.json({
            ok: true,
            path: existing.full,
            rel: existing.rel,
            name: firstPaths.name,
          });
        }
        if (existing) {
          const buf = fs.readFileSync(existing.full);
          res.set('Content-Type', 'application/pdf');
          res.set('Content-Disposition', 'inline; filename="' + pdfPaths.name + '"');
          return res.send(buf);
        }
        const pdfBuf = await protocolPdf.generateKontrollwiegungPdfBuffer(rec, { lang: recLangs[0] });
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="' + pdfPaths.name + '"');
        return res.send(pdfBuf);
      }
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: 'base_url erforderlich.' });
      }
      const url =
        baseUrl +
        '/dispo_api/api/kontrollwiegungsprotokoll_pdf.php?id=' +
        encodeURIComponent(protokollIdRaw) +
        '&technician_id=' +
        encodeURIComponent(technicianId);
      const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
      const r = await fetch(url, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="Kontrollwiegungsprotokoll.pdf"');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'PDF nicht verfügbar: ' + e.message });
    }
  });

  function resolveSchleppkettenLocalPdfPaths(reiseDir, localJobId, fab, technicianId, datum, lang, langs) {
    const safeFn = String(fab || '').replace(/[^\w.-]+/g, '_');
    const d = String(datum || '').replace(/-/g, '');
    const suffix = protocolPdfLangSuffix(lang || 'de', langs);
    const name = 'Schleppketten_Test_' + safeFn + '_' + d + suffix + '.pdf';
    if (Number.isFinite(localJobId) && localJobId > 0 && fab) {
      try {
        const { targetDir, relDir } = resolveMonteurProtokollePdfTargetSync(
          reiseDir,
          localJobId,
          fab,
          technicianId,
        );
        return {
          full: path.join(targetDir, name),
          rel: relDir + '/' + name,
          name,
          targetDir,
          relDir,
        };
      } catch (_) { /* Fallback */ }
    }
    return {
      full: path.join(reiseDir, 'Dokumente_Monteur', name),
      rel: 'Dokumente_Monteur/' + name,
      name,
      targetDir: path.join(reiseDir, 'Dokumente_Monteur'),
      relDir: 'Dokumente_Monteur',
    };
  }

  app.get('/api/protokolle/schleppketten', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      await pullOneJsonDraftForJob(
        reiseDir,
        localJobId,
        jobRow.server_id,
        technicianId,
        'schleppkettenprotokoll.json',
        req.query,
      );
      const store = schleppkettenLocal.readSchleppkettenStore(reiseDir, db, localJobId);
      res.json({ ok: true, store: store || { byFab: {}, nextLocalId: 1 } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  });

  app.post('/api/protokolle/schleppketten', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      const fab = String(body.fabrikationsnummer || body.fab || '').trim();
      if (!technicianId || !localJobId || !fab) {
        return res.status(400).json({ ok: false, error: 'job_id, fabrikationsnummer und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const entry = Object.assign({}, body, {
        technician_id: technicianId,
        job_id: localJobId,
        fabrikationsnummer: fab,
        messungen: Array.isArray(body.messungen) ? body.messungen : [],
      });
      const record = schleppkettenLocal.saveSchleppkettenLocal(reiseDir, fab, entry, db, localJobId);
      res.json({
        ok: true,
        protokoll_id: record.protokoll_id,
        local_protokoll_id: record.protokoll_id,
        store: schleppkettenLocal.readSchleppkettenStore(reiseDir, db, localJobId),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Draft konnte nicht gespeichert werden.' });
    }
  });

  app.post('/api/schleppkettenprotokoll_save', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      const leistungVal = String(
        body.leistung != null && String(body.leistung).trim() !== ''
          ? body.leistung
          : (body.nennleistung != null ? body.nennleistung : '')
      ).trim();
      const elektronikVal = String(
        body.elektronik != null && String(body.elektronik).trim() !== ''
          ? body.elektronik
          : (body.dwc != null ? body.dwc : '')
      ).trim();
      let serverJobId = parseInt(body.job_id, 10);
      if (Number.isFinite(localJobId) && localJobId > 0) {
        const jobRowSk = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
        if (jobRowSk && jobRowSk.server_id != null && String(jobRowSk.server_id).trim() !== '') {
          serverJobId = parseInt(jobRowSk.server_id, 10);
        }
      }
      const payload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: Number.isFinite(serverJobId) && serverJobId > 0 ? serverJobId : body.job_id,
        local_job_id: localJobId,
        fabrikationsnummer: body.fabrikationsnummer,
        durchfuehrungsdatum: body.durchfuehrungsdatum,
        projekt: body.projekt != null ? String(body.projekt).trim() : '',
        waagenart: body.waagenart != null ? String(body.waagenart).trim() : 'Bandwaage',
        type: body.type != null ? String(body.type).trim() : '',
        leistung: leistungVal,
        elektronik: elektronikVal,
        nennleistung: leistungVal,
        gn: body.gn != null ? String(body.gn).trim() : '',
        dwc: elektronikVal,
        pos_nr: body.pos_nr != null ? String(body.pos_nr).trim() : '',
        monteur_name: body.monteur_name != null ? String(body.monteur_name).trim() : '',
        ketten: Array.isArray(body.ketten) ? body.ketten : [],
        ketten_type: body.ketten_type != null ? String(body.ketten_type).trim() : '',
        ketten_laenge: body.ketten_laenge != null ? String(body.ketten_laenge).trim() : '',
        ketten_anzahl: body.ketten_anzahl != null ? String(body.ketten_anzahl).trim() : '',
        gewicht_pro_kette: body.gewicht_pro_kette != null ? String(body.gewicht_pro_kette).trim() : '',
        gewicht_pro_meter: body.gewicht_pro_meter != null ? String(body.gewicht_pro_meter).trim() : '',
        kunde: body.kunde != null ? String(body.kunde).trim() : '',
        messungen: Array.isArray(body.messungen) ? body.messungen : [],
        dispoBaseUrl,
        serverUsername: body.serverUsername || body.dispoUsername,
        serverPassword: body.serverPassword ?? body.dispoPassword,
      };
      const pdfLangsSk = parseProtocolLanguages(body);
      payload.languages = pdfLangsSk;
      payload.pdf_languages = pdfLangsSk;
      enrichKontrollwiegungPdfPayload(payload, localJobId, technicianId);
      if (payload.kunde) payload.customer_name = payload.kunde;
      let reiseDir = null;
      if (Number.isFinite(localJobId) && localJobId > 0) {
        reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      }
      let record = null;
      let savedPdf = null;
      let savedPdfPath = null;
      const savedPdfs = [];
      const createPdf = body.create_pdf === true || body.createPdf === true;
      if (reiseDir) {
        record = schleppkettenLocal.saveSchleppkettenLocal(reiseDir, payload.fabrikationsnummer, payload, db, localJobId);
        if (record) {
          payload.gespeichert_am = record.gespeichert_am || record.updated_at || '';
          payload.updated_at = record.updated_at || payload.gespeichert_am;
          payload.messungen = record.messungen;
        }
        if (createPdf) {
        const sigPngSk = await resolveTechnicianSignaturePng(technicianId, body);
        if (!sigPngSk) return failMissingSignature(res);
        payload.technician_signature_png = sigPngSk;
        for (const lang of pdfLangsSk) {
          const pdfPaths = resolveSchleppkettenLocalPdfPaths(
            reiseDir,
            localJobId,
            payload.fabrikationsnummer,
            technicianId,
            payload.durchfuehrungsdatum,
            lang,
            pdfLangsSk,
          );
          const pdfDir = path.dirname(pdfPaths.full);
          if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
          const pdfBuf = await protocolPdf.generateSchleppkettenPdfBuffer(payload, { lang });
          writeFileWithRetry(pdfPaths.full, pdfBuf);
          savedPdfs.push({ rel: pdfPaths.rel, path: pdfPaths.full, name: pdfPaths.name, lang });
          protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
        }
        savedPdf = savedPdfs[0] ? savedPdfs[0].rel : null;
        savedPdfPath = savedPdfs[0] ? savedPdfs[0].path : null;
        if (record) {
          record.pdf_rel = savedPdf;
          record.pdf_rels = savedPdfs.map((p) => p.rel);
          record.languages = pdfLangsSk;
          const storeSk = schleppkettenLocal.readSchleppkettenStore(reiseDir, db, localJobId);
          if (storeSk.byFab[payload.fabrikationsnummer]) {
            storeSk.byFab[payload.fabrikationsnummer].pdf_rel = savedPdf;
            storeSk.byFab[payload.fabrikationsnummer].pdf_rels = record.pdf_rels;
            storeSk.byFab[payload.fabrikationsnummer].languages = pdfLangsSk;
            schleppkettenLocal.writeSchleppkettenStore(reiseDir, storeSk, db, localJobId);
          }
        }
        save();
        }
        const jobRowSk = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
        const srvJobId = jobRowSk && jobRowSk.server_id != null ? parseInt(jobRowSk.server_id, 10) : 0;
        const skPath = resolveMonteurDraftJsonPath(reiseDir, 'schleppkettenprotokoll.json', true);
        queueProtocolDraftAndFiles({
          localJobId,
          technicianId,
          serverJobId: srvJobId,
          dispoBaseUrl,
          basename: 'schleppkettenprotokoll.json',
          reiseDir,
          filePath: skPath,
          username: body.serverUsername || body.dispoUsername,
          password: body.serverPassword ?? body.dispoPassword,
        });
        if (dispoBaseUrl && multiDeviceApi && multiDeviceApi.pushJsonDraft && srvJobId > 0 && !wantsLocalOnlyRequest(body)) {
          await multiDeviceApi.pushJsonDraft({
            dispoBaseUrl,
            endpoint: '/dispo_api/api/schleppkettenprotokoll_draft.php',
            technicianId,
            serverJobId: srvJobId,
            localJobId,
            reiseDir,
            filePath: skPath,
            username: body.serverUsername || body.dispoUsername,
            password: body.serverPassword ?? body.dispoPassword,
          });
        }
      }
      let protokollId = record ? record.protokoll_id : 'local:' + Date.now();
      let deferred = false;
      if (dispoBaseUrl) {
        try {
          const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
          const url = dispoBaseUrl + '/dispo_api/api/schleppkettenprotokoll_save.php';
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
            body: JSON.stringify(payload),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            protokollId = data.protokoll_id || data.id || protokollId;
            if (localJobId) {
              db.prepare(
                `DELETE FROM pending_changes WHERE entity_type = 'schleppketten' AND entity_id = ? AND action = 'save'`,
              ).run(String(localJobId) + ':' + String(payload.fabrikationsnummer || ''));
              save();
            }
            return res.json(Object.assign({}, data, protocolPdfClientFields(savedPdfs), { local_protokoll_id: record && record.protokoll_id }));
          }
          deferred = true;
        } catch (_) {
          deferred = true;
        }
      } else {
        deferred = true;
      }
      if (deferred && localJobId) {
        queueDispoProxyPending(
          db,
          'schleppketten',
          localJobId + ':' + String(payload.fabrikationsnummer || ''),
          'save',
          payload,
        );
        save();
      }
      res.json(Object.assign({
        ok: true,
        deferred: !!deferred,
        protokoll_id: protokollId,
        local_protokoll_id: record && record.protokoll_id,
      }, protocolPdfClientFields(savedPdfs)));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Schleppketten-Test konnte nicht gespeichert werden.' });
    }
  });

  app.get('/api/schleppkettenprotokoll_pdf', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const protokollIdRaw = String(req.query.id || '');
      const localJobId = parseInt(req.query.local_job_id || req.query.job_id, 10);
      const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
      const openLocal =
        String(req.query.open_local || req.query.resolve_path || '').trim() === '1' ||
        String(req.query.open_local || '').toLowerCase() === 'true';
      if (!technicianId || !protokollIdRaw) {
        return res.status(400).json({ ok: false, error: 'id und technician_id erforderlich.' });
      }
      if (!Number.isFinite(localJobId) || localJobId <= 0) {
        return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const rec = schleppkettenLocal.getSchleppkettenLocal(reiseDir, fab, protokollIdRaw, db, localJobId);
      if (!rec) {
        return res.status(404).json({ ok: false, error: 'Lokales Protokoll nicht gefunden.' });
      }
      const pdfPayload = enrichKontrollwiegungPdfPayload(Object.assign({}, rec), localJobId, technicianId);
      pdfPayload.messungen = schleppkettenLocal.enrichMessungen(pdfPayload.messungen);
      const sigSk = await resolveTechnicianSignaturePng(technicianId, rec);
      if (sigSk) pdfPayload.technician_signature_png = sigSk;
      const recLangsSk = parseProtocolLanguages(rec);
      const pdfPaths = resolveSchleppkettenLocalPdfPaths(
        reiseDir,
        localJobId,
        rec.fabrikationsnummer,
        technicianId,
        rec.durchfuehrungsdatum,
        recLangsSk[0],
        recLangsSk,
      );
      if (openLocal) {
        let firstPaths = pdfPaths;
        for (const lang of recLangsSk) {
          const langPaths = resolveSchleppkettenLocalPdfPaths(
            reiseDir,
            localJobId,
            rec.fabrikationsnummer,
            technicianId,
            rec.durchfuehrungsdatum,
            lang,
            recLangsSk,
          );
          const pdfDir = path.dirname(langPaths.full);
          if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
          const pdfBufGen = await protocolPdf.generateSchleppkettenPdfBuffer(pdfPayload, { lang });
          writeFileWithRetry(langPaths.full, pdfBufGen);
          protectPathIfUnderDokumenteMonteur(db, localJobId, langPaths.rel);
          if (lang === recLangsSk[0]) firstPaths = langPaths;
        }
        save();
        return res.json({ ok: true, path: firstPaths.full, rel: firstPaths.rel, name: firstPaths.name });
      }
      if (fs.existsSync(pdfPaths.full)) {
        const buf = fs.readFileSync(pdfPaths.full);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="' + pdfPaths.name + '"');
        return res.send(buf);
      }
      const pdfBuf = await protocolPdf.generateSchleppkettenPdfBuffer(pdfPayload, { lang: recLangsSk[0] });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="' + pdfPaths.name + '"');
      return res.send(pdfBuf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'PDF nicht verfügbar: ' + e.message });
    }
  });

  function resolvePruefzertifikatLocalPdfPaths(reiseDir, localJobId, fab, technicianId, datum, lang) {
    const safeFn = String(fab || '').replace(/[^\w.-]+/g, '_');
    const d = String(datum || '').replace(/-/g, '');
    const suffix = lang === 'en' ? '_EN' : '';
    const name = 'Pruefzertifikat_' + safeFn + '_' + d + suffix + '.pdf';
    if (Number.isFinite(localJobId) && localJobId > 0 && fab) {
      try {
        const { targetDir, relDir } = resolveMonteurProtokollePdfTargetSync(
          reiseDir,
          localJobId,
          fab,
          technicianId,
        );
        return {
          full: path.join(targetDir, name),
          rel: relDir + '/' + name,
          name,
          targetDir,
          relDir,
        };
      } catch (_) { /* Fallback */ }
    }
    return {
      full: path.join(reiseDir, 'Dokumente_Monteur', name),
      rel: 'Dokumente_Monteur/' + name,
      name,
      targetDir: path.join(reiseDir, 'Dokumente_Monteur'),
      relDir: 'Dokumente_Monteur',
    };
  }

  app.get('/api/protokolle/pruefzertifikat', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      await pullOneJsonDraftForJob(
        reiseDir,
        localJobId,
        jobRow.server_id,
        technicianId,
        'pruefzertifikat.json',
        req.query,
      );
      const store = pruefzertifikatLocal.readPruefzertifikatStore(reiseDir, db, localJobId);
      res.json({ ok: true, store: store || { byFab: {}, nextLocalId: 1 } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  });

  app.get('/api/pruefzertifikat_prefill', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.local_job_id, 10);
      const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
      const dispoBaseUrl = String(req.query.base_url || req.query.dispoBaseUrl || '').trim().replace(/\/$/, '');
      if (!technicianId || !localJobId || !fab) {
        return res.status(400).json({ ok: false, error: 'job_id, fabrikationsnummer und technician_id erforderlich.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      let serverJobId = localJobId;
      const jobRow = db.prepare('SELECT server_id, job_number FROM jobs WHERE id = ?').get(localJobId);
      if (jobRow && jobRow.server_id != null && String(jobRow.server_id).trim() !== '') {
        serverJobId = parseInt(jobRow.server_id, 10);
      }
      if (dispoBaseUrl) {
        try {
          const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
          const url =
            dispoBaseUrl +
            '/dispo_api/api/pruefzertifikat_prefill.php?technician_id=' +
            encodeURIComponent(technicianId) +
            '&job_id=' +
            encodeURIComponent(serverJobId) +
            '&fabrikationsnummer=' +
            encodeURIComponent(fab);
          const r = await fetch(url, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.prefill) {
            const prefill = data.prefill;
            try {
              ensureAnlagenstammLocalSchema(db);
              const stammRow = anlagenstammLookupByFab(db, fab);
              if (stammRow && stammRow.projekt && String(stammRow.projekt).trim()) {
                // Anlagenstamm hat Vorrang vor Auftragsnummer im Prefill.
                prefill.projekt = String(stammRow.projekt).trim();
              }
            } catch (_) { /* optional */ }
            try {
              if (!(prefill.ergebnisse && prefill.ergebnisse.service)) {
                const localSp = pruefzertifikatLocal.prefillFromLocalDrafts(reiseDir, fab, {}, db, localJobId);
                if (localSp && localSp.ergebnisse && localSp.ergebnisse.service) {
                  prefill.ergebnisse = prefill.ergebnisse || {};
                  prefill.ergebnisse.service = localSp.ergebnisse.service;
                  if (!prefill.verfahren) prefill.verfahren = {};
                  prefill.verfahren.service = true;
                }
              }
            } catch (_) { /* optional */ }
            return res.json({ ok: true, prefill, source: data.source || 'dispo' });
          }
        } catch (_) { /* local fallback */ }
      }
      const tech = (() => {
        try {
          return db.prepare('SELECT full_name FROM technicians WHERE id = ?').get(technicianId);
        } catch (_) {
          try {
            return db.prepare('SELECT full_name FROM users WHERE id = ?').get(technicianId);
          } catch (_2) {
            return null;
          }
        }
      })();
      let stammMeta = {};
      try {
        ensureAnlagenstammLocalSchema(db);
        const stammRow = anlagenstammLookupByFab(db, fab);
        if (stammRow) {
          stammMeta = {
            projekt: stammRow.projekt != null ? String(stammRow.projekt).trim() : '',
            type: stammRow.type != null ? String(stammRow.type).trim() : '',
            elektronik: stammRow.elektronik != null ? String(stammRow.elektronik).trim() : '',
            position: stammRow.position != null ? String(stammRow.position).trim() : '',
            leistung: stammRow.leistung != null ? String(stammRow.leistung).trim() : '',
          };
        }
      } catch (_) { /* optional */ }
      const prefill = pruefzertifikatLocal.prefillFromLocalDrafts(reiseDir, fab, {
        job_number: jobRow && jobRow.job_number,
        technician_name: tech && tech.full_name,
        ...stammMeta,
      }, db, localJobId);
      res.json({ ok: true, prefill, source: 'local' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Prefill fehlgeschlagen.' });
    }
  });

  app.post('/api/pruefzertifikat_save', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      if (!technicianId) {
        return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      }
      let serverJobId = parseInt(body.job_id, 10);
      if (Number.isFinite(localJobId) && localJobId > 0) {
        const jobRowPz = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
        if (jobRowPz && jobRowPz.server_id != null && String(jobRowPz.server_id).trim() !== '') {
          serverJobId = parseInt(jobRowPz.server_id, 10);
        }
      }
      const pdfLanguagesRaw = Array.isArray(body.pdf_languages) && body.pdf_languages.length
        ? body.pdf_languages
        : (Array.isArray(body.languages) ? body.languages : []);
      const pdfLanguages = pdfLanguagesRaw
        .map((l) => String(l).toLowerCase())
        .filter((l) => l === 'de' || l === 'en');
      const wantPdf = !!body.create_pdf || !!body.createPdf;
      const langs = wantPdf ? (pdfLanguages.length ? pdfLanguages : ['de']) : [];
      const storedLangs = pdfLanguages.length ? pdfLanguages : ['de'];
      const payload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: Number.isFinite(serverJobId) && serverJobId > 0 ? serverJobId : body.job_id,
        local_job_id: localJobId,
        fabrikationsnummer: body.fabrikationsnummer,
        pruefdatum: body.pruefdatum || body.durchfuehrungsdatum,
        durchfuehrungsdatum: body.pruefdatum || body.durchfuehrungsdatum,
        naechste_pruefung: body.naechste_pruefung || '',
        zertifikat_nr: body.zertifikat_nr || '',
        projekt: body.projekt != null ? String(body.projekt).trim() : '',
        kunde: body.kunde != null ? String(body.kunde).trim() : '',
        standort: body.standort != null ? String(body.standort).trim() : '',
        type: body.type != null ? String(body.type).trim() : '',
        pos_nr: body.pos_nr != null ? String(body.pos_nr).trim() : '',
        elektronik: body.elektronik != null ? String(body.elektronik).trim() : '',
        nennleistung: body.nennleistung != null ? String(body.nennleistung).trim() : (body.leistung || ''),
        waagenart: body.waagenart != null ? String(body.waagenart).trim() : '',
        verfahren: body.verfahren && typeof body.verfahren === 'object' ? body.verfahren : {},
        ergebnisse: body.ergebnisse && typeof body.ergebnisse === 'object' ? body.ergebnisse : {},
        zulaessige_abweichung_pct: body.zulaessige_abweichung_pct,
        status_bestanden: body.status_bestanden,
        pruefmittel: body.pruefmittel != null ? String(body.pruefmittel).trim() : '',
        letzte_eichung_kontrollwaage: body.letzte_eichung_kontrollwaage != null ? String(body.letzte_eichung_kontrollwaage).trim() : '',
        bemerkungen: body.bemerkungen != null ? String(body.bemerkungen).trim() : '',
        konformitaet_text: body.konformitaet_text != null ? String(body.konformitaet_text).trim() : '',
        monteur_name: body.monteur_name != null ? String(body.monteur_name).trim() : '',
        kunde_unterschrift: body.kunde_unterschrift != null ? String(body.kunde_unterschrift).trim() : '',
        kontrollwiegungsprotokoll_id: body.kontrollwiegungsprotokoll_id || null,
        schleppkettenprotokoll_id: body.schleppkettenprotokoll_id || null,
        serviceprotokoll_id: body.serviceprotokoll_id || null,
        inbetriebnahme_id: body.inbetriebnahme_id || null,
        languages: storedLangs,
        pdf_languages: storedLangs,
        dispoBaseUrl,
        serverUsername: body.serverUsername || body.dispoUsername,
        serverPassword: body.serverPassword ?? body.dispoPassword,
      };
      enrichKontrollwiegungPdfPayload(payload, localJobId, technicianId);
      let reiseDir = null;
      if (Number.isFinite(localJobId) && localJobId > 0) {
        reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      }
      let record = null;
      const savedPdfs = [];
      if (reiseDir) {
        if (wantPdf) {
          const sigPngPz = await resolveTechnicianSignaturePng(technicianId, body);
          if (!sigPngPz) return failMissingSignature(res);
          payload.technician_signature_png = sigPngPz;
        }
        record = pruefzertifikatLocal.savePruefzertifikatLocal(reiseDir, payload.fabrikationsnummer, payload, db, localJobId);
        for (const lang of langs) {
          const pdfPaths = resolvePruefzertifikatLocalPdfPaths(
            reiseDir,
            localJobId,
            payload.fabrikationsnummer,
            technicianId,
            payload.pruefdatum,
            lang,
          );
          const pdfDir = path.dirname(pdfPaths.full);
          if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
          const pdfBuf = await protocolPdf.generatePruefzertifikatPdfBuffer(payload, { lang });
          writeFileWithRetry(pdfPaths.full, pdfBuf);
          savedPdfs.push({ lang, rel: pdfPaths.rel, name: pdfPaths.name, path: pdfPaths.full });
          protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
        }
        if (record && savedPdfs.length) {
          record.pdf_rel = savedPdfs[0].rel;
          const storePz = pruefzertifikatLocal.readPruefzertifikatStore(reiseDir, db, localJobId);
          if (storePz.byFab[payload.fabrikationsnummer]) {
            storePz.byFab[payload.fabrikationsnummer].pdf_rel = savedPdfs[0].rel;
            storePz.byFab[payload.fabrikationsnummer].pdfs = savedPdfs;
            pruefzertifikatLocal.writePruefzertifikatStore(reiseDir, storePz, db, localJobId);
          }
        }
        save();
        const jobRowPz = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
        const srvJobId = jobRowPz && jobRowPz.server_id != null ? parseInt(jobRowPz.server_id, 10) : 0;
        const pzPath = resolveMonteurDraftJsonPath(reiseDir, 'pruefzertifikat.json', true);
        queueProtocolDraftAndFiles({
          localJobId,
          technicianId,
          serverJobId: srvJobId,
          dispoBaseUrl,
          basename: 'pruefzertifikat.json',
          reiseDir,
          filePath: pzPath,
          username: body.serverUsername || body.dispoUsername,
          password: body.serverPassword ?? body.dispoPassword,
        });
        if (!wantsLocalOnlyRequest(body) && dispoBaseUrl && multiDeviceApi && multiDeviceApi.pushJsonDraft && srvJobId > 0) {
          await multiDeviceApi.pushJsonDraft({
            dispoBaseUrl,
            endpoint: '/dispo_api/api/pruefzertifikat_draft.php',
            technicianId,
            serverJobId: srvJobId,
            localJobId,
            reiseDir,
            filePath: pzPath,
            username: body.serverUsername || body.dispoUsername,
            password: body.serverPassword ?? body.dispoPassword,
          });
        }
      }
      let protokollId = record ? record.protokoll_id : 'local:' + Date.now();
      let deferred = false;
      if (!wantsLocalOnlyRequest(body)) {
        if (dispoBaseUrl) {
          try {
            const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
            const url = dispoBaseUrl + '/dispo_api/api/pruefzertifikat_save.php';
            const r = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
              body: JSON.stringify(payload),
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok && data.ok) {
              protokollId = data.zertifikat_id || data.protokoll_id || data.id || protokollId;
              return res.json(Object.assign({}, data, protocolPdfClientFields(savedPdfs), {
                local_protokoll_id: record && record.protokoll_id,
              }));
            }
            deferred = true;
          } catch (_) {
            deferred = true;
          }
        } else {
          deferred = true;
        }
      }
      if (deferred && localJobId) {
        queueDispoProxyPending(
          db,
          'pruefzertifikat',
          localJobId + ':' + String(payload.fabrikationsnummer || ''),
          'save',
          payload,
        );
        save();
      }
      res.json(Object.assign({
        ok: true,
        deferred: !!deferred,
        protokoll_id: protokollId,
        zertifikat_id: protokollId,
        local_protokoll_id: record && record.protokoll_id,
      }, protocolPdfClientFields(savedPdfs)));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Prüfzertifikat konnte nicht gespeichert werden.' });
    }
  });

  const SERVICE_LIKE_PROTOCOL = {
    serviceprotokoll: {
      routeKey: 'serviceprotokoll',
      basename: 'serviceprotokoll.json',
      entityType: 'serviceprotokoll',
      draftPhp: 'serviceprotokoll_draft.php',
      savePhp: 'serviceprotokoll_save.php',
      saveAllPhp: 'serviceprotokoll_save_all.php',
      pdfPhp: 'serviceprotokoll_pdf.php',
      pdfPrefix: 'Serviceprotokoll',
      titleDe: 'Serviceprotokoll',
      titleEn: 'Service protocol',
      saveError: 'Serviceprotokoll konnte nicht gespeichert werden.',
    },
    inbetriebnahme: {
      routeKey: 'inbetriebnahme',
      basename: 'inbetriebnahmeprotokoll.json',
      entityType: 'inbetriebnahme',
      draftPhp: 'inbetriebnahme_draft.php',
      savePhp: 'inbetriebnahme_save.php',
      saveAllPhp: 'inbetriebnahme_save_all.php',
      pdfPhp: 'inbetriebnahme_pdf.php',
      pdfPrefix: 'Inbetriebnahmeprotokoll',
      titleDe: 'Inbetriebnahme Protokoll',
      titleEn: 'Commissioning report',
      saveError: 'Inbetriebnahme-Protokoll konnte nicht gespeichert werden.',
    },
  };

  function serviceLikeSpecFromArg(spec) {
    if (spec && spec.basename) return spec;
    if (spec === 'inbetriebnahme' || spec === 'ibn') return SERVICE_LIKE_PROTOCOL.inbetriebnahme;
    return SERVICE_LIKE_PROTOCOL.serviceprotokoll;
  }

  function serviceLikeSpecFromReq(req) {
    const p = String((req && req.originalUrl) || (req && req.path) || (req && req.url) || '');
    if (p.indexOf('/inbetriebnahme') !== -1) return SERVICE_LIKE_PROTOCOL.inbetriebnahme;
    return SERVICE_LIKE_PROTOCOL.serviceprotokoll;
  }

  function serviceprotokollJsonPath(reiseDir, spec) {
    const s = serviceLikeSpecFromArg(spec);
    return resolveMonteurDraftJsonPath(reiseDir, s.basename, true);
  }

  function readServiceprotokollStore(reiseDir, localJobId, spec) {
    const s = serviceLikeSpecFromArg(spec);
    if (localJobId) {
      const store = protocolDrafts.readStore(db, localJobId, s.basename, reiseDir);
      return normalizeServiceprotokollStore(store);
    }
    const p = serviceprotokollJsonPath(reiseDir, s);
    if (!fs.existsSync(p)) return { byFab: {} };
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object' && data.byFab && typeof data.byFab === 'object') {
        return normalizeServiceprotokollStore(data);
      }
    } catch (_) { /* ignore */ }
    return { byFab: {} };
  }

  /**
   * abschluss muss ein Objekt sein. PHP json_decode wandelt {} → [] um;
   * leere Arrays würden sonst beim Laden wie „gesetzt“ wirken und Status auf geprueft fallen.
   */
  function normalizeServiceprotokollAbschluss(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'geprueft', bemerkungen: '' };
    }
    const statusRaw = String(raw.status || '').trim().toLowerCase();
    let status = 'geprueft';
    if (statusRaw === 'justiert' || statusRaw === 'adjusted') status = 'justiert';
    else if (statusRaw === 'mangel' || statusRaw === 'mangel festgestellt' || statusRaw === 'defect' || statusRaw === 'defect found') {
      status = 'mangel';
    } else if (
      statusRaw === 'geprueft' ||
      statusRaw === 'geprüft' ||
      statusRaw === 'gepruft' ||
      statusRaw === 'checked' ||
      statusRaw === 'inspected' ||
      !statusRaw
    ) {
      status = 'geprueft';
    } else {
      status = statusRaw;
    }
    return {
      status,
      bemerkungen: raw.bemerkungen != null ? String(raw.bemerkungen) : '',
      monteur_id: raw.monteur_id != null ? String(raw.monteur_id) : '',
      monteur_name: raw.monteur_name != null ? String(raw.monteur_name) : '',
      signature_override_png: raw.signature_override_png || raw.signature_monteur || '',
      signature_monteur: raw.signature_monteur || raw.signature_override_png || '',
      signature_kunde: raw.signature_kunde != null ? String(raw.signature_kunde) : '',
    };
  }

  function abschlussStatusRank(abschluss) {
    const a = normalizeServiceprotokollAbschluss(abschluss);
    if (a.status === 'justiert' || a.status === 'mangel') return 2;
    if (String(a.bemerkungen || '').trim()) return 1;
    return 0;
  }

  function normalizeServiceprotokollDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return draft;
    const out = Object.assign({}, draft);
    out.abschluss = normalizeServiceprotokollAbschluss(draft.abschluss);
    return out;
  }

  function normalizeServiceprotokollStore(store) {
    const byFabIn = store && store.byFab && typeof store.byFab === 'object' ? store.byFab : {};
    const byFab = {};
    Object.keys(byFabIn).forEach((fab) => {
      const key = String(fab || '').trim();
      if (!key) return;
      byFab[key] = normalizeServiceprotokollDraft(byFabIn[fab]);
    });
    return Object.assign({}, store, { byFab });
  }

  function writeServiceprotokollDraft(reiseDir, fab, draft, localJobId, spec) {
    const s = serviceLikeSpecFromArg(spec);
    const fn = String(fab || '').trim();
    if (!fn) throw new Error('Fabrikationsnummer fehlt');
    const store = readServiceprotokollStore(reiseDir, localJobId, s);
    const prev = store.byFab[fn] || {};
    const incoming = draft && typeof draft === 'object' ? draft : {};
    const incomingAbs = incoming.abschluss;
    let abs;
    if (incomingAbs == null || typeof incomingAbs !== 'object' || Array.isArray(incomingAbs)) {
      // [] / fehlt: bisherigen Abschluss behalten (PHP-{}→[]-Falle)
      abs = normalizeServiceprotokollAbschluss(prev.abschluss);
    } else {
      abs = normalizeServiceprotokollAbschluss(incomingAbs);
    }
    store.byFab[fn] = Object.assign({}, prev, incoming, {
      fabrikationsnummer: fn,
      abschluss: abs,
      updatedAt: new Date().toISOString(),
    });
    const normalized = normalizeServiceprotokollStore(store);
    if (localJobId) {
      protocolDrafts.writeStore(db, localJobId, s.basename, normalized, reiseDir);
    } else {
      const outPath = serviceprotokollJsonPath(reiseDir, s);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileWithRetry(outPath, JSON.stringify(normalized, null, 2));
    }
    return store.byFab[fn];
  }

  function pickProtocolMotors(src) {
    if (!src || typeof src !== 'object') return [];
    if (Array.isArray(src.motoren)) return normalizeMotorRows({ motoren: src.motoren });
    if (src.messwerte && Array.isArray(src.messwerte.motoren)) {
      return normalizeMotorRows({ motoren: src.messwerte.motoren });
    }
    return [];
  }

  function shouldApplyServiceprotokollToAnlagenstamm(body) {
    const b = body || {};
    if (b.apply_to_anlagenstamm === true || b.apply_to_anlagenstamm === 1 || b.apply_to_anlagenstamm === '1') return true;
    if (b.applyToAnlagenstamm === true || b.applyToAnlagenstamm === 1 || b.applyToAnlagenstamm === '1') return true;
    return false;
  }

  function encodeKaExtraFromMess(m) {
    let extras = m && Array.isArray(m.waegezellen_extra) ? m.waegezellen_extra : [];
    if ((!extras || !extras.length) && m && Array.isArray(m.waegezellen) && m.waegezellen.length > 1) {
      extras = m.waegezellen.slice(1);
    }
    const normalized = extras
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = {
          kraftaufnehmer: String(item.kraftaufnehmer || item.type || '').trim(),
          dms_nr: String(item.dms_nr || item.serialNumber || '').trim(),
          dms_position: String(item.dms_position || item.position || '').trim(),
          vers_spannung: String(item.vers_spannung || item.supplyVoltage || '').trim(),
          sensitivitaet: String(item.sensitivitaet || item.sensitivity || '').trim(),
        };
        if (!row.kraftaufnehmer && !row.dms_nr && !row.dms_position && !row.vers_spannung && !row.sensitivitaet) {
          return null;
        }
        return row;
      })
      .filter(Boolean);
    if (!normalized.length) return '';
    try {
      return JSON.stringify(normalized);
    } catch (_) {
      return '';
    }
  }

  async function syncServiceprotokollMesswerteToAnlagenstammLocal(body, fab, messwerte, kopfDwc, kopfExtra) {
    if (!shouldApplyServiceprotokollToAnlagenstamm(body)) return null;
    const mess = messwerte && typeof messwerte === 'object' ? messwerte : {};
    const kopf = kopfExtra && typeof kopfExtra === 'object' ? kopfExtra : {};
    const typeVal = String(mess.waegezelle_type || '').trim();
    const snVal = String(mess.waegezelle_seriennummer || '').trim();
    const dwcVal = String(kopfDwc || kopf.kopf_dwc || '').trim();
    const posVal = String(kopf.kopf_pos_nr || '').trim();
    const qmaxVal = String(kopf.kopf_qmax || '').trim();
    const vmaxVal = String(kopf.kopf_vmax || '').trim();
    const plantTypeVal = String(kopf.kopf_type || '').trim();
    const projektVal = String(kopf.projekt || body.projekt || '').trim();
    const dmsPosEarly = String(
      kopf.dms_position || mess.waegezelle_position || body.dms_position || '',
    ).trim();
    const versEarly = String(
      kopf.vers_spannung || mess.vers_spannung || body.vers_spannung || '',
    ).trim();
    const sensEarly = String(
      kopf.sensitivitaet || mess.sensitivitaet || body.sensitivitaet || '',
    ).trim();
    const kaExtraEarly =
      kopf.kraftaufnehmer_extra != null && kopf.kraftaufnehmer_extra !== ''
        ? String(kopf.kraftaufnehmer_extra)
        : body.kraftaufnehmer_extra != null && body.kraftaufnehmer_extra !== ''
          ? String(body.kraftaufnehmer_extra)
          : encodeKaExtraFromMess(mess);
    const fabKey = String(fab || '').trim();
    if (
      !fabKey ||
      (!typeVal &&
        !snVal &&
        !dwcVal &&
        !posVal &&
        !qmaxVal &&
        !vmaxVal &&
        !plantTypeVal &&
        !projektVal &&
        !dmsPosEarly &&
        !versEarly &&
        !sensEarly &&
        !kaExtraEarly)
    ) {
      return null;
    }
    const technicianId = body.technician_id != null ? parseInt(String(body.technician_id), 10) : null;
    const partial = {
      fabrikationsnummer: fabKey,
      baseUrl: body.dispoBaseUrl || body.base_url || body.baseUrl,
      externalUrl: body.externalUrl,
      internalUrl: body.internalUrl,
      serverUsername: body.serverUsername || body.dispoUsername,
      serverPassword: body.serverPassword ?? body.dispoPassword,
      technician_id: technicianId,
    };
    if (typeVal) partial.kraftaufnehmer = typeVal;
    if (snVal) partial.dms_nr = snVal;
    if (dwcVal) partial.elektronik = dwcVal;
    if (posVal) partial.position = posVal;
    if (qmaxVal) partial.leistung = qmaxVal;
    if (vmaxVal) partial.nenngeschwindigkeit = vmaxVal;
    if (plantTypeVal) partial.type = plantTypeVal;
    if (projektVal) partial.projekt = projektVal;
    const dmsPosVal = String(
      kopf.dms_position || mess.waegezelle_position || body.dms_position || '',
    ).trim();
    const versVal = String(
      kopf.vers_spannung || mess.vers_spannung || body.vers_spannung || '',
    ).trim();
    const sensVal = String(
      kopf.sensitivitaet || mess.sensitivitaet || body.sensitivitaet || '',
    ).trim();
    const kaExtraVal =
      kopf.kraftaufnehmer_extra != null && kopf.kraftaufnehmer_extra !== ''
        ? kopf.kraftaufnehmer_extra
        : body.kraftaufnehmer_extra != null && body.kraftaufnehmer_extra !== ''
          ? body.kraftaufnehmer_extra
          : encodeKaExtraFromMess(mess);
    if (dmsPosVal) partial.dms_position = dmsPosVal;
    if (versVal) partial.vers_spannung = versVal;
    if (sensVal) partial.sensitivitaet = sensVal;
    if (kaExtraVal !== '' && kaExtraVal != null) partial.kraftaufnehmer_extra = kaExtraVal;
    return performAnlagenstammSave(partial, technicianId);
  }

  function isEmptyServiceprotokollStore(store) {
    const byFab = store && store.byFab;
    if (!byFab || typeof byFab !== 'object') return true;
    return Object.keys(byFab).length === 0;
  }

  function mergeServiceprotokollDraftStores(base, incoming) {
    const out = { byFab: {} };
    [base, incoming].forEach((store) => {
      const byFab = store && store.byFab && typeof store.byFab === 'object' ? store.byFab : {};
      Object.keys(byFab).forEach((fab) => {
        const draft = byFab[fab];
        if (!draft || typeof draft !== 'object') return;
        const key = String(fab).trim();
        if (!key) return;
        const norm = normalizeServiceprotokollDraft(draft);
        const prev = out.byFab[key];
        if (!prev) {
          out.byFab[key] = norm;
          return;
        }
        const tNew = Date.parse(norm.updatedAt || '') || 0;
        const tOld = Date.parse(prev.updatedAt || '') || 0;
        if (tNew >= tOld) {
          // Neuerer Draft gewinnt, aber schwächeres/leeres abschluss nicht über stärkeres legen
          const merged = Object.assign({}, norm);
          if (abschlussStatusRank(prev.abschluss) > abschlussStatusRank(norm.abschluss)) {
            merged.abschluss = normalizeServiceprotokollAbschluss(prev.abschluss);
          }
          out.byFab[key] = merged;
        } else if (abschlussStatusRank(norm.abschluss) > abschlussStatusRank(prev.abschluss)) {
          out.byFab[key] = Object.assign({}, prev, {
            abschluss: normalizeServiceprotokollAbschluss(norm.abschluss),
          });
        }
      });
    });
    return out;
  }

  async function fetchServiceprotokollDraftFromDispo(dispoBaseUrl, serverJobId, technicianId, authHeader, spec) {
    const s = serviceLikeSpecFromArg(spec);
    const base = String(dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!base || !serverJobId || !technicianId) return { store: { byFab: {} }, revision: 0 };
    const url = base + '/dispo_api/api/' + s.draftPhp + '?job_id=' + encodeURIComponent(serverJobId) +
      '&technician_id=' + encodeURIComponent(technicianId);
    try {
      const r = await fetchWithTimeout(url, { headers: { 'X-Technician-Id': String(technicianId), ...(authHeader || {}) } });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok && data.store && data.store.byFab) {
        return {
          store: data.store,
          revision: parseInt(data.revision, 10) || 0,
          server_updated_at: data.server_updated_at || null,
        };
      }
    } catch (_) { /* optional */ }
    return { store: { byFab: {} }, revision: 0 };
  }

  async function syncServiceprotokollStoreWithDispo(reiseDir, technicianId, serverJobId, dispoBaseUrl, authHeader, localJobId, spec) {
    const s = serviceLikeSpecFromArg(spec);
    const base = String(dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!base || !serverJobId || !technicianId) {
      return readServiceprotokollStore(reiseDir, localJobId, s);
    }
    const persist = (store, revision, serverUpdatedAt) => {
      const normalized = normalizeServiceprotokollStore(store);
      if (localJobId) {
        protocolDrafts.writeDraft(
          db,
          localJobId,
          s.basename,
          normalized,
          revision,
          serverUpdatedAt,
          reiseDir,
        );
        return;
      }
      const localPath = serviceprotokollJsonPath(reiseDir, s);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      writeFileWithRetry(
        localPath,
        JSON.stringify(
          Object.assign({}, normalized, {
            schema_version: 1,
            revision: revision || 0,
            server_updated_at: serverUpdatedAt || new Date().toISOString(),
          }),
          null,
          2,
        ),
      );
    };
    const localMeta = localJobId
      ? protocolDrafts.readDraft(db, localJobId, s.basename, reiseDir)
      : readLocalDraftFile(serviceprotokollJsonPath(reiseDir, s));
    const localRevision = parseInt(localMeta.revision, 10) || 0;
    const local = normalizeServiceprotokollStore(localMeta.payload || readServiceprotokollStore(reiseDir, localJobId, s));
    const remoteMeta = await fetchServiceprotokollDraftFromDispo(base, serverJobId, technicianId, authHeader, s);
    const remote = remoteMeta.store || { byFab: {} };
    const merged = mergeServiceprotokollDraftStores(local, remote);
    if (isEmptyServiceprotokollStore(merged) && isEmptyServiceprotokollStore(remote)) {
      persist(merged, remoteMeta.revision || 0, remoteMeta.server_updated_at || null);
      return merged;
    }
    const localJson = JSON.stringify(local);
    const remoteJson = JSON.stringify(remote);
    const mergedJson = JSON.stringify(merged);
    if (mergedJson !== localJson && !(isEmptyServiceprotokollStore(merged) && isEmptyServiceprotokollStore(local))) {
      persist(merged, remoteMeta.revision || localRevision, remoteMeta.server_updated_at || new Date().toISOString());
    }
    if (mergedJson !== remoteJson && !(isEmptyServiceprotokollStore(merged) && isEmptyServiceprotokollStore(remote))) {
      try {
        const postUrl = base + '/dispo_api/api/' + s.draftPhp;
        const deviceId =
          multiDeviceApi && multiDeviceApi.deviceId ? multiDeviceApi.deviceId() : undefined;
        const postRes = await fetchWithTimeout(postUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Technician-Id': String(technicianId),
            ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
            ...(authHeader || {}),
          },
          body: JSON.stringify({
            technician_id: technicianId,
            job_id: serverJobId,
            store: merged,
            base_revision: remoteMeta.revision || localRevision,
            device_id: deviceId,
          }),
        });
        const postData = await postRes.json().catch(() => ({}));
        if (postRes.status === 409 && postData.code === 'job_closed') {
          return merged;
        }
        if (postRes.status === 409 && postData.code === 'conflict' && multiDeviceApi) {
          try {
            const { writeConflictCopy } = require('./lib/multi-device-sync');
            writeConflictCopy(serviceprotokollJsonPath(reiseDir, s), deviceId);
          } catch (_) {}
          if (postData.store) {
            persist(postData.store, postData.revision || 0, postData.server_updated_at || null);
            return postData.store;
          }
        } else if (postRes.ok && postData.ok && postData.revision != null) {
          persist(postData.store || merged, postData.revision, postData.server_updated_at || null);
        }
      } catch (_) { /* optional */ }
    }
    return merged;
  }

  function resolveMonteurProtokollePdfTargetSync(reiseDir, localJobId, fab, technicianId) {
    const docMonteurBase = path.join(reiseDir, 'Dokumente_Monteur');
    const docAnlageBase = path.join(reiseDir, 'Dokumente_Anlage');
    const offlineCfg = getOfflinePullConfig(db, localJobId);
    const montageFolderName = resolveMonteurAuftragsordnerName(localJobId, technicianId);
    let folderName = null;
    const fromMap = (offlineCfg.fab_map || []).find((e) => String(e.fab) === String(fab));
    if (fromMap && fromMap.folder_name_canonical) folderName = fromMap.folder_name_canonical;
    if (!folderName) {
      const fnNum = parseInt(String(fab).trim(), 10);
      folderName =
        (Number.isFinite(fnNum) ? findMonteurFolderForFab(docMonteurBase, fnNum) : null) ||
        (Number.isFinite(fnNum) ? findParameterlistenFolder(docAnlageBase, fnNum) : null) ||
        sanitizeDienstreiseFolderPart(fab);
    }
    const targetDir = buildMonteurWorkAbsDir(docMonteurBase, folderName, montageFolderName, 'Protokolle');
    const relDir = buildMonteurWorkRelPath(folderName, montageFolderName, 'Protokolle');
    return { targetDir, relDir, folderName, montageFolderName };
  }

  async function resolveMonteurProtokollePdfTarget(reiseDir, localJobId, fab, technicianId) {
    if (reiseDir && fs.existsSync(reiseDir) && localJobId) {
      await ensureJobReiseFolderLayout(localJobId, reiseDir, technicianId);
    }
    return resolveMonteurProtokollePdfTargetSync(reiseDir, localJobId, fab, technicianId);
  }

  /** @deprecated Alias – Service-PDFs liegen unter …/Protokolle/ */
  function resolveServiceprotokollLocalPdfTarget(reiseDir, localJobId, fab, technicianId) {
    return resolveMonteurProtokollePdfTarget(reiseDir, localJobId, fab, technicianId);
  }

  function enrichKontrollwiegungPdfPayload(payload, localJobId, technicianId) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (Number.isFinite(localJobId) && localJobId > 0) {
      try {
        const jobMeta = db
          .prepare(
            `SELECT c.name AS customer_name, j.job_number
             FROM jobs j
             LEFT JOIN customers c ON c.id = j.customer_id
             WHERE j.id = ?`,
          )
          .get(localJobId);
        if (jobMeta) {
          const kunde = String(jobMeta.customer_name || '').trim();
          if (kunde) {
            p.kunde = kunde;
            p.customer_name = kunde;
          }
          if (jobMeta.job_number != null && String(jobMeta.job_number).trim() !== '') {
            p.job_number = String(jobMeta.job_number);
          }
        }
      } catch (_) { /* optional */ }
    }
    const techName = getTechnicianDisplayName(technicianId);
    if (techName) {
      p.monteur_name = techName;
      p.technician_name = techName;
    }
    if (!p.gespeichert_am && p.updated_at) p.gespeichert_am = p.updated_at;
    if (!p.gespeichert_am) p.gespeichert_am = new Date().toISOString();
    return p;
  }

  function parseProtocolLanguages(body) {
    const languages = [];
    const pushLang = (v) => {
      const l = String(v || '').toLowerCase().slice(0, 2);
      if ((l === 'de' || l === 'en') && !languages.includes(l)) languages.push(l);
    };
    const raw = Array.isArray(body && body.languages) && body.languages.length
      ? body.languages
      : (Array.isArray(body && body.pdf_languages) ? body.pdf_languages : null);
    if (raw && raw.length) raw.forEach(pushLang);
    else if (body && body.language) pushLang(body.language);
    if (!languages.length) languages.push('de');
    return languages;
  }

  function parseProtocolLanguagesMaybe(body) {
    const has =
      (Array.isArray(body && body.languages) && body.languages.length) ||
      (Array.isArray(body && body.pdf_languages) && body.pdf_languages.length) ||
      (body && body.language != null && String(body.language).trim() !== '');
    if (!has) return null;
    return parseProtocolLanguages(body);
  }

  function protocolPdfLangSuffix(lang, langs) {
    const list = Array.isArray(langs) && langs.length ? langs : [lang || 'de'];
    const multi = list.length > 1;
    if (multi) return '_' + String(lang || 'de').toUpperCase();
    return String(lang || '').toLowerCase() === 'en' ? '_EN' : '';
  }

  function protocolPdfClientFields(savedPdfs) {
    const list = Array.isArray(savedPdfs) ? savedPdfs : [];
    return {
      saved_pdfs: list,
      saved_pdf: (list[0] && list[0].rel) || null,
      pdf_path: (list[0] && list[0].path) || undefined,
      pdf_paths: list.map((p) => p && p.path).filter(Boolean),
    };
  }

  function resolveKontrollwiegungLocalPdfPaths(reiseDir, localJobId, fab, technicianId, datum, lang, langs) {
    const safeFn = String(fab || '').replace(/[^\w.-]+/g, '_');
    const d = String(datum || '').replace(/-/g, '');
    const suffix = protocolPdfLangSuffix(lang || 'de', langs);
    const name = 'Kontrollwiegungsprotokoll_' + safeFn + '_' + d + suffix + '.pdf';
    if (Number.isFinite(localJobId) && localJobId > 0 && fab) {
      try {
        const { targetDir, relDir } = resolveMonteurProtokollePdfTargetSync(
          reiseDir,
          localJobId,
          fab,
          technicianId,
        );
        return {
          full: path.join(targetDir, name),
          rel: relDir + '/' + name,
          name,
          targetDir,
          relDir,
        };
      } catch (_) { /* Fallback flach */ }
    }
    return {
      full: path.join(reiseDir, 'Dokumente_Monteur', name),
      rel: 'Dokumente_Monteur/' + name,
      name,
      targetDir: path.join(reiseDir, 'Dokumente_Monteur'),
      relDir: 'Dokumente_Monteur',
    };
  }

  /** Dispo liefert protokolle[] (neu) oder nur protokoll_ids + fabrikationsnummern (Legacy-Sammel-PDF). */
  function resolveServiceprotokollAllPdfSavedItems(saveData, requestProtokolle) {
    const fromServer = Array.isArray(saveData && saveData.protokolle) ? saveData.protokolle : [];
    const withIds = fromServer.filter(
      (item) => item && item.protokoll_id != null && String(item.fabrikationsnummer || '').trim() !== '',
    );
    if (withIds.length) return withIds;

    const ids = Array.isArray(saveData && saveData.protokoll_ids) ? saveData.protokoll_ids : [];
    if (!ids.length) return [];

    const req = Array.isArray(requestProtokolle) ? requestProtokolle : [];
    const serverFabs = Array.isArray(saveData && saveData.fabrikationsnummern) ? saveData.fabrikationsnummern : [];
    return ids
      .map((id, idx) => {
        const fabFromServer = serverFabs[idx] != null ? String(serverFabs[idx]).trim() : '';
        const fabFromReq =
          req[idx] && req[idx].fabrikationsnummer != null ? String(req[idx].fabrikationsnummer).trim() : '';
        const fab = fabFromServer || fabFromReq;
        return fab ? { protokoll_id: id, fabrikationsnummer: fab } : null;
      })
      .filter(Boolean);
  }

  async function writeServiceprotokollPdfsLocally(reiseDir, localJobId, fab, technicianId, draftPayload, pdfLangs, spec) {
    const s = serviceLikeSpecFromArg(spec);
    const langs = pdfLangs && pdfLangs.length ? pdfLangs : ['de'];
    const multiLang = langs.length > 1;
    const datum = String(draftPayload.durchfuehrungsdatum || '').replace(/-/g, '');
    const safeFn = String(fab).replace(/[^\w.-]+/g, '_');
    const { targetDir, relDir } = resolveServiceprotokollLocalPdfTarget(reiseDir, localJobId, fab, technicianId);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const enriched = Object.assign({}, draftPayload, {
      fabrikationsnummer: draftPayload.fabrikationsnummer || fab,
    });
    enrichKontrollwiegungPdfPayload(enriched, localJobId, technicianId);
    if (enriched.abschluss && enriched.abschluss.monteur_name) {
      enriched.monteur_name = enriched.abschluss.monteur_name;
    }
    const sigPng = await resolveTechnicianSignaturePng(technicianId, draftPayload);
    if (!sigPng) {
      const err = new Error(
        'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
      );
      err.code = 'missing_technician_signature';
      throw err;
    }
    enriched.technician_signature_png = sigPng;
    const savedRel = [];
    const savedAbs = [];
    let localWarning = null;
    for (const lang of langs) {
      try {
        const pdfBuf = await protocolPdf.generateServiceprotokollPdfBuffer(enriched, {
          lang,
          titleDe: s.titleDe,
          titleEn: s.titleEn,
        });
        const suffix = multiLang ? '_' + lang.toUpperCase() : lang === 'en' ? '_EN' : '';
        const pdfName = s.pdfPrefix + '_' + safeFn + '_' + datum + suffix + '.pdf';
        const fullPath = path.join(targetDir, pdfName);
        writeFileWithRetry(fullPath, pdfBuf);
        savedRel.push(relDir + '/' + pdfName);
        savedAbs.push(fullPath);
        protectPathIfUnderDokumenteMonteur(db, localJobId, relDir + '/' + pdfName);
      } catch (localErr) {
        localWarning =
          (localWarning ? localWarning + ' ' : '') + 'PDF ' + lang.toUpperCase() + ': ' + localErr.message;
      }
    }
    return { savedRel, savedAbs, localWarning };
  }

  function archivProtocolJsonKindFromName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/')).toLowerCase();
    if (base === 'serviceprotokoll.json') return 'serviceprotokoll';
    if (base === 'inbetriebnahmeprotokoll.json') return 'inbetriebnahme';
    if (base === 'montagebericht.json') return 'montagebericht';
    if (base === 'kontrollwiegungsprotokoll.json') return 'kontrollwiegung';
    if (base === 'schleppkettenprotokoll.json') return 'schleppketten';
    if (base === 'pruefzertifikat.json') return 'pruefzertifikat';
    return null;
  }

  function unwrapByFabStore(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { byFab: {} };
    let data = raw;
    if (!data.byFab && data.payload && typeof data.payload === 'object' && data.payload.byFab) {
      data = data.payload;
    }
    if (data.byFab && typeof data.byFab === 'object' && !Array.isArray(data.byFab)) {
      return Object.assign({}, data, { byFab: data.byFab });
    }
    const fab = String(data.fabrikationsnummer || '').trim();
    if (fab) return { byFab: { [fab]: data } };
    return { byFab: {} };
  }

  function formatArchivDateOnly(str) {
    const s = String(str || '').trim().slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s;
    return m[3] + '.' + m[2] + '.' + m[1];
  }

  function formatArchivDateRange(start, end) {
    const s = String(start || '').trim().slice(0, 10);
    const e = String(end || '').trim().slice(0, 10);
    if (!s) return formatArchivDateOnly(e);
    if (!e || s === e) return formatArchivDateOnly(s);
    return formatArchivDateOnly(s) + ' – ' + formatArchivDateOnly(e);
  }

  function archivToFab(f) {
    if (f == null) return '';
    if (typeof f === 'string') return f.trim();
    return String(f.fabrikationsnummer ?? f.Fabrikationsnummer ?? '').trim();
  }

  function buildArchivMontageberichtTableRows(dbFabRows, fabBemerkungen) {
    const toTextbausteine = (bem) =>
      (bem || '')
        .toString()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((t) => ({ text: t, html: t }));
    const isRichFabHtml = (html) => {
      const h = (html || '').toString();
      if (!h.trim()) return false;
      if (/<img\b/i.test(h) || /<table\b/i.test(h)) return true;
      return h.length > 80 && /<(p|div|br|h[1-6]|ul|ol)\b/i.test(h);
    };
    const toTextbausteineFromRich = (html, plain) => {
      const rawHtml = (html || '').toString();
      if (rawHtml.trim()) {
        if (isRichFabHtml(rawHtml)) {
          const text = rawHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
          return [{ text: text || String(plain || '').trim(), html: rawHtml.trim() }];
        }
        const parts = rawHtml
          .split(/<br\s*\/?>/i)
          .map((chunk) => {
            const htmlPart = String(chunk || '').trim();
            const text = htmlPart
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            return { text, html: htmlPart };
          })
          .filter((x) => x.text || x.html);
        if (parts.length) return parts;
        const textFallback = rawHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(div|p|li)>/gi, '\n')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/\s+\n/g, '\n')
          .replace(/\n\s+/g, '\n')
          .trim();
        if (textFallback) {
          return [{ text: textFallback.replace(/^\s*[•▪◦●\-]\s*/, '').trim(), html: rawHtml.trim() }];
        }
      }
      return toTextbausteine(plain || '');
    };
    const bemerkungenByFn = {};
    const bemerkungenHtmlByFn = {};
    const typePosByFn = {};
    for (const fb of fabBemerkungen || []) {
      const fn = archivToFab(fb);
      if (!fn) continue;
      typePosByFn[fn] = {
        type: fb && fb.type != null ? String(fb.type).trim() : '',
        position: fb && fb.position != null ? String(fb.position).trim() : '',
      };
      const fbHtml = fb && fb.bemerkungen_html != null ? String(fb.bemerkungen_html) : '';
      if (fbHtml.trim()) bemerkungenHtmlByFn[fn] = fbHtml;
      const explicitTb =
        Array.isArray(fb.textbausteine) && fb.textbausteine.length > 0
          ? fb.textbausteine
              .map((t) => ({
                text: String(t && t.text != null ? t.text : '').trim(),
                html: String(t && t.html != null ? t.html : t && t.text != null ? t.text : '').trim(),
              }))
              .filter((t) => t.text || t.html)
          : null;
      const explicitHasImg = !!(explicitTb && explicitTb.some((t) => /<img\b/i.test(t.html || '')));
      const tb =
        isRichFabHtml(fbHtml) && (!explicitTb || !explicitHasImg)
          ? toTextbausteineFromRich(fbHtml, fb && fb.bemerkungen)
          : explicitTb && explicitTb.length > 0
            ? explicitTb
            : toTextbausteineFromRich(fbHtml, fb && fb.bemerkungen);
      bemerkungenByFn[fn] = tb;
    }
    return (dbFabRows || []).map((row) => {
      const fn = (row.fabrikationsnummer || '').toString().trim();
      const fromForm = typePosByFn[fn];
      const type =
        fromForm != null
          ? String(fromForm.type != null ? fromForm.type : '').trim()
          : (row.type || '').toString().trim();
      const position =
        fromForm != null
          ? String(fromForm.position != null ? fromForm.position : '').trim()
          : (row.position || '').toString().trim();
      const userTb = bemerkungenByFn[fn];
      const tb =
        userTb && userTb.length > 0
          ? userTb
          : Array.isArray(row.textbausteine)
            ? row.textbausteine
                .map((t) => ({
                  text: String(t && t.text != null ? t.text : '').trim(),
                  html: String(t && t.html != null ? t.html : t && t.text != null ? t.text : '').trim(),
                }))
                .filter((t) => t.text || t.html)
            : [];
      const bemerk = tb.map((x) => x.text).join('\n');
      const bemerkHtml =
        bemerkungenHtmlByFn[fn] || (tb.length === 1 && tb[0].html ? tb[0].html : '') || '';
      return {
        fabrikationsnummer: fn,
        type,
        position,
        textbausteine: tb,
        bemerkungen: bemerk,
        bemerkungen_html: bemerkHtml,
      };
    });
  }

  async function writeArchivMontageberichtPdfs(reiseDir, localJobId, technicianId, draftPayload) {
    const draft = stripDraftMeta(draftPayload || {});
    const kopfFromDraft = draft.kopfdaten && typeof draft.kopfdaten === 'object' ? draft.kopfdaten : {};
    const projekt = String(draft.projekt || kopfFromDraft.projekt || '').trim();
    if (!projekt) {
      throw new Error('Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm / manuell).');
    }
    const jobRow = db
      .prepare(
        `SELECT j.id, j.start_datetime, j.end_datetime, j.job_number, j.fabrikationsnummern,
                c.name AS customer_name, ja.city, ja.country
         FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
         LEFT JOIN job_addresses ja ON ja.job_id = j.id
         WHERE j.id = ?`,
      )
      .get(localJobId);
    if (!jobRow) throw new Error('Auftrag nicht gefunden.');
    let dbFabRows = sortJobFabRows(
      parseJobFabrikationsnummernRows(jobRow.fabrikationsnummern).map((r) => ({
        fabrikationsnummer: archivToFab(r),
        type: r && (r.type != null ? r.type : r.Type) != null ? String(r.type ?? r.Type).trim() : '',
        position:
          r && (r.position != null ? r.position : r.Position) != null
            ? String(r.position ?? r.Position).trim()
            : '',
        geliefert_ueber: r && r.geliefert_ueber != null ? String(r.geliefert_ueber).trim() : '',
      })),
    ).filter((r) => r.fabrikationsnummer);
    const fabBemerkungen = Array.isArray(draft.fabBemerkungen) ? draft.fabBemerkungen : [];
    if (!dbFabRows.length) {
      dbFabRows = fabBemerkungen
        .map((fb) => ({
          fabrikationsnummer: archivToFab(fb),
          type: fb && fb.type != null ? String(fb.type).trim() : '',
          position: fb && fb.position != null ? String(fb.position).trim() : '',
        }))
        .filter((r) => r.fabrikationsnummer);
    }
    if (!dbFabRows.length && Array.isArray(kopfFromDraft.fabrikationsnummern)) {
      dbFabRows = kopfFromDraft.fabrikationsnummern
        .map((f) => ({
          fabrikationsnummer: archivToFab(f),
          type: f && typeof f === 'object' && f.type != null ? String(f.type).trim() : '',
          position: f && typeof f === 'object' && f.position != null ? String(f.position).trim() : '',
        }))
        .filter((r) => r.fabrikationsnummer);
    }
    if (!dbFabRows.length) {
      throw new Error('Mindestens eine Fabrikationsnummer erforderlich.');
    }
    const tableRows = buildArchivMontageberichtTableRows(dbFabRows, fabBemerkungen);
    const fabs = tableRows.map((r) => r.fabrikationsnummer).filter(Boolean);
    const languages = parseProtocolLanguages(draft);
    const kopfdatenForDocx = {
      kunde: String(kopfFromDraft.kunde || jobRow.customer_name || '').trim(),
      projekt,
      datum: String(
        kopfFromDraft.datum || formatArchivDateRange(jobRow.start_datetime, jobRow.end_datetime),
      ).trim(),
      servicetechniker: String(
        kopfFromDraft.servicetechniker || getTechnicianDisplayName(technicianId) || '',
      ).trim(),
      ansprechperson: String(kopfFromDraft.ansprechperson || '').trim(),
      geliefertUeber: String(
        kopfFromDraft.geliefertUeber ||
          (dbFabRows[0] && dbFabRows[0].geliefert_ueber) ||
          '',
      ).trim(),
      bemerkungen: String(draft.bemerkungen || kopfFromDraft.bemerkungen || '').trim(),
      bemerkungen_html: String(draft.bemerkungen_html || kopfFromDraft.bemerkungen_html || '').trim(),
    };
    if (!kopfdatenForDocx.ansprechperson) {
      try {
        const contacts = db
          .prepare(`${JOB_CONTACTS_SELECT_SQL} WHERE job_id = ? ORDER BY sort_order, id`)
          .all(localJobId);
        const parts = [];
        contacts.forEach((c) => {
          const n = normalizeJobContactPayload(c);
          if (!jobContactHasAny(n)) return;
          const name =
            (n.contact_name && String(n.contact_name).trim()) ||
            `${n.first_name || ''} ${n.last_name || ''}`.trim();
          if (name) parts.push(name);
        });
        kopfdatenForDocx.ansprechperson = parts.join('\n');
      } catch (_) {
        kopfdatenForDocx.ansprechperson = '';
      }
    }
    const sigPng = await resolveTechnicianSignaturePng(technicianId, draft);
    if (!sigPng) {
      const err = new Error(
        'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
      );
      err.code = 'missing_technician_signature';
      throw err;
    }
    const docMonteurBase = path.join(reiseDir, 'Dokumente_Monteur');
    const docAnlageBase = path.join(reiseDir, 'Dokumente_Anlage');
    const offlineCfgMb = getOfflinePullConfig(db, localJobId);
    await ensureJobReiseFolderLayout(localJobId, reiseDir, technicianId);
    const montageFolderNameMb = resolveMonteurAuftragsordnerName(localJobId, technicianId);
    const targetFolderNames = new Set();
    for (const fab of fabs) {
      let folderName = null;
      const fromMap = (offlineCfgMb.fab_map || []).find((e) => String(e.fab) === String(fab));
      if (fromMap && fromMap.folder_name_canonical) folderName = fromMap.folder_name_canonical;
      if (!folderName) {
        const fnNum = parseInt(String(fab).trim(), 10);
        folderName =
          (Number.isFinite(fnNum) ? findMonteurFolderForFab(docMonteurBase, fnNum) : null) ||
          (Number.isFinite(fnNum) ? findParameterlistenFolder(docAnlageBase, fnNum) : null) ||
          sanitizeDienstreiseFolderPart(fab);
      }
      targetFolderNames.add(folderName);
    }
    const fileBase = sanitizeExportFileBase(String(path.basename(reiseDir) || '').replace(/^\d+_/, ''));
    const fileStemForLang = (lang) => (lang === 'en' ? `${fileBase}_report_GB` : `${fileBase}_Montage_DE`);
    const savedRel = [];
    const savedAbs = [];
    for (const lang of languages) {
      const pdfBytes = await protocolPdf.generateMontageberichtPdfBuffer(
        {
          kopfdaten: kopfdatenForDocx,
          tableRows,
          grundDesEinsatzes: String(draft.grundDesEinsatzes || ''),
          grundDesEinsatzes_html: String(draft.grundDesEinsatzes_html || ''),
          freitext: String(draft.freitext || ''),
          technician_signature_png: sigPng,
        },
        { lang },
      );
      if (!pdfBytes || !pdfBytes.length) {
        throw new Error(`PDF konnte nicht erzeugt werden (${lang === 'en' ? 'Englisch' : 'Deutsch'}).`);
      }
      const pdfFilename = `${fileStemForLang(lang)}.pdf`;
      for (const folderName of targetFolderNames) {
        const protokolleDir = buildMonteurWorkAbsDir(
          docMonteurBase,
          folderName,
          montageFolderNameMb,
          'Protokolle',
        );
        if (!fs.existsSync(protokolleDir)) fs.mkdirSync(protokolleDir, { recursive: true });
        const absPdf = path.join(protokolleDir, pdfFilename);
        writeFileWithRetry(absPdf, pdfBytes);
        if (!savedAbs.includes(absPdf)) savedAbs.push(absPdf);
        const rel = buildMonteurWorkRelPath(folderName, montageFolderNameMb, 'Protokolle/' + pdfFilename);
        protectPathIfUnderDokumenteMonteur(db, localJobId, rel);
        if (!savedRel.includes(rel)) savedRel.push(rel);
      }
    }
    return { savedRel, savedAbs };
  }

  async function generateArchivProtocolPdfsFromJson(opts) {
    const reiseDir = opts.reiseDir;
    const localJobId = opts.localJobId;
    const technicianId = opts.technicianId;
    const jsonAbsPath = opts.jsonAbsPath;
    const kind = opts.kind;
    const payload = opts.payload
      || (jsonAbsPath ? (readLocalDraftFile(jsonAbsPath).payload || {}) : {});
    const savedRel = [];
    const savedAbs = [];
    const warnings = [];

    if (kind === 'montagebericht') {
      const result = await writeArchivMontageberichtPdfs(reiseDir, localJobId, technicianId, payload);
      return {
        savedRel: result.savedRel || [],
        savedAbs: result.savedAbs || [],
        warning: undefined,
      };
    }

    const store = unwrapByFabStore(payload);
    const fabs = Object.keys(store.byFab || {}).filter((fn) => String(fn || '').trim());
    if (!fabs.length) {
      throw new Error('Die JSON-Datei enthält keine Protokolldaten je Fabrikationsnummer.');
    }

    for (const fab of fabs) {
      const rec = store.byFab[fab] || {};
      const recPayload = Object.assign({}, rec, { fabrikationsnummer: fab });
      try {
        if (kind === 'serviceprotokoll' || kind === 'inbetriebnahme') {
          const regenSpec = kind === 'inbetriebnahme' ? SERVICE_LIKE_PROTOCOL.inbetriebnahme : SERVICE_LIKE_PROTOCOL.serviceprotokoll;
          const draftPayload = {
            fabrikationsnummer: fab,
            durchfuehrungsdatum: String(recPayload.durchfuehrungsdatum || '').trim(),
            projekt: String(recPayload.projekt || '').trim(),
            arbeitsschritte: Array.isArray(recPayload.arbeitsschritte) ? recPayload.arbeitsschritte : [],
            messwerte: recPayload.messwerte && typeof recPayload.messwerte === 'object' ? recPayload.messwerte : {},
            bemerkungen: String(recPayload.bemerkungen || ''),
            kopf_pos_nr: String(recPayload.kopf_pos_nr || ''),
            kopf_qmax: String(recPayload.kopf_qmax || ''),
            kopf_vmax: String(recPayload.kopf_vmax || ''),
            kopf_type: String(recPayload.kopf_type || ''),
            kopf_dwc: String(recPayload.kopf_dwc || ''),
            abschluss: normalizeServiceprotokollAbschluss(recPayload.abschluss),
            motoren: pickProtocolMotors(recPayload),
          };
          if (!draftPayload.durchfuehrungsdatum) {
            warnings.push('FN ' + fab + ': Datum der Durchführung fehlt.');
            continue;
          }
          const steps = draftPayload.arbeitsschritte.filter((s) => {
            if (!s) return false;
            const de = String(s.bezeichnung_de != null ? s.bezeichnung_de : s.bezeichnung || '').trim();
            const en = String(s.bezeichnung_en || '').trim();
            return de !== '' || en !== '';
          });
          if (!steps.length) {
            warnings.push('FN ' + fab + ': mindestens ein Arbeitsschritt mit Bezeichnung erforderlich.');
            continue;
          }
          draftPayload.arbeitsschritte = steps;
          const pdfLangs = parseProtocolLanguages(recPayload);
          draftPayload.languages = pdfLangs;
          draftPayload.pdf_languages = pdfLangs;
          const localPdf = await writeServiceprotokollPdfsLocally(
            reiseDir,
            localJobId,
            fab,
            technicianId,
            Object.assign({}, draftPayload, {
              signature_override_png:
                recPayload.signature_override_png ||
                (recPayload.abschluss && recPayload.abschluss.signature_override_png) ||
                '',
            }),
            pdfLangs,
            regenSpec,
          );
          if (localPdf.savedRel) savedRel.push(...localPdf.savedRel);
          if (localPdf.savedAbs) savedAbs.push(...localPdf.savedAbs);
          if (localPdf.localWarning) warnings.push('FN ' + fab + ': ' + localPdf.localWarning);
          continue;
        }

        if (kind === 'kontrollwiegung') {
          const pdfLangs = parseProtocolLanguages(recPayload);
          const payloadKw = enrichKontrollwiegungPdfPayload(
            Object.assign({}, recPayload, { languages: pdfLangs, pdf_languages: pdfLangs }),
            localJobId,
            technicianId,
          );
          const sigPngKw = await resolveTechnicianSignaturePng(technicianId, recPayload);
          if (!sigPngKw) {
            const err = new Error(
              'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
            );
            err.code = 'missing_technician_signature';
            throw err;
          }
          payloadKw.technician_signature_png = sigPngKw;
          for (const lang of pdfLangs) {
            const pdfPaths = resolveKontrollwiegungLocalPdfPaths(
              reiseDir,
              localJobId,
              fab,
              technicianId,
              payloadKw.durchfuehrungsdatum,
              lang,
              pdfLangs,
            );
            const pdfDir = path.dirname(pdfPaths.full);
            if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
            const pdfBuf = await protocolPdf.generateKontrollwiegungPdfBuffer(payloadKw, { lang });
            writeFileWithRetry(pdfPaths.full, pdfBuf);
            savedRel.push(pdfPaths.rel);
            savedAbs.push(pdfPaths.full);
            protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
          }
          continue;
        }

        if (kind === 'schleppketten') {
          const pdfLangsSk = parseProtocolLanguages(recPayload);
          const payloadSk = enrichKontrollwiegungPdfPayload(
            Object.assign({}, recPayload, { languages: pdfLangsSk, pdf_languages: pdfLangsSk }),
            localJobId,
            technicianId,
          );
          payloadSk.messungen = schleppkettenLocal.enrichMessungen(payloadSk.messungen);
          if (payloadSk.kunde) payloadSk.customer_name = payloadSk.kunde;
          const sigPngSk = await resolveTechnicianSignaturePng(technicianId, recPayload);
          if (!sigPngSk) {
            const err = new Error(
              'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
            );
            err.code = 'missing_technician_signature';
            throw err;
          }
          payloadSk.technician_signature_png = sigPngSk;
          for (const lang of pdfLangsSk) {
            const pdfPaths = resolveSchleppkettenLocalPdfPaths(
              reiseDir,
              localJobId,
              fab,
              technicianId,
              payloadSk.durchfuehrungsdatum,
              lang,
              pdfLangsSk,
            );
            const pdfDir = path.dirname(pdfPaths.full);
            if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
            const pdfBuf = await protocolPdf.generateSchleppkettenPdfBuffer(payloadSk, { lang });
            writeFileWithRetry(pdfPaths.full, pdfBuf);
            savedRel.push(pdfPaths.rel);
            savedAbs.push(pdfPaths.full);
            protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
          }
          continue;
        }

        if (kind === 'pruefzertifikat') {
          const pdfLangsPz = parseProtocolLanguages(recPayload);
          const payloadPz = enrichKontrollwiegungPdfPayload(
            Object.assign({}, recPayload, {
              pruefdatum: recPayload.pruefdatum || recPayload.durchfuehrungsdatum,
              durchfuehrungsdatum: recPayload.pruefdatum || recPayload.durchfuehrungsdatum,
              languages: pdfLangsPz,
              pdf_languages: pdfLangsPz,
            }),
            localJobId,
            technicianId,
          );
          const sigPngPz = await resolveTechnicianSignaturePng(technicianId, recPayload);
          if (!sigPngPz) {
            const err = new Error(
              'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
            );
            err.code = 'missing_technician_signature';
            throw err;
          }
          payloadPz.technician_signature_png = sigPngPz;
          for (const lang of pdfLangsPz) {
            const pdfPaths = resolvePruefzertifikatLocalPdfPaths(
              reiseDir,
              localJobId,
              fab,
              technicianId,
              payloadPz.pruefdatum,
              lang,
            );
            const pdfDir = path.dirname(pdfPaths.full);
            if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
            const pdfBuf = await protocolPdf.generatePruefzertifikatPdfBuffer(payloadPz, { lang });
            writeFileWithRetry(pdfPaths.full, pdfBuf);
            savedRel.push(pdfPaths.rel);
            savedAbs.push(pdfPaths.full);
            protectPathIfUnderDokumenteMonteur(db, localJobId, pdfPaths.rel);
          }
        }
      } catch (fabErr) {
        if (fabErr && fabErr.code === 'missing_technician_signature') throw fabErr;
        warnings.push('FN ' + fab + ': ' + (fabErr && fabErr.message ? fabErr.message : String(fabErr)));
      }
    }

    if (!savedRel.length && !savedAbs.length) {
      const err = new Error(warnings.join('\n') || 'Keine PDFs konnten erstellt werden.');
      err.code = 'no_pdfs';
      throw err;
    }
    return {
      savedRel,
      savedAbs,
      warning: warnings.filter(Boolean).join('\n') || undefined,
    };
  }

  app.post('/api/archiv/protocol_json_pdf', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const jobIdRaw = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      if (!technicianId || !jobIdRaw) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const resolved = resolveLocalJobIdForTechnician(db, technicianId, jobIdRaw, { mode: 'auto' });
      if (!resolved || !resolved.ok) {
        return res.status((resolved && resolved.status) || 404).json({
          ok: false,
          error: (resolved && resolved.error) || 'Auftrag nicht gefunden.',
        });
      }
      const localJobId = resolved.localId;
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(404).json({ ok: false, error: 'Kein lokaler Projektordner mehr vorhanden.' });
      }
      const relIn = String(body.relative_path || body.relPath || body.rel || '').replace(/\\/g, '/').trim();
      const nameIn = String(body.name || '').trim();
      let jsonAbs = '';
      let dbPayload = null;
      let kind = null;
      const dbName = relIn.startsWith('db:')
        ? relIn.slice(3)
        : (nameIn && archivProtocolJsonKindFromName(nameIn) ? path.basename(nameIn) : '');
      if (dbName && archivProtocolJsonKindFromName(dbName)) {
        kind = archivProtocolJsonKindFromName(dbName);
        const meta = protocolDrafts.readDraft(db, localJobId, path.basename(dbName), reiseDir);
        if (meta && meta.payload && !isEmptyMonteurDraftPayload(meta.payload)) {
          dbPayload = meta.payload;
        }
      }
      if (!dbPayload) {
        if (relIn && !relIn.startsWith('db:')) {
          jsonAbs = kundenDokumentation.assertPathUnderReise(reiseDir, path.join(reiseDir, relIn));
        } else if (nameIn && archivProtocolJsonKindFromName(nameIn)) {
          jsonAbs = resolveMonteurDraftJsonPath(reiseDir, path.basename(nameIn), false);
        }
        if (jsonAbs && fs.existsSync(jsonAbs) && fs.statSync(jsonAbs).isFile()) {
          kind = archivProtocolJsonKindFromName(jsonAbs);
        }
      }
      if (!kind) {
        return res.status(400).json({
          ok: false,
          error: 'Nur Protokoll-JSON (Service, Montagebericht, Kontrollwiegung, Schleppketten, Prüfzertifikat).',
        });
      }
      if (!dbPayload && (!jsonAbs || !fs.existsSync(jsonAbs) || !fs.statSync(jsonAbs).isFile())) {
        return res.status(404).json({ ok: false, error: 'JSON-Zwischenstand nicht gefunden.' });
      }
      const result = await generateArchivProtocolPdfsFromJson({
        reiseDir,
        localJobId,
        technicianId,
        jsonAbsPath: jsonAbs,
        payload: dbPayload,
        kind,
      });
      try {
        save();
      } catch (_) {
        /* optional */
      }
      return res.json({
        ok: true,
        kind,
        saved: result.savedRel || [],
        pdf_paths: result.savedAbs || [],
        pdf_path: (result.savedAbs && result.savedAbs[0]) || null,
        warning: result.warning,
      });
    } catch (e) {
      if (e && e.code === 'missing_technician_signature') {
        return failMissingSignature(res);
      }
      const msg = e && e.message ? e.message : String(e);
      const status = e && e.code === 'no_pdfs' ? 400 : 500;
      console.warn('[archiv/protocol_json_pdf]', msg);
      return res.status(status).json({ ok: false, error: msg || 'PDF konnte nicht erstellt werden.' });
    }
  });

  async function downloadServiceprotokollPdfsFromDispo(
    dispoBaseUrl,
    protokollId,
    technicianId,
    auth,
    reiseDir,
    localJobId,
    fab,
    pdfLangs,
    durchfuehrungsdatum,
    spec,
  ) {
    const s = serviceLikeSpecFromArg(spec);
    const langs = pdfLangs && pdfLangs.length ? pdfLangs : ['de'];
    const multiLang = langs.length > 1;
    const datum = String(durchfuehrungsdatum || '').replace(/-/g, '');
    const safeFn = String(fab).replace(/[^\w.-]+/g, '_');
    const { targetDir, relDir } = resolveServiceprotokollLocalPdfTarget(reiseDir, localJobId, fab, technicianId);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const savedRel = [];
    let localWarning = null;
    for (const lang of langs) {
      try {
        const pdfUrl =
          dispoBaseUrl +
          '/dispo_api/api/' +
          s.pdfPhp +
          '?id=' +
          encodeURIComponent(protokollId) +
          '&technician_id=' +
          encodeURIComponent(technicianId) +
          '&lang=' +
          encodeURIComponent(lang);
        const pdfRes = await fetchWithTimeout(pdfUrl, {
          headers: { 'X-Technician-Id': String(technicianId), ...(auth || {}) },
        }, 15000);
        if (!pdfRes.ok) {
          localWarning = (localWarning ? localWarning + ' ' : '') + 'Dispo-PDF ' + lang.toUpperCase() + ' nicht geladen.';
          continue;
        }
        const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
        const suffix = multiLang ? '_' + lang.toUpperCase() : lang === 'en' ? '_EN' : '';
        const pdfName = s.pdfPrefix + '_' + safeFn + '_' + datum + suffix + '.pdf';
        const fullLocalPdf = path.join(targetDir, pdfName);
        if (keepExistingLocalPdf(fullLocalPdf)) {
          savedRel.push(relDir + '/' + pdfName);
          protectPathIfUnderDokumenteMonteur(db, localJobId, relDir + '/' + pdfName);
          continue;
        }
        writeFileWithRetry(fullLocalPdf, pdfBuf);
        savedRel.push(relDir + '/' + pdfName);
        protectPathIfUnderDokumenteMonteur(db, localJobId, relDir + '/' + pdfName);
      } catch (localErr) {
        localWarning = (localWarning ? localWarning + ' ' : '') + 'Dispo-PDF ' + lang.toUpperCase() + ': ' + localErr.message;
      }
    }
    return { savedRel, localWarning };
  }

  async function handleServiceLikeProtokollGet(req, res) {
    try {
      const spec = serviceLikeSpecFromReq(req);
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      const fab = (req.query.fabrikationsnummer || req.query.fab || '').toString().trim();
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const localOnly = wantsLocalOnlyRequest(req.query);
      const creds = resolveDispoServerCreds(req.query || {});
      const parsedServerJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : NaN;
      const hasServerJobId = Number.isFinite(parsedServerJobId) && parsedServerJobId > 0;
      let store = readServiceprotokollStore(reiseDir, localJobId, spec);
      if (!localOnly && creds.baseUrl && hasServerJobId) {
        const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
        try {
          store = await syncServiceprotokollStoreWithDispo(reiseDir, technicianId, parsedServerJobId, creds.baseUrl, auth, localJobId, spec);
        } catch (_) {
          /* lokaler Store bleibt */
        }
      }
      if (fab && store.byFab[fab]) {
        return res.json({ ok: true, data: store.byFab[fab], store });
      }
      res.json({ ok: true, data: fab ? null : store, store });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  }
  app.get('/api/protokolle/serviceprotokoll', handleServiceLikeProtokollGet);
  app.get('/api/protokolle/inbetriebnahme', handleServiceLikeProtokollGet);

  app.post('/api/protokolle/serviceprotokoll', express.json(), handleServiceLikeProtokollPost);
  app.post('/api/protokolle/inbetriebnahme', express.json(), handleServiceLikeProtokollPost);
  async function handleServiceLikeProtokollPost(req, res) {
    const spec = serviceLikeSpecFromReq(req);
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const fab = String(body.fabrikationsnummer || '').trim();
      const jsonOnly = body.jsonOnly === true || body.saveJsonOnly === true;

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      if (!fab) {
        return res.status(400).json({ ok: false, error: 'Fabrikationsnummer erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.server_id, j.status FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const projekt = String(body.projekt || '').trim();
      if (!projekt && !jsonOnly) {
        return res.status(400).json({ ok: false, error: 'Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm / manuell).' });
      }

      const draftPayload = {
        fabrikationsnummer: fab,
        durchfuehrungsdatum: String(body.durchfuehrungsdatum || '').trim(),
        projekt,
        arbeitsschritte: Array.isArray(body.arbeitsschritte) ? body.arbeitsschritte : [],
        messwerte: body.messwerte && typeof body.messwerte === 'object' ? body.messwerte : {},
        bemerkungen: String(body.bemerkungen || ''),
        kopf_pos_nr: String(body.kopf_pos_nr || ''),
        kopf_qmax: String(body.kopf_qmax || ''),
        kopf_vmax: String(body.kopf_vmax || ''),
        kopf_type: String(body.kopf_type || ''),
        kopf_dwc: String(body.kopf_dwc || ''),
        abschluss: normalizeServiceprotokollAbschluss(body.abschluss),
        motoren: pickProtocolMotors(body),
      };
      const langsMaybe = parseProtocolLanguagesMaybe(body);
      if (langsMaybe && langsMaybe.length) {
        draftPayload.languages = langsMaybe;
        draftPayload.pdf_languages = langsMaybe;
      }

      let messSyncWarning = null;
      const applyToAnlagenstamm = shouldApplyServiceprotokollToAnlagenstamm(body);
      if (applyToAnlagenstamm) {
        try {
          const messSync = await syncServiceprotokollMesswerteToAnlagenstammLocal(body, fab, draftPayload.messwerte, draftPayload.kopf_dwc, {
            kopf_pos_nr: draftPayload.kopf_pos_nr,
            kopf_qmax: draftPayload.kopf_qmax,
            kopf_vmax: draftPayload.kopf_vmax,
            kopf_type: draftPayload.kopf_type,
            kopf_dwc: draftPayload.kopf_dwc,
            projekt: draftPayload.projekt,
            dms_position: (draftPayload.messwerte && draftPayload.messwerte.waegezelle_position) || '',
            vers_spannung: (draftPayload.messwerte && draftPayload.messwerte.vers_spannung) || '',
            sensitivitaet: (draftPayload.messwerte && draftPayload.messwerte.sensitivitaet) || '',
            kraftaufnehmer_extra: encodeKaExtraFromMess(draftPayload.messwerte),
          });
          if (messSync && messSync.ok === false) {
            messSyncWarning = 'Anlagenstamm (technische Daten): ' + (messSync.error || 'lokal nicht gespeichert');
          }
          try {
            syncProtocolMotorsToStamm(db, fab, draftPayload.motoren || []);
          } catch (_) { /* optional */ }
        } catch (messErr) {
          messSyncWarning = 'Anlagenstamm (technische Daten): ' + (messErr.message || 'Speichern fehlgeschlagen');
        }
      }

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      writeServiceprotokollDraft(reiseDir, fab, draftPayload, localJobId, spec);

      let syncWarning = messSyncWarning;
      const parsedServerJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : NaN;
      const hasServerJobId = Number.isFinite(parsedServerJobId) && parsedServerJobId > 0;
      queueProtocolDraftAndFiles({
        localJobId,
        technicianId,
        serverJobId: parsedServerJobId,
        dispoBaseUrl,
        basename: spec.basename,
        reiseDir,
        filePath: serviceprotokollJsonPath(reiseDir, spec),
        username: body.dispoUsername || body.serverUsername,
        password: body.dispoPassword ?? body.serverPassword,
      });
      const skipDispoSync = wantsLocalOnlyRequest(body) || shouldDeferDispoSync({ hasBaseUrl: !!dispoBaseUrl, localOnly: body.local_only });
      if (!skipDispoSync && dispoBaseUrl && hasServerJobId) {
        const authSync = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.serverPassword ?? body.serverPassword);
        try {
          await syncServiceprotokollStoreWithDispo(reiseDir, technicianId, parsedServerJobId, dispoBaseUrl, authSync, localJobId, spec);
        } catch (_) {
          syncWarning = [syncWarning, 'Zwischenstand: Dispo-Sync fehlgeschlagen.'].filter(Boolean).join('\n');
        }
      }

      if (jsonOnly) {
        return res.json({ ok: true, jsonOnly: true, warning: syncWarning || undefined });
      }

      if (!draftPayload.durchfuehrungsdatum) {
        return res.status(400).json({ ok: false, error: 'Bitte Datum der Durchführung angeben.' });
      }
      const steps = (draftPayload.arbeitsschritte || []).filter((s) => {
        if (!s) return false;
        const de = String(s.bezeichnung_de != null ? s.bezeichnung_de : s.bezeichnung || '').trim();
        const en = String(s.bezeichnung_en || '').trim();
        return de !== '' || en !== '';
      });
      if (!steps.length) {
        return res.status(400).json({ ok: false, error: 'Mindestens ein Arbeitsschritt mit Bezeichnung erforderlich.' });
      }

      const pdfLangs =
        Array.isArray(body.pdf_languages) && body.pdf_languages.length
          ? body.pdf_languages.map((l) => String(l).toLowerCase()).filter((l) => l === 'de' || l === 'en')
          : ['de'];
      const savePayload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: hasServerJobId ? parsedServerJobId : localJobId,
        local_job_id: localJobId,
        fabrikationsnummer: fab,
        durchfuehrungsdatum: draftPayload.durchfuehrungsdatum,
        arbeitsschritte: steps,
        messwerte: draftPayload.messwerte,
        projekt,
        bemerkungen: draftPayload.bemerkungen,
        kopf_pos_nr: draftPayload.kopf_pos_nr,
        kopf_qmax: draftPayload.kopf_qmax,
        kopf_vmax: draftPayload.kopf_vmax,
        kopf_type: draftPayload.kopf_type,
        kopf_dwc: draftPayload.kopf_dwc,
        abschluss: draftPayload.abschluss || {},
        motoren: draftPayload.motoren || [],
        pdf_languages: pdfLangs,
        dispoBaseUrl,
        serverUsername: body.serverUsername || body.dispoUsername,
        serverPassword: body.serverPassword ?? body.dispoPassword,
      };

      const localPdf = await writeServiceprotokollPdfsLocally(
        reiseDir,
        localJobId,
        fab,
        technicianId,
        Object.assign({}, draftPayload, {
          arbeitsschritte: steps,
          dispoBaseUrl,
          base_url: dispoBaseUrl,
          serverUsername: body.serverUsername || body.dispoUsername,
          serverPassword: body.serverPassword ?? body.dispoPassword,
          signature_override_png: body.signature_override_png || '',
        }),
        pdfLangs,
        spec,
      );
      let savedRel = localPdf.savedRel || [];
      let savedAbs = localPdf.savedAbs || [];
      let localWarning = localPdf.localWarning;
      queueProtocolDraftAndFiles({
        localJobId,
        technicianId,
        serverJobId: parsedServerJobId,
        dispoBaseUrl,
        basename: spec.basename,
        reiseDir,
        filePath: serviceprotokollJsonPath(reiseDir, spec),
        username: body.serverUsername || body.dispoUsername,
        password: body.serverPassword ?? body.dispoPassword,
      });
      let protokollId = 'local:' + Date.now();
      let deferred = false;
      let saveData = {};

      const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
      if (!skipDispoSync && dispoBaseUrl && hasServerJobId) {
        try {
          const saveRes = await fetchWithTimeout(
            dispoBaseUrl + '/dispo_api/api/' + spec.savePhp,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
              body: JSON.stringify(savePayload),
            },
            10000,
          );
          saveData = await saveRes.json().catch(() => ({}));
          if (saveRes.ok && saveData.ok && saveData.protokoll_id) {
            protokollId = saveData.protokoll_id;
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = ? AND entity_id = ? AND action = 'save'`,
            ).run(spec.entityType, String(localJobId) + ':' + fab);
            // Wichtig: Dispo-PDF nur laden, wenn lokales Corporate-PDF fehlt.
            // downloadServiceprotokollPdfsFromDispo schreibt in dieselben Dateinamen und
            // würde sonst das lokale Layout (wie bei „Alle PDF“) mit dem Dispo-Template überschreiben.
            let dispoPdf = { savedRel: [], localWarning: null };
            if (!savedRel || !savedRel.length) {
              dispoPdf = await downloadServiceprotokollPdfsFromDispo(
                dispoBaseUrl,
                saveData.protokoll_id,
                technicianId,
                auth,
                reiseDir,
                localJobId,
                fab,
                pdfLangs,
                draftPayload.durchfuehrungsdatum,
                spec,
              );
            }
            if ((!savedRel || !savedRel.length) && dispoPdf.savedRel && dispoPdf.savedRel.length) {
              savedRel = dispoPdf.savedRel;
              localWarning = dispoPdf.localWarning;
            } else if (dispoPdf.localWarning) {
              localWarning = [localWarning, dispoPdf.localWarning].filter(Boolean).join(' ');
            }
          } else {
            deferred = true;
            queueDispoProxyPending(db, spec.entityType, localJobId + ':' + fab, 'save', savePayload);
            save();
            syncWarning = [syncWarning, saveData.error || 'Dispo-Speichern fehlgeschlagen – Sync-Queue.'].filter(Boolean).join('\n');
          }
        } catch (dispoErr) {
          deferred = true;
          queueDispoProxyPending(db, spec.entityType, localJobId + ':' + fab, 'save', savePayload);
          save();
          syncWarning = [syncWarning, 'Dispo nicht erreichbar – Sync-Queue.'].filter(Boolean).join('\n');
        }
      } else {
        deferred = true;
        queueDispoProxyPending(db, spec.entityType, localJobId + ':' + fab, 'save', savePayload);
        save();
      }

      const warning = [syncWarning, saveData.warning, localWarning].filter(Boolean).join('\n') || undefined;
      res.json({
        ok: true,
        jsonOnly: false,
        protokoll_id: protokollId,
        pdf_path: savedAbs[0] || saveData.pdf_path || null,
        pdf_paths: savedAbs.length ? savedAbs : (saveData.pdf_paths || []),
        saved: savedRel,
        deferred,
        warning,
      });
    } catch (e) {
      if (e && e.code === 'missing_technician_signature') {
        return failMissingSignature(res);
      }
      res.status(500).json({ ok: false, error: e.message || spec.saveError });
    }
  }

  app.post('/api/protokolle/serviceprotokoll/all-pdf', express.json(), handleServiceLikeProtokollAllPdf);
  app.post('/api/protokolle/inbetriebnahme/all-pdf', express.json(), handleServiceLikeProtokollAllPdf);
  async function handleServiceLikeProtokollAllPdf(req, res) {
    const spec = serviceLikeSpecFromReq(req);
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const protokolle = Array.isArray(body.protokolle) ? body.protokolle : [];
      const durchfuehrungsdatum = String(body.durchfuehrungsdatum || '').trim();

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      if (!protokolle.length) {
        return res.status(400).json({ ok: false, error: 'protokolle[] erforderlich.' });
      }
      if (!durchfuehrungsdatum) {
        return res.status(400).json({ ok: false, error: 'Bitte Datum der Durchführung angeben.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.server_id, j.status FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const pdfLangs =
        Array.isArray(body.pdf_languages) && body.pdf_languages.length
          ? body.pdf_languages.map((l) => String(l).toLowerCase()).filter((l) => l === 'de' || l === 'en')
          : ['de'];
      const parsedServerJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : NaN;
      const hasServerJobId = Number.isFinite(parsedServerJobId) && parsedServerJobId > 0;
      const skipDispoSync = wantsLocalOnlyRequest(body) || shouldDeferDispoSync({ hasBaseUrl: !!dispoBaseUrl, localOnly: body.local_only });

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      let messSyncWarning = null;
      let localWarning = null;
      const savedRel = [];
      const savedAbs = [];
      const localResults = [];
      const applyToAnlagenstamm = shouldApplyServiceprotokollToAnlagenstamm(body);

      for (const p of protokolle) {
        if (!p || typeof p !== 'object') continue;
        const fab = String(p.fabrikationsnummer || '').trim();
        if (!fab) continue;
        const steps = (Array.isArray(p.arbeitsschritte) ? p.arbeitsschritte : []).filter((s) => {
          if (!s) return false;
          const de = String(s.bezeichnung_de != null ? s.bezeichnung_de : s.bezeichnung || '').trim();
          const en = String(s.bezeichnung_en || '').trim();
          return de !== '' || en !== '';
        });
        if (!steps.length) {
          localWarning = [localWarning, 'FN ' + fab + ': mindestens ein Arbeitsschritt mit Bezeichnung erforderlich.'].filter(Boolean).join('\n');
          continue;
        }
        const draftPayload = {
          fabrikationsnummer: fab,
          durchfuehrungsdatum,
          projekt: String(p.projekt || '').trim(),
          arbeitsschritte: steps,
          messwerte: p.messwerte && typeof p.messwerte === 'object' ? p.messwerte : {},
          bemerkungen: String(p.bemerkungen || ''),
          kopf_pos_nr: String(p.kopf_pos_nr || ''),
          kopf_qmax: String(p.kopf_qmax || ''),
          kopf_vmax: String(p.kopf_vmax || ''),
          kopf_type: String(p.kopf_type || ''),
          kopf_dwc: String(p.kopf_dwc || ''),
          abschluss: normalizeServiceprotokollAbschluss(p.abschluss),
          languages: pdfLangs,
          pdf_languages: pdfLangs,
          motoren: pickProtocolMotors(p),
        };
        if (applyToAnlagenstamm) {
          try {
            const messSync = await syncServiceprotokollMesswerteToAnlagenstammLocal(body, fab, draftPayload.messwerte, draftPayload.kopf_dwc, {
              kopf_pos_nr: draftPayload.kopf_pos_nr,
              kopf_qmax: draftPayload.kopf_qmax,
              kopf_vmax: draftPayload.kopf_vmax,
              kopf_type: draftPayload.kopf_type,
              kopf_dwc: draftPayload.kopf_dwc,
              projekt: draftPayload.projekt,
            });
            if (messSync && messSync.ok === false) {
              messSyncWarning = [messSyncWarning, 'FN ' + fab + ': Anlagenstamm (technische Daten) lokal nicht gespeichert'].filter(Boolean).join('\n');
            }
            try {
              syncProtocolMotorsToStamm(db, fab, draftPayload.motoren || []);
            } catch (_) { /* optional */ }
          } catch (messErr) {
            messSyncWarning = [messSyncWarning, 'FN ' + fab + ': ' + (messErr.message || 'Anlagenstamm-Sync fehlgeschlagen')].filter(Boolean).join('\n');
          }
        }
        writeServiceprotokollDraft(reiseDir, fab, draftPayload, localJobId, spec);

        try {
          const localPdf = await writeServiceprotokollPdfsLocally(
            reiseDir,
            localJobId,
            fab,
            technicianId,
            Object.assign({}, draftPayload, {
              dispoBaseUrl,
              base_url: dispoBaseUrl,
              serverUsername: body.serverUsername || body.dispoUsername,
              serverPassword: body.serverPassword ?? body.dispoPassword,
              signature_override_png: body.signature_override_png || '',
            }),
            pdfLangs,
            spec,
          );
          if (localPdf.savedRel && localPdf.savedRel.length) {
            savedRel.push(...localPdf.savedRel);
          }
          if (localPdf.savedAbs && localPdf.savedAbs.length) {
            savedAbs.push(...localPdf.savedAbs);
          }
          if (localPdf.localWarning) {
            localWarning = [localWarning, 'FN ' + fab + ': ' + localPdf.localWarning].filter(Boolean).join('\n');
          }
          localResults.push({
            protokoll_id: 'local:' + Date.now() + ':' + fab,
            fabrikationsnummer: fab,
          });
        } catch (pdfErr) {
          localWarning = [localWarning, 'FN ' + fab + ': ' + (pdfErr.message || 'PDF lokal fehlgeschlagen')].filter(Boolean).join('\n');
        }
      }

      if (!savedRel.length) {
        return res.status(400).json({
          ok: false,
          error: localWarning || 'Keine PDFs konnten erstellt werden.',
        });
      }

      queueProtocolDraftAndFiles({
        localJobId,
        technicianId,
        serverJobId: parsedServerJobId,
        dispoBaseUrl,
        basename: spec.basename,
        reiseDir,
        filePath: serviceprotokollJsonPath(reiseDir, spec),
        username: body.serverUsername || body.dispoUsername,
        password: body.serverPassword ?? body.dispoPassword,
      });

      let saveData = {};
      let dispoWarning = null;
      const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
      if (!skipDispoSync && dispoBaseUrl && hasServerJobId) {
        try {
          const saveAllUrl = dispoBaseUrl + '/dispo_api/api/' + spec.saveAllPhp;
          const savePayload = {
            technician_id: body.technician_id != null ? body.technician_id : technicianId,
            job_id: parsedServerJobId,
            durchfuehrungsdatum,
            protokolle,
            pdf_languages: pdfLangs,
            apply_to_anlagenstamm: applyToAnlagenstamm ? 1 : 0,
          };
          const saveRes = await fetch(saveAllUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
            body: JSON.stringify(savePayload),
          });
          saveData = await saveRes.json().catch(() => ({}));
          if (!saveRes.ok || !saveData.ok) {
            dispoWarning =
              'Dispo-Sync: ' + (saveData.error || saveRes.statusText || 'Speichern fehlgeschlagen') +
              ' – lokale PDFs wurden trotzdem erstellt.';
          } else if (saveData.warning) {
            dispoWarning = String(saveData.warning);
          }
        } catch (syncErr) {
          dispoWarning =
            'Dispo-Sync: ' + (syncErr.message || 'nicht erreichbar') + ' – lokale PDFs wurden trotzdem erstellt.';
        }
      } else if (!hasServerJobId) {
        dispoWarning = 'Auftrag ohne Server-Verknüpfung – nur lokale PDFs erstellt.';
      }

      const savedItems =
        saveData && saveData.ok
          ? resolveServiceprotokollAllPdfSavedItems(saveData, protokolle)
          : localResults;
      const warning = [messSyncWarning, dispoWarning, localWarning].filter(Boolean).join('\n') || undefined;
      res.json({
        ok: true,
        protokoll_ids: (saveData && saveData.protokoll_ids) || [],
        protokolle: savedItems.length ? savedItems : localResults,
        saved: savedRel,
        pdf_paths: savedAbs,
        warning,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'PDFs konnten nicht erstellt werden.' });
    }
  }

  app.post('/api/serviceprotokoll_save', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !dispoBaseUrl) {
        return res.status(400).json({ ok: false, error: 'base_url und technician_id erforderlich.' });
      }
      const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
      const url = dispoBaseUrl + '/dispo_api/api/serviceprotokoll_save.php';
      let serverJobId;
      try {
        serverJobId = getServerJobId(body.job_id);
      } catch (e) {
        return res.status(404).json({ ok: false, error: e.message || 'Auftrag nicht gefunden.' });
      }
      const payload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: serverJobId,
        fabrikationsnummer: body.fabrikationsnummer,
        durchfuehrungsdatum: body.durchfuehrungsdatum,
        arbeitsschritte: Array.isArray(body.arbeitsschritte) ? body.arbeitsschritte : [],
        messwerte: body.messwerte && typeof body.messwerte === 'object' ? body.messwerte : {},
        projekt: body.projekt,
        bemerkungen: body.bemerkungen,
        kopf_pos_nr: body.kopf_pos_nr,
        kopf_qmax: body.kopf_qmax,
        kopf_type: body.kopf_type,
        kopf_dwc: body.kopf_dwc,
        pdf_languages: Array.isArray(body.pdf_languages) && body.pdf_languages.length
          ? body.pdf_languages.map((l) => String(l).toLowerCase()).filter((l) => l === 'de' || l === 'en')
          : ['de'],
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      let localWarning = null;
      if (data.ok && data.protokoll_id) {
        try {
          const resolved = resolveLocalJobIdForTechnician(db, technicianId, body.job_id, { mode: 'auto' });
          const localJobId = resolved && resolved.localJobId ? resolved.localJobId : null;
          if (localJobId) {
            const pdfUrl = dispoBaseUrl + '/dispo_api/api/serviceprotokoll_pdf.php?id=' + encodeURIComponent(data.protokoll_id) + '&technician_id=' + encodeURIComponent(technicianId);
            const pdfRes = await fetch(pdfUrl, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
            if (pdfRes.ok) {
              const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
              const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
              const fabRaw = String(body.fabrikationsnummer || '').trim();
              const datum = String(body.durchfuehrungsdatum || '').replace(/-/g, '');
              const safeFn = fabRaw.replace(/[^\w.-]+/g, '_');
              const pdfName = 'Serviceprotokoll_' + safeFn + '_' + datum + '.pdf';
              const { targetDir } = resolveServiceprotokollLocalPdfTarget(reiseDir, localJobId, fabRaw, technicianId);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              const localPdfFull = path.join(targetDir, pdfName);
              if (!keepExistingLocalPdf(localPdfFull)) {
                writeFileWithRetry(localPdfFull, pdfBuf);
              }
            } else {
              localWarning = 'PDF lokal konnte nicht vom Server geladen werden.';
            }
          }
        } catch (localErr) {
          localWarning = 'Lokale PDF-Kopie fehlgeschlagen: ' + localErr.message;
        }
      }
      if (localWarning) {
        data.warning = data.warning ? data.warning + '\n' + localWarning : localWarning;
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.get('/api/serviceprotokoll_pdf', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const protokollId = parseInt(req.query.id, 10);
      const localJobId = parseInt(req.query.local_job_id || req.query.job_id || '0', 10);
      const relativePath = String(req.query.relative_path || req.query.path || '').trim().replace(/\\/g, '/');
      // Offline-First: lokales PDF aus Dienstreise-Ordner, wenn angegeben
      if (localJobId > 0 && relativePath) {
        try {
          const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
          if (reiseDir && fs.existsSync(reiseDir)) {
            const fullPath = path.join(reiseDir, relativePath.split('/').join(path.sep));
            const resolved = path.resolve(fullPath);
            const baseResolved = path.resolve(reiseDir);
            if (resolved.startsWith(baseResolved) && fs.existsSync(resolved)) {
              const buf = fs.readFileSync(resolved);
              res.set('Content-Type', 'application/pdf');
              res.set('Content-Disposition', 'attachment; filename="Serviceprotokoll.pdf"');
              return res.send(buf);
            }
          }
        } catch (localErr) {
          console.warn('[serviceprotokoll_pdf] local:', localErr && localErr.message ? localErr.message : localErr);
        }
      }
      const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !protokollId || !baseUrl) {
        return res.status(400).json({
          ok: false,
          error: 'Lokal: local_job_id+relative_path — oder id, base_url und technician_id für Dispo.',
        });
      }
      const url = baseUrl + '/dispo_api/api/serviceprotokoll_pdf.php?id=' + encodeURIComponent(protokollId) + '&technician_id=' + encodeURIComponent(technicianId);
      const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
      const r = await fetch(url, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="Serviceprotokoll.pdf"');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Fabrikationsnummer aus Dateiname extrahieren (z. B. FN11952_PA7_… → 11952). */
  function extractFnFromFilename(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const m = filename.match(/FN(\d+)/i) || filename.match(/(\d{4,})/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Zahlen-FN aus jobs.fabrikationsnummern (JSON-Leistungszeilen oder Fallback Split-Liste). */
  function fabNumbersFromJobFabrikationsnummern(raw) {
    const set = new Set();
    const addNum = (v) => {
      const d = String(v || '').replace(/\D/g, '');
      if (!d) return;
      const n = parseInt(d, 10);
      if (Number.isFinite(n) && n > 0) set.add(n);
    };
    if (raw == null || raw === '') return set;
    const s = String(raw).trim();
    if (!s) return set;
    try {
      const parsed = JSON.parse(s);
      const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const fab = row.fabrikationsnummer != null ? row.fabrikationsnummer : row.Fabrikationsnummer;
        addNum(fab);
      }
      if (set.size > 0) return set;
    } catch (_) {
      /* kein JSON */
    }
    for (const part of s.split(/[\s;,]+/)) {
      if (part.trim()) addNum(part);
    }
    return set;
  }

  /**
   * Findet den vorhandenen Anlagenordner für eine FN unter Dokumente_Anlage.
   * Möglichkeit 1: Ordner = eine FN (exakt).
   * Möglichkeit 2/3: Ordner = Bereich "von - bis"; mit oder ohne Leerzeichen, Endzahl gekürzt möglich.
   * Beispiele: 11952 - 11958, 11952-11958, 11952-58, 11952 - 58.
   * Datumsordner wie 30-2020-07-25_Kunde werden nicht als Bereich gewertet.
   * Gibt den Ordnernamen zurück oder null.
   */
  function findParameterlistenFolder(docAnlagePath, fn) {
    if (fn == null || fn === '' || !Number.isFinite(fn)) return null;
    return findMonteurFolderForFab(docAnlagePath, fn);
  }

  function resolveKundenDokumentationLocalJob(req, jobIdRaw) {
    const jobId = parseInt(jobIdRaw, 10);
    if (!jobId) return { ok: false, status: 400, error: 'job_id erforderlich.' };
    const technicianId = getTechnicianId(req);
    const resolved =
      technicianId && Number.isFinite(technicianId) && technicianId > 0
        ? resolveLocalJobIdForTechnician(db, technicianId, jobId, { mode: 'auto' })
        : null;
    let localJobId = jobId;
    if (resolved) {
      if (!resolved.ok) {
        return { ok: false, status: resolved.status || 404, error: resolved.error || 'Auftrag nicht gefunden.' };
      }
      localJobId = resolved.localId;
    } else {
      const mapped = getJobRowByLocalOrServerId(jobId);
      if (!mapped) return { ok: false, status: 404, error: 'Auftrag nicht gefunden.' };
      localJobId = mapped.id;
    }
    return { ok: true, localJobId, technicianId };
  }

  function loadKundenDokumentationJobMeta(localJobId) {
    return db
      .prepare(
        `SELECT j.id, j.job_number, j.fabrikationsnummern, j.server_id,
                c.name AS customer_name
         FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
         WHERE j.id = ?`,
      )
      .get(localJobId);
  }

  function collectKundenDokumentationRecipients(localJobId, jobRow) {
    let contacts = [];
    try {
      contacts = db
        .prepare(`${JOB_CONTACTS_SELECT_SQL} WHERE job_id = ? ORDER BY sort_order, id`)
        .all(localJobId);
    } catch (_) {
      contacts = [];
    }
    return kundenDokumentation.collectRecipientEmails(contacts);
  }

  function resolveKundenDokumentationItemsFromPaths(reiseDir, localJobId, technicianId, paths, catalog) {
    const wanted = new Set(
      (Array.isArray(paths) ? paths : [])
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => path.resolve(p)),
    );
    const all = []
      .concat(catalog.documents || [])
      .concat(catalog.photos || []);
    if (wanted.size === 0) return [];
    return all.filter((item) => wanted.has(path.resolve(item.absPath)));
  }

  function buildKundenDokumentationCatalog(localJobId, technicianId, jobRow) {
    const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
    if (!reiseDir || !fs.existsSync(reiseDir)) {
      return {
        reiseDir: null,
        documents: [],
        photos: [],
        recipients: collectKundenDokumentationRecipients(localJobId, jobRow),
        targetRel: 'Dokumente_Monteur/' + kundenDokumentation.KUNDEN_DOC_FOLDER,
        folder_missing: true,
        hint: 'Noch kein Projektordner — bitte Auftrag annehmen.',
        job_number: jobRow && jobRow.job_number ? String(jobRow.job_number) : '',
        customer_name: jobRow && jobRow.customer_name ? String(jobRow.customer_name) : '',
      };
    }

    const fabs = parseJobFabrikationsnummernRows(jobRow && jobRow.fabrikationsnummern)
      .map((r) => String((r && (r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer)) || '').trim())
      .filter(Boolean);

    const scanned = kundenDokumentation.scanKundenDokumentation({
      reiseDir,
      fabs,
      resolveFabDirs: (fab) => {
        const { targetDir, folderName, montageFolderName } = resolveMonteurProtokollePdfTargetSync(
          reiseDir,
          localJobId,
          fab,
          technicianId,
        );
        const docMonteurBase = path.join(reiseDir, 'Dokumente_Monteur');
        return {
          folderName,
          montageFolderName,
          protokolleDir: targetDir,
          parameterDir: buildMonteurWorkAbsDir(docMonteurBase, folderName, montageFolderName, 'Parameter'),
          bilderDir: buildMonteurWorkAbsDir(docMonteurBase, folderName, montageFolderName, 'Bilder'),
          relBase: buildMonteurWorkRelPath(folderName, montageFolderName),
        };
      },
      previewUrlForRel: (rel) =>
        '/api/dienstreise/project_file?job_id=' +
        encodeURIComponent(String(localJobId)) +
        '&path=' +
        encodeURIComponent(rel) +
        '&thumb=1&inline=1',
    });

    return {
      reiseDir,
      documents: scanned.documents,
      photos: scanned.photos,
      recipients: collectKundenDokumentationRecipients(localJobId, jobRow),
      targetRel: scanned.targetRel,
      folder_missing: false,
      hint: null,
      job_number: jobRow && jobRow.job_number ? String(jobRow.job_number) : '',
      customer_name: jobRow && jobRow.customer_name ? String(jobRow.customer_name) : '',
    };
  }

  app.get('/api/protokolle/kunden-dokumentation', (req, res) => {
    try {
      const resolved = resolveKundenDokumentationLocalJob(req, req.query.job_id);
      if (!resolved.ok) return res.status(resolved.status).json({ ok: false, error: resolved.error });
      const jobRow = loadKundenDokumentationJobMeta(resolved.localJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const catalog = buildKundenDokumentationCatalog(resolved.localJobId, resolved.technicianId, jobRow);
      return res.json({
        ok: true,
        documents: catalog.documents.map((d) => ({
          id: d.id,
          kind: d.kind,
          type: d.type,
          name: d.name,
          fab: d.fab,
          absPath: d.absPath,
          relPath: d.relPath,
          size: d.size,
          mtime: d.mtime,
        })),
        photos: catalog.photos.map((p) => ({
          id: p.id,
          kind: p.kind,
          type: p.type,
          name: p.name,
          fab: p.fab,
          absPath: p.absPath,
          relPath: p.relPath,
          size: p.size,
          mtime: p.mtime,
          previewUrl: p.previewUrl,
        })),
        recipients: catalog.recipients,
        targetRel: catalog.targetRel,
        folder_missing: catalog.folder_missing,
        hint: catalog.hint,
        job_number: catalog.job_number,
        customer_name: catalog.customer_name,
      });
    } catch (e) {
      console.warn('[kunden-dokumentation] list', e);
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/protokolle/kunden-dokumentation/copy', express.json({ limit: '2mb' }), (req, res) => {
    try {
      const body = req.body || {};
      const resolved = resolveKundenDokumentationLocalJob(req, body.job_id != null ? body.job_id : body.jobId);
      if (!resolved.ok) return res.status(resolved.status).json({ ok: false, error: resolved.error });
      const jobRow = loadKundenDokumentationJobMeta(resolved.localJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const catalog = buildKundenDokumentationCatalog(resolved.localJobId, resolved.technicianId, jobRow);
      if (!catalog.reiseDir) {
        return res.status(400).json({ ok: false, error: catalog.hint || 'Kein Reiseordner.' });
      }
      const items = resolveKundenDokumentationItemsFromPaths(
        catalog.reiseDir,
        resolved.localJobId,
        resolved.technicianId,
        body.paths,
        catalog,
      );
      if (!items.length) {
        return res.status(400).json({ ok: false, error: 'Keine gültigen Dateien ausgewählt.' });
      }
      const result = kundenDokumentation.copyKundenDokumentationItems({
        reiseDir: catalog.reiseDir,
        items,
      });
      return res.json({
        ok: result.ok,
        copied: result.copied,
        errors: result.errors,
        targetDir: result.targetDir,
        targetRel: result.targetRel,
        count: result.copied.length,
      });
    } catch (e) {
      console.warn('[kunden-dokumentation] copy', e);
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/protokolle/kunden-dokumentation/prepare-email', express.json({ limit: '2mb' }), (req, res) => {
    try {
      const body = req.body || {};
      const mode = String(body.mode || 'files').toLowerCase() === 'zip' ? 'zip' : 'files';
      const resolved = resolveKundenDokumentationLocalJob(req, body.job_id != null ? body.job_id : body.jobId);
      if (!resolved.ok) return res.status(resolved.status).json({ ok: false, error: resolved.error });
      const jobRow = loadKundenDokumentationJobMeta(resolved.localJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const catalog = buildKundenDokumentationCatalog(resolved.localJobId, resolved.technicianId, jobRow);
      if (!catalog.reiseDir) {
        return res.status(400).json({ ok: false, error: catalog.hint || 'Kein Reiseordner.' });
      }
      const items = resolveKundenDokumentationItemsFromPaths(
        catalog.reiseDir,
        resolved.localJobId,
        resolved.technicianId,
        body.paths,
        catalog,
      );
      if (!items.length) {
        return res.status(400).json({ ok: false, error: 'Keine gültigen Dateien ausgewählt.' });
      }
      const copyResult = kundenDokumentation.copyKundenDokumentationItems({
        reiseDir: catalog.reiseDir,
        items,
      });
      if (!copyResult.copied.length) {
        return res.status(400).json({
          ok: false,
          error: 'Kopieren fehlgeschlagen.',
          errors: copyResult.errors,
        });
      }

      let attachments = copyResult.copied.map((c) => c.to);
      let zipName = null;
      if (mode === 'zip') {
        const zip = kundenDokumentation.createZipFromCopied(
          copyResult.targetDir,
          copyResult.copied,
          catalog.job_number,
        );
        attachments = [zip.zipPath];
        zipName = zip.zipName;
      }

      const subjectParts = ['Kundendokumentation'];
      if (catalog.job_number) subjectParts.push(catalog.job_number);
      if (catalog.customer_name) subjectParts.push(catalog.customer_name);
      const subject = subjectParts.join(' – ');
      const bodyText =
        'Im Anhang finden Sie die ausgewählte Kundendokumentation' +
        (catalog.job_number ? ' zu Auftrag ' + catalog.job_number : '') +
        '.';

      let outlook = null;
      let outlookError = null;
      try {
        outlook = kundenDokumentation.openOutlookDraft({
          recipients: catalog.recipients,
          attachments,
          subject,
          body: bodyText,
        });
      } catch (err) {
        outlookError = err && err.message ? err.message : String(err);
      }

      const totalBytes = attachments.reduce((sum, p) => {
        try {
          return sum + (fs.statSync(p).size || 0);
        } catch (_) {
          return sum;
        }
      }, 0);

      return res.json({
        ok: !outlookError,
        mode,
        copied: copyResult.copied,
        errors: copyResult.errors,
        targetDir: copyResult.targetDir,
        targetRel: copyResult.targetRel,
        zipName,
        recipients: catalog.recipients,
        attachmentCount: attachments.length,
        attachmentBytes: totalBytes,
        large_attachment_hint: totalBytes > 20 * 1024 * 1024,
        outlook,
        outlook_error: outlookError,
        error: outlookError || undefined,
      });
    } catch (e) {
      console.warn('[kunden-dokumentation] prepare-email', e);
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/protokolle/parameterlisten', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const filename = (body.filename || '').toString().trim();
      const contentBase64 = body.content;

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      if (!filename || !contentBase64) {
        return res.status(400).json({ ok: false, error: 'filename und content (base64) erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.status, j.fabrikationsnummern FROM jobs j
        WHERE j.id = ?
          AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const docMonteurPath = path.join(reiseDir, 'Dokumente_Monteur');
      const docAnlagePath = path.join(reiseDir, 'Dokumente_Anlage');
      const offlineCfgPl = getOfflinePullConfig(db, localJobId);
      await ensureJobReiseFolderLayout(localJobId, reiseDir, technicianId);
      const montageFolderNamePl = resolveMonteurAuftragsordnerName(localJobId, technicianId);
      let csvBuffer;
      try {
        csvBuffer = Buffer.from(contentBase64, 'base64');
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Ungültiger Base64-Inhalt.' });
      }
      const parsedParam = parseParameterFile(csvBuffer, { fileName: filename });
      const filenameFn = parsedParam && parsedParam.filename_fab ? parseInt(parsedParam.filename_fab, 10) : null;
      const contentFn = parsedParam && parsedParam.content_fab ? parseInt(parsedParam.content_fab, 10) : null;
      const fn = Number.isFinite(contentFn) && contentFn > 0
        ? contentFn
        : (Number.isFinite(filenameFn) && filenameFn > 0 ? filenameFn : null);
      if (fn == null) {
        return res.status(400).json({ ok: false, error: 'Keine Fabrikationsnummer erkannt (Dateiname oder Dateiinhalt).' });
      }

      const fnAllowedOnJob = fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern).has(fn);
      let folderName = null;
      const fromMap = (offlineCfgPl.fab_map || []).find((e) => String(e.fab) === String(fn));
      if (fromMap && fromMap.folder_name_canonical) folderName = fromMap.folder_name_canonical;
      if (!folderName) folderName = findMonteurFolderForFab(docMonteurPath, fn);
      if (!folderName) folderName = findParameterlistenFolder(docAnlagePath, fn);
      if (!folderName && fnAllowedOnJob) {
        folderName = String(fn);
      }
      if (!folderName) {
        return res.status(400).json({
          ok: false,
          error:
            'FN passt nicht zum Auftrag (Fabrikationsnummer in den Projektdaten prüfen; Dateiname z. B. FN12186_….csv).',
        });
      }

      const paramDir = buildMonteurWorkAbsDir(docMonteurPath, folderName, montageFolderNamePl, 'Parameter');
      try {
        if (!fs.existsSync(paramDir)) fs.mkdirSync(paramDir, { recursive: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'Ordner konnte nicht angelegt werden: ' + (e.message || e) });
      }

      const csvPath = path.join(paramDir, filename);
      writeFileWithRetry(csvPath, csvBuffer);

      let csvText = csvBuffer.toString('utf8');
      if (!csvText || /[\uFFFD]/.test(csvText)) {
        csvText = csvBuffer.toString('latin1');
      }

      let pdfBytes = null;
      try {
        const csvToPdfBuffer = getCsvToPdfBuffer();
        const sourcePath = (body.source_path || body.sourcePath || filename).toString().trim() || filename;
        pdfBytes = await csvToPdfBuffer(csvText, { filename, sourcePath });
      } catch (pdfErr) {
        console.warn('Parameter-PDF on-demand (Akte):', pdfErr && pdfErr.message ? pdfErr.message : pdfErr);
      }
      const pdfBasename = filename.replace(/\.(csv|txt|pa3|pa4|pa5|pal)$/i, '') + '.pdf';
      const pdfPath = path.join(paramDir, pdfBasename);
      if (pdfBytes) {
        writeFileWithRetry(pdfPath, pdfBytes);
      }

      const savedCsv = buildMonteurWorkRelPath(folderName, montageFolderNamePl, path.join('Parameter', filename));
      const savedPdf = buildMonteurWorkRelPath(folderName, montageFolderNamePl, path.join('Parameter', pdfBasename));
      protectPathIfUnderDokumenteMonteur(db, localJobId, savedCsv);
      protectPathIfUnderDokumenteMonteur(db, localJobId, savedPdf);
      save();
      const technicianName = getTechnicianDisplayName(technicianId);
      let serverFileId = null;
      let dispoIngestError = null;
      const dispoCandidates = buildDispoBaseCandidates({
        baseUrl: body.baseUrl,
        externalUrl: body.externalUrl,
        internalUrl: body.internalUrl,
      });
      if (dispoCandidates.length > 0) {
        try {
          const remote = await proxyAnlagenstammParameterIngest({
            technician_id: technicianId,
            baseUrl: body.baseUrl,
            externalUrl: body.externalUrl,
            internalUrl: body.internalUrl,
            serverUsername: body.serverUsername,
            serverPassword: body.serverPassword,
            filename,
            content: contentBase64,
            source: 'upload',
            mime: 'text/plain',
          });
          if (remote && remote.ok !== false) {
            serverFileId = remote.id != null ? Number(remote.id) : null;
          } else {
            dispoIngestError = remote && remote.error ? String(remote.error) : 'Dispo-Ingest fehlgeschlagen';
          }
        } catch (dispoErr) {
          dispoIngestError = dispoErr && dispoErr.message ? dispoErr.message : String(dispoErr);
        }
      }
      let ingest = null;
      let ingestError = null;
      try {
        ingest = ingestParameterFileIntoAnlagenstamm({
          fileName: filename,
          source: 'upload',
          sourcePath: savedCsv.replace(/\\/g, '/'),
          storageRelPath: csvPath,
          buffer: csvBuffer,
          mime: 'text/plain',
          technicianId,
          technicianName,
          serverFileId,
        });
        if (ingest && ingest.ok === false && ingest.error) {
          ingestError = String(ingest.error);
        }
      } catch (ingestErr) {
        ingestError = ingestErr && ingestErr.message ? ingestErr.message : String(ingestErr);
        console.warn('[parameterlisten] lokaler Cache:', ingestError);
      }
      res.json({
        ok: true,
        savedCsv,
        savedPdf,
        pdf_path: pdfBytes ? pdfPath : undefined,
        pdf_paths: pdfBytes ? [pdfPath] : [],
        ingest_ok: !!(ingest && ingest.ok),
        ingest_error: ingestError,
        dispo_ingest_ok: serverFileId != null,
        dispo_ingest_error: dispoIngestError,
        dispo_ingest_skipped: dispoCandidates.length === 0,
        dispo_file_id: serverFileId,
        fab_used: fn,
        filename_fn: Number.isFinite(filenameFn) ? filenameFn : null,
        content_fn: Number.isFinite(contentFn) ? contentFn : null,
      });
    } catch (e) {
      const errMsg =
        (e && e.message) ||
        (typeof e === 'string' ? e : '') ||
        (e ? String(e) : '') ||
        'Unbekannter Fehler';
      console.error('[parameterlisten] Upload:', errMsg, e);
      res.status(500).json({ ok: false, error: 'Parameterlisten-Upload fehlgeschlagen: ' + errMsg });
    }
  });

  app.get('/api/textbausteine_list', async (req, res) => {
    const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req);
    const localOnly = wantsLocalOnlyRequest(req.query);
    try {
      textbausteineLocal.ensureTextbausteineSchema(db);
      let local = textbausteineLocal.listTextbausteineLocal(db, technicianId);
      if (localOnly || !baseUrl || !technicianId) {
        local.data_source = 'local';
        return res.json(local);
      }
      try {
        const url =
          baseUrl + '/dispo_api/api/textbausteine_list.php?technician_id=' + encodeURIComponent(technicianId);
        const r = await fetchWithTimeout(url, { headers: { 'X-Technician-Id': String(technicianId) } });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok && Array.isArray(data.categories)) {
          textbausteineLocal.mergeTextbausteineFromRemote(db, technicianId, data);
          save();
          local = textbausteineLocal.listTextbausteineLocal(db, technicianId);
          local.data_source = 'dispo';
          return res.json(local);
        }
        local.data_source = local.categories && local.categories.length ? 'local_cache' : 'local_empty';
        local.warning = (data && data.error) || 'Dispo-Abruf fehlgeschlagen – lokaler Cache.';
        return res.json(local);
      } catch (fetchErr) {
        local.data_source = local.categories && local.categories.length ? 'local_cache' : 'local_empty';
        if (!local.categories || !local.categories.length) {
          return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + fetchErr.message });
        }
        local.warning = 'Dispo nicht erreichbar – lokaler Cache.';
        return res.json(local);
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_category_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    try {
      const result = textbausteineLocal.saveCategoryLocal(db, technicianId, body);
      textbausteineLocal.queueTextbausteinePending(db, result.id, 'category_save', {
        technician_id: technicianId,
        baseUrl,
        ...body,
        id: result.id,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(technicianId));
          const catRow = db
            .prepare(`SELECT server_id FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`)
            .get(result.id, technicianId);
          const dispoCatId =
            (catRow && parseInt(catRow.server_id, 10)) || (parseInt(body.id, 10) > 0 ? parseInt(body.id, 10) : 0);
          if (dispoCatId > 0) formBody.append('id', String(dispoCatId));
          formBody.append('name', body.name || '');
          formBody.append('sort_order', body.sort_order || 0);
          const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_save.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.id) {
            db.prepare(
              `UPDATE textbausteine_user_categories SET server_id = ? WHERE id = ? AND technician_id = ?`,
            ).run(data.id, result.id, technicianId);
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'textbausteine' AND entity_id = ? AND action = 'category_save'`,
            ).run(String(result.id));
            save();
            return res.json(Object.assign({}, data, { local_id: result.id }));
          }
        } catch (_) { /* offline – pending bleibt */ }
      }
      res.json(Object.assign({}, result, { deferred: true }));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_category_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!body.id) return res.status(400).json({ ok: false, error: 'id erforderlich.' });
    try {
      const catRow = db
        .prepare(`SELECT server_id FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`)
        .get(body.id, technicianId);
      const dispoCatId =
        (catRow && parseInt(catRow.server_id, 10)) || (parseInt(body.id, 10) > 0 ? parseInt(body.id, 10) : 0);
      textbausteineLocal.deleteCategoryLocal(db, technicianId, body.id);
      textbausteineLocal.queueTextbausteinePending(db, body.id, 'category_delete', {
        technician_id: technicianId,
        baseUrl,
        id: dispoCatId || body.id,
      });
      save();
      if (baseUrl && technicianId && dispoCatId > 0) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('id', String(dispoCatId));
          formBody.append('technician_id', String(technicianId));
          const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_delete.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'textbausteine' AND entity_id = ? AND action = 'category_delete'`,
            ).run(String(body.id));
            save();
            return res.json(data);
          }
        } catch (_) {}
      }
      res.json({ ok: true, deferred: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_publish_global', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    const localId = parseInt(body.item_id != null ? body.item_id : body.id, 10);
    if (!localId) {
      return res.status(400).json({ ok: false, error: 'item_id erforderlich.' });
    }
    if (!baseUrl) {
      return res.status(400).json({ ok: false, error: 'Dispo-URL in Einstellungen eintragen (Freigabe nur online).' });
    }
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
    }
    try {
      textbausteineLocal.ensureTextbausteineSchema(db);
      const row = textbausteineLocal.getUserItemWithCategory(db, technicianId, localId);
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Textbaustein nicht gefunden.' });
      }
      let dispoCatId = parseInt(row.category_server_id, 10) || 0;
      if (!(dispoCatId > 0) && parseInt(row.category_id, 10) > 0) {
        dispoCatId = parseInt(row.category_id, 10);
      }
      if (!(dispoCatId > 0)) {
        const catBody = new URLSearchParams();
        catBody.append('technician_id', String(technicianId));
        catBody.append('name', row.category_name || '');
        catBody.append('sort_order', String(row.category_sort_order || 0));
        const catR = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_save.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Technician-Id': String(technicianId),
          },
          body: catBody.toString(),
        });
        const catData = await catR.json().catch(() => ({}));
        if (!catR.ok || !catData.ok || !catData.id) {
          return res.status(catR.ok ? 400 : catR.status).json({
            ok: false,
            error: catData.error || 'Kategorie konnte nicht auf Dispo gespeichert werden.',
          });
        }
        dispoCatId = parseInt(catData.id, 10);
        db.prepare(
          `UPDATE textbausteine_user_categories SET server_id = ? WHERE id = ? AND technician_id = ?`,
        ).run(dispoCatId, row.category_id, parseInt(technicianId, 10));
        save();
      }
      let dispoItemId = parseInt(row.server_id, 10) || 0;
      if (!(dispoItemId > 0) && localId > 0) dispoItemId = localId;
      if (!(dispoItemId > 0)) {
        const saveBody = new URLSearchParams();
        saveBody.append('technician_id', String(technicianId));
        saveBody.append('category_id', String(dispoCatId));
        saveBody.append('text', row.text || '');
        saveBody.append('text_de', row.text || '');
        saveBody.append('text_en', row.text_en || '');
        saveBody.append('sort_order', String(row.sort_order || 0));
        const saveR = await fetch(baseUrl + '/dispo_api/api/textbausteine_save.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Technician-Id': String(technicianId),
          },
          body: saveBody.toString(),
        });
        const saveData = await saveR.json().catch(() => ({}));
        if (!saveR.ok || !saveData.ok || !saveData.id) {
          return res.status(saveR.ok ? 400 : saveR.status).json({
            ok: false,
            error: saveData.error || 'Textbaustein konnte nicht auf Dispo gespeichert werden.',
          });
        }
        dispoItemId = parseInt(saveData.id, 10);
        db.prepare(`UPDATE textbausteine_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
          dispoItemId,
          localId,
          parseInt(technicianId, 10),
        );
        save();
      }
      const formBody = new URLSearchParams();
      formBody.append('technician_id', String(technicianId));
      formBody.append('item_id', String(dispoItemId));
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_publish_global.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Technician-Id': String(technicianId),
        },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        return res.status(r.status >= 400 ? r.status : 400).json(
          data.ok === false ? data : { ok: false, error: data.error || 'Freigabe fehlgeschlagen' },
        );
      }
      const globalId = parseInt(data.id, 10);
      const globalCatId = parseInt(data.global_category_id, 10) || 0;
      if (!(globalId > 0)) {
        return res.status(502).json({ ok: false, error: 'Dispo lieferte keine globale ID.' });
      }
      textbausteineLocal.promoteUserItemToGlobal(db, technicianId, localId, globalId, globalCatId);
      db.prepare(
        `DELETE FROM pending_changes WHERE entity_type = 'textbausteine' AND entity_id = ? AND action IN ('item_save', 'item_delete', 'item_reorder')`,
      ).run(String(localId));
      save();
      return res.json({
        ok: true,
        id: globalId,
        local_id: localId,
        global_category_id: globalCatId || undefined,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    const textDe = String(body.text_de != null ? body.text_de : (body.text != null ? body.text : '')).trim();
    const textEn = String(body.text_en != null ? body.text_en : '').trim();
    if (!body.category_id || (!textDe && !textEn)) {
      return res.status(400).json({ ok: false, error: 'category_id und text_de oder text_en erforderlich.' });
    }
    try {
      const result = textbausteineLocal.saveItemLocal(db, technicianId, body);
      textbausteineLocal.queueTextbausteinePending(db, result.id, 'item_save', {
        technician_id: technicianId,
        baseUrl,
        ...body,
        id: result.id,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(technicianId));
          const itemRow = db
            .prepare(`SELECT server_id, category_id, text, text_en FROM textbausteine_user WHERE id = ? AND technician_id = ?`)
            .get(result.id, technicianId);
          const dispoItemId =
            (itemRow && parseInt(itemRow.server_id, 10)) || (parseInt(body.id, 10) > 0 ? parseInt(body.id, 10) : 0);
          if (dispoItemId > 0) formBody.append('id', String(dispoItemId));
          const catLocal = itemRow ? itemRow.category_id : body.category_id;
          const catRow = db
            .prepare(`SELECT server_id FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`)
            .get(catLocal, technicianId);
          const dispoCatId =
            (catRow && parseInt(catRow.server_id, 10)) || (parseInt(catLocal, 10) > 0 ? parseInt(catLocal, 10) : 0);
          if (!(dispoCatId > 0)) throw new Error('skip-dispo-no-category');
          formBody.append('category_id', String(dispoCatId));
          formBody.append('text', (itemRow && itemRow.text) || textDe);
          formBody.append('text_de', (itemRow && itemRow.text) || textDe);
          formBody.append('text_en', (itemRow && itemRow.text_en) || textEn);
          formBody.append('sort_order', body.sort_order || 0);
          const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_save.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.id) {
            db.prepare(`UPDATE textbausteine_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              result.id,
              technicianId,
            );
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'textbausteine' AND entity_id = ? AND action = 'item_save'`,
            ).run(String(result.id));
            save();
            return res.json(Object.assign({}, data, { local_id: result.id }));
          }
        } catch (_) {}
      }
      res.json(Object.assign({}, result, { deferred: true }));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!body.id) return res.status(400).json({ ok: false, error: 'id erforderlich.' });
    try {
      const itemRow = db
        .prepare(`SELECT server_id FROM textbausteine_user WHERE id = ? AND technician_id = ?`)
        .get(body.id, technicianId);
      const dispoItemId =
        (itemRow && parseInt(itemRow.server_id, 10)) || (parseInt(body.id, 10) > 0 ? parseInt(body.id, 10) : 0);
      textbausteineLocal.deleteItemLocal(db, technicianId, body.id);
      textbausteineLocal.queueTextbausteinePending(db, body.id, 'item_delete', {
        technician_id: technicianId,
        baseUrl,
        id: dispoItemId || body.id,
      });
      save();
      if (baseUrl && dispoItemId > 0) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('id', String(dispoItemId));
          const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_delete.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'textbausteine' AND entity_id = ? AND action = 'item_delete'`,
            ).run(String(body.id));
            save();
            return res.json(data);
          }
        } catch (_) {}
      }
      res.json({ ok: true, deferred: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/textbausteine_reorder', express.json(), async (req, res) => {
    const body = req.body || {};
    const technicianId = getTechnicianId(req) || body.technician_id;
    let orders = body.orders;
    if (!Array.isArray(orders)) orders = [];
    try {
      textbausteineLocal.ensureTextbausteineSchema(db);
      textbausteineLocal.reorderUserItemsLocal(db, technicianId, orders);
      save();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/arbeitsschritte_list', async (req, res) => {
    const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req);
    const localOnly = wantsLocalOnlyRequest(req.query);
    const catalogKind = String(req.query.catalog_kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service';
    try {
      arbeitsschritteLocal.ensureArbeitsschritteSchema(db);
      let local = arbeitsschritteLocal.listArbeitsschritteLocal(db, technicianId, catalogKind);
      if (localOnly || !baseUrl || !technicianId) {
        local.data_source = 'local';
        return res.json(local);
      }
      try {
        const url =
          baseUrl +
          '/dispo_api/api/arbeitsschritte_list.php?technician_id=' +
          encodeURIComponent(technicianId) +
          '&catalog_kind=' +
          encodeURIComponent(catalogKind);
        const r = await fetchWithTimeout(url, { headers: { 'X-Technician-Id': String(technicianId) } });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          data.catalog_kind = catalogKind;
          arbeitsschritteLocal.mergeArbeitsschritteFromRemote(db, technicianId, data);
          save();
          local = arbeitsschritteLocal.listArbeitsschritteLocal(db, technicianId, catalogKind);
          local.data_source = 'dispo';
          return res.json(local);
        }
        local.data_source = local.steps && local.steps.length ? 'local_cache' : 'local_empty';
        local.warning = (data && data.error) || 'Dispo-Abruf fehlgeschlagen – lokaler Cache.';
        return res.json(local);
      } catch (fetchErr) {
        local.data_source = local.steps && local.steps.length ? 'local_cache' : 'local_empty';
        if (!local.steps || !local.steps.length) {
          return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + fetchErr.message });
        }
        local.warning = 'Dispo nicht erreichbar – lokaler Cache.';
        return res.json(local);
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    try {
      const result = arbeitsschritteLocal.saveStepLocal(db, technicianId, body);
      arbeitsschritteLocal.queueArbeitsschrittePending(db, result.id, 'step_save', {
        technician_id: technicianId,
        baseUrl,
        ...body,
        id: result.id,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(technicianId));
          if (body.id && parseInt(body.id, 10) > 0) formBody.append('id', body.id);
          formBody.append('bezeichnung_de', body.bezeichnung_de || '');
          formBody.append('bezeichnung_en', body.bezeichnung_en || '');
          formBody.append('sort_order', body.sort_order || 0);
          formBody.append('catalog_kind', String(body.catalog_kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service');
          const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_save.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.id) {
            db.prepare(`UPDATE arbeitsschritte_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              result.id,
              technicianId,
            );
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'arbeitsschritte' AND entity_id = ? AND action = 'step_save'`,
            ).run(String(result.id));
            save();
            return res.json(Object.assign({}, data, { local_id: result.id }));
          }
        } catch (_) {}
      }
      res.json(Object.assign({}, result, { deferred: true }));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!body.id) return res.status(400).json({ ok: false, error: 'id erforderlich.' });
    try {
      // server_id vor lokalem Delete lesen — Delete entfernt die Zeile.
      let serverStepId = null;
      try {
        const before = db
          .prepare(`SELECT id, server_id FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`)
          .get(parseInt(body.id, 10), parseInt(technicianId, 10));
        if (before && before.server_id != null) serverStepId = parseInt(before.server_id, 10);
      } catch (_) {
        /* ignore */
      }
      if (!(serverStepId > 0) && parseInt(body.id, 10) > 0) serverStepId = parseInt(body.id, 10);
      arbeitsschritteLocal.deleteStepLocal(db, technicianId, body.id);
      arbeitsschritteLocal.queueArbeitsschrittePending(db, body.id, 'step_delete', {
        technician_id: technicianId,
        baseUrl,
        id: serverStepId > 0 ? serverStepId : body.id,
        server_id: serverStepId > 0 ? serverStepId : null,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const delId = serverStepId > 0 ? serverStepId : body.id;
          const formBody = new URLSearchParams();
          formBody.append('id', String(delId));
          formBody.append('technician_id', String(technicianId));
          const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_delete.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'arbeitsschritte' AND entity_id = ? AND action = 'step_delete'`,
            ).run(String(body.id));
            save();
            return res.json(data);
          }
        } catch (_) {}
      }
      res.json({ ok: true, deferred: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_publish_global', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    const localId = parseInt(body.id, 10);
    if (!localId) {
      return res.status(400).json({ ok: false, error: 'id erforderlich.' });
    }
    if (!baseUrl) {
      return res.status(400).json({ ok: false, error: 'Dispo-URL in Einstellungen eintragen (Freigabe nur online).' });
    }
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
    }
    try {
      arbeitsschritteLocal.ensureArbeitsschritteSchema(db);
      const row = db
        .prepare(
          `SELECT id, bezeichnung_de, bezeichnung_en, sort_order, server_id
           FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`,
        )
        .get(localId, parseInt(technicianId, 10));
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Schritt nicht gefunden.' });
      }
      let dispoUserId = parseInt(row.server_id, 10) || 0;
      if (!(dispoUserId > 0)) {
        const saveBody = new URLSearchParams();
        saveBody.append('technician_id', String(technicianId));
        saveBody.append('bezeichnung_de', row.bezeichnung_de || '');
        saveBody.append('bezeichnung_en', row.bezeichnung_en || '');
        saveBody.append('sort_order', String(row.sort_order || 0));
        const saveR = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_save.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Technician-Id': String(technicianId),
          },
          body: saveBody.toString(),
        });
        const saveData = await saveR.json().catch(() => ({}));
        if (!saveR.ok || !saveData.ok || !saveData.id) {
          return res.status(saveR.ok ? 400 : saveR.status).json({
            ok: false,
            error: saveData.error || 'Schritt konnte nicht auf Dispo gespeichert werden.',
          });
        }
        dispoUserId = parseInt(saveData.id, 10);
        db.prepare(`UPDATE arbeitsschritte_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
          dispoUserId,
          localId,
          parseInt(technicianId, 10),
        );
        save();
      }
      const formBody = new URLSearchParams();
      formBody.append('technician_id', String(technicianId));
      formBody.append('id', String(dispoUserId));
      const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_publish_global.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Technician-Id': String(technicianId),
        },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        return res.status(r.status >= 400 ? r.status : 400).json(
          data.ok === false ? data : { ok: false, error: data.error || 'Freigabe fehlgeschlagen' },
        );
      }
      const globalId = parseInt(data.id, 10);
      if (!(globalId > 0)) {
        return res.status(502).json({ ok: false, error: 'Dispo lieferte keine globale ID.' });
      }
      arbeitsschritteLocal.promoteUserStepToGlobal(db, technicianId, localId, globalId);
      db.prepare(
        `DELETE FROM pending_changes WHERE entity_type = 'arbeitsschritte' AND entity_id = ? AND action IN ('step_save', 'step_publish')`,
      ).run(String(localId));
      save();
      return res.json({ ok: true, id: globalId, local_id: localId });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_preset_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    try {
      const result = arbeitsschritteLocal.savePresetLocal(db, technicianId, body);
      arbeitsschritteLocal.queueArbeitsschrittePending(db, result.id, 'preset_save', {
        technician_id: technicianId,
        baseUrl,
        ...body,
        id: result.id,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(technicianId));
          if (body.id && parseInt(body.id, 10) > 0) formBody.append('id', body.id);
          formBody.append('name', body.name || '');
          formBody.append('type_code', body.type_code || '');
          formBody.append('sort_order', body.sort_order || 0);
          formBody.append('step_refs', JSON.stringify(body.step_refs || []));
          formBody.append('catalog_kind', String(body.catalog_kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service');
          const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_preset_save.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.id) {
            db.prepare(`UPDATE arbeitsschritte_preset_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              result.id,
              technicianId,
            );
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'arbeitsschritte' AND entity_id = ? AND action = 'preset_save'`,
            ).run(String(result.id));
            save();
            return res.json(Object.assign({}, data, { local_id: result.id }));
          }
        } catch (_) {}
      }
      res.json(Object.assign({}, result, { deferred: true }));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_preset_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!body.id) return res.status(400).json({ ok: false, error: 'id erforderlich.' });
    try {
      arbeitsschritteLocal.deletePresetLocal(db, technicianId, body.id);
      arbeitsschritteLocal.queueArbeitsschrittePending(db, body.id, 'preset_delete', {
        technician_id: technicianId,
        baseUrl,
        id: body.id,
      });
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('id', body.id);
          formBody.append('technician_id', String(technicianId));
          const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_preset_delete.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            db.prepare(
              `DELETE FROM pending_changes WHERE entity_type = 'arbeitsschritte' AND entity_id = ? AND action = 'preset_delete'`,
            ).run(String(body.id));
            save();
            return res.json(data);
          }
        } catch (_) {}
      }
      res.json({ ok: true, deferred: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/arbeitsschritte_reorder', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    let orders = body.orders;
    if (!Array.isArray(orders)) orders = [];
    try {
      arbeitsschritteLocal.ensureArbeitsschritteSchema(db);
      arbeitsschritteLocal.reorderUserStepsLocal(db, technicianId, orders);
      save();
      if (baseUrl && technicianId) {
        try {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(technicianId));
          formBody.append('orders', JSON.stringify(orders));
          const r = await fetch(baseUrl + '/dispo_api/api/arbeitsschritte_reorder.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Technician-Id': String(technicianId),
            },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) return res.json(data);
        } catch (_) {}
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  /** Fabrikationsnummern dürfen auch bei „angelegt/geplant/zugeteilt“ gesetzt werden (vor „Auftrag annehmen“). */
  function getLocalJobMetaForFabrikationsnummernPatch(dbConn, technicianId, rawJobId) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n)) return { error: 'job_id ungültig.', status: 400 };
    const row = dbConn.prepare(`
      SELECT j.id, j.status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
        AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
      ORDER BY CASE WHEN j.id = ? THEN 0 ELSE 1 END, j.id ASC
      LIMIT 1
    `).get(n, n, technicianId, n);
    if (!row) return { error: 'Auftrag nicht gefunden.', status: 404 };
    const s = String(row.status || '').trim().toLowerCase();
    if (s === 'abgerechnet') {
      return { error: 'Auftrag ist abgerechnet – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    return { localId: row.id };
  }

  app.patch('/api/job', express.json(), (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const { job_id, status, description, fabrikationsnummern, hotel_selection } = body;
    if (!technicianId || !job_id) {
      return res.status(400).json({ ok: false, error: 'technician_id und job_id erforderlich.' });
    }
    const hotelKeys = ['hotel_endkunde', 'hotel_street', 'hotel_house_number', 'hotel_zip', 'hotel_city', 'hotel_country', 'hotel_address_extra_1', 'hotel_address_extra_2', 'hotel_phone', 'hotel_email', 'hotel_website', 'hotel_comment', 'hotel_rating_stars'];
    const jobSiteKeys = ['endkunde', 'street', 'house_number', 'zip', 'city', 'country', 'address_extra_1', 'address_extra_2'];
    const fabOnlyPatch = fabrikationsnummern !== undefined
      && status === undefined
      && description === undefined
      && !hotel_selection
      && !Array.isArray(body.job_contacts)
      && !hotelKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k))
      && !jobSiteKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    const gate = fabOnlyPatch
      ? getLocalJobMetaForFabrikationsnummernPatch(db, technicianId, job_id)
      : getWritableLocalJobMetaForPatch(db, technicianId, job_id);
    if (gate.error) {
      return res.status(gate.status).json({ ok: false, error: gate.error });
    }
    const effectiveJobId = gate.localId;
    const allowed = ['angelegt', 'zugeteilt', 'in_arbeit', 'erledigt', 'abgerechnet', 'geplant'];
    const hasHotelPayload = hotelKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    try {
      if (hasHotelPayload) {
        const hotelPayload = {};
        hotelKeys.forEach((k) => { hotelPayload[k] = body[k] != null ? String(body[k]) : ''; });
        const jha = db.prepare('SELECT job_id FROM job_hotel_addresses WHERE job_id = ?').get(effectiveJobId);
        const endkunde = hotelPayload.hotel_endkunde || null;
        const street = hotelPayload.hotel_street || '';
        const house_number = hotelPayload.hotel_house_number || '';
        const zip = postalCodeNormalize(hotelPayload.hotel_zip || '', hotelPayload.hotel_country || '');
        const city = hotelPayload.hotel_city || '';
        const country = hotelPayload.hotel_country || '';
        const address_extra_1 = hotelPayload.hotel_address_extra_1 || null;
        const address_extra_2 = hotelPayload.hotel_address_extra_2 || null;
        const phone = hotelPayload.hotel_phone || null;
        const email = hotelPayload.hotel_email || null;
        const website = hotelPayload.hotel_website || null;
        if (jha) {
          db.prepare('UPDATE job_hotel_addresses SET endkunde=?, street=?, house_number=?, zip=?, city=?, country=?, address_extra_1=?, address_extra_2=?, phone=?, email=?, website=? WHERE job_id=?').run(endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website, effectiveJobId);
        } else {
          db.prepare('INSERT INTO job_hotel_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(effectiveJobId, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website);
        }
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'hotel_address', JSON.stringify(hotelPayload));
        save();
        return res.json({ ok: true, updated: 'hotel_address' });
      }
      const hasJobSitePayload = jobSiteKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
      if (hasJobSitePayload) {
        const sitePayload = {};
        jobSiteKeys.forEach((k) => { sitePayload[k] = body[k] != null ? String(body[k]) : ''; });
        insertOrUpdateJobAddress(db, effectiveJobId, {
          endkunde: sitePayload.endkunde || null,
          street: sitePayload.street || '',
          house_number: sitePayload.house_number || '',
          zip: postalCodeNormalize(sitePayload.zip || '', sitePayload.country || ''),
          city: sitePayload.city || '',
          country: sitePayload.country || 'DE',
          address_extra_1: sitePayload.address_extra_1 || null,
          address_extra_2: sitePayload.address_extra_2 || null,
        });
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
          'job',
          effectiveJobId,
          'job_address',
          JSON.stringify(sitePayload),
        );
        save();
        return res.json({ ok: true, updated: 'job_address' });
      }
      if (Array.isArray(body.job_contacts)) {
        const contacts = body.job_contacts
          .filter((c) => c && typeof c === 'object')
          .map((c) => jobContactToApiRow(normalizeJobContactPayload(c)))
          .filter((c) => jobContactHasAny(c));
        try {
          db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(effectiveJobId);
          contacts.forEach((c, i) => {
            insertJobContactRow(db, effectiveJobId, normalizeJobContactPayload(c), i);
          });
        } catch (e) {
          return res.status(500).json({ ok: false, error: e.message || 'Kontakte konnten nicht gespeichert werden.' });
        }
        db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'job_contacts'`).run(
          effectiveJobId,
        );
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
          'job',
          effectiveJobId,
          'job_contacts',
          JSON.stringify({ job_contacts: contacts }),
        );
        save();
        return res.json({ ok: true, updated: 'job_contacts' });
      }
      if (hotel_selection && typeof hotel_selection === 'object') {
        const hotelId = Number(hotel_selection.hotel_id || 0);
        if (!Number.isFinite(hotelId) || hotelId <= 0) {
          return res.status(400).json({ ok: false, error: 'hotel_selection.hotel_id fehlt oder ungültig.' });
        }
        const comment = hotel_selection.comment != null ? String(hotel_selection.comment) : null;
        let ratingStars = null;
        if (Object.prototype.hasOwnProperty.call(hotel_selection, 'rating_stars') && hotel_selection.rating_stars !== null && hotel_selection.rating_stars !== '') {
          ratingStars = Math.max(0, Math.min(5, Number(hotel_selection.rating_stars)));
          if (!Number.isFinite(ratingStars)) ratingStars = null;
        }
        const ratingAvg = hotel_selection.rating_avg != null ? Number(hotel_selection.rating_avg) : null;
        const ratingCount = hotel_selection.rating_count != null ? Number(hotel_selection.rating_count) : 0;
        db.prepare(`
          INSERT INTO job_hotel_selection (job_id, hotel_id, comment, rating_stars, rating_avg, rating_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(job_id) DO UPDATE SET
            hotel_id=excluded.hotel_id,
            comment=excluded.comment,
            rating_stars=excluded.rating_stars,
            rating_avg=excluded.rating_avg,
            rating_count=excluded.rating_count,
            updated_at=datetime('now')
        `).run(effectiveJobId, hotelId, comment, ratingStars, ratingAvg, ratingCount);
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'hotel_selection', JSON.stringify({ hotel_selection: { hotel_id: hotelId, comment: comment, rating_stars: ratingStars } }));
        save();
        return res.json({ ok: true, updated: 'hotel_selection' });
      }
      if (status && allowed.includes(status)) {
        const r = db.prepare(`
          UPDATE jobs SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
        `).run(status, effectiveJobId, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'status', JSON.stringify({ status }));
          freezeProtocolDraftsIfClosed(effectiveJobId, status);
          save();
          return res.json({ ok: true, updated: 'status' });
        }
      }
      if (description !== undefined) {
        const r = db.prepare(`
          UPDATE jobs SET description = ?, updated_at = datetime('now')
          WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
        `).run(description, effectiveJobId, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'description', JSON.stringify({ description }));
          save();
          return res.json({ ok: true, updated: 'description' });
        }
      }
      if (fabrikationsnummern !== undefined) {
        let val = typeof fabrikationsnummern === 'string' ? fabrikationsnummern : (fabrikationsnummern != null ? JSON.stringify(fabrikationsnummern) : null);
        if (val != null) {
          val = clampFabrikationsnummernJson(val);
          try {
            val = JSON.stringify(sortJobFabRows(JSON.parse(val)));
          } catch (_) { /* unverändert */ }
          // Leere Leistungsfelder (z. B. neu hinzugefügte FN) aus lokalem Anlagenstamm füllen
          try {
            const enriched = enrichFabJsonWithLocalAnlagenstamm(db, val);
            if (enriched != null && String(enriched).trim() !== '') val = enriched;
            val = JSON.stringify(sortJobFabRows(JSON.parse(val)));
          } catch (_) { /* Enrich optional */ }
        }
        const jobFabBefore = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(effectiveJobId);
        const oldFabJson = jobFabBefore && jobFabBefore.fabrikationsnummern;
        const addedFns = computeAddedJobFabNums(oldFabJson, val);
        const removedFns = computeRemovedJobFabNums(oldFabJson, val);
        const r = db.prepare(`
          UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now')
          WHERE id = ? AND EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
        `).run(val, effectiveJobId, technicianId);
        if (r.changes) {
          const changedFns = computeChangedJobStammFns(oldFabJson, val);
          const stammFns = [...new Set([...(addedFns || []), ...(changedFns || [])])];
          if (stammFns.length) {
            applyJobFabEditsToAnlagenstammLocal(db, val, { onlyFns: stammFns });
            syncJobFabRowsToAnlagenstammLocal(db, val, { onlyFns: addedFns });
            enqueueAnlagenstammPendingFromFabJson(db, val, { onlyFns: stammFns });
          }
          for (const fn of removedFns) {
            try {
              removeOfflinePullFab(db, effectiveJobId, fn);
            } catch (rmOffErr) {
              console.warn(
                '[job PATCH] removeOfflinePullFab',
                fn,
                rmOffErr && rmOffErr.message ? rmOffErr.message : rmOffErr,
              );
            }
          }
          db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'fabrikationsnummern'`).run(
            effectiveJobId,
          );
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'fabrikationsnummern', JSON.stringify({ fabrikationsnummern: val }));
          if (!save()) {
            return res.status(500).json({
              ok: false,
              error: 'Fabrikationsnummern lokal gespeichert, aber ' + monteurDbSaveErrorMessage(),
            });
          }
          return res.json({
            ok: true,
            updated: 'fabrikationsnummern',
            pending_sync: true,
            added_fns: addedFns,
            removed_fns: removedFns,
            fabrikationsnummern: val,
          });
        }
        if (fabOnlyPatch) {
          return res.status(403).json({
            ok: false,
            error: 'Fabrikationsnummern konnten nicht gespeichert werden (Auftrag nicht gefunden oder nicht diesem Monteur zugeordnet).',
          });
        }
      }
      res.status(400).json({ ok: false, error: 'Status-Update fehlgeschlagen oder keine Berechtigung.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/my_absences', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    try {
      const orphanResult = reconcileLocalAbsenceOrphans(db, technicianId, new Set());
      if (orphanResult.absences > 0 || orphanResult.requests > 0) save();
    } catch (orphanErr) {
      console.warn('[my_absences] orphan reconcile:', orphanErr && orphanErr.message ? orphanErr.message : orphanErr);
    }
    let sql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment FROM absences WHERE technician_id = ?';
    const params = [technicianId];
    if (dateFrom) { sql += ' AND end_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { sql += ' AND start_datetime <= ?'; params.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY start_datetime ASC';
    const rows = db.prepare(sql).all(...params);
    const byKey = new Map();
    rows.forEach((r) => byKey.set(absencePeriodDedupeKey(r.technician_id, r.start_datetime, r.end_datetime), true));
    // Genehmigte und ausstehende Abwesenheitsanfragen mit anzeigen (z. B. eigene Abwesenheit in Einzeltechniker-Ansicht)
    let reqSql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment, status FROM absence_requests WHERE technician_id = ? AND status IN (\'approved\', \'pending\')';
    const reqParams = [technicianId];
    if (dateFrom) { reqSql += ' AND end_datetime >= ?'; reqParams.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { reqSql += ' AND start_datetime <= ?'; reqParams.push(dateTo + ' 23:59:59'); }
    reqSql += ' ORDER BY start_datetime ASC';
    const requests = db.prepare(reqSql).all(...reqParams);
    requests.forEach((r) => {
      const key = absencePeriodDedupeKey(r.technician_id, r.start_datetime, r.end_datetime);
      if (!byKey.has(key)) {
        byKey.set(key, true);
        rows.push({ id: r.id, server_id: r.server_id, technician_id: r.technician_id, start_datetime: r.start_datetime, end_datetime: r.end_datetime, type: r.type, comment: r.comment != null ? r.comment : null, from_absence_request: true, status: r.status });
      }
    });
    rows.sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')));
    res.json({ ok: true, technician_id: technicianId, absences: rows });
  });

  app.post('/api/job_file', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const jobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const fileId = parseInt(body.file_id != null ? body.file_id : body.server_id != null ? body.server_id : body.id, 10);
      const keepLocal = body.keep_local != null ? (body.keep_local ? 1 : 0) : null;
      if (!jobId || !fileId) {
        return res.status(400).json({ ok: false, error: 'job_id und file_id erforderlich.' });
      }
      if (keepLocal === null) {
        return res.status(400).json({ ok: false, error: 'keep_local (0 oder 1) erforderlich.' });
      }
      try {
        const r = db.prepare('UPDATE job_files SET keep_local = ? WHERE job_id = ? AND (id = ? OR server_id = ?)').run(keepLocal, jobId, fileId, fileId);
        if (r.changes === 0) {
          db.prepare('INSERT OR IGNORE INTO job_files (id, job_id, server_id, keep_local) VALUES (?, ?, ?, ?)').run(fileId, jobId, fileId, keepLocal);
        }
        res.json({ ok: true, keep_local: keepLocal });
      } catch (e) {
        if (e.message && (e.message.includes('no such table') || e.message.includes('job_files'))) {
          return res.status(501).json({ ok: false, error: 'Tabelle job_files nicht vorhanden.' });
        }
        throw e;
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Aktualisierung fehlgeschlagen.' });
    }
  });

  app.get('/api/my_absence_requests', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const rows = db.prepare('SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment, status, requested_at, synced_at FROM absence_requests WHERE technician_id = ? ORDER BY requested_at DESC').all(technicianId);
    res.json({ ok: true, technician_id: technicianId, requests: rows });
  });

  app.post('/api/absence_requests_cleanup_errors', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const r = db.prepare('DELETE FROM absence_requests WHERE technician_id = ? AND status = ?').run(technicianId, 'error');
    save();
    res.json({ ok: true, deleted: r.changes });
  });

  app.delete('/api/absence_request', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const id = parseInt(req.query.id, 10) || parseInt((req.body || {}).id, 10) || 0;
      if (!technicianId || !id) {
        return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
      }
      const r = db.prepare('DELETE FROM absence_requests WHERE id = ? AND technician_id = ?').run(id, technicianId);
      if (r.changes) {
        save();
        return res.json({ ok: true });
      }
      return res.status(404).json({ ok: false, error: 'Anfrage nicht gefunden.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/absence_request', (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const start = body.start_datetime || body.start || body.date_from || '';
    const end = body.end_datetime || body.end || body.date_to || '';
    const type = body.type || body.reason || null;
    let comment = body.comment != null && String(body.comment).trim() !== '' ? String(body.comment).trim() : null;
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : String(v).trim();
    const startNorm = norm(start);
    const endNorm = norm(end);
    try {
      const r = db.prepare('INSERT INTO absence_requests (technician_id, start_datetime, end_datetime, type, comment, status) VALUES (?, ?, ?, ?, ?, ?)').run(technicianId, startNorm, endNorm, type || null, comment, 'pending');
      const localId = r.lastInsertRowid;
      save();
      if (baseUrl) {
        const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) };
        const auth = authHeaderFromCredentials(body.serverUsername, body.serverPassword);
        if (auth) header.Authorization = auth.Authorization;
        fetch(baseUrl + '/api/absence_request.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify({ technician_id: technicianId, start_datetime: startNorm, end_datetime: endNorm, type: type || null, comment: comment }),
        }).then(async (resp) => {
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.ok && data.id) {
            db.prepare('UPDATE absence_requests SET server_id = ?, synced_at = datetime(\'now\') WHERE id = ?').run(data.id, localId);
            save();
          } else if (resp.status >= 400 && resp.status < 500) {
            // Dauerhafter fachlicher Fehler (z. B. „Kein gültiger Monteur“): nicht endlos pending lassen.
            logAbsenceRequestError({ context: 'immediate', status: resp.status, body: data, technicianId, baseUrl });
            db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE id = ?').run('error', localId);
            save();
          }
        }).catch(() => {
          // Verbindungsfehler: Eintrag bleibt pending und wird beim nächsten Sync erneut versucht.
        });
      }
      res.json({ ok: true, id: localId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/absence_request', (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const id = parseInt(body.id, 10) || parseInt(req.query.id, 10) || 0;
    const start = body.start_datetime || body.start || body.date_from || '';
    const end = body.end_datetime || body.end || body.date_to || '';
    const type = body.type || body.reason || null;
    const hasComment = Object.prototype.hasOwnProperty.call(body, 'comment');
    const comment = hasComment && body.comment != null && String(body.comment).trim() !== '' ? String(body.comment).trim() : (hasComment ? null : undefined);
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !id || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, id, start_datetime und end_datetime erforderlich.' });
    }
    const row = db.prepare('SELECT id, status, server_id FROM absence_requests WHERE id = ? AND technician_id = ?').get(id, technicianId);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Anfrage nicht gefunden.' });
    }
    if (String(row.status) !== 'pending') {
      return res.status(403).json({ ok: false, error: 'Nur offene Anfragen können geändert werden.' });
    }
    const normStart = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : String(v).trim();
    const normEnd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 23:59:59' : String(v).trim();
    const startNorm = normStart(start);
    const endNorm = normEnd(end);
    try {
      if (hasComment) {
        db.prepare('UPDATE absence_requests SET start_datetime = ?, end_datetime = ?, type = ?, comment = ? WHERE id = ? AND technician_id = ?').run(startNorm, endNorm, type || null, comment, id, technicianId);
      } else {
        db.prepare('UPDATE absence_requests SET start_datetime = ?, end_datetime = ?, type = ? WHERE id = ? AND technician_id = ?').run(startNorm, endNorm, type || null, id, technicianId);
      }
      save();
      const remoteId = parseInt(row.server_id, 10) || 0;
      if (baseUrl && remoteId) {
        const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) };
        const auth = authHeaderFromCredentials(body.serverUsername, body.serverPassword);
        if (auth) header.Authorization = auth.Authorization;
        fetch(baseUrl + '/api/absence_request.php', {
          method: 'PATCH',
          headers: header,
          body: JSON.stringify({
            technician_id: technicianId,
            id: remoteId,
            start_datetime: startNorm,
            end_datetime: endNorm,
            type: type || null,
            comment: hasComment ? comment : undefined,
          }),
        }).catch(() => {});
      }
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/events', (req, res) => {
    const technicianId = getTechnicianId(req);
    const baseUrl = req.query.base_url || req.query.baseUrl || '';
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    if (!sseClients.has(technicianId)) sseClients.set(technicianId, new Set());
    sseClients.get(technicianId).add(res);
    connectPushForTechnician(technicianId, baseUrl);
    req.on('close', () => {
      const set = sseClients.get(technicianId);
      if (set) {
        set.delete(res);
        if (set.size === 0) {
          sseClients.delete(technicianId);
          const ws = pushWsByTechnician.get(technicianId);
          if (ws) { ws.close(); pushWsByTechnician.delete(technicianId); }
        }
      }
    });
  });

  app.post('/api/absence', (req, res) => {
    res.status(403).json({
      ok: false,
      error: 'Genehmigte Abwesenheiten können nur von Dispo, Buchhaltung, Lohnverrechnung oder Admin geändert werden.',
      code: 'absence_locked_after_approval',
    });
  });

  app.patch('/api/absence', (req, res) => {
    res.status(403).json({
      ok: false,
      error: 'Genehmigte Abwesenheiten können nur von Dispo, Buchhaltung, Lohnverrechnung oder Admin geändert werden.',
      code: 'absence_locked_after_approval',
    });
  });

  app.delete('/api/absence', (req, res) => {
    res.status(403).json({
      ok: false,
      error: 'Genehmigte Abwesenheiten können nur von Dispo, Buchhaltung, Lohnverrechnung oder Admin geändert werden.',
      code: 'absence_locked_after_approval',
    });
  });

  app.get('/api/pending_changes', (req, res) => {
    const rows = db.prepare('SELECT * FROM pending_changes ORDER BY id').all();
    const pending = (rows || []).map((row) => {
      const copy = Object.assign({}, row);
      if (copy.payload) {
        try {
          const obj = JSON.parse(copy.payload);
          if (obj && typeof obj === 'object') {
            if (obj.serverPassword) obj.serverPassword = '***';
            copy.payload = JSON.stringify(obj);
          }
        } catch (_) {
          /* Payload bleibt unverändert wenn kein JSON */
        }
      }
      return copy;
    });
    let failed = [];
    try {
      failed = db
        .prepare(
          'SELECT id, original_pending_id, entity_type, entity_id, action, attempts, last_error, fail_reason, failed_at FROM pending_changes_failed ORDER BY id DESC LIMIT 100',
        )
        .all();
    } catch (_) {
      failed = [];
    }
    res.json({ ok: true, pending, failed });
  });

  app.post('/api/sync_retry_failed', express.json(), async (req, res) => {
    try {
      const n = requeueFailedPendingChanges(db);
      save();
      let pushed = false;
      let pushError = '';
      try {
        const creds = resolveDispoServerCreds(req.body || {});
        const techId = getTechnicianId(req);
        const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
        const base = String((creds && creds.baseUrl) || '').trim().replace(/\/$/, '');
        if (n > 0 && base && auth && techId) {
          await pushToServer(base, techId, db, auth, liveDispoCredsForPush(base, creds));
          save();
          pushed = true;
        }
      } catch (ePush) {
        pushError = ePush && ePush.message ? String(ePush.message) : String(ePush);
      }
      res.json({
        ok: true,
        requeued: n,
        pushed,
        push_error: pushError || null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  function authHeaderFromCredentials(username, password) {
    const session = loadDispoWebSessionCreds();
    const u = (username || session.serverUsername || '').toString().trim();
    if (!u) return undefined;
    const explicit = password != null ? String(password) : '';
    const p = explicit !== '' ? explicit : String(session.serverPassword || '');
    if (!p) return undefined;
    return { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
  }

  /**
   * Profil-Unterschrift für finales PDF: Override aus Body, sonst Cache (+ Sync).
   */
  async function resolveTechnicianSignaturePng(technicianId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const overrideRaw =
      b.signature_override_png ||
      b.technician_signature_png ||
      (b.abschluss && (b.abschluss.signature_override_png || b.abschluss.signature_monteur)) ||
      '';
    const override = technicianSignature.normalizePngBase64(overrideRaw);
    if (override) return override;
    const creds = resolveDispoServerCreds(b);
    const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
    const dispoBase = String(creds.baseUrl || b.dispoBaseUrl || b.base_url || b.baseUrl || '')
      .trim()
      .replace(/\/$/, '');
    if (dispoBase && auth) {
      try {
        await technicianSignature.syncWithDispo(db, technicianId, dispoBase, auth);
        save();
      } catch (_) {
        /* offline */
      }
    }
    const local = technicianSignature.getLocal(db, technicianId);
    return local && local.png_base64 ? local.png_base64 : null;
  }

  function failMissingSignature(res) {
    res.status(400).json({
      ok: false,
      error:
        'Keine Profil-Unterschrift. Bitte unter Einstellungen hinterlegen oder für dieses Protokoll neu zeichnen.',
      code: 'missing_technician_signature',
    });
    return false;
  }

  /** Basic vom Browser an 127.0.0.1 (kein Passwort in der Query); Fallback Query für Alt-Clients. */
  function authHeaderFromIncomingBasicOrQuery(req) {
    const raw = req.headers && req.headers.authorization;
    if (raw && /^\s*Basic\s+/i.test(String(raw))) {
      try {
        const b64 = String(raw).replace(/^\s*Basic\s+/i, '').trim();
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const u = colon >= 0 ? decoded.slice(0, colon) : decoded;
        const p = colon >= 0 ? decoded.slice(colon + 1) : '';
        return authHeaderFromCredentials(u, p);
      } catch (_) {
        return authHeaderFromCredentials('', '');
      }
    }
    return authHeaderFromCredentials('', '');
  }

  registerAbrechnungRoutes(app, {
    db,
    save,
    dbDir: DB_DIR,
    authHeaderFromCredentials,
    authHeaderFromIncomingBasicOrQuery,
    getTechnicianId,
    loadDispoCreds: loadDispoWebSessionCreds,
    resolveDienstreiseReiseDirForJob: (jobIdRef, opts) => resolveDienstreiseReiseDirForJob(jobIdRef, opts),
    getDienstreiseBasePath: () => getDienstreiseBasePath(),
  });

  registerZeitschreibungRoutes(app, {
    getDb: () => db,
    dbDir: DB_DIR,
    writeFileWithRetry,
    resolveDispoPushCreds: () => {
      try {
        const c = resolveDispoServerCreds({});
        const baseUrl = String((c && c.baseUrl) || '').trim();
        if (!baseUrl) return null;
        return {
          baseUrl,
          authHeader: authHeaderFromCredentials(
            (c && c.serverUsername) || '',
            (c && c.serverPassword) || '',
          ),
        };
      } catch (_) {
        return null;
      }
    },
  });
  registerHinweiseRoutes(app, {
    getTechnicianId,
    resolveDispoPushCreds: () => {
      try {
        const c = resolveDispoServerCreds({});
        const baseUrl = String((c && c.baseUrl) || '').trim();
        if (!baseUrl) return null;
        return {
          baseUrl,
          authHeader: authHeaderFromCredentials(
            (c && c.serverUsername) || '',
            (c && c.serverPassword) || '',
          ),
        };
      } catch (_) {
        return null;
      }
    },
  });
  try {
    ensureZeitschreibungTables(db);
  } catch (e) {
    console.warn('[zeitschreibung] ensureTables:', e && e.message ? e.message : e);
  }

  const abrechnungRefreshCtx = {
    db,
    save,
    dbDir: DB_DIR,
    authHeaderFromCredentials,
    resolveDienstreiseReiseDirForJob: (jobIdRef, opts) => resolveDienstreiseReiseDirForJob(jobIdRef, opts),
    getDienstreiseBasePath: () => getDienstreiseBasePath(),
  };

  function fingerprintDispoBase(urlRaw) {
    const base = (urlRaw || '').trim().replace(/\/$/, '');
    return crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 24);
  }

  function combineAbortSignals(a, b) {
    if (!b) return a;
    if (!a) return b;
    if (a.aborted || b.aborted) {
      const ac = new AbortController();
      ac.abort();
      return ac.signal;
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return ac.signal;
  }

  async function executeBackgroundJob(job, helpers) {
    const { signal, setProgress, mergeCheckpoint, readCheckpoint } = helpers;
    switch (job.type) {
      case 'dienstreise_pull': {
        const p = job.payload || {};
        const rawJobId = parseInt(p.job_id, 10);
        let dispoBaseUrl = (p.dispo_base_url || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technician_id, 10);
        const includeBilder = !!p.include_bilder;
        const acceptJob = !!p.accept_job;
        const periodicDelta = !!p.periodic_delta;
        const dispoUsername = (p.dispo_username || '').trim();
        const dispoPassword = p.dispo_password != null ? String(p.dispo_password) : '';
        if (!rawJobId || !technicianId) throw new Error('dienstreise_pull: job_id und technician_id erforderlich.');
        const authHeader = authHeaderFromCredentials(dispoUsername, dispoPassword) || {};
        if (!authHeader.Authorization) throw new Error('Dispo-Zugangsdaten fehlen.');
        const resolvedPull = await resolveDispoWorkingBase({
          baseUrl: dispoBaseUrl,
          externalUrl: p.externalUrl,
          internalUrl: p.internalUrl,
          technicianId,
          serverUsername: dispoUsername,
          serverPassword: dispoPassword,
        });
        if (resolvedPull.base) dispoBaseUrl = resolvedPull.base;
        const resolvedJob = resolveLocalJobIdForTechnician(db, technicianId, rawJobId, { mode: 'auto' });
        if (!resolvedJob.ok) throw new Error(resolvedJob.error);
        const assignGate = requireJobAssignedToTechnician(db, resolvedJob.localId, technicianId);
        if (assignGate) throw new Error(assignGate.error);
        const jobRowFull = lookupDienstreiseJobRow(resolvedJob.localId);
        if (!jobRowFull) throw new Error('Auftrag nicht gefunden.');
        const statusRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(resolvedJob.localId);
        jobRowFull.status = statusRow ? statusRow.status : null;
        if (!acceptJob) {
          const folderGate = dienstreiseProjectFolderBlocked(jobRowFull.status);
          if (folderGate) throw new Error(folderGate.error);
        }
        const localJobId = jobRowFull.id;
        const serverJobId = jobRowFull.server_id != null ? jobRowFull.server_id : jobRowFull.id;
        const targetDir = getOrCreateDienstreiseFolderForJob(localJobId, {
          skipAssignmentCheck: true,
          technicianId,
        });
        if (!targetDir || !fs.existsSync(targetDir)) throw new Error('Zielordner konnte nicht erstellt werden.');
        if (!dispoBaseUrl) {
          if (acceptJob) {
            applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
            mergeCheckpoint({
              finalize_done: true,
              status_sync_warning: resolvedPull.error || 'Keine Verbindung zur Dispo.',
              empty_copy: true,
            });
            setProgress('done', 1, 1, 'Auftrag lokal angenommen (ohne Dateikopie).');
            break;
          }
          throw new Error(resolvedPull.error || 'Keine erreichbare Dispo-URL für Projektordner.');
        }
        console.log('[dienstreise_pull] start', {
          local_job_id: localJobId,
          server_job_id: serverJobId,
          technician_id: technicianId,
          accept_job: acceptJob,
          periodic_delta: periodicDelta,
          target_dir: targetDir,
        });
        const offlineCfg = getOfflinePullConfig(db, localJobId);
        const pullMode = p.offline_pull_mode || offlineCfg.pull_mode || 'legacy';
        const skipTedOnPull = acceptJob || pullMode === 'explicit';
        const pathsByFab = getOfflinePullPathsByFab(db, localJobId);
        let fabMap = offlineCfg.fab_map || [];
        if (!fabMap.length) {
          fabMap = [];
          for (const fn of fabNumbersFromJobFabrikationsnummern(jobRowFull.fabrikationsnummern)) {
            fabMap.push({
              fab: String(fn),
              folder_name_canonical: buildCanonicalFabFolderName(fn, jobRowFull),
            });
          }
        }
        fabMap = await resolveFabMapCanonicalFolderNames(
          dispoBaseUrl,
          serverJobId,
          technicianId,
          authHeader,
          fabMap,
          [...fabNumbersFromJobFabrikationsnummern(jobRowFull.fabrikationsnummern)],
          signal,
          jobRowFull,
        );
        if (fabMap.length) {
          await dbLock.runWithDbLock(async () => {
            updateOfflinePullFabMap(db, localJobId, fabMap);
            save();
          });
        }
        await ensureAnlageFnDirs(targetDir, fabMap);
        await migrateBareFabAnlageDirs(targetDir, fabMap);
        await removeStaleBareFabMonteurDirs(targetDir, fabMap);
        await migrateAliasFnFolders(targetDir, fabMap);
        const layoutPull = await ensureJobReiseFolderLayout(localJobId, targetDir, technicianId);
        const montageFolderName = layoutPull.montageFolderName || resolveMonteurAuftragsordnerName(localJobId, technicianId);
        if (montageFolderName) {
          removeLegacyMonteurAuftragsordnerTopLevel(targetDir, montageFolderName, fabMap);
        }
        let fp = fingerprintDispoBase(dispoBaseUrl);
        let chk = readCheckpoint();
        if (chk.dispo_base_fingerprint && chk.dispo_base_fingerprint !== fp) {
          throw new Error('Dispo-Basis-URL hat sich geändert — Kopie nicht automatisch fortgesetzt.');
        }
        if (chk.server_job_id != null && Number(chk.server_job_id) !== Number(serverJobId)) {
          throw new Error('Server-Auftrags-ID hat sich geändert — Checkpoint verworfen.');
        }
        const hasOwnProgress =
          (Array.isArray(chk.completed) && chk.completed.length > 0) ||
          (Array.isArray(chk.ted_completed) && chk.ted_completed.length > 0) ||
          !!chk.refresh_done_at;
        if (!hasOwnProgress) {
          const prev = loadLastCompletedDienstreisePullCheckpoint(localJobId);
          if (prev) {
            if (!prev.dispo_base_fingerprint || prev.dispo_base_fingerprint === fp) {
              if (prev.server_job_id == null || Number(prev.server_job_id) === Number(serverJobId)) {
                const seed = {
                  dispo_base_fingerprint: fp,
                  server_job_id: serverJobId,
                  local_job_id: localJobId,
                };
                if (Array.isArray(prev.completed) && prev.completed.length) seed.completed = prev.completed.slice();
                if (Array.isArray(prev.ted_completed) && prev.ted_completed.length) {
                  seed.ted_completed = prev.ted_completed.slice();
                }
                if (prev.refresh_done_at && !periodicDelta) seed.refresh_done_at = prev.refresh_done_at;
                mergeCheckpoint(seed);
                chk = readCheckpoint();
              }
            }
          }
        }
        const refreshAge = chk.refresh_done_at ? Date.now() - new Date(chk.refresh_done_at).getTime() : Infinity;
        const skipRefresh = !periodicDelta && !!(chk.refresh_done_at && refreshAge < 15 * 60 * 1000 && chk.dispo_base_fingerprint === fp);
        let copyWarning = null;
        let skipCopyDueToNetwork = false;
        setProgress('refresh', 0, 1, skipRefresh ? 'Dispo-Refresh (Checkpoint, TTL).' : 'Dispo wird aktualisiert …');
        if (!skipRefresh) {
          const pullPair = normalizeDispoBasePair(p.externalUrl, p.internalUrl);
          const refreshCandidates = buildDispoBaseCandidates({
            baseUrl: dispoBaseUrl,
            externalUrl: pullPair.external,
            internalUrl: pullPair.internal,
          });
          const refreshTimeoutMs = 60000;
          let refreshBase = null;
          let lastRefreshErr = null;
          for (const candidate of refreshCandidates) {
            const refreshUrl = candidate + '/api/job_project_refresh.php';
            const refreshAbort = new AbortController();
            const refreshTimeoutId = setTimeout(() => refreshAbort.abort(), refreshTimeoutMs);
            try {
              const refreshRes = await fetch(refreshUrl, {
                method: 'POST',
                signal: combineAbortSignals(signal, refreshAbort.signal),
                headers: Object.assign({ 'Content-Type': 'application/json' }, dispoMonteurFetchHeaders(technicianId, authHeader)),
                body: JSON.stringify({ job_id: serverJobId, technician_id: technicianId, include_bilder: includeBilder }),
              });
              const refreshData = await refreshRes.json().catch(() => ({}));
              if (refreshRes.ok && !(refreshData && refreshData.ok === false)) {
                refreshBase = candidate;
                break;
              }
              lastRefreshErr = new Error(
                (refreshData && refreshData.error)
                  ? String(refreshData.error)
                  : 'Dispo-Aktualisierung fehlgeschlagen (HTTP ' + refreshRes.status + ').',
              );
            } catch (e) {
              if (isFetchNetworkError(e) || (e && e.name === 'AbortError')) {
                lastRefreshErr = e;
                continue;
              }
              throw e;
            } finally {
              clearTimeout(refreshTimeoutId);
            }
          }
          if (!refreshBase) {
            const refreshFail = lastRefreshErr || new Error('Dispo-Aktualisierung auf keiner Basis-URL möglich.');
            if (acceptJob) {
              copyWarning = formatFetchError(refreshFail, dispoBaseUrl);
              skipCopyDueToNetwork = true;
              console.warn(
                '[dienstreise_pull] accept: Dispo-Refresh fehlgeschlagen, lokale Annahme trotzdem.',
                copyWarning,
              );
            } else {
              throw refreshFail;
            }
          } else {
            dispoBaseUrl = refreshBase;
            fp = fingerprintDispoBase(dispoBaseUrl);
            mergeCheckpoint({
              refresh_done_at: new Date().toISOString(),
              dispo_base_fingerprint: fp,
              server_job_id: serverJobId,
              local_job_id: localJobId,
            });
          }
        } else {
          mergeCheckpoint({
            dispo_base_fingerprint: fp,
            server_job_id: serverJobId,
            local_job_id: localJobId,
          });
        }
        setProgress('refresh_done', 1, 1, 'Liste und Downloads …');
        chk = readCheckpoint();

        async function listEntries(relPath) {
          const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
          const url =
            dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + serverJobId + pathQ;
          const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader), signal });
          const text = await r.text();
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_) {
            throw new Error('Dispo-Liste: ungültige Antwort (' + r.status + '): ' + text.slice(0, 160));
          }
          if (!r.ok || data.ok === false) {
            throw new Error((data && data.error) ? String(data.error) : 'Dispo-Liste fehlgeschlagen (HTTP ' + r.status + ').');
          }
          return Array.isArray(data.entries) ? data.entries : [];
        }

        let manifestListed = 0;
        async function collectManifest(relPath, acc) {
          const entries = await listEntries(relPath);
          for (const e of entries) {
            const name = e.name || '';
            if (!name || name === '.' || name === '..') continue;
            const childRel = relPath ? relPath + '/' + name : name;
            const t = String(e.type || '').toLowerCase();
            if (t === 'dir') await collectManifest(childRel, acc);
            else if (t === 'file') {
              let sz = null;
              if (e.size != null) sz = Number(e.size);
              else if (e.size_bytes != null) sz = Number(e.size_bytes);
              const mtimeMs = dispoEntryMtimeMs(e);
              acc.push({
                path: childRel,
                size: Number.isFinite(sz) ? sz : null,
                mtime_ms: mtimeMs,
              });
              manifestListed++;
              if (manifestListed === 1 || manifestListed % 20 === 0) {
                setProgress('manifest', manifestListed, 0, childRel);
              }
            }
          }
        }

        let files = null;
        if (skipCopyDueToNetwork) {
          files = [];
        } else if (!periodicDelta && Array.isArray(chk.files) && chk.files.length) {
          files = filterManifestForPull(chk.files, pullMode, pathsByFab, fabMap);
        } else {
          files = [];
          try {
            await collectManifest('', files);
            files = filterManifestForPull(files, pullMode, pathsByFab, fabMap);
            mergeCheckpoint({ files, completed: [] });
          } catch (listErr) {
            if (acceptJob) {
              copyWarning = formatFetchError(listErr, dispoBaseUrl);
              console.warn('[dienstreise_pull] accept: Dateiliste fehlgeschlagen.', copyWarning);
              files = [];
            } else {
              throw listErr;
            }
          }
        }
        mergeCheckpoint({
          pull_audit: {
            pull_mode: pullMode,
            manifest_matched: files.length,
            explicit_paths: pathsByFab
              ? [...pathsByFab.values()].reduce((n, m) => n + (m && m.size ? m.size : 0), 0)
              : 0,
          },
        });

        const FS_MTIME_TOLERANCE_MS = 2000;

        /**
         * Überspringen wenn lokal vorhanden und nicht älter als Dispo (mtime), sonst Größenvergleich.
         * Download nur wenn Dispo-Datei fehlt lokal, neuer ist (mtime) oder Größe abweicht.
         */
        function localFnEntriesForPull() {
          const extra = [];
          try {
            const dm = path.join(targetDir, 'Dokumente_Monteur');
            if (fs.existsSync(dm)) {
              for (const ent of fs.readdirSync(dm, { withFileTypes: true })) {
                if (!ent.isDirectory() || isDokumenteMonteurReservedTopDir(ent.name)) continue;
                extra.push({ folder_name_canonical: ent.name, fab: ent.name });
              }
            }
          } catch (_) {}
          return [...(Array.isArray(fabMap) ? fabMap : []), ...extra];
        }

        function localRelsForPullFile(relPath) {
          const mapped =
            String(relPath || '').startsWith('Dokumente_Monteur/')
              ? mapServerManifestPathToLocalAnlageRel(relPath, fabMap)
              : relPath;
          return expandTopLevelMontageRelToFnFolders(mapped, localFnEntriesForPull());
        }

        async function copyPullFileToSiblingRels(primaryAbs, localRels) {
          if (!primaryAbs || !fs.existsSync(primaryAbs)) return;
          for (let s = 1; s < localRels.length; s++) {
            const siblingAbs = path.join(targetDir, String(localRels[s] || '').replace(/\//g, path.sep));
            if (siblingAbs === primaryAbs || fs.existsSync(siblingAbs)) continue;
            try {
              const siblingDir = path.dirname(siblingAbs);
              await fs.promises.mkdir(siblingDir, { recursive: true });
              await fs.promises.copyFile(primaryAbs, siblingAbs);
            } catch (copyErr) {
              console.warn(
                '[dienstreise_pull] PWA-Foto FN-Kopie',
                copyErr && copyErr.message ? copyErr.message : copyErr,
              );
            }
          }
        }

        function shouldSkip(relPath, expectedSize, expectedMtimeMs, completedArr) {
          const localRel = localRelsForPullFile(relPath)[0] || relPath;
          const lp = path.join(targetDir, localRel.replace(/\//g, path.sep));
          if (!fs.existsSync(lp)) return false;
          let localSize = null;
          let localMtimeMs = null;
          try {
            const st = fs.statSync(lp);
            localSize = st.size;
            localMtimeMs = st.mtimeMs != null ? st.mtimeMs : st.mtime ? st.mtime.getTime() : null;
          } catch (_) {
            return false;
          }
          if (expectedMtimeMs != null && Number.isFinite(expectedMtimeMs) && expectedMtimeMs > 0) {
            if (localMtimeMs == null || !Number.isFinite(localMtimeMs)) return false;
            // Lokal neuer oder gleich (Toleranz) → nie überschreiben, auch bei Größenabweichung.
            if (localMtimeMs + FS_MTIME_TOLERANCE_MS >= expectedMtimeMs) return true;
            return false; // Dispo neuer → Download
          }
          if (expectedSize == null || !Number.isFinite(expectedSize)) {
            return !!(completedArr && completedArr.includes(relPath));
          }
          return localSize === expectedSize;
        }

        async function notifyMarkDocsLoaded() {
          try {
            const url = dispoBaseUrl + '/api/job_mark_docs_loaded.php';
            const r = await fetch(url, {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, dispoMonteurFetchHeaders(technicianId, authHeader)),
              body: JSON.stringify({ job_id: serverJobId, technician_id: technicianId }),
              signal,
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) {
              console.warn('[dienstreise_pull] job_mark_docs_loaded', r.status, data && data.error);
            }
          } catch (e) {
            console.warn('[dienstreise_pull] job_mark_docs_loaded', e && e.message ? e.message : e);
          }
        }

        const total = files.length;
        let completed = Array.isArray(chk.completed) ? chk.completed.slice() : [];
        let skippedStart = 0;
        for (const f of files) {
          if (shouldSkip(f.path, f.size, f.mtime_ms, completed)) skippedStart++;
        }
        setProgress('download', skippedStart, total, total ? '' : 'Keine Dateien.');

        async function pushLocalChangesBeforePull() {
          setProgress('push_first', 0, 1, 'Lokale neuere Dateien zuerst senden …');
          try {
            await dbLock.runWithDbLock(async () => {
              await pushToServer(
                dispoBaseUrl,
                technicianId,
                db,
                authHeader,
                liveDispoCredsForPush(dispoBaseUrl, {
                  serverUsername: dispoUsername,
                  serverPassword: dispoPassword,
                  externalUrl: p.externalUrl,
                  internalUrl: p.internalUrl,
                }),
              );
              save();
            });
          } catch (prePushErr) {
            console.warn(
              '[dienstreise_pull] pre-pull pending:',
              prePushErr && prePushErr.message ? prePushErr.message : prePushErr,
            );
          }
          try {
            await syncDienstreiseFoldersToDispo(
              localJobId,
              dispoBaseUrl,
              technicianId,
              dispoUsername,
              dispoPassword,
              {
                onlyChanged: true,
                externalUrl: p.externalUrl,
                internalUrl: p.internalUrl,
              },
            );
          } catch (filePushErr) {
            console.warn(
              '[dienstreise_pull] pre-pull files:',
              filePushErr && filePushErr.message ? filePushErr.message : filePushErr,
            );
          }
          setProgress('push_first', 1, 1, 'Lokale Änderungen gesendet.');
        }

        async function pullProtocolJsonDrafts() {
          if (!multiDeviceApi || !multiDeviceApi.pullAllJsonDrafts) return;
          setProgress('drafts', 0, 1, 'Protokoll-Zwischenstände …');
          try {
            await multiDeviceApi.pullAllJsonDrafts({
              reiseDir: targetDir,
              dispoBaseUrl,
              technicianId,
              serverJobId,
              localJobId,
              username: dispoUsername,
              password: dispoPassword,
            });
          } catch (draftPullErr) {
            console.warn(
              '[dienstreise_pull] json drafts:',
              draftPullErr && draftPullErr.message ? draftPullErr.message : draftPullErr,
            );
          }
          setProgress('drafts', 1, 1, 'Protokoll-Zwischenstände.');
        }

        await pushLocalChangesBeforePull();

        if (total === 0) {
          await pullProtocolJsonDrafts();
          if (!skipTedOnPull) {
            setProgress('ted', 0, 1, 'TED-Excel in Projektordner …');
            try {
              await pullTedExcelIntoReiseDir({
                db,
                dbLock,
                dispoBaseUrl,
                technicianId,
                serverJobId,
                localJobId,
                targetDir,
                authHeader: dispoMonteurFetchHeaders(technicianId, authHeader),
                signal,
                setProgress,
                mergeCheckpoint,
                readCheckpoint,
              });
            } catch (tedPullErr) {
              console.warn('[dienstreise_pull] TED (0 Dateien):', tedPullErr && tedPullErr.message ? tedPullErr.message : tedPullErr);
            }
          }
          if (acceptJob) {
            await notifyMarkDocsLoaded();
            applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
            let statusSyncWarning = null;
            const srvId = jobRowFull.server_id != null ? jobRowFull.server_id : null;
            if (srvId) {
              const pushRes = await pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, srvId, authHeader);
              if (pushRes.ok) {
                await dbLock.runWithDbLock(async () => {
                  db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`).run(localJobId);
                  save();
                });
              } else {
                statusSyncWarning = pushRes.error || 'Status konnte nicht sofort zur Dispo gesendet werden.';
              }
            }
            mergeCheckpoint({
              finalize_done: true,
              status_sync_warning: [statusSyncWarning, copyWarning].filter(Boolean).join(' ') || null,
              empty_copy: true,
            });
          } else {
            mergeCheckpoint({ finalize_done: true, empty_copy: true });
          }
          try {
            await dbLock.runWithDbLock(async () => {
              cacheProjekteNeuTreesForJob(localJobId);
            });
          } catch (cacheErr) {
            console.warn('[dienstreise_pull] projekte_neu cache:', cacheErr && cacheErr.message ? cacheErr.message : cacheErr);
          }
          break;
        }

        try {
        for (let i = 0; i < files.length; i++) {
          const relPath = files[i].path;
          const expectedSize = files[i].size;
          const expectedMtimeMs = files[i].mtime_ms;
          if (shouldSkip(relPath, expectedSize, expectedMtimeMs, completed)) {
            const localRelsSkip = localRelsForPullFile(relPath);
            const localRelSkip = localRelsSkip[0] || relPath;
            await copyPullFileToSiblingRels(path.join(targetDir, String(localRelSkip).replace(/\//g, path.sep)), localRelsSkip);
            const relNormSkip = normProjectRelPath(localRelSkip);
            if (
              relNormSkip &&
              DIENSTREISE_SYNC_FOLDERS.some((fd) => relNormSkip === fd || relNormSkip.startsWith(fd + '/'))
            ) {
              const lpSkip = path.join(targetDir, localRelSkip.replace(/\//g, path.sep));
              if (fs.existsSync(lpSkip)) recordDienstreisePushCache(db, localJobId, relNormSkip, lpSkip);
            }
            setProgress('file', i + 1, total, relPath);
            continue;
          }
          const url =
            dispoBaseUrl +
            '/api/job_project_file_download.php?technician_id=' +
            technicianId +
            '&job_id=' +
            serverJobId +
            '&path=' +
            encodeURIComponent(relPath);
          const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader), signal });
          let fileMtimeMs = expectedMtimeMs;
          if (fileMtimeMs == null || !Number.isFinite(fileMtimeMs)) {
            const lm = r.headers.get('last-modified');
            if (lm) fileMtimeMs = parseDispoFileMtimeMs(lm);
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try {
              const j = JSON.parse(buf.toString('utf8'));
              if (j && j.error) msg = String(j.error);
            } catch (_) {}
            throw new Error('Download fehlgeschlagen (' + relPath + '): ' + msg);
          }
          const ctDl = (r.headers.get('content-type') || '').toLowerCase();
          if (ctDl.includes('application/json')) {
            try {
              const j = JSON.parse(buf.toString('utf8'));
              if (j && j.ok === false && j.error) throw new Error('Download fehlgeschlagen (' + relPath + '): ' + String(j.error));
            } catch (e) {
              if (e.message && e.message.startsWith('Download fehlgeschlagen')) throw e;
            }
          }
          const localRels = localRelsForPullFile(relPath);
          const localRelPath = localRels[0] || relPath;
          const localPath = path.join(targetDir, localRelPath.replace(/\//g, path.sep));
          await hangDiag.timeAsync('onedrive_write', () => replaceFileWithoutUnlink(localPath, buf));
          applyLocalFileMtimeFromDispo(localPath, fileMtimeMs);
          await copyPullFileToSiblingRels(localPath, localRels);
          const relNormPull = normProjectRelPath(localRelPath);
          if (
            relNormPull &&
            DIENSTREISE_SYNC_FOLDERS.some((fd) => relNormPull === fd || relNormPull.startsWith(fd + '/'))
          ) {
            recordDienstreisePushCache(db, localJobId, relNormPull, localPath);
          }
          if (!completed.includes(relPath)) completed.push(relPath);
          mergeCheckpoint({ completed });
          setProgress('file', i + 1, total, relPath);
          await yieldEventLoop();
        }
        } catch (dlErr) {
          if (acceptJob) {
            copyWarning = [copyWarning, formatFetchError(dlErr, dispoBaseUrl)].filter(Boolean).join(' ');
            console.warn('[dienstreise_pull] accept: Download unterbrochen.', copyWarning);
          } else {
            throw dlErr;
          }
        }

        try {
          await migrateTopLevelMontageIntoFnFolders(targetDir, localFnEntriesForPull());
        } catch (migErr) {
          console.warn(
            '[dienstreise_pull] Top-Level-Montage → FN',
            migErr && migErr.message ? migErr.message : migErr,
          );
        }

        await pullProtocolJsonDrafts();

        if (!skipTedOnPull) {
          setProgress('ted', 0, 1, 'TED-Excel in Projektordner …');
          try {
            await pullTedExcelIntoReiseDir({
              db,
              dbLock,
              dispoBaseUrl,
              technicianId,
              serverJobId,
              localJobId,
              targetDir,
              authHeader: dispoMonteurFetchHeaders(technicianId, authHeader),
              signal,
              setProgress,
              mergeCheckpoint,
              readCheckpoint,
            });
          } catch (tedPullErr) {
            console.warn('[dienstreise_pull] TED:', tedPullErr && tedPullErr.message ? tedPullErr.message : tedPullErr);
          }
        }

        chk = readCheckpoint();
        if (!chk.finalize_done) {
          if (acceptJob) {
            await notifyMarkDocsLoaded();
            applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
            let statusSyncWarning = null;
            const srvId = jobRowFull.server_id != null ? jobRowFull.server_id : null;
            if (srvId) {
              const pushRes = await pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, srvId, authHeader);
              if (pushRes.ok) {
                await dbLock.runWithDbLock(async () => {
                  db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`).run(localJobId);
                  save();
                });
              } else {
                statusSyncWarning = pushRes.error || 'Status konnte nicht sofort zur Dispo gesendet werden.';
              }
            }
            mergeCheckpoint({
              finalize_done: true,
              status_sync_warning: [statusSyncWarning, copyWarning].filter(Boolean).join(' ') || null,
            });
          } else {
            mergeCheckpoint({ finalize_done: true });
          }
        }
        try {
          await dbLock.runWithDbLock(async () => {
            cacheProjekteNeuTreesForJob(localJobId);
          });
        } catch (cacheErr) {
          console.warn('[dienstreise_pull] projekte_neu cache:', cacheErr && cacheErr.message ? cacheErr.message : cacheErr);
        }
        break;
      }
      case 'dienstreise_finish': {
        const p = job.payload || {};
        const localJobId = parseInt(p.job_id, 10);
        if (!localJobId) throw new Error('dienstreise_finish: job_id fehlt.');
        await performFinishAndCleanupWork(p, { setProgress, signal });
        await dbLock.runWithDbLock(async () => {
          save();
        });
        setProgress('done', 1, 1, 'Auftrag abgeschlossen.');
        break;
      }
      case 'dienstreise_push': {
        const p = job.payload || {};
        const localJobId = parseInt(p.job_id, 10);
        const dispoBaseUrl = (p.dispo_base_url || p.dispoBaseUrl || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technician_id != null ? p.technician_id : p.technicianId, 10);
        setProgress('dienstreise_push', 0, 1, 'Synchronisiere Dienstreise-Ordner …');
        await syncDienstreiseFoldersToDispo(
          localJobId,
          dispoBaseUrl,
          technicianId,
          String(p.dispo_username || p.dispoUsername || ''),
          String(p.dispo_password != null ? p.dispo_password : p.dispoPassword || ''),
          {
            onlyChanged: p.onlyChanged !== false,
            externalUrl: p.externalUrl,
            internalUrl: p.internalUrl,
          },
        );
        if (dispoBaseUrl) {
          try {
            await syncProtokollTemplates(dispoBaseUrl);
          } catch (tplErr) {
            console.warn('Protokoll-Vorlagen Sync fehlgeschlagen (offline-Vorlagen weiter nutzbar):', tplErr.message);
          }
        }
        break;
      }
      case 'sync_pull': {
        const p = job.payload || {};
        const pair = normalizeDispoBasePair(p.externalUrl, p.internalUrl);
        let base = (p.baseUrl || pair.external || pair.internal || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technicianId, 10);
        const auth = authHeaderFromCredentials(p.serverUsername, p.serverPassword);
        const fetchHeaders = dispoMonteurFetchHeaders(technicianId, auth);
        if (pair.external && pair.internal) {
          const resolved = await resolveDispoWorkingBase({
            baseUrl: base,
            externalUrl: pair.external,
            internalUrl: pair.internal,
            technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
          });
          if (resolved.base) base = resolved.base;
        }
        if (p.serverUsername && p.serverPassword) {
          try {
            saveWebSession(DB_DIR, {
              dispo_username: String(p.serverUsername),
              dispo_password: String(p.serverPassword),
              dispo_base: base,
              dispo_external_url: p.externalUrl || pair.external || base,
              dispo_internal_url: p.internalUrl || pair.internal || '',
            });
          } catch (sessErr) {
            console.warn('[sync_pull] session persist:', sessErr && sessErr.message ? sessErr.message : sessErr);
          }
        }
        await dbLock.runWithDbLock(async () => {
          setProgress('sync_pull', 0, 8, 'Sende Status/Pending vor Pull …');
          try {
            await pushToServer(base, technicianId, db, auth, liveDispoCredsForPush(base, p));
            save();
          } catch (prePushErr) {
            console.warn(
              '[sync_pull] pre-pull-push:',
              prePushErr && prePushErr.message ? prePushErr.message : prePushErr,
            );
          }
        });
        await dbLock.runWithDbLock(async () => {
          setProgress('sync_pull', 1, 8, 'Ziehe Aufträge von Dispo …');
          const pullResult = await pullFromServer(base, technicianId, db, auth, p.date_from, p.date_to);
          if (pullResult && Array.isArray(pullResult.warnings) && pullResult.warnings.length) {
            console.warn('[sync_pull] jobs-warnings:', pullResult.warnings.join(' · '));
            setProgress(
              'sync_pull',
              1,
              8,
              'Aufträge gezogen (Warnung: ' + String(pullResult.warnings[0]).slice(0, 120) + ')',
            );
            if (typeof mergeCheckpoint === 'function') {
              mergeCheckpoint({
                pull_warnings: pullResult.warnings,
                pull_guard: pullResult.pull_guard || null,
              });
            }
          } else if (typeof mergeCheckpoint === 'function') {
            mergeCheckpoint({ pull_warnings: [], pull_guard: pullResult && pullResult.pull_guard ? pullResult.pull_guard : null });
          }
          save();
        });
        await dbLock.runWithDbLock(async () => {
          setProgress('sync_pull', 2, 8, 'Sende ausstehende Änderungen …');
          try {
            await pushToServer(base, technicianId, db, auth, liveDispoCredsForPush(base, p));
            save();
          } catch (pushErr) {
            console.warn(
              '[sync_pull] nach-pull-push:',
              pushErr && pushErr.message ? pushErr.message : pushErr,
            );
          }
        });
        setProgress('sync_pull', 3, 8, 'Kalender-Cache …');
        const range = defaultFutureRange();
        const cacheStart = p.date_from && String(p.date_from).trim() ? String(p.date_from).trim() : range.start;
        const cacheEnd = p.date_to && String(p.date_to).trim() ? String(p.date_to).trim() : range.end;
        let calendarCacheOk = false;
        let calendarCacheError = '';
        try {
          const calData = await fetchCalendarFromDispo(base, cacheStart, cacheEnd, auth);
          await dbLock.runWithDbLock(async () => {
            upsertCalendarCache(db, calData, { replaceAll: true });
            reconcileLocalJobsFromCalendarCache(db, technicianId, calData);
            save();
          });
          calendarCacheOk = true;
        } catch (calErr) {
          calendarCacheError = calErr && calErr.message ? String(calErr.message) : String(calErr || 'unbekannt');
          console.warn('[sync_pull] kalender:', calendarCacheError);
          try {
            await dbLock.runWithDbLock(async () => {
              const pruned = reconcileCalendarCacheAbsencesForTechnician(db, technicianId);
              if (pruned > 0) {
                console.log('[sync_pull] kalender-cache bereinigt (Monteur ' + technicianId + '): ' + pruned + ' veraltete Abwesenheit(en)');
                save();
              }
            });
          } catch (reconcileErr) {
            console.warn('[sync_pull] kalender-cache reconcile:', reconcileErr && reconcileErr.message ? reconcileErr.message : reconcileErr);
          }
        }
        if (typeof mergeCheckpoint === 'function') {
          mergeCheckpoint({
            calendar_cache_ok: calendarCacheOk,
            calendar_cache_error: calendarCacheOk ? '' : calendarCacheError,
          });
        }
        setProgress('sync_pull', 3, 8, 'TED-Index …');
        try {
          await syncTedIndexForTechnicianJobs(db, base, technicianId, fetchHeaders, signal, setProgress, dbLock);
        } catch (tedErr) {
          console.warn('[sync_pull] ted_index:', tedErr && tedErr.message ? tedErr.message : tedErr);
        }
        setProgress('sync_pull', 4, 8, 'TED-Excel in Projektordner …');
        try {
          const tedDl = await pullTedExcelFilesForTechnicianJobsInSync(
            base,
            technicianId,
            fetchHeaders,
            signal,
            setProgress,
            dbLock,
          );
          console.log(
            '[sync_pull] ted_files:',
            'jobs=' + (tedDl.attempted_jobs || tedDl.downloaded_jobs || 0),
            'files=' + (tedDl.files_downloaded || 0),
            'failed=' + (tedDl.files_failed || 0),
            'skip_no_folder=' + (tedDl.skipped_no_folder || 0),
          );
        } catch (tedDlErr) {
          console.warn('[sync_pull] ted_files:', tedDlErr && tedDlErr.message ? tedDlErr.message : tedDlErr);
        }
        setProgress('sync_pull', 5, 8, 'Protokoll-Vorlagen …');
        try {
          await syncProtokollTemplates(base);
        } catch (tplErr) {
          console.warn('Protokoll-Vorlagen Sync fehlgeschlagen:', tplErr.message);
        }
        try {
          await dbLock.runWithDbLock(async () => {
            await pullTextbausteineFromDispo(base, technicianId, db, auth);
            save();
          });
        } catch (tbErr) {
          console.warn('[sync_pull] textbausteine:', tbErr && tbErr.message ? tbErr.message : tbErr);
        }
        try {
          await dbLock.runWithDbLock(async () => {
            await pullArbeitsschritteFromDispo(base, technicianId, db, auth);
            save();
          });
        } catch (asErr) {
          console.warn('[sync_pull] arbeitsschritte:', asErr && asErr.message ? asErr.message : asErr);
        }
        await dbLock.runWithDbLock(async () => {
          setProgress('sync_pull', 6, 8, 'Projektordner (Änderungen) …');
          try {
            const openJobs = listLocalJobsForPeriodicDienstreisePull(technicianId);
            for (const row of openJobs) {
              enqueueDienstreisePushChanged(row.id, technicianId, base, p.serverUsername, p.serverPassword, {
                externalUrl: p.externalUrl,
                internalUrl: p.internalUrl,
              });
            }
          } catch (pushChangedErr) {
            console.warn(
              '[sync_pull] dienstreise_changed_push:',
              pushChangedErr && pushChangedErr.message ? pushChangedErr.message : pushChangedErr,
            );
          }
          try {
            const delta = enqueuePeriodicDienstreiseDeltaPulls({
              technicianId,
              dispoBaseUrl: base,
              externalUrl: p.externalUrl,
              internalUrl: p.internalUrl,
              dispoUsername: p.serverUsername,
              dispoPassword: p.serverPassword,
              force: true,
            });
            if (delta.enqueued > 0) {
              console.log('[sync_pull] dienstreise_delta enqueued:', delta.enqueued);
            }
          } catch (deltaErr) {
            console.warn(
              '[sync_pull] dienstreise_delta:',
              deltaErr && deltaErr.message ? deltaErr.message : deltaErr,
            );
          }
          if (hasPendingOrDirtyAnlagenstamm(db)) {
            console.log(
              '[sync_pull] anlagenstamm_db_sync mit lokalen Änderungen/Pending — Server-Daten werden ergänzt (dirty Zeilen bleiben erhalten)',
            );
          }
        });
        setProgress('anlagenstamm_db_sync', 0, 1, 'Anlagenstamm-Stammdaten …');
        try {
          await dbLock.runWithDbLock(async () => {
            prepareAnlagenstammSyncRun(db, { forceFull: !!p.forceAnlagenstammFull });
            save();
          });
          const syncResult = await syncAnlagenstammFromDispo(
            db,
            {
              baseUrl: base,
              externalUrl: p.externalUrl,
              internalUrl: p.internalUrl,
              technician_id: technicianId,
              serverUsername: p.serverUsername,
              serverPassword: p.serverPassword,
            },
            (prog) => {
              if (prog && prog.page && prog.totalPages) {
                const label =
                  (prog.resuming ? 'Fortsetzung ' : '') + 'Seite ' + prog.page + '/' + prog.totalPages;
                setProgress('anlagenstamm_db_sync', prog.page, prog.totalPages, label);
              }
            },
            { dbLock, save },
          );
          if (!syncResult.ok) {
            console.warn('[sync_pull] anlagenstamm_db_sync:', syncResult.error || 'fehlgeschlagen');
          } else if (syncResult.row_count != null || syncResult.skipped) {
            if (syncResult.skipped) {
              console.log(
                '[sync_pull] anlagenstamm_db_sync: Stammdaten übersprungen (TTL noch gültig)',
                syncResult.repaired ? ', lokale FN/Leistung-Korrektur: ' + syncResult.repaired : '',
              );
            } else {
              console.log(
                '[sync_pull] anlagenstamm_db_sync ok, Zeilen lokal:',
                syncResult.row_count,
                ', orphans entfernt:',
                syncResult.purged != null ? syncResult.purged : 0,
              );
            }
            await new Promise((r) => setImmediate(r));
            try {
              const pnTreeSync = await syncProjekteNeuTreesFromDispo(
                db,
                {
                  baseUrl: base,
                  externalUrl: p.externalUrl,
                  internalUrl: p.internalUrl,
                  technician_id: technicianId,
                  serverUsername: p.serverUsername,
                  serverPassword: p.serverPassword,
                },
                (prog) => {
                  if (prog && prog.page && prog.totalPages) {
                    const label =
                      (prog.resuming ? 'Fortsetzung ' : '') +
                      'PROJEKTE-NEU-Bäume ' +
                      prog.page +
                      '/' +
                      prog.totalPages;
                    setProgress('anlagenstamm_pn_tree', prog.page, prog.totalPages, label);
                  }
                },
                { dbLock, save },
              );
              if (pnTreeSync.ok) {
                if (pnTreeSync.skipped) {
                  console.log('[sync_pull] anlagenstamm_pn_tree: bereits vollständig, übersprungen');
                } else {
                  console.log(
                    '[sync_pull] anlagenstamm_pn_tree:',
                    pnTreeSync.written || 0,
                    'geschrieben,',
                    pnTreeSync.skipped || 0,
                    'unverändert, gesamt',
                    pnTreeSync.total_count || 0,
                  );
                }
                await dbLock.runWithDbLock(async () => {
                  finalizeAnlagenstammSyncRun(db);
                  save();
                });
              } else if (pnTreeSync._notFound) {
                console.warn(
                  '[sync_pull] anlagenstamm_pn_tree: DB-Export nicht verfügbar (Server-Update / anlagenstamm_pn_tree_export_chunk.php). Kein Dateisystem-Fallback im Sync.',
                );
              } else {
                console.warn('[sync_pull] anlagenstamm_pn_tree:', pnTreeSync.error || 'fehlgeschlagen');
              }
            } catch (pnErr) {
              console.warn('[sync_pull] anlagenstamm_pn_tree:', pnErr && pnErr.message ? pnErr.message : pnErr);
            }
          }
        } catch (syncErr) {
          console.warn('[sync_pull] anlagenstamm_db_sync:', syncErr && syncErr.message ? syncErr.message : syncErr);
        }
        try {
          const abSync = enqueueAbrechnungBackgroundSync({
            baseUrl: base,
            technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
          });
          if (abSync.enqueued > 0) {
            console.log('[sync_pull] abrechnung_refresh enqueued:', abSync.enqueued, abSync.periods);
          }
        } catch (abErr) {
          console.warn('[sync_pull] abrechnung_refresh:', abErr && abErr.message ? abErr.message : abErr);
        }
        try {
          await dbLock.runWithDbLock(async () => {
            await flushAbrechnungOutbox(
              { db, save, dbDir: DB_DIR, authHeaderFromCredentials },
              base,
              technicianId,
              p.serverUsername,
              p.serverPassword,
            );
            save();
          });
        } catch (flushErr) {
          console.warn(
            '[sync_pull] abrechnung_outbox_flush:',
            flushErr && flushErr.message ? flushErr.message : flushErr,
          );
        }
        break;
      }
      case 'anlagenstamm_db_sync': {
        const p = job.payload || {};
        const base = (p.baseUrl || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technicianId, 10);
        await dbLock.runWithDbLock(async () => {
          prepareAnlagenstammSyncRun(db, { forceFull: !!p.forceAnlagenstammFull });
          save();
        });
        const syncResult = await syncAnlagenstammFromDispo(
          db,
          {
            baseUrl: base,
            externalUrl: p.externalUrl,
            internalUrl: p.internalUrl,
            technician_id: technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
          },
          (prog) => {
            if (prog && prog.page && prog.totalPages) {
              const label =
                (prog.resuming ? 'Fortsetzung ' : '') + 'Seite ' + prog.page + '/' + prog.totalPages;
              setProgress('anlagenstamm_db_sync', prog.page, prog.totalPages, label);
            }
          },
          { dbLock, save },
        );
        if (!syncResult.ok) throw new Error(syncResult.error || 'Anlagenstamm-Sync fehlgeschlagen.');
        if (syncResult.skipped) {
          console.log(
            '[anlagenstamm_db_sync] Stammdaten übersprungen (TTL noch gültig)',
            syncResult.repaired ? ', lokale FN/Leistung-Korrektur: ' + syncResult.repaired : '',
          );
        } else {
          console.log(
            '[anlagenstamm_db_sync] ok, Zeilen lokal:',
            syncResult.row_count,
            ', orphans entfernt:',
            syncResult.purged != null ? syncResult.purged : 0,
          );
        }
        const auth = authHeaderFromCredentials(p.serverUsername, p.serverPassword);
        const fetchHeaders = dispoMonteurFetchHeaders(technicianId, auth);
        try {
          const pnTreeSync = await syncProjekteNeuTreesFromDispo(
            db,
            {
              baseUrl: base,
              externalUrl: p.externalUrl,
              internalUrl: p.internalUrl,
              technician_id: technicianId,
              serverUsername: p.serverUsername,
              serverPassword: p.serverPassword,
            },
            (prog) => {
              if (prog && prog.page && prog.totalPages) {
                const label =
                  (prog.resuming ? 'Fortsetzung ' : '') +
                  'PROJEKTE-NEU-Bäume ' +
                  prog.page +
                  '/' +
                  prog.totalPages;
                setProgress('anlagenstamm_pn_tree', prog.page, prog.totalPages, label);
              }
            },
            { dbLock, save },
          );
          if (pnTreeSync.ok) {
            await dbLock.runWithDbLock(async () => {
              finalizeAnlagenstammSyncRun(db);
              save();
            });
            console.log(
              '[anlagenstamm_db_sync] anlagenstamm_pn_tree:',
              pnTreeSync.written || 0,
              'geschrieben,',
              pnTreeSync.skipped || 0,
              'unverändert, gesamt',
              pnTreeSync.total_count || 0,
            );
          } else if (pnTreeSync._notFound) {
            console.warn(
              '[anlagenstamm_db_sync] anlagenstamm_pn_tree: DB-Export nicht verfügbar — kein Dateisystem-Fallback im Sync.',
            );
          } else {
            console.warn('[anlagenstamm_db_sync] anlagenstamm_pn_tree:', pnTreeSync.error || 'fehlgeschlagen');
          }
        } catch (pnErr) {
          console.warn('[anlagenstamm_db_sync] anlagenstamm_pn_tree:', pnErr && pnErr.message ? pnErr.message : pnErr);
        }
        setProgress('done', 1, 1, 'Anlagenstamm synchronisiert (' + (syncResult.row_count || 0) + ' Zeilen, PROJEKTE-NEU-Bäume abgeglichen).');
        break;
      }
      case 'sync_push': {
        const p = job.payload || {};
        const creds = resolveDispoServerCreds(p);
        const technicianId = parseInt(p.technicianId, 10);
        const auth = authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
        const resolved = await resolveDispoWorkingBase({
          baseUrl: p.baseUrl,
          externalUrl: creds.externalUrl || p.externalUrl,
          internalUrl: creds.internalUrl || p.internalUrl,
          technicianId,
          serverUsername: creds.serverUsername,
          serverPassword: creds.serverPassword,
        });
        const baseUrl = (resolved.base || '').trim().replace(/\/$/, '');
        if (!baseUrl) throw new Error(resolved.error || 'Dispo-Basis-URL fehlt.');
        setProgress('sync_push', 0, 2, 'Sende Änderungen zur Dispo …');
        await pushToServer(baseUrl, technicianId, db, auth, liveDispoCredsForPush(baseUrl, creds));
        setProgress('sync_push', 1, 2, 'Abrechnungs-Outbox …');
        try {
          await flushAbrechnungOutbox(
            { db, save, dbDir: DB_DIR, authHeaderFromCredentials },
            baseUrl,
            technicianId,
            creds.serverUsername,
            creds.serverPassword,
          );
        } catch (e) {
          console.warn('[abrechnung] flush after sync_push:', e && e.message ? e.message : e);
        }
        try {
          await flushZeitschreibungOutbox(db, baseUrl, auth, technicianId);
        } catch (e) {
          console.warn('[zeitschreibung] flush after sync_push:', e && e.message ? e.message : e);
        }
        try {
          await pullRecentLohnLocks(db, technicianId, baseUrl, auth);
        } catch (e) {
          console.warn('[zeitschreibung] pull Lohn-Locks after sync_push:', e && e.message ? e.message : e);
        }
        save();
        break;
      }
      case 'abrechnung_refresh': {
        const p = job.payload || {};
        setProgress('abrechnung_refresh', 0, 1, 'Abrechnung wird abgeglichen …');
        const result = await runAbrechnungRefreshCore(
          abrechnungRefreshCtx,
          {
            baseUrl: p.baseUrl,
            technicianId: p.technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
            period_ym: p.period_ym,
            job_server_id: p.job_server_id,
            sync_all_jobs: p.sync_all_jobs !== false,
          },
          (cur, tot, msg) => setProgress('abrechnung_refresh', cur, tot, msg || 'Abrechnung …'),
        );
        let msg = 'Abrechnung synchronisiert.';
        if (result.partial && result.warnings && result.warnings.length) msg += ' ' + result.warnings.join('; ');
        mergeCheckpoint({
          abrechnung_partial: !!result.partial,
          abrechnung_warnings: Array.isArray(result.warnings) ? result.warnings : [],
        });
        setProgress('done', 1, 1, msg);
        break;
      }
      default:
        throw new Error('Unbekannter Job-Typ (Runner): ' + job.type);
    }
  }

  bgJobs = createBackgroundJobService(db, save, { executeJob: executeBackgroundJob });
  monteurRuntime.bgJobs = bgJobs;
  bgJobs.markStaleRunningAsInterrupted();
  purgeOrphanReiseFolderBindings();
  const purgedMirrors = purgeUnassignedMirrorJobs(db);
  if (purgedMirrors) {
    save();
    console.log('[startup] unzugewiesene Spiegel-Aufträge entfernt:', purgedMirrors);
  }
  if (typeof bgJobs.purgeUnassignedDienstreisePullJobs === 'function') {
    bgJobs.purgeUnassignedDienstreisePullJobs();
  }
  if (typeof bgJobs.purgeNonInArbeitDienstreiseCopyPulls === 'function') {
    bgJobs.purgeNonInArbeitDienstreiseCopyPulls();
  }
  bgJobs.kick();

  function defaultAbrechnungSyncPeriods(extraYm) {
    const periods = [];
    if (extraYm && /^\d{4}-\d{2}$/.test(String(extraYm))) periods.push(String(extraYm));
    const now = new Date();
    for (let offset = 0; offset <= 1; offset += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!periods.includes(ym)) periods.push(ym);
    }
    return periods;
  }

  function enqueueAbrechnungBackgroundSync(opts) {
    opts = opts || {};
    if (!bgJobs) return { enqueued: 0, job_ids: [], periods: [] };
    const dispoBaseUrl = (opts.baseUrl || opts.dispoBaseUrl || '').trim().replace(/\/+$/, '');
    const technicianId = parseInt(opts.technicianId, 10);
    const serverUsername = (opts.serverUsername || '').trim();
    const serverPassword = opts.serverPassword != null ? String(opts.serverPassword) : '';
    const jobServerId = parseInt(opts.job_server_id, 10) || 0;
    if (!dispoBaseUrl || !Number.isFinite(technicianId) || technicianId <= 0) {
      return { enqueued: 0, job_ids: [], periods: [] };
    }
    const periods = defaultAbrechnungSyncPeriods(opts.period_ym);
    const job_ids = [];
    let enqueued = 0;
    for (const period of periods) {
      const dedupeKey = 'abrechnung_refresh:' + technicianId + ':' + period;
      const enq = bgJobs.enqueue(
        'abrechnung_refresh',
        {
          baseUrl: dispoBaseUrl,
          technicianId,
          serverUsername,
          serverPassword,
          period_ym: period,
          job_server_id: jobServerId,
          sync_all_jobs: opts.sync_all_jobs !== false,
        },
        dedupeKey,
      );
      if (enq && enq.job_id) {
        job_ids.push(enq.job_id);
        enqueued += 1;
      }
    }
    return { enqueued, job_ids, periods };
  }

  app.post('/api/abrechnung/schedule_refresh', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const creds = loadDispoWebSessionCreds();
      const baseUrl = (body.baseUrl || body.base_url || creds.baseUrl || '').trim();
      const technicianId = parseInt(
        body.technicianId != null
          ? body.technicianId
          : body.technician_id != null
            ? body.technician_id
            : getTechnicianId({ query: body, headers: req.headers }),
        10,
      );
      const result = enqueueAbrechnungBackgroundSync({
        baseUrl,
        technicianId,
        serverUsername: body.serverUsername || creds.serverUsername,
        serverPassword: body.serverPassword != null ? body.serverPassword : creds.serverPassword,
        period_ym: body.period_ym,
        job_server_id: body.job_server_id,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  async function enrichJobFabWithAnlagenstamm(job, baseUrl, authHeader, opts) {
    opts = opts || {};
    if (!job) return job;
    const localJobPk = job.id != null ? parseInt(job.id, 10) : NaN;
    if (Number.isFinite(localJobPk)) {
      const pendingFab = getPendingJobFabrikationsnummern(db, localJobPk);
      if (pendingFab !== undefined) {
        job = Object.assign({}, job, { fabrikationsnummern: pendingFab });
      }
    }
    if (typeof job.fabrikationsnummern !== 'string') return job;
    const fab = job.fabrikationsnummern.trim();
    if (!fab) return job;
    /** Anlagenstamm überschreibt Job-Stammdaten (Type/Leistung/…) – heilt vertauschte Types. */
    const jobRows = parseJobFabrikationsnummernRows(fab);
    const parts = jobRows.map((r) => normJobFabKey(r)).filter(Boolean);
    if (parts.length === 0) return job;
    ensureAnlagenstammLocalSchema(db);
    let data = { data: [] };
    let debugInfo = { requestedFabs: parts.slice(), ok: false, matchCount: 0, status: null, _source: null };
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const localOnly = !!opts.localOnly;
    const tryLocal = localOnly || anlagenstammLocalRowCount(db) > 0;
    if (tryLocal) {
      const localRows = anlagenstammGetRowsByFabs(db, parts);
      data = { data: localRows };
      debugInfo.ok = localRows.length > 0;
      debugInfo.matchCount = localRows.length;
      debugInfo._source = 'local';
    } else if (base && !localOnly) {
      const url = `${base}/dispo_api/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(parts.join(','))}`;
      debugInfo.url = url;
      try {
        const r = await fetch(url, authHeader ? { headers: authHeader } : {});
        data = await r.json().catch(() => ({}));
        debugInfo.ok = !!r.ok;
        debugInfo.status = r.status;
        debugInfo.matchCount = Array.isArray(data.data) ? data.data.length : 0;
        debugInfo._source = 'dispo';
      } catch (e) {
        return { ...job, _anlagenstamm_debug: debugInfo };
      }
    } else if (!tryLocal && !base) {
      return { ...job, _anlagenstamm_debug: debugInfo };
    }
    try {
      const byFab = {};
      if (Array.isArray(data.data)) {
        for (const row of data.data) {
          const key = String(row.fabrikationsnummer ?? '').trim();
          if (!key) continue;
          byFab[key] = row;
          for (const k of fabCacheLookupKeys(key)) {
            if (!byFab[k]) byFab[k] = row;
          }
        }
      }
      const newFabJson = JSON.stringify(
        jobRows.map((r) => {
          const fn = normJobFabKey(r);
          const apiRow = fn ? byFab[fn] || {} : {};
          const localRow = fn ? anlagenstammLookupByFab(db, fn) : null;
          const localDirty = localRow && Number(localRow.dirty) === 1 && hasNonemptyStammField(localRow);
          const jobRow = r && typeof r === 'object' ? r : { fabrikationsnummer: fn };
          // Unsynced Projektdaten-Edit nicht mit altem Stamm zurückschreiben.
          return mergeStammIntoJobRow(jobRow, apiRow, localRow, localDirty, {
            preferJob: pendingFab !== undefined && !localDirty,
          });
        }),
      );
      debugInfo.ok = true;
      const localPk = job.id != null ? parseInt(job.id, 10) : NaN;
      if (Number.isFinite(localPk) && newFabJson !== fab) {
        try {
          db.prepare(`UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now') WHERE id = ?`).run(
            newFabJson,
            localPk,
          );
        } catch (_) {
          /* Anzeige-Enrich trotzdem liefern */
        }
      }
      return { ...job, fabrikationsnummern: newFabJson, _anlagenstamm_debug: debugInfo };
    } catch (e) {
      debugInfo.error = e && e.message ? e.message : String(e);
    }
    return { ...job, _anlagenstamm_debug: debugInfo };
  }

  const DISPO_PROBE_TIMEOUT_MS = 10000;
  const DISPO_PROBE_LAN_MS = 12000;

  /** @param {number} status @param {string} body */
  function errorTextFromDispoBody(status, body) {
    let msg = 'HTTP ' + status;
    const bodyStr = body != null ? String(body) : '';
    try {
      const data = JSON.parse(bodyStr);
      if (data && typeof data.error === 'string' && data.error.trim()) {
        msg = data.error.trim();
        if (status === 403) msg = 'Monteur wird nicht anerkannt: ' + msg;
      }
    } catch (_) {
      if (status === 404 && bodyStr.length > 0) {
        msg = 'Pfad nicht gefunden (404).';
      }
      if (status === 500 && bodyStr.length > 0) {
        const snippet = bodyStr.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (/Fatal error|Parse error|Exception|Warning:/i.test(snippet)) {
          msg = 'Dispo-Server-Fehler (500). Vorschau: ' + snippet;
        }
      }
    }
    return msg;
  }

  async function errorTextFromDispoResponse(r) {
    const body = await r.text();
    return errorTextFromDispoBody(r.status, body);
  }

  /**
   * Erreichbarkeit: /api/my_jobs.php, sonst Folgeprobe dispo_api/jobs_open.
   * Ohne technician_id (Erstinstallation) gilt eine HTTP-Antwort der Dispo als erreichbar
   * — kein Fallback auf ID 1 (Admin, „Kein gültiger Monteur“).
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  async function probeDispoConnection(baseUrlRaw, technicianId, serverUsername, serverPassword, signal) {
    const urls = dispoProbeUrls(baseUrlRaw, technicianId);
    const base = urls.base;
    const hasTechnicianId = urls.technicianId != null;
    if (!base) {
      return { ok: false, error: 'Server-URL fehlt.' };
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const opts = auth ? { headers: auth, signal } : { signal };

    try {
      const rMy = await fetch(urls.myJobs, opts);
      const classMy = classifyDispoProbeStatus(rMy.status, hasTechnicianId);
      if (classMy === 'ok' || classMy === 'reachable') {
        await rMy.text().catch(() => '');
        return { ok: true };
      }
      if (classMy === 'auth') {
        const errMyJobs = await errorTextFromDispoResponse(rMy);
        return { ok: false, error: 'my_jobs: ' + errMyJobs };
      }

      const errMyJobs = await errorTextFromDispoResponse(rMy);

      const rOpen = await fetch(urls.jobsOpen, opts);
      const classOpen = classifyDispoProbeStatus(rOpen.status, hasTechnicianId);
      if (classOpen === 'ok') {
        const text = await rOpen.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : [];
        } catch (_) {
          return {
            ok: false,
            error: 'dispo_api/jobs_open: kein gültiges JSON. Zusätzlich my_jobs: ' + errMyJobs,
          };
        }
        if (Array.isArray(data)) return { ok: true };
        if (data && typeof data === 'object' && data.ok === false && data.error) {
          return { ok: false, error: String(data.error) };
        }
        return {
          ok: false,
          error: 'dispo_api/jobs_open: keine JSON-Liste. my_jobs: ' + errMyJobs,
        };
      }
      if (classOpen === 'reachable') {
        await rOpen.text().catch(() => '');
        return { ok: true };
      }
      const errOpen = await errorTextFromDispoResponse(rOpen);
      return {
        ok: false,
        error: 'my_jobs: ' + errMyJobs + ' · dispo_api/jobs_open: ' + errOpen,
      };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, error: 'Timeout nach ' + DISPO_PROBE_TIMEOUT_MS / 1000 + ' s (Dispo-Probe)' };
      }
      return { ok: false, error: formatFetchError(e, base) };
    }
  }

  /** Monteur-ID und Name aus Dispo-Login (HTTP Basic). */
  async function resolveMonteurFromDispoAuth(baseUrlRaw, serverUsername, serverPassword, signal) {
    const base = (baseUrlRaw || '').toString().trim().replace(/\/$/, '');
    const user = (serverUsername || '').toString().trim();
    const pass = serverPassword != null ? String(serverPassword) : '';
    if (!base || !user || !pass) {
      return { ok: false, error: 'Benutzername und Passwort erforderlich.' };
    }
    const auth = authHeaderFromCredentials(user, pass);
    const headers = Object.assign({ 'X-Technician-Id': '0' }, auth || {});
    if (auth && auth.Authorization) {
      headers['X-Kukla-Authorization'] = auth.Authorization;
    }
    const urls = [`${base}/dispo_api/api/monteur_auth.php`, `${base}/api/monteur_auth.php`];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers, signal });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data && data.ok === true && data.technician_id) {
          return {
            ok: true,
            technician_id: Number(data.technician_id),
            full_name: data.full_name != null ? String(data.full_name).trim() : '',
            username: data.username != null ? String(data.username).trim() : user,
            perm_admin: data.perm_admin === true || data.perm_admin === 1,
            alert_recipient: data.alert_recipient === true || data.alert_recipient === 1,
          };
        }
        if (r.status === 404) continue;
        if (r.status === 401 || r.status === 429) {
          return { ok: false, error: data && data.error ? String(data.error) : (r.status === 429 ? 'Konto gesperrt' : 'Anmeldung fehlgeschlagen') };
        }
        if (data && data.error) {
          return { ok: false, error: String(data.error) };
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          return { ok: false, error: 'Timeout nach ' + DISPO_PROBE_TIMEOUT_MS / 1000 + ' s (Login-Probe)' };
        }
      }
    }
    return { ok: false, error: 'monteur_auth nicht verfügbar' };
  }

  function upsertLocalMonteurProfile(profile) {
    const id = parseInt(profile.technician_id, 10);
    if (!Number.isFinite(id) || id <= 0) return;
    const fullName = (profile.full_name || '').toString().trim() || 'Monteur';
    const username = (profile.username || '').toString().trim() || 'tech_' + id;
    const permAdmin = profile.perm_admin === true || profile.perm_admin === 1 ? 1 : 0;
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (existing) {
      try {
        db.prepare('UPDATE users SET full_name = ?, username = ?, perm_admin = ? WHERE id = ?').run(fullName, username, permAdmin, id);
      } catch (e) {
        db.prepare('UPDATE users SET full_name = ?, username = ? WHERE id = ?').run(fullName, username, id);
      }
    } else {
      try {
        db.prepare('INSERT INTO users (id, username, full_name, role, active, perm_admin) VALUES (?, ?, ?, ?, ?, ?)').run(
          id,
          username,
          fullName,
          'monteur',
          1,
          permAdmin,
        );
      } catch (e) {
        db.prepare('INSERT INTO users (id, username, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run(
          id,
          username,
          fullName,
          'monteur',
          1,
        );
      }
    }
    try {
      if (profile.alert_recipient != null) {
        // lokal nur als Flag in settings speichern (keine extra Spalte nötig)
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
          'alert_recipient_' + id,
          profile.alert_recipient ? '1' : '0',
        );
      }
    } catch (e) {}
    save();
  }

  async function resolveDispoWorkingBase(opts) {
    const pair = normalizeDispoBasePair(opts && opts.externalUrl, opts && opts.internalUrl);
    let base = normalizeDispoBase(opts && opts.baseUrl) || pair.external || pair.internal;
    const technicianId = opts && opts.technicianId;
    const serverUsername = opts && opts.serverUsername;
    const serverPassword = opts && opts.serverPassword;

    async function probeUrl(url) {
      const { result } = await probeDispoBaseWithOptionalAuth(url, technicianId, serverUsername, serverPassword, {
        skipProfile: true,
      });
      return result;
    }

    if (pair.external && pair.internal) {
      const pick = await pickReachableDispoBase({
        externalUrl: pair.external,
        internalUrl: pair.internal,
        preferInternal: !(opts && opts.preferInternal === false),
        probe: probeUrl,
      });
      if (pick.ok && pick.selected_base_url) {
        return { base: pick.selected_base_url, pick };
      }
    }

    const candidates = buildDispoBaseCandidates({
      baseUrl: base,
      externalUrl: pair.external,
      internalUrl: pair.internal,
    });
    let lastErr = 'Keine erreichbare Dispo-URL.';
    for (const candidate of candidates) {
      const r = await probeUrl(candidate);
      if (r.ok) return { base: candidate, pick: null };
      if (r.error) lastErr = r.error;
    }
    return { base: '', pick: null, error: lastErr };
  }

  async function probeDispoBaseWithOptionalAuth(base, technicianId, serverUsername, serverPassword, opts) {
    const skipProfile = !!(opts && opts.skipProfile);
    const hasCreds =
      (serverUsername || '').toString().trim() !== '' &&
      serverPassword != null &&
      String(serverPassword) !== '';
    const ac = new AbortController();
    const probeMs = isPrivateLanHostname(safeHostname(base)) ? DISPO_PROBE_LAN_MS : DISPO_PROBE_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort(), probeMs);
    try {
      let probeTechId = technicianId;
      let profile = null;
      if (hasCreds && !skipProfile) {
        profile = await resolveMonteurFromDispoAuth(base, serverUsername, serverPassword, ac.signal);
        if (profile.ok && profile.technician_id) {
          probeTechId = profile.technician_id;
        }
      }
      const result = await probeDispoConnection(base, probeTechId, serverUsername, serverPassword, ac.signal);
      return { result, profile };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return {
          result: { ok: false, error: 'Timeout nach ' + probeMs / 1000 + ' s (Dispo-Probe)' },
          profile: null,
        };
      }
      return {
        result: { ok: false, error: e && e.message ? e.message : String(e) },
        profile: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  app.post('/api/check_connection', express.json(), async (req, res) => {
    const creds = resolveDispoServerCreds(req.body || {});
    const { baseUrl, externalUrl, internalUrl, technicianId } = req.body || {};
    const serverUsername = creds.serverUsername;
    const serverPassword = creds.serverPassword;
    const pair = normalizeDispoBasePair(externalUrl, internalUrl);
    const ext = pair.external;
    const int = pair.internal;
    const candidates = buildDispoBaseCandidates({ baseUrl, externalUrl: ext, internalUrl: int });
    if (candidates.length === 0) {
      return res.json({ ok: false, error: 'Server-URL fehlt.' });
    }
    let lastProfile = null;

    async function finishSuccess(base, profile) {
      if (serverUsername && serverPassword) {
        try {
          saveWebSession(DB_DIR, {
            dispo_username: String(serverUsername),
            dispo_password: String(serverPassword),
            dispo_base: base,
            dispo_external_url: ext || base,
            dispo_internal_url: int || '',
          });
        } catch (_) {
          /* ignore */
        }
      }
      const payload = { ok: true, used_base_url: base };
      if (profile && profile.ok) {
        try {
          upsertLocalMonteurProfile(profile);
        } catch (_) {}
        payload.technician_id = profile.technician_id;
        payload.full_name = profile.full_name;
        payload.username = profile.username;
        payload.perm_admin = !!profile.perm_admin;
        payload.alert_recipient = !!profile.alert_recipient || !!profile.perm_admin;
      }
      return res.json(payload);
    }

    const requestTechId = parseTechnicianId(technicianId);
    const hasLoginCreds =
      (serverUsername || '').toString().trim() !== '' &&
      serverPassword != null &&
      String(serverPassword) !== '';

    function finishAfterReachable(base, profile) {
      if (hasLoginCreds && !requestTechId && !(profile && profile.ok && profile.technician_id)) {
        return res.json({
          ok: false,
          used_base_url: base,
          error:
            (profile && profile.error) ||
            'Monteur-ID konnte nicht ermittelt werden (Dispo-Benutzername und Passwort prüfen).',
        });
      }
      return finishSuccess(base, profile);
    }

    if (ext && int) {
      const pick = await pickReachableDispoBase({
        externalUrl: ext,
        internalUrl: int,
        probe: async (base) => {
          const { result } = await probeDispoBaseWithOptionalAuth(
            base,
            technicianId,
            serverUsername,
            serverPassword,
            { skipProfile: true },
          );
          return result;
        },
      });
      if (pick.ok && pick.selected_base_url) {
        if (serverUsername && serverPassword) {
          const ac = new AbortController();
          const ms = isPrivateLanHostname(safeHostname(pick.selected_base_url))
            ? DISPO_PROBE_LAN_MS
            : DISPO_PROBE_TIMEOUT_MS;
          const timer = setTimeout(() => ac.abort(), ms);
          try {
            lastProfile = await resolveMonteurFromDispoAuth(
              pick.selected_base_url,
              serverUsername,
              serverPassword,
              ac.signal,
            );
          } catch (_) {
            lastProfile = null;
          } finally {
            clearTimeout(timer);
          }
        }
        return finishAfterReachable(pick.selected_base_url, lastProfile);
      }
      const failPayload = { ok: false, error: pick.error || 'Verbindung fehlgeschlagen' };
      if (lastProfile && lastProfile.ok && lastProfile.technician_id) {
        try {
          upsertLocalMonteurProfile(lastProfile);
        } catch (_) {}
        failPayload.technician_id = lastProfile.technician_id;
        failPayload.full_name = lastProfile.full_name;
        failPayload.username = lastProfile.username;
        failPayload.perm_admin = !!lastProfile.perm_admin;
        failPayload.alert_recipient = !!lastProfile.alert_recipient || !!lastProfile.perm_admin;
      }
      return res.json(failPayload);
    }

    let lastErr = 'Verbindung fehlgeschlagen';
    for (const base of candidates) {
      const { result, profile } = await probeDispoBaseWithOptionalAuth(
        base,
        technicianId,
        serverUsername,
        serverPassword,
        { skipProfile: true },
      );
      if (profile && profile.ok && profile.technician_id) lastProfile = profile;
      if (result.ok) {
        if (serverUsername && serverPassword && !(lastProfile && lastProfile.ok)) {
          const ac = new AbortController();
          const ms = isPrivateLanHostname(safeHostname(base)) ? DISPO_PROBE_LAN_MS : DISPO_PROBE_TIMEOUT_MS;
          const timer = setTimeout(() => ac.abort(), ms);
          try {
            lastProfile = await resolveMonteurFromDispoAuth(base, serverUsername, serverPassword, ac.signal);
          } catch (_) {
            lastProfile = null;
          } finally {
            clearTimeout(timer);
          }
        }
        return finishAfterReachable(base, lastProfile && lastProfile.ok ? lastProfile : profile);
      }
      lastErr = result.error || lastErr;
    }
    const failPayload = { ok: false, error: lastErr };
    if (lastProfile && lastProfile.ok && lastProfile.technician_id) {
      try {
        upsertLocalMonteurProfile(lastProfile);
      } catch (_) {}
      failPayload.technician_id = lastProfile.technician_id;
      failPayload.full_name = lastProfile.full_name;
      failPayload.username = lastProfile.username;
      failPayload.perm_admin = !!lastProfile.perm_admin;
      failPayload.alert_recipient = !!lastProfile.alert_recipient || !!lastProfile.perm_admin;
    }
    return res.json(failPayload);
  });

  /** Monteur-ID/Name nur aus Dispo-Login (ohne jobs_open/my_jobs-Probe). */
  app.post('/api/monteur_profile', express.json(), async (req, res) => {
    const creds = resolveDispoServerCreds(req.body || {});
    const { baseUrl, externalUrl, internalUrl } = req.body || {};
    const serverUsername = creds.serverUsername;
    const serverPassword = creds.serverPassword;
    const pair = normalizeDispoBasePair(externalUrl, internalUrl);
    const candidates = buildDispoBaseCandidates({
      baseUrl,
      externalUrl: pair.external,
      internalUrl: pair.internal,
    });
    if (candidates.length === 0) {
      return res.json({ ok: false, error: 'Server-URL fehlt.' });
    }
    const user = (serverUsername || '').toString().trim();
    if (!user) {
      return res.json({ ok: false, error: 'Benutzername fehlt.' });
    }
    async function authProfileOnBase(base) {
      const ac = new AbortController();
      const ms = isPrivateLanHostname(safeHostname(base))
        ? DISPO_PROBE_LAN_MS
        : DISPO_PROBE_TIMEOUT_MS;
      const timer = setTimeout(() => ac.abort(), ms);
      try {
        return await resolveMonteurFromDispoAuth(base, serverUsername, serverPassword, ac.signal);
      } finally {
        clearTimeout(timer);
      }
    }

    if (pair.external && pair.internal) {
      const pick = await pickReachableDispoBase({
        externalUrl: pair.external,
        internalUrl: pair.internal,
        probe: async (url) => {
          const { result } = await probeDispoBaseWithOptionalAuth(
            url,
            null,
            serverUsername,
            serverPassword,
            { skipProfile: true },
          );
          return result;
        },
      });
      if (pick.ok && pick.selected_base_url) {
        try {
          const profile = await authProfileOnBase(pick.selected_base_url);
          if (profile.ok && profile.technician_id) {
            try {
              upsertLocalMonteurProfile(profile);
            } catch (_) {}
            return res.json({
              ok: true,
              used_base_url: pick.selected_base_url,
              technician_id: profile.technician_id,
              full_name: profile.full_name,
              username: profile.username,
            });
          }
          return res.json({ ok: false, error: profile.error || 'Login fehlgeschlagen' });
        } catch (e) {
          const msg =
            e && e.name === 'AbortError'
              ? 'Timeout (Login)'
              : e && e.message
                ? e.message
                : String(e);
          return res.json({ ok: false, error: msg });
        }
      }
      if (!pick.ok && pick.error) {
        return res.json({ ok: false, error: pick.error });
      }
    }

    let lastErr = 'Profil nicht ermittelt';
    for (const base of candidates) {
      try {
        const profile = await authProfileOnBase(base);
        if (profile.ok && profile.technician_id) {
          try {
            upsertLocalMonteurProfile(profile);
          } catch (_) {}
          return res.json({
            ok: true,
            used_base_url: base,
            technician_id: profile.technician_id,
            full_name: profile.full_name,
            username: profile.username,
          });
        }
        lastErr = profile.error || lastErr;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          lastErr = 'Timeout (Login-Probe)';
        } else {
          lastErr = e && e.message ? e.message : lastErr;
        }
      }
    }
    return res.json({ ok: false, error: lastErr });
  });

  async function proxyDispoServerMaintenanceRequest(req, relativePath, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const method = (o.method || 'GET').toUpperCase();
    const creds = resolveDispoServerCreds(req.body || {});
    const incomingAuth = authHeaderFromIncomingBasicOrQuery(req);
    const serverUsername =
      (creds.serverUsername || '').trim() ||
      (incomingAuth && incomingAuth.Authorization
        ? Buffer.from(String(incomingAuth.Authorization).replace(/^\s*Basic\s+/i, ''), 'base64')
            .toString('utf8')
            .split(':')[0]
        : '');
    const serverPassword =
      creds.serverPassword ||
      (incomingAuth && incomingAuth.Authorization
        ? (function () {
            const decoded = Buffer.from(
              String(incomingAuth.Authorization).replace(/^\s*Basic\s+/i, ''),
              'base64',
            ).toString('utf8');
            const colon = decoded.indexOf(':');
            return colon >= 0 ? decoded.slice(colon + 1) : '';
          })()
        : '');
    const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
    if (!authHeader || !authHeader.Authorization) {
      return { ok: false, status: 401, error: 'Dispo-Zugangsdaten fehlen.' };
    }
    const technicianId = getTechnicianId(req);
    const resolved = await resolveDispoWorkingBase({
      baseUrl: creds.baseUrl,
      externalUrl: creds.externalUrl,
      internalUrl: creds.internalUrl,
      technicianId,
      serverUsername,
      serverPassword,
    });
    if (!resolved.base) {
      return { ok: false, status: 502, error: resolved.error || 'Dispo nicht erreichbar.' };
    }
    const url = resolved.base.replace(/\/$/, '') + relativePath;
    const headers = dispoMonteurFetchHeaders(technicianId, authHeader);
    const fetchOpts = { method, headers };
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(o.body);
    }
    const r = await fetch(url, fetchOpts);
    const data = await r.json().catch(function () {
      return {};
    });
    return {
      ok: r.ok,
      status: r.status,
      data,
      base: resolved.base,
      serverUsername,
      serverPassword,
    };
  }

  async function resolveServerRebootAllowed(req, credsUsername) {
    const cached = readServerRebootPolicyCache();
    const username = String(credsUsername || '').trim();
    if (cached && !isServerRebootPolicyCacheStale(cached) && isUserAllowedByRebootPolicy(cached, username)) {
      return {
        allowed: true,
        reboot_enabled: cached.reboot_enabled !== false,
        source: 'cache',
        stale: false,
        policy: cached,
      };
    }
    const eligible = await proxyDispoServerMaintenanceRequest(req, '/api/server_reboot_eligible.php');
    if (eligible.ok && eligible.data && eligible.data.ok && eligible.data.is_allowed) {
      return {
        allowed: true,
        reboot_enabled: eligible.data.reboot_enabled !== false,
        source: 'eligible',
        stale: cached ? isServerRebootPolicyCacheStale(cached) : true,
        policy: cached,
      };
    }
    if (cached && isUserAllowedByRebootPolicy(cached, username)) {
      return {
        allowed: true,
        reboot_enabled: cached.reboot_enabled !== false,
        source: 'cache',
        stale: isServerRebootPolicyCacheStale(cached),
        policy: cached,
      };
    }
    return {
      allowed: false,
      reboot_enabled: cached ? cached.reboot_enabled !== false : false,
      source: cached ? 'cache' : 'none',
      stale: cached ? isServerRebootPolicyCacheStale(cached) : true,
      policy: cached,
      error:
        (eligible.data && eligible.data.error) ||
        eligible.error ||
        'Keine Berechtigung fuer Server-Reboot.',
    };
  }

  app.get('/api/server/reboot_policy', async (req, res) => {
    try {
      const proxied = await proxyDispoServerMaintenanceRequest(req, '/api/server_reboot_policy.php');
      if (!proxied.ok) {
        const cached = readServerRebootPolicyCache();
        if (cached) {
          const creds = resolveDispoServerCreds({});
          const incomingAuth = authHeaderFromIncomingBasicOrQuery(req);
          let username = (creds.serverUsername || '').trim();
          if (!username && incomingAuth && incomingAuth.Authorization) {
            const decoded = Buffer.from(
              String(incomingAuth.Authorization).replace(/^\s*Basic\s+/i, ''),
              'base64',
            ).toString('utf8');
            const colon = decoded.indexOf(':');
            username = colon >= 0 ? decoded.slice(0, colon) : decoded;
          }
          return res.json({
            ok: true,
            from_cache: true,
            stale: isServerRebootPolicyCacheStale(cached),
            sync_version: cached.sync_version,
            reboot_enabled: cached.reboot_enabled,
            allowed_usernames: cached.allowed_usernames || [],
            is_allowed_for_current_user: isUserAllowedByRebootPolicy(cached, username),
            cached_at: cached.cached_at,
            proxy_error: proxied.data && proxied.data.error ? proxied.data.error : proxied.error,
          });
        }
        return res.status(proxied.status || 502).json({
          ok: false,
          error: (proxied.data && proxied.data.error) || proxied.error || 'Policy-Sync fehlgeschlagen.',
        });
      }
      const data = proxied.data && typeof proxied.data === 'object' ? proxied.data : {};
      if (data.ok) {
        writeServerRebootPolicyCache(data);
      }
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/server/reboot_allowed', async (req, res) => {
    try {
      const creds = resolveDispoServerCreds({});
      const incomingAuth = authHeaderFromIncomingBasicOrQuery(req);
      let username = (creds.serverUsername || '').trim();
      if (!username && incomingAuth && incomingAuth.Authorization) {
        const decoded = Buffer.from(
          String(incomingAuth.Authorization).replace(/^\s*Basic\s+/i, ''),
          'base64',
        ).toString('utf8');
        const colon = decoded.indexOf(':');
        username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      }
      const verdict = await resolveServerRebootAllowed(req, username);
      return res.json({
        ok: true,
        allowed: !!verdict.allowed && verdict.reboot_enabled !== false,
        reboot_enabled: verdict.reboot_enabled !== false,
        source: verdict.source,
        stale: !!verdict.stale,
        cached_at: verdict.policy && verdict.policy.cached_at ? verdict.policy.cached_at : null,
        error: verdict.allowed ? null : verdict.error || null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/server/health', async (req, res) => {
    try {
      const proxied = await proxyDispoServerMaintenanceRequest(req, '/api/server_health_ping.php');
      if (!proxied.ok) {
        return res.status(proxied.status || 502).json({
          ok: false,
          error: (proxied.data && proxied.data.error) || proxied.error || 'Health-Check fehlgeschlagen.',
        });
      }
      return res.json(proxied.data || { ok: false, error: 'Leere Antwort.' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/server/reboot', express.json(), async (req, res) => {
    try {
      const creds = resolveDispoServerCreds(req.body || {});
      const incomingAuth = authHeaderFromIncomingBasicOrQuery(req);
      let username = (creds.serverUsername || '').trim();
      if (!username && incomingAuth && incomingAuth.Authorization) {
        const decoded = Buffer.from(
          String(incomingAuth.Authorization).replace(/^\s*Basic\s+/i, ''),
          'base64',
        ).toString('utf8');
        const colon = decoded.indexOf(':');
        username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      }
      const verdict = await resolveServerRebootAllowed(req, username);
      if (!verdict.allowed) {
        return res.status(403).json({
          ok: false,
          error: verdict.error || 'Keine Berechtigung fuer Server-Reboot.',
        });
      }
      if (verdict.reboot_enabled === false) {
        return res.status(403).json({
          ok: false,
          error: 'Server-Reboot ist auf dem Server deaktiviert.',
        });
      }
      const proxied = await proxyDispoServerMaintenanceRequest(req, '/api/server_reboot.php', {
        method: 'POST',
        body: req.body && typeof req.body === 'object' ? req.body : {},
      });
      if (!proxied.ok) {
        return res.status(proxied.status || 502).json({
          ok: false,
          error: (proxied.data && proxied.data.error) || proxied.error || 'Reboot fehlgeschlagen.',
          details: proxied.data || null,
        });
      }
      return res.json(proxied.data || { ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  function formatBytesHuman(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function getLocalDbStats() {
    // Kein wal_checkpoint: TRUNCATE während Sync blockiert den Electron-Hauptprozess.
    let size = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const p = DB_PATH + suffix;
      try {
        if (fs.existsSync(p)) size += fs.statSync(p).size;
      } catch (_) { /* ignore */ }
    }
    return {
      db_path: DB_PATH,
      db_size_bytes: size,
      db_size_human: formatBytesHuman(size),
    };
  }

  function dirSizeBytesRecursive(root, depth) {
    if (!root || !fs.existsSync(root) || depth > 10) return 0;
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      return 0;
    }
    for (const ent of entries) {
      const p = path.join(root, ent.name);
      try {
        if (ent.isDirectory()) total += dirSizeBytesRecursive(p, depth + 1);
        else if (ent.isFile()) total += fs.statSync(p).size;
      } catch (_) {}
    }
    return total;
  }

  function getDienstreiseFilesStats() {
    const base = getDienstreiseBasePath();
    if (!base) {
      return { configured: false, bytes: 0, human: '—', base_path: '' };
    }
    hangDiag.setDiskRoot(base);
    return {
      configured: true,
      bytes: 0,
      human: '—',
      base_path: base,
    };
  }

  app.get('/api/sync_status', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const lastPull = db
        .prepare(
          `SELECT updated_at, status, error, message, checkpoint_json FROM background_jobs
           WHERE type = 'sync_pull' AND status IN ('completed', 'failed', 'interrupted')
           ORDER BY datetime(updated_at) DESC LIMIT 1`,
        )
        .get();
      let pullWarnings = [];
      if (lastPull && lastPull.checkpoint_json) {
        try {
          const chk = JSON.parse(lastPull.checkpoint_json);
          if (chk && Array.isArray(chk.pull_warnings)) pullWarnings = chk.pull_warnings;
        } catch (_) { /* ignore */ }
      }
      const running = db
        .prepare(
          `SELECT id, type, status, progress_phase, message FROM background_jobs
           WHERE status IN ('queued', 'running') ORDER BY datetime(updated_at) DESC LIMIT 5`,
        )
        .all();
      const pendingN = db.prepare(`SELECT COUNT(*) AS n FROM pending_changes`).get();
      let pendingLastError = null;
      let pendingSummary = '';
      try {
        const errRow = db
          .prepare(
            `SELECT last_error FROM pending_changes
             WHERE last_error IS NOT NULL AND TRIM(last_error) != ''
             ORDER BY datetime(COALESCE(last_attempt_at, created_at)) DESC LIMIT 1`,
          )
          .get();
        pendingLastError = errRow && errRow.last_error ? String(errRow.last_error).slice(0, 280) : null;
        const groups = db
          .prepare(`SELECT entity_type, action, COUNT(*) AS n FROM pending_changes GROUP BY entity_type, action`)
          .all();
        pendingSummary = (groups || [])
          .map((g) => String(g.n) + '× ' + String(g.entity_type || '?') + '/' + String(g.action || '?'))
          .join(', ');
      } catch (_) {
        pendingLastError = null;
        pendingSummary = '';
      }
      let pendingItems = [];
      let pendingFailedCount = 0;
      let pendingFailedPreview = [];
      try {
        pendingItems = db
          .prepare(
            `SELECT id, entity_type, entity_id, action, attempts, last_error, last_attempt_at, created_at
             FROM pending_changes ORDER BY id DESC LIMIT 20`,
          )
          .all();
      } catch (_) {
        pendingItems = [];
      }
      try {
        const failedN = db.prepare('SELECT COUNT(*) AS n FROM pending_changes_failed').get();
        pendingFailedCount = failedN && failedN.n != null ? Number(failedN.n) : 0;
        pendingFailedPreview = db
          .prepare(
            `SELECT entity_type, entity_id, action, attempts, last_error, fail_reason, failed_at
             FROM pending_changes_failed ORDER BY id DESC LIMIT 10`,
          )
          .all();
      } catch (_) {
        pendingFailedCount = 0;
        pendingFailedPreview = [];
      }
      const lastPush = db
        .prepare(
          `SELECT updated_at, status, error, message FROM background_jobs
           WHERE type = 'sync_push' AND status IN ('completed', 'failed', 'interrupted')
           ORDER BY datetime(updated_at) DESC LIMIT 1`,
        )
        .get();
      let pendingUploadsN = 0;
      try {
        const upRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM dienstreise_push_cache
             WHERE synced_at IS NULL OR local_mtime_ms != synced_mtime_ms OR local_size != synced_size`,
          )
          .get();
        pendingUploadsN = upRow && upRow.n != null ? Number(upRow.n) : 0;
      } catch (_) {}
      const calRow = db
        .prepare(`SELECT MAX(synced_at) AS synced_at FROM calendar_cache_jobs`)
        .get();
      const stammN = db.prepare(`SELECT COUNT(*) AS n FROM anlagenstamm_local`).get();
      let anlagenSyncState = null;
      try {
        anlagenSyncState = getAnlagenstammSyncResumeState(db);
      } catch (_) {}
      const highPri = bgJobs ? bgJobs.countQueuedHighPriority() : 0;
      const dbStats = getLocalDbStats();
      const dienstreiseStats = getDienstreiseFilesStats();
      const lastJobsSync = lastPull && lastPull.updated_at ? lastPull.updated_at : null;
      const deviceId =
        multiDeviceApi && multiDeviceApi.deviceId ? multiDeviceApi.deviceId() : null;
      const conflicts =
        multiDeviceApi && multiDeviceApi.listRecentConflicts
          ? multiDeviceApi.listRecentConflicts(20)
          : [];
      const pendingCleanup =
        multiDeviceApi && multiDeviceApi.listPendingLocalCleanup
          ? multiDeviceApi.listPendingLocalCleanup()
          : [];
      return res.json({
        ok: true,
        technician_id: technicianId,
        device_id: deviceId,
        last_sync_pull: lastPull
          ? {
              updated_at: lastPull.updated_at,
              status: lastPull.status,
              error: lastPull.error,
              message: lastPull.message || null,
              pull_warnings: pullWarnings,
            }
          : null,
        last_jobs_sync: lastJobsSync,
        last_sync_push: lastPush
          ? {
              updated_at: lastPush.updated_at,
              status: lastPush.status,
              error: lastPush.error,
              message: lastPush.message || null,
            }
          : null,
        active_jobs: running || [],
        pending_changes: pendingN && pendingN.n != null ? Number(pendingN.n) : 0,
        pending_uploads: pendingUploadsN,
        pending_events: pendingN && pendingN.n != null ? Number(pendingN.n) : 0,
        pending_last_error: pendingLastError,
        pending_summary: pendingSummary,
        pending_items: pendingItems || [],
        pending_failed_count: pendingFailedCount,
        pending_failed_preview: pendingFailedPreview || [],
        calendar_cache_synced_at: calRow && calRow.synced_at ? calRow.synced_at : null,
        anlagenstamm_local_count: stammN && stammN.n != null ? Number(stammN.n) : 0,
        anlagenstamm_sync_state: anlagenSyncState || null,
        high_priority_jobs: highPri,
        db_path: dbStats.db_path,
        db_size_bytes: dbStats.db_size_bytes,
        db_size_human: dbStats.db_size_human,
        dienstreise_files_cache_bytes: dienstreiseStats.bytes,
        dienstreise_files_cache_human: dienstreiseStats.human,
        dienstreise_files_configured: dienstreiseStats.configured,
        dienstreise_base_path: dienstreiseStats.base_path || null,
        conflicts,
        jobs_pending_local_cleanup: pendingCleanup,
        peer_count: null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/hang_diag', (_req, res) => {
    try {
      const snap = hangDiag.snapshot();
      return res.json(Object.assign({ ok: true }, snap));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/offline_manifest', (req, res) => {
    try {
      const rawJobId = parseInt(req.query.job_id, 10);
      if (!rawJobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const jobRow = getJobRowWithStatusByLocalOrServerId(rawJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const localJobId = jobRow.id;
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      const pull = db
        .prepare(
          `SELECT id, status, progress_phase, progress_current, progress_total, message, updated_at
           FROM background_jobs WHERE type = 'dienstreise_pull' AND dedupe_key LIKE ?
           ORDER BY datetime(updated_at) DESC LIMIT 1`,
        )
        .get('dienstreise_pull:' + localJobId + ':%');
      const tedRows = db
        .prepare(`SELECT rel_path, file_name, fab, synced_at FROM job_ted_index WHERE local_job_id = ?`)
        .all(localJobId);
      let projekteNeuEnabled = false;
      const fabs = String(jobRow.fabrikationsnummern || '')
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const fab of fabs) {
        const cached = readAnlagenstammTreeCache(db, fab);
        if (cached && cached.tree && cached.tree.length) {
          projekteNeuEnabled = true;
          break;
        }
      }
      let fileCount = 0;
      if (reiseDir && fs.existsSync(reiseDir)) {
        try {
          const walk = (dir, depth) => {
            if (depth > 12) return;
            const names = fs.readdirSync(dir);
            for (const name of names) {
              if (isIgnorableDirEntry(name)) continue;
              const full = path.join(dir, name);
              try {
                const st = fs.statSync(full);
                if (st.isFile()) fileCount += 1;
                else if (st.isDirectory()) walk(full, depth + 1);
              } catch (_) {}
            }
          };
          walk(reiseDir, 0);
        } catch (_) {}
      }
      return res.json({
        ok: true,
        local_job_id: localJobId,
        status: jobRow.status,
        reise_dir: reiseDir || '',
        reise_dir_exists: !!(reiseDir && fs.existsSync(reiseDir)),
        project_file_count: fileCount,
        dienstreise_pull: pull || null,
        ted_files: tedRows || [],
        projekte_neu_cached: projekteNeuEnabled,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Zwei Basis-URLs (extern/intern): parallel prüfen, bei beidem OK interne wählen (10 s Timeout pro Probe). */
  app.post('/api/dispo_pick_base', express.json(), async (req, res) => {
    const { externalUrl, internalUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    const pair = normalizeDispoBasePair(externalUrl, internalUrl);
    try {
      const pick = await pickReachableDispoBase({
        externalUrl: pair.external,
        internalUrl: pair.internal,
        probe: (url) => {
          const ac = new AbortController();
          const probeMs = isPrivateLanHostname(safeHostname(url)) ? DISPO_PROBE_LAN_MS : DISPO_PROBE_TIMEOUT_MS;
          const timer = setTimeout(() => ac.abort(), probeMs);
          return probeDispoConnection(url, technicianId, serverUsername, serverPassword, ac.signal).finally(() =>
            clearTimeout(timer),
          );
        },
      });
      return res.json(pick);
    } catch (e) {
      return res.json({ ok: false, error: e.message || String(e), tried: [] });
    }
  });

  app.post('/api/sync_pull', express.json(), async (req, res) => {
    const body = req.body || {};
    const pair = normalizeDispoBasePair(body.externalUrl, body.internalUrl);
    const baseUrl = (
      body.baseUrl ||
      body.base_url ||
      pair.external ||
      pair.internal ||
      ''
    )
      .toString()
      .trim();
    const technicianId = parseInt(body.technicianId ?? body.technician_id, 10);
    const { serverUsername, serverPassword, date_from, date_to } = body;
    const forceAnlagenstammFull =
      body.forceAnlagenstammFull === true ||
      body.force_anlagenstamm_full === true ||
      body.forceAnlagenstammFull === 1 ||
      body.force_anlagenstamm_full === 1;
    if (!baseUrl || !Number.isFinite(technicianId) || technicianId <= 0) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
    }
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      bgJobs.reapStuckJobs();
      const base = (baseUrl || '').trim().replace(/\/$/, '');
      const tid = parseInt(technicianId, 10);
      const dedupeKey = 'sync_pull:' + tid + ':' + fingerprintDispoBase(base);
      const { job_id } = bgJobs.enqueue(
        'sync_pull',
        {
          baseUrl: base,
          externalUrl: pair.external,
          internalUrl: pair.internal,
          technicianId: tid,
          serverUsername,
          serverPassword,
          date_from,
          date_to,
          forceAnlagenstammFull,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/sync_push', express.json(), (req, res) => {
    const body = req.body || {};
    const pair = normalizeDispoBasePair(body.externalUrl, body.internalUrl);
    const baseUrl = (
      body.baseUrl ||
      body.base_url ||
      pair.external ||
      pair.internal ||
      ''
    )
      .toString()
      .trim();
    const technicianId = parseInt(body.technicianId ?? body.technician_id, 10);
    const { serverUsername, serverPassword } = body;
    if (!baseUrl || !Number.isFinite(technicianId) || technicianId <= 0) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
    }
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const base = (baseUrl || '').trim().replace(/\/$/, '');
      const tid = parseInt(technicianId, 10);
      const dedupeKey = 'sync_push:' + tid + ':' + fingerprintDispoBase(base);
      const { job_id } = bgJobs.enqueue(
        'sync_push',
        {
          baseUrl: base,
          externalUrl: pair.external,
          internalUrl: pair.internal,
          technicianId: tid,
          serverUsername,
          serverPassword,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      logSyncPushError(Object.assign({ reason: 'enqueue_fehler', message: e.message }));
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/background_jobs', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const { type, payload, dedupe_key } = req.body || {};
      const { job_id } = bgJobs.enqueue(type, payload || {}, dedupe_key || null);
      return res.status(202).json({ ok: true, job_id });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/background_jobs/recover', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const body = req.body || {};
      const skipAcceptJob = body.skipAcceptJob !== false;
      const r = bgJobs.recoverPullJobs({ skipAcceptJob });
      return res.json({ ok: true, reopened: r.reopened });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/background_jobs/reap', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      bgJobs.reapStuckJobs();
      bgJobs.kick();
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/background_jobs', (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      bgJobs.reapStuckJobs();
      bgJobs.kick();
      const runningOnly = req.query.running === '1' || req.query.running === 'true';
      const activeOnly = !runningOnly && (req.query.active === '1' || req.query.active === 'true');
      const jobs = bgJobs.listJobs(req.query.limit, { activeOnly, runningOnly });
      return res.json({ ok: true, jobs });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/background_jobs/:id', (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const job = bgJobs.getJob(req.params.id);
      if (!job) return res.status(404).json({ ok: false, error: 'Job nicht gefunden.' });
      return res.json({ ok: true, job });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/background_jobs/:id/cancel', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const x = bgJobs.cancelJob(req.params.id);
      if (!x.ok) return res.status(400).json({ ok: false, error: x.error });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/calendar', async (req, res) => {
    const baseUrl = (req.query.baseUrl || req.query.base_url || '').toString().trim().replace(/\/$/, '');
    const start = (req.query.start || '').toString().trim();
    const end = (req.query.end || '').toString().trim();
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: 'start und end erforderlich.' });
    }
    if (!baseUrl) {
      return res.redirect(307, `/api/calendar_cached?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/calendar.php?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      if (!r.ok) throw new Error('Calendar API: ' + r.status);
      const data = await r.json();
      res.json(data);
    } catch (e) {
      if (isLikelyOfflineSyncError(e)) {
        return res.redirect(307, `/api/calendar_cached?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/calendar', express.json(), async (req, res) => {
    const { baseUrl: rawUrl, start, end, serverUsername, serverPassword, skipJobEnrich } = req.body || {};
    const baseUrl = (rawUrl || '').toString().trim().replace(/\/$/, '');
    const s = (start || '').toString().trim();
    const e = (end || '').toString().trim();
    if (!s || !e) {
      return res.status(400).json({ ok: false, error: 'start und end erforderlich.' });
    }
    if (!baseUrl) {
      try {
        const payload = readCalendarCachePayload(db, s, e, getTechnicianId(req));
        return res.json(Object.assign({ ok: true, data_source: 'cache' }, payload));
      } catch (cacheErr) {
        return res.status(503).json({ ok: false, error: cacheErr.message || 'Kein Kalender-Cache' });
      }
    }
    try {
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const opts = auth ? { headers: auth } : {};
      const r = await fetch(`${baseUrl}/api/calendar.php?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`, opts);
      if (!r.ok) throw new Error('Calendar API: ' + r.status);
      const data = await r.json();

      // Jobs anreichern: Firma, Ort, Länderkürzel (wie bei Einzeltechniker), damit Balken/Tooltip gleich angezeigt werden
      const jobs = data.jobs || [];
      if (!skipJobEnrich && jobs.length) {
        await Promise.all(jobs.map(async (job) => {
          const jobId = job.id ?? job.server_id;
          const techId = job.technician_id;
          if (jobId == null || techId == null) return;
          try {
            const jr = await fetch(`${baseUrl}/dispo_api/api/job.php?id=${encodeURIComponent(jobId)}&technician_id=${encodeURIComponent(techId)}`, opts);
            if (!jr.ok) return;
            const jData = await jr.json();
            const full = jData.job;
            if (full) {
              if (full.customer_name != null) job.customer_name = full.customer_name;
              if (full.city != null) job.city = full.city;
              if (full.country != null) job.country = full.country;
            }
          } catch (_) { /* Einzelauftrag nicht geladen, Balken behält Nummer */ }
        }));
      }

      try {
        upsertCalendarCache(db, data, { rangeStart: s, rangeEnd: e, replaceAll: false });
        const calTechId = getTechnicianId(req);
        if (calTechId) {
          reconcileLocalJobsFromCalendarCache(db, calTechId, data);
        }
        save();
      } catch (_) { /* Cache optional */ }

      res.json(data);
    } catch (err) {
      if (isLikelyOfflineSyncError(err)) {
        try {
          const payload = readCalendarCachePayload(db, s, e, getTechnicianId(req));
          return res.json(Object.assign({ ok: true, data_source: 'cache' }, payload));
        } catch (_) {}
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get('/api/calendar_cached', (req, res) => {
    const start = String(req.query.start || '').trim();
    const end = String(req.query.end || '').trim();
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: 'start und end erforderlich.' });
    }
    try {
      const technicianId = getTechnicianId(req);
      if (technicianId) {
        const pruned = reconcileCalendarCacheAbsencesForTechnician(db, technicianId);
        if (pruned > 0) save();
      }
      const payload = readCalendarCachePayload(db, start, end, technicianId);
      return res.json(Object.assign({ ok: true }, payload));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  const {
    createImageGallerySession,
    getImageGallerySession,
  } = require('./lib/image-gallery-sessions');

  app.post('/api/image-gallery/session', express.json({ limit: '4mb' }), (req, res) => {
    const id = createImageGallerySession((req.body && req.body.images) || []);
    if (!id) return res.status(400).json({ ok: false, error: 'no_images' });
    res.json({ ok: true, id });
  });

  app.get('/api/image-gallery/session/:id', (req, res) => {
    const session = getImageGallerySession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, images: session.images || [] });
  });

  /** Galerie-Fenster: Bilder serverseitig laden (Technician-Id + Thumb-Cache). */
  app.get('/api/image-gallery/media/:sessionId/:index', async (req, res) => {
    try {
      const session = getImageGallerySession(req.params.sessionId);
      if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
      const idx = Math.max(0, parseInt(req.params.index, 10) || 0);
      const item = (session.images || [])[idx];
      if (!item) return res.status(404).json({ ok: false, error: 'index' });
      const wantThumb = String(req.query.thumb || '') === '1';
      let sourceUrl = String(wantThumb ? item.thumbUrl || item.url : item.url || '').trim();
      if (!sourceUrl) return res.status(404).json({ ok: false, error: 'url' });

      let parsed;
      try {
        parsed = new URL(sourceUrl, `http://127.0.0.1:${PORT}`);
      } catch (_) {
        return res.status(400).json({ ok: false, error: 'invalid_url' });
      }
      const techId = getTechnicianId(req);
      if (techId && !parsed.searchParams.get('technician_id')) {
        parsed.searchParams.set('technician_id', String(techId));
      }
      const internalUrl = `http://127.0.0.1:${PORT}${parsed.pathname}?${parsed.searchParams.toString()}`;
      const headers = {};
      const gw = require('./lib/local-gateway-auth');
      headers[gw.HEADER] = gw.getLocalGatewayToken();
      if (techId) headers['X-Technician-Id'] = String(techId);
      const r = await fetch(internalUrl, { headers });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        return res
          .status(r.status)
          .json({ ok: false, error: errBody || 'upstream_' + r.status });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

function defaultFutureRange() {
  const from = new Date();
  const to = new Date(from);
  to.setFullYear(to.getFullYear() + 10);
  return { start: from.toISOString().slice(0, 10), end: to.toISOString().slice(0, 10) };
}

async function fetchCalendarFromDispo(baseUrl, start, end, authHeader) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/calendar.php?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const opts = authHeader ? { headers: authHeader } : {};
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!r.ok) {
    const msg = (data && data.error) ? data.error : ('HTTP ' + r.status + ' ' + (r.statusText || ''));
    throw new Error('Kalender-Cache Pull fehlgeschlagen: ' + msg);
  }
  if (!data || typeof data !== 'object') throw new Error('Kalender-Cache Pull: ungültige Antwort.');
  return data;
}

function extractFabsFromJobs(jobs) {
  const result = [];
  const seen = new Set();
  const list = Array.isArray(jobs) ? jobs : [];
  for (const j of list) {
    const raw = (j && j.fabrikationsnummern != null) ? j.fabrikationsnummern : '';
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
        for (const row of rows) {
          const fab = String((row && (row.fabrikationsnummer || row.Fabrikationsnummer || row.fab)) || '').trim();
          if (!fab || seen.has(fab)) continue;
          seen.add(fab);
          result.push(fab);
        }
      } catch (_) {
        const parts = raw.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
        for (const fab of parts) {
          if (seen.has(fab)) continue;
          seen.add(fab);
          result.push(fab);
        }
      }
    } else if (Array.isArray(raw)) {
      for (const row of raw) {
        const fab = String((row && (row.fabrikationsnummer || row.Fabrikationsnummer || row.fab)) || '').trim();
        if (!fab || seen.has(fab)) continue;
        seen.add(fab);
        result.push(fab);
      }
    }
  }
  return result;
}

function flattenMechanikTedByFab(data) {
  const out = [];
  const byFab = data && data.by_fab && typeof data.by_fab === 'object' ? data.by_fab : {};
  for (const fab of Object.keys(byFab)) {
    const rows = Array.isArray(byFab[fab]) ? byFab[fab] : [];
    for (const row of rows) {
      if (!row || !row.rel_path) continue;
      out.push({
        rel_path: String(row.rel_path),
        file_name: row.file_name != null ? String(row.file_name) : '',
        fab: String(fab),
      });
    }
  }
  return out;
}

function normTedFabKey(fab) {
  return String(fab || '')
    .trim()
    .replace(/\D/g, '');
}

function tedEntryKey(ent) {
  const fab = normTedFabKey(ent && ent.fab) || String((ent && ent.fab) || '').trim();
  const rel = String((ent && ent.rel_path) || '')
    .trim()
    .replace(/\\/g, '/');
  const fn = String((ent && ent.file_name) || '').trim();
  return fab + '|' + rel + '|' + fn;
}

/** TED-/Projektordner-Dateien nur nach „Auftrag annehmen“ (lokal in_arbeit). */
function localJobStatusAllowsTedFilePull(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return false;
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(lid);
  return row && String(row.status || '').trim().toLowerCase() === 'in_arbeit';
}

function jobFabKeysFromLocalJob(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return [];
  const row = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(lid);
  if (!row) return [];
  const out = [];
  const seen = new Set();
  for (const r of parseJobFabrikationsnummernRows(row.fabrikationsnummern)) {
    const f = String(r.fabrikationsnummer ?? r.Fabrikationsnummer ?? '').trim();
    if (!f) continue;
    const k = normTedFabKey(f) || f;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

function upsertJobTedIndex(db, localJobId, serverJobId, entries) {
  db.transaction(() => {
    db.prepare(`DELETE FROM job_ted_index WHERE local_job_id = ?`).run(localJobId);
    for (const e of entries || []) {
      const rel = String(e.rel_path || '').trim().replace(/\\/g, '/');
      if (!rel || rel.includes('..')) continue;
      db.prepare(
        `INSERT INTO job_ted_index (local_job_id, server_job_id, rel_path, file_name, fab, synced_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        localJobId,
        serverJobId,
        rel,
        String(e.file_name || '').trim() || null,
        String(e.fab || '').trim() || '',
      );
    }
  });
}

function tedCompletedIncludes(completed, entryKey, ent) {
  if (!Array.isArray(completed) || !completed.length) return false;
  if (completed.includes(entryKey)) return true;
  const rel = String((ent && ent.rel_path) || '')
    .trim()
    .replace(/\\/g, '/');
  return !!(rel && completed.includes(rel));
}

async function fetchMechanikTedListFromDispo(base, technicianId, serverJobId, authHeader, signal, opts) {
  opts = opts || {};
  const listBase =
    `${base}/dispo_api/api/mechanik_ted_excel_list.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(serverJobId)}`;
  const byKey = new Map();

  function mergeListPayload(data) {
    for (const ent of flattenMechanikTedByFab(data)) {
      const rel = String(ent.rel_path || '').trim();
      if (!rel) continue;
      const key = tedEntryKey(ent);
      if (!byKey.has(key)) byKey.set(key, ent);
    }
  }

  async function fetchListUrl(url) {
    const r = await fetch(url, { headers: authHeader, signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error((data && data.error) || 'TED-Liste fehlgeschlagen (HTTP ' + r.status + ').');
    }
    mergeListPayload(data);
  }

  async function fetchListUrlWithRetry(url, attempts) {
    const max = attempts != null ? attempts : 3;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      try {
        await fetchListUrl(url);
        return;
      } catch (e) {
        lastErr = e;
        if (i < max - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
        }
      }
    }
    throw lastErr || new Error('TED-Liste fehlgeschlagen.');
  }

  await fetchListUrlWithRetry(listBase);

  const extraFabs = Array.isArray(opts.extraFabs) ? opts.extraFabs : [];
  if (extraFabs.length > 1) {
    for (const fab of extraFabs) {
      const fabStr = String(fab || '').trim();
      if (!fabStr) continue;
      const urlFab = listBase + '&fab=' + encodeURIComponent(fabStr);
      try {
        await fetchListUrl(urlFab);
      } catch (e) {
        console.warn('[ted_list] fab', fabStr, e && e.message ? e.message : e);
      }
    }
  }

  const result = [...byKey.values()];
  try {
    const fabCount = new Set(result.map((e) => String(e.fab || '').trim()).filter(Boolean)).size;
    console.log('[ted_list] job=' + serverJobId + ' entries=' + result.length + ' fabs=' + fabCount);
  } catch (_) {}
  return result;
}

/** Erster erfolgreicher Binary-Download aus parallelen URLs (schneller als Kette). */
async function fetchFirstOkBinary(urls, headers, timeoutMs) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) throw new Error('Datei nicht gefunden.');
  const ms = timeoutMs != null ? timeoutMs : 22000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let lastErr = 'Datei nicht gefunden.';
  try {
    return await Promise.any(
      list.map((url) =>
        (async () => {
          const r = await fetch(url, { headers, signal: ac.signal });
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          if (!r.ok || ct.includes('application/json')) {
            const data = await r.json().catch(() => ({}));
            throw new Error((data && data.error) || 'HTTP ' + r.status);
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) throw new Error('Datei ist leer.');
          ac.abort();
          return { buf, contentDisposition: r.headers.get('content-disposition') || '' };
        })(),
      ),
    );
  } catch (e) {
    if (e && e.errors && e.errors.length) {
      const tail = e.errors[e.errors.length - 1];
      if (tail && tail.message) lastErr = tail.message;
    } else if (e && e.message) {
      lastErr = e.message;
    }
    throw new Error(lastErr);
  } finally {
    clearTimeout(timer);
  }
}

function buildMechanikTedDownloadUrls(base, technicianId, serverJobId, relPath, fabOpt) {
  const baseNorm = String(base || '').trim().replace(/\/$/, '');
  if (!baseNorm || !relPath) return [];
  const relQ = `rel_path=${encodeURIComponent(relPath)}`;
  const fabStr = fabOpt != null && String(fabOpt).trim() !== '' ? String(fabOpt).trim() : '';
  const urls = [];
  if (fabStr) {
    const fabQs = `fab=${encodeURIComponent(fabStr)}&${relQ}`;
    urls.push(`${baseNorm}/api/mobile/mechanik_ted_excel_download_by_fab.php?${fabQs}`);
    urls.push(`${baseNorm}/dispo/api/mobile/mechanik_ted_excel_download_by_fab.php?${fabQs}`);
  }
  urls.push(`${baseNorm}/api/mechanik_ted_excel_download.php?${relQ}`);
  urls.push(`${baseNorm}/dispo/api/mechanik_ted_excel_download.php?${relQ}`);
  const jobId = parseInt(serverJobId, 10);
  if (Number.isFinite(jobId) && jobId > 0) {
    const baseDl = `${baseNorm}/dispo_api/api/mechanik_ted_excel_download.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}&${relQ}`;
    urls.push(baseDl);
    if (fabStr) urls.push(`${baseDl}&fab=${encodeURIComponent(fabStr)}`);
  }
  return urls;
}

/** TED-Download wie PWA: Mobile-API mit fab+rel_path (Basic-Auth, kein job_id). */
async function downloadMechanikTedByFabMobile(base, relPath, fabOpt, authHeader, signal) {
  const fabStr = fabOpt != null && String(fabOpt).trim() !== '' ? String(fabOpt).trim() : '';
  if (!fabStr || !relPath) return null;
  const baseNorm = String(base || '').trim().replace(/\/$/, '');
  if (!baseNorm) return null;
  const qs = `fab=${encodeURIComponent(fabStr)}&rel_path=${encodeURIComponent(relPath)}`;
  const urls = [
    `${baseNorm}/api/mobile/mechanik_ted_excel_download_by_fab.php?${qs}`,
    `${baseNorm}/dispo/api/mobile/mechanik_ted_excel_download_by_fab.php?${qs}`,
  ];
  let lastErr = 'Datei nicht gefunden.';
  for (const url of urls) {
    let r;
    try {
      r = await fetch(url, { headers: authHeader, signal });
    } catch (fetchErr) {
      lastErr = fetchErr.message || String(fetchErr);
      continue;
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || ct.includes('application/json')) {
      const data = await r.json().catch(() => ({}));
      if (data && data.error) lastErr = String(data.error);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) {
      lastErr = 'Datei ist leer.';
      continue;
    }
    return { buf, contentDisposition: r.headers.get('content-disposition') || '' };
  }
  throw new Error(lastErr);
}

/** TED-Download über Dispo-Web-Session (Cookies) — rel_path reicht ohne job_id. */
async function downloadMechanikTedViaSessionProxy(dbDir, technicianId, serverJobId, relPath, fabOpt, credsOpt) {
  const { ensureProxyAuthenticated, tryProxyFetchDispoBinary } = require('./lib/monteur-dispo-web-routes');
  const relQ = `rel_path=${encodeURIComponent(relPath)}`;
  const fast = await tryProxyFetchDispoBinary(dbDir, `/api/mechanik_ted_excel_download.php?${relQ}`);
  if (fast && fast.buf && fast.buf.length) return fast;
  const creds = credsOpt && typeof credsOpt === 'object' ? credsOpt : null;
  const auth = await ensureProxyAuthenticated(dbDir, creds);
  if (!auth.ok || !auth.authenticated || !auth.proxy) return null;
  const paths = [`/api/mechanik_ted_excel_download.php?${relQ}`];
  const jobId = parseInt(serverJobId, 10);
  if (Number.isFinite(jobId) && jobId > 0) {
    const baseDl = `/dispo_api/api/mechanik_ted_excel_download.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}&${relQ}`;
    paths.push(baseDl);
    const fabStr = fabOpt != null && String(fabOpt).trim() !== '' ? String(fabOpt).trim() : '';
    if (fabStr) {
      paths.push(`${baseDl}&fab=${encodeURIComponent(fabStr)}`);
    }
  }
  for (const suffix of paths) {
    try {
      const { res } = await auth.proxy.fetchDispo(suffix, { method: 'GET' });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || ct.includes('application/json')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      return { buf, contentDisposition: res.headers.get('content-disposition') || '' };
    } catch (_) {
      /* nächster Pfad */
    }
  }
  return null;
}

async function downloadMechanikTedBuffer(base, technicianId, serverJobId, relPath, authHeader, signal, fabOpt) {
  const relQ = `rel_path=${encodeURIComponent(relPath)}`;
  const jobId = parseInt(serverJobId, 10);
  const baseNorm = String(base || '').trim().replace(/\/$/, '');
  const fabStr = fabOpt != null && String(fabOpt).trim() !== '' ? String(fabOpt).trim() : '';
  const urls = [];
  if (fabStr) {
    const fabQs = `fab=${encodeURIComponent(fabStr)}&${relQ}`;
    urls.push(`${baseNorm}/api/mobile/mechanik_ted_excel_download_by_fab.php?${fabQs}`);
    urls.push(`${baseNorm}/dispo/api/mobile/mechanik_ted_excel_download_by_fab.php?${fabQs}`);
  }
  urls.push(`${baseNorm}/api/mechanik_ted_excel_download.php?${relQ}`);
  urls.push(`${baseNorm}/dispo/api/mechanik_ted_excel_download.php?${relQ}`);
  if (Number.isFinite(jobId) && jobId > 0) {
    const baseDl = `${baseNorm}/dispo_api/api/mechanik_ted_excel_download.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}&${relQ}`;
    urls.unshift(baseDl);
    const fabStr = fabOpt != null && String(fabOpt).trim() !== '' ? String(fabOpt).trim() : '';
    if (fabStr) {
      urls.unshift(`${baseDl}&fab=${encodeURIComponent(fabStr)}`);
    }
  }
  let lastErr = 'Datei nicht gefunden.';
  for (const url of urls) {
    let r;
    try {
      r = await fetch(url, { headers: authHeader, signal });
    } catch (fetchErr) {
      lastErr = fetchErr.message || String(fetchErr);
      continue;
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || ct.includes('application/json')) {
      const data = await r.json().catch(() => ({}));
      if (data && data.error) lastErr = String(data.error);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) {
      lastErr = 'Datei ist leer.';
      continue;
    }
    return { buf, contentDisposition: r.headers.get('content-disposition') || '' };
  }
  throw new Error(lastErr);
}

async function syncTedIndexForTechnicianJobs(db, base, technicianId, authHeader, signal, setProgress, lock) {
  const rows = db
    .prepare(
      `SELECT j.id AS local_id, j.server_id FROM jobs j
       INNER JOIN job_technicians jt ON jt.job_id = j.id
       WHERE jt.technician_id = ? AND j.status = 'in_arbeit'`,
    )
    .all(technicianId);
  const total = rows.length;
  let i = 0;
  for (const row of rows) {
    if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    i++;
    if (setProgress) setProgress('ted_index', i, total, 'TED-Index ' + i + '/' + total);
    const serverJobId = row.server_id != null ? Number(row.server_id) : Number(row.local_id);
    try {
      let extraFabs = [];
      if (lock && typeof lock.runWithDbLock === 'function') {
        await lock.runWithDbLock(async () => {
          extraFabs = jobFabKeysFromLocalJob(db, row.local_id);
        });
      } else {
        extraFabs = jobFabKeysFromLocalJob(db, row.local_id);
      }
      const list = await fetchMechanikTedListFromDispo(base, technicianId, serverJobId, authHeader, signal, {
        extraFabs,
      });
      if (lock && typeof lock.runWithDbLock === 'function') {
        await lock.runWithDbLock(async () => {
          upsertJobTedIndex(db, row.local_id, serverJobId, list);
          if (typeof db.save === 'function') db.save();
        });
      } else {
        upsertJobTedIndex(db, row.local_id, serverJobId, list);
        if (typeof db.save === 'function') db.save();
      }
    } catch (err) {
      console.warn('[sync_pull] ted_index job', serverJobId, err && err.message ? err.message : err);
    }
  }
}

function resolveTedFnFolderForPull(db, localJobId, ent) {
  const cfg = getOfflinePullConfig(db, localJobId);
  const fromMap = (cfg.fab_map || []).find((e) => String(e.fab) === String(ent.fab));
  if (fromMap && fromMap.folder_name_canonical) return fromMap.folder_name_canonical;
  const digits = String(ent.fab || '').replace(/\D/g, '');
  return digits || String(ent.fab || '').trim() || 'unknown';
}

function resolveTedLocalAbsPath(targetDir, db, localJobId, ent, usedLocalNames) {
  const rel = String(ent.rel_path || '').trim().replace(/\\/g, '/');
  if (!rel || rel.includes('..')) {
    return path.join(targetDir, 'TED', safeTedLocalFileName(ent, usedLocalNames));
  }
  const fnFolder = resolveTedFnFolderForPull(db, localJobId, ent);
  const relAnlage = buildTedAnlageRelPath(fnFolder, rel);
  if (relAnlage) {
    return path.join(targetDir, ...relAnlage.split('/'));
  }
  return path.join(targetDir, 'TED', safeTedLocalFileName(ent, usedLocalNames));
}

const tedExcelPullInFlight = new Map();

function yieldTedPullLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function pullTedExcelIntoReiseDir(opts) {
  const key = String((opts && opts.localJobId) || '') + ':' + String((opts && opts.serverJobId) || '');
  const existing = key !== ':' ? tedExcelPullInFlight.get(key) : null;
  if (existing) return existing;
  const run = pullTedExcelIntoReiseDirLocked(opts);
  if (key !== ':') tedExcelPullInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (key !== ':' && tedExcelPullInFlight.get(key) === run) tedExcelPullInFlight.delete(key);
  }
}

async function pullTedExcelIntoReiseDirLocked(opts) {
  const {
    db,
    dbLock,
    dispoBaseUrl,
    technicianId,
    serverJobId,
    localJobId,
    targetDir,
    authHeader,
    signal,
    setProgress,
    mergeCheckpoint,
    readCheckpoint,
    force: forcePull,
  } = opts;

  async function withDbLock(fn) {
    if (dbLock && typeof dbLock.runWithDbLock === 'function') {
      return dbLock.runWithDbLock(fn);
    }
    return fn();
  }

  let jobFabKeys = [];
  await withDbLock(async () => {
    jobFabKeys = jobFabKeysFromLocalJob(db, localJobId);
    let jobMetaTed = null;
    try {
      jobMetaTed = db
        .prepare(
          `SELECT c.name AS customer_name, ja.city, ja.country
           FROM jobs j
           LEFT JOIN customers c ON c.id = j.customer_id
           LEFT JOIN job_addresses ja ON ja.job_id = j.id
           WHERE j.id = ? LIMIT 1`,
        )
        .get(localJobId);
    } catch (_) {
      jobMetaTed = null;
    }
    const cfg = getOfflinePullConfig(db, localJobId);
    const fabEntries = (cfg.fab_map || []).length
      ? cfg.fab_map
      : jobFabKeys.map((fab) => {
          const built = buildFnProjectFolderName({
            fab,
            customer_name: jobMetaTed && jobMetaTed.customer_name,
            city: jobMetaTed && jobMetaTed.city,
            country: jobMetaTed && jobMetaTed.country,
          });
          return { fab: String(fab), folder_name_canonical: built || String(fab) };
        });
    if (fabEntries.length) await ensureAnlageFnDirs(targetDir, fabEntries);
  });
  let entries = [];
  let listSource = 'list';
  try {
    entries = await fetchMechanikTedListFromDispo(dispoBaseUrl, technicianId, serverJobId, authHeader, signal, {
      extraFabs: jobFabKeys,
    });
    await withDbLock(async () => {
      upsertJobTedIndex(db, localJobId, serverJobId, entries);
      if (typeof db.save === 'function') db.save();
    });
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    console.warn('[dienstreise_pull] TED-Liste:', errMsg, 'job=' + serverJobId);
    listSource = 'cache';
    await withDbLock(async () => {
      entries = db.prepare(`SELECT rel_path, file_name, fab FROM job_ted_index WHERE local_job_id = ?`).all(localJobId);
    });
  }
  try {
    console.log(
      '[pullTedExcel] start job=' + serverJobId + ' expected=' + entries.length + ' source=' + listSource,
    );
  } catch (_) {}
  let chk = readCheckpoint();
  let completed = forcePull ? [] : Array.isArray(chk.ted_completed) ? chk.ted_completed.slice() : [];
  const total = entries.length;
  let idx = 0;
  let tedErrors = 0;
  let downloaded = 0;
  let skipped = 0;
  const usedLocalNames = new Set();
  for (const ent of entries) {
    const entryKey = tedEntryKey(ent);
    const rel = String(ent.rel_path || '').trim().replace(/\\/g, '/');
    if (!rel || rel.includes('..')) continue;
    const localPath = resolveTedLocalAbsPath(targetDir, db, localJobId, ent, usedLocalNames);
    const localComplete = tedLocalFileLooksComplete(localPath, ent && ent.file_size);
    const alreadyDone = !forcePull && tedCompletedIncludes(completed, entryKey, ent);
    if (alreadyDone && localComplete) {
      idx++;
      skipped++;
      if (skipped % 4 === 0) await yieldTedPullLoop();
      continue;
    }
    if (localComplete) {
      if (!completed.includes(entryKey)) completed.push(entryKey);
      mergeCheckpoint({ ted_completed: completed });
      idx++;
      skipped++;
      if (skipped % 4 === 0) await yieldTedPullLoop();
      continue;
    }
    if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    idx++;
    if (setProgress) setProgress('ted', idx, total, rel);
    try {
      const dl = await downloadMechanikTedBuffer(
        dispoBaseUrl,
        technicianId,
        serverJobId,
        rel,
        authHeader,
        signal,
        ent.fab,
      );
      const finalPath = resolveTedLocalAbsPath(targetDir, db, localJobId, ent, usedLocalNames);
      await hangDiag.timeAsync('onedrive_write', () => replaceFileWithoutUnlink(finalPath, dl.buf));
      if (!completed.includes(entryKey)) completed.push(entryKey);
      mergeCheckpoint({ ted_completed: completed });
      downloaded++;
      console.log(
        '[pullTedExcel] OK',
        'fn=' + String(ent.fab || ''),
        'file=' + path.basename(finalPath),
        'rel=' + rel,
        'bytes=' + dl.buf.length,
      );
      await yieldTedPullLoop();
    } catch (dlErr) {
      tedErrors++;
      console.warn(
        '[pullTedExcel] Download fehlgeschlagen',
        'fn=' + String(ent.fab || ''),
        rel,
        '→',
        path.basename(localPath),
        dlErr && dlErr.message ? dlErr.message : dlErr,
      );
    }
  }
  if (tedErrors > 0) {
    console.warn('[pullTedExcel] ' + tedErrors + ' von ' + total + ' TED-Dateien fehlgeschlagen (job ' + serverJobId + ').');
  }
  let present = 0;
  let checked = 0;
  for (const ent of entries) {
    const rel = String(ent.rel_path || '').trim().replace(/\\/g, '/');
    if (!rel || rel.includes('..')) continue;
    const p = resolveTedLocalAbsPath(targetDir, db, localJobId, ent, new Set());
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) present++;
    } catch (_) {}
    checked += 1;
    if (checked % 5 === 0) await yieldTedPullLoop();
  }
  return { total, downloaded, skipped, failed: tedErrors, present };
}

function fabCacheLookupKeys(fab) {
  const keys = [];
  const s = String(fab || '').trim();
  if (s) keys.push(s);
  if (/^\d+$/.test(s)) {
    const n = String(parseInt(s, 10));
    if (keys.indexOf(n) === -1) keys.push(n);
  }
  return keys;
}

function readAnlagenstammTreeCache(db, fab) {
  return readAnlagenstammTreeCacheRow(db, fab);
}

function queryJobsOpenLocalRows(dbConn, technicianId, query) {
  const q = query && typeof query === 'object' ? query : {};
  const includeErledigt = (q.include_erledigt || '').toString() === '1';
  const filterNoDate = (q.filter_no_date || '').toString() === '1';
  const filterNoTechnician = (q.filter_no_technician || '').toString() === '1';
  const whereParts = [];
  if (!includeErledigt) {
    whereParts.push("j.status NOT IN ('erledigt','abgerechnet')");
  }
  if (filterNoDate) {
    whereParts.push(
      "((j.start_datetime IS NULL AND j.end_datetime IS NULL) OR (date(j.start_datetime) = '1000-01-01' AND date(j.end_datetime) = '1000-01-01'))",
    );
  }
  if (filterNoTechnician) {
    whereParts.push('NOT EXISTS (SELECT 1 FROM job_technicians jt3 WHERE jt3.job_id = j.id)');
  }
  const whereSql = whereParts.length ? whereParts.join(' AND ') : '1=1';
  const sql = `
SELECT
  j.id,
  j.server_id,
  j.job_number,
  j.status,
  c.name AS customer_name,
  ja.endkunde,
  ja.street,
  ja.house_number,
  ja.zip,
  ja.city,
  ja.country,
  ja.address_extra_1,
  ja.address_extra_2,
  j.start_datetime AS start_datetime_raw,
  j.end_datetime AS end_datetime_raw,
  CASE
    WHEN date(j.start_datetime) = '1000-01-01' AND date(j.end_datetime) = '1000-01-01' THEN NULL
    ELSE substr(j.start_datetime, 1, 10)
  END AS start_datetime,
  CASE
    WHEN date(j.start_datetime) = '1000-01-01' AND date(j.end_datetime) = '1000-01-01' THEN NULL
    ELSE substr(j.end_datetime, 1, 10)
  END AS end_datetime,
  j.required_technicians,
  (
    SELECT COUNT(DISTINCT jt2.technician_id)
    FROM job_technicians jt2
    WHERE jt2.job_id = j.id
  ) AS assigned_count
FROM jobs j
JOIN customers c ON c.id = j.customer_id
LEFT JOIN job_addresses ja ON ja.job_id = j.id
WHERE (${whereSql})
  AND (
    EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
    OR NOT EXISTS (SELECT 1 FROM job_technicians jt0 WHERE jt0.job_id = j.id)
  )
ORDER BY
  (CASE WHEN ((j.start_datetime IS NULL AND j.end_datetime IS NULL) OR (date(j.start_datetime) = '1000-01-01' AND date(j.end_datetime) = '1000-01-01')) THEN 1 ELSE 0 END) ASC,
  COALESCE(j.start_datetime, j.end_datetime) ASC,
  j.id ASC`;
  return dbConn.prepare(sql).all(technicianId);
}

async function pullTextbausteineFromDispo(baseUrl, technicianId, dbConn, authHeader) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  const tid = parseInt(technicianId, 10);
  if (!base || !tid) return { ok: false, skipped: true };
  const url = base + '/dispo_api/api/textbausteine_list.php?technician_id=' + encodeURIComponent(tid);
  const r = await fetch(url, {
    headers: Object.assign({ 'X-Technician-Id': String(tid) }, authHeader || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    throw new Error((data && data.error) || r.statusText || 'textbausteine_list fehlgeschlagen');
  }
  textbausteineLocal.mergeTextbausteineFromRemote(dbConn, tid, data);
  return { ok: true, categories: (data.categories || []).length };
}

async function pullArbeitsschritteFromDispo(baseUrl, technicianId, dbConn, authHeader) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  const tid = parseInt(technicianId, 10);
  if (!base || !tid) return { ok: false, skipped: true };
  let steps = 0;
  let presets = 0;
  for (const kind of ['service', 'ibn']) {
    const url =
      base +
      '/dispo_api/api/arbeitsschritte_list.php?technician_id=' +
      encodeURIComponent(tid) +
      '&catalog_kind=' +
      encodeURIComponent(kind);
    try {
      const r = await fetch(url, {
        headers: Object.assign({ 'X-Technician-Id': String(tid) }, authHeader || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (kind === 'ibn') continue;
        throw new Error((data && data.error) || r.statusText || 'arbeitsschritte_list fehlgeschlagen');
      }
      data.catalog_kind = kind;
      arbeitsschritteLocal.mergeArbeitsschritteFromRemote(dbConn, tid, data);
      steps += (data.steps || []).length;
      presets += (data.presets || []).length;
    } catch (e) {
      if (kind === 'ibn') continue;
      throw e;
    }
  }
  return { ok: true, steps, presets };
}

function queueDispoProxyPending(dbConn, entityType, entityId, action, payload) {
  if (!isHandledPendingEntityType(entityType)) {
    console.warn('[pending_changes] entity_type ohne pushToServer-Handler:', entityType);
  }
  dbConn
    .prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`)
    .run(entityType, String(entityId), action, JSON.stringify(payload));
}

function readCalendarCachePayload(dbConn, start, end, technicianId) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (!s || !e) throw new Error('start und end erforderlich.');
  const calTechId = technicianId || null;
  if (calTechId) reconcileCalendarCacheAbsencesForTechnician(dbConn, calTechId);
  const technicians = dbConn
    .prepare('SELECT technician_id AS id, name, color FROM calendar_cache_technicians ORDER BY technician_id')
    .all();
  const jobs = calTechId
    ? dbConn
        .prepare(
          `
        SELECT
          c.server_job_id AS id, c.technician_id, c.customer_name, c.job_number, c.city, c.country, c.status,
          c.start_datetime, c.end_datetime, c.technician_name, c.technician_color,
          c.montage_verrechnet, c.billing_travel_complete, c.date_not_fixed,
          (
            SELECT j.id FROM jobs j
            INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
            WHERE CAST(j.server_id AS TEXT) = CAST(c.server_job_id AS TEXT)
            LIMIT 1
          ) AS local_job_id
        FROM calendar_cache_jobs c
        WHERE c.end_datetime >= ? AND c.start_datetime <= ?
      `,
        )
        .all(calTechId, s + ' 00:00:00', e + ' 23:59:59')
    : dbConn
        .prepare(
          `
        SELECT
          server_job_id AS id, technician_id, customer_name, job_number, city, country, status,
          start_datetime, end_datetime, technician_name, technician_color,
          montage_verrechnet, billing_travel_complete, date_not_fixed,
          NULL AS local_job_id
        FROM calendar_cache_jobs
        WHERE end_datetime >= ? AND start_datetime <= ?
      `,
        )
        .all(s + ' 00:00:00', e + ' 23:59:59');
  const absencesRaw = dbConn
    .prepare(
      `
        SELECT
          server_absence_id AS id, technician_id, type, comment, start_datetime, end_datetime,
          technician_name, technician_color
        FROM calendar_cache_absences
        WHERE end_datetime >= ? AND start_datetime <= ?
      `,
    )
    .all(s + ' 00:00:00', e + ' 23:59:59');
  const absences = absencesRaw.filter((a) => !isAbsenceExpiredByEnd(a.end_datetime));
  return { technicians, jobs, absences };
}

function readAnlagenstammRootFolderName(db, fab) {
  const cached = readAnlagenstammTreeCache(db, fab);
  const fromTree = cached && cached.root_folder_name ? String(cached.root_folder_name).trim() : '';
  if (
    fromTree &&
    !isBareFabFolderName(fromTree) &&
    folderNameMatchesFab(fromTree, fab) &&
    !isDatePrefixedProjectFolderName(fromTree)
  ) {
    return fromTree;
  }
  try {
    const row = db
      .prepare('SELECT pn_root_name FROM anlagenstamm_local WHERE TRIM(fabrikationsnummer) = TRIM(?) LIMIT 1')
      .get(String(fab || '').trim());
    const pn = row && row.pn_root_name ? String(row.pn_root_name).trim() : '';
    if (pn && !isBareFabFolderName(pn) && folderNameMatchesFab(pn, fab)) return pn;
  } catch (_) {}
  return null;
}

function fabMapJsonEqual(a, b) {
  try {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  } catch (_) {
    return false;
  }
}

function upsertAnlagenstammTreeCache(db, fab, pnRaw, meta) {
  upsertAnlagenstammTreeCacheRow(db, fab, pnRaw, meta);
}

/**
 * Dispo calendar.php liefert oft nur YYYY-MM-DD (DATE_FORMAT), plus *_raw mit voller Zeit.
 * SQLite-Stringvergleiche mit „YYYY-MM-DD 00:00:00“ schließen date-only Enddaten am Range-Rand aus.
 * Unassigned-Lane nutzt technician_id = 0.
 */
function normalizeCalendarCacheDateTime(value, isEnd) {
  let s = String(value || '')
    .trim()
    .replace('T', ' ');
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s + (isEnd ? ' 23:59:59' : ' 00:00:00');
  }
  if (s.length > 19) s = s.slice(0, 19);
  return s;
}

function pickCalendarEventDateTime(row, isEnd) {
  if (!row || typeof row !== 'object') return '';
  const rawKey = isEnd ? 'end_datetime_raw' : 'start_datetime_raw';
  const key = isEnd ? 'end_datetime' : 'start_datetime';
  const raw = row[rawKey];
  if (raw != null && String(raw).trim() !== '') {
    return normalizeCalendarCacheDateTime(raw, isEnd);
  }
  return normalizeCalendarCacheDateTime(row[key], isEnd);
}

function upsertCalendarCache(db, calendarData, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const replaceAll = options.replaceAll !== false && !options.rangeStart;
  const rangeStart = options.rangeStart ? normalizeCalendarCacheDateTime(options.rangeStart, false) : '';
  const rangeEnd = options.rangeEnd ? normalizeCalendarCacheDateTime(options.rangeEnd, true) : '';
  const technicians = Array.isArray(calendarData.technicians) ? calendarData.technicians : [];
  const jobs = Array.isArray(calendarData.jobs) ? calendarData.jobs : [];
  const absences = Array.isArray(calendarData.absences) ? calendarData.absences : [];
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const delTech = db.prepare('DELETE FROM calendar_cache_technicians');
  const delJobs = db.prepare('DELETE FROM calendar_cache_jobs');
  const delAbs = db.prepare('DELETE FROM calendar_cache_absences');
  const delJobsRange = db.prepare(
    `DELETE FROM calendar_cache_jobs WHERE end_datetime >= ? AND start_datetime <= ?`,
  );
  const delAbsRange = db.prepare(
    `DELETE FROM calendar_cache_absences WHERE end_datetime >= ? AND start_datetime <= ?`,
  );
  const insTech = db.prepare(
    'INSERT OR REPLACE INTO calendar_cache_technicians (technician_id, name, color, synced_at) VALUES (?, ?, ?, ?)',
  );
  const insJob = db.prepare(`INSERT OR REPLACE INTO calendar_cache_jobs
        (cache_key, server_job_id, technician_id, customer_name, job_number, city, country, status, start_datetime, end_datetime, technician_name, technician_color, montage_verrechnet, billing_travel_complete, date_not_fixed, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAbs = db.prepare(`INSERT OR REPLACE INTO calendar_cache_absences
        (cache_key, server_absence_id, technician_id, type, comment, start_datetime, end_datetime, technician_name, technician_color, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  hangDiag.timeSync('upsert_calendar_cache', () => {
  db.transaction(() => {
    if (replaceAll || !rangeStart || !rangeEnd) {
      delTech.run();
      delJobs.run();
      delAbs.run();
    } else {
      // Sichtbarer Zeitraum: alte Termine/Abwesenheiten in diesem Fenster entfernen (Umbuchungen),
      // andere Monate im Cache behalten.
      delJobsRange.run(rangeStart, rangeEnd);
      delAbsRange.run(rangeStart, rangeEnd);
    }

    for (const t of technicians) {
      const tid = Number(t.id != null ? t.id : t.technician_id);
      // 0 = Lane „Nicht zugewiesen“ (Dispo calendar.php)
      if (!Number.isFinite(tid) || tid < 0) continue;
      const name =
        String(t.name || t.full_name || t.technician_name || '').trim() ||
        (tid === 0 ? 'Nicht zugewiesen' : 'Techniker ' + tid);
      const color = String(t.color || t.farbe || '').trim() || (tid === 0 ? '#94a3b8' : '#4a90e2');
      insTech.run(tid, name, color, syncedAt);
    }

    for (const j of jobs) {
      const sid = Number(j.id != null ? j.id : j.server_id);
      const tid = Number(j.technician_id != null ? j.technician_id : j.technicianId);
      const start = pickCalendarEventDateTime(j, false);
      const end = pickCalendarEventDateTime(j, true);
      if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(tid) || tid < 0 || !start || !end) continue;
      const cacheKey = String(sid) + ':' + String(tid);
      insJob.run(
        cacheKey, sid, tid,
        String(j.customer_name || j.customer || ''), String(j.job_number || ''),
        String(j.city || ''), String(j.country || j.country_code || ''), String(j.status || ''),
        start, end, String(j.technician_name || ''), String(j.technician_color || ''),
        Number(j.montage_verrechnet) === 1 ? 1 : 0,
        Number(j.billing_travel_complete) === 1 ? 1 : 0,
        Number(j.date_not_fixed) === 1 ? 1 : 0,
        syncedAt
      );
    }

    for (const a of absences) {
      const sidRaw = a.id != null ? String(a.id) : '';
      const tid = Number(a.technician_id != null ? a.technician_id : a.technicianId);
      const start = pickCalendarEventDateTime(a, false);
      const end = pickCalendarEventDateTime(a, true);
      const type = String(a.type || '');
      if (!Number.isFinite(tid) || tid <= 0 || !start || !end) continue;
      const cacheKey = [sidRaw || 'x', tid, start, end, type].join(':');
      insAbs.run(
        cacheKey, sidRaw !== '' ? Number(sidRaw) : null, tid, type, String(a.comment || ''),
        start, end, String(a.technician_name || ''), String(a.technician_color || ''), syncedAt
      );
    }
  });
  });
}

/**
 * Lokale jobs/job_technicians und Termin-Daten an Kalender-Stand (Dispo) angleichen.
 * Der Kalender-Cache enthält alle Techniker-Zeilen; my_jobs-Pull kann Zuordnungen
 * wegen shouldPreserveLocalJobOnPull fälschlich behalten.
 */
function reconcileLocalJobsFromCalendarCache(db, technicianId, calendarData) {
  const tid = Number(technicianId);
  if (!Number.isFinite(tid) || tid <= 0) return;
  const jobs = Array.isArray(calendarData && calendarData.jobs) ? calendarData.jobs : [];
  // Auch bei leerer Job-Liste Zuordnungen bereinigen (alles umgebucht / nur Abwesenheiten).

  const serverIdsForTech = new Set();
  const calendarByServerId = new Map();

  for (const j of jobs) {
    const sid = Number(j.id != null ? j.id : j.server_id);
    const jt = Number(j.technician_id != null ? j.technician_id : j.technicianId);
    if (!Number.isFinite(sid) || sid <= 0) continue;
    if (!calendarByServerId.has(sid)) calendarByServerId.set(sid, []);
    calendarByServerId.get(sid).push(j);
    if (jt === tid) serverIdsForTech.add(sid);
  }

  db.transaction(() => {
    for (const [sid, entries] of calendarByServerId) {
      const local = db.prepare('SELECT id FROM jobs WHERE server_id = ?').get(sid);
      if (!local) continue;
      const entry =
        entries.find((e) => Number(e.technician_id != null ? e.technician_id : e.technicianId) === tid) ||
        entries[0];
      const start = pickCalendarEventDateTime(entry, false);
      const end = pickCalendarEventDateTime(entry, true);
      if (!start || !end) continue;
      const dateNotFixed = Number(entry.date_not_fixed) === 1 ? 1 : 0;
      db.prepare(
        `UPDATE jobs SET start_datetime = ?, end_datetime = ?, date_not_fixed = ?, synced_at = datetime('now') WHERE id = ?`,
      ).run(start, end, dateNotFixed, local.id);
    }

    for (const sid of serverIdsForTech) {
      const local = db.prepare('SELECT id FROM jobs WHERE server_id = ?').get(sid);
      if (!local) continue;
      db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(local.id, tid);
    }

    const assignedLocal = db.prepare(`
      SELECT j.id, j.server_id FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      WHERE j.server_id IS NOT NULL AND TRIM(CAST(j.server_id AS TEXT)) != ''
    `).all(tid);

    for (const row of assignedLocal) {
      const sid = Number(row.server_id);
      if (serverIdsForTech.has(sid)) continue;
      // Nur entfernen, wenn der Auftrag im Kalender-Payload vorkommt (andere Techniker / unzugewiesen)
      // oder wenn der Sync-Range den Auftrag abdeckt. Sonst: Listenlücke außerhalb des sichtbaren Fensters.
      const inCalendar = calendarByServerId.has(sid);
      if (!inCalendar && jobs.length > 0) {
        // Sichtbarer Monat: Auftrag nicht im Kalender → Termin woanders / weg; Zuordnung prüfen über Start/Ende lokal
        const localJob = db.prepare('SELECT start_datetime, end_datetime FROM jobs WHERE id = ?').get(row.id);
        const calStart = calendarData && calendarData.start ? String(calendarData.start).slice(0, 10) : '';
        const calEnd = calendarData && calendarData.end ? String(calendarData.end).slice(0, 10) : '';
        if (calStart && calEnd && localJob) {
          const ls = String(localJob.start_datetime || '').slice(0, 10);
          const le = String(localJob.end_datetime || '').slice(0, 10);
          const overlaps = ls && le && le >= calStart && ls <= calEnd;
          if (!overlaps) continue;
        } else if (calStart && calEnd) {
          continue;
        }
      }
      db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(row.id, tid);
      if (shouldPreserveLocalJobOnPull(db, row.id)) continue;
      deleteLocalJobRowIfUnassigned(db, row.id);
    }
  });
}

function jobHasPendingLocalChanges(db, localJobId) {
  const n = parseInt(localJobId, 10);
  if (!Number.isFinite(n)) return false;
  if (db.prepare(`SELECT 1 FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? LIMIT 1`).get(n)) {
    return true;
  }
  const mapped = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(n);
  if (mapped && mapped.server_id != null) {
    return !!db
      .prepare(`SELECT 1 FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? LIMIT 1`)
      .get(mapped.server_id);
  }
  return false;
}

/** Laufende lokale Arbeit / Pending nie durch Pull-Listenlücke löschen. */
function shouldPreserveLocalJobOnPull(db, localJobId) {
  const assigned = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ? LIMIT 1').get(localJobId);
  if (!assigned) return false;
  if (jobHasPendingLocalChanges(db, localJobId)) return true;
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(localJobId);
  const st = row ? String(row.status || '').trim().toLowerCase() : '';
  // Nur echte laufende Montage schützen — zugeteilt/angelegt/geplant müssen Dispo-Umbuchungen folgen
  // (sonst bleiben alte Termine/Zuweisungen in Lokal + „Alle Techniker“-Kalender hängen).
  if (st === 'in_arbeit') return true;
  const pulls = db
    .prepare(
      `SELECT payload_json FROM background_jobs
       WHERE type = 'dienstreise_pull' AND status IN ('queued', 'running', 'completed', 'done')
         AND dedupe_key LIKE ?`,
    )
    .all('dienstreise_pull:' + localJobId + ':%');
  for (const pr of pulls) {
    let payload = {};
    try {
      payload = pr.payload_json ? JSON.parse(pr.payload_json) : {};
    } catch (_) {}
    const tid = parseInt(payload.technician_id, 10);
    if (Number.isFinite(tid) && tid > 0 && isJobAssignedToTechnician(db, localJobId, tid)) {
      return true;
    }
  }
  return false;
}

function deleteLocalJobRowIfUnassigned(db, localJobId) {
  const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(localJobId);
  if (rest) return;
  try {
    db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(localJobId);
  } catch (e) { /* Tabelle fehlt */ }
  try {
    db.prepare('DELETE FROM job_hotel_addresses WHERE job_id = ?').run(localJobId);
  } catch (e) { /* ignore */ }
  try {
    db.prepare('DELETE FROM job_reise_folder_binding WHERE local_job_id = ?').run(localJobId);
  } catch (_) {}
  db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(localJobId);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(localJobId);
}

/** Fremde Spiegel-Jobs ohne Monteur-Zuordnung (z. B. Gebtron id 47) — verursachen ID-Kollisionen. */
function purgeUnassignedMirrorJobs(dbConn) {
  const rows = dbConn
    .prepare(
      `SELECT j.id FROM jobs j
       WHERE NOT EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id)
         AND LOWER(TRIM(COALESCE(j.status, ''))) != 'in_arbeit'`,
    )
    .all();
  let n = 0;
  for (const row of rows) {
    if (shouldPreserveLocalJobOnPull(dbConn, row.id)) continue;
    deleteLocalJobRowIfUnassigned(dbConn, row.id);
    n++;
  }
  return n;
}

function removeLocalJobsNotInDispo(db, technicianId, receivedJobServerIds, opts) {
  const options = opts || {};
  if (options.skipRemoval === true) {
    console.warn(
      '[sync_pull] removeLocalJobsNotInDispo übersprungen:',
      options.reason || 'suspicious pull',
    );
    return { removed: 0, skipped: true };
  }
  let removed = 0;
  const rows = db.prepare(
    'SELECT j.id, j.server_id FROM jobs j INNER JOIN job_technicians jt ON jt.job_id = j.id WHERE jt.technician_id = ?'
  ).all(technicianId);
  for (const row of rows) {
    const hasServerId = row.server_id != null && String(row.server_id).trim() !== '';
    if (!hasServerId) continue; // Verwaiste Aufträge (ohne server_id) nicht löschen – werden ggf. im gleichen Pull verknüpft
    const serverId = row.server_id;
    if (receivedJobServerIds.has(Number(serverId)) || receivedJobServerIds.has(String(serverId))) continue;
    // Techniker-Zuordnung immer entfernen wenn Dispo den Auftrag nicht mehr liefert (Server = Quelle).
    db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(row.id, technicianId);
    removed++;
    if (shouldPreserveLocalJobOnPull(db, row.id)) continue;
    deleteLocalJobRowIfUnassigned(db, row.id);
  }
  // Lokale Spiegel ohne job_technicians (unzugewiesen auf Dispo): entfernen, wenn nicht mehr im Pull
  const unassignedMirror = db.prepare(`
    SELECT j.id, j.server_id FROM jobs j
    WHERE j.server_id IS NOT NULL AND TRIM(CAST(j.server_id AS TEXT)) != ''
    AND NOT EXISTS (SELECT 1 FROM job_technicians jtx WHERE jtx.job_id = j.id)
  `).all();
  for (const row of unassignedMirror) {
    const serverId = row.server_id;
    if (receivedJobServerIds.has(Number(serverId)) || receivedJobServerIds.has(String(serverId))) continue;
    if (shouldPreserveLocalJobOnPull(db, row.id)) continue;
    try {
      db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(row.id);
    } catch (e) { /* Tabelle fehlt */ }
    try {
      db.prepare('DELETE FROM job_hotel_addresses WHERE job_id = ?').run(row.id);
    } catch (e) { /* ignore */ }
    db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(row.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
    removed++;
  }
  return { removed, skipped: false };
}

function removeLocalAbsencesNotInDispo(db, technicianId, receivedAbsenceServerIds) {
  const rows = db.prepare('SELECT id, server_id FROM absences WHERE technician_id = ?').all(technicianId);
  for (const row of rows) {
    // Offline-Creates ohne server_id behalten (Pending pushen).
    if (row.server_id == null || row.server_id === '') {
      const pendingCreate = db
        .prepare(
          `SELECT 1 FROM pending_changes WHERE entity_type = 'absence' AND entity_id = ? AND action IN ('create','update') LIMIT 1`,
        )
        .get(String(row.id));
      if (pendingCreate) continue;
      // Auch ohne Pending: lokal ohne server_id nicht löschen (Orphan bis Mapping).
      continue;
    }
    const serverId = row.server_id;
    if (receivedAbsenceServerIds.has(Number(serverId)) || receivedAbsenceServerIds.has(String(serverId))) continue;
    const pendingKeep = db
      .prepare(
        `SELECT 1 FROM pending_changes WHERE entity_type = 'absence' AND (entity_id = ? OR entity_id = ?) LIMIT 1`,
      )
      .get(String(row.id), String(serverId));
    if (pendingKeep) continue;
    db.prepare('DELETE FROM absences WHERE id = ?').run(row.id);
  }
}

function absencePeriodDedupeKeyGlobal(technicianId, start, end) {
  function normDt(v) {
    if (v == null) return '';
    let s = String(v).replace('T', ' ').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
    return s;
  }
  return String(technicianId || '') + '\t' + normDt(start) + '\t' + normDt(end);
}

function isAbsenceExpiredByEnd(endDatetime) {
  const endYmd = String(endDatetime || '').replace('T', ' ').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) return false;
  const today = new Date();
  const todayYmd =
    today.getFullYear() +
    '-' +
    String(today.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(today.getDate()).padStart(2, '0');
  return endYmd < todayYmd;
}

/**
 * Kalender-Cache kann veraltete Abwesenheiten enthalten (z. B. wenn calendar.php-Sync fehlschlug,
 * während my_absences-Pull bereits gelöscht hat). Für den eingeloggten Monteur Cache an lokale DB angleichen.
 */
function reconcileCalendarCacheAbsencesForTechnician(db, technicianId) {
  const tid = Number(technicianId);
  if (!Number.isFinite(tid) || tid <= 0) return 0;
  const localAbs = db
    .prepare('SELECT server_id, start_datetime, end_datetime FROM absences WHERE technician_id = ?')
    .all(tid);
  const localReq = db
    .prepare(
      "SELECT server_id, start_datetime, end_datetime FROM absence_requests WHERE technician_id = ? AND status IN ('approved', 'pending')",
    )
    .all(tid);
  const allowedServerIds = new Set();
  const allowedPeriodKeys = new Set();
  const remember = (r) => {
    if (r.server_id != null && r.server_id !== '') {
      allowedServerIds.add(Number(r.server_id));
      allowedServerIds.add(String(r.server_id));
    }
    allowedPeriodKeys.add(absencePeriodDedupeKeyGlobal(tid, r.start_datetime, r.end_datetime));
  };
  localAbs.forEach(remember);
  localReq.forEach(remember);
  const cacheRows = db
    .prepare(
      'SELECT cache_key, server_absence_id, start_datetime, end_datetime FROM calendar_cache_absences WHERE technician_id = ?',
    )
    .all(tid);
  let deleted = 0;
  for (const c of cacheRows) {
    const sid = c.server_absence_id;
    const periodKey = absencePeriodDedupeKeyGlobal(tid, c.start_datetime, c.end_datetime);
    if (sid != null && sid !== '' && (allowedServerIds.has(Number(sid)) || allowedServerIds.has(String(sid)))) {
      continue;
    }
    if (allowedPeriodKeys.has(periodKey)) continue;
    db.prepare('DELETE FROM calendar_cache_absences WHERE cache_key = ?').run(c.cache_key);
    deleted++;
  }
  return deleted;
}

/**
 * Verwaiste lokale Abwesenheits-Daten entfernen (Geister im Kalender ohne Server-/Listen-Entsprechung).
 * @param {Set<number|string>} receivedAbsenceServerIds IDs aus dem letzten my_absences-Pull
 */
function reconcileLocalAbsenceOrphans(db, technicianId, receivedAbsenceServerIds) {
  const tid = Number(technicianId);
  if (!Number.isFinite(tid) || tid <= 0) return { absences: 0, requests: 0 };
  const received = receivedAbsenceServerIds || new Set();
  let absencesDeleted = 0;
  let requestsDeleted = 0;

  const localAbsRows = db.prepare('SELECT id, server_id FROM absences WHERE technician_id = ?').all(tid);
  for (const row of localAbsRows) {
    const sid = row.server_id;
    if (sid != null && sid !== '') continue;
    const pending = db
      .prepare(
        `SELECT 1 FROM pending_changes WHERE entity_type = 'absence' AND entity_id = ? AND action IN ('create', 'update', 'delete') LIMIT 1`,
      )
      .get(row.id);
    if (pending) continue;
    db.prepare('DELETE FROM absences WHERE id = ?').run(row.id);
    absencesDeleted++;
  }

  const periodKeys = new Set();
  db.prepare('SELECT server_id, start_datetime, end_datetime FROM absences WHERE technician_id = ?').all(tid).forEach((r) => {
    periodKeys.add(absencePeriodDedupeKeyGlobal(tid, r.start_datetime, r.end_datetime));
    if (r.server_id != null && r.server_id !== '') {
      periodKeys.add('sid:' + String(r.server_id));
    }
  });

  const reqs = db
    .prepare(
      `SELECT id, server_id, start_datetime, end_datetime, status FROM absence_requests WHERE technician_id = ? AND status IN ('approved', 'pending')`,
    )
    .all(tid);

  for (const r of reqs) {
    const periodKey = absencePeriodDedupeKeyGlobal(tid, r.start_datetime, r.end_datetime);
    if (periodKeys.has(periodKey)) {
      if (r.status === 'approved') {
        db.prepare('DELETE FROM absence_requests WHERE id = ?').run(r.id);
        requestsDeleted++;
      }
      continue;
    }
    const reqSid = r.server_id;
    if (reqSid != null && reqSid !== '' && (received.has(Number(reqSid)) || received.has(String(reqSid)))) {
      continue;
    }
    if (r.status === 'approved') {
      db.prepare('DELETE FROM absence_requests WHERE id = ?').run(r.id);
      requestsDeleted++;
      continue;
    }
    if (r.status === 'pending' && reqSid != null && reqSid !== '' && received.size > 0) {
      db.prepare('DELETE FROM absence_requests WHERE id = ?').run(r.id);
      requestsDeleted++;
    }
  }

  return { absences: absencesDeleted, requests: requestsDeleted };
}

/**
 * Entfernt lokale Anfragen, die der Server in absence_request_status nicht mehr kennt.
 */
function reconcileAbsenceRequestsWithServerStatus(db, technicianId, serverRequestRows) {
  const tid = Number(technicianId);
  if (!Number.isFinite(tid) || tid <= 0 || !Array.isArray(serverRequestRows)) return 0;
  const serverIds = new Set();
  for (const req of serverRequestRows) {
    if (req && req.id != null) {
      serverIds.add(Number(req.id));
      serverIds.add(String(req.id));
    }
  }
  let deleted = 0;
  const localRows = db
    .prepare(
      `SELECT id, server_id FROM absence_requests WHERE technician_id = ? AND server_id IS NOT NULL AND server_id != ''`,
    )
    .all(tid);
  for (const row of localRows) {
    const sid = row.server_id;
    if (serverIds.has(Number(sid)) || serverIds.has(String(sid))) continue;
    db.prepare('DELETE FROM absence_requests WHERE id = ?').run(row.id);
    deleted++;
  }
  return deleted;
}

async function fetchDispoMonteurList(base, technicianId, authHeader, dateFrom, dateTo, fileName, label) {
  const q = new URLSearchParams({ technician_id: String(technicianId) });
  if (dateFrom) q.set('date_from', String(dateFrom));
  if (dateTo) q.set('date_to', String(dateTo));
  const fetchOpts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
  const candidates = [
    `${base}/dispo_api/api/${fileName}?${q}`,
    `${base}/api/${fileName}?${q}`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, fetchOpts);
      if (r.ok) return { res: r, url };
      lastErr = new Error(label + ': ' + r.status + ' ' + r.statusText + ' (' + url + ')');
      if (r.status === 401 || r.status === 429) throw lastErr;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? String(e.message) : '';
      if (/\b(401|429)\b/.test(msg)) throw e;
    }
  }
  throw lastErr || new Error(label + ' nicht erreichbar.');
}

async function fetchMyJobsForPull(base, technicianId, authHeader, dateFrom, dateTo) {
  return fetchDispoMonteurList(base, technicianId, authHeader, dateFrom, dateTo, 'my_jobs.php', 'Aufträge');
}

async function fetchMyAbsencesForPull(base, technicianId, authHeader, dateFrom, dateTo) {
  return fetchDispoMonteurList(base, technicianId, authHeader, dateFrom, dateTo, 'my_absences.php', 'Abwesenheiten');
}

async function pullFromServer(baseUrl, technicianId, db, authHeader, dateFrom, dateTo) {
  const base = baseUrl.replace(/\/$/, '');
  let jobsRes;
  let absencesRes;
  let jobsPullUrl = '';
  try {
    const jobsFetch = await fetchMyJobsForPull(base, technicianId, authHeader, dateFrom, dateTo);
    jobsRes = jobsFetch.res;
    jobsPullUrl = jobsFetch.url;
    const absencesFetch = await fetchMyAbsencesForPull(base, technicianId, authHeader, dateFrom, dateTo);
    absencesRes = absencesFetch.res;
  } catch (e) {
    throw new Error('Dispo-Server nicht erreichbar: ' + e.message + '. Prüfen Sie die Adresse (z. B. http://localhost/) und ob der Server läuft.');
  }
  if (!jobsRes.ok || !absencesRes.ok) {
    const parts = [];
    if (!jobsRes.ok) parts.push('Aufträge: ' + jobsRes.status + ' ' + jobsRes.statusText);
    if (!absencesRes.ok) parts.push('Abwesenheiten: ' + absencesRes.status + ' ' + absencesRes.statusText);
    throw new Error(
      'Pull fehlgeschlagen (' +
        parts.join('; ') +
        '). Erwartet erreichbar: ' +
        (jobsPullUrl || base + '/dispo_api/api/my_jobs.php') +
        ' oder ' +
        base +
        '/api/my_jobs.php',
    );
  }
  const jobsData = await jobsRes.json();
  const jobs = jobsData.jobs || [];
  const absencesData = await absencesRes.json();
  const absences = absencesData.absences || [];
  const fabs = extractFabsFromJobs(jobs);
  const receivedJobServerIds = new Set();
  const uniqueReceivedJobIds = new Set();
  for (const j of jobs) {
    const id = j.id;
    if (id != null) {
      receivedJobServerIds.add(Number(id));
      receivedJobServerIds.add(String(id));
      uniqueReceivedJobIds.add(String(id));
    }
  }
  const receivedAbsenceServerIds = new Set();
  for (const a of absences) {
    const id = a.id;
    if (id != null) { receivedAbsenceServerIds.add(Number(id)); receivedAbsenceServerIds.add(String(id)); }
  }
  const localAssignedRow = db
    .prepare(
      'SELECT COUNT(*) AS n FROM jobs j INNER JOIN job_technicians jt ON jt.job_id = j.id WHERE jt.technician_id = ?',
    )
    .get(technicianId);
  const localAssignedCount = localAssignedRow && localAssignedRow.n != null ? Number(localAssignedRow.n) : 0;
  const pullGuard = evaluateJobPullRemovalGuard(localAssignedCount, uniqueReceivedJobIds.size);
  console.log(
    '[sync_pull] jobs local=' +
      pullGuard.localCount +
      ' received=' +
      pullGuard.receivedCount +
      (pullGuard.skipRemoval ? ' skipRemoval=1' : ''),
  );
  const warnings = [];
  if (pullGuard.warning) warnings.push(pullGuard.warning);

  db.transaction(() => {
    ensureTechnician(db, technicianId);
    removeLocalJobsNotInDispo(db, technicianId, receivedJobServerIds, {
      skipRemoval: pullGuard.skipRemoval,
      reason: pullGuard.warning || '',
    });
    if (!pullGuard.skipRemoval) {
      const purgedMirrors = purgeUnassignedMirrorJobs(db);
      if (purgedMirrors) {
        console.log('[sync_pull] unzugewiesene Spiegel-Aufträge entfernt:', purgedMirrors);
      }
    }
    removeLocalAbsencesNotInDispo(db, technicianId, receivedAbsenceServerIds);
    for (const j of jobs) {
      const custId = ensureCustomer(db, j);
      const localId = insertOrUpdateJob(db, j, custId, technicianId);
      dropStaleEmptyFabPendingOnPull(db, localId, j.fabrikationsnummern);
    }
    for (const a of absences) {
      insertOrUpdateAbsence(db, a, technicianId);
    }
    reconcileCalendarCacheAbsencesForTechnician(db, technicianId);
    const orphanResult = reconcileLocalAbsenceOrphans(db, technicianId, receivedAbsenceServerIds);
    if (orphanResult.absences > 0 || orphanResult.requests > 0) {
      console.log(
        '[sync_pull] verwaiste Abwesenheiten bereinigt (Monteur ' +
          technicianId +
          '): absences=' +
          orphanResult.absences +
          ', requests=' +
          orphanResult.requests,
      );
    }
  });

  const fullName = (jobsData.technician_full_name != null && String(jobsData.technician_full_name).trim()) ? String(jobsData.technician_full_name).trim() : null;
  const username = (jobsData.technician_username != null && String(jobsData.technician_username).trim()) ? String(jobsData.technician_username).trim() : null;
  if (fullName != null || username != null) {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(technicianId);
    if (existing) {
      if (fullName != null && username != null) {
        db.prepare('UPDATE users SET full_name = ?, username = ? WHERE id = ?').run(fullName, username, technicianId);
      } else if (fullName != null) {
        db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(fullName, technicianId);
      } else {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, technicianId);
      }
    }
  }
  return { fabs, warnings, pull_guard: pullGuard };
}

function ensureTechnician(db, technicianId) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(technicianId);
  if (existing) return;
  db.prepare('INSERT OR IGNORE INTO users (id, username, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run(
    technicianId,
    'tech_' + technicianId,
    'Monteur',
    'monteur',
    1
  );
}

function ensureCustomer(db, j) {
  const name = j.customer_name || 'Unbekannt';
  const row = db.prepare('SELECT id FROM customers WHERE name = ? LIMIT 1').get(name);
  if (row) return row.id;
  const r = db.prepare('INSERT INTO customers (name, street, house_number, zip, city, phone, contact_person, contact_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    name, j.street || '', j.house_number || '', j.zip || '', j.city || '', j.customer_phone || '', j.contact_person || '', j.contact_phone || ''
  );
  return r.lastInsertRowid;
}

function getPendingJobFabrikationsnummern(db, localJobId) {
  const row = db
    .prepare(
      `SELECT payload FROM pending_changes
       WHERE entity_type = 'job' AND entity_id = ? AND action = 'fabrikationsnummern'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(localJobId);
  if (!row) return undefined;
  try {
    const p = JSON.parse(row.payload || '{}');
    if (p.fabrikationsnummern === undefined) return undefined;
    const v = p.fabrikationsnummern;
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch (_) {
    return undefined;
  }
}

function resolveFabrikationsnummernForPull(db, localJobId, serverFab) {
  const pending = getPendingJobFabrikationsnummern(db, localJobId);
  if (pending !== undefined) return pending;
  return serverFab != null ? serverFab : null;
}

/** Nach Pull: leeres FN-Pending verwerfen, wenn Dispo bereits Leistungszeilen liefert (Race sync_push). */
function dropStaleEmptyFabPendingOnPull(db, localJobId, serverFab) {
  const serverRows = parseJobFabrikationsnummernRows(serverFab);
  if (serverRows.length === 0) return;
  const pending = getPendingJobFabrikationsnummern(db, localJobId);
  if (pending === undefined) return;
  if (parseJobFabrikationsnummernRows(pending).length > 0) return;
  const entityIds = [localJobId];
  const mapped = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(localJobId);
  if (mapped && mapped.server_id != null && String(mapped.server_id).trim() !== '') {
    entityIds.push(mapped.server_id);
  }
  for (const eid of entityIds) {
    db.prepare(
      `DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'fabrikationsnummern'`,
    ).run(eid);
  }
}

/** Pull: lokale/pending Leistungszeilen mit Dispo-Stand zusammenführen (nie blind überschreiben). */
function mergeFabForJobPull(db, localJobId, serverFab) {
  const pending = getPendingJobFabrikationsnummern(db, localJobId);
  const curRow = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
  const curFab = curRow && curRow.fabrikationsnummern ? curRow.fabrikationsnummern : null;
  let localFab = curFab;
  if (pending !== undefined) {
    localFab = curFab ? mergeJobFabrikationsnummernJson(curFab, pending) || pending : pending;
  }
  if (serverFab == null || serverFab === '') {
    return localFab != null ? enrichFabJsonWithLocalAnlagenstamm(db, localFab) : null;
  }
  if (!localFab) return enrichFabJsonWithLocalAnlagenstamm(db, serverFab);
  const merged = mergeJobFabrikationsnummernJson(localFab, serverFab) || localFab;
  return enrichFabJsonWithLocalAnlagenstamm(db, merged);
}

/** Baustellen-Ansprechpartner aus Dispo-Payload (nicht Kunden-contact_person). */
const JOB_CONTACTS_SELECT_SQL = `SELECT contact_name, contact_phone, contact_email, first_name, last_name, title, department, phone, mobile, email FROM job_contacts`;
const JOB_CONTACTS_SELECT_WITH_JOB_SQL = `SELECT job_id, contact_name, contact_phone, contact_email, first_name, last_name, title, department, phone, mobile, email FROM job_contacts`;

function normalizeJobContactPayload(input) {
  const raw = input && typeof input === 'object' ? input : {};
  let fn = raw.first_name != null ? String(raw.first_name).trim() : '';
  let ln = raw.last_name != null ? String(raw.last_name).trim() : '';
  const title = raw.title != null ? String(raw.title).trim() : '';
  const dept = raw.department != null ? String(raw.department).trim() : '';
  let phone = raw.phone != null ? String(raw.phone).trim() : '';
  let mobile = raw.mobile != null ? String(raw.mobile).trim() : '';
  let email = raw.email != null ? String(raw.email).trim() : '';
  let legacyName = raw.contact_name != null ? String(raw.contact_name).trim() : '';
  const legacyPhone = raw.contact_phone != null ? String(raw.contact_phone).trim() : '';
  const legacyEmail = raw.contact_email != null ? String(raw.contact_email).trim() : '';
  // contact_phone spiegelt oft phone||mobile – nicht als Festnetz setzen, wenn es die Mobilnummer ist.
  if (!phone && legacyPhone && legacyPhone !== mobile) phone = legacyPhone;
  if (phone && mobile && phone === mobile) phone = '';
  if (!email && legacyEmail) email = legacyEmail;
  if (!fn && !ln && legacyName) {
    const parts = legacyName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      fn = parts.shift();
      ln = parts.join(' ');
    } else {
      ln = legacyName;
    }
  }
  const combined = `${fn} ${ln}`.trim();
  const displayName = legacyName || combined;
  const legacyPhoneSingle = phone || mobile;
  return {
    first_name: fn || null,
    last_name: ln || null,
    title: title || null,
    department: dept || null,
    phone: phone || null,
    mobile: mobile || null,
    email: email || null,
    contact_name: displayName || null,
    contact_phone: legacyPhoneSingle || null,
    contact_email: email || null,
  };
}

function jobContactHasAny(n) {
  return !!(
    (n.contact_name && String(n.contact_name).trim())
    || (n.phone && String(n.phone).trim())
    || (n.mobile && String(n.mobile).trim())
    || (n.email && String(n.email).trim())
    || (n.first_name && String(n.first_name).trim())
    || (n.last_name && String(n.last_name).trim())
    || (n.title && String(n.title).trim())
    || (n.department && String(n.department).trim())
  );
}

function jobContactToApiRow(n) {
  return {
    contact_name: n.contact_name || '',
    contact_phone: n.contact_phone || '',
    contact_email: n.contact_email || '',
    first_name: n.first_name || '',
    last_name: n.last_name || '',
    title: n.title || '',
    department: n.department || '',
    phone: n.phone || '',
    mobile: n.mobile || '',
    email: n.email || '',
  };
}

function insertJobContactRow(dbConn, jobId, n, sortOrder) {
  dbConn.prepare(
    `INSERT INTO job_contacts (job_id, contact_name, contact_phone, contact_email, first_name, last_name, title, department, phone, mobile, email, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    n.contact_name || null,
    n.contact_phone || null,
    n.contact_email || null,
    n.first_name || null,
    n.last_name || null,
    n.title || null,
    n.department || null,
    n.phone || null,
    n.mobile || null,
    n.email || null,
    sortOrder,
  );
}

function mapJobContactDbRow(r) {
  return {
    contact_name: r.contact_name,
    contact_phone: r.contact_phone,
    contact_email: r.contact_email,
    first_name: r.first_name,
    last_name: r.last_name,
    title: r.title,
    department: r.department,
    phone: r.phone,
    mobile: r.mobile,
    email: r.email,
  };
}

function normalizeJobContactsFromPayload(job) {
  if (!job || typeof job !== 'object') return [];
  // Nur eine Quelle – sonst verdoppeln sich Kontakte, wenn mehrere Keys gesetzt sind.
  let rawList = [];
  if (Array.isArray(job.job_contacts)) rawList = job.job_contacts;
  else if (Array.isArray(job.jobContacts)) rawList = job.jobContacts;
  else if (Array.isArray(job.contacts)) rawList = job.contacts;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i++) {
    const n = normalizeJobContactPayload(rawList[i] || {});
    if (!jobContactHasAny(n)) continue;
    const row = jobContactToApiRow(n);
    const key = [
      String(row.first_name || '').trim().toLowerCase(),
      String(row.last_name || '').trim().toLowerCase(),
      String(row.contact_name || '').trim().toLowerCase(),
      String(row.title || '').trim().toLowerCase(),
      String(row.department || '').trim().toLowerCase(),
      String(row.phone || '').trim(),
      String(row.mobile || '').trim(),
      String(row.email || '').trim().toLowerCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  if (out.length > 0) return out;
  const directName = (job.baustellen_ansprechpartner != null ? String(job.baustellen_ansprechpartner) : '').trim();
  const directPhone = (job.job_contact_phone != null ? String(job.job_contact_phone) : (job.baustelle_phone != null ? String(job.baustelle_phone) : '')).trim();
  const directEmail = (job.job_contact_email != null ? String(job.job_contact_email) : (job.baustelle_email != null ? String(job.baustelle_email) : '')).trim();
  if (directName || directPhone || directEmail) {
    return [jobContactToApiRow(normalizeJobContactPayload({
      contact_name: directName,
      contact_phone: directPhone,
      contact_email: directEmail,
    }))];
  }
  return [];
}

function upsertJobContactsForLocalJob(db, localJobId, j) {
  if (!j || typeof j !== 'object') return;
  const keyPresent =
    Object.prototype.hasOwnProperty.call(j, 'job_contacts')
    || Object.prototype.hasOwnProperty.call(j, 'jobContacts')
    || Object.prototype.hasOwnProperty.call(j, 'contacts');
  const contacts = normalizeJobContactsFromPayload(j);
  // Ohne Kontakt-Felder im Payload nichts anfassen (Altserver ohne job_contacts).
  if (!keyPresent && !contacts.length) return;
  try {
    // Ungepushte lokale Edits nicht mit Server-Stand überschreiben.
    if (getPendingJobActionPayload(db, localJobId, 'job_contacts')) return;
    db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(localJobId);
    for (let i = 0; i < contacts.length; i++) {
      const n = normalizeJobContactPayload(contacts[i]);
      if (!jobContactHasAny(n)) continue;
      insertJobContactRow(db, localJobId, n, i);
    }
  } catch (e) { /* Tabelle fehlt */ }
}

function attachJobContactsToJobs(db, jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  const ids = jobs.map((row) => row.id).filter((id) => id != null);
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(
      `${JOB_CONTACTS_SELECT_WITH_JOB_SQL} WHERE job_id IN (${placeholders}) ORDER BY sort_order, id`,
    ).all(...ids);
  } catch (e) {
    return;
  }
  const byJob = {};
  for (const r of rows) {
    if (!byJob[r.job_id]) byJob[r.job_id] = [];
    byJob[r.job_id].push(mapJobContactDbRow(r));
  }
  for (const job of jobs) {
    job.job_contacts = byJob[job.id] || [];
  }
}

const JOB_STATUS_RANK = {
  angelegt: 10,
  geplant: 20,
  zugeteilt: 30,
  in_arbeit: 40,
  erledigt: 50,
  abgerechnet: 60,
};

function jobStatusRank(status) {
  const s = String(status || '').trim().toLowerCase();
  return JOB_STATUS_RANK[s] != null ? JOB_STATUS_RANK[s] : 0;
}

function parseDispoTimestampMs(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim().replace(' ', 'T');
  const ms = Date.parse(s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return Number.isFinite(ms) ? ms : 0;
}

function ensureJobsServerUpdatedAtColumn(db) {
  try {
    db.prepare('ALTER TABLE jobs ADD COLUMN server_updated_at TEXT').run();
  } catch (_) {
    /* exists */
  }
}

function getPendingJobActionPayload(db, localJobId, action) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return undefined;
  const entityIds = [lid];
  const mapped = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(lid);
  if (mapped && mapped.server_id != null && String(mapped.server_id).trim() !== '') {
    entityIds.push(mapped.server_id);
  }
  for (const eid of entityIds) {
    const row = db
      .prepare(
        `SELECT payload FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(eid, action);
    if (!row) continue;
    try {
      return JSON.parse(row.payload || '{}');
    } catch (_) {
      /* ignore */
    }
  }
  return undefined;
}

function getPendingJobStatusPayload(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return null;
  const entityIds = [lid];
  const mapped = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(lid);
  if (mapped && mapped.server_id != null && String(mapped.server_id).trim() !== '') {
    entityIds.push(mapped.server_id);
  }
  for (const eid of entityIds) {
    const rows = db
      .prepare(
        `SELECT payload FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status' ORDER BY id DESC LIMIT 1`,
      )
      .all(eid);
    for (const p of rows) {
      try {
        const pl = JSON.parse(p.payload || '{}');
        const st = String(pl.status || '').trim().toLowerCase();
        if (st) return st;
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

/** Verwirft ausstehende Status-Pushes nur bei Admin-Downgrade unter in_arbeit. */
function clearSupersededPendingJobStatusOnPull(db, localJobId, serverStatus) {
  const st = String(serverStatus || '').trim().toLowerCase();
  if (st === 'erledigt' || st === 'abgerechnet') return;
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return;
  const entityIds = [lid];
  const mapped = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(lid);
  if (mapped && mapped.server_id != null && String(mapped.server_id).trim() !== '') {
    entityIds.push(mapped.server_id);
  }
  const serverRank = jobStatusRank(st);
  const inArbeitRank = jobStatusRank('in_arbeit');
  for (const eid of entityIds) {
    const pending = db
      .prepare(
        `SELECT id, payload FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`,
      )
      .all(eid);
    for (const p of pending) {
      try {
        const pl = JSON.parse(p.payload || '{}');
        const plSt = String(pl.status || '').trim().toLowerCase();
        const pendingRank = jobStatusRank(plSt);
        // Nur Admin-Rückgabe unter in_arbeit (zugeteilt/angelegt/…) verwirft Pending.
        // Pending erledigt bei Server in_arbeit behalten.
        const adminDowngrade = serverRank > 0 && serverRank < inArbeitRank;
        const dropAheadOnDowngrade =
          adminDowngrade && pendingRank > 0 && pendingRank > serverRank;
        if (dropAheadOnDowngrade) {
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function applyJobTechnicianOpts(db, localJobId, technicianId, j, opts) {
  opts = opts || {};
  const lid = Number(localJobId);
  if (!Number.isFinite(lid) || lid <= 0) return;
  if (opts.assignTechnician !== false) {
    const dispCount = Number(j && j.dispo_jt_count);
    const tid = Number(technicianId);
    if ((!Number.isFinite(dispCount) || dispCount > 0) && Number.isFinite(tid) && tid > 0) {
      ensureTechnician(db, tid);
      db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(lid, tid);
    }
  }
  const extra = Array.isArray(opts.assignedTechnicianIds) ? opts.assignedTechnicianIds : [];
  for (const raw of extra) {
    const extraTid = Number(raw);
    if (!Number.isFinite(extraTid) || extraTid <= 0) continue;
    ensureTechnician(db, extraTid);
    db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(lid, extraTid);
  }
}

function insertOrUpdateJob(db, j, customerId, technicianId, opts) {
  opts = opts || {};
  ensureJobsServerUpdatedAtColumn(db);
  const id = j.id;
  const existing = db.prepare('SELECT id FROM jobs WHERE server_id = ?').get(id);
  const start = (j.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (j.end_datetime || '').replace('T', ' ').substring(0, 19);
  const rawSt = String(j.status || '').toLowerCase();
  const KNOWN = new Set(['angelegt', 'zugeteilt', 'in_arbeit', 'erledigt', 'abgerechnet', 'geplant']);
  const status = KNOWN.has(rawSt) ? rawSt : 'angelegt';
  const dateNotFixed = Number(j.date_not_fixed) === 1 ? 1 : 0;
  const remoteUpdatedAt = j.updated_at != null ? String(j.updated_at) : j.server_updated_at != null ? String(j.server_updated_at) : null;
  const remoteTs = parseDispoTimestampMs(remoteUpdatedAt);
  if (existing) {
    const prevRow = db
      .prepare('SELECT status, description, start_datetime, end_datetime, date_not_fixed, server_updated_at FROM jobs WHERE id = ?')
      .get(existing.id);
    const prevSt = String((prevRow && prevRow.status) || '').trim().toLowerCase();
    const localTs = parseDispoTimestampMs(prevRow && prevRow.server_updated_at);
    const serverIsFresher = !localTs || !remoteTs || remoteTs > localTs;
    const fabForLocal = mergeFabForJobPull(db, existing.id, j.fabrikationsnummern);

    let nextStatus = status;
    let nextDesc = j.description != null ? j.description : null;
    let nextStart = start;
    let nextEnd = end;
    let nextDateNotFixed = dateNotFixed;

    const pendingStatus = getPendingJobStatusPayload(db, existing.id);
    const pendingDesc = getPendingJobActionPayload(db, existing.id, 'description');

    if (pendingStatus) {
      nextStatus = pendingStatus;
    } else if (!serverIsFresher && prevRow && prevRow.status) {
      nextStatus = String(prevRow.status);
    }

    if (pendingDesc && pendingDesc.description !== undefined) {
      nextDesc = pendingDesc.description;
    } else if (!serverIsFresher && prevRow) {
      nextDesc = prevRow.description;
    }

    if (!serverIsFresher && !pendingStatus && prevRow) {
      if (prevRow.start_datetime) nextStart = String(prevRow.start_datetime).replace('T', ' ').substring(0, 19);
      if (prevRow.end_datetime) nextEnd = String(prevRow.end_datetime).replace('T', ' ').substring(0, 19);
      if (prevRow.date_not_fixed != null) nextDateNotFixed = Number(prevRow.date_not_fixed) === 1 ? 1 : 0;
    }

    db.prepare('UPDATE jobs SET job_number = ?, customer_id = ?, job_type = ?, start_datetime = ?, end_datetime = ?, status = ?, date_not_fixed = ?, description = ?, fabrikationsnummern = ?, eap_nummer = ?, bestellnummer = ?, synced_at = datetime(\'now\'), server_updated_at = COALESCE(?, server_updated_at) WHERE id = ?').run(
      j.job_number || null, customerId, j.job_type || 'Service', nextStart, nextEnd, nextStatus, nextDateNotFixed, nextDesc, fabForLocal, j.eap_nummer || null, j.bestellnummer || null,
      serverIsFresher && remoteUpdatedAt ? remoteUpdatedAt : null,
      existing.id
    );
    clearSupersededPendingJobStatusOnPull(db, existing.id, status);
    try {
      const keptPending = getPendingJobStatusPayload(db, existing.id);
      if (keptPending) {
        db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(keptPending, existing.id);
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const applied = db.prepare('SELECT status FROM jobs WHERE id = ?').get(existing.id);
      const st = String((applied && applied.status) || nextStatus || '').trim().toLowerCase();
      if (st === 'erledigt' || st === 'abgerechnet') {
        protocolDrafts.freezeJob(db, existing.id);
      }
    } catch (_) {
      /* ignore */
    }
    if (
      prevSt === 'in_arbeit' &&
      (status === 'erledigt' || status === 'zugeteilt' || status === 'abgerechnet')
    ) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS jobs_pending_local_cleanup (
            local_job_id INTEGER PRIMARY KEY,
            server_job_id INTEGER,
            reason TEXT NOT NULL,
            status_on_server TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
        db.prepare(
          `INSERT INTO jobs_pending_local_cleanup (local_job_id, server_job_id, reason, status_on_server, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(local_job_id) DO UPDATE SET
             server_job_id = excluded.server_job_id,
             reason = excluded.reason,
             status_on_server = excluded.status_on_server,
             created_at = datetime('now')`,
        ).run(
          existing.id,
          id,
          status === 'zugeteilt' ? 'released_remote' : 'closed_remote',
          status,
        );
      } catch (_) {
        /* ignore */
      }
    }
    if (j.street != null) insertOrUpdateJobAddress(db, existing.id, j);
    if (hasHotelFields(j)) insertOrUpdateJobHotel(db, existing.id, j);
    upsertJobContactsForLocalJob(db, existing.id, j);
    applyJobTechnicianOpts(db, existing.id, technicianId, j, opts);
    return existing.id;
  }
  // Verwaisten lokalen Auftrag (ohne server_id) mit Dispo-Auftrag verknüpfen – dann bleibt die lokale ID erhalten
  let orphan = null;
  const jobNumber = (j.job_number != null && String(j.job_number).trim() !== '') ? String(j.job_number).trim() : null;
  const customerName = (j.customer_name != null && String(j.customer_name).trim() !== '') ? String(j.customer_name).trim() : null;
  const startDate = start.substring(0, 10); // YYYY-MM-DD
  if (jobNumber) {
    orphan = db.prepare(`
      SELECT j.id FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      WHERE (j.server_id IS NULL OR j.server_id = '') AND j.job_number = ?
      LIMIT 1
    `).get(technicianId, jobNumber);
  }
  if (!orphan && customerName && startDate) {
    const orphans = db.prepare(`
      SELECT j.id FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      INNER JOIN customers c ON c.id = j.customer_id
      WHERE (j.server_id IS NULL OR j.server_id = '') AND TRIM(c.name) = ? AND (j.start_datetime IS NULL OR j.start_datetime LIKE ?)
      LIMIT 2
    `).all(technicianId, customerName, startDate + '%');
    if (orphans.length === 1) orphan = orphans[0];
  }
  if (orphan) {
    const fabOrphan = mergeFabForJobPull(db, orphan.id, j.fabrikationsnummern);
    db.prepare('UPDATE jobs SET server_id = ?, job_number = ?, customer_id = ?, job_type = ?, start_datetime = ?, end_datetime = ?, status = ?, date_not_fixed = ?, description = ?, fabrikationsnummern = ?, eap_nummer = ?, bestellnummer = ?, synced_at = datetime(\'now\'), server_updated_at = ? WHERE id = ?').run(
      id, j.job_number || null, customerId, j.job_type || 'Service', start, end, status, dateNotFixed, j.description || null, fabOrphan, j.eap_nummer || null, j.bestellnummer || null, remoteUpdatedAt, orphan.id
    );
    clearSupersededPendingJobStatusOnPull(db, orphan.id, status);
    try {
      if (status === 'erledigt' || status === 'abgerechnet') {
        protocolDrafts.freezeJob(db, orphan.id);
      }
    } catch (_) {
      /* ignore */
    }
    if (j.street != null) insertOrUpdateJobAddress(db, orphan.id, j);
    if (hasHotelFields(j)) insertOrUpdateJobHotel(db, orphan.id, j);
    upsertJobContactsForLocalJob(db, orphan.id, j);
    applyJobTechnicianOpts(db, orphan.id, technicianId, j, opts);
    return orphan.id;
  }
  const r2 = db.prepare('INSERT INTO jobs (server_id, job_number, customer_id, job_type, start_datetime, end_datetime, status, date_not_fixed, description, fabrikationsnummern, eap_nummer, bestellnummer, synced_at, server_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), ?)').run(
    id, j.job_number || null, customerId, j.job_type || 'Service', start, end, status, dateNotFixed, j.description || null, j.fabrikationsnummern || null, j.eap_nummer || null, j.bestellnummer || null, remoteUpdatedAt
  );
  const newId = r2.lastInsertRowid;
  if (j.street != null) insertOrUpdateJobAddress(db, newId, j);
  if (hasHotelFields(j)) insertOrUpdateJobHotel(db, newId, j);
  upsertJobContactsForLocalJob(db, newId, j);
  applyJobTechnicianOpts(db, newId, technicianId, j, opts);
  return newId;
}

function hasHotelFields(j) {
  return ['hotel_endkunde', 'hotel_street', 'hotel_house_number', 'hotel_zip', 'hotel_city', 'hotel_country', 'hotel_phone', 'hotel_email', 'hotel_website'].some((k) => j[k] != null && String(j[k]).trim() !== '');
}

function insertOrUpdateJobHotel(db, jobId, j) {
  const endkunde = (j.hotel_endkunde != null ? String(j.hotel_endkunde) : '').trim() || null;
  const street = (j.hotel_street != null ? String(j.hotel_street) : '').trim() || '';
  const house_number = (j.hotel_house_number != null ? String(j.hotel_house_number) : '').trim() || '';
  const zip = postalCodeNormalize((j.hotel_zip != null ? String(j.hotel_zip) : '').trim() || '', (j.hotel_country != null ? String(j.hotel_country) : '').trim() || '');
  const city = (j.hotel_city != null ? String(j.hotel_city) : '').trim() || '';
  const country = (j.hotel_country != null ? String(j.hotel_country) : '').trim() || '';
  const address_extra_1 = (j.hotel_address_extra_1 != null ? String(j.hotel_address_extra_1) : '').trim() || null;
  const address_extra_2 = (j.hotel_address_extra_2 != null ? String(j.hotel_address_extra_2) : '').trim() || null;
  const phone = (j.hotel_phone != null ? String(j.hotel_phone) : '').trim() || null;
  const email = (j.hotel_email != null ? String(j.hotel_email) : '').trim() || null;
  const website = (j.hotel_website != null ? String(j.hotel_website) : '').trim() || null;
  const existing = db.prepare('SELECT job_id FROM job_hotel_addresses WHERE job_id = ?').get(jobId);
  if (existing) {
    db.prepare('UPDATE job_hotel_addresses SET endkunde=?, street=?, house_number=?, zip=?, city=?, country=?, address_extra_1=?, address_extra_2=?, phone=?, email=?, website=? WHERE job_id=?').run(endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website, jobId);
  } else {
    db.prepare('INSERT INTO job_hotel_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website);
  }
  const hotelId = Number(j.hotel_id || 0);
  const comment = j.hotel_comment != null ? String(j.hotel_comment) : null;
  const ratingStars = (j.hotel_rating_stars != null && String(j.hotel_rating_stars).trim() !== '') ? Number(j.hotel_rating_stars) : null;
  const ratingAvg = (j.hotel_rating_avg != null && String(j.hotel_rating_avg).trim() !== '') ? Number(j.hotel_rating_avg) : null;
  const ratingCount = (j.hotel_rating_count != null && String(j.hotel_rating_count).trim() !== '') ? Number(j.hotel_rating_count) : 0;
  if (Number.isFinite(hotelId) && hotelId > 0) {
    db.prepare(`
      INSERT INTO job_hotel_selection (job_id, hotel_id, comment, rating_stars, rating_avg, rating_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(job_id) DO UPDATE SET
        hotel_id=excluded.hotel_id,
        comment=excluded.comment,
        rating_stars=excluded.rating_stars,
        rating_avg=excluded.rating_avg,
        rating_count=excluded.rating_count,
        updated_at=datetime('now')
    `).run(jobId, hotelId, comment, Number.isFinite(ratingStars) ? ratingStars : null, Number.isFinite(ratingAvg) ? ratingAvg : null, Number.isFinite(ratingCount) ? ratingCount : 0);
  }
}

function insertOrUpdateJobAddress(db, jobId, j) {
  const endkunde = j.endkunde || null;
  const street = j.street || '';
  const house = j.house_number || '';
  const country = j.country || 'DE';
  const zip = postalCodeNormalize(j.zip || '', country);
  const city = j.city || '';
  db.prepare('INSERT OR REPLACE INTO job_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    jobId, endkunde, street, house, zip, city, country, j.address_extra_1 || null, j.address_extra_2 || null
  );
}

function insertOrUpdateAbsence(db, a, technicianId) {
  const serverId = a.id;
  const start = (a.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (a.end_datetime || '').replace('T', ' ').substring(0, 19);
  const type = a.type || '';
  const comment = a.comment != null && String(a.comment).trim() !== '' ? String(a.comment).trim() : null;
  const existing = db.prepare('SELECT id FROM absences WHERE server_id = ?').get(serverId);
  if (existing) {
    db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ?, comment = ?, synced_at = datetime(\'now\') WHERE id = ?').run(start, end, type, comment, existing.id);
    return;
  }
  db.prepare('INSERT INTO absences (server_id, technician_id, start_datetime, end_datetime, type, comment, synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(serverId, technicianId, start, end, type, comment);
}

/**
 * Löscht für einen erledigten Auftrag alle lokalen Job-Dateien, die nicht als „Nicht löschen“ markiert sind:
 * Einträge in job_files mit keep_local = 0 und ggf. zugehörige Dateien (stored_path).
 */
function cleanup_completed_job_files(db, jobId) {
  try {
    const rows = db.prepare('SELECT id, stored_path FROM job_files WHERE job_id = ? AND keep_local = 0').all(jobId);
    for (const r of rows) {
      if (r.stored_path && typeof r.stored_path === 'string' && r.stored_path.trim() !== '') {
        try {
          if (fs.existsSync(r.stored_path) && fs.statSync(r.stored_path).isFile()) {
            fs.unlinkSync(r.stored_path);
          }
        } catch (e) {
          // Einzelne Datei-Löschfehler ignorieren
        }
      }
    }
    db.prepare('DELETE FROM job_files WHERE job_id = ? AND keep_local = 0').run(jobId);
  } catch (e) {
    if (!e.message || (!e.message.includes('no such table') && !e.message.includes('job_files'))) {
      console.error('cleanup_completed_job_files:', e.message);
    }
  }
}

function liveDispoCredsForPush(baseUrl, payloadOrCreds) {
  const p = payloadOrCreds && typeof payloadOrCreds === 'object' ? payloadOrCreds : {};
  const creds = typeof resolveDispoServerCreds === 'function' ? resolveDispoServerCreds(p) : p;
  return {
    baseUrl: String(baseUrl || '').trim().replace(/\/$/, ''),
    externalUrl: creds.externalUrl || p.externalUrl || '',
    internalUrl: creds.internalUrl || p.internalUrl || '',
    serverUsername: creds.serverUsername || p.serverUsername || '',
    serverPassword: creds.serverPassword || p.serverPassword || '',
  };
}

function mergeLiveDispoIntoPendingPayload(payloadRaw, live, fallbackBase) {
  const src = payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {};
  const liveObj = live && typeof live === 'object' ? live : {};
  const base = String(liveObj.baseUrl || fallbackBase || src.baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  const out = Object.assign({}, src, {
    baseUrl: base,
    externalUrl: liveObj.externalUrl || src.externalUrl,
    internalUrl: liveObj.internalUrl || src.internalUrl,
  });
  if (base) out.dispoBaseUrl = base;
  if (liveObj.serverUsername) out.serverUsername = liveObj.serverUsername;
  if (liveObj.serverPassword) out.serverPassword = liveObj.serverPassword;
  return out;
}

function markPendingPushSkip(db, pendingRow, message) {
  if (!pendingRow || pendingRow.id == null) return;
  try {
    db.prepare(
      `UPDATE pending_changes SET last_error = ?, last_attempt_at = datetime('now') WHERE id = ?`,
    ).run(String(message || '').slice(0, 4000), pendingRow.id);
  } catch (_) {
    /* Spalten fehlen vor Migration */
  }
}

async function pushToServer(baseUrl, technicianId, db, authHeader, liveCreds) {
  const live = liveDispoCredsForPush(baseUrl, liveCreds);
  const base = (live.baseUrl || String(baseUrl || '')).replace(/\/$/, '');
  let auth = authHeader && authHeader.Authorization ? authHeader : null;
  if (!auth) {
    const u = String(live.serverUsername || '').trim();
    const p = String(live.serverPassword || '');
    if (u && p) {
      auth = { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
    }
  }
  let pushFailures = 0;
  let lastPushFailMsg = '';
  const noteFail = (msg) => {
    pushFailures += 1;
    if (msg) lastPushFailMsg = String(msg);
  };
  const pending = db.prepare('SELECT * FROM pending_changes ORDER BY id').all();
  pending.sort((a, b) => {
    const score = (p) => {
      if (p.entity_type === 'job') return 0;
      if (p.entity_type !== 'anlagenstamm') return 10;
      if (p.action === 'save') return 5;
      if (p.action === 'delete') return 8;
      return 6;
    };
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return (a.id || 0) - (b.id || 0);
  });
  const header = Object.assign(
    { 'Content-Type': 'application/json' },
    dispoMonteurFetchHeaders(technicianId, auth || authHeader),
  );
  for (const p of pending) {
    let handled = false;
    if (p.entity_type === 'job' && (p.action === 'status' || p.action === 'description' || p.action === 'fabrikationsnummern' || p.action === 'hotel_address' || p.action === 'hotel_selection' || p.action === 'job_address' || p.action === 'job_contacts')) {
      handled = true;
      let job = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(p.entity_id);
      if (!job) job = db.prepare('SELECT id, server_id FROM jobs WHERE server_id = ?').get(p.entity_id);
      const hasServerId = job && job.server_id != null && String(job.server_id).trim() !== '';
      const serverJobId = hasServerId ? job.server_id : null;
      if (!job) {
        // Verwaiste Änderung: Auftrag existiert nicht mehr – Eintrag entfernen, Sync fortsetzen
        logSyncPushError({
          reason: 'pending_verwaist',
          pending_entity_id: p.entity_id,
          pending_action: p.action,
          hinweis: 'Auftrag wurde lokal nicht gefunden, Eintrag wird entfernt.'
        });
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        continue;
      }
      if (!serverJobId) {
        const skipMsg =
          'Lokaler Auftrag hat keine Dispo-Verknüpfung (server_id). Eintrag bleibt in der Queue bis nach Sync-Pull.';
        logSyncPushError({
          reason: 'job_ohne_server_id',
          pending_entity_id: p.entity_id,
          pending_action: p.action,
          job_gefunden: true,
          job_id_lokal: job.id,
          job_server_id: job.server_id,
          hinweis: skipMsg,
        });
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      // Techniker-ID aus job_technicians verwenden (Auftrag ist diesem Techniker zugeordnet), nicht aus Einstellungen – sonst meldet Dispo „nicht zugeordnet“
      const techRow = job && job.id != null ? db.prepare('SELECT technician_id FROM job_technicians WHERE job_id = ? LIMIT 1').get(job.id) : null;
      const techIdForPush = (techRow && techRow.technician_id != null) ? techRow.technician_id : technicianId;
      const headerForJob = Object.assign(
        { 'Content-Type': 'application/json' },
        dispoMonteurFetchHeaders(techIdForPush, auth || authHeader),
      );
      const payload = JSON.parse(p.payload || '{}');
      if (p.action === 'hotel_address' && payload && typeof payload === 'object') {
        payload.hotel_country = payload.hotel_country != null ? String(payload.hotel_country) : '';
      }
      if (p.action === 'fabrikationsnummern' && payload.fabrikationsnummern != null) {
        payload.fabrikationsnummern =
          typeof payload.fabrikationsnummern === 'string'
            ? clampFabrikationsnummernJson(payload.fabrikationsnummern)
            : JSON.stringify(
                (Array.isArray(payload.fabrikationsnummern) ? payload.fabrikationsnummern : []).map((row) =>
                  clampForDispoJobFabrikation(row),
                ),
              );
        const pushFabRows = parseJobFabrikationsnummernRows(payload.fabrikationsnummern);
        if (pushFabRows.length === 0) {
          console.warn('[sync_push] fabrikationsnummern: leeres Pending verworfen (würde Dispo-FN löschen)', {
            job_id: serverJobId,
            pending_id: p.id,
          });
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
          continue;
        }
      }
      const body = { job_id: serverJobId, ...payload };
      let r = await fetch(`${base}/dispo_api/api/job.php?technician_id=${techIdForPush}`, { method: 'PATCH', headers: headerForJob, body: JSON.stringify(body) });
      if (
        !r.ok &&
        p.action === 'status' &&
        String(payload.status || '').trim().toLowerCase() === 'erledigt' &&
        r.status === 400
      ) {
        // Dispo: erledigt nur von zugeteilt/in_arbeit — Zwischenstufe versuchen (wie Finish-Sofort-Push).
        try {
          const mid = await fetch(`${base}/dispo_api/api/job.php?technician_id=${techIdForPush}`, {
            method: 'PATCH',
            headers: headerForJob,
            body: JSON.stringify({ job_id: serverJobId, status: 'in_arbeit' }),
          });
          if (mid.ok) {
            r = await fetch(`${base}/dispo_api/api/job.php?technician_id=${techIdForPush}`, {
              method: 'PATCH',
              headers: headerForJob,
              body: JSON.stringify({ job_id: serverJobId, status: 'erledigt' }),
            });
          }
        } catch (_) {
          /* Originalfehler unten behandeln */
        }
      }
      if (!r.ok) {
        let errMsg = 'Dispo: ' + r.status;
        let errData = null;
        try {
          const text = await r.text();
          try { errData = JSON.parse(text); } catch (_) { errData = { _raw: text.substring(0, 500) }; }
          if (errData && typeof errData.error === 'string') errMsg = errData.error;
        } catch (_) {}
        const statusPushRejected = p.action === 'status'
          && r.status === 400
          && /Status-Update fehlgeschlagen/i.test(errMsg);
        if (statusPushRejected) {
          const wantedSt = String(payload.status || '').trim().toLowerCase();
          console.warn('[sync_push] Status nicht übernommen (Dispo-Übergang):', {
            job_id: serverJobId,
            technician_id: techIdForPush,
            payload_status: payload.status,
            error: errMsg,
          });
          // erledigt niemals verwerfen — sonst holt der Pull den Auftrag als offen zurück.
          if (wantedSt !== 'erledigt') {
            db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
          } else {
            markPendingPushSkip(db, p, errMsg);
            noteFail(errMsg);
          }
          continue;
        }
        logSyncPushError({
          reason: 'dispo_antwort_fehler',
          status: r.status,
          statusText: r.statusText,
          body: errData,
          gesendet_job_id: serverJobId,
          gesendet_technician_id: techIdForPush,
          action: p.action
        });
        const pushErr = new Error(errMsg);
        pushErr.status = r.status;
        const outcome = resolveSyncPushFailure(db, p, pushErr, 'job_' + p.action);
        if (outcome === 'retry' || outcome === 'offline') noteFail(errMsg);
        continue;
      }
      db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      if (p.action === 'fabrikationsnummern' && payload.fabrikationsnummern !== undefined && job && job.id != null) {
        const fabVal =
          typeof payload.fabrikationsnummern === 'string'
            ? payload.fabrikationsnummern
            : JSON.stringify(payload.fabrikationsnummern);
        db.prepare(`UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now') WHERE id = ?`).run(fabVal, job.id);
      }
      if (p.action === 'status' && payload.status === 'erledigt') {
        const localJobId = (job && job.id) || p.entity_id;
        cleanup_completed_job_files(db, localJobId);
        db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(localJobId, techIdForPush);
        const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(localJobId);
        if (!rest) {
          db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(localJobId);
          db.prepare('DELETE FROM jobs WHERE id = ?').run(localJobId);
        }
      }
    }
    if (p.entity_type === 'absence') {
      handled = true;
      const dropLocked = function (pendingId) {
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(pendingId);
      };
      if (p.action === 'create') {
        const payload = JSON.parse(p.payload || '{}');
        const r = await fetch(`${base}/api/absence.php?technician_id=${technicianId}`, { method: 'POST', headers: header, body: JSON.stringify({ ...payload, technician_id: technicianId }) });
        if (r.ok) {
          const result = await r.json();
          if (result.id) db.prepare('UPDATE absences SET server_id = ? WHERE id = ?').run(result.id, p.entity_id);
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        } else if (r.status === 403) {
          dropLocked(p.id);
        } else {
          let errBody = null;
          try {
            errBody = await r.json();
          } catch (_) {}
          logSyncPushError({
            reason: 'absence_create',
            status: r.status,
            body: errBody,
            pending_id: p.id,
            entity_id: p.entity_id,
          });
          const absErr = new Error(
            (errBody && errBody.error) || 'Abwesenheit anlegen fehlgeschlagen (HTTP ' + r.status + ')',
          );
          absErr.status = r.status;
          const outcome = resolveSyncPushFailure(db, p, absErr, 'absence_create');
          if (outcome === 'retry' || outcome === 'offline') noteFail(absErr.message);
        }
      } else if (p.action === 'update') {
        const row = db.prepare('SELECT server_id FROM absences WHERE id = ?').get(p.entity_id);
        const serverAbsenceId = (row && row.server_id) ? row.server_id : p.entity_id;
        const payload = JSON.parse(p.payload || '{}');
        const r = await fetch(`${base}/api/absence.php?technician_id=${technicianId}`, { method: 'PATCH', headers: header, body: JSON.stringify({ id: serverAbsenceId, ...payload }) });
        if (r.ok) {
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        } else if (r.status === 403) {
          dropLocked(p.id);
        } else {
          let errBody = null;
          try {
            errBody = await r.json();
          } catch (_) {}
          logSyncPushError({
            reason: 'absence_update',
            status: r.status,
            body: errBody,
            pending_id: p.id,
            entity_id: p.entity_id,
          });
          const absErr = new Error(
            (errBody && errBody.error) || 'Abwesenheit ändern fehlgeschlagen (HTTP ' + r.status + ')',
          );
          absErr.status = r.status;
          const outcome = resolveSyncPushFailure(db, p, absErr, 'absence_update');
          if (outcome === 'retry' || outcome === 'offline') noteFail(absErr.message);
        }
      } else if (p.action === 'delete') {
        const r = await fetch(`${base}/api/absence.php?id=${p.entity_id}&technician_id=${technicianId}`, { method: 'DELETE' });
        if (r.ok || r.status === 403) {
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        } else {
          logSyncPushError({
            reason: 'absence_delete',
            status: r.status,
            pending_id: p.id,
            entity_id: p.entity_id,
          });
          const absErr = new Error('Abwesenheit löschen fehlgeschlagen (HTTP ' + r.status + ')');
          absErr.status = r.status;
          const outcome = resolveSyncPushFailure(db, p, absErr, 'absence_delete');
          if (outcome === 'retry' || outcome === 'offline') noteFail(absErr.message);
        }
      }
    }
    if (p.entity_type === 'anlagenstamm' && p.action === 'save') {
      handled = true;
      const payloadRaw = JSON.parse(p.payload || '{}');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? payloadRaw.technicianId ?? technicianId), 10) ||
        technicianId;
      const fabPending = String(payloadRaw.fabrikationsnummer ?? p.entity_id ?? '').trim();
      const existingStamm = fabPending ? anlagenstammLookupByFab(db, fabPending) : null;
      const mergedPending = mergeAnlagenstammPayload(existingStamm || {}, payloadRaw);
      if (!hasNonemptyStammField(mergedPending)) {
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        continue;
      }
      const pushStammBody = stripEmptyStammFieldsForDispoPush(payloadRaw, existingStamm || {});
      const payload = mergeLiveDispoIntoPendingPayload(
        Object.assign({}, pushStammBody, {
          technician_id: techId,
          serverUsername: payloadRaw.serverUsername,
          serverPassword: payloadRaw.serverPassword,
          externalUrl: payloadRaw.externalUrl,
          internalUrl: payloadRaw.internalUrl,
        }),
        live,
        base,
      );
      const canReachDispo =
        techId > 0 &&
        buildDispoBaseCandidates({
          baseUrl: payload.baseUrl,
          externalUrl: payload.externalUrl,
          internalUrl: payload.internalUrl,
        }).length > 0;
      if (!canReachDispo) {
        const skipMsg = 'Dispo-URL oder Monteur-ID fehlt (Einstellungen prüfen, dann Sync).';
        logSyncPushError({
          reason: 'anlagenstamm_save',
          error: skipMsg,
          entity_id: p.entity_id,
        });
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      try {
        delete payload.id;
        let data = await proxyAnlagenstammSave(
          Object.assign({}, payload, { technician_id: techId }),
        );
        if (data && data.ok === false && /Fabrikationsnummer existiert bereits/i.test(String(data.error || ''))) {
          const retryPayload = Object.assign({}, payload, { technician_id: techId });
          delete retryPayload.id;
          data = await proxyAnlagenstammSave(retryPayload);
        }
        if (data && data.ok === false) {
          throw new Error(data.error || 'Anlagenstamm speichern fehlgeschlagen.');
        }
        const fab = String(payload.fabrikationsnummer ?? '').trim();
        if (fab) {
          if (data && data.id) {
            db.prepare(
              'UPDATE anlagenstamm_local SET id = ?, dirty = 0 WHERE TRIM(fabrikationsnummer) = TRIM(?)',
            ).run(parseInt(data.id, 10), fab);
          } else {
            db.prepare('UPDATE anlagenstamm_local SET dirty = 0 WHERE TRIM(fabrikationsnummer) = TRIM(?)').run(fab);
          }
          dedupeAnlagenstammLocalByFab(db, fab);
          await applyLocalAnlagenstammToMatchingJobs(db, fab);
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const errMsg = e && e.message ? e.message : String(e);
        logSyncPushError({
          reason: 'anlagenstamm_save',
          error: errMsg,
          entity_id: p.entity_id,
        });
        const outcome = resolveSyncPushFailure(db, p, e, 'anlagenstamm_save');
        if (outcome === 'retry' || outcome === 'offline') noteFail(errMsg);
        continue;
      }
    }
    if (p.entity_type === 'anlagenstamm' && p.action === 'delete') {
      handled = true;
      const payloadRaw = JSON.parse(p.payload || '{}');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? payloadRaw.technicianId ?? technicianId), 10) ||
        technicianId;
      const serverId = parseInt(String(payloadRaw.id ?? ''), 10);
      if (serverId <= 0) {
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        continue;
      }
      const payload = mergeLiveDispoIntoPendingPayload(
        Object.assign({}, payloadRaw, {
          id: serverId,
          technician_id: techId,
        }),
        live,
        base,
      );
      const canReachDispo =
        techId > 0 &&
        buildDispoBaseCandidates({
          baseUrl: payload.baseUrl,
          externalUrl: payload.externalUrl,
          internalUrl: payload.internalUrl,
        }).length > 0;
      if (!canReachDispo) {
        const skipMsg = 'Dispo-URL oder Monteur-ID fehlt (Einstellungen prüfen, dann Sync).';
        logSyncPushError({
          reason: 'anlagenstamm_delete',
          error: skipMsg,
          entity_id: p.entity_id,
        });
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      try {
        const data = await proxyAnlagenstammDelete(Object.assign({}, payload, { technician_id: techId }));
        if (data && data.ok === false) {
          throw new Error(data.error || 'Anlagenstamm löschen fehlgeschlagen.');
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const errMsg = e && e.message ? e.message : String(e);
        logSyncPushError({
          reason: 'anlagenstamm_delete',
          error: errMsg,
          entity_id: p.entity_id,
        });
        const dropPending =
          /404|nicht gefunden|not found|Anlage nicht gefunden|Monteur-API-Datei wurde.*nicht gefunden/i.test(errMsg);
        if (dropPending) {
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        } else {
          noteFail(errMsg);
        }
        continue;
      }
    }
    if (p.entity_type === 'textbausteine') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const techId =
        parseInt(String(payloadRaw.technician_id ?? payloadRaw.technicianId ?? technicianId), 10) || technicianId;
      const tbBase = String(payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      if (!tbBase || !techId) {
        const outcome = resolveSyncPushFailure(
          db,
          p,
          new Error('Dispo-URL oder Monteur-ID fehlt'),
          'textbausteine_push_skip',
        );
        if (outcome === 'retry' || outcome === 'offline') noteFail('Dispo-URL oder Monteur-ID fehlt');
        continue;
      }
      try {
        if (p.action === 'category_save') {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(techId));
          const localCatId = parseInt(p.entity_id, 10);
          const catRow = db
            .prepare(`SELECT server_id FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`)
            .get(localCatId, techId);
          const dispoCatId =
            (catRow && parseInt(catRow.server_id, 10)) ||
            (payloadRaw.id && parseInt(payloadRaw.id, 10) > 0 ? parseInt(payloadRaw.id, 10) : 0);
          if (dispoCatId > 0) formBody.append('id', String(dispoCatId));
          formBody.append('name', payloadRaw.name || '');
          formBody.append('sort_order', payloadRaw.sort_order || 0);
          const r = await fetch(tbBase + '/dispo_api/api/textbausteine_category_save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
          if (data.id && parseInt(p.entity_id, 10) < 0) {
            db.prepare(`UPDATE textbausteine_user_categories SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              parseInt(p.entity_id, 10),
              techId,
            );
          }
        } else if (p.action === 'category_delete') {
          const formBody = new URLSearchParams();
          formBody.append('id', payloadRaw.id);
          formBody.append('technician_id', String(techId));
          const r = await fetch(tbBase + '/dispo_api/api/textbausteine_category_delete.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
        } else if (p.action === 'item_save') {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(techId));
          const localItemId = parseInt(p.entity_id, 10);
          const itemRow = db
            .prepare(`SELECT server_id, category_id, text, text_en FROM textbausteine_user WHERE id = ? AND technician_id = ?`)
            .get(localItemId, techId);
          const dispoItemId =
            (itemRow && parseInt(itemRow.server_id, 10)) ||
            (payloadRaw.id && parseInt(payloadRaw.id, 10) > 0 ? parseInt(payloadRaw.id, 10) : 0);
          if (dispoItemId > 0) formBody.append('id', String(dispoItemId));
          const catLocal = itemRow ? itemRow.category_id : payloadRaw.category_id;
          const catRow = db
            .prepare(`SELECT server_id FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`)
            .get(catLocal, techId);
          const dispoCatId =
            (catRow && parseInt(catRow.server_id, 10)) ||
            (parseInt(catLocal, 10) > 0 ? parseInt(catLocal, 10) : 0);
          if (!(dispoCatId > 0)) throw new Error('Kategorie noch nicht auf Dispo.');
          formBody.append('category_id', String(dispoCatId));
          const textDe =
            (itemRow && itemRow.text) || payloadRaw.text_de || payloadRaw.text || '';
          const textEn = (itemRow && itemRow.text_en) || payloadRaw.text_en || '';
          formBody.append('text', textDe);
          formBody.append('text_de', textDe);
          formBody.append('text_en', textEn);
          formBody.append('sort_order', payloadRaw.sort_order || 0);
          const r = await fetch(tbBase + '/dispo_api/api/textbausteine_save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
          if (data.id && parseInt(p.entity_id, 10) < 0) {
            db.prepare(`UPDATE textbausteine_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              parseInt(p.entity_id, 10),
              techId,
            );
          }
        } else if (p.action === 'item_delete') {
          const formBody = new URLSearchParams();
          formBody.append('id', payloadRaw.id);
          const r = await fetch(tbBase + '/dispo_api/api/textbausteine_delete.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
        } else if (p.action === 'item_reorder') {
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
          continue;
        } else {
          continue;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'textbausteine_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'arbeitsschritte') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const techId =
        parseInt(String(payloadRaw.technician_id ?? payloadRaw.technicianId ?? technicianId), 10) || technicianId;
      const asBase = String(payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      if (!asBase || !techId) {
        const skipMsg = 'Dispo-URL oder Monteur-ID fehlt';
        logSyncPushError({ reason: 'arbeitsschritte_push_skip', pending_id: p.id });
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      try {
        if (p.action === 'step_save') {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(techId));
          if (payloadRaw.id && parseInt(payloadRaw.id, 10) > 0) formBody.append('id', payloadRaw.id);
          formBody.append('bezeichnung_de', payloadRaw.bezeichnung_de || '');
          formBody.append('bezeichnung_en', payloadRaw.bezeichnung_en || '');
          formBody.append('sort_order', payloadRaw.sort_order || 0);
          formBody.append('catalog_kind', String(payloadRaw.catalog_kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service');
          const r = await fetch(asBase + '/dispo_api/api/arbeitsschritte_save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
          if (data.id && parseInt(p.entity_id, 10) < 0) {
            db.prepare(`UPDATE arbeitsschritte_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              parseInt(p.entity_id, 10),
              techId,
            );
          }
        } else if (p.action === 'step_delete') {
          const delIdRaw = payloadRaw.server_id != null ? payloadRaw.server_id : payloadRaw.id;
          const delId = parseInt(delIdRaw, 10);
          if (!Number.isFinite(delId) || delId <= 0) {
            console.warn('[sync_push] step_delete ohne gültige id — Pending verworfen', {
              pending_id: p.id,
              payload_id: payloadRaw.id,
              server_id: payloadRaw.server_id,
            });
            db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
            continue;
          }
          const formBody = new URLSearchParams();
          formBody.append('id', String(delId));
          formBody.append('technician_id', String(techId));
          const r = await fetch(asBase + '/dispo_api/api/arbeitsschritte_delete.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) {
            const errMsg = data.error || r.statusText || 'step_delete fehlgeschlagen';
            if (/id erforderlich|nicht gefunden|not found|404/i.test(String(errMsg))) {
              console.warn('[sync_push] step_delete Giftpille verworfen', { pending_id: p.id, errMsg });
              db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
              continue;
            }
            throw new Error(errMsg);
          }
        } else if (p.action === 'preset_save') {
          const formBody = new URLSearchParams();
          formBody.append('technician_id', String(techId));
          if (payloadRaw.id && parseInt(payloadRaw.id, 10) > 0) formBody.append('id', payloadRaw.id);
          formBody.append('name', payloadRaw.name || '');
          formBody.append('type_code', payloadRaw.type_code || '');
          formBody.append('sort_order', payloadRaw.sort_order || 0);
          formBody.append('step_refs', JSON.stringify(payloadRaw.step_refs || []));
          formBody.append('catalog_kind', String(payloadRaw.catalog_kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service');
          const r = await fetch(asBase + '/dispo_api/api/arbeitsschritte_preset_save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
          if (data.id && parseInt(p.entity_id, 10) < 0) {
            db.prepare(`UPDATE arbeitsschritte_preset_user SET server_id = ? WHERE id = ? AND technician_id = ?`).run(
              data.id,
              parseInt(p.entity_id, 10),
              techId,
            );
          }
        } else if (p.action === 'preset_delete') {
          const formBody = new URLSearchParams();
          formBody.append('id', payloadRaw.id);
          formBody.append('technician_id', String(techId));
          const r = await fetch(asBase + '/dispo_api/api/arbeitsschritte_preset_delete.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(techId), ...header },
            body: formBody.toString(),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
        } else {
          continue;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'arbeitsschritte_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if ((p.entity_type === 'serviceprotokoll' || p.entity_type === 'inbetriebnahme') && p.action === 'save') {
      handled = true;
      const protoSpec = p.entity_type === 'inbetriebnahme' ? SERVICE_LIKE_PROTOCOL.inbetriebnahme : SERVICE_LIKE_PROTOCOL.serviceprotokoll;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.dispoBaseUrl || payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? technicianId), 10) || technicianId;
      if (!tbBase || !techId) {
        resolveSyncPushFailure(
          db,
          p,
          new Error('Dispo-URL oder Monteur-ID fehlt'),
          protoSpec.entityType + '_push_skip',
        );
        continue;
      }
      try {
        const jobId = parseInt(payloadRaw.job_id, 10);
        if (!Number.isFinite(jobId) || jobId <= 0) {
          resolveSyncPushFailure(db, p, new Error('job_id ungültig'), protoSpec.entityType + '_push');
          continue;
        }
        const r = await fetch(tbBase + '/dispo_api/api/' + protoSpec.savePhp, {
          method: 'POST',
          headers: header,
          body: JSON.stringify(payloadRaw),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          const pushErr = new Error(data.error || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, protoSpec.entityType + '_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'kontrollwiegung' && p.action === 'save') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.dispoBaseUrl || payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? technicianId), 10) || technicianId;
      if (!tbBase || !techId) {
        resolveSyncPushFailure(
          db,
          p,
          new Error('Dispo-URL oder Monteur-ID fehlt'),
          'kontrollwiegung_push_skip',
        );
        continue;
      }
      try {
        const r = await fetch(tbBase + '/dispo_api/api/kontrollwiegungsprotokoll_save.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify(payloadRaw),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          const pushErr = new Error(data.error || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'kontrollwiegung_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'schleppketten' && p.action === 'save') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.dispoBaseUrl || payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? technicianId), 10) || technicianId;
      if (!tbBase || !techId) {
        resolveSyncPushFailure(
          db,
          p,
          new Error('Dispo-URL oder Monteur-ID fehlt'),
          'schleppketten_push_skip',
        );
        continue;
      }
      try {
        const r = await fetch(tbBase + '/dispo_api/api/schleppkettenprotokoll_save.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify(payloadRaw),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          const pushErr = new Error(data.error || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'schleppketten_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'pruefzertifikat' && p.action === 'save') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.dispoBaseUrl || payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? technicianId), 10) || technicianId;
      if (!tbBase || !techId) {
        resolveSyncPushFailure(
          db,
          p,
          new Error('Dispo-URL oder Monteur-ID fehlt'),
          'pruefzertifikat_push_skip',
        );
        continue;
      }
      try {
        const r = await fetch(tbBase + '/dispo_api/api/pruefzertifikat_save.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify(payloadRaw),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          const pushErr = new Error(data.error || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'pruefzertifikat_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'protocol_draft' && p.action === 'push') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      if (typeof protocolDraftPushImpl !== 'function') {
        resolveSyncPushFailure(db, p, new Error('Draft-Push nicht bereit'), 'protocol_draft_push');
        continue;
      }
      try {
        const result = await protocolDraftPushImpl({
          dispoBaseUrl: payloadRaw.dispoBaseUrl || payloadRaw.baseUrl || base,
          endpoint: payloadRaw.endpoint,
          technicianId:
            parseInt(payloadRaw.technicianId != null ? payloadRaw.technicianId : technicianId, 10) ||
            technicianId,
          serverJobId: payloadRaw.serverJobId,
          localJobId: payloadRaw.localJobId,
          reiseDir: payloadRaw.reiseDir,
          filePath: payloadRaw.filePath,
          basename: payloadRaw.basename,
          username: payloadRaw.username || payloadRaw.serverUsername || live.serverUsername,
          password:
            payloadRaw.password != null
              ? payloadRaw.password
              : payloadRaw.serverPassword != null
                ? payloadRaw.serverPassword
                : live.serverPassword,
        });
        if (result && (result.ok || result.queued || result.skipped)) {
          try {
            db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
          } catch (_) {
            /* Zeile kann schon durch queueDraftPushPending ersetzt sein */
          }
        } else {
          const pushErr = new Error((result && result.error) || 'draft_push_failed');
          throw pushErr;
        }
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'protocol_draft_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'signature' && p.action === 'submit') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      const techId =
        parseInt(String(payloadRaw.technician_id ?? technicianId), 10) || technicianId;
      if (!tbBase || !techId) {
        const skipMsg = 'Dispo-URL oder Monteur-ID fehlt';
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      try {
        const r = await fetch(tbBase + '/dispo_api/api/signature_submit.php?technician_id=' + encodeURIComponent(techId), {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, header),
          body: JSON.stringify(payloadRaw.payload || {}),
        });
        if (!r.ok) {
          const errText = await r.text();
          const pushErr = new Error(errText || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'signature_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'rams') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.baseUrl || base || '').trim().replace(/\/$/, '');
      if (!tbBase || !payloadRaw.action) {
        const skipMsg = 'RAMS-Push: Dispo-URL oder action fehlt';
        markPendingPushSkip(db, p, skipMsg);
        noteFail(skipMsg);
        continue;
      }
      try {
        const qs = new URLSearchParams();
        qs.set('action', String(payloadRaw.action));
        const qp = payloadRaw.queryParams && typeof payloadRaw.queryParams === 'object' ? payloadRaw.queryParams : {};
        Object.keys(qp).forEach((k) => {
          if (qp[k] !== undefined && qp[k] !== null) qs.set(k, String(qp[k]));
        });
        const method = String(payloadRaw.method || 'POST').toUpperCase();
        const url = `${tbBase}/api/mobile/rams.php?${qs.toString()}`;
        const opts = { method, headers: header };
        if (method !== 'GET' && method !== 'HEAD') {
          opts.body = JSON.stringify(payloadRaw.payload && typeof payloadRaw.payload === 'object' ? payloadRaw.payload : {});
        }
        const r = await fetch(url, opts);
        if (!r.ok) {
          const errText = await r.text();
          const pushErr = new Error(errText || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'rams_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (p.entity_type === 'arbeitsnachweis' && p.action === 'save') {
      handled = true;
      const payloadRaw = mergeLiveDispoIntoPendingPayload(JSON.parse(p.payload || '{}'), live, base);
      const tbBase = String(payloadRaw.baseUrl || payloadRaw.dispoBaseUrl || base || '')
        .trim()
        .replace(/\/$/, '');
      if (!tbBase) {
        resolveSyncPushFailure(db, p, new Error('Dispo-URL fehlt'), 'arbeitsnachweis_push_skip');
        continue;
      }
      try {
        const anLoc = require('./lib/arbeitsnachweis-local');
        let localPay = null;
        try {
          localPay = anLoc.toDispoSavePayload(anLoc.loadRow(db, p.entity_id));
        } catch (_) {}
        const chosen = anLoc.resolveSavePayload(payloadRaw, localPay) || payloadRaw;
        const url = `${tbBase}/api/mobile/arbeitsnachweis.php?action=save`;
        const postBody = Object.assign({ action: 'save' }, chosen);
        delete postBody.serverPassword;
        delete postBody.dispo_password;
        delete postBody.dispoPassword;
        const r = await fetch(url, {
          method: 'POST',
          headers: Object.assign({ Accept: 'application/json', 'Content-Type': 'application/json' }, header),
          body: JSON.stringify(postBody),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          const pushErr = new Error(data.error || r.statusText);
          pushErr.status = r.status;
          throw pushErr;
        }
        try {
          anLoc.markSynced(db, p.entity_id, data.document_id, {
            number: data.number,
            status: data.status,
            content_version: data.content_version,
            local_uuid: data.local_uuid,
          });
          anLoc.clearFailedPending(db, p.entity_id);
        } catch (_) {}
        db.prepare(
          `DELETE FROM pending_changes WHERE entity_type = 'arbeitsnachweis' AND entity_id = ? AND action = 'save'`,
        ).run(p.entity_id);
      } catch (e) {
        const outcome = resolveSyncPushFailure(db, p, e, 'arbeitsnachweis_push');
        if (outcome === 'retry' || outcome === 'offline') noteFail(e && e.message ? e.message : e);
        continue;
      }
    }
    if (!handled) {
      const outcome = resolveSyncPushFailure(
        db,
        p,
        new Error(
          isHandledPendingEntityType(p.entity_type)
            ? 'Kein pushToServer-Zweig für entity_type=' + String(p.entity_type)
            : 'Kein pushToServer-Handler für entity_type=' + String(p.entity_type),
        ),
        'pending_unbekannt',
      );
      if (outcome === 'retry' || outcome === 'offline') {
        noteFail('Kein Handler für ' + String(p.entity_type));
      }
    }
  }
  const pendingRequests = db.prepare('SELECT id, start_datetime, end_datetime, type, comment FROM absence_requests WHERE technician_id = ? AND status = ? AND (server_id IS NULL OR server_id = \'\')').all(technicianId, 'pending');
  for (const row of pendingRequests) {
    try {
      const r = await fetch(`${base}/api/absence_request.php`, {
        method: 'POST',
        headers: header,
        body: JSON.stringify({
          technician_id: technicianId,
          start_datetime: row.start_datetime,
          end_datetime: row.end_datetime,
          type: row.type || null,
          comment: row.comment != null && String(row.comment).trim() !== '' ? String(row.comment).trim() : null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok && data.id) {
        db.prepare('UPDATE absence_requests SET server_id = ?, synced_at = datetime(\'now\') WHERE id = ?').run(data.id, row.id);
      } else if (r.status >= 400 && r.status < 500) {
        // Dauerhafter fachlicher Fehler – nicht weiter als pending behandeln.
        logAbsenceRequestError({ context: 'sync', status: r.status, body: data, technicianId, baseUrl: base });
        db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE id = ?').run('error', row.id);
      }
    } catch (e) {}
  }
  try {
    const statusRes = await fetch(`${base}/api/absence_request_status.php?technician_id=${technicianId}`, { headers: authHeader || {} });
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusData.ok && Array.isArray(statusData.requests)) {
      reconcileAbsenceRequestsWithServerStatus(db, technicianId, statusData.requests);
      for (const req of statusData.requests) {
        if (req.id != null && req.status && req.status !== 'pending') {
          db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE server_id = ? AND technician_id = ?').run(req.status, req.id, technicianId);
        }
      }
    }
  } catch (e) {}
  try {
    const erledigtJobs = db.prepare('SELECT id FROM jobs WHERE status = ?').all('erledigt');
    for (const j of erledigtJobs) {
      const hasPending = db.prepare('SELECT 1 FROM pending_changes WHERE entity_type = ? AND entity_id = ?').get('job', j.id);
      if (!hasPending) {
        cleanup_completed_job_files(db, j.id);
      }
    }
  } catch (e) {}
  if (pushFailures > 0) {
    const left = db.prepare('SELECT COUNT(*) AS n FROM pending_changes').get();
    const nLeft = left && left.n != null ? Number(left.n) : 0;
    throw new Error(
      (lastPushFailMsg || pushFailures + ' Änderung(en) konnten nicht zur Dispo gesendet werden.') +
        (nLeft ? ' ' + nLeft + ' noch ausstehend.' : ''),
    );
  }
}

module.exports = {
  createApp,
  getDb,
  getMonteurDb,
  PORT,
  performAnlagenstammSave,
  performAnlagenstammDelete,
  flushMonteurDb,
};
