'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isIdPaFormat, idPaToPal, parseIdPaLine } = require('./idpa-to-pal');
const { isPalDwc6Format } = require('../pal-to-pdf');

const SAMPLE = [
  'IdPa 100    100000     0     10000000 Nennleistung       kg/h      l 81',
  'IdPa 105    50         3     1000 Nennfrequenz        Hz      I 81',
  'IdPa 110    2007       2000  19999 FabrikNummer                 I 81',
  'IdPa 111    0          0     4 SPRACHE/LANGU                      l 81',
  'IdPa 116    45377      0     0 Software Ver.                      l 81',
  'IdPa 120    2000       0     10000 MinGrenze                      I 81',
].join('\n');

describe('kuklink idpa-to-pal', () => {
  it('wandelt IdPa in PAL-Semikolonliste', () => {
    assert.equal(isIdPaFormat(SAMPLE), true);
    const pal = idPaToPal(SAMPLE);
    assert.equal(isPalDwc6Format(pal, 'FN_2007.pal'), true);
    assert.match(pal, /100; Nennleistung\s*; 100000; kg\/h\s*; 0; 10000000;/);
    assert.match(pal, /110; Fabriknummer\s*; 2007;/);
    const fab = parseIdPaLine('IdPa 110    2007     2000     19999 FabrikNummer                 I 81');
    assert.equal(fab.value, '2007');
    assert.equal(fab.unit, '');
  });

  it('schneidet Typ-Schwanz l/I 81 ab und formatiert KUKLink-Werte', () => {
    const row = parseIdPaLine('IdPa 100    100000     0     10000000 Nennleistung       kg/h      l 81');
    assert.equal(row.name, 'Nennleistung');
    assert.equal(row.unit, 'kg/h');
    assert.equal(row.value, '100000');
    const sw = parseIdPaLine('IdPa 116    45377      0     0 Software Ver.                      l 81');
    assert.equal(sw.value, 'B1.41');
    assert.equal(sw.name, 'Software Version');
    const lang = parseIdPaLine('IdPa 111    0          0     4 SPRACHE/LANGU                      l 81');
    assert.equal(lang.value, '0 = Deutsch');
    const minB = parseIdPaLine('IdPa 120    2000       0     10000 MinGrenze                      I 81');
    assert.equal(minB.value, '20');
    assert.equal(minB.unit, '%');
    assert.equal(minB.name, 'Minimale Belegung');
  });

  it('verwirft Müllzeilen ohne gültiges IdPa', () => {
    const pal = idPaToPal('IdPa 50 0 1 foo I 81\nIdPa 256 33554944 OK OK IdPa\nIdPa 110 2007 2000 19999 FabrikNummer I 81\n');
    assert.match(pal, /110; Fabriknummer/);
    assert.doesNotMatch(pal, /256;/);
    assert.doesNotMatch(pal, /50;/);
  });
});
