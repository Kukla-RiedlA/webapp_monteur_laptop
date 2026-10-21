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

function isProtocolConflictCopyName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  return /\.conflict-/i.test(base);
}

function removeProtocolConflictCopies(rootDir) {
  const removed = [];
  if (!rootDir || !fs.existsSync(rootDir)) return removed;
  let names;
  try {
    names = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return removed;
  }
  for (const ent of names) {
    const n = String(ent.name || '');
    if (!n || n === '.' || n === '..') continue;
    const full = path.join(rootDir, n);
    if (ent.isDirectory()) {
      removed.push(...removeProtocolConflictCopies(full));
      continue;
    }
    if (!ent.isFile() || !isProtocolConflictCopyName(n)) continue;
    try {
      fs.unlinkSync(full);
      removed.push(n);
    } catch (_) {
      /* OneDrive kann die Datei kurz sperren */
    }
  }
  return removed;
}

/** Kanonischer Schreibpfad: Dokumente_Monteur/{basename}. */
function monteurDraftJsonPath(reiseDir, basename) {
  const base = path.basename(String(basename || '').replace(/\\/g, '/'));
  if (!reiseDir) return '';
  return path.join(String(reiseDir), 'Dokumente_Monteur', base);
}

/**
 * Legacy Root/Dispo → Dokumente_Monteur migrieren.
 * @returns {string} Zielpfad unter Dokumente_Monteur (auch wenn Datei noch fehlt)
 */
function resolveMonteurDraftJsonPath(reiseDir, basename, migrate) {
  if (!reiseDir) return '';
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
  const out = Object.assign({}, remote);
  delete out.byFab;
  for (const key of Object.keys(local)) {
    if (key === 'byFab' || key === 'fabBemerkungen') continue;
    const lv = local[key];
    const rv = remote[key];
    const localEmpty = lv == null || (typeof lv === 'string' && lv.trim() === '');
    const remoteFilled = rv != null && !(typeof rv === 'string' && rv.trim() === '');
    if (localEmpty && remoteFilled) {
      out[key] = rv;
    } else if (lv !== undefined) {
      out[key] = lv;
    }
  }
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

/**
 * Nur Meta/Zeitstempel — kein Fachinhalt. Abweichungen hier dürfen keinen
 * „Anderer Laptop“-Konflikt auslösen (auch bei einem Gerät nach Speichern/Push).
 */
const DRAFT_CONTENT_IGNORE_KEYS = new Set([
  'revision',
  'schema_version',
  'server_updated_at',
  'updatedAt',
  'updated_at',
  'gespeichert_am',
  'local_updated_at',
  'nextLocalId',
  'textbausteine',
  'jsonOnly',
  'local_only',
  'skip_dispo_sync',
  '_conflict',
  'device_id',
  'deviceId',
  'technicianId',
  'technician_id',
  'job_id',
  'pdf_rel',
  'pdf_rels',
  'last_pdf_rel',
  'last_pdf_paths',
  'last_pdf_abs',
  'pdf_path',
  'pdf_paths',
]);

function stripForContentEquality(value, depth) {
  const d = depth == null ? 0 : depth;
  if (value == null || typeof value !== 'object' || d > 12) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripForContentEquality(item, d + 1));
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (DRAFT_CONTENT_IGNORE_KEYS.has(key)) continue;
    out[key] = stripForContentEquality(value[key], d + 1);
  }
  return out;
}

function draftPayloadsEqual(a, b) {
  const left = stripForContentEquality(stripDraftMeta(a || {}));
  const right = stripForContentEquality(stripDraftMeta(b || {}));
  return stableStringify(left) === stableStringify(right);
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

const DRAFT_PREFILL_KEYS = new Set([
  'customer',
  'kunde',
  'customer_name',
  'kundenname',
  'adresse',
  'address',
  'anschrift',
  'datum',
  'date',
  'durchfuehrungsdatum',
  'start',
  'ende',
  'fabrikationsnummer',
  'fabrikationsnummern',
  'fab',
  'fn',
  'pdf_rel',
  'pdf_rels',
  'last_pdf_rel',
  'last_pdf_paths',
  'last_pdf_abs',
  'pdf_path',
  'pdf_paths',
  'languages',
  'language',
  'revision',
  'updatedAt',
  'updated_at',
  'server_updated_at',
  'gespeichert_am',
  'schema_version',
  'nextLocalId',
  'id',
  'nr',
  'zeile',
  'row',
  'job_id',
  'job_number',
  'technician_id',
  'technician_name',
  'projekt',
  'projektnummer',
  'auftrag',
  'auftragsnummer',
]);

function draftValueFilled(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return v === true;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || /^<p>\s*<\/p>$/i.test(s)) return false;
    return true;
  }
  return false;
}

