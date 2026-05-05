'use strict';

const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const express = require('express');

function mkdirpSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cacheRoot(dbDir) {
  return path.join(dbDir, 'abrechnung_cache');
}

function jobDir(dbDir, jobServerId) {
  return path.join(cacheRoot(dbDir), String(jobServerId));
}

function filePathLocal(dbDir, jobServerId, bucket, name) {
  const safe = path.basename(String(name || ''));
  return path.join(jobDir(dbDir, jobServerId), bucket, safe);
}

function ensureSchema(db) {
  /** sql.js-Wrapper in server.js: nur db.prepare(…).run/get/all — kein db.run. */
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_jobs_snapshot (
    technician_id INTEGER NOT NULL,
    period_ym TEXT NOT NULL,
    jobs_json TEXT NOT NULL,
    synced_at TEXT,
    PRIMARY KEY (technician_id, period_ym)
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_notes_cache (
    job_server_id INTEGER NOT NULL,
    dispo TEXT,
    buchhaltung TEXT,
    synced_at TEXT,
    PRIMARY KEY (job_server_id)
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_files_meta (
    job_server_id INTEGER NOT NULL,
    bucket TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size_bytes INTEGER,
    synced_at TEXT,
    PRIMARY KEY (job_server_id, bucket, file_name)
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    attempts INTEGER NOT NULL DEFAULT 0
  )`).run();
}

function dispoBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

/** Wenn die Abrechnungs-API auf dem Server fehlt: Aufträge aus der normalen SQLite-Sync-DB (gleicher Monat). */
function buildAbrechnungJobsFallbackFromSqlite(db, technicianId, periodYm) {
  if (!/^\d{4}-\d{2}$/.test(String(periodYm))) return [];
  const period = String(periodYm);
  const start = `${period}-01`;
  const last = new Date(`${period}-01T12:00:00`);
  last.setMonth(last.getMonth() + 1);
  last.setDate(0);
  const y = last.getFullYear();
  const m = String(last.getMonth() + 1).padStart(2, '0');
  const d = String(last.getDate()).padStart(2, '0');
  const end = `${y}-${m}-${d} 23:59:59`;
  try {
    const rows = db
      .prepare(
        `SELECT j.server_id, j.id AS local_id, j.job_number, j.status, c.name AS customer_name
         FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         INNER JOIN customers c ON c.id = j.customer_id
         WHERE j.start_datetime >= ? AND j.start_datetime <= ?
           AND j.status != 'abgerechnet'
         ORDER BY j.start_datetime ASC, j.id ASC`,
      )
      .all(technicianId, start, end);
    return rows.map((r) => {
      const sid = r.server_id != null && r.server_id !== '' ? Number(r.server_id) : Number(r.local_id);
      const num = String(r.job_number || '').trim();
      const cust = String(r.customer_name || '').trim();
      const label = (num !== '' ? `${num} — ` : `#${sid} — `) + cust;
      return {
        id: sid,
        label,
        status: String(r.status || ''),
        can_write: true,
        montage_abgerechnet: 0,
        montage_verrechnet: 0,
        _from_local_sync: true,
      };
    });
  } catch (_) {
    return [];
  }
}

/** Zwei URL-Varianten: direkt unter dispo_api (Standard) oder unter /api/ (Apache/XAMPP, wenn dispo_api nicht als URL erreichbar ist). */
function abrechnungScriptUrlCandidates(baseUrl, scriptFile) {
  const b = dispoBase(baseUrl);
  return [`${b}/dispo_api/api/${scriptFile}`, `${b}/api/monteur_${scriptFile}`];
}

async function dispoFetchJson(baseUrl, pathName, qs, authHeader, technicianId) {
  const q = new URLSearchParams(qs);
  if (technicianId != null) q.set('technician_id', String(technicianId));
  const query = q.toString();
  const headers = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
  const urls = abrechnungScriptUrlCandidates(baseUrl, pathName).map((u) => `${u}?${query}`);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const r = await fetch(url, { headers });
    const text = await r.text();
    const tryNext = r.status === 404 && i < urls.length - 1;
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      lastErr = new Error('Dispo: kein JSON (' + r.status + '): ' + text.slice(0, 200));
      if (tryNext) continue;
      throw lastErr;
    }
    if (!r.ok || data.ok === false) {
      lastErr = new Error(data.error || ('HTTP ' + r.status));
      if (tryNext) continue;
      throw lastErr;
    }
    return data;
  }
  throw (
    lastErr ||
    new Error('Abrechnungs-Endpunkt nicht erreichbar (404). Versucht: ' + urls.join(' | ') + '.')
  );
}

