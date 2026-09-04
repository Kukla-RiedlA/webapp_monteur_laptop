'use strict';

const assert = require('assert');
const { rowInPdf, rowInSumme } = require('../lib/protocol_pdf');
const { enrichMessungen } = require('../lib/schleppketten-local');

assert.strictEqual(rowInSumme({ in_summe: true }), true);
assert.strictEqual(rowInSumme({ in_summe: false }), false);
assert.strictEqual(rowInPdf({ in_summe: true, in_pdf: false }), true, 'Summe erzwingt PDF');
assert.strictEqual(rowInPdf({ in_summe: false, in_pdf: true }), true, 'ohne Summe, Druck an');
assert.strictEqual(rowInPdf({ in_summe: false, in_pdf: false }), false, 'ohne Summe, Druck aus');
assert.strictEqual(rowInPdf({ in_summe: false }), false, 'Legacy ohne in_pdf: nicht in Summe = nicht im PDF');
assert.strictEqual(rowInPdf({ in_summe: true }), true, 'Legacy ohne in_pdf: in Summe = im PDF');

const enriched = enrichMessungen([
  { in_summe: true },
  { in_summe: false },
  { in_summe: false, in_pdf: true },
]);
assert.strictEqual(enriched[0].in_pdf, true);
assert.strictEqual(enriched[1].in_pdf, false);
assert.strictEqual(enriched[2].in_pdf, true);
assert.strictEqual(rowInPdf(enriched[2]), true);

console.log('ok: rowInPdf / enrichMessungen');
