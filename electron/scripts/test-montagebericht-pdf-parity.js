#!/usr/bin/env node
'use strict';

/**
 * Test-Routine: Montagebericht-PDF übernimmt Fett/Kursiv/Unterstrich
 * und erzeugt keine Geister-Zeilenumbrüche.
 *
 * Aus electron/:
 *   node scripts/test-montagebericht-pdf-parity.js
 *   npm run test:montagebericht-pdf-parity          (Electron → inkl. PNG)
 *   npm run test:montagebericht-pdf-parity:open
 */

const path = require('path');
const fs = require('fs');
const { htmlToStyledBlocks, styledBlocksToPlain } = require('../lib/html_rich_text');
const { generateMontageberichtPdfBuffer } = require('../lib/protocol_pdf');

const OPEN_FLAG = process.argv.includes('--open');
const OUT_DIR = path.join(__dirname, '..', 'test-output');
const OUT_PDF = path.join(OUT_DIR, 'montagebericht-parity.pdf');
const OUT_RUNS = path.join(OUT_DIR, 'montagebericht-parity-runs.json');

const LONG_SENTENCE =
  'LangerSatz ohne Enter: Dies ist ein absichtlich sehr langer Satz ohne manuelle ' +
  'Zeilenumbrüche damit der Soft-Wrap im PDF sichtbar wird und mit dem Formular ' +
  'auf A4-Satzbreite vergleichbar bleibt.';

const GRUND_HTML =
  '<div>' + LONG_SENTENCE + '</div>' +
  '<div>Vor dem Fett <b>Fettwort</b> und CSS <span style="font-weight: bold">FettCss</span> danach.</div>' +
  '<div><i>Kursivwort</i> und <u>Unterwort</u>.</div>';

const BEMERK_HTML =
  '<div>Zeile</div><div><br></div><div>nächste</div>' +
  '<p>Hello <span>world</span> ohne Extra-Absatz.</p>' +
  '<ul><li>ListenpunktEins</li><li>ListenpunktZwei</li></ul>';

const FAB_HTML = '<p>FN-Text mit <strong>FettFn</strong>.</p>';

function paragraphTexts(html) {
  const block = htmlToStyledBlocks(html).find((b) => b.type === 'text');
  if (!block) return [];
  return block.paragraphs.map((runs) => (runs || []).map((r) => r.text).join(''));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertParser() {
  const grundParas = paragraphTexts(GRUND_HTML);
  assert(grundParas.some((t) => t.indexOf('Fettwort') >= 0), 'Parser: Fettwort fehlt');
  const grundRuns = htmlToStyledBlocks(GRUND_HTML)[0].paragraphs.flat();
  assert(grundRuns.some((r) => r.bold && r.text.indexOf('Fettwort') >= 0), 'Parser: Fettwort nicht bold');
  assert(grundRuns.some((r) => r.bold && r.text.indexOf('FettCss') >= 0), 'Parser: FettCss nicht bold');
  assert(grundRuns.some((r) => r.italic && r.text.indexOf('Kursivwort') >= 0), 'Parser: Kursivwort nicht italic');
  assert(grundRuns.some((r) => r.underline && r.text.indexOf('Unterwort') >= 0), 'Parser: Unterwort nicht underline');
  assert(grundParas.some((t) => t.indexOf(LONG_SENTENCE) >= 0), 'Parser: Langer Satz wurde zerlegt');

  const bemerk = paragraphTexts(BEMERK_HTML);
  const z = bemerk.indexOf('Zeile');
  const n = bemerk.indexOf('nächste');
  assert(z >= 0 && n > z, 'Parser: Zeile/nächste fehlen');
  const between = bemerk.slice(z + 1, n);
  assert(between.filter((t) => !String(t).trim()).length <= 1, 'Parser: Doppel-Leerzeile nach <div><br></div>');
  assert(bemerk.some((t) => t.indexOf('Hello world') >= 0), 'Parser: Span hat Extra-Absatz erzeugt');
  assert(bemerk.filter((t) => t.indexOf('ListenpunktEins') >= 0).length === 1, 'Parser: ListenpunktEins');

  const fabRuns = htmlToStyledBlocks(FAB_HTML)[0].paragraphs.flat();
  assert(fabRuns.some((r) => r.bold && r.text.indexOf('FettFn') >= 0), 'Parser: FettFn nicht bold');
}

function fixturePayload() {
  return {
    kopfdaten: {
      kunde: 'Parity-Kunde',
      projekt: 'Parity-Projekt',
      datum: '26.08.2026',
      geliefertUeber: 'Direkt',
      servicetechniker: 'Test',
      ansprechperson: 'QA',
      bemerkungen: styledBlocksToPlain(htmlToStyledBlocks(BEMERK_HTML)),
      bemerkungen_html: BEMERK_HTML,
    },
    grundDesEinsatzes: styledBlocksToPlain(htmlToStyledBlocks(GRUND_HTML)),
    grundDesEinsatzes_html: GRUND_HTML,
    tableRows: [
      {
        fabrikationsnummer: 'FN-PARITY',
        type: 'Waage',
        position: '1',
        bemerkungen: styledBlocksToPlain(htmlToStyledBlocks(FAB_HTML)),
        bemerkungen_html: FAB_HTML,
      },
    ],
  };
}

function fileUrl(p) {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://' + s;
}

async function assertDistinctStyleFonts(pdfBytes) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    console.warn('pdfjs-dist nicht ladbar, Font-Check übersprungen:', e.message);
    return;
  }
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = false;
  } catch (_) { /* ignore */ }
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
  }).promise;
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  const find = (re) => tc.items.find((it) => it.str && re.test(it.str));
  const fett = find(/Fettwort/);
  const kursiv = find(/Kursivwort/);
  const body = find(/Vor dem Fett/);
  assert(fett && fett.fontName, 'PDF: Fettwort ohne Font');
  assert(kursiv && kursiv.fontName, 'PDF: Kursivwort ohne Font');
  assert(body && body.fontName, 'PDF: Fließtext ohne Font');
  assert(fett.fontName !== body.fontName, 'PDF: Fettwort nutzt nicht die Bold-Schrift');
  assert(kursiv.fontName !== body.fontName, 'PDF: Kursivwort nutzt nicht die Italic-Schrift');
  assert(fett.fontName !== kursiv.fontName, 'PDF: Fett und Kursiv sind dieselbe Schrift');
}