function scoreDraftObject(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 5) return 0;
  let n = 0;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') n += scoreDraftObject(item, depth + 1);
      else if (draftValueFilled(item)) n += 1;
    }
    return n;
  }
  for (const key of Object.keys(obj)) {
    if (DRAFT_PREFILL_KEYS.has(key)) continue;
    const v = obj[key];
    if (v && typeof v === 'object') n += scoreDraftObject(v, depth + 1);
    else if (draftValueFilled(v)) n += 1;
  }
  return n;
}

/** 0 = leerer oder nur aus dem Auftrag vorbefüllter Stub, >0 = fachlicher Inhalt. */
function draftEntryContentScore(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (Array.isArray(entry.wiegungen)) {
    let n = 0;
    for (const row of entry.wiegungen) {
      if (!row || typeof row !== 'object') continue;
      if (scoreDraftObject(row, 0) > 0) n += 1;
    }
    return n;
  }
  return scoreDraftObject(entry, 0);
}

/**
 * same: gleicher oder leerer Inhalt.
 * local/remote: nur eine Seite hat fachlichen Inhalt.
 * conflict: beide Seiten sind gefüllt und unterschiedlich.
 */
function classifyDraftSides(localPayload, remotePayload) {
  const local = localPayload && typeof localPayload === 'object' ? localPayload : {};
  const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : {};
  if (draftPayloadsEqual(local, remote)) return 'same';
  const locScore = draftEntryContentScore(local);
  const remScore = draftEntryContentScore(remote);
  if (locScore === 0 && remScore === 0) return 'same';
  if (locScore === 0 && remScore > 0) return 'remote';
  if (remScore === 0 && locScore > 0) return 'local';
  return 'conflict';
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
  const conflicts = [];
  let usedBoth = false;
  for (const raw of keys) {
    const key = String(raw || '').trim();
    if (!key) continue;
    const loc = localBy[raw] || localBy[key];
    const rem = remoteBy[raw] || remoteBy[key];
    if (loc && rem && typeof loc === 'object' && typeof rem === 'object') {
      const side = classifyDraftSides(loc, rem);
      if (side === 'remote') {
        byFab[key] = rem;
      } else if (side === 'conflict' && !preferLocal) {
        byFab[key] = loc;
        conflicts.push(key);
      } else if (preferLocal && draftEntryContentScore(loc) === 0 && draftEntryContentScore(rem) > 0) {
        byFab[key] = rem;
      } else {
        byFab[key] = loc;
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
  return { payload: out, merged: usedBoth, conflicts };
}

/** Konflikt-FN bleiben auf dem Server; die übrigen FN sind die Vereinigung. */
function payloadForServerPush(mergedPayload, remotePayload, conflictKeys) {
  const keys = Array.isArray(conflictKeys) ? conflictKeys.filter(Boolean) : [];
  if (!keys.length) return mergedPayload;
  const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : {};
  const remoteBy = remote.byFab && typeof remote.byFab === 'object' ? remote.byFab : {};
  const out = JSON.parse(JSON.stringify(mergedPayload && typeof mergedPayload === 'object' ? mergedPayload : {}));
  if (!out.byFab || typeof out.byFab !== 'object') out.byFab = {};
  for (const key of keys) {
    if (remoteBy[key] && typeof remoteBy[key] === 'object') out.byFab[key] = remoteBy[key];
    else delete out.byFab[key];
  }
  return out;
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

const DIFF_SKIP_KEYS = new Set([
  'revision',
  'schema_version',
  'server_updated_at',
  'updatedAt',
  'updated_at',
  'gespeichert_am',
  'nextLocalId',
  'textbausteine',
  'jsonOnly',
  'local_only',
  'skip_dispo_sync',
  'freitext',
  'technicianId',
  'technician_id',
  'job_id',
  'pdf_rel',
  'pdf_rels',
  'last_pdf_rel',
  'last_pdf_paths',
  'last_pdf_abs',
  'pdf_path',
  'pdf_paths',
  'id',
  'nr',
  'zeile',
  'row',
  'fabrikationsnummer',
  'fabrikationsnummern',
  // Auth nie im Diff (Klartext-Leck in „Unterschiede“)
  'serverPassword',
  'server_password',
  'dispo_password',
  'dispoPassword',
  'password',
  'dispo_password_enc',
  'serverUsername',
  'server_username',
  'dispo_username',
  'dispoUsername',
  'dispoBaseUrl',
  'dispo_base_url',
  'baseUrl',
]);

const DIFF_FIELD_LABELS = {
  grundDesEinsatzes: 'Grund des Einsatzes',
  bemerkungen: 'Bemerkungen',
  type: 'Type',
  position: 'Pos.Nr.',
  projekt: 'Projekt',
  languages: 'Sprache',
  language: 'Sprache',
  kopfdaten: 'Kopfdaten',
  kunde: 'Kunde',
  customer: 'Kunde',
  datum: 'Datum',
  servicetechniker: 'Servicetechniker',
  ansprechperson: 'Ansprechperson',
  geliefertUeber: 'Geliefert über',
  geliefert_ueber: 'Geliefert über',
  unterschrift: 'Unterschrift',
  signature: 'Unterschrift',
  signature_override_png: 'Unterschrift',
  signature_png: 'Unterschrift',
};

const DIFF_KEY_ORDER = [
  'grundDesEinsatzes',
  'languages',
  'language',
  'projekt',
  'kopfdaten',
  'bemerkungen',
  'fabBemerkungen',
  'byFab',
];

function diffFieldLabel(key) {
  if (DIFF_FIELD_LABELS[key]) return DIFF_FIELD_LABELS[key];
  return String(key || '')
    .replace(/_html$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-zäöü])([A-Z])/g, '$1 $2')
    .trim();
}

function diffOrderedKeys(a, b) {
  const set = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const pref = DIFF_KEY_ORDER.filter((key) => set.has(key));
  const rest = [...set].filter((key) => pref.indexOf(key) < 0).sort();
  return pref.concat(rest);
}

function diffIsLeaf(value) {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function diffIsImageBlob(value) {
  return typeof value === 'string' && /^data:image\//i.test(value.trim());
}

function diffDecodeText(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function diffPlain(value) {
  if (value == null) return { text: '', imgKey: '' };
  if (typeof value === 'number') return { text: String(value), imgKey: '' };
  if (typeof value === 'boolean') return { text: value ? 'ja' : '', imgKey: '' };
  if (typeof value !== 'string') return { text: '', imgKey: '' };
  if (diffIsImageBlob(value)) return { text: '', imgKey: String(value.length) + ':' + value.slice(30, 50) };
  const imgs = [];
  let text = value.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, (_, src) => {
    const raw = String(src || '');
    imgs.push(String(raw.length) + ':' + raw.slice(0, 24));
    return ' [Bild] ';
  });
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  text = diffDecodeText(text.replace(/<[^>]+>/g, ''));
  text = text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, imgKey: imgs.join('|') };
}

function diffClip(value) {
  const text = String(value || '');
  if (text.length <= 800) return text;
  return text.slice(0, 800) + '…';
}

function diffPushRow(rows, group, label, local, remote) {
  const loc = String(local || '');
  const rem = String(remote || '');
  if (loc.trim() === rem.trim()) return;
  rows.push({
    group: group || '',
    label: label || 'Inhalt',
    local: diffClip(loc),
    remote: diffClip(rem),
  });
}

function diffTextOf(value, html) {
  if (diffIsImageBlob(value) || diffIsImageBlob(html)) {
    const blob = diffIsImageBlob(html) ? html : value;
    return { text: '', imgKey: String(blob.length) + ':' + String(blob).slice(30, 50) };
  }
  const source = html != null && String(html).trim() !== '' ? html : value;
  return diffPlain(source);
}

function diffCompareScalar(rows, group, label, local, remote, localHtml, remoteHtml) {
  const loc = diffTextOf(local, localHtml);
  const rem = diffTextOf(remote, remoteHtml);
  const locBlank = !String(loc.text || '').trim() && !loc.imgKey;
  const remBlank = !String(rem.text || '').trim() && !rem.imgKey;
  if (locBlank && remBlank) return;
  if (loc.text !== rem.text) diffPushRow(rows, group, label, loc.text, rem.text);
  else if (loc.imgKey !== rem.imgKey) {
    diffPushRow(
      rows,
      group,
      label + ' (Bild)',
      loc.imgKey ? 'Bild auf diesem Laptop' : 'kein Bild',
      rem.imgKey ? (loc.imgKey ? 'anderes Bild' : 'Bild auf dem anderen Laptop') : 'kein Bild',
    );
  }
}

function diffIndexByFn(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const fn = String(row.fabrikationsnummer || row.fab || '').trim();
    if (fn) map.set(fn, row);
  });
  return map;
}

