'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLocalFresher,
  timestampsAreUncertain,
  HANDLED_PENDING_ENTITY_TYPES,
} = require('./local_first');
const { mergeByFabStores, classifyDraftSides, decideSharedFile, payloadForServerPush, diffProtocolPayloads } = require('./multi-device-sync');

describe('isLocalFresher', () => {
  it('returns true when local is newer', () => {
    assert.equal(isLocalFresher('2026-08-26T12:00:00Z', '2026-08-26T11:00:00Z'), true);
  });
  it('returns false when remote is newer', () => {
    assert.equal(isLocalFresher('2026-08-26T11:00:00Z', '2026-08-26T12:00:00Z'), false);
  });
  it('returns null when both timestamps are missing', () => {
    assert.equal(isLocalFresher(null, null), null);
    assert.equal(timestampsAreUncertain(null, ''), true);
  });
  it('returns true when only local timestamp exists', () => {
    assert.equal(isLocalFresher('2026-08-26T12:00:00Z', null), true);
  });
  it('returns false when only remote timestamp exists', () => {
    assert.equal(isLocalFresher(null, '2026-08-26T12:00:00Z'), false);
  });
});

describe('mergeByFabStores', () => {
  it('keeps local-only and remote-only FNs', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T12:00:00Z', x: 1 } } },
      { byFab: { B: { updated_at: '2026-08-26T12:00:00Z', y: 2 } } },
    );
    assert.ok(merged.payload.byFab.A);
    assert.ok(merged.payload.byFab.B);
    assert.equal(merged.payload.byFab.A.x, 1);
    assert.equal(merged.payload.byFab.B.y, 2);
  });
  it('keeps newer local FN over older remote', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T13:00:00Z', v: 'local' } } },
      { byFab: { A: { updated_at: '2026-08-26T10:00:00Z', v: 'remote' } } },
    );
    assert.equal(merged.payload.byFab.A.v, 'local');
  });
  it('keeps both filled FN stands as a conflict instead of last-writer-wins', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T10:00:00Z', v: 'local' } } },
      { byFab: { A: { updated_at: '2026-08-26T13:00:00Z', v: 'remote' } } },
    );
    assert.equal(merged.payload.byFab.A.v, 'local');
    assert.deepEqual(merged.conflicts, ['A']);
  });
  it('filled remote replaces an empty local stub', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T13:00:00Z', kunde: 'Nur Kopf' } } },
      { byFab: { A: { updated_at: '2026-08-26T10:00:00Z', bemerkung: 'ausgefüllt' } } },
    );
    assert.equal(merged.payload.byFab.A.bemerkung, 'ausgefüllt');
    assert.deepEqual(merged.conflicts, []);
  });
  it('does not count job prefill as protocol content', () => {
    assert.equal(
      classifyDraftSides(
        { kunde: 'Knauf', datum: '2026-08-26', adresse: 'Werk' },
        { kunde: 'Knauf', datum: '2026-08-26', adresse: 'Werk', bemerkung: 'Lager geprüft' },
      ),
      'remote',
    );
  });
  it('preferLocal keeps existing local FN even if remote is newer', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T10:00:00Z', v: 'local' } } },
      { byFab: { A: { updated_at: '2026-08-26T13:00:00Z', v: 'remote' }, B: { v: 'nur-dispo' } } },
      { preferLocal: true },
    );
    assert.equal(merged.payload.byFab.A.v, 'local');
    assert.equal(merged.payload.byFab.B.v, 'nur-dispo');
  });
  it('empty local stub loses to remote wiegungen even if local timestamp is newer', () => {
    const merged = mergeByFabStores(
      {
        byFab: {
          A: {
            updated_at: '2026-09-05T12:00:00Z',
            wiegungen: [{ nr: 1 }],
          },
        },
      },
      {
        byFab: {
          A: {
            updated_at: '2026-09-04T10:00:00Z',
            wiegungen: [{ nr: 1, soll: '100', ist: '100' }],
          },
          B: {
            updated_at: '2026-09-04T10:00:00Z',
            wiegungen: [{ nr: 1, soll: '50', ist: '50' }],
          },
        },
      },
    );
    assert.equal(merged.payload.byFab.A.wiegungen[0].soll, '100');
    assert.equal(merged.payload.byFab.B.wiegungen[0].soll, '50');
  });
});

