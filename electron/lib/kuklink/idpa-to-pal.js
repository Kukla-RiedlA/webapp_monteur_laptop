'use strict';

const { applyCatalog } = require('./idpa-catalog');

const KNOWN_UNITS = /^(kg\/h|mm\/s|Hz|mm|%|t|kg|s|ms)$/i;

function isIdPaFormat(text) {
  const src = String(text || '');
  const lines = src.split(/\r\n|\n|\r/).map((s) => s.trim()).filter(Boolean);
  let hits = 0;
  for (const line of lines) {
    if (/^IdPa\s+\d+\s+/i.test(line)) hits += 1;
  }
  return hits >= 3;
}

function isBoundToken(s) {
  const v = String(s || '');
  return /^-?\d+$/.test(v) || /^&B[01]+$/i.test(v);
}

function parseIdPaLine(line) {
  const raw = String(line || '').trim();
  const m = raw.match(/^IdPa\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/i);
  if (!m) return null;
  const parId = parseInt(m[1], 10);
  if (!Number.isFinite(parId) || parId < 100 || parId > 999) return null;
  if (!isBoundToken(m[3]) || !isBoundToken(m[4])) return null;
  let rest = String(m[5] || '').trim();
  const tail = rest.match(/^(.*?)\s+([A-Za-z])\s+([0-9A-Fa-f]{2})$/);
  if (tail) rest = String(tail[1] || '').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  let unit = '';
  let name = rest;
  if (words.length >= 2 && KNOWN_UNITS.test(words[words.length - 1])) {
    unit = words.pop();
    name = words.join(' ');
  }
  return applyCatalog({
    parId,
    value: m[2],
    min: m[3],
    max: m[4],
    name,
    unit,
  });
}

function palField(s, width) {
  const v = String(s == null ? '' : s);
  if (!width) return v;
  return v.length >= width ? v : v + ' '.repeat(width - v.length);
}

function idPaToPal(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const row = parseIdPaLine(line);
    if (!row || !Number.isFinite(row.parId)) continue;
    if (seen.has(row.parId)) continue;
    seen.add(row.parId);
    out.push(
      [
        String(row.parId),
        palField(row.name, 16),
        row.value,
        palField(row.unit, 7),
        row.min,
        row.max,
      ].join('; ') + ';',
    );
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

module.exports = {
  isIdPaFormat,
  parseIdPaLine,
  idPaToPal,
};
