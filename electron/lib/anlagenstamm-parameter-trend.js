'use strict';

const { isLinePlaceholder } = require('./anlagenstamm-parameter-parser');

/**
 * Vergleicht zwei Parameterlisten anhand aller extrahierten Einzelwerte.
 * Doppelte Schlüssel in einer Datei werden durchnummeriert (dup2, dup3, …).
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
  if (!key) return '';
  return unit ? key + '\u0001' + unit : key;
}

function normValue(entry) {
  if (!entry) return '';
  return String(entry.param_value != null ? entry.param_value : '').trim();
}

function valuesEquivalentForCompare(oldVal, newVal) {
  const a = String(oldVal == null ? '' : oldVal).trim();
  const b = String(newVal == null ? '' : newVal).trim();
  if (a === b) return true;
  if (isLinePlaceholder(a) && isLinePlaceholder(b)) return true;
  if (isLinePlaceholder(a) && b === '') return true;
  if (isLinePlaceholder(b) && a === '') return true;
  return false;
}

function buildKeyedEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const map = new Map();
  const order = [];
  for (const ent of list) {
    if (isLinePlaceholder(ent && ent.param_key) || isLinePlaceholder(ent && ent.raw_line)) {
      continue;
    }
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
      if (isLinePlaceholder(newRow.param_value) || isLinePlaceholder(newRow.param_key)) {
        unchanged += 1;
        continue;
      }
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
      if (isLinePlaceholder(oldRow.param_value) || isLinePlaceholder(oldRow.param_key)) {
        unchanged += 1;
        continue;
      }
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
    if (
      valuesEquivalentForCompare(oldRow.param_value, newRow.param_value) &&
      (oldRow.unit === newRow.unit ||
        isLinePlaceholder(oldRow.param_value) ||
        isLinePlaceholder(newRow.param_value))
    ) {
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

function splitParameterTextLines(text) {
  return String(text || '').split(/\r\n|\n|\r/);
}

function normalizeParameterLineForDiff(line) {
  const s = String(line == null ? '' : line).replace(/[ \t]+$/g, '');
  if (isLinePlaceholder(s)) return '\u0001PH';
  return s;
}

function tokenizeParamLine(line) {
  return String(line == null ? '' : line).split(/(\s+|;)/).filter((t) => t !== '');
}

function inlineDiffParts(left, right) {
  const a = String(left == null ? '' : left);
  const b = String(right == null ? '' : right);
  if (a === b) {
    return {
      left: [{ text: a, changed: false }],
      right: [{ text: b, changed: false }],
    };
  }
  const ta = tokenizeParamLine(a);
  const tb = tokenizeParamLine(b);
  const n = ta.length;
  const m = tb.length;
  if (!n && !m) {
    return {
      left: [{ text: '', changed: false }],
      right: [{ text: '', changed: false }],
    };
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = ta[i - 1] === tb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const aMarks = new Array(n).fill(true);
  const bMarks = new Array(m).fill(true);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (ta[i - 1] === tb[j - 1]) {
      aMarks[i - 1] = false;
      bMarks[j - 1] = false;
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  function partsFrom(tokens, marks) {
    const parts = [];
    let buf = '';
    let chg = false;
    for (let k = 0; k < tokens.length; k++) {
      const c = !!marks[k];
      if (k === 0) {
        chg = c;
        buf = tokens[k];
        continue;
      }
      if (c === chg) buf += tokens[k];
      else {
        parts.push({ text: buf, changed: chg });
        buf = tokens[k];
        chg = c;
      }
    }
    if (buf || tokens.length === 0) parts.push({ text: buf, changed: chg });
    return parts.length ? parts : [{ text: '', changed: false }];
  }
  return { left: partsFrom(ta, aMarks), right: partsFrom(tb, bMarks) };
}

function lcsLineOps(aNorm, bNorm) {
  const n = aNorm.length;
  const m = bNorm.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        aNorm[i - 1] === bNorm[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aNorm[i - 1] === bNorm[j - 1]) {
      ops.push({ op: 'eq', li: i - 1, ri: j - 1 });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: 'ins', li: -1, ri: j - 1 });
      j -= 1;
    } else {
      ops.push({ op: 'del', li: i - 1, ri: -1 });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Zeilenvergleich analog Notepad++ Compare: gleich / geändert / nur links / nur rechts.
 * Platzhalter-Striche gelten als gleich, unabhängig von der Länge.
 *
 * @returns {{ rows: Array<object>, summary: { changed: number, added: number, removed: number, equal: number } }}
 */
