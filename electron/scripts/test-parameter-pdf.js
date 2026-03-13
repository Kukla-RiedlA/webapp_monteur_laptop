#!/usr/bin/env node
'use strict';

/**
 * Test-Routine für Parameter-PDF: Erzeugt eine Test-PDF und prüft,
 * ob das Layout 1:1 wie das Referenz-PDF ist (Header-Texte vorhanden).
 * Aufruf aus electron/: node scripts/test-parameter-pdf.js [--open]
 * Mit --open wird die PDF nach dem Erzeugen im Standard-Viewer geöffnet.
 *
 * Wichtig: Nach Änderungen an lib/csv-to-pdf.js die WebApp (Electron) neu starten,
 * damit der Server die neue Version lädt – sonst weicht die PDF in der App vom Test ab.
 */

const path = require('path');
const fs = require('fs');
const { csvToPdfBuffer } = require('../lib/csv-to-pdf');

const OPEN_FLAG = process.argv.includes('--open');
const OUT_DIR = path.join(__dirname, '..', 'test-output');
const OUT_PATH = path.join(OUT_DIR, 'parameter-test.pdf');

// CSV wie aus der Praxis: 4 Spalten Name;Value;Unit;Comment
const SAMPLE_CSV = [
  'Name;Value;Unit;Comment',
  'P1000 Fabricationnumber;12345;;',
  'P1001 Serial number;67890;;',
  'P2010 Capacity;5000;kg;',
  'P3010 Calibration date;01.03.2026;;',
].join('\n');

// Texte, die im generierten PDF vorkommen müssen (1:1 wie Referenz)
const REQUIRED_TEXTS = [
  'DWC-7',
  'Printout',
  'Parameter',
  'KUKLA',
  'Vöcklabruck',
  'AUSTRIA',
  'Name',
  'Value',
  'Unit',
  'Comment',
  'Seite',
  'of',
];

async function main() {
  console.log('Parameter-PDF Test: Erzeuge Test-PDF …');
  // Gleiche Optionen wie in der WebApp: filename für Header (PA7 → DWC-7 etc.)
  const pdfBytes = await csvToPdfBuffer(SAMPLE_CSV, { filename: 'FN11952_PA7_EN_20260309_1329.csv' });
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, pdfBytes);
  console.log('Gespeichert:', OUT_PATH);

  let pdfText = '';
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBytes);
    pdfText = (data && data.text) ? data.text : '';
  } catch (e) {
    console.warn('Hinweis: pdf-parse nicht installiert (npm install --save-dev pdf-parse). Keine Text-Prüfung.');
  }

  if (pdfText) {
    const missing = REQUIRED_TEXTS.filter((t) => !pdfText.includes(t));
    if (missing.length > 0) {
      console.error('FEHLER: Folgende erwartete Texte fehlen in der PDF:', missing.join(', '));
      process.exit(1);
    }
    console.log('OK: Alle erwarteten Header-/Layout-Texte vorhanden.');
  }

  if (OPEN_FLAG) {
    const { platform } = process;
    const { exec } = require('child_process');
    const cmd = platform === 'win32' ? `start "" "${OUT_PATH}"` : platform === 'darwin' ? `open "${OUT_PATH}"` : `xdg-open "${OUT_PATH}"`;
    exec(cmd, (err) => {
      if (err) console.warn('PDF konnte nicht geöffnet werden:', err.message);
    });
    console.log('PDF im Viewer geöffnet. Bitte visuell mit Referenz vergleichen.');
  } else {
    console.log('Tipp: Mit --open die PDF nach dem Test öffnen: node scripts/test-parameter-pdf.js --open');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
