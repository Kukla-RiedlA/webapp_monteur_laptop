'use strict';

/**
 * Multi-Device: Draft-Push, Conflict-Dateien, Bootstrap-Schätzung.
 * Protokoll-Draft-JSONs liegen unter Dokumente_Monteur/ (nicht Reise-Root / nicht Dokumente_Dispo).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MONTEUR_DRAFT_BASENAMES = [
  'serviceprotokoll.json',
  'inbetriebnahmeprotokoll.json',
  'montagebericht.json',
  'kontrollwiegungsprotokoll.json',
  'schleppkettenprotokoll.json',
  'pruefzertifikat.json',
];

/** Dispo-Draft-APIs zu den kanonischen Dateinamen unter Dokumente_Monteur/. */
const DRAFT_JSON_ENDPOINTS = {
  'serviceprotokoll.json': '/dispo_api/api/serviceprotokoll_draft.php',
  'inbetriebnahmeprotokoll.json': '/dispo_api/api/inbetriebnahme_draft.php',
  'montagebericht.json': '/dispo_api/api/montagebericht_draft.php',
  'kontrollwiegungsprotokoll.json': '/dispo_api/api/kontrollwiegungsprotokoll_draft.php',
  'schleppkettenprotokoll.json': '/dispo_api/api/schleppkettenprotokoll_draft.php',
  'pruefzertifikat.json': '/dispo_api/api/pruefzertifikat_draft.php',
};

function isMonteurDraftJsonBasename(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base) return false;
  for (const known of MONTEUR_DRAFT_BASENAMES) {
    if (base.toLowerCase() === known.toLowerCase()) return true;
  }
  if (/\.json\.conflict-/i.test(base)) {
    const stem = base.replace(/\.conflict-.*$/i, '');
    return isMonteurDraftJsonBasename(stem);
  }
  return false;
}

/** Kanonischer Schreibpfad: Dokumente_Monteur/{basename}. */
function monteurDraftJsonPath(reiseDir, basename) {
  const base = path.basename(String(basename || '').replace(/\\/g, '/'));
  return path.join(reiseDir, 'Dokumente_Monteur', base);
}

/**
 * Legacy Root/Dispo → Dokumente_Monteur migrieren.
 * @returns {string} Zielpfad unter Dokumente_Monteur (auch wenn Datei noch fehlt)
 */
function resolveMonteurDraftJsonPath(reiseDir, basename, migrate) {
  const doMigrate = migrate !== false;
  const base = path.basename(String(basename || '').replace(/\\/g, '/'));
  const target = monteurDraftJsonPath(reiseDir, base);
  const legacy = [
    path.join(reiseDir, base),
    path.join(reiseDir, 'Dokumente_Dispo', base),
    // Ältere Pulls haben Drafts fälschlich nach Dokumente_Anlage gespiegelt.
    path.join(reiseDir, 'Dokumente_Anlage', base),
  ];
  try {
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      if (doMigrate) {
        for (const cand of legacy) {
          try {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              if (fs.realpathSync(target) !== fs.realpathSync(cand)) fs.unlinkSync(cand);
            }
          } catch (_) {
            /* ignore */
          }
        }
      }
      return target;
    }
  } catch (_) {
    /* fall through */
  }
  let found = null;
  for (const cand of legacy) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        found = cand;
        break;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!found || !doMigrate) return found || target;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(found, target);
    } catch (_) {
      fs.copyFileSync(found, target);
      try {
        fs.unlinkSync(found);
      } catch (_) {
        /* ignore */
      }
    }
    for (const cand of legacy) {
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          if (fs.realpathSync(target) !== fs.realpathSync(cand)) fs.unlinkSync(cand);
        }
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    return found;
  }
  return target;
}

function stripDraftMeta(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = Object.assign({}, obj);
  delete out.revision;
  delete out.server_updated_at;
  delete out.schema_version;
  delete out._conflict;
  if (out.byFab && typeof out.byFab === 'object' && !Array.isArray(out.byFab) && Object.keys(out.byFab).length === 0) {
    delete out.byFab;
  }
  return out;
}

function hasRealByFab(payload) {
  const byFab = payload && payload.byFab;
  return !!(byFab && typeof byFab === 'object' && !Array.isArray(byFab) && Object.keys(byFab).length > 0);
}