describe('HANDLED_PENDING_ENTITY_TYPES', () => {
  it('covers schleppketten, pruefzertifikat and protocol_draft', () => {
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('schleppketten'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('pruefzertifikat'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('protocol_draft'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('kontrollwiegung'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('serviceprotokoll'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('parameter_ingest'));
  });
});

describe('decideSharedFile', () => {
  it('downloads when the hash differs and the local file was not edited since sync', () => {
    assert.equal(
      decideSharedFile({ localSha: 'aaa', remoteSha: 'bbb', localUnchanged: true, draftConflict: false }),
      'download',
    );
  });
  it('keeps a matching hash even if mtime would differ', () => {
    assert.equal(
      decideSharedFile({ localSha: 'aaa', remoteSha: 'aaa', localUnchanged: false }),
      'keep',
    );
  });
  it('conflicts when both sides changed or a draft conflict is open', () => {
    assert.equal(
      decideSharedFile({ localSha: 'aaa', remoteSha: 'bbb', localUnchanged: false }),
      'conflict',
    );
    assert.equal(
      decideSharedFile({ localSha: 'aaa', remoteSha: 'bbb', localUnchanged: true, draftConflict: true }),
      'conflict',
    );
  });
});

describe('payloadForServerPush', () => {
  it('leaves conflict FN on the server and pushes the other FN', () => {
    const safe = payloadForServerPush(
      { byFab: { A: { v: 'local' }, B: { v: 'union' } } },
      { byFab: { A: { v: 'remote' } } },
      ['A'],
    );
    assert.equal(safe.byFab.A.v, 'remote');
    assert.equal(safe.byFab.B.v, 'union');
  });
});

describe('diffProtocolPayloads', () => {
  it('lists only changed montagebericht fields and groups them by FN', () => {
    const rows = diffProtocolPayloads(
      {
        grundDesEinsatzes: 'Wartung',
        grundDesEinsatzes_html: '<p>Wartung</p>',
        fabBemerkungen: [
          { fabrikationsnummer: '9500', type: 'A', bemerkungen: 'dieser Laptop', bemerkungen_html: '<p>dieser Laptop</p>' },
          { fabrikationsnummer: '10832', bemerkungen: 'gleich', bemerkungen_html: '<p>gleich</p>' },
        ],
      },
      {
        grundDesEinsatzes: 'Austausch',
        grundDesEinsatzes_html: '<p>Austausch</p>',
        revision: 4,
        fabBemerkungen: [
          { fabrikationsnummer: '9500', type: 'A', bemerkungen: 'anderer Laptop', bemerkungen_html: '<p>anderer Laptop</p>' },
          { fabrikationsnummer: '10832', bemerkungen: 'gleich', bemerkungen_html: '<p>gleich</p>' },
        ],
      },
    );
    assert.deepEqual(
      rows.map((row) => row.group + '|' + row.label + '|' + row.local + '|' + row.remote),
      ['|Grund des Einsatzes|Wartung|Austausch', 'FN 9500|Bemerkungen|dieser Laptop|anderer Laptop'],
    );
  });

  it('treats the same text with different html as equal and reports a changed image', () => {
    const rows = diffProtocolPayloads(
      { bemerkungen: 'Text', bemerkungen_html: '<p>Text</p><img src="data:image/png;base64,aaa">' },
      { bemerkungen: 'Text', bemerkungen_html: '<p>Text</p><img src="data:image/png;base64,bbb">' },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Bemerkungen (Bild)');
    assert.equal(rows[0].local, 'Bild auf diesem Laptop');
    assert.equal(rows[0].remote, 'anderes Bild');
  });

  it('groups byFab differences under the FN', () => {
    const rows = diffProtocolPayloads(
      { byFab: { '9500': { messwert: '1', updatedAt: '2026-10-01' }, '10832': { messwert: '9' } } },
      { byFab: { '9500': { messwert: '2', updatedAt: '2026-10-08' }, '10832': { messwert: '9' } } },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].group, 'FN 9500');
    assert.equal(rows[0].local, '1');
    assert.equal(rows[0].remote, '2');
  });
});
