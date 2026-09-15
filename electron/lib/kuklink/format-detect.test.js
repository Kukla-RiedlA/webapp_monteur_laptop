'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectDumpFamily,
  extractFabFromDump,
  suggestedFilename,
  decodeDumpBuffer,
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
  it('nimmt den ersten lesbaren Dump als Treffer', () => {
    const { classifyBuffer } = require('./connect-probe');
    const partial = Buffer.from(
      '            ****Fabriknummer :  9344   **********************************\n',
      'latin1',
    );
    const hit = classifyBuffer(partial);
    assert.ok(hit);
    assert.equal(hit.family, FAMILY_LEGACY);
  });

  it('erkennt PA-Drucklayout als DWC-3/4/5', () => {
    const d = detectDumpFamily(SAMPLE_PA3, 'x.txt');
    assert.equal(d.family, FAMILY_LEGACY);
    assert.equal(extractFabFromDump(SAMPLE_PA3), '9344');
    assert.equal(suggestedFilename(d.family, '9344', SAMPLE_PA3), 'FN_9344.pa3');
  });

  it('erkennt Fabriknummer in IdPa-110-Zeile', () => {
    const sample = [
      'IdPa 100    100000     0     10000000 Nennleistung',
      'IdPa 110    2007     2000     19999 FabrikNummer',
      'IdPa 114      0     0     4 SPRACHE/LANGU',
    ].join('\n');
    const d = detectDumpFamily(sample);
    assert.equal(d.family, FAMILY_LEGACY);
    assert.equal(extractFabFromDump(sample), '2007');
    assert.equal(suggestedFilename(d.family, '2007', sample), 'FN_2007.pal');
  });

  it('erkennt PAL als DWC-6', () => {
    const d = detectDumpFamily(SAMPLE_PAL, 'x.pal');
    assert.equal(d.family, FAMILY_DWC6);
    assert.equal(extractFabFromDump(SAMPLE_PAL), '5584');
    assert.equal(suggestedFilename(d.family, '5584'), 'FN_5584.pal');
  });

  it('erkennt FN sprachunabhängig im Parameter-Printout', () => {
    const { decodeDumpBuffer } = require('./format-detect');
    const englishCr =
      '\r            WAAGENFABRIK KUKLA  Parameter printout \r' +
      '            ****Fabric.number:  2007   **********************************\r\n' +
      '             DWC-3D N1 A3.41          <TYPE SCALE     >\r';
    const decoded = decodeDumpBuffer(Buffer.from(englishCr, 'latin1'));
    const d = detectDumpFamily(decoded.text, 'x.txt');
    assert.equal(d.family, FAMILY_LEGACY);
    assert.equal(extractFabFromDump(decoded.text), '2007');
    assert.equal(extractFabFromDump('            ****No. de fabric:  3344   ********'), '3344');
    assert.equal(extractFabFromDump('            ****No. di fabbr.:  1122   ********'), '1122');
    assert.ok(!decoded.text.includes('\r'));
    assert.match(decoded.text, /Parameter printout\s*\n\s+\*{4}Fabric\.number/);
  });

  it('liest PAL-110 unabhängig vom Parameternamen', () => {
    const palEn = '110; Fabric.number; 2007;       ; 2000; 19999;';
    assert.equal(extractFabFromDump(palEn), '2007');
  });

  it('erkennt DWC-4 Kopfzeile FN: 2007', () => {
    const sample = [
      'Waagenfabrik KUKLA     Parameterausdruck',
      '--------------------------------------------------------------------------------',
      'DWC4 L2.10 FN: 2007                    Nov 23 1998- D / __ -',
      'Nennleistung                         25000 kg/h',
    ].join('\n');
    assert.equal(extractFabFromDump(sample), '2007');
    const withNul = decodeDumpBuffer(Buffer.from('DWC4 L2.10 FN:\x00 2007\r\nNennleistung', 'binary'));
    assert.equal(extractFabFromDump(withNul.text), '2007');
  });

  it('erkennt L2.36 Parameterausdruck (tx_derzeit) als DWC-4 L2.36', () => {
    const { classifyBuffer, TRIGGERS } = require('./connect-probe');
    const { legacyDumpLabel } = require('./format-detect');
    const sample = [
      '       Waagenfabrik KUKLA    Parameterausdruck',
      '',
      'DWC4 L2.36  FN: 1234           Sep 15 2026- D /___- ',
      'Nennleistung                         25000 kg/h',
    ].join('\n');
    const d = detectDumpFamily(sample);
    assert.equal(d.family, FAMILY_LEGACY);
    assert.equal(d.label, 'DWC-4 L2.36');
    assert.equal(legacyDumpLabel(sample), 'DWC-4 L2.36');
    assert.equal(extractFabFromDump(sample), '1234');
    const hit = classifyBuffer(Buffer.from(sample, 'latin1'));
    assert.ok(hit);
    assert.equal(hit.label, 'DWC-4 L2.36');
    assert.equal(TRIGGERS[0].name, 'p');
    assert.deepEqual([...TRIGGERS[0].bytes], [0x50]);
    assert.equal(TRIGGERS[1].name, 'stx');
    assert.deepEqual([...TRIGGERS[1].bytes], [0x02]);
  });
});
