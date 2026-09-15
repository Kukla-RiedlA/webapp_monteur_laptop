'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTargetFab } = require('./anlagenstamm-parameter-parser');

describe('resolveTargetFab', () => {
  it('nutzt die geöffnete Anlage, wenn die Datei keine FN hat', () => {
    const r = resolveTargetFab('', '9751');
    assert.equal(r.ok, true);
    assert.equal(r.fab, '9751');
  });

  it('akzeptiert passende FN', () => {
    const r = resolveTargetFab('FN9751', '9751');
    assert.equal(r.ok, true);
    assert.equal(r.fab, '9751');
  });

  it('lehnt abweichende FN ab', () => {
    const r = resolveTargetFab('12186', '9751');
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /12186/);
    assert.match(String(r.error || ''), /9751/);
  });

  it('fällt auf erkannte FN zurück, wenn keine Anlage übergeben wird', () => {
    const r = resolveTargetFab('9751', '');
    assert.equal(r.ok, true);
    assert.equal(r.fab, '9751');
  });
});
