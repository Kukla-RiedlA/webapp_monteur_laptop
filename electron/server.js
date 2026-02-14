/**
 * Lokaler API-Server für die Monteur WebApp (Offline).
 * Verwendet sql.js (WASM, kein nativer Build); läuft im Electron-Hauptprozess.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = 39678;
const DB_DIR = path.join(__dirname, 'db');
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
  return createDbWrapper(sqlDb);
}

function createApp(db) {
  const app = express();
  app.use(express.json());

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

  app.get('/api/version', (req, res) => {
    res.json({ version: appVersion });
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
    res.json({ ok: true, technician_id: technicianId, absences: rows });
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

  app.delete('/api/absence', (req, res) => {
    const technicianId = getTechnicianId(req);
    const id = parseInt(req.query.id, 10) || parseInt((req.body || {}).id, 10) || 0;
    if (!technicianId || !id) {
      return res.status(400).json({ ok: false, error: 'technician_id und id erforderlich.' });
    }
    try {
      const row = db.prepare('SELECT server_id FROM absences WHERE id = ? AND technician_id = ?').get(id, technicianId);
      const r = db.prepare('DELETE FROM absences WHERE id = ? AND technician_id = ?').run(id, technicianId);
      if (r.changes && row && row.server_id) {
        db.prepare('INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)').run('absence', row.server_id, 'delete', '{}');
      }
      if (r.changes) {
        save();
        return res.json({ ok: true });
      }
      res.status(404).json({ ok: false, error: 'Abwesenheit nicht gefunden.' });
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

  app.post('/api/sync_pull', express.json(), (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, date_from, date_to } = req.body || {};
    if (!baseUrl || !technicianId) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    const auth = authHeaderFromCredentials(serverUsername, serverPassword);
    pullFromServer(baseUrl, technicianId, db, auth, date_from, date_to).then(() => {
      save();
      res.json({ ok: true });
    }).catch((e) => res.status(500).json({ ok: false, error: e.message }));
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
  const { jobs } = jobsData;
  const { absences } = await absencesRes.json();
  db.transaction(() => {
    ensureTechnician(db, technicianId);
    for (const j of jobs || []) {
      const custId = ensureCustomer(db, j);
      insertOrUpdateJob(db, j, custId, technicianId);
    }
    for (const a of absences || []) {
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
      if (r.ok) db.prepare('DELETE FROM pending_changes WHERE id = ?').run(p.id);
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
}

module.exports = { createApp, getDb, PORT };
