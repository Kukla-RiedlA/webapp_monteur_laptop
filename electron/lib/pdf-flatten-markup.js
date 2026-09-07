'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, LineCapStyle } = require('pdf-lib');
const { sanitizeForWinAnsi } = require('./pdf-winansi');
const { isProjekteNeuMontageFolderName } = require('./projekte-neu-local');

const WORK_LEAF_FOLDERS = new Set(['protokolle', 'bilder', 'pdf', 'parameter', 'allgemein', 'angebot']);

const MAX_STROKES = 800;
const MAX_TEXTS = 200;
const MAX_POINTS = 4000;
const ALLOWED_COLORS = new Set(['#c1121f', '#0e7b5a', '#1a1a1a']);

function stripOpenCachePrefix(base) {
  return String(base || '').replace(/^\d{14}_/, '');
}

function annotatedPdfFileName(sourcePath) {
  const resolved = path.normalize(String(sourcePath || '').trim());
  const ext = path.extname(resolved) || '.pdf';
  const base = stripOpenCachePrefix(path.basename(resolved, ext));
  if (/_kommentiert$/i.test(base)) return base + ext;
  return base + '_kommentiert' + ext;
}

function extractFabHintFromFileName(filePath) {
  const base = stripOpenCachePrefix(path.basename(String(filePath || ''), path.extname(filePath || '')));
  const m = base.match(/^(\d{4,})(?:\D|$)/);
  return m ? m[1] : '';
}

function fnFolderMatchesFab(name, fab) {
  const n = String(name || '').trim();
  const f = String(fab || '').trim();
  if (!n || !f) return false;
  if (n === f || n.startsWith(f + '_') || n.startsWith(f + ' ') || n.startsWith(f + '-')) return true;
  const range = n.match(/^(\d+)\s*[-–]\s*(\d+)/);
  if (!range) return false;
  const a = parseInt(range[1], 10);
  const b = parseInt(range[2], 10);
  const x = parseInt(f, 10);
  return Number.isFinite(x) && x >= Math.min(a, b) && x <= Math.max(a, b);
}

function looksLikeLaptopAuftragsordner(name) {
  return /^\d{4}-\d{2}-\d{2}_/.test(String(name || '').trim());
}

function isWorkLeafFolder(name) {
  return WORK_LEAF_FOLDERS.has(String(name || '').trim().toLowerCase());
}

function usableAuftragsordnerName(name) {
  const n = String(name || '').trim();
  if (!n || isWorkLeafFolder(n) || isProjekteNeuMontageFolderName(n)) return '';
  return n;
}

