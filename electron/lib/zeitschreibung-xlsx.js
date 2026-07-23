'use strict';

const fs = require('fs');
const path = require('path');
const calc = require('./zeitschreibung-calc');

const HOUR_COLS = [
  { col: 'D', field: 'anw' },
  { col: 'E', field: 'montage' },
  { col: 'F', field: 'ue50' },
  { col: 'G', field: 'ue100' },
  { col: 'H', field: 'weg' },
  { col: 'I', field: 'urlaub' },
  { col: 'J', field: 'za_plus' },
  { col: 'K', field: 'za_minus' },
  { col: 'L', field: 'krank' },
];

/** Row 8 = Tag 1 … Row 38 = Tag 31 (wie Excel-Vorlage). */
const FIRST_DATA_ROW = 8;

function resolveTemplatePath() {
  const candidates = [
    path.join(__dirname, '..', 'templates', 'zeitschreibung_vorlage.xlsx'),
    path.join(process.cwd(), 'templates', 'zeitschreibung_vorlage.xlsx'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Zeitschreibung-Vorlage fehlt (templates/zeitschreibung_vorlage.xlsx).');
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/** Eine Zelle matchen: Self-Closing ohne Slash in Attributen, sonst Open/Close. */
function findCellMatch(sheetXml, ref) {
  const re = new RegExp(
    `<c r="${ref}"[^/]*/>|<c r="${ref}"[^>]*>[\\s\\S]*?</c>`,
  );
  return re.exec(sheetXml);
}

function styleAttrsFromCell(cellXml) {
  const m = /^<c r="[^"]+"([^>]*?)(?:\/>|>)/.exec(cellXml || '');
  if (!m) return '';
  return String(m[1] || '')
    .replace(/\s+t="[^"]*"/g, '')
    .replace(/\/\s*$/, '')
    .trim();
}

function numberCellXml(ref, attrs, value) {
  const a = String(attrs || '').trim();
  const prefix = a ? `<c r="${ref}" ${a}` : `<c r="${ref}"`;
  if (value == null || !Number.isFinite(Number(value)) || Math.abs(Number(value)) < 1e-12) {
    return `${prefix}/>`;
  }
  return `${prefix}><v>${Number(value)}</v></c>`;
}

function inlineStrCellXml(ref, attrs, text) {
  const a = String(attrs || '').trim();
  const prefix = a ? `<c r="${ref}" ${a}` : `<c r="${ref}"`;
  const t = text == null ? '' : String(text);
  if (!t) return `${prefix}/>`;
  return `${prefix} t="inlineStr"><is><t>${escXml(t)}</t></is></c>`;
}

function upsertCell(sheetXml, ref, newXml) {
  const m = findCellMatch(sheetXml, ref);
  if (m) {
    return sheetXml.slice(0, m.index) + newXml + sheetXml.slice(m.index + m[0].length);
  }

  const letters = ref.replace(/\d+$/, '');
  const row = ref.replace(/^[A-Z]+/i, '');
  const rowRe = new RegExp(`(<row[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rm = rowRe.exec(sheetXml);
  if (!rm) {
    throw new Error(`Zeile ${row} nicht in Vorlage gefunden (Zelle ${ref})`);
  }
  const rowOpen = rm[1];
  let inner = rm[2];
  const rowClose = rm[3];

  const styleM = /\ss="(\d+)"/.exec(inner);
  let xml = newXml;
  if (styleM && !/\ss="/.test(newXml)) {
    xml = newXml.replace(`<c r="${ref}"`, `<c r="${ref}" s="${styleM[1]}"`);
  }

  const target = colIndex(letters);
  const cellRe = new RegExp(
    `<c r="([A-Z]+)${row}"[^/]*/>|<c r="([A-Z]+)${row}"[^>]*>[\\s\\S]*?</c>`,
    'g',
  );
  let inserted = false;
  let out = '';
  let last = 0;
  let cm;
  while ((cm = cellRe.exec(inner)) !== null) {
    const colLetters = cm[1] || cm[2];
    if (!inserted && colIndex(colLetters) > target) {
      out += inner.slice(last, cm.index) + xml;
      last = cm.index;
      inserted = true;
    }
  }
  out += inner.slice(last);
  if (!inserted) out += xml;
  inner = out;

  return sheetXml.slice(0, rm.index) + rowOpen + inner + rowClose + sheetXml.slice(rm.index + rm[0].length);
}

function setNumberCell(sheetXml, ref, value) {
  const m = findCellMatch(sheetXml, ref);
  const attrs = m ? styleAttrsFromCell(m[0]) : '';
  const n = value == null || value === '' ? null : Number(value);
  if ((n == null || !Number.isFinite(n) || Math.abs(n) < 1e-12) && !m) {
    return sheetXml;
  }
  return upsertCell(sheetXml, ref, numberCellXml(ref, attrs, n));
}

function setInlineStrCell(sheetXml, ref, text) {
  const m = findCellMatch(sheetXml, ref);
  const attrs = m ? styleAttrsFromCell(m[0]) : '';
  const t = text == null ? '' : String(text);
  if (!t && !m) return sheetXml;
  return upsertCell(sheetXml, ref, inlineStrCellXml(ref, attrs, t));
}

function stripCalcChain(zip) {
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
  }
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (relsFile) {
    let rels = relsFile.asText();
    rels = rels.replace(/<Relationship[^>]*Target="calcChain\.xml"[^/]*\/>\s*/g, '');
    zip.file('xl/_rels/workbook.xml.rels', rels);
  }
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    let ct = ctFile.asText();
    ct = ct.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^/]*\/>\s*/g, '');
    zip.file('[Content_Types].xml', ct);
  }
}

/**
 * Befüllt die Excel-Vorlage 1:1 (Formeln, CF, Ferienberechnung, Drop Down bleiben).
 * @returns {Promise<Buffer>}
 */
async function generateZeitschreibungXlsxBuffer(payload) {
  const PizZip = require('pizzip');
  const year = Number(payload.year);
  const month = Number(payload.month);
  const name = String(payload.technicianName || '').trim();
  const daysRaw = Array.isArray(payload.days) ? payload.days : [];
  const days = daysRaw.map(calc.enrichDay);
  const byDate = Object.create(null);
  for (const d of days) {
    if (d && d.day_date) byDate[d.day_date] = d;
  }

  const monLabel = calc.MONTH_NAMES[month] || String(month);
  const tplPath = resolveTemplatePath();
  const zip = new PizZip(fs.readFileSync(tplPath));
  stripCalcChain(zip);

  const sheetFile = zip.file('xl/worksheets/sheet1.xml');
  if (!sheetFile) throw new Error('Vorlage: sheet1.xml fehlt');
  let sheetXml = sheetFile.asText();

  sheetXml = setInlineStrCell(sheetXml, 'F4', monLabel);
  sheetXml = setNumberCell(sheetXml, 'I4', year);
  sheetXml = setInlineStrCell(sheetXml, 'K4', name);

  const dim = calc.daysInMonth(year, month);
  for (let day = 1; day <= 31; day++) {
    const row = FIRST_DATA_ROW + day - 1;
    const dateKey = day <= dim ? calc.toDateKey(year, month, day) : null;
    const d = dateKey ? byDate[dateKey] || {} : {};

    for (const { col, field } of HOUR_COLS) {
      const n = calc.num(d[field]);
      sheetXml = setNumberCell(sheetXml, `${col}${row}`, n > 0 ? n : null);
    }
    const bemerkung = day <= dim ? String(d.bemerkung || '') : '';
    sheetXml = setInlineStrCell(sheetXml, `N${row}`, bemerkung);
  }

  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  generateZeitschreibungXlsxBuffer,
  resolveTemplatePath,
};
