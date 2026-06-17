'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function readCachedProjekteNeuThumb(dbDir, fab, relPath, thumbMax) {
  const p = projekteNeuThumbCachePath(dbDir, fab, relPath, thumbMax);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return { path: p, buf: fs.readFileSync(p), contentType: 'image/webp' };
}

function writeCachedProjekteNeuThumb(dbDir, fab, relPath, thumbMax, buf) {
  if (!buf || !buf.length) return null;
  const p = projekteNeuThumbCachePath(dbDir, fab, relPath, thumbMax);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
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
