'use strict';

const path = require('path');
const fs = require('fs');

async function embedLogo(pdfDoc) {
  const baseDir = path.join(__dirname, '..');
  // PNG mit Transparenz zuerst (kein schwarzer/weißer Kasten im PDF)
  const logoPaths = [
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

/**
 * PNG/JPEG Base64 (roh oder data-URL) für pdf-lib einbetten.
 */
async function embedSignatureImage(pdfDoc, pngBase64) {
  const raw = String(pngBase64 || '').trim();
  if (!raw) return null;
  let b64 = raw.replace(/^data:image\/(png|jpe?g);base64,/i, '').replace(/\s+/g, '');
  if (!b64) return null;
  let bytes;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch (_) {
    return null;
  }
  if (!bytes || bytes.length < 32) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  try {
    if (isPng) return await pdfDoc.embedPng(bytes);
    if (isJpg) return await pdfDoc.embedJpg(bytes);
  } catch (_) {
    /* sharp fallback */
  }
  try {
    const sharp = require('sharp');
    const png = await sharp(bytes).rotate().png().toBuffer();
    return await pdfDoc.embedPng(png);
  } catch (_) {
    return null;
  }
}

/**
 * Zeichnet Unterschrift + optionales Label. y = Oberkante; Rückgabe = y darunter.
 */
async function drawTechnicianSignatureAt(pdfDoc, page, opts) {
  const pngBase64 = opts && opts.pngBase64;
  const img = await embedSignatureImage(pdfDoc, pngBase64);
  if (!img) return opts && opts.y != null ? opts.y : 0;
  const maxW = opts.maxW != null ? opts.maxW : 160;
  const maxH = opts.maxH != null ? opts.maxH : 48;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const iw = img.width * scale;
  const ih = img.height * scale;
  let y = opts.y;
  const x = opts.x != null ? opts.x : 36;
  const font = opts.font;
  const color = opts.color;
  const S = typeof opts.S === 'function' ? opts.S : (t) => String(t == null ? '' : t);
  if (opts.label && font) {
    page.drawText(S(opts.label), {
      x,
      y: y - 10,
      size: opts.labelSize != null ? opts.labelSize : 7,
      font,
      color: opts.mutedColor || color,
    });
    y -= 14;
  }
  page.drawImage(img, { x, y: y - ih, width: iw, height: ih });
  return y - ih - 4;
}

/**
 * Unicode-fähige Schriften (Windows Arial/Calibri), sonst Helvetica.
 * Benötigt @pdf-lib/fontkit für TTF.
 */
async function embedProtocolFonts(pdfDoc) {
  const { StandardFonts } = require('pdf-lib');
  const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const fontsDir = path.join(winDir, 'Fonts');
  const pairs = [
    ['arial.ttf', 'arialbd.ttf'],
    ['calibri.ttf', 'calibrib.ttf'],
    ['segoeui.ttf', 'segoeuib.ttf'],
  ];
  try {
    const fontkit = require('@pdf-lib/fontkit');
    pdfDoc.registerFontkit(fontkit);
    for (const [reg, bold] of pairs) {
      const regPath = path.join(fontsDir, reg);
      const boldPath = path.join(fontsDir, bold);
      if (!fs.existsSync(regPath) || !fs.existsSync(boldPath)) continue;
      try {
        const font = await pdfDoc.embedFont(fs.readFileSync(regPath), { subset: true });
        const fontBold = await pdfDoc.embedFont(fs.readFileSync(boldPath), { subset: true });
        return { font, fontBold, unicode: true };
      } catch (_) {
        /* next pair */
      }
    }
  } catch (_) {
    /* fontkit fehlt oder TTF-Fehler */
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { font, fontBold, unicode: false };
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
  const cells = Array.isArray(m.waegezellen) && m.waegezellen.length
    ? m.waegezellen
    : null;
  if (cells) {
    cells.forEach((wz, i) => {
      if (!wz) return;
      const label = de ? ('Wägezelle ' + (i + 1)) : ('Load cell ' + (i + 1));
      const parts = [
        wz.type || wz.kraftaufnehmer,
        wz.serialNumber || wz.dms_nr,
        wz.position || wz.dms_position,
        (wz.supplyVoltage || wz.vers_spannung) ? String(wz.supplyVoltage || wz.vers_spannung) + ' V' : '',
        (wz.sensitivity || wz.sensitivitaet) ? String(wz.sensitivity || wz.sensitivitaet) + ' mV/V' : '',
      ].filter((x) => x && String(x).trim());
      if (parts.length) lines.push([label, parts.join(' / ')]);
    });
  } else {
    if (m.waegezelle_type) lines.push([(de ? 'Wägezelle Typ' : 'Load cell type'), m.waegezelle_type]);
    if (m.waegezelle_seriennummer) lines.push([(de ? 'Seriennummer' : 'Serial no.'), m.waegezelle_seriennummer]);
    if (m.waegezelle_position) lines.push([(de ? 'Pos.' : 'Pos.'), m.waegezelle_position]);
    if (Array.isArray(m.waegezellen_extra)) {
      m.waegezellen_extra.forEach((ex, i) => {
        if (!ex) return;
        const label = de ? ('Wägezelle ' + (i + 2)) : ('Load cell ' + (i + 2));
        const parts = [
          ex.kraftaufnehmer,
          ex.dms_nr,
          ex.dms_position,
          ex.vers_spannung ? String(ex.vers_spannung) + ' V' : '',
          ex.sensitivitaet ? String(ex.sensitivitaet) + ' mV/V' : '',
        ].filter((x) => x && String(x).trim());
        if (parts.length) lines.push([label, parts.join(' / ')]);
      });
    }
    if (m.vers_spannung) lines.push([(de ? 'Versorgungsspannung V' : 'Supply voltage V'), m.vers_spannung]);
    if (m.sensitivitaet) lines.push([(de ? 'Sensitivität mV/V' : 'Sensitivity mV/V'), m.sensitivitaet]);
  }
  const pgVals = normalizePruefgewichtstestVals(m.pruefgewichtstest);
  pgVals.forEach((v, i) => {
    if (!v) return;
    const label = de
      ? 'Abweichung ' + (i + 1) + ' (%)'
      : 'Deviation ' + (i + 1) + ' (%)';
    lines.push([label, v]);
  });
  return lines;
}

/** Bis zu 4 %-Abweichungen aus Array oder Legacy-Objekt. */
function normalizePruefgewichtstestVals(raw) {
  const out = ['', '', '', ''];
  if (Array.isArray(raw)) {
    for (let i = 0; i < 4; i++) {
      if (raw[i] != null && String(raw[i]).trim() !== '') out[i] = String(raw[i]).trim();
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (let i = 0; i < 4; i++) {
      const v =
        raw[i] != null
          ? raw[i]
          : raw['v' + (i + 1)] != null
            ? raw['v' + (i + 1)]
            : raw['m' + (i + 1)];
      if (v != null && String(v).trim() !== '') out[i] = String(v).trim();
    }
    if (!out.some(Boolean)) {
      const legacy = [
        raw.kg,
        raw.anzeige != null ? raw.anzeige : raw.display,
        raw.abweichung != null ? raw.abweichung : raw.deviation,
        raw.value4 != null ? raw.value4 : raw.wert4,
      ];
      for (let i = 0; i < 4; i++) {
        if (legacy[i] != null && String(legacy[i]).trim() !== '') out[i] = String(legacy[i]).trim();
      }
    }
    return out;
  }
  if (raw != null && String(raw).trim() !== '') out[0] = String(raw).trim();
  return out;
}

/**
 * Zeichnet Prüfgewichtstest als Tabelle wie „Messwerte Wägezelle“:
 * Kopfzeile (dunkelgrün) + Messwertzeile, gleiche Höhen/Spaltenanteile.
 * Returns neue Y-Position (unter dem Block).
 */
function drawPruefgewichtstestRow(page, y, opts) {
  const {
    vals,
    de,
    marginX,
    tableInnerW,
    font,
    fontBold,
    green,
    greenDark,
    greenSoft,
    grayText,
    white,
    S,
    title,
  } = opts;
  const cells = ['', '', '', ''];
  let any = false;
  (vals || []).forEach((v, i) => {
    if (i > 3) return;
    const s = v != null ? String(v).trim() : '';
    if (s) {
      cells[i] = s;
      any = true;
    }
  });
  if (!any) return y;

  const sanitize = typeof S === 'function' ? S : (t) => String(t == null ? '' : t);
  const head = title || (de ? 'Prüfgewichtstest' : 'Test with test load');
  page.drawText(sanitize(head), {
    x: marginX,
    y,
    size: 10,
    font: fontBold,
    color: greenDark,
  });
  y -= 14;

  // Gleiche Aufteilung wie Messpunkt-Tabelle (0.36 + 4×0.16)
  const colW = [
    tableInnerW * 0.36,
    tableInnerW * 0.16,
    tableInnerW * 0.16,
    tableInnerW * 0.16,
    tableInnerW * 0.16,
  ];
  const headers = [
    de ? 'Messpunkt' : 'Point',
    de ? 'Abw. 1 (%)' : 'Dev. 1 (%)',
    de ? 'Abw. 2 (%)' : 'Dev. 2 (%)',
    de ? 'Abw. 3 (%)' : 'Dev. 3 (%)',
    de ? 'Abw. 4 (%)' : 'Dev. 4 (%)',
  ];
  page.drawRectangle({
    x: marginX,
    y: y - 16,
    width: tableInnerW,
    height: 18,
    color: green,
  });
  let hx = marginX;
  headers.forEach((h, i) => {
    page.drawText(sanitize(h), {
      x: hx + 4,
      y: y - 10,
      size: 7.5,
      font: fontBold,
      color: white,
    });
    hx += colW[i];
  });
  y -= 18;

  const rowLabel = de ? 'Prüfgewichtstest' : 'Test with test load';
  const rowCells = [
    rowLabel,
    cells[0] || '–',
    cells[1] || '–',
    cells[2] || '–',
    cells[3] || '–',
  ];
  page.drawRectangle({
    x: marginX,
    y: y - 14,
    width: tableInnerW,
    height: 16,
    color: white,
    borderColor: greenSoft,
    borderWidth: 0.5,
  });
  let cx = marginX;
  rowCells.forEach((cell, i) => {
    page.drawText(sanitize(String(cell)), {
      x: cx + 4,
      y: y - 10,
      size: 8,
      font: i === 0 ? font : fontBold,
      color: grayText,
    });
    cx += colW[i];
  });
  return y - 16 - 10;
}

/**
 * Offline-Serviceprotokoll-PDF – A4 Hochkant, Corporate-Design wie Kontrollwiegung.
 */
async function generateServiceprotokollPdfBuffer(payload, options) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginX = 32;
  const marginTop = 24;
  const marginBottom = 40;
  const green = rgb(14 / 255, 123 / 255, 90 / 255);
  const greenDark = rgb(12 / 255, 106 / 255, 77 / 255);
  const greenSoft = rgb(207 / 255, 232 / 255, 209 / 255);
  const greenHeader = rgb(232 / 255, 244 / 255, 236 / 255);
  const grayText = rgb(0.25, 0.25, 0.25);
  const grayMuted = rgb(0.45, 0.45, 0.45);
  const lineGray = rgb(0.78, 0.82, 0.8);
  const white = rgb(1, 1, 1);
  const tableInnerW = PAGE_W - marginX * 2;

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const stepsRaw = Array.isArray(payload.arbeitsschritte) ? payload.arbeitsschritte : [];
  const steps = stepsRaw
    .map((s) => {
      if (!s) return null;
      const label = de
        ? String(s.bezeichnung_de != null ? s.bezeichnung_de : s.bezeichnung || '').trim()
        : String(s.bezeichnung_en || s.bezeichnung || s.bezeichnung_de || '').trim();
      if (!label) return null;
      return {
        label,
        status: stepStatusLabel(s.status, lang),
        bemerkung: stripHtml(s.bemerkung || ''),
      };
    })
    .filter(Boolean);

  const mess = payload.messwerte && typeof payload.messwerte === 'object' ? payload.messwerte : {};
  function emptyMessCellRow() {
    return { kg: '', mv: '', ma: '', g_prozent: '' };
  }
  function resolveMessMatrix(m) {
    const mm = m.mess_matrix && typeof m.mess_matrix === 'object' ? m.mess_matrix : null;
    if (mm) {
      return {
        dms: Object.assign(emptyMessCellRow(), mm.dms || mm.dms_entlastet || {}),
        tara: Object.assign(emptyMessCellRow(), mm.tara || {}),
        pruefgewicht: Object.assign(emptyMessCellRow(), mm.pruefgewicht || {}),
      };
    }
    return {
      dms: {
        kg: '',
        mv: m.dms_entlastet != null ? String(m.dms_entlastet) : '',
        ma: m.ma != null ? String(m.ma) : '',
        g_prozent: '',
      },
      tara: {
        kg: '',
        mv: m.tara != null ? String(m.tara) : '',
        ma: '',
        g_prozent: m.g_prozent != null ? String(m.g_prozent) : '',
      },
      pruefgewicht: {
        kg: m.kg != null ? String(m.kg) : '',
        mv: m.pruefgewicht != null ? String(m.pruefgewicht) : m.mv != null ? String(m.mv) : '',
        ma: '',
        g_prozent: m.g_prozent != null ? String(m.g_prozent) : '',
      },
    };
  }
  const matrix = resolveMessMatrix(mess);
  const messDefs = [
    { key: 'dms', de: 'DMS entlastet', en: 'Load cell released' },
    { key: 'tara', de: 'Tara', en: 'Tare' },
    { key: 'pruefgewicht', de: 'Pruefgewicht', en: 'Test load' },
  ];

  function matrixToMessRows(mm, forceEmptyRows) {
    const rows = [];
    messDefs.forEach((d) => {
      const r = (mm && mm[d.key]) || emptyMessCellRow();
      const has = ['kg', 'mv', 'ma', 'g_prozent'].some((k) => String(r[k] || '').trim() !== '');
      if (!has && !forceEmptyRows) return;
      rows.push({
        label: de ? d.de : d.en,
        kg: String(r.kg || '').trim(),
        mv: String(r.mv || '').trim(),
        ma: String(r.ma || '').trim(),
        g: String(r.g_prozent || '').trim(),
      });
    });
    if (forceEmptyRows && !rows.some((r) => r.kg || r.mv || r.ma || r.g)) {
      return [];
    }
    return rows;
  }

  function normalizeWaegezelleCell(raw, idx) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const type = String(c.type != null ? c.type : c.kraftaufnehmer || '').trim();
    const serialNumber = String(c.serialNumber != null ? c.serialNumber : c.dms_nr || '').trim();
    const position = String(c.position != null ? c.position : c.dms_position || '').trim();
    const supplyVoltage = String(c.supplyVoltage != null ? c.supplyVoltage : c.vers_spannung || '').trim();
    const sensitivity = String(c.sensitivity != null ? c.sensitivity : c.sensitivitaet || '').trim();
    let mm = null;
    if (c.mess_matrix && typeof c.mess_matrix === 'object') {
      mm = {
        dms: Object.assign(emptyMessCellRow(), c.mess_matrix.dms || {}),
        tara: Object.assign(emptyMessCellRow(), c.mess_matrix.tara || {}),
        pruefgewicht: Object.assign(emptyMessCellRow(), c.mess_matrix.pruefgewicht || {}),
      };
    } else if (idx === 0) {
      mm = resolveMessMatrix(mess);
    } else {
      mm = {
        dms: emptyMessCellRow(),
        tara: emptyMessCellRow(),
        pruefgewicht: emptyMessCellRow(),
      };
    }
    return { type, serialNumber, position, supplyVoltage, sensitivity, matrix: mm };
  }

  /** Pro Wägezelle: Stammdaten + Messwertzeilen (Legacy = eine Zelle). */
  const waegezellenBlocks = [];
  if (Array.isArray(mess.waegezellen) && mess.waegezellen.length) {
    mess.waegezellen.forEach((wz, i) => {
      const cell = normalizeWaegezelleCell(wz, i);
      const rows = matrixToMessRows(cell.matrix, false);
      const hasMeta = !!(cell.type || cell.serialNumber || cell.position || cell.supplyVoltage || cell.sensitivity);
      if (!hasMeta && !rows.length) return;
      waegezellenBlocks.push({ cell, rows, index: i });
    });
  }
  if (!waegezellenBlocks.length) {
    const first = normalizeWaegezelleCell(
      {
        type: mess.waegezelle_type,
        serialNumber: mess.waegezelle_seriennummer,
        position: mess.waegezelle_position,
        supplyVoltage: mess.vers_spannung,
        sensitivity: mess.sensitivitaet,
        mess_matrix: mess.mess_matrix,
      },
      0,
    );
    let rows = matrixToMessRows(first.matrix, false);
    if (!rows.length) {
      rows = matrixToMessRows(first.matrix, true);
    }
    const extras = Array.isArray(mess.waegezellen_extra) ? mess.waegezellen_extra : [];
    const hasMeta = !!(first.type || first.serialNumber || first.position || first.supplyVoltage || first.sensitivity);
    if (hasMeta || rows.length) {
      waegezellenBlocks.push({ cell: first, rows, index: 0 });
    }
    extras.forEach((ex, i) => {
      const cell = normalizeWaegezelleCell(ex, i + 1);
      const rowsEx = matrixToMessRows(cell.matrix, false);
      const has = !!(cell.type || cell.serialNumber || cell.position || cell.supplyVoltage || cell.sensitivity || rowsEx.length);
      if (!has) return;
      waegezellenBlocks.push({ cell, rows: rowsEx, index: i + 1 });
    });
  }
  // Legacy-Alias für Höhenplanung / Einzelpfad
  const messRows = waegezellenBlocks.length ? waegezellenBlocks[0].rows : [];

  const pgVals = normalizePruefgewichtstestVals(mess.pruefgewichtstest);
  // Legacy-Feld taraspeicher
  if (!pgVals.some(Boolean) && mess.taraspeicher != null && String(mess.taraspeicher).trim() !== '') {
    pgVals[0] = String(mess.taraspeicher).trim();
  }

  const abschluss = payload.abschluss && typeof payload.abschluss === 'object' ? payload.abschluss : {};
  const monteurName =
    String(
      abschluss.monteur_name ||
        payload.monteur_name ||
        payload.technician_name ||
        '',
    ).trim() || '–';

  const stepCols = [
    { key: 'nr', label: de ? 'Nr.' : 'No.', w: 28, align: 'center' },
    { key: 'status', label: de ? 'Ergebnis' : 'Result', w: 48, align: 'center' },
    { key: 'label', label: de ? 'Arbeitsschritt' : 'Work step', w: 250, align: 'left' },
    { key: 'bemerkung', label: de ? 'Bemerkung' : 'Remark', w: 0, align: 'left' },
  ];
  const stepFixed = stepCols.reduce((s, c) => s + (c.key === 'bemerkung' ? 0 : c.w), 0);
  stepCols.forEach((c) => {
    if (c.key === 'bemerkung') c.w = Math.max(80, tableInnerW - stepFixed);
  });

  const headerBandH = 52;
  const metaBlockH = 118;
  const stepHeaderH = 22;
  const stepRowH = 18;

  function drawPageChrome(page) {
    let y = PAGE_H - marginTop;
    if (logo) {
      const maxH = 40;
      const maxW = 110;
      const scale = Math.min(maxW / logo.width, maxH / logo.height);
      const lw = logo.width * scale;
      const lh = logo.height * scale;
      page.drawImage(logo, { x: marginX, y: y - lh, width: lw, height: lh });
    } else {
      page.drawText('KUKLA', { x: marginX, y: y - 18, size: 14, font: fontBold, color: green });
    }

    const title = de ? 'Serviceprotokoll' : 'Service protocol';
    page.drawText(title, {
      x: marginX + 130,
      y: y - 16,
      size: 17,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(de ? 'service protocol' : 'Serviceprotokoll', {
      x: marginX + 130,
      y: y - 32,
      size: 9,
      font,
      color: grayMuted,
    });

    const addrLines = [
      'KUKLA Waagenfabrik GmbH & Co KG',
      'Fadingerstr. 1-11 · 4840 Voecklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = y - 12;
    addrLines.forEach((line) => {
      const tw = font.widthOfTextAtSize(line, 7);
      page.drawText(line, { x: PAGE_W - marginX - tw, y: ay, size: 7, font, color: grayMuted });
      ay -= 9;
    });

    y -= headerBandH;
    page.drawRectangle({
      x: marginX,
      y: y - 3,
      width: tableInnerW,
      height: 3,
      color: green,
    });
    return y - 12;
  }

  function drawMeta(page, yStart) {
    const boxY = yStart - metaBlockH;
    page.drawRectangle({
      x: marginX,
      y: boxY,
      width: tableInnerW,
      height: metaBlockH,
      color: greenHeader,
      borderColor: greenSoft,
      borderWidth: 0.8,
    });
    const colW = tableInnerW / 3;
    const pad = 10;
    const fields = [
      [
        [de ? 'Kunde / customer' : 'Customer', payload.kunde || payload.customer_name || ''],
        ['FN', payload.fabrikationsnummer || ''],
        [de ? 'Projekt / project' : 'Project', payload.projekt || ''],
        [de ? 'Datum / date' : 'Date', formatDateDe(payload.durchfuehrungsdatum) || '–'],
      ],
      [
        ['Type / type', payload.kopf_type || payload.type || ''],
        ['Qmax', payload.kopf_qmax || ''],
        [de ? 'Pos.Nr.' : 'Pos. no.', payload.kopf_pos_nr || ''],
        ['DWC', payload.kopf_dwc || ''],
      ],
      [
        [de ? 'Waegezelle Type' : 'Load cell type', mess.waegezelle_type || ''],
        [de ? 'Seriennummer' : 'Serial no.', mess.waegezelle_seriennummer || ''],
        [de ? 'Versorgungsspannung V' : 'Supply voltage V', mess.vers_spannung || ''],
        [de ? 'Sensitivität mV/V' : 'Sensitivity mV/V', mess.sensitivitaet || ''],
        [de ? 'Servicetechniker' : 'Service engineer', monteurName],
      ],
    ];
    fields.forEach((group, gi) => {
      const gx = marginX + gi * colW + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(clipText(font, label, 6.5, colW - pad * 2), {
          x: gx,
          y: gy,
          size: 6.5,
          font,
          color: grayMuted,
        });
        page.drawText(clipText(fontBold, String(val || '').trim() || '–', 9, colW - pad * 2), {
          x: gx,
          y: gy - 11,
          size: 9,
          font: fontBold,
          color: grayText,
        });
        gy -= 26;
      });
    });
    return boxY - 12;
  }

  function drawStepTableHeader(page, yTop) {
    const y = yTop - stepHeaderH;
    page.drawRectangle({
      x: marginX,
      y,
      width: tableInnerW,
      height: stepHeaderH,
      color: green,
    });
    let x = marginX;
    stepCols.forEach((col) => {
      const label = clipText(fontBold, col.label, 8, col.w - 6);
      let lx = x + 4;
      if (col.align === 'center') lx = x + (col.w - fontBold.widthOfTextAtSize(label, 8)) / 2;
      else if (col.align === 'right') lx = x + col.w - 4 - fontBold.widthOfTextAtSize(label, 8);
      page.drawText(label, { x: Math.max(x + 2, lx), y: y + 7, size: 8, font: fontBold, color: white });
      x += col.w;
    });
    return y;
  }

  function measureStepRowHeight(step) {
    const bem = step.bemerkung || '';
    const labelW = stepCols.find((c) => c.key === 'label').w - 8;
    const bemW = stepCols.find((c) => c.key === 'bemerkung').w - 8;
    const labelLines = Math.max(1, Math.ceil(font.widthOfTextAtSize(step.label, 8) / Math.max(1, labelW)));
    const bemLines = bem
      ? Math.max(1, Math.ceil(font.widthOfTextAtSize(bem, 7.5) / Math.max(1, bemW)))
      : 1;
    return Math.max(stepRowH, Math.max(labelLines, bemLines) * 11 + 6);
  }

  function drawWrappedInCell(page, text, x, y, maxW, size, useFont, color, lineH) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    let line = '';
    let cy = y;
    const lines = [];
    words.forEach((word) => {
      const test = line ? line + ' ' + word : word;
      if (useFont.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    if (!lines.length) lines.push('');
    lines.forEach((ln) => {
      page.drawText(ln, { x, y: cy, size, font: useFont, color });
      cy -= lineH;
    });
    return lines.length;
  }

  function drawStepRow(page, yTop, step, idx) {
    const h = measureStepRowHeight(step);
    const y = yTop - h;
    page.drawLine({
      start: { x: marginX, y },
      end: { x: marginX + tableInnerW, y },
      thickness: 0.7,
      color: lineGray,
    });
    let x = marginX;
    const textTop = yTop - 12;
    stepCols.forEach((col) => {
      if (col.key === 'nr') {
        const t = String(idx + 1);
        const tx = x + (col.w - fontBold.widthOfTextAtSize(t, 8)) / 2;
        page.drawText(t, { x: tx, y: textTop, size: 8, font: fontBold, color: grayText });
      } else if (col.key === 'status') {
        const t = step.status;
        const tx = x + (col.w - fontBold.widthOfTextAtSize(t, 8)) / 2;
        page.drawText(t, { x: Math.max(x + 2, tx), y: textTop, size: 8, font: fontBold, color: greenDark });
      } else if (col.key === 'label') {
        drawWrappedInCell(page, step.label, x + 4, textTop, col.w - 8, 8, font, grayText, 10);
      } else {
        drawWrappedInCell(page, step.bemerkung, x + 4, textTop, col.w - 8, 7.5, font, grayMuted, 10);
      }
      x += col.w;
    });
    return y;
  }

  function drawSectionTitle(page, y, title) {
    page.drawText(title, { x: marginX, y, size: 10, font: fontBold, color: greenDark });
    return y - 14;
  }

  function drawKeyValueTable(page, yStart, rows, colDefs) {
    let y = yStart;
    const headerH = 18;
    page.drawRectangle({
      x: marginX,
      y: y - headerH,
      width: tableInnerW,
      height: headerH,
      color: green,
    });
    let x = marginX;
    colDefs.forEach((c) => {
      page.drawText(c.label, { x: x + 4, y: y - 12, size: 7.5, font: fontBold, color: white });
      x += c.w;
    });
    y -= headerH;
    rows.forEach((row) => {
      const rh = 16;
      y -= rh;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: marginX + tableInnerW, y },
        thickness: 0.6,
        color: lineGray,
      });
      let cx = marginX;
      colDefs.forEach((c) => {
        const val = clipText(font, row[c.key] || '', 8, c.w - 6);
        page.drawText(val, { x: cx + 4, y: y + 4, size: 8, font, color: grayText });
        cx += c.w;
      });
    });
    page.drawRectangle({
      x: marginX,
      y,
      width: tableInnerW,
      height: yStart - y,
      borderColor: green,
      borderWidth: 0.8,
    });
    return y - 10;
  }

  function drawFooter(page, pageIndex, pageCount, isLast) {
    const footerLineY = marginBottom + 22;
    page.drawLine({
      start: { x: marginX, y: footerLineY },
      end: { x: PAGE_W - marginX, y: footerLineY },
      thickness: 0.6,
      color: greenSoft,
    });
    if (isLast) {
      page.drawText('Pruefer / tester: ____________________________', {
        x: marginX,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
      page.drawText('Datum: ' + pdfFooterCreatedDateDe(payload), {
        x: marginX + 220,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
    }
    const pageLabel = (de ? 'Seite ' : 'Page ') + (pageIndex + 1) + ' / ' + pageCount;
    const tw = font.widthOfTextAtSize(pageLabel, 8);
    page.drawText(pageLabel, {
      x: PAGE_W - marginX - tw,
      y: marginBottom,
      size: 8,
      font,
      color: grayMuted,
    });
  }

  // Content blocks after steps (only on last page with remaining room / overflow pages)
  function buildTrailingBlocks() {
    const blocks = [];
    waegezellenBlocks.forEach((wz) => {
      blocks.push({ type: 'wz', wz });
    });
    if (pgVals.some(Boolean)) {
      blocks.push({ type: 'pg' });
    }
    const bemerk = stripHtml(payload.bemerkungen || '');
    if (bemerk) blocks.push({ type: 'bemerk', text: bemerk });
    const absStatus = abschlussStatusLabel(abschluss, lang);
    const absBem = stripHtml(abschluss.bemerkungen || '');
    if (absStatus || abschluss.monteur_name || abschluss.datum || absBem || sigImg) {
      blocks.push({
        type: 'abschluss',
        status: absStatus,
        monteur: String(abschluss.monteur_name || monteurName || '').trim(),
        datum: formatDateDe(abschluss.datum) || String(abschluss.datum || '').trim(),
        bemerkung: absBem,
        hasSig: !!sigImg,
      });
    }
    return blocks;
  }

  const trailing = buildTrailingBlocks();
  const contentTopAfterMeta = PAGE_H - marginTop - headerBandH - 12 - metaBlockH - 12;
  const usableH = contentTopAfterMeta - marginBottom - 28;

  // Paginate steps first
  const stepPages = [];
  let stepIdx = 0;
  while (stepIdx < steps.length || stepPages.length === 0) {
    const pageSteps = [];
    let used = stepHeaderH;
    while (stepIdx < steps.length) {
      const h = measureStepRowHeight(steps[stepIdx]);
      if (pageSteps.length && used + h > usableH) break;
      pageSteps.push(steps[stepIdx]);
      used += h;
      stepIdx += 1;
    }
    stepPages.push({ steps: pageSteps, startIndex: stepIdx - pageSteps.length });
    if (!steps.length) break;
  }

  // Attach trailing content to last step page if room, else extra pages
  const pagesPlan = stepPages.map((p, i) => ({
    steps: p.steps,
    startIndex: p.startIndex,
    trailing: [],
  }));
  let trailQueue = trailing.slice();
  let targetIdx = pagesPlan.length - 1;
  let lastUsed =
    stepHeaderH +
    pagesPlan[targetIdx].steps.reduce((s, st) => s + measureStepRowHeight(st), 0) +
    (pagesPlan[targetIdx].steps.length ? 20 : 0);
  while (trailQueue.length) {
    const block = trailQueue[0];
    let need = 40;
    if (block.type === 'wz') {
      const rowsN = (block.wz && block.wz.rows && block.wz.rows.length) || 0;
      need = 20 + 28 + (rowsN ? 18 + rowsN * 16 + 14 : 8) + 10;
    } else if (block.type === 'mess') need = 20 + 18 + messRows.length * 16 + 14;
    else if (block.type === 'pg') need = 20 + 14 + 18 + 16 + 10;
    else if (block.type === 'bemerk') need = 40;
    else if (block.type === 'abschluss') need = 80 + (block.hasSig ? 56 : 0);
    if (lastUsed + need > usableH && pagesPlan[targetIdx].trailing.length) {
      pagesPlan.push({ steps: [], startIndex: 0, trailing: [] });
      targetIdx = pagesPlan.length - 1;
      lastUsed = 0;
    }
    pagesPlan[targetIdx].trailing.push(trailQueue.shift());
    lastUsed += need;
  }

  pagesPlan.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = drawPageChrome(page);
    y = drawMeta(page, y);

    if (plan.steps.length || (pageIndex === 0 && !steps.length)) {
      const tableTop = y;
      y = drawSectionTitle(page, y, de ? 'Arbeitsschritte / work steps' : 'Work steps');
      const thTop = y;
      y = drawStepTableHeader(page, y);
      plan.steps.forEach((st, i) => {
        y = drawStepRow(page, y, st, plan.startIndex + i);
      });
      if (!plan.steps.length) {
        y -= 16;
        page.drawText(de ? 'Keine Arbeitsschritte' : 'No work steps', {
          x: marginX + 8,
          y: y + 4,
          size: 8,
          font,
          color: grayMuted,
        });
      }
      page.drawRectangle({
        x: marginX,
        y,
        width: tableInnerW,
        height: thTop - y,
        borderColor: green,
        borderWidth: 0.9,
      });
      let vx = marginX;
      stepCols.forEach((col, ci) => {
        if (ci > 0) {
          page.drawLine({
            start: { x: vx, y },
            end: { x: vx, y: thTop },
            thickness: 0.35,
            color: lineGray,
          });
        }
        vx += col.w;
      });
      y -= 12;
    }

    const trail = plan.trailing || [];
    trail.forEach((block) => {
      if (block.type === 'wz' || block.type === 'mess') {
        const wz = block.type === 'wz' ? block.wz : { cell: null, rows: messRows, index: 0 };
        const cell = (wz && wz.cell) || {};
        const rows = (wz && wz.rows) || [];
        const idx = wz && wz.index != null ? wz.index : 0;
        const title =
          waegezellenBlocks.length > 1
            ? de
              ? 'Waegezelle & Messwerte ' + (idx + 1)
              : 'Load cell & measurements ' + (idx + 1)
            : de
              ? 'Waegezelle & Messwerte'
              : 'Load cell & measurements';
        y = drawSectionTitle(page, y, title);
        const metaBits = [
          [de ? 'Type' : 'Type', cell.type || ''],
          [de ? 'Seriennr.' : 'Serial', cell.serialNumber || ''],
          [de ? 'Pos.' : 'Pos.', cell.position || ''],
          [de ? 'Vers. V' : 'Supply V', cell.supplyVoltage || ''],
          [de ? 'Sens. mV/V' : 'Sens. mV/V', cell.sensitivity || ''],
        ].filter((p) => String(p[1] || '').trim());
        if (metaBits.length) {
          const metaH = 22;
          page.drawRectangle({
            x: marginX,
            y: y - metaH,
            width: tableInnerW,
            height: metaH,
            color: greenHeader,
            borderColor: greenSoft,
            borderWidth: 0.5,
          });
          let mx = marginX + 6;
          metaBits.forEach((pair) => {
            const label = pair[0] + ': ';
            const val = clipText(fontBold, String(pair[1]), 8, 90);
            page.drawText(label, { x: mx, y: y - 14, size: 6.5, font, color: grayMuted });
            const lw = font.widthOfTextAtSize(label, 6.5);
            page.drawText(val, { x: mx + lw, y: y - 14, size: 8, font: fontBold, color: grayText });
            mx += Math.max(100, lw + fontBold.widthOfTextAtSize(val, 8) + 14);
          });
          y -= metaH + 4;
        }
        if (rows.length) {
          const cols = [
            { key: 'label', label: de ? 'Messpunkt' : 'Point', w: tableInnerW * 0.36 },
            { key: 'kg', label: 'kg', w: tableInnerW * 0.16 },
            { key: 'mv', label: 'mV', w: tableInnerW * 0.16 },
            { key: 'ma', label: 'mA', w: tableInnerW * 0.16 },
            { key: 'g', label: 'g %', w: tableInnerW * 0.16 },
          ];
          y = drawKeyValueTable(page, y, rows, cols);
        } else {
          y -= 6;
        }
      } else if (block.type === 'pg') {
        y = drawPruefgewichtstestRow(page, y, {
          vals: pgVals,
          de,
          marginX,
          tableInnerW,
          font,
          fontBold,
          green,
          greenDark,
          greenSoft,
          grayText,
          white,
          S: (t) => String(t == null ? '' : t),
          title: de ? 'Pruefgewichtstest' : 'Test with test load',
        });
      } else if (block.type === 'bemerk') {
        y = drawSectionTitle(page, y, de ? 'Allgemeine Bemerkungen' : 'General remarks');
        y = drawWrappedText(page, font, block.text, marginX, y, tableInnerW, 8, 11);
        y -= 8;
      } else if (block.type === 'abschluss') {
        y = drawSectionTitle(page, y, de ? 'Abschluss' : 'Completion');
        const absBoxH = 56 + (sigImg ? 52 : 0);
        page.drawRectangle({
          x: marginX,
          y: y - absBoxH,
          width: tableInnerW,
          height: absBoxH,
          color: greenHeader,
          borderColor: greenSoft,
          borderWidth: 0.8,
        });
        const absFields = [
          [de ? 'Status' : 'Status', block.status || '–'],
          [de ? 'Monteur' : 'Technician', block.monteur || '–'],
          [de ? 'Datum' : 'Date', block.datum || '–'],
        ];
        absFields.forEach((pair, i) => {
          const ax = marginX + 10 + i * (tableInnerW / 3);
          page.drawText(pair[0], { x: ax, y: y - 12, size: 6.5, font, color: grayMuted });
          page.drawText(clipText(fontBold, pair[1], 9, tableInnerW / 3 - 20), {
            x: ax,
            y: y - 24,
            size: 9,
            font: fontBold,
            color: grayText,
          });
        });
        if (block.bemerkung) {
          page.drawText(clipText(font, (de ? 'Bem.: ' : 'Note: ') + block.bemerkung, 8, tableInnerW - 20), {
            x: marginX + 10,
            y: y - 42,
            size: 8,
            font,
            color: grayText,
          });
        }
        if (sigImg) {
          const maxW = 150;
          const maxH = 42;
          const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
          const iw = sigImg.width * scale;
          const ih = sigImg.height * scale;
          page.drawText(de ? 'Unterschrift' : 'Signature', {
            x: marginX + 10,
            y: y - 58,
            size: 6.5,
            font,
            color: grayMuted,
          });
          page.drawImage(sigImg, { x: marginX + 10, y: y - absBoxH + 4, width: iw, height: ih });
        }
        y -= absBoxH + 10;
      }
    });

    drawFooter(page, pageIndex, pagesPlan.length, pageIndex === pagesPlan.length - 1);
  });

  return Buffer.from(await pdfDoc.save());
}

function parseLocaleNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatDeNumber(v, digits) {
  if (v == null || String(v).trim() === '') return '';
  const n = typeof v === 'number' ? v : parseLocaleNumber(v);
  if (n == null) return String(v).trim();
  const d = digits != null ? digits : 3;
  return n.toFixed(d).replace('.', ',');
}

function formatDePercent(v) {
  if (v == null || String(v).trim() === '') return '';
  const n = typeof v === 'number' ? v : parseLocaleNumber(v);
  if (n == null) return String(v).trim();
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2).replace('.', ',') + ' %';
}

function formatDateDe(isoOrDate) {
  const s = String(isoOrDate || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return d + '.' + m + '.' + y;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
}

/** Fußzeilen-Datum = PDF-Erstellung (gespeichert_am / sonst jetzt). */
function pdfFooterCreatedDateDe(payload) {
  const fromPayload = formatDateDe(
    (payload && (payload.gespeichert_am || payload.updated_at || payload.pdf_created_at)) || '',
  );
  if (fromPayload) return fromPayload;
  return formatDateDe(new Date().toISOString());
}

function formatDateTimeDe(isoOrDate) {
  const s = String(isoOrDate || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return formatDateDe(s);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(d.getDate()) +
    '.' +
    pad(d.getMonth() + 1) +
    '.' +
    d.getFullYear() +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

function clipText(font, text, size, maxWidth) {
  const raw = String(text || '')
    .replace(/\u2211/g, 'Sum')
    .replace(/\u2026/g, '...')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\uF0A7\uF0B7\uF0D8\uF0FC]/g, '\u2022')
    .replace(/\u00a0/g, ' ');
  if (!raw) return '';
  if (font.widthOfTextAtSize(raw, size) <= maxWidth) return raw;
  let t = raw;
  while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '...';
}

function rowInSumme(row) {
  return !(row && (row.in_summe === false || row.in_summe === 0 || row.in_summe === '0'));
}

/**
 * Kontrollwiegungsprotokoll – A4 Querformat, Tabellenlayout (Kukla-Corporate).
 */
async function generateKontrollwiegungPdfBuffer(payload) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const marginX = 28;
  const marginTop = 22;
  const marginBottom = 36;
  const green = rgb(14 / 255, 123 / 255, 90 / 255);
  const greenDark = rgb(12 / 255, 106 / 255, 77 / 255);
  const greenSoft = rgb(207 / 255, 232 / 255, 209 / 255);
  const greenHeader = rgb(232 / 255, 244 / 255, 236 / 255);
  const grayText = rgb(0.25, 0.25, 0.25);
  const grayMuted = rgb(0.45, 0.45, 0.45);
  const lineGray = rgb(0.78, 0.82, 0.8);
  const white = rgb(1, 1, 1);
  const sumBg = rgb(0.93, 0.96, 0.94);

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const rowsAll = Array.isArray(payload.wiegungen) ? payload.wiegungen : [];
  // PDF: nur Zeilen, die für die Summe markiert sind (in_summe)
  const dataRows = rowsAll.filter(rowInSumme);

  const cols = [
    { key: 'nr', label: 'Nr.', sub: 'No.', w: 28, align: 'center' },
    { key: 'bandwaage_kg', label: 'Bandwaage [kg]', sub: 'beltscale', w: 88, align: 'right', digits: 3 },
    { key: 'kontrollwaage_kg', label: 'Kontrollwaage [kg]', sub: 'controlscale', w: 98, align: 'right', digits: 3 },
    { key: 'fehler_kg', label: 'Fehler [kg]', sub: 'difference', w: 72, align: 'right', digits: 3 },
    { key: 'fehler_prozent', label: 'Fehler [%]', sub: 'difference', w: 68, align: 'right', kind: 'pct' },
    { key: 'leistung_th', label: 'Leistung [t/h]', sub: 'value', w: 72, align: 'right', digits: 0 },
    { key: 'tara_kg', label: 'Tara [kg]', sub: 'truck tare', w: 68, align: 'right', digits: 0 },
    { key: 'brutto_kg', label: 'Brutto [kg]', sub: 'gross', w: 72, align: 'right', digits: 0 },
    { key: 'bemerkung', label: 'Bemerkungen', sub: 'remarks', w: 0, align: 'left' },
  ];
  const tableInnerW = PAGE_W - marginX * 2;
  const fixedW = cols.reduce((s, c) => s + (c.key === 'bemerkung' ? 0 : c.w), 0);
  cols.forEach((c) => {
    if (c.key === 'bemerkung') c.w = Math.max(90, tableInnerW - fixedW);
  });

  const headerH = 28;
  const rowH = 18;
  const metaBlockH = 118;

  function computeSums() {
    const keys = ['bandwaage_kg', 'kontrollwaage_kg', 'fehler_kg', 'leistung_th', 'tara_kg', 'brutto_kg'];
    const totals = {};
    const counts = {};
    keys.forEach((k) => {
      totals[k] = 0;
      counts[k] = 0;
    });
    let sumBand = 0;
    let sumKontr = 0;
    let hasBandKontr = false;
    let any = false;
    dataRows.forEach((row) => {
      any = true;
      keys.forEach((k) => {
        const n = parseLocaleNumber(row[k]);
        if (n != null) {
          totals[k] += n;
          counts[k] += 1;
        }
      });
      const band = parseLocaleNumber(row.bandwaage_kg);
      const kontr = parseLocaleNumber(row.kontrollwaage_kg);
      if (band != null && kontr != null) {
        sumBand += band;
        sumKontr += kontr;
        hasBandKontr = true;
      }
    });
    const out = { any, totals, counts };
    if (any && counts.leistung_th > 0) {
      out.leistung_avg = totals.leistung_th / counts.leistung_th;
    }
    if (hasBandKontr && sumKontr !== 0) {
      out.fehler_kg = sumBand - sumKontr;
      out.fehler_prozent = ((sumBand - sumKontr) / sumKontr) * 100;
    } else if (any && counts.fehler_kg > 0) {
      out.fehler_kg = totals.fehler_kg;
    }
    return out;
  }

  const sums = computeSums();

  function cellValue(row, col, idx) {
    if (col.key === 'nr') return String(idx + 1);
    if (col.key === 'bemerkung') return String(row.bemerkung || '').trim();
    if (col.kind === 'pct') return formatDePercent(row.fehler_prozent);
    const dig = col.digits != null ? col.digits : 3;
    return formatDeNumber(row[col.key], dig);
  }

  function sumCellValue(col) {
    if (col.key === 'nr') return 'Sum';
    if (col.key === 'bemerkung') return 'Summe';
    if (col.key === 'leistung_th') {
      return sums.any && sums.leistung_avg != null ? formatDeNumber(sums.leistung_avg, 0) : '';
    }
    if (col.key === 'fehler_prozent') {
      return sums.fehler_prozent != null ? formatDePercent(sums.fehler_prozent) : '';
    }
    if (col.key === 'fehler_kg') {
      return sums.fehler_kg != null
        ? formatDeNumber(sums.fehler_kg, 3)
        : sums.any && sums.counts.fehler_kg
          ? formatDeNumber(sums.totals.fehler_kg, 3)
          : '';
    }
    if (!sums.any || !sums.counts[col.key]) return '';
    const dig = col.digits != null ? col.digits : 3;
    return formatDeNumber(sums.totals[col.key], dig);
  }

  function drawHeader(page) {
    let y = PAGE_H - marginTop;
    if (logo) {
      const maxH = 42;
      const maxW = 120;
      const scale = Math.min(maxW / logo.width, maxH / logo.height);
      const lw = logo.width * scale;
      const lh = logo.height * scale;
      page.drawImage(logo, { x: marginX, y: y - lh, width: lw, height: lh });
    } else {
      page.drawText('KUKLA', { x: marginX, y: y - 18, size: 16, font: fontBold, color: green });
    }

    const titleX = marginX + 140;
    page.drawText('Kontrollwiegungsprotokoll', {
      x: titleX,
      y: y - 16,
      size: 18,
      font: fontBold,
      color: greenDark,
    });
    page.drawText('calibration protocol', {
      x: titleX,
      y: y - 32,
      size: 9,
      font,
      color: grayMuted,
    });

    const addrLines = [
      'KUKLA Waagenfabrik GmbH & Co KG',
      'Fadingerstr. 1-11 · 4840 Vöcklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = y - 12;
    addrLines.forEach((line) => {
      const tw = font.widthOfTextAtSize(line, 7.5);
      page.drawText(line, { x: PAGE_W - marginX - tw, y: ay, size: 7.5, font, color: grayMuted });
      ay -= 10;
    });

    y -= 52;
    page.drawRectangle({
      x: marginX,
      y: y - 3,
      width: tableInnerW,
      height: 3,
      color: green,
    });
    return y - 14;
  }

  function drawMeta(page, yStart) {
    const boxH = metaBlockH;
    const boxY = yStart - boxH;
    page.drawRectangle({
      x: marginX,
      y: boxY,
      width: tableInnerW,
      height: boxH,
      color: greenHeader,
      borderColor: greenSoft,
      borderWidth: 0.8,
    });

    const colW = tableInnerW / 3;
    const pad = 10;
    const datumVal = formatDateDe(payload.durchfuehrungsdatum) || '–';
    const monteurVal =
      String(payload.monteur_name || payload.technician_name || '').trim() || '–';
    const gespeichertVal =
      formatDateTimeDe(payload.gespeichert_am || payload.updated_at) || '–';
    const fields = [
      [
        ['Kunde / customer', payload.kunde || payload.customer_name || ''],
        ['FN', payload.fabrikationsnummer || ''],
        ['Projekt / project', payload.projekt || ''],
        ['Datum / date', datumVal],
      ],
      [
        ['Type / type', payload.type || ''],
        ['Leistung / value', payload.leistung || ''],
        ['Elektronik', payload.elektronik || ''],
        ['Servicetechniker', monteurVal],
      ],
      [
        ['Teilung Kontrollwaage', payload.teilung_kontrollwaage || ''],
        ['Bereich max', payload.bereich_max || ''],
        ['Letzte Eichung', formatDateDe(payload.letzte_eichung) || String(payload.letzte_eichung || '')],
        ['Gespeichert', gespeichertVal],
      ],
    ];

    fields.forEach((group, gi) => {
      const gx = marginX + gi * colW + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(label, { x: gx, y: gy, size: 6.5, font, color: grayMuted });
        const display = String(val || '').trim() || '–';
        page.drawText(clipText(fontBold, display, 9, colW - pad * 2), {
          x: gx,
          y: gy - 11,
          size: 9,
          font: fontBold,
          color: grayText,
        });
        gy -= 26;
      });
    });
    return boxY - 12;
  }

  function drawTableHeader(page, yTop) {
    const y = yTop - headerH;
    page.drawRectangle({
      x: marginX,
      y,
      width: tableInnerW,
      height: headerH,
      color: green,
    });
    let x = marginX;
    cols.forEach((col) => {
      const label = clipText(fontBold, col.label, 7.5, col.w - 6);
      const sub = clipText(font, col.sub, 6, col.w - 6);
      const lx =
        col.align === 'right'
          ? x + col.w - 4 - fontBold.widthOfTextAtSize(label, 7.5)
          : col.align === 'center'
            ? x + (col.w - fontBold.widthOfTextAtSize(label, 7.5)) / 2
            : x + 4;
      page.drawText(label, { x: Math.max(x + 2, lx), y: y + 15, size: 7.5, font: fontBold, color: white });
      const sx =
        col.align === 'right'
          ? x + col.w - 4 - font.widthOfTextAtSize(sub, 6)
          : col.align === 'center'
            ? x + (col.w - font.widthOfTextAtSize(sub, 6)) / 2
            : x + 4;
      page.drawText(sub, { x: Math.max(x + 2, sx), y: y + 5, size: 6, font, color: rgb(0.85, 0.95, 0.9) });
      x += col.w;
    });
    return y;
  }

  function drawDataRow(page, yTop, row, idx, isSum) {
    const y = yTop - rowH;
    if (isSum) {
      page.drawRectangle({
        x: marginX,
        y,
        width: tableInnerW,
        height: rowH,
        color: sumBg,
      });
    }
    // Trennlinie unter jeder Wiegungszeile (inkl. Summe)
    page.drawLine({
      start: { x: marginX, y },
      end: { x: marginX + tableInnerW, y },
      thickness: 0.7,
      color: isSum ? green : lineGray,
    });

    let x = marginX;
    cols.forEach((col) => {
      const raw = isSum ? sumCellValue(col) : cellValue(row, col, idx);
      const size = isSum || col.key === 'nr' ? 8 : 8;
      const useFont = isSum || col.key === 'nr' ? fontBold : font;
      const text = clipText(useFont, raw, size, col.w - 6);
      let tx = x + 4;
      if (col.align === 'right') tx = x + col.w - 4 - useFont.widthOfTextAtSize(text, size);
      else if (col.align === 'center') tx = x + (col.w - useFont.widthOfTextAtSize(text, size)) / 2;
      page.drawText(text, {
        x: Math.max(x + 2, tx),
        y: y + 5.5,
        size,
        font: useFont,
        color: isSum ? greenDark : grayText,
      });
      x += col.w;
    });
    return y;
  }

  function drawFooter(page, pageIndex, pageCount, isLast) {
    const footerLineY = marginBottom + 22;
    page.drawLine({
      start: { x: marginX, y: footerLineY },
      end: { x: PAGE_W - marginX, y: footerLineY },
      thickness: 0.6,
      color: greenSoft,
    });
    if (isLast) {
      page.drawText('Pruefer / tester: ____________________________', {
        x: marginX,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
      page.drawText('Datum: ' + pdfFooterCreatedDateDe(payload), {
        x: marginX + 260,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
    }
    const pageLabel = 'Seite ' + (pageIndex + 1) + ' / ' + pageCount;
    const tw = font.widthOfTextAtSize(pageLabel, 8);
    page.drawText(pageLabel, {
      x: PAGE_W - marginX - tw,
      y: marginBottom,
      size: 8,
      font,
      color: grayMuted,
    });
  }

  // Jede Seite: Logo + Titel + Kopfblock; Summe nur auf der letzten Seite
  const contentTop = PAGE_H - marginTop - 52 - 14 - metaBlockH - 12;
  const rowsPerPage = Math.max(
    1,
    Math.floor((contentTop - marginBottom - 22 - headerH) / rowH),
  );

  const pagesPlan = [];
  let remaining = dataRows.slice();
  if (!remaining.length) {
    pagesPlan.push({ rows: [], withSum: false });
  } else {
    while (remaining.length > 0) {
      const left = remaining.length;
      const sumSlot = sums.any ? 1 : 0;
      if (left + sumSlot <= rowsPerPage) {
        pagesPlan.push({ rows: remaining.splice(0), withSum: !!sums.any });
      } else {
        pagesPlan.push({ rows: remaining.splice(0, rowsPerPage), withSum: false });
      }
    }
    if (sums.any && pagesPlan.length && !pagesPlan[pagesPlan.length - 1].withSum) {
      pagesPlan.push({ rows: [], withSum: true });
    }
  }

  pagesPlan.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = drawHeader(page);
    y = drawMeta(page, y);
    const tableTop = y;
    y = drawTableHeader(page, y);
    plan.rows.forEach((row, i) => {
      const globalIdx = dataRows.indexOf(row);
      y = drawDataRow(page, y, row, globalIdx >= 0 ? globalIdx : i, false);
    });
    if (plan.withSum && sums.any) {
      y = drawDataRow(page, y, {}, 0, true);
    }
    const tableBottom = y;
    let vx = marginX;
    cols.forEach((col, ci) => {
      if (ci > 0) {
        page.drawLine({
          start: { x: vx, y: tableBottom },
          end: { x: vx, y: tableTop },
          thickness: 0.35,
          color: lineGray,
        });
      }
      vx += col.w;
    });
    page.drawRectangle({
      x: marginX,
      y: tableBottom,
      width: tableInnerW,
      height: Math.max(0, tableTop - tableBottom),
      borderColor: green,
      borderWidth: 0.9,
    });
    if (sigImg && pageIndex === pagesPlan.length - 1) {
      const maxW = 140;
      const maxH = 36;
      const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
      const iw = sigImg.width * scale;
      const ih = sigImg.height * scale;
      page.drawText('Unterschrift / Signature', {
        x: marginX,
        y: marginBottom + 18,
        size: 7,
        font,
        color: grayMuted,
      });
      page.drawImage(sigImg, { x: marginX + 130, y: marginBottom + 6, width: iw, height: ih });
    }
    drawFooter(page, pageIndex, pagesPlan.length, pageIndex === pagesPlan.length - 1);
  });

  return Buffer.from(await pdfDoc.save());
}

/**
 * Schleppketten-Test / chain calibration – A4 Querformat, Corporate-Design.
 */
async function generateSchleppkettenPdfBuffer(payload) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const skLocal = require('./schleppketten-local');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const marginX = 26;
  const marginTop = 22;
  const marginBottom = 36;
  const green = rgb(14 / 255, 123 / 255, 90 / 255);
  const greenDark = rgb(12 / 255, 106 / 255, 77 / 255);
  const greenSoft = rgb(207 / 255, 232 / 255, 209 / 255);
  const greenHeader = rgb(232 / 255, 244 / 255, 236 / 255);
  const grayText = rgb(0.25, 0.25, 0.25);
  const grayMuted = rgb(0.45, 0.45, 0.45);
  const lineGray = rgb(0.78, 0.82, 0.8);
  const white = rgb(1, 1, 1);
  const sumBg = rgb(0.93, 0.96, 0.94);

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const rowsAll = skLocal.enrichMessungen(Array.isArray(payload.messungen) ? payload.messungen : []);
  const dataRows = rowsAll.filter(rowInSumme);

  const cols = [
    { key: 'nr', label: 'Nr.', sub: 'No.', w: 26, align: 'center' },
    { key: 'bandwaage_t', label: 'Bandwaage [t]', sub: 'beltscale', w: 78, align: 'right', digits: 3 },
    { key: 'pruefkette_t', label: 'Pruefkette [t]', sub: 'testchain', w: 78, align: 'right', digits: 3 },
    { key: 'kg_pro_m', label: 'kg/m', sub: 'kg/m', w: 62, align: 'right', digits: 4 },
    { key: 'geschwindigkeit_ms', label: 'Geschw. [m/s]', sub: 'speed', w: 70, align: 'right', digits: 2 },
    { key: 'messzeit_s', label: 'Messzeit [s]', sub: 'measure time', w: 62, align: 'right', digits: 0 },
    { key: 'fehler_prozent', label: 'Fehler [%]', sub: 'difference', w: 62, align: 'right', kind: 'pct' },
    { key: 'leistung_th', label: 'Leistung [t/h]', sub: 'value', w: 70, align: 'right', digits: 1 },
    { key: 'bemerkung', label: 'Bemerkungen', sub: 'remarks', w: 0, align: 'left' },
  ];
  const tableInnerW = PAGE_W - marginX * 2;
  const fixedW = cols.reduce((s, c) => s + (c.key === 'bemerkung' ? 0 : c.w), 0);
  cols.forEach((c) => {
    if (c.key === 'bemerkung') c.w = Math.max(80, tableInnerW - fixedW);
  });

  const headerH = 28;
  const rowH = 18;
  const metaBlockH = 118;

  function computeSums() {
    let sumBand = 0;
    let sumPk = 0;
    let sumKgm = 0;
    let sumZeit = 0;
    let sumLeist = 0;
    let nLeist = 0;
    let any = false;
    dataRows.forEach((row) => {
      any = true;
      const band = parseLocaleNumber(row.bandwaage_t);
      const pk = parseLocaleNumber(row.pruefkette_t);
      const kgm = parseLocaleNumber(row.kg_pro_m);
      const zeit = parseLocaleNumber(row.messzeit_s);
      const leist = parseLocaleNumber(row.leistung_th);
      if (band != null) sumBand += band;
      if (pk != null) sumPk += pk;
      if (kgm != null) sumKgm += kgm;
      if (zeit != null) sumZeit += zeit;
      if (leist != null) {
        sumLeist += leist;
        nLeist += 1;
      }
    });
    const out = { any, sumBand, sumPk, sumKgm, sumZeit };
    if (nLeist > 0) out.leistung_avg = sumLeist / nLeist;
    if (any && sumPk !== 0) out.fehler_prozent = ((sumBand - sumPk) / sumPk) * 100;
    return out;
  }
  const sums = computeSums();

  function cellValue(row, col, idx) {
    if (col.key === 'nr') return String(idx + 1);
    if (col.key === 'bemerkung') return String(row.bemerkung || '').trim();
    if (col.kind === 'pct') return formatDePercent(row.fehler_prozent);
    return formatDeNumber(row[col.key], col.digits != null ? col.digits : 3);
  }

  function sumCellValue(col) {
    if (col.key === 'nr') return 'Sum';
    if (col.key === 'bemerkung') return 'Summe';
    if (col.key === 'geschwindigkeit_ms') return '';
    if (col.key === 'leistung_th') {
      return sums.any && sums.leistung_avg != null ? formatDeNumber(sums.leistung_avg, 1) : '';
    }
    if (col.key === 'fehler_prozent') {
      return sums.fehler_prozent != null ? formatDePercent(sums.fehler_prozent) : '';
    }
    if (col.key === 'bandwaage_t') return sums.any ? formatDeNumber(sums.sumBand, 3) : '';
    if (col.key === 'pruefkette_t') return sums.any ? formatDeNumber(sums.sumPk, 3) : '';
    if (col.key === 'kg_pro_m') return sums.any ? formatDeNumber(sums.sumKgm, 4) : '';
    if (col.key === 'messzeit_s') return sums.any ? formatDeNumber(sums.sumZeit, 0) : '';
    return '';
  }

  function drawHeader(page) {
    let y = PAGE_H - marginTop;
    if (logo) {
      const maxH = 42;
      const maxW = 120;
      const scale = Math.min(maxW / logo.width, maxH / logo.height);
      const lw = logo.width * scale;
      const lh = logo.height * scale;
      page.drawImage(logo, { x: marginX, y: y - lh, width: lw, height: lh });
    } else {
      page.drawText('KUKLA', { x: marginX, y: y - 18, size: 16, font: fontBold, color: green });
    }
    page.drawText('Schleppketten-Test', {
      x: marginX + 140,
      y: y - 16,
      size: 18,
      font: fontBold,
      color: greenDark,
    });
    page.drawText('chain calibration', {
      x: marginX + 140,
      y: y - 32,
      size: 9,
      font,
      color: grayMuted,
    });
    const addrLines = [
      'KUKLA Waagenfabrik GmbH & Co KG',
      'Fadingerstr. 1-11 · 4840 Voecklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = y - 12;
    addrLines.forEach((line) => {
      const tw = font.widthOfTextAtSize(line, 7.5);
      page.drawText(line, { x: PAGE_W - marginX - tw, y: ay, size: 7.5, font, color: grayMuted });
      ay -= 10;
    });
    y -= 52;
    page.drawRectangle({ x: marginX, y: y - 3, width: tableInnerW, height: 3, color: green });
    return y - 14;
  }

  function drawMeta(page, yStart) {
    const boxY = yStart - metaBlockH;
    page.drawRectangle({
      x: marginX,
      y: boxY,
      width: tableInnerW,
      height: metaBlockH,
      color: greenHeader,
      borderColor: greenSoft,
      borderWidth: 0.8,
    });
    const colW = tableInnerW / 3;
    const pad = 10;
    const fields = [
      [
        ['Kunde / customer', payload.kunde || payload.customer_name || ''],
        ['FN', payload.fabrikationsnummer || ''],
        ['Projekt / project', payload.projekt || ''],
        ['Datum / date', formatDateDe(payload.durchfuehrungsdatum) || '–'],
      ],
      [
        ['Waagenart / scale type', payload.waagenart || 'Bandwaage'],
        ['Type / type', payload.type || ''],
        ['Leistung / value', payload.nennleistung || payload.leistung || ''],
        ['Elektronik / DWC', payload.elektronik || payload.dwc || ''],
      ],
      [
        ['Pos.Nr.', payload.pos_nr || ''],
        ['GN', payload.gn || ''],
        ['Servicetechniker', payload.monteur_name || payload.technician_name || '–'],
      ],
    ];
    fields.forEach((group, gi) => {
      const gx = marginX + gi * colW + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(clipText(font, label, 6.5, colW - pad * 2), {
          x: gx,
          y: gy,
          size: 6.5,
          font,
          color: grayMuted,
        });
        page.drawText(clipText(fontBold, String(val || '').trim() || '–', 9, colW - pad * 2), {
          x: gx,
          y: gy - 11,
          size: 9,
          font: fontBold,
          color: grayText,
        });
        gy -= 26;
      });
    });
    return boxY - 12;
  }

  const sectionTitleH = 16;

  function drawSectionTitle(page, yStart, titleDe, titleEn) {
    page.drawText(titleDe, {
      x: marginX,
      y: yStart - 12,
      size: 10,
      font: fontBold,
      color: greenDark,
    });
    if (titleEn) {
      const tw = fontBold.widthOfTextAtSize(titleDe, 10);
      page.drawText(' / ' + titleEn, {
        x: marginX + tw,
        y: yStart - 12,
        size: 8,
        font,
        color: grayMuted,
      });
    }
    return yStart - sectionTitleH;
  }

  function drawKettenDaten(page, yStart) {
    yStart = drawSectionTitle(page, yStart, 'Ketten Daten', 'chain data');
    const listRaw = Array.isArray(payload.ketten) ? payload.ketten : [];
    const list = listRaw.length
      ? listRaw
      : [{
          tag: '',
          ketten_type: payload.ketten_type || '',
          laenge: payload.ketten_laenge || '',
          gewicht_pro_kette: payload.gewicht_pro_kette || '',
          gewicht_pro_meter: payload.gewicht_pro_meter || '',
          in_summe: true,
        }];
    const marked = list.filter((k) => !(k && (k.in_summe === false || k.in_summe === 0 || k.in_summe === '0')));
    const rows = marked.length ? marked : list;

    const colsK = [
      { key: 'nr', label: 'Nr.', sub: 'No.', w: 28, align: 'center' },
      { key: 'tag', label: 'Tag (Name)', sub: 'tag', w: 140, align: 'left' },
      { key: 'ketten_type', label: 'Ketten Type', sub: 'chain type', w: 90, align: 'left' },
      { key: 'laenge', label: 'Laenge', sub: 'length', w: 90, align: 'right', digits: 3 },
      { key: 'gewicht_pro_kette', label: 'Gewicht / Kette', sub: 'weight / chain', w: 110, align: 'right', digits: 3 },
      { key: 'gewicht_pro_meter', label: 'Gewicht / Meter', sub: 'weight / m', w: 0, align: 'right', digits: 4 },
    ];
    const fixedK = colsK.reduce((s, c) => s + (c.key === 'gewicht_pro_meter' ? 0 : c.w), 0);
    colsK.forEach((c) => {
      if (c.key === 'gewicht_pro_meter') c.w = Math.max(100, tableInnerW - fixedK);
    });

    let sumLaenge = 0;
    let sumGewicht = 0;
    let sumMeter = 0;
    let nLaenge = 0;
    let nGewicht = 0;
    let nMeter = 0;
    rows.forEach((row) => {
      const laenge = parseLocaleNumber(row.laenge);
      const gewicht = parseLocaleNumber(row.gewicht_pro_kette);
      const meter = parseLocaleNumber(row.gewicht_pro_meter);
      if (laenge != null) { sumLaenge += laenge; nLaenge += 1; }
      if (gewicht != null) { sumGewicht += gewicht; nGewicht += 1; }
      if (meter != null) { sumMeter += meter; nMeter += 1; }
    });
    const sumMeterVal = nMeter
      ? sumMeter
      : (nLaenge && nGewicht && sumLaenge !== 0 ? sumGewicht / sumLaenge : null);

    function ketteCellValue(row, col, idx) {
      if (col.key === 'nr') return String(idx + 1);
      if (col.key === 'tag') return String(row.tag || '').trim();
      if (col.key === 'ketten_type') return String(row.ketten_type || '').trim();
      if (col.digits != null) return formatDeNumber(row[col.key], col.digits);
      return String(row[col.key] || '').trim();
    }
    function ketteSumCellValue(col) {
      if (col.key === 'nr') return 'Sum';
      if (col.key === 'tag') return 'Summe';
      if (col.key === 'ketten_type') return '';
      if (col.key === 'laenge') return nLaenge ? formatDeNumber(sumLaenge, 3) : '';
      if (col.key === 'gewicht_pro_kette') return nGewicht ? formatDeNumber(sumGewicht, 3) : '';
      if (col.key === 'gewicht_pro_meter') return sumMeterVal != null ? formatDeNumber(sumMeterVal, 4) : '';
      return '';
    }

    let y = yStart;
    // Table header (same style as Messungen)
    y -= headerH;
    page.drawRectangle({ x: marginX, y, width: tableInnerW, height: headerH, color: green });
    let x = marginX;
    colsK.forEach((col) => {
      const label = clipText(fontBold, col.label, 7, col.w - 4);
      const sub = clipText(font, col.sub, 5.5, col.w - 4);
      let lx = x + 3;
      if (col.align === 'right') lx = x + col.w - 3 - fontBold.widthOfTextAtSize(label, 7);
      else if (col.align === 'center') lx = x + (col.w - fontBold.widthOfTextAtSize(label, 7)) / 2;
      page.drawText(label, { x: Math.max(x + 1, lx), y: y + 15, size: 7, font: fontBold, color: white });
      let sx = x + 3;
      if (col.align === 'right') sx = x + col.w - 3 - font.widthOfTextAtSize(sub, 5.5);
      else if (col.align === 'center') sx = x + (col.w - font.widthOfTextAtSize(sub, 5.5)) / 2;
      page.drawText(sub, {
        x: Math.max(x + 1, sx),
        y: y + 5,
        size: 5.5,
        font,
        color: rgb(0.85, 0.95, 0.9),
      });
      x += col.w;
    });
    const tableTop = y + headerH;

    function drawKetteDataRow(yTop, row, idx, isSum) {
      const rowY = yTop - rowH;
      if (isSum) {
        page.drawRectangle({ x: marginX, y: rowY, width: tableInnerW, height: rowH, color: sumBg });
      }
      page.drawLine({
        start: { x: marginX, y: rowY },
        end: { x: marginX + tableInnerW, y: rowY },
        thickness: 0.7,
        color: isSum ? green : lineGray,
      });
      let cx = marginX;
      colsK.forEach((col) => {
        const raw = isSum ? ketteSumCellValue(col) : ketteCellValue(row, col, idx);
        const useFont = isSum || col.key === 'nr' ? fontBold : font;
        const text = clipText(useFont, raw, 7.5, col.w - 5);
        let tx = cx + 3;
        if (col.align === 'right') tx = cx + col.w - 3 - useFont.widthOfTextAtSize(text, 7.5);
        else if (col.align === 'center') tx = cx + (col.w - useFont.widthOfTextAtSize(text, 7.5)) / 2;
        page.drawText(text, {
          x: Math.max(cx + 1, tx),
          y: rowY + 5.5,
          size: 7.5,
          font: useFont,
          color: isSum ? greenDark : grayText,
        });
        cx += col.w;
      });
      return rowY;
    }

    rows.forEach((row, idx) => {
      y = drawKetteDataRow(y, row, idx, false);
    });
    y = drawKetteDataRow(y, {}, 0, true);
    const tableBottom = y;

    let vx = marginX;
    colsK.forEach((col, ci) => {
      if (ci > 0) {
        page.drawLine({
          start: { x: vx, y: tableBottom },
          end: { x: vx, y: tableTop },
          thickness: 0.35,
          color: lineGray,
        });
      }
      vx += col.w;
    });
    page.drawRectangle({
      x: marginX,
      y: tableBottom,
      width: tableInnerW,
      height: Math.max(0, tableTop - tableBottom),
      borderColor: green,
      borderWidth: 0.9,
    });
    return tableBottom - 10;
  }

  function drawTableHeader(page, yTop) {
    const y = yTop - headerH;
    page.drawRectangle({ x: marginX, y, width: tableInnerW, height: headerH, color: green });
    let x = marginX;
    cols.forEach((col) => {
      const label = clipText(fontBold, col.label, 7, col.w - 4);
      const sub = clipText(font, col.sub, 5.5, col.w - 4);
      let lx = x + 3;
      if (col.align === 'right') lx = x + col.w - 3 - fontBold.widthOfTextAtSize(label, 7);
      else if (col.align === 'center') lx = x + (col.w - fontBold.widthOfTextAtSize(label, 7)) / 2;
      page.drawText(label, { x: Math.max(x + 1, lx), y: y + 15, size: 7, font: fontBold, color: white });
      let sx = x + 3;
      if (col.align === 'right') sx = x + col.w - 3 - font.widthOfTextAtSize(sub, 5.5);
      else if (col.align === 'center') sx = x + (col.w - font.widthOfTextAtSize(sub, 5.5)) / 2;
      page.drawText(sub, {
        x: Math.max(x + 1, sx),
        y: y + 5,
        size: 5.5,
        font,
        color: rgb(0.85, 0.95, 0.9),
      });
      x += col.w;
    });
    return y;
  }

  function drawDataRow(page, yTop, row, idx, isSum) {
    const y = yTop - rowH;
    if (isSum) {
      page.drawRectangle({ x: marginX, y, width: tableInnerW, height: rowH, color: sumBg });
    }
    page.drawLine({
      start: { x: marginX, y },
      end: { x: marginX + tableInnerW, y },
      thickness: 0.7,
      color: isSum ? green : lineGray,
    });
    let x = marginX;
    cols.forEach((col) => {
      const raw = isSum ? sumCellValue(col) : cellValue(row, col, idx);
      const useFont = isSum || col.key === 'nr' ? fontBold : font;
      const text = clipText(useFont, raw, 7.5, col.w - 5);
      let tx = x + 3;
      if (col.align === 'right') tx = x + col.w - 3 - useFont.widthOfTextAtSize(text, 7.5);
      else if (col.align === 'center') tx = x + (col.w - useFont.widthOfTextAtSize(text, 7.5)) / 2;
      page.drawText(text, {
        x: Math.max(x + 1, tx),
        y: y + 5.5,
        size: 7.5,
        font: useFont,
        color: isSum ? greenDark : grayText,
      });
      x += col.w;
    });
    return y;
  }

  function drawFooter(page, pageIndex, pageCount, isLast) {
    const footerLineY = marginBottom + 22;
    page.drawLine({
      start: { x: marginX, y: footerLineY },
      end: { x: PAGE_W - marginX, y: footerLineY },
      thickness: 0.6,
      color: greenSoft,
    });
    if (isLast) {
      page.drawText('Pruefer / tester: ____________________________', {
        x: marginX,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
      page.drawText('Datum: ' + pdfFooterCreatedDateDe(payload), {
        x: marginX + 260,
        y: marginBottom,
        size: 8,
        font,
        color: grayMuted,
      });
    }
    const pageLabel = 'Seite ' + (pageIndex + 1) + ' / ' + pageCount;
    const tw = font.widthOfTextAtSize(pageLabel, 8);
    page.drawText(pageLabel, {
      x: PAGE_W - marginX - tw,
      y: marginBottom,
      size: 8,
      font,
      color: grayMuted,
    });
  }

  const kettenListForH = Array.isArray(payload.ketten) && payload.ketten.length
    ? payload.ketten.filter((k) => !(k && (k.in_summe === false || k.in_summe === 0 || k.in_summe === '0')))
    : [{}];
  const kettenRowsForH = kettenListForH.length ? kettenListForH : [{}];
  const kettenBlockH = sectionTitleH + headerH + (kettenRowsForH.length + 1) * rowH + 10;
  const contentTop = PAGE_H - marginTop - 52 - 14 - metaBlockH - 12 - kettenBlockH - sectionTitleH;
  const rowsPerPage = Math.max(1, Math.floor((contentTop - marginBottom - 22 - headerH) / rowH));
  const pagesPlan = [];
  let remaining = dataRows.slice();
  if (!remaining.length) {
    pagesPlan.push({ rows: [], withSum: false });
  } else {
    while (remaining.length > 0) {
      const left = remaining.length;
      const sumSlot = sums.any ? 1 : 0;
      if (left + sumSlot <= rowsPerPage) {
        pagesPlan.push({ rows: remaining.splice(0), withSum: !!sums.any });
      } else {
        pagesPlan.push({ rows: remaining.splice(0, rowsPerPage), withSum: false });
      }
    }
    if (sums.any && pagesPlan.length && !pagesPlan[pagesPlan.length - 1].withSum) {
      pagesPlan.push({ rows: [], withSum: true });
    }
  }

  pagesPlan.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = drawHeader(page);
    y = drawMeta(page, y);
    y = drawKettenDaten(page, y);
    y = drawSectionTitle(page, y, 'Messungen', 'measurements');
    const tableTop = y;
    y = drawTableHeader(page, y);
    plan.rows.forEach((row, i) => {
      const globalIdx = dataRows.indexOf(row);
      y = drawDataRow(page, y, row, globalIdx >= 0 ? globalIdx : i, false);
    });
    if (plan.withSum && sums.any) y = drawDataRow(page, y, {}, 0, true);
    const tableBottom = y;
    let vx = marginX;
    cols.forEach((col, ci) => {
      if (ci > 0) {
        page.drawLine({
          start: { x: vx, y: tableBottom },
          end: { x: vx, y: tableTop },
          thickness: 0.35,
          color: lineGray,
        });
      }
      vx += col.w;
    });
    page.drawRectangle({
      x: marginX,
      y: tableBottom,
      width: tableInnerW,
      height: Math.max(0, tableTop - tableBottom),
      borderColor: green,
      borderWidth: 0.9,
    });
    if (sigImg && pageIndex === pagesPlan.length - 1) {
      const maxW = 140;
      const maxH = 36;
      const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
      const iw = sigImg.width * scale;
      const ih = sigImg.height * scale;
      page.drawText('Unterschrift / Signature', {
        x: marginX,
        y: marginBottom + 18,
        size: 7,
        font,
        color: grayMuted,
      });
      page.drawImage(sigImg, { x: marginX + 130, y: marginBottom + 6, width: iw, height: ih });
    }
    drawFooter(page, pageIndex, pagesPlan.length, pageIndex === pagesPlan.length - 1);
  });

  return Buffer.from(await pdfDoc.save());
}

function decodeHtmlEntitiesPdf(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\u00a0/g, ' ');
}

function sanitizePdfText(text, unicodeCapable) {
  let s = String(text || '')
    .replace(/\u2211/g, 'Sum')
    .replace(/\u2026/g, '...')
    .replace(/[\u2013\u2014]/g, '-')
    // Aufzaehlungszeichen → Unicode BULLET
    .replace(/[\u2022\u2023\u2043\u2219\u25CF\u25CB\u25E6\u25AA\u25AB\u25A0\u25A1\u25BA\u25B8\u25B6\u25C6\u25C7\u25CA\u00B7\u2024\u30FB\uFF65]/g, '\u2022')
    .replace(/[\uF0A7\uF0B7\uF0D8\uF0FC\uF0E0\uF02D]/g, '\u2022')
    .replace(/\u00a0/g, ' ');
  if (unicodeCapable) {
    // BMP-Buchstaben/Diakritika behalten (z. B. ū ņ š); nur Steuer-/Private-Use bereinigen
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[\uF000-\uF8FF]/g, '\u2022');
  }
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF\u2022]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0x2000 && code <= 0x206f) return '\u2022';
    if (code >= 0x25a0 && code <= 0x25ff) return '\u2022';
    if (code >= 0xf000 && code <= 0xf0ff) return '\u2022';
    return '?';
  });
}

