/**
 * Montagebericht-DOCX-Generator mit docx-Bibliothek
 * Erzeugt das Montagebericht-Dokument programmatisch (Calibri, feste Spaltenbreiten).
 */
const path = require('path');
const fs = require('fs');

/** JPG/JPEG-Buffer: weiße Pixel transparent machen, als PNG zurückgeben. Schwellwert 0–255 (z. B. 250 = fast weiß). */
async function makeWhiteTransparentPng(jpegBuffer, whiteThreshold = 250) {
  const sharp = require('sharp');
  const { data, info } = await sharp(jpegBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
      data[i + 3] = 0;
    }
  }
  return sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  VerticalAlign,
  TextRun,
  TableLayoutType,
  BorderStyle,
  HeightRule,
  AlignmentType,
} = require('docx');

const sanitize = (v) => {
  if (v == null || v === undefined) return '';
  const s = decodeHtmlEntities(String(v).trim());
  return (s === 'undefined' || s === 'null') ? '' : s;
};

/** HTML-Entities aus Rich-Text (&nbsp; usw.) für sichtbaren DOCX/PDF-Text auflösen. */
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&thinsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&#x0*a0;/gi, ' ')
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

/** Gesamttabelle ~17,7 cm (10060 DXA). Label-Spalte schmaler → Trennlinie weiter links. */
const TABLE_W = 10060;
/** Label-Spalte: eng an „Grund des Einsatzes:“ / „purpose of visit:“, aber spürbar schmaler als 1/3. */
const COL_LABEL = 2480;
const COL_MID = 4300;
const COL_RIGHT = TABLE_W - COL_LABEL - COL_MID;
const HEADER_COL_WIDTHS = [COL_LABEL, COL_MID, COL_RIGHT];

/** Mehr Abstand Text ↔ Zellrand (DXA / Twips). */
const CELL_MARGINS = { top: 60, bottom: 60, left: 120, right: 120 };
const CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
};

function mbCell(children, opts = {}) {
  const {
    columnSpan,
    verticalAlign,
    margins = CELL_MARGINS,
    borders = CELL_BORDERS,
    width,
  } = opts;
  return new TableCell({
    children,
    ...(columnSpan ? { columnSpan } : {}),
    ...(verticalAlign ? { verticalAlign } : {}),
    margins,
    borders,
    ...(width ? { width: { size: width, type: WidthType.DXA } } : {}),
  });
}

