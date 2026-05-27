'use strict';

const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
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
  try {
    db.prepare('ALTER TABLE abrechnung_notes_cache ADD COLUMN comments_json TEXT').run();
  } catch (_) {
    /* Spalte existiert bereits */
  }
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

/**
 * Dispo und abrechnung_*-Cache verwenden die Auftrags-ID vom Server; das Dropdown kann jobs.id (lokal) liefern.
 */
function resolveDispoJobIdForAbrechnung(db, idFromClient) {
  const jid = parseInt(idFromClient, 10);
  if (!Number.isFinite(jid) || jid <= 0) return jid;
  try {
    const hitServer = db.prepare('SELECT server_id FROM jobs WHERE server_id = ?').get(jid);
    if (hitServer && hitServer.server_id != null) return Number(hitServer.server_id);
    const hitLocal = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(jid);
    if (hitLocal && hitLocal.server_id != null && hitLocal.server_id !== '') {
      const sid = Number(hitLocal.server_id);
      if (Number.isFinite(sid) && sid > 0) return sid;
    }
  } catch (_) {
    /* ignore */
  }
  return jid;
}

function readCommentsFromRow(row) {
  const empty = { dispo: [], buchhaltung: [] };
  if (!row) {
    return empty;
  }
  if (row.comments_json) {
    try {
      const j = JSON.parse(row.comments_json);
      return {
        dispo: Array.isArray(j.dispo) ? j.dispo : [],
        buchhaltung: Array.isArray(j.buchhaltung) ? j.buchhaltung : [],
      };
    } catch (_) {
      /* fall through */
    }
  }
  const d = row.dispo != null ? String(row.dispo).trim() : '';
  const bh = row.buchhaltung != null ? String(row.buchhaltung).trim() : '';
  return {
    dispo: d
      ? [
          {
            id: 0,
            body: d,
            created_at: '',
            author_name: '(ältere Notiz)',
            can_edit: false,
            can_delete: false,
          },
        ]
      : [],
    buchhaltung: bh
      ? [
          {
            id: 0,
            body: bh,
            created_at: '',
            author_name: '(ältere Notiz)',
            can_edit: false,
            can_delete: false,
          },
        ]
      : [],
  };
}

function writeCommentsCache(db, jobServerId, comments) {
  const payload = JSON.stringify({
    dispo: comments.dispo || [],
    buchhaltung: comments.buchhaltung || [],
  });
  db.prepare(`
    INSERT INTO abrechnung_notes_cache (job_server_id, dispo, buchhaltung, comments_json, synced_at)
    VALUES (?, '', '', ?, datetime('now'))
    ON CONFLICT(job_server_id) DO UPDATE SET
      comments_json = excluded.comments_json,
      synced_at = excluded.synced_at
  `).run(jobServerId, payload);
}

function appendOptimisticComment(db, jobServerId, bucket, text) {
  const row = db
    .prepare('SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?')
    .get(jobServerId);
  const c = readCommentsFromRow(row);
  const list = bucket === 'dispo' ? c.dispo : c.buchhaltung;
  list.push({
    id: 0,
    body: text,
    created_at: new Date().toISOString(),
    author_name: '',
    can_edit: true,
    can_delete: true,
  });
  writeCommentsCache(db, jobServerId, c);
}

async function syncCommentsOnlyFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId) {
  const { db, save } = ctx;
  const data = await dispoFetchJson(
    baseUrl,
    'abrechnung_notes.php',
    { job_id: String(jobServerId) },
    authHeader,
    technicianId,
  );
  const comments = data.comments || { dispo: [], buchhaltung: [] };
  writeCommentsCache(db, jobServerId, comments);
  save();
}

