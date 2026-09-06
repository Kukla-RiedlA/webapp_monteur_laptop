'use strict';

const { isPa3DumpFormat } = require('../pa3-to-pdf');
const { isPalDwc6Format } = require('../pal-to-pdf');
const { extractContentFab, extractFilenameFab, normalizeFabDigits } = require('../anlagenstamm-parameter-parser');

const FAMILY_LEGACY = 'legacy_pa';
const FAMILY_DWC6 = 'dwc6_pal';

function decodeDumpBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const latin1 = buf.toString('latin1');
  const utf8 = buf.toString('utf8');
  if (utf8 && !/\uFFFD/.test(utf8) && /[;:]/.test(utf8)) return { text: utf8, encoding: 'utf8' };
  return { text: latin1, encoding: 'latin1' };
}

function looksLikePrintableDump(text) {
  const src = String(text || '');
  if (src.length < 12) return false;
  const printable = src.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return printable.length >= 8;
}

function detectDumpFamily(text, filename) {
  const src = String(text || '');
  if (isPa3DumpFormat(src, filename)) {
    return { family: FAMILY_LEGACY, label: 'DWC-3/4/5' };
  }
  if (isPalDwc6Format(src, filename)) {
    return { family: FAMILY_DWC6, label: 'DWC-6' };
  }
  return { family: null, label: null };
}

function extractFabFromDump(text, filename) {
  const src = String(text || '');
  const fromParser = extractContentFab(src);
  if (fromParser) return fromParser;
  const header = src.match(/\*{2,}\s*Fabriknummer\s*:\s*(\d{3,})/i);
  if (header) return normalizeFabDigits(header[1]);
  const pal110 = src.match(/^\s*110\s*;\s*Fabriknummer\s*;\s*(\d{3,})/im);
  if (pal110) return normalizeFabDigits(pal110[1]);
  return extractFilenameFab(filename || '');
}

function suggestedFilename(family, fab) {
  const fn = fab ? 'FN' + String(fab) + '_kuklink' : 'kuklink';
  if (family === FAMILY_DWC6) return fn + '.pal';
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
};