function sizeFromCssPx(px) {
  const n = parseFloat((px || '').toString().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(16, Math.min(96, Math.round((n * 72 / 96) * 2)));
}

function readImageSizeFromBuffer(buf, typeHint) {
  try {
    if (!buf || buf.length < 24) return null;
    const t = String(typeHint || '').toLowerCase();
    if (t === 'png' || (buf[0] === 0x89 && buf[1] === 0x50)) {
      if (buf.length < 24) return null;
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (t === 'jpg' || t === 'jpeg' || (buf[0] === 0xff && buf[1] === 0xd8)) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        if (len < 2) break;
        i += 2 + len;
      }
    }
    if (t === 'gif' || (buf[0] === 0x47 && buf[1] === 0x49)) {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Data-URL &lt;img&gt; → ImageRun für DOCX (Base64 aus dem Richtext-Editor).
 * @returns {InstanceType<typeof ImageRun>|null}
 */
function imageRunFromDataUrl(src, styleText) {
  const rawSrc = decodeHtmlEntities(String(src || '').trim());
  const m = rawSrc.match(/^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  let type = m[1].toLowerCase();
  if (type === 'jpeg') type = 'jpg';
  if (type === 'webp') type = 'png';
  let data;
  try {
    data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    return null;
  }
  if (!data || data.length < 32) return null;

  const style = parseStyle(styleText || '');
  const natural = readImageSizeFromBuffer(data, type) || { width: 420, height: 315 };
  let widthPx = 420;
  if (style.width) {
    const w = String(style.width).trim();
    if (/%/.test(w)) {
      const pct = parseFloat(w) || 100;
      widthPx = Math.round(520 * Math.min(100, Math.max(10, pct)) / 100);
    } else {
      const px = parseFloat(w);
      if (Number.isFinite(px) && px > 0) widthPx = Math.min(520, Math.max(40, Math.round(px)));
    }
  } else if (natural.width > 0 && natural.width < 420) {
    widthPx = Math.max(40, Math.min(420, natural.width));
  }
  const ratio = natural.height > 0 && natural.width > 0 ? (natural.height / natural.width) : 0.75;
  let heightPx = Math.max(16, Math.round(widthPx * ratio));

  try {
    if (type !== 'jpg' && type !== 'png' && type !== 'gif' && type !== 'bmp') {
      type = 'jpg';
    }
    return new ImageRun({
      type,
      data,
      transformation: { width: widthPx, height: heightPx },
    });
  } catch (_) {
    return null;
  }
}

function parseImgSrcFromToken(token) {
  const srcMatch = String(token || '').match(/\ssrc\s*=\s*["']([^"']+)["']/i);
  return srcMatch ? srcMatch[1] : '';
}

function parseStyle(styleText) {
  const out = {};
  (styleText || '').split(';').forEach((part) => {
    const idx = part.indexOf(':');
    if (idx <= 0) return;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    out[k] = v;
  });
  return out;
}

function mergeStyle(base, extra) {
  return {
    bold: base.bold || extra.bold,
    italics: base.italics || extra.italics,
    underline: base.underline || extra.underline,
    font: extra.font || base.font || 'Calibri',
    size: extra.size || base.size || null,
    align: extra.align || base.align || null,
  };
}

function styleFromTag(tag, styleAttr) {
  const lower = (tag || '').toLowerCase();
  const css = parseStyle(styleAttr || '');
  const out = {};
  if (lower === 'b' || lower === 'strong') out.bold = true;
  if (lower === 'i' || lower === 'em') out.italics = true;
  if (lower === 'u') out.underline = true;
  if (css['font-weight'] && (css['font-weight'] === 'bold' || parseInt(css['font-weight'], 10) >= 600)) out.bold = true;
  if (css['font-style'] === 'italic') out.italics = true;
  if (css['text-decoration'] && css['text-decoration'].toLowerCase().indexOf('underline') >= 0) out.underline = true;
  if (css['font-family']) out.font = css['font-family'].replace(/["']/g, '').split(',')[0].trim();
  const cssSize = css['font-size'] ? sizeFromCssPx(css['font-size']) : null;
  if (cssSize) out.size = cssSize;
  if (css['text-align']) {
    const a = css['text-align'].toLowerCase();
    if (a === 'center') out.align = AlignmentType.CENTER;
    else if (a === 'right') out.align = AlignmentType.RIGHT;
    else out.align = AlignmentType.LEFT;
  }
  return out;
}

function htmlToParagraphs(html, defaultSizeHalfPt = 24) {
  let raw = (html || '').toString();
  if (!raw.trim()) return [];
  /* Layout-Tabellen der E-Mail → flacher Fließtext (PDF/DOCX ohne Raster) */
  raw = raw
    .replace(/<\/?(table|thead|tbody|tfoot|tr|td|th)\b[^>]*>/gi, (m) => {
      if (/^<\s*\//i.test(m)) {
        if (/\/\s*tr\b/i.test(m) || /\/\s*table\b/i.test(m)) return '<br>';
        return '';
      }
      return '';
    });
  /* Doppelte gleiche Bilder entfernen (Outlook/Clipboard-Artefakt, auch nicht benachbart) */
  {
    const seenImg = new Set();
    raw = raw.replace(/<img\b[^>]*>/gi, (tag) => {
      const srcMatch = tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i);
      if (!srcMatch) return tag;
      let key = srcMatch[1];
      if (/^data:image\//i.test(key)) {
        const payload = key.replace(/^data:image\/[^;]+;base64,/i, '').replace(/\s+/g, '');
        key = `d:${payload.length}:${payload.slice(0, 40)}:${payload.slice(-20)}`;
      } else {
        key = key.replace(/^https?:/i, 'https:').split('#')[0].toLowerCase();
      }
      if (seenImg.has(key)) return '';
      seenImg.add(key);
      return tag;
    });
  }
  const tokens = raw
    .replace(/\r\n?/g, '\n')
    .split(/(<[^>]+>)/g)
    .filter(Boolean);
  const paragraphs = [];
  let current = { runs: [], bullet: false, align: null };
  let inList = false;
  let styleStack = [{ bold: false, italics: false, underline: false, font: 'Calibri', size: defaultSizeHalfPt, align: null }];
  const pushParagraph = () => {
    if (current.runs.length === 0 && !current.bullet) return;
    paragraphs.push(current);
    current = { runs: [], bullet: false, align: null };
  };
  const addText = (text) => {
    const cleaned = decodeHtmlEntities(text || '').replace(/\s+/g, ' ');
    if (!cleaned.trim()) return;
    const st = styleStack[styleStack.length - 1];
    current.runs.push({
      text: cleaned,
      bold: !!st.bold,
      italics: !!st.italics,
      underline: !!st.underline,
      font: st.font || 'Calibri',
      size: st.size || defaultSizeHalfPt,
    });
    if (!current.align && st.align) current.align = st.align;
  };
  tokens.forEach((token) => {
    if (token.charAt(0) !== '<') {
      addText(token);
      return;
    }
    const isClose = /^<\s*\//.test(token);
    const nameMatch = token.match(/^<\s*\/?\s*([a-zA-Z0-9]+)/);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (!tag) return;
    if (isClose) {
      if (tag === 'li' || tag === 'p' || tag === 'div') pushParagraph();
      if (tag === 'ul' || tag === 'ol') inList = false;
      if (styleStack.length > 1) styleStack.pop();
      return;
    }
    const styleAttrMatch = token.match(/\sstyle\s*=\s*["']([^"']*)["']/i);
    const merged = mergeStyle(styleStack[styleStack.length - 1], styleFromTag(tag, styleAttrMatch ? styleAttrMatch[1] : ''));
    styleStack.push(merged);
    if (tag === 'ul' || tag === 'ol') inList = true;
    if (tag === 'li') current.bullet = true;
    if (tag === 'p' || tag === 'div') {
      if (current.runs.length > 0 || current.bullet) pushParagraph();
      if (merged.align) current.align = merged.align;
    }
    if (tag === 'br') {
      const st = styleStack[styleStack.length - 1];
      current.runs.push(new TextRun({ break: 1, font: st.font || 'Calibri', size: st.size || defaultSizeHalfPt }));
    }
    if (tag === 'img') {
      const src = parseImgSrcFromToken(token);
      const styleAttr = styleAttrMatch ? styleAttrMatch[1] : '';
      const imgRun = imageRunFromDataUrl(src, styleAttr);
      if (imgRun) {
        if (current.runs.length > 0) pushParagraph();
        current.runs.push(imgRun);
        pushParagraph();
      }
      if (styleStack.length > 1) styleStack.pop();
    }
  });
  pushParagraph();
  return paragraphs.map((p) => {
    const runs = p.runs.map((r) => {
      if (r instanceof TextRun || r instanceof ImageRun) return r;
      const runObj = { ...r };
      if (p.bullet && typeof runObj.text === 'string') {
        runObj.text = runObj.text.replace(/^\s*([•\-]\s*)+/, '');
      }
      return new TextRun(runObj);
    });
    return new Paragraph({
      children: runs.length > 0 ? runs : [new TextRun({ text: '', font: 'Calibri', size: defaultSizeHalfPt })],
      bullet: p.bullet ? { level: 0 } : undefined,
      alignment: p.align || undefined,
    });
  });
}

function createFnTable(fn, L) {
  /* Volles Rich-HTML der FN-Bemerkungen bevorzugen (Bilder/E-Mail), sonst Textbausteine */
  const fabHtml = sanitize(fn && fn.bemerkungen_html != null ? fn.bemerkungen_html : '');
  const textbausteine = Array.isArray(fn.textbausteine)
    ? fn.textbausteine.map((tb) => ({
        text: sanitize(tb && tb.text != null ? tb.text : ''),
        html: sanitize(tb && tb.html != null ? tb.html : ''),
      })).filter((t) => t.text || t.html)
    : [];

  function paragraphsFromPlainLines(text) {
    const parts = (text || '')
      .toString()
      .replace(/\u2022/g, '\n')
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*([•▪◦●\-]\s*)+/, '').trim())
      .filter(Boolean);
    if (!parts.length) {
      return [new Paragraph({ children: [new TextRun({ text: '', font: 'Calibri', size: 22 })] })];
    }
    return parts.map((line) => new Paragraph({
      children: [new TextRun({ text: line, font: 'Calibri', size: 22 })],
    }));
  }

  let textbausteinParagraphs;
  if (fabHtml && /<\s*\/?\s*[a-z][^>]*>/i.test(fabHtml)) {
    const rich = htmlToParagraphs(fabHtml, 22);
    textbausteinParagraphs = rich.length > 0 ? rich : paragraphsFromPlainLines(sanitize(fn.bemerkungen || ''));
  } else if (textbausteine.length > 0) {
    textbausteinParagraphs = textbausteine.flatMap((tb) => {
      const rawHtml = (tb.html || '').toString();
      const hasHtmlMarkup = /<\s*\/?\s*[a-z][^>]*>/i.test(rawHtml);
      const richParagraphs = hasHtmlMarkup ? htmlToParagraphs(rawHtml, 22) : [];
      if (hasHtmlMarkup && richParagraphs.length > 0) {
        return richParagraphs;
      }
      return paragraphsFromPlainLines(tb.text || '');
    });
  } else {
    textbausteinParagraphs = paragraphsFromPlainLines(sanitize(fn.bemerkungen || ''));
  }

  // 3 Spalten: FN. | Type | Pos.Nr. – mit Einzug wie Kopfbereich
  const fnCol = Math.floor(TABLE_W / 3);
  const colWidths = [fnCol, fnCol, TABLE_W - fnCol * 2];

  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA },
    columnWidths: colWidths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: [
          mbCell([
            new Paragraph({
              children: [
                new TextRun({ text: `${L.fn} `, font: 'Calibri', bold: true }),
                new TextRun({ text: sanitize(fn.fabrikationsnummer), font: 'Calibri', bold: false }),
              ],
            }),
          ], { width: colWidths[0] }),
          mbCell([
            new Paragraph({
              children: [
                new TextRun({ text: `${L.type} `, font: 'Calibri', bold: true }),
                new TextRun({ text: sanitize(fn.type), font: 'Calibri', bold: false }),
              ],
            }),
          ], { width: colWidths[1] }),
          mbCell([
            new Paragraph({
              children: [
                new TextRun({ text: `${L.posNr} `, font: 'Calibri', bold: true }),
                new TextRun({ text: sanitize(fn.position), font: 'Calibri', bold: false }),
              ],
            }),
          ], { width: colWidths[2] }),
        ],
      }),
      new TableRow({
        children: [
          mbCell(textbausteinParagraphs, { columnSpan: 3, width: TABLE_W }),
        ],
      }),
    ],
  });
}

