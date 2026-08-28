'use strict';

/**
 * PAL (DWC-6): Semikolon-Liste ParID; Bezeichnung; Wert; Einheit; Min; Max
 * → KUKLink-V2.0-Listenausdruck (ParID / Bezeichnung / Wert / Einheit, Parametergruppen).
 */

const { sanitizeForWinAnsi } = require('./pdf-winansi');

function isPalDwc6Format(text, filename) {
  if (/\.pal$/i.test(String(filename || ''))) return true;
  const lines = String(text || '')
    .split(/\r\n|\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  let considered = 0;
  let hits = 0;
  for (const line of lines) {
    if (line.indexOf(';') < 0) continue;
    considered += 1;
    const parts = splitPalFields(line);
    if (/^\d+$/.test(parts[0] || '') && parts.length >= 4) hits += 1;
  }
  return considered >= 3 && hits >= 3 && hits / considered >= 0.5;
}

function splitPalFields(line) {
  const parts = String(line || '').split(';').map((p) => p.trim());
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function dwc6GroupForParId(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  if (n >= 100 && n <= 119) return 'Parametergruppe Nenndaten';
  if (n >= 120 && n <= 134) return 'Parametergruppe Grenzwerte';
  if (n >= 135 && n <= 199) return 'Parametergruppe Einteilung / Zähler / Test';
  if (n >= 200 && n <= 399) return 'Parametergruppe Wiegekanaleinstellung';
  if (n >= 400 && n <= 419) return 'Digitale Eingänge';
  if (n >= 420 && n <= 459) return 'Digitale Ausgänge';
  if (n >= 460 && n <= 521) return 'Analoge Ausgänge';
  if (n >= 522 && n <= 699) return 'Parametergruppe Simulation';
  if (n >= 700 && n <= 998) return 'Bus';
  if (n === 999) return 'Checksum';
  return null;
}

function germanizeValue(value) {
  return String(value || '').replace(/\./g, ',');
}

function parsePalRows(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/);
  const rows = [];
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.indexOf(';') < 0) continue;
    const parts = splitPalFields(line);
    if (!/^\d+$/.test(parts[0] || '') || parts.length < 3) continue;
    rows.push({
      parId: parseInt(parts[0], 10),
      name: parts[1] || '',
      value: germanizeValue(parts[2] || ''),
      unit: parts[3] || '',
    });
  }
  return rows;
}

function extractFab(rows, filename) {
  const fabRow = rows.find((r) => r.parId === 110 || /^fabriknummer$/i.test(r.name));
  if (fabRow && /^\d+$/.test(String(fabRow.value).replace(/,/g, ''))) {
    return String(fabRow.value).replace(/,/g, '');
  }
  const fromName = String(filename || '').match(/\b(\d{3,6})\b/);
  return fromName ? fromName[1] : '';
}

function formatDeDateTime(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return dd + '.' + mm + '.' + yyyy + ' ' + hh + ':' + mi;
}

function buildItems(rows) {
  const items = [{ type: 'colhead' }];
  let lastGroup = null;
  for (const row of rows) {
    const group = dwc6GroupForParId(row.parId);
    if (group && group !== lastGroup) {
      items.push({ type: 'group', text: group });
      lastGroup = group;
    }
    items.push({ type: 'param', row });
  }
  return items;
}