/** @deprecated Alias – nutzt WinAnsi-Fallback */
function sanitizePdfWinAnsi(text) {
  return sanitizePdfText(text, false);
}

function htmlFragmentToPlainPdf(html) {
  return decodeHtmlEntitiesPdf(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\u2022 ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Richtext (HTML oder Plain) → Zeichenblöcke + Bild-Blöcke (data-URL).
 */
function htmlToMbContentBlocks(html, plainFallback, unicodeCapable) {
  const uni = !!unicodeCapable;
  const raw = String(html || '').trim();
  if (!raw) {
    const p = String(plainFallback || '').trim();
    return p ? [{ type: 'text', text: sanitizePdfText(p, uni) }] : [];
  }
  if (!/<[a-z]/i.test(raw)) {
    return [{ type: 'text', text: sanitizePdfText(decodeHtmlEntitiesPdf(raw), uni) }];
  }
  const blocks = [];
  const re = /<img\b[^>]*>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    const before = htmlFragmentToPlainPdf(raw.slice(last, m.index));
    if (before) blocks.push({ type: 'text', text: sanitizePdfText(before, uni) });
    const tag = m[0];
    const srcM = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    let widthPct = 100;
    const styleW = tag.match(/width\s*:\s*([\d.]+)\s*%/i);
    const attrW = tag.match(/\bwidth\s*=\s*["']([\d.]+)%["']/i);
    if (styleW) widthPct = Math.min(100, Math.max(10, parseFloat(styleW[1]) || 100));
    else if (attrW) widthPct = Math.min(100, Math.max(10, parseFloat(attrW[1]) || 100));
    if (srcM && srcM[1]) {
      blocks.push({ type: 'image', src: decodeHtmlEntitiesPdf(srcM[1].trim()), widthPct });
    }
    last = m.index + m[0].length;
  }
  const after = htmlFragmentToPlainPdf(raw.slice(last));
  if (after) blocks.push({ type: 'text', text: sanitizePdfText(after, uni) });
  if (!blocks.length) {
    const plain = htmlFragmentToPlainPdf(raw) || String(plainFallback || '').trim();
    if (plain) blocks.push({ type: 'text', text: sanitizePdfText(plain, uni) });
  }
  return blocks;
}

async function embedContentImage(pdfDoc, src) {
  const rawSrc = String(src || '').trim();
  const m = rawSrc.match(/^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  let type = m[1].toLowerCase();
  if (type === 'jpeg') type = 'jpg';
  let bytes;
  try {
    bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    return null;
  }
  if (!bytes || bytes.length < 32) return null;

  const tryEmbed = async (buf, t) => {
    if (t === 'png') return pdfDoc.embedPng(buf);
    return pdfDoc.embedJpg(buf);
  };

  if (type === 'webp' || type === 'gif') {
    try {
      const sharp = require('sharp');
      bytes = await sharp(bytes).rotate().png().toBuffer();
      type = 'png';
    } catch (_) {
      return null;
    }
  }

  // Große Fotos herunterskalieren → schnelleres Speichern / kleinere PDFs
  try {
    const sharp = require('sharp');
    const meta = await sharp(bytes).metadata();
    const w = meta.width || 0;
    if (w > 1400) {
      bytes = await sharp(bytes)
        .rotate()
        .resize({ width: 1400, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      type = 'jpg';
    }
  } catch (_) { /* Original belassen */ }

  try {
    return await tryEmbed(bytes, type === 'png' ? 'png' : 'jpg');
  } catch (_) {
    try {
      const sharp = require('sharp');
      const png = await sharp(bytes).png().toBuffer();
      return await pdfDoc.embedPng(png);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Montagebericht – A4 Hochformat, Corporate-Layout wie Serviceprotokoll.
 * payload: { kopfdaten, tableRows, grundDesEinsatzes, grundDesEinsatzes_html, freitext }
 * options: { lang: 'de'|'en' }
 */
async function generateMontageberichtPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const fonts = await embedProtocolFonts(pdfDoc);
  const font = fonts.font;
  const fontBold = fonts.fontBold;
  const unicodeOk = !!fonts.unicode;
  const S = (t) => sanitizePdfText(t, unicodeOk);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginX = 32;
  const marginTop = 24;
  const marginBottom = 40;
  const green = rgb(14 / 255, 123 / 255, 90 / 255);
  const greenDark = rgb(12 / 255, 106 / 255, 77 / 255);
  const greenSoft = rgb(207 / 255, 232 / 255, 209 / 255);
  const greenHeader = rgb(232 / 255, 244 / 255, 236 / 255);
  const grayText = rgb(0.25, 0.25, 0.25);
  const grayMuted = rgb(0.45, 0.45, 0.45);
  const lineGray = rgb(0.78, 0.82, 0.8);
  const white = rgb(1, 1, 1);
  const tableInnerW = PAGE_W - marginX * 2;
  const headerBandH = 52;
  const metaBlockH = 118;
  const contentBottom = marginBottom + 28;

  const L = {
    title: de ? 'Montagebericht' : 'Assembly report',
    titleSub: de ? 'assembly report' : 'Montagebericht',
    kunde: de ? 'Kunde / customer' : 'Customer',
    geliefert: de ? 'geliefert ueber' : 'Delivered via',
    projekt: de ? 'Projekt / project' : 'Project',
    datum: de ? 'Datum / date' : 'Date',
    fn: 'FN',
    tech: de ? 'Servicetechniker' : 'Service engineer',
    contact: de ? 'Ansprechperson' : 'Contact person',
    grund: de ? 'Grund des Einsatzes' : 'Purpose of visit',
    bemerk: de ? 'Bemerkungen' : 'Remarks',
    type: de ? 'Type' : 'Type',
    pos: de ? 'Pos.Nr.' : 'Pos. no.',
    page: de ? 'Seite' : 'Page',
  };

  const kopf = (payload && payload.kopfdaten) || {};
  const tableRows = Array.isArray(payload && payload.tableRows) ? payload.tableRows : [];
  const kunde = S(kopf.kunde || '').trim();
  const projekt = S(kopf.projekt || '').trim();
  const datumVal = S(kopf.datum || '').trim();
  const geliefertUeber = S(kopf.geliefertUeber || '').trim();
  const servicetechniker = S(kopf.servicetechniker || '').trim();
  const ansprechperson = S(kopf.ansprechperson || '').trim();
  const fnList = tableRows
    .map((r) => String((r && r.fabrikationsnummer) || '').trim())
    .filter(Boolean)
    .join(', ');

  let grundPlain = String((payload && payload.grundDesEinsatzes) || '').trim();
  const freitext = String((payload && payload.freitext) || '').trim();
  if (freitext) grundPlain = (grundPlain ? grundPlain + ' ' : '') + freitext;
  const grundHtml = String((payload && payload.grundDesEinsatzes_html) || '').trim();
  const bemerkPlain = String(kopf.bemerkungen || '').trim();
  const bemerkHtml = String(kopf.bemerkungen_html || '').trim();

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload && payload.technician_signature_png);

  async function resolveBlocks(html, plain) {
    const rawBlocks = htmlToMbContentBlocks(html, plain, unicodeOk);
    const out = [];
    for (const b of rawBlocks) {
      if (b.type === 'text') {
        if (b.text) out.push(b);
        continue;
      }
      if (b.type === 'image') {
        const img = await embedContentImage(pdfDoc, b.src);
        if (img) out.push({ type: 'image', img, widthPct: b.widthPct || 100 });
      }
    }
    return out;
  }

  const grundBlocks = await resolveBlocks(grundHtml, grundPlain);
  const bemerkBlocks = await resolveBlocks(bemerkHtml, bemerkPlain);
  const fnSections = [];
  for (const row of tableRows) {
    const fn = String((row && row.fabrikationsnummer) || '').trim();
    const type = S((row && row.type) || '').trim();
    const position = S((row && row.position) || '').trim();
    let html = String((row && row.bemerkungen_html) || '').trim();
    let plain = String((row && row.bemerkungen) || '').trim();
    if (!html && Array.isArray(row && row.textbausteine) && row.textbausteine.length) {
      const parts = row.textbausteine
        .map((t) => {
          const h = String((t && t.html) || '').trim();
          if (h) return h;
          const tx = String((t && t.text) || '').trim();
          return tx ? '<p>' + tx.replace(/</g, '&lt;') + '</p>' : '';
        })
        .filter(Boolean);
      if (parts.length) html = parts.join('');
      if (!plain) {
        plain = row.textbausteine
          .map((t) => String((t && t.text) || '').trim())
          .filter(Boolean)
          .join('\n');
      }
    }
    const blocks = await resolveBlocks(html, plain);
    fnSections.push({ fn, type, position, blocks });
  }

  function drawPageChrome(page) {
    let y = PAGE_H - marginTop;
    if (logo) {
      const maxH = 40;
      const maxW = 110;
      const scale = Math.min(maxW / logo.width, maxH / logo.height);
      const lw = logo.width * scale;
      const lh = logo.height * scale;
      page.drawImage(logo, { x: marginX, y: y - lh, width: lw, height: lh });
    } else {
      page.drawText('KUKLA', { x: marginX, y: y - 18, size: 14, font: fontBold, color: green });
    }
    page.drawText(L.title, {
      x: marginX + 130,
      y: y - 16,
      size: 17,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(L.titleSub, {
      x: marginX + 130,
      y: y - 32,
      size: 9,
      font,
      color: grayMuted,
    });
    const addrLines = [
      'KUKLA Waagenfabrik GmbH & Co KG',
      'Fadingerstr. 1-11 · 4840 Voecklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = y - 12;
    addrLines.forEach((line) => {
      const tw = font.widthOfTextAtSize(line, 7);
      page.drawText(line, { x: PAGE_W - marginX - tw, y: ay, size: 7, font, color: grayMuted });
      ay -= 9;
    });
    y -= headerBandH;
    page.drawRectangle({
      x: marginX,
      y: y - 3,
      width: tableInnerW,
      height: 3,
      color: green,
    });
    return y - 12;
  }

  function drawMeta(page, yStart) {
    const boxY = yStart - metaBlockH;
    page.drawRectangle({
      x: marginX,
      y: boxY,
      width: tableInnerW,
      height: metaBlockH,
      color: greenHeader,
      borderColor: greenSoft,
      borderWidth: 0.8,
    });
    const pad = 10;
    const fields2 = [
      [
        [L.kunde, kunde],
        [L.projekt, projekt],
        [L.fn, fnList],
        [L.datum, datumVal || '–'],
      ],
      [
        [L.geliefert, geliefertUeber],
        [L.tech, servicetechniker],
        [L.contact, ansprechperson],
      ],
    ];
    fields2.forEach((group, gi) => {
      const gx = marginX + gi * (tableInnerW / 2) + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(clipText(font, label, 6.5, tableInnerW / 2 - pad * 2), {
          x: gx,
          y: gy,
          size: 6.5,
          font,
          color: grayMuted,
        });
        page.drawText(clipText(fontBold, String(val || '').trim() || '–', 9, tableInnerW / 2 - pad * 2), {
          x: gx,
          y: gy - 11,
          size: 9,
          font: fontBold,
          color: grayText,
        });
        gy -= 26;
      });
    });
    return boxY - 14;
  }

  function drawFooter(page, pageIndex, pageCount) {
    const footerLineY = marginBottom + 22;
    page.drawLine({
      start: { x: marginX, y: footerLineY },
      end: { x: PAGE_W - marginX, y: footerLineY },
      thickness: 0.6,
      color: greenSoft,
    });
    const pageLabel = L.page + ' ' + (pageIndex + 1) + ' / ' + pageCount;
    const tw = font.widthOfTextAtSize(pageLabel, 8);
    page.drawText(pageLabel, {
      x: PAGE_W - marginX - tw,
      y: marginBottom,
      size: 8,
      font,
      color: grayMuted,
    });
  }

  function measureTextHeight(text, size, lineH, maxW) {
    const raw = String(text || '');
    if (!raw) return lineH;
    const paragraphs = raw.split('\n');
    let lines = 0;
    paragraphs.forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines += 1;
        return;
      }
      let line = '';
      words.forEach((word) => {
        const test = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(test, size) > maxW && line) {
          lines += 1;
          line = word;
        } else {
          line = test;
        }
      });
      if (line) lines += 1;
    });
    return Math.max(lineH, lines * lineH);
  }

  // Build draw queue
  const queue = [];
  queue.push({ type: 'section', title: L.grund });
  if (grundBlocks.length) {
    grundBlocks.forEach((b) => queue.push(b));
  } else {
    queue.push({ type: 'text', text: '–' });
  }
  fnSections.forEach((sec) => {
    queue.push({
      type: 'fn_header',
      fn: sec.fn || '–',
      typeVal: sec.type || '–',
      pos: sec.position || '–',
    });
    if (sec.blocks.length) sec.blocks.forEach((b) => queue.push(b));
    else queue.push({ type: 'text', text: '–' });
    queue.push({ type: 'fn_sep' });
  });
  queue.push({ type: 'section', title: L.bemerk });
  if (bemerkBlocks.length) {
    bemerkBlocks.forEach((b) => queue.push(b));
  } else {
    queue.push({ type: 'text', text: '–' });
  }

  const pages = [];
  let page = null;
  let y = 0;
  let firstPage = true;

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = drawPageChrome(page);
    if (firstPage) {
      y = drawMeta(page, y);
      firstPage = false;
    }
  }

  function needSpace(h) {
    if (!page) newPage();
    if (y - h < contentBottom) {
      newPage();
    }
  }

  function estimateItemHeight(item) {
    if (item.type === 'section') return 18;
    if (item.type === 'fn_header') return 28;
    if (item.type === 'fn_sep') return 14;
    if (item.type === 'text') return measureTextHeight(item.text, 9, 12, tableInnerW) + 6;
    if (item.type === 'image' && item.img) {
      const maxW = tableInnerW * ((item.widthPct || 100) / 100);
      const scale = Math.min(1, maxW / item.img.width);
      return item.img.height * scale + 10;
    }
    return 12;
  }

  newPage();
  queue.forEach((item) => {
    const h = estimateItemHeight(item);
    needSpace(Math.min(h, 120));
    if (item.type === 'section') {
      page.drawText(item.title, { x: marginX, y: y, size: 10, font: fontBold, color: greenDark });
      y -= 14;
      return;
    }
    if (item.type === 'fn_sep') {
      needSpace(12);
      y -= 4;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: marginX + tableInnerW, y },
        thickness: 0.6,
        color: greenSoft,
      });
      y -= 10;
      return;
    }
    if (item.type === 'fn_header') {
      const boxH = 22;
      needSpace(boxH + 8);
      page.drawRectangle({
        x: marginX,
        y: y - boxH,
        width: tableInnerW,
        height: boxH,
        color: green,
      });
      const colW = tableInnerW / 3;
      const padX = 8;
      const textY = y - 15;
      const size = 9;
      const leftTxt = clipText(fontBold, 'FN. ' + S(item.fn), size, colW - padX * 2);
      const midTxt = clipText(
        fontBold,
        L.type + ': ' + S(item.typeVal),
        size,
        colW - padX * 2,
      );
      const rightTxt = clipText(
        fontBold,
        L.pos + ': ' + S(item.pos),
        size,
        colW - padX * 2,
      );
      page.drawText(leftTxt, {
        x: marginX + padX,
        y: textY,
        size,
        font: fontBold,
        color: white,
      });
      const midW = fontBold.widthOfTextAtSize(midTxt, size);
      page.drawText(midTxt, {
        x: marginX + colW + (colW - midW) / 2,
        y: textY,
        size,
        font: fontBold,
        color: white,
      });
      const rightW = fontBold.widthOfTextAtSize(rightTxt, size);
      page.drawText(rightTxt, {
        x: marginX + colW * 2 + colW - padX - rightW,
        y: textY,
        size,
        font: fontBold,
        color: white,
      });
      y -= boxH + 8;
      return;
    }
    if (item.type === 'text') {
      const size = 9;
      const lineH = 12;
      const maxW = tableInnerW;
      const paragraphs = String(item.text || '').split('\n');
      paragraphs.forEach((para, pi) => {
        const words = para.split(/\s+/).filter(Boolean);
        if (!words.length) {
          needSpace(lineH);
          y -= lineH;
          return;
        }
        let line = '';
        const flush = () => {
          if (!line) return;
          needSpace(lineH + 2);
          page.drawText(line, { x: marginX, y, size, font, color: grayText });
          y -= lineH;
          line = '';
        };
        words.forEach((word) => {
          const test = line ? line + ' ' + word : word;
          if (font.widthOfTextAtSize(test, size) > maxW && line) {
            flush();
            line = word;
          } else {
            line = test;
          }
        });
        flush();
        if (pi < paragraphs.length - 1) {
          /* paragraph gap already via empty lines */
        }
      });
      y -= 6;
      return;
    }
    if (item.type === 'image' && item.img) {
      const maxW = tableInnerW * ((item.widthPct || 100) / 100);
      const scale = Math.min(1, maxW / item.img.width);
      let iw = item.img.width * scale;
      let ih = item.img.height * scale;
      const maxH = Math.max(80, y - contentBottom - 4);
      if (ih > maxH) {
        const s2 = maxH / ih;
        iw *= s2;
        ih *= s2;
      }
      needSpace(ih + 8);
      page.drawImage(item.img, {
        x: marginX,
        y: y - ih,
        width: iw,
        height: ih,
      });
      y -= ih + 10;
    }
  });

  if (sigImg) {
    const maxW = 160;
    const maxH = 48;
    const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
    const iw = sigImg.width * scale;
    const ih = sigImg.height * scale;
    needSpace(ih + 28);
    page.drawText(S(de ? 'Unterschrift Servicetechniker' : 'Technician signature'), {
      x: marginX,
      y: y - 10,
      size: 8,
      font: fontBold,
      color: greenDark,
    });
    y -= 16;
    page.drawImage(sigImg, { x: marginX, y: y - ih, width: iw, height: ih });
    y -= ih + 8;
    if (servicetechniker) {
      page.drawText(S(servicetechniker), {
        x: marginX,
        y: y - 10,
        size: 8,
        font,
        color: grayText,
      });
    }
  }

  pages.forEach((p, i) => {
    drawFooter(p, i, pages.length);
  });

  return Buffer.from(await pdfDoc.save());
}

