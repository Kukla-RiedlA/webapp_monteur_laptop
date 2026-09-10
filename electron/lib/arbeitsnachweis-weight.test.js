'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { contentWeight, resolveSavePayload } = require('./arbeitsnachweis-local');

function day(desc) {
  return {
    item_type: 'arbeitszeile',
    item_date: '2026-09-01',
    description: desc || 'Arbeit',
    item_time: '08:00–17:00',
    normal_hours: 8,
  };
}

describe('contentWeight', () => {
  it('scores a filled work day as 3', () => {
    assert.equal(contentWeight({ items: [day()], arbeitsnachweis: {} }), 3);
  });
  it('scores three filled days as 9', () => {
    assert.equal(
      contentWeight({
        items: [day('Tag 1'), day('Tag 2'), day('Tag 3')],
        arbeitsnachweis: {},
      }),
      9,
    );
  });
  it('treats date-only rows as 1', () => {
    assert.equal(
      contentWeight({
        items: [{ item_type: 'arbeitszeile', item_date: '2026-09-01' }],
        arbeitsnachweis: {},
      }),
      1,
    );
  });
});

describe('resolveSavePayload', () => {
  it('prefers current SQLite when it is heavier than a frozen queue snapshot', () => {
    const snapshot = {
      baseUrl: 'https://dispo.example',
      technician_id: 7,
      items: [day('Tag 1')],
      arbeitsnachweis: {},
    };
    const local = {
      items: [day('Tag 1'), day('Tag 2'), day('Tag 3')],
      arbeitsnachweis: { remarks: 'aktuell' },
      job_id: 42,
    };
    const chosen = resolveSavePayload(snapshot, local);
    assert.equal(chosen.baseUrl, 'https://dispo.example');
    assert.equal(chosen.technician_id, 7);
    assert.equal(chosen.job_id, 42);
    assert.equal(chosen.items.length, 3);
    assert.ok(contentWeight(chosen) > contentWeight(snapshot));
  });
  it('falls back to the queue snapshot when local row is missing', () => {
    const snapshot = { items: [day('Tag 1')], arbeitsnachweis: {} };
    const chosen = resolveSavePayload(snapshot, null);
    assert.equal(chosen, snapshot);
  });
});

describe('merge job FNs into Arbeitsnachweis', () => {
  const { mergeFabRows, applyJobFabsToAn } = require('./arbeitsnachweis-local');
  it('keeps existing FNs and adds later job FNs', () => {
    const merged = mergeFabRows(
      [{ fabrikationsnummer: '111', type: 'A' }],
      [{ fabrikationsnummer: '222', type: 'B' }],
    );
    assert.deepEqual(merged, [
      { fabrikationsnummer: '111', type: 'A' },
      { fabrikationsnummer: '222', type: 'B' },
    ]);
  });
  it('fills empty snapshot from later job FNs', () => {
    const an = applyJobFabsToAn({ fabrikationsnummern: [] }, [
      { fabrikationsnummer: '12306', type: 'E-DBW' },
    ]);
    assert.equal(an.fabrikationsnummer, '12306');
    assert.equal(an.fabrikationsnummern.length, 1);
    assert.equal(an.equipment_type, 'E-DBW');
  });
  it('fills missing type from later job row', () => {
    const merged = mergeFabRows(
      [{ fabrikationsnummer: '12306', type: '' }],
      [{ fabrikationsnummer: '12306', type: 'E-DBW' }],
    );
    assert.equal(merged[0].type, 'E-DBW');
  });
});