function diffStructured(rows, group, labelPrefix, local, remote, depth) {
  const level = depth || 0;
  if (level > 6) {
    if (stableStringify(local) !== stableStringify(remote)) {
      diffPushRow(rows, group, labelPrefix || 'Inhalt', 'Inhalt auf diesem Laptop', 'anderer Inhalt');
    }
    return;
  }
  if ((local == null || diffIsLeaf(local)) && (remote == null || diffIsLeaf(remote))) {
    diffCompareScalar(rows, group, labelPrefix || 'Inhalt', local, remote);
    return;
  }
  if (Array.isArray(local) || Array.isArray(remote)) {
    diffArray(rows, group, labelPrefix, local, remote, level);
    return;
  }
  const left = local && typeof local === 'object' ? local : {};
  const right = remote && typeof remote === 'object' ? remote : {};
  diffOrderedKeys(left, right).forEach((key) => {
    diffConsiderKey(rows, group, left, right, key, labelPrefix, level);
  });
}

function diffArray(rows, group, labelPrefix, local, remote, depth) {
  const left = Array.isArray(local) ? local : [];
  const right = Array.isArray(remote) ? remote : [];
  if (left.every(diffIsLeaf) && right.every(diffIsLeaf)) {
    const join = (list) =>
      list
        .filter((item) => item != null && item !== false && String(item).trim() !== '')
        .map((item) => (typeof item === 'boolean' ? 'ja' : String(item)))
        .join(', ');
    diffCompareScalar(rows, group, labelPrefix || 'Liste', join(left), join(right));
    return;
  }
  const leftFn = diffIndexByFn(left);
  const rightFn = diffIndexByFn(right);
  if (leftFn.size || rightFn.size) {
    const fns = [];
    left.forEach((row) => {
      const fn = row && String(row.fabrikationsnummer || row.fab || '').trim();
      if (fn && fns.indexOf(fn) < 0) fns.push(fn);
    });
    right.forEach((row) => {
      const fn = row && String(row.fabrikationsnummer || row.fab || '').trim();
      if (fn && fns.indexOf(fn) < 0) fns.push(fn);
    });
    fns.forEach((fn) => {
      diffStructured(rows, 'FN ' + fn, '', leftFn.get(fn), rightFn.get(fn), (depth || 0) + 1);
    });
    return;
  }
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i += 1) {
    const prefix = (labelPrefix || 'Eintrag') + ' ' + (i + 1);
    diffStructured(rows, group, prefix, left[i], right[i], (depth || 0) + 1);
  }
}

