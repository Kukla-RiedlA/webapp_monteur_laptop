'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  draftPayloadsEqual,
  classifyDraftSides,
  diffProtocolPayloads,
} = require('./multi-device-sync');

describe('draft content equality (ignore timestamps)', () => {
  it('treats same fachinhalt with different updatedAt as equal', () => {
    const local = {
      grundDesEinsatzes: 'Wartung',
      bemerkungen: 'ok',
      updatedAt: '2026-10-21T11:56:27',
      gespeichert_am: '2026-10-21 11:56:27',
    };
    const remote = {
      grundDesEinsatzes: 'Wartung',
      bemerkungen: 'ok',
      updatedAt: '2026-10-21T11:42:15',
      gespeichert_am: '2026-10-21 11:42:15',
      revision: 5,
      server_updated_at: '2026-10-21T11:42:15Z',
    };
    assert.equal(draftPayloadsEqual(local, remote), true);
    assert.equal(classifyDraftSides(local, remote), 'same');
    assert.equal(diffProtocolPayloads(local, remote).length, 0);
  });

  it('still detects real text differences', () => {
    const local = { bemerkungen: 'A', updatedAt: '2026-10-21T12:00:00' };
    const remote = { bemerkungen: 'B', updatedAt: '2026-10-21T11:00:00' };
    assert.equal(draftPayloadsEqual(local, remote), false);
    assert.equal(classifyDraftSides(local, remote), 'conflict');
    assert.ok(diffProtocolPayloads(local, remote).length > 0);
  });

  it('ignores nested byFab timestamps', () => {
    const local = {
      byFab: {
        '123': { bemerkungen: 'x', updatedAt: '2026-10-21T12:00:00' },
      },
    };
    const remote = {
      byFab: {
        '123': { bemerkungen: 'x', updated_at: '2026-10-21T11:00:00' },
      },
    };
    assert.equal(draftPayloadsEqual(local, remote), true);
    assert.equal(classifyDraftSides(local, remote), 'same');
  });
});
