'use strict';

const path = require('path');
const crypto = require('crypto');

const PARAM_EXT_RE = /\.(csv|txt|pa3|pa4|pa5|pal)$/i;

function isSupportedParameterFileName(fileName) {
  return PARAM_EXT_RE.test(String(fileName || '').trim());
}

function normalizeFabDigits(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function extractFilenameFab(fileName) {
  const base = path.basename(String(fileName || ''));
  const checks = [
    /(?:^|[^A-Z0-9])FN\s*[-_: ]?\s*(\d{3,})/i,
    /(?:^|[^A-Z0-9])(fabricationnumber|fabriknummer)\s*[-_: ]\s*(\d{3,})/i,
    /\b(\d{4,6})\b/,
  ];
  for (const re of checks) {
    const m = base.match(re);
    if (!m) continue;
    const g = m[2] || m[1];
    const fab = normalizeFabDigits(g);
    if (fab) return fab;
  }
  return '';
}

function decodeBufferSmart(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const attempts = ['utf8', 'latin1'];
  for (const enc of attempts) {
    const txt = buf.toString(enc);
    if (!txt) continue;
    if (enc === 'utf8' && /\uFFFD/.test(txt)) continue;
    return { text: txt, encoding: enc };
  }
  return { text: buf.toString('latin1'), encoding: 'latin1' };
}

function extractContentFab(text) {
  const src = String(text || '');
  if (!src) return '';
  const patterns = [
    /fabricationnumber\s*[:;]\s*(\d{3,})/i,
    /\bFN\s*[:; ]\s*(\d{3,})/i,
    /fabriknummer\s*[:;]\s*(\d{3,})/i,
    /;\s*fabriknummer\s*;\s*(\d{3,})\s*;/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const fab = normalizeFabDigits(m[1]);
    if (fab) return fab;
  }
  return '';
}

function parseDelimitedLine(line, lineNo) {
  const parts = String(line || '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length < 2) return null;
  let key = parts[0];
  let value = parts[1];
  let unit = '';
  if (/^\d+$/.test(parts[0]) && parts.length >= 3) {
    key = parts[1];
    value = parts[2];
    unit = parts[3] || '';
  } else {
    unit = parts[2] || '';
  }
  if (!key) return null;
  return {
    line_no: lineNo,
    param_key: String(key).trim(),
    param_value: String(value || '').trim(),
    unit: String(unit || '').trim(),
    raw_line: String(line || ''),
  };
}

function parseColonLine(line, lineNo) {
  const m = String(line || '').match(/^\s*([^:;]{2,}?)\s*[:]\s*(.+?)\s*$/);
  if (!m) return null;
  return {
    line_no: lineNo,
    param_key: String(m[1] || '').trim(),
    param_value: String(m[2] || '').trim(),
    unit: '',
    raw_line: String(line || ''),
  };
}

function extractEntries(text) {
  const rows = String(text || '').split(/\r\n|\n|\r/);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    const raw = rows[i];
    const line = String(raw || '').trim();
    if (!line) continue;
    if (line.length > 512) continue;
    let parsed = null;
    if (line.indexOf(';') >= 0) parsed = parseDelimitedLine(line, lineNo);
    if (!parsed && line.indexOf(':') >= 0) parsed = parseColonLine(line, lineNo);
    if (!parsed) continue;
    const keyLow = parsed.param_key.toLowerCase();
    if (keyLow === 'fabriknummer' || keyLow === 'fabricationnumber' || keyLow === 'fn') continue;
    if (!parsed.param_key || parsed.param_key.length < 2) continue;
    out.push(parsed);
  }
  return out;
}

function parseParameterFile(buffer, opts) {
  const fileName = String((opts && opts.fileName) || '').trim();
  const decoded = decodeBufferSmart(buffer);
  const filenameFab = extractFilenameFab(fileName);
  const contentFab = extractContentFab(decoded.text);
  const usedFab = contentFab || filenameFab || '';
  const entries = extractEntries(decoded.text);
  const sha256 = crypto.createHash('sha256').update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])).digest('hex');
  return {
    ok: true,
    file_name: path.basename(fileName),
    file_ext: path.extname(fileName).toLowerCase(),
    sha256,
    text_encoding: decoded.encoding,
    filename_fab: filenameFab,
    content_fab: contentFab,
    used_fab: usedFab,
    entries,
  };
}

module.exports = {
  isSupportedParameterFileName,
  parseParameterFile,
  normalizeFabDigits,
  extractFilenameFab,
  extractContentFab,
};
