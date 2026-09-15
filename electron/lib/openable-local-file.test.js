'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { looksLikePdfFile, isCsvFilePath, stripOpenStampPrefix, materializeOpenablePath, safeOpenFileName } = require('./openable-local-file');

describe('openable-local-file', () => {
  it('erkennt PDF an der Endung und am Dateikopf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-open-'));
    try {
      const withExt = path.join(dir, 'a.pdf');
      fs.writeFileSync(withExt, '%PDF-1.4\n');
      const hashed = path.join(dir, '879a4f527b799954cf5923a66fddac0c8d3758f5184004b68eb22302a3e97ae9');
      fs.writeFileSync(hashed, '%PDF-1.7\nrest');
      const other = path.join(dir, 'noext');
      fs.writeFileSync(other, 'PK\x03\x04');
      assert.equal(looksLikePdfFile(withExt), true);
      assert.equal(looksLikePdfFile(hashed), true);
      assert.equal(looksLikePdfFile(other), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kopiert Hash-Cache mit Originalnamen und .pdf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-open-mat-'));
    try {
      const hashed = path.join(dir, 'cache', '879a4f527b799954cf5923a66fddac0c8d3758f5184004b68eb22302a3e97ae9');
      fs.mkdirSync(path.dirname(hashed), { recursive: true });
      fs.writeFileSync(hashed, '%PDF-1.4\n');
      const openDir = path.join(dir, 'open');
      const dest = materializeOpenablePath(hashed, openDir, 'Doku/11603_Kna_EN.pdf');
      assert.match(path.basename(dest).replace(/\\/g, '/'), /^\d{14}_11603_Kna_EN\.pdf$/);
      assert.equal(fs.existsSync(dest), true);
      assert.equal(fs.readFileSync(dest).slice(0, 5).toString('latin1'), '%PDF-');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('erkennt CSV nur an der Endung', () => {
    assert.equal(isCsvFilePath('FN12186_PA7.csv'), true);
    assert.equal(isCsvFilePath('C:\\\\cache\\\\liste.CSV'), true);
    assert.equal(isCsvFilePath('liste.xlsx'), false);
    assert.equal(isCsvFilePath('liste.csv.txt'), false);
  });

  it('entfernt nur den Öffnen-Cache-Zeitstempel vom Dateinamen', () => {
    assert.equal(
      stripOpenStampPrefix('20260908092345_FN11603_PA7_EN_20240710_0726.CSV'),
      'FN11603_PA7_EN_20240710_0726.CSV',
    );
    assert.equal(
      stripOpenStampPrefix('C:\\\\cache\\\\20260908092345_FN11603_PA7_DE_20240610_1130 (alt).CSV'),
      'FN11603_PA7_DE_20240610_1130 (alt).CSV',
    );
    assert.equal(
      stripOpenStampPrefix('FN11603_PA7_EN_20240710_0726.CSV'),
      'FN11603_PA7_EN_20240710_0726.CSV',
    );
  });

  it('lässt Dateien mit Endung unverändert', () => {
    const src = path.join('/tmp', 'plan.pdf');
    assert.equal(materializeOpenablePath(src, '/tmp/open', 'plan.pdf'), path.normalize(src));
  });

  it('setzt fehlende Endung aus dem Anzeigenamen', () => {
    assert.equal(safeOpenFileName('plan.pdf', ''), 'plan.pdf');
    assert.equal(safeOpenFileName('hashfile', '.pdf'), 'hashfile.pdf');
  });
});
