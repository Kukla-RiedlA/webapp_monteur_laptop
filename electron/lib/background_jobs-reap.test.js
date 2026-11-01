'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundJobService, ensureBackgroundJobsSchema } = require('./background_jobs');

function openDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  ensureBackgroundJobsSchema(db);
  return db;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(15);
  }
  throw new Error('Zeitüberschreitung');
}

function utcSql(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

function statusOf(db, id) {
  return db.prepare('SELECT status, error FROM background_jobs WHERE id = ?').get(id);
}

function countStatus(db, status) {
  return db.prepare('SELECT COUNT(*) AS n FROM background_jobs WHERE status = ?').get(status).n;
}

describe('reapStuckJobs speichert nur bei echter Änderung', () => {
  it('lässt einen frischen laufenden Job und ruft save nicht auf', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let saves = 0;
    const svc = createBackgroundJobService(db, () => {
      saves += 1;
    }, {
      executeJob: () => gate,
    });
    const enqueued = svc.enqueue('sync_push', { job_id: 1 }, 'sync_push:fresh');
    await until(() => statusOf(db, enqueued.job_id).status === 'running', 2000);
    saves = 0;
    svc.reapStuckJobs();
    assert.equal(saves, 0);
    assert.equal(statusOf(db, enqueued.job_id).status, 'running');
    release();
    db.close();
  });

  it('beendet einen laufenden Job nach 8 Minuten mit einem save', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let saves = 0;
    const svc = createBackgroundJobService(db, () => {
      saves += 1;
    }, {
      executeJob: () => gate,
    });
    const enqueued = svc.enqueue('sync_push', { job_id: 2 }, 'sync_push:stale');
    await until(() => statusOf(db, enqueued.job_id).status === 'running', 2000);
    db.prepare('UPDATE background_jobs SET updated_at = ? WHERE id = ?').run(utcSql(9 * 60 * 1000), enqueued.job_id);
    saves = 0;
    svc.reapStuckJobs();
    const row = statusOf(db, enqueued.job_id);
    assert.equal(row.status, 'failed');
    assert.match(String(row.error || ''), /Zeitüberschreitung/);
    assert.equal(saves, 1);
    release();
    db.close();
  });

  it('beendet die langsame Phase schon nach 5 Minuten, eine normale Phase nach 6 Minuten nicht', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const releases = [];
    let saves = 0;
    const svc = createBackgroundJobService(db, () => {
      saves += 1;
    }, {
      executeJob: () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    });
    const slow = svc.enqueue('sync_pull', { technicianId: 1 }, 'sync_pull:slow');
    const normal = svc.enqueue('abrechnung_refresh', { technicianId: 1 }, 'abrechnung:normal');
    await until(
      () => statusOf(db, slow.job_id).status === 'running' && statusOf(db, normal.job_id).status === 'running',
      2000,
    );
    const ago = utcSql(6 * 60 * 1000);
    db.prepare('UPDATE background_jobs SET updated_at = ?, progress_phase = ? WHERE id = ?').run(ago, 'refresh', slow.job_id);
    db.prepare('UPDATE background_jobs SET updated_at = ?, progress_phase = ? WHERE id = ?').run(ago, 'files', normal.job_id);
    saves = 0;
    svc.reapStuckJobs();
    assert.equal(statusOf(db, slow.job_id).status, 'failed');
    assert.match(String(statusOf(db, slow.job_id).error || ''), /Zeitüberschreitung/);
    assert.equal(statusOf(db, normal.job_id).status, 'running');
    assert.equal(saves, 1);
    releases.forEach((fn) => fn());
    db.close();
  });

  it('lässt interrupted mit Resume stehen und beendet es nach dem Limit oder zwei Versuchen', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    let saves = 0;
    const svc = createBackgroundJobService(db, () => {
      saves += 1;
    }, {
      executeJob: async () => {},
    });
    const insert = db.prepare(
      `INSERT INTO background_jobs (id, type, status, payload_json, checkpoint_json, updated_at)
       VALUES (?, 'dienstreise_pull', 'interrupted', '{}', ?, ?)`,
    );
    insert.run('keep', JSON.stringify({ completed: ['a.txt'] }), utcSql(60 * 1000));
    saves = 0;
    svc.reapStuckJobs();
    assert.equal(statusOf(db, 'keep').status, 'interrupted');
    assert.equal(saves, 0);

    insert.run('old', JSON.stringify({ completed: ['a.txt'] }), utcSql(9 * 60 * 1000));
    saves = 0;
    svc.reapStuckJobs();
    assert.equal(statusOf(db, 'old').status, 'failed');
    assert.equal(saves, 1);

    insert.run('attempts', JSON.stringify({ recover_attempts: 2 }), utcSql(60 * 1000));
    saves = 0;
    svc.reapStuckJobs();
    assert.equal(statusOf(db, 'attempts').status, 'failed');
    assert.equal(saves, 1);
    db.close();
  });
});

describe('Hintergrund-Jobs bleiben parallel wie bisher', () => {
  it('zieht zwei Aufträge gleichzeitig und hält sync_pull sowie denselben Auftrag exklusiv', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const releases = [];
    const svc = createBackgroundJobService(db, () => {}, {
      executeJob: () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    });
    svc.enqueue('dienstreise_pull', { job_id: 1 }, 'pull:1');
    svc.enqueue('dienstreise_pull', { job_id: 2 }, 'pull:2');
    await until(() => countStatus(db, 'running') === 2, 2000);

    const first = svc.enqueue('sync_pull', { technicianId: 3 }, 'sync_pull:one');
    const second = svc.enqueue('sync_pull', { technicianId: 3 }, 'sync_pull:one');
    assert.equal(second.created, false);
    assert.equal(second.job_id, first.job_id);
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS n FROM background_jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')`,
      ).get('sync_pull:one').n,
      1,
    );

    svc.enqueue('dienstreise_pull', { job_id: 5 }, 'pull:5');
    svc.enqueue('dienstreise_push', { job_id: 5 }, 'push:5');
    await until(() => {
      const pull = db.prepare(`SELECT status FROM background_jobs WHERE dedupe_key = 'pull:5'`).get();
      const push = db.prepare(`SELECT status FROM background_jobs WHERE dedupe_key = 'push:5'`).get();
      return pull && pull.status === 'running' && push && push.status === 'queued';
    }, 2000);

    releases.forEach((fn) => fn());
    db.close();
  });
});
