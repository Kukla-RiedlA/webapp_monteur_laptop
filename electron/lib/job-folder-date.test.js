'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { coerceIsoDatePart, jobFolderDatePart } = require('./job-folder-date');

describe('jobFolderDatePart', () => {
  it('nimmt ISO mit Uhrzeit', () => {
    assert.equal(jobFolderDatePart('2026-09-29 12:00:00', null), '2026-09-29');
    assert.equal(jobFolderDatePart('2026-09-30T10:00:00.000Z', ''), '2026-09-30');
  });

  it('nimmt deutsches Datum mit Uhrzeit (Kalenderanzeige)', () => {
    assert.equal(coerceIsoDatePart('30.09.2026 12:00'), '2026-09-30');
    assert.equal(jobFolderDatePart('30.09.2026 12:00', null), '2026-09-30');
  });

  it('fällt auf das Endedatum zurück, wenn der Beginn fehlt', () => {
    assert.equal(jobFolderDatePart('', '2026-09-29 18:00:00'), '2026-09-29');
    assert.equal(jobFolderDatePart(null, '29.09.2026'), '2026-09-29');
  });

  it('lehnt Platzhalter und unmögliche Tage ab', () => {
    assert.equal(coerceIsoDatePart('0000-00-00 00:00:00'), '');
    assert.equal(coerceIsoDatePart('31.02.2026'), '');
    assert.equal(jobFolderDatePart('0000-00-00', '2026-09-29'), '2026-09-29');
  });
});
