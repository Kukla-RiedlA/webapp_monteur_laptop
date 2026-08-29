'use strict';

/**
 * Hang-/Lag-Diagnose für den Electron-Hauptprozess.
 * Schreibt JSON-Zeilen nach userData/hang-diag.log (kein Passwort, keine Dateiinhalte).
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 256 * 1024;
const RING_MAX = 200;
const WARN_MS = 80;
const LAG_MS = 500;
const LOOP_INTERVAL_MS = 1000;
const RENDERER_STALE_MS = 8000;

let logPath = null;
let version = '';
let phase = '';
let bgJobType = '';
let diskKind = 'unset';
let lastRendererPingAt = 0;
let lastLoopScheduledAt = 0;
let loopTimer = null;
let flushTimer = null;
let pendingDisk = [];
const ring = [];

function classifyPathKind(filePath) {
  const s = String(filePath || '').trim();
  if (!s) return 'unset';
  if (s.startsWith('\\\\') || s.startsWith('//')) return 'unc';
  if (/onedrive/i.test(s)) return 'onedrive';
  return 'local';
}

function appendLine(text, toDisk) {
  ring.push(text);
  if (ring.length > RING_MAX) ring.shift();
  if (!toDisk || !logPath) return;
  pendingDisk.push(text);
  if (flushTimer) return;
  flushTimer = setTimeout(flushDisk, 1500);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function flushDisk() {
  flushTimer = null;
  if (!logPath || !pendingDisk.length) return;
  const chunk = pendingDisk.join('\n') + '\n';
  pendingDisk = [];
  fs.promises
    .appendFile(logPath, chunk)
    .then(() => fs.promises.stat(logPath))
    .then((st) => {
      if (!st || st.size <= MAX_FILE_BYTES) return null;
      return fs.promises.readFile(logPath, 'utf8').then((buf) => {
        const keep = buf.slice(Math.floor(buf.length / 2));
        return fs.promises.writeFile(logPath, keep.startsWith('\n') ? keep.slice(1) : keep);
      });
    })
    .catch(() => {});
}

function write(level, msg, extra) {
  const rec = Object.assign(
    {
      t: new Date().toISOString(),
      v: version,
      level: level,
      msg: msg,
      phase: phase || '',
      job: bgJobType || '',
      disk: diskKind,
      rendererAgeMs: lastRendererPingAt ? Date.now() - lastRendererPingAt : null,
    },
    extra && typeof extra === 'object' ? extra : {},
  );
  appendLine(JSON.stringify(rec), level === 'error' || msg === 'hang_diag_start');
}

function startLoopWatch() {
  if (loopTimer) return;
  lastLoopScheduledAt = Date.now();
  loopTimer = setInterval(() => {
    const scheduled = Date.now();
    const intervalLag = scheduled - lastLoopScheduledAt - LOOP_INTERVAL_MS;
    lastLoopScheduledAt = scheduled;
    setImmediate(() => {
      const immediateLag = Date.now() - scheduled;
      const lag = Math.max(0, intervalLag, immediateLag);
      if (lag >= LAG_MS) write('error', 'event_loop_lag', { lagMs: lag });
      if (lastRendererPingAt && Date.now() - lastRendererPingAt > RENDERER_STALE_MS) {
        write('error', 'renderer_heartbeat_missing', {
          rendererAgeMs: Date.now() - lastRendererPingAt,
        });
      }
    });
  }, LOOP_INTERVAL_MS);
  if (typeof loopTimer.unref === 'function') loopTimer.unref();
}

function init(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const dir = String(o.userDataDir || '').trim();
  if (!dir) return;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  logPath = path.join(dir, 'hang-diag.log');
  version = String(o.version || '');
  write('info', 'hang_diag_start', { logPath: logPath });
  startLoopWatch();
}

function setPhase(name) {
  phase = name ? String(name) : '';
}

function setBackgroundJob(type) {
  bgJobType = type ? String(type) : '';
}

function setDiskRoot(filePath) {
  diskKind = classifyPathKind(filePath);
}

function noteRendererPing() {
  lastRendererPingAt = Date.now();
}

function noteGpuGone(details) {
  write('error', 'gpu_process_gone', {
    reason: details && details.reason ? String(details.reason) : '',
    exitCode: details && details.exitCode != null ? details.exitCode : null,
    type: details && details.type ? String(details.type) : 'GPU',
  });
}

function timeSync(name, fn) {
  setPhase(name);
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= LAG_MS) write('error', 'phase_duration', { name: name, ms: ms });
    else if (ms >= WARN_MS) write('warn', 'phase_duration', { name: name, ms: ms });
    setPhase('');
  }
}

async function timeAsync(name, fn) {
  setPhase(name);
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= LAG_MS) write('error', 'phase_duration', { name: name, ms: ms });
    else if (ms >= WARN_MS) write('warn', 'phase_duration', { name: name, ms: ms });
    setPhase('');
  }
}

function getRecentLines(n) {
  const take = Number.isFinite(n) && n > 0 ? n : RING_MAX;
  return ring.slice(-take);
}

function getLogPath() {
  return logPath;
}

function snapshot() {
  return {
    log_path: logPath,
    phase: phase,
    job: bgJobType,
    disk: diskKind,
    renderer_age_ms: lastRendererPingAt ? Date.now() - lastRendererPingAt : null,
    lines: getRecentLines(200),
  };
}

module.exports = {
  init,
  write,
  setPhase,
  setBackgroundJob,
  setDiskRoot,
  classifyPathKind,
  noteRendererPing,
  noteGpuGone,
  timeSync,
  timeAsync,
  getRecentLines,
  getLogPath,
  snapshot,
};
