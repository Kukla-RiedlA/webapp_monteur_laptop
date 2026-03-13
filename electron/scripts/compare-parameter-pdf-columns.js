#!/usr/bin/env node
'use strict';

/**
 * Vergleicht Spaltenpositionen unserer Parameter-PDF mit der Referenz-PDF.
 * Nutzung: node scripts/compare-parameter-pdf-columns.js "P:\Pfad\zur\Referenz.pdf"
 * Liest Spalten-X-Positionen aus beiden PDFs (pdfjs getTextContent) und passt
 * die Anteile in lib/csv-to-pdf.js an, bis sie übereinstimmen.
 */

const path = require('path');
const fs = require('fs');

const REF_PATH = process.argv[2] || process.env.REFERENCE_PDF;
const ELECTRON_DIR = path.join(__dirname, '..');
const CSV_TO_PDF_PATH = path.join(ELECTRON_DIR, 'lib', 'csv-to-pdf.js');
const OUT_PDF_PATH = path.join(ELECTRON_DIR, 'test-output', 'parameter-test.pdf');
const TOLERANCE_PT = 5;
const MAX_ITERATIONS = 15;

if (!REF_PATH || !fs.existsSync(REF_PATH)) {
  console.error('Referenz-PDF fehlt. Aufruf: node scripts/compare-parameter-pdf-columns.js "P:\\Pfad\\zur\\Referenz.pdf"');
  process.exit(1);
}

async function getTextItemsWithPositions(pdfPath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = (content.items || []).map((item) => {
    const tr = item.transform;
    const x = tr && tr[4] != null ? tr[4] : 0;
    const y = tr && tr[5] != null ? tr[5] : 0;
    const w = (item.width != null) ? item.width : 0;
    return { str: item.str || '', x, y, w, height: item.height || 0 };
  });
  return { items };
}

function findTableRowBounds(items) {
  const names = ['Name', 'Value', 'Unit', 'Comment'];
  const byY = {};
  for (const it of items) {
    const y = Math.round(it.y);
    if (!byY[y]) byY[y] = [];
    byY[y].push(it);
  }
  const yKeys = Object.keys(byY).map(Number).sort((a, b) => b - a);
  for (const y of yKeys) {
    const row = byY[y];
    const texts = row.map((r) => r.str.trim()).filter(Boolean);
    const hasHeader = names.every((n) => texts.some((t) => t === n || t.includes(n)));
    if (hasHeader || (row.length >= 4 && texts.some((t) => t.startsWith('P') || /^\d+/.test(t)))) {
      const sorted = row.slice().sort((a, b) => a.x - b.x);
      const n = sorted.length;
      const gap = 8;
      const minColWidth = 15;
      if (n >= 4) {
        const lefts = [sorted[0].x];
        let lastX = sorted[0].x;
        for (let i = 1; i < n && lefts.length < 4; i++) {
          if (sorted[i].x >= lastX + minColWidth) {
            lefts.push(sorted[i].x);
            lastX = sorted[i].x;
          }
        }
        while (lefts.length < 4) lefts.push(lefts[lefts.length - 1] + 50);
        const lastRight = sorted[n - 1].x + (sorted[n - 1].w || 0);
        const rights = [
          Math.max(lefts[0], lefts[1] - gap),
          Math.max(lefts[1], lefts[2] - gap),
          Math.max(lefts[2], lefts[3] - gap),
          lastRight,
        ];
        return { lefts: lefts.slice(0, 4), rights, sorted };
      }
      const lefts = sorted.map((s) => s.x);
      const rights = sorted.map((s) => s.x + (s.w || 0));
      return { lefts, rights, sorted };
    }
  }
  return null;
}

function getColumnWidthsFromBounds(lefts, rights) {
  if (!lefts || lefts.length < 4) return null;
  const widths = lefts.map((l, i) => Math.max(0, (rights[i] != null ? rights[i] - l : 0)));
  const gaps = [];
  for (let i = 0; i < lefts.length - 1; i++) {
    gaps.push(Math.max(0, (lefts[i + 1] || 0) - (rights[i] || 0)));
  }
  const totalColWidth = widths.reduce((a, b) => a + b, 0);
  const proportions = totalColWidth > 0 ? widths.map((w) => w / totalColWidth) : [0.25, 0.25, 0.25, 0.25];
  return { widths, gaps, proportions };
}

async function generateOurPdf() {
  const { csvToPdfBuffer } = require(path.join(ELECTRON_DIR, 'lib', 'csv-to-pdf.js'));
  const csv = 'Name;Value;Unit;Comment\nP1000 Test;1;kg;';
  const buf = await csvToPdfBuffer(csv, { filename: 'FN11952_PA7_EN_20260309_1329.csv' });
  const outDir = path.dirname(OUT_PDF_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PDF_PATH, buf);
  return OUT_PDF_PATH;
}

