'use strict';

/**
 * CSV (Semikolon-getrennt) in PDF-Tabelle umwandeln (pdf-lib).
 * Layout wie Referenz-PDF: Logo links, DWC-7/Printout Mitte, Adresse rechts,
 * Zeile "Parameter", Tabelle mit Name/Value/Unit/Comment, Fußzeile Seite x/y.
 * Für Verwendung in server.js und in test-parameter-pdf.js.
 */

const path = require('path');
const fs = require('fs');

async function csvToPdfBuffer(csvText, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  // Nur Semikolon trennt Spalten; Komma (z. B. in 0,0) ist kein Trennzeichen.
  const delimiter = ';';
  const lines = (csvText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rows = lines.map((line) => {
    const parts = [];
    let inQuote = false;
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === delimiter && !inQuote) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur.trim());
    return parts;
  });
  // Nach abschließendem Semikolon entstehen leere Zellen (z. B. "...;10.0.1.39;" → 5 Teile). Leere Endzellen entfernen.
  for (let r = 0; r < rows.length; r++) {
    while (rows[r].length > 0 && String(rows[r][rows[r].length - 1]).trim() === '') {
      rows[r].pop();
    }
  }
  if (rows.length === 0) rows.push(['(leer)']);

  let headerRowIndex = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.length >= 4 && /^name$/i.test(String(row[0]).trim()) && /^value$/i.test(String(row[1]).trim()) && /^unit$/i.test(String(row[2]).trim()) && /^comment$/i.test(String(row[3]).trim())) {
      headerRowIndex = r;
      break;
    }
  }
  if (headerRowIndex >= 0) rows.splice(0, headerRowIndex);

  // Parameter-PDF hat immer genau 4 Spalten: Name, Value, Unit, Comment
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length > 4) rows[r] = rows[r].slice(0, 4);
    while (rows[r].length < 4) rows[r].push('');
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const margin = 40;
  const tableMargin = margin;
  const headerHeight = 52;
  const footerHeight = 24;
  const contentTop = 842 - margin - headerHeight;
  const contentBottom = margin + footerHeight;
  const contentHeight = contentTop - contentBottom;
  const fontSize = 9;
  const lineHeight = 12;
  const maxRowsPerPage = Math.max(1, Math.floor(contentHeight / lineHeight));
  const totalPages = Math.ceil(rows.length / maxRowsPerPage);
  const pageWidth = 595 - tableMargin * 2;
  const tableRightEdge = tableMargin + pageWidth;
  if (typeof process !== 'undefined' && process.env.PARAMETER_PDF_DEBUG === '1') {
    console.log('[Parameter-PDF] Tabelle: linke Kante', tableMargin, 'pt, Breite', pageWidth, 'pt, rechte Kante', tableRightEdge, 'pt (Seite 595 pt)');
  }
  const numCols = 4;
  const COL_GAP = 8;
  const totalGap = (numCols - 1) * COL_GAP;
  const contentWidth = pageWidth - totalGap;
  const COL_PROPORTIONS_4 = [0.38, 0.12, 0.25, 0.25];
  const colWidths = COL_PROPORTIONS_4.map((p) => contentWidth * p);
  const colMaxChars = [120, 40, 48, 48];

  let logoImage = null;
  const baseDir = path.join(__dirname, '..');
  const logoPaths = [
    path.join(baseDir, '..', 'dispo', 'assets', 'img', 'kukla_logo.jpg'),
    path.join(baseDir, 'public', 'assets', 'img', 'kukla_logo.jpg'),
  ];
  for (const logoPath of logoPaths) {
    try {
      if (fs.existsSync(logoPath)) {
        const logoBytes = fs.readFileSync(logoPath);
        logoImage = await pdfDoc.embedJpg(logoBytes);
        break;
      }
    } catch (e) {
      // nächstes Logo versuchen
    }
  }

  const green = rgb(0, 0.38, 0.24);

  // Header-Titel aus Dateinamen: PA7 → DWC-7, PA8 → DWC-8, KSW7 → KSW-7
  function headerTitleFromFilename(filename) {
    const name = (filename != null && filename !== '') ? String(filename).toUpperCase() : '';
    const pa = name.match(/PA(\d+)/);
    if (pa) return 'DWC-' + pa[1];
    const ksw = name.match(/KSW(\d+)/);
    if (ksw) return 'KSW-' + ksw[1];
    return 'DWC-7';
  }
  const headerTitle = headerTitleFromFilename(options && options.filename);

  function drawHeader(p, pageNum) {
    const yStart = 842 - margin;
    const pageCenterX = 595 / 2;
    const rightEdge = 595 - margin;

    // Vorlage: Oberkanten von Logo, DWC-7 und erster Adresszeile horizontal bündig
    const row1Baseline = yStart - 14;   // DWC-7 (14 pt) → Oberkante = yStart
    const addrSize = 9;
    const row1AddrBaseline = yStart - addrSize; // Adresse Zeile 1 → Oberkante = yStart

    // —— Links: nur Logo (Oberkante = yStart), kein Firmenname ——
    let yLeft = yStart;
    if (logoImage) {
      const maxLogoW = 90;
      const maxLogoH = 32;
      const scale = Math.min(maxLogoW / logoImage.width, maxLogoH / logoImage.height);
      const logoW = logoImage.width * scale;
      const logoH = logoImage.height * scale;
      p.drawImage(logoImage, { x: margin, y: yStart - logoH, width: logoW, height: logoH });
      yLeft = yStart - logoH - 6;
    } else {
      yLeft = yStart - 6;
    }

    // —— Mitte: Titel aus Dateinamen (z. B. DWC-7, DWC-8, KSW-7), darunter Printout ——
    const titleW = fontBold.widthOfTextAtSize(headerTitle, 14);
    const printW = font.widthOfTextAtSize('Printout', 10);
    p.drawText(headerTitle, { x: pageCenterX - titleW / 2, y: row1Baseline, size: 14, font: fontBold, color: green });
    p.drawText('Printout', { x: pageCenterX - printW / 2, y: row1Baseline - 16, size: 10, font, color: green });

    // —— Rechts: 3 Zeilen Adresse, erste Zeile Oberkante = yStart (wie Vorlage) ——
    const addrLines = [
      'KUKLA WAAGENFABRIK GmbH Co KG',
      'Stefan-Fadinger-Str. 1 - 11',
      '4840 Vöcklabruck / AUSTRIA',
    ];
    let yRight = row1AddrBaseline;
    for (const line of addrLines) {
      const w = font.widthOfTextAtSize(line, addrSize);
      p.drawText(line, { x: rightEdge - w, y: yRight, size: addrSize, font, color: green });
      yRight -= 12;
    }
  }

  function drawFooter(p, pageNum) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const footerSize = 8;
    const footerText = 'Seite ' + pageNum + ' / ' + totalPages + '  ' + dateStr + ' ' + timeStr;
    p.drawText(footerText, { x: margin, y: margin, size: footerSize, font });
  }

  function sanitizeForWinAnsi(s) {
    return (
      s
        .replace(/\0/g, '')
        .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/\uFFFD/g, '')
        .replace(/\u2013/g, '-')
        .replace(/\u2014/g, '-')
        .replace(/\u2018|\u2019/g, "'")
        .replace(/\u201C|\u201D/g, '"')
        .replace(/\u00B0/g, '\u00B0')
        .replace(/[\u0160\u0161]/g, 's')
        .replace(/[\u010C\u010D\u0106\u0107]/g, 'c')
        .replace(/[\u017D\u017E]/g, 'z')
        .replace(/\u0111/g, 'd')
        .replace(/\u0141/g, 'L')
        .replace(/\u0142/g, 'l')
        .replace(/\u0152/g, 'O')
        .replace(/\u0153/g, 'o')
        .replace(/\u20AC/g, 'EUR')
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
    );
  }

  let page = pdfDoc.addPage([595, 842]);
  let pageNum = 1;
  drawHeader(page, pageNum);
  drawFooter(page, pageNum);

  let y = contentTop;
  let rowIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rowIndex >= maxRowsPerPage) {
      page = pdfDoc.addPage([595, 842]);
      pageNum++;
      drawHeader(page, pageNum);
      drawFooter(page, pageNum);
      y = contentTop;
      rowIndex = 0;
    }
    const row = rows[i];
    let xOffset = tableMargin;
    const cellPadding = 2;
    for (let col = 0; col < numCols; col++) {
      const maxChars = (colMaxChars[col] != null) ? colMaxChars[col] : 50;
      const cellText = sanitizeForWinAnsi((row[col] != null ? String(row[col]) : '').slice(0, maxChars));
      const textW = font.widthOfTextAtSize(cellText, fontSize);
      const cellW = colWidths[col];
      const x = col === 1 ? xOffset + cellW - cellPadding - textW : xOffset + cellPadding;
      page.drawText(cellText, { x, y: y - fontSize, size: fontSize, font });
      xOffset += cellW + (col < numCols - 1 ? COL_GAP : 0);
    }
    y -= lineHeight;
    rowIndex++;
  }

  return await pdfDoc.save();
}

if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  console.log('[Parameter-PDF] Modul geladen, Spalten: Name 38%, Value 12%, Unit 25%, Comment 25%');
}
module.exports = { csvToPdfBuffer };
