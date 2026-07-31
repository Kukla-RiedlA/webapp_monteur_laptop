'use strict';

const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const FormData = require('form-data');
const express = require('express');
const phpLocal = require('./abrechnung-php-local');

function mkdirpSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cacheRoot(dbDir) {
  return path.join(dbDir, 'abrechnung_cache');
}

function jobDir(dbDir, jobServerId) {
  return path.join(cacheRoot(dbDir), String(jobServerId));
}

/** Wie dispo/inc/abrechnung_access.php abrechnung_bucket_subdir — Dateien im Dienstreise-Projektordner. */
function abrechnungBucketDienstreiseSubdir(bucket) {
  if (bucket === 'dispo' || bucket === 'buchhaltung') return 'Dokumente_Dispo';
  if (bucket === 'ordner_buchhaltung') return 'Dokumente_Buchhaltung';
  return null;
}

function abrechnungFileCtxFrom(ctx) {
  if (!ctx || typeof ctx.resolveDienstreiseReiseDirForJob !== 'function') return null;
  return { resolveDienstreiseReiseDirForJob: ctx.resolveDienstreiseReiseDirForJob };
}

function normalizeAbrechnungRelativeName(name) {
  const raw = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const parts = raw.split('/').map((p) => path.basename(p)).filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}

function filePathLocal(dbDir, jobServerId, bucket, name, fileCtx) {
  const rel = normalizeAbrechnungRelativeName(name);
  if (!rel) return path.join(jobDir(dbDir, jobServerId), bucket, '');
  const sub = abrechnungBucketDienstreiseSubdir(bucket);
  if (fileCtx && sub) {
    const reiseDir = fileCtx.resolveDienstreiseReiseDirForJob(jobServerId, { createIfMissing: true });
    if (reiseDir) return path.join(reiseDir, sub, ...rel.split('/'));
  }
  return path.join(jobDir(dbDir, jobServerId), bucket, ...rel.split('/'));
}

function walkFilesRecursive(rootDir, relBase) {
  const out = [];
  if (!rootDir || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return out;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const n = ent.name;
    if (!n || n.startsWith('.')) continue;
    const fp = path.join(rootDir, n);
    const rel = relBase ? `${relBase}/${n}` : n;
    try {
      if (ent.isDirectory()) {
        out.push(...walkFilesRecursive(fp, rel));
      } else if (ent.isFile()) {
        const st = fs.statSync(fp);
        out.push({
          file_name: rel.replace(/\\/g, '/'),
          size_bytes: st.size,
          uploaded_at: st.mtime ? new Date(st.mtime).toISOString() : null,
        });
      }
    } catch (_) {
      /* ignore */
    }
  }
  return out;
}

function scanLocalAbrechnungFilesFromDisk(fileCtx, db, jobServerIdFromQuery, bucket, dbDir) {
  if (!bucket) return [];
  const sub = abrechnungBucketDienstreiseSubdir(bucket);
  const resolved = resolveDispoJobIdForAbrechnung(db, jobServerIdFromQuery);
  const ids = Array.from(
    new Set(
      [jobServerIdFromQuery, resolved].filter((x) => {
        const n = parseInt(String(x), 10);
        return Number.isFinite(n) && n > 0;
      }),
    ),
  );
  const seen = new Set();
  const out = [];
  function pushRow(row) {
    const fn = row.file_name != null ? String(row.file_name) : '';
    if (!fn || seen.has(fn)) return;
    seen.add(fn);
    out.push({
      bucket,
      file_name: fn,
      size_bytes: row.size_bytes != null ? row.size_bytes : null,
      synced_at: null,
      uploaded_at: row.uploaded_at != null ? row.uploaded_at : null,
      uploaded_by_name: row.uploaded_by_name != null ? row.uploaded_by_name : null,
    });
  }
  for (const id of ids) {
    if (fileCtx && sub) {
      const reiseDir = fileCtx.resolveDienstreiseReiseDirForJob(id, { createIfMissing: false });
      if (reiseDir) {
        const dir = path.join(reiseDir, sub);
        for (const f of walkFilesRecursive(dir, '')) pushRow(f);
      }
    }
    if (dbDir) {
      const legacyDir = path.join(jobDir(dbDir, id), bucket);
      for (const f of walkFilesRecursive(legacyDir, '')) pushRow(f);
    }
  }
  return out;
}