function findExistingAuftragsordner(montageDir) {
  if (!montageDir || !fs.existsSync(montageDir)) return '';
  let names = [];
  try {
    names = fs
      .readdirSync(montageDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_) {
    return '';
  }
  const laptop = names.filter(looksLikeLaptopAuftragsordner).sort().reverse();
  for (const n of laptop) {
    if (fs.existsSync(path.join(montageDir, n, 'Protokolle'))) return n;
  }
  if (laptop.length) return laptop[0];
  const usable = names.map(usableAuftragsordnerName).filter(Boolean);
  for (const n of usable) {
    if (fs.existsSync(path.join(montageDir, n, 'Protokolle'))) return n;
  }
  return usable[0] || '';
}

function resolveFromReiseDir(reiseDir, fabHint) {
  const root = String(reiseDir || '').trim();
  const fab = String(fabHint || '').trim();
  if (!root || !fab) return '';
  const monteur = path.join(root, 'Dokumente_Monteur');
  if (!fs.existsSync(monteur)) return '';
  let names = [];
  try {
    names = fs
      .readdirSync(monteur, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_) {
    return '';
  }
  const matches = names.filter((n) => fnFolderMatchesFab(n, fab)).sort((a, b) => b.length - a.length);
  for (const fnFolder of matches) {
    const montageDir = path.join(monteur, fnFolder, 'Montage');
    const ao = findExistingAuftragsordner(montageDir);
    if (ao) return path.join(montageDir, ao, 'PDF');
  }
  return '';
}

/**
 * Ziel: Dokumente_Monteur/<FN>/Montage/<Auftragsordner>/PDF
 * gleicher Ordner wie Protokolle/Bilder, nicht der PROJEKTE-NEU-Montageordner.
 */
function resolveMonteurMontagePdfDir(sourcePath, opts) {
  const resolved = path.normalize(String(sourcePath || '').trim());
  if (!resolved) return '';
  const re = /^(.*?)[/\\]Dokumente_(?:Monteur|Anlage)[/\\]([^/\\]+)(.*)$/i;
  const m = resolved.match(re);
  if (m) {
    const root = m[1];
    const fnFolder = String(m[2] || '').trim();
    if (fnFolder && !/^Montage$/i.test(fnFolder)) {
      const rest = String(m[3] || '').replace(/^[/\\]+/, '');
      const parts = rest.split(/[/\\]/).filter(Boolean);
      let ao = '';
      if (parts[0] && /^Montage$/i.test(parts[0])) {
        ao = usableAuftragsordnerName(parts[1] || '');
      }
      const montageDir = path.join(root, 'Dokumente_Monteur', fnFolder, 'Montage');
      if (!ao) ao = findExistingAuftragsordner(montageDir);
      if (ao) return path.join(montageDir, ao, 'PDF');
    }
  }
  const fabHint = String((opts && opts.fabHint) || extractFabHintFromFileName(resolved) || '').trim();
  const dirs = Array.isArray(opts && opts.reiseDirs) ? opts.reiseDirs : [];
  for (const reiseDir of dirs) {
    const hit = resolveFromReiseDir(reiseDir, fabHint);
    if (hit) return hit;
  }
  return '';
}

function suggestedAnnotatedPath(sourcePath, opts) {
  const resolved = path.normalize(String(sourcePath || '').trim());
  const name = annotatedPdfFileName(resolved);
  const destDir = resolveMonteurMontagePdfDir(resolved, opts) || path.dirname(resolved);
  return path.join(destDir, name);
}

function hexToRgb(hex) {
  const raw = String(hex || '').trim().toLowerCase();
  const normalized = ALLOWED_COLORS.has(raw) ? raw : '#c1121f';
  const h = normalized.slice(1);
  return rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  );
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampPt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function shapeKind(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (k === 'line' || k === 'circle') return k;
  return 'pen';
}

function normalizeMarkup(markup) {
  const src = markup && typeof markup === 'object' ? markup : {};
  const strokes = [];
  const texts = [];
  const rawStrokes = Array.isArray(src.strokes) ? src.strokes : [];
  for (let i = 0; i < rawStrokes.length && strokes.length < MAX_STROKES; i += 1) {
    const s = rawStrokes[i];
    if (!s || typeof s !== 'object') continue;
    const kind = shapeKind(s.kind);
    const ptsIn = Array.isArray(s.points) ? s.points : [];
    const points = [];
    for (let p = 0; p < ptsIn.length && points.length < MAX_POINTS; p += 1) {
      const pt = ptsIn[p];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      points.push([clamp01(pt[0]), clamp01(pt[1])]);
    }
    if (kind === 'line' || kind === 'circle') {
      if (points.length < 2) continue;
      points.splice(0, points.length, points[0], points[points.length - 1]);
    } else if (points.length < 2) {
      continue;
    }
    strokes.push({
      kind,
      page: Math.max(0, parseInt(s.page, 10) || 0),
      color: String(s.color || '#c1121f'),
      widthPt: clampPt(s.widthPt, 0.6, 12, 2.5),
      points,
    });
  }
  const rawTexts = Array.isArray(src.texts) ? src.texts : [];
  for (let i = 0; i < rawTexts.length && texts.length < MAX_TEXTS; i += 1) {
    const t = rawTexts[i];
    if (!t || typeof t !== 'object') continue;
    const text = String(t.text || '').replace(/\s+$/g, '').trim();
    if (!text) continue;
    texts.push({
      page: Math.max(0, parseInt(t.page, 10) || 0),
      color: String(t.color || '#c1121f'),
      sizePt: clampPt(t.sizePt, 8, 36, 14),
      x: clamp01(t.x),
      y: clamp01(t.y),
      text: text.slice(0, 500),
    });
  }
  return { strokes, texts };
}

async function embedCommentFont(pdfDoc) {
  const { StandardFonts } = require('pdf-lib');
  try {
    const fontkit = require('@pdf-lib/fontkit');
    pdfDoc.registerFontkit(fontkit);
    const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const candidates = ['arial.ttf', 'calibri.ttf', 'segoeui.ttf'];
    for (const name of candidates) {
      const fontPath = path.join(winDir, 'Fonts', name);
      if (!fs.existsSync(fontPath)) continue;
      const font = await pdfDoc.embedFont(fs.readFileSync(fontPath), { subset: true });
      return { font, unicode: true };
    }
  } catch (_) { /* Helvetica */ }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  return { font, unicode: false };
}

function toPdfXY(page, nx, ny) {
  const w = page.getWidth();
  const h = page.getHeight();
  return { x: nx * w, y: h - ny * h };
}

async function flattenPdfMarkup(opts) {
  const sourcePath = path.normalize(String((opts && opts.sourcePath) || '').trim());
  const destPath = path.normalize(String((opts && opts.destPath) || '').trim());
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('PDF nicht gefunden.');
  }
  if (!destPath) throw new Error('Zielpfad fehlt.');
  const markup = normalizeMarkup(opts && opts.markup);
  const bytes = fs.readFileSync(sourcePath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const fonts = await embedCommentFont(pdfDoc);
  const pages = pdfDoc.getPages();

  for (const stroke of markup.strokes) {
    const page = pages[stroke.page];
    if (!page) continue;
    const color = hexToRgb(stroke.color);
    const pts = stroke.points;
    if (stroke.kind === 'circle') {
      const c = toPdfXY(page, pts[0][0], pts[0][1]);
      const e = toPdfXY(page, pts[1][0], pts[1][1]);
      const radius = Math.hypot(e.x - c.x, e.y - c.y);
      if (radius < 1) continue;
      page.drawEllipse({
        x: c.x,
        y: c.y,
        xScale: radius,
        yScale: radius,
        borderWidth: stroke.widthPt,
        borderColor: color,
        color: undefined,
      });
      continue;
    }
    if (stroke.kind === 'line') {
      const a = toPdfXY(page, pts[0][0], pts[0][1]);
      const b = toPdfXY(page, pts[1][0], pts[1][1]);
      page.drawLine({
        start: a,
        end: b,
        thickness: stroke.widthPt,
        color,
        lineCap: LineCapStyle.Round,
      });
      continue;
    }
    for (let i = 1; i < pts.length; i += 1) {
      const a = toPdfXY(page, pts[i - 1][0], pts[i - 1][1]);
      const b = toPdfXY(page, pts[i][0], pts[i][1]);
      page.drawLine({
        start: a,
        end: b,
        thickness: stroke.widthPt,
        color,
        lineCap: LineCapStyle.Round,
      });
    }
  }

  for (const item of markup.texts) {
    const page = pages[item.page];
    if (!page) continue;
    const pos = toPdfXY(page, item.x, item.y);
    const size = item.sizePt;
    const y = pos.y - size;
    const raw = fonts.unicode ? String(item.text) : sanitizeForWinAnsi(item.text);
    const lines = raw.split(/\r?\n/).filter((line, idx, arr) => line || idx < arr.length - 1);
    const use = lines.length ? lines : [raw];
    for (let i = 0; i < use.length; i += 1) {
      const line = use[i] || ' ';
      page.drawText(line, {
        x: pos.x,
        y: y - i * size * 1.25,
        size,
        font: fonts.font,
        color: hexToRgb(item.color),
      });
    }
  }

  const out = await pdfDoc.save({ useObjectStreams: false });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, out);
  return destPath;
}

module.exports = {
  suggestedAnnotatedPath,
  annotatedPdfFileName,
  resolveMonteurMontagePdfDir,
  normalizeMarkup,
  flattenPdfMarkup,
  ALLOWED_COLORS,
};
