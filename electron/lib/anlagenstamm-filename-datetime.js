'use strict';

/**
 * Datum/Uhrzeit aus Anlagenstamm-Dateinamen, analog zu
 * dispo/inc/anlagenstamm_filename_datetime.php
 * z. B. FN10066_PA7_EN_20220928_0942.CSV → 2022-09-28 09:42:00
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalIso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds())
  );
}

function filenameDatetimeIso(filename) {
  const base = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  if (!base) return null;
  const m = base.match(
    /_(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])([0-5]\d)(?:([0-5]\d))?/,
  );
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null;
  }
  const s = m[6] ? m[6] : '00';
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + s;
}

function normalizeMtimeIso(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return formatLocalIso(new Date(ms));
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (m) {
    const sec = m[3] && m[3] !== '' ? m[3] : '00';
    return m[1] + ' ' + m[2] + ':' + sec;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s + ' 00:00:00';
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    return normalizeMtimeIso(n);
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return formatLocalIso(new Date(parsed));
  }
  return '';
}

/**
 * Anzeige-Stempel: Dateiname, sonst Quellen-mtime, zuletzt Fallback (nicht „jetzt“ beim Scan).
 */
function resolveDisplayDatetime(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const fromName = filenameDatetimeIso(o.filename || '');
  if (fromName) return fromName;
  const fromMtime = normalizeMtimeIso(o.sourceMtimeIso != null ? o.sourceMtimeIso : o.sourceMtimeMs);
  if (fromMtime) return fromMtime;
  const fb = normalizeMtimeIso(o.fallbackDatetime);
  return fb || '';
}

function displayDatetimeSortTs(iso) {
  const s = String(iso || '').trim();
  if (!s) return 0;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

function decorateParameterListItem(item) {
  const src = item && typeof item === 'object' ? item : {};
  const name = String(src.original_filename || src.name || src.display_name || '');
  const display = resolveDisplayDatetime({
    filename: name,
    sourceMtimeIso: src.mtime || src.source_mtime || src.source_mtime_iso,
    fallbackDatetime: src.uploaded_at,
  });
  const out = Object.assign({}, src);
  if (display) {
    out.display_datetime = display;
    out.uploaded_at = display;
  } else if (!out.display_datetime) {
    out.display_datetime = String(src.uploaded_at || '');
  }
  return out;
}

function sortParameterFilesByDisplayDesc(files) {
  return (Array.isArray(files) ? files.slice() : []).sort((a, b) => {
    const tb = displayDatetimeSortTs((b && (b.display_datetime || b.uploaded_at)) || '');
    const ta = displayDatetimeSortTs((a && (a.display_datetime || a.uploaded_at)) || '');
    if (tb !== ta) return tb - ta;
    return (Number(b && b.id) || 0) - (Number(a && a.id) || 0);
  });
}

function sortParameterFilesByDisplayAsc(files) {
  return (Array.isArray(files) ? files.slice() : []).sort((a, b) => {
    const ta = displayDatetimeSortTs((a && (a.display_datetime || a.uploaded_at)) || '');
    const tb = displayDatetimeSortTs((b && (b.display_datetime || b.uploaded_at)) || '');
    if (ta !== tb) return ta - tb;
    return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
  });
}

function parameterFileMergeKey(item) {
  const sha = String((item && item.sha256) || '')
    .trim()
    .toLowerCase();
  if (sha) return 'sha:' + sha;
  const name = String((item && (item.original_filename || item.name)) || '')
    .trim()
    .toLowerCase();
  const size = item && item.size != null ? String(item.size) : '';
  const sp = String((item && (item.source_path || item.storage_relpath || item.storage_rel_path)) || '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
  return 'n:' + name + '|s:' + size + '|p:' + sp;
}

function mergeParameterFileLists(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const list of [primary || [], extra || []]) {
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const k = parameterFileMergeKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return sortParameterFilesByDisplayDesc(out);
}

module.exports = {
  filenameDatetimeIso,
  resolveDisplayDatetime,
  displayDatetimeSortTs,
  decorateParameterListItem,
  sortParameterFilesByDisplayDesc,
  sortParameterFilesByDisplayAsc,
  parameterFileMergeKey,
  mergeParameterFileLists,
};
