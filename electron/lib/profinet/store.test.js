'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('./store');

function fakeDb(mode) {
  const ops = [];
  const db = {
    ops,
    prepare(sql) {
      return {
        run(...args) {
          ops.push({ sql, args });
        },
        all() {
          return [];
        },
      };
    },
  };
  if (mode === 'compat') {
    db.transaction = (fn) => {
      fn();
    };
  } else {
    db.transaction = (fn) => () => {
      fn();
    };
  }
  return db;
}

test('Zuordnen läuft mit db-compat, das die Transaktion sofort ausführt', () => {
  const db = fakeDb('compat');
  const saved = store.replaceSet(db, 'FN-1', [{
    mac: '00:60:65:de:bc:f2',
    station_name: 'dwc7b',
    ip_address: '0.0.0.0',
  }], []);
  assert.deepEqual(saved.teilnehmer, []);
  assert.ok(db.ops.some((op) => /INSERT INTO anlagenstamm_profinet_teilnehmer/.test(op.sql)));
  assert.ok(db.ops.some((op) => op.args && op.args[1] === '00:60:65:de:bc:f2'));
});

test('Zuordnen ruft den better-sqlite3-Runner genau einmal auf', () => {
  const db = fakeDb('runner');
  store.replaceSet(db, 'FN-1', [{ mac: '00:60:65:de:bc:f2', station_name: 'dwc7b' }], []);
  const inserts = db.ops.filter((op) => /INSERT INTO anlagenstamm_profinet_teilnehmer/.test(op.sql));
  assert.equal(inserts.length, 1);
});
