'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeArbeitsnachweisLanguage } = require('./arbeitsnachweis-local');

describe('Arbeitsnachweis Sprache', () => {
  it('behält Deutsch, Englisch und beide', () => {
    assert.equal(normalizeArbeitsnachweisLanguage('de'), 'de');
    assert.equal(normalizeArbeitsnachweisLanguage('en'), 'en');
    assert.equal(normalizeArbeitsnachweisLanguage('de,en'), 'de,en');
    assert.equal(normalizeArbeitsnachweisLanguage('en,de'), 'de,en');
    assert.equal(normalizeArbeitsnachweisLanguage(''), 'de');
  });
});
