'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectDumpFamily,
  extractFabFromDump,
  suggestedFilename,
  FAMILY_LEGACY,
  FAMILY_DWC6,
} = require('./format-detect');

const SAMPLE_PA3 = [
  '            WAAGENFABRIK KUKLA  Parameterausdruck   ',
  '            ****Fabriknummer :  9344   **********************************',
  '              DWC-5C N1 C3.70          <WAAGENART     >',
  '             <NENNDATEN     >          <Anzeigeeinheit>',
].join('\n');

const SAMPLE_PAL = [
  '100; Nennleistung; 60000; kg/h  ; 0; 10000000;',
  '110; Fabriknummer; 5584;       ; 2000; 19999;',
  '200; OFFSET Wiegekanal; 10442;       ; 500; 35000;',
].join('\n');

describe('kuklink format-detect', () => {
  it('erkennt PA-Drucklayout als DWC-3/4/5', () => {
    const d = detectDumpFamily(SAMPLE_PA3, 'x.txt');
    assert.equal(d.family, FAMILY_LEGACY);
    assert.equal(extractFabFromDump(SAMPLE_PA3), '9344');
    assert.equal(suggestedFilename(d.family, '9344'), 'FN9344_kuklink.pa3');
  });

  it('erkennt PAL als DWC-6', () => {
    const d = detectDumpFamily(SAMPLE_PAL, 'x.pal');
    assert.equal(d.family, FAMILY_DWC6);
    assert.equal(extractFabFromDump(SAMPLE_PAL), '5584');
    assert.equal(suggestedFilename(d.family, '5584'), 'FN5584_kuklink.pal');
  });
});