function dedupeAbrechnungFileRows(rows) {
  const m = new Map();
  for (const row of rows || []) {
    const b = row.bucket != null ? String(row.bucket) : '';
    const fn =
      row.file_name != null ? String(row.file_name) : row.name != null ? String(row.name) : '';
    if (!b || !fn) continue;
    const k = `${b}\0${fn}`;
    if (!m.has(k)) {
      m.set(k, {
        bucket: b,
        file_name: fn,
        size_bytes: row.size_bytes != null ? row.size_bytes : null,
        synced_at: row.synced_at != null ? row.synced_at : null,
        remote_only: row.remote_only === true,
      });
    }
  }
  return Array.from(m.values());
}

/** Anzeige: gleicher Dateiname nur einmal (Dispo bevorzugt). */
function dedupeAbrechnungFilesByFilename(rows) {
  const m = new Map();
  for (const row of dedupeAbrechnungFileRows(rows)) {
    const fn = row.file_name != null ? String(row.file_name) : '';
    if (!fn) continue;
    const bucket = row.bucket != null ? String(row.bucket) : 'dispo';
    const existing = m.get(fn);
    if (!existing || (existing.bucket === 'buchhaltung' && bucket === 'dispo')) {
      m.set(fn, {
        bucket,
        file_name: fn,
        size_bytes: row.size_bytes != null ? row.size_bytes : null,
        synced_at: row.synced_at != null ? row.synced_at : null,
        remote_only: row.remote_only === true,
      });
    }
  }
  return Array.from(m.values()).sort((a, b) => String(a.file_name || '').localeCompare(String(b.file_name || '')));
}

