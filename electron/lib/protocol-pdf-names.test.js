'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  montageberichtExportStem,
  fnProtocolPdfFilename,
  labeledProtocolPdfFilename,
  isLegacyMontageberichtExportName,
  isCurrentMontageberichtExportName,
} = require('./protocol-pdf-names');

describe('protocol-pdf-names', () => {
  it('Montagebericht Typ-Datum-Sprache', () => {
    const base = '2026-09-06_Test_Sunstwo_AT';
    assert.equal(montageberichtExportStem(base, 'de') + '.pdf', 'Montage_Bericht_2026-09-06_Test_Sunstwo_AT_DE.pdf');
    assert.equal(montageberichtExportStem(base, 'en') + '.pdf', 'Assembly_report_2026-09-06_Test_Sunstwo_AT_GB.pdf');
  });

  it('übrige Protokolle: englischer Typ + GB', () => {
    assert.equal(
      fnProtocolPdfFilename('serviceprotokoll', '20500', '2026-09-05', 'en'),
      'Service_protocol_20500_20260905_GB.pdf',
    );
    assert.equal(
      fnProtocolPdfFilename('inbetriebnahme', '20500', '20260905', 'en'),
      'Commissioning_report_20500_20260905_GB.pdf',
    );
    assert.equal(
      fnProtocolPdfFilename('kontrollwiegung', '20500', '20260905', 'de'),
      'Kontrollwiegungsprotokoll_20500_20260905_DE.pdf',
    );
    assert.equal(
      fnProtocolPdfFilename('schleppketten', '20501', '20260905', 'en'),
      'Chain_calibration_20501_20260905_GB.pdf',
    );
    assert.equal(
      fnProtocolPdfFilename('pruefzertifikat', '20500', '20260905', 'en'),
      'Inspection_certificate_20500_20260905_GB.pdf',
    );
    assert.equal(labeledProtocolPdfFilename('arbeitsnachweis', 'AN-12', 'en'), 'Working_report_AN-12_GB.pdf');
  });

  it('OneDrive -1-Kopien gelten als derselbe Montagebericht-Typ', () => {
    assert.equal(
      isCurrentMontageberichtExportName('Assembly_report_2026-09-06_Test_Sunstwo_AT_GB-1.pdf'),
      true,
    );
    assert.equal(
      isLegacyMontageberichtExportName('2026-09-06_Test_Sunstwo_AT_Montage_DE-2.pdf'),
      true,
    );
  });
});
