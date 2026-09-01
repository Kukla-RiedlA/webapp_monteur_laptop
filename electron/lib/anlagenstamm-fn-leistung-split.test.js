'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  trySplitMerged,
  normalizeRow,
  looksMerged,
} = require('./anlagenstamm-fn-leistung-split');

function expectSplit(raw, fn, leist) {
  const got = trySplitMerged(raw);
  assert.ok(got, raw + ' sollte splitten');
  assert.equal(got.fabrikationsnummer, fn, raw + ' FN');
  assert.equal(got.leistung, leist, raw + ' Leistung');
}

describe('anlagenstamm FN/Leistung-Split', () => {
  it('trennt Einheit nach 5-stelliger FN', () => {
    expectSplit('95844 t/h', '95844', 't/h');
  });

  it('trennt 6-stellige Zahl plus Einheit', () => {
    expectSplit('958442 t/h', '95844', '2 t/h');
  });

  it('trennt FN und Leistungszahl mit Leerzeichen', () => {
    expectSplit('12300 80 t/h', '12300', '80 t/h');
  });

  it('behaelt gesetzte Leistung wenn FN nur die Einheit traegt', () => {
    const c = normalizeRow('95844 t/h', '80 t/h');
    assert.equal(c.fabrikationsnummer, '95844');
    assert.equal(c.leistung, '80 t/h');
  });

  it('splitte 12300 50 t/h in leere Leistung', () => {
    const e = normalizeRow('12300 50 t/h', '');
    assert.equal(e.fabrikationsnummer, '12300');
    assert.equal(e.leistung, '50 t/h');
  });

  it('looksMerged erkennt verkettete Werte', () => {
    assert.equal(looksMerged('95844 t/h'), true);
    assert.equal(looksMerged('95844'), false);
    assert.equal(looksMerged('1249480 t/h'), true);
  });

  it('splitte typische Import-Artefakte', () => {
    const cases = [
      ['12496400 t/h', '12496', '400 t/h'],
      ['124955,5 t/h', '12495', '5,5 t/h'],
      ['1249480 t/h', '12494', '80 t/h'],
      ['12492100 t/h', '12492', '100 t/h'],
      ['124913500 kg/h', '12491', '3500 kg/h'],
      ['124906 t/h', '12490', '6 t/h'],
      ['9258180 t/h', '92581', '80 t/h'],
      ['95973,5 t/h', '95973', '0,5 t/h'],
      ['1125010 m³/h', '11250', '10 m³/h'],
    ];
    for (const [raw, fn, leist] of cases) expectSplit(raw, fn, leist);
  });

  it('laesst Buchstaben-Varianten und Bereiche unangetastet', () => {
    for (const raw of ['7551 A', '7551 B', '8135 A-C', '11415 A+B', '11626A+B', '11111-45', '10177-A', '6398 /']) {
      assert.equal(trySplitMerged(raw), null, raw);
    }
  });

  it('erkennt 4-stellige FN plus Leistung (99xxx)', () => {
    const four = [
      ['999945 t/h', '9999', '45 t/h'],
      ['999840 t/h', '9998', '40 t/h'],
      ['9997250 t/h', '9997', '250 t/h'],
      ['997510 t/h', '9975', '10 t/h'],
      ['997510\nt/h', '9975', '10 t/h'],
      ['9974 t/h', '9974', 't/h'],
      ['9970300 kg/h', '9970', '300 kg/h'],
    ];
    for (const [raw, fn, leist] of four) expectSplit(raw, fn, leist);
  });

  it('kombiniert 6-stellige FN mit Einheits-Leistung', () => {
    const mergedUnit = normalizeRow('997510', 't/h');
    assert.equal(mergedUnit.fabrikationsnummer, '9975');
    assert.equal(mergedUnit.leistung, '10 t/h');
  });
});
