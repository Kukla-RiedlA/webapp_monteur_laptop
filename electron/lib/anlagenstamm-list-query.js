'use strict';

const ANLAGENSTAMM_SORT_COLS = new Set([
  'fabrikationsnummer',
  'type',
  'leistung',
  'ted_mechanik',
  'pn_root_name',
  'nenngeschwindigkeit',
  'kraftaufnehmer',
  'dms_nr',
  'tacho',
  'elektronik',
  'material',
  'position',
  'aktueller_kunde',
  'letzter_besuch',
  'geliefert_ueber',
  'projekt',
  'bemerkungen',
]);

const ANLAGENSTAMM_FILTER_FIELD_MAP = {
  filter_fn: 'fabrikationsnummer',
  filter_type: 'type',
  filter_leistung: 'leistung',
  filter_v: 'nenngeschwindigkeit',
  filter_kraftaufnehmer: 'kraftaufnehmer',
  filter_dms_nr: 'dms_nr',
  filter_tacho: 'tacho',
  filter_elektronik: 'elektronik',
  filter_material: 'material',
  filter_position: 'position',
  filter_aktueller_kunde: 'aktueller_kunde',
  filter_letzter_besuch: 'letzter_besuch',
  filter_geliefert_ueber: 'geliefert_ueber',
  filter_projekt: 'projekt',
  filter_bemerkungen: 'bemerkungen',
  filter_pn_root: 'pn_root_name',
};

function compareFabSort(fabA, fabB, dir) {
  const a = String(fabA || '').trim();
  const b = String(fabB || '').trim();
  const aNum = /^[0-9]+$/.test(a);
  const bNum = /^[0-9]+$/.test(b);
  if (aNum !== bNum) {
    // Wie Dispo: Zahlen-FNs immer vor Text (key1 DESC), unabhängig von asc/desc.
    return aNum ? -1 : 1;
  }
  if (aNum && bNum) {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (na !== nb) return dir * (na - nb);
  }
  return dir * a.localeCompare(b, 'de');
}

function sortValueForCol(row, col) {
  if (col === 'ted_mechanik') {
    const t = row.ted_mechanik;
    if (Array.isArray(t)) {
      return t.map((x) => (x && x.file_name) || '').join(' ').toLowerCase();
    }
    return String(t || '').toLowerCase();
  }
  if (col === 'letzter_besuch') {
    return String(row.letzter_besuch || '0001-01-01');
  }
  return String(row[col] ?? '').toLowerCase();
}

function sortAnlagenstammRows(rows, query = {}) {
  let sortCol = String(query.sort_col || 'fabrikationsnummer').trim();
  if (!ANLAGENSTAMM_SORT_COLS.has(sortCol)) {
    sortCol = 'fabrikationsnummer';
  }
  const dir = String(query.sort_dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  const out = [...(rows || [])];
  out.sort((a, b) => {
    if (sortCol === 'fabrikationsnummer') {
      return compareFabSort(a.fabrikationsnummer, b.fabrikationsnummer, dir);
    }
    const va = sortValueForCol(a, sortCol);
    const vb = sortValueForCol(b, sortCol);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return compareFabSort(a.fabrikationsnummer, b.fabrikationsnummer, 1);
  });
  return out;
}

function filterAnlagenstammRows(rows, query = {}) {
  const omitFn = String(query.omit_fn_filter || '') === '1';
  let out = rows || [];
  for (const [param, field] of Object.entries(ANLAGENSTAMM_FILTER_FIELD_MAP)) {
    if (param === 'filter_fn' && omitFn) continue;
    const val = String(query[param] || '').trim().toLowerCase();
    if (!val) continue;
    out = out.filter((row) => String(row[field] || '').toLowerCase().includes(val));
  }
  const filterTed = String(query.filter_ted || '').trim().toLowerCase();
  if (filterTed) {
    out = out.filter((row) => sortValueForCol(row, 'ted_mechanik').includes(filterTed));
  }
  return out;
}

function fnQIsNumeric(q) {
  const s = String(q || '').trim();
  return s !== '' && /^[0-9]+$/.test(s);
}

function resolveAnlagenstammFnFocus(allRows, query = {}) {
  const q = String(query.q || query.filter_fn || '').trim();
  if (!q) {
    return { success: true, match: 'none' };
  }
  const pageSize = Math.min(1000, Math.max(10, parseInt(String(query.page_size || '300'), 10) || 300));
  const isNumericQ = fnQIsNumeric(q);
  const filterQuery = { ...query };
  delete filterQuery.q;
  delete filterQuery.filter_fn;
  const sorted = sortAnlagenstammRows(filterAnlagenstammRows(allRows, filterQuery), {
    sort_col: 'fabrikationsnummer',
    sort_dir: 'asc',
  });

  let match = 'none';
  let targetRow = null;
  const exactRow = sorted.find((r) => String(r.fabrikationsnummer || '').trim() === q);
  if (exactRow) {
    match = 'exact';
    targetRow = exactRow;
  } else if (isNumericQ) {
    const qNum = parseInt(q, 10);
    let prev = null;
    let prevNum = -1;
    for (const r of sorted) {
      const fab = String(r.fabrikationsnummer || '').trim();
      if (!/^[0-9]+$/.test(fab)) continue;
      const n = parseInt(fab, 10);
      if (n < qNum && n > prevNum) {
        prevNum = n;
        prev = r;
      }
    }
    if (prev) {
      match = 'previous';
      targetRow = prev;
    }
  } else {
    let prev = null;
    for (const r of sorted) {
      const fab = String(r.fabrikationsnummer || '').trim();
      if (compareFabSort(fab, q, 1) < 0) prev = r;
    }
    if (prev) {
      match = 'previous';
      targetRow = prev;
    }
  }

  if (!targetRow) {
    return { success: true, match: 'none', q };
  }

  const targetFab = String(targetRow.fabrikationsnummer || '').trim();
  const targetId = Number(targetRow.id || 0);
  let rowIndex = sorted.findIndex((r) => Number(r.id) === targetId && targetId > 0);
  if (rowIndex < 0) {
    rowIndex = sorted.findIndex((r) => String(r.fabrikationsnummer || '').trim() === targetFab);
  }
  if (rowIndex < 0) rowIndex = 0;

  const targetPage = pageSize > 0 ? Math.floor(rowIndex / pageSize) + 1 : 1;

  return {
    success: true,
    match,
    q,
    id: targetId,
    fabrikationsnummer: targetFab,
    row_index: rowIndex,
    target_page: targetPage,
    offset_in_page: pageSize > 0 ? rowIndex % pageSize : 0,
    page_size: pageSize,
    source: 'local_cache',
  };
}

function paginateAnlagenstammList(allRows, query = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const pageSize = Math.min(1000, Math.max(10, parseInt(String(query.page_size || '300'), 10) || 300));
  const filtered = filterAnlagenstammRows(allRows, query);
  const sorted = sortAnlagenstammRows(filtered, query);
  const total = sorted.length;
  const offset = (page - 1) * pageSize;
  const data = sorted.slice(offset, offset + pageSize);
  return {
    success: true,
    data,
    rows: data,
    page,
    page_size: pageSize,
    total_count: total,
    total_pages: Math.ceil(total / pageSize) || 1,
    source: total > 0 ? 'local_cache' : 'local_empty',
  };
}

module.exports = {
  filterAnlagenstammRows,
  sortAnlagenstammRows,
  resolveAnlagenstammFnFocus,
  paginateAnlagenstammList,
};