function diffConsiderKey(rows, group, left, right, key, labelPrefix, depth) {
  if (DIFF_SKIP_KEYS.has(key)) return;
  if (key.endsWith('_html')) {
    const base = key.slice(0, -5);
    const hasBase =
      (left && Object.prototype.hasOwnProperty.call(left, base)) ||
      (right && Object.prototype.hasOwnProperty.call(right, base));
    if (hasBase) return;
    const label = labelPrefix ? labelPrefix + ' · ' + diffFieldLabel(base) : diffFieldLabel(base);
    diffCompareScalar(rows, group, label, undefined, undefined, left && left[key], right && right[key]);
    return;
  }
  const label = labelPrefix ? labelPrefix + ' · ' + diffFieldLabel(key) : diffFieldLabel(key);
  const lv = left ? left[key] : undefined;
  const rv = right ? right[key] : undefined;
  const htmlKey = key + '_html';
  const lh = left ? left[htmlKey] : undefined;
  const rh = right ? right[htmlKey] : undefined;
  if (diffIsImageBlob(lv) || diffIsImageBlob(rv)) {
    if (lv === rv) return;
    diffPushRow(
      rows,
      group,
      label,
      diffIsImageBlob(lv) ? 'Unterschrift vorhanden' : 'keine Unterschrift',
      diffIsImageBlob(rv) ? (diffIsImageBlob(lv) ? 'andere Unterschrift' : 'Unterschrift vorhanden') : 'keine Unterschrift',
    );
    return;
  }
  const leftLeaf = lv == null || diffIsLeaf(lv);
  const rightLeaf = rv == null || diffIsLeaf(rv);
  if (leftLeaf && rightLeaf) {
    diffCompareScalar(rows, group, label, lv, rv, lh, rh);
    return;
  }
  diffStructured(rows, group, label, lv !== undefined ? lv : lh, rv !== undefined ? rv : rh, (depth || 0) + 1);
}

