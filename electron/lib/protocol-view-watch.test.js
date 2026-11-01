'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { protocolViewsToScan } = require('./protocol-view-watch');

describe('protocolViewsToScan', () => {
  it('liefert nur die sichtbare Protokollmaske', () => {
    assert.deepEqual(protocolViewsToScan('viewProtokolleMontagebericht'), ['viewProtokolleMontagebericht']);
  });

  it('scannt Start, leer und unbekannte Masken nicht', () => {
    assert.deepEqual(protocolViewsToScan('start'), []);
    assert.deepEqual(protocolViewsToScan(''), []);
    assert.deepEqual(protocolViewsToScan('viewProtokolleService'), []);
  });
});
