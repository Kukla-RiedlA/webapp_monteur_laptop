'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBackgroundJobService, ensureBackgroundJobsSchema } = require('./background_jobs');
const { registerMultiDeviceRoutes } = require('./multi-device-routes');
const { DRAFT_JSON_ENDPOINTS } = require('./multi-device-sync');
const protocolDrafts = require('./protocol-drafts-local');

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

describe('dienstreise_push follow-up', () => {
  it('enqueues one follow-up after a running push finishes', async (t) => {
    let db;
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let runs = 0;
    const svc = createBackgroundJobService(db, () => {}, {
      executeJob: async () => {
        runs += 1;
        if (runs === 1) await firstGate;
      },
    });
    svc.enqueue('dienstreise_push', { job_id: 7 }, 'dienstreise_push:7');
    await until(() => db.prepare(`SELECT COUNT(*) AS n FROM background_jobs WHERE status = 'running'`).get().n === 1, 2000);
    const second = svc.enqueue('dienstreise_push', { job_id: 7, onlyChanged: true }, 'dienstreise_push:7');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n, 1);
    assert.equal(second.job_id, db.prepare(`SELECT id FROM background_jobs`).get().id);
    releaseFirst();
    await until(() => db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get().n === 2, 2000);
    await until(
      () => db.prepare(`SELECT COUNT(*) AS n FROM background_jobs WHERE status = 'completed'`).get().n === 2,
      2000,
    );
    db.close();
  });
});

