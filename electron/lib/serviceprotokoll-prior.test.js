'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const protocolDrafts = require('./protocol-drafts-local');
const { chooseServiceprotokollPrior, priorHasComparisonValues } = require('./serviceprotokoll-prior');

describe('serviceprotokoll prior', () => {
  it('erkennt Messwerte und ignoriert leere Entwürfe', () => {
    assert.equal(priorHasComparisonValues({ vers_spannung: '10' }), true);
    assert.equal(priorHasComparisonValues({ mess_matrix: { dms: { mv: '' } } }), false);
    assert.equal(priorHasComparisonValues({}), false);
  });

  it('nimmt das neuere Datum', () => {
    const older = { datum: '2024-01-01', messwerte: { vers_spannung: '9' } };
    const newer = { datum: '2025-06-01', messwerte: { vers_spannung: '10' } };
    assert.equal(chooseServiceprotokollPrior(older, newer), newer);
    assert.equal(chooseServiceprotokollPrior(newer, older), newer);
    assert.equal(chooseServiceprotokollPrior(older, { datum: '2026-01-01', messwerte: {} }), older);
  });

  it('liest ein älteres Protokoll derselben FN und lässt den aktuellen Auftrag aus', (t) => {
    let db;
    try {
      const Database = require('better-sqlite3');
      db = new Database(':memory:');
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const mess = {
      vers_spannung: '12',
      mess_matrix: { dms: { kg: '', mv: '1.8', ma: '4', g_prozent: '' } },
    };
    protocolDrafts.writeDraft(
      db,
      4,
      'serviceprotokoll.json',
      { byFab: { FN9: { durchfuehrungsdatum: '2024-03-02', messwerte: mess } } },
      1,
      '2024-03-02T10:00:00Z',
      null,
    );
    protocolDrafts.writeDraft(
      db,
      8,
      'serviceprotokoll.json',
      { byFab: { FN9: { durchfuehrungsdatum: '2023-01-01', messwerte: { vers_spannung: '1' } } } },
      1,
      '2023-01-01T10:00:00Z',
      null,
    );
    const found = protocolDrafts.findLocalServiceprotokollPrior(db, 9, 'FN9');
    assert.equal(found.messwerte.vers_spannung, '12');
    assert.equal(found.datum, '2024-03-02');
    assert.equal(protocolDrafts.findLocalServiceprotokollPrior(db, 4, 'FN9').messwerte.vers_spannung, '1');
    protocolDrafts.writeServiceprotokollPriorCache(db, 'FN9', {
      datum: '2025-08-01',
      job_id: 70,
      messwerte: { sensitivitaet: '2.1' },
    });
    const cached = protocolDrafts.readServiceprotokollPriorCache(db, 'FN9', 0);
    assert.equal(cached.messwerte.sensitivitaet, '2.1');
    assert.equal(protocolDrafts.readServiceprotokollPriorCache(db, 'FN9', 70), null);
    const picked = chooseServiceprotokollPrior(found, cached);
    assert.equal(picked.messwerte.sensitivitaet, '2.1');
    db.close();
  });
});
