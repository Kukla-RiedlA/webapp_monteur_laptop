'use strict';

const MAX_CHARS = 200000;

let generation = 1;
let text = '';
let rxBytes = 0;

function clear() {
  generation += 1;
  text = '';
  rxBytes = 0;
}

function formatRx(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 0x0d) {
      out += '\n';
      if (src[i + 1] === 0x0a) i += 1;
    } else if (b === 0x0c) {
      out += '\n\n';
    } else if (b === 0x0a || b === 0x09) {
      out += String.fromCharCode(b);
    } else if (b === 0x02) {
      out += '<STX>';
    } else if (b === 0x03) {
      out += '<ETX>';
    } else if (b === 0x00) {
      continue;
    } else if (b >= 32 && b !== 127) {
      out += String.fromCharCode(b);
    } else {
      out += '.';
    }
  }
  return out;
}

function append(chunk) {
  const s = String(chunk || '');
  if (!s) return;
  text += s;
  if (text.length > MAX_CHARS) {
    text = text.slice(text.length - MAX_CHARS);
    generation += 1;
  }
}

function rx(buf) {
  const n = Buffer.isBuffer(buf) ? buf.length : Buffer.from(buf || []).length;
  rxBytes += n;
  append(formatRx(buf));
}

function tx(label) {
  const s = String(label || '').trim();
  if (!s) return;
  append('\n>> ' + s + '\n');
}

function meta(line) {
  const s = String(line || '').trim();
  if (!s) return;
  append('\n[' + s + ']\n');
}

function since(after, clientGen) {
  const gen = Number(clientGen) || 0;
  if (gen !== generation) {
    return {
      generation,
      seq: text.length,
      chunk: text,
      reset: true,
      rxBytes,
    };
  }
  const a = Math.max(0, Number(after) || 0);
  return {
    generation,
    seq: text.length,
    chunk: a < text.length ? text.slice(a) : '',
    reset: false,
    rxBytes,
  };
}

function snapshot() {
  return { generation, seq: text.length, text, rxBytes };
}

/** Probe-Log ersetzen durch den erfolgreichen Dump. */
function replaceWithDump(dumpText, header) {
  clear();
  const h = String(header || '').trim();
  if (h) meta(h);
  append(String(dumpText || ''));
}

module.exports = {
  clear,
  rx,
  tx,
  meta,
  replaceWithDump,
  since,
  snapshot,
  formatRx,
};