function readCurrentColConfig() {
  const src = fs.readFileSync(CSV_TO_PDF_PATH, 'utf8');
  const m = src.match(/contentWidth \* (0\.\d+),\s*contentWidth \* (0\.\d+),\s*contentWidth \* (0\.\d+),\s*contentWidth \* (0\.\d+)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

function writeColConfig(proportions, colGap = 8) {
  let src = fs.readFileSync(CSV_TO_PDF_PATH, 'utf8');
  const [a, b, c, d] = proportions.map((p) => p.toFixed(2));
  src = src.replace(
    /const COL_GAP = \d+;/,
    `const COL_GAP = ${colGap};`
  );
  src = src.replace(
    /contentWidth \* 0\.\d+,\s*contentWidth \* 0\.\d+,\s*contentWidth \* 0\.\d+,\s*contentWidth \* 0\.\d+/,
    `contentWidth * ${a}, contentWidth * ${b}, contentWidth * ${c}, contentWidth * ${d}`
  );
  fs.writeFileSync(CSV_TO_PDF_PATH, src);
}

async function main() {
  console.log('Referenz-PDF:', REF_PATH);
  const ref = await getTextItemsWithPositions(REF_PATH);
  const refBounds = findTableRowBounds(ref.items);
  if (!refBounds) {
    console.error('Konnte Tabellenzeile in Referenz-PDF nicht finden (Name/Value/Unit/Comment oder Datenzeile).');
    process.exit(1);
  }
  const refCols = getColumnWidthsFromBounds(refBounds.lefts, refBounds.rights);
  if (!refCols) {
    console.error('Konnte Spaltenbreiten aus Referenz nicht ableiten.');
    process.exit(1);
  }
  console.log('Referenz Anteile (aus Positionen):', refCols.proportions.map((p) => (p * 100).toFixed(1) + '%').join(', '));
  console.log('Referenz Abstände (pt):', refCols.gaps.map((g) => g.toFixed(0)).join(', '));

  let iter = 0;
  let lastProportions = null;
  while (iter < MAX_ITERATIONS) {
    iter++;
    await generateOurPdf();
    if (!fs.existsSync(OUT_PDF_PATH)) {
      console.error('Generierte PDF nicht gefunden.');
      break;
    }
    const our = await getTextItemsWithPositions(OUT_PDF_PATH);
    const ourBounds = findTableRowBounds(our.items);
    if (!ourBounds) {
      console.log('Iteration', iter, ': Tabellenzeile in unserer PDF nicht gefunden.');
      break;
    }
    const ourCols = getColumnWidthsFromBounds(ourBounds.lefts, ourBounds.rights);
    if (!ourCols) break;

    const diff = refCols.proportions.map((r, i) => Math.abs((ourCols.proportions[i] || 0) - r));
    const maxDiff = Math.max(...diff);
    console.log('Iteration', iter, ' Anteile:', ourCols.proportions.map((p) => (p * 100).toFixed(1) + '%').join(', '), ' maxDiff:', (maxDiff * 100).toFixed(1) + '%');

    if (maxDiff * 100 < TOLERANCE_PT) {
      console.log('Spalten weichen um unter', TOLERANCE_PT, '% ab – Ziel erreicht.');
      break;
    }

    const newProp = refCols.proportions.map((p, i) => {
      const mix = 0.6;
      return (ourCols.proportions[i] || 0.25) * (1 - mix) + p * mix;
    });
    const sum = newProp.reduce((a, b) => a + b, 0);
    const normalized = newProp.map((p) => p / sum);
    if (lastProportions && normalized.every((n, i) => Math.abs(n - lastProportions[i]) < 0.001)) {
      const refNorm = refCols.proportions.map((p) => Math.max(0.05, p));
      const sumRef = refNorm.reduce((a, b) => a + b, 0);
      const refFinal = refNorm.map((p) => p / sumRef);
      if (refFinal.every((p) => p > 0 && p < 1)) {
        writeColConfig(refFinal);
        console.log('Anpassung konvergiert – Referenz-Anteile übernommen:', refFinal.map((p) => (p * 100).toFixed(1) + '%').join(', '));
      } else {
        console.log('Referenz-Anteile ungültig – csv-to-pdf.js unverändert.');
      }
      break;
    }
    lastProportions = normalized;
    const toWrite = normalized.map((p) => Math.max(0.05, Math.min(0.6, p)));
    const sumW = toWrite.reduce((a, b) => a + b, 0);
    const final = toWrite.map((p) => p / sumW);
    if (final.every((p) => p > 0 && p < 1)) writeColConfig(final);
  }

  console.log('Fertig. Bitte test-output/parameter-test.pdf mit der Referenz visuell vergleichen.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
