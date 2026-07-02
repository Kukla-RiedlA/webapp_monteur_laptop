'use strict';

const path = require('path');
const fs = require('fs');

async function embedLogo(pdfDoc) {
  const { rgb } = require('pdf-lib');
  const baseDir = path.join(__dirname, '..');
  const logoPaths = [
    path.join(baseDir, '..', '..', 'dispo', 'assets', 'img', 'kukla_logo_claim_green.png'),
    path.join(baseDir, '..', 'dispo', 'assets', 'img', 'kukla_logo_claim_green.png'),
    path.join(baseDir, 'public', 'assets', 'img', 'kukla_logo.jpg'),
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

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function drawWrappedText(page, font, text, x, y, maxWidth, size, lineHeight) {
  const raw = String(text || '').replace(/\r/g, '');
  const chunks = raw.split('\n');
  let cy = y;
  for (const chunk of chunks) {
    const words = chunk.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      const w = font.widthOfTextAtSize(test, size);
      if (w > maxWidth && line) {
        page.drawText(line, { x, y: cy, size, font });
        cy -= lineHeight;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      page.drawText(line, { x, y: cy, size, font });
      cy -= lineHeight;
    }
  }
  return cy;
}

function stepStatusLabel(status, lang) {
  const st = String(status || 'na').toLowerCase();
  if (st === 'ok') return lang === 'en' ? 'OK' : 'OK';
  if (st === 'nok') return lang === 'en' ? 'n.i.O.' : 'n.i.O.';
  return lang === 'en' ? 'n.a.' : 'n.a.';
}

function abschlussStatusLabel(abschluss, lang) {
  const st = String((abschluss && abschluss.status) || '').toLowerCase();
  if (st === 'geprueft' || st === 'geprüft') return lang === 'en' ? 'Checked' : 'Geprüft';
  if (st === 'nicht_geprueft') return lang === 'en' ? 'Not checked' : 'Nicht geprüft';
  return st || '';
}

function formatMesswerteLines(mess, lang) {
  const m = mess && typeof mess === 'object' ? mess : {};
  const lines = [];
  const de = lang !== 'en';
  if (m.waegezelle_type) lines.push([(de ? 'Wägezelle Typ' : 'Load cell type'), m.waegezelle_type]);
  if (m.waegezelle_seriennummer) lines.push([(de ? 'Seriennummer' : 'Serial no.'), m.waegezelle_seriennummer]);
  if (m.vers_spannung) lines.push([(de ? 'Versorgungsspannung' : 'Supply voltage'), m.vers_spannung]);
  const pg = m.pruefgewichtstest;
  if (pg && typeof pg === 'object') {
    Object.keys(pg).forEach((k) => {
      const v = pg[k];
      if (v != null && String(v).trim() !== '') lines.push([k, v]);
    });
  }
  return lines;
}

/**
 * Offline-Serviceprotokoll-PDF (pdf-lib, inhaltlich an Formular angeglichen).
 */
async function generateServiceprotokollPdfBuffer(payload, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([595, 842]);
  const margin = 40;
  const bottom = 50;
  let y = 800;
  const green = rgb(0, 0.38, 0.24);

  function ensureSpace(need) {
    if (y - need >= bottom) return;
    page = pdfDoc.addPage([595, 842]);
    y = 800;
  }

  const logo = await embedLogo(pdfDoc);
  if (logo) {
    const dims = logo.scale(0.25);
    page.drawImage(logo, { x: margin, y: y - 20, width: dims.width, height: dims.height });
  }

  const title = lang === 'en' ? 'Service protocol' : 'Serviceprotokoll';
  page.drawText(title, { x: 200, y, size: 16, font: fontBold, color: green });
  y -= 28;

  const head = [
    [lang === 'en' ? 'Project' : 'Projekt', payload.projekt || ''],
    [lang === 'en' ? 'Fabrication no.' : 'Fabrikationsnummer', payload.fabrikationsnummer || ''],
    [lang === 'en' ? 'Date' : 'Durchführungsdatum', payload.durchfuehrungsdatum || ''],
    [lang === 'en' ? 'Position' : 'Position', payload.kopf_pos_nr || ''],
    [lang === 'en' ? 'Qmax' : 'Qmax', payload.kopf_qmax || ''],
    [lang === 'en' ? 'Type' : 'Type', payload.kopf_type || ''],
    ['DWC', payload.kopf_dwc || ''],
  ];
  for (const [label, val] of head) {
    if (!String(val || '').trim()) continue;
    ensureSpace(16);
    page.drawText(label + ':', { x: margin, y, size: 10, font: fontBold });
    page.drawText(String(val), { x: margin + 130, y, size: 10, font });
    y -= 16;
  }
  y -= 8;

  ensureSpace(24);
  page.drawText(lang === 'en' ? 'Work steps' : 'Arbeitsschritte', { x: margin, y, size: 11, font: fontBold, color: green });
  y -= 18;
  const steps = Array.isArray(payload.arbeitsschritte) ? payload.arbeitsschritte : [];
  steps.forEach((s, idx) => {
    const label =
      lang === 'en'
        ? String(s.bezeichnung_en || s.bezeichnung || '').trim()
        : String(s.bezeichnung_de != null ? s.bezeichnung_de : s.bezeichnung || '').trim();
    if (!label) return;
    const status = stepStatusLabel(s.status, lang);
    const bem = stripHtml(s.bemerkung || '');
    ensureSpace(28);
    const prefix = (idx + 1) + '. [' + status + '] ';
    y = drawWrappedText(page, font, prefix + label, margin, y, 515, 9, 12);
    if (bem) {
      y = drawWrappedText(page, font, '   ' + (lang === 'en' ? 'Note: ' : 'Bem.: ') + bem, margin + 8, y, 505, 8, 11);
    }
    y -= 4;
  });

  const messLines = formatMesswerteLines(payload.messwerte, lang);
  if (messLines.length) {
    y -= 8;
    ensureSpace(24);
    page.drawText(lang === 'en' ? 'Measured values' : 'Messwerte', { x: margin, y, size: 11, font: fontBold, color: green });
    y -= 16;
    for (const [k, v] of messLines) {
      ensureSpace(14);
      page.drawText(k + ':', { x: margin, y, size: 9, font: fontBold });
      page.drawText(String(v), { x: margin + 120, y, size: 9, font });
      y -= 13;
    }
  }

  y -= 8;
  ensureSpace(24);
  page.drawText(lang === 'en' ? 'Remarks' : 'Bemerkungen', { x: margin, y, size: 11, font: fontBold, color: green });
  y -= 16;
  y = drawWrappedText(page, font, stripHtml(payload.bemerkungen || ''), margin, y, 515, 9, 12);

  const abschluss = payload.abschluss && typeof payload.abschluss === 'object' ? payload.abschluss : {};
  const absLines = [
    abschlussStatusLabel(abschluss, lang),
    abschluss.monteur_name || '',
    abschluss.datum || '',
    stripHtml(abschluss.bemerkungen || ''),
  ].filter(Boolean);
  if (absLines.length) {
    y -= 16;
    ensureSpace(24);
    page.drawText(lang === 'en' ? 'Completion' : 'Abschluss', { x: margin, y, size: 11, font: fontBold, color: green });
    y -= 16;
    for (const line of absLines) {
      ensureSpace(14);
      y = drawWrappedText(page, font, line, margin, y, 515, 9, 12);
    }
  }

  page.drawText('KUKLA', { x: margin, y: 30, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
  return Buffer.from(await pdfDoc.save());
}

async function generateKontrollwiegungPdfBuffer(payload) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([595, 842]);
  const margin = 40;
  let y = 800;
  const green = rgb(0, 0.38, 0.24);

  page.drawText('Kontrollwiegungsprotokoll', { x: margin, y, size: 16, font: fontBold, color: green });
  y -= 24;
  const head = [
    ['Fabrikationsnummer', payload.fabrikationsnummer],
    ['Datum', payload.durchfuehrungsdatum],
    ['Auftrag', payload.job_id != null ? String(payload.job_id) : ''],
  ];
  for (const [k, v] of head) {
    page.drawText(k + ':', { x: margin, y, size: 10, font: fontBold });
    page.drawText(String(v || ''), { x: margin + 130, y, size: 10, font });
    y -= 14;
  }
  y -= 10;
  const rows = Array.isArray(payload.wiegungen) ? payload.wiegungen : [];
  rows.forEach((row, i) => {
    page.drawText('Wiegung ' + (i + 1), { x: margin, y, size: 10, font: fontBold });
    y -= 14;
    const parts = Object.entries(row || {})
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => k + ': ' + v);
    y = drawWrappedText(page, font, parts.join(' | '), margin + 10, y, 500, 9, 12);
    y -= 6;
  });
  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  generateServiceprotokollPdfBuffer,
  generateKontrollwiegungPdfBuffer,
};
