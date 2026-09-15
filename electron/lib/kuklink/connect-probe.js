'use strict';

const serial = require('./serial-session');
const term = require('./terminal-log');
const {
  decodeDumpBuffer,
  detectDumpFamily,
  looksLikePrintableDump,
  FAMILY_LEGACY,
} = require('./format-detect');

const BAUD_ORDER = [9600, 1200, 19200];
const FRAMES = [
  { dataBits: 8, parity: 'none', stopBits: 1 },
  { dataBits: 7, parity: 'even', stopBits: 1 },
  { dataBits: 8, parity: 'even', stopBits: 1 },
  { dataBits: 7, parity: 'none', stopBits: 1 },
];

// L2.36 (Rw3.c): case 'P' / case 0x02 → tx_derzeit(1). Altes VB-KUKLink sendet "P".
const TRIGGERS = [
  { name: 'p', bytes: Buffer.from('P', 'ascii'), ackOnLf: true },
  { name: 'stx', bytes: Buffer.from([0x02]), ackOnLf: true },
  { name: 'etx_ov', bytes: Buffer.from('\x03OV', 'latin1'), ackOnLf: true },
];

function normalizeSettings(s) {
  return {
    path: String((s && s.path) || ''),
    baudRate: Number((s && s.baudRate) || 9600),
    dataBits: Number((s && s.dataBits) || 8),
    parity: String((s && s.parity) || 'none').toLowerCase(),
    stopBits: Number((s && s.stopBits) || 1),
  };
}

function settingsKey(s) {
  const n = normalizeSettings(s);
  return [n.path, n.baudRate, n.dataBits, n.parity, n.stopBits].join('|');
}

function buildMatrix(portPath, lastPref) {
  const out = [];
  const seen = new Set();
  function push(s) {
    const n = normalizeSettings(Object.assign({ path: portPath }, s));
    if (!n.path) return;
    const k = settingsKey(n);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  }
  if (lastPref && lastPref.path === portPath) push(lastPref);
  for (const baud of BAUD_ORDER) {
    for (const frame of FRAMES) {
      push(Object.assign({ baudRate: baud }, frame));
    }
  }
  return out;
}

function looksLikeUsefulDump(text) {
  const src = String(text || '');
  if (detectDumpFamily(src).family) return true;
  if (/Parameterausdruck|Fabriknummer|WAAGENFABRIK\s+KUKLA/i.test(src)) return true;
  if ((src.match(/;/g) || []).length >= 8 && /^\s*\d+\s*;/m.test(src)) return true;
  const letters = (src.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
  return looksLikePrintableDump(src) && src.trim().length >= 40 && letters >= 20;
}

function classifyBuffer(buf) {
  if (!buf || !buf.length) return null;
  const decoded = decodeDumpBuffer(buf);
  if (!looksLikePrintableDump(decoded.text)) return null;
  const fam = detectDumpFamily(decoded.text);
  if (fam.family) {
    return {
      family: fam.family,
      label: fam.label,
      text: decoded.text,
      encoding: decoded.encoding,
      bytes: buf.length,
    };
  }
  if (!looksLikeUsefulDump(decoded.text)) return null;
  return {
    family: fam.family || FAMILY_LEGACY,
    label: fam.label || 'DWC-3/4/5',
    text: decoded.text,
    encoding: decoded.encoding,
    bytes: buf.length,
  };
}

async function tryOneSetting(settings, opts) {
  const maxMs = (opts && opts.probeMs) || 2500;
  const idleMs = (opts && opts.idleMs) || 700;
  let port;
  try {
    port = await serial.openPort(settings);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), settings };
  }
  const frame =
    settings.baudRate +
    ' ' +
    settings.dataBits +
    String(settings.parity || 'none').charAt(0).toUpperCase() +
    settings.stopBits;
  try {
    for (const trig of TRIGGERS) {
      await serial.writeBytes(port, trig.bytes);
      const buf = await serial.collectBytes(port, {
        maxMs,
        idleMs,
        minBytes: 12,
        ackOnLf: trig.ackOnLf,
      });
      const hit = classifyBuffer(buf);
      if (hit) {
        term.replaceWithDump(
          hit.text,
          'Verbunden ' + (settings.path || '') + ' · ' + frame + ' · ' + (hit.label || hit.family),
        );
        return { ok: true, port, settings, trigger: trig.name, dump: hit };
      }
    }
    await serial.closePort(port);
    return { ok: false, error: 'keine gültige Antwort', settings };
  } catch (err) {
    await serial.closePort(port);
    return { ok: false, error: err && err.message ? err.message : String(err), settings };
  }
}

/**
 * Probe Baud/Parität. Bei Treffer bleibt der Port offen (session.port).
 */
async function probeConnect(portPath, opts) {
  const dbDir = opts && opts.dbDir;
  const prefs = dbDir ? serial.readPrefs(dbDir) : {};
  const last = prefs && prefs[portPath] ? prefs[portPath] : null;
  const manual = opts && opts.settings ? normalizeSettings(Object.assign({ path: portPath }, opts.settings)) : null;
  const matrix = manual ? [manual] : buildMatrix(portPath, last);
  const attempts = [];
  for (const settings of matrix) {
    const result = await tryOneSetting(settings, opts);
    attempts.push({
      settings: result.settings,
      ok: !!result.ok,
      error: result.error || null,
    });
    if (result.ok) {
      if (dbDir) {
        prefs[portPath] = settings;
        serial.writePrefs(dbDir, prefs);
      }
      return {
        ok: true,
        settings,
        trigger: result.trigger,
        dump: result.dump,
        port: result.port,
        attempts,
      };
    }
  }
  return {
    ok: false,
    error: 'Keine passende Baudrate/Parität gefunden. Bitte Schnittstelle manuell wählen.',
    needManual: true,
    attempts,
  };
}

module.exports = {
  BAUD_ORDER,
  FRAMES,
  TRIGGERS,
  buildMatrix,
  normalizeSettings,
  probeConnect,
  classifyBuffer,
};
