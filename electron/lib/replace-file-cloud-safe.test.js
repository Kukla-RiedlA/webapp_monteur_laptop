'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replaceFileWithoutUnlink, replaceFileWithoutUnlinkSync } = require('./replace-file-cloud-safe');
const { tedLocalFileLooksComplete } = require('./ted-excel-local');
const { fsExistsSync, fsReadFileSync, win32FsPath } = require('./win32-long-path');

describe('replaceFileWithoutUnlink', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-replace-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(process.platform === 'win32' ? win32FsPath(dir) : dir, { recursive: true, force: true });
    } catch (_) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (__) {
        /* ignore */
      }
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

  it('Sync-Variante überschreibt ohne unlink der Zieldatei', () => {
    const dest = path.join(dir, 'protokoll.pdf');
    fs.writeFileSync(dest, 'alt');
    const origUnlink = fs.unlinkSync;
    const unlinkedDest = [];
    fs.unlinkSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(dest)) unlinkedDest.push(p);
      return origUnlink(p);
    };
    try {
      replaceFileWithoutUnlinkSync(dest, Buffer.from('neu'));
    } finally {
      fs.unlinkSync = origUnlink;
    }
    assert.equal(fs.readFileSync(dest, 'utf8'), 'neu');
    assert.deepEqual(unlinkedDest, []);
  });

  it('schreibt unter Windows in einen Pfad länger als MAX_PATH', async () => {
    if (process.platform !== 'win32') return;
    let dest = dir;
    while (dest.length < 250) {
      dest = path.join(dest, '11603_Knauf Enginnering GmbH Iphofen Stuckgips Sittingbourne');
    }
    dest = path.join(dest, 'Montage', 'Bilder', '11603_2026-03-21_09-57-23.jpg');
    assert.ok(dest.length > 260);
    await replaceFileWithoutUnlink(dest, Buffer.from('foto-bytes'));
    assert.equal(fsExistsSync(dest), true);
    assert.equal(fsReadFileSync(dest).toString(), 'foto-bytes');
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
