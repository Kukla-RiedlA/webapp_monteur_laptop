'use strict';

const {
  rowCount,
  listAllAnlagenstammLocal,
  lookupById,
  deleteLocal,
  parseTedMechanik,
  persistAnlagenstammExtras,
  normalizeFabDigits,
} = require('./anlagenstamm-local');
const {
  paginateAnlagenstammList,
  resolveAnlagenstammFnFocus,
} = require('./anlagenstamm-list-query');

function readTreeCachePn(db, fab) {
  if (!db || !fab) return '';
  try {
    const row = db
      .prepare('SELECT tree_json FROM anlagenstamm_tree_cache WHERE fab = ? LIMIT 1')
      .get(String(fab).trim());
    if (!row || !row.tree_json) return '';
    const tree = JSON.parse(row.tree_json);
    if (!Array.isArray(tree) || !tree.length) return '';
    const first = tree[0];
    return String((first && (first.name || first.label)) || '').trim();
  } catch (_) {
    return '';
  }
}

function enrichRowsWithTreePn(db, rows) {
  return (rows || []).map((row) => {
    const pn = String(row.pn_root_name || '').trim() || readTreeCachePn(db, row.fabrikationsnummer);
    return pn ? { ...row, pn_root_name: pn } : row;
  });
}

function hasLocalAnlagenstammData(db) {
  return rowCount(db) > 0;
}

function getAnlagenstammListResponse(db, query = {}) {
  if (!hasLocalAnlagenstammData(db)) {
    return {
      success: true,
      data: [],
      rows: [],
      page: 1,
      page_size: parseInt(String(query.page_size || '300'), 10) || 300,
      total_count: 0,
      total_pages: 1,
      source: 'local_empty',
    };
  }
  const all = enrichRowsWithTreePn(db, listAllAnlagenstammLocal(db));
  return paginateAnlagenstammList(all, query);
}

function getAnlagenstammFnFocusResponse(db, query = {}) {
  if (!hasLocalAnlagenstammData(db)) {
    return { success: true, match: 'none', source: 'local_empty' };
  }
  const all = enrichRowsWithTreePn(db, listAllAnlagenstammLocal(db));
  return resolveAnlagenstammFnFocus(all, query);
}

function readTedFromJobIndex(db, fab) {
  if (!db || !fab) return [];
  const f = String(fab).trim();
  const digits = normalizeFabDigits(f) || f.replace(/\D/g, '');
  const keys = [f];
  if (digits && keys.indexOf(digits) === -1) keys.push(digits);
  for (const key of keys) {
    if (!key) continue;
    const rows = db
      .prepare(
        `SELECT rel_path, file_name FROM job_ted_index
         WHERE TRIM(fab) = TRIM(?) OR TRIM(fab) = TRIM(?)
         ORDER BY file_name ASC`,
      )
      .all(key, digits || key);
    if (rows && rows.length) {
      return rows.map((r) => ({
        file_name: String(r.file_name || '').trim(),
        rel_path: String(r.rel_path || '').trim(),
      })).filter((e) => e.file_name || e.rel_path);
    }
  }
  return [];
}

function lookupAnlagenExtrasForFab(db, fab) {
  const f = String(fab || '').trim();
  if (!f) return { pn: '', ted: [] };
  const byFab = db
    .prepare(
      'SELECT pn_root_name, ted_mechanik FROM anlagenstamm_local WHERE TRIM(fabrikationsnummer) = TRIM(?) LIMIT 1',
    )
    .get(f);
  let pn = '';
  let ted = [];
  if (byFab) {
    pn = String(byFab.pn_root_name || '').trim();
    ted = parseTedMechanik(byFab.ted_mechanik);
  }
  if (!pn) pn = readTreeCachePn(db, f);
  if (!ted.length) ted = readTedFromJobIndex(db, f);
  return { pn, ted };
}

function getAnlagenstammExtrasResponse(db, body = {}) {
  const rawFabs = body && body.fabs != null ? body.fabs : [];
  const fabs = (Array.isArray(rawFabs) ? rawFabs : [rawFabs])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const pn_by_fab = {};
  const ted_by_fab = {};
  let source = 'local_empty';
  for (const fab of fabs) {
    const extra = lookupAnlagenExtrasForFab(db, fab);
    pn_by_fab[fab] = extra.pn;
    ted_by_fab[fab] = extra.ted;
    if (extra.pn || extra.ted.length) source = 'local_cache';
  }
  return { success: true, pn_by_fab, ted_by_fab, source };
}

function mergeAnlagenstammExtrasWithRemote(local, remote) {
  const base = local && local.success !== false ? local : { success: true, pn_by_fab: {}, ted_by_fab: {}, source: 'local_empty' };
  if (!remote || remote.success === false) return base;
  const pn = { ...(base.pn_by_fab || {}) };
  const ted = { ...(base.ted_by_fab || {}) };
  const remotePn = remote.pn_by_fab || {};
  const remoteTed = remote.ted_by_fab || {};
  let merged = false;
  for (const fab of Object.keys(remotePn)) {
    const cur = String(pn[fab] || '').trim();
    const rem = String(remotePn[fab] || '').trim();
    if (!cur && rem) {
      pn[fab] = rem;
      merged = true;
    }
  }
  for (const fab of Object.keys(remoteTed)) {
    const cur = Array.isArray(ted[fab]) ? ted[fab] : [];
    const rem = Array.isArray(remoteTed[fab]) ? remoteTed[fab] : [];
    if ((!cur || cur.length === 0) && rem.length > 0) {
      ted[fab] = rem;
      merged = true;
    }
  }
  if (!merged) return base;
  return {
    success: true,
    pn_by_fab: pn,
    ted_by_fab: ted,
    source: base.source === 'local_empty' ? 'local_cache+online_extras' : `${base.source}+online_extras`,
  };
}

function persistMergedExtrasToDb(db, merged) {
  if (!db || !merged || merged.success === false) return 0;
  return persistAnlagenstammExtras(db, merged.pn_by_fab || {}, merged.ted_by_fab || {});
}

function getAnlagenstammByIdResponse(db, id) {
  const row = lookupById(db, id);
  if (!row) return { success: false, error: 'Anlage nicht gefunden' };
  const pn = String(row.pn_root_name || '').trim() || readTreeCachePn(db, row.fabrikationsnummer);
  return { success: true, data: pn ? { ...row, pn_root_name: pn } : row, source: 'local_cache' };
}

function deleteAnlagenstammLocal(db, payload) {
  const id = Number(payload.id || 0);
  return deleteLocal(db, id);
}

module.exports = {
  hasLocalAnlagenstammData,
  getAnlagenstammListResponse,
  getAnlagenstammFnFocusResponse,
  getAnlagenstammExtrasResponse,
  mergeAnlagenstammExtrasWithRemote,
  persistMergedExtrasToDb,
  getAnlagenstammByIdResponse,
  deleteAnlagenstammLocal,
};
