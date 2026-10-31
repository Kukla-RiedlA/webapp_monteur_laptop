'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessProtocolPdf,
  contentHash,
  gapReason,
} = require('./protocol-pdf-freshness');

const NOW = Date.parse('2026-10-31T12:00:00');

function filled(extra) {
  return Object.assign({ projekt: 'Werk Nord', durchfuehrungsdatum: '2026-10-31' }, extra || {});
}

describe('protocol-pdf-freshness', () => {
  it('leerer Entwurf zählt nicht', () => {
    assert.equal(assessProtocolPdf({ draft: { languages: ['de'], updated_at: '2026-10-31T12:00:00' } }), null);
    assert.equal(assessProtocolPdf({ draft: {} }), null);
  });

  it('fehlendes PDF', () => {
    const result = assessProtocolPdf({
      kind: 'serviceprotokoll',
      draft: filled(),
      pdfs: [],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'missing');
    assert.equal(result.reason, 'kein PDF');
    assert.equal(gapReason(result), 'kein PDF');
  });

  it('PDF älter als die letzte Formularänderung', () => {
    const result = assessProtocolPdf({
      kind: 'montagebericht',
      draft: filled({ languages: ['de'] }),
      pdfs: [{ lang: 'de', exists: true, mtimeMs: NOW - 60 * 60 * 1000 }],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'stale');
    assert.equal(result.reason, 'Formular danach geändert');
  });

  it('PDF aus demselben Speichervorgang gilt als aktuell', () => {
    const result = assessProtocolPdf({
      kind: 'serviceprotokoll',
      draft: filled(),
      pdfs: [{ lang: 'de', exists: true, mtimeMs: NOW - 4000 }],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'current');
  });

  it('gespeicherter Inhaltshash macht ein älteres PDF aktuell', () => {
    const draft = filled({ pdf_content_hash: '' });
    const hash = contentHash(draft);
    draft.pdf_content_hash = hash;
    const result = assessProtocolPdf({
      kind: 'kontrollwiegung',
      draft,
      pdfs: [{ lang: 'de', exists: true, mtimeMs: NOW - 24 * 60 * 60 * 1000 }],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'current');
  });

  it('abweichender Inhaltshash ist veraltet', () => {
    const draft = filled({ pdf_content_hash: 'alt' });
    const result = assessProtocolPdf({
      kind: 'pruefzertifikat',
      draft,
      pdfs: [{ lang: 'de', exists: true, mtimeMs: NOW }],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'stale');
  });

  it('zweite Sprache fehlt', () => {
    const result = assessProtocolPdf({
      kind: 'inbetriebnahme',
      draft: filled({ languages: ['de', 'en'] }),
      pdfs: [{ lang: 'de', exists: true, mtimeMs: NOW }],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'missing');
    assert.match(result.reason, /kein PDF/);
    assert.match(result.reason, /EN/);
  });

  it('Hash ignoriert Zeitstempel und PDF-Pfade', () => {
    const a = contentHash({ projekt: 'A', updated_at: '1', last_pdf_rel: 'a.pdf', pdf_content_hash: 'x' });
    const b = contentHash({ pdf_paths: ['b.pdf'], updated_at: '2', projekt: 'A' });
    const c = contentHash({ projekt: 'B', updated_at: '1' });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('Art ohne PDF-Schreiber bleibt in der Rückfrage', () => {
    const result = assessProtocolPdf({
      kind: 'spaeteres_protokoll',
      draft: filled(),
      pdfs: [],
      formUpdatedMs: NOW,
    });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'PDF-Erzeugung für diese Art fehlt');
  });
});