describe('blocking conflicts', () => {
  it('ack and startup leave a blocking conflict in place', async (t) => {
    let db;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-conflict-'));
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const routes = {};
    const app = {
      get(routePath, ...handlers) {
        routes['GET ' + routePath] = handlers[handlers.length - 1];
      },
      post(routePath, ...handlers) {
        routes['POST ' + routePath] = handlers[handlers.length - 1];
      },
    };
    registerMultiDeviceRoutes({
      app,
      db,
      DB_DIR: dir,
      save() {},
      fetchWithTimeout: async () => ({ ok: false, json: async () => ({}) }),
      getTechnicianId: () => 1,
    });
    db.prepare(
      `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
       VALUES (4, 9, 'serviceprotokoll.json', ?)`,
    ).run(JSON.stringify({ blocking: true, kind: 'draft', summary: 'serviceprotokoll' }));
    db.prepare(
      `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
       VALUES (4, 9, 'alt.txt', ?)`,
    ).run(JSON.stringify({ kept: 'local' }));
    const blockingId = db.prepare(`SELECT id FROM multi_device_conflicts WHERE rel_path = 'serviceprotokoll.json'`).get().id;
    const oldId = db.prepare(`SELECT id FROM multi_device_conflicts WHERE rel_path = 'alt.txt'`).get().id;

    const resAck = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    routes['POST /api/multi_device/conflicts/ack']({ body: {}, query: {} }, resAck);
    assert.equal(resAck.body.ok, true);
    assert.equal(db.prepare('SELECT id FROM multi_device_conflicts WHERE id = ?').get(blockingId).id, blockingId);
    assert.equal(db.prepare('SELECT id FROM multi_device_conflicts WHERE id = ?').get(oldId), undefined);

    const resOne = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    routes['POST /api/multi_device/conflicts/ack']({ body: { id: blockingId }, query: {} }, resOne);
    assert.equal(resOne.body.kept, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 1);

    registerMultiDeviceRoutes({
      app,
      db,
      DB_DIR: dir,
      save() {},
      fetchWithTimeout: async () => ({ ok: false, json: async () => ({}) }),
      getTechnicianId: () => 1,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('diff returns field rows for a draft and rejects a path outside the conflict folder', async (t) => {
    let db;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-conflict-diff-'));
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const routes = {};
    const app = {
      get(routePath, ...handlers) {
        routes['GET ' + routePath] = handlers[handlers.length - 1];
      },
      post(routePath, ...handlers) {
        routes['POST ' + routePath] = handlers[handlers.length - 1];
      },
    };
    registerMultiDeviceRoutes({
      app,
      db,
      DB_DIR: dir,
      save() {},
      fetchWithTimeout: async () => ({ ok: false, json: async () => ({}) }),
      getTechnicianId: () => 1,
    });
    const remoteFile = path.join(dir, 'protocol-conflicts', '4_montagebericht.json.json');
    fs.mkdirSync(path.dirname(remoteFile), { recursive: true });
    fs.writeFileSync(
      remoteFile,
      JSON.stringify({
        grundDesEinsatzes: 'Austausch',
        grundDesEinsatzes_html: '<p>Austausch</p>',
        fabBemerkungen: [{ fabrikationsnummer: '9500', bemerkungen: 'anderer Laptop' }],
      }),
    );
    protocolDrafts.writeDraft(
      db,
      4,
      'montagebericht.json',
      {
        grundDesEinsatzes: 'Wartung',
        grundDesEinsatzes_html: '<p>Wartung</p>',
        fabBemerkungen: [{ fabrikationsnummer: '9500', bemerkungen: 'dieser Laptop' }],
      },
      2,
      '2026-10-19 09:00:00',
      '',
    );
    const info = db
      .prepare(
        `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
         VALUES (4, 9, 'montagebericht.json', ?)`,
      )
      .run(
        JSON.stringify({
          blocking: true,
          kind: 'draft',
          basename: 'montagebericht.json',
          summary: 'montagebericht',
          remote_at: '2026-10-08 11:22:29',
          remote_file: remoteFile,
        }),
      );
    const resDiff = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    routes['POST /api/multi_device/conflicts/diff']({ body: { id: info.lastInsertRowid }, query: {} }, resDiff);
    assert.equal(resDiff.body.ok, true);
    assert.equal(resDiff.body.remote_at, '2026-10-08 11:22:29');
    assert.ok(resDiff.body.rows.some((row) => row.label === 'Grund des Einsatzes' && row.local === 'Wartung' && row.remote === 'Austausch'));
    assert.ok(resDiff.body.rows.some((row) => row.group === 'FN 9500' && row.local === 'dieser Laptop'));

    const outside = db
      .prepare(
        `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
         VALUES (4, 9, 'montagebericht.json', ?)`,
      )
      .run(JSON.stringify({ kind: 'draft', basename: 'montagebericht.json', remote_file: path.join(dir, 'secret.json') }));
    const resDenied = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    routes['POST /api/multi_device/conflicts/diff']({ body: { id: outside.lastInsertRowid }, query: {} }, resDenied);
    assert.equal(resDenied.statusCode, 404);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not recreate a montagebericht conflict after the same remote stand was chosen', async (t) => {
    let db;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-conflict-resolve-'));
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    const localPayload = {
      grundDesEinsatzes: 'Wartung',
      grundDesEinsatzes_html: '<p>Wartung</p>',
      fabBemerkungen: [{ fabrikationsnummer: '9500', bemerkungen: 'dieser Laptop' }],
    };
    let remoteStore = {
      grundDesEinsatzes: 'Austausch',
      grundDesEinsatzes_html: '<p>Austausch</p>',
      fabBemerkungen: [{ fabrikationsnummer: '9500', bemerkungen: 'anderer Laptop' }],
    };
    const routes = {};
    const app = {
      get(routePath, ...handlers) {
        routes['GET ' + routePath] = handlers[handlers.length - 1];
      },
      post(routePath, ...handlers) {
        routes['POST ' + routePath] = handlers[handlers.length - 1];
      },
    };
    const api = registerMultiDeviceRoutes({
      app,
      db,
      DB_DIR: dir,
      save() {},
      fetchWithTimeout: async (_url, options) => {
        const method = String((options && options.method) || 'GET').toUpperCase();
        if (method === 'POST') {
          return {
            ok: false,
            status: 409,
            statusText: 'Conflict',
            json: async () => ({ ok: false, code: 'job_closed', error: 'Auftrag ist abgeschlossen' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            revision: 4,
            server_updated_at: '2026-10-08 11:22:29',
            store: remoteStore,
          }),
        };
      },
      getTechnicianId: () => 1,
    });
    protocolDrafts.writeDraft(db, 4, 'montagebericht.json', localPayload, 2, '2026-10-19 09:00:00', '');
    const pullOpts = {
      dispoBaseUrl: 'https://dispo.example',
      endpoint: DRAFT_JSON_ENDPOINTS['montagebericht.json'],
      technicianId: 1,
      serverJobId: 9,
      localJobId: 4,
      basename: 'montagebericht.json',
      username: 'monteur',
      password: 'geheim',
    };
    const first = await api.pullJsonDraft(pullOpts);
    assert.equal(first.conflict, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 1);
    const conflictId = db.prepare('SELECT id FROM multi_device_conflicts').get().id;
    const resKeep = {
      statusCode: 200,
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    await routes['POST /api/multi_device/conflicts/resolve'](
      {
        body: {
          id: conflictId,
          choice: 'local',
          dispoBaseUrl: 'https://dispo.example',
          dispoUsername: 'monteur',
          dispoPassword: 'geheim',
        },
        query: {},
      },
      resKeep,
    );
    assert.equal(resKeep.statusCode, 200);
    assert.equal(resKeep.body.ok, true);
    assert.equal(resKeep.body.choice, 'local');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflict_resolutions').get().n, 1);

    const again = await api.pullJsonDraft(pullOpts);
    assert.equal(again.resolved, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 0);
    const kept = protocolDrafts.readDraft(db, 4, 'montagebericht.json', '');
    assert.equal(kept.payload.grundDesEinsatzes, 'Wartung');

    remoteStore = {
      grundDesEinsatzes: 'Neubau',
      grundDesEinsatzes_html: '<p>Neubau</p>',
      fabBemerkungen: [{ fabrikationsnummer: '9500', bemerkungen: 'neuer Stand' }],
    };
    const changed = await api.pullJsonDraft(pullOpts);
    assert.equal(changed.conflict, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies the other laptop onto a frozen montagebericht and does not ask again', async (t) => {
    let db;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-conflict-frozen-'));
    try {
      db = openDb();
    } catch (e) {
      t.skip('better-sqlite3 nicht ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT)');
    db.prepare(`INSERT INTO jobs (id, status) VALUES (4, 'erledigt')`).run();
    protocolDrafts.writeDraft(
      db,
      4,
      'montagebericht.json',
      { grundDesEinsatzes: 'Wartung' },
      2,
      '2026-10-19 09:00:00',
      '',
    );
    const remoteFile = path.join(dir, 'protocol-conflicts', '4_montagebericht.json.json');
    fs.mkdirSync(path.dirname(remoteFile), { recursive: true });
    fs.writeFileSync(remoteFile, JSON.stringify({ grundDesEinsatzes: 'Austausch' }));
    const routes = {};
    const app = {
      get(routePath, ...handlers) {
        routes['GET ' + routePath] = handlers[handlers.length - 1];
      },
      post(routePath, ...handlers) {
        routes['POST ' + routePath] = handlers[handlers.length - 1];
      },
    };
    const api = registerMultiDeviceRoutes({
      app,
      db,
      DB_DIR: dir,
      save() {},
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          revision: 4,
          server_updated_at: '2026-10-08 11:22:29',
          store: { grundDesEinsatzes: 'Austausch' },
        }),
      }),
      getTechnicianId: () => 1,
    });
    const info = db
      .prepare(
        `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
         VALUES (4, 9, 'montagebericht.json', ?)`,
      )
      .run(
        JSON.stringify({
          blocking: true,
          kind: 'draft',
          basename: 'montagebericht.json',
          summary: 'montagebericht',
          remote_revision: 4,
          remote_at: '2026-10-08 11:22:29',
          remote_file: remoteFile,
        }),
      );
    const resTake = {
      statusCode: 200,
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    await routes['POST /api/multi_device/conflicts/resolve'](
      { body: { id: info.lastInsertRowid, choice: 'remote' }, query: {} },
      resTake,
    );
    assert.equal(resTake.body.ok, true);
    const taken = protocolDrafts.readDraft(db, 4, 'montagebericht.json', '');
    assert.equal(taken.payload.grundDesEinsatzes, 'Austausch');
    const again = await api.pullJsonDraft({
      dispoBaseUrl: 'https://dispo.example',
      endpoint: DRAFT_JSON_ENDPOINTS['montagebericht.json'],
      technicianId: 1,
      serverJobId: 9,
      localJobId: 4,
      basename: 'montagebericht.json',
      username: 'monteur',
      password: 'geheim',
    });
    assert.notEqual(again.conflict, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_device_conflicts').get().n, 0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
