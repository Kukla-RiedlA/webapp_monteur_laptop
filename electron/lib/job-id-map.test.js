'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyDispoServerJobIdToPayload } = require('./job-id-map');

function fakeDb(rowsByLocal, rowsByServer) {
  const local = rowsByLocal || {};
  const server = rowsByServer || {};
  return {
    prepare(sql) {
      const s = String(sql || '');
      return {
        get(id) {
          if (/WHERE id = \?/.test(s)) return local[id] || local[String(id)] || undefined;
          if (/server_id/.test(s)) return server[id] || server[String(id)] || undefined;
          return undefined;
        },
      };
    },
  };
}

describe('applyDispoServerJobIdToPayload', () => {
  it('ersetzt lokale job_id durch server_id', () => {
    const db = fakeDb({ 107: { server_id: 5000 } });
    const out = applyDispoServerJobIdToPayload(db, { job_id: 107, local_job_id: 107, fabrikationsnummer: '12306' });
    assert.equal(out.job_id, 5000);
    assert.equal(out.local_job_id, 107);
    assert.equal(out.fabrikationsnummer, '12306');
  });

  it('nutzt local_job_id wenn job_id schon falsch/lokal ist', () => {
    const db = fakeDb({ 107: { server_id: 5000 } });
    const out = applyDispoServerJobIdToPayload(db, { job_id: 107, local_job_id: 107 });
    assert.equal(out.job_id, 5000);
  });

  it('laesst job_id unveraendert wenn kein server_id existiert', () => {
    const db = fakeDb({ 107: { server_id: null } });
    const out = applyDispoServerJobIdToPayload(db, { job_id: 107, local_job_id: 107 });
    assert.equal(out.job_id, 107);
  });

  it('erkennt job_id die bereits server_id ist', () => {
    const db = fakeDb({}, { 5000: { server_id: 5000 } });
    const out = applyDispoServerJobIdToPayload(db, { job_id: 5000 });
    assert.equal(out.job_id, 5000);
  });
});
