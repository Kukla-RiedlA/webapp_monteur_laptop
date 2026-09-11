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

  it('erkennt FN in JSON-Leistungszeilen', () => {
    const json = JSON.stringify([
      { fabrikationsnummer: '12304', type: 'Bandwaage' },
      { fabrikationsnummer: '12305' },
    ]);
    assert.equal(jobHasFab(json, '12304'), true);
    assert.equal(jobHasFab(json, '12306'), false);
    assert.equal(jobHasFab('[{"fabrikationsnummer":"11603"}]', '11603'), true);
  });

  it('nimmt Dispo-Parameterlisten und ergänzt nur lokale Extra-Dateien', () => {
    const { mergeRemoteDocumentsList } = require('./anlagenstamm-documents-local');
    const local = {
      categories: [
        { slug: 'parameterliste', documents: [{ parameter_file_id: 1, original_name: 'A.CSV', size_bytes: 10 }] },
        { slug: 'montagebericht', documents: [] },
      ],
    };
    const remote = {
      ok: true,
      fab: '10066',
      parameter_fab: '10066',
      source: 'dispo_api',
      categories: [
        {
          slug: 'parameterliste',
          documents: [
            { parameter_file_id: 80, original_name: 'ALT.CSV', size_bytes: 99 },
            { parameter_file_id: 1, original_name: 'A.CSV', size_bytes: 10 },
          ],
        },
        { slug: 'montagebericht', documents: [{ id: 5, original_name: 'MB.pdf', size_bytes: 20 }] },
      ],
      events: [],
      timeline: [],
    };
    const merged = mergeRemoteDocumentsList(local, remote);
    const param = merged.categories.find((c) => c.slug === 'parameterliste');
    const mb = merged.categories.find((c) => c.slug === 'montagebericht');
    assert.equal(param.documents.length, 2);
    assert.equal(mb.documents.length, 1);
    assert.equal(merged.source, 'dispo_api');
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

  it('mappt Dokumente-Parameterlisten auf die Akte-Parameter-Liste', () => {
    const { mapParameterFilesFromDocumentsList } = require('./anlagenstamm-documents-local');
    const files = mapParameterFilesFromDocumentsList({
      categories: [
        {
          slug: 'parameterliste',
          documents: [
            {
              parameter_file_id: 44,
              original_name: 'FN10265_PA7_DE_20251118_1032.CSV',
              size_bytes: 88000,
              notes: 'Projekte neu · — · 910 Werte',
              display_datetime: '2025-11-18 10:32',
            },
            { id: 0, original_name: 'skip-me.csv' },
          ],
        },
      ],
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].id, 44);
    assert.equal(files[0].source, 'projekte_neu');
    assert.equal(files[0].entry_count, 910);
    assert.equal(files[0].original_filename, 'FN10265_PA7_DE_20251118_1032.CSV');
  });
});
