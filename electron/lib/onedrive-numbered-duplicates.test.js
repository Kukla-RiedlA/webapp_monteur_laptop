'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseOnedriveNumberedCopy,
  stripOnedriveCopySuffix,
  sweepOnedriveNumberedDuplicates,
} = require('./onedrive-numbered-duplicates');

describe('onedrive-numbered-duplicates', () => {
  it('erkennt -1 vor der Endung, nicht das Datum in der Mitte', () => {
    const p = parseOnedriveNumberedCopy('Assembly_report_2026-09-06_Test_Sunstwo_AT_GB-1.pdf');
    assert.equal(p.canonical, 'Assembly_report_2026-09-06_Test_Sunstwo_AT_GB.pdf');
    assert.equal(p.n, 1);
    assert.equal(
      stripOnedriveCopySuffix('2026-09-06_Test_Sunstwo_AT_Montage_DE-2.pdf'),
      '2026-09-06_Test_Sunstwo_AT_Montage_DE.pdf',
    );
    assert.equal(parseOnedriveNumberedCopy('Serviceprotokoll_20500_20260905_DE.pdf'), null);
  });

  it('löscht -1 wenn die kanonische Datei existiert', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-od-dup-'));
    try {
      fs.writeFileSync(path.join(dir, 'Assembly_report_x_GB.pdf'), 'keep');
      fs.writeFileSync(path.join(dir, 'Assembly_report_x_GB-1.pdf'), 'dup');
      fs.writeFileSync(path.join(dir, 'Assembly_report_x_GB-2.pdf'), 'dup2');
      sweepOnedriveNumberedDuplicates(dir);
      assert.equal(fs.existsSync(path.join(dir, 'Assembly_report_x_GB.pdf')), true);
      assert.equal(fs.existsSync(path.join(dir, 'Assembly_report_x_GB-1.pdf')), false);
      assert.equal(fs.existsSync(path.join(dir, 'Assembly_report_x_GB-2.pdf')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('löscht alten Namen ohne _DE wenn die DE-Datei existiert', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-od-lang-'));
    try {
      fs.writeFileSync(path.join(dir, 'Serviceprotokoll_20500_20260905_DE.pdf'), 'neu');
      fs.writeFileSync(path.join(dir, 'Serviceprotokoll_20500_20260905-1.pdf'), 'alt');
      sweepOnedriveNumberedDuplicates(dir);
      assert.equal(fs.existsSync(path.join(dir, 'Serviceprotokoll_20500_20260905_DE.pdf')), true);
      assert.equal(fs.existsSync(path.join(dir, 'Serviceprotokoll_20500_20260905-1.pdf')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('benennt alleiniges -1 auf den Originalnamen zurück', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-od-ren-'));
    try {
      fs.writeFileSync(path.join(dir, 'Kontrollwiegungsprotokoll_20500_20260905_DE-1.pdf'), 'only');
      sweepOnedriveNumberedDuplicates(dir);
      assert.equal(
        fs.existsSync(path.join(dir, 'Kontrollwiegungsprotokoll_20500_20260905_DE.pdf')),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(dir, 'Kontrollwiegungsprotokoll_20500_20260905_DE-1.pdf')),
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
