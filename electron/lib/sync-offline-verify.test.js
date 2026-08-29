'use strict';

/**
 * Prüfmethode Offline-JSON/PDF-Sync (Last-Write-Wins).
 * Aus electron/:  node --test lib/sync-lww.test.js lib/sync-offline-verify.test.js
 * oder:           npm run test:sync-offline
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HANDLED_PENDING_ENTITY_TYPES,
  isHandledPendingEntityType,
  isLocalFresher,
  evaluateJobPullRemovalGuard,
  wantsLocalOnlyRequest,
} = require('./local_first');
const {
  MONTEUR_DRAFT_BASENAMES,
  DRAFT_JSON_ENDPOINTS,
  mergeByFabStores,
  isEmptyMonteurDraftPayload,
  pruneEmptyMonteurDraftJsons,
  writeLocalDraftFile,
  readLocalDraftFile,
  writePayloadConflictCopy,
  isMonteurDraftJsonBasename,
} = require('./multi-device-sync');
const { registerMultiDeviceRoutes } = require('./multi-device-routes');
const protocolDrafts = require('./protocol-drafts-local');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');

function jsonResponse(body, status) {
  const st = status != null ? status : 200;
  return {
    ok: st >= 200 && st < 300,
    status: st,
    statusText: st === 200 ? 'OK' : 'ERR',
    json: async () => body,
  };
}

function capturingDb() {
  const inserts = [];
  return {
    inserts,
    exec() {},
    prepare(sql) {
      const s = String(sql || '');
      return {
        run(...args) {
          if (/INSERT INTO pending_changes\b/i.test(s)) {
            inserts.push({ sql: s, args: args.slice() });
          }
          return { changes: 1 };
        },
        get() {
          return undefined;
        },
        all() {
          return [];
        },
      };
    },
  };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

function createDraftApi(opts) {
  const o = opts || {};
  const db = o.db || capturingDb();
  const dbDir = o.dbDir || tmpDir('kukla-sync-verify-');
  let fetchImpl =
    o.fetchImpl ||
    (async () => jsonResponse({ ok: true, store: { byFab: {} }, revision: 0 }));
  const api = registerMultiDeviceRoutes({
    app: { post() {}, get() {} },
    db,
    DB_DIR: dbDir,
    save() {},
    fetchWithTimeout: (...args) => fetchImpl(...args),
    getTechnicianId: () => 7,
    resolveDienstreiseReiseDirForJob: () => dbDir,
    cleanupDienstreiseReiseDir() {},
    listProtectedPaths: () => [],
    bgJobs: null,
    getBgJobs: () => null,
    getAppVersion: () => 'test',
  });
  return {
    api,
    db,
    dbDir,
    setFetch(fn) {
      fetchImpl = fn;
    },
    close() {
      rmDir(dbDir);
    },
  };
}

describe('Verdrahtung server.js (alle Sync-Stellen)', () => {
  it('jeder HANDLED-Typ hat einen pushToServer-Zweig', () => {
    for (const type of HANDLED_PENDING_ENTITY_TYPES) {
      assert.match(
        serverSrc,
        new RegExp("p\\.entity_type === '" + type + "'"),
        'pushToServer fehlt für ' + type,
      );
    }
  });

  it('queueDispoProxyPending-Typen sind Teilmenge der Handler', () => {
    const queued = new Set();
    const re = /queueDispoProxyPending\(\s*(?:db(?:Conn)?\s*,\s*)?'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(serverSrc))) queued.add(m[1]);
    assert.ok(queued.has('schleppketten'));
    assert.ok(queued.has('pruefzertifikat'));
    assert.ok(queued.has('kontrollwiegung'));
    assert.ok(queued.has('serviceprotokoll'));
    for (const type of queued) {
      assert.equal(
        isHandledPendingEntityType(type),
        true,
        'Queue ohne Handler: ' + type,
      );
    }
  });

  it('queueProtocolDraftAndFiles für alle fünf Draft-JSONs', () => {
    for (const basename of MONTEUR_DRAFT_BASENAMES) {
      assert.ok(
        serverSrc.includes("basename: '" + basename + "'"),
        'queueProtocolDraftAndFiles fehlt für ' + basename,
      );
    }
  });

  it('Datei-Push nutzt mtime/Größe und Cache nur nach Upload', () => {
    const batch = serverSrc.slice(
      serverSrc.indexOf('async function pushFileBatch'),
      serverSrc.indexOf('if (onlyChanged)'),
    );
    assert.ok(batch.includes('localDienstreiseFileNeedsDispoPush'));
    assert.ok(batch.includes('uploadJobProjectFileToDispo'));
    assert.ok(batch.includes('recordDienstreisePushCache'));
    assert.ok(batch.includes('continue;'));
    const skipThenCache = /!needsPush\)[\s\S]{0,80}continue;[\s\S]{0,40}recordDienstreisePushCache/;
    assert.equal(
      skipThenCache.test(batch),
      false,
      'Skip darf den Push-Cache nicht setzen',
    );
  });

  it('mtime-Scan bleibt gleich, gibt aber den Event-Loop frei', () => {
    assert.ok(serverSrc.includes('async function collectChangedDienstreiseSyncFileEntries'));
    assert.ok(serverSrc.includes('await collectChangedDienstreiseSyncFileEntries'));
    assert.ok(serverSrc.includes('await yieldEventLoop()'));
    assert.ok(serverSrc.includes('localDienstreiseFileNeedsDispoPush(dbConn, localJobId, f.relPathFromRoot, f.fullPath)'));
  });

  it('Finish-Verify lädt geänderte Dateien nach, nicht nur fehlende Namen', () => {
    assert.ok(serverSrc.includes('localDienstreiseFileNeedsDispoPush(db, localJobId, p, full)'));
  });

  it('Dispo-PDF-Download überschreibt vorhandene lokale PDF nicht', () => {
    assert.ok(serverSrc.includes('function keepExistingLocalPdf'));
    assert.ok(serverSrc.includes('if (keepExistingLocalPdf(fullLocalPdf))'));
    assert.ok(serverSrc.includes('if (!keepExistingLocalPdf(localPdfFull))'));
  });

  it('Wieder-Online: Push vor JSON-Pull', () => {
    const pullIdx = serverSrc.indexOf("case 'dienstreise_pull'");
    const pushFn = serverSrc.indexOf('async function pushLocalChangesBeforePull', pullIdx);
    const callPush = serverSrc.indexOf('await pushLocalChangesBeforePull()', pullIdx);
    const callDrafts = serverSrc.indexOf('await pullProtocolJsonDrafts()', pullIdx);
    assert.ok(pushFn > 0 && callPush > pushFn);
    assert.ok(callDrafts > callPush, 'JSON-Pull muss nach Push-first kommen');
  });

  it('sync_pull queued geänderte Dateien vor Delta-Pull', () => {
    const syncIdx = serverSrc.indexOf("case 'sync_pull'");
    const changed = serverSrc.indexOf('enqueueDienstreisePushChanged', syncIdx);
    const delta = serverSrc.indexOf('enqueuePeriodicDienstreiseDeltaPulls', syncIdx);
    assert.ok(changed > syncIdx);
    assert.ok(delta > changed);
  });

  it('dienstreise_push verwendet onlyChanged', () => {
    const idx = serverSrc.indexOf("case 'dienstreise_push'");
    const chunk = serverSrc.slice(idx, idx + 900);
    assert.ok(chunk.includes('onlyChanged: p.onlyChanged !== false'));
  });

  it('Dead-Letter Schleppkette/Prüfzertifikat/protocol_draft wird requeued', () => {
    assert.ok(
      /requeueFailedPendingByTypes\([^)]*schleppketten[^)]*pruefzertifikat[^)]*protocol_draft/.test(
        serverSrc,
      ),
    );
  });
});

describe('Draft-APIs und Datenverlust-Schutz', () => {
  it('jeder Draft-Basename hat einen Dispo-Endpunkt', () => {
    for (const basename of MONTEUR_DRAFT_BASENAMES) {
      assert.ok(DRAFT_JSON_ENDPOINTS[basename], 'Endpoint fehlt: ' + basename);
      assert.ok(isMonteurDraftJsonBasename(basename));
    }
  });

  it('pruneEmpty löscht nur leere Payload, nie Inhalt', () => {
    const dir = tmpDir('kukla-prune-');
    const monteur = path.join(dir, 'Dokumente_Monteur');
    fs.mkdirSync(monteur, { recursive: true });
    const emptyPath = path.join(monteur, 'montagebericht.json');
    const fullPath = path.join(monteur, 'serviceprotokoll.json');
    fs.writeFileSync(emptyPath, JSON.stringify({ byFab: {}, revision: 0 }), 'utf8');
    fs.writeFileSync(
      fullPath,
      JSON.stringify({ byFab: { FN1: { bemerkungen: 'bleibt' } } }, null, 2),
      'utf8',
    );
    const removed = pruneEmptyMonteurDraftJsons(dir);
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(emptyPath), false);
    assert.equal(fs.existsSync(fullPath), true);
    rmDir(dir);
  });

  it('isEmptyMonteurDraftPayload erkennt Inhalt', () => {
    assert.equal(isEmptyMonteurDraftPayload({}), true);
    assert.equal(isEmptyMonteurDraftPayload({ byFab: {} }), true);
    assert.equal(isEmptyMonteurDraftPayload({ byFab: { A: { x: 1 } } }), false);
    assert.equal(isEmptyMonteurDraftPayload({ grundDesEinsatzes: 'x' }), false);
  });

  it('Conflict-Copy erhält den lokalen Stand zusätzlich', () => {
    const dir = tmpDir('kukla-conflict-');
    const filePath = path.join(dir, 'Dokumente_Monteur', 'serviceprotokoll.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { byFab: { A: { v: 'lokal' } } };
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    const copy = writePayloadConflictCopy(filePath, payload, 'testdevice');
    assert.ok(copy && fs.existsSync(copy));
    assert.equal(fs.existsSync(filePath), true);
    assert.ok(path.basename(copy).includes('.conflict-'));
    rmDir(dir);
  });

  it('byFab-Merge behält FN nur lokal und nur remote', () => {
    const merged = mergeByFabStores(
      { byFab: { LOKAL: { updated_at: '2026-08-26T18:00:00Z', t: 'l' } } },
      { byFab: { REMOTE: { updated_at: '2026-08-26T18:00:00Z', t: 'r' } } },
    );
    assert.ok(merged.payload.byFab.LOKAL);
    assert.ok(merged.payload.byFab.REMOTE);
  });

  it('Job-Pull-Guard löscht bei leerer API-Antwort nicht', () => {
    const g = evaluateJobPullRemovalGuard(5, 0);
    assert.equal(g.skipRemoval, true);
  });

  it('skipDispo / local_only wird erkannt', () => {
    assert.equal(wantsLocalOnlyRequest({ skip_dispo_sync: true }), true);
    assert.equal(wantsLocalOnlyRequest({ local_only: 1 }), true);
    assert.equal(wantsLocalOnlyRequest({}), false);
  });
});

describe('pullJsonDraft Last-Write-Wins (simuliertes Dispo)', () => {
  let harness;
  let reiseDir;

  before(() => {
    harness = createDraftApi();
    reiseDir = tmpDir('kukla-draft-pull-');
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur'), { recursive: true });
  });

  after(() => {
    if (harness) harness.close();
    rmDir(reiseDir);
  });

  function filePath(basename) {
    return path.join(reiseDir, 'Dokumente_Monteur', basename);
  }

  async function pull(basename, remoteBody) {
    harness.setFetch(async () => jsonResponse(remoteBody));
    return harness.api.pullJsonDraft({
      dispoBaseUrl: 'https://dispo.test',
      endpoint: DRAFT_JSON_ENDPOINTS[basename],
      technicianId: 7,
      serverJobId: 99,
      reiseDir,
      basename,
      filePath: filePath(basename),
      username: 'u',
      password: 'p',
    });
  }

  it('überschreibt lokal neueren Service-JSON nicht, meldet local_newer', async () => {
    const basename = 'serviceprotokoll.json';
    writeLocalDraftFile(
      filePath(basename),
      { byFab: { FN1: { bemerkungen: 'offline-neu', updated_at: '2026-08-26T20:00:00Z' } } },
      1,
      '2026-08-20T10:00:00Z',
    );
    const result = await pull(basename, {
      ok: true,
      revision: 9,
      server_updated_at: '2026-08-20T10:00:00Z',
      store: { byFab: { FN1: { bemerkungen: 'online-alt', updated_at: '2026-08-20T10:00:00Z' } } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.local_newer, true);
    assert.equal(result.skipped, true);
    const local = readLocalDraftFile(filePath(basename));
    assert.equal(local.payload.byFab.FN1.bemerkungen, 'offline-neu');
  });

  it('leeres Remote löscht lokalen Inhalt nicht', async () => {
    const basename = 'montagebericht.json';
    writeLocalDraftFile(filePath(basename), { grundDesEinsatzes: 'bleibt' }, 2, '2026-08-26T12:00:00Z');
    const result = await pull(basename, {
      ok: true,
      revision: 3,
      server_updated_at: '2026-08-26T08:00:00Z',
      store: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.local_newer, true);
    assert.equal(result.empty_remote, true);
    const local = readLocalDraftFile(filePath(basename));
    assert.equal(local.payload.grundDesEinsatzes, 'bleibt');
  });

  it('Remote neuer: Conflict-Copy + Merge, lokale Extra-FN bleibt', async () => {
    const basename = 'kontrollwiegungsprotokoll.json';
    const p = filePath(basename);
    writeLocalDraftFile(
      p,
      {
        byFab: {
          ALT: { v: 'lokal-alt', updated_at: '2026-08-01T00:00:00Z' },
          NURLOKAL: { v: 'nur-laptop', updated_at: '2026-08-26T12:00:00Z' },
        },
      },
      1,
      '2026-08-01T00:00:00Z',
    );
    const old = new Date('2026-08-01T00:00:00Z').getTime() / 1000;
    fs.utimesSync(p, old, old);
    const result = await pull(basename, {
      ok: true,
      revision: 4,
      server_updated_at: '2026-08-26T21:00:00Z',
      store: {
        byFab: {
          ALT: { v: 'remote-neu', updated_at: '2026-08-26T21:00:00Z' },
        },
      },
    });
    assert.equal(result.ok, true);
    const local = readLocalDraftFile(p);
    assert.equal(local.payload.byFab.ALT.v, 'remote-neu');
    assert.equal(local.payload.byFab.NURLOKAL.v, 'nur-laptop');
    const conflict = fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.conflict-'));
    assert.ok(conflict.length >= 1, 'Conflict-Copy der lokalen Version fehlt');
  });

  it('Remote ohne Zeitstempel: lokale Datei bleibt (nicht Remote-only)', async () => {
    const basename = 'schleppkettenprotokoll.json';
    writeLocalDraftFile(filePath(basename), { byFab: { K: { v: 'unsicher-lokal' } } }, 1, null);
    const p = filePath(basename);
    // mtime entfernen, indem wir server_updated_at und Datei-mtime unbrauchbar machen:
    // readLocalDraftFile nutzt Datei-mtime — daher utimes auf Epoch, remote ohne Stempel.
    fs.utimesSync(p, 0, 0);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete raw.server_updated_at;
    fs.writeFileSync(p, JSON.stringify(raw), 'utf8');
    fs.utimesSync(p, 0, 0);
    const result = await pull(basename, {
      ok: true,
      revision: 8,
      server_updated_at: null,
      store: { byFab: { K: { v: 'remote-ohne-ts' } } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    const local = readLocalDraftFile(p);
    assert.equal(local.payload.byFab.K.v, 'unsicher-lokal');
  });

  it('pushJsonDraft bei Offline queued (queued:true) und protocol_draft-INSERT', async () => {
    const basename = 'pruefzertifikat.json';
    writeLocalDraftFile(filePath(basename), { byFab: { Z: { v: 'offline' } } }, 1, '2026-08-26T12:00:00Z');
    harness.setFetch(async () => {
      const e = new Error('fetch failed');
      e.code = 'ENOTFOUND';
      throw e;
    });
    const result = await harness.api.pushJsonDraft({
      dispoBaseUrl: 'https://dispo.test',
      endpoint: DRAFT_JSON_ENDPOINTS[basename],
      technicianId: 7,
      serverJobId: 99,
      reiseDir,
      basename,
      filePath: filePath(basename),
      username: 'u',
      password: 'p',
    });
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    const queued = harness.api.queueDraftPushPending({
      dispoBaseUrl: 'https://dispo.test',
      endpoint: DRAFT_JSON_ENDPOINTS[basename],
      technicianId: 7,
      serverJobId: 99,
      localJobId: 5,
      reiseDir,
      basename,
      filePath: filePath(basename),
      username: 'u',
      password: 'p',
    });
    assert.equal(queued, true);
    const inserted = harness.db.inserts.filter((row) => row.args && row.args[0] === 'protocol_draft');
    assert.ok(inserted.length >= 1, 'pending_changes protocol_draft fehlt');
  });
});

describe('protocol_drafts.local_updated_at', () => {
  it('readLocalDraftFile setzt local_updated_at aus Datei-mtime', () => {
    const dir = tmpDir('kukla-mtime-');
    const filePath = path.join(dir, 'Dokumente_Monteur', 'montagebericht.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeLocalDraftFile(filePath, { grundDesEinsatzes: 'ts' }, 1, '2026-08-01T00:00:00Z');
    const read = readLocalDraftFile(filePath);
    assert.ok(read.local_updated_at);
    assert.equal(isLocalFresher(read.local_updated_at, '2026-08-01T00:00:00Z'), true);
    rmDir(dir);
  });

  it('readDraft liefert local_updated_at nach writeDraft', (t) => {
    let Database;
    let db;
    try {
      Database = require('better-sqlite3');
      db = new Database(':memory:');
    } catch (e) {
      t.skip('better-sqlite3 nicht mit diesem Node ladbar: ' + (e && e.message ? e.message : e));
      return;
    }
    db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT)');
    db.prepare("INSERT INTO jobs (id, status) VALUES (1, 'in_arbeit')").run();
    protocolDrafts.writeDraft(
      db,
      1,
      'serviceprotokoll.json',
      { byFab: { FN: { bemerkungen: 'x' } } },
      1,
      '2026-08-01T00:00:00Z',
      null,
    );
    const draft = protocolDrafts.readDraft(db, 1, 'serviceprotokoll.json', null);
    assert.ok(draft.local_updated_at, 'local_updated_at fehlt');
    assert.equal(draft.payload.byFab.FN.bemerkungen, 'x');
    assert.equal(isLocalFresher(draft.local_updated_at, '2026-08-01T00:00:00Z'), true);
    db.close();
  });
});
