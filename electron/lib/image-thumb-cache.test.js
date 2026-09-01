'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  THUMB_KIND_PROJEKTE_NEU,
  readImageThumbCache,
  writeImageThumbCache,
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
});
