'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLocalFresher,
  timestampsAreUncertain,
  HANDLED_PENDING_ENTITY_TYPES,
} = require('./local_first');
const { mergeByFabStores } = require('./multi-device-sync');

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
  it('takes remote FN when remote is newer', () => {
    const merged = mergeByFabStores(
      { byFab: { A: { updated_at: '2026-08-26T10:00:00Z', v: 'local' } } },
      { byFab: { A: { updated_at: '2026-08-26T13:00:00Z', v: 'remote' } } },
    );
    assert.equal(merged.payload.byFab.A.v, 'remote');
  });
});

describe('HANDLED_PENDING_ENTITY_TYPES', () => {
  it('covers schleppketten, pruefzertifikat and protocol_draft', () => {
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('schleppketten'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('pruefzertifikat'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('protocol_draft'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('kontrollwiegung'));
    assert.ok(HANDLED_PENDING_ENTITY_TYPES.includes('serviceprotokoll'));
  });
});