function draftDataImageCount(payload) {
  return (JSON.stringify(payload || {}).match(/data:image\//gi) || []).length;
}

function parseDraftTsMs(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function draftTimestampNewer(candidate, baseline) {
  const a = parseDraftTsMs(candidate);
  const b = parseDraftTsMs(baseline);
  return !!(a && b && a > b + 2000);
}

function htmlHasDataImage(html) {
  return /data:image\//i.test(String(html || ''));
}

function pickHtmlPreferringImages(localHtml, remoteHtml) {
  const locS = localHtml == null ? '' : String(localHtml);
  const remS = remoteHtml == null ? '' : String(remoteHtml);
  const locImg = htmlHasDataImage(locS);
  const remImg = htmlHasDataImage(remS);
  if (remImg && !locImg) return remS;
  if (locImg && !remImg) return locS;
  if (remImg && locImg) return remS.length >= locS.length ? remS : locS;
  return remS.length > locS.length ? remS : locS;
}

function rowHasDataImage(row) {
  return draftDataImageCount(row) > 0;
}

/**
 * Montagebericht (kein byFab): eingebettete data:image-Bilder aus Remote behalten,
 * lokalen Text nicht pauschal verwerfen.
 */
function mergeFlatProtocolStores(localPayload, remotePayload) {
  const local = stripDraftMeta(localPayload || {});
  const remote = stripDraftMeta(remotePayload || {});
  const out = Object.assign({}, remote, local);
  delete out.byFab;
  ['grundDesEinsatzes_html', 'bemerkungen_html'].forEach((k) => {
    if (local[k] != null || remote[k] != null) {
      out[k] = pickHtmlPreferringImages(local[k], remote[k]);
    }
  });
  const locFabs = Array.isArray(local.fabBemerkungen) ? local.fabBemerkungen : [];
  const remFabs = Array.isArray(remote.fabBemerkungen) ? remote.fabBemerkungen : [];
  if (locFabs.length || remFabs.length) {
    const byFn = new Map();
    remFabs.concat(locFabs).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const fn = String(row.fabrikationsnummer || '').trim();
      const prev = byFn.get(fn);
      if (!prev) {
        byFn.set(fn, Object.assign({}, row));
        return;
      }
      const locRow = row;
      const remRow = prev;
      const merged = Object.assign({}, remRow, locRow);
      merged.bemerkungen_html = pickHtmlPreferringImages(locRow.bemerkungen_html, remRow.bemerkungen_html);
      if (rowHasDataImage(remRow) && !rowHasDataImage(locRow)) {
        byFn.set(fn, Object.assign({}, locRow, remRow, { bemerkungen_html: merged.bemerkungen_html }));
        return;
      }
      byFn.set(fn, merged);
    });
    out.fabBemerkungen = Array.from(byFn.values());
  }
  return out;
}

/** Stabile JSON-Serialisierung für Payload-Vergleich (Reihenfolge egal). */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

function draftPayloadsEqual(a, b) {
  return stableStringify(stripDraftMeta(a || {})) === stableStringify(stripDraftMeta(b || {}));
}

/** Leerer Store (kein byFab-Inhalt / leeres Objekt) — Datei nicht anlegen oder behalten. */
function isEmptyMonteurDraftPayload(payload) {
  const p = stripDraftMeta(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
  const keys = Object.keys(p);
  if (keys.length === 0) return true;
  if (Object.prototype.hasOwnProperty.call(p, 'byFab')) {
    const byFab = p.byFab;
    const emptyByFab = !byFab || typeof byFab !== 'object' || Object.keys(byFab).length === 0;
    const otherKeys = keys.filter((k) => k !== 'byFab' && k !== 'nextLocalId');
    return emptyByFab && otherKeys.length === 0;
  }
  return draftPayloadsEqual(p, {});
}

function pruneEmptyMonteurDraftJsons(reiseDir) {
  if (!reiseDir) return 0;
  let removed = 0;
  for (const basename of MONTEUR_DRAFT_BASENAMES) {
    const filePath = monteurDraftJsonPath(reiseDir, basename);
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!isEmptyMonteurDraftPayload(raw)) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch (_) {
      /* Datei behalten wenn unlesbar */
    }
  }
  return removed;
}

function readLocalDraftFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { payload: {}, revision: 0, server_updated_at: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object') return { payload: {}, revision: 0, server_updated_at: null };
    const revision = parseInt(data.revision, 10) || 0;
    const serverUpdated =
      data.server_updated_at != null && String(data.server_updated_at).trim()
        ? String(data.server_updated_at)
        : null;
    let localUpdatedAt = serverUpdated;
    try {
      const st = fs.statSync(filePath);
      if (st && st.mtime) localUpdatedAt = new Date(st.mtimeMs || st.mtime).toISOString();
    } catch (_) {
      /* ignore */
    }
    return {
      payload: stripDraftMeta(data),
      revision,
      server_updated_at: serverUpdated,
      local_updated_at: localUpdatedAt,
    };
  } catch (_) {
    return { payload: {}, revision: 0, server_updated_at: null };
  }
}

