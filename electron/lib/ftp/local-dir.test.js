'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { listLocalDirectory, saveLocalFile } = require('./local-dir');

describe('ftp lokaler Ordner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-ftp-'));
  fs.writeFileSync(path.join(root, 'notiz.txt'), 'hallo');
  fs.mkdirSync(path.join(root, 'Unterordner'));

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('listet Dateien und Ordner', () => {
    const listed = listLocalDirectory(root);
    assert.equal(listed.path, path.resolve(root));
    const names = listed.entries.map((entry) => entry.name);
    assert.deepEqual(names, ['Unterordner', 'notiz.txt']);
    assert.equal(listed.entries[0].type, 'dir');
    assert.equal(listed.entries[1].type, 'file');
  });

  it('speichert nur in den gewählten Ordner', () => {
    const saved = saveLocalFile(root, 'FN2007.csv', Buffer.from('a;b'));
    assert.equal(path.dirname(saved.path), path.resolve(root));
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'a;b');
    const again = saveLocalFile(root, 'FN2007.csv', Buffer.from('c'));
    assert.equal(again.name, 'FN2007_2.csv');
  });

  it('lehnt Pfade im Dateinamen ab', () => {
    assert.throws(() => saveLocalFile(root, '..\\x.csv', Buffer.from('a')), /Dateiname/);
  });
});
