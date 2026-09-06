'use strict';

const serial = require('./serial-session');
const term = require('./terminal-log');
const { probeConnect, normalizeSettings, classifyBuffer } = require('./connect-probe');
const {
  decodeDumpBuffer,
  detectDumpFamily,
  extractFabFromDump,
  suggestedFilename,
} = require('./format-detect');

let session = null;
let tapHandler = null;

function detachTap() {
  if (session && session.port && tapHandler) {
    try {
      session.port.off('data', tapHandler);
    } catch (_) {}
  }
  tapHandler = null;
}

function attachTap(port) {
  detachTap();
  if (!port) return;
  tapHandler = function onTap(buf) {
    term.rx(buf);
  };
  port.on('data', tapHandler);
}

function publicStatus() {
  const snap = term.snapshot();
  if (!session) {
    return { connected: false, rxBytes: snap.rxBytes };
  }
  return {
    connected: true,
    path: session.settings.path,
    baudRate: session.settings.baudRate,
    dataBits: session.settings.dataBits,
    parity: session.settings.parity,
    stopBits: session.settings.stopBits,
    family: session.family,
    label: session.label,
    trigger: session.trigger,
    previewBytes: session.dumpBuffer ? session.dumpBuffer.length : 0,
    rxBytes: snap.rxBytes,
  };
}

function terminalSince(after, generation) {
  return term.since(after, generation);
}

async function disconnect() {
  detachTap();
  if (session && session.port) {
    await serial.closePort(session.port);
  }
  if (session) {
    term.meta('Getrennt');
  }
  session = null;
}

async function connect(portPath, opts) {
  await disconnect();
  term.clear();
  term.meta('Verbinde ' + portPath + ' …');
  const result = await probeConnect(portPath, opts);
  if (!result.ok) {
    term.meta(result.error || 'Verbindung fehlgeschlagen');
    return {
      ok: false,
      error: result.error,
      needManual: !!result.needManual,
      attempts: result.attempts,
    };
  }
  session = {
    port: result.port,
    settings: result.settings,
    family: result.dump.family,
    label: result.dump.label,
    trigger: result.trigger,
    dumpBuffer: Buffer.from(result.dump.text, result.dump.encoding || 'latin1'),
    dumpText: result.dump.text,
  };
  attachTap(session.port);
  return {
    ok: true,
    status: publicStatus(),
    preview: result.dump.text.slice(0, 1200),
    attempts: result.attempts,
  };
}

async function dumpAgain() {
  if (!session || !session.port) {
    return { ok: false, error: 'Keine Verbindung.' };
  }
  const trigger =
    session.trigger === 'etx_ov' ? Buffer.from('\x03OV', 'latin1') : Buffer.from([0x02]);
  term.meta('Parameterliste holen');
  term.tx(session.trigger === 'etx_ov' ? 'ETX OV' : 'STX');
  await serial.writeBytes(session.port, trigger);
  const buf = await serial.collectBytes(session.port, {
    maxMs: 25000,
    idleMs: 1500,
    minBytes: 20,
    ackOnLf: true,
  });
  const decoded = decodeDumpBuffer(buf);
  const fam = detectDumpFamily(decoded.text);
  if (fam.family) {
    session.family = fam.family;
    session.label = fam.label;
    session.dumpText = decoded.text;
    session.dumpBuffer = buf;
  } else if (decoded.text && decoded.text.length > 20) {
    session.dumpText = decoded.text;
    session.dumpBuffer = buf;
  }
  term.meta(
    (session.label || session.family || 'Dump') +
      ' · ' +
      (session.dumpText ? session.dumpText.length : 0) +
      ' Zeichen',
  );
  return {
    ok: true,
    status: publicStatus(),
    text: session.dumpText || '',
    family: session.family,
    label: session.label,
    fab: extractFabFromDump(session.dumpText || ''),
    filename: suggestedFilename(session.family, extractFabFromDump(session.dumpText || '')),
  };
}

function currentDump() {
  if (!session) return null;
  const fab = extractFabFromDump(session.dumpText || '');
  return {
    text: session.dumpText || '',
    buffer: session.dumpBuffer,
    family: session.family,
    label: session.label,
    fab,
    filename: suggestedFilename(session.family, fab),
    settings: session.settings,
  };
}

module.exports = {
  listPorts: serial.listPorts,
  connect,
  disconnect,
  dumpAgain,
  currentDump,
  publicStatus,
  terminalSince,
  normalizeSettings,
  classifyBuffer,
};
