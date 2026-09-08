'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('CSV Speichern unter', () => {
  it('behandelt CSV in main.js nicht als Excel-Datei', () => {
    const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const start = src.indexOf('function isExcelFile');
    assert.ok(start > 0, 'isExcelFile vorhanden');
    const snippet = src.slice(start, start + 280);
    assert.match(snippet, /ext === '\.xls'/);
    assert.doesNotMatch(snippet, /ext === '\.csv'/);
    assert.match(src, /csv\.saveAs/);
    assert.match(src, /stripOpenStampPrefix/);
    assert.match(src, /via: csv \? 'csv-save-as'/);
  });
});
