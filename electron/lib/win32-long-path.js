'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Windows MAX_PATH (~260) umgehen: Node/OneDrive scheitern sonst still an langen
 * Dienstreise-Pfaden (FN-Ordner + Montage + Fotodateiname).
 */
function win32FsPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return raw;
  if (process.platform !== 'win32') return raw;
  if (raw.startsWith('\\\\?\\')) return raw;
  const n = path.resolve(raw);
  if (n.startsWith('\\\\?\\')) return n;
  if (n.startsWith('\\\\')) return '\\\\?\\UNC\\' + n.slice(2);
  return '\\\\?\\' + n;
}

function fsExistsSync(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return false;
  try {
    if (fs.existsSync(p)) return true;
  } catch (_) {
    /* MAX_PATH */
  }
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync(win32FsPath(p))) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

function fsStatSync(filePath) {
  const p = String(filePath || '').trim();
  try {
    return fs.statSync(p);
  } catch (e) {
    if (process.platform === 'win32') return fs.statSync(win32FsPath(p));
    throw e;
  }
}

async function fsStat(filePath) {
  const p = String(filePath || '').trim();
  try {
    return await fs.promises.stat(p);
  } catch (e) {
    if (process.platform === 'win32') return fs.promises.stat(win32FsPath(p));
    throw e;
  }
}

function stripWin32LongPrefix(filePath) {
  const s = String(filePath || '');
  if (s.startsWith('\\\\?\\UNC\\')) return '\\' + s.slice(8);
  if (s.startsWith('\\\\?\\')) return s.slice(4);
  return s;
}

async function fsReaddir(dirPath, options) {
  const p = String(dirPath || '').trim();
  try {
    return await fs.promises.readdir(p, options);
  } catch (e) {
    if (process.platform === 'win32') return fs.promises.readdir(win32FsPath(p), options);
    throw e;
  }
}

function fsReaddirSync(dirPath, options) {
  const p = String(dirPath || '').trim();
  try {
    return fs.readdirSync(p, options);
  } catch (e) {
    if (process.platform === 'win32') return fs.readdirSync(win32FsPath(p), options);
    throw e;
  }
}

function fsRealpathSync(filePath) {
  const p = String(filePath || '').trim();
  try {
    return stripWin32LongPrefix(fs.realpathSync(p));
  } catch (e) {
    if (process.platform === 'win32') return stripWin32LongPrefix(fs.realpathSync(win32FsPath(p)));
    throw e;
  }
}

function fsReadFileSync(filePath, encoding) {
  const p = String(filePath || '').trim();
  try {
    return encoding != null ? fs.readFileSync(p, encoding) : fs.readFileSync(p);
  } catch (e) {
    if (process.platform === 'win32') {
      return encoding != null ? fs.readFileSync(win32FsPath(p), encoding) : fs.readFileSync(win32FsPath(p));
    }
    throw e;
  }
}

function isPathLengthFsError(err) {
  const code = err && err.code;
  if (code === 'ENAMETOOLONG' || code === 'ENOENT' || code === 'EINVAL') return true;
  const msg = err && err.message ? String(err.message) : '';
  return /filename too long|cannot find the (path|file)|ENOENT|ENAMETOOLONG/i.test(msg);
}

module.exports = {
  win32FsPath,
  stripWin32LongPrefix,
  fsExistsSync,
  fsStatSync,
  fsStat,
  fsReaddir,
  fsReaddirSync,
  fsRealpathSync,
  fsReadFileSync,
  isPathLengthFsError,
};