function writeLocalDraftFile(filePath, payload, revision, serverUpdatedAt) {
  const clean = stripDraftMeta(payload);
  if (isEmptyMonteurDraftPayload(clean)) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore */
    }
    return {
      schema_version: 1,
      revision: Math.max(0, parseInt(revision, 10) || 0),
      server_updated_at: serverUpdatedAt || null,
    };
  }
  const wrapped = Object.assign({}, clean, {
    schema_version: 1,
    revision: Math.max(0, parseInt(revision, 10) || 0),
    server_updated_at: serverUpdatedAt || new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(wrapped, null, 2), 'utf8');
  return wrapped;
}

function draftEntryTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.updatedAt || entry.updated_at || entry.gespeichert_am || entry.server_updated_at || '').trim();
}

/** 0 = leerer Autosave-Stub, >0 = fachlicher Inhalt (z. B. Wiegungen). */
function draftEntryContentScore(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (Array.isArray(entry.wiegungen)) {
    let n = 0;
    for (const row of entry.wiegungen) {
      if (!row || typeof row !== 'object') continue;
      const filled = Object.keys(row).some((k) => {
        if (k === 'id' || k === 'nr' || k === 'zeile' || k === 'row') return false;
        const v = row[k];
        if (v == null) return false;
        if (typeof v === 'number') return Number.isFinite(v);
        return String(v).trim() !== '';
      });
      if (filled) n += 1;
    }
    return n;
  }
  return 1;
}

/**
 * Union der byFab-Stores. Pro FN: Inhalt vor leerem Stub, sonst neuerer updatedAt.
 * preferLocal: vorhandene lokale FN nie durch Dispo ersetzen (nur fehlende FN ergänzen).
 */
function mergeByFabStores(localPayload, remotePayload, opts) {
  const preferLocal = !!(opts && opts.preferLocal);
  const local = localPayload && typeof localPayload === 'object' && !Array.isArray(localPayload) ? localPayload : {};
  const remote = remotePayload && typeof remotePayload === 'object' && !Array.isArray(remotePayload) ? remotePayload : {};
  const localBy = local.byFab && typeof local.byFab === 'object' ? local.byFab : {};
  const remoteBy = remote.byFab && typeof remote.byFab === 'object' ? remote.byFab : {};
  const keys = new Set([...Object.keys(localBy), ...Object.keys(remoteBy)]);
  const byFab = {};
  let usedBoth = false;
  for (const raw of keys) {
    const key = String(raw || '').trim();
    if (!key) continue;
    const loc = localBy[raw] || localBy[key];
    const rem = remoteBy[raw] || remoteBy[key];
    if (loc && rem && typeof loc === 'object' && typeof rem === 'object') {
      if (preferLocal) {
        byFab[key] = loc;
      } else {
        const locScore = draftEntryContentScore(loc);
        const remScore = draftEntryContentScore(rem);
        if (locScore === 0 && remScore > 0) {
          byFab[key] = rem;
        } else if (remScore === 0 && locScore > 0) {
          byFab[key] = loc;
        } else {
          const locMs = Date.parse(draftEntryTimestamp(loc)) || 0;
          const remMs = Date.parse(draftEntryTimestamp(rem)) || 0;
          if (locMs && remMs && remMs > locMs + 2000) {
            byFab[key] = rem;
          } else {
            byFab[key] = loc;
          }
        }
      }
      usedBoth = true;
    } else if (loc && typeof loc === 'object') {
      byFab[key] = loc;
      usedBoth = true;
    } else if (rem && typeof rem === 'object') {
      byFab[key] = rem;
      usedBoth = true;
    }
  }
  const extra = Object.assign({}, stripDraftMeta(remote), stripDraftMeta(local));
  delete extra.byFab;
  const out = Object.assign({}, extra);
  if (Object.keys(byFab).length > 0) {
    out.byFab = byFab;
  }
  if (local.nextLocalId != null || remote.nextLocalId != null) {
    out.nextLocalId = Math.max(Number(local.nextLocalId) || 1, Number(remote.nextLocalId) || 1);
  }
  return { payload: out, merged: usedBoth };
}

