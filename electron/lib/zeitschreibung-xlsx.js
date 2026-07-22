'use strict';

const calc = require('./zeitschreibung-calc');

/**
 * Schreibt eine einfache XLSX (Office Open XML) ohne exceljs — via PizZip.
 * @returns {Promise<Buffer>}
 */
async function generateZeitschreibungXlsxBuffer(payload) {
  const PizZip = require('pizzip');
  const year = Number(payload.year);
  const month = Number(payload.month);
  const name = String(payload.technicianName || '');
  const days = Array.isArray(payload.days) ? payload.days : [];
  const sums = payload.sums || calc.columnSums(days);
  const gesamt = payload.gesamt != null ? calc.num(payload.gesamt) : calc.gesamtSum(sums);
  const monLabel = calc.MONTH_NAMES[month] || String(month);

  const rows = [];
  rows.push(['Stundenaufzeichnung']);
  rows.push([]);
  rows.push(['', '', '', '', monLabel, '', '', year, '', name]);
  rows.push([]);
  rows.push([
    'Datum',
    'Tag',
    'Feiert.',
    'Anw.',
    'Montage',
    'Ü/50%',
    'Ü/100%',
    'Weg',
    'Urlaub',
    'ZA+',
    'ZA-',
    'Krank/Arzt',
    'Summe',
    'Bemerkung',
  ]);
  for (const d of days) {
    const dk = String(d.day_date || '');
    const dateDe = dk.length >= 10 ? `${dk.slice(8, 10)}.${dk.slice(5, 7)}.${dk.slice(0, 4)}` : dk;
    rows.push([
      dateDe,
      d.weekday || '',
      d.holiday_label || '',
      calc.num(d.anw) || '',
      calc.num(d.montage) || '',
      calc.num(d.ue50) || '',
      calc.num(d.ue100) || '',
      calc.num(d.weg) || '',
      calc.num(d.urlaub) || '',
      calc.num(d.za_plus) || '',
      calc.num(d.za_minus) || '',
      calc.num(d.krank) || '',
      calc.round2(d.day_sum != null ? d.day_sum : calc.daySum(d)),
      d.bemerkung || '',
    ]);
  }
  rows.push([
    'Gesamt',
    calc.round2(gesamt),
    '',
    calc.round2(sums.anw),
    calc.round2(sums.montage),
    calc.round2(sums.ue50),
    calc.round2(sums.ue100),
    calc.round2(sums.weg),
    calc.round2(sums.urlaub),
    calc.round2(sums.za_plus),
    calc.round2(sums.za_minus),
    calc.round2(sums.krank),
    calc.round2(sums.day_sum),
    '',
  ]);

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cellXml(val, ref) {
    if (val === '' || val === null || val === undefined) {
      return `<c r="${ref}"/>`;
    }
    if (typeof val === 'number') {
      return `<c r="${ref}"><v>${val}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t>${esc(val)}</t></is></c>`;
  }

  function colLetter(idx) {
    let n = idx;
    let s = '';
    while (n >= 0) {
      s = String.fromCharCode((n % 26) + 65) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  let sheetRows = '';
  rows.forEach((row, rIdx) => {
    const r = rIdx + 1;
    let cells = '';
    row.forEach((val, cIdx) => {
      cells += cellXml(val, `${colLetter(cIdx)}${r}`);
    });
    sheetRows += `<row r="${r}">${cells}</row>`;
  });

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Zeitschreibung" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', relsXml);
  zip.file('xl/workbook.xml', workbookXml);
  zip.file('xl/_rels/workbook.xml.rels', wbRelsXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generateZeitschreibungXlsxBuffer };
