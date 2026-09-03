'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replaceFileWithoutUnlink } = require('./replace-file-cloud-safe');
const { tedLocalFileLooksComplete } = require('./ted-excel-local');

describe('replaceFileWithoutUnlink', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-replace-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });

  it('legt eine neue Datei an', async () => {
    const dest = path.join(dir, 'neu.xls');
    const ret = replaceFileWithoutUnlink(dest, Buffer.from('ted-a'));
    assert.equal(typeof ret.then, 'function');
    await ret;
    assert.equal(fs.readFileSync(dest, 'utf8'), 'ted-a');
  });

  it('überschreibt vorhandene Datei ohne unlink der Zieldatei', async () => {
    const dest = path.join(dir, '1230401DF-AL_Aksaray-71.xls');
    fs.writeFileSync(dest, 'alt');
    const origUnlink = fs.unlinkSync;
    const unlinkedDest = [];
    fs.unlinkSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(dest)) unlinkedDest.push(p);
      return origUnlink(p);
    };
    try {
      await replaceFileWithoutUnlink(dest, Buffer.from('neu-inhalt'));
    } finally {
      fs.unlinkSync = origUnlink;
    }
    assert.equal(fs.readFileSync(dest, 'utf8'), 'neu-inhalt');
    assert.deepEqual(unlinkedDest, []);
    assert.equal(fs.existsSync(dest + '.part'), false);
  });
});

describe('tedLocalFileLooksComplete', () => {
  it('erkennt fehlende, leere und größenfalsche Dateien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-ted-complete-'));
    try {
      const p = path.join(dir, 'a.xls');
      assert.equal(tedLocalFileLooksComplete(p), false);
      fs.writeFileSync(p, '');
      assert.equal(tedLocalFileLooksComplete(p, 10), false);
      fs.writeFileSync(p, Buffer.alloc(10));
      assert.equal(tedLocalFileLooksComplete(p, 10), true);
      assert.equal(tedLocalFileLooksComplete(p, 11), false);
      assert.equal(tedLocalFileLooksComplete(p), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