async function getLogoCellContent(dirname) {
  const logoPaths = [
    path.join(dirname, 'public', 'assets', 'img', 'kukla_logo.png'),
    path.join(dirname, '..', '..', 'dispo', 'assets', 'templates', 'protokoll', '_extract_de', 'word', 'media', 'image1.jpeg'),
    path.join(dirname, 'public', 'assets', 'img', 'kukla_logo.jpg'),
  ];
  for (const logoPath of logoPaths) {
    if (fs.existsSync(logoPath)) {
      try {
        let logoData = fs.readFileSync(logoPath);
        const ext = path.extname(logoPath).toLowerCase();
        let mimeType = ext === '.png' ? 'png' : 'jpeg';
        // Bei JPG/JPEG: weißen Hintergrund transparent machen (als PNG einbetten)
        if (ext === '.jpg' || ext === '.jpeg') {
          try {
            logoData = await makeWhiteTransparentPng(logoData, 250);
            mimeType = 'png';
          } catch (imgErr) {
            console.warn('Logo Weiß→transparent fehlgeschlagen, verwende Original:', imgErr.message);
          }
        }
        // Logo als schwebendes Bild hinter die Zelle (behindDocument), damit der Zellenrahmen über dem Bild liegt
        return [
          new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [
              new ImageRun({
                type: mimeType,
                data: logoData,
                transformation: { width: 137, height: 92 },
                floating: {
                  behindDocument: true,
                  layoutInCell: true,
                  horizontalPosition: { relative: 'column', align: 'left', offset: 91440 },
                  verticalPosition: { relative: 'paragraph', align: 'top', offset: 45720 },
                },
              }),
            ],
          }),
        ];
      } catch (e) {
        console.warn('Logo konnte nicht geladen werden:', logoPath, e.message);
      }
    }
  }
  return [new Paragraph({ text: '' })];
}

