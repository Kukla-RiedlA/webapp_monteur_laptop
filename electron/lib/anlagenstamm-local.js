'use strict';

const path = require('path');
const fs = require('fs');
const {
  buildDispoBaseCandidates,
  tryDispoBasesInOrder,
  normalizeDispoBase,
  isFetchNetworkError,
} = require('./dispo-base-fallback');

const DISPO_EXPORT_CHUNK_TIMEOUT_MS = 90 * 1000;

/** Bekannte Dispo-Basis zuerst (nach resolveDispoWorkingBase), dann Fallback-Kandidaten. */
function buildAnlagenstammSyncBases(payload) {
  const resolved = normalizeDispoBase(payload && payload.baseUrl);
  const rest = buildDispoBaseCandidates({
    baseUrl: payload && payload.baseUrl,
    externalUrl: payload && payload.externalUrl,
    internalUrl: payload && payload.internalUrl,
  });
  if (!resolved) return rest;
  const out = [resolved];
  for (const u of rest) {
    if (u !== resolved) out.push(u);
  }
  return out;
}

function isRetryableExportChunkFailure(data, err) {
  if (err) return isFetchNetworkError(err);
  if (!data || data.ok !== false) return false;
  const status = Number(data._httpStatus) || 0;
  if (status === 401 || status === 403) return false;
  if (status >= 500 || status === 408 || status === 429 || status === 0) return true;
  const msg = String(data.error || '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('certificate') ||
    msg.includes('tls')
  );
}
const { compareParameterEntryLists } = require('./anlagenstamm-parameter-trend');

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
  run(`CREATE TABLE IF NOT EXISTS anlagenstamm_parameter_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fab TEXT NOT NULL,
      source TEXT NOT NULL,
      source_file_status TEXT NOT NULL DEFAULT 'present',
      technician_id INTEGER,
      technician_name TEXT,
      uploaded_at TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      storage_relpath TEXT,
      source_path TEXT,
      filename_fn TEXT,
      content_fn TEXT,
      used_fn TEXT,
      server_file_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_as_param_files_unique ON anlagenstamm_parameter_files(fab, source, sha256)',
  );
  run(
    'CREATE INDEX IF NOT EXISTS idx_as_param_files_fab_uploaded ON anlagenstamm_parameter_files(fab, uploaded_at DESC)',
  );
  run(
    'CREATE INDEX IF NOT EXISTS idx_as_param_files_source_path ON anlagenstamm_parameter_files(source, source_path)',
  );
  run(`CREATE TABLE IF NOT EXISTS anlagenstamm_parameter_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      line_no INTEGER,
      param_key TEXT NOT NULL,
      param_value TEXT,
      unit TEXT,
      raw_line TEXT,
      FOREIGN KEY(file_id) REFERENCES anlagenstamm_parameter_files(id) ON DELETE CASCADE
    )`);
  run(
    'CREATE INDEX IF NOT EXISTS idx_as_param_entries_file ON anlagenstamm_parameter_entries(file_id)',
  );
  if (dbOrSql && typeof dbOrSql.prepare === 'function') {
    try {
      const cols = dbOrSql.prepare('PRAGMA table_info(anlagenstamm_parameter_files)').all();
      const hasServerId = cols.some((c) => c && c.name === 'server_file_id');
      if (!hasServerId) {
        run('ALTER TABLE anlagenstamm_parameter_files ADD COLUMN server_file_id INTEGER');
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      if (!/duplicate column name/i.test(msg)) {
        console.warn('[anlagenstamm-local] server_file_id migration:', msg);
      }
    }
  }
}

function rowCount(db) {
  const r = db.prepare('SELECT COUNT(*) AS c FROM anlagenstamm_local').get();
  return r && r.c != null ? Number(r.c) : 0;
}

/** Liste für GET /api/anlagenstamm/list (wie Dispo Desktop, aus lokalem Cache). */
function listAnlagenstammForApi(db, limit, offset) {
  ensureAnlagenstammLocalSchema(db);
  const rows = db
    .prepare(
      `SELECT id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
              material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
              geliefert_ueber, projekt, bemerkungen, customer_country
       FROM anlagenstamm_local
       ORDER BY TRIM(fabrikationsnummer) ASC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
  return rows.map((r) => ({
    id: r.id,
    fabrikationsnummer: r.fabrikationsnummer,
    type: r.type || '',
    leistung: r.leistung || '',
    kraftaufnehmer: r.kraftaufnehmer || '',
    nenngeschwindigkeit: r.nenngeschwindigkeit || '',
    material: r.material || '',
    tacho: r.tacho || '',
    elektronik: r.elektronik || '',
    dms_nr: r.dms_nr || '',
    position: r.position || '',
    aktueller_kunde: r.aktueller_kunde || '',
    letzter_besuch: r.letzter_besuch || '',
    geliefert_ueber: r.geliefert_ueber || '',
    projekt: r.projekt || '',
    bemerkungen: r.bemerkungen || '',
    customer_country: r.customer_country || '',
  }));
}