function writeConflictCopy(filePath, deviceId) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeDevice = String(deviceId || 'device').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'device';
  const conflictName = base + '.conflict-' + safeDevice + '-' + ts;
  const dest = path.join(dir, conflictName);
  try {
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (_) {
    return null;
  }
}

/** Conflict-Copy aus Payload, auch wenn die Draft-Datei nur in SQLite liegt. */
function writePayloadConflictCopy(filePath, payload, deviceId) {
  if (filePath && fs.existsSync(filePath)) return writeConflictCopy(filePath, deviceId);
  if (!filePath || payload == null || typeof payload !== 'object') return null;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!dir || !base) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeDevice = String(deviceId || 'device').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'device';
  const dest = path.join(dir, base + '.conflict-' + safeDevice + '-' + ts);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf8');
    return dest;
  } catch (_) {
    return null;
  }
}

function sha256File(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return '';
    if (st.size > 64 * 1024 * 1024) {
      return 'size:' + st.size + ':mtime:' + Math.floor(st.mtimeMs);
    }
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(absPath));
    return h.digest('hex');
  } catch (_) {
    return '';
  }
}

/**
 * Vergleicht lokalen physischen Tree mit Server-Manifest; legt Conflict-Copies an.
 * @returns {{ conflicts: Array, missing_local: number, outdated: number }}
 */
function reconcileLocalTreeWithManifest(reiseDir, manifestFiles, deviceId) {
  const conflicts = [];
  let missingLocal = 0;
  let outdated = 0;
  if (!reiseDir || !fs.existsSync(reiseDir) || !Array.isArray(manifestFiles)) {
    return { conflicts, missing_local: 0, outdated: 0 };
  }
  for (const f of manifestFiles) {
    const rel = String((f && f.rel_path) || '').replace(/\\/g, '/');
    if (!rel || rel.indexOf('.conflict-') >= 0) continue;
    const abs = path.join(reiseDir, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      missingLocal++;
      continue;
    }
    const localSha = sha256File(abs);
    const remoteSha = String((f && f.sha256) || '');
    if (!localSha || !remoteSha || localSha === remoteSha) continue;
    // Lokale Datei weicht ab → Conflict-Copy der lokalen Version, Remote gewinnt beim nächsten Pull
    const copied = writeConflictCopy(abs, deviceId);
    outdated++;
    conflicts.push({
      rel_path: rel,
      local_sha256: localSha,
      remote_sha256: remoteSha,
      conflict_file: copied ? path.basename(copied) : null,
    });
  }
  return { conflicts, missing_local: missingLocal, outdated };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

module.exports = {
  MONTEUR_DRAFT_BASENAMES,
  DRAFT_JSON_ENDPOINTS,
  isMonteurDraftJsonBasename,
  monteurDraftJsonPath,
  resolveMonteurDraftJsonPath,
  stripDraftMeta,
  stableStringify,
  draftPayloadsEqual,
  isEmptyMonteurDraftPayload,
  hasRealByFab,
  draftDataImageCount,
  draftTimestampNewer,
  mergeFlatProtocolStores,
  pruneEmptyMonteurDraftJsons,
  readLocalDraftFile,
  writeLocalDraftFile,
  writeConflictCopy,
  writePayloadConflictCopy,
  draftEntryTimestamp,
  mergeByFabStores,
  sha256File,
  reconcileLocalTreeWithManifest,
  formatBytes,
};