function formatDatum(kopfdaten, jobRow) {
  const explicit = sanitize(kopfdaten.datum);
  if (explicit) return explicit;
  const start = jobRow && jobRow.start_datetime ? new Date(jobRow.start_datetime).toISOString().slice(0, 10) : null;
  const end = jobRow && jobRow.end_datetime ? new Date(jobRow.end_datetime).toISOString().slice(0, 10) : null;
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || new Date().toISOString().slice(0, 10);
}

/**
 * Erzeugt den Montagebericht als DOCX-Buffer.
 * @param {Object} options
 * @param {Object} options.kopfdaten - { kunde, projekt, datum, geliefertUeber, servicetechniker, ansprechperson, bemerkungen }
 * @param {Array} options.tableRows - [{ fabrikationsnummer, type, position, textbausteine }]
 * @param {string} options.language - 'de' oder 'en'
 * @param {Object} options.jobRow - { customer_name, job_number, description, start_datetime, end_datetime }
 * @param {string} options.grundDesEinsatzes
 * @param {string} options.grundDesEinsatzes_html
 * @param {string} options.freitext
 * @returns {Promise<Buffer>}
 */
async function buildMontageberichtDocx(options) {
  const { kopfdaten = {}, tableRows = [], language = 'de', jobRow = {}, grundDesEinsatzes = '', grundDesEinsatzes_html = '', freitext = '' } = options;
  const isEn = language === 'en';
  const L = {
    title: isEn ? 'Assembly report' : 'Montagebericht',
    kunde: isEn ? 'customer:' : 'Kunde:',
    geliefertUeber: isEn ? 'delivered via:' : 'geliefert über:',
    projekt: isEn ? 'project:' : 'Projekt:',
    datum: isEn ? 'date:' : 'Datum:',
    fn: isEn ? 'FN.' : 'FN.',
    type: isEn ? 'type:' : 'Type:',
    posNr: isEn ? 'pos.No.:' : 'Pos.Nr.:',
    bemerkungen: isEn ? 'Remarks' : 'Bemerkungen',
    servicetechniker: isEn ? 'service engineer:' : 'Servicetechniker:',
    ansprechperson: isEn ? 'contact person:' : 'Ansprechperson:',
    grundDesEinsatzes: isEn ? 'purpose of visit:' : 'Grund des Einsatzes:',
  };

  const kunde = sanitize(kopfdaten.kunde ?? jobRow.customer_name ?? '');
  const projekt = sanitize(kopfdaten.projekt ?? '');
  const datumStr = formatDatum(kopfdaten, jobRow);
  const geliefertUeber = sanitize(kopfdaten.geliefertUeber ?? '');
  const servicetechniker = sanitize(kopfdaten.servicetechniker ?? '');
  const ansprechperson = sanitize(kopfdaten.ansprechperson ?? '');
  const grundVal = sanitize(grundDesEinsatzes) + (freitext ? ' ' + sanitize(freitext) : '');
  const grundHtml = sanitize(grundDesEinsatzes_html);
  const fnList = tableRows.map((r) => r.fabrikationsnummer).filter(Boolean).join(', ');
  const bemerkungen = sanitize(kopfdaten.bemerkungen ?? '');
  const bemerkungenHtml = sanitize(kopfdaten.bemerkungen_html ?? '');
  const grundParagraphs = htmlToParagraphs(grundHtml || grundVal, 24);
  const bemerkungenParagraphs = htmlToParagraphs(bemerkungenHtml || bemerkungen, 24);

  const logoCellContent = await getLogoCellContent(__dirname);

  const headerTable = new Table({
    width: { size: TABLE_W, type: WidthType.DXA },
    columnWidths: HEADER_COL_WIDTHS,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        height: { value: 1390, rule: HeightRule.EXACT }, // max 2,45 cm (Logo ~2,43 cm), in 1/20 pt (2,45 cm ≈ 69,5 pt)
        children: [
          mbCell(logoCellContent, {
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            width: COL_LABEL,
          }),
          mbCell(
            [
              new Paragraph({
                children: [
                  new TextRun({ text: L.title, font: 'Calibri', bold: true, size: 50 }),
                ],
              }),
            ],
            {
              columnSpan: 2,
              verticalAlign: VerticalAlign.CENTER,
              margins: CELL_MARGINS,
              width: COL_MID + COL_RIGHT,
            }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.kunde, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: kunde, font: 'Calibri', size: 24 })] })],
            { width: COL_MID }
          ),
          mbCell(
            [
              new Paragraph({
                children: [
                  new TextRun({ text: L.geliefertUeber + ' ', font: 'Calibri', bold: true, size: 24 }),
                  new TextRun({ text: geliefertUeber, font: 'Calibri', size: 24 }),
                ],
              }),
            ],
            { width: COL_RIGHT }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.projekt, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: projekt, font: 'Calibri', size: 24 })] })],
            { width: COL_MID }
          ),
          mbCell(
            [
              new Paragraph({
                children: [
                  new TextRun({ text: L.datum + ' ', font: 'Calibri', bold: true, size: 24 }),
                  new TextRun({ text: datumStr, font: 'Calibri', size: 24 }),
                ],
              }),
            ],
            { width: COL_RIGHT }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.fn + ':', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: fnList, font: 'Calibri', size: 24 })] })],
            { columnSpan: 2, width: COL_MID + COL_RIGHT }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.servicetechniker, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: servicetechniker, font: 'Calibri', size: 24 })] })],
            { columnSpan: 2, width: COL_MID + COL_RIGHT }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.ansprechperson, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: ansprechperson, font: 'Calibri', size: 24 })] })],
            { columnSpan: 2, width: COL_MID + COL_RIGHT }
          ),
        ],
      }),
      new TableRow({
        children: [
          mbCell(
            [new Paragraph({ children: [new TextRun({ text: L.grundDesEinsatzes, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            { verticalAlign: VerticalAlign.CENTER, width: COL_LABEL }
          ),
          mbCell(
            grundParagraphs.length > 0
              ? grundParagraphs
              : [new Paragraph({ children: [new TextRun({ text: grundVal, font: 'Calibri', size: 24 })] })],
            { columnSpan: 2, width: COL_MID + COL_RIGHT }
          ),
        ],
      }),
    ],
  });

  const tableSpacing = new Paragraph({ text: '', spacing: { before: 100 } });

  const children = [
    headerTable,
    tableSpacing,
    ...tableRows.flatMap((fn, i) =>
      i === 0 ? [createFnTable(fn, L)] : [tableSpacing, createFnTable(fn, L)]
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: L.bemerkungen + ':', font: 'Calibri', bold: true })] }),
    new Paragraph({ text: '' }),
    ...(bemerkungenParagraphs.length > 0 ? bemerkungenParagraphs : [new Paragraph({ children: [new TextRun({ text: bemerkungen, font: 'Calibri' })] })]),
    new Paragraph({ text: '' }),
  ];

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildMontageberichtDocx };
