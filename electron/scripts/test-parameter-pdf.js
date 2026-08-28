#!/usr/bin/env node
'use strict';

/**
 * Test-Routine für Parameter-PDF je Geräteformat.
 * Aufruf aus electron/: node scripts/test-parameter-pdf.js [--open]
 *
 * Wichtig: Nach Änderungen an lib/csv-to-pdf.js / pal-to-pdf.js / pa3-to-pdf.js
 * die WebApp (Electron) neu starten.
 */

const path = require('path');
const fs = require('fs');
const { csvToPdfBuffer } = require('../lib/csv-to-pdf');
const { parseParameterFile } = require('../lib/anlagenstamm-parameter-parser');

const PAL_REF = 'C:\\Users\\ariedl\\Downloads\\5584.pal';
const PA3_REF = 'P:\\OneDrive - KUKLA Waagenfabrik GmbH & Co KG\\Montagen\\2026\\03_2026-01-15_Knauf_Weißenbach_AT\\FN 9344.pa3';
const OPEN_FLAG = process.argv.includes('--open');
const OUT_DIR = path.join(__dirname, '..', 'test-output');

function readIfExists(filePath, enc) {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, enc || 'latin1');
  } catch (_) {}
  return '';
}

const SAMPLE_CSV = [
  'Name;Value;Unit;Comment',
  'P1000 Fabricationnumber;12345;;',
  'P1001 Serial number;67890;;',
  'P2010 Capacity;5000;kg;',
  'P3010 Calibration date;01.03.2026;;',
].join('\n');

const SAMPLE_PAL = [
  '100; Nennleistung; 60000; kg/h  ; 0; 10000000;',
  '105; Nennfrequenz; 38; Hz    ; 3; 1000;',
  '110; Fabriknummer; 5584;       ; 2000; 19999;',
  '116; Software Version; B1.41;       ; 0; 0;',
  '120; Minimale Belegung; 20; %; 0; 100;',
  '140; Prüfgewicht; 41.62; %; 10; 150;',
  '200; OFFSET Wiegekanal; 10442;       ; 500; 35000;',
  '400; U1             ; 3 =Band laeuft;       ; 0; 10;',
  '420; K1             ; 0 =Stoerung;       ; 0; 8;',
  '470; DA1 OFFSET; 190;       ; 0; 350;',
  '522; Tacho - Sim    ; 0; Hz    ; 0; 1000;',
  '700; Bus-AdresseDP  ; 126;       ; 1; 126;',
  '999; Pruefsumme     ; 6422528;       ; 0; 0;',
].join('\n');

const SAMPLE_PA3 = [
  '            WAAGENFABRIK KUKLA  Parameterausdruck   ',
  '            ****Fabriknummer :  9344   **********************************',
  '             ________________         ________________',
  '              DWC-5C N1 C3.70          <WAAGENART     >',
  '             ________________         ________________',
  '                     --*--****************--*--',
  '             ________________         ________________',
  '             <NENNDATEN     >          <Anzeigeeinheit>',
  '              Nennleistung               0.010_  t /h',
  '                   550 kg/h',
  '             ________________         ________________',
  '                     --*--****************--*--',
  '             ________________         ________________',
  '             <Wiegekanal    >          <Zaehlerimpuls >',
  '             OFFSET 0%  15431',
  '             ________________         ________________',
  '            -------------------------------------------------------------',
  '            15.Jan.2026               11:11:16                   Seite  1',
  '\f',
  '            WAAGENFABRIK KUKLA  Parameterausdruck   ',
  '            ****Fabriknummer :  9344   **********************************',
  '             <BANDDATEN     >          <ANZEIGE       >',
  '            -------------------------------------------------------------',
  '            15.Jan.2026               11:11:22                   Seite  2',
].join('\n');

const CASES = [
  {
    name: 'DWC-7 CSV',
    outName: 'parameter-test.pdf',
    filename: 'FN11952_PA7_EN_20260309_1329.csv',
    text: SAMPLE_CSV,
    required: ['DWC-7', 'Printout', 'KUKLA', 'Vöcklabruck', 'AUSTRIA', 'Name', 'Value', 'Unit', 'Comment', 'Seite', ' / '],
  },
  {
    name: 'DWC-6 PAL',
    outName: 'parameter-test-pal.pdf',
    filename: '5584.pal',
    sourcePath: 'C:\\Users\\ariedl\\Downloads\\5584.pal',
    text: SAMPLE_PAL,
    required: [
      'KUKLink V2.0',
      'Fabriknummer: 5584',
      'Parametergruppe Nenndaten',
      '100',
      'Nennleistung',
      '60000',
      'kg/h',
      'Digitale Eingänge',
      'Pruefsumme',
      '41,62',
    ],
  },
  {
    name: 'DWC-5/3 PA3',
    outName: 'parameter-test-pa3.pdf',
    filename: 'FN 9344.pa3',
    text: readIfExists(PA3_REF) || SAMPLE_PA3,
    minPages: 2,
    allowParseFallback: true,
    required: ['WAAGENFABRIK KUKLA', 'Fabriknummer', 'NENNDATEN', 'Wiegekanal', 'Seite'],
  },
];

async function extractPdfText(pdfBytes) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(Buffer.from(pdfBytes));
    if (data && data.text && String(data.text).trim()) return data.text;
  } catch (_) {}
  return '';
}

async function assertPdfContent(spec, pdfBytes) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPageCount();
  if (spec.minPages && pages < spec.minPages) {
    console.error('FEHLER (' + spec.name + '): zu wenige Seiten (' + pages + ', erwartet >= ' + spec.minPages + ')');
    return false;
  }
  const pdfText = await extractPdfText(pdfBytes);
  if (pdfText) {
    const missing = spec.required.filter((t) => !pdfText.includes(t));
    if (missing.length > 0) {
      console.error('FEHLER (' + spec.name + '): fehlende Texte:', missing.join(', '));
      console.error('--- PDF-Text (Auszug) ---\n' + pdfText.slice(0, 1200));
      return false;
    }
    console.log('OK (' + spec.name + '): erwartete Texte vorhanden (' + pages + ' Seite(n)).');
    return true;
  }
  if (spec.allowParseFallback) {
    console.log('OK (' + spec.name + '): pdf-lib gültig (' + pages + ' Seite(n)).');
    return true;
  }
  console.error('FEHLER (' + spec.name + '): PDF-Text konnte nicht gelesen werden.');
  return false;
}

function openPdf(filePath) {
  const { platform } = process;
  const { exec } = require('child_process');
  const cmd = platform === 'win32' ? `start "" "${filePath}"` : platform === 'darwin' ? `open "${filePath}"` : `xdg-open "${filePath}"`;
  exec(cmd, (err) => {
    if (err) console.warn('PDF konnte nicht geöffnet werden:', err.message);
  });
}

async function runCase(spec) {
  console.log(spec.name + ': Erzeuge Test-PDF …');
  const pdfBytes = await csvToPdfBuffer(spec.text, {
    filename: spec.filename,
    sourcePath: spec.sourcePath || spec.filename,
  });
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, spec.outName);
  fs.writeFileSync(outPath, pdfBytes);
  console.log('Gespeichert:', outPath);

  const passed = await assertPdfContent(spec, pdfBytes);
  if (OPEN_FLAG) openPdf(outPath);
  return passed;
}

async function maybeRenderReferenceFiles() {
  const extras = [
    {
      src: PAL_REF,
      filename: '5584.pal',
      outName: 'parameter-ref-5584-pal.pdf',
    },
    {
      src: PA3_REF,
      filename: 'FN 9344.pa3',
      outName: 'parameter-ref-9344-pa3.pdf',
    },
  ];
  for (const extra of extras) {
    if (!fs.existsSync(extra.src)) continue;
    const buf = fs.readFileSync(extra.src);
    let text = buf.toString('utf8');
    if (!text || /\uFFFD/.test(text)) text = buf.toString('latin1');
    const pdfBytes = await csvToPdfBuffer(text, { filename: extra.filename, sourcePath: extra.src });
    const outPath = path.join(OUT_DIR, extra.outName);
    fs.writeFileSync(outPath, pdfBytes);
    console.log('Referenzdatei gerendert:', outPath);
    if (OPEN_FLAG) openPdf(outPath);
  }
}

async function main() {
  const palParsed = parseParameterFile(Buffer.from(SAMPLE_PAL, 'utf8'), { fileName: '5584.pal' });
  if (!palParsed || palParsed.used_fab !== '5584') {
    console.error('FEHLER: PAL-Parser erkennt FN 5584 nicht.', palParsed && palParsed.used_fab);
    process.exit(1);
  }
  const pa3Parsed = parseParameterFile(Buffer.from(SAMPLE_PA3, 'utf8'), { fileName: 'FN 9344.pa3' });
  if (!pa3Parsed || pa3Parsed.used_fab !== '9344') {
    console.error('FEHLER: PA3-Parser erkennt FN 9344 nicht.', pa3Parsed && pa3Parsed.used_fab);
    process.exit(1);
  }
  console.log('OK: Parser erkennt Fabriknummern in PAL und PA3.');

  let ok = true;
  for (const spec of CASES) {
    const passed = await runCase(spec);
    if (!passed) ok = false;
  }
  await maybeRenderReferenceFiles();
  if (!OPEN_FLAG) {
    console.log('Tipp: Mit --open die PDFs nach dem Test öffnen: node scripts/test-parameter-pdf.js --open');
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
