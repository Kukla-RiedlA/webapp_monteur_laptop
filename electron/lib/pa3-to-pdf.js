'use strict';

/**
 * PA3 (DWC-5 / DWC-3): fertiger Zweispalt-Bildschirmausdruck
 * → Courier-PDF Seite für Seite (Form-Feed), Layout bleibt erhalten.
 */

const { sanitizeForWinAnsi } = require('./pdf-winansi');

function isPa3DumpFormat(text, filename) {
  const name = String(filename || '');
  if (/\.pa3$/i.test(name)) return true;
  const src = String(text || '');
  if (/WAAGENFABRIK\s+KUKLA/i.test(src) && /Parameterausdruck/i.test(src)) return true;
  if (/<NENNDATEN/i.test(src) && /--\*--\*{8,}--\*--/.test(src)) return true;
  if (/\.pa[45]$/i.test(name) && /WAAGENFABRIK\s+KUKLA/i.test(src) && /Parameterausdruck/i.test(src)) {
    return true;
  }
  return false;
}

function splitPa3Pages(text) {
  const raw = String(text || '').replace(/\u000c/g, '\f');
  let parts = raw.split('\f').map((p) =>
    String(p || '')
      .replace(/\s+$/g, '')
      .replace(/^\r?\n+/, '')
  );
  parts = parts.filter((p) => String(p).replace(/\s+/g, '').length > 0);
  if (parts.length === 0) parts = [String(text || '')];
  return parts;
}

function pageLines(pageText) {
  return String(pageText || '')
    .replace(/\t/g, ' ')
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/[ \t]+$/g, ''));
}

async function pa3ToPdfBuffer(text, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pagesText = splitPa3Pages(text);
  const lineSets = pagesText.map(pageLines);
  const maxLines = Math.max(1, ...lineSets.map((ls) => ls.length));
  const maxChars = Math.max(
    1,
    ...lineSets.map((ls) => Math.max(1, ...ls.map((l) => String(l || '').length)))
  );

  const pageW = 595;
  const pageH = 842;
  const marginX = 22;
  const marginY = 18;
  const usableW = pageW - marginX * 2;
  const usableH = pageH - marginY * 2;

  let fontSize = 8;
  const courierChar = 0.6;
  const sizeByWidth = usableW / (maxChars * courierChar);
  const sizeByHeight = usableH / maxLines;
  fontSize = Math.max(5.5, Math.min(9, sizeByWidth, sizeByHeight * 0.92));
  const lineHeight = Math.min(fontSize + 2.2, usableH / maxLines);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const black = rgb(0, 0, 0);

  for (const lines of lineSets) {
    const page = pdfDoc.addPage([pageW, pageH]);
    let y = pageH - marginY - fontSize;
    for (const line of lines) {
      if (y < marginY) break;
      const t = sanitizeForWinAnsi(line);
      if (t.length) {
        page.drawText(t, { x: marginX, y, size: fontSize, font, color: black });
      }
      y -= lineHeight;
    }
  }

  return await pdfDoc.save();
}

module.exports = {
  pa3ToPdfBuffer,
  isPa3DumpFormat,
};
