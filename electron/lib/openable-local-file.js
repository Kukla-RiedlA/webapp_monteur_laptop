'use strict';

const fs = require('fs');
const path = require('path');

function looksLikePdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
}

function isCsvFilePath(filePath) {
  return String(path.extname(String(filePath || ''))).toLowerCase() === '.csv';
}

function looksLikePdfFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return false;
  if (/\.pdf$/i.test(p)) return true;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(5);
      const n = fs.readSync(fd, buf, 0, 5, 0);
      return n >= 5 && looksLikePdfBuffer(buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return false;
  }
}

function safeOpenFileName(displayName, fallbackExt) {
  let name = String(displayName || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim() || 'download';
  name = path.basename(name.replace(/\\/g, '/'));
  const ext = path.extname(name);
  const fb = String(fallbackExt || '').trim();
  if (!ext && fb) name += fb.charAt(0) === '.' ? fb : '.' + fb;
  return name;
}

function stripOpenStampPrefix(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  const stripped = base.replace(/^\d{14}_/, '');
  return stripped || base;
}

function copyToNamedOpenPath(sourcePath, destDir, displayName, fallbackExt) {
  const src = path.normalize(String(sourcePath || '').trim());
  if (!src || !fs.existsSync(src)) return '';
  const name = safeOpenFileName(displayName, fallbackExt);
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
  const dest = path.join(destDir, stamp + '_' + name);
  fs.copyFileSync(src, dest);
  return dest;
}

function materializeOpenablePath(sourcePath, destDir, displayName) {
  const src = path.normalize(String(sourcePath || '').trim());
  if (!src || !fs.existsSync(src)) return src;
  if (path.extname(src)) return src;
  const rawName = path.basename(String(displayName || '').replace(/\\/g, '/') || 'download');
  let fallbackExt = path.extname(rawName);
  if (!fallbackExt && looksLikePdfFile(src)) fallbackExt = '.pdf';
  return copyToNamedOpenPath(src, destDir, rawName || displayName, fallbackExt) || src;
}

module.exports = {
  looksLikePdfBuffer,
  looksLikePdfFile,
  isCsvFilePath,
  stripOpenStampPrefix,
  safeOpenFileName,
  copyToNamedOpenPath,
  materializeOpenablePath,
};