/**
 * Hersteller-Prüfzertifikat A4 Hochkant, bilingual (options.lang = 'de'|'en').
 */
async function generatePruefzertifikatPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const fonts = await embedProtocolFonts(pdfDoc);
  const font = fonts.font;
  const fontBold = fonts.fontBold;
  const unicodeOk = !!fonts.unicode;
  const S = (v) => sanitizePdfText(v, unicodeOk);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginX = 36;
  const marginTop = 28;
  const marginBottom = 42;
  const green = rgb(14 / 255, 123 / 255, 90 / 255);
  const greenDark = rgb(12 / 255, 106 / 255, 77 / 255);
  const greenSoft = rgb(207 / 255, 232 / 255, 209 / 255);
  const greenHeader = rgb(232 / 255, 244 / 255, 236 / 255);
  const grayText = rgb(0.22, 0.22, 0.22);
  const grayMuted = rgb(0.45, 0.45, 0.45);
  const white = rgb(1, 1, 1);
  const tableInnerW = PAGE_W - marginX * 2;

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const t = (a, b) => (de ? a : b);
  const str = (v) => (v == null ? '' : String(v).trim());
  const fmtPct = (v) => {
    if (v == null || v === '') return '–';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return str(v);
    return (Math.round(n * 1000) / 1000).toLocaleString(de ? 'de-DE' : 'en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    });
  };

  const ergebnisse =
    payload.ergebnisse && typeof payload.ergebnisse === 'object'
      ? payload.ergebnisse
      : (() => {
          try {
            return JSON.parse(payload.ergebnisse_json || '{}') || {};
          } catch (_) {
            return {};
          }
        })();
  const verfahren =
    payload.verfahren && typeof payload.verfahren === 'object'
      ? payload.verfahren
      : (() => {
          try {
            return JSON.parse(payload.verfahren_json || '{}') || {};
          } catch (_) {
            return {};
          }
        })();

  let statusBestanden = payload.status_bestanden;
  if (statusBestanden === '1' || statusBestanden === 1 || statusBestanden === true) statusBestanden = true;
  else if (statusBestanden === '0' || statusBestanden === 0 || statusBestanden === false) statusBestanden = false;
  else statusBestanden = null;

  const statusLabel =
    statusBestanden === true
      ? t('BESTANDEN', 'PASSED')
      : statusBestanden === false
        ? t('NICHT BESTANDEN', 'FAILED')
        : t('k. A.', 'n/a');

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - marginTop;

  // Outer frame
  page.drawRectangle({
    x: 18,
    y: 18,
    width: PAGE_W - 36,
    height: PAGE_H - 36,
    borderColor: green,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: 22,
    y: 22,
    width: PAGE_W - 44,
    height: PAGE_H - 44,
    borderColor: greenSoft,
    borderWidth: 1,
  });

  // Header bar
  page.drawRectangle({
    x: marginX,
    y: y - 52,
    width: tableInnerW,
    height: 52,
    color: greenHeader,
  });
  if (logo) {
    const lh = 36;
    const lw = (logo.width / logo.height) * lh;
    page.drawImage(logo, { x: marginX + 8, y: y - 44, width: lw, height: lh });
  }
  const title = t(
    'Hersteller-Prüfzertifikat',
    'Manufacturer Inspection Certificate',
  );
  const subtitle = t('Wiederkehrende Überprüfung', 'Recurring Verification');
  page.drawText(S(title), {
    x: marginX + 110,
    y: y - 22,
    size: 14,
    font: fontBold,
    color: greenDark,
  });
  page.drawText(S(subtitle), {
    x: marginX + 110,
    y: y - 38,
    size: 10,
    font,
    color: grayMuted,
  });
  y -= 68;

  const certNr = str(payload.zertifikat_nr) || '–';
  page.drawText(S(t('Zertifikatsnr.', 'Certificate no.') + ': ' + certNr), {
    x: marginX,
    y,
    size: 9,
    font: fontBold,
    color: grayText,
  });
  page.drawText(S(t('Bezug', 'Reference') + ': EU 2018/2066 Art. 60 (MRR)'), {
    x: marginX + 260,
    y,
    size: 8,
    font,
    color: grayMuted,
  });
  y -= 18;

  function drawMetaRow(label, value, x, yy, w) {
    page.drawText(S(label), { x, y: yy, size: 7.5, font, color: grayMuted });
    const val = str(value) || '–';
    const shown = val.length > 42 ? val.slice(0, 41) + '…' : val;
    page.drawText(S(shown), {
      x,
      y: yy - 12,
      size: 10,
      font: fontBold,
      color: grayText,
    });
  }

  page.drawRectangle({
    x: marginX,
    y: y - 48,
    width: tableInnerW,
    height: 52,
    color: rgb(0.97, 0.99, 0.97),
    borderColor: greenSoft,
    borderWidth: 1,
  });
  drawMetaRow(t('Fabrikationsnummer', 'Serial / FN'), payload.fabrikationsnummer, marginX + 10, y - 6, 200);
  drawMetaRow(t('Prüfdatum', 'Inspection date'), payload.pruefdatum || payload.durchfuehrungsdatum, marginX + 280, y - 6, 200);
  drawMetaRow(t('Kunde', 'Customer'), payload.kunde || payload.customer_name, marginX + 10, y - 30, 200);
  drawMetaRow(t('Nächste Prüfung', 'Next inspection'), payload.naechste_pruefung, marginX + 280, y - 30, 200);
  y -= 60;

  // Plant data
  page.drawText(S(t('Anlagendaten', 'Equipment data')), {
    x: marginX,
    y,
    size: 11,
    font: fontBold,
    color: greenDark,
  });
  y -= 6;
  page.drawRectangle({ x: marginX, y: y - 1, width: 120, height: 2, color: green });
  y -= 16;

  const plantRows = [
    [t('Type', 'Type'), payload.type],
    [t('Pos.-Nr.', 'Pos. no.'), payload.pos_nr],
    [t('Elektronik / DWC', 'Electronics / DWC'), payload.elektronik || payload.dwc],
    [t('Nennleistung', 'Rated capacity'), payload.nennleistung || payload.leistung],
    [t('Waagenart', 'Scale type'), payload.waagenart || 'Bandwaage'],
    [t('Projekt / Auftrag', 'Project / Job'), payload.projekt || payload.job_number],
    [t('Standort', 'Site'), payload.standort],
  ];
  plantRows.forEach((row, idx) => {
    const bg = idx % 2 === 0 ? greenHeader : white;
    page.drawRectangle({ x: marginX, y: y - 14, width: tableInnerW, height: 16, color: bg });
    page.drawText(S(str(row[0])), { x: marginX + 6, y: y - 10, size: 8, font, color: grayMuted });
    page.drawText(S(str(row[1]) || '–'), { x: marginX + 200, y: y - 10, size: 9, font: fontBold, color: grayText });
    y -= 16;
  });
  y -= 12;

  // Methods
  page.drawText(S(t('Prüfverfahren', 'Inspection methods')), {
    x: marginX,
    y,
    size: 11,
    font: fontBold,
    color: greenDark,
  });
  y -= 16;
  const methods = [];
  if (verfahren.kontrollwiegung) methods.push(t('Kontrollwiegung', 'Control weighing'));
  if (verfahren.schleppketten) methods.push(t('Schleppketten-Test', 'Chain calibration test'));
  if (verfahren.service) methods.push(t('Serviceprotokoll', 'Service protocol'));
  page.drawText(S(methods.length ? methods.join('  ·  ') : '–'), {
    x: marginX,
    y,
    size: 9,
    font,
    color: grayText,
  });
  y -= 20;

  // Results table – nur aktive Verfahren
  const resultRows = [];
  if (verfahren.kontrollwiegung && ergebnisse.kontrollwiegung) {
    resultRows.push([
      t('Kontrollwiegung', 'Control weighing'),
      String(ergebnisse.kontrollwiegung.anzahl != null ? ergebnisse.kontrollwiegung.anzahl : '–'),
      fmtPct(ergebnisse.kontrollwiegung.fehler_prozent),
      str(ergebnisse.kontrollwiegung.datum) || '–',
    ]);
  }
  if (verfahren.schleppketten && ergebnisse.schleppketten) {
    resultRows.push([
      t('Schleppketten-Test', 'Chain test'),
      String(ergebnisse.schleppketten.anzahl != null ? ergebnisse.schleppketten.anzahl : '–'),
      fmtPct(ergebnisse.schleppketten.fehler_prozent),
      str(ergebnisse.schleppketten.datum) || '–',
    ]);
  }
  if (verfahren.service) {
    resultRows.push([
      t('Serviceprotokoll', 'Service protocol'),
      '–',
      '–',
      '–',
    ]);
  }

  page.drawText(S(t('Ergebnisse', 'Results')), {
    x: marginX,
    y,
    size: 11,
    font: fontBold,
    color: greenDark,
  });
  y -= 6;
  page.drawRectangle({ x: marginX, y: y - 1, width: 80, height: 2, color: green });
  y -= 18;

  if (resultRows.length) {
    const resultHeaderH = 20;
    page.drawRectangle({
      x: marginX,
      y: y - resultHeaderH + 4,
      width: tableInnerW,
      height: resultHeaderH,
      color: green,
    });
    const colW = [tableInnerW * 0.4, tableInnerW * 0.2, tableInnerW * 0.2, tableInnerW * 0.2];
    const headers = [
      t('Verfahren', 'Method'),
      t('Anzahl', 'Count'),
      t('Fehler %', 'Error %'),
      t('Datum', 'Date'),
    ];
    let cx = marginX;
    headers.forEach((h, i) => {
      page.drawText(S(h), { x: cx + 4, y: y - 8, size: 8, font: fontBold, color: white });
      cx += colW[i];
    });
    y -= resultHeaderH;

    resultRows.forEach((r, idx) => {
      const bg = idx % 2 === 0 ? white : greenHeader;
      page.drawRectangle({ x: marginX, y: y - 14, width: tableInnerW, height: 16, color: bg, borderColor: greenSoft, borderWidth: 0.5 });
      let x = marginX;
      r.forEach((cell, i) => {
        page.drawText(S(String(cell)), { x: x + 4, y: y - 10, size: 9, font, color: grayText });
        x += colW[i];
      });
      y -= 16;
    });
    y -= 10;
  } else {
    page.drawText(S(t('Kein Prüfverfahren ausgewählt.', 'No inspection method selected.')), {
      x: marginX,
      y,
      size: 9,
      font,
      color: grayMuted,
    });
    y -= 16;
  }

  page.drawText(
    S(t('Zulässige Abweichung', 'Max. permissible error') + ': ± ' + fmtPct(payload.zulaessige_abweichung_pct) + ' %'),
    { x: marginX, y, size: 9, font: fontBold, color: grayText },
  );
  y -= 18;

  // Service: Messwerte Wägezelle + Prüfgewichtstest
  const serviceMess =
    verfahren.service && ergebnisse.service && typeof ergebnisse.service === 'object'
      ? ergebnisse.service
      : null;
  if (serviceMess) {
    const emptyCell = { kg: '', mv: '', ma: '', g_prozent: '' };
    const mm =
      serviceMess.mess_matrix && typeof serviceMess.mess_matrix === 'object'
        ? serviceMess.mess_matrix
        : {};
    const messDefs = [
      { key: 'dms', de: 'DMS entlastet', en: 'Load cell released' },
      { key: 'tara', de: 'Tara', en: 'Tare' },
      { key: 'pruefgewicht', de: 'Prüfgewicht', en: 'Test load' },
    ];
    const messRows = [];
    messDefs.forEach((d) => {
      const r = Object.assign({}, emptyCell, mm[d.key] || {});
      const has = ['kg', 'mv', 'ma', 'g_prozent'].some((k) => String(r[k] || '').trim() !== '');
      if (!has) return;
      messRows.push({
        label: t(d.de, d.en),
        kg: String(r.kg || '').trim(),
        mv: String(r.mv || '').trim(),
        ma: String(r.ma || '').trim(),
        g: String(r.g_prozent || '').trim(),
      });
    });
    if (messRows.length) {
      page.drawText(S(t('Messwerte Wägezelle', 'Load cell measurements')), {
        x: marginX,
        y,
        size: 10,
        font: fontBold,
        color: greenDark,
      });
      y -= 14;
      const mColW = [tableInnerW * 0.36, tableInnerW * 0.16, tableInnerW * 0.16, tableInnerW * 0.16, tableInnerW * 0.16];
      const mHeaders = [t('Messpunkt', 'Point'), 'kg', 'mV', 'mA', 'g %'];
      page.drawRectangle({
        x: marginX,
        y: y - 16,
        width: tableInnerW,
        height: 18,
        color: green,
      });
      let mx = marginX;
      mHeaders.forEach((h, i) => {
        page.drawText(S(h), { x: mx + 4, y: y - 10, size: 7.5, font: fontBold, color: white });
        mx += mColW[i];
      });
      y -= 18;
      messRows.forEach((row, idx) => {
        const bg = idx % 2 === 0 ? white : greenHeader;
        page.drawRectangle({
          x: marginX,
          y: y - 14,
          width: tableInnerW,
          height: 16,
          color: bg,
          borderColor: greenSoft,
          borderWidth: 0.5,
        });
        const cells = [row.label, row.kg || '–', row.mv || '–', row.ma || '–', row.g || '–'];
        let cx2 = marginX;
        cells.forEach((cell, i) => {
          page.drawText(S(String(cell)), {
            x: cx2 + 4,
            y: y - 10,
            size: 8,
            font: i === 0 ? font : fontBold,
            color: grayText,
          });
          cx2 += mColW[i];
        });
        y -= 16;
      });
      y -= 10;
    }

    const pgVals = normalizePruefgewichtstestVals(serviceMess.pruefgewichtstest);
    y = drawPruefgewichtstestRow(page, y, {
      vals: pgVals,
      de,
      marginX,
      tableInnerW,
      font,
      fontBold,
      green,
      greenDark,
      greenSoft,
      grayText,
      white,
      S,
      title: t('Prüfgewichtstest', 'Test with test load'),
    });
  }

  y -= 4;

  // Seal
  const sealW = 220;
  const sealH = 40;
  const sealX = marginX + (tableInnerW - sealW) / 2;
  page.drawRectangle({
    x: sealX,
    y: y - sealH,
    width: sealW,
    height: sealH,
    borderColor: green,
    borderWidth: 2.5,
    color: white,
  });
  const sealSize = 14;
  const sealLabel = S(statusLabel);
  const sealTw = fontBold.widthOfTextAtSize(sealLabel, sealSize);
  page.drawText(sealLabel, {
    x: sealX + (sealW - sealTw) / 2,
    y: y - sealH / 2 - 5,
    size: sealSize,
    font: fontBold,
    color: greenDark,
  });
  y -= sealH + 18;

  // Traceability
  page.drawText(S(t('Rückführbarkeit / Prüfmittel', 'Traceability / test means')), {
    x: marginX,
    y,
    size: 10,
    font: fontBold,
    color: greenDark,
  });
  y -= 14;
  const pruefmittel = str(payload.pruefmittel) || '–';
  page.drawText(S(pruefmittel.length > 90 ? pruefmittel.slice(0, 89) + '…' : pruefmittel), {
    x: marginX,
    y,
    size: 9,
    font,
    color: grayText,
  });
  y -= 14;
  if (verfahren.kontrollwiegung && str(payload.letzte_eichung_kontrollwaage)) {
    page.drawText(
      S(
        t('Letzte Eichung Kontrollwaage', 'Last verification of control scale') +
          ': ' +
          str(payload.letzte_eichung_kontrollwaage),
      ),
      { x: marginX, y, size: 8, font, color: grayMuted },
    );
    y -= 12;
  }
  y -= 6;

  // Conformity — EN-PDF immer englischen Standardtext (nicht DE-Formulartext)
  const KONFORM_DE =
    'Die Anlage wurde nach dem Herstellerverfahren der KUKLA Waagenfabrik GmbH & Co KG einer wiederkehrenden Überprüfung unterzogen. Dieses Hersteller-Prüfzertifikat (Manufacturer Inspection Certificate) dient als Nachweis der Qualitätssicherung der Messeinrichtung im Sinne von Art. 60 der Verordnung (EU) 2018/2066 (MRR). Es handelt sich nicht um eine akkreditierte Kalibrierung nach EN ISO/IEC 17025 und nicht um eine behördliche Eichung.';
  const KONFORM_EN =
    'The equipment was subjected to a recurring inspection according to the manufacturer procedure of KUKLA Waagenfabrik GmbH & Co KG. This Manufacturer Inspection Certificate serves as evidence of measuring equipment quality assurance pursuant to Art. 60 of Regulation (EU) 2018/2066 (MRR). It is not an accredited calibration under EN ISO/IEC 17025 and not an official legal metrology verification.';
  const konform = de
    ? str(payload.konformitaet_text) || KONFORM_DE
    : str(payload.konformitaet_text_en) || KONFORM_EN;

  page.drawText(S(t('Konformitätsaussage', 'Statement of conformity')), {
    x: marginX,
    y,
    size: 10,
    font: fontBold,
    color: greenDark,
  });
  y -= 14;

  const words = S(konform).split(/\s+/).filter(Boolean);
  let line = '';
  const maxW = tableInnerW;
  const flushLine = () => {
    if (!line) return;
    page.drawText(line, { x: marginX, y, size: 8, font, color: grayText });
    y -= 11;
    line = '';
  };
  words.forEach((word) => {
    const test = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(test, 8) > maxW && line) {
      flushLine();
      line = word;
    } else {
      line = test;
    }
  });
  flushLine();
  y -= 16;

  // Signatures
  page.drawText(S(t('Monteur / Technician', 'Technician') + ': ' + (str(payload.monteur_name) || '____________________')), {
    x: marginX,
    y,
    size: 9,
    font,
    color: grayText,
  });
  y -= 16;
  page.drawText(S(t('Datum', 'Date') + ': ' + (str(payload.pruefdatum) || '__________')), {
    x: marginX,
    y,
    size: 9,
    font,
    color: grayText,
  });
  if (sigImg) {
    y -= 14;
    page.drawText(S(t('Unterschrift', 'Signature')), {
      x: marginX,
      y,
      size: 8,
      font,
      color: grayMuted,
    });
    y -= 6;
    const maxW = 160;
    const maxH = 48;
    const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
    const iw = sigImg.width * scale;
    const ih = sigImg.height * scale;
    page.drawImage(sigImg, { x: marginX, y: y - ih, width: iw, height: ih });
    y -= ih + 4;
  }

  // Footer
  page.drawText(S('KUKLA Waagenfabrik GmbH & Co KG  ·  ' + certNr + '  ·  ' + (de ? 'DE' : 'EN')), {
    x: marginX,
    y: marginBottom - 8,
    size: 7,
    font,
    color: grayMuted,
  });
  page.drawText(S(t('Seite 1/1', 'Page 1/1')), {
    x: PAGE_W - marginX - 40,
    y: marginBottom - 8,
    size: 7,
    font,
    color: grayMuted,
  });

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  generateServiceprotokollPdfBuffer,
  generateKontrollwiegungPdfBuffer,
  generateSchleppkettenPdfBuffer,
  generateMontageberichtPdfBuffer,
  generatePruefzertifikatPdfBuffer,
};
