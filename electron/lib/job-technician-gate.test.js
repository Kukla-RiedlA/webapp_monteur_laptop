'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePatchJobRef } = require('./job-technician-gate');

describe('resolvePatchJobRef', () => {
  it('nimmt local_job_id vor job_id (Kalender-Dispo-ID)', () => {
    const out = resolvePatchJobRef({ job_id: 75, local_job_id: 17, server_id: 75 });
    assert.equal(out.ref, 17);
    assert.equal(out.mode, 'local');
  });

  it('nutzt server-Mode wenn job_id gleich server_id und kein local_job_id', () => {
    const out = resolvePatchJobRef({ job_id: 247, server_id: 247 });
    assert.equal(out.ref, 247);
    assert.equal(out.mode, 'server');
  });

  it('nutzt auto wenn nur job_id gesetzt ist', () => {
    const out = resolvePatchJobRef({ job_id: 17 });
    assert.equal(out.ref, 17);
    assert.equal(out.mode, 'auto');
  });

  it('lehnt leeren Body ab', () => {
    const out = resolvePatchJobRef({});
    assert.equal(out.ref, null);
    assert.equal(out.mode, 'auto');
  });
});
