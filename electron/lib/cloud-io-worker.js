'use strict';

/**
 * Datei-IO für OneDrive/Cloud-Ordner.
 * Läuft absichtlich nicht im Electron-Hauptprozess: stat/copy/read auf OneDrive
 * blockieren sonst den Event-Loop (UI, Heartbeat, lokaler HTTP-Server).
 */

const fs = require('fs');
const { parentPort } = require('worker_threads');
const { replaceFileWithoutUnlink } = require('./replace-file-cloud-safe');
const { win32FsPath } = require('./win32-long-path');

function statInfo(filePath) {
  const primary = win32FsPath(filePath);
  let st;
  try {
    st = fs.statSync(primary);
  } catch (e) {
    if (primary === filePath) throw e;
    st = fs.statSync(filePath);
  }
  return {
    size: Number(st.size) || 0,
    mtimeMs: st.mtimeMs != null ? Number(st.mtimeMs) || 0 : st.mtime ? st.mtime.getTime() : 0,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
  };
}

function existsPath(filePath) {
  const primary = win32FsPath(filePath);
  try {
    if (fs.existsSync(primary)) return true;
  } catch (_) {
    /* ignore */
  }
  if (primary !== filePath) {
    try {
      if (fs.existsSync(filePath)) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

function readDirEntries(dirPath) {
  const primary = win32FsPath(dirPath);
  let entries;
  try {
    entries = fs.readdirSync(primary, { withFileTypes: true });
  } catch (e) {
    if (primary === dirPath) throw e;
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  }
  return entries.map((ent) => ({
    name: ent.name,
    isDirectory: ent.isDirectory(),
    isFile: ent.isFile(),
  }));
}

function readFileBytes(filePath) {
  const primary = win32FsPath(filePath);
  try {
    return fs.readFileSync(primary);
  } catch (e) {
    if (primary === filePath) throw e;
    return fs.readFileSync(filePath);
  }
}

parentPort.on('message', async (msg) => {
  const id = msg && msg.id;
  try {
    const op = msg && msg.op;
    if (op === 'replace') {
      const bytes = msg.bytes ? Buffer.from(msg.bytes) : Buffer.alloc(0);
      const dest = await replaceFileWithoutUnlink(msg.dest, bytes, msg.opts || undefined);
      parentPort.postMessage({ id, ok: true, result: dest });
      return;
    }
    if (op === 'stat') {
      parentPort.postMessage({ id, ok: true, result: statInfo(msg.path) });
      return;
    }
    if (op === 'exists') {
      parentPort.postMessage({ id, ok: true, result: existsPath(msg.path) });
      return;
    }
    if (op === 'readdir') {
      parentPort.postMessage({ id, ok: true, result: readDirEntries(msg.path) });
      return;
    }
    if (op === 'readFile') {
      const raw = readFileBytes(msg.path);
      const bytes = Buffer.allocUnsafeSlow(raw.length);
      raw.copy(bytes);
      parentPort.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
      return;
    }
    throw new Error('Unbekannte Datei-Operation.');
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e && e.message ? String(e.message) : String(e),
      code: e && e.code ? String(e.code) : '',
    });
  }
});
