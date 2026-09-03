'use strict';

const path = require('path');
const fs = require('fs');
const { htmlToStyledBlocks, styledBlocksToPlain } = require('./html_rich_text');
const { kuklaPdfColors } = require('./protocol_pdf_layout');

/**
 * Pflicht für neue Dokumenttypen in dieser Datei:
 * embedLogo (PNG Alpha), kuklaPdfColors, Kopfband, Footer, Keep-together für FN/Sektion.
 * Keine neuen Grün-Werte, keine zweite Engine. Siehe protocol_pdf_layout.js
 * und .cursor/rules/formular-pdf-design.mdc.
 */

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
async function embedTtfIfExists(pdfDoc, filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return await pdfDoc.embedFont(fs.readFileSync(filePath), { subset: true });
  } catch (_) {
    return fallback;
  }
}

async function embedProtocolFonts(pdfDoc) {
  const { StandardFonts } = require('pdf-lib');
  const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const fontsDir = path.join(winDir, 'Fonts');
  const families = [
    ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
    ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
    ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  ];
  try {
    const fontkit = require('@pdf-lib/fontkit');
    pdfDoc.registerFontkit(fontkit);
    for (const [reg, bold, italic, boldItalic] of families) {
      const regPath = path.join(fontsDir, reg);
      const boldPath = path.join(fontsDir, bold);
      if (!fs.existsSync(regPath) || !fs.existsSync(boldPath)) continue;
      try {
        const font = await pdfDoc.embedFont(fs.readFileSync(regPath), { subset: true });
        const fontBold = await pdfDoc.embedFont(fs.readFileSync(boldPath), { subset: true });
        const fontItalic = await embedTtfIfExists(pdfDoc, path.join(fontsDir, italic), font);
        const fontBoldItalic = await embedTtfIfExists(pdfDoc, path.join(fontsDir, boldItalic), fontBold);
        return { font, fontBold, fontItalic, fontBoldItalic, unicode: true };
      } catch (_) {
        /* next family */
      }
    }
  } catch (_) {
    /* fontkit fehlt oder TTF-Fehler */
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
  return { font, fontBold, fontItalic, fontBoldItalic, unicode: false };
}

function fontForStyledRun(run, fonts) {
  if (run && run.bold && run.italic) return fonts.fontBoldItalic || fonts.fontBold || fonts.font;
  if (run && run.bold) return fonts.fontBold || fonts.font;
  if (run && run.italic) return fonts.fontItalic || fonts.font;
  return fonts.font;
}

function wrapStyledRuns(runs, fonts, size, maxW) {
  const tokens = [];
  (runs || []).forEach((run) => {
    String(run.text || '').split(/(\s+)/).forEach((part) => {
      if (!part) return;
      tokens.push({
        text: part,
        bold: !!run.bold,
        italic: !!run.italic,
        underline: !!run.underline,
        isSpace: /^\s+$/.test(part),
      });
    });
  });
  const lines = [];
  let line = [];
  let lineW = 0;
  const tokW = (tok) => fontForStyledRun(tok, fonts).widthOfTextAtSize(tok.text, size);
  const pushLine = () => {
    while (line.length && line[line.length - 1].isSpace) line.pop();
    lines.push(line);
    line = [];
    lineW = 0;
  };
  tokens.forEach((tok) => {
    const w = tokW(tok);
    if (line.length && !tok.isSpace && lineW + w > maxW) pushLine();
    if (!line.length && tok.isSpace) return;
    line.push(tok);
    lineW += w;
  });
  if (line.length) pushLine();
  if (!lines.length) lines.push([]);
  return lines;
}

function drawStyledLine(page, line, x, y, size, fonts, color) {
  let cx = x;
  (line || []).forEach((tok) => {
    const f = fontForStyledRun(tok, fonts);
    const w = f.widthOfTextAtSize(tok.text, size);
    if (tok.text && !tok.isSpace) {
      page.drawText(tok.text, { x: cx, y, size, font: f, color });
      if (tok.underline) {
        page.drawLine({
          start: { x: cx, y: y - 1.4 },
          end: { x: cx + w, y: y - 1.4 },
          thickness: 0.55,
          color,
        });
      }
    }
    cx += w;
  });
}

function paragraphsFromTextItem(item) {
  if (item && Array.isArray(item.paragraphs)) return item.paragraphs;
  const t = String((item && item.text) || '');
  return t.split('\n').map((line) =>
    (line
      ? [{ text: line, bold: false, italic: false, underline: false }]
      : []),
  );
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function drawWrappedText(page, font, text, x, y, maxWidth, size, lineHeight, unicodeCapable) {
  const raw = sanitizePdfText(String(text || '').replace(/\r/g, ''), !!unicodeCapable);
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

function splitBilingualLabel(bez) {
  const s = String(bez || '').trim();
  if (!s) return { de: '', en: '' };
  let m = s.match(/^(.+?)\s\/\s+(.+)$/);
  if (m) return { de: m[1].trim(), en: m[2].trim() };
  m = s.match(/^(.+?)\/\s+(.+)$/);
  if (m) return { de: m[1].trim(), en: m[2].trim() };
  return { de: s, en: '' };
}

const BUILTIN_ARBEITSSCHRITT_EN = {
  'Kontrolle der Wägebrücke': 'check of weighing bridge',
  'Kontrolle des Fördergurtes': 'check of conveyor belt',
  'Reinigen der Waage': 'cleaning of the scale',
  'Kontr. der Rollen & Rollenflucht': 'check of rollers & roller aligment',
  'Zustand der Bandabstreifer': 'condition of belt scrapers',
  'Trommelkratzer': 'drum scraper',
  'Abstreifpflug': 'scraper plough',
  'Bandspannung': 'belt tensioning',
  'Bandlenkung': 'belt steering device',
  'Schmierstellen': 'lubrication points',
  'Kraftaufnehmer': 'load cell',
  'Tacho': 'tacho',
  'Schieflaufschalter': 'belt misalignment switch',
  'Kettentriebe': 'chain drives',
  'Überlastschutz': 'overload protection',
  'Wiegeelektronik': 'weighing electronics',
  'Tara': 'tare',
  'PGW-Test': 'test with test weight',
  'Regelung & Dosierung': 'control & dosing',
  'Kontrollwiegungen': 'check weighing procedures',
  'Kontrolle der Zellenradschleuse': 'check of rotary vane feeder',
  'Kontrolle Wägebrücke': 'check of weighing bridge',
  'Kontrolle Fördergut': 'check of conveyor belt',
  'Reinigen Waage': 'cleaning of the scale',
  'Rollen & Rollenflucht': 'check of rollers & roller aligment',
  'Zustand Bandabstreifer': 'condition of belt scrapers',
};

/** Feste Arbeitsschritt-Bezeichnung je PDF-Sprache (DE oder EN, nicht gemischt). */
function arbeitsschrittLabelForLang(step, lang) {
  if (!step || typeof step !== 'object') return '';
  let de = String(step.bezeichnung_de != null ? step.bezeichnung_de : '').trim();
  let en = String(step.bezeichnung_en != null ? step.bezeichnung_en : '').trim();
  const combined = String(step.bezeichnung || step.label || '').trim();
  if ((!de || !en) && combined) {
    const parts = splitBilingualLabel(combined);
    if (!de) de = parts.de;
    if (!en) en = parts.en;
  }
  if (!en && de && BUILTIN_ARBEITSSCHRITT_EN[de]) en = BUILTIN_ARBEITSSCHRITT_EN[de];
  if (lang === 'en') return en || de;
  return de || en;
}

function scaleTypeLabelForLang(raw, de) {
  const s = String(raw || '').trim();
  if (!s || /^bandwaage$/i.test(s) || /^belt\s*scale$/i.test(s)) {
    return de ? 'Bandwaage' : 'Belt scale';
  }
  return s;
}

function abschlussStatusLabel(abschluss, lang) {
  const st = String((abschluss && abschluss.status) || '').toLowerCase().trim();
  if (st === 'justiert' || st === 'adjusted') return lang === 'en' ? 'Adjusted' : 'Justiert';
  if (st === 'mangel' || st === 'defect' || st === 'defect found') {
    return lang === 'en' ? 'Defect found' : 'Mangel festgestellt';
  }
  if (st === 'nicht_geprueft' || st === 'nicht geprüft') {
    return lang === 'en' ? 'Not checked' : 'Nicht geprüft';
  }
  if (st === 'geprueft' || st === 'geprüft' || st === 'checked' || st === 'inspected' || !st) {
    return lang === 'en' ? 'Checked' : 'Geprüft';
  }
  return lang === 'en' ? 'Checked' : 'Geprüft';
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
  const gapBlock = opts.gapBlock != null ? opts.gapBlock : 12;
  const gapTitle = opts.gapTitle != null ? opts.gapTitle : 10;
  const gapAfter = opts.gapAfter != null ? opts.gapAfter : 6;

  y -= gapBlock;
  page.drawText(sanitize(head), {
    x: marginX,
    y,
    size: 9,
    font: fontBold,
    color: greenDark,
  });
  const tw = fontBold.widthOfTextAtSize(sanitize(head), 9);
  page.drawRectangle({
    x: marginX,
    y: y - 5,
    width: Math.min(tw + 4, 180),
    height: 1.5,
    color: green,
  });
  y -= 5 + 1.5 + gapTitle;

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
  const rowH = 15;
  const headTop = y;
  page.drawRectangle({
    x: marginX,
    y: headTop - rowH,
    width: tableInnerW,
    height: rowH,
    color: green,
  });
  let hx = marginX;
  const headTextY = headTop - rowH / 2 - 2.5;
  headers.forEach((h, i) => {
    page.drawText(sanitize(h), {
      x: hx + 4,
      y: headTextY,
      size: 7.5,
      font: fontBold,
      color: white,
    });
    hx += colW[i];
  });
  y = headTop - rowH;

  const rowLabel = de ? 'Prüfgewichtstest' : 'Test with test load';
  const rowCells = [
    rowLabel,
    cells[0] || '–',
    cells[1] || '–',
    cells[2] || '–',
    cells[3] || '–',
  ];
  const rowTop = y;
  page.drawRectangle({
    x: marginX,
    y: rowTop - rowH,
    width: tableInnerW,
    height: rowH,
    color: white,
  });
  let cx = marginX;
  const rowTextY = rowTop - rowH / 2 - 2.5;
  rowCells.forEach((cell, i) => {
    page.drawText(sanitize(String(cell)), {
      x: cx + 4,
      y: rowTextY,
      size: 8,
      font: i === 0 ? font : fontBold,
      color: grayText,
    });
    cx += colW[i];
  });
  return rowTop - rowH - gapAfter;
}

/**
 * Offline-Serviceprotokoll-PDF – A4 Hochkant, Corporate-Design wie Kontrollwiegung.
 */
async function generateServiceprotokollPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const fonts = await embedProtocolFonts(pdfDoc);
  const font = fonts.font;
  const fontBold = fonts.fontBold;
  const unicodeOk = !!fonts.unicode;
  const S = (t) => sanitizePdfText(t, unicodeOk);
  const clip = (f, t, sz, mw) => clipText(f, t, sz, mw, unicodeOk);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginX = 32;
  const marginTop = 24;
  const marginBottom = 40;
  const { green, greenDark, greenSoft, greenHeader, grayText, grayMuted, lineGray, white } =
    kuklaPdfColors(rgb);
  const tableInnerW = PAGE_W - marginX * 2;

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const stepsRaw = Array.isArray(payload.arbeitsschritte) ? payload.arbeitsschritte : [];
  const steps = stepsRaw
    .map((s) => {
      if (!s) return null;
      const label = arbeitsschrittLabelForLang(s, lang);
      if (!label) return null;
      return {
        label: S(label),
        status: S(stepStatusLabel(s.status, lang)),
        bemerkung: S(stripHtml(s.bemerkung || '')),
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
    { key: 'pruefgewicht', de: 'Prüfgewicht', en: 'Test load' },
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
  const metaRowH = 28;
  const metaCols = 4;
  const metaBlockH = 14 + metaRowH * 3;
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

    const titleDe = (options && options.titleDe) || 'Serviceprotokoll';
    const titleEn = (options && options.titleEn) || 'Service protocol';
    const title = de ? titleDe : titleEn;
    page.drawText(title, {
      x: marginX + 130,
      y: y - 16,
      size: 17,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(de ? titleEn : titleDe, {
      x: marginX + 130,
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
      const tw = font.widthOfTextAtSize(line, 7);
      page.drawText(S(line), { x: PAGE_W - marginX - tw, y: ay, size: 7, font, color: grayMuted });
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
    const padX = 10;
    const padY = 11;
    const gap = 8;
    const colW = (tableInnerW - padX * 2 - gap * (metaCols - 1)) / metaCols;
    const colX = (ci) => marginX + padX + ci * (colW + gap);

    // Festes 4-Spalten-Raster (alle Zeilen gleiche Spaltenachsen)
    // Zeile 1: Kunde (2 Spalten) | Projekt | FN
    // Zeile 2: Type | Qmax | Pos.Nr. | DWC
    // Zeile 3: Datum | Servicetechniker (2 Spalten) | Status
    const absStatusKopf = abschlussStatusLabel(abschluss, lang) || '–';
    const cells = [
      {
        row: 0,
        col: 0,
        span: 2,
        label: de ? 'Kunde / customer' : 'Customer',
        value: payload.kunde || payload.customer_name || '',
      },
      {
        row: 0,
        col: 2,
        span: 1,
        label: de ? 'Projekt / project' : 'Project',
        value: payload.projekt || '',
      },
      {
        row: 0,
        col: 3,
        span: 1,
        label: 'FN',
        value: payload.fabrikationsnummer || '',
      },
      {
        row: 1,
        col: 0,
        span: 1,
        label: de ? 'Type / type' : 'Type',
        value: payload.kopf_type || payload.type || '',
      },
      {
        row: 1,
        col: 1,
        span: 1,
        label: 'Qmax',
        value: payload.kopf_qmax || '',
      },
      {
        row: 1,
        col: 2,
        span: 1,
        label: de ? 'Pos.Nr.' : 'Pos. no.',
        value: payload.kopf_pos_nr || '',
      },
      {
        row: 1,
        col: 3,
        span: 1,
        label: 'DWC',
        value: payload.kopf_dwc || '',
      },
      {
        row: 2,
        col: 0,
        span: 1,
        label: de ? 'Datum / date' : 'Date',
        value: formatDateDe(payload.durchfuehrungsdatum) || '–',
      },
      {
        row: 2,
        col: 1,
        span: 2,
        label: de ? 'Servicetechniker' : 'Service engineer',
        value: monteurName,
      },
      {
        row: 2,
        col: 3,
        span: 1,
        label: de ? 'Status' : 'Status',
        value: absStatusKopf,
      },
    ];

    // Dezente Trennlinien zwischen den Zeilen
    for (let r = 1; r < 3; r++) {
      const ly = yStart - padY - r * metaRowH + 6;
      page.drawLine({
        start: { x: marginX + padX, y: ly },
        end: { x: marginX + tableInnerW - padX, y: ly },
        thickness: 0.4,
        color: greenSoft,
      });
    }

    cells.forEach((cell) => {
      const w = colW * cell.span + gap * (cell.span - 1);
      const x = colX(cell.col);
      const gy = yStart - padY - cell.row * metaRowH;
      page.drawText(clip(font, cell.label, 6.5, w), {
        x,
        y: gy,
        size: 6.5,
        font,
        color: grayMuted,
      });
      page.drawText(clip(fontBold, String(cell.value || '').trim() || '–', 9, w), {
        x,
        y: gy - 12,
        size: 9,
        font: fontBold,
        color: grayText,
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
      const label = clip(fontBold, col.label, 8, col.w - 6);
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
    page.drawText(S(title), { x: marginX, y, size: 10, font: fontBold, color: greenDark });
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
      page.drawText(S(c.label), { x: x + 4, y: y - 12, size: 7.5, font: fontBold, color: white });
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
        const val = clip(font, row[c.key] || '', 8, c.w - 6);
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
    drawFixedProtocolFooter(page, {
      marginX,
      marginBottom,
      pageW: PAGE_W,
      font,
      grayMuted,
      greenSoft,
      de,
      pageIndex,
      pageCount,
      isLast,
      sigImg,
      createdDate: pdfFooterCreatedDateDe(payload),
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
    // Status steht im Kopffeld; Abschluss-Box (Status/Monteur/Datum) entfällt.
    // Abschluss-Bemerkungen weiterhin als eigener Block, falls vorhanden.
    const absBem = stripHtml(abschluss.bemerkungen || '');
    if (absBem) {
      blocks.push({ type: 'abschluss_bemerk', text: absBem });
    }
    return blocks;
  }

  const trailing = buildTrailingBlocks();
  const chromeBottom = PAGE_H - marginTop - headerBandH - 12;
  const contentBottom = marginBottom + PROTOCOL_FOOTER_RESERVED_H;
  const usableHFirst = chromeBottom - 12 - metaBlockH - 12 - contentBottom;
  const usableHNext = chromeBottom - contentBottom;

  // Paginate steps: erste Seite mit Meta (weniger Platz), Folgeseiten ohne Meta
  const stepPages = [];
  let stepIdx = 0;
  while (stepIdx < steps.length || stepPages.length === 0) {
    const pageSteps = [];
    const limit = stepPages.length === 0 ? usableHFirst : usableHNext;
    let used = stepHeaderH;
    while (stepIdx < steps.length) {
      const h = measureStepRowHeight(steps[stepIdx]);
      if (pageSteps.length && used + h > limit) break;
      pageSteps.push(steps[stepIdx]);
      used += h;
      stepIdx += 1;
    }
    stepPages.push({ steps: pageSteps, startIndex: stepIdx - pageSteps.length });
    if (!steps.length) break;
  }

  // Attach trailing content to last step page if room, else extra pages
  const pagesPlan = stepPages.map((p) => ({
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
    else if (block.type === 'abschluss_bemerk') need = 40;
    const limit = targetIdx === 0 ? usableHFirst : usableHNext;
    if (lastUsed + need > limit && pagesPlan[targetIdx].trailing.length) {
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
    if (pageIndex === 0) {
      y = drawMeta(page, y);
    }

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
              ? 'Wägezelle & Messwerte ' + (idx + 1)
              : 'Load cell & measurements ' + (idx + 1)
            : de
              ? 'Wägezelle & Messwerte'
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
            const val = clip(fontBold, String(pair[1]), 8, 90);
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
          S,
          title: de ? 'Prüfgewichtstest' : 'Test with test load',
        });
      } else if (block.type === 'bemerk') {
        y = drawSectionTitle(page, y, de ? 'Allgemeine Bemerkungen' : 'General remarks');
        y = drawWrappedText(page, font, block.text, marginX, y, tableInnerW, 8, 11, unicodeOk);
        y -= 8;
      } else if (block.type === 'abschluss_bemerk') {
        y = drawSectionTitle(page, y, de ? 'Abschluss-Bemerkungen' : 'Completion remarks');
        y = drawWrappedText(page, font, block.text, marginX, y, tableInnerW, 8, 11, unicodeOk);
        y -= 8;
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

/**
 * Reservierte Fußhöhe (Linie + Datum + Signatur auf letzter Seite).
 * Inhalt endet immer darüber – auch auf Seiten ohne Signatur-Bild.
 */
const PROTOCOL_FOOTER_RESERVED_H = 48;

/**
 * Einheitlicher Protokoll-Fuß: Datum + Seitenzahl immer; Signatur nur letzte Seite.
 * @param {import('pdf-lib').PDFPage} page
 * @param {object} opts
 */
function drawFixedProtocolFooter(page, opts) {
  const marginX = opts.marginX != null ? opts.marginX : 32;
  const marginBottom = opts.marginBottom != null ? opts.marginBottom : 36;
  const pageW = opts.pageW;
  const font = opts.font;
  const grayMuted = opts.grayMuted;
  const greenSoft = opts.greenSoft;
  const de = opts.de !== false;
  const pageIndex = opts.pageIndex != null ? opts.pageIndex : 0;
  const pageCount = opts.pageCount != null ? opts.pageCount : 1;
  const isLast = !!opts.isLast;
  const sigImg = opts.sigImg || null;
  const createdDate = opts.createdDate != null ? String(opts.createdDate) : '';
  const innerW = pageW - marginX * 2;

  const footerLineY = marginBottom + PROTOCOL_FOOTER_RESERVED_H - 10;
  page.drawLine({
    start: { x: marginX, y: footerLineY },
    end: { x: marginX + innerW, y: footerLineY },
    thickness: 0.6,
    color: greenSoft,
  });

  const dateLabel = (de ? 'Datum: ' : 'Date: ') + (createdDate || '–');
  page.drawText(dateLabel, {
    x: marginX,
    y: marginBottom,
    size: 8,
    font,
    color: grayMuted,
  });

  if (isLast && sigImg) {
    const maxW = 120;
    const maxH = 32;
    const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
    const iw = sigImg.width * scale;
    const ih = sigImg.height * scale;
    const dateW = font.widthOfTextAtSize(dateLabel, 8);
    const sigX = Math.min(marginX + Math.max(dateW + 16, 130), pageW - marginX - iw);
    page.drawImage(sigImg, { x: sigX, y: marginBottom + 2, width: iw, height: ih });
  }

  const pageLabel = (de ? 'Seite ' : 'Page ') + (pageIndex + 1) + ' / ' + pageCount;
  const tw = font.widthOfTextAtSize(pageLabel, 8);
  page.drawText(pageLabel, {
    x: pageW - marginX - tw,
    y: marginBottom,
    size: 8,
    font,
    color: grayMuted,
  });
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

function clipText(font, text, size, maxWidth, unicodeCapable) {
  // unicodeCapable gesetzt → sanitize; sonst Text vom Aufrufer (bereits S()) nur clippen
  const raw =
    unicodeCapable === undefined ? String(text == null ? '' : text) : sanitizePdfText(text, !!unicodeCapable);
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
async function generateKontrollwiegungPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const fonts = await embedProtocolFonts(pdfDoc);
  const font = fonts.font;
  const fontBold = fonts.fontBold;
  const unicodeOk = !!fonts.unicode;
  const S = (t) => sanitizePdfText(t, unicodeOk);
  const clip = (f, t, sz, mw) => clipText(f, t, sz, mw, unicodeOk);

  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const marginX = 28;
  const marginTop = 22;
  const marginBottom = 36;
  const { green, greenDark, greenSoft, greenHeader, grayText, grayMuted, lineGray, white, sumBg } =
    kuklaPdfColors(rgb);

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const rowsAll = Array.isArray(payload.wiegungen) ? payload.wiegungen : [];
  // PDF: nur Zeilen, die für die Summe markiert sind (in_summe)
  const dataRows = rowsAll.filter(rowInSumme);

  const cols = de
    ? [
        { key: 'nr', label: 'Nr.', sub: 'No.', w: 28, align: 'center' },
        { key: 'bandwaage_kg', label: 'Bandwaage [kg]', sub: 'belt scale', w: 88, align: 'right', digits: 3 },
        { key: 'kontrollwaage_kg', label: 'Kontrollwaage [kg]', sub: 'control scale', w: 98, align: 'right', digits: 3 },
        { key: 'fehler_kg', label: 'Fehler [kg]', sub: 'difference', w: 72, align: 'right', digits: 3 },
        { key: 'fehler_prozent', label: 'Fehler [%]', sub: 'difference', w: 68, align: 'right', kind: 'pct' },
        { key: 'leistung_th', label: 'Leistung [t/h]', sub: 'rate', w: 72, align: 'right', digits: 0 },
        { key: 'tara_kg', label: 'Tara [kg]', sub: 'tare', w: 68, align: 'right', digits: 0 },
        { key: 'brutto_kg', label: 'Brutto [kg]', sub: 'gross', w: 72, align: 'right', digits: 0 },
        { key: 'bemerkung', label: 'Bemerkungen', sub: 'remarks', w: 0, align: 'left' },
      ]
    : [
        { key: 'nr', label: 'No.', sub: 'Nr.', w: 28, align: 'center' },
        { key: 'bandwaage_kg', label: 'Belt scale [kg]', sub: 'Bandwaage', w: 88, align: 'right', digits: 3 },
        { key: 'kontrollwaage_kg', label: 'Control scale [kg]', sub: 'Kontrollwaage', w: 98, align: 'right', digits: 3 },
        { key: 'fehler_kg', label: 'Difference [kg]', sub: 'Fehler', w: 72, align: 'right', digits: 3 },
        { key: 'fehler_prozent', label: 'Difference [%]', sub: 'Fehler', w: 68, align: 'right', kind: 'pct' },
        { key: 'leistung_th', label: 'Rate [t/h]', sub: 'Leistung', w: 72, align: 'right', digits: 0 },
        { key: 'tara_kg', label: 'Tare [kg]', sub: 'Tara', w: 68, align: 'right', digits: 0 },
        { key: 'brutto_kg', label: 'Gross [kg]', sub: 'Brutto', w: 72, align: 'right', digits: 0 },
        { key: 'bemerkung', label: 'Remarks', sub: 'Bemerkungen', w: 0, align: 'left' },
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
    if (col.key === 'bemerkung') return de ? 'Summe' : 'Total';
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
    page.drawText(de ? 'Kontrollwiegungsprotokoll' : 'Calibration protocol', {
      x: titleX,
      y: y - 16,
      size: 18,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(de ? 'calibration protocol' : 'Kontrollwiegungsprotokoll', {
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
      const safe = S(line);
      const tw = font.widthOfTextAtSize(safe, 7.5);
      page.drawText(safe, { x: PAGE_W - marginX - tw, y: ay, size: 7.5, font, color: grayMuted });
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
    const fields = de
      ? [
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
        ]
      : [
          [
            ['Customer / Kunde', payload.kunde || payload.customer_name || ''],
            ['SN', payload.fabrikationsnummer || ''],
            ['Project / Projekt', payload.projekt || ''],
            ['Date / Datum', datumVal],
          ],
          [
            ['Type / type', payload.type || ''],
            ['Rate / Leistung', payload.leistung || ''],
            ['Electronics', payload.elektronik || ''],
            ['Service engineer', monteurVal],
          ],
          [
            ['Control scale division', payload.teilung_kontrollwaage || ''],
            ['Max range', payload.bereich_max || ''],
            ['Last verification', formatDateDe(payload.letzte_eichung) || String(payload.letzte_eichung || '')],
            ['Saved', gespeichertVal],
          ],
        ];

    fields.forEach((group, gi) => {
      const gx = marginX + gi * colW + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(S(label), { x: gx, y: gy, size: 6.5, font, color: grayMuted });
        const display = String(val || '').trim() || '–';
        page.drawText(clip(fontBold, display, 9, colW - pad * 2), {
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
      const label = clip(fontBold, col.label, 7.5, col.w - 6);
      const sub = clip(font, col.sub, 6, col.w - 6);
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
      const text = clip(useFont, raw, size, col.w - 6);
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
    drawFixedProtocolFooter(page, {
      marginX,
      marginBottom,
      pageW: PAGE_W,
      font,
      grayMuted,
      greenSoft,
      de,
      pageIndex,
      pageCount,
      isLast,
      sigImg,
      createdDate: pdfFooterCreatedDateDe(payload),
    });
  }

  // Seite 1: Meta; Folgeseiten: nur Chrome. Fuß immer reserviert.
  const chromeH = 52 + 14;
  const contentTopFirst = PAGE_H - marginTop - chromeH - metaBlockH - 12;
  const contentTopNext = PAGE_H - marginTop - chromeH;
  const footerReserve = PROTOCOL_FOOTER_RESERVED_H;
  const rowsPerPageFirst = Math.max(
    1,
    Math.floor((contentTopFirst - marginBottom - footerReserve - headerH) / rowH),
  );
  const rowsPerPageNext = Math.max(
    1,
    Math.floor((contentTopNext - marginBottom - footerReserve - headerH) / rowH),
  );

  const pagesPlan = [];
  let remaining = dataRows.slice();
  if (!remaining.length) {
    pagesPlan.push({ rows: [], withSum: false });
  } else {
    let pageNo = 0;
    while (remaining.length > 0) {
      const capacity = pageNo === 0 ? rowsPerPageFirst : rowsPerPageNext;
      const left = remaining.length;
      const sumSlot = sums.any ? 1 : 0;
      if (left + sumSlot <= capacity) {
        pagesPlan.push({ rows: remaining.splice(0), withSum: !!sums.any });
      } else {
        pagesPlan.push({ rows: remaining.splice(0, capacity), withSum: false });
      }
      pageNo += 1;
    }
    if (sums.any && pagesPlan.length && !pagesPlan[pagesPlan.length - 1].withSum) {
      pagesPlan.push({ rows: [], withSum: true });
    }
  }

  pagesPlan.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = drawHeader(page);
    if (pageIndex === 0) {
      y = drawMeta(page, y);
    }
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
    drawFooter(page, pageIndex, pagesPlan.length, pageIndex === pagesPlan.length - 1);
  });

  return Buffer.from(await pdfDoc.save());
}

/**
 * Schleppketten-Test / chain calibration – A4 Querformat, Corporate-Design.
 */
async function generateSchleppkettenPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const skLocal = require('./schleppketten-local');
  const lang = (options && options.lang) === 'en' ? 'en' : 'de';
  const de = lang !== 'en';
  const pdfDoc = await PDFDocument.create();
  const fonts = await embedProtocolFonts(pdfDoc);
  const font = fonts.font;
  const fontBold = fonts.fontBold;
  const unicodeOk = !!fonts.unicode;
  const S = (t) => sanitizePdfText(t, unicodeOk);
  const clip = (f, t, sz, mw) => clipText(f, t, sz, mw, unicodeOk);

  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const marginX = 26;
  const marginTop = 22;
  const marginBottom = 36;
  const { green, greenDark, greenSoft, greenHeader, grayText, grayMuted, lineGray, white, sumBg } =
    kuklaPdfColors(rgb);

  const logo = await embedLogo(pdfDoc);
  const sigImg = await embedSignatureImage(pdfDoc, payload.technician_signature_png);
  const rowsAll = skLocal.enrichMessungen(Array.isArray(payload.messungen) ? payload.messungen : []);
  const dataRows = rowsAll.filter(rowInSumme);

  const cols = de
    ? [
        { key: 'nr', label: 'Nr.', sub: 'No.', w: 26, align: 'center' },
        { key: 'bandwaage_t', label: 'Bandwaage [t]', sub: 'belt scale', w: 78, align: 'right', digits: 3 },
        { key: 'pruefkette_t', label: 'Prüfkette [t]', sub: 'test chain', w: 78, align: 'right', digits: 3 },
        { key: 'kg_pro_m', label: 'kg/m', sub: 'kg/m', w: 62, align: 'right', digits: 4 },
        { key: 'geschwindigkeit_ms', label: 'Geschw. [m/s]', sub: 'speed', w: 70, align: 'right', digits: 2 },
        { key: 'messzeit_s', label: 'Messzeit [s]', sub: 'measure time', w: 62, align: 'right', digits: 0 },
        { key: 'fehler_prozent', label: 'Fehler [%]', sub: 'difference', w: 62, align: 'right', kind: 'pct' },
        { key: 'leistung_th', label: 'Leistung [t/h]', sub: 'rate', w: 70, align: 'right', digits: 1 },
        { key: 'bemerkung', label: 'Bemerkungen', sub: 'remarks', w: 0, align: 'left' },
      ]
    : [
        { key: 'nr', label: 'No.', sub: 'Nr.', w: 26, align: 'center' },
        { key: 'bandwaage_t', label: 'Belt scale [t]', sub: 'Bandwaage', w: 78, align: 'right', digits: 3 },
        { key: 'pruefkette_t', label: 'Test chain [t]', sub: 'Prüfkette', w: 78, align: 'right', digits: 3 },
        { key: 'kg_pro_m', label: 'kg/m', sub: 'kg/m', w: 62, align: 'right', digits: 4 },
        { key: 'geschwindigkeit_ms', label: 'Speed [m/s]', sub: 'Geschw.', w: 70, align: 'right', digits: 2 },
        { key: 'messzeit_s', label: 'Measure time [s]', sub: 'Messzeit', w: 62, align: 'right', digits: 0 },
        { key: 'fehler_prozent', label: 'Difference [%]', sub: 'Fehler', w: 62, align: 'right', kind: 'pct' },
        { key: 'leistung_th', label: 'Rate [t/h]', sub: 'Leistung', w: 70, align: 'right', digits: 1 },
        { key: 'bemerkung', label: 'Remarks', sub: 'Bemerkungen', w: 0, align: 'left' },
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
    if (col.key === 'bemerkung') return de ? 'Summe' : 'Total';
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
    page.drawText(de ? 'Schleppketten-Test' : 'Chain calibration', {
      x: marginX + 140,
      y: y - 16,
      size: 18,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(de ? 'chain calibration' : 'Schleppketten-Test', {
      x: marginX + 140,
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
      const safe = S(line);
      const tw = font.widthOfTextAtSize(safe, 7.5);
      page.drawText(safe, { x: PAGE_W - marginX - tw, y: ay, size: 7.5, font, color: grayMuted });
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
    const fields = de
      ? [
          [
            ['Kunde / customer', payload.kunde || payload.customer_name || ''],
            ['FN', payload.fabrikationsnummer || ''],
            ['Projekt / project', payload.projekt || ''],
            ['Datum / date', formatDateDe(payload.durchfuehrungsdatum) || '–'],
          ],
          [
            ['Waagenart / scale type', scaleTypeLabelForLang(payload.waagenart, true)],
            ['Type / type', payload.type || ''],
            ['Leistung / value', payload.nennleistung || payload.leistung || ''],
            ['Elektronik / DWC', payload.elektronik || payload.dwc || ''],
          ],
          [
            ['Pos.Nr.', payload.pos_nr || ''],
            ['GN', payload.gn || ''],
            ['Servicetechniker', payload.monteur_name || payload.technician_name || '–'],
          ],
        ]
      : [
          [
            ['Customer / Kunde', payload.kunde || payload.customer_name || ''],
            ['SN', payload.fabrikationsnummer || ''],
            ['Project / Projekt', payload.projekt || ''],
            ['Date / Datum', formatDateDe(payload.durchfuehrungsdatum) || '–'],
          ],
          [
            ['Scale type / Waagenart', scaleTypeLabelForLang(payload.waagenart, false)],
            ['Type / type', payload.type || ''],
            ['Rate / Leistung', payload.nennleistung || payload.leistung || ''],
            ['Electronics / DWC', payload.elektronik || payload.dwc || ''],
          ],
          [
            ['Pos. no.', payload.pos_nr || ''],
            ['GN', payload.gn || ''],
            ['Service engineer', payload.monteur_name || payload.technician_name || '–'],
          ],
        ];
    fields.forEach((group, gi) => {
      const gx = marginX + gi * colW + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        page.drawText(clip(font, label, 6.5, colW - pad * 2), {
          x: gx,
          y: gy,
          size: 6.5,
          font,
          color: grayMuted,
        });
        page.drawText(clip(fontBold, String(val || '').trim() || '–', 9, colW - pad * 2), {
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
    const primary = de ? titleDe : titleEn;
    const secondary = de ? titleEn : titleDe;
    page.drawText(primary, {
      x: marginX,
      y: yStart - 12,
      size: 10,
      font: fontBold,
      color: greenDark,
    });
    if (secondary) {
      const tw = fontBold.widthOfTextAtSize(primary, 10);
      page.drawText(' / ' + secondary, {
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

    const colsK = de
      ? [
          { key: 'nr', label: 'Nr.', sub: 'No.', w: 28, align: 'center' },
          { key: 'tag', label: 'Tag (Name)', sub: 'tag', w: 140, align: 'left' },
          { key: 'ketten_type', label: 'Ketten Type', sub: 'chain type', w: 90, align: 'left' },
          { key: 'laenge', label: 'Laenge', sub: 'length', w: 90, align: 'right', digits: 3 },
          { key: 'gewicht_pro_kette', label: 'Gewicht / Kette', sub: 'weight / chain', w: 110, align: 'right', digits: 3 },
          { key: 'gewicht_pro_meter', label: 'Gewicht / Meter', sub: 'weight / m', w: 0, align: 'right', digits: 4 },
        ]
      : [
          { key: 'nr', label: 'No.', sub: 'Nr.', w: 28, align: 'center' },
          { key: 'tag', label: 'Tag (name)', sub: 'Tag', w: 140, align: 'left' },
          { key: 'ketten_type', label: 'Chain type', sub: 'Ketten Type', w: 90, align: 'left' },
          { key: 'laenge', label: 'Length', sub: 'Laenge', w: 90, align: 'right', digits: 3 },
          { key: 'gewicht_pro_kette', label: 'Weight / chain', sub: 'Gewicht / Kette', w: 110, align: 'right', digits: 3 },
          { key: 'gewicht_pro_meter', label: 'Weight / m', sub: 'Gewicht / Meter', w: 0, align: 'right', digits: 4 },
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
      if (col.key === 'tag') return de ? 'Summe' : 'Total';
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
      const label = clip(fontBold, col.label, 7, col.w - 4);
      const sub = clip(font, col.sub, 5.5, col.w - 4);
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
        const text = clip(useFont, raw, 7.5, col.w - 5);
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
      const label = clip(fontBold, col.label, 7, col.w - 4);
      const sub = clip(font, col.sub, 5.5, col.w - 4);
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
      const text = clip(useFont, raw, 7.5, col.w - 5);
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
    drawFixedProtocolFooter(page, {
      marginX,
      marginBottom,
      pageW: PAGE_W,
      font,
      grayMuted,
      greenSoft,
      de,
      pageIndex,
      pageCount,
      isLast,
      sigImg,
      createdDate: pdfFooterCreatedDateDe(payload),
    });
  }

  const kettenListForH = Array.isArray(payload.ketten) && payload.ketten.length
    ? payload.ketten.filter((k) => !(k && (k.in_summe === false || k.in_summe === 0 || k.in_summe === '0')))
    : [{}];
  const kettenRowsForH = kettenListForH.length ? kettenListForH : [{}];
  const kettenBlockH = sectionTitleH + headerH + (kettenRowsForH.length + 1) * rowH + 10;
  const chromeH = 52 + 14;
  const footerReserve = PROTOCOL_FOOTER_RESERVED_H;
  // Seite 1: Meta + Kettenblock; Folgeseiten: nur Chrome + Messungen
  const contentTopFirst =
    PAGE_H - marginTop - chromeH - metaBlockH - 12 - kettenBlockH - sectionTitleH;
  const contentTopNext = PAGE_H - marginTop - chromeH - sectionTitleH;
  const rowsPerPageFirst = Math.max(
    1,
    Math.floor((contentTopFirst - marginBottom - footerReserve - headerH) / rowH),
  );
  const rowsPerPageNext = Math.max(
    1,
    Math.floor((contentTopNext - marginBottom - footerReserve - headerH) / rowH),
  );
  const pagesPlan = [];
  let remaining = dataRows.slice();
  if (!remaining.length) {
    pagesPlan.push({ rows: [], withSum: false });
  } else {
    let pageNo = 0;
    while (remaining.length > 0) {
      const capacity = pageNo === 0 ? rowsPerPageFirst : rowsPerPageNext;
      const left = remaining.length;
      const sumSlot = sums.any ? 1 : 0;
      if (left + sumSlot <= capacity) {
        pagesPlan.push({ rows: remaining.splice(0), withSum: !!sums.any });
      } else {
        pagesPlan.push({ rows: remaining.splice(0, capacity), withSum: false });
      }
      pageNo += 1;
    }
    if (sums.any && pagesPlan.length && !pagesPlan[pagesPlan.length - 1].withSum) {
      pagesPlan.push({ rows: [], withSum: true });
    }
  }

  pagesPlan.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = drawHeader(page);
    if (pageIndex === 0) {
      y = drawMeta(page, y);
      y = drawKettenDaten(page, y);
    }
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
  return styledBlocksToPlain(htmlToStyledBlocks(html));
}

/**
 * Richtext (HTML oder Plain) → Zeichenblöcke (Absätze/Runs) + Bild-Blöcke (data-URL).
 */
function htmlToMbContentBlocks(html, plainFallback, unicodeCapable) {
  const uni = !!unicodeCapable;
  return htmlToStyledBlocks(html, plainFallback).map((b) => {
    if (b.type === 'image') return b;
    return {
      type: 'text',
      paragraphs: (b.paragraphs || []).map((runs) =>
        (runs || [])
          .map((r) => ({
            text: sanitizePdfText(r.text, uni),
            bold: !!r.bold,
            italic: !!r.italic,
            underline: !!r.underline,
          }))
          .filter((r) => r.text),
      ),
    };
  }).filter((b) => b.type === 'image' || (b.paragraphs && b.paragraphs.length));
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
  const styleFonts = {
    font,
    fontBold,
    fontItalic: fonts.fontItalic || font,
    fontBoldItalic: fonts.fontBoldItalic || fonts.fontBold || font,
  };
  const unicodeOk = !!fonts.unicode;
  const S = (t) => sanitizePdfText(t, unicodeOk);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginX = 32;
  const marginTop = 24;
  const marginBottom = 40;
  const { green, greenDark, greenSoft, greenHeader, grayText, grayMuted, lineGray, white } =
    kuklaPdfColors(rgb);
  const tableInnerW = PAGE_W - marginX * 2;
  const headerBandH = 52;
  const contentBottom = marginBottom + PROTOCOL_FOOTER_RESERVED_H;

  const L = {
    title: de ? 'Montagebericht' : 'Assembly report',
    titleSub: de ? 'assembly report' : 'Montagebericht',
    kunde: de ? 'Kunde / customer' : 'Customer',
    geliefert: de ? 'geliefert über' : 'Delivered via',
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
  const ansprechpersonRaw = String(kopf.ansprechperson || '').trim();
  // Mehrere Ansprechpartner: Zeilenumbruch oder Legacy „A, B“
  const ansprechLines = (ansprechpersonRaw.includes('\n')
    ? ansprechpersonRaw.split(/\n+/)
    : ansprechpersonRaw.split(/\s*,\s*/)
  )
    .map((s) => S(s).trim())
    .filter(Boolean);
  const metaBlockH = 118 + Math.max(0, ansprechLines.length - 1) * 12;
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
        if ((b.paragraphs && b.paragraphs.length) || b.text) out.push(b);
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
      'Fadingerstr. 1-11 · 4840 Vöcklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = y - 12;
    addrLines.forEach((line) => {
      const safe = S(line);
      const tw = font.widthOfTextAtSize(safe, 7);
      page.drawText(safe, { x: PAGE_W - marginX - tw, y: ay, size: 7, font, color: grayMuted });
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
    const colW = tableInnerW / 2 - pad * 2;
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
        [L.contact, ansprechLines.length ? ansprechLines : ['–']],
      ],
    ];
    fields2.forEach((group, gi) => {
      const gx = marginX + gi * (tableInnerW / 2) + pad;
      let gy = yStart - 12;
      group.forEach(([label, val]) => {
        const lines = Array.isArray(val)
          ? val
          : [String(val || '').trim() || '–'];
        page.drawText(clipText(font, label, 6.5, colW), {
          x: gx,
          y: gy,
          size: 6.5,
          font,
          color: grayMuted,
        });
        lines.forEach((line, li) => {
          page.drawText(clipText(fontBold, String(line || '').trim() || '–', 9, colW), {
            x: gx,
            y: gy - 11 - li * 12,
            size: 9,
            font: fontBold,
            color: grayText,
          });
        });
        gy -= 26 + Math.max(0, lines.length - 1) * 12;
      });
    });
    return boxY - 14;
  }

  function drawFooter(page, pageIndex, pageCount, isLast) {
    drawFixedProtocolFooter(page, {
      marginX,
      marginBottom,
      pageW: PAGE_W,
      font,
      grayMuted,
      greenSoft,
      de,
      pageIndex,
      pageCount,
      isLast,
      sigImg,
      createdDate: pdfFooterCreatedDateDe(payload),
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
    if (item.type === 'fn_header') return 36; // box 22 + Abstand 14
    if (item.type === 'fn_sep') return 14;
    if (item.type === 'text') {
      const paras = paragraphsFromTextItem(item);
      let lines = 0;
      paras.forEach((runs) => {
        if (!runs || !runs.length) {
          lines += 1;
          return;
        }
        lines += wrapStyledRuns(runs, styleFonts, 9, tableInnerW).length;
      });
      return Math.max(12, lines * 12) + 6;
    }
    if (item.type === 'image' && item.img) {
      const maxW = tableInnerW * ((item.widthPct || 100) / 100);
      const scale = Math.min(1, maxW / item.img.width);
      return item.img.height * scale + 10;
    }
    return 12;
  }

  /**
   * FN-Leiste gehört zum Textblock: ganze Sektion zusammenhalten, wenn sie
   * auf eine Folgeseite passt; sonst mindestens Leiste + Textanfang (3 Zeilen).
   */
  function measureFnBlockKeepHeight(headerIndex) {
    const headerH = estimateItemHeight(queue[headerIndex]);
    let restH = 0;
    let firstContentH = 0;
    for (let j = headerIndex + 1; j < queue.length; j++) {
      const it = queue[j];
      const ih = estimateItemHeight(it);
      restH += ih;
      if (!firstContentH && (it.type === 'text' || it.type === 'image')) {
        firstContentH = it.type === 'image' ? Math.min(ih, 80) : Math.min(ih, 12 * 3 + 6);
      }
      if (it.type === 'fn_sep') break;
    }
    const total = headerH + restH;
    const chromeH = marginTop + headerBandH + 12;
    const freshAvail = PAGE_H - chromeH - contentBottom;
    if (total <= freshAvail) return total;
    return headerH + Math.max(firstContentH || 36, 36);
  }

  newPage();
  for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi];
    const h = estimateItemHeight(item);
    if (item.type === 'fn_header') {
      needSpace(measureFnBlockKeepHeight(qi));
    } else if (item.type === 'section') {
      needSpace(Math.min(Math.max(h, 40), 160));
    } else if (item.type === 'image') {
      needSpace(Math.min(h, Math.max(80, y - contentBottom)));
    } else {
      needSpace(Math.min(h, 120));
    }
    if (item.type === 'section') {
      page.drawText(item.title, { x: marginX, y: y, size: 10, font: fontBold, color: greenDark });
      y -= 14;
      continue;
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
      continue;
    }
    if (item.type === 'fn_header') {
      const boxH = 22;
      const gapBelow = 14;
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
      y -= boxH + gapBelow;
      continue;
    }
    if (item.type === 'text') {
      const size = 9;
      const lineH = 12;
      const maxW = tableInnerW;
      const paragraphs = paragraphsFromTextItem(item);
      paragraphs.forEach((runs) => {
        if (!runs || !runs.length) {
          needSpace(lineH);
          y -= lineH;
          return;
        }
        const wrapped = wrapStyledRuns(runs, styleFonts, size, maxW);
        wrapped.forEach((line) => {
          needSpace(lineH + 2);
          drawStyledLine(page, line, marginX, y, size, styleFonts, grayText);
          y -= lineH;
        });
      });
      y -= 6;
      continue;
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
  }

  pages.forEach((p, i) => {
    drawFooter(p, i, pages.length, i === pages.length - 1);
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
  const contentBottom = marginBottom + PROTOCOL_FOOTER_RESERVED_H;
  const { green, greenDark, greenSoft, greenHeader, grayMuted, white } = kuklaPdfColors(rgb);
  const grayText = rgb(0.22, 0.22, 0.22);
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

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - marginTop;

  page.drawRectangle({
    x: 20,
    y: 20,
    width: PAGE_W - 40,
    height: PAGE_H - 40,
    borderColor: green,
    borderWidth: 1.5,
  });

  const clipVal = (v, maxLen) => {
    const s = str(v) || '–';
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  };
  const fmtDate = (v) => formatDateDe(v) || str(v) || '–';

  // Einheitliches Abstands-Raster (pt)
  const GAP_BLOCK = 12; // zwischen Blöcken (vor Überschrift)
  const GAP_TITLE = 10; // von Unterstreichung bis Inhalt
  const GAP_LINE = 11; // Fließtext-Zeilenabstand
  const GAP_AFTER_TABLE = 6; // unter Tabellen vor nächstem Element

  /** Block-Überschrift mit klarem Abstand davor und danach. */
  function drawSectionHead(label) {
    y -= GAP_BLOCK;
    page.drawText(S(label), { x: marginX, y, size: 9, font: fontBold, color: greenDark });
    const tw = fontBold.widthOfTextAtSize(S(label), 9);
    page.drawRectangle({
      x: marginX,
      y: y - 5,
      width: Math.min(tw + 4, 180),
      height: 1.5,
      color: green,
    });
    y -= 5 + 1.5 + GAP_TITLE;
  }

  function drawStackedKv(label, value, x, cellTop, cellH, maxChars) {
    const labelY = cellTop - 9;
    const valueY = cellTop - cellH + 7;
    page.drawText(S(label), { x, y: labelY, size: 6, font, color: grayMuted });
    page.drawText(S(clipVal(value, maxChars || 40)), {
      x,
      y: valueY,
      size: 8,
      font: fontBold,
      color: grayText,
    });
  }

  function textYInRow(rowTop, rowH) {
    return rowTop - rowH / 2 - 2.5;
  }

  // —— Header ——
  const headerH = 38;
  page.drawRectangle({
    x: marginX,
    y: y - headerH,
    width: tableInnerW,
    height: headerH,
    color: greenHeader,
  });
  if (logo) {
    const lh = 24;
    const lw = (logo.width / logo.height) * lh;
    page.drawImage(logo, { x: marginX + 8, y: y - headerH + 7, width: lw, height: lh });
  }
  page.drawText(S(t('Hersteller-Prüfzertifikat', 'Manufacturer Inspection Certificate')), {
    x: marginX + 100,
    y: y - 14,
    size: 12,
    font: fontBold,
    color: greenDark,
  });
  page.drawText(S(t('Wiederkehrende Überprüfung', 'Recurring Verification')), {
    x: marginX + 100,
    y: y - 27,
    size: 8,
    font,
    color: grayMuted,
  });
  y -= headerH + 12;

  // —— Zertifikatszeile ——
  const certNr = str(payload.zertifikat_nr) || '–';
  page.drawText(S(t('Zertifikatsnr.', 'Certificate no.') + ': ' + certNr), {
    x: marginX,
    y,
    size: 8.5,
    font: fontBold,
    color: grayText,
  });
  page.drawText(S(t('Bezug', 'Reference') + ': EU 2018/2066 Art. 60 (MRR)'), {
    x: marginX + 260,
    y,
    size: 7.5,
    font,
    color: grayMuted,
  });
  y -= 14;

  // —— Meta-Box ——
  const metaPadX = 10;
  const metaPadY = 7;
  const metaCols = 4;
  const metaGap = 10;
  const metaRowH = 28;
  const metaH = metaPadY * 2 + metaRowH * 2;
  const metaTop = y;
  page.drawRectangle({
    x: marginX,
    y: metaTop - metaH,
    width: tableInnerW,
    height: metaH,
    color: rgb(0.97, 0.99, 0.97),
    borderColor: greenSoft,
    borderWidth: 0.8,
  });
  page.drawLine({
    start: { x: marginX + metaPadX, y: metaTop - metaPadY - metaRowH },
    end: { x: marginX + tableInnerW - metaPadX, y: metaTop - metaPadY - metaRowH },
    thickness: 0.4,
    color: greenSoft,
  });
  const metaColW = (tableInnerW - metaPadX * 2 - metaGap * (metaCols - 1)) / metaCols;
  const metaCells = [
    { r: 0, c: 0, label: t('Fabrikationsnummer', 'Serial / FN'), value: payload.fabrikationsnummer },
    {
      r: 0,
      c: 1,
      label: t('Prüfdatum', 'Inspection date'),
      value: fmtDate(payload.pruefdatum || payload.durchfuehrungsdatum),
    },
    { r: 0, c: 2, label: t('Nächste Prüfung', 'Next inspection'), value: fmtDate(payload.naechste_pruefung) },
    { r: 0, c: 3, label: t('Monteur', 'Technician'), value: payload.monteur_name },
    { r: 1, c: 0, span: 2, label: t('Kunde', 'Customer'), value: payload.kunde || payload.customer_name },
    { r: 1, c: 2, label: t('Projekt', 'Project'), value: payload.projekt || payload.job_number },
    { r: 1, c: 3, label: t('Standort', 'Site'), value: payload.standort },
  ];
  metaCells.forEach((cell) => {
    const span = cell.span || 1;
    const x = marginX + metaPadX + cell.c * (metaColW + metaGap);
    const cellTop = metaTop - metaPadY - cell.r * metaRowH;
    drawStackedKv(cell.label, cell.value, x, cellTop, metaRowH, span >= 2 ? 58 : 28);
  });
  y = metaTop - metaH;

  // —— Anlagendaten ——
  drawSectionHead(t('Anlagendaten', 'Equipment data'));
  const plantRows = [
    [t('Type', 'Type'), payload.type, t('Pos.-Nr.', 'Pos. no.'), payload.pos_nr],
    [
      t('Elektronik / DWC', 'Electronics / DWC'),
      payload.elektronik || payload.dwc,
      t('Nennleistung', 'Rated capacity'),
      payload.nennleistung || payload.leistung,
    ],
    [
      t('Waagenart', 'Scale type'),
      scaleTypeLabelForLang(payload.waagenart, de),
      t('Projekt / Auftrag', 'Project / Job'),
      payload.projekt || payload.job_number,
    ],
  ];
  const plantRowH = 15;
  const plantHalf = tableInnerW / 2;
  plantRows.forEach((row, idx) => {
    const rowTop = y;
    page.drawRectangle({
      x: marginX,
      y: rowTop - plantRowH,
      width: tableInnerW,
      height: plantRowH,
      color: idx % 2 === 0 ? greenHeader : white,
    });
    const ty = textYInRow(rowTop, plantRowH);
    page.drawText(S(str(row[0])), { x: marginX + 6, y: ty, size: 7, font, color: grayMuted });
    page.drawText(S(clipVal(row[1], 28)), {
      x: marginX + 118,
      y: ty,
      size: 8,
      font: fontBold,
      color: grayText,
    });
    page.drawText(S(str(row[2])), { x: marginX + plantHalf + 6, y: ty, size: 7, font, color: grayMuted });
    page.drawText(S(clipVal(row[3], 28)), {
      x: marginX + plantHalf + 118,
      y: ty,
      size: 8,
      font: fontBold,
      color: grayText,
    });
    y = rowTop - plantRowH;
  });
  y -= GAP_AFTER_TABLE;

  // —— Verfahren ——
  const methods = [];
  if (verfahren.kontrollwiegung) methods.push(t('Kontrollwiegung', 'Control weighing'));
  if (verfahren.schleppketten) methods.push(t('Schleppketten-Test', 'Chain calibration test'));
  if (verfahren.service) methods.push(t('Serviceprotokoll', 'Service protocol'));
  if (verfahren.inbetriebnahme) methods.push(t('Inbetriebnahme Protokoll', 'Commissioning report'));
  drawSectionHead(t('Prüfverfahren', 'Inspection methods'));
  page.drawText(S(methods.length ? methods.join('  ·  ') : '–'), {
    x: marginX,
    y,
    size: 8,
    font,
    color: grayText,
  });
  y -= GAP_LINE;

  // —— Ergebnisse ——
  const resultRows = [];
  if (verfahren.kontrollwiegung && ergebnisse.kontrollwiegung) {
    resultRows.push([
      t('Kontrollwiegung', 'Control weighing'),
      String(ergebnisse.kontrollwiegung.anzahl != null ? ergebnisse.kontrollwiegung.anzahl : '–'),
      fmtPct(ergebnisse.kontrollwiegung.fehler_prozent),
      fmtDate(ergebnisse.kontrollwiegung.datum),
    ]);
  }
  if (verfahren.schleppketten && ergebnisse.schleppketten) {
    resultRows.push([
      t('Schleppketten-Test', 'Chain test'),
      String(ergebnisse.schleppketten.anzahl != null ? ergebnisse.schleppketten.anzahl : '–'),
      fmtPct(ergebnisse.schleppketten.fehler_prozent),
      fmtDate(ergebnisse.schleppketten.datum),
    ]);
  }
  if (verfahren.service) {
    resultRows.push([t('Serviceprotokoll', 'Service protocol'), '–', '–', '–']);
  }
  if (verfahren.inbetriebnahme) {
    resultRows.push([t('Inbetriebnahme Protokoll', 'Commissioning report'), '–', '–', '–']);
  }

  drawSectionHead(t('Ergebnisse', 'Results'));
  const colW = [tableInnerW * 0.4, tableInnerW * 0.2, tableInnerW * 0.2, tableInnerW * 0.2];
  const resultRowH = 15;
  if (resultRows.length) {
    const headTop = y;
    page.drawRectangle({
      x: marginX,
      y: headTop - resultRowH,
      width: tableInnerW,
      height: resultRowH,
      color: green,
    });
    let cx = marginX;
    const hty = textYInRow(headTop, resultRowH);
    [t('Verfahren', 'Method'), t('Anzahl', 'Count'), t('Fehler %', 'Error %'), t('Datum', 'Date')].forEach(
      (h, i) => {
        page.drawText(S(h), { x: cx + 4, y: hty, size: 7, font: fontBold, color: white });
        cx += colW[i];
      },
    );
    y = headTop - resultRowH;

    resultRows.forEach((r, idx) => {
      const rowTop = y;
      page.drawRectangle({
        x: marginX,
        y: rowTop - resultRowH,
        width: tableInnerW,
        height: resultRowH,
        color: idx % 2 === 0 ? white : greenHeader,
      });
      let x = marginX;
      const ty = textYInRow(rowTop, resultRowH);
      r.forEach((cell, i) => {
        page.drawText(S(String(cell)), { x: x + 4, y: ty, size: 8, font, color: grayText });
        x += colW[i];
      });
      y = rowTop - resultRowH;
    });
  } else {
    page.drawText(S(t('Kein Prüfverfahren ausgewählt.', 'No inspection method selected.')), {
      x: marginX,
      y,
      size: 8,
      font,
      color: grayMuted,
    });
    y -= GAP_LINE;
  }

  y -= 10;
  page.drawText(
    S(
      t('Zulässige Abweichung', 'Max. permissible error') +
        ': ± ' +
        fmtPct(payload.zulaessige_abweichung_pct) +
        ' %',
    ),
    { x: marginX, y, size: 8, font: fontBold, color: grayText },
  );
  y -= GAP_AFTER_TABLE;

  // —— Service-/IBN-Messwerte ——
  const messBlocks = [];
  if (verfahren.service && ergebnisse.service && typeof ergebnisse.service === 'object') {
    messBlocks.push({
      titleDe: 'Messwerte Wägezelle',
      titleEn: 'Load cell measurements',
      pgTitleDe: 'Prüfgewichtstest',
      pgTitleEn: 'Test with test load',
      data: ergebnisse.service,
    });
  }
  if (verfahren.inbetriebnahme && ergebnisse.inbetriebnahme && typeof ergebnisse.inbetriebnahme === 'object') {
    messBlocks.push({
      titleDe: 'Messwerte Wägezelle (Inbetriebnahme)',
      titleEn: 'Load cell measurements (commissioning)',
      pgTitleDe: 'Prüfgewichtstest (Inbetriebnahme)',
      pgTitleEn: 'Test with test load (commissioning)',
      data: ergebnisse.inbetriebnahme,
    });
  }
  messBlocks.forEach((block) => {
    const serviceMess = block.data;
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
    const messRowH = 15;
    if (messRows.length) {
      drawSectionHead(t(block.titleDe, block.titleEn));
      const mColW = [
        tableInnerW * 0.36,
        tableInnerW * 0.16,
        tableInnerW * 0.16,
        tableInnerW * 0.16,
        tableInnerW * 0.16,
      ];
      const headTop = y;
      page.drawRectangle({
        x: marginX,
        y: headTop - messRowH,
        width: tableInnerW,
        height: messRowH,
        color: green,
      });
      let mx = marginX;
      const hty = textYInRow(headTop, messRowH);
      [t('Messpunkt', 'Point'), 'kg', 'mV', 'mA', 'g %'].forEach((h, i) => {
        page.drawText(S(h), { x: mx + 3, y: hty, size: 7, font: fontBold, color: white });
        mx += mColW[i];
      });
      y = headTop - messRowH;

      messRows.forEach((row, idx) => {
        const rowTop = y;
        page.drawRectangle({
          x: marginX,
          y: rowTop - messRowH,
          width: tableInnerW,
          height: messRowH,
          color: idx % 2 === 0 ? white : greenHeader,
        });
        const cells = [row.label, row.kg || '–', row.mv || '–', row.ma || '–', row.g || '–'];
        let cx2 = marginX;
        const ty = textYInRow(rowTop, messRowH);
        cells.forEach((cell, i) => {
          page.drawText(S(String(cell)), {
            x: cx2 + 3,
            y: ty,
            size: 7.5,
            font: i === 0 ? font : fontBold,
            color: grayText,
          });
          cx2 += mColW[i];
        });
        y = rowTop - messRowH;
      });
      y -= GAP_AFTER_TABLE;
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
      title: t(block.pgTitleDe, block.pgTitleEn),
      gapBlock: GAP_BLOCK,
      gapTitle: GAP_TITLE,
      gapAfter: GAP_AFTER_TABLE,
    });
  });

  // —— Siegelbox ——
  y -= GAP_BLOCK;
  const sealW = 200;
  const sealH = 28;
  const sealX = marginX + (tableInnerW - sealW) / 2;
  page.drawRectangle({
    x: sealX,
    y: y - sealH,
    width: sealW,
    height: sealH,
    borderColor: green,
    borderWidth: 2,
    color: white,
  });
  const sealLabel = S(statusLabel);
  const sealSize = 11;
  const sealTw = fontBold.widthOfTextAtSize(sealLabel, sealSize);
  page.drawText(sealLabel, {
    x: sealX + (sealW - sealTw) / 2,
    y: y - sealH / 2 - 3.5,
    size: sealSize,
    font: fontBold,
    color: greenDark,
  });
  y -= sealH;

  // —— Prüfmittel ——
  drawSectionHead(t('Rückführbarkeit / Prüfmittel', 'Traceability / test means'));
  const pruefmittel = str(payload.pruefmittel) || '–';
  page.drawText(S(clipVal(pruefmittel, 110)), {
    x: marginX,
    y,
    size: 8,
    font,
    color: grayText,
  });
  y -= GAP_LINE;
  if (verfahren.kontrollwiegung && str(payload.letzte_eichung_kontrollwaage)) {
    page.drawText(
      S(
        t('Letzte Eichung Kontrollwaage', 'Last verification of control scale') +
          ': ' +
          fmtDate(payload.letzte_eichung_kontrollwaage),
      ),
      { x: marginX, y, size: 7.5, font, color: grayMuted },
    );
    y -= GAP_LINE;
  }

  // —— Konformität ——
  const KONFORM_DE =
    'Die Anlage wurde nach dem Herstellerverfahren der KUKLA Waagenfabrik GmbH & Co KG einer wiederkehrenden Überprüfung unterzogen. Dieses Hersteller-Prüfzertifikat (Manufacturer Inspection Certificate) dient als Nachweis der Qualitätssicherung der Messeinrichtung im Sinne von Art. 60 der Verordnung (EU) 2018/2066 (MRR). Es handelt sich nicht um eine akkreditierte Kalibrierung nach EN ISO/IEC 17025 und nicht um eine behördliche Eichung.';
  const KONFORM_EN =
    'The equipment was subjected to a recurring inspection according to the manufacturer procedure of KUKLA Waagenfabrik GmbH & Co KG. This Manufacturer Inspection Certificate serves as evidence of measuring equipment quality assurance pursuant to Art. 60 of Regulation (EU) 2018/2066 (MRR). It is not an accredited calibration under EN ISO/IEC 17025 and not an official legal metrology verification.';
  const konform = de
    ? str(payload.konformitaet_text) || KONFORM_DE
    : str(payload.konformitaet_text_en) || KONFORM_EN;

  drawSectionHead(t('Konformitätsaussage', 'Statement of conformity'));
  const words = S(konform).split(/\s+/).filter(Boolean);
  let line = '';
  const maxW = tableInnerW;
  const lineH = GAP_LINE;
  const minY = contentBottom + 2;
  const flushLine = () => {
    if (!line) return;
    if (y < minY) {
      line = '';
      return;
    }
    page.drawText(line, { x: marginX, y, size: 7, font, color: grayText });
    y -= lineH;
    line = '';
  };
  words.forEach((word) => {
    if (y < minY) return;
    const test = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(test, 7) > maxW && line) {
      flushLine();
      line = word;
    } else {
      line = test;
    }
  });
  flushLine();

  drawFixedProtocolFooter(page, {
    marginX,
    marginBottom,
    pageW: PAGE_W,
    font,
    grayMuted,
    greenSoft,
    de,
    pageIndex: 0,
    pageCount: 1,
    isLast: true,
    sigImg,
    createdDate: pdfFooterCreatedDateDe(payload),
  });

  return Buffer.from(await pdfDoc.save());
}

function wrapPdfPlain(font, text, size, maxW) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const paragraphs = raw.split('\n');
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxW) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        if (font.widthOfTextAtSize(w, size) <= maxW) {
          cur = w;
        } else {
          let chunk = '';
          for (const ch of w) {
            if (font.widthOfTextAtSize(chunk + ch, size) <= maxW) chunk += ch;
            else {
              if (chunk) lines.push(chunk);
              chunk = ch;
            }
          }
          cur = chunk;
        }
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/**
 * Arbeitsnachweis / Working Report – A4, Corporate-Layout wie Montagebericht/Service.
 * payload: { document, arbeitsnachweis, items, customer_name, technician_signature_png, customer_signature_png }
 */
async function generateArbeitsnachweisPdfBuffer(payload, options) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const lang = (options && options.lang) === 'en' ? 'en' : ((payload && payload.language) === 'en' ? 'en' : 'de');
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
  const { green, greenDark, greenSoft, greenHeader, grayText, grayMuted, lineGray, white } =
    kuklaPdfColors(rgb);
  const tableInnerW = PAGE_W - marginX * 2;
  const headerBandH = 52;
  const contentBottom = marginBottom + PROTOCOL_FOOTER_RESERVED_H;

  const L = {
    title: de ? 'ARBEITSNACHWEIS' : 'WORKING REPORT',
    titleSub: de ? 'Working Report' : 'Arbeitsnachweis',
    nr: de ? 'Nr.' : 'No.',
    customer: de ? 'Auftraggeber' : 'Customer',
    site: de ? 'Baustelle' : 'Site',
    type: de ? 'Typ / Type' : 'Type',
    fab: de ? 'Fabr.-Nr.' : 'Serial No.',
    tech: de ? 'KUKLA-Techniker' : 'KUKLA Engineer',
    car: de ? 'Auto' : 'Car',
    startKm: 'Start',
    endKm: 'End',
    totalKm: 'Total km',
    living: de ? 'Tagesauslösen' : 'Living costs',
    overnight: de ? 'Nächtigung beigestellt' : 'Overnight stay provided',
    yes: de ? 'Ja' : 'Yes',
    noVal: de ? 'Nein' : 'No',
    date: de ? 'Datum' : 'Date',
    time: de ? 'Zeit' : 'Time',
    works: de ? 'Durchgeführte Arbeiten' : 'Executed works',
    normal: de ? 'Normalstd.' : 'Normal hours',
    ot50: de ? 'Ü50' : 'OT 50%',
    ot100: de ? 'Ü100' : 'OT 100%',
    sum: de ? 'Summe' : 'Total',
    parts: de ? 'Ersatzteile' : 'Spare parts',
    qty: de ? 'Stk.' : 'Pcs.',
    designation: de ? 'Bezeichnung' : 'Designation',
    typeNo: 'Type No.',
    comment: de ? 'Kommentar' : 'Comment',
    remarks: de ? 'Bemerkung' : 'Remarks',
    sigTech: de ? 'Unterschrift KUKLA-Techniker' : 'Signature KUKLA Engineer',
    sigCust: de ? 'Unterschrift Auftraggeber' : 'Signature Customer',
    confirm: de
      ? 'Der Auftraggeber bestätigt die in diesem Arbeitsnachweis angeführten Arbeitszeiten, durchgeführten Arbeiten und gegebenenfalls verwendeten Ersatzteile.'
      : 'The customer confirms the working hours, executed works and, where applicable, spare parts stated in this working report.',
    footer: de
      ? 'Dieser Arbeitsnachweis gilt als Grundlage für die Rechnungslegung.'
      : 'This working report is the basis for invoicing.',
    page: de ? 'Seite' : 'Page',
  };

  const doc = (payload && payload.document) || {};
  const an = (payload && payload.arbeitsnachweis) || {};
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const work = items.filter((r) => (r && r.item_type) === 'arbeitszeile');
  const parts = items.filter((r) => (r && r.item_type) === 'ersatzteil');
  const customerName = S((payload && payload.customer_name) || doc.customer_name || '').trim();
  const number = S(doc.number || '').trim();
  const logo = await embedLogo(pdfDoc);
  const techSig = await embedSignatureImage(pdfDoc, payload && payload.technician_signature_png);
  const custSig = await embedSignatureImage(pdfDoc, payload && payload.customer_signature_png);

  function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return '';
    return String(Math.round(n * 100) / 100).replace('.', ',');
  }
  function fmtDate(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return S(s);
    return m[3] + '.' + m[2] + '.' + m[1];
  }
  function fmtDateTime(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{2}\.\d{2}\.\d{4}/.test(s)) return S(s);
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return S(s);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear()
      + '  ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function pickCustomerSignedAt() {
    const direct = payload && (payload.customer_signed_at || payload.customer_signature_at);
    if (direct) return String(direct);
    const sigs = Array.isArray(payload && payload.signatures) ? payload.signatures : [];
    for (const s of sigs) {
      if (!s || s.signer_type !== 'kunde') continue;
      if (s.invalidated_at) continue;
      if (s.signed_at) return String(s.signed_at);
    }
    if (payload && payload.customer_signature_png) return new Date().toISOString();
    return '';
  }

  const pages = [];
  function newPage() {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    return page;
  }

  function drawChrome() {
    const page = pages[pages.length - 1];
    let yTop = PAGE_H - marginTop;
    if (logo) {
      const maxH = 40;
      const maxW = 110;
      const scale = Math.min(maxW / logo.width, maxH / logo.height);
      page.drawImage(logo, {
        x: marginX,
        y: yTop - logo.height * scale,
        width: logo.width * scale,
        height: logo.height * scale,
      });
    } else {
      page.drawText('KUKLA', { x: marginX, y: yTop - 18, size: 14, font: fontBold, color: green });
    }
    const titleSize = 15;
    const titleW = fontBold.widthOfTextAtSize(L.title, titleSize);
    const subW = font.widthOfTextAtSize(L.titleSub, 9);
    const titleCx = PAGE_W / 2;
    page.drawText(L.title, {
      x: titleCx - titleW / 2,
      y: yTop - 18,
      size: titleSize,
      font: fontBold,
      color: greenDark,
    });
    page.drawText(L.titleSub, {
      x: titleCx - subW / 2,
      y: yTop - 34,
      size: 9,
      font,
      color: grayMuted,
    });
    const addrLines = [
      'KUKLA Waagenfabrik GmbH & Co KG',
      'Fadingerstr. 1-11 · 4840 Vöcklabruck',
      'Tel. +43 7672 26666-0 · www.kukla.co.at',
    ];
    let ay = yTop - 12;
    addrLines.forEach((line) => {
      const safe = S(line);
      const tw = font.widthOfTextAtSize(safe, 7);
      page.drawText(safe, { x: PAGE_W - marginX - tw, y: ay, size: 7, font, color: grayMuted });
      ay -= 9;
    });
    yTop -= headerBandH;
    page.drawRectangle({ x: marginX, y: yTop - 3, width: tableInnerW, height: 3, color: green });
    if (number) {
      const nr = L.nr + ' ' + number;
      const tw = fontBold.widthOfTextAtSize(nr, 9);
      page.drawText(nr, { x: PAGE_W - marginX - tw, y: yTop - 16, size: 9, font: fontBold, color: greenDark });
    }
    return yTop - 22;
  }

  let page = newPage();
  let y = drawChrome();

  function ensureSpace(need) {
    if (y - need < contentBottom) {
      page = newPage();
      y = drawChrome();
      return true;
    }
    return false;
  }

  function drawTxt(pg, text, opts) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return;
    pg.drawText(t, opts);
  }
  function drawCentered(pg, text, x, w, yy, size, useFont, color) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return;
    const tw = useFont.widthOfTextAtSize(t, size);
    pg.drawText(t, { x: x + Math.max(0, (w - tw) / 2), y: yy, size, font: useFont, color });
  }
  function drawRight(pg, text, rightX, yy, size, useFont, color) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return;
    const tw = useFont.widthOfTextAtSize(t, size);
    pg.drawText(t, { x: rightX - tw, y: yy, size, font: useFont, color });
  }
  function kmDisp(v) {
    if (v == null || v === '') return '';
    return String(v);
  }
  function siteLinesFromText(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    if (/\r|\n/.test(text)) {
      return text.split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);
    }
    return text.split(/\s*,\s*/).map((ln) => ln.trim()).filter(Boolean);
  }

  const overnight = an.naechtigung_beigestellt === true || an.naechtigung_beigestellt === 1 || an.naechtigung_beigestellt === '1';
  let fabs = [];
  if (Array.isArray(an.fabrikationsnummern)) fabs = an.fabrikationsnummern;
  else if (Array.isArray(payload && payload.fabrikationsnummern)) fabs = payload.fabrikationsnummern;
  if (!fabs.length) {
    const fn0 = String(an.fabrikationsnummer || '').trim();
    const ty0 = String(an.equipment_type || '').trim();
    if (fn0 || ty0) fabs = [{ fabrikationsnummer: fn0, type: ty0 }];
  }
  const fabRows = fabs.map((r) => ({
    fn: String((r && (r.fabrikationsnummer || r.fn)) || '').trim(),
    type: String((r && (r.type || r.typ)) || '').trim(),
  })).filter((r) => r.fn || r.type);
  const siteLines = siteLinesFromText(an.site || '').map((ln) => S(ln)).filter(Boolean);
  const living = S(an.living_costs || '').trim();
  const car = S(an.car_info || '').trim();
  const pad = 10;
  const halfW = tableInnerW / 2;
  const colInnerW = halfW - pad * 2;
  const leftX = marginX + pad;
  const rightX = marginX + halfW + pad;
  const custLines = wrapPdfPlain(fontBold, customerName || '', 9, colInnerW).filter((ln) => String(ln || '').trim());
  const techLines = wrapPdfPlain(fontBold, S(an.technician_name || ''), 9, colInnerW).filter((ln) => String(ln || '').trim());
  const siteWrapped = [];
  siteLines.forEach((ln) => {
    wrapPdfPlain(fontBold, ln, 9, colInnerW).forEach((wln) => {
      if (String(wln || '').trim()) siteWrapped.push(wln);
    });
  });
  const kmGap = 6;
  const kmColW = Math.floor((colInnerW - kmGap * 3) / 4);
  const carWrap = wrapPdfPlain(fontBold, car, 9, Math.max(18, kmColW - 2)).filter((ln) => String(ln || '').trim());
  const kmValH = Math.max(12, carWrap.length * 11);
  const kmRowH = 12 + kmValH + 4;
  const costsH = 24;
  const blockGap = 8;
  const leftH = 12 + Math.max(custLines.length, 1) * 11 + blockGap
    + 12 + Math.max(siteWrapped.length, 1) * 11;
  const rightH = 12 + Math.max(techLines.length, 1) * 11 + blockGap + kmRowH + blockGap + costsH;
  const metaH = pad * 2 + Math.max(leftH, rightH);

  page.drawRectangle({
    x: marginX,
    y: y - metaH,
    width: tableInnerW,
    height: metaH,
    color: greenHeader,
    borderColor: greenSoft,
    borderWidth: 0.8,
  });
  page.drawLine({
    start: { x: marginX + halfW, y: y - 7 },
    end: { x: marginX + halfW, y: y - metaH + 7 },
    thickness: 0.6,
    color: greenSoft,
  });

  const y0 = y - pad - 2;
  let ly = y0;
  drawTxt(page, S(L.customer), { x: leftX, y: ly, size: 7, font, color: grayMuted });
  ly -= 11;
  (custLines.length ? custLines : ['']).forEach((ln) => {
    drawTxt(page, ln, { x: leftX, y: ly, size: 9, font: fontBold, color: grayText });
    ly -= 11;
  });
  ly -= blockGap;
  drawTxt(page, S(L.site), { x: leftX, y: ly, size: 7, font, color: grayMuted });
  ly -= 11;
  (siteWrapped.length ? siteWrapped : ['']).forEach((ln) => {
    drawTxt(page, ln, { x: leftX, y: ly, size: 9, font: fontBold, color: grayText });
    ly -= 11;
  });

  let ry = y0;
  drawTxt(page, S(L.tech), { x: rightX, y: ry, size: 7, font, color: grayMuted });
  ry -= 11;
  (techLines.length ? techLines : ['']).forEach((ln) => {
    drawTxt(page, ln, { x: rightX, y: ry, size: 9, font: fontBold, color: grayText });
    ry -= 11;
  });
  ry -= blockGap;
  const kmCols = [
    { lab: L.car, valLines: carWrap },
    { lab: L.startKm, valLines: kmDisp(an.start_km) ? [kmDisp(an.start_km)] : [] },
    { lab: L.endKm, valLines: kmDisp(an.end_km) ? [kmDisp(an.end_km)] : [] },
    { lab: L.totalKm, valLines: kmDisp(an.total_km) ? [kmDisp(an.total_km)] : [] },
  ];
  let kx = rightX;
  kmCols.forEach((c) => {
    drawTxt(page, S(c.lab), { x: kx, y: ry, size: 7, font, color: grayMuted });
    (c.valLines && c.valLines.length ? c.valLines : ['']).forEach((ln, li) => {
      drawTxt(page, ln, { x: kx, y: ry - 12 - li * 11, size: 9, font: fontBold, color: grayText });
    });
    kx += kmColW + kmGap;
  });
  ry -= kmRowH + blockGap;
  const costW = Math.floor((colInnerW - kmGap) / 2);
  drawTxt(page, S(L.living), { x: rightX, y: ry, size: 7, font, color: grayMuted });
  drawTxt(page, S(L.overnight), { x: rightX + costW + kmGap, y: ry, size: 7, font, color: grayMuted });
  ry -= 11;
  drawTxt(page, living, { x: rightX, y: ry, size: 9, font: fontBold, color: grayText });
  drawTxt(page, overnight ? L.yes : L.noVal, {
    x: rightX + costW + kmGap,
    y: ry,
    size: 9,
    font: fontBold,
    color: grayText,
  });
  y -= metaH + 14;

  const colDate = 54;
  const colTime = 62;
  const colN = 36;
  const col50 = 34;
  const col100 = 36;
  const colWorks = tableInnerW - colDate - colTime - colN - col50 - col100;

  function drawTableHead(headers, widths) {
    const h = 16;
    ensureSpace(h + 4);
    page.drawRectangle({ x: marginX, y: y - h, width: tableInnerW, height: h, color: greenHeader });
    let x = marginX;
    headers.forEach((hTxt, i) => {
      page.drawText(S(hTxt), { x: x + 3, y: y - 12, size: 7, font: fontBold, color: greenDark });
      x += widths[i];
    });
    y -= h;
  }

  const colFn = 58;
  const colType = tableInnerW / 2 - colFn;
  const fabWidths = [colFn, colType, colFn, colType];
  if (fabRows.length) {
    drawTxt(page, S(de ? 'Anlagen' : 'Equipment'), {
      x: marginX,
      y,
      size: 9,
      font: fontBold,
      color: greenDark,
    });
    y -= 14;
    drawTableHead([L.fab, L.type, L.fab, L.type], fabWidths);
    const midX = marginX + colFn + colType;
    function drawFabSplit(topY, botY) {
      page.drawLine({
        start: { x: midX, y: topY },
        end: { x: midX, y: botY },
        thickness: 1.2,
        color: green,
      });
    }
    drawFabSplit(y + 16, y);
    for (let i = 0; i < fabRows.length; i += 2) {
      const a = fabRows[i];
      const b = fabRows[i + 1] || { fn: '', type: '' };
      const aFn = wrapPdfPlain(fontBold, S(a.fn), 8, colFn - 8);
      const bFn = wrapPdfPlain(fontBold, S(b.fn), 8, colFn - 8);
      const aType = wrapPdfPlain(font, S(a.type), 8, colType - 8);
      const bType = wrapPdfPlain(font, S(b.type), 8, colType - 8);
      const lines = Math.max(aFn.length, bFn.length, aType.length, bType.length, 1);
      const h = Math.max(16, lines * 10 + 6);
      if (ensureSpace(h + 2)) {
        drawTableHead([L.fab, L.type, L.fab, L.type], fabWidths);
        drawFabSplit(y + 16, y);
      }
      if ((i / 2) % 2 === 1) {
        page.drawRectangle({ x: marginX, y: y - h, width: tableInnerW, height: h, color: greenHeader });
      }
      page.drawLine({
        start: { x: marginX, y: y - h },
        end: { x: marginX + tableInnerW, y: y - h },
        thickness: 0.3,
        color: lineGray,
      });
      drawFabSplit(y, y - h);
      function drawCellLines(arr, x, useFont) {
        arr.forEach((ln, li) => {
          drawTxt(page, ln, { x, y: y - 11 - li * 10, size: 8, font: useFont, color: grayText });
        });
      }
      drawCellLines(aFn, marginX + 4, fontBold);
      drawCellLines(aType, marginX + colFn + 4, font);
      drawCellLines(bFn, midX + 6, fontBold);
      drawCellLines(bType, midX + colFn + 6, font);
      y -= h;
    }
    y -= 12;
  }

  drawTxt(page, S(L.works), { x: marginX, y, size: 9, font: fontBold, color: greenDark });
  y -= 14;
  drawTableHead([L.date, L.time, L.works, L.normal, L.ot50, L.ot100], [colDate, colTime, colWorks, colN, col50, col100]);

  let sumN = 0;
  let sum50 = 0;
  let sum100 = 0;
  work.forEach((row, idx) => {
    const descLines = wrapPdfPlain(font, S(row.description || ''), 8, colWorks - 6);
    const h = Math.max(16, descLines.length * 10 + 8);
    if (ensureSpace(h + 2)) {
      drawTableHead([L.date, L.time, L.works, L.normal, L.ot50, L.ot100], [colDate, colTime, colWorks, colN, col50, col100]);
    }
    if (idx % 2 === 1) {
      page.drawRectangle({ x: marginX, y: y - h, width: tableInnerW, height: h, color: greenHeader });
    }
    page.drawLine({
      start: { x: marginX, y: y - h },
      end: { x: marginX + tableInnerW, y: y - h },
      thickness: 0.3,
      color: lineGray,
    });
    const n = Number(row.normal_hours) || 0;
    const o50 = Number(row.overtime_50) || 0;
    const o100 = Number(row.overtime_100) || 0;
    sumN += n;
    sum50 += o50;
    sum100 += o100;
    const baseY = y - 12;
    page.drawText(fmtDate(row.item_date), { x: marginX + 3, y: baseY, size: 8, font, color: grayText });
    page.drawText(S(row.item_time || ''), { x: marginX + colDate + 3, y: baseY, size: 8, font, color: grayText });
    descLines.forEach((ln, li) => {
      page.drawText(ln, { x: marginX + colDate + colTime + 3, y: y - 12 - li * 10, size: 8, font, color: grayText });
    });
    const nx = marginX + colDate + colTime + colWorks;
    drawCentered(page, fmtNum(n), nx, colN, baseY, 8, font, grayText);
    drawCentered(page, fmtNum(o50), nx + colN, col50, baseY, 8, font, grayText);
    drawCentered(page, fmtNum(o100), nx + colN + col50, col100, baseY, 8, font, grayText);
    y -= h;
  });

  ensureSpace(18);
  page.drawRectangle({ x: marginX, y: y - 16, width: tableInnerW, height: 16, color: greenSoft });
  page.drawText(L.sum, { x: marginX + colDate + colTime + 3, y: y - 12, size: 8, font: fontBold, color: greenDark });
  const nx = marginX + colDate + colTime + colWorks;
  drawCentered(page, fmtNum(sumN) || '0', nx, colN, y - 12, 8, fontBold, greenDark);
  drawCentered(page, fmtNum(sum50) || '0', nx + colN, col50, y - 12, 8, fontBold, greenDark);
  drawCentered(page, fmtNum(sum100) || '0', nx + colN + col50, col100, y - 12, 8, fontBold, greenDark);
  y -= 22;

  if (parts.length) {
    const colQty = 32;
    const colType = 72;
    const colComment = Math.floor(tableInnerW * 0.34);
    const colDes = tableInnerW - colQty - colType - colComment;
    drawTableHead([L.qty, L.designation, L.typeNo, L.comment], [colQty, colDes, colType, colComment]);
    parts.forEach((row, idx) => {
      const desLines = wrapPdfPlain(font, S(row.designation || ''), 8, colDes - 6);
      const cmtLines = wrapPdfPlain(font, S(row.description || row.comment || ''), 8, colComment - 6);
      const h = Math.max(16, Math.max(desLines.length, cmtLines.length) * 10 + 6);
      if (ensureSpace(h + 2)) {
        drawTableHead([L.qty, L.designation, L.typeNo, L.comment], [colQty, colDes, colType, colComment]);
      }
      if (idx % 2 === 1) {
        page.drawRectangle({ x: marginX, y: y - h, width: tableInnerW, height: h, color: greenHeader });
      }
      page.drawText(fmtNum(row.quantity) || String(row.quantity || ''), {
        x: marginX + 3,
        y: y - 12,
        size: 8,
        font,
        color: grayText,
      });
      desLines.forEach((ln, li) => {
        page.drawText(ln, { x: marginX + colQty + 3, y: y - 12 - li * 10, size: 8, font, color: grayText });
      });
      page.drawText(S(row.type_no || ''), {
        x: marginX + colQty + colDes + 3,
        y: y - 12,
        size: 8,
        font,
        color: grayText,
      });
      cmtLines.forEach((ln, li) => {
        page.drawText(ln, {
          x: marginX + colQty + colDes + colType + 3,
          y: y - 12 - li * 10,
          size: 8,
          font,
          color: grayText,
        });
      });
      y -= h;
    });
    y -= 10;
  }

  const remarks = S(an.remarks || '').trim();
  if (remarks) {
    const rLines = wrapPdfPlain(font, remarks, 9, tableInnerW - 8);
    ensureSpace(18 + rLines.length * 11);
    page.drawText(L.remarks, { x: marginX, y: y, size: 9, font: fontBold, color: greenDark });
    y -= 14;
    rLines.forEach((ln) => {
      page.drawText(ln, { x: marginX, y: y, size: 9, font, color: grayText });
      y -= 11;
    });
    y -= 8;
  }

  const confirmLines = wrapPdfPlain(font, L.confirm, 8, tableInnerW);
  const sigH = 56;
  const sigBlockH = 28 + confirmLines.length * 11 + sigH + 24;
  ensureSpace(sigBlockH);
  confirmLines.forEach((ln) => {
    page.drawText(ln, { x: marginX, y: y, size: 8, font, color: grayText });
    y -= 11;
  });
  y -= 8;
  const sigW = (tableInnerW - 16) / 2;
  function drawSigBox(x, img, label, name, signedAt) {
    page.drawText(S(label), { x: x, y: y, size: 7, font, color: grayMuted });
    page.drawRectangle({
      x: x,
      y: y - sigH - 4,
      width: sigW,
      height: sigH,
      borderColor: greenSoft,
      borderWidth: 0.7,
      color: white,
    });
    if (img) {
      const scale = Math.min((sigW - 12) / img.width, (sigH - 10) / img.height, 1);
      page.drawImage(img, {
        x: x + 6,
        y: y - sigH + 2,
        width: img.width * scale,
        height: img.height * scale,
      });
    }
    const nameY = y - sigH - 16;
    const stamp = signedAt ? fmtDateTime(signedAt) : '';
    const stampW = stamp ? font.widthOfTextAtSize(stamp, 8) : 0;
    const nameMaxW = stamp ? Math.max(40, sigW - stampW - 8) : sigW;
    if (name) {
      let nm = S(name);
      while (nm.length > 1 && font.widthOfTextAtSize(nm, 8) > nameMaxW) {
        nm = nm.slice(0, -1);
      }
      page.drawText(nm, { x: x, y: nameY, size: 8, font, color: grayText });
    }
    if (stamp) {
      drawRight(page, stamp, x + sigW, nameY, 8, font, grayMuted);
    }
  }
  const custName = S((payload && payload.customer_signer_name) || '').trim();
  drawSigBox(marginX, techSig, L.sigTech, S(an.technician_name || ''));
  drawSigBox(marginX + sigW + 16, custSig, L.sigCust, custName, pickCustomerSignedAt());

  const count = pages.length;
  pages.forEach((p, idx) => {
    const footerLineY = marginBottom + PROTOCOL_FOOTER_RESERVED_H - 10;
    p.drawLine({
      start: { x: marginX, y: footerLineY },
      end: { x: marginX + tableInnerW, y: footerLineY },
      thickness: 0.6,
      color: greenSoft,
    });
    p.drawText(S(L.footer), { x: marginX, y: marginBottom, size: 7, font, color: grayMuted });
    const pageLabel = L.page + ' ' + (idx + 1);
    const tw = font.widthOfTextAtSize(pageLabel, 8);
    p.drawText(pageLabel, {
      x: PAGE_W - marginX - tw,
      y: marginBottom,
      size: 8,
      font,
      color: grayMuted,
    });
  });
  void count;

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  generateServiceprotokollPdfBuffer,
  generateKontrollwiegungPdfBuffer,
  generateSchleppkettenPdfBuffer,
  generateMontageberichtPdfBuffer,
  generatePruefzertifikatPdfBuffer,
  generateArbeitsnachweisPdfBuffer,
  htmlToMbContentBlocks,
  htmlFragmentToPlainPdf,
};