/** Dispo `anlagenstamm` – Spaltenlängen (fsm_init.sql). */
const DISPO_ANLAGENSTAMM_MAX = {
  fabrikationsnummer: 50,
  type: 100,
  leistung: 100,
  kraftaufnehmer: 100,
  nenngeschwindigkeit: 100,
  material: 100,
  tacho: 100,
  elektronik: 100,
  dms_nr: 100,
  position: 100,
  aktueller_kunde: 255,
  geliefert_ueber: 255,
  projekt: 255,
};

/** Dispo `job_fabrikation` – teils kürzer als Anlagenstamm (z. B. leistung 50). */
const DISPO_JOB_FABRIKATION_MAX = {
  fabrikationsnummer: 50,
  type: 100,
  baujahr: 20,
  leistung: 50,
  nenngeschwindigkeit: 100,
  kraftaufnehmer: 100,
  tacho: 100,
  dms_nr: 100,
  elektronik: 100,
  material: 100,
  position: 100,
};

function clampDispoField(value, maxLen) {
  if (value == null) return '';
  let s = String(value);
  if (maxLen > 0 && s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function clampRowToDispoLimits(row, limits) {
  if (!row || typeof row !== 'object') return row;
  const out = Object.assign({}, row);
  for (const key of Object.keys(limits)) {
    if (out[key] != null) out[key] = clampDispoField(out[key], limits[key]);
  }
  return out;
}

function clampForDispoAnlagenstamm(rowOrPayload) {
  return clampRowToDispoLimits(rowOrPayload, DISPO_ANLAGENSTAMM_MAX);
}

/** Leere/null/Whitespace – nie bestehende Stammwerte überschreiben (Sync + saveLocal). */
function stammFieldTrim(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s;
}

/** Abgleich mit JOB_FAB_STAMM_KEYS in server.js + Formularfelder. */
const ANLAGENSTAMM_MERGE_KEYS = [
  'type',
  'leistung',
  'nenngeschwindigkeit',
  'kraftaufnehmer',
  'dms_nr',
  'tacho',
  'elektronik',
  'material',
  'position',
  'geliefert_ueber',
  'projekt',
  'bemerkungen',
  'aktueller_kunde',
  'letzter_besuch',
];

/**
 * incoming: nur nicht-leere Felder ersetzen existing; leere incoming-Werte behalten existing.
 */
function mergeAnlagenstammPayload(existing, incoming) {
  const ex = existing && typeof existing === 'object' ? existing : {};
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const out = {};
  const fab = stammFieldTrim(inc.fabrikationsnummer) || stammFieldTrim(ex.fabrikationsnummer);
  if (fab) out.fabrikationsnummer = fab;
  const incId = parseInt(inc.id, 10);
  const exId = parseInt(ex.id, 10);
  if (Number.isFinite(incId) && incId > 0) out.id = incId;
  else if (Number.isFinite(exId) && exId > 0) out.id = exId;
  for (const k of ANLAGENSTAMM_MERGE_KEYS) {
    const incVal = stammFieldTrim(inc[k]);
    const exVal = stammFieldTrim(ex[k]);
    if (incVal !== '') out[k] = incVal;
    else if (exVal !== '') out[k] = exVal;
    else out[k] = '';
  }
  return out;
}

function hasNonemptyStammField(merged) {
  if (!merged || typeof merged !== 'object') return false;
  for (const k of ANLAGENSTAMM_MERGE_KEYS) {
    if (stammFieldTrim(merged[k]) !== '') return true;
  }
  return false;
}

/** HTTP an Dispo: nur Felder mit effektiv gesetztem Wert (nach Merge), nie leere Keys senden. */
function stripEmptyStammFieldsForDispoPush(payload, existing) {
  const merged = mergeAnlagenstammPayload(existing, payload);
  const out = {};
  if (merged.fabrikationsnummer) out.fabrikationsnummer = merged.fabrikationsnummer;
  if (merged.id != null && Number(merged.id) > 0) out.id = merged.id;
  for (const k of ANLAGENSTAMM_MERGE_KEYS) {
    const v = stammFieldTrim(merged[k]);
    if (v !== '') out[k] = v;
  }
  return clampForDispoAnlagenstamm(out);
}

function clampForDispoJobFabrikation(row) {
  return clampRowToDispoLimits(row, DISPO_JOB_FABRIKATION_MAX);
}

function clampFabrikationsnummernJson(jsonStr) {
  if (jsonStr == null || jsonStr === '') return jsonStr;
  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return jsonStr;
    return JSON.stringify(arr.map((r) => clampForDispoJobFabrikation(r)));
  } catch (_) {
    return jsonStr;
  }
}

const UPSERT_ANLAGENSTAMM_SQL = `
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
  `;

/** Leere dirty-Stubs (nur FN aus jobs.fabrikationsnummern) blockieren Server-Upserts — entfernen. */
function clearEmptyDirtyAnlagenstammStubs(db) {
  const rows = db
    .prepare(
      `SELECT id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
              material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
              geliefert_ueber, projekt, bemerkungen, customer_country
       FROM anlagenstamm_local WHERE dirty = 1`,
    )
    .all();
  const del = db.prepare('DELETE FROM anlagenstamm_local WHERE id = ?');
  let removed = 0;
  for (const r of rows) {
    if (!hasNonemptyStammField(r)) {
      del.run(r.id);
      removed++;
    }
  }
  return removed;
}

function upsertAnlagenstammRows(db, rows) {
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const getByIdStmt = db.prepare('SELECT * FROM anlagenstamm_local WHERE id = ?');
  const delStubStmt = db.prepare('DELETE FROM anlagenstamm_local WHERE id = ?');
  const upsertStmt = db.prepare(UPSERT_ANLAGENSTAMM_SQL);

  function removeEmptyDirtyStub(existing) {
    if (!existing || Number(existing.dirty) !== 1 || hasNonemptyStammField(existing)) return false;
    delStubStmt.run(existing.id);
    return true;
  }

  for (const raw of rows) {
    const row = clampForDispoAnlagenstamm(raw);
    const id = parseInt(row.id, 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    const fab = clampDispoField(row.fabrikationsnummer, DISPO_ANLAGENSTAMM_MAX.fabrikationsnummer).trim();
    const byId = getByIdStmt.get(id);
    if (byId && Number(byId.dirty) === 1 && hasNonemptyStammField(byId)) continue;
    if (fab) {
      const byFab = lookupByFab(db, fab);
      if (byFab && Number(byFab.dirty) === 1 && hasNonemptyStammField(byFab)) continue;
      if (byFab && byFab.id !== id) removeEmptyDirtyStub(byFab);
    }
    removeEmptyDirtyStub(byId);
    upsertStmt.run(
      id,
      fab,
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

/** FN-Varianten für Lookup (exakt, nur Ziffern, führende Nullen). */
function fabLookupKeys(fab) {
  const keys = [];
  const s = String(fab || '').trim();
  if (s) keys.push(s);
  const digits = s.replace(/\D/g, '');
  if (digits) {
    if (keys.indexOf(digits) === -1) keys.push(digits);
    const n = String(parseInt(digits, 10));
    if (Number.isFinite(parseInt(digits, 10)) && keys.indexOf(n) === -1) keys.push(n);
  }
  return keys;
}

function lookupByFab(db, fab) {
  const sql = `SELECT id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
          material, tacho, elektronik, dms_nr, position, aktueller_kunde, letzter_besuch,
          geliefert_ueber, projekt, bemerkungen, dirty
         FROM anlagenstamm_local
         WHERE TRIM(fabrikationsnummer) = TRIM(?)
         ORDER BY dirty DESC, synced_at DESC, id DESC
         LIMIT 1`;
  for (const k of fabLookupKeys(fab)) {
    const row = db.prepare(sql).get(k);
    if (row) return row;
  }
  return null;
}

/** Doppelte Zeilen pro FN (lokale vs. Server-id) bereinigen – behält dirty, sonst neueste. */
function dedupeAnlagenstammLocalByFab(db, fab) {
  const fabNorm = String(fab || '').trim();
  if (!fabNorm) return null;
  const rows = db
    .prepare(
      `SELECT id FROM anlagenstamm_local
       WHERE TRIM(fabrikationsnummer) = TRIM(?)
       ORDER BY dirty DESC, synced_at DESC, id DESC`,
    )
    .all(fabNorm);
  if (!rows.length) return null;
  const keepId = rows[0].id;
  for (let i = 1; i < rows.length; i++) {
    db.prepare('DELETE FROM anlagenstamm_local WHERE id = ?').run(rows[i].id);
  }
  return keepId;
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
  const normalized = clampForDispoAnlagenstamm(payload || {});
  const fab = String(normalized.fabrikationsnummer ?? '').trim();
  if (!fab) return { ok: false, error: 'Fabrikationsnummer fehlt' };
  let id = parseInt(normalized.id, 10);
  const existing = lookupByFab(db, fab);
  const merged = mergeAnlagenstammPayload(existing || {}, normalized);
  if (existing && existing.id) {
    id = existing.id;
  } else if (merged.id != null && Number(merged.id) > 0) {
    id = merged.id;
  } else if (!Number.isFinite(id) || id <= 0) {
    id = 0;
  }
  const fields = {
    type: merged.type != null ? String(merged.type) : '',
    leistung: merged.leistung != null ? String(merged.leistung) : '',
    kraftaufnehmer: merged.kraftaufnehmer != null ? String(merged.kraftaufnehmer) : '',
    nenngeschwindigkeit: merged.nenngeschwindigkeit != null ? String(merged.nenngeschwindigkeit) : '',
    material: merged.material != null ? String(merged.material) : '',
    tacho: merged.tacho != null ? String(merged.tacho) : '',
    elektronik: merged.elektronik != null ? String(merged.elektronik) : '',
    dms_nr: merged.dms_nr != null ? String(merged.dms_nr) : '',
    position: merged.position != null ? String(merged.position) : '',
    geliefert_ueber: merged.geliefert_ueber != null ? String(merged.geliefert_ueber) : '',
    projekt: merged.projekt != null ? String(merged.projekt) : '',
    bemerkungen: merged.bemerkungen != null ? String(merged.bemerkungen) : '',
  };
  const syncedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fieldArgs = [
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
  ];
  if (existing && existing.id) {
    db.prepare(
      `UPDATE anlagenstamm_local SET
        fabrikationsnummer = ?, type = ?, leistung = ?, kraftaufnehmer = ?, nenngeschwindigkeit = ?,
        material = ?, tacho = ?, elektronik = ?, dms_nr = ?, position = ?,
        geliefert_ueber = ?, projekt = ?, bemerkungen = ?, dirty = 1, synced_at = ?
       WHERE id = ?`,
    ).run(...fieldArgs, existing.id);
    id = existing.id;
  } else if (id > 0) {
    db.prepare(
      `INSERT INTO anlagenstamm_local (
        id, fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
        material, tacho, elektronik, dms_nr, position, geliefert_ueber, projekt, bemerkungen, dirty, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, ...fieldArgs);
  } else {
    const ins = db.prepare(
      `INSERT INTO anlagenstamm_local (
        fabrikationsnummer, type, leistung, kraftaufnehmer, nenngeschwindigkeit,
        material, tacho, elektronik, dms_nr, position, geliefert_ueber, projekt, bemerkungen, dirty, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const r = ins.run(...fieldArgs);
    id = Number(r.lastInsertRowid);
  }
  dedupeAnlagenstammLocalByFab(db, fab);
  const kept = lookupByFab(db, fab);
  if (kept && kept.id) id = kept.id;
  return { ok: true, id, fabrikationsnummer: fab, fields, _pending: true };
}

/** Vollsync wie Dispo Desktop: GET /api/anlagenstamm_list.php?omit_fn_filter=1 */
async function fetchAnlagenstammListPage(base, authHeader, page, pageSize) {
  const url = `${base}/api/anlagenstamm_list.php?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(pageSize)}&omit_fn_filter=1`;
  const headers = {};
  if (authHeader && authHeader.Authorization) {
    headers.Authorization = authHeader.Authorization;
    headers['X-Kukla-Authorization'] = authHeader.Authorization;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISPO_EXPORT_CHUNK_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', headers, signal: ac.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) {
      const err = (data && data.error) || r.statusText || 'HTTP ' + r.status;
      return { ok: false, error: err, _httpStatus: r.status };
    }
    return {
      ok: true,
      rows: Array.isArray(data.data) ? data.data : [],
      total_count: data.total_count != null ? Number(data.total_count) : 0,
      total_pages: data.total_pages != null ? Number(data.total_pages) : 1,
      _used_base_url: base,
    };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return {
        ok: false,
        error: 'Timeout nach ' + Math.round(DISPO_EXPORT_CHUNK_TIMEOUT_MS / 1000) + ' s (Anlagenstamm-Liste)',
        _httpStatus: 0,
      };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExportChunk(base, technicianId, authHeader, page, pageSize) {
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_export_chunk.php';
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISPO_EXPORT_CHUNK_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        dispoMonteurFetchHeaders(technicianId, authHeader),
      ),
      body: JSON.stringify({ page, page_size: pageSize }),
      signal: ac.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (data && data.error) || r.statusText || 'HTTP ' + r.status;
      return { ok: false, error: err, _httpStatus: r.status };
    }
    return Object.assign({}, data, { ok: true, _used_base_url: base });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return {
        ok: false,
        error: 'Timeout nach ' + Math.round(DISPO_EXPORT_CHUNK_TIMEOUT_MS / 1000) + ' s (Anlagenstamm-Export)',
        _httpStatus: 0,
      };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function syncAnlagenstammFromDispo(db, payload, onProgress, options) {
  options = options || {};
  const dbLock = options.dbLock;
  const saveFn = options.save;

  function withDbLock(fn) {
    if (dbLock && typeof dbLock.runWithDbLock === 'function') {
      return dbLock.runWithDbLock(fn);
    }
    return Promise.resolve(fn());
  }

  ensureAnlagenstammLocalSchema(db);
  await withDbLock(async () => {
    const removed = clearEmptyDirtyAnlagenstammStubs(db);
    if (removed > 0 && typeof saveFn === 'function') saveFn();
  });
  const bases = buildAnlagenstammSyncBases(payload);
  const username = (payload.serverUsername || '').toString().trim();
  if (!bases.length || !username) {
    return { ok: false, error: 'baseUrl und Anmeldedaten erforderlich.' };
  }
  const auth = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const pageSize = 500;
  let page = 1;
  let totalPages = 1;
  let totalCount = 0;

  const runOnBase = async (base) => {
    page = 1;
    do {
      let data;
      try {
        data = await fetchAnlagenstammListPage(base, auth, page, pageSize);
      } catch (err) {
        if (isRetryableExportChunkFailure(null, err)) throw err;
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
      if (!data.ok) {
        if (isRetryableExportChunkFailure(data)) {
          throw Object.assign(new Error(data.error || 'Anlagenstamm-Export fehlgeschlagen'), {
            _httpStatus: data._httpStatus,
          });
        }
        return data;
      }
      totalPages = data.total_pages != null ? Number(data.total_pages) : 1;
      totalCount = data.total_count != null ? Number(data.total_count) : 0;
      const rows = Array.isArray(data.rows) ? data.rows : [];
      await withDbLock(async () => {
        if (rows.length) upsertAnlagenstammRows(db, rows);
        db.prepare(
          `INSERT INTO anlagenstamm_sync_state (id, last_full_sync_at, last_page, total_count, sync_error)
           VALUES (1, datetime('now'), ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET last_page = excluded.last_page, total_count = excluded.total_count, sync_error = NULL`,
        ).run(page, totalCount);
        if (typeof saveFn === 'function') saveFn();
      });
      if (onProgress) onProgress({ page, totalPages, totalCount });
      page += 1;
    } while (page <= totalPages);
    await withDbLock(async () => {
      db.prepare(
        `INSERT INTO anlagenstamm_sync_state (id, last_full_sync_at, last_page, total_count, sync_error)
         VALUES (1, datetime('now'), ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET last_full_sync_at = datetime('now'), last_page = excluded.last_page, total_count = excluded.total_count`,
      ).run(totalPages, totalCount);
      if (typeof saveFn === 'function') saveFn();
    });
    return { ok: true, total_count: totalCount, row_count: rowCount(db) };
  };

  try {
    const tried = await tryDispoBasesInOrder(bases, runOnBase);
    if (tried.error) {
      return { ok: false, error: tried.error };
    }
    const inner = tried.result;
    if (inner && inner.ok === false) {
      return { ok: false, error: inner.error || 'Export fehlgeschlagen.' };
    }
    return Object.assign({ ok: true }, inner || {});
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    try {
      await withDbLock(async () => {
        db.prepare(
          `INSERT INTO anlagenstamm_sync_state (id, sync_error) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET sync_error = excluded.sync_error`,
        ).run(msg);
        if (typeof saveFn === 'function') saveFn();
      });
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

function normalizeFabDigits(fab) {
  const s = String(fab || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function sanitizeSource(source) {
  return String(source || '').toLowerCase().trim() === 'projekte_neu' ? 'projekte_neu' : 'upload';
}

function upsertParameterFile(db, payload) {
  ensureAnlagenstammLocalSchema(db);
  const fab = normalizeFabDigits(payload && payload.fab);
  if (!fab) return { ok: false, error: 'fab fehlt' };
  const source = sanitizeSource(payload && payload.source);
  const sha256 = String((payload && payload.sha256) || '').trim();
  if (!sha256) return { ok: false, error: 'sha256 fehlt' };
  const uploadedAt = String((payload && payload.uploaded_at) || '').trim() || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const originalFilename = String((payload && payload.original_filename) || '').trim();
  if (!originalFilename) return { ok: false, error: 'original_filename fehlt' };
  const sourceFileStatus = String((payload && payload.source_file_status) || '').trim() === 'original_deleted'
    ? 'original_deleted'
    : 'present';
  const ins = db.prepare(`INSERT INTO anlagenstamm_parameter_files
    (fab, source, source_file_status, technician_id, technician_name, uploaded_at, original_filename, mime, size, sha256, storage_relpath, source_path, filename_fn, content_fn, used_fn, server_file_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(fab, source, sha256) DO UPDATE SET
      source_file_status = excluded.source_file_status,
      technician_id = excluded.technician_id,
      technician_name = excluded.technician_name,
      uploaded_at = excluded.uploaded_at,
      original_filename = excluded.original_filename,
      mime = excluded.mime,
      size = excluded.size,
      storage_relpath = excluded.storage_relpath,
      source_path = excluded.source_path,
      filename_fn = excluded.filename_fn,
      content_fn = excluded.content_fn,
      used_fn = excluded.used_fn,
      server_file_id = COALESCE(excluded.server_file_id, server_file_id),
      updated_at = datetime('now')
  `);
  try {
    ins.run(
      fab,
      source,
      sourceFileStatus,
      payload && payload.technician_id != null ? Number(payload.technician_id) : null,
      payload && payload.technician_name != null ? String(payload.technician_name) : null,
      uploadedAt,
      originalFilename,
      payload && payload.mime != null ? String(payload.mime) : null,
      Math.max(0, Number((payload && payload.size) || 0) || 0),
      sha256,
      payload && payload.storage_relpath != null ? String(payload.storage_relpath) : null,
      payload && payload.source_path != null ? String(payload.source_path) : null,
      payload && payload.filename_fn != null ? String(payload.filename_fn) : null,
      payload && payload.content_fn != null ? String(payload.content_fn) : null,
      payload && payload.used_fn != null ? String(payload.used_fn) : null,
      payload && payload.server_file_id != null ? Number(payload.server_file_id) : null,
    );
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, error: msg };
  }
  const row = db
    .prepare('SELECT id FROM anlagenstamm_parameter_files WHERE fab = ? AND source = ? AND sha256 = ? LIMIT 1')
    .get(fab, source, sha256);
  const fileId = row && row.id ? Number(row.id) : 0;
  if (!fileId) return { ok: false, error: 'file_id konnte nicht ermittelt werden' };
  const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
  db.prepare('DELETE FROM anlagenstamm_parameter_entries WHERE file_id = ?').run(fileId);
  const insEntrySql =
    'INSERT INTO anlagenstamm_parameter_entries (file_id, line_no, param_key, param_value, unit, raw_line) VALUES (?, ?, ?, ?, ?, ?)';
  for (const ent of entries) {
    const key = String((ent && ent.param_key) || '').trim();
    if (!key) continue;
    db.prepare(insEntrySql).run(
      fileId,
      ent && ent.line_no != null ? Number(ent.line_no) : null,
      key,
      ent && ent.param_value != null ? String(ent.param_value) : null,
      ent && ent.unit != null ? String(ent.unit) : null,
      ent && ent.raw_line != null ? String(ent.raw_line) : null,
    );
  }
  return { ok: true, file_id: fileId, fab, source };
}

/** Metadaten aus Dispo-Listenantwort in lokalen Cache spiegeln (ohne Einzelwerte). */
function cacheParameterFilesFromDispo(db, fab, files) {
  const fabNorm = normalizeFabDigits(fab);
  if (!fabNorm || !Array.isArray(files)) return;
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const sha = String(f.sha256 || '').trim();
    if (!sha) continue;
    upsertParameterFile(db, {
      fab: fabNorm,
      source: f.source,
      source_file_status: f.source_file_status || 'present',
      technician_id: f.technician_id,
      technician_name: f.technician_name,
      uploaded_at: f.uploaded_at,
      original_filename: f.original_filename,
      mime: f.mime,
      size: f.size,
      sha256: sha,
      storage_relpath: f.source_path || f.storage_rel_path || null,
      source_path: f.source_path || null,
      server_file_id: f.id != null ? Number(f.id) : null,
      entries: [],
    });
  }
}

function markMissingProjekteNeuFiles(db, fab, presentSourcePaths) {
  const fabNorm = normalizeFabDigits(fab);
  if (!fabNorm) return 0;
  const present = new Set(
    (Array.isArray(presentSourcePaths) ? presentSourcePaths : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean),
  );
  const rows = db
    .prepare(
      `SELECT id, source_path
       FROM anlagenstamm_parameter_files
       WHERE fab = ? AND source = 'projekte_neu'`,
    )
    .all(fabNorm);
  let changed = 0;
  for (const row of rows) {
    const src = String(row.source_path || '').trim();
    const status = src && present.has(src) ? 'present' : 'original_deleted';
    const r = db
      .prepare(
        `UPDATE anlagenstamm_parameter_files
         SET source_file_status = ?, updated_at = datetime('now')
         WHERE id = ? AND source_file_status <> ?`,
      )
      .run(status, row.id, status);
    if (r && r.changes) changed += Number(r.changes);
  }
  return changed;
}

function listParameterFilesByFab(db, fab) {
  const fabNorm = normalizeFabDigits(fab);
  if (!fabNorm) return [];
  return db
    .prepare(
      `SELECT f.id, f.fab, f.source, f.source_file_status, f.technician_id, f.technician_name,
              f.uploaded_at, f.original_filename, f.mime, f.size, f.sha256, f.storage_relpath,
              f.source_path, f.filename_fn, f.content_fn, f.used_fn,
              (SELECT COUNT(*) FROM anlagenstamm_parameter_entries e WHERE e.file_id = f.id) AS entry_count
       FROM anlagenstamm_parameter_files f
       WHERE f.fab = ?
       ORDER BY datetime(f.uploaded_at) DESC, f.id DESC`,
    )
    .all(fabNorm);
}

function listParameterEntriesByFileId(db, fileId) {
  const fid = parseInt(fileId, 10);
  if (!Number.isFinite(fid) || fid <= 0) return [];
  return db
    .prepare(
      `SELECT line_no, param_key, param_value, unit, raw_line
       FROM anlagenstamm_parameter_entries
       WHERE file_id = ?
       ORDER BY line_no ASC, id ASC`,
    )
    .all(fid);
}

function getParameterFileMeta(db, fileId, fab) {
  const fid = parseInt(fileId, 10);
  const fabNorm = normalizeFabDigits(fab);
  if (!Number.isFinite(fid) || fid <= 0 || !fabNorm) return null;
  return db
    .prepare(
      `SELECT f.id, f.fab, f.source, f.uploaded_at, f.original_filename, f.technician_name,
              (SELECT COUNT(*) FROM anlagenstamm_parameter_entries e WHERE e.file_id = f.id) AS entry_count
       FROM anlagenstamm_parameter_files f
       WHERE f.id = ? AND f.fab = ?`,
    )
    .get(fid, fabNorm);
}

function compareParameterFilesById(db, fab, fromFileId, toFileId) {
  const fromMeta = getParameterFileMeta(db, fromFileId, fab);
  const toMeta = getParameterFileMeta(db, toFileId, fab);
  if (!fromMeta || !toMeta) {
    return { ok: false, error: 'Eine oder beide Listen wurden nicht gefunden.' };
  }
  const fromEntries = listParameterEntriesByFileId(db, fromFileId);
  const toEntries = listParameterEntriesByFileId(db, toFileId);
  const diff = compareParameterEntryLists(fromEntries, toEntries);
  return {
    ok: true,
    from_file: {
      id: fromMeta.id,
      original_filename: fromMeta.original_filename,
      uploaded_at: fromMeta.uploaded_at,
      source: fromMeta.source,
      technician_name: fromMeta.technician_name,
      entry_count: fromMeta.entry_count,
    },
    to_file: {
      id: toMeta.id,
      original_filename: toMeta.original_filename,
      uploaded_at: toMeta.uploaded_at,
      source: toMeta.source,
      technician_name: toMeta.technician_name,
      entry_count: toMeta.entry_count,
    },
    changes: diff.changes,
    summary: diff.summary,
  };
}

/** Aufeinanderfolgende Vergleiche chronologisch (älter → neuer). */
function buildParameterTrendChain(db, fab) {
  const fabNorm = normalizeFabDigits(fab);
  if (!fabNorm) return { ok: false, error: 'Ungültige Fabrikationsnummer.' };
  const files = db
    .prepare(
      `SELECT id, uploaded_at, original_filename
       FROM anlagenstamm_parameter_files
       WHERE fab = ?
       ORDER BY datetime(uploaded_at) ASC, id ASC`,
    )
    .all(fabNorm);
  if (files.length < 2) {
    return {
      ok: true,
      fab: fabNorm,
      steps: [],
      message: 'Mindestens zwei Parameterlisten nötig für einen Trend.',
    };
  }
  const steps = [];
  for (let i = 0; i < files.length - 1; i++) {
    const fromF = files[i];
    const toF = files[i + 1];
    const step = compareParameterFilesById(db, fabNorm, fromF.id, toF.id);
    if (step && step.ok) {
      steps.push({
        step_index: i + 1,
        from_file_id: fromF.id,
        to_file_id: toF.id,
        from_label: fromF.original_filename,
        to_label: toF.original_filename,
        from_uploaded_at: fromF.uploaded_at,
        to_uploaded_at: toF.uploaded_at,
        summary: step.summary,
        changes: step.changes,
      });
    }
  }
  return { ok: true, fab: fabNorm, steps };
}

module.exports = {
  ensureAnlagenstammLocalSchema,
  rowCount,
  listAnlagenstammForApi,
  upsertAnlagenstammRows,
  clearEmptyDirtyAnlagenstammStubs,
  clampForDispoAnlagenstamm,
  clampForDispoJobFabrikation,
  clampFabrikationsnummernJson,
  stammFieldTrim,
  ANLAGENSTAMM_MERGE_KEYS,
  mergeAnlagenstammPayload,
  hasNonemptyStammField,
  stripEmptyStammFieldsForDispoPush,
  searchLocal,
  fabLookupKeys,
  lookupByFab,
  dedupeAnlagenstammLocalByFab,
  getRowsByFabs,
  saveLocal,
  syncAnlagenstammFromDispo,
  authHeaderFromCredentials,
  dispoMonteurFetchHeaders,
  fabDirForCache,
  uploadCachePath,
  upsertParameterFile,
  cacheParameterFilesFromDispo,
  listParameterFilesByFab,
  markMissingProjekteNeuFiles,
  normalizeFabDigits,
  listParameterEntriesByFileId,
  compareParameterFilesById,
  buildParameterTrendChain,
};
