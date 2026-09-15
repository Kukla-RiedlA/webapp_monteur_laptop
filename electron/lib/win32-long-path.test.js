'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { win32FsPath, stripWin32LongPrefix, fsExistsSync, fsReaddirSync, isPathLengthFsError } = require('./win32-long-path');

describe('win32-long-path', () => {
  it('win32FsPath: Prefix nur unter Windows, idempotent', () => {
    const abs = path.resolve(__dirname, 'a.jpg');
    const out = win32FsPath(abs);
    if (process.platform === 'win32') {
      assert.match(out, /^\\\\\?\\/ );
      assert.equal(win32FsPath(out), out);
    } else {
      assert.equal(out, abs);
    }
  });

  it('fsExistsSync findet vorhandene Datei', () => {
    assert.equal(fsExistsSync(__filename), true);
    assert.equal(fsExistsSync(path.join(__dirname, 'does-not-exist-' + Date.now() + '.jpg')), false);
  });

  it('isPathLengthFsError erkennt ENAMETOOLONG', () => {
    assert.equal(isPathLengthFsError({ code: 'ENAMETOOLONG' }), true);
    assert.equal(isPathLengthFsError({ code: 'EPERM' }), false);
  });

  it('stripWin32LongPrefix entfernt Windows-Long-Path-Prefix', () => {
    assert.equal(stripWin32LongPrefix('\\\\?\\C:\\Fotos\\a.jpg'), 'C:\\Fotos\\a.jpg');
    assert.equal(stripWin32LongPrefix('\\\\?\\UNC\\server\\share\\a.jpg'), '\\server\\share\\a.jpg');
    assert.equal(stripWin32LongPrefix(__filename), __filename);
  });

  it('fsReaddirSync liest vorhandenes Verzeichnis', () => {
    const names = fsReaddirSync(__dirname);
    assert.ok(names.includes(path.basename(__filename)));
  });
});
