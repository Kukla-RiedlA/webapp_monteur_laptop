'use strict';

const path = require('path');
const fs = require('fs');
const { buildDispoBaseCandidates, tryDispoBasesInOrder } = require('./dispo-base-fallback');

function authHeaderFromCredentials(username, password) {
  const u = (username || '').toString().trim();
  if (!u) return undefined;
  const p = (password || '').toString();
  return { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
}

function dispoMonteurFetchHeaders(technicianId, authHeader) {
  const h = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
  const a = authHeader && authHeader.Authorization;
  if (a) h['X-Kukla-Authorization'] = a;
  return h;
}

function ensureAnlagenstammLocalSchema(dbOrSql) {
  const run = (sql) => {
    if (dbOrSql && typeof dbOrSql.run === 'function' && !dbOrSql.prepare) {
      dbOrSql.run(sql);
    } else if (dbOrSql && dbOrSql.prepare) {
      dbOrSql.prepare(sql).run();
    }
  };
  run(`CREATE TABLE IF NOT EXISTS anlagenstamm_local (
      id INTEGER PRIMARY KEY,
      fabrikationsnummer TEXT NOT NULL,
      type TEXT,
      leistung TEXT,
      kraftaufnehmer TEXT,
      nenngeschwindigkeit TEXT,
      material TEXT,
      tacho TEXT,
      elektronik TEXT,
      dms_nr TEXT,
      position TEXT,
      aktueller_kunde TEXT,
      letzter_besuch TEXT,
      geliefert_ueber TEXT,
      projekt TEXT,
      bemerkungen TEXT,
      customer_country TEXT,
      synced_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 0
    )`);
  run('CREATE INDEX IF NOT EXISTS idx_anlagenstamm_local_fab ON anlagenstamm_local(fabrikationsnummer)');
  run('CREATE INDEX IF NOT EXISTS idx_anlagenstamm_local_type ON anlagenstamm_local(type)');
  run('CREATE INDEX IF NOT EXISTS idx_anlagenstamm_local_kunde ON anlagenstamm_local(aktueller_kunde)');
  run(`CREATE TABLE IF NOT EXISTS anlagenstamm_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_full_sync_at TEXT,
      last_page INTEGER,
      total_count INTEGER,
      sync_error TEXT
    )`);
}

function rowCount(db) {
  const r = db.prepare('SELECT COUNT(*) AS c FROM anlagenstamm_local').get();
  return r && r.c != null ? Number(r.c) : 0;
}

function upsertAnlagenstammRows(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO anlagenstamm_local (
      id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
      material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
      geliefert_ueber, projekt, bemerkungen, customer_country, synced_at, dirty
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
    )
    ON CONFLICT(id) DO UPDATE SET
      fabrikationsnummer = excluded.fabrikationsnummer,
      type = excluded.type,
      leistung = excluded.leistung,
      kraftaufnehmer = excluded.kraftaufnehmer,
      nenngeschwindigkeit = excluded.nenngeschwindigkeit,
      material = excluded.material,
      tacho = excluded.tacho,
      elektronik = excluded.elektronik,
      dms_nr = excluded.dms_nr,
      position = excluded.position,
      aktueller_kunde = excluded.aktueller_kunde,
      letzter_besuch = excluded.letzter_besuch,
      geliefert_ueber = excluded.geliefert_ueber,
      projekt = excluded.projekt,
      bemerkungen = excluded.bemerkungen,
      customer_country = excluded.customer_country,
      synced_at = excluded.synced_at,
      dirty = CASE WHEN anlagenstamm_local.dirty = 1 THEN 1 ELSE 0 END
  `);
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const row of rows) {
    const id = parseInt(row.id, 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    stmt.run(
      id,
      String(row.fabrikationsnummer ?? '').trim(),
      row.type != null ? String(row.type) : '',
      row.leistung != null ? String(row.leistung) : '',
      row.kraftaufnehmer != null ? String(row.kraftaufnehmer) : '',
      row.nenngeschwindigkeit != null ? String(row.nenngeschwindigkeit) : '',
      row.material != null ? String(row.material) : '',
      row.tacho != null ? String(row.tacho) : '',
      row.elektronik != null ? String(row.elektronik) : '',
      row.dms_nr != null ? String(row.dms_nr) : '',
      row.position != null ? String(row.position) : '',
      row.aktueller_kunde != null ? String(row.aktueller_kunde) : '',
      row.letzter_besuch != null ? String(row.letzter_besuch) : '',
      row.geliefert_ueber != null ? String(row.geliefert_ueber) : '',
      row.projekt != null ? String(row.projekt) : '',
      row.bemerkungen != null ? String(row.bemerkungen) : '',
      row.customer_country != null ? String(row.customer_country) : '',
      syncedAt,
    );
  }
}

function searchLocal(db, filters) {
  const filterFn = String(filters.filter_fn || '').trim();
  const filterType = String(filters.filter_type || '').trim();
  const filterKunde = String(filters.filter_aktueller_kunde || '').trim();
  const filterLand = String(filters.filter_land || '').trim();
  if (!filterFn && !filterType && !filterKunde && !filterLand) {
    return { ok: false, error: 'Mindestens ein Filter (FN, Type, letzter Kunde oder Land) ist erforderlich.' };
  }
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(filters.page_size, 10) || 50));
  const offset = (page - 1) * pageSize;
  const where = [];
  const params = [];
  if (filterFn) {
    where.push('fabrikationsnummer LIKE ?');
    params.push('%' + filterFn + '%');
  }
  if (filterType) {
    where.push('type LIKE ?');
    params.push('%' + filterType + '%');
  }
  if (filterKunde) {
    where.push('aktueller_kunde LIKE ?');
    params.push('%' + filterKunde + '%');
  }
  if (filterLand) {
    where.push('customer_country LIKE ?');
    params.push('%' + filterLand + '%');
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const totalCount = db.prepare('SELECT COUNT(*) AS c FROM anlagenstamm_local' + whereSql).get(...params).c;
  const rows = db
    .prepare(
      `SELECT id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
        material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
        geliefert_ueber, projekt, bemerkungen
       FROM anlagenstamm_local${whereSql}
       ORDER BY TRIM(fabrikationsnummer) ASC
       LIMIT ${pageSize} OFFSET ${offset}`,
    )
    .all(...params);
  const totalPages = pageSize > 0 ? Math.ceil(totalCount / pageSize) : 1;
  return {
    ok: true,
    rows,
    page,
    page_size: pageSize,
    total_count: totalCount,
    total_pages: totalPages,
    _source: 'local',
  };
}

function lookupByFab(db, fab) {
  const fabNorm = String(fab || '').trim();
  if (!fabNorm) return null;
  return (
    db
      .prepare(
        `SELECT id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
          material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
          geliefert_ueber, projekt, bemerkungen
         FROM anlagenstamm_local WHERE TRIM(fabrikationsnummer) = TRIM(?) LIMIT 1`,
      )
      .get(fabNorm) || null
  );
}

function getRowsByFabs(db, fabs) {
  const list = Array.isArray(fabs) ? fabs.map((f) => String(f).trim()).filter(Boolean) : [];
  if (!list.length) return [];
  const out = [];
  for (const fab of list) {
    const row = lookupByFab(db, fab);
    if (row) out.push(row);
  }
  return out;
}

function saveLocal(db, payload) {
  const fab = String(payload.fabrikationsnummer ?? '').trim();
  if (!fab) return { ok: false, error: 'Fabrikationsnummer fehlt' };
  let id = parseInt(payload.id, 10);
  const existing = lookupByFab(db, fab);
  if (!Number.isFinite(id) || id <= 0) {
    id = existing && existing.id ? existing.id : 0;
  }
  const fields = {
    type: payload.type != null ? String(payload.type) : '',
    leistung: payload.leistung != null ? String(payload.leistung) : '',
    kraftaufnehmer: payload.kraftaufnehmer != null ? String(payload.kraftaufnehmer) : '',
    nenngeschwindigkeit: payload.nenngeschwindigkeit != null ? String(payload.nenngeschwindigkeit) : '',
    material: payload.material != null ? String(payload.material) : '',
    tacho: payload.tacho != null ? String(payload.tacho) : '',
    elektronik: payload.elektronik != null ? String(payload.elektronik) : '',
    dms_nr: payload.dms_nr != null ? String(payload.dms_nr) : '',
    position: payload.position != null ? String(payload.position) : '',
    geliefert_ueber: payload.geliefert_ueber != null ? String(payload.geliefert_ueber) : '',
    projekt: payload.projekt != null ? String(payload.projekt) : '',
    bemerkungen: payload.bemerkungen != null ? String(payload.bemerkungen) : '',
  };
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (id > 0) {
    db.prepare(
      `UPDATE anlagenstamm_local SET
        fabrikationsnummer = ?, type = ?, leistung = ?, kraftaufnehmer = ?, nenngeschwindigkeit = ?,
        material = ?, tacho = ?, elektronik = ?, dms_nr = ?, position = ?,
        geliefert_ueber = ?, projekt = ?, bemerkungen = ?, dirty = 1, synced_at = ?
       WHERE id = ?`,
    ).run(
      fab,
      fields.type,
      fields.leistung,
      fields.kraftaufnehmer,
      fields.nenngeschwindigkeit,
      fields.material,
      fields.tacho,
      fields.elektronik,
      fields.dms_nr,
      fields.position,
      fields.geliefert_ueber,
      fields.projekt,
      fields.bemerkungen,
      syncedAt,
      id,
    );
  } else {
    const ins = db.prepare(
      `INSERT INTO anlagenstamm_local (
        fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
        material, tacho, elektronik, dms_nr, position, geliefert_ueber, projekt, bemerkungen, dirty, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const r = ins.run(
      fab,
      fields.type,
      fields.leistung,
      fields.kraftaufnehmer,
      fields.nenngeschwindigkeit,
      fields.material,
      fields.tacho,
      fields.elektronik,
      fields.dms_nr,
      fields.position,
      fields.geliefert_ueber,
      fields.projekt,
      fields.bemerkungen,
      syncedAt,
    );
    id = Number(r.lastInsertRowid);
  }
  return { ok: true, id, fabrikationsnummer: fab, fields, _pending: true };
}

async function fetchExportChunk(base, technicianId, authHeader, page, pageSize) {
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_export_chunk.php';
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      dispoMonteurFetchHeaders(technicianId, authHeader),
    ),
    body: JSON.stringify({ page, page_size: pageSize }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = (data && data.error) || r.statusText || 'HTTP ' + r.status;
    return { ok: false, error: err, _httpStatus: r.status };
  }
  return Object.assign({}, data, { ok: true, _used_base_url: base });
}

