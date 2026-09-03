'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');

function ensureHinweiseLocalSchema(db) {
  if (!db || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS hinweise_local (
      client_uuid TEXT PRIMARY KEY,
      server_id INTEGER,
      scope TEXT NOT NULL DEFAULT 'fn',
      fabrikationsnummer TEXT,
      job_id INTEGER,
      body TEXT,
      tag TEXT DEFAULT 'allgemein',
      deadline TEXT,
      status TEXT DEFAULT 'open',
      source TEXT DEFAULT 'techniker',
      created_at TEXT DEFAULT (datetime('now')),
      pending_push INTEGER NOT NULL DEFAULT 1,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS hinweis_files_local (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL,
      original_name TEXT,
      abs_path TEXT,
      mime TEXT,
      size_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hinweise_local_fab ON hinweise_local(fabrikationsnummer);
    CREATE INDEX IF NOT EXISTS idx_hinweise_local_pending ON hinweise_local(pending_push);
  `);
}

function outboxRoot(dbDir) {
  return path.join(path.dirname(dbDir || ''), 'hinweise-outbox');
}

function safeName(name) {
  return String(name || 'datei')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 180);
}

function saveCreateLocal(db, dbDir, fields, files) {
  ensureHinweiseLocalSchema(db);
  const uuid = String(fields.client_uuid || '').trim() || crypto.randomUUID();
  const scope = String(fields.scope || 'fn').toLowerCase() === 'job' ? 'job' : 'fn';
  const fab = String(fields.fabrikationsnummer || '').trim();
  const jobId = parseInt(fields.job_id, 10) || null;
  const body = String(fields.body || '').trim();
  const tag = String(fields.tag || 'allgemein').trim() || 'allgemein';
  const deadline = String(fields.deadline || '').trim() || null;
  const dir = path.join(outboxRoot(dbDir), uuid);
  fs.mkdirSync(dir, { recursive: true });
  const storedFiles = [];
  (files || []).forEach((f, idx) => {
    const buf = f && f.buffer;
    if (!buf || !buf.length) return;
    const orig = safeName(f.filename || f.original_name || 'datei-' + (idx + 1));
    const abs = path.join(dir, orig);
    fs.writeFileSync(abs, buf);
    storedFiles.push({
      original_name: orig,
      abs_path: abs,
      mime: String(f.mimeType || f.mime || ''),
      size_bytes: buf.length,
    });
  });
  db.prepare(
    `INSERT INTO hinweise_local (
      client_uuid, scope, fabrikationsnummer, job_id, body, tag, deadline, status, source, pending_push
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'techniker', 1)`,
  ).run(uuid, scope, fab || null, jobId, body || null, tag, deadline);
  const insFile = db.prepare(
    `INSERT INTO hinweis_files_local (client_uuid, original_name, abs_path, mime, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  );
  storedFiles.forEach((sf) => {
    insFile.run(uuid, sf.original_name, sf.abs_path, sf.mime, sf.size_bytes);
  });
  return getLocalByUuid(db, uuid);
}

function fileRows(db, uuid) {
  return db
    .prepare(
      `SELECT id, original_name, abs_path, mime, size_bytes FROM hinweis_files_local WHERE client_uuid = ? ORDER BY id`,
    )
    .all(uuid);
}

function isOverdue(deadline) {
  const d = String(deadline || '').trim();
  if (!d) return false;
  const day = d.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const today = new Date();
  const ymd =
    today.getFullYear() +
    '-' +
    String(today.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(today.getDate()).padStart(2, '0');
  return day < ymd;
}

function toApiItem(db, row) {
  if (!row) return null;
  const files = fileRows(db, row.client_uuid).map((f) => ({
    id: f.id,
    original_name: f.original_name,
    mime: f.mime || '',
    is_image: Number(f.is_image) === 1,
    url: '/api/hinweise/file?local=1&file_id=' + encodeURIComponent(String(f.id)),
  }));
  const pending = Number(row.pending_push) === 1;
  return {
    hinweis_id: row.server_id || 0,
    client_uuid: row.client_uuid,
    scope: row.scope,
    fabrikationsnummer: row.fabrikationsnummer || '',
    job_id: row.job_id,
    body: row.body || '',
    tag: row.tag || 'allgemein',
    deadline: row.deadline || null,
    overdue: isOverdue(row.deadline),
    status: row.status || 'open',
    files,
    pending_push: pending,
    created_at: row.created_at,
  };
}

function getLocalByUuid(db, uuid) {
  const row = db.prepare(`SELECT * FROM hinweise_local WHERE client_uuid = ?`).get(uuid);
  return toApiItem(db, row);
}

function listLocalByFab(db, fab) {
  ensureHinweiseLocalSchema(db);
  const key = String(fab || '').trim();
  if (!key) return [];
  const rows = db
    .prepare(
      `SELECT * FROM hinweise_local
       WHERE scope = 'fn' AND TRIM(COALESCE(fabrikationsnummer, '')) = ?
       ORDER BY datetime(created_at) DESC`,
    )
    .all(key);
  return rows.map((r) => toApiItem(db, r));
}

function listLocalPendingOpen(db) {
  ensureHinweiseLocalSchema(db);
  return db
    .prepare(
      `SELECT * FROM hinweise_local WHERE pending_push = 1 AND status = 'open' ORDER BY datetime(created_at) ASC`,
    )
    .all();
}

function mergeRemoteWithLocal(db, remoteItems, fabFilter) {
  const remote = Array.isArray(remoteItems) ? remoteItems.slice() : [];
  const uuids = new Set(remote.map((it) => String(it && it.client_uuid ? it.client_uuid : '')).filter(Boolean));
  const ids = new Set(
    remote.map((it) => parseInt(it && (it.hinweis_id || it.id), 10)).filter((n) => Number.isFinite(n) && n > 0),
  );
  const local = fabFilter ? listLocalByFab(db, fabFilter) : listLocalPendingOpen(db).map((r) => toApiItem(db, r));
  local.forEach((it) => {
    if (!it) return;
    if (it.client_uuid && uuids.has(it.client_uuid)) return;
    if (it.hinweis_id && ids.has(it.hinweis_id)) return;
    remote.unshift(it);
  });
  return remote;
}

function markPushed(db, uuid, serverId) {
  db.prepare(
    `UPDATE hinweise_local SET pending_push = 0, server_id = ?, last_error = NULL WHERE client_uuid = ?`,
  ).run(serverId || null, uuid);
}

function markPushError(db, uuid, err) {
  db.prepare(`UPDATE hinweise_local SET last_error = ? WHERE client_uuid = ?`).run(
    String(err || '').slice(0, 400),
    uuid,
  );
}

function getLocalFile(db, fileId) {
  ensureHinweiseLocalSchema(db);
  return db.prepare(`SELECT * FROM hinweis_files_local WHERE id = ?`).get(fileId);
}

async function pushOneToDispo(row, files, dispoUrl, headers) {
  const fd = new FormData();
  fd.append('scope', row.scope || 'fn');
  fd.append('client_uuid', row.client_uuid);
  if (row.fabrikationsnummer) fd.append('fabrikationsnummer', row.fabrikationsnummer);
  if (row.job_id) fd.append('job_id', String(row.job_id));
  if (row.body) fd.append('body', row.body);
  if (row.tag) fd.append('tag', row.tag);
  if (row.deadline) fd.append('deadline', row.deadline);
  files.forEach((f) => {
    if (!f.abs_path || !fs.existsSync(f.abs_path)) return;
    fd.append('files[]', fs.readFileSync(f.abs_path), {
      filename: f.original_name || path.basename(f.abs_path),
      contentType: f.mime || 'application/octet-stream',
    });
  });
  const buf = fd.getBuffer();
  const r = await fetch(dispoUrl, {
    method: 'POST',
    headers: Object.assign({}, headers || {}, fd.getHeaders(), { 'Content-Length': String(buf.length) }),
    body: buf,
  });
  const text = await r.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!r.ok || !data || data.ok === false) {
    const err = new Error((data && data.error) || 'Hinweis-Push fehlgeschlagen.');
    err.status = r.status;
    throw err;
  }
  const h = data.hinweis || {};
  return parseInt(h.hinweis_id || h.id, 10) || 0;
}

async function flushPendingHinweise(db, opts) {
  opts = opts || {};
  ensureHinweiseLocalSchema(db);
  const pending = listLocalPendingOpen(db);
  if (!pending.length) return { ok: true, flushed: 0 };
  const dispoUrl = opts.dispoUrl;
  if (!dispoUrl) return { ok: false, error: 'Keine Dispo-Verbindung.', flushed: 0 };
  let flushed = 0;
  let lastError = null;
  for (const row of pending) {
    try {
      const files = fileRows(db, row.client_uuid);
      const serverId = await pushOneToDispo(row, files, dispoUrl, opts.headers);
      markPushed(db, row.client_uuid, serverId);
      flushed += 1;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      markPushError(db, row.client_uuid, lastError);
    }
  }
  if (typeof opts.save === 'function') opts.save();
  return { ok: !lastError || flushed > 0, flushed, error: lastError };
}

module.exports = {
  ensureHinweiseLocalSchema,
  saveCreateLocal,
  getLocalByUuid,
  listLocalByFab,
  mergeRemoteWithLocal,
  getLocalFile,
  flushPendingHinweise,
};
