'use strict';

/**
 * Lokaler Cache der Techniker-Profil-Unterschrift + Dispo-Sync.
 */

function tryExec(db, sql) {
  try {
    db.exec(sql);
  } catch (_) {
    /* idempotent */
  }
}

function ensureSchema(db) {
  if (!db) return;
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS technician_signature (
      technician_id INTEGER PRIMARY KEY,
      png_base64 TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'draw',
      updated_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 0
    )`,
  );
}

function stripDataUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^data:image\/(png|jpe?g);base64,/i, '');
  return s.replace(/\s+/g, '');
}

function normalizePngBase64(raw) {
  const s = stripDataUrl(raw);
  if (!s || s.length > 2_500_000) return '';
  try {
    const bin = Buffer.from(s, 'base64');
    if (!bin || bin.length < 32) return '';
    const isPng = bin.length >= 8 && bin[0] === 0x89 && bin[1] === 0x50 && bin[2] === 0x4e && bin[3] === 0x47;
    const isJpg = bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff;
    if (!isPng && !isJpg) return '';
    return s;
  } catch (_) {
    return '';
  }
}

function getLocal(db, technicianId) {
  ensureSchema(db);
  const tid = parseInt(technicianId, 10);
  if (!Number.isFinite(tid) || tid <= 0) return null;
  try {
    const row = db
      .prepare(
        'SELECT technician_id, png_base64, source, updated_at, dirty FROM technician_signature WHERE technician_id = ?',
      )
      .get(tid);
    if (!row || !row.png_base64) return null;
    return row;
  } catch (_) {
    return null;
  }
}

function setLocal(db, technicianId, pngBase64, source, updatedAt, dirty) {
  ensureSchema(db);
  const tid = parseInt(technicianId, 10);
  const png = normalizePngBase64(pngBase64);
  if (!Number.isFinite(tid) || tid <= 0 || !png) {
    throw new Error('Ungültige Unterschrift.');
  }
  const src = source === 'upload' ? 'upload' : 'draw';
  const at = updatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const dirtyFlag = dirty ? 1 : 0;
  db.prepare(
    `INSERT INTO technician_signature (technician_id, png_base64, source, updated_at, dirty)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(technician_id) DO UPDATE SET
       png_base64 = excluded.png_base64,
       source = excluded.source,
       updated_at = excluded.updated_at,
       dirty = excluded.dirty`,
  ).run(tid, png, src, at, dirtyFlag);
  return getLocal(db, tid);
}

function deleteLocal(db, technicianId) {
  ensureSchema(db);
  const tid = parseInt(technicianId, 10);
  if (!Number.isFinite(tid) || tid <= 0) return;
  try {
    db.prepare('DELETE FROM technician_signature WHERE technician_id = ?').run(tid);
  } catch (_) {}
}

function parseUpdatedAt(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Dispo-URL + Basic-Auth Headers bauen.
 */
function buildDispoRequest(dispoBaseUrl, authHeader) {
  const base = String(dispoBaseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return null;
  const url = base + '/api/mobile/technician_signature.php';
  const headers = Object.assign(
    { Accept: 'application/json', 'Content-Type': 'application/json' },
    authHeader || {},
  );
  if (authHeader && authHeader.Authorization) {
    headers['X-Kukla-Authorization'] = authHeader.Authorization;
  }
  return { url, headers };
}

async function fetchDispoSignature(dispoBaseUrl, authHeader) {
  const req = buildDispoRequest(dispoBaseUrl, authHeader);
  if (!req) return null;
  const r = await fetch(req.url, { method: 'GET', headers: req.headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (data && data.error) || 'HTTP ' + r.status };
  return data;
}

async function pushDispoSignature(dispoBaseUrl, authHeader, pngBase64, source) {
  const req = buildDispoRequest(dispoBaseUrl, authHeader);
  if (!req) return { ok: false, error: 'Keine Dispo-URL.' };
  const r = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ png_base64: pngBase64, source: source || 'draw' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (data && data.error) || 'HTTP ' + r.status };
  return data;
}

async function deleteDispoSignature(dispoBaseUrl, authHeader) {
  const req = buildDispoRequest(dispoBaseUrl, authHeader);
  if (!req) return { ok: false, error: 'Keine Dispo-URL.' };
  const r = await fetch(req.url, { method: 'DELETE', headers: req.headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (data && data.error) || 'HTTP ' + r.status };
  return data;
}

/**
 * Neueres updated_at gewinnt. Dirty-lokale Änderungen pushen zuerst.
 */
async function syncWithDispo(db, technicianId, dispoBaseUrl, authHeader) {
  ensureSchema(db);
  const tid = parseInt(technicianId, 10);
  if (!Number.isFinite(tid) || tid <= 0 || !dispoBaseUrl || !authHeader) {
    return { ok: true, skipped: true, local: getLocal(db, tid) };
  }
  const local = getLocal(db, tid);
  if (local && local.dirty) {
    const pushed = await pushDispoSignature(dispoBaseUrl, authHeader, local.png_base64, local.source);
    if (pushed && pushed.ok) {
      setLocal(db, tid, local.png_base64, local.source, pushed.updated_at || local.updated_at, false);
    }
  }
  const remote = await fetchDispoSignature(dispoBaseUrl, authHeader);
  if (!remote || remote.ok === false) {
    return { ok: false, error: (remote && remote.error) || 'Sync fehlgeschlagen', local: getLocal(db, tid) };
  }
  if (remote.has_signature && remote.png_base64) {
    const cur = getLocal(db, tid);
    const remoteNewer = !cur || parseUpdatedAt(remote.updated_at) >= parseUpdatedAt(cur.updated_at);
    if (remoteNewer || !(cur && cur.dirty)) {
      setLocal(db, tid, remote.png_base64, remote.source || 'draw', remote.updated_at, false);
    }
  } else if (!local || !local.dirty) {
    // Remote gelöscht und lokal nicht dirty → lokal löschen
    if (local && !local.dirty) deleteLocal(db, tid);
  }
  return { ok: true, local: getLocal(db, tid), remote };
}

module.exports = {
  ensureSchema,
  normalizePngBase64,
  getLocal,
  setLocal,
  deleteLocal,
  fetchDispoSignature,
  pushDispoSignature,
  deleteDispoSignature,
  syncWithDispo,
  parseUpdatedAt,
};
