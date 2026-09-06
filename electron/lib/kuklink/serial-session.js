'use strict';

const fs = require('fs');
const path = require('path');

function loadSerialPort() {
  try {
    return require('serialport').SerialPort;
  } catch (err) {
    const e = new Error(
      'Seriell-Modul nicht geladen. In electron/ bitte npm install ausführen (serialport).',
    );
    e.cause = err;
    e.code = 'SERIALPORT_MISSING';
    throw e;
  }
}

function listPorts() {
  const SerialPort = loadSerialPort();
  return SerialPort.list();
}

function openPort(opts) {
  const SerialPort = loadSerialPort();
  const port = new SerialPort({
    path: String(opts.path),
    baudRate: Number(opts.baudRate) || 9600,
    dataBits: Number(opts.dataBits) || 8,
    parity: opts.parity || 'none',
    stopBits: Number(opts.stopBits) || 1,
    autoOpen: false,
  });
  return new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port || !port.isOpen) {
      resolve();
      return;
    }
    port.close(() => resolve());
  });
}

function writeBytes(port, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return new Promise((resolve, reject) => {
    port.write(buf, (err) => {
      if (err) reject(err);
      else port.drain((e2) => (e2 ? reject(e2) : resolve()));
    });
  });
}

/**
 * Bytes sammeln. Bei LF optional ACK 0x00 (DWC-3/4/5 Parameterausdruck).
 * Ende: Idle nach mindestens minBytes, oder maxMs.
 */
function collectBytes(port, opts) {
  const maxMs = opts && opts.maxMs != null ? Number(opts.maxMs) : 8000;
  const idleMs = opts && opts.idleMs != null ? Number(opts.idleMs) : 1200;
  const minBytes = opts && opts.minBytes != null ? Number(opts.minBytes) : 16;
  const ackOnLf = !!(opts && opts.ackOnLf);
  const onChunk = opts && typeof opts.onChunk === 'function' ? opts.onChunk : null;
  const chunks = [];
  let lastRx = Date.now();

  function onData(buf) {
    if (!buf || !buf.length) return;
    chunks.push(Buffer.from(buf));
    lastRx = Date.now();
    if (onChunk) {
      try {
        onChunk(buf);
      } catch (_) {}
    }
    if (ackOnLf) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          try {
            port.write(Buffer.from([0x00]));
          } catch (_) {}
        }
      }
    }
  }

  port.on('data', onData);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now();
      const n = chunks.reduce((s, c) => s + c.length, 0);
      if (now - started >= maxMs) {
        finish();
        return;
      }
      if (n >= minBytes && now - lastRx >= idleMs) finish();
    }, 40);
    function finish() {
      clearInterval(tick);
      port.off('data', onData);
      resolve(Buffer.concat(chunks));
    }
  });
}

function prefsFile(dbDir) {
  return path.join(dbDir, 'kuklink_port_prefs.json');
}

function readPrefs(dbDir) {
  try {
    const p = prefsFile(dbDir);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writePrefs(dbDir, data) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(prefsFile(dbDir), JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

module.exports = {
  loadSerialPort,
  listPorts,
  openPort,
  closePort,
  writeBytes,
  collectBytes,
  readPrefs,
  writePrefs,
};
