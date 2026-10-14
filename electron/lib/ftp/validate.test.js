'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFtpTarget,
  normalizeRemoteDir,
  parentRemoteDir,
  assertRemoteFileName,
  publicFtpError,
} = require('./validate');

describe('ftp validate', () => {
  it('setzt Port 21 und anonymous, wenn nichts angegeben ist', () => {
    const t = parseFtpTarget({ host: '10.0.1.20' });
    assert.equal(t.port, 21);
    assert.equal(t.user, 'anonymous');
    assert.equal(t.password, '');
    assert.equal(t.remotePath, '/');
  });

  it('lehnt Passwort im Host ab', () => {
    assert.throws(() => parseFtpTarget({ host: 'user:secret@10.0.0.1' }), /IP-Adresse/);
  });

  it('normalisiert Verzeichnisse ohne ..', () => {
    assert.equal(normalizeRemoteDir('daten/parameter'), '/daten/parameter');
    assert.equal(parentRemoteDir('/daten/parameter'), '/daten');
    assert.equal(parentRemoteDir('/'), '/');
    assert.throws(() => normalizeRemoteDir('/daten/../secret'), /Ungültiger Pfad/);
  });

  it('nimmt nur Dateinamen ohne Pfad', () => {
    assert.equal(assertRemoteFileName('FN12186.csv'), 'FN12186.csv');
    assert.throws(() => assertRemoteFileName('../x.csv'), /Dateiname/);
    assert.throws(() => assertRemoteFileName('ordner/x.csv'), /Dateiname/);
  });

  it('kürzt Passwörter aus Fehlermeldungen', () => {
    assert.equal(publicFtpError({ message: 'login password=geheim failed' }), 'login password=*** failed');
  });
});