async function palToPdfBuffer(text, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const rows = parsePalRows(text);
  const filename = (options && options.filename) || '';
  const sourcePath = String((options && (options.sourcePath || options.source_path)) || filename || 'parameter.pal');
  const fab = extractFab(rows, filename || sourcePath);
  const dateStr = formatDeDateTime((options && options.now) || new Date());

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const fontBold = await pdfDoc.embedFont(StandardFonts.CourierBold);
  const black = rgb(0, 0, 0);
  const pageW = 595;
  const pageH = 842;
  const margin = 36;
  const fontSize = 9;
  const lineHeight = 12;
  const headerLines = 5;
  const headerHeight = headerLines * lineHeight + 8;
  const footerHeight = 22;
  const contentTop = pageH - margin - headerHeight;
  const contentBottom = margin + footerHeight;
  const maxRowsPerPage = Math.max(8, Math.floor((contentTop - contentBottom) / lineHeight));

  function itemSlots(item) {
    return item && item.type === 'group' ? 2 : 1;
  }

  const items = buildItems(rows);
  const pages = [];
  let buf = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const slots = itemSlots(items[i]);
    if (used + slots > maxRowsPerPage && buf.length > 0) {
      pages.push(buf);
      buf = [];
      used = 0;
    }
    buf.push(items[i]);
    used += slots;
  }
  if (buf.length) pages.push(buf);
  if (pages.length === 0) pages.push([]);
  const totalPages = pages.length;

  function drawHLine(page, y) {
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageW - margin, y },
      thickness: 0.6,
      color: black,
    });
  }

  function drawHeader(page) {
    let y = pageH - margin - fontSize;
    const lines = [
      { text: 'KUKLink V2.0 - www.kukla.co.at', bold: true },
      { text: 'Parameter Ausdruck: ' + sourcePath, bold: false },
      { text: 'Fabriknummer: ' + (fab || ''), bold: false },
      { text: dateStr, bold: false },
    ];
    for (const line of lines) {
      const t = sanitizeForWinAnsi(line.text);
      page.drawText(t, {
        x: margin,
        y,
        size: fontSize,
        font: line.bold ? fontBold : font,
        color: black,
      });
      y -= lineHeight;
    }
    drawHLine(page, y + 4);
    return y - 4;
  }

  function drawPageNum(page, pageNum, y) {
    const label = '- ' + pageNum + ' -';
    const w = font.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x: (pageW - w) / 2,
      y,
      size: fontSize,
      font,
      color: black,
    });
  }

  const colX = {
    parId: margin,
    name: margin + 36,
    value: margin + 250,
    unit: margin + 370,
  };

  function drawColHead(page, y) {
    page.drawText('ParID', { x: colX.parId, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Bezeichnung', { x: colX.name, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Wert', { x: colX.value, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Einheit', { x: colX.unit, y, size: fontSize, font: fontBold, color: black });
    drawHLine(page, y - 3);
    return y - lineHeight;
  }

  function drawGroup(page, y, text) {
    page.drawText(sanitizeForWinAnsi(text), { x: margin, y, size: fontSize, font: fontBold, color: black });
    y -= lineHeight;
    drawHLine(page, y + fontSize * 0.45);
    return y - 2;
  }

  function drawParam(page, y, row) {
    page.drawText(sanitizeForWinAnsi(String(row.parId)), {
      x: colX.parId,
      y,
      size: fontSize,
      font,
      color: black,
    });
    page.drawText(sanitizeForWinAnsi(row.name).slice(0, 36), {
      x: colX.name,
      y,
      size: fontSize,
      font,
      color: black,
    });
    page.drawText(sanitizeForWinAnsi(row.value).slice(0, 22), {
      x: colX.value,
      y,
      size: fontSize,
      font,
      color: black,
    });
    if (row.unit) {
      page.drawText(sanitizeForWinAnsi(row.unit).slice(0, 16), {
        x: colX.unit,
        y,
        size: fontSize,
        font,
        color: black,
      });
    }
    drawHLine(page, y - 3);
    return y - lineHeight;
  }

  for (let p = 0; p < totalPages; p++) {
    const page = pdfDoc.addPage([pageW, pageH]);
    const pageNum = p + 1;
    let y = drawHeader(page);
    if (pageNum > 1) {
      y -= 4;
      drawPageNum(page, pageNum, y);
      y -= lineHeight;
      drawHLine(page, y + 6);
      y -= 4;
    }
    const pageItems = pages[p];
    for (const item of pageItems) {
      if (y < contentBottom + lineHeight) break;
      if (item.type === 'colhead') y = drawColHead(page, y);
      else if (item.type === 'group') y = drawGroup(page, y, item.text);
      else if (item.type === 'param') y = drawParam(page, y, item.row);
    }
    if (pageNum === 1) {
      drawPageNum(page, pageNum, margin);
    }
  }

  return await pdfDoc.save();
}

module.exports = {
  palToPdfBuffer,
  isPalDwc6Format,
  dwc6GroupForParId,
};