async function rasterPdfToPngs(pdfBytes) {
  if (!process.versions.electron) {
    console.warn('PNG-Raster übersprungen (nicht unter Electron). npm run test:montagebericht-pdf-parity');
    return [];
  }
  const { app, BrowserWindow } = require('electron');
  if (!app.isReady()) await app.whenReady();

  const pdfJsPath = fileUrl(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.mjs'));
  const workerPath = fileUrl(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'));
  const b64 = Buffer.from(pdfBytes).toString('base64');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  window.__done = false;
  window.__error = null;
  window.__pngs = [];
  try {
    const pdfjs = await import(${JSON.stringify(pdfJsPath)});
    pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerPath)};
    const raw = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      window.__pngs.push(canvas.toDataURL('image/png'));
    }
  } catch (e) {
    window.__error = (e && e.stack) ? e.stack : String(e);
  }
  window.__done = true;
</script>
</body></html>`;

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
  console.log('Montagebericht-PDF-Parität: Parser …');
  assertParser();
  console.log('OK: Parser-Fixtures');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_RUNS,
    JSON.stringify(
      {
        grund: htmlToStyledBlocks(GRUND_HTML),
        bemerk: htmlToStyledBlocks(BEMERK_HTML),
        fab: htmlToStyledBlocks(FAB_HTML),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('Erzeuge PDF …');
  const pdfBytes = await generateMontageberichtPdfBuffer(fixturePayload(), { lang: 'de' });
  fs.writeFileSync(OUT_PDF, pdfBytes);
  console.log('Gespeichert:', OUT_PDF);

  let pdfText = '';
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBytes);
    pdfText = (data && data.text) ? data.text : '';
  } catch (e) {
    console.warn('Hinweis: pdf-parse nicht verfügbar:', e.message);
  }

  if (pdfText) {
    const required = [
      'Fettwort',
      'FettCss',
      'Kursivwort',
      'Unterwort',
      'ListenpunktEins',
      'ListenpunktZwei',
      'FettFn',
      'Zeile',
      'nächste',
      'LangerSatz',
      'Montagebericht',
    ];
    const missing = required.filter((t) => pdfText.indexOf(t) < 0);
    if (missing.length) {
      throw new Error('PDF-Text fehlt: ' + missing.join(', '));
    }
    const ghost = /Zeile\s*\n\s*\n\s*\n+\s*nächste/;
    if (ghost.test(pdfText)) {
      throw new Error('PDF hat Doppel-Leerzeile zwischen Zeile und nächste');
    }
    console.log('OK: pdf-parse Pflichttexte');
  }

  await assertDistinctStyleFonts(pdfBytes);
  console.log('OK: Fett/Kursiv nutzen andere Schriften als Regular');

  const pngs = await rasterPdfToPngs(pdfBytes);
  pngs.forEach((dataUrl, i) => {
    const m = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!m) throw new Error('Ungültiges PNG Seite ' + (i + 1));
    const out = path.join(OUT_DIR, 'montagebericht-parity-page' + (i + 1) + '.png');
    fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
    console.log('PNG:', out);
  });

  if (OPEN_FLAG) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${OUT_PDF}"`
      : process.platform === 'darwin'
        ? `open "${OUT_PDF}"`
        : `xdg-open "${OUT_PDF}"`;
    exec(cmd, (err) => {
      if (err) console.warn('PDF konnte nicht geöffnet werden:', err.message);
    });
  }

  console.log('Montagebericht-PDF-Parität: OK');
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