async function dispoAbrechnungPostJson(baseUrl, scriptFile, jsonBody, authHeader, technicianId) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) },
    authHeader || {},
  );
  const urls = abrechnungScriptUrlCandidates(baseUrl, scriptFile);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i], { method: 'POST', headers, body: JSON.stringify(jsonBody) });
    const t = await r.text();
    const tryNext = r.status === 404 && i < urls.length - 1;
    let j = {};
    try {
      j = t ? JSON.parse(t) : {};
    } catch (_) {
      lastErr = new Error(t ? t.slice(0, 240) : 'Ungültige Antwort');
      if (tryNext) continue;
      throw lastErr;
    }
    if (!r.ok || j.ok === false) {
      lastErr = new Error(j.error || t || ('HTTP ' + r.status));
      if (tryNext) continue;
      throw lastErr;
    }
    return j;
  }
  throw lastErr || new Error('Abrechnungs-API nicht erreichbar');
}

async function dispoDownloadFile(baseUrl, jobId, bucket, name, destPath, authHeader, technicianId) {
  const q = new URLSearchParams({
    technician_id: String(technicianId),
    job_id: String(jobId),
    bucket,
    name,
  });
  const qs = q.toString();
  const headers = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
  const urls = abrechnungScriptUrlCandidates(baseUrl, 'abrechnung_file_download.php').map((u) => `${u}?${qs}`);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i], { headers });
    if (r.status === 404 && i < urls.length - 1) continue;
    if (!r.ok) {
      lastErr = new Error('Download fehlgeschlagen: ' + r.status);
      if (r.status === 404 && i < urls.length - 1) continue;
      throw lastErr;
    }
    mkdirpSync(path.dirname(destPath));
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return;
  }
  throw lastErr || new Error('Download fehlgeschlagen: 404');
}

function dispoUploadMultipartOnce(urlStr, fields, fileBuf, fileName, authHeader, technicianId) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('technician_id', String(technicianId));
    Object.keys(fields).forEach((k) => form.append(k, String(fields[k])));
    form.append('file', fileBuf, path.basename(fileName || 'datei'));
    const parsed = new URL(urlStr);
    const headers = form.getHeaders({
      'X-Technician-Id': String(technicianId),
      ...(authHeader || {}),
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
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const code = res.statusCode || 0;
          if (code === 404) return reject(Object.assign(new Error('404'), { code404: true }));
          const data = body ? JSON.parse(body) : {};
          if (code >= 200 && code < 300 && data.ok !== false) {
            resolve(data);
          } else {
            reject(new Error((data && data.error) || body || ('HTTP ' + code)));
          }
        } catch (e) {
          reject(new Error(body || e.message));
        }
      });
    });
  });
}

async function dispoUploadMultipart(baseUrl, fields, fileBuf, fileName, authHeader, technicianId) {
  const urls = abrechnungScriptUrlCandidates(baseUrl, 'abrechnung_file_upload.php');
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      return await dispoUploadMultipartOnce(urls[i], fields, fileBuf, fileName, authHeader, technicianId);
    } catch (e) {
      lastErr = e;
      if (e && e.code404 && i < urls.length - 1) continue;
      throw e;
    }
  }
  throw lastErr || new Error('Upload fehlgeschlagen');
}