function findLocalAbrechnungFilePath(dbDir, db, jobServerIdFromQuery, bucket, name) {
  const resolved = resolveDispoJobIdForAbrechnung(db, jobServerIdFromQuery);
  const ids = Array.from(
    new Set(
      [jobServerIdFromQuery, resolved].filter((x) => {
        const n = parseInt(String(x), 10);
        return Number.isFinite(n) && n > 0;
      }),
    ),
  );
  for (const id of ids) {
    const fp = filePathLocal(dbDir, id, bucket, name);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
  }
  return null;
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
         WHERE j.start_datetime <= ?
           AND COALESCE(j.end_datetime, j.start_datetime) >= ?
           AND j.status != 'abgerechnet'
         ORDER BY j.start_datetime ASC, j.id ASC`,
      )
      .all(technicianId, end, start);
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

/** Snapshot-Dispo kann weniger Jobs enthalten als lokale Überlappungs-Logik — ohne Duplikate zusammenführen. */
function mergeAbrechnungJobsUnique(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const j of Array.isArray(primary) ? primary : []) {
    const id = j && j.id != null ? Number(j.id) : NaN;
    if (!Number.isFinite(id)) continue;
    seen.add(id);
    out.push(j);
  }
  const extras = [];
  for (const j of Array.isArray(secondary) ? secondary : []) {
    const id = j && j.id != null ? Number(j.id) : NaN;
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    extras.push(j);
  }
  extras.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return out.concat(extras);
}

/**
 * Zwei URL-Varianten (Reihenfolge wie job_project_*.php unter /api/):
 * 1) /api/monteur_* — oft die einzige öffentlich erreichbare Route (Apache-Docroot = dispo).
 * 2) /dispo_api/api/* — direkter API-Pfad.
 */
function abrechnungScriptUrlCandidates(baseUrl, scriptFile) {
  const b = dispoBase(baseUrl);
  return [`${b}/api/monteur_${scriptFile}`, `${b}/dispo_api/api/${scriptFile}`];
}

function appendTriedUrls(errMsg, urls) {
  const suffix = ' Versucht: ' + urls.join(' | ');
  if (String(errMsg || '').includes('Versucht:')) return String(errMsg);
  return String(errMsg || '') + suffix;
}

/** Apache übergibt Authorization oft nicht an PHP — gleicher Basic-Wert zusätzlich für require_login.php. */
function dispoMonteurFetchHeaders(authHeader, technicianId) {
  const h = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
  const a = authHeader && authHeader.Authorization;
  if (a) {
    h['X-Kukla-Authorization'] = a;
  }
  return h;
}

/** Gleiche Zuordnung wie abrechnung_monteur_api.inc.php — über job_project_* erreichbar. */
function abrechnungBucketProjectSubdir(bucket) {
  if (bucket === 'dispo') return 'Dokumente_Dispo';
  if (bucket === 'buchhaltung') return 'Dokumente_Dispo';
  return null;
}

async function dispoJobProjectFilesListJson(baseUrl, dispoJobId, relPath, authHeader, technicianId) {
  const b = dispoBase(baseUrl);
  const q = new URLSearchParams({
    technician_id: String(technicianId),
    job_id: String(dispoJobId),
    path: String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  });
  const url = `${b}/api/job_project_files_list.php?${q}`;
  const headers = dispoMonteurFetchHeaders(authHeader, technicianId);
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error('job_project_files_list: kein JSON (' + r.status + ')');
  }
  if (!r.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || 'HTTP ' + r.status);
  }
  return data;
}

/**
 * Dateiliste Abrechnungs-Bucket: zuerst monteur_abrechnung_*, bei 404/fehlendem Endpunkt Fallback job_project_files_list
 * (Ordner Dokumente_Dispo / Dokumente_Buchhaltung — wie auf der Dispo üblich).
 */
async function dispoFetchAbrechnungBucketList(baseUrl, dispoJobId, bucket, authHeader, technicianId) {
  try {
    return await dispoFetchJson(
      baseUrl,
      'abrechnung_bucket_list.php',
      { job_id: String(dispoJobId), bucket },
      authHeader,
      technicianId,
    );
  } catch (primaryErr) {
    const sub = abrechnungBucketProjectSubdir(bucket);
    if (!sub) throw primaryErr;
    try {
      const data = await dispoJobProjectFilesListJson(baseUrl, dispoJobId, sub, authHeader, technicianId);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const files = [];
      for (const ent of entries) {
        if (!ent || ent.type !== 'file') continue;
        const fn = String(ent.name || '').trim();
        if (!fn) continue;
        files.push({
          name: fn,
          size_bytes: ent.size != null ? Number(ent.size) : null,
        });
      }
      return { ok: true, files };
    } catch (fallbackErr) {
      const p = primaryErr && primaryErr.message ? primaryErr.message : String(primaryErr);
      const f = fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr);
      throw new Error(`${p} — Fallback job_project_files_list (${sub}): ${f}`);
    }
  }
}

async function dispoFetchJson(baseUrl, pathName, qs, authHeader, technicianId) {
  const q = new URLSearchParams(qs);
  if (technicianId != null) q.set('technician_id', String(technicianId));
  const query = q.toString();
  const headers = dispoMonteurFetchHeaders(authHeader, technicianId);
  const urls = abrechnungScriptUrlCandidates(baseUrl, pathName).map((u) => `${u}?${query}`);
  let lastErr;
  const hasMore = (i) => i < urls.length - 1;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const r = await fetch(url, { headers });
    const text = await r.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      lastErr = new Error('Dispo: kein JSON (' + r.status + '): ' + text.slice(0, 200));
      // Falsche Route liefert oft HTML (404/403/…): nächste Basis-URL versuchen.
      if (hasMore(i)) continue;
      throw new Error(appendTriedUrls(lastErr.message, urls));
    }
    const tryHttpNext = hasMore(i) && r.status === 404;
    if (!r.ok) {
      lastErr = new Error(data.error || 'HTTP ' + r.status);
      if (tryHttpNext) continue;
      throw lastErr;
    }
    if (data && typeof data === 'object' && data.ok === false) {
      lastErr = new Error(data.error || ('HTTP ' + r.status));
      if (tryHttpNext) continue;
      throw lastErr;
    }
    return data;
  }
  throw new Error(appendTriedUrls(lastErr ? lastErr.message : 'Abrechnungs-Endpunkt nicht erreichbar.', urls));
}

async function dispoAbrechnungPostJson(baseUrl, scriptFile, jsonBody, authHeader, technicianId) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId) },
    dispoMonteurFetchHeaders(authHeader, technicianId),
  );
  const urls = abrechnungScriptUrlCandidates(baseUrl, scriptFile);
  let lastErr;
  const hasMore = (i) => i < urls.length - 1;
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i], { method: 'POST', headers, body: JSON.stringify(jsonBody) });
    const t = await r.text();
    let j = {};
    try {
      j = t ? JSON.parse(t) : {};
    } catch (_) {
      lastErr = new Error(t ? t.slice(0, 240) : 'Ungültige Antwort');
      if (hasMore(i)) continue;
      throw new Error(appendTriedUrls(lastErr.message, urls));
    }
    const tryHttpNext = hasMore(i) && r.status === 404;
    if (!r.ok || j.ok === false) {
      lastErr = new Error(j.error || t || ('HTTP ' + r.status));
      if (tryHttpNext) continue;
      throw lastErr;
    }
    return j;
  }
  throw new Error(appendTriedUrls(lastErr ? lastErr.message : 'Abrechnungs-API nicht erreichbar', urls));
}

async function dispoDownloadFile(baseUrl, jobId, bucket, name, destPath, authHeader, technicianId) {
  const q = new URLSearchParams({
    technician_id: String(technicianId),
    job_id: String(jobId),
    bucket,
    name,
  });
  const qs = q.toString();
  const headers = dispoMonteurFetchHeaders(authHeader, technicianId);
  const urls = abrechnungScriptUrlCandidates(baseUrl, 'abrechnung_file_download.php').map((u) => `${u}?${qs}`);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i], { headers });
    if (!r.ok) {
      lastErr = new Error('Download fehlgeschlagen: ' + r.status);
      if (r.status === 404 && i < urls.length - 1) continue;
      if (r.status === 404 && i === urls.length - 1) break;
      throw lastErr;
    }
    mkdirpSync(path.dirname(destPath));
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return;
  }
  const sub = abrechnungBucketProjectSubdir(bucket);
  const safeName = path.basename(String(name || ''));
  if (sub && safeName) {
    const relPath = `${sub}/${safeName}`.replace(/\\/g, '/');
    const qjp = new URLSearchParams({
      technician_id: String(technicianId),
      job_id: String(jobId),
      path: relPath,
    });
    const urlJp = `${dispoBase(baseUrl)}/api/job_project_file_download.php?${qjp}`;
    try {
      const rj = await fetch(urlJp, { headers });
      if (rj.ok) {
        mkdirpSync(path.dirname(destPath));
        fs.writeFileSync(destPath, Buffer.from(await rj.arrayBuffer()));
        return;
      }
      lastErr = new Error('Download fehlgeschlagen: ' + rj.status);
    } catch (e) {
      lastErr = e;
    }
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
          reject(Object.assign(new Error(body ? body.slice(0, 240) : e.message), { nonJson: true }));
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
      const tryAlt = i < urls.length - 1 && e && (e.code404 || e.nonJson);
      if (tryAlt) continue;
      throw e;
    }
  }
  throw lastErr || new Error('Upload fehlgeschlagen');
}

async function syncJobFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId) {
  const { db, save, dbDir } = ctx;
  await syncCommentsOnlyFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId);
  for (const bucket of ['dispo', 'buchhaltung']) {
    const data = await dispoFetchAbrechnungBucketList(baseUrl, jobServerId, bucket, authHeader, technicianId);
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
        const outboxJobId = resolveDispoJobIdForAbrechnung(db, payload.job_id);
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_note_save.php',
          {
            technician_id: technicianId,
            job_id: outboxJobId,
            bucket: payload.bucket,
            body: payload.body || '',
          },
          authHeader,
          technicianId,
        );
        try {
          await syncCommentsOnlyFromDispo(ctx, baseUrl, technicianId, authHeader, outboxJobId);
        } catch (_) {
          /* Kommentarliste folgt beim nächsten Refresh */
        }
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

/**
 * Kernlogik von POST /api/abrechnung/refresh (für direkten Aufruf und Background-Jobs).
 * @returns {Promise<{ partial: boolean, warnings: string[] }>}
 */
async function runAbrechnungRefreshCore(ctx, body) {
  const { db, save, authHeaderFromCredentials } = ctx;
  const { baseUrl, technicianId, serverUsername, serverPassword, period_ym, job_server_id } = body || {};
  const tid = parseInt(technicianId, 10);
  const base = dispoBase(baseUrl);
  if (!base || !tid) {
    const err = new Error('baseUrl und technicianId erforderlich.');
    err.statusCode = 400;
    throw err;
  }
  const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
  const warnings = [];
  let partial = false;
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
  const jid = resolveDispoJobIdForAbrechnung(db, parseInt(job_server_id, 10));
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
  return { partial, warnings };
}

function registerAbrechnungRoutes(app, ctx) {
  const { db, save, dbDir, authHeaderFromCredentials, authHeaderFromIncomingBasicOrQuery } = ctx;
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
      const sqliteOverlap = buildAbrechnungJobsFallbackFromSqlite(db, technicianId, period);
      if (!Array.isArray(jobs) || jobs.length === 0) {
        jobs = sqliteOverlap;
        source = jobs.length ? 'sqlite_fallback' : source;
      } else {
        const merged = mergeAbrechnungJobsUnique(jobs, sqliteOverlap);
        if (merged.length > jobs.length) {
          jobs = merged;
          source = 'snapshot_merged_sqlite';
        }
      }
      return res.json({ ok: true, jobs, synced_at: row ? row.synced_at : null, jobs_source: source });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Bundle: Notizen + Dateiliste (Meta), offline aus Cache; optional Dateinamen von Dispo nachladen */
  app.get('/api/abrechnung/bundle', async (req, res) => {
    try {
      const technicianId = parseInt(req.query.technician_id, 10);
      const jobServerIdRaw = parseInt(req.query.job_server_id, 10);
      if (!technicianId || !jobServerIdRaw) {
        return res.status(400).json({ ok: false, error: 'technician_id und job_server_id erforderlich.' });
      }
      const dispoJobId = resolveDispoJobIdForAbrechnung(db, jobServerIdRaw);
      const baseUrlRaw = (req.query.base_url || req.query.baseUrl || '').toString().trim();
      let auth =
        typeof authHeaderFromIncomingBasicOrQuery === 'function' ? authHeaderFromIncomingBasicOrQuery(req) : undefined;
      if (!auth && typeof authHeaderFromCredentials === 'function') {
        const q = req.query || {};
        auth = authHeaderFromCredentials(q.serverUsername || q.server_username, q.serverPassword ?? q.server_password);
      }
      let dispoCommentsError = null;
      if (baseUrlRaw && auth && technicianId && dispoJobId) {
        try {
          await syncCommentsOnlyFromDispo(ctx, baseUrlRaw, technicianId, auth, dispoJobId);
        } catch (e) {
          dispoCommentsError = e && e.message ? String(e.message) : String(e);
          console.warn('[abrechnung/bundle] Kommentare von Dispo:', dispoCommentsError);
        }
      }
      let row = db
        .prepare('SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?')
        .get(dispoJobId);
      if (!row) {
        row = db
          .prepare('SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?')
          .get(jobServerIdRaw);
      }
      const comments = readCommentsFromRow(row);
      const notes = {
        dispo: row && row.dispo != null ? String(row.dispo) : '',
        buchhaltung: row && row.buchhaltung != null ? String(row.buchhaltung) : '',
        synced_at: row && row.synced_at != null ? row.synced_at : null,
      };
      let files = dedupeAbrechnungFileRows(
        db
          .prepare(
            `SELECT bucket, file_name, size_bytes, synced_at FROM abrechnung_files_meta
             WHERE job_server_id = ? OR job_server_id = ?
             ORDER BY bucket, file_name`,
          )
          .all(dispoJobId, jobServerIdRaw),
      );
      let dispoFilesError = null;
      if (baseUrlRaw && technicianId && dispoJobId) {
        if (!auth) {
          dispoFilesError =
            'Keine Zugangsdaten für Dispo (Benutzername/Passwort in den Einstellungen oder Authorization-Header).';
        }
      }
      if (baseUrlRaw && auth && technicianId && dispoJobId) {
        const base = dispoBase(baseUrlRaw);
        const seenByBucket = new Map();
        for (const fileRow of files) {
          const b = fileRow.bucket;
          if (!seenByBucket.has(b)) seenByBucket.set(b, new Set());
          seenByBucket.get(b).add(fileRow.file_name);
        }
        try {
          for (const bucket of ['dispo', 'buchhaltung']) {
            const data = await dispoFetchAbrechnungBucketList(base, dispoJobId, bucket, auth, technicianId);
            const remoteFiles = data.files || [];
            if (!seenByBucket.has(bucket)) seenByBucket.set(bucket, new Set());
            const seen = seenByBucket.get(bucket);
            for (const rf of remoteFiles) {
              const fn = String(rf.name || rf.file_name || '').trim();
              if (!fn || seen.has(fn)) continue;
              seen.add(fn);
              files.push({
                bucket,
                file_name: fn,
                size_bytes: rf.size_bytes != null ? rf.size_bytes : null,
                synced_at: null,
                remote_only: true,
              });
            }
          }
        } catch (e) {
          dispoFilesError = e && e.message ? String(e.message) : String(e);
          console.warn('[abrechnung/bundle] Dispo-Dateiliste:', dispoFilesError);
        }
      }
      files = dedupeAbrechnungFilesByFilename(files);
      return res.json({
        ok: true,
        comments,
        notes: notes || { dispo: '', buchhaltung: '', synced_at: null },
        files: files || [],
        job_id_for_dispo: dispoJobId,
        job_id_from_client: jobServerIdRaw,
        dispo_files_error: dispoFilesError,
        dispo_comments_error: dispoCommentsError,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Abrechnung-Datei: zuerst lokal, sonst Proxy zur Dispo (Authorization + optional base_url) */
  app.get('/api/abrechnung/file', async (req, res) => {
    try {
      const jobServerIdRaw = parseInt(req.query.job_server_id, 10);
      const bucket = (req.query.bucket || '').trim();
      const name = path.basename((req.query.name || '').toString());
      const baseUrlRaw = (req.query.base_url || req.query.baseUrl || '').toString().trim();
      const technicianId = parseInt(String(req.headers['x-technician-id'] || req.query.technician_id || ''), 10);
      if (!jobServerIdRaw || !['dispo', 'buchhaltung'].includes(bucket) || !name) {
        return res.status(400).send('Ungültige Parameter.');
      }
      const dispoJobId = resolveDispoJobIdForAbrechnung(db, jobServerIdRaw);
      const fp = findLocalAbrechnungFilePath(dbDir, db, jobServerIdRaw, bucket, name);
      if (fp) {
        return res.sendFile(path.resolve(fp));
      }
      const base = dispoBase(baseUrlRaw);
      let auth =
        typeof authHeaderFromIncomingBasicOrQuery === 'function' ? authHeaderFromIncomingBasicOrQuery(req) : undefined;
      if (!auth && typeof authHeaderFromCredentials === 'function') {
        const q = req.query || {};
        auth = authHeaderFromCredentials(q.serverUsername || q.server_username, q.serverPassword ?? q.server_password);
      }
      if (!base || !technicianId || !auth) {
        return res
          .status(404)
          .send(
            'Datei nicht lokal. Zum Laden von der Dispo in den Einstellungen Dispo-URL und Zugangsdaten setzen, dann erneut öffnen.',
          );
      }
      const q = new URLSearchParams({
        technician_id: String(technicianId),
        job_id: String(dispoJobId),
        bucket,
        name,
      });
      const qsStr = q.toString();
      const hdrs = dispoMonteurFetchHeaders(auth, technicianId);
      const urls = abrechnungScriptUrlCandidates(base, 'abrechnung_file_download.php').map((u) => `${u}?${qsStr}`);
      let lastBody = '';
      for (let i = 0; i < urls.length; i++) {
        const r = await fetch(urls[i], { headers: hdrs });
        if (!r.ok) {
          lastBody = await r.text().catch(() => '');
          if (r.status === 404 && i < urls.length - 1) continue;
          if (r.status === 404 && i === urls.length - 1) break;
          return res.status(r.status).send(lastBody || r.statusText || String(r.status));
        }
        const ct = r.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        const cd = r.headers.get('content-disposition');
        if (cd) res.setHeader('Content-Disposition', cd);
        if (r.body && typeof Readable.fromWeb === 'function') {
          Readable.fromWeb(r.body)
            .on('error', () => {
              try {
                res.destroy();
              } catch (_) {}
            })
            .pipe(res);
          return;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        return res.send(buf);
      }
      const subPb = abrechnungBucketProjectSubdir(bucket);
      if (subPb && name) {
        const relPath = `${subPb}/${name}`.replace(/\\/g, '/');
        const qJp = new URLSearchParams({
          technician_id: String(technicianId),
          job_id: String(dispoJobId),
          path: relPath,
        });
        const urlJp = `${base}/api/job_project_file_download.php?${qJp}`;
        const rJp = await fetch(urlJp, { headers: hdrs });
        if (rJp.ok) {
          const ct = rJp.headers.get('content-type');
          if (ct) res.setHeader('Content-Type', ct);
          const cd = rJp.headers.get('content-disposition');
          if (cd) res.setHeader('Content-Disposition', cd);
          if (rJp.body && typeof Readable.fromWeb === 'function') {
            Readable.fromWeb(rJp.body)
              .on('error', () => {
                try {
                  res.destroy();
                } catch (_) {}
              })
              .pipe(res);
            return;
          }
          const buf = Buffer.from(await rJp.arrayBuffer());
          return res.send(buf);
        }
        lastBody = await rJp.text().catch(() => '');
      }
      return res.status(404).send(lastBody || 'Download nicht gefunden.');
    } catch (e) {
      res.status(500).send(e.message || String(e));
    }
  });

  app.post('/api/abrechnung/refresh', express.json(), async (req, res) => {
    try {
      const result = await runAbrechnungRefreshCore(ctx, req.body || {});
      return res.json({ ok: true, partial: result.partial, warnings: result.warnings });
    } catch (e) {
      const code = e && e.statusCode === 400 ? 400 : 500;
      return res.status(code).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/abrechnung/note', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, body } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const jidRaw = parseInt(job_server_id, 10);
    const dispoJid = resolveDispoJobIdForAbrechnung(db, jidRaw);
    const b = (bucket || '').trim();
    if (!tid || !dispoJid || !['dispo', 'buchhaltung'].includes(b)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Parameter.' });
    }
    const text = body != null ? String(body) : '';
    const base = dispoBase(baseUrl);
    if (base) {
      try {
        const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
        await dispoAbrechnungPostJson(
          baseUrl,
          'abrechnung_note_save.php',
          { technician_id: tid, job_id: dispoJid, bucket: b, body: text },
          authHeader,
          tid,
        );
        await syncCommentsOnlyFromDispo(ctx, baseUrl, tid, authHeader, dispoJid);
        return res.json({ ok: true, synced: true });
      } catch (e) {
        appendOptimisticComment(db, dispoJid, b, text);
        save();
        db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
          'note',
          JSON.stringify({ job_id: dispoJid, bucket: b, body: text })
        );
        save();
        return res.json({ ok: true, synced: false, queued: true, error: e.message });
      }
    }
    appendOptimisticComment(db, dispoJid, b, text);
    save();
    db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
      'note',
      JSON.stringify({ job_id: dispoJid, bucket: b, body: text })
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

module.exports = { registerAbrechnungRoutes, flushAbrechnungOutbox, runAbrechnungRefreshCore };
