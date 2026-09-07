'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rowInSumme, rowInPdf, rowsForPdfSum } = require('./protocol_pdf');

describe('protocol PDF row flags', () => {
  it('Summe nur aus Σ-Zeilen, auch wenn andere nur gedruckt werden', () => {
    const rows = [
      { bandwaage_kg: 100, in_summe: true, in_pdf: true },
      { bandwaage_kg: 50, in_summe: false, in_pdf: true },
      { bandwaage_kg: 25, in_summe: false, in_pdf: false },
    ];
    const printed = rows.filter(rowInPdf);
    assert.equal(printed.length, 2);
    const summed = rowsForPdfSum(printed);
    assert.equal(summed.length, 1);
    assert.equal(summed[0].bandwaage_kg, 100);
    assert.equal(rowInSumme(rows[1]), false);
  });

  it('ohne in_pdf und ohne Summe nicht drucken (Legacy)', () => {
    assert.equal(rowInPdf({ in_summe: false }), false);
    assert.equal(rowInPdf({ in_summe: true }), true);
  });
});