async function syncJobFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId) {
  const { db, save, dbDir } = ctx;
  const notes = await dispoFetchJson(baseUrl, 'abrechnung_notes.php', { job_id: String(jobServerId) }, authHeader, technicianId);
  const n = notes.notes || {};
  db.prepare(`
    INSERT INTO abrechnung_notes_cache (job_server_id, dispo, buchhaltung, synced_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(job_server_id) DO UPDATE SET
      dispo = excluded.dispo,
      buchhaltung = excluded.buchhaltung,
      synced_at = excluded.synced_at
  `).run(jobServerId, n.dispo || '', n.buchhaltung || '');
  for (const bucket of ['dispo', 'buchhaltung']) {
    const data = await dispoFetchJson(baseUrl, 'abrechnung_bucket_list.php', { job_id: String(jobServerId), bucket }, authHeader, technicianId);
    const files = data.files || [];
    db.prepare('DELETE FROM abrechnung_files_meta WHERE job_server_id = ? AND bucket = ?').run(jobServerId, bucket);
    const destBase = path.join(jobDir(dbDir, jobServerId), bucket);
    mkdirpSync(destBase);
    for (const f of files) {
      const fn = f.name;
      if (!fn) continue;
      const localPath = path.join(destBase, path.basename(fn));
      try {
        await dispoDownloadFile(baseUrl, jobServerId, bucket, fn, localPath, authHeader, technicianId);
        db.prepare(`
          INSERT INTO abrechnung_files_meta (job_server_id, bucket, file_name, size_bytes, synced_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).run(jobServerId, bucket, fn, f.size_bytes != null ? f.size_bytes : fs.statSync(localPath).size);
      } catch (e) {
        console.warn('[abrechnung] download skip', fn, e.message);
      }
    }
  }
  save();
}

async function flushAbrechnungOutbox(ctx, baseUrl, technicianId, serverUsername, serverPassword) {
  const { db, save, dbDir, authHeaderFromCredentials } = ctx;
  const base = dispoBase(baseUrl);
  if (!base || !technicianId) return;
  const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
  const rows = db.prepare('SELECT id, op, payload, attempts FROM abrechnung_outbox ORDER BY id ASC LIMIT 50').all();
  for (const row of rows) {
    if (row.attempts > 20) continue;
    let payload;
    try {
      payload = JSON.parse(row.payload || '{}');
    } catch (_) {
      db.prepare('DELETE FROM abrechnung_outbox WHERE id = ?').run(row.id);
      continue;
    }
    try {
      if (row.op === 'note') {
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_note_save.php',
          {
            technician_id: technicianId,
            job_id: payload.job_id,
            bucket: payload.bucket,
            body: payload.body || '',
          },
          authHeader,
          technicianId,
        );
      } else if (row.op === 'upload') {
        const fp = payload.local_path;
        if (!fp || !fs.existsSync(fp)) throw new Error('Lokale Datei fehlt');
        const buf = fs.readFileSync(fp);
        await dispoUploadMultipart(
          baseUrl,
          { job_id: String(payload.job_id), bucket: String(payload.bucket) },
          buf,
          payload.filename || 'datei',
          authHeader,
          technicianId,
        );
      } else if (row.op === 'delete') {
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_file_delete.php',
          {
            technician_id: technicianId,
            job_id: payload.job_id,
            bucket: payload.bucket,
            name: payload.name,
          },
          authHeader,
          technicianId,
        );
      }
      db.prepare('DELETE FROM abrechnung_outbox WHERE id = ?').run(row.id);
    } catch (e) {
      db.prepare('UPDATE abrechnung_outbox SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      console.warn('[abrechnung outbox]', row.op, e.message);
    }
  }
  save();
}

function registerAbrechnungRoutes(app, ctx) {
  const { db, save, dbDir, authHeaderFromCredentials } = ctx;
  ensureSchema(db);

  /** Jobs für Monat: aus Cache oder optional Dispo */
  app.get('/api/abrechnung/jobs', (req, res) => {
    try {
      const technicianId = parseInt(req.query.technician_id, 10);
      const period = (req.query.period || '').trim();
      if (!technicianId || !/^\d{4}-\d{2}$/.test(period)) {
        return res.status(400).json({ ok: false, error: 'technician_id und period (YYYY-MM) erforderlich.' });
      }
      const row = db.prepare(
        'SELECT jobs_json, synced_at FROM abrechnung_jobs_snapshot WHERE technician_id = ? AND period_ym = ?'
      ).get(technicianId, period);
      let jobs = [];
      if (row && row.jobs_json) {
        try {
          jobs = JSON.parse(row.jobs_json);
        } catch (_) {}
      }
      let source = 'snapshot';
      if (!Array.isArray(jobs) || jobs.length === 0) {
        jobs = buildAbrechnungJobsFallbackFromSqlite(db, technicianId, period);
        source = jobs.length ? 'sqlite_fallback' : source;
      }
      return res.json({ ok: true, jobs, synced_at: row ? row.synced_at : null, jobs_source: source });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Bundle: Notizen + Dateiliste (Meta), offline aus Cache */
  app.get('/api/abrechnung/bundle', (req, res) => {
    try {
      const technicianId = parseInt(req.query.technician_id, 10);
      const jobServerId = parseInt(req.query.job_server_id, 10);
      if (!technicianId || !jobServerId) {
        return res.status(400).json({ ok: false, error: 'technician_id und job_server_id erforderlich.' });
      }
      const notes = db.prepare('SELECT dispo, buchhaltung, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?').get(jobServerId);
      const files = db.prepare(
        'SELECT bucket, file_name, size_bytes, synced_at FROM abrechnung_files_meta WHERE job_server_id = ? ORDER BY bucket, file_name'
      ).all(jobServerId);
      return res.json({
        ok: true,
        notes: notes || { dispo: '', buchhaltung: '', synced_at: null },
        files: files || [],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Abrechnung-Datei lokal (nach Sync) */
  app.get('/api/abrechnung/file', (req, res) => {
    try {
      const jobServerId = parseInt(req.query.job_server_id, 10);
      const bucket = (req.query.bucket || '').trim();
      const name = path.basename((req.query.name || '').toString());
      if (!jobServerId || !['dispo', 'buchhaltung'].includes(bucket) || !name) {
        return res.status(400).send('Ungültige Parameter.');
      }
      const fp = filePathLocal(dbDir, jobServerId, bucket, name);
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        return res.status(404).send('Datei nicht lokal vorhanden (zuerst synchronisieren oder online laden).');
      }
      res.sendFile(path.resolve(fp));
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  app.post('/api/abrechnung/refresh', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, period_ym, job_server_id } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const base = dispoBase(baseUrl);
    if (!base || !tid) {
      return res.status(400).json({ ok: false, error: 'baseUrl und technicianId erforderlich.' });
    }
    const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
    const warnings = [];
    let partial = false;
    try {
      if (period_ym && /^\d{4}-\d{2}$/.test(String(period_ym))) {
        let jobsPayload = [];
        try {
          const data = await dispoFetchJson(base, 'abrechnung_job_list.php', { monat: String(period_ym) }, authHeader, tid);
          jobsPayload = Array.isArray(data.jobs) ? data.jobs : [];
        } catch (e) {
          jobsPayload = buildAbrechnungJobsFallbackFromSqlite(db, tid, period_ym);
          partial = true;
          const hint = e && e.message ? String(e.message) : String(e);
          warnings.push('Auftragsliste aus lokalem Auftragsspeicher (' + hint + ')');
          console.warn('[abrechnung/refresh] Dispo job list skipped, using SQLite:', hint);
        }
        db.prepare(`
          INSERT INTO abrechnung_jobs_snapshot (technician_id, period_ym, jobs_json, synced_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(technician_id, period_ym) DO UPDATE SET
            jobs_json = excluded.jobs_json,
            synced_at = excluded.synced_at
        `).run(tid, period_ym, JSON.stringify(jobsPayload));
        save();
      }
      const jid = parseInt(job_server_id, 10);
      if (jid > 0) {
        try {
          await syncJobFromDispo(ctx, base, tid, authHeader, jid);
        } catch (e) {
          partial = true;
          const hint = e && e.message ? String(e.message) : String(e);
          warnings.push('Detail-Daten (Notizen/Dateien) nicht von Dispo geladen: ' + hint);
          console.warn('[abrechnung/refresh] syncJobFromDispo:', hint);
        }
      }
      try {
        await flushAbrechnungOutbox(ctx, base, tid, serverUsername, serverPassword);
      } catch (e) {
        partial = true;
        const hint = e && e.message ? String(e.message) : String(e);
        warnings.push('Ausstehende Änderungen nicht vollständig übertragen: ' + hint);
        console.warn('[abrechnung/refresh] outbox:', hint);
      }
      return res.json({ ok: true, partial, warnings });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/abrechnung/note', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, body } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const jid = parseInt(job_server_id, 10);
    const b = (bucket || '').trim();
    if (!tid || !jid || !['dispo', 'buchhaltung'].includes(b)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Parameter.' });
    }
    const text = body != null ? String(body) : '';
    const row = db.prepare('SELECT dispo, buchhaltung FROM abrechnung_notes_cache WHERE job_server_id = ?').get(jid);
    const dispoVal = b === 'dispo' ? text : (row && row.dispo != null ? String(row.dispo) : '');
    const buchVal = b === 'buchhaltung' ? text : (row && row.buchhaltung != null ? String(row.buchhaltung) : '');
    db.prepare(`
      INSERT INTO abrechnung_notes_cache (job_server_id, dispo, buchhaltung, synced_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(job_server_id) DO UPDATE SET
        dispo = excluded.dispo,
        buchhaltung = excluded.buchhaltung,
        synced_at = datetime('now')
    `).run(jid, dispoVal, buchVal);
    save();

    const base = dispoBase(baseUrl);
    if (base) {
      try {
        const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_note_save.php',
          { technician_id: tid, job_id: jid, bucket: b, body: text },
          authHeader,
          tid,
        );
        return res.json({ ok: true, synced: true });
      } catch (e) {
        db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
          'note',
          JSON.stringify({ job_id: jid, bucket: b, body: text })
        );
        save();
        return res.json({ ok: true, synced: false, queued: true, error: e.message });
      }
    }
    db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
      'note',
      JSON.stringify({ job_id: jid, bucket: b, body: text })
    );
    save();
    return res.json({ ok: true, synced: false, queued: true });
  });

  app.post('/api/abrechnung/upload', express.json({ limit: '80mb' }), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, filename, content_base64 } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const jid = parseInt(job_server_id, 10);
    const b = (bucket || '').trim();
    if (!tid || !jid || !['dispo', 'buchhaltung'].includes(b) || !content_base64) {
      return res.status(400).json({ ok: false, error: 'Parameter fehlen.' });
    }
    let buf;
    try {
      buf = Buffer.from(String(content_base64), 'base64');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'content_base64 ungültig.' });
    }
    const safeName = path.basename((filename || 'datei').toString()).replace(/[\/\\:*?"<>|]/g, '_') || 'datei';
    mkdirpSync(path.join(jobDir(dbDir, jid), b));
    const localPath = filePathLocal(dbDir, jid, b, safeName);
    fs.writeFileSync(localPath, buf);
    db.prepare(`
      INSERT INTO abrechnung_files_meta (job_server_id, bucket, file_name, size_bytes, synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(job_server_id, bucket, file_name) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        synced_at = excluded.synced_at
    `).run(jid, b, safeName, buf.length);
    save();

    const base = dispoBase(baseUrl);
    if (base) {
      try {
        const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
        await dispoUploadMultipart(base, { job_id: String(jid), bucket: b }, buf, safeName, authHeader, tid);
        return res.json({ ok: true, name: safeName, synced: true });
      } catch (e) {
        db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
          'upload',
          JSON.stringify({ job_id: jid, bucket: b, filename: safeName, local_path: localPath })
        );
        save();
        return res.json({ ok: true, name: safeName, synced: false, queued: true, error: e.message });
      }
    }
    db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
      'upload',
      JSON.stringify({ job_id: jid, bucket: b, filename: safeName, local_path: localPath })
    );
    save();
    return res.json({ ok: true, name: safeName, synced: false, queued: true });
  });

  app.post('/api/abrechnung/delete_file', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, name } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const jid = parseInt(job_server_id, 10);
    const b = (bucket || '').trim();
    const fn = path.basename((name || '').toString());
    if (!tid || !jid || !['dispo', 'buchhaltung'].includes(b) || !fn) {
      return res.status(400).json({ ok: false, error: 'Parameter fehlen.' });
    }
    const localPath = filePathLocal(dbDir, jid, b, fn);
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (_) { /* ignore */ }
    db.prepare('DELETE FROM abrechnung_files_meta WHERE job_server_id = ? AND bucket = ? AND file_name = ?').run(jid, b, fn);
    save();

    const base = dispoBase(baseUrl);
    if (base) {
      try {
        const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_file_delete.php',
          { technician_id: tid, job_id: jid, bucket: b, name: fn },
          authHeader,
          tid,
        );
        return res.json({ ok: true, synced: true });
      } catch (e) {
        db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
          'delete',
          JSON.stringify({ job_id: jid, bucket: b, name: fn })
        );
        save();
        return res.json({ ok: true, synced: false, queued: true, error: e.message });
      }
    }
    db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
      'delete',
      JSON.stringify({ job_id: jid, bucket: b, name: fn })
    );
    save();
    return res.json({ ok: true, synced: false, queued: true });
  });

  app.get('/api/abrechnung/outbox_count', (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS c FROM abrechnung_outbox').get();
    res.json({ ok: true, count: n ? n.c : 0 });
  });
}

module.exports = { registerAbrechnungRoutes, flushAbrechnungOutbox };
