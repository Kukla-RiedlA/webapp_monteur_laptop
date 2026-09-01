'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  THUMB_KIND_PROJEKTE_NEU,
  readImageThumbCache,
  writeImageThumbCache,
} = require('./image-thumb-cache');

function fabDirForCache(fab) {
  return String(fab || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function relPathHash(relPath) {
  return crypto.createHash('sha256').update(String(relPath || '').replace(/\\/g, '/'), 'utf8').digest('hex');
}

function projekteNeuFileCachePath(dbDir, fab, relPath) {
  const fabDir = fabDirForCache(fab);
  const hash = relPathHash(relPath);
  return path.join(dbDir, 'projekte_neu_file_cache', fabDir, hash);
}

function projekteNeuThumbCachePath(dbDir, fab, relPath, thumbMax) {
  const fabDir = fabDirForCache(fab);
  const hash = relPathHash(relPath);
  const max = Math.min(512, Math.max(64, Number(thumbMax) || 256));
  return path.join(dbDir, 'projekte_neu_thumb_cache', fabDir, `${hash}_${max}.webp`);
}

function readCachedProjekteNeuFile(dbDir, fab, relPath) {
  const p = projekteNeuFileCachePath(dbDir, fab, relPath);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return p;
}

function writeCachedProjekteNeuFile(dbDir, fab, relPath, buf) {
  if (!buf || !buf.length) return null;
  const p = projekteNeuFileCachePath(dbDir, fab, relPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

function readFilesystemProjekteNeuThumb(dbDir, fab, relPath, thumbMax) {
  const p = projekteNeuThumbCachePath(dbDir, fab, relPath, thumbMax);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return { path: p, buf: fs.readFileSync(p), contentType: 'image/webp' };
}

function writeFilesystemProjekteNeuThumb(dbDir, fab, relPath, thumbMax, buf) {
  if (!buf || !buf.length) return null;
  const p = projekteNeuThumbCachePath(dbDir, fab, relPath, thumbMax);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

/**
 * Thumbnail lesen: zuerst SQLite (schnell), dann Legacy-Dateicache importieren.
 * @param {object|null} db - better-sqlite3 oder db-compat
 * @param {string} dbDir
 */
function readCachedProjekteNeuThumb(db, dbDir, fab, relPath, thumbMax, filePathOpt) {
  if (db && typeof db.prepare === 'function') {
    const hit = readImageThumbCache(
      db,
      THUMB_KIND_PROJEKTE_NEU,
      fab,
      relPath,
      thumbMax,
      filePathOpt,
    );
    if (hit && hit.buf && hit.buf.length) return hit;
    const legacy = readFilesystemProjekteNeuThumb(dbDir, fab, relPath, thumbMax);
    if (legacy && legacy.buf && legacy.buf.length) {
      writeImageThumbCache(
        db,
        THUMB_KIND_PROJEKTE_NEU,
        fab,
        relPath,
        thumbMax,
        legacy.buf,
        legacy.contentType,
        filePathOpt,
      );
      return { buf: legacy.buf, contentType: legacy.contentType };
    }
    return null;
  }
  return readFilesystemProjekteNeuThumb(dbDir, fab, relPath, thumbMax);
}

/** Thumbnail persistieren – nur SQLite (kein Datei-I/O auf dem UI-Thread). */
function writeCachedProjekteNeuThumb(db, dbDir, fab, relPath, thumbMax, buf, contentType, filePathOpt) {
  if (!buf || !buf.length) return null;
  const ct = String(contentType || 'image/webp');
  if (db && typeof db.prepare === 'function') {
    writeImageThumbCache(
      db,
      THUMB_KIND_PROJEKTE_NEU,
      fab,
      relPath,
      thumbMax,
      buf,
      ct,
      filePathOpt,
    );
    return true;
  }
  try {
    writeFilesystemProjekteNeuThumb(dbDir, fab, relPath, thumbMax, buf);
  } catch (_) {
    /* ignore */
  }
  return true;
}

module.exports = {
  fabDirForCache,
  relPathHash,
  projekteNeuFileCachePath,
  projekteNeuThumbCachePath,
  readCachedProjekteNeuFile,
  writeCachedProjekteNeuFile,
  readCachedProjekteNeuThumb,
  writeCachedProjekteNeuThumb,
};
