#!/usr/bin/env node
'use strict';

/**
 * Test-Routine: Montagebericht-PDF hält FN-Leiste und Textblock zusammen.
 * Die grüne FN-Leiste darf nicht allein am Seitenende stehen.
 *
 * Schablone für JEDES neue Laptop-PDF: Fixture mit langem Fülltext, sodass
 * der kritische Block ohne Keep-together am Seitenende stünde. Gate laut
 * .cursor/rules/formular-pdf-design.mdc und docs/design/FORMULAR_PDF_CHECKLISTE.md.
 *
 * Aus electron/:
 *   node scripts/test-montagebericht-pdf-pagebreak.js
 *   npm run test:montagebericht-pdf-pagebreak          (Electron → inkl. PNG)
 *   npm run test:montagebericht-pdf-pagebreak:open
 */

const path = require('path');
const fs = require('fs');
const { generateMontageberichtPdfBuffer } = require('../lib/protocol_pdf');

const OPEN_FLAG = process.argv.includes('--open');
const OUT_DIR = path.join(__dirname, '..', 'test-output');
const OUT_PDF = path.join(OUT_DIR, 'montagebericht-pagebreak.pdf');

const FN_NUMBER = '12494';
const FN_MARKER = 'FN-PAGEBREAK-MARKER-TEXT';
const FN_BODY_LINES = [
  FN_MARKER + ' Beistellung 2 Schlosser durch Fa. Agrana',
  'Einbau der Waagenmechanik',
  'Montage des Wiegerollenstuhls - dieser musste in der Werkstatt geschweisst werden',
  'Ein und Ausrichten der Begrenzungsrollen',
  'Anheben aller im Wiegebereich montierten Rollenstuehle um 10mm',
  'Fluchten des Waagenbereichs mittels Unterlegsbleche',
  'Elektrik wurde nachmittags angefangen (externe Montagefirma)',
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fillerGrundHtml(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(
      '<p>Grundzeile ' +
        String(i).padStart(2, '0') +
        ' fuellt Seite 1, damit die FN-Leiste ohne Keep-together allein am Seitenende stünde.</p>',
    );
  }
  return lines.join('');
}

function fnHtml() {
  return (
    '<ul>' +
    FN_BODY_LINES.map((t) => '<li>' + t + '</li>').join('') +
    '</ul>'
  );
}

function fixturePayload() {
  const grundHtml = fillerGrundHtml(42);
  return {
    kopfdaten: {
      kunde: 'Pagebreak-Kunde',
      projekt: 'Pagebreak-Projekt',
      datum: '26.08.2026',
      geliefertUeber: 'Direkt',
      servicetechniker: 'Test',
      ansprechperson: 'QA',
      bemerkungen: 'Bemerkung nach FN-Block.',
      bemerkungen_html: '<p>Bemerkung nach FN-Block.</p>',
    },
    grundDesEinsatzes: 'Grund fuellt Seite 1.',
    grundDesEinsatzes_html: grundHtml,
    tableRows: [
      {
        fabrikationsnummer: FN_NUMBER,
        type: 'EBW-E-C2-500',
        position: 'N40',
        bemerkungen: FN_BODY_LINES.join('\n'),
        bemerkungen_html: fnHtml(),
      },
    ],
  };
}

function fileUrl(p) {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://' + s;
}

function itemY(it) {
  const t = it && it.transform;
  return Array.isArray(t) && t.length >= 6 ? Number(t[5]) : NaN;
}

function isFooterish(str, y) {
  if (Number.isFinite(y) && y > 120) return false;
  const s = String(str || '');
  if (/^Seite\s+\d+/i.test(s)) return true;
  if (/^Datum\s*:/i.test(s) || /^Date\s*:/i.test(s)) return true;
  return false;
}

async function loadPdfPages(pdfBytes) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error('pdfjs-dist nicht ladbar: ' + e.message);
  }
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = false;
  } catch (_) {
    /* ignore */
  }
  const pdf = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true,
    })
    .promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push({
      pageIndex: i,
      items: (tc.items || []).map((it) => ({
        str: String(it.str || ''),
        y: itemY(it),
      })),
    });
  }
  return pages;
}

function assertFnHeaderKeepsText(pages) {
  assert(pages.length >= 2, 'PDF sollte mindestens 2 Seiten haben (Grund füllt Seite 1)');

  const fnPages = [];
  pages.forEach((p) => {
    const header = p.items.find(
      (it) => /\bFN\.?\s*12494\b/.test(it.str) || (it.str.indexOf('12494') >= 0 && /FN/i.test(it.str)),
    );
    if (header) fnPages.push({ page: p, header });
  });
  assert(fnPages.length >= 1, 'PDF: FN. 12494 nicht gefunden');
  assert(
    fnPages.length === 1,
    'PDF: FN-Leiste darf nicht auf Folgeseiten wiederholt werden, gefunden auf ' +
      fnPages.map((f) => f.page.pageIndex).join(', '),
  );

  const { page, header } = fnPages[0];
  assert(Number.isFinite(header.y), 'PDF: FN-Leiste ohne Y-Position');

  const below = page.items.filter((it) => {
    if (!it.str.trim()) return false;
    if (!Number.isFinite(it.y)) return false;
    if (it.y >= header.y - 2) return false;
    if (isFooterish(it.str, it.y)) return false;
    return true;
  });
  const marker = below.find((it) => it.str.indexOf(FN_MARKER) >= 0);
  const bodyHit = marker || below.find((it) => FN_BODY_LINES.some((line) => it.str.indexOf(line.slice(0, 24)) >= 0));
  assert(
    !!bodyHit,
    'PDF Seite ' +
      page.pageIndex +
      ': FN-Leiste ohne Textblock darunter (Waise am Seitenende). Items unterhalb: ' +
      below.map((it) => JSON.stringify(it.str)).join(' | '),
  );

  const footerItems = page.items.filter((it) => isFooterish(it.str, it.y) && Number.isFinite(it.y));
  if (footerItems.length) {
    const footerTop = Math.max.apply(
      null,
      footerItems.map((it) => it.y),
    );
    assert(
      bodyHit.y > footerTop + 4,
      'PDF Seite ' +
        page.pageIndex +
        ': FN-Text liegt in der Fußzeile statt im Textblock (y=' +
        bodyHit.y +
        ', footerTop=' +
        footerTop +
        ')',
    );
  }
}

