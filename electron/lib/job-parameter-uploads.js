'use strict';

/**
 * Persistente Parameterlisten-Uploads je Auftrag.
 * Überlebt Freigabe (Projektordner-Löschung) und erneute Annahme.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isSupportedParameterFileName } = require('./anlagenstamm-parameter-parser');
const { decorateParameterListItem, sortParameterFilesByDisplayDesc } = require('./anlagenstamm-filename-datetime');

function jobKey(serverJobId, localJobId) {
  const s = parseInt(serverJobId, 10);
  if (Number.isFinite(s) && s > 0) return 's:' + s;
  const l = parseInt(localJobId, 10);
  if (Number.isFinite(l) && l > 0) return 'l:' + l;
  return '';
}

function safeFilePart(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'parameterliste';
}

function sha256Buffer(buf) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []))
    .digest('hex');
}

function sha256File(absPath) {
  return sha256Buffer(fs.readFileSync(absPath));
}

function pdfBasenameFor(filename) {
  return String(filename || '').replace(/\.(csv|txt|pa3|pa4|pa5|pal)$/i, '') + '.pdf';
}

function ensureJobParameterUploadsSchema(db) {
  if (!db || typeof db.exec !== 'function') return;
  db.exec(`CREATE TABLE IF NOT EXISTS job_parameter_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL,
    local_job_id INTEGER,
    server_job_id INTEGER,
    job_number TEXT,
    fab TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    cache_path TEXT,
    job_rel_path TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL,
    technician_id INTEGER,
    dispo_file_id INTEGER,
    mime TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_job_param_uploads_unique ON job_parameter_uploads(job_key, fab, sha256)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_job_param_uploads_job ON job_parameter_uploads(local_job_id, server_job_id, job_number)',
  );
}

function cacheDirForJob(cacheRoot, key) {
  const k = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cacheRoot, k || 'unknown');
}

function cacheFilePath(cacheRoot, key, sha256, filename) {
  return path.join(cacheDirForJob(cacheRoot, key), sha256.slice(0, 16) + '_' + safeFilePart(filename));
}

function writeCacheFile(cacheRoot, key, sha256, filename, buffer) {
  const dest = cacheFilePath(cacheRoot, key, sha256, filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return dest;
}

function upsertJobParameterUpload(db, payload) {
  ensureJobParameterUploadsSchema(db);
  const key = jobKey(payload && payload.server_job_id, payload && payload.local_job_id);
  if (!key) return { ok: false, error: 'job_key fehlt' };
  const fab = String((payload && payload.fab) || '').replace(/\D/g, '');
  const sha256 = String((payload && payload.sha256) || '').trim().toLowerCase();
  const originalFilename = String((payload && payload.original_filename) || '').trim();
  if (!fab || !sha256 || !originalFilename) {
    return { ok: false, error: 'fab, sha256 und original_filename erforderlich.' };
  }
  const uploadedAt =
    String((payload && payload.uploaded_at) || '').trim() ||
    new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO job_parameter_uploads
      (job_key, local_job_id, server_job_id, job_number, fab, original_filename, sha256,
       cache_path, job_rel_path, size, uploaded_at, technician_id, dispo_file_id, mime, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(job_key, fab, sha256) DO UPDATE SET
       local_job_id = excluded.local_job_id,
       server_job_id = COALESCE(excluded.server_job_id, job_parameter_uploads.server_job_id),
       job_number = COALESCE(excluded.job_number, job_parameter_uploads.job_number),
       original_filename = excluded.original_filename,
       cache_path = excluded.cache_path,
       job_rel_path = COALESCE(excluded.job_rel_path, job_parameter_uploads.job_rel_path),
       size = excluded.size,
       uploaded_at = excluded.uploaded_at,
       technician_id = excluded.technician_id,
       dispo_file_id = COALESCE(excluded.dispo_file_id, job_parameter_uploads.dispo_file_id),
       mime = excluded.mime,
       updated_at = datetime('now')`,
  ).run(
    key,
    payload.local_job_id != null ? Number(payload.local_job_id) : null,
    payload.server_job_id != null ? Number(payload.server_job_id) : null,
    payload.job_number != null ? String(payload.job_number) : null,
    fab,
    originalFilename,
    sha256,
    payload.cache_path != null ? String(payload.cache_path) : null,
    payload.job_rel_path != null ? String(payload.job_rel_path) : null,
    Math.max(0, Number((payload && payload.size) || 0) || 0),
    uploadedAt,
    payload.technician_id != null ? Number(payload.technician_id) : null,
    payload.dispo_file_id != null ? Number(payload.dispo_file_id) : null,
    payload.mime != null ? String(payload.mime) : null,
  );
  const row = db
    .prepare('SELECT id FROM job_parameter_uploads WHERE job_key = ? AND fab = ? AND sha256 = ? LIMIT 1')
    .get(key, fab, sha256);
  return { ok: true, id: row && row.id ? Number(row.id) : 0, job_key: key, fab, sha256 };
}

function listUploadsForJob(db, opts) {
  ensureJobParameterUploadsSchema(db);
  const keys = [];
  const sKey = jobKey(opts && opts.server_job_id, null);
  const lKey = jobKey(null, opts && opts.local_job_id);
  if (sKey) keys.push(sKey);
  if (lKey && lKey !== sKey) keys.push(lKey);
  const jobNumber = String((opts && opts.job_number) || '').trim();
  if (!keys.length && !jobNumber) return [];
  const clauses = [];
  const params = [];
  if (keys.length) {
    clauses.push('job_key IN (' + keys.map(() => '?').join(',') + ')');
    params.push(...keys);
  }
  if (jobNumber) {
    clauses.push('job_number = ?');
    params.push(jobNumber);
  }
  return db
    .prepare(
      `SELECT id, job_key, local_job_id, server_job_id, job_number, fab, original_filename, sha256,
              cache_path, job_rel_path, size, uploaded_at, technician_id, dispo_file_id, mime
       FROM job_parameter_uploads
       WHERE ${clauses.join(' OR ')}
       ORDER BY datetime(uploaded_at) DESC, id DESC`,
    )
    .all(...params);
}

function getUploadById(db, uploadId) {
  ensureJobParameterUploadsSchema(db);
  const id = parseInt(uploadId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare('SELECT * FROM job_parameter_uploads WHERE id = ? LIMIT 1').get(id) || null;
}

function getUploadByFabSha(db, opts, fab, sha256) {
  const rows = listUploadsForJob(db, opts || {});
  const fabNorm = String(fab || '').replace(/\D/g, '');
  const sha = String(sha256 || '').trim().toLowerCase();
  return rows.find((r) => String(r.fab) === fabNorm && String(r.sha256 || '').toLowerCase() === sha) || null;
}

function deleteUploadRow(db, uploadId) {
  ensureJobParameterUploadsSchema(db);
  const id = parseInt(uploadId, 10);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'upload_id ungültig.' };
  const row = getUploadById(db, id);
  if (!row) return { ok: false, error: 'Upload nicht gefunden.' };
  if (row.cache_path && fs.existsSync(row.cache_path)) {
    try {
      fs.unlinkSync(row.cache_path);
    } catch (_) {}
    const pdfCache = row.cache_path.replace(/\.(csv|txt|pa3|pa4|pa5|pal)$/i, '.pdf');
    if (pdfCache !== row.cache_path && fs.existsSync(pdfCache)) {
      try {
        fs.unlinkSync(pdfCache);
      } catch (_) {}
    }
  }
  db.prepare('DELETE FROM job_parameter_uploads WHERE id = ?').run(id);
  return { ok: true, row };
}

function fileExists(p) {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function scanParameterDir(paramDir, fab) {
  const out = [];
  if (!paramDir || !fs.existsSync(paramDir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(paramDir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !isSupportedParameterFileName(e.name)) continue;
    const abs = path.join(paramDir, e.name);
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch (_) {
      continue;
    }
    let sha = '';
    try {
      sha = sha256File(abs);
    } catch (_) {
      continue;
    }
    out.push({
      fab: String(fab || '').replace(/\D/g, ''),
      original_filename: e.name,
      sha256: sha,
      abs_path: abs,
      size: st.size,
      mtime: st.mtime ? st.mtime.toISOString() : null,
    });
  }
  return out;
}

function listMergedJobUploads(db, opts) {
  const cacheRows = listUploadsForJob(db, opts);
  const folderFiles = [];
  const scanDirs = Array.isArray(opts && opts.paramDirs) ? opts.paramDirs : [];
  for (const item of scanDirs) {
    folderFiles.push(...scanParameterDir(item.dir, item.fab));
  }
  const bySha = new Map();
  for (const f of folderFiles) {
    const k = String(f.fab) + '|' + String(f.sha256);
    bySha.set(k, f);
  }
  const seen = new Set();
  const out = [];
  for (const row of cacheRows) {
    const k = String(row.fab) + '|' + String(row.sha256);
    seen.add(k);
    const folder = bySha.get(k);
    const cacheOk = fileExists(row.cache_path);
    const resolvedJob =
      folder && folder.abs_path
        ? folder.abs_path
        : row.job_rel_path && opts.resolveJobAbs
          ? opts.resolveJobAbs(row.job_rel_path)
          : '';
    const jobOk = fileExists(resolvedJob);
    out.push({
      id: Number(row.id),
      fab: String(row.fab),
      original_filename: row.original_filename,
      sha256: row.sha256,
      size: folder && folder.size != null ? folder.size : Number(row.size) || 0,
      uploaded_at: row.uploaded_at,
      technician_id: row.technician_id,
      dispo_file_id: row.dispo_file_id,
      mime: row.mime || 'application/octet-stream',
      cache_path: cacheOk ? row.cache_path : null,
      abs_path: jobOk ? resolvedJob : null,
      job_rel_path: row.job_rel_path || null,
      is_backup: !jobOk && cacheOk,
      can_delete: true,
      source: 'upload',
    });
  }
  for (const f of folderFiles) {
    const k = String(f.fab) + '|' + String(f.sha256);
    if (seen.has(k)) continue;
    out.push({
      id: null,
      fab: f.fab,
      original_filename: f.original_filename,
      sha256: f.sha256,
      size: f.size,
      uploaded_at: f.mtime ? String(f.mtime).replace('T', ' ').slice(0, 19) : null,
      technician_id: null,
      dispo_file_id: null,
      mime: 'application/octet-stream',
      cache_path: null,
      abs_path: f.abs_path,
      job_rel_path: null,
      is_backup: false,
      can_delete: true,
      source: 'upload',
    });
  }
  out.sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
  return sortParameterFilesByDisplayDesc(out.map((item) => decorateParameterListItem(item)));
}

function resolveUploadBytes(row) {
  const candidates = [row && row.abs_path, row && row.cache_path].filter(Boolean);
  for (const p of candidates) {
    if (fileExists(p)) {
      return { ok: true, path: p, buffer: fs.readFileSync(p), filename: path.basename(p) };
    }
  }
  return { ok: false, error: 'Datei nicht gefunden (lokal).' };
}

function restoreUploadsToJobFolder(db, opts) {
  const rows = listUploadsForJob(db, opts);
  const restored = [];
  const resolveParamDir = opts && typeof opts.resolveParamDir === 'function' ? opts.resolveParamDir : null;
  const relFor = opts && typeof opts.relFor === 'function' ? opts.relFor : null;
  if (!resolveParamDir) return { ok: false, error: 'resolveParamDir fehlt.', restored };
  for (const row of rows) {
    if (!fileExists(row.cache_path)) continue;
    const paramDir = resolveParamDir(row.fab);
    if (!paramDir) continue;
    try {
      fs.mkdirSync(paramDir, { recursive: true });
    } catch (_) {
      continue;
    }
    const dest = path.join(paramDir, row.original_filename);
    try {
      fs.copyFileSync(row.cache_path, dest);
    } catch (_) {
      continue;
    }
    const rel = relFor ? relFor(row.fab, row.original_filename) : null;
    if (rel) {
      db.prepare(
        `UPDATE job_parameter_uploads SET job_rel_path = ?, local_job_id = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(rel, opts.local_job_id != null ? Number(opts.local_job_id) : row.local_job_id, row.id);
    }
    restored.push({ id: row.id, fab: row.fab, path: dest });
  }
  return { ok: true, restored };
}

function unlinkJobCopies(absPath) {
  if (!fileExists(absPath)) return;
  try {
    fs.unlinkSync(absPath);
  } catch (_) {}
  const pdf = pdfBasenameFor(absPath);
  if (pdf !== absPath && fileExists(pdf)) {
    try {
      fs.unlinkSync(pdf);
    } catch (_) {}
  }
}

module.exports = {
  jobKey,
  sha256Buffer,
  sha256File,
  pdfBasenameFor,
  ensureJobParameterUploadsSchema,
  cacheFilePath,
  writeCacheFile,
  upsertJobParameterUpload,
  listUploadsForJob,
  getUploadById,
  getUploadByFabSha,
  deleteUploadRow,
  scanParameterDir,
  listMergedJobUploads,
  resolveUploadBytes,
  restoreUploadsToJobFolder,
  unlinkJobCopies,
  fileExists,
  safeFilePart,
};