function compareParameterTextLines(leftText, rightText) {
  const left = splitParameterTextLines(leftText);
  const right = splitParameterTextLines(rightText);
  const lN = left.map(normalizeParameterLineForDiff);
  const rN = right.map(normalizeParameterLineForDiff);
  const ops = lcsLineOps(lN, rN);
  const rows = [];
  const summary = { changed: 0, added: 0, removed: 0, equal: 0 };
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k];
    const next = ops[k + 1];
    if (cur.op === 'del' && next && next.op === 'ins') {
      const lt = left[cur.li] || '';
      const rt = right[next.ri] || '';
      const type =
        isLinePlaceholder(lt) && isLinePlaceholder(rt)
          ? 'equal'
          : normalizeParameterLineForDiff(lt) === normalizeParameterLineForDiff(rt)
            ? 'equal'
            : 'changed';
      const inline = type === 'changed' ? inlineDiffParts(lt, rt) : null;
      rows.push({
        type,
        left_line_no: cur.li + 1,
        right_line_no: next.ri + 1,
        left_text: lt,
        right_text: rt,
        left_parts: inline ? inline.left : [{ text: lt, changed: false }],
        right_parts: inline ? inline.right : [{ text: rt, changed: false }],
      });
      if (type === 'changed') summary.changed += 1;
      else summary.equal += 1;
      k += 1;
      continue;
    }
    if (cur.op === 'eq') {
      const lt = left[cur.li] || '';
      const rt = right[cur.ri] || '';
      rows.push({
        type: 'equal',
        left_line_no: cur.li + 1,
        right_line_no: cur.ri + 1,
        left_text: lt,
        right_text: rt,
        left_parts: [{ text: lt, changed: false }],
        right_parts: [{ text: rt, changed: false }],
      });
      summary.equal += 1;
      continue;
    }
    if (cur.op === 'del') {
      const lt = left[cur.li] || '';
      if (isLinePlaceholder(lt)) {
        rows.push({
          type: 'equal',
          left_line_no: cur.li + 1,
          right_line_no: null,
          left_text: lt,
          right_text: '',
          left_parts: [{ text: lt, changed: false }],
          right_parts: [{ text: '', changed: false }],
        });
        summary.equal += 1;
        continue;
      }
      rows.push({
        type: 'removed',
        left_line_no: cur.li + 1,
        right_line_no: null,
        left_text: lt,
        right_text: '',
        left_parts: [{ text: lt, changed: true }],
        right_parts: [{ text: '', changed: false }],
      });
      summary.removed += 1;
      continue;
    }
    const rt = right[cur.ri] || '';
    if (isLinePlaceholder(rt)) {
      rows.push({
        type: 'equal',
        left_line_no: null,
        right_line_no: cur.ri + 1,
        left_text: '',
        right_text: rt,
        left_parts: [{ text: '', changed: false }],
        right_parts: [{ text: rt, changed: false }],
      });
      summary.equal += 1;
      continue;
    }
    rows.push({
      type: 'added',
      left_line_no: null,
      right_line_no: cur.ri + 1,
      left_text: '',
      right_text: rt,
      left_parts: [{ text: '', changed: false }],
      right_parts: [{ text: rt, changed: true }],
    });
    summary.added += 1;
  }
  return { rows, summary };
}

function decodeParameterBufferToText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const utf = buf.toString('utf8');
  if (utf && !/\uFFFD/.test(utf)) return utf;
  return buf.toString('latin1');
}

module.exports = {
  entryMatchKey,
  buildKeyedEntries,
  compareParameterEntryLists,
  compareParameterEntryMaps,
  isLinePlaceholder,
  valuesEquivalentForCompare,
  splitParameterTextLines,
  normalizeParameterLineForDiff,
  compareParameterTextLines,
  inlineDiffParts,
  decodeParameterBufferToText,
};
