/**
 * Lokaler API-Server für die Monteur WebApp (Offline).
 * Verwendet sql.js (WASM, kein nativer Build); läuft im Electron-Hauptprozess.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const FormData = require('form-data');
const csvToPdfPath = path.join(__dirname, 'lib', 'csv-to-pdf.js');

function getCsvToPdfBuffer() {
  try {
    delete require.cache[require.resolve(csvToPdfPath)];
  } catch (_) {}
  return require(csvToPdfPath).csvToPdfBuffer;
}

const PORT = 39678;
const DB_DIR = path.join(__dirname, 'db');
const { registerAbrechnungRoutes, flushAbrechnungOutbox, runAbrechnungRefreshCore } = require('./lib/abrechnung-routes');
const { ensureBackgroundJobsSchema, createBackgroundJobService } = require('./lib/background_jobs');
const { proxyAnlagenstammSearch, proxyAnlagenstammSave } = require('./lib/anlagenstamm-dispo-proxy');
const { buildDispoBaseCandidates } = require('./lib/dispo-base-fallback');
const {
  resolveProjekteNeuRoot,
  scanProjekteNeuTree,
  safeResolveUnderRoot,
} = require('./lib/projekte-neu-local');
const {
  ensureAnlagenstammLocalSchema,
  rowCount: anlagenstammLocalRowCount,
  searchLocal: anlagenstammSearchLocal,
  lookupByFab: anlagenstammLookupByFab,
  getRowsByFabs: anlagenstammGetRowsByFabs,
  saveLocal: anlagenstammSaveLocal,
  syncAnlagenstammFromDispo,
  clampForDispoAnlagenstamm,
  clampForDispoJobFabrikation,
  clampFabrikationsnummernJson,
  uploadCachePath,
} = require('./lib/anlagenstamm-local');

/** Schreiben mit Retry bei EBUSY (OneDrive/Word sperrt Datei). */
function writeFileWithRetry(filePath, data, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(filePath, data);
      return;
    } catch (e) {
      const isBusy = e.code === 'EBUSY' || e.errno === -4082;
      if (isBusy && i < maxRetries - 1) {
        const delay = 400 * (i + 1);
        const end = Date.now() + delay;
        while (Date.now() < end) { /* warten */ }
      } else if (isBusy) {
        throw new Error('Datei ist gesperrt (z. B. durch OneDrive-Sync oder geöffnetes Word). Bitte schließen und erneut versuchen.');
      } else {
        throw e;
      }
    }
  }
}
const DB_PATH = path.join(DB_DIR, 'monteur.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

/** Selbstsigniertes HTTPS zum Dispo: Datei im db-Ordner oder Umgebung KUKLA_DISP_TLS_INSECURE=1 */
const DISPO_TLS_INSECURE_FLAG = path.join(DB_DIR, '.dispo-insecure-tls');
(function applyDispoInsecureTlsFromDisk() {
  try {
    if (process.env.KUKLA_DISP_TLS_INSECURE === '1' || fs.existsSync(DISPO_TLS_INSECURE_FLAG)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  } catch (_) {}
})();

/** Wrapper um sql.js – API wie better-sqlite3 (prepare/get/all/run, transaction). */
function createDbWrapper(sqlDb) {
  return {
    _db: sqlDb,
    save() {
      try {
        const data = sqlDb.export();
        const buffer = Buffer.from(data);
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        fs.writeFileSync(DB_PATH, buffer);
      } catch (e) {
        console.error('DB save failed:', e.message);
      }
    },
    prepare(sql) {
      const stmt = sqlDb.prepare(sql);
      return {
        get(...params) {
          stmt.bind(params);
          const row = stmt.step() ? stmt.getAsObject() : null;
          stmt.reset();
          stmt.free();
          return row;
        },
        all(...params) {
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.reset();
          stmt.free();
          return rows;
        },
        run(...params) {
          stmt.bind(params);
          stmt.step();
          stmt.reset();
          stmt.free();
          const changes = sqlDb.getRowsModified();
          const idResult = sqlDb.exec('SELECT last_insert_rowid() as id');
          const lastInsertRowid = idResult.length && idResult[0].values.length ? idResult[0].values[0][0] : 0;
          return { changes, lastInsertRowid };
        },
      };
    },
    transaction(fn) {
      sqlDb.run('BEGIN TRANSACTION');
      try {
        fn();
        sqlDb.run('COMMIT');
        this.save();
      } catch (e) {
        sqlDb.run('ROLLBACK');
        throw e;
      }
    },
  };
}

function logAbsenceRequestError(info) {
  try {
    const line = new Date().toISOString() + ' ' + JSON.stringify(info) + '\n';
    const logPath = path.join(DB_DIR, 'absence_request_errors.log');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch (e) {
    // Logging-Fehler ignorieren
  }
}

/** Sync-Push-Fehler in Datei und Konsole (zum Debuggen: Log liegt im Ordner der monteur.db). */
function logSyncPushError(info) {
  const line = new Date().toISOString() + ' [sync_push] ' + JSON.stringify(info, null, 0) + '\n';
  console.error('[sync_push]', info);
  try {
    const logPath = path.join(DB_DIR, 'sync_push_errors.log');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch (e) {
    // Logging-Fehler ignorieren
  }
}

async function getDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
  });
  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }
  sqlDb.run('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  sqlDb.run(schema);
  try { sqlDb.run('ALTER TABLE jobs ADD COLUMN eap_nummer TEXT'); } catch (e) { /* Spalte existiert evtl. */ }
  try { sqlDb.run('ALTER TABLE jobs ADD COLUMN bestellnummer TEXT'); } catch (e) { /* Spalte existiert evtl. */ }
  try { sqlDb.run('ALTER TABLE job_addresses ADD COLUMN endkunde TEXT'); } catch (e) { /* Spalte existiert evtl. */ }
  try { sqlDb.run('ALTER TABLE absences ADD COLUMN comment TEXT'); } catch (e) { /* Spalte existiert evtl. */ }
  try { sqlDb.run('ALTER TABLE absence_requests ADD COLUMN comment TEXT'); } catch (e) { /* Spalte existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS job_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  } catch (e) { /* existiert evtl. */ }
  try { sqlDb.run('CREATE INDEX IF NOT EXISTS idx_job_contacts_job ON job_contacts(job_id)'); } catch (e) { /* ignore */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS job_hotel_addresses (
      job_id INTEGER PRIMARY KEY,
      endkunde TEXT,
      street TEXT,
      house_number TEXT,
      zip TEXT,
      city TEXT,
      country TEXT,
      address_extra_1 TEXT,
      address_extra_2 TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  } catch (e) { /* existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS job_hotel_selection (
      job_id INTEGER PRIMARY KEY,
      hotel_id INTEGER,
      comment TEXT,
      rating_stars INTEGER,
      rating_avg REAL,
      rating_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  } catch (e) { /* existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS absence_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      technician_id INTEGER NOT NULL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT DEFAULT (datetime('now')),
      synced_at TEXT
    )`);
  } catch (e) { /* existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS dienstreisen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      running_number INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      company_name TEXT NOT NULL,
      city TEXT,
      country_code TEXT,
      folder_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e) { /* existiert evtl. */ }
  try { sqlDb.run('CREATE INDEX IF NOT EXISTS idx_dienstreisen_year ON dienstreisen(year)'); } catch (e) { /* ignore */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS calendar_cache_technicians (
      technician_id INTEGER PRIMARY KEY,
      name TEXT,
      color TEXT,
      synced_at TEXT
    )`);
  } catch (e) { /* existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS calendar_cache_jobs (
      cache_key TEXT PRIMARY KEY,
      server_job_id INTEGER,
      technician_id INTEGER,
      customer_name TEXT,
      job_number TEXT,
      city TEXT,
      country TEXT,
      status TEXT,
      start_datetime TEXT,
      end_datetime TEXT,
      technician_name TEXT,
      technician_color TEXT,
      synced_at TEXT
    )`);
  } catch (e) { /* existiert evtl. */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS calendar_cache_absences (
      cache_key TEXT PRIMARY KEY,
      server_absence_id INTEGER,
      technician_id INTEGER,
      type TEXT,
      comment TEXT,
      start_datetime TEXT,
      end_datetime TEXT,
      technician_name TEXT,
      technician_color TEXT,
      synced_at TEXT
    )`);
  } catch (e) { /* existiert evtl. */ }
  try { sqlDb.run('CREATE INDEX IF NOT EXISTS idx_calendar_cache_jobs_range ON calendar_cache_jobs(start_datetime, end_datetime)'); } catch (e) { /* ignore */ }
  try { sqlDb.run('CREATE INDEX IF NOT EXISTS idx_calendar_cache_absences_range ON calendar_cache_absences(start_datetime, end_datetime)'); } catch (e) { /* ignore */ }
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS anlagenstamm_tree_cache (
      fab TEXT PRIMARY KEY,
      projects_enabled INTEGER NOT NULL DEFAULT 0,
      tree_json TEXT,
      synced_at TEXT
    )`);
  } catch (e) { /* existiert evtl. */ }
  try { sqlDb.run('CREATE INDEX IF NOT EXISTS idx_anlagenstamm_tree_cache_synced ON anlagenstamm_tree_cache(synced_at)'); } catch (e) { /* ignore */ }
  try {
    ensureAnlagenstammLocalSchema(sqlDb);
  } catch (e) {
    console.warn('[anlagenstamm_local] schema:', e && e.message ? e.message : e);
  }
  try {
    sqlDb.run("UPDATE jobs SET status = 'angelegt' WHERE LOWER(COALESCE(status, '')) = 'geplant'");
    const n = typeof sqlDb.getRowsModified === 'function' ? sqlDb.getRowsModified() : 0;
    if (n > 0) {
      const data = sqlDb.export();
      const buffer = Buffer.from(data);
      if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
      writeFileWithRetry(DB_PATH, buffer);
    }
  } catch (e) { /* ignore */ }
  ensureBackgroundJobsSchema(sqlDb);
  return createDbWrapper(sqlDb);
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  /** Schreibzugriff blockiert für „angelegt“ (inkl. Legacy „geplant“) und „abgerechnet“. */
  function localJobWriteBlocked(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'angelegt' || s === 'geplant') {
      return { error: 'Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    if (s === 'abgerechnet') {
      return { error: 'Auftrag ist abgerechnet – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    return null;
  }

  /** Lokaler Auftrag für Schreibzugriff; blockiert Status nur Anzeige / abgerechnet. */
  function getWritableLocalJobMetaForPatch(dbConn, technicianId, rawJobId) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n)) return { error: 'job_id ungültig.', status: 400 };
    const row = dbConn.prepare(`
      SELECT j.id, j.status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
        AND (
          EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
          OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
        )
    `).get(n, n, technicianId);
    if (!row) return { error: 'Auftrag nicht gefunden.', status: 404 };
    const blocked = localJobWriteBlocked(row.status);
    if (blocked) return blocked;
    return { localId: row.id };
  }

  /** Dienstreise-/Datei-Schreibzugriff: gleiche Regeln wie PATCH (inkl. Techniker-Zuordnung), sonst nur Status-Prüfung per lokaler ID (z. B. Upload ohne technicianId im Body). */
  function gateDienstreiseWrite(dbConn, technicianId, localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return { error: 'job_id (lokal) erforderlich.', status: 400 };
    const tid = parseInt(technicianId, 10);
    if (Number.isFinite(tid) && tid > 0) {
      const w = getWritableLocalJobMetaForPatch(dbConn, tid, lid);
      if (w.error) return w;
      return null;
    }
    const row = dbConn.prepare(`
      SELECT id, status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
    `).get(lid, lid);
    if (!row) return { error: 'Auftrag nicht gefunden.', status: 404 };
    const blocked = localJobWriteBlocked(row.status);
    if (blocked) return blocked;
    return null;
  }

  const sseClients = new Map();
  const pushWsByTechnician = new Map();
  function getPushWsUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    const u = baseUrl.trim().replace(/\/$/, '');
    try {
      const url = new URL(u);
      return (url.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + url.hostname + ':39679/ws';
    } catch (e) { return null; }
  }
  function connectPushForTechnician(technicianId, baseUrl) {
    const wsUrl = getPushWsUrl(baseUrl);
    if (!wsUrl || pushWsByTechnician.has(technicianId)) return;
    try {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', technician_id: technicianId })); });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.channel === 'absence_request_decided' && msg.payload) {
            const requestId = msg.payload.request_id;
            const status = msg.payload.status;
            if (requestId != null && status) {
              try {
                db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE server_id = ? AND technician_id = ?').run(status, requestId, technicianId);
                save();
              } catch (e) {}
            }
            const set = sseClients.get(technicianId);
            if (set) set.forEach((res) => { res.write('data: ' + JSON.stringify(msg) + '\n\n'); });
          }
        } catch (e) {}
      });
      ws.on('error', () => {
        // Push-Server nicht erreichbar: Verbindung verwerfen, App aber nicht crashen lassen.
        pushWsByTechnician.delete(technicianId);
      });
      ws.on('close', () => { pushWsByTechnician.delete(technicianId); });
      pushWsByTechnician.set(technicianId, ws);
    } catch (e) {
      // Fehler beim Aufbau der Verbindung ignorieren – App soll ohne Push weiterlaufen.
    }
  }

  const getTechnicianId = (req) => {
    const id = req.query.technician_id || req.headers['x-technician-id'];
    return id ? parseInt(id, 10) : null;
  };

  /** Gleiche logische Abwesenheit trotz unterschiedlicher ID (Anfrage vs. Absence) oder T/Space in Datumswerten erkennen. */
  const absencePeriodDedupeKey = (technicianId, start, end) => {
    function normDt(v) {
      if (v == null) return '';
      let s = String(v).replace('T', ' ').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
      return s;
    }
    return String(technicianId || '') + '\t' + normDt(start) + '\t' + normDt(end);
  };

  const save = () => db.save();

  /** @type {ReturnType<typeof createBackgroundJobService> | null} */
  let bgJobs = null;

  let appVersion = 'V 1.001';
  try {
    const v = require('./version.json');
    if (v && v.version) appVersion = v.version;
  } catch (e) { /* use default */ }

  const DIENSTREISE_CONFIG_PATH = path.join(DB_DIR, 'dienstreise_config.json');

  function getDienstreiseBasePath() {
    try {
      if (fs.existsSync(DIENSTREISE_CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(DIENSTREISE_CONFIG_PATH, 'utf8'));
        return (data && data.basePath && typeof data.basePath === 'string') ? data.basePath.trim() : '';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function setDienstreiseBasePath(basePath) {
    try {
      if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
      fs.writeFileSync(DIENSTREISE_CONFIG_PATH, JSON.stringify({ basePath: (basePath && typeof basePath === 'string') ? basePath.trim() : '' }, null, 2));
    } catch (e) {
      console.error('dienstreise config write failed:', e.message);
    }
  }

  app.get('/api/version', (req, res) => {
    res.json({
      version: appVersion,
      capabilities: {
        anlagenstamm_search: true,
        anlagenstamm_save: true,
        anlagenstamm_local_sync: true,
        projekte_neu_local: true,
      },
    });
  });

  app.get('/api/dienstreise/config', (req, res) => {
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
  });

  app.post('/api/dienstreise/config', express.json(), (req, res) => {
    const basePath = (req.body && req.body.basePath != null) ? String(req.body.basePath) : '';
    setDienstreiseBasePath(basePath);
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
  });

  app.get('/api/settings_dispo_tls', (req, res) => {
    const allow = process.env.KUKLA_DISP_TLS_INSECURE === '1' || fs.existsSync(DISPO_TLS_INSECURE_FLAG);
    res.json({ ok: true, allowInsecureTls: !!allow });
  });

  app.post('/api/settings_dispo_tls', express.json(), (req, res) => {
    const on = !!(req.body && req.body.allowInsecureTls);
    try {
      if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
      if (on) {
        fs.writeFileSync(DISPO_TLS_INSECURE_FLAG, '1');
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      } else {
        if (fs.existsSync(DISPO_TLS_INSECURE_FLAG)) fs.unlinkSync(DISPO_TLS_INSECURE_FLAG);
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
    res.json({
      ok: true,
      allowInsecureTls: on,
      hint: on ? '' : 'Bei weiterhin funktionierender HTTPS-Verbindung: App einmal vollständig neu starten.',
    });
  });

  const DIENSTREISE_SUBFOLDERS = ['Dokumente_Dispo', 'Dokumente_Monteur', 'Dokumente_Anlage', 'Dokumente_Buchhaltung'];
  const DIENSTREISE_SYNC_FOLDERS = ['Dokumente_Dispo', 'Dokumente_Monteur', 'Dokumente_Anlage', 'Dokumente_Buchhaltung'];

  function sanitizeDienstreiseFolderPart(str) {
    if (typeof str !== 'string') return '';
    const s = str.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').trim();
    return s || 'x';
  }

  function getNextRunningNumber(basePath, year) {
    const yearDir = path.join(basePath, String(year));
    if (!fs.existsSync(yearDir)) return 1;
    let maxNum = 0;
    try {
      const entries = fs.readdirSync(yearDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(/^(\d+)_/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
    } catch (e) { /* ignore */ }
    return maxNum + 1;
  }

  /** rawJobId kann lokale jobs.id oder jobs.server_id sein (Kalender-Cache liefert server_job_id als id). */
  function getJobRowByLocalOrServerId(rawJobId) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return db.prepare(`
      SELECT id, server_id FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
    `).get(n, n);
  }

  function getJobRowWithStatusByLocalOrServerId(rawJobId) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return db.prepare(`
      SELECT id, server_id, status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
    `).get(n, n);
  }

  /** Auftrag annehmen: nur aus angelegt/geplant/zugeteilt. */
  function jobStatusAllowsAcceptJob(status) {
    const s = String(status || '').trim().toLowerCase();
    return s === 'angelegt' || s === 'geplant' || s === 'zugeteilt';
  }

  function applyJobStatusInArbeitAfterAccept(localJobId, technicianId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    const r = db.prepare(`
      UPDATE jobs SET status = 'in_arbeit', updated_at = datetime('now')
      WHERE id = ? AND (
        EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
        OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = jobs.id)
      )
    `).run(lid, technicianId);
    if (r.changes) {
      db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
        'job', lid, 'status', JSON.stringify({ status: 'in_arbeit' })
      );
      save();
    }
  }

  async function pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, serverJobId, authHeader) {
    if (!dispoBaseUrl || !serverJobId) return { ok: false, error: 'Keine Dispo-Verknüpfung.' };
    const base = dispoBaseUrl.replace(/\/$/, '');
    const headerForJob = {
      'Content-Type': 'application/json',
      'X-Technician-Id': String(technicianId),
      ...(authHeader || {}),
    };
    const r = await fetch(`${base}/dispo_api/api/job.php?technician_id=${technicianId}`, {
      method: 'PATCH',
      headers: headerForJob,
      body: JSON.stringify({ job_id: serverJobId, status: 'in_arbeit' }),
    });
    if (!r.ok) {
      let errMsg = 'Dispo: ' + r.status;
      try {
        const errData = await r.json();
        if (errData && typeof errData.error === 'string') errMsg = errData.error;
      } catch (_) { /* ignore */ }
      return { ok: false, error: errMsg };
    }
    return { ok: true };
  }

  function getServerJobId(localJobIdOrServerId) {
    const row = getJobRowByLocalOrServerId(localJobIdOrServerId);
    if (!row) throw new Error('Auftrag nicht gefunden.');
    return row.server_id != null ? row.server_id : row.id;
  }

  async function syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword) {
    const base = (dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!localJobId || !base || !technicianId) throw new Error('job_id (lokal), dispoBaseUrl und technicianId erforderlich.');
    const jobId = getServerJobId(localJobId);
    const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!reiseDir || !fs.existsSync(reiseDir)) throw new Error('Dienstreise-Ordner existiert nicht.');

    const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};

    async function listRemoteFilesForFolder(folderName) {
      const seen = new Set();
      const urlBase = base + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + jobId;
      async function walk(pathPart) {
        const url = urlBase + (pathPart ? '&path=' + encodeURIComponent(pathPart) : '');
        const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error('Dispo-Dateiliste fehlgeschlagen (' + r.status + '): ' + url);
        const data = await r.json();
        const entries = (data && data.entries) ? data.entries : [];
        for (const e of entries) {
          const name = e.name || '';
          if (!name || name === '.' || name === '..') continue;
          const childPath = pathPart ? pathPart + '/' + name : name;
          if (e.type === 'dir') {
            await walk(childPath);
          } else if (e.type === 'file') {
            seen.add(childPath);
          }
        }
      }
      await walk(folderName);
      return seen;
    }

    async function uploadFile(relPathFromRoot, fullPath) {
      const url = base + '/api/job_project_file_upload.php';
      const fileBuf = fs.readFileSync(fullPath);
      await new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('technician_id', String(technicianId));
        form.append('job_id', String(jobId));
        // path-Parameter der Dispo-API ist der Zielordner relativ zum Projektordner,
        // nicht inkl. Dateinamen. Aus relPathFromRoot (z. B. Dokumente_Monteur/foo/bar.pdf)
        // wird daher nur der Ordnerteil (Dokumente_Monteur/foo) als path übergeben.
        var relNorm = relPathFromRoot.replace(/\\/g, '/');
        var lastSlash = relNorm.lastIndexOf('/');
        var folderPart = lastSlash > 0 ? relNorm.slice(0, lastSlash) : '';
        if (folderPart) {
          form.append('path', folderPart);
        }
        form.append('file', fileBuf, path.basename(fullPath));

        const parsed = new URL(url);
        const headers = form.getHeaders({
          ...dispoMonteurFetchHeaders(technicianId, authHeader),
        });
        const options = {
          method: 'POST',
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + (parsed.search || ''),
          headers,
        };

        form.submit(options, (err, res) => {
          if (err) return reject(err);
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const data = body ? JSON.parse(body) : {};
                if (data && data.ok === false) {
                  reject(new Error(data.error || 'Upload zu Dispo fehlgeschlagen.'));
                } else {
                  resolve();
                }
              } catch (e) {
                resolve(); // HTTP ok, JSON egal
              }
            } else {
              reject(new Error('Upload zu Dispo fehlgeschlagen (' + res.statusCode + '): ' + body));
            }
          });
        });
      });
    }

    function collectLocalFiles(rootDir, subfolder) {
      const result = [];
      const startDir = path.join(rootDir, subfolder);
      if (!fs.existsSync(startDir)) return result;
      function walk(currentDir, relBase) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(currentDir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (e.isDirectory()) {
            walk(full, rel);
          } else if (e.isFile()) {
            result.push({ relPathFromSub: rel, fullPath: full });
          }
        }
      }
      walk(startDir, '');
      return result.map((f) => ({
        relPathFromRoot: subfolder + (f.relPathFromSub ? '/' + f.relPathFromSub : ''),
        fullPath: f.fullPath,
      }));
    }

    for (const folder of DIENSTREISE_SYNC_FOLDERS) {
      const files = collectLocalFiles(reiseDir, folder);
      if (!files.length) continue;
      // Idempotent: erst entfernte Dateien auf dem Dispo sammeln,
      // dann nur hochladen, was dort noch nicht existiert.
      let remoteFiles;
      try {
        remoteFiles = await listRemoteFilesForFolder(folder);
      } catch (e) {
        // Wenn die Liste nicht gelesen werden kann, abbrechen – Upload ohne Kenntnis des Server-Zustands
        // würde zu Duplikaten führen.
        throw e;
      }
      for (const f of files) {
        // relPathFromRoot z.B. Dokumente_Buchhaltung/rechnung.pdf – remoteFiles enthält dieselbe Form (folder/name)
        const relNorm = f.relPathFromRoot.replace(/\\/g, '/');
        // Wenn auf dem Dispo bereits eine Datei mit diesem Pfad vorhanden ist, nicht erneut hochladen.
        if (relNorm && remoteFiles.has(relNorm)) continue;
        await uploadFile(f.relPathFromRoot, f.fullPath);
      }
    }
  }

  function createDienstreiseFolder(basePath, startDateISO, companyName, city, countryCode) {
    const base = (basePath && typeof basePath === 'string') ? basePath.trim() : getDienstreiseBasePath();
    if (!base) throw new Error('Speicherort Dienstreise ist nicht konfiguriert.');
    const datePart = (startDateISO && typeof startDateISO === 'string') ? startDateISO.trim().slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) throw new Error('Ungültiges Startdatum (YYYY-MM-DD).');
    const year = datePart.slice(0, 4);
    const nr = getNextRunningNumber(base, year);
    const firm = sanitizeDienstreiseFolderPart(companyName);
    const ort = sanitizeDienstreiseFolderPart(city);
    const lk = sanitizeDienstreiseFolderPart(countryCode);
    const folderName = `${nr}_${datePart}_${firm}_${ort}_${lk}`;
    const yearDir = path.join(base, year);
    const reiseDir = path.join(yearDir, folderName);
    if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });
    if (fs.existsSync(reiseDir)) throw new Error('Reise-Ordner existiert bereits: ' + folderName);
    fs.mkdirSync(reiseDir, { recursive: true });
    for (const sub of DIENSTREISE_SUBFOLDERS) {
      fs.mkdirSync(path.join(reiseDir, sub), { recursive: true });
    }
    return { folderName, fullPath: reiseDir, year: parseInt(year, 10), runningNumber: nr };
  }

  /** Sucht vorhandenen Reise-Ordner zu Jahr/Datum/Firma/Ort/Land; liefert null wenn keiner existiert. */
  function findExistingReiseDir(base, year, datePart, firm, ort, lk) {
    const yearDir = path.join(base, String(year));
    if (!fs.existsSync(yearDir)) return null;
    const expectedSuffix = `${datePart}_${firm}_${ort}_${lk}`;
    try {
      const entries = fs.readdirSync(yearDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(/^(\d+)_(.+)$/);
        if (m && m[2] === expectedSuffix) return path.join(yearDir, e.name);
      }
    } catch (err) { /* ignore */ }
    return null;
  }

  /**
   * Zielordner für einen Auftrag: Jahr = Beginn des Auftrags, Ordner = Laufende Nr._Datum_Firmenname_Ort_LK.
   * Verwendet vorhandenen Ordner falls passend, sonst wird er angelegt.
   */
  function getOrCreateDienstreiseFolderForJob(localJobId) {
    const base = getDienstreiseBasePath();
    if (!base) throw new Error('Speicherort Dienstreise ist nicht konfiguriert.');
    const row = db.prepare(`
      SELECT j.id, j.server_id, j.start_datetime, c.name AS customer_name, ja.city, ja.country
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
    `).get(localJobId, localJobId);
    if (!row) throw new Error('Auftrag nicht gefunden.');
    const startStr = (row.start_datetime || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) throw new Error('Auftrag hat kein gültiges Startdatum.');
    const year = startStr.slice(0, 4);
    const companyName = (row.customer_name || '').trim() || 'Auftrag';
    const city = (row.city || '').trim();
    const countryRaw = (row.country || '').trim();
    const countryCode = countryRaw.length >= 2 ? countryRaw.slice(0, 2).toUpperCase() : countryRaw;
    const firm = sanitizeDienstreiseFolderPart(companyName);
    const ort = sanitizeDienstreiseFolderPart(city);
    const lk = sanitizeDienstreiseFolderPart(countryCode);
    const existing = findExistingReiseDir(base, year, startStr, firm, ort, lk);
    if (existing) return existing;
    const result = createDienstreiseFolder(base, startStr, companyName, city, countryCode);
    return result.fullPath;
  }

  app.post('/api/dienstreise/create_folder', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const basePath = body.basePath != null ? body.basePath : getDienstreiseBasePath();
      const startDate = body.startDate || body.start_date || '';
      const companyName = body.companyName || body.company_name || '';
      const city = body.city || '';
      const countryCode = body.countryCode || body.country_code || '';
      const result = createDienstreiseFolder(basePath, startDate, companyName, city, countryCode);
      res.json({ ok: true, folderName: result.folderName, fullPath: result.fullPath, year: result.year, runningNumber: result.runningNumber });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Ordner konnte nicht angelegt werden.' });
    }
  });

  function getDienstreiseFullPath(dienstreiseRow) {
    const base = getDienstreiseBasePath();
    if (!base || !dienstreiseRow || !dienstreiseRow.folder_name) return null;
    return path.join(base, String(dienstreiseRow.year), dienstreiseRow.folder_name);
  }

  /** Dateiname, der für "leer" ignoriert wird (versteckte/Systemdateien). */
  function isIgnorableDirEntry(name) {
    if (!name || name === '.' || name === '..') return true;
    if (name.startsWith('.')) return true;
    const lower = name.toLowerCase();
    if (lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store') return true;
    return false;
  }

  /** True, wenn der Ordner keine sichtbaren Einträge hat (nur ignorierbare = effektiv leer). */
  function isEffectivelyEmptyDir(dirPath) {
    try {
      const names = fs.readdirSync(dirPath);
      const visible = names.filter((n) => !isIgnorableDirEntry(n));
      return visible.length === 0;
    } catch (e) {
      return true;
    }
  }

  app.get('/api/dienstreise/list', (req, res) => {
    try {
      const rows = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen ORDER BY year DESC, running_number DESC').all();
      res.json({ ok: true, dienstreisen: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Liste der Dateien/Ordner im Projektordner eines Auftrags (Explorer-Ansicht). subpath = relativer Pfad (z. B. "" oder "Dokumente_Monteur"). */
  app.get('/api/dienstreise/project_files', (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      if (!jobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const reiseDir = getOrCreateDienstreiseFolderForJob(jobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) return res.json({ ok: true, folderPath: reiseDir || '', entries: [] });
      let subpath = (req.query.subpath || '').trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
      if (subpath && (subpath.includes('..') || path.isAbsolute(subpath))) return res.status(400).json({ ok: false, error: 'Ungültiger Unterpfad.' });
      const dirPath = subpath ? path.join(reiseDir, subpath) : reiseDir;
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return res.json({ ok: true, folderPath: reiseDir, subpath: subpath || '', entries: [] });
      const names = fs.readdirSync(dirPath);
      const entries = [];
      for (const name of names) {
        if (isIgnorableDirEntry(name)) continue; // versteckte/Systemdateien weder anzeigen noch für "leer" zählen
        const fullPath = path.join(dirPath, name);
        let stat;
        try { stat = fs.statSync(fullPath); } catch (e) { continue; }
        if (stat.isDirectory()) {
          if (isEffectivelyEmptyDir(fullPath)) continue; // leere bzw. nur Systemdateien = ausblenden
        }
        const relativePath = subpath ? subpath + path.sep + name : name;
        entries.push({
          name,
          relativePath,
          fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.isFile() ? stat.size : null,
          mtime: stat.mtime ? stat.mtime.toISOString() : null,
        });
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });
      res.json({ ok: true, folderPath: reiseDir, subpath: subpath || '', entries });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Dateiliste konnte nicht gelesen werden.' });
    }
  });

  function getProjekteNeuLocalContext(localJobId, fab) {
    const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!reiseDir) return null;
    const dm = path.join(reiseDir, 'Dokumente_Monteur');
    const resolved = resolveProjekteNeuRoot(dm, fab);
    if (!resolved) return null;
    return { reiseDir, dm, resolved };
  }

  function cacheProjekteNeuTreesForJob(localJobId) {
    const jobRow = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
    if (!jobRow) return;
    const ctxBase = getOrCreateDienstreiseFolderForJob(localJobId);
    if (!ctxBase || !fs.existsSync(ctxBase)) return;
    const dm = path.join(ctxBase, 'Dokumente_Monteur');
    const fabs = fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern);
    for (const fabNum of fabs) {
      const fab = String(fabNum);
      const resolved = resolveProjekteNeuRoot(dm, fab);
      if (!resolved) continue;
      const scanned = scanProjekteNeuTree(resolved.root);
      upsertAnlagenstammTreeCache(db, fab, { enabled: true, tree: scanned.tree });
    }
    save();
  }

  function resolveLocalJobIdForFab(technicianId, fab) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm || !technicianId) return null;
    const jobs = db
      .prepare(
        `SELECT j.id FROM jobs j
         WHERE EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
         ORDER BY j.id DESC`,
      )
      .all(technicianId);
    let bestId = null;
    let bestTs = 0;
    for (const row of jobs) {
      const jid = row.id;
      const ctx = getProjekteNeuLocalContext(jid, fabNorm);
      if (!ctx) continue;
      const pull = db
        .prepare(
          `SELECT updated_at FROM background_jobs
           WHERE type = 'dienstreise_pull' AND status = 'done'
             AND dedupe_key LIKE ? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get('dienstreise_pull:' + jid + ':%');
      const ts = pull && pull.updated_at ? Date.parse(String(pull.updated_at).replace(' ', 'T') + 'Z') : 0;
      if (!bestId || ts >= bestTs) {
        bestId = jid;
        bestTs = ts || Date.now();
      }
    }
    return bestId;
  }

  app.get('/api/dienstreise/projekte_neu_tree', (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      const fab = String(req.query.fab || '').trim();
      if (!jobId || !fab) return res.status(400).json({ ok: false, error: 'job_id und fab erforderlich.' });
      const ctx = getProjekteNeuLocalContext(jobId, fab);
      if (!ctx) {
        return res.json({ ok: true, local: false, enabled: false, tree: [], message: 'Kein lokaler PROJEKTE-NEU-Ordner für diese FN.' });
      }
      const scanned = scanProjekteNeuTree(ctx.resolved.root);
      upsertAnlagenstammTreeCache(db, fab, { enabled: true, tree: scanned.tree });
      save();
      return res.json({
        ok: true,
        local: true,
        enabled: true,
        tree: scanned.tree,
        truncated: scanned.truncated,
        folder: ctx.resolved.folderName,
        job_id: jobId,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/anlagenstamm/projekte_neu_resolve_local', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const fab = String(req.query.fab || '').trim();
      if (!technicianId || !fab) return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
      const jobId = resolveLocalJobIdForFab(technicianId, fab);
      if (!jobId) {
        return res.json({ ok: true, found: false, job_id: null });
      }
      return res.json({ ok: true, found: true, job_id: jobId });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/dienstreise/projekte_neu_file', async (req, res) => {
    try {
      const jobId = parseInt(req.query.job_id, 10);
      const fab = String(req.query.fab || '').trim();
      const relPath = String(req.query.path || '').trim();
      const wantThumb = String(req.query.thumb || '').toLowerCase() === '1' || req.query.thumb === 'true';
      const wantInline = String(req.query.inline || '').toLowerCase() === '1' || req.query.inline === 'true';
      let thumbMax = parseInt(req.query.thumbMax || req.query.thumb_max, 10);
      if (!Number.isFinite(thumbMax)) thumbMax = 256;
      thumbMax = Math.min(512, Math.max(64, thumbMax));
      if (!jobId || !fab || !relPath) {
        return res.status(400).json({ ok: false, error: 'job_id, fab und path erforderlich.' });
      }
      const ctx = getProjekteNeuLocalContext(jobId, fab);
      if (!ctx) return res.status(404).json({ ok: false, error: 'local_unavailable', message: 'Kein lokaler Ordner.' });
      const filePath = safeResolveUnderRoot(ctx.resolved.root, relPath);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.' });
      }
      const baseName = path.basename(filePath);
      if (wantThumb) {
        try {
          const sharp = require('sharp');
          const buf = await sharp(filePath).rotate().resize(thumbMax, thumbMax, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
          res.setHeader('Content-Type', 'image/webp');
          res.setHeader('Content-Length', String(buf.length));
          return res.send(buf);
        } catch (thumbErr) {
          return res.status(415).json({ ok: false, error: thumbErr.message || 'thumb_not_image' });
        }
      }
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(baseName).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
      };
      const ct = mimeMap[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader(
        'Content-Disposition',
        (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
      );
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/dienstreise/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'id fehlt.' });
    const row = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Dienstreise nicht gefunden.' });
    const fullPath = getDienstreiseFullPath(row);
    res.json({ ok: true, dienstreise: { ...row, fullPath } });
  });

  app.post('/api/dienstreise', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const startDate = (body.startDate || body.start_date || '').trim().slice(0, 10);
      const companyName = (body.companyName || body.company_name || '').trim();
      const city = (body.city || '').trim();
      const countryCode = (body.countryCode || body.country_code || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !companyName) {
        return res.status(400).json({ ok: false, error: 'Startdatum (YYYY-MM-DD) und Firmenname erforderlich.' });
      }
      const basePath = body.basePath != null ? body.basePath : getDienstreiseBasePath();
      const result = createDienstreiseFolder(basePath, startDate, companyName, city, countryCode);
      const runResult = db.prepare('INSERT INTO dienstreisen (year, running_number, start_date, company_name, city, country_code, folder_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        result.year, result.runningNumber, startDate, companyName, city, countryCode, result.folderName
      );
      const row = db.prepare('SELECT id, year, running_number, start_date, company_name, city, country_code, folder_name, created_at FROM dienstreisen WHERE id = ?').get(runResult.lastInsertRowid);
      const fullPath = getDienstreiseFullPath(row);
      res.json({ ok: true, dienstreise: { ...row, fullPath } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Anlegen fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/sync_to_dispo', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id, 10);
      const dispoBaseUrl = (body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technician_id, 10);
      const dispoUsername = (body.dispo_username || '').trim();
      const dispoPassword = (body.dispo_password != null ? String(body.dispo_password) : '');
      const drGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (drGate) return res.status(drGate.status).json({ ok: false, error: drGate.error });
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const dedupeKey = 'dienstreise_push:' + localJobId;
      const { job_id } = bgJobs.enqueue(
        'dienstreise_push',
        {
          job_id: localJobId,
          dispo_base_url: dispoBaseUrl,
          technician_id: technicianId,
          dispo_username: dispoUsername,
          dispo_password: dispoPassword,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Sync zum Dispo-Server fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/copy_project', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const rawJobId = parseInt(body.job_id, 10);
      const dispoBaseUrl = (body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technician_id, 10);
      const dispoUsername = (body.dispo_username || '').trim();
      const dispoPassword = (body.dispo_password != null ? String(body.dispo_password) : '');

      if (!rawJobId || !dispoBaseUrl || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal), dispo_base_url und technician_id erforderlich.' });
      }

      const drGateCopy = gateDienstreiseWrite(db, technicianId, rawJobId);
      if (drGateCopy) return res.status(drGateCopy.status).json({ ok: false, error: drGateCopy.error });

      const jobRow = getJobRowByLocalOrServerId(rawJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const jobId = jobRow.server_id != null ? jobRow.server_id : jobRow.id;

      const targetDir = getOrCreateDienstreiseFolderForJob(jobRow.id);
      if (!targetDir || !fs.existsSync(targetDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });

      const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};

      async function listEntries(relPath) {
        const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
        const url = dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + jobId + pathQ;
        const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
        const r = await fetch(url, opts);
        if (!r.ok) {
          const msg = r.status === 404
            ? 'Dispo-Liste fehlgeschlagen: 404 – URL prüfen (Server-Adresse in Einstellungen). Aufgerufene URL: ' + url
            : 'Dispo-Liste fehlgeschlagen: ' + r.status;
          throw new Error(msg);
        }
        const data = await r.json();
        return (data && data.entries) ? data.entries : [];
      }

      async function downloadFile(relPath, localPath) {
        const url = dispoBaseUrl + '/api/job_project_file_download.php?technician_id=' + technicianId + '&job_id=' + jobId + '&path=' + encodeURIComponent(relPath);
        const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error('Download fehlgeschlagen: ' + relPath + ' (' + r.status + ')');
        const buf = Buffer.from(await r.arrayBuffer());
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, buf);
      }

      async function copyRecursive(relPath) {
        const entries = await listEntries(relPath);
        for (const e of entries) {
          const name = e.name || '';
          if (!name || name === '.' || name === '..') continue;
          const childRel = relPath ? relPath + '/' + name : name;
          const localFull = path.join(targetDir, childRel.replace(/\//g, path.sep));
          if (e.type === 'dir') {
            if (!fs.existsSync(localFull)) fs.mkdirSync(localFull, { recursive: true });
            await copyRecursive(childRel);
          } else if (e.type === 'file') {
            await downloadFile(childRel, localFull);
          }
        }
      }

      await copyRecursive('');
      res.json({ ok: true, message: 'Projektordner wurde in den Dienstreise-Ordner kopiert.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Kopieren fehlgeschlagen.' });
    }
  });

  /**
   * Queued Hintergrund-Job: Dispo-Refresh, Projektordner kopieren, optional Auftrag annehmen.
   * @param {{ acceptJob?: boolean }} options
   */
  function enqueueDienstreisePullFromRequest(req, res, options) {
    const acceptJob = !!(options && options.acceptJob);
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const body = req.body || {};
      const rawJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword =
        body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '';
      const includeBilder = !!body.include_bilder;

      if (!rawJobId || !dispoBaseUrl || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal), dispoBaseUrl und technicianId erforderlich.' });
      }

      const jobRowFull = getJobRowWithStatusByLocalOrServerId(rawJobId);
      if (!jobRowFull) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });

      if (acceptJob) {
        const st = String(jobRowFull.status || '').trim().toLowerCase();
        if (st === 'in_arbeit') {
          return res.status(400).json({ ok: false, error: 'Auftrag ist bereits in Arbeit.' });
        }
        if (st === 'erledigt' || st === 'abgerechnet') {
          return res.status(400).json({ ok: false, error: 'Auftrag kann in diesem Status nicht angenommen werden.' });
        }
        if (!jobStatusAllowsAcceptJob(jobRowFull.status)) {
          return res.status(400).json({ ok: false, error: 'Auftrag kann nur im Status Angelegt oder Zugeteilt angenommen werden.' });
        }
      } else {
        const drGateStream = gateDienstreiseWrite(db, technicianId, rawJobId);
        if (drGateStream) return res.status(drGateStream.status).json({ ok: false, error: drGateStream.error });
      }

      const localJobId = jobRowFull.id;
      const targetDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!targetDir || !fs.existsSync(targetDir)) {
        return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });
      }

      const authHeader =
        dispoUsername || dispoPassword
          ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') }
          : {};
      if (!authHeader.Authorization) {
        return res.status(400).json({
          ok: false,
          error:
            'Dispo-Zugangsdaten fehlen: Benutzername und Passwort in den Einstellungen eintragen (erforderlich für Projektordner holen).',
        });
      }

      const dedupeKey = 'dienstreise_pull:' + localJobId + ':' + (acceptJob ? 'accept' : 'copy');
      const { job_id } = bgJobs.enqueue(
        'dienstreise_pull',
        {
          job_id: rawJobId,
          dispo_base_url: dispoBaseUrl,
          technician_id: technicianId,
          dispo_username: dispoUsername,
          dispo_password: dispoPassword,
          include_bilder: includeBilder,
          accept_job: acceptJob,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Job konnte nicht gestartet werden.' });
    }
  }

  /** @deprecated NDJSON entfernt — Antwort 202 + job_id; siehe GET /api/background_jobs/:id */
  app.post('/api/dienstreise/copy_project_stream', express.json(), (req, res) => {
    enqueueDienstreisePullFromRequest(req, res, { acceptJob: false });
  });

  /** Auftrag annehmen (Hintergrund-Job). */
  app.post('/api/dienstreise/accept_job_stream', express.json(), (req, res) => {
    enqueueDienstreisePullFromRequest(req, res, { acceptJob: true });
  });

  app.post('/api/dienstreise/upload', (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const subfolder = (body.subfolder || '').trim();
      const filename = (body.filename || '').trim() || 'datei';
      const content = body.content;
      if (!localJobId || !DIENSTREISE_SUBFOLDERS.includes(subfolder)) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal) und subfolder (Dokumente_Dispo/Dokumente_Monteur/Dokumente_Anlage/Dokumente_Buchhaltung) erforderlich.' });
      }
      const uploadGate = gateDienstreiseWrite(db, null, localJobId);
      if (uploadGate) return res.status(uploadGate.status).json({ ok: false, error: uploadGate.error });
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });
      const subDir = path.join(reiseDir, subfolder);
      if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
      const safeName = path.basename(filename).replace(/[\/\\:*?"<>|]/g, '_') || 'datei';
      const targetPath = path.join(subDir, safeName);
      const buf = typeof content === 'string' ? Buffer.from(content, 'base64') : (Buffer.isBuffer(content) ? content : null);
      if (!buf || buf.length === 0) return res.status(400).json({ ok: false, error: 'Dateiinhalt (content, base64) fehlt.' });
      fs.writeFileSync(targetPath, buf);
      res.json({ ok: true, path: targetPath, filename: safeName });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Upload fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/delete_file', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const relativePath = (body.relative_path || body.relativePath || '').trim().replace(/\\/g, '/');
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '');

      if (!localJobId || !relativePath) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal) und relative_path erforderlich.' });
      }

      const delGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (delGate) return res.status(delGate.status).json({ ok: false, error: delGate.error });

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });
      }

      const localFullPath = path.join(reiseDir, relativePath.replace(/\//g, path.sep));
      if (!path.resolve(localFullPath).startsWith(path.resolve(reiseDir))) {
        return res.status(400).json({ ok: false, error: 'Ungültiger Pfad.' });
      }
      if (!fs.existsSync(localFullPath) || !fs.statSync(localFullPath).isFile()) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.' });
      }

      fs.unlinkSync(localFullPath);

      if (dispoBaseUrl && technicianId) {
        const jobId = getServerJobId(localJobId);
        const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};
        const formBody = new URLSearchParams();
        formBody.append('technician_id', String(technicianId));
        formBody.append('job_id', String(jobId));
        formBody.append('path', relativePath);
        try {
          const r = await fetch(dispoBaseUrl + '/api/job_project_file_delete.php', {
            method: 'POST',
            headers: Object.assign(
              { 'Content-Type': 'application/x-www-form-urlencoded' },
              dispoMonteurFetchHeaders(technicianId, authHeader),
            ),
            body: formBody.toString(),
          });
          if (!r.ok) {
            const errText = await r.text();
            let errMsg;
            try {
              const errData = errText ? JSON.parse(errText) : {};
              errMsg = errData.error || errText || 'Löschen auf Dispo fehlgeschlagen.';
            } catch (e) {
              errMsg = errText || 'Löschen auf Dispo fehlgeschlagen.';
            }
            return res.json({ ok: true, warning: 'Lokal gelöscht, aber Dispo: ' + errMsg });
          }
        } catch (e) {
          return res.json({ ok: true, warning: 'Lokal gelöscht, aber Dispo-Verbindung fehlgeschlagen: ' + (e.message || String(e)) });
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Löschen fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/finish_and_cleanup', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const protectedPaths = Array.isArray(body.protectedPaths) ? body.protectedPaths.map((p) => String(p || '').replace(/^[\/\\]+|[\/\\]+$/g, '')).filter(Boolean) : [];
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '');
      if (!localJobId) return res.status(400).json({ ok: false, error: 'job_id (lokal) erforderlich.' });
      const finishGate = gateDienstreiseWrite(db, technicianId, localJobId);
      if (finishGate) return res.status(finishGate.status).json({ ok: false, error: finishGate.error });
      const jobId = getServerJobId(localJobId);
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!reiseDir || !fs.existsSync(reiseDir)) return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });

      // Vor Verify: sicherstellen, dass die Sync-Ordner noch einmal aktiv zum Dispo geschoben werden,
      // damit neue Dateien (z. B. kurz vor „Erledigt“ hochgeladen) berücksichtigt sind.
      if (dispoBaseUrl && technicianId) {
        try {
          await syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword);
        } catch (syncErr) {
          return res.status(502).json({ ok: false, error: 'Sync zum Dispo-Server vor Abschluss fehlgeschlagen: ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)) });
        }
      }

      async function collectRemoteFilesForFolder(folderName) {
        if (!dispoBaseUrl || !technicianId) return new Set();
        const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};
        const seen = new Set();
        async function walk(pathPart) {
          const url = dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + jobId + (pathPart ? '&path=' + encodeURIComponent(pathPart) : '');
          const opts = { headers: dispoMonteurFetchHeaders(technicianId, authHeader) };
          const r = await fetch(url, opts);
          if (!r.ok) throw new Error('Dispo-Dateiliste fehlgeschlagen (' + r.status + '): ' + url);
          const data = await r.json();
          const entries = (data && data.entries) ? data.entries : [];
          for (const e of entries) {
            const name = e.name || '';
            if (!name || name === '.' || name === '..') continue;
            const childPath = pathPart ? pathPart + '/' + name : name;
            if (e.type === 'dir') {
              await walk(childPath);
            } else if (e.type === 'file') {
              seen.add(childPath);
            }
          }
        }
        await walk(folderName);
        return seen;
      }

      function collectLocalFilesForFolder(rootDir, folderName) {
        const result = [];
        const startDir = path.join(rootDir, folderName);
        if (!fs.existsSync(startDir)) return result;
        function walk(currentDir, relBase) {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(currentDir, e.name);
            const rel = relBase ? relBase + '/' + e.name : e.name;
            if (e.isDirectory()) {
              walk(full, rel);
            } else if (e.isFile()) {
              result.push(folderName + (rel ? '/' + rel : ''));
            }
          }
        }
        walk(startDir, '');
        return result;
      }

      // Verify: alle lokalen Dateien unter den Sync-Ordnern müssen am Dispo existieren
      for (const folder of DIENSTREISE_SYNC_FOLDERS) {
        const localFiles = collectLocalFilesForFolder(reiseDir, folder);
        if (!localFiles.length) continue;
        const remoteFiles = await collectRemoteFilesForFolder(folder);
        const missing = localFiles.filter((p) => !remoteFiles.has(p));
        if (missing.length > 0) {
          return res.status(409).json({ ok: false, error: 'Dispo und WebApp sind nicht synchron (fehlende Dateien: ' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : '') + ').' });
        }
      }

      const protectedSet = new Set(protectedPaths.map((p) => p.replace(/\\/g, '/')));
      function isProtected(rel) {
        const norm = rel.replace(/\\/g, '/');
        for (const p of protectedSet) {
          if (!p) continue;
          if (norm === p || norm.startsWith(p + '/')) return true;
        }
        return false;
      }

      /** Entfernt ignorierbare Dateien in einem Ordner, damit der Ordner danach leer ist und gelöscht werden kann. */
      function removeIgnorableFilesInDir(dirPath) {
        try {
          const names = fs.readdirSync(dirPath);
          for (const name of names) {
            if (!isIgnorableDirEntry(name)) continue;
            const full = path.join(dirPath, name);
            try {
              if (fs.statSync(full).isFile()) fs.unlinkSync(full);
            } catch (err) { /* ignore */ }
          }
        } catch (err) { /* ignore */ }
      }

      /** Entfernt alle ignorierbaren Einträge (Dateien und Unterordner rekursiv), damit leere Ordner danach mit rmdir entfernt werden können. */
      function removeAllIgnorableContents(dirPath) {
        try {
          const names = fs.readdirSync(dirPath);
          for (const name of names) {
            if (!isIgnorableDirEntry(name)) continue;
            const full = path.join(dirPath, name);
            try {
              if (fs.statSync(full).isFile()) {
                fs.unlinkSync(full);
              } else {
                removeAllIgnorableContents(full);
                fs.rmdirSync(full);
              }
            } catch (err) { /* ignore */ }
          }
        } catch (err) { /* ignore */ }
      }

      /** Prüft, ob ein Ordner leer ist (keine Einträge außer evtl. ignorierbare). */
      function isEmptyOrOnlyIgnorable(dirPath) {
        try {
          const names = fs.readdirSync(dirPath);
          return names.filter((n) => !isIgnorableDirEntry(n)).length === 0;
        } catch (e) {
          return true;
        }
      }

      function deleteRecursively(dir, relBase) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (isProtected(rel)) continue;
          if (e.isDirectory()) {
            deleteRecursively(full, rel);
            try {
              removeAllIgnorableContents(full);
              if (isEmptyOrOnlyIgnorable(full) && !isProtected(rel)) fs.rmdirSync(full);
            } catch (err) { /* ignore */ }
          } else if (e.isFile()) {
            try { fs.unlinkSync(full); } catch (err) { /* ignore */ }
          }
        }
      }

      deleteRecursively(reiseDir, '');
      // Nach dem ersten Durchlauf können ggf. noch leere Ordner übrig sein, deren Eltern zuvor geschützte Kinder hatten.
      // Zweiter Durchlauf nur zum Entfernen leerer, ungeschützter Ordner.
      function removeEmptyDirs(dir, relBase) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (e.isDirectory()) {
            removeEmptyDirs(full, rel);
            try {
              removeAllIgnorableContents(full);
              if (isEmptyOrOnlyIgnorable(full) && !isProtected(rel)) fs.rmdirSync(full);
            } catch (err) { /* ignore */ }
          }
        }
      }
      removeEmptyDirs(reiseDir, '');

      // Weitere Durchläufe: leere Ordner von unten nach oben entfernen (bis nichts mehr wegfällt)
      for (let pass = 0; pass < 5; pass++) {
        let removed = false;
        function removeEmptyDirsPass(dir, relBase) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            const rel = relBase ? relBase + '/' + e.name : e.name;
            if (e.isDirectory()) {
              removeEmptyDirsPass(full, rel);
              try {
                removeAllIgnorableContents(full);
                if (isEmptyOrOnlyIgnorable(full) && !isProtected(rel)) {
                  fs.rmdirSync(full);
                  removed = true;
                }
              } catch (err) { /* ignore */ }
            }
          }
        }
        removeEmptyDirsPass(reiseDir, '');
        if (!removed) break;
      }

      // Leeren Dienstreise-Ordner selbst entfernen (z. B. 1_2026-02-16_Kopierkunde_sss_AT)
      try {
        removeAllIgnorableContents(reiseDir);
        if (fs.existsSync(reiseDir) && isEmptyOrOnlyIgnorable(reiseDir)) {
          fs.rmdirSync(reiseDir);
        }
      } catch (err) { /* ignore */ }

      // Job lokal als "erledigt" markieren UND eine Pending-Änderung anlegen,
      // damit der Status beim nächsten Sync auch im Dispo gesetzt wird
      try {
        if (technicianId) {
          const r = db.prepare(`
            UPDATE jobs SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND (
              EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
              OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = jobs.id)
            )
          `).run('erledigt', localJobId, technicianId);
          if (r.changes) {
            db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`)
              .run('job', localJobId, 'status', JSON.stringify({ status: 'erledigt' }));
            save();
          } else {
            // Fallback: zumindest lokal den Status setzen
            db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('erledigt', localJobId);
          }
        } else {
          db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('erledigt', localJobId);
        }
      } catch (statusErr) {
        // Wenn das Status-Update/Pending-Flag scheitert, soll der Abschluss
        // trotzdem nicht komplett fehlschlagen.
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Abschluss/Löschung fehlgeschlagen.' });
    }
  });

  app.get('/api/technician', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const row = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(technicianId);
    if (!row) {
      return res.json({ ok: true, id: technicianId, full_name: null, username: null });
    }
    res.json({ ok: true, id: row.id, full_name: row.full_name || null, username: row.username || null });
  });

  app.get('/api/my_jobs', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const includeErledigt = req.query.include_erledigt === '1' || req.query.include_erledigt === 'true';
    let sql = `SELECT j.id, j.server_id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
        j.status, j.required_technicians, j.description, j.fabrikationsnummern,
        c.name AS customer_name, c.phone AS customer_phone, c.contact_person, c.contact_phone,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      WHERE (
        EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
        OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
      )`;
    const params = [technicianId];
    if (!includeErledigt) {
      sql += ` AND j.status != 'erledigt'`;
    }
    if (dateFrom) { sql += ' AND j.end_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { sql += ' AND j.start_datetime <= ?'; params.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY j.start_datetime ASC';
    try {
      const rows = db.prepare(sql).all(...params);
      res.json({ ok: true, technician_id: technicianId, jobs: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/my_jobs_archive', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const yearParam = parseInt(req.query.year, 10);
    const year = Number.isFinite(yearParam) && yearParam > 1900 ? yearParam : currentYear;

    const customer = (req.query.customer || '').trim();
    const monthRaw = (req.query.month || '').trim();
    const fab = (req.query.fabrikationsnummer || '').trim();
    const country = (req.query.country || '').trim();

    let sql = `SELECT j.id, j.server_id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
        j.status, j.required_technicians, j.description, j.fabrikationsnummern,
        c.name AS customer_name, c.phone AS customer_phone, c.contact_person, c.contact_phone,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      WHERE j.status = 'erledigt'
        AND strftime('%Y', j.end_datetime) = ?
        AND (
          EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
          OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
        )`;
    const params = [String(year), technicianId];

    if (customer) {
      sql += ' AND c.name LIKE ?';
      params.push('%' + customer + '%');
    }

    if (monthRaw) {
      // Erwartet "MM" (01-12) oder "YYYY-MM"
      if (/^\d{4}-\d{2}$/.test(monthRaw)) {
        sql += ' AND strftime(\'%Y-%m\', j.end_datetime) = ?';
        params.push(monthRaw);
      } else if (/^\d{1,2}$/.test(monthRaw)) {
        const mm = monthRaw.padStart(2, '0');
        if (parseInt(mm, 10) >= 1 && parseInt(mm, 10) <= 12) {
          sql += ' AND strftime(\'%m\', j.end_datetime) = ?';
          params.push(mm);
        }
      }
    }

    if (fab) {
      sql += ' AND j.fabrikationsnummern IS NOT NULL AND j.fabrikationsnummern LIKE ?';
      params.push('%' + fab + '%');
    }

    if (country) {
      sql += ' AND (ja.country LIKE ? OR c.country LIKE ?)';
      params.push('%' + country + '%', '%' + country + '%');
    }

    sql += ' ORDER BY j.end_datetime DESC';

    try {
      const rows = db.prepare(sql).all(...params);
      res.json({ ok: true, technician_id: technicianId, year, jobs: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/jobs_open', async (req, res) => {
    const technicianId = getTechnicianId(req);
    const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ error: 'base_url und technician_id erforderlich.' });
    }
    const auth = authHeaderFromIncomingBasicOrQuery(req);
    const includeErledigt = (req.query.include_erledigt || '').toString() === '1';
    const filterNoDate = (req.query.filter_no_date || '').toString() === '1';
    const filterNoTechnician = (req.query.filter_no_technician || '').toString() === '1';
    const url =
      `${baseUrl}/dispo_api/api/jobs_open.php?technician_id=${encodeURIComponent(technicianId)}` +
      (includeErledigt ? '&include_erledigt=1' : '') +
      (filterNoDate ? '&filter_no_date=1' : '') +
      (filterNoTechnician ? '&filter_no_technician=1' : '');
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const text = await r.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = null;
        }
      }
      if (!r.ok) {
        const apiErr = data && typeof data.error === 'string' && data.error.trim() ? data.error.trim() : null;
        const snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        return res.status(r.status).json({
          error: apiErr || snippet || r.statusText || 'Dispo-Fehler',
        });
      }
      if (!Array.isArray(data)) {
        return res.status(502).json({
          error: 'Unerwartete Antwort von jobs_open (kein JSON-Array).',
          detail: (text || '').slice(0, 400),
        });
      }
      res.json(data);
    } catch (e) {
      const msg = e.message || String(e);
      console.error('[jobs_open]', msg);
      let hint = '';
      if (/CERT|TLS|SSL|self-signed|self signed|unable to verify|UNABLE_TO_VERIFY|wrong version number|EPROTO/i.test(msg)) {
        hint =
          'Bei HTTPS mit selbstsigniertem Zertifikat: Einstellungen → „Selbstsigniertes HTTPS-Zertifikat akzeptieren“ aktivieren, speichern, App neu starten.';
      }
      res.status(502).json({
        error: 'Dispo nicht erreichbar: ' + msg,
        hint,
      });
    }
  });

  app.get('/api/job', async (req, res) => {
    const technicianId = getTechnicianId(req);
    const jobId = parseInt(req.query.id, 10);
    if (!technicianId || !jobId) {
      return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
    }
    const row = db.prepare(`
      SELECT j.*, c.name AS customer_name, c.street AS customer_street, c.house_number AS customer_house_number,
        c.zip AS customer_zip, c.city AS customer_city, c.phone AS customer_phone,
        c.contact_person, c.contact_phone, c.contact_email,
        ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2,
        jha.endkunde AS hotel_endkunde, jha.street AS hotel_street, jha.house_number AS hotel_house_number,
        jha.zip AS hotel_zip, jha.city AS hotel_city, jha.country AS hotel_country,
        jha.address_extra_1 AS hotel_address_extra_1, jha.address_extra_2 AS hotel_address_extra_2,
        jha.phone AS hotel_phone, jha.email AS hotel_email, jha.website AS hotel_website,
        jhs.hotel_id AS hotel_id, jhs.comment AS hotel_comment, jhs.rating_stars AS hotel_rating_stars,
        jhs.rating_avg AS hotel_rating_avg, jhs.rating_count AS hotel_rating_count
      FROM jobs j
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      LEFT JOIN job_hotel_addresses jha ON jha.job_id = j.id
      LEFT JOIN job_hotel_selection jhs ON jhs.job_id = j.id
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
        AND (
          EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
          OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
        )
    `).get(jobId, jobId, technicianId);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
    }
    const localJobPk = row.id;
    let job = { ...row };
    job.job_contacts = job.job_contacts || [];
    try {
      const contacts = db.prepare('SELECT contact_name, contact_phone, contact_email FROM job_contacts WHERE job_id = ? ORDER BY sort_order, id').all(localJobPk);
      if (contacts && contacts.length > 0) {
        job.job_contacts = contacts;
      }
    } catch (e) {
      // Tabelle job_contacts fehlt ggf. – Fallback auf contact_person/contact_phone/contact_email vom Job/Kunde
    }
    const baseUrl = (req.query.base_url || '').toString().trim();
    const enrich = req.query.enrich_anlagenstamm === '1' || req.query.enrich_anlagenstamm === 'true';
    if (enrich && baseUrl) {
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      job = await enrichJobFabWithAnlagenstamm(job, baseUrl, auth);
    }
    res.json({ ok: true, job });
  });

  function normalizeJobContactsFromPayload(job) {
    if (!job || typeof job !== 'object') return [];
    const candidates = []
      .concat(Array.isArray(job.job_contacts) ? job.job_contacts : [])
      .concat(Array.isArray(job.jobContacts) ? job.jobContacts : [])
      .concat(Array.isArray(job.contacts) ? job.contacts : []);
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i] || {};
      const name = (c.contact_name != null ? String(c.contact_name) : (c.name != null ? String(c.name) : (c.contactPerson != null ? String(c.contactPerson) : ''))).trim();
      const phone = (c.contact_phone != null ? String(c.contact_phone) : (c.phone != null ? String(c.phone) : '')).trim();
      const email = (c.contact_email != null ? String(c.contact_email) : (c.email != null ? String(c.email) : '')).trim();
      if (name || phone || email) {
        out.push({ contact_name: name, contact_phone: phone, contact_email: email });
      }
    }
    if (out.length > 0) return out;
    const directName = (job.baustellen_ansprechpartner != null ? String(job.baustellen_ansprechpartner) : (job.contact_person != null ? String(job.contact_person) : '')).trim();
    const directPhone = (job.contact_phone != null ? String(job.contact_phone) : '').trim();
    const directEmail = (job.contact_email != null ? String(job.contact_email) : '').trim();
    if (directName || directPhone || directEmail) {
      return [{ contact_name: directName, contact_phone: directPhone, contact_email: directEmail }];
    }
    return [];
  }

  app.post('/api/job_from_dispo', express.json(), async (req, res) => {
    const sendError = (status, msg) => {
      if (!res.headersSent) res.status(status).json({ ok: false, error: msg });
    };
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, jobId: localJobId } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !base || localJobId == null) {
        return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
      }
      const localId = parseInt(localJobId, 10);
      if (!Number.isFinite(localId)) {
        return res.status(400).json({ ok: false, error: 'jobId ungültig.' });
      }
      const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
      const row = db.prepare(`
        SELECT j.id, j.server_id FROM jobs j
        WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
          AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
          )
      `).get(localId, localId, technicianId);

      async function finishWithDispoJob(data) {
        if (!data.job || typeof data.job !== 'object') {
          return sendError(404, (data && data.error) || 'Auftrag nicht gefunden.');
        }
        if (data.job.fabrikationsnummern == null && data.job.Fabrikationsnummern != null) {
          data.job.fabrikationsnummern = data.job.Fabrikationsnummern;
        }
        data.job = await enrichJobFabWithAnlagenstamm(data.job, base, auth);
        const localDbId = row ? row.id : null;
        const contacts = normalizeJobContactsFromPayload(data.job);
        data.job.job_contacts = contacts;
        if (localDbId != null) {
          try {
            const hotel = db.prepare('SELECT endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website FROM job_hotel_addresses WHERE job_id = ?').get(localDbId);
            if (hotel) {
              data.job.hotel_endkunde = hotel.endkunde;
              data.job.hotel_street = hotel.street;
              data.job.hotel_house_number = hotel.house_number;
              data.job.hotel_zip = hotel.zip;
              data.job.hotel_city = hotel.city;
              data.job.hotel_country = hotel.country;
              data.job.hotel_address_extra_1 = hotel.address_extra_1;
              data.job.hotel_address_extra_2 = hotel.address_extra_2;
              data.job.hotel_phone = hotel.phone;
              data.job.hotel_email = hotel.email;
              data.job.hotel_website = hotel.website;
            }
          } catch (e) { /* Tabelle fehlt – ignorieren */ }
          try {
            db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(localDbId);
            for (let i = 0; i < contacts.length; i++) {
              const c = contacts[i];
              const name = (c.contact_name != null ? String(c.contact_name) : '').trim();
              const phone = (c.contact_phone != null ? String(c.contact_phone) : '').trim();
              const email = (c.contact_email != null ? String(c.contact_email) : '').trim();
              if (name || phone || email) {
                db.prepare('INSERT INTO job_contacts (job_id, contact_name, contact_phone, contact_email, sort_order) VALUES (?, ?, ?, ?, ?)').run(localDbId, name || null, phone || null, email || null, i);
              }
            }
          } catch (e) { /* Tabelle fehlt oder Fehler – ignorieren */ }
        }
        res.json(data);
      }

      async function fetchDispoJob(urlToFetch) {
        const r = await fetch(urlToFetch, auth ? { headers: auth } : {});
        const raw = await r.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
        if (!r.ok) {
          logSyncPushError({
            reason: 'job_from_dispo_http_error',
            status: r.status,
            statusText: r.statusText,
            url: urlToFetch,
            body_preview: (raw || '').slice(0, 1200),
          });
        }
        return { ok: r.ok, status: r.status, statusText: r.statusText, data, raw };
      }

      // Kein lokaler SQLite-Eintrag: jobId ist oft die Dispo-Server-ID (z. B. Liste „Offene Aufträge“ / noch nicht synchronisiert)
      if (!row) {
        const urlDirect = `${base}/dispo_api/api/job.php?id=${encodeURIComponent(localId)}&technician_id=${encodeURIComponent(technicianId)}&debug=1`;
        const rs0 = await fetchDispoJob(urlDirect);
        if (!rs0.ok) {
          return sendError(rs0.status, rs0.data.error || rs0.statusText || 'Dispo-Fehler');
        }
        return await finishWithDispoJob({ ok: true, ...rs0.data });
      }

      const serverJobId = (row.server_id != null && row.server_id !== '') ? row.server_id : row.id;
      const url = `${base}/dispo_api/api/job.php?id=${encodeURIComponent(serverJobId)}&technician_id=${encodeURIComponent(technicianId)}&debug=1`;
      const rs = await fetchDispoJob(url);
      if (!rs.ok) {
        return sendError(rs.status, rs.data.error || rs.statusText || 'Dispo-Fehler');
      }
      await finishWithDispoJob(rs.data);
    } catch (e) {
      console.error('[job_from_dispo]', e.message, e.stack);
      logSyncPushError({ reason: 'job_from_dispo', message: e.message, stack: e.stack });
      sendError(500, e.message || 'Interner Fehler beim Laden von der Dispo');
    }
  });

  /** Proxys: Dispo Signatur-API (dispo_api) mit Basic-Auth wie job_from_dispo */
  app.post('/api/dispo_signature_session_open', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, payload } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !base) {
        return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const url = `${base}/dispo_api/api/signature_session_open.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, auth || {}),
        body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'signature_session_open' });
    }
  });

  app.post('/api/dispo_signature_submit', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, payload } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !base) {
        return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const url = `${base}/dispo_api/api/signature_submit.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, auth || {}),
        body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'signature_submit' });
    }
  });

  app.post('/api/dispo_signature_stage_pdf_b64', express.json({ limit: '80mb' }), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const { baseUrl, serverUsername, serverPassword, pdfBase64, fileName } = req.body || {};
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !base || !pdfBase64) {
        return res.status(400).json({ ok: false, error: 'baseUrl, pdfBase64 und technician_id erforderlich.' });
      }
      const buf = Buffer.from(String(pdfBase64), 'base64');
      if (buf.length < 8 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return res.status(400).json({ ok: false, error: 'Kein gültiges PDF (Base64).' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const fd = new FormData();
      fd.append('technician_id', String(technicianId));
      fd.append('file', buf, { filename: (fileName && String(fileName)) || 'upload.pdf', contentType: 'application/pdf' });
      const url = `${base}/dispo_api/api/signature_stage_pdf.php`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({}, auth || {}, fd.getHeaders()),
        body: fd,
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'signature_stage' });
    }
  });

  /**
   * Generischer Proxy fuer die Mobile-RAMS-API (`/api/mobile/rams.php`).
   * Auth: HTTP-Basic gegen `users` (siehe `dispo/auth/require_token.php`).
   * Body: { action, method, queryParams?, payload?, baseUrl }
   * Wird vom Laptop-Frontend (rams_wizard.js) aufgerufen, damit der gleiche
   * Mobile-Endpoint wie in der PWA genutzt werden kann.
   */
  app.all('/api/laptop_rams_proxy', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const baseUrl = (body.baseUrl || body.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
      const action = (body.action || req.query.action || '').toString().trim();
      const method = (body.method || (body.payload ? 'POST' : 'GET')).toString().toUpperCase();
      const queryParams = (body.queryParams && typeof body.queryParams === 'object') ? body.queryParams : {};
      const payload = body.payload;
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: 'baseUrl erforderlich.' });
      }
      if (!action) {
        return res.status(400).json({ ok: false, error: 'action erforderlich.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'Basic-Auth erforderlich.' });
      }
      const qs = new URLSearchParams();
      qs.set('action', action);
      Object.keys(queryParams).forEach((k) => {
        if (queryParams[k] !== undefined && queryParams[k] !== null) qs.set(k, String(queryParams[k]));
      });
      const url = `${baseUrl}/api/mobile/rams.php?${qs.toString()}`;
      const headers = Object.assign(
        { Accept: 'application/json' },
        auth || {},
        auth && auth.Authorization ? { 'X-Kukla-Authorization': auth.Authorization } : {}
      );
      const opts = { method: method, headers: headers };
      if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(payload && typeof payload === 'object' ? payload : (payload || {}));
      }
      const r = await fetch(url, opts);
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'rams_proxy' });
    }
  });

  /**
   * Aktive Auftraege des Technikers fuer "RAMS Erstellen" im Laptop.
   * Liefert das schon vorhandene Dispo-Endpoint `dispo_api/api/jobs_open.php`.
   * Diese Route ist ein Convenience-Wrapper um POST mit JSON-Body, weil das
   * Laptop-Frontend dieselbe Calling-Convention wie der RAMS-Proxy nutzt.
   */
  app.post('/api/laptop_active_jobs_for_rams', express.json(), async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const baseUrl = (body.baseUrl || body.base_url || '').toString().trim().replace(/\/$/, '');
      const technicianId = body.technicianId || body.technician_id || getTechnicianId(req);
      if (!baseUrl || !technicianId) {
        return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      const url = `${baseUrl}/dispo_api/api/jobs_open.php?technician_id=${encodeURIComponent(technicianId)}`;
      const r = await fetch(url, { method: 'GET', headers: Object.assign({ Accept: 'application/json' }, auth || {}) });
      const raw = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: (parsed && parsed.error) || 'Dispo-Fehler', raw: raw.slice(0, 400) });
      }
      const jobs = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.jobs) ? parsed.jobs : []);
      res.json({ ok: true, jobs: jobs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'jobs_proxy' });
    }
  });

  /**
   * Whitelist-Proxy fuer ausgewaehlte Mobile-API-Skripte (Signatur-Session/Submit).
   * Gleiche Basic-Auth wie laptop_rams_proxy. Pfad relativ zur Dispo-Base.
   */
  app.post('/api/laptop_mobile_post', express.json({ limit: '80mb' }), async (req, res) => {
    try {
      const allowed = new Set([
        '/api/mobile/signature_session_open.php',
        '/api/mobile/signature_submit.php',
      ]);
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const baseUrl = (body.baseUrl || body.base_url || '').toString().trim().replace(/\/$/, '');
      let relPath = (body.path || '').toString().trim();
      if (!relPath.startsWith('/')) {
        relPath = '/' + relPath;
      }
      if (!baseUrl || !allowed.has(relPath)) {
        return res.status(400).json({ ok: false, error: 'baseUrl oder path ungueltig.' });
      }
      const auth = authHeaderFromIncomingBasicOrQuery(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'Basic-Auth erforderlich.' });
      }
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      const url = `${baseUrl}${relPath}`;
      const headers = Object.assign(
        { Accept: 'application/json', 'Content-Type': 'application/json' },
        auth || {},
        auth && auth.Authorization ? { 'X-Kukla-Authorization': auth.Authorization } : {}
      );
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'laptop_mobile_post' });
    }
  });

  /** PDF aus lokalem Dienstreise-Ordner stagen (Montagebericht → Dispo-Signatur). */
  app.post('/api/montagebericht_signature_stage', express.json(), async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const {
        localJobId,
        relativePath,
        baseUrl,
        serverUsername,
        serverPassword,
      } = req.body || {};
      const jid = parseInt(String(localJobId || ''), 10);
      const rel = (relativePath || '').toString().trim().replace(/\\/g, '/');
      if (!technicianId || !jid || !rel) {
        return res.status(400).json({ ok: false, error: 'localJobId und relativePath erforderlich.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(jid);
      if (!reiseDir || !fs.existsSync(reiseDir)) {
        return res.status(400).json({ ok: false, error: 'Dienstreise-Ordner nicht gefunden.' });
      }
      const fullPath = path.join(reiseDir, rel.split('/').join(path.sep));
      const resolved = path.resolve(fullPath);
      const baseResolved = path.resolve(reiseDir);
      if (!resolved.startsWith(baseResolved)) {
        return res.status(400).json({ ok: false, error: 'Pfad ungültig.' });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ ok: false, error: 'PDF nicht gefunden.' });
      }
      const buf = fs.readFileSync(resolved);
      if (buf.length < 8 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return res.status(400).json({ ok: false, error: 'Kein gültiges PDF.' });
      }
      const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!base) {
        return res.status(400).json({ ok: false, error: 'Dispo baseUrl erforderlich.' });
      }
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const fd = new FormData();
      fd.append('technician_id', String(technicianId));
      fd.append('file', buf, {
        filename: path.basename(rel) || 'montage.pdf',
        contentType: 'application/pdf',
      });
      const url = `${base}/dispo_api/api/signature_stage_pdf.php`;
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({}, auth || {}, fd.getHeaders()),
        body: fd,
      });
      const raw = await r.text();
      res.status(r.status).type('application/json').send(raw);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'montagebericht_signature_stage' });
    }
  });

  app.post('/api/anlagenstamm_from_dispo', express.json(), async (req, res) => {
    const { baseUrl, fabs } = req.body || {};
    const list = Array.isArray(fabs) ? fabs.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim()) : [];
    if (list.length === 0) {
      return res.status(400).json({ ok: false, error: 'fabs (Array) erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    const localRows = anlagenstammGetRowsByFabs(db, list);
    if (localRows.length > 0 && anlagenstammLocalRowCount(db) > 0) {
      return res.json({ ok: true, data: localRows, _source: 'local' });
    }
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl und fabs (Array) erforderlich.' });
    }
    const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(list.join(','))}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_lookup', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, fab, serverUsername, serverPassword, force_online: forceOnline } = req.body || {};
    const fabValue = (fab || '').toString().trim();
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    if (!forceOnline && anlagenstammLocalRowCount(db) > 0) {
      const row = anlagenstammLookupByFab(db, fabValue);
      if (row) {
        return res.json({ ok: true, row, anlage: row, _source: 'local' });
      }
    }
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl, fab und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_lookup.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_search', express.json(), async (req, res) => {
    const body = req.body || {};
    const technicianId =
      getTechnicianId(req) ??
      (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    const forceOnline =
      body.force_online === true ||
      body.force_online === 1 ||
      String(body.force_online || '').toLowerCase() === 'true';
    if (!forceOnline && anlagenstammLocalRowCount(db) > 0) {
      const local = anlagenstammSearchLocal(db, body);
      if (local.ok) return res.json(local);
    }
    const hasBase = buildDispoBaseCandidates({
      baseUrl: body.baseUrl,
      externalUrl: body.externalUrl,
      internalUrl: body.internalUrl,
    }).length > 0;
    if (!hasBase) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technician_id erforderlich.' });
    }
    try {
      const data = await proxyAnlagenstammSearch(Object.assign({}, body, { technician_id: technicianId }));
      if (data && data.ok === false) {
        const code = Number(data._httpStatus) >= 400 ? Number(data._httpStatus) : 502;
        const out = Object.assign({}, data);
        delete out._httpStatus;
        return res.status(code).json(out);
      }
      const ok = Object.assign({}, data);
      delete ok._httpStatus;
      res.json(ok);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const technicianId =
      getTechnicianId(req) ??
      (body.technician_id != null ? parseInt(String(body.technician_id), 10) : null);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
    }
    ensureAnlagenstammLocalSchema(db);
    const bodyNorm = clampForDispoAnlagenstamm(body);
    const localResult = anlagenstammSaveLocal(db, bodyNorm);
    if (!localResult.ok) {
      return res.status(400).json(localResult);
    }
    const entityId = localResult.id > 0 ? localResult.id : String(localResult.fabrikationsnummer || '').trim();
    db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'anlagenstamm' AND entity_id = ? AND action = 'save'`).run(
      entityId,
    );
    db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
      'anlagenstamm',
      entityId,
      'save',
      JSON.stringify(
        Object.assign({}, bodyNorm, {
          id: localResult.id,
          fabrikationsnummer: localResult.fabrikationsnummer,
          serverUsername: body.serverUsername,
          serverPassword: body.serverPassword,
          baseUrl: body.baseUrl,
          externalUrl: body.externalUrl,
          internalUrl: body.internalUrl,
          technician_id: technicianId,
        }),
      ),
    );
    save();
    res.json({
      ok: true,
      id: localResult.id,
      fabrikationsnummer: localResult.fabrikationsnummer,
      pending_sync: true,
      _source: 'local',
    });
  });

  app.post('/api/anlagenstamm_files_list', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, fab, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    if (!technicianId || !base || !fabValue) {
      return res.status(400).json({ ok: false, error: 'baseUrl, fab und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/anlagenstamm_files_list.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}`;
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      try {
        const pnRaw = data && data.projekte_neu ? data.projekte_neu : { enabled: false, tree: [] };
        upsertAnlagenstammTreeCache(db, fabValue, pnRaw);
        save();
      } catch (_) { /* cache ist best-effort */ }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.get('/api/anlagenstamm_tree_cached', (req, res) => {
    const fab = String(req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'fab erforderlich.' });
    try {
      const row = db.prepare('SELECT fab, projects_enabled, tree_json, synced_at FROM anlagenstamm_tree_cache WHERE fab = ?').get(fab);
      if (!row) return res.json({ ok: true, found: false, fab: fab, projects_enabled: false, tree: [] });
      let tree = [];
      try { tree = row.tree_json ? JSON.parse(row.tree_json) : []; } catch (_) { tree = []; }
      return res.json({
        ok: true,
        found: true,
        fab: row.fab,
        projects_enabled: Number(row.projects_enabled) === 1,
        tree: Array.isArray(tree) ? tree : [],
        synced_at: row.synced_at || null
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_file_download', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const {
      baseUrl,
      fab,
      file,
      path: pnPathRaw,
      source: sourceRaw,
      serverUsername,
      serverPassword,
      thumb: thumbRaw,
      thumbMax: thumbMaxRaw,
      inline: inlineRaw,
      job_id: jobIdRaw,
    } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    const fileValue = (file || '').toString().trim();
    const sourceNorm = String(sourceRaw || '').toLowerCase().trim();
    const pnPath = (pnPathRaw || '').toString().trim();
    const wantThumb =
      thumbRaw === true ||
      thumbRaw === 1 ||
      String(thumbRaw || '').toLowerCase() === 'true';
    const wantInline =
      inlineRaw === true ||
      inlineRaw === 1 ||
      String(inlineRaw || '').toLowerCase() === 'true';
    let thumbMax = parseInt(thumbMaxRaw, 10);
    if (!Number.isFinite(thumbMax)) thumbMax = 256;
    thumbMax = Math.min(512, Math.max(64, thumbMax));
    if (!technicianId || !fabValue) {
      return res.status(400).json({ ok: false, error: 'fab und technician_id erforderlich.' });
    }
    if (sourceNorm === 'projekte_neu' && pnPath) {
      let localJobId = parseInt(jobIdRaw, 10);
      if (!localJobId) localJobId = resolveLocalJobIdForFab(technicianId, fabValue);
      if (localJobId) {
        const ctx = getProjekteNeuLocalContext(localJobId, fabValue);
        if (ctx) {
          const filePath = safeResolveUnderRoot(ctx.resolved.root, pnPath);
          if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            try {
              if (wantThumb) {
                const sharp = require('sharp');
                const buf = await sharp(filePath)
                  .rotate()
                  .resize(thumbMax, thumbMax, { fit: 'inside', withoutEnlargement: true })
                  .webp({ quality: 82 })
                  .toBuffer();
                res.setHeader('Content-Type', 'image/webp');
                res.setHeader('Content-Length', String(buf.length));
                return res.send(buf);
              }
              const buf = fs.readFileSync(filePath);
              const baseName = path.basename(filePath);
              res.setHeader('Content-Type', 'application/octet-stream');
              res.setHeader(
                'Content-Disposition',
                (wantInline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(baseName) + '"',
              );
              res.setHeader('Content-Length', String(buf.length));
              return res.send(buf);
            } catch (localErr) {
              if (wantThumb) {
                return res.status(415).json({ ok: false, error: localErr.message || 'thumb_not_image' });
              }
            }
          }
        }
      }
    }
    if (sourceNorm !== 'projekte_neu' && fileValue) {
      const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile()) {
        const buf = fs.readFileSync(cacheFile);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(fileValue) + '"');
        res.setHeader('Content-Length', String(buf.length));
        return res.send(buf);
      }
    }
    if (!base) {
      return res.status(400).json({ ok: false, error: 'baseUrl, fab und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    let url;
    if (sourceNorm === 'projekte_neu') {
      if (!pnPath) {
        return res.status(400).json({ ok: false, error: 'path erforderlich für PROJEKTE NEU.' });
      }
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}`;
    } else {
      if (!fileValue) {
        return res.status(400).json({ ok: false, error: 'baseUrl, fab, file und technician_id erforderlich.' });
      }
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&file=${encodeURIComponent(fileValue)}`;
    }
    const qs = [];
    if (wantThumb) {
      qs.push('thumb=1');
      qs.push(`thumb_max=${encodeURIComponent(String(thumbMax))}`);
    }
    if (wantInline) qs.push('inline=1');
    if (qs.length) url += '&' + qs.join('&');
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const fallbackFn = sourceNorm === 'projekte_neu'
        ? (pnPath.split(/[/\\]/).pop() || 'download')
        : fileValue;
      if (sourceNorm !== 'projekte_neu' && fileValue && buf.length) {
        try {
          const cacheFile = uploadCachePath(DB_DIR, fabValue, fileValue);
          const cacheDir = path.dirname(cacheFile);
          if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cacheFile, buf);
        } catch (_) {}
      }
      const cd = r.headers.get('content-disposition') || ('attachment; filename="' + encodeURIComponent(fallbackFn) + '"');
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', cd);
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_file_open', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, fab, file, path: pnPathRaw, source: sourceRaw, fallbackName, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const fabValue = (fab || '').toString().trim();
    const fileValue = (file || '').toString().trim();
    const sourceNorm = String(sourceRaw || '').toLowerCase().trim();
    const pnPath = (pnPathRaw || '').toString().trim();
    if (!technicianId || !base || !fabValue) {
      return res.status(400).json({ ok: false, error: 'baseUrl, fab und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    let url;
    if (sourceNorm === 'projekte_neu') {
      if (!pnPath) return res.status(400).json({ ok: false, error: 'path erforderlich für PROJEKTE NEU.' });
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&source=projekte_neu&path=${encodeURIComponent(pnPath)}`;
    } else {
      if (!fileValue) return res.status(400).json({ ok: false, error: 'file erforderlich.' });
      url = `${base}/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabValue)}&file=${encodeURIComponent(fileValue)}`;
    }
    try {
      const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, auth) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        try { console.warn('[anlagenstamm_file_open] upstream error', r.status, data && data.error ? data.error : r.statusText); } catch (_) {}
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return res.status(500).json({ ok: false, error: 'Datei ist leer.' });
      const openDir = path.join(DB_DIR, 'anlagenstamm_open');
      if (!fs.existsSync(openDir)) fs.mkdirSync(openDir, { recursive: true });
      const rawName = sourceNorm === 'projekte_neu'
        ? (pnPath.split(/[/\\]/).pop() || String(fallbackName || '').trim() || 'download')
        : (fileValue || String(fallbackName || '').trim() || 'download');
      const safeName = String(rawName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'download';
      const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
      const targetPath = path.join(openDir, `${stamp}_${safeName}`);
      fs.writeFileSync(targetPath, buf);
      try { console.log('[anlagenstamm_file_open] ready', targetPath, 'bytes=' + buf.length); } catch (_) {}
      return res.json({ ok: true, path: targetPath, filename: safeName, size: buf.length });
    } catch (e) {
      try { console.warn('[anlagenstamm_file_open] fetch exception', e.message); } catch (_) {}
      return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** TED/Mechanik-Excel-Index: gleiche Auth wie andere Dispo-Proxys (Basic über serverUsername/serverPassword). */
  app.post('/api/mechanik_ted_excel_from_dispo', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, jobId: rawJobId, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const jobId = parseInt(rawJobId, 10);
    if (!technicianId || !base || !Number.isFinite(jobId)) {
      return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/mechanik_ted_excel_list.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/job_hotels_from_dispo', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, jobId: rawJobId, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const jobId = parseInt(rawJobId, 10);
    if (!technicianId || !base || !Number.isFinite(jobId)) {
      return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/dispo_api/api/job_hotels_by_fab.php?technician_id=${encodeURIComponent(technicianId)}&job_id=${encodeURIComponent(jobId)}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Lädt Montagebericht-Vorlagen von der Dispo und speichert sie lokal (bei sync_to_dispo). */
  async function syncProtokollTemplates(dispoBaseUrl) {
    const base = (dispoBaseUrl || '').trim().replace(/\/$/, '');
    if (!base) return;
    const cacheDir = path.join(DB_DIR, 'protokoll_templates');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    for (const lang of ['de', 'en']) {
      const filename = lang === 'en' ? 'Montagebericht_EN.docx' : 'Montagebericht_DE.docx';
      const url = base + '/dispo_api/api/protokoll_template_download.php?language=' + encodeURIComponent(lang);
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0) {
          fs.writeFileSync(path.join(cacheDir, filename), buf);
        }
      } catch (e) {
        console.warn('Protokoll-Vorlage ' + filename + ' Sync fehlgeschlagen:', e.message);
      }
    }
  }

  /** Liest Montagebericht-Vorlage nur aus lokalem Cache oder gebündelten Fallbacks (kein Download zur Laufzeit). */
  function getProtokollTemplateBuffer(language) {
    const lang = (language || 'de').toLowerCase().slice(0, 2);
    const filename = lang === 'en' ? 'Montagebericht_EN.docx' : 'Montagebericht_DE.docx';
    const cacheDir = path.join(DB_DIR, 'protokoll_templates');
    const cachePath = path.join(cacheDir, filename);
    const bundledPath = path.join(__dirname, 'templates', filename);
    const dispoPath = path.join(__dirname, '..', '..', 'dispo', 'assets', 'templates', 'protokoll', filename);

    // Reihenfolge: Cache (nach Sync), Dispo-Workspace, gebündelt (immer verfügbar)
    for (const p of [cachePath, dispoPath, bundledPath]) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p);
        } catch (e) {
          console.warn('Protokoll-Vorlage lesen fehlgeschlagen:', p, e.message);
        }
      }
    }
    return null;
  }

  app.get('/api/protokolle/montagebericht', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(req.query.job_id || req.query.jobId, 10);
      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      const jobRow = db.prepare(`
        SELECT j.id FROM jobs j
        WHERE j.id = ?
          AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
          )
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const dataPath = path.join(reiseDir, 'montagebericht.json');
      if (!fs.existsSync(dataPath)) {
        return res.json({ ok: true, data: null });
      }
      const raw = fs.readFileSync(dataPath, 'utf8');
      const data = JSON.parse(raw);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Daten konnten nicht geladen werden.' });
    }
  });

  app.post('/api/protokolle/montagebericht', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      const language = (body.language || 'de').toLowerCase().slice(0, 2);
      const kopfdaten = body.kopfdaten || {};
      const fabBemerkungen = Array.isArray(body.fabBemerkungen) ? body.fabBemerkungen : [];
      const grundDesEinsatzes = (body.grundDesEinsatzes || '').trim();
      const grundDesEinsatzesHtml = (body.grundDesEinsatzes_html || '').toString().trim();
      const freitext = (body.freitext || '').trim();
      const projektPflicht = (kopfdaten.projekt != null ? String(kopfdaten.projekt) : '').trim();
      if (!projektPflicht) {
        return res.status(400).json({ ok: false, error: 'Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm / manuell).' });
      }

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.server_id, j.status, j.start_datetime, j.end_datetime, j.job_number, j.description, j.fabrikationsnummern,
          c.name AS customer_name, c.street AS cust_street, c.house_number AS cust_house, c.zip AS cust_zip, c.city AS cust_city,
          ja.endkunde, ja.street, ja.house_number, ja.zip, ja.city, ja.country
        FROM jobs j
        INNER JOIN customers c ON c.id = j.customer_id
        LEFT JOIN job_addresses ja ON ja.job_id = j.id
        WHERE j.id = ?
          AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
          )
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const toFab = (f) => (f != null && (typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer))) ? String(typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer)).trim() : '';
      let dbFabRows = [];
      const parsedServerJobId = jobRow.server_id != null ? parseInt(jobRow.server_id, 10) : NaN;
      const hasServerJobId = Number.isFinite(parsedServerJobId) && parsedServerJobId > 0;
      const serverJobId = hasServerJobId ? parsedServerJobId : null;
      if (dispoBaseUrl && hasServerJobId) {
        try {
          const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
          const url = dispoBaseUrl + '/dispo_api/api/montagebericht_data.php?job_id=' + encodeURIComponent(serverJobId) + '&technician_id=' + encodeURIComponent(technicianId);
          const r = await fetch(url, auth ? { headers: auth } : {});
          const apiData = await r.json().catch(() => ({}));
          if (r.ok && Array.isArray(apiData.data) && apiData.data.length > 0) {
            dbFabRows = apiData.data.map((row) => ({
              fabrikationsnummer: String(row.fabrikationsnummer ?? '').trim(),
              type: String(row.type ?? '').trim(),
              position: String(row.position ?? '').trim(),
              textbausteine: Array.isArray(row.textbausteine) ? row.textbausteine.map((t) => ({ text: String(t && t.text != null ? t.text : '').trim() })).filter((t) => t.text) : [],
            })).filter((row) => row.fabrikationsnummer);
          }
        } catch (_) { /* API-Fehler ignorieren */ }
      }
      const rawFab = (jobRow.fabrikationsnummern || '').toString().trim();
      if (rawFab) {
        try {
          const parsed = JSON.parse(rawFab);
          if (Array.isArray(parsed) && parsed.length > 0) {
            dbFabRows = parsed.map((r) => {
              const fn = (r && (r.fabrikationsnummer ?? r.Fabrikationsnummer) != null) ? String(r.fabrikationsnummer ?? r.Fabrikationsnummer).trim() : '';
              const t = (r && typeof r === 'object' && (r.type ?? r.Type) != null) ? String(r.type ?? r.Type).trim() : '';
              const p = (r && typeof r === 'object' && (r.position ?? r.Position) != null) ? String(r.position ?? r.Position).trim() : '';
              return { fabrikationsnummer: fn, type: t, position: p };
            }).filter((r) => r.fabrikationsnummer);
          }
        } catch (_) { /* kein JSON */ }
        if (dbFabRows.length === 0) {
          const parts = rawFab.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
          dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
        }
      }
      if (dbFabRows.length === 0 && dispoBaseUrl) {
        const reqFabs = (kopfdaten.fabrikationsnummern || []).map(toFab).filter(Boolean);
        const reqFabsAlt = (fabBemerkungen || []).map((fb) => toFab(fb)).filter(Boolean);
        const parts = reqFabs.length > 0 ? reqFabs : reqFabsAlt;
        if (parts.length > 0) {
          try {
            const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
            const url = dispoBaseUrl + '/dispo_api/api/anlagenstamm_by_fab.php?fabs=' + encodeURIComponent(parts.join(','));
            const r = await fetch(url, auth ? { headers: auth } : {});
            const data = await r.json().catch(() => ({}));
            if (r.ok && Array.isArray(data.data) && data.data.length > 0) {
              dbFabRows = data.data.map((row) => ({
                fabrikationsnummer: String(row.fabrikationsnummer ?? '').trim(),
                type: String(row.type ?? '').trim(),
                position: String(row.position ?? '').trim(),
              })).filter((row) => row.fabrikationsnummer);
            } else {
              dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
            }
          } catch (_) {
            dbFabRows = parts.map((fn) => ({ fabrikationsnummer: fn, type: '', position: '' }));
          }
        }
      } else if (dbFabRows.length > 0 && dispoBaseUrl) {
        const needsEnrich = dbFabRows.every((r) => !(r.type || r.position));
        if (needsEnrich) {
          try {
            const auth = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
            const fnList = dbFabRows.map((r) => r.fabrikationsnummer).filter(Boolean).join(',');
            const url = dispoBaseUrl + '/dispo_api/api/anlagenstamm_by_fab.php?fabs=' + encodeURIComponent(fnList);
            const r = await fetch(url, auth ? { headers: auth } : {});
            const data = await r.json().catch(() => ({}));
            if (r.ok && Array.isArray(data.data) && data.data.length > 0) {
              const byFn = {};
              for (const row of data.data) {
                const fn = String(row.fabrikationsnummer ?? '').trim();
                if (fn) byFn[fn] = { fabrikationsnummer: fn, type: String(row.type ?? '').trim(), position: String(row.position ?? '').trim() };
              }
              dbFabRows = dbFabRows.map((r) => {
                const enriched = byFn[r.fabrikationsnummer];
                return enriched || r;
              });
            }
          } catch (_) { /* API-Fehler ignorieren */ }
        }
      }
      if (dbFabRows.length === 0) {
        dbFabRows = (kopfdaten.fabrikationsnummern || []).map((f) => {
          const fn = toFab(f);
          const t = (f && typeof f === 'object' && f.type != null) ? String(f.type).trim() : '';
          const p = (f && typeof f === 'object' && f.position != null) ? String(f.position).trim() : '';
          return { fabrikationsnummer: fn, type: t, position: p };
        }).filter((r) => r.fabrikationsnummer);
      }
      if (dbFabRows.length === 0) {
        dbFabRows = (fabBemerkungen || []).map((fb) => {
          const fn = toFab(fb);
          const t = (fb && typeof fb === 'object' && fb.type != null) ? String(fb.type).trim() : '';
          const p = (fb && typeof fb === 'object' && fb.position != null) ? String(fb.position).trim() : '';
          return { fabrikationsnummer: fn, type: t, position: p };
        }).filter((r) => r.fabrikationsnummer);
      }
      let fabs = dbFabRows.map((r) => r.fabrikationsnummer).filter(Boolean);
      if (fabs.length === 0) {
        return res.status(400).json({ ok: false, error: 'Mindestens eine Fabrikationsnummer erforderlich.' });
      }

      const jsonOnly = body.jsonOnly === true || body.saveJsonOnly === true;

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const ordnerName = path.basename(reiseDir);
      const montageberichtDataPath = path.join(reiseDir, 'montagebericht.json');
      const kopfdatenBemerkungen = (kopfdaten && kopfdaten.bemerkungen != null) ? String(kopfdaten.bemerkungen).trim() : '';
      const kopfdatenBemerkungenHtml = (kopfdaten && kopfdaten.bemerkungen_html != null) ? String(kopfdaten.bemerkungen_html).trim() : '';
      writeFileWithRetry(montageberichtDataPath, JSON.stringify({
        grundDesEinsatzes,
        grundDesEinsatzes_html: grundDesEinsatzesHtml,
        fabBemerkungen,
        language,
        bemerkungen: kopfdatenBemerkungen,
        bemerkungen_html: kopfdatenBemerkungenHtml,
        projekt: projektPflicht,
      }, null, 2));

      let syncWarning = null;
      const appendSyncWarning = (msg) => {
        syncWarning = syncWarning ? `${syncWarning}\n\n${msg}` : msg;
      };
      if (dispoBaseUrl && hasServerJobId) {
        const authSync = authHeaderFromCredentials(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
        const syncHeaders = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...(authSync || {}) };
        try {
          const syncUrl = dispoBaseUrl + '/dispo_api/api/anlagenstamm_projekt_job_save.php';
          const syncRes = await fetch(syncUrl, {
            method: 'POST',
            headers: syncHeaders,
            body: JSON.stringify({ technician_id: technicianId, job_id: serverJobId, projekt: projektPflicht }),
          });
          const syncData = await syncRes.json().catch(() => ({}));
          if (!syncRes.ok || !syncData.ok) {
            const msg = 'Projekt: Anlagenstamm auf dem Server konnte nicht angepasst werden: ' + (syncData.error || syncRes.statusText || syncRes.status);
            if (syncRes.status >= 500) console.warn(msg);
            else appendSyncWarning(msg);
          }
        } catch (syncErr) {
          console.warn('Projekt: Dispo für Anlagenstamm-Update nicht erreichbar.');
        }
        const tpRows = (fabBemerkungen || [])
          .map((fb) => {
            const fn = toFab(fb);
            if (!fn) return null;
            const typeVal = (fb && fb.type != null) ? String(fb.type).trim() : '';
            const positionVal = (fb && fb.position != null) ? String(fb.position).trim() : '';
            if (!typeVal && !positionVal) return null;
            return {
              fabrikationsnummer: fn,
              type: typeVal,
              position: positionVal,
            };
          })
          .filter(Boolean);
        if (tpRows.length > 0) {
          try {
            const tpUrl = dispoBaseUrl + '/dispo_api/api/anlagenstamm_type_position_job_save.php';
            const tpRes = await fetch(tpUrl, {
              method: 'POST',
              headers: syncHeaders,
              body: JSON.stringify({ technician_id: technicianId, job_id: serverJobId, rows: tpRows }),
            });
            const tpData = await tpRes.json().catch(() => ({}));
            if (!tpRes.ok || !tpData.ok) {
              const msg = 'Type/Pos.Nr.: Anlagenstamm auf dem Server konnte nicht angepasst werden: ' + (tpData.error || tpRes.statusText || tpRes.status);
              if (tpRes.status >= 500) console.warn(msg);
              else appendSyncWarning(msg);
            }
          } catch (tpErr) {
            console.warn('Type/Pos.Nr.: Dispo für Anlagenstamm-Update nicht erreichbar.');
          }
        }
      }

      if (jsonOnly) {
        return res.json({
          ok: true,
          jsonOnly: true,
          warning: syncWarning || undefined,
        });
      }

      const pdfFilename = ordnerName + '_Montage.pdf';

      const toTextbausteine = (bem) => (bem || '').toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, html: t }));
      const toTextbausteineFromRich = (html, plain) => {
        const rawHtml = (html || '').toString();
        if (rawHtml.trim()) {
          const liMatches = rawHtml.match(/<li[\s\S]*?>[\s\S]*?<\/li>/gi) || [];
          if (liMatches.length > 0) {
            return liMatches
              .map((li) => {
                const inner = li.replace(/^<li[\s\S]*?>/i, '').replace(/<\/li>$/i, '').trim();
                const text = inner.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
                return { text, html: inner };
              })
              .filter((x) => x.text);
          }
          const textFallback = rawHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
          if (textFallback) {
            const splitBullets = textFallback
              .replace(/\u2022/g, '\n• ')
              .split(/\r?\n|(?=\s*[•▪◦●]\s+)/)
              .map((s) => s.replace(/^\s*[•▪◦●\-]\s*/, '').trim())
              .filter(Boolean);
            if (splitBullets.length > 1) return splitBullets.map((t) => ({ text: t, html: t }));
            return [{ text: textFallback.replace(/^\s*[•▪◦●\-]\s*/, '').trim(), html: rawHtml.trim() }];
          }
        }
        return toTextbausteine(plain || '');
      };
      const bemerkungenByFn = {};
      const typePosByFn = {};
      for (const fb of fabBemerkungen || []) {
        const fn = toFab(fb);
        if (fn) {
          typePosByFn[fn] = {
            type: (fb && fb.type != null) ? String(fb.type).trim() : '',
            position: (fb && fb.position != null) ? String(fb.position).trim() : '',
          };
          const explicitTb = Array.isArray(fb.textbausteine) && fb.textbausteine.length > 0
            ? fb.textbausteine
              .map((t) => ({
                text: String(t && t.text != null ? t.text : '').trim(),
                html: String(t && t.html != null ? t.html : (t && t.text != null ? t.text : '')).trim(),
              }))
              .filter((t) => t.text)
            : null;
          const tb = explicitTb && explicitTb.length > 0
            ? explicitTb
            : toTextbausteineFromRich(fb && fb.bemerkungen_html, fb && fb.bemerkungen);
          bemerkungenByFn[fn] = tb;
        }
      }
      const tableRows = dbFabRows.map((row) => {
        const fn = (row.fabrikationsnummer || '').toString().trim();
        const fromForm = typePosByFn[fn];
        const type = (fromForm != null)
          ? String(fromForm.type != null ? fromForm.type : '').trim()
          : (row.type || '').toString().trim();
        const position = (fromForm != null)
          ? String(fromForm.position != null ? fromForm.position : '').trim()
          : (row.position || '').toString().trim();
        const userTb = bemerkungenByFn[fn];
        const tb = (userTb && userTb.length > 0)
          ? userTb
          : (Array.isArray(row.textbausteine)
            ? row.textbausteine
              .map((t) => ({
                text: String(t && t.text != null ? t.text : '').trim(),
                html: String(t && t.html != null ? t.html : (t && t.text != null ? t.text : '')).trim(),
              }))
              .filter((t) => t.text)
            : []);
        const bemerk = tb.map((x) => x.text).join('\n');
        return { fabrikationsnummer: fn, type, position, textbausteine: tb, bemerkungen: bemerk };
      });

      const kopfdatenForDocx = { ...kopfdaten };
      try {
        const contacts = db.prepare('SELECT contact_name, contact_phone, contact_email FROM job_contacts WHERE job_id = ? ORDER BY sort_order, id LIMIT 1').all(localJobId);
        const c = contacts[0];
        if (c && (c.contact_name || c.contact_phone || c.contact_email)) {
          const parts = [c.contact_name, c.contact_phone, c.contact_email].filter((x) => x != null && String(x).trim() !== '');
          kopfdatenForDocx.ansprechperson = parts.join(', ');
        } else {
          kopfdatenForDocx.ansprechperson = '';
        }
      } catch (_) {
        kopfdatenForDocx.ansprechperson = '';
      }

      let docxBytes = null;
      try {
        const { buildMontageberichtDocx } = require('./montagebericht_docx');
        docxBytes = await buildMontageberichtDocx({
          kopfdaten: kopfdatenForDocx,
          tableRows,
          language,
          jobRow,
          grundDesEinsatzes,
          grundDesEinsatzes_html: grundDesEinsatzesHtml,
          freitext,
        });
        if (process.env.MONTAGEBERICHT_DEBUG) {
          const debugPath = path.join(reiseDir, 'Montagebericht_DEBUG.docx');
          fs.writeFileSync(debugPath, docxBytes);
          console.log('[Montagebericht-Debug] DOCX gespeichert unter:', debugPath);
        }
      } catch (docxErr) {
        console.warn('DOCX-Generierung fehlgeschlagen:', docxErr.message);
        if (docxErr.stack) console.warn('Stack:', docxErr.stack);
      }

      let pdfBytes = null;
      if (docxBytes) {
        const os = require('os');
        const tmpDir = os.tmpdir();
        const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const tempDocx = path.join(tmpDir, `montage_${uid}.docx`);
        const tempPdf = path.join(tmpDir, `montage_${uid}.pdf`);
        try {
          fs.writeFileSync(tempDocx, docxBytes);
          const { convert } = require('docx2pdf-converter');
          convert(tempDocx, tempPdf);
          if (fs.existsSync(tempPdf)) {
            pdfBytes = fs.readFileSync(tempPdf);
          }
        } catch (convErr) {
          console.warn('DOCX→PDF-Konvertierung fehlgeschlagen:', convErr && convErr.message ? convErr.message : String(convErr));
          if (convErr && convErr.stack) console.warn('Stack:', convErr.stack);
        } finally {
          try { if (fs.existsSync(tempDocx)) fs.unlinkSync(tempDocx); } catch (_) { /* ignore */ }
          try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch (_) { /* ignore */ }
        }
      }

      if (!docxBytes) {
        return res.status(500).json({ ok: false, error: 'DOCX konnte nicht erstellt werden.' });
      }
      if (!pdfBytes) {
        const hint = process.platform === 'win32'
          ? 'Bitte Microsoft Word installieren. Unter Windows wird Word für die PDF-Konvertierung verwendet.'
          : process.platform === 'darwin'
            ? 'Bitte Microsoft Word installieren (macOS).'
            : 'Bitte LibreOffice oder unoconv installieren (Linux).';
        return res.status(500).json({
          ok: false,
          error: `PDF konnte nicht aus dem DOCX erzeugt werden. ${hint}`,
        });
      }

      const docAnlageBase = path.join(reiseDir, 'Dokumente_Anlage');
      const docxFilename = ordnerName + '_Montage.docx';

      // Pro FN nur einen Zielordner: vorhandenen Sammelordner (z. B. "11952 - 11958") nutzen, sonst Einzel-FN-Ordner. Bericht nur einmal pro eindeutigem Ordner speichern.
      const targetFolderNames = new Set();
      for (const fab of fabs) {
        const fnNum = parseInt(String(fab).trim(), 10);
        const existingFolder = Number.isFinite(fnNum) ? findParameterlistenFolder(docAnlageBase, fnNum) : null;
        const folderName = existingFolder != null ? existingFolder : sanitizeDienstreiseFolderPart(fab);
        targetFolderNames.add(folderName);
      }
      for (const folderName of targetFolderNames) {
        const montageDir = path.join(docAnlageBase, folderName, 'Montage');
        if (!fs.existsSync(montageDir)) {
          const docFabDir = path.join(docAnlageBase, folderName);
          if (!fs.existsSync(docFabDir)) fs.mkdirSync(docFabDir, { recursive: true });
          fs.mkdirSync(montageDir, { recursive: true });
        }
        writeFileWithRetry(path.join(montageDir, pdfFilename), pdfBytes);
        if (docxBytes) {
          writeFileWithRetry(path.join(montageDir, docxFilename), docxBytes);
        }
      }

      res.json({
        ok: true,
        jsonOnly: false,
        warning: syncWarning || undefined,
        saved: fabs.map((f) => path.join('Dokumente_Anlage', sanitizeDienstreiseFolderPart(f), 'Montage', pdfFilename)),
        savedDocx: docxBytes ? fabs.map((f) => path.join('Dokumente_Anlage', sanitizeDienstreiseFolderPart(f), 'Montage', docxFilename)) : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Montagebericht konnte nicht erstellt werden.' });
    }
  });

  app.post('/api/kontrollwiegungsprotokoll_save', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const dispoBaseUrl = (body.base_url || body.dispoBaseUrl || body.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !dispoBaseUrl) {
        return res.status(400).json({ ok: false, error: 'base_url und technician_id erforderlich.' });
      }
      const auth = authHeaderFromCredentials(body.serverUsername || body.dispoUsername, body.serverPassword ?? body.dispoPassword);
      const url = dispoBaseUrl + '/dispo_api/api/kontrollwiegungsprotokoll_save.php';
      const payload = {
        technician_id: body.technician_id != null ? body.technician_id : technicianId,
        job_id: body.job_id,
        fabrikationsnummer: body.fabrikationsnummer,
        durchfuehrungsdatum: body.durchfuehrungsdatum,
        wiegungen: Array.isArray(body.wiegungen) ? body.wiegungen : [],
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.get('/api/kontrollwiegungsprotokoll_pdf', async (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const protokollId = parseInt(req.query.id, 10);
      const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
      if (!technicianId || !protokollId || !baseUrl) {
        return res.status(400).json({ ok: false, error: 'id, base_url und technician_id erforderlich.' });
      }
      const url = baseUrl + '/dispo_api/api/kontrollwiegungsprotokoll_pdf.php?id=' + encodeURIComponent(protokollId) + '&technician_id=' + encodeURIComponent(technicianId);
      const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
      const r = await fetch(url, { headers: { 'X-Technician-Id': String(technicianId), ...auth } });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: r.statusText });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="Kontrollwiegungsprotokoll.pdf"');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Fabrikationsnummer aus Dateiname extrahieren (z. B. FN11952_PA7_… → 11952). */
  function extractFnFromFilename(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const m = filename.match(/FN(\d+)/i) || filename.match(/(\d{4,})/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Zahlen-FN aus jobs.fabrikationsnummern (JSON-Leistungszeilen oder Fallback Split-Liste). */
  function fabNumbersFromJobFabrikationsnummern(raw) {
    const set = new Set();
    const addNum = (v) => {
      const d = String(v || '').replace(/\D/g, '');
      if (!d) return;
      const n = parseInt(d, 10);
      if (Number.isFinite(n) && n > 0) set.add(n);
    };
    if (raw == null || raw === '') return set;
    const s = String(raw).trim();
    if (!s) return set;
    try {
      const parsed = JSON.parse(s);
      const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const fab = row.fabrikationsnummer != null ? row.fabrikationsnummer : row.Fabrikationsnummer;
        addNum(fab);
      }
      if (set.size > 0) return set;
    } catch (_) {
      /* kein JSON */
    }
    for (const part of s.split(/[\s;,]+/)) {
      if (part.trim()) addNum(part);
    }
    return set;
  }

  /**
   * Findet den vorhandenen Anlagenordner für eine FN unter Dokumente_Anlage.
   * Möglichkeit 1: Ordner = eine FN (exakt).
   * Möglichkeit 2/3: Ordner = Bereich "von - bis"; mit oder ohne Leerzeichen, Endzahl gekürzt möglich.
   * Beispiele: 11952 - 11958, 11952-11958, 11952-58, 11952 - 58.
   * Gibt den Ordnernamen zurück oder null.
   */
  function findParameterlistenFolder(docAnlagePath, fn) {
    if (fn == null || fn === '' || !Number.isFinite(fn)) return null;
    const fnNum = parseInt(fn, 10);
    if (!fs.existsSync(docAnlagePath) || !fs.statSync(docAnlagePath).isDirectory()) return null;
    let names;
    try {
      names = fs.readdirSync(docAnlagePath, { withFileTypes: true });
    } catch (e) {
      return null;
    }
    const dirs = names.filter((e) => e.isDirectory() && !isIgnorableDirEntry(e.name)).map((e) => e.name);

    for (const dirName of dirs) {
      if (dirName.includes(' - ')) continue;
      const digitsOnly = dirName.replace(/\D/g, '');
      if (digitsOnly && parseInt(digitsOnly, 10) === fnNum) return dirName;
    }

    const rangeRe = /(\d+)\s*-\s*(\d+)/;
    for (const dirName of dirs) {
      const m = dirName.match(rangeRe);
      if (!m) continue;
      let from = parseInt(m[1], 10);
      let to = parseInt(m[2], 10);
      const fromStr = m[1];
      const toStr = m[2];
      if (toStr.length < fromStr.length) {
        const prefix = fromStr.slice(0, fromStr.length - toStr.length);
        to = parseInt(prefix + toStr, 10);
      }
      if (fnNum >= from && fnNum <= to) return dirName;
    }
    return null;
  }

  app.post('/api/protokolle/parameterlisten', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = getTechnicianId(req);
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const filename = (body.filename || '').toString().trim();
      const contentBase64 = body.content;

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }
      if (!filename || !contentBase64) {
        return res.status(400).json({ ok: false, error: 'filename und content (base64) erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.status, j.fabrikationsnummern FROM jobs j
        WHERE j.id = ?
          AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
          )
      `).get(localJobId, technicianId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }
      const blocked = localJobWriteBlocked(jobRow.status);
      if (blocked) {
        return res.status(blocked.status).json({ ok: false, error: blocked.error });
      }

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const docAnlagePath = path.join(reiseDir, 'Dokumente_Anlage');
      const fn = extractFnFromFilename(filename);
      if (fn == null) {
        return res.status(400).json({ ok: false, error: 'Im Dateinamen konnte keine Fabrikationsnummer erkannt werden (z. B. FN11952).' });
      }

      const fnAllowedOnJob = fabNumbersFromJobFabrikationsnummern(jobRow.fabrikationsnummern).has(fn);
      let folderName = findParameterlistenFolder(docAnlagePath, fn);
      if (!folderName && fnAllowedOnJob) {
        folderName = String(fn);
      }
      if (!folderName) {
        return res.status(400).json({
          ok: false,
          error:
            'FN passt nicht zum Auftrag (Fabrikationsnummer in den Projektdaten prüfen; Dateiname z. B. FN12186_….csv).',
        });
      }

      const paramDir = path.join(docAnlagePath, folderName, 'Montage', 'Parameter');
      try {
        if (!fs.existsSync(paramDir)) fs.mkdirSync(paramDir, { recursive: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'Ordner konnte nicht angelegt werden: ' + (e.message || e) });
      }

      let csvBuffer;
      try {
        csvBuffer = Buffer.from(contentBase64, 'base64');
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Ungültiger Base64-Inhalt.' });
      }
      const csvPath = path.join(paramDir, filename);
      writeFileWithRetry(csvPath, csvBuffer);

      let csvText = csvBuffer.toString('utf8');
      if (!csvText || /[\uFFFD]/.test(csvText)) {
        csvText = csvBuffer.toString('latin1');
      }

      const csvToPdfBuffer = getCsvToPdfBuffer();
      const pdfBytes = await csvToPdfBuffer(csvText, { filename });
      const pdfBasename = filename.replace(/\.csv$/i, '') + '.pdf';
      const pdfPath = path.join(paramDir, pdfBasename);
      writeFileWithRetry(pdfPath, pdfBytes);

      const savedCsv = path.join('Dokumente_Anlage', folderName, 'Montage', 'Parameter', filename);
      const savedPdf = path.join('Dokumente_Anlage', folderName, 'Montage', 'Parameter', pdfBasename);
      res.json({ ok: true, savedCsv, savedPdf });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Parameterlisten-Upload fehlgeschlagen.' });
    }
  });

  app.get('/api/textbausteine_list', async (req, res) => {
    const baseUrl = (req.query.base_url || req.query.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req);
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl erforderlich.' });
    try {
      const url = baseUrl + '/dispo_api/api/textbausteine_list.php?technician_id=' + encodeURIComponent(technicianId || 0);
      const r = await fetch(url, { headers: { 'X-Technician-Id': String(technicianId || 0) } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || 'Fehler' });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/textbausteine_category_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('technician_id', String(technicianId || 0));
      if (body.id) formBody.append('id', body.id);
      formBody.append('name', body.name || '');
      formBody.append('sort_order', body.sort_order || 0);
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_save.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(technicianId || 0) },
        body: formBody.toString(),
      });
      const raw = await r.text();
      let data = {};
      try { data = JSON.parse(raw); } catch (_) { /* keine JSON-Antwort */ }
      if (!r.ok) {
        const err = data.ok === false && data.error ? data.error
          : r.status === 404 ? 'Dispo-API nicht gefunden (404). Prüfen Sie die Dispo-URL in den Einstellungen.'
          : r.status >= 500 ? 'Dispo-Serverfehler (HTTP ' + r.status + ').'
          : 'HTTP ' + r.status + (raw && raw.length < 200 ? ': ' + raw.replace(/\s+/g, ' ').slice(0, 100) : '');
        return res.status(r.status).json({ ok: false, error: err });
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/textbausteine_category_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!baseUrl || !body.id) return res.status(400).json({ ok: false, error: 'baseUrl und id erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('id', body.id);
      formBody.append('technician_id', String(technicianId || 0));
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_delete.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(technicianId || 0) },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || 'Fehler' });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/textbausteine_publish_global', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!baseUrl || body.item_id == null) return res.status(400).json({ ok: false, error: 'baseUrl und item_id erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('technician_id', String(technicianId || 0));
      formBody.append('item_id', String(body.item_id));
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_publish_global.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(technicianId || 0) },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || 'Fehler' });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/textbausteine_save', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    const technicianId = getTechnicianId(req) || body.technician_id;
    if (!baseUrl || !body.category_id || body.text === undefined) return res.status(400).json({ ok: false, error: 'baseUrl, category_id und text erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('technician_id', String(technicianId || 0));
      if (body.id) formBody.append('id', body.id);
      formBody.append('category_id', body.category_id);
      formBody.append('text', body.text);
      formBody.append('sort_order', body.sort_order || 0);
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_save.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Technician-Id': String(technicianId || 0) },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || 'Fehler' });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/textbausteine_delete', express.json(), async (req, res) => {
    const body = req.body || {};
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!baseUrl || !body.id) return res.status(400).json({ ok: false, error: 'baseUrl und id erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('id', body.id);
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_delete.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || 'Fehler' });
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  /** Fabrikationsnummern dürfen auch bei „angelegt/geplant/zugeteilt“ gesetzt werden (vor „Auftrag annehmen“). */
  function getLocalJobMetaForFabrikationsnummernPatch(dbConn, technicianId, rawJobId) {
    const n = parseInt(rawJobId, 10);
    if (!Number.isFinite(n)) return { error: 'job_id ungültig.', status: 400 };
    const row = dbConn.prepare(`
      SELECT j.id, j.status FROM jobs j
      WHERE (j.id = ? OR CAST(j.server_id AS TEXT) = CAST(? AS TEXT))
        AND (
          EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.technician_id = ?)
          OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
        )
    `).get(n, n, technicianId);
    if (!row) return { error: 'Auftrag nicht gefunden.', status: 404 };
    const s = String(row.status || '').trim().toLowerCase();
    if (s === 'abgerechnet') {
      return { error: 'Auftrag ist abgerechnet – Bearbeitung in der App nicht erlaubt.', status: 403 };
    }
    return { localId: row.id };
  }

  app.patch('/api/job', express.json(), (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const { job_id, status, description, fabrikationsnummern, hotel_selection } = body;
    if (!technicianId || !job_id) {
      return res.status(400).json({ ok: false, error: 'technician_id und job_id erforderlich.' });
    }
    const fabOnlyPatch = fabrikationsnummern !== undefined
      && status === undefined
      && description === undefined
      && !hotel_selection
      && !['hotel_endkunde', 'hotel_street', 'hotel_house_number', 'hotel_zip', 'hotel_city', 'hotel_country', 'hotel_address_extra_1', 'hotel_address_extra_2', 'hotel_phone', 'hotel_email', 'hotel_website', 'hotel_comment', 'hotel_rating_stars'].some((k) => Object.prototype.hasOwnProperty.call(body, k));
    const gate = fabOnlyPatch
      ? getLocalJobMetaForFabrikationsnummernPatch(db, technicianId, job_id)
      : getWritableLocalJobMetaForPatch(db, technicianId, job_id);
    if (gate.error) {
      return res.status(gate.status).json({ ok: false, error: gate.error });
    }
    const effectiveJobId = gate.localId;
    const allowed = ['angelegt', 'zugeteilt', 'in_arbeit', 'erledigt', 'abgerechnet', 'geplant'];
    const hotelKeys = ['hotel_endkunde', 'hotel_street', 'hotel_house_number', 'hotel_zip', 'hotel_city', 'hotel_country', 'hotel_address_extra_1', 'hotel_address_extra_2', 'hotel_phone', 'hotel_email', 'hotel_website', 'hotel_comment', 'hotel_rating_stars'];
    const hasHotelPayload = hotelKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    try {
      if (hasHotelPayload) {
        const hotelPayload = {};
        hotelKeys.forEach((k) => { hotelPayload[k] = body[k] != null ? String(body[k]) : ''; });
        const jha = db.prepare('SELECT job_id FROM job_hotel_addresses WHERE job_id = ?').get(effectiveJobId);
        const endkunde = hotelPayload.hotel_endkunde || null;
        const street = hotelPayload.hotel_street || '';
        const house_number = hotelPayload.hotel_house_number || '';
        const zip = hotelPayload.hotel_zip || '';
        const city = hotelPayload.hotel_city || '';
        const country = hotelPayload.hotel_country || null;
        const address_extra_1 = hotelPayload.hotel_address_extra_1 || null;
        const address_extra_2 = hotelPayload.hotel_address_extra_2 || null;
        const phone = hotelPayload.hotel_phone || null;
        const email = hotelPayload.hotel_email || null;
        const website = hotelPayload.hotel_website || null;
        if (jha) {
          db.prepare('UPDATE job_hotel_addresses SET endkunde=?, street=?, house_number=?, zip=?, city=?, country=?, address_extra_1=?, address_extra_2=?, phone=?, email=?, website=? WHERE job_id=?').run(endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website, effectiveJobId);
        } else {
          db.prepare('INSERT INTO job_hotel_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(effectiveJobId, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website);
        }
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'hotel_address', JSON.stringify(hotelPayload));
        save();
        return res.json({ ok: true, updated: 'hotel_address' });
      }
      if (hotel_selection && typeof hotel_selection === 'object') {
        const hotelId = Number(hotel_selection.hotel_id || 0);
        if (!Number.isFinite(hotelId) || hotelId <= 0) {
          return res.status(400).json({ ok: false, error: 'hotel_selection.hotel_id fehlt oder ungültig.' });
        }
        const comment = hotel_selection.comment != null ? String(hotel_selection.comment) : null;
        let ratingStars = null;
        if (Object.prototype.hasOwnProperty.call(hotel_selection, 'rating_stars') && hotel_selection.rating_stars !== null && hotel_selection.rating_stars !== '') {
          ratingStars = Math.max(0, Math.min(5, Number(hotel_selection.rating_stars)));
          if (!Number.isFinite(ratingStars)) ratingStars = null;
        }
        const ratingAvg = hotel_selection.rating_avg != null ? Number(hotel_selection.rating_avg) : null;
        const ratingCount = hotel_selection.rating_count != null ? Number(hotel_selection.rating_count) : 0;
        db.prepare(`
          INSERT INTO job_hotel_selection (job_id, hotel_id, comment, rating_stars, rating_avg, rating_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(job_id) DO UPDATE SET
            hotel_id=excluded.hotel_id,
            comment=excluded.comment,
            rating_stars=excluded.rating_stars,
            rating_avg=excluded.rating_avg,
            rating_count=excluded.rating_count,
            updated_at=datetime('now')
        `).run(effectiveJobId, hotelId, comment, ratingStars, ratingAvg, ratingCount);
        db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'hotel_selection', JSON.stringify({ hotel_selection: { hotel_id: hotelId, comment: comment, rating_stars: ratingStars } }));
        save();
        return res.json({ ok: true, updated: 'hotel_selection' });
      }
      if (status && allowed.includes(status)) {
        const r = db.prepare(`
          UPDATE jobs SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = jobs.id)
          )
        `).run(status, effectiveJobId, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'status', JSON.stringify({ status }));
          save();
          return res.json({ ok: true, updated: 'status' });
        }
      }
      if (description !== undefined) {
        const r = db.prepare(`
          UPDATE jobs SET description = ?, updated_at = datetime('now')
          WHERE id = ? AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = jobs.id)
          )
        `).run(description, effectiveJobId, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'description', JSON.stringify({ description }));
          save();
          return res.json({ ok: true, updated: 'description' });
        }
      }
      if (fabrikationsnummern !== undefined) {
        let val = typeof fabrikationsnummern === 'string' ? fabrikationsnummern : (fabrikationsnummern != null ? JSON.stringify(fabrikationsnummern) : null);
        if (val != null) val = clampFabrikationsnummernJson(val);
        const r = db.prepare(`
          UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now')
          WHERE id = ? AND (
            EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id AND jt.technician_id = ?)
            OR NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = jobs.id)
          )
        `).run(val, effectiveJobId, technicianId);
        if (r.changes) {
          db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'fabrikationsnummern'`).run(
            effectiveJobId,
          );
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', effectiveJobId, 'fabrikationsnummern', JSON.stringify({ fabrikationsnummern: val }));
          save();
          return res.json({ ok: true, updated: 'fabrikationsnummern', pending_sync: true });
        }
      }
      res.status(400).json({ ok: false, error: 'Status-Update fehlgeschlagen oder keine Berechtigung.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/my_absences', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    let sql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment FROM absences WHERE technician_id = ?';
    const params = [technicianId];
    if (dateFrom) { sql += ' AND end_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { sql += ' AND start_datetime <= ?'; params.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY start_datetime ASC';
    const rows = db.prepare(sql).all(...params);
    const byKey = new Map();
    rows.forEach((r) => byKey.set(absencePeriodDedupeKey(r.technician_id, r.start_datetime, r.end_datetime), true));
    // Genehmigte und ausstehende Abwesenheitsanfragen mit anzeigen (z. B. eigene Abwesenheit in Einzeltechniker-Ansicht)
    let reqSql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment, status FROM absence_requests WHERE technician_id = ? AND status IN (\'approved\', \'pending\')';
    const reqParams = [technicianId];
    if (dateFrom) { reqSql += ' AND end_datetime >= ?'; reqParams.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { reqSql += ' AND start_datetime <= ?'; reqParams.push(dateTo + ' 23:59:59'); }
    reqSql += ' ORDER BY start_datetime ASC';
    const requests = db.prepare(reqSql).all(...reqParams);
    requests.forEach((r) => {
      const key = absencePeriodDedupeKey(r.technician_id, r.start_datetime, r.end_datetime);
      if (!byKey.has(key)) {
        byKey.set(key, true);
        rows.push({ id: r.id, server_id: r.server_id, technician_id: r.technician_id, start_datetime: r.start_datetime, end_datetime: r.end_datetime, type: r.type, comment: r.comment != null ? r.comment : null, from_absence_request: true, status: r.status });
      }
    });
    rows.sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')));
    res.json({ ok: true, technician_id: technicianId, absences: rows });
  });

  app.post('/api/job_file', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const jobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const fileId = parseInt(body.file_id != null ? body.file_id : body.server_id != null ? body.server_id : body.id, 10);
      const keepLocal = body.keep_local != null ? (body.keep_local ? 1 : 0) : null;
      if (!jobId || !fileId) {
        return res.status(400).json({ ok: false, error: 'job_id und file_id erforderlich.' });
      }
      if (keepLocal === null) {
        return res.status(400).json({ ok: false, error: 'keep_local (0 oder 1) erforderlich.' });
      }
      try {
        const r = db.prepare('UPDATE job_files SET keep_local = ? WHERE job_id = ? AND (id = ? OR server_id = ?)').run(keepLocal, jobId, fileId, fileId);
        if (r.changes === 0) {
          db.prepare('INSERT OR IGNORE INTO job_files (id, job_id, server_id, keep_local) VALUES (?, ?, ?, ?)').run(fileId, jobId, fileId, keepLocal);
        }
        res.json({ ok: true, keep_local: keepLocal });
      } catch (e) {
        if (e.message && (e.message.includes('no such table') || e.message.includes('job_files'))) {
          return res.status(501).json({ ok: false, error: 'Tabelle job_files nicht vorhanden.' });
        }
        throw e;
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Aktualisierung fehlgeschlagen.' });
    }
  });

  app.get('/api/my_absence_requests', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const rows = db.prepare('SELECT id, server_id, technician_id, start_datetime, end_datetime, type, comment, status, requested_at, synced_at FROM absence_requests WHERE technician_id = ? ORDER BY requested_at DESC').all(technicianId);
    res.json({ ok: true, technician_id: technicianId, requests: rows });
  });

  app.post('/api/absence_requests_cleanup_errors', (req, res) => {
    const technicianId = getTechnicianId(req);
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    const r = db.prepare('DELETE FROM absence_requests WHERE technician_id = ? AND status = ?').run(technicianId, 'error');
    save();
    res.json({ ok: true, deleted: r.changes });
  });

  app.delete('/api/absence_request', (req, res) => {
    try {
      const technicianId = getTechnicianId(req);
      const id = parseInt(req.query.id, 10) || parseInt((req.body || {}).id, 10) || 0;
      if (!technicianId || !id) {
        return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
      }
      const r = db.prepare('DELETE FROM absence_requests WHERE id = ? AND technician_id = ?').run(id, technicianId);
      if (r.changes) {
        save();
        return res.json({ ok: true });
      }
      return res.status(404).json({ ok: false, error: 'Anfrage nicht gefunden.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/absence_request', (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const start = body.start_datetime || body.start || body.date_from || '';
    const end = body.end_datetime || body.end || body.date_to || '';
    const type = body.type || body.reason || null;
    let comment = body.comment != null && String(body.comment).trim() !== '' ? String(body.comment).trim() : null;
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : String(v).trim();
    const startNorm = norm(start);
    const endNorm = norm(end);
    try {
      const r = db.prepare('INSERT INTO absence_requests (technician_id, start_datetime, end_datetime, type, comment, status) VALUES (?, ?, ?, ?, ?, ?)').run(technicianId, startNorm, endNorm, type || null, comment, 'pending');
      const localId = r.lastInsertRowid;
      save();
      if (baseUrl) {
        const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) };
        const auth = authHeaderFromCredentials(body.serverUsername, body.serverPassword);
        if (auth) header.Authorization = auth.Authorization;
        fetch(baseUrl + '/api/absence_request.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify({ technician_id: technicianId, start_datetime: startNorm, end_datetime: endNorm, type: type || null, comment: comment }),
        }).then(async (resp) => {
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.ok && data.id) {
            db.prepare('UPDATE absence_requests SET server_id = ?, synced_at = datetime(\'now\') WHERE id = ?').run(data.id, localId);
            save();
          } else if (resp.status >= 400 && resp.status < 500) {
            // Dauerhafter fachlicher Fehler (z. B. „Kein gültiger Monteur“): nicht endlos pending lassen.
            logAbsenceRequestError({ context: 'immediate', status: resp.status, body: data, technicianId, baseUrl });
            db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE id = ?').run('error', localId);
            save();
          }
        }).catch(() => {
          // Verbindungsfehler: Eintrag bleibt pending und wird beim nächsten Sync erneut versucht.
        });
      }
      res.json({ ok: true, id: localId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/events', (req, res) => {
    const technicianId = getTechnicianId(req);
    const baseUrl = req.query.base_url || req.query.baseUrl || '';
    if (!technicianId) {
      return res.status(400).json({ ok: false, error: 'technician_id fehlt.' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    if (!sseClients.has(technicianId)) sseClients.set(technicianId, new Set());
    sseClients.get(technicianId).add(res);
    connectPushForTechnician(technicianId, baseUrl);
    req.on('close', () => {
      const set = sseClients.get(technicianId);
      if (set) {
        set.delete(res);
        if (set.size === 0) {
          sseClients.delete(technicianId);
          const ws = pushWsByTechnician.get(technicianId);
          if (ws) { ws.close(); pushWsByTechnician.delete(technicianId); }
        }
      }
    });
  });

  app.post('/api/absence', (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const start = body.start_datetime || body.start || body.date_from || '';
    const end = body.end_datetime || body.end || body.date_to || '';
    const type = body.type || null;
    const comment = body.comment != null && String(body.comment).trim() !== '' ? String(body.comment).trim() : null;
    if (!technicianId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : v.trim();
    try {
      const r = db.prepare('INSERT INTO absences (technician_id, start_datetime, end_datetime, type, comment) VALUES (?, ?, ?, ?, ?)').run(technicianId, norm(start), norm(end), type || '', comment);
      const id = r.lastInsertRowid;
      db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', id, 'create', JSON.stringify({ start_datetime: norm(start), end_datetime: norm(end), type, comment }));
      save();
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/absence', (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const id = body.id || parseInt(req.query.id, 10) || 0;
    const start = body.start_datetime || body.start || body.date_from || '';
    const end = body.end_datetime || body.end || body.date_to || '';
    const type = body.type || null;
    const hasComment = Object.prototype.hasOwnProperty.call(body, 'comment');
    const comment = hasComment && body.comment != null && String(body.comment).trim() !== '' ? String(body.comment).trim() : (hasComment ? null : undefined);
    if (!technicianId || !id || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : v.trim();
    try {
      let r;
      if (hasComment) {
        r = db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ?, comment = ? WHERE id = ? AND technician_id = ?').run(norm(start), norm(end), type || '', comment, id, technicianId);
      } else {
        r = db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ? WHERE id = ? AND technician_id = ?').run(norm(start), norm(end), type || '', id, technicianId);
      }
      if (r.changes) {
        const pl = { start_datetime: norm(start), end_datetime: norm(end), type: type || '' };
        if (hasComment) pl.comment = comment;
        db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', id, 'update', JSON.stringify(pl));
        save();
        return res.json({ ok: true });
      }
      res.status(404).json({ ok: false, error: 'Abwesenheit nicht gefunden.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/absence', async (req, res) => {
    const technicianId = getTechnicianId(req);
    const body = req.body || {};
    const id = parseInt(req.query.id, 10) || parseInt(body.id, 10) || 0;
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !id) {
      return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
    }
    try {
      const row = db.prepare('SELECT server_id FROM absences WHERE id = ? AND technician_id = ?').get(id, technicianId);
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Abwesenheit nicht gefunden.' });
      }
      const serverId = row.server_id != null && row.server_id !== '' ? row.server_id : null;
      if (baseUrl && serverId != null) {
        const auth = authHeaderFromCredentials(body.serverUsername, body.serverPassword);
        const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...(auth || {}) };
        try {
          const delRes = await fetch(`${baseUrl}/api/absence.php?id=${encodeURIComponent(serverId)}&technician_id=${encodeURIComponent(technicianId)}`, { method: 'DELETE', headers: header });
          if (!delRes.ok) {
            const errText = await delRes.text();
            return res.status(502).json({ ok: false, error: 'Dispo-Löschen fehlgeschlagen: ' + (errText.slice(0, 80) || delRes.status) });
          }
        } catch (e) {
          return res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + (e.message || String(e)) });
        }
      } else if (serverId != null) {
        db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', serverId, 'delete', '{}');
      }
      db.prepare('DELETE FROM absences WHERE id = ? AND technician_id = ?').run(id, technicianId);
      save();
      return res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/pending_changes', (req, res) => {
    const rows = db.prepare('SELECT * FROM pending_changes ORDER BY id').all();
    res.json({ ok: true, pending: rows });
  });

  function authHeaderFromCredentials(username, password) {
    const u = (username || '').toString().trim();
    if (!u) return undefined;
    const p = (password || '').toString();
    return { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
  }

  /** Apache/FPM liefert Authorization oft nicht an PHP — Dispo require_login.php liest X-Kukla-Authorization. */
  function dispoMonteurFetchHeaders(technicianId, authHeader) {
    const h = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
    const a = authHeader && authHeader.Authorization;
    if (a) {
      h['X-Kukla-Authorization'] = a;
    }
    return h;
  }

  /** Basic vom Browser an 127.0.0.1 (kein Passwort in der Query); Fallback Query für Alt-Clients. */
  function authHeaderFromIncomingBasicOrQuery(req) {
    const raw = req.headers && req.headers.authorization;
    if (raw && /^\s*Basic\s+/i.test(String(raw))) {
      try {
        const b64 = String(raw).replace(/^\s*Basic\s+/i, '').trim();
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const u = colon >= 0 ? decoded.slice(0, colon) : decoded;
        const p = colon >= 0 ? decoded.slice(colon + 1) : '';
        return authHeaderFromCredentials(u, p);
      } catch (_) {
        /* Query-Fallback */
      }
    }
    const q = req.query || {};
    return authHeaderFromCredentials(q.serverUsername || q.server_username, q.serverPassword ?? q.server_password);
  }

  registerAbrechnungRoutes(app, {
    db,
    save,
    dbDir: DB_DIR,
    authHeaderFromCredentials,
    authHeaderFromIncomingBasicOrQuery,
  });

  const abrechnungRefreshCtx = { db, save, dbDir: DB_DIR, authHeaderFromCredentials };

  function fingerprintDispoBase(urlRaw) {
    const base = (urlRaw || '').trim().replace(/\/$/, '');
    return crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 24);
  }

  function combineAbortSignals(a, b) {
    if (!b) return a;
    if (!a) return b;
    if (a.aborted || b.aborted) {
      const ac = new AbortController();
      ac.abort();
      return ac.signal;
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return ac.signal;
  }

  async function executeBackgroundJob(job, helpers) {
    const { signal, setProgress, mergeCheckpoint, readCheckpoint } = helpers;
    switch (job.type) {
      case 'dienstreise_pull': {
        const p = job.payload || {};
        const rawJobId = parseInt(p.job_id, 10);
        const dispoBaseUrl = (p.dispo_base_url || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technician_id, 10);
        const includeBilder = !!p.include_bilder;
        const acceptJob = !!p.accept_job;
        const dispoUsername = (p.dispo_username || '').trim();
        const dispoPassword = p.dispo_password != null ? String(p.dispo_password) : '';
        if (!rawJobId || !dispoBaseUrl || !technicianId) throw new Error('dienstreise_pull: job_id, dispo_base_url und technician_id erforderlich.');
        const authHeader =
          dispoUsername || dispoPassword
            ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') }
            : {};
        if (!authHeader.Authorization) throw new Error('Dispo-Zugangsdaten fehlen.');
        const jobRowFull = getJobRowWithStatusByLocalOrServerId(rawJobId);
        if (!jobRowFull) throw new Error('Auftrag nicht gefunden.');
        const localJobId = jobRowFull.id;
        const serverJobId = jobRowFull.server_id != null ? jobRowFull.server_id : jobRowFull.id;
        const targetDir = getOrCreateDienstreiseFolderForJob(localJobId);
        if (!targetDir || !fs.existsSync(targetDir)) throw new Error('Zielordner konnte nicht erstellt werden.');
        const fp = fingerprintDispoBase(dispoBaseUrl);
        let chk = readCheckpoint();
        if (chk.dispo_base_fingerprint && chk.dispo_base_fingerprint !== fp) {
          throw new Error('Dispo-Basis-URL hat sich geändert — Kopie nicht automatisch fortgesetzt.');
        }
        if (chk.server_job_id != null && Number(chk.server_job_id) !== Number(serverJobId)) {
          throw new Error('Server-Auftrags-ID hat sich geändert — Checkpoint verworfen.');
        }
        const refreshAge = chk.refresh_done_at ? Date.now() - new Date(chk.refresh_done_at).getTime() : Infinity;
        const skipRefresh = !!(chk.refresh_done_at && refreshAge < 15 * 60 * 1000 && chk.dispo_base_fingerprint === fp);
        setProgress('refresh', 0, 1, skipRefresh ? 'Dispo-Refresh (Checkpoint, TTL).' : 'Dispo wird aktualisiert …');
        if (!skipRefresh) {
          const refreshUrl = dispoBaseUrl + '/api/job_project_refresh.php';
          const refreshTimeoutMs = 60000;
          const refreshAbort = new AbortController();
          const refreshTimeoutId = setTimeout(() => refreshAbort.abort(), refreshTimeoutMs);
          try {
            const refreshRes = await fetch(refreshUrl, {
              method: 'POST',
              signal: combineAbortSignals(signal, refreshAbort.signal),
              headers: Object.assign({ 'Content-Type': 'application/json' }, dispoMonteurFetchHeaders(technicianId, authHeader)),
              body: JSON.stringify({ job_id: serverJobId, technician_id: technicianId, include_bilder: includeBilder }),
            });
            const refreshData = await refreshRes.json().catch(() => ({}));
            if (!refreshRes.ok || (refreshData && refreshData.ok === false)) {
              throw new Error(
                (refreshData && refreshData.error)
                  ? String(refreshData.error)
                  : 'Dispo-Aktualisierung fehlgeschlagen (HTTP ' + refreshRes.status + ').',
              );
            }
          } finally {
            clearTimeout(refreshTimeoutId);
          }
          mergeCheckpoint({
            refresh_done_at: new Date().toISOString(),
            dispo_base_fingerprint: fp,
            server_job_id: serverJobId,
            local_job_id: localJobId,
          });
        } else {
          mergeCheckpoint({
            dispo_base_fingerprint: fp,
            server_job_id: serverJobId,
            local_job_id: localJobId,
          });
        }
        setProgress('refresh_done', 1, 1, 'Liste und Downloads …');
        chk = readCheckpoint();

        async function listEntries(relPath) {
          const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
          const url =
            dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + serverJobId + pathQ;
          const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader), signal });
          const text = await r.text();
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_) {
            throw new Error('Dispo-Liste: ungültige Antwort (' + r.status + '): ' + text.slice(0, 160));
          }
          if (!r.ok || data.ok === false) {
            throw new Error((data && data.error) ? String(data.error) : 'Dispo-Liste fehlgeschlagen (HTTP ' + r.status + ').');
          }
          return Array.isArray(data.entries) ? data.entries : [];
        }

        async function collectManifest(relPath, acc) {
          const entries = await listEntries(relPath);
          for (const e of entries) {
            const name = e.name || '';
            if (!name || name === '.' || name === '..') continue;
            const childRel = relPath ? relPath + '/' + name : name;
            const t = String(e.type || '').toLowerCase();
            if (t === 'dir') await collectManifest(childRel, acc);
            else if (t === 'file') {
              let sz = null;
              if (e.size != null) sz = Number(e.size);
              else if (e.size_bytes != null) sz = Number(e.size_bytes);
              acc.push({ path: childRel, size: Number.isFinite(sz) ? sz : null });
            }
          }
        }

        let files = Array.isArray(chk.files) && chk.files.length ? chk.files : null;
        if (!files) {
          files = [];
          await collectManifest('', files);
          mergeCheckpoint({ files });
        }

        function shouldSkip(relPath, expectedSize, completedArr) {
          if (!completedArr || !completedArr.includes(relPath)) return false;
          const lp = path.join(targetDir, relPath.replace(/\//g, path.sep));
          if (!fs.existsSync(lp)) return false;
          if (expectedSize == null || !Number.isFinite(expectedSize)) return true;
          try {
            return fs.statSync(lp).size === expectedSize;
          } catch (_) {
            return false;
          }
        }

        async function notifyMarkDocsLoaded() {
          try {
            const url = dispoBaseUrl + '/api/job_mark_docs_loaded.php';
            const r = await fetch(url, {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, dispoMonteurFetchHeaders(technicianId, authHeader)),
              body: JSON.stringify({ job_id: serverJobId, technician_id: technicianId }),
              signal,
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) {
              console.warn('[dienstreise_pull] job_mark_docs_loaded', r.status, data && data.error);
            }
          } catch (e) {
            console.warn('[dienstreise_pull] job_mark_docs_loaded', e && e.message ? e.message : e);
          }
        }

        const total = files.length;
        let completed = Array.isArray(chk.completed) ? chk.completed.slice() : [];
        let skippedStart = 0;
        for (const f of files) {
          if (shouldSkip(f.path, f.size, completed)) skippedStart++;
        }
        setProgress('download', skippedStart, total, total ? '' : 'Keine Dateien.');
        if (total === 0) {
          await notifyMarkDocsLoaded();
          if (acceptJob) {
            applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
            let statusSyncWarning = null;
            const srvId = jobRowFull.server_id != null ? jobRowFull.server_id : null;
            if (srvId) {
              const pushRes = await pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, srvId, authHeader);
              if (pushRes.ok) {
                db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`).run(localJobId);
                save();
              } else {
                statusSyncWarning = pushRes.error || 'Status konnte nicht sofort zur Dispo gesendet werden.';
              }
            }
            mergeCheckpoint({
              finalize_done: true,
              status_sync_warning: statusSyncWarning,
              empty_copy: true,
            });
          } else {
            mergeCheckpoint({ finalize_done: true, empty_copy: true });
          }
          try {
            cacheProjekteNeuTreesForJob(localJobId);
          } catch (cacheErr) {
            console.warn('[dienstreise_pull] projekte_neu cache:', cacheErr && cacheErr.message ? cacheErr.message : cacheErr);
          }
          break;
        }

        for (let i = 0; i < files.length; i++) {
          const relPath = files[i].path;
          const expectedSize = files[i].size;
          if (shouldSkip(relPath, expectedSize, completed)) {
            setProgress('file', i + 1, total, relPath);
            continue;
          }
          const url =
            dispoBaseUrl +
            '/api/job_project_file_download.php?technician_id=' +
            technicianId +
            '&job_id=' +
            serverJobId +
            '&path=' +
            encodeURIComponent(relPath);
          const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader), signal });
          const buf = Buffer.from(await r.arrayBuffer());
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try {
              const j = JSON.parse(buf.toString('utf8'));
              if (j && j.error) msg = String(j.error);
            } catch (_) {}
            throw new Error('Download fehlgeschlagen (' + relPath + '): ' + msg);
          }
          const ctDl = (r.headers.get('content-type') || '').toLowerCase();
          if (ctDl.includes('application/json')) {
            try {
              const j = JSON.parse(buf.toString('utf8'));
              if (j && j.ok === false && j.error) throw new Error('Download fehlgeschlagen (' + relPath + '): ' + String(j.error));
            } catch (e) {
              if (e.message && e.message.startsWith('Download fehlgeschlagen')) throw e;
            }
          }
          const localPath = path.join(targetDir, relPath.replace(/\//g, path.sep));
          const dir = path.dirname(localPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const partPath = localPath + '.part';
          fs.writeFileSync(partPath, buf);
          try {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
          } catch (_) {}
          fs.renameSync(partPath, localPath);
          if (!completed.includes(relPath)) completed.push(relPath);
          mergeCheckpoint({ completed });
          setProgress('file', i + 1, total, relPath);
        }

        await notifyMarkDocsLoaded();

        chk = readCheckpoint();
        if (!chk.finalize_done) {
          if (acceptJob) {
            applyJobStatusInArbeitAfterAccept(localJobId, technicianId);
            let statusSyncWarning = null;
            const srvId = jobRowFull.server_id != null ? jobRowFull.server_id : null;
            if (srvId) {
              const pushRes = await pushJobStatusInArbeitToDispo(dispoBaseUrl, technicianId, srvId, authHeader);
              if (pushRes.ok) {
                db.prepare(`DELETE FROM pending_changes WHERE entity_type = 'job' AND entity_id = ? AND action = 'status'`).run(localJobId);
                save();
              } else {
                statusSyncWarning = pushRes.error || 'Status konnte nicht sofort zur Dispo gesendet werden.';
              }
            }
            mergeCheckpoint({ finalize_done: true, status_sync_warning: statusSyncWarning });
          } else {
            mergeCheckpoint({ finalize_done: true });
          }
        }
        try {
          cacheProjekteNeuTreesForJob(localJobId);
        } catch (cacheErr) {
          console.warn('[dienstreise_pull] projekte_neu cache:', cacheErr && cacheErr.message ? cacheErr.message : cacheErr);
        }
        break;
      }
      case 'dienstreise_push': {
        const p = job.payload || {};
        const localJobId = parseInt(p.job_id, 10);
        const dispoBaseUrl = (p.dispo_base_url || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technician_id, 10);
        setProgress('dienstreise_push', 0, 1, 'Synchronisiere Dienstreise-Ordner …');
        await syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, String(p.dispo_username || ''), String(p.dispo_password || ''));
        if (dispoBaseUrl) {
          try {
            await syncProtokollTemplates(dispoBaseUrl);
          } catch (tplErr) {
            console.warn('Protokoll-Vorlagen Sync fehlgeschlagen (offline-Vorlagen weiter nutzbar):', tplErr.message);
          }
        }
        break;
      }
      case 'sync_pull': {
        const p = job.payload || {};
        const base = (p.baseUrl || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technicianId, 10);
        const auth = authHeaderFromCredentials(p.serverUsername, p.serverPassword);
        setProgress('sync_pull', 0, 4, 'Ziehe Aufträge von Dispo …');
        const pullInfo = await pullFromServer(base, technicianId, db, auth, p.date_from, p.date_to);
        save();
        setProgress('sync_pull', 1, 4, 'Kalender-Cache …');
        const range = defaultFutureRange();
        const cacheStart = p.date_from && String(p.date_from).trim() ? String(p.date_from).trim() : range.start;
        const cacheEnd = p.date_to && String(p.date_to).trim() ? String(p.date_to).trim() : range.end;
        try {
          const calData = await fetchCalendarFromDispo(base, cacheStart, cacheEnd, auth);
          upsertCalendarCache(db, calData);
          const fabs = pullInfo && Array.isArray(pullInfo.fabs) ? pullInfo.fabs : [];
          const subset = fabs.slice(0, 200);
          let fi = 0;
          for (const fab of subset) {
            if (signal.aborted) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
            fi++;
            setProgress('anlagenstamm_tree', fi, subset.length, fab);
            try {
              await fetchAndCacheAnlagenstammTree(base, technicianId, fab, auth, db);
            } catch (_) {}
          }
        } catch (_) {}
        save();
        setProgress('sync_pull', 3, 4, 'Protokoll-Vorlagen …');
        try {
          await syncProtokollTemplates(base);
        } catch (tplErr) {
          console.warn('Protokoll-Vorlagen Sync fehlgeschlagen:', tplErr.message);
        }
        setProgress('anlagenstamm_db_sync', 0, 1, 'Anlagenstamm-Stammdaten …');
        try {
          const syncResult = await syncAnlagenstammFromDispo(db, {
            baseUrl: base,
            technician_id: technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
          }, (prog) => {
            if (prog && prog.page && prog.totalPages) {
              setProgress('anlagenstamm_db_sync', prog.page, prog.totalPages, 'Seite ' + prog.page + '/' + prog.totalPages);
            }
          });
          if (!syncResult.ok) {
            console.warn('[sync_pull] anlagenstamm_db_sync:', syncResult.error || 'fehlgeschlagen');
          }
          save();
        } catch (syncErr) {
          console.warn('[sync_pull] anlagenstamm_db_sync:', syncErr && syncErr.message ? syncErr.message : syncErr);
        }
        break;
      }
      case 'anlagenstamm_db_sync': {
        const p = job.payload || {};
        const base = (p.baseUrl || '').trim().replace(/\/$/, '');
        const technicianId = parseInt(p.technicianId, 10);
        const syncResult = await syncAnlagenstammFromDispo(
          db,
          {
            baseUrl: base,
            externalUrl: p.externalUrl,
            internalUrl: p.internalUrl,
            technician_id: technicianId,
            serverUsername: p.serverUsername,
            serverPassword: p.serverPassword,
          },
          (prog) => {
            if (prog && prog.page && prog.totalPages) {
              setProgress('anlagenstamm_db_sync', prog.page, prog.totalPages, 'Seite ' + prog.page + '/' + prog.totalPages);
            }
          },
        );
        if (!syncResult.ok) throw new Error(syncResult.error || 'Anlagenstamm-Sync fehlgeschlagen.');
        save();
        setProgress('done', 1, 1, 'Anlagenstamm synchronisiert (' + (syncResult.row_count || 0) + ' Zeilen).');
        break;
      }
      case 'sync_push': {
        const p = job.payload || {};
        const baseUrl = (p.baseUrl || '').trim();
        const technicianId = parseInt(p.technicianId, 10);
        const auth = authHeaderFromCredentials(p.serverUsername, p.serverPassword);
        setProgress('sync_push', 0, 2, 'Sende Änderungen zur Dispo …');
        await pushToServer(baseUrl, technicianId, db, auth);
        setProgress('sync_push', 1, 2, 'Abrechnungs-Outbox …');
        try {
          await flushAbrechnungOutbox(
            { db, save, dbDir: DB_DIR, authHeaderFromCredentials },
            baseUrl,
            technicianId,
            p.serverUsername,
            p.serverPassword,
          );
        } catch (e) {
          console.warn('[abrechnung] flush after sync_push:', e && e.message ? e.message : e);
        }
        save();
        break;
      }
      case 'abrechnung_refresh': {
        const p = job.payload || {};
        setProgress('abrechnung_refresh', 0, 1, 'Abrechnung wird abgeglichen …');
        const result = await runAbrechnungRefreshCore(abrechnungRefreshCtx, {
          baseUrl: p.baseUrl,
          technicianId: p.technicianId,
          serverUsername: p.serverUsername,
          serverPassword: p.serverPassword,
          period_ym: p.period_ym,
          job_server_id: p.job_server_id,
        });
        let msg = 'Abrechnung synchronisiert.';
        if (result.partial && result.warnings && result.warnings.length) msg += ' ' + result.warnings.join('; ');
        mergeCheckpoint({
          abrechnung_partial: !!result.partial,
          abrechnung_warnings: Array.isArray(result.warnings) ? result.warnings : [],
        });
        setProgress('done', 1, 1, msg);
        break;
      }
      default:
        throw new Error('Unbekannter Job-Typ (Runner): ' + job.type);
    }
  }

  bgJobs = createBackgroundJobService(db, save, { executeJob: executeBackgroundJob });
  bgJobs.markStaleRunningAsInterrupted();
  bgJobs.kick();

  async function enrichJobFabWithAnlagenstamm(job, baseUrl, authHeader) {
    if (!job) return job;
    const localJobPk = job.id != null ? parseInt(job.id, 10) : NaN;
    if (Number.isFinite(localJobPk)) {
      const pendingFab = getPendingJobFabrikationsnummern(db, localJobPk);
      if (pendingFab !== undefined) {
        job = Object.assign({}, job, { fabrikationsnummern: pendingFab });
      }
    }
    if (!baseUrl || typeof job.fabrikationsnummern !== 'string') return job;
    const fab = job.fabrikationsnummern.trim();
    if (!fab) return job;
    /** Felder aus Dispo-Anlagenstamm – immer nachladen und in bestehende FN-Objekte mergen (u. a. projekt). */
    const STAMM_KEYS = ['type', 'leistung', 'nenngeschwindigkeit', 'kraftaufnehmer', 'dms_nr', 'tacho', 'elektronik', 'material', 'position', 'geliefert_ueber', 'projekt', 'bemerkungen'];
    let parsed = null;
    let parts = [];
    try {
      parsed = JSON.parse(fab);
      if (Array.isArray(parsed) && parsed.length > 0) {
        parts = parsed
          .map((r) => {
            if (r && typeof r === 'object') {
              const fn = r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer;
              return fn != null ? String(fn).trim() : '';
            }
            return r != null ? String(r).trim() : '';
          })
          .filter(Boolean);
      }
    } catch (e) {
      parsed = null;
    }
    if (parts.length === 0) parts = fab.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return job;
    ensureAnlagenstammLocalSchema(db);
    let data = { data: [] };
    let debugInfo = { requestedFabs: parts.slice(), ok: false, matchCount: 0, status: null, _source: null };
    if (anlagenstammLocalRowCount(db) > 0) {
      const localRows = anlagenstammGetRowsByFabs(db, parts);
      if (localRows.length > 0) {
        data = { data: localRows };
        debugInfo.ok = true;
        debugInfo.matchCount = localRows.length;
        debugInfo._source = 'local';
      }
    }
    const base = baseUrl.toString().trim().replace(/\/$/, '');
    if (!debugInfo.ok && base) {
      const url = `${base}/dispo_api/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(parts.join(','))}`;
      debugInfo.url = url;
      try {
        const r = await fetch(url, authHeader ? { headers: authHeader } : {});
        data = await r.json().catch(() => ({}));
        debugInfo.ok = !!r.ok;
        debugInfo.status = r.status;
        debugInfo.matchCount = Array.isArray(data.data) ? data.data.length : 0;
        debugInfo._source = 'dispo';
      } catch (e) {
        return { ...job, _anlagenstamm_debug: debugInfo };
      }
    }
    try {
      if (!debugInfo.ok || !Array.isArray(data.data) || data.data.length === 0) {
        return { ...job, _anlagenstamm_debug: debugInfo };
      }
      const byFab = {};
      for (const row of data.data) {
        const key = String(row.fabrikationsnummer ?? '').trim();
        if (key) byFab[key] = row;
      }
      const rowForParsedIndex = (i, fnHint) => {
        if (Array.isArray(data.data) && i >= 0 && i < data.data.length) return data.data[i];
        const fn = String(fnHint || '').trim();
        return fn ? byFab[fn] || {} : {};
      };
      const hasObjectRows = Array.isArray(parsed) && parsed.length > 0 && parsed.some((x) => x && typeof x === 'object');
      let newFabJson;
      if (hasObjectRows) {
        const sameLen = Array.isArray(data.data) && data.data.length === parsed.length;
        newFabJson = JSON.stringify(
          parsed.map((r, i) => {
            if (!r || typeof r !== 'object') {
              const fn = String(r).trim();
              const apiRow = sameLen ? rowForParsedIndex(i, fn) : byFab[fn] || {};
              const o = { fabrikationsnummer: fn };
              for (const k of STAMM_KEYS) {
                o[k] = apiRow[k] != null ? apiRow[k] : '';
              }
              return o;
            }
            const fn = String(
              r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer != null ? r.Fabrikationsnummer : '',
            ).trim();
            const apiRow = sameLen ? rowForParsedIndex(i, fn) : (fn ? byFab[fn] || {} : {});
            const localRow = fn ? anlagenstammLookupByFab(db, fn) : null;
            const localDirty = localRow && Number(localRow.dirty) === 1;
            const merged = { ...r };
            for (const k of STAMM_KEYS) {
              if (localDirty && localRow[k] != null && String(localRow[k]).trim() !== '') {
                merged[k] = localRow[k];
              } else if (apiRow[k] != null && String(apiRow[k]).trim() !== '') {
                merged[k] = apiRow[k];
              } else if (r[k] != null && String(r[k]).trim() !== '') {
                merged[k] = r[k];
              } else {
                merged[k] = '';
              }
            }
            if (fn) merged.fabrikationsnummer = fn;
            return merged;
          }),
        );
      } else {
        newFabJson = JSON.stringify(data.data);
      }
      return { ...job, fabrikationsnummern: newFabJson, _anlagenstamm_debug: debugInfo };
    } catch (e) {
      debugInfo.error = e && e.message ? e.message : String(e);
    }
    return { ...job, _anlagenstamm_debug: debugInfo };
  }

  const DISPO_PROBE_TIMEOUT_MS = 10000;

  /** @param {number} status @param {string} body */
  function errorTextFromDispoBody(status, body) {
    let msg = 'HTTP ' + status;
    const bodyStr = body != null ? String(body) : '';
    try {
      const data = JSON.parse(bodyStr);
      if (data && typeof data.error === 'string' && data.error.trim()) {
        msg = data.error.trim();
        if (status === 403) msg = 'Monteur wird nicht anerkannt: ' + msg;
      }
    } catch (_) {
      if (status === 404 && bodyStr.length > 0) {
        msg = 'Pfad nicht gefunden (404).';
      }
      if (status === 500 && bodyStr.length > 0) {
        const snippet = bodyStr.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (/Fatal error|Parse error|Exception|Warning:/i.test(snippet)) {
          msg = 'Dispo-Server-Fehler (500). Vorschau: ' + snippet;
        }
      }
    }
    return msg;
  }

  async function errorTextFromDispoResponse(r) {
    const body = await r.text();
    return errorTextFromDispoBody(r.status, body);
  }

  /**
   * Gleiche Erreichbarkeitslogik wie früher: /api/my_jobs.php genügt für Kalender-Sync u. a.;
   * nur wenn my_jobs fehlschlägt, Folgeprobe dispo_api/jobs_open.
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  async function probeDispoConnection(baseUrlRaw, technicianId, serverUsername, serverPassword, signal) {
    const base = (baseUrlRaw || '').toString().trim().replace(/\/$/, '');
    let techId = technicianId != null ? Number(technicianId) : 1;
    if (!Number.isFinite(techId) || techId <= 0) techId = 1;
    if (!base) {
      return { ok: false, error: 'Server-URL fehlt.' };
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const opts = auth ? { headers: auth, signal } : { signal };
    const urlMyJobs = `${base}/api/my_jobs.php?technician_id=${encodeURIComponent(techId)}`;
    const urlJobsOpen = `${base}/dispo_api/api/jobs_open.php?technician_id=${encodeURIComponent(techId)}`;

    try {
      const rMy = await fetch(urlMyJobs, opts);
      if (rMy.ok) return { ok: true };

      const errMyJobs = await errorTextFromDispoResponse(rMy);

      const rOpen = await fetch(urlJobsOpen, opts);
      if (rOpen.ok) {
        const text = await rOpen.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : [];
        } catch (_) {
          return {
            ok: false,
            error: 'dispo_api/jobs_open: kein gültiges JSON. Zusätzlich my_jobs: ' + errMyJobs,
          };
        }
        if (Array.isArray(data)) return { ok: true };
        if (data && typeof data === 'object' && data.ok === false && data.error) {
          return { ok: false, error: String(data.error) };
        }
        return {
          ok: false,
          error: 'dispo_api/jobs_open: keine JSON-Liste. my_jobs: ' + errMyJobs,
        };
      }
      const errOpen = await errorTextFromDispoResponse(rOpen);
      return {
        ok: false,
        error: 'my_jobs: ' + errMyJobs + ' · dispo_api/jobs_open: ' + errOpen,
      };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, error: 'Timeout nach ' + DISPO_PROBE_TIMEOUT_MS / 1000 + ' s (Dispo-Probe)' };
      }
      return { ok: false, error: 'Dispo nicht erreichbar: ' + (e.message || String(e)) };
    }
  }

  app.post('/api/check_connection', express.json(), async (req, res) => {
    const { baseUrl, externalUrl, internalUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    const candidates = buildDispoBaseCandidates({ baseUrl, externalUrl, internalUrl });
    if (candidates.length === 0) {
      return res.json({ ok: false, error: 'Server-URL fehlt.' });
    }
    let lastErr = 'Verbindung fehlgeschlagen';
    for (const base of candidates) {
      const result = await probeDispoConnection(base, technicianId, serverUsername, serverPassword, undefined);
      if (result.ok) {
        return res.json({ ok: true, used_base_url: base });
      }
      lastErr = result.error || lastErr;
    }
    return res.json({ ok: false, error: lastErr });
  });

  /** Zwei Basis-URLs (extern/intern): parallel prüfen, bei beidem OK interne wählen (10 s Timeout pro Probe). */
  app.post('/api/dispo_pick_base', express.json(), async (req, res) => {
    const { externalUrl, internalUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    const ext = (externalUrl || '').toString().trim().replace(/\/$/, '');
    const int = (internalUrl || '').toString().trim().replace(/\/$/, '');
    if (!ext && !int) {
      return res.json({ ok: false, error: 'Mindestens eine Dispo-Basis-URL erforderlich.', tried: [] });
    }

    const runProbe = (url) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), DISPO_PROBE_TIMEOUT_MS);
      return probeDispoConnection(url, technicianId, serverUsername, serverPassword, ac.signal).finally(() =>
        clearTimeout(timer),
      );
    };

    try {
      if (ext && !int) {
        const r = await runProbe(ext);
        return res.json({
          ok: r.ok,
          selected_base_url: r.ok ? ext : null,
          preferred_source: 'single',
          tried: [{ url: ext, ok: r.ok, error: r.ok ? undefined : r.error }],
        });
      }
      if (int && !ext) {
        const r = await runProbe(int);
        return res.json({
          ok: r.ok,
          selected_base_url: r.ok ? int : null,
          preferred_source: 'single',
          tried: [{ url: int, ok: r.ok, error: r.ok ? undefined : r.error }],
        });
      }

      const [rInt, rExt] = await Promise.all([runProbe(int), runProbe(ext)]);
      const tried = [
        { url: int, ok: rInt.ok, error: rInt.ok ? undefined : rInt.error },
        { url: ext, ok: rExt.ok, error: rExt.ok ? undefined : rExt.error },
      ];
      if (rInt.ok && rExt.ok) {
        return res.json({ ok: true, selected_base_url: int, preferred_source: 'internal', tried });
      }
      if (rInt.ok) {
        return res.json({ ok: true, selected_base_url: int, preferred_source: 'internal', tried });
      }
      if (rExt.ok) {
        return res.json({ ok: true, selected_base_url: ext, preferred_source: 'external', tried });
      }
      return res.json({ ok: false, error: 'Keine erreichbare Dispo-URL.', tried });
    } catch (e) {
      return res.json({ ok: false, error: e.message || String(e), tried: [] });
    }
  });

  app.post('/api/sync_pull', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, date_from, date_to } = req.body || {};
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const base = (baseUrl || '').trim().replace(/\/$/, '');
      const tid = parseInt(technicianId, 10);
      const dedupeKey = 'sync_pull:' + tid + ':' + fingerprintDispoBase(base);
      const { job_id } = bgJobs.enqueue(
        'sync_pull',
        {
          baseUrl: base,
          technicianId: tid,
          serverUsername,
          serverPassword,
          date_from,
          date_to,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/sync_push', express.json(), (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const base = (baseUrl || '').trim().replace(/\/$/, '');
      const tid = parseInt(technicianId, 10);
      const dedupeKey = 'sync_push:' + tid + ':' + fingerprintDispoBase(base);
      const { job_id } = bgJobs.enqueue(
        'sync_push',
        {
          baseUrl: base,
          technicianId: tid,
          serverUsername,
          serverPassword,
        },
        dedupeKey,
      );
      return res.status(202).json({ ok: true, job_id, async: true });
    } catch (e) {
      logSyncPushError(Object.assign({ reason: 'enqueue_fehler', message: e.message }));
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/background_jobs', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const { type, payload, dedupe_key } = req.body || {};
      const { job_id } = bgJobs.enqueue(type, payload || {}, dedupe_key || null);
      return res.status(202).json({ ok: true, job_id });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/background_jobs/recover', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const r = bgJobs.recoverPullJobs();
      return res.json({ ok: true, reopened: r.reopened });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/background_jobs', (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const activeOnly = req.query.active === '1' || req.query.active === 'true';
      const jobs = bgJobs.listJobs(req.query.limit, activeOnly);
      return res.json({ ok: true, jobs });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/background_jobs/:id', (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const job = bgJobs.getJob(req.params.id);
      if (!job) return res.status(404).json({ ok: false, error: 'Job nicht gefunden.' });
      return res.json({ ok: true, job });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/background_jobs/:id/cancel', express.json(), (req, res) => {
    try {
      if (!bgJobs) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const x = bgJobs.cancelJob(req.params.id);
      if (!x.ok) return res.status(400).json({ ok: false, error: x.error });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/calendar', async (req, res) => {
    const baseUrl = (req.query.baseUrl || req.query.base_url || '').toString().trim().replace(/\/$/, '');
    const start = (req.query.start || '').toString().trim();
    const end = (req.query.end || '').toString().trim();
    if (!baseUrl || !start || !end) {
      return res.status(400).json({ ok: false, error: 'baseUrl, start und end erforderlich.' });
    }
    try {
      const r = await fetch(`${baseUrl}/api/calendar.php?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      if (!r.ok) throw new Error('Calendar API: ' + r.status);
      const data = await r.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/calendar', express.json(), async (req, res) => {
    const { baseUrl: rawUrl, start, end, serverUsername, serverPassword } = req.body || {};
    const baseUrl = (rawUrl || '').toString().trim().replace(/\/$/, '');
    const s = (start || '').toString().trim();
    const e = (end || '').toString().trim();
    if (!baseUrl || !s || !e) {
      return res.status(400).json({ ok: false, error: 'baseUrl, start und end erforderlich.' });
    }
    try {
      const auth = authHeaderFromCredentials(serverUsername, serverPassword);
      const opts = auth ? { headers: auth } : {};
      const r = await fetch(`${baseUrl}/api/calendar.php?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`, opts);
      if (!r.ok) throw new Error('Calendar API: ' + r.status);
      const data = await r.json();

      // Jobs anreichern: Firma, Ort, Länderkürzel (wie bei Einzeltechniker), damit Balken/Tooltip gleich angezeigt werden
      const jobs = data.jobs || [];
      await Promise.all(jobs.map(async (job) => {
        const jobId = job.id ?? job.server_id;
        const techId = job.technician_id;
        if (jobId == null || techId == null) return;
        try {
          const jr = await fetch(`${baseUrl}/dispo_api/api/job.php?id=${encodeURIComponent(jobId)}&technician_id=${encodeURIComponent(techId)}`, opts);
          if (!jr.ok) return;
          const jData = await jr.json();
          const full = jData.job;
          if (full) {
            if (full.customer_name != null) job.customer_name = full.customer_name;
            if (full.city != null) job.city = full.city;
            if (full.country != null) job.country = full.country;
          }
        } catch (_) { /* Einzelauftrag nicht geladen, Balken behält Nummer */ }
      }));

      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get('/api/calendar_cached', (req, res) => {
    const start = String(req.query.start || '').trim();
    const end = String(req.query.end || '').trim();
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: 'start und end erforderlich.' });
    }
    try {
      const technicians = db.prepare('SELECT technician_id AS id, name, color FROM calendar_cache_technicians ORDER BY technician_id').all();
      const jobs = db.prepare(`
        SELECT
          server_job_id AS id, technician_id, customer_name, job_number, city, country, status,
          start_datetime, end_datetime, technician_name, technician_color
        FROM calendar_cache_jobs
        WHERE end_datetime >= ? AND start_datetime <= ?
      `).all(start + ' 00:00:00', end + ' 23:59:59');
      const absences = db.prepare(`
        SELECT
          server_absence_id AS id, technician_id, type, comment, start_datetime, end_datetime,
          technician_name, technician_color
        FROM calendar_cache_absences
        WHERE end_datetime >= ? AND start_datetime <= ?
      `).all(start + ' 00:00:00', end + ' 23:59:59');
      return res.json({ ok: true, technicians, jobs, absences });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

function defaultFutureRange() {
  const from = new Date();
  const to = new Date(from);
  to.setFullYear(to.getFullYear() + 10);
  return { start: from.toISOString().slice(0, 10), end: to.toISOString().slice(0, 10) };
}

async function fetchCalendarFromDispo(baseUrl, start, end, authHeader) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/calendar.php?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const opts = authHeader ? { headers: authHeader } : {};
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!r.ok) {
    const msg = (data && data.error) ? data.error : ('HTTP ' + r.status + ' ' + (r.statusText || ''));
    throw new Error('Kalender-Cache Pull fehlgeschlagen: ' + msg);
  }
  if (!data || typeof data !== 'object') throw new Error('Kalender-Cache Pull: ungültige Antwort.');
  return data;
}

function extractFabsFromJobs(jobs) {
  const result = [];
  const seen = new Set();
  const list = Array.isArray(jobs) ? jobs : [];
  for (const j of list) {
    const raw = (j && j.fabrikationsnummern != null) ? j.fabrikationsnummern : '';
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
        for (const row of rows) {
          const fab = String((row && (row.fabrikationsnummer || row.Fabrikationsnummer || row.fab)) || '').trim();
          if (!fab || seen.has(fab)) continue;
          seen.add(fab);
          result.push(fab);
        }
      } catch (_) {
        const parts = raw.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
        for (const fab of parts) {
          if (seen.has(fab)) continue;
          seen.add(fab);
          result.push(fab);
        }
      }
    } else if (Array.isArray(raw)) {
      for (const row of raw) {
        const fab = String((row && (row.fabrikationsnummer || row.Fabrikationsnummer || row.fab)) || '').trim();
        if (!fab || seen.has(fab)) continue;
        seen.add(fab);
        result.push(fab);
      }
    }
  }
  return result;
}

function upsertAnlagenstammTreeCache(db, fab, pnRaw) {
  const fabNorm = String(fab || '').trim();
  if (!fabNorm) return;
  const enabled = pnRaw && pnRaw.enabled ? 1 : 0;
  const tree = pnRaw && Array.isArray(pnRaw.tree) ? pnRaw.tree : [];
  const treeJson = JSON.stringify(tree);
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT OR REPLACE INTO anlagenstamm_tree_cache (fab, projects_enabled, tree_json, synced_at)
    VALUES (?, ?, ?, ?)
  `).run(fabNorm, enabled, treeJson, syncedAt);
}

async function fetchAndCacheAnlagenstammTree(baseUrl, technicianId, fab, authHeader, db) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  const fabNorm = String(fab || '').trim();
  if (!base || !technicianId || !fabNorm) return null;
  const url = `${base}/dispo_api/api/anlagenstamm_files_list.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabNorm)}`;
  const r = await fetch(url, authHeader ? { headers: authHeader } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error) ? data.error : ('HTTP ' + r.status));
  const pnRaw = data && data.projekte_neu ? data.projekte_neu : { enabled: false, tree: [] };
  upsertAnlagenstammTreeCache(db, fabNorm, pnRaw);
  return pnRaw;
}

function upsertCalendarCache(db, calendarData) {
  const technicians = Array.isArray(calendarData.technicians) ? calendarData.technicians : [];
  const jobs = Array.isArray(calendarData.jobs) ? calendarData.jobs : [];
  const absences = Array.isArray(calendarData.absences) ? calendarData.absences : [];
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.transaction(() => {
    db.prepare('DELETE FROM calendar_cache_technicians').run();
    db.prepare('DELETE FROM calendar_cache_jobs').run();
    db.prepare('DELETE FROM calendar_cache_absences').run();

    for (const t of technicians) {
      const tid = Number(t.id != null ? t.id : t.technician_id);
      if (!Number.isFinite(tid) || tid <= 0) continue;
      const name = String(t.name || t.full_name || t.technician_name || '').trim() || ('Techniker ' + tid);
      const color = String(t.color || t.farbe || '').trim() || '#4a90e2';
      db.prepare('INSERT OR REPLACE INTO calendar_cache_technicians (technician_id, name, color, synced_at) VALUES (?, ?, ?, ?)')
        .run(tid, name, color, syncedAt);
    }

    for (const j of jobs) {
      const sid = Number(j.id != null ? j.id : j.server_id);
      const tid = Number(j.technician_id != null ? j.technician_id : j.technicianId);
      const start = String(j.start_datetime || '').replace('T', ' ').slice(0, 19);
      const end = String(j.end_datetime || '').replace('T', ' ').slice(0, 19);
      if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(tid) || tid <= 0 || !start || !end) continue;
      const cacheKey = String(sid) + ':' + String(tid);
      db.prepare(`INSERT OR REPLACE INTO calendar_cache_jobs
        (cache_key, server_job_id, technician_id, customer_name, job_number, city, country, status, start_datetime, end_datetime, technician_name, technician_color, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cacheKey, sid, tid,
        String(j.customer_name || ''), String(j.job_number || ''),
        String(j.city || ''), String(j.country || ''), String(j.status || ''),
        start, end, String(j.technician_name || ''), String(j.technician_color || ''), syncedAt
      );
    }

    for (const a of absences) {
      const sidRaw = a.id != null ? String(a.id) : '';
      const tid = Number(a.technician_id != null ? a.technician_id : a.technicianId);
      const start = String(a.start_datetime || '').replace('T', ' ').slice(0, 19);
      const end = String(a.end_datetime || '').replace('T', ' ').slice(0, 19);
      const type = String(a.type || '');
      if (!Number.isFinite(tid) || tid <= 0 || !start || !end) continue;
      const cacheKey = [sidRaw || 'x', tid, start, end, type].join(':');
      db.prepare(`INSERT OR REPLACE INTO calendar_cache_absences
        (cache_key, server_absence_id, technician_id, type, comment, start_datetime, end_datetime, technician_name, technician_color, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cacheKey, sidRaw !== '' ? Number(sidRaw) : null, tid, type, String(a.comment || ''),
        start, end, String(a.technician_name || ''), String(a.technician_color || ''), syncedAt
      );
    }
  });
}

function removeLocalJobsNotInDispo(db, technicianId, receivedJobServerIds) {
  const rows = db.prepare(
    'SELECT j.id, j.server_id FROM jobs j INNER JOIN job_technicians jt ON jt.job_id = j.id WHERE jt.technician_id = ?'
  ).all(technicianId);
  for (const row of rows) {
    const hasServerId = row.server_id != null && String(row.server_id).trim() !== '';
    if (!hasServerId) continue; // Verwaiste Aufträge (ohne server_id) nicht löschen – werden ggf. im gleichen Pull verknüpft
    const serverId = row.server_id;
    if (receivedJobServerIds.has(Number(serverId)) || receivedJobServerIds.has(String(serverId))) continue;
    db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(row.id, technicianId);
    const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(row.id);
    if (!rest) {
      db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(row.id);
      db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
    }
  }
  // Lokale Spiegel ohne job_technicians (unzugewiesen auf Dispo): entfernen, wenn nicht mehr im Pull
  const unassignedMirror = db.prepare(`
    SELECT j.id, j.server_id FROM jobs j
    WHERE j.server_id IS NOT NULL AND TRIM(CAST(j.server_id AS TEXT)) != ''
    AND NOT EXISTS (SELECT 1 FROM job_technicians jtx WHERE jtx.job_id = j.id)
  `).all();
  for (const row of unassignedMirror) {
    const serverId = row.server_id;
    if (receivedJobServerIds.has(Number(serverId)) || receivedJobServerIds.has(String(serverId))) continue;
    try {
      db.prepare('DELETE FROM job_contacts WHERE job_id = ?').run(row.id);
    } catch (e) { /* Tabelle fehlt */ }
    try {
      db.prepare('DELETE FROM job_hotel_addresses WHERE job_id = ?').run(row.id);
    } catch (e) { /* ignore */ }
    db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(row.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
  }
}

function removeLocalAbsencesNotInDispo(db, technicianId, receivedAbsenceServerIds) {
  const rows = db.prepare('SELECT id, server_id FROM absences WHERE technician_id = ?').all(technicianId);
  for (const row of rows) {
    const serverId = row.server_id != null && row.server_id !== '' ? row.server_id : row.id;
    if (receivedAbsenceServerIds.has(Number(serverId)) || receivedAbsenceServerIds.has(String(serverId))) continue;
    db.prepare('DELETE FROM absences WHERE id = ?').run(row.id);
  }
}

async function pullFromServer(baseUrl, technicianId, db, authHeader, dateFrom, dateTo) {
  const base = baseUrl.replace(/\/$/, '');
  let jobsUrl = `${base}/api/my_jobs.php?technician_id=${technicianId}`;
  let absencesUrl = `${base}/api/my_absences.php?technician_id=${technicianId}`;
  if (dateFrom) jobsUrl += '&date_from=' + encodeURIComponent(dateFrom);
  if (dateTo) jobsUrl += '&date_to=' + encodeURIComponent(dateTo);
  if (dateFrom) absencesUrl += '&date_from=' + encodeURIComponent(dateFrom);
  if (dateTo) absencesUrl += '&date_to=' + encodeURIComponent(dateTo);
  const fetchOpts = authHeader ? { headers: authHeader } : {};
  let jobsRes;
  let absencesRes;
  try {
    [jobsRes, absencesRes] = await Promise.all([
      fetch(jobsUrl, fetchOpts),
      fetch(absencesUrl, fetchOpts)
    ]);
  } catch (e) {
    throw new Error('Dispo-Server nicht erreichbar: ' + e.message + '. Prüfen Sie die Adresse (z. B. http://localhost/) und ob der Server läuft.');
  }
  if (!jobsRes.ok || !absencesRes.ok) {
    const parts = [];
    if (!jobsRes.ok) parts.push('Aufträge: ' + jobsRes.status + ' ' + jobsRes.statusText);
    if (!absencesRes.ok) parts.push('Abwesenheiten: ' + absencesRes.status + ' ' + absencesRes.statusText);
    throw new Error('Pull fehlgeschlagen (' + parts.join('; ') + '). Dispo-Server-URL muss so sein, dass ' + base + '/api/my_jobs.php erreichbar ist.');
  }
  const jobsData = await jobsRes.json();
  const jobs = jobsData.jobs || [];
  const absencesData = await absencesRes.json();
  const absences = absencesData.absences || [];
  const fabs = extractFabsFromJobs(jobs);
  const receivedJobServerIds = new Set();
  for (const j of jobs) {
    const id = j.id;
    if (id != null) { receivedJobServerIds.add(Number(id)); receivedJobServerIds.add(String(id)); }
  }
  const receivedAbsenceServerIds = new Set();
  for (const a of absences) {
    const id = a.id;
    if (id != null) { receivedAbsenceServerIds.add(Number(id)); receivedAbsenceServerIds.add(String(id)); }
  }
  db.transaction(() => {
    ensureTechnician(db, technicianId);
    removeLocalJobsNotInDispo(db, technicianId, receivedJobServerIds);
    removeLocalAbsencesNotInDispo(db, technicianId, receivedAbsenceServerIds);
    for (const j of jobs) {
      const custId = ensureCustomer(db, j);
      insertOrUpdateJob(db, j, custId, technicianId);
    }
    for (const a of absences) {
      insertOrUpdateAbsence(db, a, technicianId);
    }
  });

  const fullName = (jobsData.technician_full_name != null && String(jobsData.technician_full_name).trim()) ? String(jobsData.technician_full_name).trim() : null;
  const username = (jobsData.technician_username != null && String(jobsData.technician_username).trim()) ? String(jobsData.technician_username).trim() : null;
  if (fullName != null || username != null) {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(technicianId);
    if (existing) {
      if (fullName != null && username != null) {
        db.prepare('UPDATE users SET full_name = ?, username = ? WHERE id = ?').run(fullName, username, technicianId);
      } else if (fullName != null) {
        db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(fullName, technicianId);
      } else {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, technicianId);
      }
    }
  }
  return { fabs };
}

function ensureTechnician(db, technicianId) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(technicianId);
  if (existing) return;
  db.prepare('INSERT OR IGNORE INTO users (id, username, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run(
    technicianId,
    'tech_' + technicianId,
    'Monteur',
    'monteur',
    1
  );
}

function ensureCustomer(db, j) {
  const name = j.customer_name || 'Unbekannt';
  const row = db.prepare('SELECT id FROM customers WHERE name = ? LIMIT 1').get(name);
  if (row) return row.id;
  const r = db.prepare('INSERT INTO customers (name, street, house_number, zip, city, phone, contact_person, contact_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    name, j.street || '', j.house_number || '', j.zip || '', j.city || '', j.customer_phone || '', j.contact_person || '', j.contact_phone || ''
  );
  return r.lastInsertRowid;
}

function getPendingJobFabrikationsnummern(db, localJobId) {
  const row = db
    .prepare(
      `SELECT payload FROM pending_changes
       WHERE entity_type = 'job' AND entity_id = ? AND action = 'fabrikationsnummern'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(localJobId);
  if (!row) return undefined;
  try {
    const p = JSON.parse(row.payload || '{}');
    if (p.fabrikationsnummern === undefined) return undefined;
    const v = p.fabrikationsnummern;
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch (_) {
    return undefined;
  }
}

function resolveFabrikationsnummernForPull(db, localJobId, serverFab) {
  const pending = getPendingJobFabrikationsnummern(db, localJobId);
  if (pending !== undefined) return pending;
  return serverFab != null ? serverFab : null;
}

function insertOrUpdateJob(db, j, customerId, technicianId) {
  const id = j.id;
  const existing = db.prepare('SELECT id FROM jobs WHERE server_id = ?').get(id);
  const start = (j.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (j.end_datetime || '').replace('T', ' ').substring(0, 19);
  const rawSt = String(j.status || '').toLowerCase();
  const KNOWN = new Set(['angelegt', 'zugeteilt', 'in_arbeit', 'erledigt', 'abgerechnet', 'geplant']);
  const status = KNOWN.has(rawSt) ? rawSt : 'angelegt';
  if (existing) {
    const fabForLocal = resolveFabrikationsnummernForPull(db, existing.id, j.fabrikationsnummern);
    db.prepare('UPDATE jobs SET job_number = ?, customer_id = ?, job_type = ?, start_datetime = ?, end_datetime = ?, status = ?, description = ?, fabrikationsnummern = ?, eap_nummer = ?, bestellnummer = ?, synced_at = datetime(\'now\') WHERE id = ?').run(
      j.job_number || null, customerId, j.job_type || 'Service', start, end, status, j.description || null, fabForLocal, j.eap_nummer || null, j.bestellnummer || null, existing.id
    );
    if (j.street != null) insertOrUpdateJobAddress(db, existing.id, j);
    if (hasHotelFields(j)) insertOrUpdateJobHotel(db, existing.id, j);
    const dispCountUpd = Number(j.dispo_jt_count);
    if (Number.isFinite(dispCountUpd) && dispCountUpd > 0) {
      db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(existing.id, technicianId);
    }
    return existing.id;
  }
  // Verwaisten lokalen Auftrag (ohne server_id) mit Dispo-Auftrag verknüpfen – dann bleibt die lokale ID erhalten
  let orphan = null;
  const jobNumber = (j.job_number != null && String(j.job_number).trim() !== '') ? String(j.job_number).trim() : null;
  const customerName = (j.customer_name != null && String(j.customer_name).trim() !== '') ? String(j.customer_name).trim() : null;
  const startDate = start.substring(0, 10); // YYYY-MM-DD
  if (jobNumber) {
    orphan = db.prepare(`
      SELECT j.id FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      WHERE (j.server_id IS NULL OR j.server_id = '') AND j.job_number = ?
      LIMIT 1
    `).get(technicianId, jobNumber);
  }
  if (!orphan && customerName && startDate) {
    const orphans = db.prepare(`
      SELECT j.id FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      INNER JOIN customers c ON c.id = j.customer_id
      WHERE (j.server_id IS NULL OR j.server_id = '') AND TRIM(c.name) = ? AND (j.start_datetime IS NULL OR j.start_datetime LIKE ?)
      LIMIT 2
    `).all(technicianId, customerName, startDate + '%');
    if (orphans.length === 1) orphan = orphans[0];
  }
  if (orphan) {
    const fabOrphan = resolveFabrikationsnummernForPull(db, orphan.id, j.fabrikationsnummern);
    db.prepare('UPDATE jobs SET server_id = ?, job_number = ?, customer_id = ?, job_type = ?, start_datetime = ?, end_datetime = ?, status = ?, description = ?, fabrikationsnummern = ?, eap_nummer = ?, bestellnummer = ?, synced_at = datetime(\'now\') WHERE id = ?').run(
      id, j.job_number || null, customerId, j.job_type || 'Service', start, end, status, j.description || null, fabOrphan, j.eap_nummer || null, j.bestellnummer || null, orphan.id
    );
    if (j.street != null) insertOrUpdateJobAddress(db, orphan.id, j);
    if (hasHotelFields(j)) insertOrUpdateJobHotel(db, orphan.id, j);
    return orphan.id;
  }
  const r2 = db.prepare('INSERT INTO jobs (server_id, job_number, customer_id, job_type, start_datetime, end_datetime, status, description, fabrikationsnummern, eap_nummer, bestellnummer, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(
    id, j.job_number || null, customerId, j.job_type || 'Service', start, end, status, j.description || null, j.fabrikationsnummern || null, j.eap_nummer || null, j.bestellnummer || null
  );
  const newId = r2.lastInsertRowid;
  const dispCountNew = Number(j.dispo_jt_count);
  // Auf Dispo ohne Techniker: keine lokale Zuordnung erzeugen (sonst „nicht unzugewiesen“ mehr). Ohne Feld: Altserver-Verhalten.
  const assignLocalTech = !Number.isFinite(dispCountNew) || dispCountNew > 0;
  if (assignLocalTech) {
    db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(newId, technicianId);
  }
  if (j.street != null) insertOrUpdateJobAddress(db, newId, j);
  if (hasHotelFields(j)) insertOrUpdateJobHotel(db, newId, j);
  return newId;
}

function hasHotelFields(j) {
  return ['hotel_endkunde', 'hotel_street', 'hotel_house_number', 'hotel_zip', 'hotel_city', 'hotel_country', 'hotel_phone', 'hotel_email', 'hotel_website'].some((k) => j[k] != null && String(j[k]).trim() !== '');
}

function insertOrUpdateJobHotel(db, jobId, j) {
  const endkunde = (j.hotel_endkunde != null ? String(j.hotel_endkunde) : '').trim() || null;
  const street = (j.hotel_street != null ? String(j.hotel_street) : '').trim() || '';
  const house_number = (j.hotel_house_number != null ? String(j.hotel_house_number) : '').trim() || '';
  const zip = (j.hotel_zip != null ? String(j.hotel_zip) : '').trim() || '';
  const city = (j.hotel_city != null ? String(j.hotel_city) : '').trim() || '';
  const country = (j.hotel_country != null ? String(j.hotel_country) : '').trim() || null;
  const address_extra_1 = (j.hotel_address_extra_1 != null ? String(j.hotel_address_extra_1) : '').trim() || null;
  const address_extra_2 = (j.hotel_address_extra_2 != null ? String(j.hotel_address_extra_2) : '').trim() || null;
  const phone = (j.hotel_phone != null ? String(j.hotel_phone) : '').trim() || null;
  const email = (j.hotel_email != null ? String(j.hotel_email) : '').trim() || null;
  const website = (j.hotel_website != null ? String(j.hotel_website) : '').trim() || null;
  const existing = db.prepare('SELECT job_id FROM job_hotel_addresses WHERE job_id = ?').get(jobId);
  if (existing) {
    db.prepare('UPDATE job_hotel_addresses SET endkunde=?, street=?, house_number=?, zip=?, city=?, country=?, address_extra_1=?, address_extra_2=?, phone=?, email=?, website=? WHERE job_id=?').run(endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website, jobId);
  } else {
    db.prepare('INSERT INTO job_hotel_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website);
  }
  const hotelId = Number(j.hotel_id || 0);
  const comment = j.hotel_comment != null ? String(j.hotel_comment) : null;
  const ratingStars = (j.hotel_rating_stars != null && String(j.hotel_rating_stars).trim() !== '') ? Number(j.hotel_rating_stars) : null;
  const ratingAvg = (j.hotel_rating_avg != null && String(j.hotel_rating_avg).trim() !== '') ? Number(j.hotel_rating_avg) : null;
  const ratingCount = (j.hotel_rating_count != null && String(j.hotel_rating_count).trim() !== '') ? Number(j.hotel_rating_count) : 0;
  if (Number.isFinite(hotelId) && hotelId > 0) {
    db.prepare(`
      INSERT INTO job_hotel_selection (job_id, hotel_id, comment, rating_stars, rating_avg, rating_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(job_id) DO UPDATE SET
        hotel_id=excluded.hotel_id,
        comment=excluded.comment,
        rating_stars=excluded.rating_stars,
        rating_avg=excluded.rating_avg,
        rating_count=excluded.rating_count,
        updated_at=datetime('now')
    `).run(jobId, hotelId, comment, Number.isFinite(ratingStars) ? ratingStars : null, Number.isFinite(ratingAvg) ? ratingAvg : null, Number.isFinite(ratingCount) ? ratingCount : 0);
  }
}

function insertOrUpdateJobAddress(db, jobId, j) {
  const endkunde = j.endkunde || null;
  const street = j.street || ''; const house = j.house_number || ''; const zip = j.zip || ''; const city = j.city || ''; const country = j.country || 'DE';
  db.prepare('INSERT OR REPLACE INTO job_addresses (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    jobId, endkunde, street, house, zip, city, country, j.address_extra_1 || null, j.address_extra_2 || null
  );
}

function insertOrUpdateAbsence(db, a, technicianId) {
  const serverId = a.id;
  const start = (a.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (a.end_datetime || '').replace('T', ' ').substring(0, 19);
  const type = a.type || '';
  const comment = a.comment != null && String(a.comment).trim() !== '' ? String(a.comment).trim() : null;
  const existing = db.prepare('SELECT id FROM absences WHERE server_id = ?').get(serverId);
  if (existing) {
    db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ?, comment = ?, synced_at = datetime(\'now\') WHERE id = ?').run(start, end, type, comment, existing.id);
    return;
  }
  db.prepare('INSERT INTO absences (server_id, technician_id, start_datetime, end_datetime, type, comment, synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(serverId, technicianId, start, end, type, comment);
}

/**
 * Löscht für einen erledigten Auftrag alle lokalen Job-Dateien, die nicht als „Nicht löschen“ markiert sind:
 * Einträge in job_files mit keep_local = 0 und ggf. zugehörige Dateien (stored_path).
 */
function cleanup_completed_job_files(db, jobId) {
  try {
    const rows = db.prepare('SELECT id, stored_path FROM job_files WHERE job_id = ? AND keep_local = 0').all(jobId);
    for (const r of rows) {
      if (r.stored_path && typeof r.stored_path === 'string' && r.stored_path.trim() !== '') {
        try {
          if (fs.existsSync(r.stored_path) && fs.statSync(r.stored_path).isFile()) {
            fs.unlinkSync(r.stored_path);
          }
        } catch (e) {
          // Einzelne Datei-Löschfehler ignorieren
        }
      }
    }
    db.prepare('DELETE FROM job_files WHERE job_id = ? AND keep_local = 0').run(jobId);
  } catch (e) {
    if (!e.message || (!e.message.includes('no such table') && !e.message.includes('job_files'))) {
      console.error('cleanup_completed_job_files:', e.message);
    }
  }
}

async function pushToServer(baseUrl, technicianId, db, authHeader) {
  const base = baseUrl.replace(/\/$/, '');
  const pending = db.prepare('SELECT * FROM pending_changes ORDER BY id').all();
  const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...(authHeader || {}) };
  for (const p of pending) {
    if (p.entity_type === 'job' && (p.action === 'status' || p.action === 'description' || p.action === 'fabrikationsnummern' || p.action === 'hotel_address' || p.action === 'hotel_selection')) {
      let job = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(p.entity_id);
      if (!job) job = db.prepare('SELECT id, server_id FROM jobs WHERE server_id = ?').get(p.entity_id);
      const hasServerId = job && job.server_id != null && String(job.server_id).trim() !== '';
      const serverJobId = hasServerId ? job.server_id : null;
      if (!job) {
        // Verwaiste Änderung: Auftrag existiert nicht mehr – Eintrag entfernen, Sync fortsetzen
        logSyncPushError({
          reason: 'pending_verwaist',
          pending_entity_id: p.entity_id,
          pending_action: p.action,
          hinweis: 'Auftrag wurde lokal nicht gefunden, Eintrag wird entfernt.'
        });
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        continue;
      }
      if (!serverJobId) {
        logSyncPushError({
          reason: 'job_ohne_server_id',
          pending_entity_id: p.entity_id,
          pending_action: p.action,
          job_gefunden: true,
          job_id_lokal: job.id,
          job_server_id: job.server_id,
          hinweis: 'Lokaler Auftrag hat keine Dispo-Verknüpfung (server_id). Nach Pull prüfen: gleiche Auftragsnummer/Kunde+Datum wie in der Dispo?'
        });
        throw new Error('Auftrag (lokal) ist noch nicht mit der Dispo verknüpft. Bitte zuerst „Von Dispo laden“ (Sync-Pull) ausführen, dann erneut Sync pushen.');
      }
      // Techniker-ID aus job_technicians verwenden (Auftrag ist diesem Techniker zugeordnet), nicht aus Einstellungen – sonst meldet Dispo „nicht zugeordnet“
      const techRow = job && job.id != null ? db.prepare('SELECT technician_id FROM job_technicians WHERE job_id = ? LIMIT 1').get(job.id) : null;
      const techIdForPush = (techRow && techRow.technician_id != null) ? techRow.technician_id : technicianId;
      const headerForJob = { 'Content-Type': 'application/json', 'X-Technician-Id': String(techIdForPush), ...(authHeader || {}) };
      const payload = JSON.parse(p.payload || '{}');
      if (p.action === 'fabrikationsnummern' && payload.fabrikationsnummern != null) {
        payload.fabrikationsnummern =
          typeof payload.fabrikationsnummern === 'string'
            ? clampFabrikationsnummernJson(payload.fabrikationsnummern)
            : JSON.stringify(
                (Array.isArray(payload.fabrikationsnummern) ? payload.fabrikationsnummern : []).map((row) =>
                  clampForDispoJobFabrikation(row),
                ),
              );
      }
      const body = { job_id: serverJobId, ...payload };
      const r = await fetch(`${base}/dispo_api/api/job.php?technician_id=${techIdForPush}`, { method: 'PATCH', headers: headerForJob, body: JSON.stringify(body) });
      if (!r.ok) {
        let errMsg = 'Dispo: ' + r.status;
        let errData = null;
        try {
          const text = await r.text();
          try { errData = JSON.parse(text); } catch (_) { errData = { _raw: text.substring(0, 500) }; }
          if (errData && typeof errData.error === 'string') errMsg = errData.error;
        } catch (_) {}
        const statusPushRejected = p.action === 'status'
          && r.status === 400
          && /Status-Update fehlgeschlagen/i.test(errMsg);
        if (statusPushRejected) {
          console.warn('[sync_push] Status nicht übernommen (Dispo-Übergang):', {
            job_id: serverJobId,
            technician_id: techIdForPush,
            payload_status: payload.status,
            error: errMsg,
          });
          continue;
        }
        logSyncPushError({
          reason: 'dispo_antwort_fehler',
          status: r.status,
          statusText: r.statusText,
          body: errData,
          gesendet_job_id: serverJobId,
          gesendet_technician_id: techIdForPush,
          action: p.action
        });
        throw new Error(errMsg);
      }
      db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      if (p.action === 'fabrikationsnummern' && payload.fabrikationsnummern !== undefined && job && job.id != null) {
        const fabVal =
          typeof payload.fabrikationsnummern === 'string'
            ? payload.fabrikationsnummern
            : JSON.stringify(payload.fabrikationsnummern);
        db.prepare(`UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now') WHERE id = ?`).run(fabVal, job.id);
      }
      if (p.action === 'status' && payload.status === 'erledigt') {
        const localJobId = (job && job.id) || p.entity_id;
        cleanup_completed_job_files(db, localJobId);
        db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(localJobId, techIdForPush);
        const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(localJobId);
        if (!rest) {
          db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(localJobId);
          db.prepare('DELETE FROM jobs WHERE id = ?').run(localJobId);
        }
      }
    }
    if (p.entity_type === 'absence') {
      if (p.action === 'create') {
        const payload = JSON.parse(p.payload || '{}');
        const r = await fetch(`${base}/api/absence.php?technician_id=${technicianId}`, { method: 'POST', headers: header, body: JSON.stringify({ ...payload, technician_id: technicianId }) });
        if (r.ok) {
          const result = await r.json();
          if (result.id) db.prepare('UPDATE absences SET server_id = ? WHERE id = ?').run(result.id, p.entity_id);
          db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        }
      } else if (p.action === 'update') {
        const row = db.prepare('SELECT server_id FROM absences WHERE id = ?').get(p.entity_id);
        const serverAbsenceId = (row && row.server_id) ? row.server_id : p.entity_id;
        const payload = JSON.parse(p.payload || '{}');
        const r = await fetch(`${base}/api/absence.php?technician_id=${technicianId}`, { method: 'PATCH', headers: header, body: JSON.stringify({ id: serverAbsenceId, ...payload }) });
        if (r.ok) db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } else if (p.action === 'delete') {
        const r = await fetch(`${base}/api/absence.php?id=${p.entity_id}&technician_id=${technicianId}`, { method: 'DELETE' });
        if (r.ok) db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      }
    }
    if (p.entity_type === 'anlagenstamm' && p.action === 'save') {
      const payload = JSON.parse(p.payload || '{}');
      const techId = parseInt(String(payload.technician_id ?? technicianId), 10) || technicianId;
      try {
        const data = await proxyAnlagenstammSave(
          Object.assign({}, clampForDispoAnlagenstamm(payload), { technician_id: techId }),
        );
        if (data && data.ok === false) {
          throw new Error(data.error || 'Anlagenstamm speichern fehlgeschlagen.');
        }
        const fab = String(payload.fabrikationsnummer ?? '').trim();
        if (fab) {
          if (data && data.id) {
            db.prepare('UPDATE anlagenstamm_local SET id = ?, dirty = 0 WHERE fabrikationsnummer = ?').run(
              parseInt(data.id, 10),
              fab,
            );
          } else {
            db.prepare('UPDATE anlagenstamm_local SET dirty = 0 WHERE fabrikationsnummer = ?').run(fab);
          }
        }
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
      } catch (e) {
        logSyncPushError({
          reason: 'anlagenstamm_save',
          error: e && e.message ? e.message : String(e),
          entity_id: p.entity_id,
        });
        throw e;
      }
    }
  }
  const pendingRequests = db.prepare('SELECT id, start_datetime, end_datetime, type, comment FROM absence_requests WHERE technician_id = ? AND status = ? AND (server_id IS NULL OR server_id = \'\')').all(technicianId, 'pending');
  for (const row of pendingRequests) {
    try {
      const r = await fetch(`${base}/api/absence_request.php`, {
        method: 'POST',
        headers: header,
        body: JSON.stringify({
          technician_id: technicianId,
          start_datetime: row.start_datetime,
          end_datetime: row.end_datetime,
          type: row.type || null,
          comment: row.comment != null && String(row.comment).trim() !== '' ? String(row.comment).trim() : null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok && data.id) {
        db.prepare('UPDATE absence_requests SET server_id = ?, synced_at = datetime(\'now\') WHERE id = ?').run(data.id, row.id);
      } else if (r.status >= 400 && r.status < 500) {
        // Dauerhafter fachlicher Fehler – nicht weiter als pending behandeln.
        logAbsenceRequestError({ context: 'sync', status: r.status, body: data, technicianId, baseUrl: base });
        db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE id = ?').run('error', row.id);
      }
    } catch (e) {}
  }
  try {
    const statusRes = await fetch(`${base}/api/absence_request_status.php?technician_id=${technicianId}`, { headers: authHeader || {} });
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusData.ok && Array.isArray(statusData.requests)) {
      for (const req of statusData.requests) {
        if (req.id != null && req.status && req.status !== 'pending') {
          db.prepare('UPDATE absence_requests SET status = ?, synced_at = datetime(\'now\') WHERE server_id = ? AND technician_id = ?').run(req.status, req.id, technicianId);
        }
      }
    }
  } catch (e) {}
  try {
    const erledigtJobs = db.prepare('SELECT id FROM jobs WHERE status = ?').all('erledigt');
    for (const j of erledigtJobs) {
      const hasPending = db.prepare('SELECT 1 FROM pending_changes WHERE entity_type = ? AND entity_id = ?').get('job', j.id);
      if (!hasPending) {
        cleanup_completed_job_files(db, j.id);
      }
    }
  } catch (e) {}
}

module.exports = { createApp, getDb, PORT };
