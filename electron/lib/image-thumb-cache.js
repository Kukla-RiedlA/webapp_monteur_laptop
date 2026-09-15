'use strict';

const { fsStatSync } = require('./win32-long-path');

const THUMB_KIND_PROJEKTE_NEU = 'projekte_neu';
const THUMB_KIND_DIENSTREISE = 'dienstreise';

function normalizeRelPath(relPath) {
  return String(relPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function normalizeScopeId(scopeId) {
  const s = String(scopeId || '').trim();
  if (!s) return '';
  if (/^\d{4,6}$/.test(s)) return s;
  const m = s.match(/(?:^|\D)(\d{4,6})(?!\d)/);
  return m ? m[1] : s;
}

function clampThumbMax(thumbMax) {
  const n = parseInt(thumbMax, 10);
  if (!Number.isFinite(n)) return 256;
  return Math.min(512, Math.max(64, n));
}

function ensureImageThumbCacheSchema(db) {
  if (!db || typeof db.prepare !== 'function') return;
  db.prepare(
    `CREATE TABLE IF NOT EXISTS image_thumb_cache (
      cache_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      thumb_max INTEGER NOT NULL DEFAULT 256,
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      thumb_blob BLOB NOT NULL,
      source_mtime TEXT,
      source_size INTEGER,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (cache_kind, scope_id, rel_path, thumb_max)
    )`,
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_image_thumb_cache_scope ON image_thumb_cache(cache_kind, scope_id)',
  ).run();
}

function sourceStatMeta(filePath) {
  if (!filePath) return { source_mtime: null, source_size: null };
  try {
    const st = fsStatSync(filePath);
    return {
      source_mtime: st.mtime ? String(st.mtimeMs) : null,
      source_size: st.isFile() ? st.size : null,
    };
  } catch (_) {
    return { source_mtime: null, source_size: null };
  }
}

function isSourceStale(row, filePath) {
  if (!row || !filePath) return false;
  if (row.source_size == null) return false;
  const meta = sourceStatMeta(filePath);
  if (meta.source_size != null && row.source_size !== meta.source_size) return true;
  return false;
}

function readImageThumbCache(db, kind, scopeId, relPath, thumbMax, filePathOpt) {
  if (!db || typeof db.prepare !== 'function') return null;
  ensureImageThumbCacheSchema(db);
  const rel = normalizeRelPath(relPath);
  const scope = normalizeScopeId(scopeId);
  const max = clampThumbMax(thumbMax);
  if (!kind || !scope || !rel) return null;
  const row = db
    .prepare(
      `SELECT content_type, thumb_blob, source_mtime, source_size
       FROM image_thumb_cache
       WHERE cache_kind = ? AND scope_id = ? AND rel_path = ? AND thumb_max = ?`,
    )
    .get(kind, scope, rel, max);
  if (!row || !row.thumb_blob) return null;
  const buf = Buffer.isBuffer(row.thumb_blob) ? row.thumb_blob : Buffer.from(row.thumb_blob);
  if (!buf.length) return null;
  if (isSourceStale(row, filePathOpt)) return null;
  return {
    buf,
    contentType: String(row.content_type || 'image/webp'),
  };
}

function writeImageThumbCache(db, kind, scopeId, relPath, thumbMax, buf, contentType, filePathOpt, sourceMeta) {
  if (!db || typeof db.prepare !== 'function' || !buf || !buf.length) return false;
  ensureImageThumbCacheSchema(db);
  const rel = normalizeRelPath(relPath);
  const scope = normalizeScopeId(scopeId);
  const max = clampThumbMax(thumbMax);
  const meta = sourceStatMeta(filePathOpt);
  if (sourceMeta && typeof sourceMeta === 'object') {
    if (sourceMeta.source_mtime != null && sourceMeta.source_mtime !== '') {
      meta.source_mtime = String(sourceMeta.source_mtime);
    }
    if (sourceMeta.source_size != null && sourceMeta.source_size !== '') {
      const n = Number(sourceMeta.source_size);
      meta.source_size = Number.isFinite(n) ? n : meta.source_size;
    }
  }
  db.prepare(
    `INSERT INTO image_thumb_cache (
       cache_kind, scope_id, rel_path, thumb_max, content_type, thumb_blob, source_mtime, source_size, cached_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(cache_kind, scope_id, rel_path, thumb_max) DO UPDATE SET
       content_type = excluded.content_type,
       thumb_blob = excluded.thumb_blob,
       source_mtime = excluded.source_mtime,
       source_size = excluded.source_size,
       cached_at = datetime('now')`,
  ).run(
    kind,
    scope,
    rel,
    max,
    String(contentType || 'image/webp'),
    buf,
    meta.source_mtime,
    meta.source_size,
  );
  return true;
}

function deleteImageThumbCacheExcept(db, kind, scopeId, keepRelPaths, thumbMax) {
  if (!db || typeof db.prepare !== 'function') return 0;
  ensureImageThumbCacheSchema(db);
  const scope = normalizeScopeId(scopeId);
  const max = clampThumbMax(thumbMax);
  if (!kind || !scope) return 0;
  const keep = new Set((Array.isArray(keepRelPaths) ? keepRelPaths : []).map(normalizeRelPath).filter(Boolean));
  const rows = db
    .prepare(
      'SELECT rel_path FROM image_thumb_cache WHERE cache_kind = ? AND scope_id = ? AND thumb_max = ?',
    )
    .all(kind, scope, max);
  const del = db.prepare(
    'DELETE FROM image_thumb_cache WHERE cache_kind = ? AND scope_id = ? AND rel_path = ? AND thumb_max = ?',
  );
  let n = 0;
  for (const row of rows || []) {
    const rel = normalizeRelPath(row && row.rel_path);
    if (!rel || keep.has(rel)) continue;
    del.run(kind, scope, rel, max);
    n += 1;
  }
  return n;
}

function deleteImageThumbCacheScope(db, kind, scopeId) {
  if (!db || typeof db.prepare !== 'function') return 0;
  ensureImageThumbCacheSchema(db);
  const scope = normalizeScopeId(scopeId);
  if (!kind || !scope) return 0;
  const info = db.prepare('DELETE FROM image_thumb_cache WHERE cache_kind = ? AND scope_id = ?').run(kind, scope);
  return info && info.changes != null ? Number(info.changes) : 0;
}

module.exports = {
  THUMB_KIND_PROJEKTE_NEU,
  THUMB_KIND_DIENSTREISE,
  ensureImageThumbCacheSchema,
  readImageThumbCache,
  writeImageThumbCache,
  deleteImageThumbCacheExcept,
  deleteImageThumbCacheScope,
  normalizeRelPath,
  normalizeScopeId,
  clampThumbMax,
};
