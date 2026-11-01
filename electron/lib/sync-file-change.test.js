'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideSharedFile } = require('./multi-device-sync');
const {
  remoteFileAlreadyLocal,
  localFileNeedsPush,
  contentShaPlaceholder,
  contentShaForFileStat,
  HASH_FULL_READ_MAX_BYTES,
} = require('./sync-file-change');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('remoteFileAlreadyLocal', () => {
  it('lädt nicht erneut, wenn nur die Uhrzeit abweicht und die Größe gleich ist', () => {
    assert.equal(remoteFileAlreadyLocal({ size: 100 }, { size: 100, mtime_ms: Date.now() }), true);
  });

  it('lädt, wenn die Größe abweicht', () => {
    assert.equal(remoteFileAlreadyLocal({ size: 100 }, { size: 120 }), false);
  });

  it('lädt bei gleichem SHA nicht, auch wenn die Größe in der Liste fehlt', () => {
    assert.equal(remoteFileAlreadyLocal({ size: 100, sha256: SHA_A }, { size: null, sha256: SHA_A }), true);
  });

  it('lädt bei gleichem Umfang, wenn der Inhalt abweicht', () => {
    assert.equal(
      remoteFileAlreadyLocal({ size: 100, sha256: SHA_A }, { size: 100, sha256: SHA_B }),
      false,
    );
  });

  it('lädt, wenn die Datei lokal fehlt', () => {
    assert.equal(remoteFileAlreadyLocal(null, { size: 10, sha256: SHA_A }), false);
  });
});

describe('localFileNeedsPush', () => {
  it('lädt nicht hoch, wenn nur die Uhrzeit neu ist', () => {
    assert.equal(localFileNeedsPush({ size: 50, mtimeMs: 1 }, { size: 50, mtimeMs: 999 }), false);
  });

  it('lädt hoch, wenn die Größe abweicht', () => {
    assert.equal(localFileNeedsPush({ size: 50 }, { size: 51 }), true);
  });

  it('lädt hoch, wenn der gespeicherte Inhalt abweicht', () => {
    assert.equal(
      localFileNeedsPush({ size: 50, sha256: SHA_A }, { size: 50, sha256: SHA_B }),
      true,
    );
  });

  it('lädt eine noch nie gesendete Datei hoch', () => {
    assert.equal(localFileNeedsPush(null, { size: 50, sha256: SHA_A }), true);
  });
});

describe('contentShaForFileStat', () => {
  it('bildet den Größen-Platzhalter und liest die Datei nicht', () => {
    let reads = 0;
    const size = HASH_FULL_READ_MAX_BYTES + 1;
    const sha = contentShaForFileStat({ size, mtimeMs: 1200.9, isFile: true }, () => {
      reads += 1;
      return Buffer.from('nein');
    });
    assert.equal(reads, 0);
    assert.equal(sha, contentShaPlaceholder(size, 1200.9));
    assert.equal(sha, 'size:' + size + ':mtime:1200');
  });

  it('entscheidet mit gleichem Platzhalter keep und mit verschiedenem download oder conflict', () => {
    const a = contentShaPlaceholder(HASH_FULL_READ_MAX_BYTES + 8, 10);
    const b = contentShaPlaceholder(HASH_FULL_READ_MAX_BYTES + 9, 10);
    assert.equal(decideSharedFile({ localSha: a, remoteSha: a, localUnchanged: false }), 'keep');
    assert.equal(decideSharedFile({ localSha: a, remoteSha: b, localUnchanged: true }), 'download');
    assert.equal(decideSharedFile({ localSha: a, remoteSha: b, localUnchanged: false }), 'conflict');
    assert.equal(decideSharedFile({ localSha: a, remoteSha: b, draftConflict: true }), 'conflict');
  });

  it('lädt, wenn lokal keine SHA da ist und die Gegenstelle eine hat', () => {
    assert.equal(decideSharedFile({ localSha: '', remoteSha: SHA_A }), 'download');
  });
});
