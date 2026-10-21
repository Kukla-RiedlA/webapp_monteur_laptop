'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stripPasswordFields,
  scrubPasswordFieldsInJson,
  scrubPasswordColumnsInTable,
} = require('./credential-vault');

describe('credential-vault strip/scrub', () => {
  it('stripPasswordFields removes all plaintext password keys', () => {
    const out = stripPasswordFields({
      baseUrl: 'https://example',
      serverUsername: 'Alois',
      serverPassword: 'geheim',
      dispo_password: 'alt',
      dispoPassword: 'x',
      server_password: 'y',
      password: 'z',
      job_id: 1,
    });
    assert.equal(out.baseUrl, 'https://example');
    assert.equal(out.serverUsername, 'Alois');
    assert.equal(out.job_id, 1);
    assert.equal(out.serverPassword, undefined);
    assert.equal(out.dispo_password, undefined);
    assert.equal(out.dispoPassword, undefined);
    assert.equal(out.server_password, undefined);
    assert.equal(out.password, undefined);
  });

  it('scrubPasswordFieldsInJson removes keys and reports changed', () => {
    const raw = JSON.stringify({
      type: 'schleppkette',
      serverPassword: 'Ka***',
      local_id: 38,
    });
    const r = scrubPasswordFieldsInJson(raw);
    assert.equal(r.changed, true);
    const obj = JSON.parse(r.text);
    assert.equal(obj.type, 'schleppkette');
    assert.equal(obj.local_id, 38);
    assert.equal(obj.serverPassword, undefined);
  });

  it('scrubPasswordFieldsInJson is idempotent when clean', () => {
    const raw = JSON.stringify({ a: 1 });
    const r = scrubPasswordFieldsInJson(raw);
    assert.equal(r.changed, false);
    assert.equal(r.text, raw);
  });

  it('scrubPasswordColumnsInTable cleans payload_json via prepare API', () => {
    const rows = [
      { _rid: 1, _json: JSON.stringify({ serverPassword: 'secret', technicianId: 14 }) },
      { _rid: 2, _json: JSON.stringify({ technicianId: 14 }) },
    ];
    const updates = [];
    const db = {
      prepare(sql) {
        if (/SELECT/i.test(sql)) {
          return {
            all() {
              return rows.filter((r) => /"serverPassword"/.test(r._json) || /"dispo_password"/.test(r._json));
            },
          };
        }
        return {
          run(text, rid) {
            updates.push({ text, rid });
            const hit = rows.find((r) => r._rid === rid);
            if (hit) hit._json = text;
          },
        };
      },
    };
    const n = scrubPasswordColumnsInTable(db, 'background_jobs', 'payload_json');
    assert.equal(n, 1);
    assert.equal(updates.length, 1);
    const payload = JSON.parse(rows[0]._json);
    assert.equal(payload.technicianId, 14);
    assert.equal(payload.serverPassword, undefined);
  });
});

