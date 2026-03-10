/**
 * Lokaler API-Server für die Monteur WebApp (Offline).
 * Verwendet sql.js (WASM, kein nativer Build); läuft im Electron-Hauptprozess.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const FormData = require('form-data');

const PORT = 39678;
const DB_DIR = path.join(__dirname, 'db');

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
  return createDbWrapper(sqlDb);
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

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

  const save = () => db.save();

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
    res.json({ version: appVersion });
  });

  app.get('/api/dienstreise/config', (req, res) => {
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
  });

  app.post('/api/dienstreise/config', express.json(), (req, res) => {
    const basePath = (req.body && req.body.basePath != null) ? String(req.body.basePath) : '';
    setDienstreiseBasePath(basePath);
    res.json({ ok: true, basePath: getDienstreiseBasePath() });
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

  function getServerJobId(localJobId) {
    const row = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(localJobId);
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
        const opts = { headers: { 'X-Technician-Id': String(technicianId), ...authHeader } };
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
          'X-Technician-Id': String(technicianId),
          ...authHeader,
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
      WHERE j.id = ?
    `).get(localJobId);
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
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '');
      await syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword);
      if (dispoBaseUrl) {
        try {
          await syncProtokollTemplates(dispoBaseUrl);
        } catch (tplErr) {
          console.warn('Protokoll-Vorlagen Sync fehlgeschlagen (offline-Vorlagen weiter nutzbar):', tplErr.message);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Sync zum Dispo-Server fehlgeschlagen.' });
    }
  });

  app.post('/api/dienstreise/copy_project', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const dispoBaseUrl = (body.dispoBaseUrl || body.dispo_base_url || '').trim().replace(/\/$/, '');
      const technicianId = parseInt(body.technicianId != null ? body.technicianId : body.technician_id, 10);
      const dispoUsername = (body.dispoUsername || body.dispo_username || '').trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.dispo_password != null ? String(body.dispo_password) : '');

      if (!localJobId || !dispoBaseUrl || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id (lokal), dispoBaseUrl und technicianId erforderlich.' });
      }

      const jobRow = db.prepare('SELECT id, server_id FROM jobs WHERE id = ?').get(localJobId);
      if (!jobRow) return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      const jobId = jobRow.server_id != null ? jobRow.server_id : jobRow.id;

      const targetDir = getOrCreateDienstreiseFolderForJob(localJobId);
      if (!targetDir || !fs.existsSync(targetDir)) return res.status(400).json({ ok: false, error: 'Zielordner konnte nicht erstellt werden.' });

      const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};

      async function listEntries(relPath) {
        const pathQ = relPath ? '&path=' + encodeURIComponent(relPath) : '';
        const url = dispoBaseUrl + '/api/job_project_files_list.php?technician_id=' + technicianId + '&job_id=' + jobId + pathQ;
        const opts = { headers: { 'X-Technician-Id': String(technicianId), ...authHeader } };
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
        const opts = { headers: { 'X-Technician-Id': String(technicianId), ...authHeader } };
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
            headers: {
              'X-Technician-Id': String(technicianId),
              'Content-Type': 'application/x-www-form-urlencoded',
              ...authHeader,
            },
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
          const opts = { headers: { 'X-Technician-Id': String(technicianId), ...authHeader } };
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

      function deleteRecursively(dir, relBase) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (isProtected(rel)) continue;
          if (e.isDirectory()) {
            deleteRecursively(full, rel);
            try {
              removeIgnorableFilesInDir(full);
              const rest = fs.readdirSync(full);
              if (rest.length === 0 && !isProtected(rel)) fs.rmdirSync(full);
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
              removeIgnorableFilesInDir(full);
              const rest = fs.readdirSync(full);
              if (rest.length === 0 && !isProtected(rel)) fs.rmdirSync(full);
            } catch (err) { /* ignore */ }
          }
        }
      }
      removeEmptyDirs(reiseDir, '');

      // Leeren Dienstreise-Ordner selbst entfernen (z. B. 1_2026-02-16_Kopierkunde_sss_AT)
      try {
        removeIgnorableFilesInDir(reiseDir);
        if (fs.existsSync(reiseDir) && fs.readdirSync(reiseDir).length === 0) {
          fs.rmdirSync(reiseDir);
        }
      } catch (err) { /* ignore */ }

      // Job lokal als "erledigt" markieren UND eine Pending-Änderung anlegen,
      // damit der Status beim nächsten Sync auch im Dispo gesetzt wird
      try {
        if (technicianId) {
          const r = db.prepare(`
            UPDATE jobs SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND id IN (SELECT job_id FROM job_technicians WHERE technician_id = ?)
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
        ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2
      FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      WHERE 1=1`;
    const params = [technicianId];
    if (!includeErledigt) {
      sql += ` AND j.status != 'erledigt'`;
    }
    if (dateFrom) { sql += ' AND j.start_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
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
        ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2
      FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      WHERE j.status = 'erledigt'
        AND strftime('%Y', j.end_datetime) = ?`;
    const params = [technicianId, String(year)];

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
        ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2
      FROM jobs j
      INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
      INNER JOIN customers c ON c.id = j.customer_id
      LEFT JOIN job_addresses ja ON ja.job_id = j.id
      WHERE j.id = ?
    `).get(technicianId, jobId);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
    }
    let job = row;
    const baseUrl = (req.query.base_url || '').toString().trim();
    const enrich = req.query.enrich_anlagenstamm === '1' || req.query.enrich_anlagenstamm === 'true';
    if (enrich && baseUrl) {
      const auth = authHeaderFromCredentials(req.query.serverUsername, req.query.serverPassword);
      job = await enrichJobFabWithAnlagenstamm(job, baseUrl, auth);
    }
    res.json({ ok: true, job });
  });

  app.post('/api/job_from_dispo', express.json(), async (req, res) => {
    const technicianId = getTechnicianId(req);
    const { baseUrl, jobId: localJobId } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !base || localJobId == null) {
      return res.status(400).json({ ok: false, error: 'baseUrl, jobId und technician_id erforderlich.' });
    }
    const localId = parseInt(localJobId, 10);
    const row = db.prepare('SELECT id, server_id FROM jobs WHERE id = ? AND id IN (SELECT job_id FROM job_technicians WHERE technician_id = ?)').get(localId, technicianId);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
    }
    const serverJobId = (row.server_id != null && row.server_id !== '') ? row.server_id : localId;
    const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
    const url = `${base}/api/job.php?id=${encodeURIComponent(serverJobId)}&technician_id=${encodeURIComponent(technicianId)}&debug=1`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: data.error || r.statusText });
      }
      if (data.job && typeof data.job === 'object') {
        if (data.job.fabrikationsnummern == null && data.job.Fabrikationsnummern != null) {
          data.job.fabrikationsnummern = data.job.Fabrikationsnummern;
        }
        data.job = await enrichJobFabWithAnlagenstamm(data.job, base, auth);
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Dispo nicht erreichbar: ' + e.message });
    }
  });

  app.post('/api/anlagenstamm_from_dispo', express.json(), async (req, res) => {
    const { baseUrl, fabs } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const list = Array.isArray(fabs) ? fabs.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim()) : [];
    if (!base || list.length === 0) {
      return res.status(400).json({ ok: false, error: 'baseUrl und fabs (Array) erforderlich.' });
    }
    const auth = authHeaderFromCredentials(req.body.serverUsername, req.body.serverPassword);
    const url = `${base}/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(list.join(','))}`;
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
        INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
        WHERE j.id = ?
      `).get(technicianId, localJobId);
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
      const freitext = (body.freitext || '').trim();

      if (!localJobId || !technicianId) {
        return res.status(400).json({ ok: false, error: 'job_id und technician_id erforderlich.' });
      }

      const jobRow = db.prepare(`
        SELECT j.id, j.server_id, j.start_datetime, j.end_datetime, j.job_number, j.description, j.fabrikationsnummern,
          c.name AS customer_name, c.street AS cust_street, c.house_number AS cust_house, c.zip AS cust_zip, c.city AS cust_city,
          ja.street, ja.house_number, ja.zip, ja.city, ja.country
        FROM jobs j
        INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
        INNER JOIN customers c ON c.id = j.customer_id
        LEFT JOIN job_addresses ja ON ja.job_id = j.id
        WHERE j.id = ?
      `).get(technicianId, localJobId);
      if (!jobRow) {
        return res.status(404).json({ ok: false, error: 'Auftrag nicht gefunden.' });
      }

      const toFab = (f) => (f != null && (typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer))) ? String(typeof f === 'string' ? f : (f.fabrikationsnummer ?? f.Fabrikationsnummer)).trim() : '';
      let dbFabRows = [];
      const serverJobId = jobRow.server_id != null ? jobRow.server_id : localJobId;
      if (dispoBaseUrl && serverJobId) {
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

      const reiseDir = getOrCreateDienstreiseFolderForJob(localJobId);
      const ordnerName = path.basename(reiseDir);
      const pdfFilename = ordnerName + '_Montage.pdf';

      const toTextbausteine = (bem) => (bem || '').toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t }));
      const bemerkungenByFn = {};
      for (const fb of fabBemerkungen || []) {
        const fn = toFab(fb);
        if (fn) {
          const explicitTb = Array.isArray(fb.textbausteine) && fb.textbausteine.length > 0
            ? fb.textbausteine.map((t) => ({ text: String(t && t.text != null ? t.text : '').trim() })).filter((t) => t.text)
            : null;
          const tb = explicitTb && explicitTb.length > 0 ? explicitTb : toTextbausteine(fb && fb.bemerkungen);
          bemerkungenByFn[fn] = tb;
        }
      }
      const tableRows = dbFabRows.map((row) => {
        const fn = (row.fabrikationsnummer || '').toString().trim();
        const type = (row.type || '').toString().trim();
        const position = (row.position || '').toString().trim();
        const userTb = bemerkungenByFn[fn];
        const tb = (userTb && userTb.length > 0) ? userTb : (Array.isArray(row.textbausteine) ? row.textbausteine.map((t) => ({ text: String(t && t.text != null ? t.text : '').trim() })).filter((t) => t.text) : []);
        const bemerk = tb.map((x) => x.text).join('\n');
        return { fabrikationsnummer: fn, type, position, textbausteine: tb, bemerkungen: bemerk };
      });

      let docxBytes = null;
      try {
        const { buildMontageberichtDocx } = require('./montagebericht_docx');
        docxBytes = await buildMontageberichtDocx({
          kopfdaten,
          tableRows,
          language,
          jobRow,
          grundDesEinsatzes,
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

      const jobId = jobRow.server_id != null ? jobRow.server_id : localJobId;
      const docAnlageBase = path.join(reiseDir, 'Dokumente_Anlage');
      const docxFilename = ordnerName + '_Montage.docx';

      for (const fab of fabs) {
        const fabSafe = sanitizeDienstreiseFolderPart(fab);
        const montageDir = path.join(docAnlageBase, fabSafe, 'Montage');
        if (!fs.existsSync(montageDir)) {
          const docFabDir = path.join(docAnlageBase, fabSafe);
          if (!fs.existsSync(docFabDir)) fs.mkdirSync(docFabDir, { recursive: true });
          fs.mkdirSync(montageDir, { recursive: true });
        }
        const targetPath = path.join(montageDir, pdfFilename);
        writeFileWithRetry(targetPath, pdfBytes);
        if (docxBytes) {
          writeFileWithRetry(path.join(montageDir, docxFilename), docxBytes);
        }
      }

      const montageberichtDataPath = path.join(reiseDir, 'montagebericht.json');
      writeFileWithRetry(montageberichtDataPath, JSON.stringify({
        grundDesEinsatzes,
        fabBemerkungen,
        language,
      }, null, 2));

      const dispoUsername = (body.dispoUsername || body.serverUsername || '').toString().trim();
      const dispoPassword = (body.dispoPassword != null ? String(body.dispoPassword) : body.serverPassword != null ? String(body.serverPassword) : '');

      if (dispoBaseUrl && technicianId) {
        try {
          await syncDienstreiseFoldersToDispo(localJobId, dispoBaseUrl, technicianId, dispoUsername, dispoPassword);
        } catch (syncErr) {
          return res.json({ ok: true, warning: 'PDF gespeichert, Sync zum Dispo fehlgeschlagen: ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)) });
        }
        const authHeader = (dispoUsername || dispoPassword) ? { Authorization: 'Basic ' + Buffer.from(dispoUsername + ':' + dispoPassword).toString('base64') } : {};
        try {
          const saveDataRes = await fetch(dispoBaseUrl + '/dispo_api/api/montagebericht_data_save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...authHeader },
            body: JSON.stringify({
              technician_id: technicianId,
              job_id: jobId,
              data: tableRows.map((r) => ({
                fabrikationsnummer: r.fabrikationsnummer,
                type: r.type,
                position: r.position,
                textbausteine: r.textbausteine,
              })),
            }),
          });
          if (!saveDataRes.ok) {
            console.warn('Montagebericht-Daten konnten nicht in Dispo gespeichert werden:', saveDataRes.status);
          }
        } catch (saveErr) {
          console.warn('Montagebericht-Daten-Save fehlgeschlagen:', saveErr && saveErr.message);
        }
        const anlagenstammUrl = dispoBaseUrl + '/dispo_api/api/anlagenstamm_montagebericht_save.php';
        const tableRowByFab = {};
        for (const r of tableRows) {
          const fn = (r.fabrikationsnummer || '').toString().trim();
          if (fn) tableRowByFab[fn] = r;
        }
        for (const fab of fabs) {
          try {
            const row = tableRowByFab[fab] || {};
            const form = new FormData();
            form.append('technician_id', String(technicianId));
            form.append('job_id', String(jobId));
            form.append('fabrikationsnummer', fab);
            form.append('type', (row.type || '').toString());
            form.append('position', (row.position || '').toString());
            form.append('textbausteine', JSON.stringify(row.textbausteine || []));
            form.append('file', Buffer.from(pdfBytes), { filename: pdfFilename });
            const parsed = new URL(anlagenstammUrl);
            const headers = form.getHeaders();
            headers['X-Technician-Id'] = String(technicianId);
            if (authHeader && authHeader.Authorization) headers.Authorization = authHeader.Authorization;
            await new Promise((resolve, reject) => {
              form.submit({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + (parsed.search || ''),
                method: 'POST',
                headers,
              }, (err, res) => {
                if (err) return reject(err);
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                  if (res.statusCode >= 200 && res.statusCode < 300) resolve();
                  else {
                    try {
                      const data = body ? JSON.parse(body) : {};
                      reject(new Error(data.error || 'Upload fehlgeschlagen (' + res.statusCode + ')'));
                    } catch (e) {
                      reject(new Error('Upload fehlgeschlagen (' + res.statusCode + '): ' + body));
                    }
                  }
                });
              });
            });
          } catch (uploadErr) {
            console.warn('Anlagenstamm Montagebericht PDF-Upload für Fab ' + fab + ' fehlgeschlagen:', uploadErr.message);
          }
          if (docxBytes) {
            try {
              const formDocx = new FormData();
              formDocx.append('technician_id', String(technicianId));
              formDocx.append('job_id', String(jobId));
              formDocx.append('fabrikationsnummer', fab);
              formDocx.append('file', docxBytes, { filename: docxFilename });
              const parsedDocx = new URL(anlagenstammUrl);
              const headersDocx = formDocx.getHeaders();
              headersDocx['X-Technician-Id'] = String(technicianId);
              if (authHeader && authHeader.Authorization) headersDocx.Authorization = authHeader.Authorization;
              await new Promise((resolve, reject) => {
                formDocx.submit({
                  protocol: parsedDocx.protocol,
                  hostname: parsedDocx.hostname,
                  port: parsedDocx.port || (parsedDocx.protocol === 'https:' ? 443 : 80),
                  path: parsedDocx.pathname + (parsedDocx.search || ''),
                  method: 'POST',
                  headers: headersDocx,
                }, (err, resDocx) => {
                  if (err) return reject(err);
                  let bodyDocx = '';
                  resDocx.setEncoding('utf8');
                  resDocx.on('data', (chunk) => { bodyDocx += chunk; });
                  resDocx.on('end', () => {
                    if (resDocx.statusCode >= 200 && resDocx.statusCode < 300) resolve();
                    else {
                      try {
                        const dataDocx = bodyDocx ? JSON.parse(bodyDocx) : {};
                        reject(new Error(dataDocx.error || 'DOCX-Upload fehlgeschlagen (' + resDocx.statusCode + ')'));
                      } catch (e) {
                        reject(new Error('DOCX-Upload fehlgeschlagen (' + resDocx.statusCode + '): ' + bodyDocx));
                      }
                    }
                  });
                });
              });
            } catch (docxUploadErr) {
              console.warn('Anlagenstamm Montagebericht DOCX-Upload für Fab ' + fab + ' fehlgeschlagen:', docxUploadErr.message);
            }
          }
        }
      }

      res.json({ ok: true, saved: fabs.map((f) => path.join('Dokumente_Anlage', sanitizeDienstreiseFolderPart(f), 'Montage', pdfFilename)), savedDocx: docxBytes ? fabs.map((f) => path.join('Dokumente_Anlage', sanitizeDienstreiseFolderPart(f), 'Montage', docxFilename)) : null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Montagebericht konnte nicht erstellt werden.' });
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
    if (!baseUrl || !body.id) return res.status(400).json({ ok: false, error: 'baseUrl und id erforderlich.' });
    try {
      const formBody = new URLSearchParams();
      formBody.append('id', body.id);
      const r = await fetch(baseUrl + '/dispo_api/api/textbausteine_category_delete.php', {
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

  app.patch('/api/job', (req, res) => {
    const technicianId = getTechnicianId(req);
    const { job_id, status, description, fabrikationsnummern } = req.body || {};
    if (!technicianId || !job_id) {
      return res.status(400).json({ ok: false, error: 'technician_id und job_id erforderlich.' });
    }
    const allowed = ['geplant', 'in_arbeit', 'erledigt'];
    try {
      if (status && allowed.includes(status)) {
        const r = db.prepare(`
          UPDATE jobs SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND id IN (SELECT job_id FROM job_technicians WHERE technician_id = ?)
        `).run(status, job_id, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', job_id, 'status', JSON.stringify({ status }));
          save();
          return res.json({ ok: true, updated: 'status' });
        }
      }
      if (description !== undefined) {
        const r = db.prepare(`
          UPDATE jobs SET description = ?, updated_at = datetime('now')
          WHERE id = ? AND id IN (SELECT job_id FROM job_technicians WHERE technician_id = ?)
        `).run(description, job_id, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', job_id, 'description', JSON.stringify({ description }));
          save();
          return res.json({ ok: true, updated: 'description' });
        }
      }
      if (fabrikationsnummern !== undefined) {
        const val = typeof fabrikationsnummern === 'string' ? fabrikationsnummern : (fabrikationsnummern != null ? JSON.stringify(fabrikationsnummern) : null);
        const r = db.prepare(`
          UPDATE jobs SET fabrikationsnummern = ?, updated_at = datetime('now')
          WHERE id = ? AND id IN (SELECT job_id FROM job_technicians WHERE technician_id = ?)
        `).run(val, job_id, technicianId);
        if (r.changes) {
          db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run('job', job_id, 'fabrikationsnummern', JSON.stringify({ fabrikationsnummern: val }));
          save();
          return res.json({ ok: true, updated: 'fabrikationsnummern' });
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
    let sql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type FROM absences WHERE technician_id = ?';
    const params = [technicianId];
    if (dateFrom) { sql += ' AND end_datetime >= ?'; params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { sql += ' AND start_datetime <= ?'; params.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY start_datetime ASC';
    const rows = db.prepare(sql).all(...params);
    const byKey = new Map();
    rows.forEach((r) => byKey.set(r.start_datetime + '\t' + r.end_datetime, true));
    // Genehmigte und ausstehende Abwesenheitsanfragen mit anzeigen (z. B. eigene Abwesenheit in Einzeltechniker-Ansicht)
    let reqSql = 'SELECT id, server_id, technician_id, start_datetime, end_datetime, type, status FROM absence_requests WHERE technician_id = ? AND status IN (\'approved\', \'pending\')';
    const reqParams = [technicianId];
    if (dateFrom) { reqSql += ' AND end_datetime >= ?'; reqParams.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { reqSql += ' AND start_datetime <= ?'; reqParams.push(dateTo + ' 23:59:59'); }
    reqSql += ' ORDER BY start_datetime ASC';
    const requests = db.prepare(reqSql).all(...reqParams);
    requests.forEach((r) => {
      const key = r.start_datetime + '\t' + r.end_datetime;
      if (!byKey.has(key)) {
        byKey.set(key, true);
        rows.push({ id: r.id, server_id: r.server_id, technician_id: r.technician_id, start_datetime: r.start_datetime, end_datetime: r.end_datetime, type: r.type, from_absence_request: true, status: r.status });
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
    const rows = db.prepare('SELECT id, server_id, technician_id, start_datetime, end_datetime, type, status, requested_at, synced_at FROM absence_requests WHERE technician_id = ? ORDER BY requested_at DESC').all(technicianId);
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
    const baseUrl = (body.base_url || body.baseUrl || '').toString().trim().replace(/\/$/, '');
    if (!technicianId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : String(v).trim();
    const startNorm = norm(start);
    const endNorm = norm(end);
    try {
      const r = db.prepare('INSERT INTO absence_requests (technician_id, start_datetime, end_datetime, type, status) VALUES (?, ?, ?, ?, ?)').run(technicianId, startNorm, endNorm, type || null, 'pending');
      const localId = r.lastInsertRowid;
      save();
      if (baseUrl) {
        const header = { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) };
        const auth = authHeaderFromCredentials(body.serverUsername, body.serverPassword);
        if (auth) header.Authorization = auth.Authorization;
        fetch(baseUrl + '/api/absence_request.php', {
          method: 'POST',
          headers: header,
          body: JSON.stringify({ technician_id: technicianId, start_datetime: startNorm, end_datetime: endNorm, type: type || null }),
        }).then(async (resp) => {
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.success && data.id) {
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
    if (!technicianId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : v.trim();
    try {
      const r = db.prepare('INSERT INTO absences (technician_id, start_datetime, end_datetime, type) VALUES (?, ?, ?, ?)').run(technicianId, norm(start), norm(end), type || '');
      const id = r.lastInsertRowid;
      db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', id, 'create', JSON.stringify({ start_datetime: norm(start), end_datetime: norm(end), type }));
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
    if (!technicianId || !id || !start || !end) {
      return res.status(400).json({ ok: false, error: 'technician_id, id, start_datetime und end_datetime erforderlich.' });
    }
    const norm = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? v.trim() + ' 00:00:00' : v.trim();
    try {
      const r = db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ? WHERE id = ? AND technician_id = ?').run(norm(start), norm(end), type || '', id, technicianId);
      if (r.changes) {
        db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', id, 'update', JSON.stringify({ start_datetime: norm(start), end_datetime: norm(end), type }));
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

  async function enrichJobFabWithAnlagenstamm(job, baseUrl, authHeader) {
    if (!job || !baseUrl || typeof job.fabrikationsnummern !== 'string') return job;
    const fab = job.fabrikationsnummern.trim();
    if (!fab) return job;
    let parts = [];
    try {
      const parsed = JSON.parse(fab);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hasLeistung = parsed.some((r) => (r.type && r.type.trim()) || (r.leistung && r.leistung.trim()) || (r.nenngeschwindigkeit && r.nenngeschwindigkeit.trim()) || (r.kraftaufnehmer && r.kraftaufnehmer.trim()) || (r.dms_nr && r.dms_nr.trim()) || (r.tacho && r.tacho.trim()) || (r.elektronik && r.elektronik.trim()) || (r.material && r.material.trim()) || (r.position && r.position.trim()));
        if (hasLeistung) return job;
        parts = parsed
          .map((r) => (r && (r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer) != null
            ? String(r.fabrikationsnummer != null ? r.fabrikationsnummer : r.Fabrikationsnummer).trim()
            : ''))
          .filter(Boolean);
      }
    } catch (e) { /* no json */ }
    if (parts.length === 0) parts = fab.split(/[\s;,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return job;
    const base = baseUrl.toString().trim().replace(/\/$/, '');
    const url = `${base}/api/anlagenstamm_by_fab.php?fabs=${encodeURIComponent(parts.join(','))}`;
    let debugInfo = { url, requestedFabs: parts.slice(), ok: false, matchCount: 0, status: null };
    try {
      const r = await fetch(url, authHeader ? { headers: authHeader } : {});
      const data = await r.json().catch(() => ({}));
      debugInfo.ok = !!r.ok;
      debugInfo.status = r.status;
      debugInfo.matchCount = Array.isArray(data.data) ? data.data.length : 0;
      if (r.ok && Array.isArray(data.data) && data.data.length > 0) {
        const j = { ...job, _anlagenstamm_debug: debugInfo };
        j.fabrikationsnummern = JSON.stringify(data.data);
        return j;
      }
    } catch (e) {
      debugInfo.error = e && e.message ? e.message : String(e);
    }
    return { ...job, _anlagenstamm_debug: debugInfo };
  }

  app.post('/api/check_connection', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    const base = (baseUrl || '').toString().trim().replace(/\/$/, '');
    const techId = technicianId != null ? technicianId : 1;
    if (!base) {
      return res.json({ ok: false, error: 'Server-URL fehlt.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const url = `${base}/api/my_jobs.php?technician_id=${techId}`;
    try {
      const r = await fetch(url, auth ? { headers: auth } : {});
      if (r.ok) return res.json({ ok: true });
      let msg = 'Server antwortet mit ' + r.status;
      const body = await r.text();
      try {
        const data = JSON.parse(body);
        if (data && typeof data.error === 'string' && data.error.trim()) {
          msg = data.error.trim();
          if (r.status === 403) msg = 'Monteur wird nicht anerkannt: ' + msg;
        }
      } catch (_) {
        if (r.status === 500 && body && body.length > 0) {
          const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200);
          if (/Fatal error|Parse error|Exception|Warning:/i.test(snippet)) {
            msg = 'Dispo-Server-Fehler (500). In C:\\xampp_2\\apache\\logs\\error.log nachsehen. Vorschau: ' + snippet;
          }
        }
      }
      return res.json({ ok: false, error: msg });
    } catch (e) {
      return res.json({ ok: false, error: 'Dispo nicht erreichbar: ' + (e.message || String(e)) });
    }
  });

  app.post('/api/sync_pull', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, date_from, date_to } = req.body || {};
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    const base = (baseUrl || '').trim().replace(/\/$/, '');
    try {
      await pullFromServer(base, technicianId, db, auth, date_from, date_to);
      save();
      try {
        await syncProtokollTemplates(base);
      } catch (tplErr) {
        console.warn('Protokoll-Vorlagen Sync fehlgeschlagen:', tplErr.message);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/sync_push', express.json(), (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword } = req.body || {};
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    pushToServer(baseUrl, technicianId, db, auth).then(() => {
      save();
      res.json({ ok: true });
    }).catch((e) => res.status(500).json({ ok: false, error: e.message }));
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
          const jr = await fetch(`${baseUrl}/api/job.php?id=${encodeURIComponent(jobId)}&technician_id=${encodeURIComponent(techId)}`, opts);
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

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

function removeLocalJobsNotInDispo(db, technicianId, receivedJobServerIds) {
  const rows = db.prepare(
    'SELECT j.id, j.server_id FROM jobs j INNER JOIN job_technicians jt ON jt.job_id = j.id WHERE jt.technician_id = ?'
  ).all(technicianId);
  for (const row of rows) {
    const serverId = row.server_id != null && row.server_id !== '' ? row.server_id : row.id;
    if (receivedJobServerIds.has(Number(serverId)) || receivedJobServerIds.has(String(serverId))) continue;
    db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(row.id, technicianId);
    const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(row.id);
    if (!rest) {
      db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(row.id);
      db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
    }
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

function insertOrUpdateJob(db, j, customerId, technicianId) {
  const id = j.id;
  const existing = db.prepare('SELECT id FROM jobs WHERE server_id = ?').get(id);
  const start = (j.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (j.end_datetime || '').replace('T', ' ').substring(0, 19);
  const status = ['geplant', 'in_arbeit', 'erledigt'].includes(j.status) ? j.status : 'geplant';
    if (existing) {
    db.prepare('UPDATE jobs SET job_number = ?, customer_id = ?, job_type = ?, start_datetime = ?, end_datetime = ?, status = ?, description = ?, fabrikationsnummern = ?, eap_nummer = ?, bestellnummer = ?, synced_at = datetime(\'now\') WHERE id = ?').run(
      j.job_number || null, customerId, j.job_type || 'Service', start, end, status, j.description || null, j.fabrikationsnummern || null, j.eap_nummer || null, j.bestellnummer || null, existing.id
    );
    if (j.street != null) insertOrUpdateJobAddress(db, existing.id, j);
    return existing.id;
  }
  const r2 = db.prepare('INSERT INTO jobs (server_id, job_number, customer_id, job_type, start_datetime, end_datetime, status, description, fabrikationsnummern, eap_nummer, bestellnummer, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(
    id, j.job_number || null, customerId, j.job_type || 'Service', start, end, status, j.description || null, j.fabrikationsnummern || null, j.eap_nummer || null, j.bestellnummer || null
  );
  const newId = r2.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)').run(newId, technicianId);
  if (j.street != null) insertOrUpdateJobAddress(db, newId, j);
  return newId;
}

function insertOrUpdateJobAddress(db, jobId, j) {
  const street = j.street || ''; const house = j.house_number || ''; const zip = j.zip || ''; const city = j.city || ''; const country = j.country || 'DE';
  db.prepare('INSERT OR REPLACE INTO job_addresses (job_id, street, house_number, zip, city, country, address_extra_1, address_extra_2) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    jobId, street, house, zip, city, country, j.address_extra_1 || null, j.address_extra_2 || null
  );
}

function insertOrUpdateAbsence(db, a, technicianId) {
  const serverId = a.id;
  const start = (a.start_datetime || '').replace('T', ' ').substring(0, 19);
  const end = (a.end_datetime || '').replace('T', ' ').substring(0, 19);
  const type = a.type || '';
  const existing = db.prepare('SELECT id FROM absences WHERE server_id = ?').get(serverId);
  if (existing) {
    db.prepare('UPDATE absences SET start_datetime = ?, end_datetime = ?, type = ?, synced_at = datetime(\'now\') WHERE id = ?').run(start, end, type, existing.id);
    return;
  }
  db.prepare('INSERT INTO absences (server_id, technician_id, start_datetime, end_datetime, type, synced_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))').run(serverId, technicianId, start, end, type);
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
    if (p.entity_type === 'job' && (p.action === 'status' || p.action === 'description' || p.action === 'fabrikationsnummern')) {
      const job = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(p.entity_id);
      const serverJobId = (job && job.server_id) ? job.server_id : p.entity_id;
      const payload = JSON.parse(p.payload || '{}');
      const body = { job_id: serverJobId, ...payload };
      const r = await fetch(`${base}/api/job.php?technician_id=${technicianId}`, { method: 'PATCH', headers: header, body: JSON.stringify(body) });
      if (r.ok) {
        db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
        if (p.action === 'status' && payload.status === 'erledigt') {
          const localJobId = p.entity_id;
          cleanup_completed_job_files(db, localJobId);
          db.prepare('DELETE FROM job_technicians WHERE job_id = ? AND technician_id = ?').run(localJobId, technicianId);
          const rest = db.prepare('SELECT 1 FROM job_technicians WHERE job_id = ?').get(localJobId);
          if (!rest) {
            db.prepare('DELETE FROM job_addresses WHERE job_id = ?').run(localJobId);
            db.prepare('DELETE FROM jobs WHERE id = ?').run(localJobId);
          }
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
  }
  const pendingRequests = db.prepare('SELECT id, start_datetime, end_datetime, type FROM absence_requests WHERE technician_id = ? AND status = ? AND (server_id IS NULL OR server_id = \'\')').all(technicianId, 'pending');
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
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.success && data.id) {
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
    if (statusData.success && Array.isArray(statusData.requests)) {
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
