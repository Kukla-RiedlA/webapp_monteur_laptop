'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureTables, persistTimesheet, loadTimesheet } = require('./zeitschreibung-routes');

function mem() {
  const db = new Database(':memory:');
  ensureTables(db);
  return db;
}

function day(loaded, date) {
  return (loaded.days || []).find((d) => d.day_date === date);
}

describe('persistTimesheet verliert keine Tage', () => {
  it('leeres Payload lässt vorhandene Stunden stehen', () => {
    const db = mem();
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-01', montage: 8.5, bemerkung: 'bleiben' },
    ], 'draft');
    persistTimesheet(db, 14, 2026, 10, [], 'draft');
    const loaded = loadTimesheet(db, 14, 2026, 10);
    const d = day(loaded, '2026-10-01');
    assert.equal(d.montage, 8.5);
    assert.equal(d.bemerkung, 'bleiben');
    assert.ok((loaded.days || []).length >= 28);
  });

  it('fehlender Tag im Payload bleibt erhalten, gesendeter Tag wird aktualisiert', () => {
    const db = mem();
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-01', montage: 8.5 },
      { day_date: '2026-10-02', montage: 4 },
    ], 'draft');
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-02', montage: 6 },
    ], 'draft');
    const loaded = loadTimesheet(db, 14, 2026, 10);
    assert.equal(day(loaded, '2026-10-01').montage, 8.5);
    assert.equal(day(loaded, '2026-10-02').montage, 6);
  });

  it('gesperrter Tag behält lokale Stunden und übernimmt Server-Stunden nur in leere Tage', () => {
    const db = mem();
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-01', montage: 8.5, lohn_gesperrt: 1 },
      { day_date: '2026-10-03', montage: 0, lohn_gesperrt: 0 },
    ], 'draft');
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-01', montage: 0, lohn_gesperrt: 1, korrekturen: {} },
      { day_date: '2026-10-03', montage: 0, weg: 14.5, lohn_gesperrt: 1, korrekturen: {} },
    ], 'draft');
    const loaded = loadTimesheet(db, 14, 2026, 10);
    assert.equal(day(loaded, '2026-10-01').montage, 8.5);
    assert.equal(day(loaded, '2026-10-01').lohn_gesperrt, 1);
    assert.equal(day(loaded, '2026-10-03').weg, 14.5);
    assert.equal(day(loaded, '2026-10-03').lohn_gesperrt, 1);
  });

  it('Fehler beim Schreiben rollt die Löschung zurück', () => {
    const db = mem();
    persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-01', montage: 8.5, bemerkung: 'bleiben' },
    ], 'draft');
    const original = db.prepare.bind(db);
    db.prepare = function (sql) {
      const stmt = original(sql);
      if (String(sql).startsWith('INSERT INTO timesheet_days')) {
        const run = stmt.run.bind(stmt);
        stmt.run = function () {
          throw new Error('insert kaputt');
        };
        stmt.run._orig = run;
      }
      return stmt;
    };
    assert.throws(() => {
      persistTimesheet(db, 14, 2026, 10, [
        { day_date: '2026-10-01', montage: 1 },
      ], 'draft');
    }, /insert kaputt/);
    db.prepare = original;
    const loaded = loadTimesheet(db, 14, 2026, 10);
    assert.equal(day(loaded, '2026-10-01').montage, 8.5);
    assert.equal(day(loaded, '2026-10-01').bemerkung, 'bleiben');
  });

  it('db-compat-Transaktion (sofort ausführen, undefined) speichert ohne writeAll-Fehler', () => {
    const raw = mem();
    const db = {
      exec(sql) { raw.exec(sql); },
      prepare(sql) {
        const stmt = raw.prepare(sql);
        return {
          run(...params) { return stmt.run(...params); },
          get(...params) { return stmt.get(...params); },
          all(...params) { return stmt.all(...params); },
        };
      },
      transaction(fn) {
        raw.transaction(fn)();
      },
    };
    const saved = persistTimesheet(db, 14, 2026, 10, [
      { day_date: '2026-10-05', montage: 7.5, bemerkung: 'compat' },
    ], 'submitted');
    assert.equal(saved.status, 'submitted');
    const loaded = loadTimesheet(db, 14, 2026, 10);
    assert.equal(day(loaded, '2026-10-05').montage, 7.5);
    assert.equal(day(loaded, '2026-10-05').bemerkung, 'compat');
    assert.equal(loaded.status, 'submitted');
  });
});
