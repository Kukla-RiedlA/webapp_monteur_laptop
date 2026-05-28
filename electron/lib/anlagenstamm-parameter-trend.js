'use strict';

/**
 * Vergleicht zwei Parameterlisten anhand aller extrahierten Einzelwerte.
 * Doppelte Schlüssel in einer Datei werden über Zeilennummer eindeutig gemacht.
 */

function normKeyPart(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function entryMatchKey(entry) {
  const key = normKeyPart(entry && entry.param_key);
  const unit = normKeyPart(entry && entry.unit);
  const line = entry && entry.line_no != null ? String(entry.line_no) : '';
  if (!key) return '';
  return unit ? key + '\u0001' + unit + '\u0001' + line : key + '\u0001' + line;
}

function normValue(entry) {
  if (!entry) return '';
  return String(entry.param_value != null ? entry.param_value : '').trim();
}

function buildKeyedEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const map = new Map();
  const order = [];
  for (const ent of list) {
    const mk = entryMatchKey(ent);
    if (!mk) continue;
    let slot = mk;
    let n = 2;
    while (map.has(slot)) {
      slot = mk + '\u0001dup' + n;
      n += 1;
    }
    const row = {
      match_key: slot,
      param_key: String(ent.param_key || '').trim(),
      param_value: normValue(ent),
      unit: ent.unit != null ? String(ent.unit).trim() : '',
      line_no: ent.line_no != null ? Number(ent.line_no) : null,
      raw_line: ent.raw_line != null ? String(ent.raw_line) : '',
    };
    map.set(slot, row);
    order.push(slot);
  }
  return { map, order };
}

function compareParameterEntryMaps(fromMap, toMap, fromOrder, toOrder) {
  const from = fromMap instanceof Map ? fromMap : new Map();
  const to = toMap instanceof Map ? toMap : new Map();
  const keys = new Set();
  for (const k of fromOrder || []) keys.add(k);
  for (const k of toOrder || []) keys.add(k);
  for (const k of from.keys()) keys.add(k);
  for (const k of to.keys()) keys.add(k);

  const changes = [];
  let unchanged = 0;
  for (const mk of keys) {
    const oldRow = from.get(mk) || null;
    const newRow = to.get(mk) || null;
    if (!oldRow && newRow) {
      changes.push({
        status: 'added',
        param_key: newRow.param_key,
        unit: newRow.unit,
        line_no_old: null,
        line_no_new: newRow.line_no,
        value_old: '',
        value_new: newRow.param_value,
        raw_line_old: '',
        raw_line_new: newRow.raw_line,
      });
      continue;
    }
    if (oldRow && !newRow) {
      changes.push({
        status: 'removed',
        param_key: oldRow.param_key,
        unit: oldRow.unit,
        line_no_old: oldRow.line_no,
        line_no_new: null,
        value_old: oldRow.param_value,
        value_new: '',
        raw_line_old: oldRow.raw_line,
        raw_line_new: '',
      });
      continue;
    }
    if (!oldRow || !newRow) continue;
    if (oldRow.param_value === newRow.param_value && oldRow.unit === newRow.unit) {
      unchanged += 1;
      changes.push({
        status: 'unchanged',
        param_key: oldRow.param_key,
        unit: oldRow.unit,
        line_no_old: oldRow.line_no,
        line_no_new: newRow.line_no,
        value_old: oldRow.param_value,
        value_new: newRow.param_value,
        raw_line_old: oldRow.raw_line,
        raw_line_new: newRow.raw_line,
      });
    } else {
      changes.push({
        status: 'changed',
        param_key: oldRow.param_key,
        unit: oldRow.unit,
        line_no_old: oldRow.line_no,
        line_no_new: newRow.line_no,
        value_old: oldRow.param_value,
        value_new: newRow.param_value,
        raw_line_old: oldRow.raw_line,
        raw_line_new: newRow.raw_line,
      });
    }
  }

  changes.sort((a, b) => {
    const rank = { changed: 0, added: 1, removed: 2, unchanged: 3 };
    const ra = rank[a.status] != null ? rank[a.status] : 9;
    const rb = rank[b.status] != null ? rank[b.status] : 9;
    if (ra !== rb) return ra - rb;
    return String(a.param_key || '').localeCompare(String(b.param_key || ''), 'de');
  });

  return {
    changes,
    summary: {
      total_keys: changes.length,
      changed: changes.filter((c) => c.status === 'changed').length,
      added: changes.filter((c) => c.status === 'added').length,
      removed: changes.filter((c) => c.status === 'removed').length,
      unchanged,
    },
  };
}

function compareParameterEntryLists(fromEntries, toEntries) {
  const fromBuilt = buildKeyedEntries(fromEntries);
  const toBuilt = buildKeyedEntries(toEntries);
  return compareParameterEntryMaps(fromBuilt.map, toBuilt.map, fromBuilt.order, toBuilt.order);
}

module.exports = {
  entryMatchKey,
  buildKeyedEntries,
  compareParameterEntryLists,
  compareParameterEntryMaps,
};
