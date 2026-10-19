'use strict';

/**
 * OneDrive-Datei-IO aus dem Electron-Hauptprozess heraus.
 * Der Worker blockiert bei Cloud-Dateisperren; UI und Heartbeat bleiben im Hauptprozess frei.
 */

const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;
let seq = 0;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map();

function failAll(err) {
  for (const item of pending.values()) item.reject(err);
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'cloud-io-worker.js'));
  worker.on('message', (msg) => {
    const item = pending.get(msg && msg.id);
    if (!item) return;
    pending.delete(msg.id);
    if (msg.ok) {
      if (msg.bytes) item.resolve(Buffer.from(msg.bytes));
      else item.resolve(msg.result);
      return;
    }
    const err = new Error(msg.error || 'Datei-IO fehlgeschlagen');
    if (msg.code) err.code = msg.code;
    item.reject(err);
  });
  worker.on('error', (err) => {
    const current = worker;
    worker = null;
    failAll(err instanceof Error ? err : new Error(String(err)));
    if (current) {
      current.terminate().catch(() => {});
    }
  });
  worker.on('exit', (code) => {
    worker = null;
    if (!pending.size) return;
    failAll(new Error('Datei-IO-Worker beendet (' + code + ').'));
  });
  return worker;
}

function call(op, payload, transferList) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage(Object.assign({ id, op }, payload), transferList || []);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

async function replaceFileOffMainThread(destPath, data, opts) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data == null ? '' : data);
  const bytes = Buffer.allocUnsafeSlow(buf.length);
  buf.copy(bytes);
  const payload = { dest: destPath, bytes, opts: opts || null };
  if (!bytes.byteLength) return call('replace', payload);
  return call('replace', payload, [bytes.buffer]);
}

function statOffMainThread(filePath) {
  return call('stat', { path: filePath });
}

function existsOffMainThread(filePath) {
  return call('exists', { path: filePath });
}

function readdirOffMainThread(dirPath) {
  return call('readdir', { path: dirPath });
}

function readFileOffMainThread(filePath) {
  return call('readFile', { path: filePath });
}

async function closeCloudIoLane() {
  const current = worker;
  worker = null;
  failAll(new Error('Datei-IO-Worker geschlossen.'));
  if (!current) return;
  await current.terminate();
}

module.exports = {
  replaceFileOffMainThread,
  statOffMainThread,
  existsOffMainThread,
  readdirOffMainThread,
  readFileOffMainThread,
  closeCloudIoLane,
};