async function syncAnlagenstammFromDispo(db, payload, onProgress) {
  ensureAnlagenstammLocalSchema(db);
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const bases = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  if (!technicianId || !bases.length) {
    return { ok: false, error: 'baseUrl und technician_id erforderlich.' };
  }
  const auth = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const pageSize = 500;
  let page = 1;
  let totalPages = 1;
  let totalCount = 0;

  const runOnBase = async (base) => {
    page = 1;
    do {
      const data = await fetchExportChunk(base, technicianId, auth, page, pageSize);
      if (!data.ok) return data;
      totalPages = data.total_pages != null ? Number(data.total_pages) : 1;
      totalCount = data.total_count != null ? Number(data.total_count) : 0;
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (rows.length) upsertAnlagenstammRows(db, rows);
      if (onProgress) onProgress({ page, totalPages, totalCount });
      db.prepare(
        `INSERT INTO anlagenstamm_sync_state (id, last_full_sync_at, last_page, total_count, sync_error)
         VALUES (1, datetime('now'), ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET last_page = excluded.last_page, total_count = excluded.total_count, sync_error = NULL`,
      ).run(page, totalCount);
      page += 1;
    } while (page <= totalPages);
    db.prepare(
      `INSERT INTO anlagenstamm_sync_state (id, last_full_sync_at, last_page, total_count, sync_error)
       VALUES (1, datetime('now'), ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET last_full_sync_at = datetime('now'), last_page = excluded.last_page, total_count = excluded.total_count`,
    ).run(totalPages, totalCount);
    return { ok: true, total_count: totalCount, row_count: rowCount(db) };
  };

  try {
    return await tryDispoBasesInOrder(bases, runOnBase);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    try {
      db.prepare(
        `INSERT INTO anlagenstamm_sync_state (id, sync_error) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET sync_error = excluded.sync_error`,
      ).run(msg);
    } catch (_) {}
    return { ok: false, error: msg };
  }
}

function fabDirForCache(fab) {
  return String(fab || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function uploadCachePath(dbDir, fab, fileName) {
  return path.join(dbDir, 'anlagenstamm_upload_cache', fabDirForCache(fab), String(fileName || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_'));
}

module.exports = {
  ensureAnlagenstammLocalSchema,
  rowCount,
  upsertAnlagenstammRows,
  searchLocal,
  lookupByFab,
  getRowsByFabs,
  saveLocal,
  syncAnlagenstammFromDispo,
  authHeaderFromCredentials,
  dispoMonteurFetchHeaders,
  fabDirForCache,
  uploadCachePath,
};
