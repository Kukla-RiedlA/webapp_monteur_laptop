'use strict';

/**
 * Multi-Device: Draft-Push, Conflict-Dateien, Bootstrap-Schätzung.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function stripDraftMeta(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = Object.assign({}, obj);
  delete out.revision;
  delete out.server_updated_at;
  delete out.schema_version;
  delete out._conflict;
  return out;
}

function readLocalDraftFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { payload: {}, revision: 0 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object') return { payload: {}, revision: 0 };
    const revision = parseInt(data.revision, 10) || 0;
    return { payload: stripDraftMeta(data), revision };
  } catch (_) {
    return { payload: {}, revision: 0 };
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
  stripDraftMeta,
  readLocalDraftFile,
  writeLocalDraftFile,
  writeConflictCopy,
  sha256File,
  reconcileLocalTreeWithManifest,
  formatBytes,
};
