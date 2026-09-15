'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyPnThumbExportItem } = require('./anlagenstamm-local');
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
      if (/CREATE TABLE|CREATE INDEX|PRAGMA table_info/i.test(sql)) {
        return { run: () => {}, all: () => [] };
      }
      if (/SELECT content_type, thumb_blob/.test(sql)) {
        return {
          get(kind, scope, rel, max) {
            return rows.get(key(kind, scope, rel, max)) || undefined;
          },
        };
      }
      if (/SELECT rel_path FROM image_thumb_cache/.test(sql)) {
        return {
          all(kind, scope, max) {
            const out = [];
            for (const [k, v] of rows) {
              const parts = k.split('\0');
              if (parts[0] === kind && parts[1] === scope && parts[3] === String(max)) {
                out.push({ rel_path: parts[2] });
              }
            }
            return out;
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
      if (/DELETE FROM image_thumb_cache WHERE cache_kind = \? AND scope_id = \? AND rel_path/.test(sql)) {
        return {
          run(kind, scope, rel, max) {
            rows.delete(key(kind, scope, rel, max));
          },
        };
      }
      if (/DELETE FROM image_thumb_cache WHERE cache_kind = \? AND scope_id = \?$/.test(sql)) {
        return {
          run(kind, scope) {
            let changes = 0;
            for (const k of [...rows.keys()]) {
              const parts = k.split('\0');
              if (parts[0] === kind && parts[1] === scope) {
                rows.delete(k);
                changes += 1;
              }
            }
            return { changes };
          },
        };
      }
      throw new Error('unexpected sql: ' + sql);
    },
  };
}

describe('applyPnThumbExportItem', () => {
  it('schreibt Base64-Thumbs in den Cache und entfernt verwaiste Rel-Pfade', () => {
    const db = makeMemDb();
    const keepBuf = Buffer.from('keep-thumb');
    const goneBuf = Buffer.from('gone-thumb');
    writeImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12304', 'old/gone.jpg', 256, goneBuf, 'image/webp', null);
    const result = applyPnThumbExportItem(db, {
      fab: '12304',
      thumb_max: 256,
      thumbs: [
        {
          rel_path: 'Fotos/a.jpg',
          content_type: 'image/webp',
          thumb_blob_b64: keepBuf.toString('base64'),
          source_size_bytes: 1200,
          source_mtime_unix: 1710000000,
        },
      ],
      keep_rel_paths: ['Fotos/a.jpg'],
    });
    assert.equal(result.written, 1);
    assert.equal(result.pruned, 1);
    const hit = readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12304', 'Fotos/a.jpg', 256, null);
    assert.ok(hit);
    assert.equal(Buffer.compare(hit.buf, keepBuf), 0);
    const gone = readImageThumbCache(db, THUMB_KIND_PROJEKTE_NEU, '12304', 'old/gone.jpg', 256, null);
    assert.equal(gone, null);
  });
});