/** Feldunterschiede zwischen lokalem und fremdem Protokollstand. */
function diffProtocolPayloads(localPayload, remotePayload) {
  const local = stripDraftMeta(localPayload || {});
  const remote = stripDraftMeta(remotePayload || {});
  const rows = [];
  if (local.byFab || remote.byFab) {
    const left = local.byFab && typeof local.byFab === 'object' ? local.byFab : {};
    const right = remote.byFab && typeof remote.byFab === 'object' ? remote.byFab : {};
    const fns = [];
    Object.keys(left).forEach((fn) => {
      if (fns.indexOf(fn) < 0) fns.push(fn);
    });
    Object.keys(right).forEach((fn) => {
      if (fns.indexOf(fn) < 0) fns.push(fn);
    });
    fns.forEach((fn) => {
      const name = String(fn || '').trim();
      if (!name) return;
      diffStructured(rows, 'FN ' + name, '', left[fn] || left[name], right[fn] || right[name], 0);
    });
  }
  diffOrderedKeys(local, remote).forEach((key) => {
    if (key === 'byFab') return;
    diffConsiderKey(rows, '', local, remote, key, '', 0);
  });
  return rows;
}

function decideSharedFile(opts) {
  const o = opts || {};
  const localSha = String(o.localSha || '');
  const remoteSha = String(o.remoteSha || '');
  if (!remoteSha && !localSha) return 'keep';
  if (!localSha && remoteSha) return 'download';
  if (!remoteSha) return 'keep';
  if (localSha === remoteSha) return 'keep';
  if (o.draftConflict) return 'conflict';
  if (o.localUnchanged) return 'download';
  return 'conflict';
}

module.exports = {
  MONTEUR_DRAFT_BASENAMES,
  DRAFT_JSON_ENDPOINTS,
  isMonteurDraftJsonBasename,
  monteurDraftJsonPath,
  resolveMonteurDraftJsonPath,
  stripDraftMeta,
  stripForContentEquality,
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
  isProtocolConflictCopyName,
  removeProtocolConflictCopies,
  draftEntryTimestamp,
  draftEntryContentScore,
  classifyDraftSides,
  payloadForServerPush,
  decideSharedFile,
  diffProtocolPayloads,
  mergeByFabStores,
  sha256File,
  reconcileLocalTreeWithManifest,
  formatBytes,
};
