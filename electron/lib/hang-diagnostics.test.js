'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPathKind } = require('./hang-diagnostics');

describe('classifyPathKind', () => {
  it('erkennt UNC, OneDrive und lokal', () => {
    assert.equal(classifyPathKind(''), 'unset');
    assert.equal(classifyPathKind('\\\\server\\share\\docs'), 'unc');
    assert.equal(classifyPathKind('C:\\Users\\x\\OneDrive\\Dokumente'), 'onedrive');
    assert.equal(classifyPathKind('C:\\Daten\\Monteur'), 'local');
  });
});
