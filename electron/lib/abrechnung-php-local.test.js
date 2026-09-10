'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const phpLocal = require('./abrechnung-php-local');

function readCommentsFromRow(row) {
  if (!row || !row.comments_json) return { dispo: [], buchhaltung: [] };
  const j = JSON.parse(row.comments_json);
  return {
    dispo: Array.isArray(j.dispo) ? j.dispo : [],
    buchhaltung: Array.isArray(j.buchhaltung) ? j.buchhaltung : [],
  };
}

function makeCacheDb(rows) {
  const store = rows.map((r) => Object.assign({}, r));
  return {
    store,
    prepare(sql) {
      const s = String(sql);
      if (/FROM abrechnung_notes_cache WHERE job_server_id/.test(s)) {
        return {
          get(id) {
            return store.find((r) => Number(r.job_server_id) === Number(id));
          },
        };
      }
      if (/FROM abrechnung_notes_cache/.test(s)) {
        return { all() { return store; } };
      }
      throw new Error('unerwartetes SQL: ' + s);
    },
  };
}

function writeCommentsCache(_db, jobId, comments) {
  const row = _db.store.find((r) => Number(r.job_server_id) === Number(jobId));
  if (row) row.comments_json = JSON.stringify(comments);
}

describe('Abrechnung-Kommentar-Cache', () => {
  it('findet und ändert einen Kommentar auch ohne job_id', () => {
    const db = makeCacheDb([
      {
        job_server_id: 42,
        comments_json: JSON.stringify({
          dispo: [{ id: 17, body: 'alt', can_edit: true }],
          buchhaltung: [],
        }),
      },
    ]);
    const found = phpLocal.findCommentInNotesCache(db, readCommentsFromRow, 17);
    assert.equal(found && found.jobServerId, 42);
    const res = phpLocal.updateCommentInCache(
      db,
      null,
      readCommentsFromRow,
      writeCommentsCache,
      0,
      17,
      'neu',
    );
    assert.equal(res.ok, true);
    assert.equal(res.job_id, 42);
    const after = JSON.parse(db.store[0].comments_json);
    assert.equal(after.dispo[0].body, 'neu');
  });

  it('liefert 404 wenn der Kommentar in keinem Cache liegt', () => {
    const db = makeCacheDb([{ job_server_id: 1, comments_json: '{"dispo":[],"buchhaltung":[]}' }]);
    const res = phpLocal.updateCommentInCache(
      db,
      null,
      readCommentsFromRow,
      writeCommentsCache,
      0,
      99,
      'x',
    );
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  });
});

describe('Kommentar-Edit sendet job_id', () => {
  it('FormData für Edit und Delete enthält job_id', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'assets', 'js', 'dispo', 'job_subfolder_docs.js'),
      'utf8',
    );
    assert.match(src, /fdEdit\.append\('job_id'/);
    assert.match(src, /fd2\.append\('job_id'/);
  });
});

describe('Beleg-Dateinamen', () => {
  const opts = { date: '2026-09-11', time: '14-30-05' };

  it('setzt Prefix_Datum_Original', () => {
    assert.equal(
      phpLocal.applyBelegPrefix('Knauf UK Bestellnummer 4505535068.pdf', 'Transport', opts),
      'Transport_2026-09-11_Knauf UK Bestellnummer 4505535068.pdf',
    );
  });

  it('streift bekanntes Prefix und Datum ab', () => {
    assert.equal(
      phpLocal.applyBelegPrefix('Hotel_2026-09-02_rechnung.pdf', 'Transport', opts),
      'Transport_2026-09-11_rechnung.pdf',
    );
  });

  it('Scan-Fallback ohne Username', () => {
    assert.equal(
      phpLocal.applyBelegPrefix('scan.pdf', 'Hotel', { ...opts, scan: true }),
      'Hotel_2026-09-11_14-30-05.pdf',
    );
  });

  it('Kollision hängt -1 an', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kukla-beleg-'));
    const first = phpLocal.applyBelegPrefix('rechnung.pdf', 'Angebot', opts);
    fs.writeFileSync(path.join(dir, first), 'x');
    const second = phpLocal.resolveUniqueStoredName('rechnung.pdf', 'Angebot', dir, opts);
    assert.equal(second, 'Angebot_2026-09-11_rechnung-1.pdf');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
