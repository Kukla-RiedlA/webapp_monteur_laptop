'use strict';

const serial = require('./serial-session');
const term = require('./terminal-log');
const { normalizeSettings, classifyBuffer } = require('./connect-probe');
const {
  decodeDumpBuffer,
  detectDumpFamily,
  extractFabFromDump,
  suggestedFilename,
  FAMILY_LEGACY,
  FAMILY_DWC6,
} = require('./format-detect');

function frameLabel(settings) {
  const s = normalizeSettings(settings);
  const p = String(s.parity || 'none').charAt(0).toLowerCase() || 'n';
  return s.baudRate + ',' + p + ',' + s.dataBits + ',' + s.stopBits;
}

function resolveTrigger(opts, family) {
  if (opts && opts.trigger === 'etx_ov') return 'etx_ov';
  if (opts && (opts.trigger === 'p_or_stx' || opts.trigger === 'p')) return 'p_or_stx';
  if (opts && opts.trigger === 'stx') return 'stx';
  if (family === FAMILY_DWC6) return 'etx_ov';
  // L2.36 / DWC-4: 'P' oder STX startet tx_derzeit(1). DWC-3 ignoriert 'P'.
  return 'p_or_stx';
}

function resolveFamily(opts) {
  const raw = opts && opts.family != null ? String(opts.family) : '';
  if (raw === FAMILY_DWC6 || raw === 'dwc6' || raw === 'dwc6_pal') return FAMILY_DWC6;
  if (raw === FAMILY_LEGACY || raw === 'legacy_pa' || raw === 'legacy') return FAMILY_LEGACY;
  return FAMILY_LEGACY;
}

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
    if (!session || !buf || !buf.length) return;
    if (!session.rxChunks) session.rxChunks = [];
    session.rxChunks.push(Buffer.from(buf));
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
  const settings = normalizeSettings(Object.assign({ path: portPath }, (opts && opts.settings) || {}));
  if (!settings.path) {
    return { ok: false, error: 'COM-Port fehlt.' };
  }
  const family = resolveFamily(opts);
  const label = String((opts && opts.label) || (family === FAMILY_DWC6 ? 'DWC-6' : 'DWC-3/5'));
  const trigger = resolveTrigger(opts, family);
  term.clear();
  term.meta('Verbinde ' + settings.path + ' · ' + frameLabel(settings) + ' · ' + label + ' · DTR/RTS aus');
  let port;
  try {
    port = await serial.openPort(settings);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    term.meta(msg);
    return { ok: false, error: msg };
  }
  session = {
    port,
    settings,
    family,
    label,
    trigger,
    dumpBuffer: null,
    dumpText: '',
    rxChunks: [],
  };
  attachTap(session.port);
  term.meta('Verbunden ' + settings.path + ' · ' + frameLabel(settings) + ' · ' + label);
  return {
    ok: true,
    status: publicStatus(),
  };
}

async function dumpAgain() {
  if (!session || !session.port) {
    return { ok: false, error: 'Keine Verbindung.' };
  }
  const isEtx = session.trigger === 'etx_ov';
  const tryPThenStx = session.trigger === 'p_or_stx' || session.trigger === 'p';
  const baud = Number(session.settings && session.settings.baudRate) || 9600;
  const slow = baud <= 1200;
  session.rxChunks = [];
  session.dumpBuffer = null;
  session.dumpText = '';
  await serial.flushPort(session.port);
  await serial.sleep(80);
  const startLabel = isEtx ? 'ETX OV' : tryPThenStx ? 'P / STX' : 'STX';
  term.meta('Parameterliste holen (' + startLabel + (slow ? ', 1200 Baud' : '') + ')');

  let rx = 0;
  const collectP = serial.collectBytes(session.port, {
    maxMs: slow ? 240000 : 60000,
    idleMs: slow ? 4000 : 1500,
    minBytes: 20,
    ackOnLf: !isEtx,
    abortIfEmptyMs: slow ? 45000 : 8000,
    onChunk: (b) => {
      rx += b && b.length ? b.length : 0;
    },
  });
  if (isEtx) {
    term.tx('ETX OV');
    await serial.writeBytesWithGap(session.port, Buffer.from('\x03OV', 'latin1'), 50);
  } else if (tryPThenStx) {
    // L2.36 (Rw3.c) und DWC-4: Firmware case 'P' / case 0x02 → tx_derzeit(1).
    // Altes KUKLink VB sendet "P", C-Version ComWrite(0x02) — nacheinander probieren.
    const cmds = [
      { label: 'P', bytes: Buffer.from('P', 'ascii') },
      { label: 'STX', bytes: Buffer.from([0x02]) },
    ];
    for (let i = 0; i < 6 && rx < 8; i++) {
      const cmd = cmds[i % cmds.length];
      term.tx(cmd.label + (i >= 2 ? ' Wiederholung' : ''));
      await serial.writeBytes(session.port, cmd.bytes);
      await serial.sleep(slow ? 550 : 400);
    }
  } else {
    // KUKLink DWC_ParConnect: ComWrite(Com, 0x02). Firmware (dwcLauf) prüft
    // sbuf_rx==0x02 nur im Haupttakt — STX bei Bedarf wiederholen.
    const tries = slow ? 8 : 2;
    const waitMs = slow ? 450 : 350;
    for (let i = 0; i < tries; i++) {
      if (rx >= 8) break;
      term.tx(i === 0 ? 'STX' : 'STX Wiederholung ' + (i + 1));
      await serial.writeBytes(session.port, Buffer.from([0x02]));
      await serial.sleep(waitMs);
    }
  }
  const collectBuf = await collectP;
  const tapped = session.rxChunks && session.rxChunks.length ? Buffer.concat(session.rxChunks) : Buffer.alloc(0);
  const buf = tapped.length >= collectBuf.length ? tapped : collectBuf;
  const decoded = decodeDumpBuffer(buf);
  const hit = classifyBuffer(buf);
  session.dumpBuffer = buf;
  session.dumpText = hit ? hit.text : decoded.text || '';
  const fam = hit || detectDumpFamily(session.dumpText);
  if (fam && fam.family) {
    session.family = fam.family;
    if (fam.label) session.label = fam.label;
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
    filename: suggestedFilename(session.family, extractFabFromDump(session.dumpText || ''), session.dumpText),
  };
}

function sessionDumpText() {
  if (!session) return '';
  const tapped =
    session.rxChunks && session.rxChunks.length ? Buffer.concat(session.rxChunks) : session.dumpBuffer;
  if (tapped && tapped.length) {
    const decoded = decodeDumpBuffer(tapped);
    if (decoded.text && decoded.text.length >= (session.dumpText || '').length) return decoded.text;
  }
  return session.dumpText || '';
}

function currentDump() {
  if (!session) return null;
  const text = sessionDumpText();
  const fab = extractFabFromDump(text);
  return {
    text,
    buffer: session.rxChunks && session.rxChunks.length ? Buffer.concat(session.rxChunks) : session.dumpBuffer,
    family: session.family,
    label: session.label,
    fab,
    filename: suggestedFilename(session.family, fab, text),
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
