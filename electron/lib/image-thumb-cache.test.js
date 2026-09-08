'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  THUMB_KIND_PROJEKTE_NEU,
  readImageThumbCache,
  writeImageThumbCache,
  deleteImageThumbCacheExcept,
  normalizeScopeId,
} = require('./image-thumb-cache');

function makeMemDb() {
  const rows = new Map();
  function key(kind, scope, rel, max) {
    return [kind, scope, rel, String(max)].join('\0');
  }
  return {
    prepare(sql) {
      if (/CREATE TABLE|CREATE INDEX/i.test(sql)) {
        return { run: () => {} };
      }
      if (/SELECT content_type, thumb_blob/.test(sql)) {
        return {
          get(kind, scope, rel, max) {
            return rows.get(key(kind, scope, rel, max)) || undefined;
          },
        };
      }
      if (/INSERT INTO image_thumb_cache/.test(sql)) {
        return {
          run(kind, scope, rel, max, contentType, buf, sourceMtime, sourceSize) {
            rows.set(key(kind, scope, rel, max), {
              content_type: contentType,
              thumb_blob: buf,
              source_mtime: sourceMtime,
              source_size: sourceSize,
            });
          },
        };
      }
      if (/SELECT rel_path FROM image_thumb_cache/.test(sql)) {
        return {
          all(kind, scope, max) {
            const out = [];
            for (const [k] of rows) {
              const parts = k.split('\0');
              if (parts[0] === kind && parts[1] === scope && parts[3] === String(max)) {
                out.push({ rel_path: parts[2] });
              }
            }
            return out;
          },
        };
      }
      if (/DELETE FROM image_thumb_cache WHERE cache_kind = \? AND scope_id = \? AND rel_path/.test(sql)) {
        return {
          run(kind, scope, rel, max) {
            rows.delete(key(kind, scope, rel, max));
          },
        };
      }
      throw new Error('unexpected sql: ' + sql);
    },
  };
}

describe('image_thumb_cache', () => {
  it('schreibt und liest WebP-Thumbs ohne lokale Vollbild-Datei', () => {
    const db = makeMemDb();
    const buf = Buffer.from('RIFF....WEBPFAKE');
    assert.equal(
      writeImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12300', '12229/IMG_3626.JPG', 256, buf, 'image/webp', null),
      true,
    );
    const hit = readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12300', '12229/IMG_3626.JPG', 256, null);
    assert.ok(hit);
    assert.equal(hit.contentType, 'image/webp');
    assert.equal(Buffer.compare(hit.buf, buf), 0);
  });

  it('normalisiert FN-Scope damit 12304 und 12304_Kunde denselben Cache treffen', () => {
    assert.equal(normalizeScopeId('12304'), '12304');
    assert.equal(normalizeScopeId('12304_Kunde'), '12304');
    const db = makeMemDb();
    const buf = Buffer.from('RIFF....WEBPFAKE');
    assert.equal(
      writeImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12304_Kunde', 'Montage/a.jpg', 256, buf, 'image/webp', null),
      true,
    );
    const hit = readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12304', 'Montage/a.jpg', 256, null);
    assert.ok(hit);
    assert.equal(Buffer.compare(hit.buf, buf), 0);
  });

  it('uebernimmt Server-source_mtime und prune per keep_rel_paths', () => {
    const db = makeMemDb();
    const keep = Buffer.from('keep');
    const gone = Buffer.from('gone');
    writeImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '10584', 'old.jpg', 256, gone, 'image/webp', null);
    writeImageThumbCache(
      db,
      THUMB_KIND_PROJEKTE_NEU,
      '10584',
      'new.jpg',
      256,
      keep,
      'image/webp',
      null,
      { source_mtime: 1710000000, source_size: 42 },
    );
    const n = deleteImageThumbCacheExcept(db, THUMB_KIND_PROJEKTE_NEU, '10584', ['new.jpg'], 256);
    assert.equal(n, 1);
    assert.equal(readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '10584', 'old.jpg', 256, null), null);
    const hit = readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '10584', 'new.jpg', 256, null);
    assert.ok(hit);
  });
});
