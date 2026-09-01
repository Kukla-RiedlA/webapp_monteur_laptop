'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { purgeAnlagenstammLocalOrphans } = require('./anlagenstamm-local');

function makeCompatDb(rows) {
  const store = rows.slice();
  return {
    _store: store,
    prepare(sql) {
      if (/SELECT id FROM anlagenstamm_local/.test(sql)) {
        return {
          all: () => store.filter((r) => Number(r.dirty) !== 1).map((r) => ({ id: r.id })),
        };
      }
      if (/DELETE FROM anlagenstamm_local/.test(sql)) {
        return {
          run(id) {
            const i = store.findIndex((r) => r.id === id && Number(r.dirty) !== 1);
            if (i >= 0) store.splice(i, 1);
          },
        };
      }
      throw new Error('unexpected sql: ' + sql);
    },
    // Wie electron/lib/db-compat.js: sofort ausführen, kein Runner, keine Argumente.
    transaction(fn) {
      fn();
    },
  };
}

describe('purgeAnlagenstammLocalOrphans + db-compat', () => {
  it('loescht Orphans ohne TypeError (transaction ohne Argumente)', () => {
    const db = makeCompatDb([
      { id: 1, dirty: 0 },
      { id: 2, dirty: 0 },
      { id: 3, dirty: 1 },
    ]);
    const n = purgeAnlagenstammLocalOrphans(db, new Set([1]));
    assert.equal(n, 1);
    assert.deepEqual(
      db._store.map((r) => r.id),
      [1, 3],
    );
  });
});
