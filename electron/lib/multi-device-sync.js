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
  'montagebericht.json',
  'kontrollwiegungsprotokoll.json',
];

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
  const legacy = [path.join(reiseDir, base), path.join(reiseDir, 'Dokumente_Dispo', base)];
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
    return { payload: stripDraftMeta(data), revision, server_updated_at: serverUpdated };
  } catch (_) {
    return { payload: {}, revision: 0, server_updated_at: null };
  }
}

function writeLocalDraftFile(filePath, payload, revision, serverUpdatedAt) {
  const wrapped = Object.assign({}, stripDraftMeta(payload), {
    schema_version: 1,
    revision: Math.max(0, parseInt(revision, 10) || 0),
    server_updated_at: serverUpdatedAt || new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(wrapped, null, 2), 'utf8');
  return wrapped;
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
  isMonteurDraftJsonBasename,
  monteurDraftJsonPath,
  resolveMonteurDraftJsonPath,
  stripDraftMeta,
  stableStringify,
  draftPayloadsEqual,
  readLocalDraftFile,
  writeLocalDraftFile,
  writeConflictCopy,
  sha256File,
  reconcileLocalTreeWithManifest,
  formatBytes,
};
