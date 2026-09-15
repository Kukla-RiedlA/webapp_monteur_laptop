'use strict';

const { isPa3DumpFormat } = require('../pa3-to-pdf');
const { isIdPaFormat } = require('./idpa-to-pal');
const { isPalDwc6Format } = require('../pal-to-pdf');
const { extractContentFab, extractFilenameFab, normalizeFabDigits } = require('../anlagenstamm-parameter-parser');

const FAMILY_LEGACY = 'legacy_pa';
const FAMILY_DWC6 = 'dwc6_pal';

function normalizeDumpNewlines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function stripDumpControls(text) {
  return String(text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function decodeDumpBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const latin1 = stripDumpControls(normalizeDumpNewlines(buf.toString('latin1')));
  const utf8 = stripDumpControls(normalizeDumpNewlines(buf.toString('utf8')));
  if (utf8 && !/\uFFFD/.test(utf8) && /[;:]/.test(utf8)) return { text: utf8, encoding: 'utf8' };
  return { text: latin1, encoding: 'latin1' };
}

function looksLikePrintableDump(text) {
  const src = String(text || '');
  if (src.length < 12) return false;
  const printable = src.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return printable.length >= 8;
}

function legacyDumpLabel(src) {
  const text = String(src || '');
  const l2 = text.match(/\bDWC4\s+([LED]2\.\d+)/i) || text.match(/\bWIEN\s+([LED]2\.\d+)/i);
  if (l2) return 'DWC-4 ' + String(l2[1]).toUpperCase();
  if (/\bDWC4\b/i.test(text) || /\bDWC-4\b/i.test(text)) return 'DWC-4';
  if (/\bDWC-?5/i.test(text)) return 'DWC-5';
  if (/\bDWC-?3/i.test(text)) return 'DWC-3';
  return 'DWC-3/4/5';
}

function detectDumpFamily(text, filename) {
  const src = String(text || '');
  if (isIdPaFormat(src) || (/^\s*IdPa\s+\d+/im.test(src) && /FabrikNum/i.test(src))) {
    return { family: FAMILY_LEGACY, label: legacyDumpLabel(src) };
  }
  if (isPalDwc6Format(src, filename)) {
    return { family: FAMILY_DWC6, label: 'DWC-6' };
  }
  if (isPa3DumpFormat(src, filename)) {
    return { family: FAMILY_LEGACY, label: legacyDumpLabel(src) };
  }
  return { family: null, label: null };
}

function extractFabFromDump(text, filename) {
  const src = String(text || '');
  const fromParser = extractContentFab(src);
  if (fromParser) return fromParser;
  const header = src.match(/\*{2,}\s*[^\d\n*]{0,24}:\s*(\d{3,5})/);
  if (header) return normalizeFabDigits(header[1]);
  const pal110 = src.match(/^\s*110\s*;\s*[^;\n]{0,40};\s*(\d{3,})/im);
  if (pal110) return normalizeFabDigits(pal110[1]);
  const idPa110 = src.match(/^\s*IdPa\s+110\s+(\d{3,})\b/im);
  if (idPa110) return normalizeFabDigits(idPa110[1]);
  const idPaNamed = src.match(/^\s*IdPa\s+\d+\s+(\d{3,})\s+\d+\s+\d+\s+FabrikNum/im);
  if (idPaNamed) return normalizeFabDigits(idPaNamed[1]);
  return extractFilenameFab(filename || '');
}

function suggestedFilename(family, fab, text) {
  const fn = fab ? 'FN_' + String(fab) : 'kuklink';
  if (family === FAMILY_DWC6 || isIdPaFormat(text)) return fn + '.pal';
  return fn + '.pa3';
}

module.exports = {
  FAMILY_LEGACY,
  FAMILY_DWC6,
  decodeDumpBuffer,
  looksLikePrintableDump,
  detectDumpFamily,
  extractFabFromDump,
  suggestedFilename,
  isIdPaFormat,
  legacyDumpLabel,
};
