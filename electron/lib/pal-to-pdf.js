'use strict';

/**
 * PAL (DWC-6 / IdPa→PAL): KUKLink-V2.0-Listenausdruck
 * (Logo links, grüner Kopf, rote Parametergruppen, ParID / Bezeichnung / Wert / Einheit).
 */

const fs = require('fs');
const path = require('path');
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
  const s = String(value || '');
  if (/^\d+\.\d+$/.test(s)) return s.replace('.', ',');
  return s;
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

async function embedKuklaLogo(pdfDoc) {
  const baseDir = path.join(__dirname, '..');
  const logoPaths = [
    path.join(baseDir, 'public', 'assets', 'img', 'kukla_logo_wordmark.jpg'),
    path.join(baseDir, 'public', 'assets', 'img', 'kukla_logo_claim_green.png'),
    path.join(baseDir, '..', '..', 'dispo', 'assets', 'img', 'kukla_logo_claim_green.png'),
    path.join(baseDir, '..', '..', 'dispo', 'assets', 'img', 'kukla_logo.png'),
    path.join(baseDir, 'public', 'assets', 'img', 'kukla_logo.jpg'),
    path.join(baseDir, '..', '..', 'dispo', 'assets', 'img', 'kukla_logo.jpg'),
  ];
  for (const logoPath of logoPaths) {
    try {
      if (!fs.existsSync(logoPath)) continue;
      const bytes = fs.readFileSync(logoPath);
      if (/\.png$/i.test(logoPath)) return await pdfDoc.embedPng(bytes);
      return await pdfDoc.embedJpg(bytes);
    } catch (_) {
      /* next */
    }
  }
  return null;
}

async function palToPdfBuffer(text, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const rows = parsePalRows(text);
  const filename = (options && options.filename) || '';
  const sourcePath = String((options && (options.sourcePath || options.source_path)) || filename || 'parameter.pal');
  const fab = extractFab(rows, filename || sourcePath);
  const dateStr = formatDeDateTime((options && options.now) || new Date());

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const headerGreen = rgb(0, 64 / 255, 0);
  const groupRed = rgb(192 / 255, 0, 0);
  const logo = await embedKuklaLogo(pdfDoc);

  const pageW = 595;
  const pageH = 842;
  const tableLeft = 57;
  const tableRight = 465;
  const fontSize = 8;
  const lineHeight = 14.8;
  const contentBottom = 28;
  // Seite 1 der KUKLink-V2.0-Vorlage: Spaltenkopf + 7 Gruppen + Parameter bis 471
  const maxRowsPerPage = 37;

  const items = buildItems(rows);
  const pages = [];
  let buf = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const isColHead = items[i] && items[i].type === 'colhead';
    if (!isColHead && used + 1 > maxRowsPerPage && buf.length > 0) {
      pages.push(buf);
      buf = [];
      used = 0;
    }
    buf.push(items[i]);
    used += 1;
  }
  if (buf.length) pages.push(buf);
  if (pages.length === 0) pages.push([]);
  const totalPages = pages.length;

  function drawHLine(page, y) {
    page.drawLine({
      start: { x: tableLeft, y },
      end: { x: tableRight, y },
      thickness: 0.5,
      color: black,
    });
  }

  function drawHeader(page) {
    const yTop = pageH - 55;
    let logoH = 0;
    if (logo) {
      const maxLogoW = 102;
      const maxLogoH = 61;
      const scale = Math.min(maxLogoW / logo.width, maxLogoH / logo.height);
      const logoW = logo.width * scale;
      logoH = logo.height * scale;
      page.drawImage(logo, {
        x: tableLeft,
        y: yTop - logoH,
        width: logoW,
        height: logoH,
      });
    }
    const headerLines = [
      'KUKLink V2.0 - www.kukla.co.at',
      'Parameter Ausdruck: ' + (fab ? 'FN_' + fab : sourcePath),
      'Fabriknummer: ' + (fab || ''),
      dateStr,
    ];
    let yText = yTop - 10;
    for (const line of headerLines) {
      page.drawText(sanitizeForWinAnsi(line), {
        x: 170,
        y: yText,
        size: fontSize,
        font: fontBold,
        color: headerGreen,
      });
      yText -= 14.2;
    }
    return Math.min(yTop - logoH, yText) - 4;
  }

  function drawPageNum(page, pageNum) {
    const label = '- ' + pageNum + ' -';
    const w = font.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x: (pageW - w) / 2,
      y: 18,
      size: fontSize,
      font,
      color: black,
    });
  }

  const colX = {
    parId: tableLeft,
    name: 75,
    value: 240,
    unit: 305,
  };

  function drawColHead(page, y) {
    drawHLine(page, y + fontSize + 4);
    page.drawText('ParID', { x: colX.parId, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Bezeichnung', { x: 94, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Wert', { x: colX.value, y, size: fontSize, font: fontBold, color: black });
    page.drawText('Einheit', { x: 299, y, size: fontSize, font: fontBold, color: black });
    drawHLine(page, y - 3);
    return y - lineHeight;
  }

  function drawGroup(page, y, text) {
    page.drawText(sanitizeForWinAnsi(text), {
      x: tableLeft,
      y,
      size: fontSize,
      font: fontBold,
      color: groupRed,
    });
    drawHLine(page, y - 3);
    return y - lineHeight;
  }

  function drawParam(page, y, row) {
    page.drawText(sanitizeForWinAnsi(String(row.parId)), {
      x: colX.parId,
      y,
      size: fontSize,
      font,
      color: black,
    });
    page.drawText(sanitizeForWinAnsi(row.name).slice(0, 42), {
      x: colX.name,
      y,
      size: fontSize,
      font,
      color: black,
    });
    page.drawText(sanitizeForWinAnsi(row.value).slice(0, 28), {
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
    const pageItems = pages[p].filter((item) => !(pageNum > 1 && item.type === 'colhead'));
    if (pageNum > 1) {
      drawHLine(page, y + fontSize + 4);
    }
    for (const item of pageItems) {
      if (y < contentBottom + lineHeight) break;
      if (item.type === 'colhead') y = drawColHead(page, y);
      else if (item.type === 'group') y = drawGroup(page, y, item.text);
      else if (item.type === 'param') y = drawParam(page, y, item.row);
    }
    drawPageNum(page, pageNum);
  }

  return await pdfDoc.save();
}

module.exports = {
  palToPdfBuffer,
  isPalDwc6Format,
  dwc6GroupForParId,
};
