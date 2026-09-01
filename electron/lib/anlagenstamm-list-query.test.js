'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sortAnlagenstammRows } = require('./anlagenstamm-list-query');

function fabs(rows) {
  return rows.map((r) => r.fabrikationsnummer);
}

describe('Anlagenstamm FN-Sortierung (wie Dispo)', () => {
  const rows = [
    { fabrikationsnummer: 'Angebot2' },
    { fabrikationsnummer: '999945 t/h' },
    { fabrikationsnummer: '12540' },
    { fabrikationsnummer: '12531' },
    { fabrikationsnummer: '9999' },
  ];

  it('DESC: hoechste Zahl oben, Text-FNs danach', () => {
    const sorted = sortAnlagenstammRows(rows, { sort_col: 'fabrikationsnummer', sort_dir: 'desc' });
    assert.deepEqual(fabs(sorted), ['12540', '12531', '9999', 'Angebot2', '999945 t/h']);
  });

  it('ASC: kleinste Zahl oben, Text-FNs am Ende', () => {
    const sorted = sortAnlagenstammRows(rows, { sort_col: 'fabrikationsnummer', sort_dir: 'asc' });
    assert.deepEqual(fabs(sorted), ['9999', '12531', '12540', '999945 t/h', 'Angebot2']);
  });
});
