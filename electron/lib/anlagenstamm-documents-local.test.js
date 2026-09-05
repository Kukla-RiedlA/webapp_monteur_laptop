'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jobHasFab, KIND_TO_SLUG, buildLocalAnlagenstammDocumentsList } = require('./anlagenstamm-documents-local');

describe('local documents list', () => {
  it('ordnet Kontrollwiegung den Wiegeprotokollen zu', () => {
    assert.equal(KIND_TO_SLUG.kontrollwiegung, 'wiegeprotokoll');
  });

  it('erkennt FN in Job-Fabrikationsnummern', () => {
    assert.equal(jobHasFab('12304,12305', '12304'), true);
    assert.equal(jobHasFab('FN12304', '12304'), true);
    assert.equal(jobHasFab('1230,1231', '12304'), false);
  });

  it('legt Parameterlisten an und lässt JSON-Entwürfe weg', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('FROM anlagenstamm_parameter_files')) {
          return {
            all() {
              return [
                {
                  id: 9,
                  source: 'upload',
                  technician_name: 'Alois',
                  entry_count: 3,
                  original_filename: 'FN12304_PA.txt',
                  uploaded_at: '2026-09-04 10:00:00',
                  mime: 'text/plain',
                  size: 100,
                  storage_relpath: '',
                  source_path: '',
                  technician_id: 14,
                  source_file_status: 'present',
                },
              ];
            },
          };
        }
        if (s.includes('FROM protocol_drafts')) {
          return {
            all() {
              return [
                {
                  id: 1,
                  local_job_id: 166,
                  protocol_kind: 'kontrollwiegung',
                  fabrikationsnummer: '12304',
                  payload_json: JSON.stringify({ wiegung: { netto: 1 } }),
                  updated_at: '2026-09-04 11:00:00',
                  job_fabs: '12304,12305',
                },
              ];
            },
          };
        }
        return { all() { return []; }, get() { return null; } };
      },
    };
    const data = buildLocalAnlagenstammDocumentsList(db, '12304');
    const param = data.categories.find((c) => c.slug === 'parameterliste');
    const kw = data.categories.find((c) => c.slug === 'wiegeprotokoll');
    assert.equal(param.documents.length, 1);
    assert.equal(param.documents[0].parameter_file_id, 9);
    assert.equal(kw.documents.length, 0);
    assert.equal(data.source, 'local_fast');
  });
});