function ensureSchema(db) {
  /** DB-Wrapper: db.prepare(…).run/get/all */
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
    uploaded_at TEXT,
    uploaded_by_name TEXT,
    uploaded_by_user_id INTEGER,
    PRIMARY KEY (job_server_id, bucket, file_name)
  )`).run();
  try {
    db.prepare('ALTER TABLE abrechnung_files_meta ADD COLUMN uploaded_at TEXT').run();
  } catch (_) {
    /* exists */
  }
  try {
    db.prepare('ALTER TABLE abrechnung_files_meta ADD COLUMN uploaded_by_name TEXT').run();
  } catch (_) {
    /* exists */
  }
  try {
    db.prepare('ALTER TABLE abrechnung_files_meta ADD COLUMN uploaded_by_user_id INTEGER').run();
  } catch (_) {
    /* exists */
  }
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    attempts INTEGER NOT NULL DEFAULT 0
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS abrechnung_billing_cache (
    job_server_id INTEGER PRIMARY KEY,
    billing_json TEXT NOT NULL,
    synced_at TEXT
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

/** Outbox delete/upload Keys: "bucket\\0filename" für einen Dispo-Job. */
function pendingAbrechnungOutboxKeys(db, jobServerId, op) {
  const keys = new Set();
  const jidWant = Number(jobServerId);
  if (!Number.isFinite(jidWant) || jidWant <= 0) return keys;
  const rows = db.prepare('SELECT payload FROM abrechnung_outbox WHERE op = ?').all(op);
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload || '{}');
      const jid = Number(resolveDispoJobIdForAbrechnung(db, p.job_id));
      if (jid !== jidWant) continue;
      const b = String(p.bucket || '').trim();
      const n = normalizeAbrechnungRelativeName(p.name || p.filename || '');
      if (b && n) keys.add(b + '\0' + n);
    } catch (_) {
      /* ignore */
    }
  }
  return keys;
}

function enrichAbrechnungFilesWithSyncState(db, jobServerId, files) {
  const jid = resolveDispoJobIdForAbrechnung(db, jobServerId);
  const pendingUp = pendingAbrechnungOutboxKeys(db, jid, 'upload');
  const pendingDel = pendingAbrechnungOutboxKeys(db, jid, 'delete');
  return (files || []).map((f) => {
    const bucket = String(f.bucket || 'dispo').trim();
    const name = normalizeAbrechnungRelativeName(f.name || f.file_name || '');
    const key = bucket + '\0' + name;
    const synced = f.synced_at != null && String(f.synced_at).trim() !== '';
    let sync_state = 'idle';
    if (pendingDel.has(key)) sync_state = 'pending_delete';
    else if (pendingUp.has(key) && !synced) sync_state = 'pending_upload';
    // Stale Outbox nach Live-Upload: synced_at gesetzt → nicht weiter drehen.
    const server_present =
      sync_state === 'pending_upload'
        ? false
        : sync_state === 'pending_delete'
          ? true
          : synced;
    return Object.assign({}, f, {
      name: name || f.name || f.file_name,
      sync_state,
      server_present,
    });
  });
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
    const next = {
      bucket: b,
      file_name: fn,
      size_bytes: row.size_bytes != null ? row.size_bytes : null,
      synced_at: row.synced_at != null ? row.synced_at : null,
      uploaded_at: row.uploaded_at != null ? row.uploaded_at : null,
      uploaded_by_name: row.uploaded_by_name != null ? row.uploaded_by_name : null,
      remote_only: row.remote_only === true,
    };
    if (!m.has(k)) {
      m.set(k, next);
      continue;
    }
    const prev = m.get(k);
    m.set(k, {
      bucket: b,
      file_name: fn,
      size_bytes: next.size_bytes != null ? next.size_bytes : prev.size_bytes,
      synced_at: next.synced_at || prev.synced_at,
      uploaded_at: next.uploaded_at || prev.uploaded_at,
      uploaded_by_name: next.uploaded_by_name || prev.uploaded_by_name,
      remote_only: prev.remote_only && next.remote_only,
    });
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
        uploaded_at: row.uploaded_at != null ? row.uploaded_at : null,
        uploaded_by_name: row.uploaded_by_name != null ? row.uploaded_by_name : null,
        remote_only: row.remote_only === true,
      });
    }
  }
  return Array.from(m.values()).sort((a, b) => String(a.file_name || '').localeCompare(String(b.file_name || '')));
}

function findLocalAbrechnungFilePath(dbDir, db, jobServerIdFromQuery, bucket, name, fileCtx) {
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
    const fp = filePathLocal(dbDir, id, bucket, name, fileCtx);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
    const rel = normalizeAbrechnungRelativeName(name);
    const legacy = path.join(jobDir(dbDir, id), bucket, ...(rel ? rel.split('/') : []));
    if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) return legacy;
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
 * (Ordner Dokumente_Dispo inkl. Unterordner — wie nach dienstreise_pull lokal).
 */
async function dispoListProjectFilesRecursive(baseUrl, dispoJobId, rootRelPath, authHeader, technicianId) {
  const files = [];
  async function walk(relPath) {
    const data = await dispoJobProjectFilesListJson(baseUrl, dispoJobId, relPath, authHeader, technicianId);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    for (const ent of entries) {
      if (!ent || !ent.name) continue;
      const name = String(ent.name).trim();
      if (!name || name === '.' || name === '..') continue;
      const childRel = relPath ? `${relPath}/${name}` : name;
      const type = String(ent.type || '').toLowerCase();
      if (type === 'dir' || type === 'directory') {
        await walk(childRel);
      } else if (type === 'file') {
        const root = String(rootRelPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        let relInBucket = childRel.replace(/\\/g, '/');
        if (root && relInBucket.startsWith(root + '/')) {
          relInBucket = relInBucket.slice(root.length + 1);
        } else if (relInBucket === root) {
          relInBucket = path.basename(relInBucket);
        }
        files.push({
          name: relInBucket,
          size_bytes: ent.size != null ? Number(ent.size) : null,
        });
      }
    }
  }
  await walk(rootRelPath);
  return files;
}

async function dispoFetchAbrechnungBucketList(baseUrl, dispoJobId, bucket, authHeader, technicianId) {
  let files = [];
  let primaryErr = null;
  try {
    const data = await dispoFetchJson(
      baseUrl,
      'abrechnung_bucket_list.php',
      { job_id: String(dispoJobId), bucket },
      authHeader,
      technicianId,
    );
    files = Array.isArray(data.files) ? data.files : [];
  } catch (e) {
    primaryErr = e;
  }
  const sub = abrechnungBucketProjectSubdir(bucket);
  if (sub) {
    try {
      const proj = await dispoListProjectFilesRecursive(baseUrl, dispoJobId, sub, authHeader, technicianId);
      const seen = new Set(
        files.map((f) => normalizeAbrechnungRelativeName(f && (f.name || f.file_name))),
      );
      for (const pf of proj) {
        const n = normalizeAbrechnungRelativeName(pf.name);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        files.push(pf);
      }
    } catch (fallbackErr) {
      if (!files.length) {
        const p = primaryErr && primaryErr.message ? primaryErr.message : String(primaryErr || '');
        const f = fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr);
        throw new Error(`${p} — Fallback job_project_files_list (${sub}): ${f}`);
      }
    }
  } else if (!files.length && primaryErr) {
    throw primaryErr;
  }
  return { ok: true, files };
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
  const relName = normalizeAbrechnungRelativeName(name);
  if (sub && relName) {
    const relPath = `${sub}/${relName}`.replace(/\\/g, '/');
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
          const code = res.statusCode || 0;
          // 2xx ohne JSON: Datei oft schon geschrieben — als Erfolg werten (kein Outbox-Retry → keine Duplikate).
          if (code >= 200 && code < 300) {
            resolve({
              ok: true,
              name: path.basename(fileName || 'datei'),
              nonJson: true,
            });
            return;
          }
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
      // Nur bei echtem 404 die Alternativ-URL versuchen.
      // Bei nonJson NICHT retryen: die erste URL kann die Datei schon geschrieben haben
      // (sonst entsteht Sonstige_….pdf + Sonstige_…-1.pdf).
      const tryAlt = i < urls.length - 1 && e && e.code404;
      if (tryAlt) continue;
      throw e;
    }
  }
  throw lastErr || new Error('Upload fehlgeschlagen');
}

/** Entfernt doppelte Upload-Outbox-Einträge für dieselbe Datei. */
function clearAbrechnungOutboxUploadsForFile(db, jobServerId, bucket, fileName) {
  const jidWant = Number(resolveDispoJobIdForAbrechnung(db, jobServerId));
  const wantBucket = String(bucket || '').trim();
  const wantName = normalizeAbrechnungRelativeName(fileName);
  if (!jidWant || !wantBucket || !wantName) return;
  const rows = db.prepare(`SELECT id, payload FROM abrechnung_outbox WHERE op = 'upload'`).all();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload || '{}');
      const jid = Number(resolveDispoJobIdForAbrechnung(db, p.job_id));
      const b = String(p.bucket || '').trim();
      const n = normalizeAbrechnungRelativeName(p.filename || p.name || p.orig_filename || '');
      if (jid === jidWant && b === wantBucket && n === wantName) {
        db.prepare('DELETE FROM abrechnung_outbox WHERE id = ?').run(row.id);
      }
    } catch (_) {
      /* ignore */
    }
  }
}

async function syncJobFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId) {
  const { db, save, dbDir } = ctx;
  const fileCtx = abrechnungFileCtxFrom(ctx);
  const pendingDeletes = pendingAbrechnungOutboxKeys(db, jobServerId, 'delete');
  const pendingUploads = pendingAbrechnungOutboxKeys(db, jobServerId, 'upload');
  await syncCommentsOnlyFromDispo(ctx, baseUrl, technicianId, authHeader, jobServerId);
  for (const bucket of ['dispo', 'buchhaltung']) {
    const data = await dispoFetchAbrechnungBucketList(baseUrl, jobServerId, bucket, authHeader, technicianId);
    const files = data.files || [];
    const prevMeta = db
      .prepare(
        `SELECT file_name, uploaded_by_name, uploaded_by_user_id, uploaded_at
         FROM abrechnung_files_meta WHERE job_server_id = ? AND bucket = ?`,
      )
      .all(jobServerId, bucket);
    const prevByName = new Map();
    for (const row of prevMeta) {
      prevByName.set(String(row.file_name), row);
    }
    db.prepare('DELETE FROM abrechnung_files_meta WHERE job_server_id = ? AND bucket = ?').run(jobServerId, bucket);
    for (const f of files) {
      const fn = normalizeAbrechnungRelativeName(f.name || f.file_name);
      if (!fn) continue;
      const key = bucket + '\0' + fn;
      if (pendingDeletes.has(key)) continue;
      const localPath = filePathLocal(dbDir, jobServerId, bucket, fn, fileCtx);
      try {
        mkdirpSync(path.dirname(localPath));
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
          await dispoDownloadFile(baseUrl, jobServerId, bucket, fn, localPath, authHeader, technicianId);
        }
        const prev = prevByName.get(fn);
        const byName =
          f.uploaded_by_name != null && String(f.uploaded_by_name).trim() !== ''
            ? String(f.uploaded_by_name)
            : prev && prev.uploaded_by_name
              ? String(prev.uploaded_by_name)
              : null;
        const byUser =
          f.uploaded_by_user_id != null
            ? Number(f.uploaded_by_user_id)
            : prev && prev.uploaded_by_user_id != null
              ? Number(prev.uploaded_by_user_id)
              : null;
        const uploadedAt =
          f.uploaded_at != null
            ? String(f.uploaded_at)
            : prev && prev.uploaded_at
              ? String(prev.uploaded_at)
              : null;
        db.prepare(`
          INSERT INTO abrechnung_files_meta (
            job_server_id, bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name, uploaded_by_user_id
          ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
        `).run(
          jobServerId,
          bucket,
          fn,
          f.size_bytes != null ? f.size_bytes : fs.statSync(localPath).size,
          uploadedAt,
          byName,
          byUser,
        );
      } catch (e) {
        console.warn('[abrechnung] download skip', fn, e.message);
      }
    }
    const diskOnly = scanLocalAbrechnungFilesFromDisk(fileCtx, db, jobServerId, bucket, dbDir);
    const serverNames = new Set(
      (files || [])
        .map((f) => normalizeAbrechnungRelativeName(f && (f.name || f.file_name)))
        .filter(Boolean),
    );
    for (const row of diskOnly) {
      const fn = row.file_name;
      const key = bucket + '\0' + fn;
      if (pendingDeletes.has(key) || pendingUploads.has(key)) {
        if (pendingDeletes.has(key)) {
          try {
            const lp = findLocalAbrechnungFilePath(dbDir, db, jobServerId, bucket, fn, fileCtx);
            if (lp && fs.existsSync(lp)) fs.unlinkSync(lp);
          } catch (_) {
            /* ignore */
          }
          continue;
        }
        // pending_upload: in Meta behalten
        const exists = db
          .prepare(
            'SELECT 1 FROM abrechnung_files_meta WHERE job_server_id = ? AND bucket = ? AND file_name = ?',
          )
          .get(jobServerId, bucket, fn);
        if (exists) continue;
        const prev = prevByName.get(fn);
        db.prepare(`
          INSERT INTO abrechnung_files_meta (
            job_server_id, bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name, uploaded_by_user_id
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          jobServerId,
          bucket,
          fn,
          row.size_bytes,
          prev && prev.uploaded_at ? String(prev.uploaded_at) : null,
          prev && prev.uploaded_by_name ? String(prev.uploaded_by_name) : null,
          prev && prev.uploaded_by_user_id != null ? Number(prev.uploaded_by_user_id) : null,
        );
        continue;
      }

      if (serverNames.has(fn)) continue;

      // Auf Server gelöscht → alle lokalen Kopien (Dienstreise + Legacy-Cache) entfernen.
      try {
        const paths = [];
        const primary = findLocalAbrechnungFilePath(dbDir, db, jobServerId, bucket, fn, fileCtx);
        if (primary) paths.push(primary);
        const legacy = path.join(jobDir(dbDir, jobServerId), bucket, ...String(fn).split('/'));
        paths.push(legacy);
        const resolved = resolveDispoJobIdForAbrechnung(db, jobServerId);
        if (resolved !== jobServerId) {
          paths.push(path.join(jobDir(dbDir, resolved), bucket, ...String(fn).split('/')));
        }
        let removed = false;
        for (const lp of paths) {
          try {
            if (lp && fs.existsSync(lp) && fs.statSync(lp).isFile()) {
              fs.unlinkSync(lp);
              removed = true;
            }
          } catch (_) {
            /* ignore */
          }
        }
        if (removed) {
          console.log('[abrechnung] lokale Rest-Datei entfernt (fehlt auf Server):', bucket, fn);
        }
      } catch (e) {
        console.warn('[abrechnung] Rest-Datei löschen fehlgeschlagen', fn, e && e.message);
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
        const outboxJobId = resolveDispoJobIdForAbrechnung(db, payload.job_id);
        const uploadFields = {
          job_id: String(outboxJobId),
          bucket: String(payload.bucket),
        };
        // Dateiname in Outbox ist bereits final — kein zweites beleg_prefix.
        if (payload.uploader_name) {
          uploadFields.uploader_name = String(payload.uploader_name);
        }
        const uploadName = payload.orig_filename || payload.filename || 'datei';
        const upRes = await dispoUploadMultipart(
          baseUrl,
          uploadFields,
          buf,
          uploadName,
          authHeader,
          technicianId,
        );
        const fn = normalizeAbrechnungRelativeName(
          (upRes && (upRes.name || upRes.file_name)) || payload.filename || uploadName,
        );
        if (fn) {
          db.prepare(
            `UPDATE abrechnung_files_meta SET synced_at = datetime('now'), file_name = COALESCE(?, file_name)
             WHERE job_server_id = ? AND bucket = ? AND (file_name = ? OR file_name = ?)`,
          ).run(
            fn,
            outboxJobId,
            String(payload.bucket || ''),
            normalizeAbrechnungRelativeName(payload.filename || ''),
            fn,
          );
          clearAbrechnungOutboxUploadsForFile(db, outboxJobId, payload.bucket, fn);
          clearAbrechnungOutboxUploadsForFile(db, outboxJobId, payload.bucket, payload.filename);
        }
      } else if (row.op === 'delete') {
        const outboxJobId = resolveDispoJobIdForAbrechnung(db, payload.job_id);
        try {
          await dispoAbrechnungPostJson(
            baseUrl,
            'abrechnung_file_delete.php',
            {
              technician_id: technicianId,
              job_id: outboxJobId,
              bucket: payload.bucket,
              name: payload.name,
            },
            authHeader,
            technicianId,
          );
        } catch (delErr) {
          const msg = delErr && delErr.message ? String(delErr.message) : String(delErr);
          // Bereits weg auf dem Server → Outbox-Eintrag erledigt, nicht endlos retryen.
          if (/nicht gefunden|not found|404/i.test(msg)) {
            db.prepare('DELETE FROM abrechnung_outbox WHERE id = ?').run(row.id);
            continue;
          }
          throw delErr;
        }
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
async function runAbrechnungRefreshCore(ctx, body, onProgress) {
  const { db, save, authHeaderFromCredentials } = ctx;
  const { baseUrl, technicianId, serverUsername, serverPassword, period_ym, job_server_id, sync_all_jobs } =
    body || {};
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
  let jobsPayload = [];
  if (period_ym && /^\d{4}-\d{2}$/.test(String(period_ym))) {
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
  const syncAll = sync_all_jobs === true;
  const priorityJid = resolveDispoJobIdForAbrechnung(db, parseInt(job_server_id, 10));
  try {
    await flushAbrechnungOutbox(ctx, base, tid, serverUsername, serverPassword);
  } catch (e) {
    partial = true;
    const hint = e && e.message ? String(e.message) : String(e);
    warnings.push('Ausstehende Änderungen nicht vollständig übertragen: ' + hint);
    console.warn('[abrechnung/refresh] outbox:', hint);
  }
  if (syncAll && period_ym) {
    let jobs = jobsPayload;
    if (!jobs.length) {
      const row = db
        .prepare(
          'SELECT jobs_json FROM abrechnung_jobs_snapshot WHERE technician_id = ? AND period_ym = ?',
        )
        .get(tid, period_ym);
      if (row && row.jobs_json) {
        try {
          jobs = JSON.parse(row.jobs_json);
        } catch (_) {
          jobs = [];
        }
      }
    }
    if (!Array.isArray(jobs) || !jobs.length) {
      jobs = buildAbrechnungJobsFallbackFromSqlite(db, tid, period_ym);
    }
    const ordered = [];
    const seen = new Set();
    if (priorityJid > 0) {
      ordered.push({ id: priorityJid });
      seen.add(priorityJid);
    }
    for (const j of jobs) {
      const jid = resolveDispoJobIdForAbrechnung(db, j && j.id != null ? j.id : 0);
      if (jid > 0 && !seen.has(jid)) {
        seen.add(jid);
        ordered.push({ id: jid });
      }
    }
    const total = ordered.length;
    let idx = 0;
    for (const j of ordered) {
      const jid = j.id;
      idx += 1;
      if (typeof onProgress === 'function') {
        onProgress(idx, total, 'Auftrag ' + jid + ' (' + idx + '/' + total + ')');
      }
      try {
        await syncJobFromDispo(ctx, base, tid, authHeader, jid);
      } catch (e) {
        partial = true;
        const hint = e && e.message ? String(e.message) : String(e);
        warnings.push('Auftrag ' + jid + ': ' + hint);
        console.warn('[abrechnung/refresh] syncJobFromDispo', jid, hint);
      }
    }
  } else if (priorityJid > 0) {
    try {
      await syncJobFromDispo(ctx, base, tid, authHeader, priorityJid);
    } catch (e) {
      partial = true;
      const hint = e && e.message ? String(e.message) : String(e);
      warnings.push('Detail-Daten (Notizen/Dateien) nicht von Dispo geladen: ' + hint);
      console.warn('[abrechnung/refresh] syncJobFromDispo:', hint);
    }
  }
  return { partial, warnings };
}

function registerAbrechnungRoutesInner(app, ctx) {
  const { db, save, dbDir, authHeaderFromCredentials, authHeaderFromIncomingBasicOrQuery } = ctx;
  const fileCtx = abrechnungFileCtxFrom(ctx);
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
            `SELECT bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name FROM abrechnung_files_meta
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
                uploaded_at: rf.uploaded_at != null ? rf.uploaded_at : null,
                uploaded_by_name: rf.uploaded_by_name != null ? rf.uploaded_by_name : null,
                remote_only: true,
              });
            }
          }
        } catch (e) {
          dispoFilesError = e && e.message ? String(e.message) : String(e);
          console.warn('[abrechnung/bundle] Dispo-Dateiliste:', dispoFilesError);
        }
      }
      for (const bucket of ['dispo', 'buchhaltung']) {
        const diskOnly = scanLocalAbrechnungFilesFromDisk(fileCtx, db, jobServerIdRaw, bucket, dbDir);
        const seenFn = new Set(files.map((fr) => `${fr.bucket}\0${fr.file_name}`));
        for (const dr of diskOnly) {
          const k = `${dr.bucket}\0${dr.file_name}`;
          if (seenFn.has(k)) continue;
          seenFn.add(k);
          files.push(dr);
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
      const fp = findLocalAbrechnungFilePath(dbDir, db, jobServerIdRaw, bucket, name, fileCtx);
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
            'Datei nicht lokal. Hintergrund-Sync lädt fehlende Dateien nach — bitte kurz warten und erneut öffnen.',
          );
      }
      const dest = filePathLocal(dbDir, dispoJobId, bucket, name, fileCtx);
      try {
        mkdirpSync(path.dirname(dest));
        await dispoDownloadFile(base, dispoJobId, bucket, name, dest, auth, technicianId);
        db.prepare(`
          INSERT INTO abrechnung_files_meta (job_server_id, bucket, file_name, size_bytes, synced_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(job_server_id, bucket, file_name) DO UPDATE SET
            size_bytes = excluded.size_bytes,
            synced_at = excluded.synced_at
        `).run(
          dispoJobId,
          bucket,
          name,
          fs.existsSync(dest) ? fs.statSync(dest).size : null,
        );
        save();
        return res.sendFile(path.resolve(dest));
      } catch (dlErr) {
        return res.status(404).send((dlErr && dlErr.message) || 'Download nicht gefunden.');
      }
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
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, filename, content_base64, beleg_prefix } = req.body || {};
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
    const origName = path.basename((filename || 'datei').toString());
    const belegPrefixIn = String(beleg_prefix || '').trim();
    const belegPrefix = phpLocal.belegPrefixAllowed(belegPrefixIn) ? belegPrefixIn : null;
    const probePath = filePathLocal(dbDir, jid, b, 'probe.tmp', fileCtx);
    const targetDir = path.dirname(probePath);
    mkdirpSync(targetDir);
    const safeName = phpLocal.resolveUniqueStoredName(origName, belegPrefix, targetDir);
    const localPath = path.join(targetDir, path.basename(safeName));
    fs.writeFileSync(localPath, buf);
    const uploaderName = phpLocal.resolveTechnicianDisplayName(db, tid);
    const uploadedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO abrechnung_files_meta (
        job_server_id, bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name, uploaded_by_user_id
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(job_server_id, bucket, file_name) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        uploaded_at = excluded.uploaded_at,
        uploaded_by_name = excluded.uploaded_by_name,
        uploaded_by_user_id = excluded.uploaded_by_user_id
    `).run(jid, b, safeName, buf.length, uploadedAt, uploaderName || null, tid || null);
    save();

    const base = dispoBase(baseUrl);
    const uploadFields = { job_id: String(jid), bucket: b };
    if (uploaderName) uploadFields.uploader_name = uploaderName;
    const remoteName = safeName || origName;
    if (base) {
      try {
        const authHeader = authHeaderFromCredentials(serverUsername, serverPassword);
        const upRes = await dispoUploadMultipart(base, uploadFields, buf, remoteName, authHeader, tid);
        const serverName = normalizeAbrechnungRelativeName((upRes && (upRes.name || upRes.file_name)) || safeName);
        db.prepare(
          `UPDATE abrechnung_files_meta SET synced_at = datetime('now'), file_name = ?
           WHERE job_server_id = ? AND bucket = ? AND file_name = ?`,
        ).run(serverName || safeName, jid, b, safeName);
        clearAbrechnungOutboxUploadsForFile(db, jid, b, safeName);
        if (serverName) clearAbrechnungOutboxUploadsForFile(db, jid, b, serverName);
        save();
        return res.json({ ok: true, name: serverName || safeName, synced: true });
      } catch (e) {
        db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
          'upload',
          JSON.stringify({
            job_id: jid,
            bucket: b,
            filename: safeName,
            local_path: localPath,
            beleg_prefix: '',
            orig_filename: remoteName,
            uploader_name: uploaderName || '',
          })
        );
        save();
        return res.json({ ok: true, name: safeName, synced: false, queued: true, error: e.message });
      }
    }
    db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
      'upload',
      JSON.stringify({
        job_id: jid,
        bucket: b,
        filename: safeName,
        local_path: localPath,
        beleg_prefix: '',
        orig_filename: remoteName,
        uploader_name: uploaderName || '',
      })
    );
    save();
    return res.json({ ok: true, name: safeName, synced: false, queued: true });
  });

  app.post('/api/abrechnung/delete_file', express.json(), async (req, res) => {
    const { baseUrl, technicianId, serverUsername, serverPassword, job_server_id, bucket, name } = req.body || {};
    const tid = parseInt(technicianId, 10);
    const jidRaw = parseInt(job_server_id, 10);
    const jid = resolveDispoJobIdForAbrechnung(db, jidRaw);
    const b = (bucket || '').trim();
    const fn = path.basename((name || '').toString());
    if (!tid || !jid || !['dispo', 'buchhaltung'].includes(b) || !fn) {
      return res.status(400).json({ ok: false, error: 'Parameter fehlen.' });
    }
    const localPath = filePathLocal(dbDir, jid, b, fn, fileCtx);
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (_) { /* ignore */ }
    db.prepare('DELETE FROM abrechnung_files_meta WHERE (job_server_id = ? OR job_server_id = ?) AND bucket = ? AND file_name = ?').run(
      jid,
      jidRaw,
      b,
      fn,
    );
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

function registerAbrechnungRoutes(app, ctx) {
  ensureSchema(ctx.db);
  registerAbrechnungRoutesInner(app, ctx);
}

module.exports = {
  registerAbrechnungRoutes,
  flushAbrechnungOutbox,
  runAbrechnungRefreshCore,
  resolveDispoJobIdForAbrechnung,
  readCommentsFromRow,
  writeCommentsCache,
  appendOptimisticComment,
  syncCommentsOnlyFromDispo,
  dispoFetchJson,
  dispoAbrechnungPostJson,
  dispoUploadMultipart,
  normalizeAbrechnungRelativeName,
  walkFilesRecursive,
  scanLocalAbrechnungFilesFromDisk,
  abrechnungFileCtxFrom,
  abrechnungBucketDienstreiseSubdir,
  findLocalAbrechnungFilePath,
  filePathLocal,
  jobDir,
  cacheRoot,
  mkdirpSync,
  dedupeAbrechnungFileRows,
  enrichAbrechnungFilesWithSyncState,
  pendingAbrechnungOutboxKeys,
  clearAbrechnungOutboxUploadsForFile,
  dispoDownloadFile,
};