async function rasterPdfToPngs(pdfBytes) {
  if (!process.versions.electron) {
    console.warn('PNG-Raster übersprungen (nicht unter Electron). npm run test:montagebericht-pdf-pagebreak');
    return [];
  }
  const { app, BrowserWindow } = require('electron');
  if (!app.isReady()) await app.whenReady();

  const pdfJsPath = fileUrl(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.mjs'));
  const workerPath = fileUrl(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'));
  const b64 = Buffer.from(pdfBytes).toString('base64');
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n<script type="module">\n' +
    '  window.__done = false;\n' +
    '  window.__error = null;\n' +
    '  window.__pngs = [];\n' +
    '  try {\n' +
    '    const pdfjs = await import(' +
    JSON.stringify(pdfJsPath) +
    ');\n' +
    '    pdfjs.GlobalWorkerOptions.workerSrc = ' +
    JSON.stringify(workerPath) +
    ';\n' +
    '    const raw = atob(' +
    JSON.stringify(b64) +
    ');\n' +
    '    const bytes = new Uint8Array(raw.length);\n' +
    '    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);\n' +
    '    const pdf = await pdfjs.getDocument({ data: bytes }).promise;\n' +
    '    for (let i = 1; i <= pdf.numPages; i++) {\n' +
    '      const page = await pdf.getPage(i);\n' +
    '      const viewport = page.getViewport({ scale: 1.6 });\n' +
    '      const canvas = document.createElement("canvas");\n' +
    '      canvas.width = Math.ceil(viewport.width);\n' +
    '      canvas.height = Math.ceil(viewport.height);\n' +
    '      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;\n' +
    '      window.__pngs.push(canvas.toDataURL("image/png"));\n' +
    '    }\n' +
    '  } catch (e) {\n' +
    '    window.__error = (e && e.stack) ? e.stack : String(e);\n' +
    '  }\n' +
    '  window.__done = true;\n' +
    '</script>\n</body></html>';

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1280,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const done = await win.webContents.executeJavaScript('window.__done === true');
    if (done) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const err = await win.webContents.executeJavaScript('window.__error');
  const pngs = await win.webContents.executeJavaScript('window.__pngs');
  win.destroy();
  if (err) throw new Error('PDF-Raster fehlgeschlagen: ' + err);
  if (!Array.isArray(pngs) || !pngs.length) throw new Error('PDF-Raster: keine Seiten');
  return pngs;
}

async function run() {
  console.log('Montagebericht-PDF-Seitenumbruch: erzeuge Fixture …');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const pdfBytes = await generateMontageberichtPdfBuffer(fixturePayload(), { lang: 'de' });
  fs.writeFileSync(OUT_PDF, pdfBytes);
  console.log('Gespeichert:', OUT_PDF);

  const pages = await loadPdfPages(pdfBytes);
  console.log('Seiten:', pages.length);
  assertFnHeaderKeepsText(pages);
  console.log('OK: FN-Leiste steht mit Textblock auf derselben Seite');

  const pngs = await rasterPdfToPngs(pdfBytes);
  pngs.forEach((dataUrl, i) => {
    const m = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!m) throw new Error('Ungültiges PNG Seite ' + (i + 1));
    const out = path.join(OUT_DIR, 'montagebericht-pagebreak-page' + (i + 1) + '.png');
    fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
    console.log('PNG:', out);
  });

  if (OPEN_FLAG) {
    const { exec } = require('child_process');
    const cmd =
      process.platform === 'win32'
        ? 'start "" "' + OUT_PDF + '"'
        : process.platform === 'darwin'
          ? 'open "' + OUT_PDF + '"'
          : 'xdg-open "' + OUT_PDF + '"';
    exec(cmd, (err) => {
      if (err) console.warn('PDF konnte nicht geöffnet werden:', err.message);
    });
  }

  console.log('Montagebericht-PDF-Seitenumbruch: OK');
}

function main() {
  const inElectron = !!process.versions.electron;
  if (inElectron) {
    const { app } = require('electron');
    app.whenReady().then(() =>
      run()
        .then(() => app.exit(0))
        .catch((e) => {
          console.error(e);
          app.exit(1);
        }),
    );
    return;
  }
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
