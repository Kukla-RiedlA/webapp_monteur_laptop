'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertRemoteFileName } = require('./validate');

function fail(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_local_dir';
  return err;
}

function defaultLocalDir() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  if (docs && fs.existsSync(docs)) return docs;
  return home;
}

function resolveLocalDir(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const dir = path.resolve(text || defaultLocalDir());
  if (!dir || dir.length > 1024) throw fail('Ungültiger Ordner.');
  let st;
  try {
    st = fs.statSync(dir);
  } catch (_) {
    throw fail('Ordner nicht gefunden.');
  }
  if (!st.isDirectory()) throw fail('Das ist kein Ordner.');
  return dir;
}

function parentLocalDir(dir) {
  const resolved = resolveLocalDir(dir);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return parent;
}

function listLocalDirectory(raw) {
  const dir = resolveLocalDir(raw);
  const names = fs.readdirSync(dir, { withFileTypes: true });
  const entries = [];
  for (const item of names) {
    if (!item || !item.name || item.name === '.' || item.name === '..') continue;
    if (item.name.startsWith('.')) continue;
    const full = path.join(dir, item.name);
    let size = 0;
    let mtime = '';
    let type = item.isDirectory() ? 'dir' : 'file';
    try {
      const st = fs.statSync(full);
      size = st.isFile() ? st.size : 0;
      mtime = st.mtime ? st.mtime.toISOString() : '';
      type = st.isDirectory() ? 'dir' : 'file';
    } catch (_) {
      continue;
    }
    entries.push({ name: item.name, type, size, mtime });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
  return { path: dir, parent: parentLocalDir(dir), entries };
}

function uniqueLocalName(dir, desired) {
  const base = assertRemoteFileName(desired);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = stem + '_' + n + ext;
    n += 1;
    if (n > 9999) throw fail('Zu viele Dateien mit diesem Namen.');
  }
  return candidate;
}

function saveLocalFile(rawDir, filename, buffer) {
  const dir = resolveLocalDir(rawDir);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('Datei ist leer.');
  const name = uniqueLocalName(dir, filename);
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buffer);
  return { path: dest, name, dir };
}

module.exports = {
  defaultLocalDir,
  resolveLocalDir,
  parentLocalDir,
  listLocalDirectory,
  saveLocalFile,
};
