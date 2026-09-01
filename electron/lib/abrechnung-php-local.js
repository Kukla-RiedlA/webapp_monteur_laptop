'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Abrechnung — lokale Hilfen für PHP-kompatible Routen (Parität Dispo-Web / Desktop).
 */
function parseJobDatetime(raw) {
  if (!raw) return null;
  const s = String(raw).replace('T', ' ').trim().slice(0, 19);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
}

function rangeOverlapsMonth(start, end, ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return false;
  const [y, mo] = ym.split('-').map(Number);
  const monthStart = new Date(y, mo - 1, 1);
  const monthEnd = new Date(y, mo, 0, 23, 59, 59);
  const rs = start || end;
  const re = end || start;
  if (!rs || !re) return false;
  return rs <= monthEnd && re >= monthStart;
}

function jobOverlapsMonthFromRow(row, ym) {
  const sd = parseJobDatetime(row.start_datetime);
  const ed = parseJobDatetime(row.end_datetime) || sd;
  if (sd || ed) {
    return rangeOverlapsMonth(sd || ed, ed || sd, ym);
  }
  return false;
}

function parseMitAbgerechnet(query) {
  const v = query && query.mit_abgerechnet;
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes';
}

const BELEG_CATEGORIES = [
  { id: 'transport', label: 'Flug / Bahn / Transport', prefix: 'Transport', icon: 'flug_bahn_transport.png' },
  { id: 'hotel', label: 'Hotel', prefix: 'Hotel', icon: 'hotel.png' },
  { id: 'leihwagen', label: 'Leihauto', prefix: 'Leihwagen', icon: 'leihauto.png' },
  { id: 'arbeitsnachweis', label: 'Arbeitsnachweis', prefix: 'Arbeitsnachweis', icon: 'arbeitsnachweis.png' },
  { id: 'montagebericht', label: 'Montagebericht', prefix: 'Montagebericht', icon: 'montagebericht.png' },
  { id: 'kfz', label: 'Maut / Parken', prefix: 'KFZ', icon: 'maut_parken.png' },
  { id: 'email', label: 'E-Mail', prefix: 'Email', icon: 'email.png' },
  { id: 'angebot', label: 'Angebot', prefix: 'Angebot', icon: 'angebot.png' },
  { id: 'bestellung', label: 'Bestellung', prefix: 'Bestellung', icon: 'bestellung.png' },
  { id: 'kommunikation', label: 'Kommunikation', prefix: 'Kommunikation', icon: 'kommunikation.png' },
  { id: 'gebuehren', label: 'Visa / Gebühren', prefix: 'Gebuehren', icon: 'visa_gebuehren.png' },
  { id: 'bewirtung', label: 'Kundenbewirtung', prefix: 'Bewirtung', icon: 'kundenbewirtung.png' },
  { id: 'sonstige', label: 'Sonstige Auslagen', prefix: 'Sonstige', icon: 'sonstige_auslagen.png' },
];

function belegPrefixes() {
  return BELEG_CATEGORIES.map((c) => c.prefix).filter(Boolean);
}

function belegPrefixAllowed(prefix) {
  const p = String(prefix || '').trim();
  return p !== '' && belegPrefixes().includes(p);
}

function sanitizeUploadBasename(name) {
  let n = path.basename(String(name || 'datei')).replace(/[\/\\:*?"<>|]/g, '_');
  n = n.replace(/^[\s._-]+|[\s._-]+$/g, '');
  return n || 'datei';
}

function belegLegacyPrefixes() {
  return ['Firmenauto'];
}

function stripKnownBelegPrefix(baseName) {
  const base = String(baseName || '');
  const prefixes = [...belegPrefixes(), ...belegLegacyPrefixes()];
  for (const prefix of prefixes) {
    const needle = `${prefix}_`;
    if (base.startsWith(needle)) {
      const rest = base.slice(needle.length);
      return rest || base;
    }
  }
  return base;
}

function applyBelegPrefix(origName, prefix) {
  const orig = path.basename(String(origName || 'datei'));
  const ext = path.extname(orig);
  let baseName = ext ? path.basename(orig, ext) : orig;
  baseName = sanitizeUploadBasename(baseName);
  const p = String(prefix || '').trim();
  if (!belegPrefixAllowed(p)) {
    return `${baseName}${ext}`;
  }
  baseName = stripKnownBelegPrefix(baseName);
  baseName = sanitizeUploadBasename(baseName);
  return `${p}_${baseName}${ext}`;
}

function resolveUniqueStoredName(origName, prefix, targetDir) {
  let stored = applyBelegPrefix(origName, prefix);
  const ext = path.extname(stored);
  let baseName = ext ? path.basename(stored, ext) : stored;
  let counter = 1;
  while (targetDir && fs.existsSync(path.join(targetDir, stored))) {
    stored = `${baseName}-${counter}${ext}`;
    counter += 1;
  }
  return stored;
}

function buildJobLabel(row, id) {
  const num = String(row.job_number || '').trim();
  const cust = String(row.customer_name || '').trim();
  let label = (num ? `${num} — ` : `#${id} — `) + cust;
  if (String(row.status || '') === 'abgerechnet') label += ' (abgerechnet)';
  return label;
}

function monteurCanWriteJob(db, dispoJobId, technicianId) {
  let row = null;
  try {
    row = db
      .prepare(
        `SELECT j.id, j.server_id, j.status
         FROM jobs j
         WHERE j.server_id = ? OR j.id = ?
         LIMIT 1`,
      )
      .get(dispoJobId, dispoJobId);
  } catch (_) {
    return true;
  }
  if (!row) return true;
  const st = String(row.status || '');
  if (st === 'abgerechnet') return false;
  const sid = row.server_id != null && row.server_id !== '' ? Number(row.server_id) : Number(row.id);
  try {
    const cal = db
      .prepare(
        `SELECT montage_verrechnet, billing_travel_complete
         FROM calendar_cache_jobs
         WHERE server_job_id = ? AND technician_id = ?
         LIMIT 1`,
      )
      .get(sid, technicianId);
    if (cal && Number(cal.montage_verrechnet) === 1 && Number(cal.billing_travel_complete) === 1) {
      return false;
    }
  } catch (_) {
    /* ignore */
  }
  return true;
}

function buildPageConfig(db, technicianId, query = {}) {
  const today = new Date();
  let defaultYear = today.getFullYear();
  let defaultMonthNum = today.getMonth() + 1;
  if (query.jahr) defaultYear = Number(query.jahr) || defaultYear;
  if (query.monat_num) defaultMonthNum = Number(query.monat_num) || defaultMonthNum;
  const tidFromQuery = Number(query.technician_id || query.techniker || 0);
  const effectiveTechnician = technicianId || (Number.isFinite(tidFromQuery) && tidFromQuery > 0 ? tidFromQuery : 0);
  let prefillJob = null;
  const prefillId = Number(query.job_id || query.id || 0);
  if (prefillId > 0) {
    prefillJob = { id: prefillId };
    if (db && !query.jahr && !query.monat_num) {
      try {
        const row = db
          .prepare(
            `SELECT j.id, j.server_id, j.status, j.start_datetime, j.job_number, c.name AS customer_name
             FROM jobs j
             LEFT JOIN customers c ON c.id = j.customer_id
             WHERE j.server_id = ? OR j.id = ?
             LIMIT 1`,
          )
          .get(prefillId, prefillId);
        if (row) {
          const sd = parseJobDatetime(row.start_datetime);
          if (sd) {
            defaultYear = sd.getFullYear();
            defaultMonthNum = sd.getMonth() + 1;
          }
          const sid = row.server_id != null && row.server_id !== '' ? Number(row.server_id) : Number(row.id);
          prefillJob = {
            id: sid,
            label: buildJobLabel(row, sid),
            status: String(row.status || ''),
            can_write: monteurCanWriteJob(db, sid, effectiveTechnician),
          };
        }
      } catch (_) {
        /* ignore */
      }
    }
  } else if (db && effectiveTechnician > 0) {
    const picked = pickDefaultAbrechnungJob(db, effectiveTechnician);
    if (picked) {
      defaultYear = picked.year;
      defaultMonthNum = picked.monthNum;
      prefillJob = {
        id: picked.serverJobId,
        label: picked.label,
        status: picked.status,
        can_write: picked.can_write,
      };
    }
  }
  const filterMonth = `${defaultYear}-${String(defaultMonthNum).padStart(2, '0')}`;
  return {
    laptopMonthOnly: true,
    fromLaptopEmbed: true,
    hideTechnicianFilter: true,
    showBillingUi: true,
    month: filterMonth,
    year: defaultYear,
    monthNum: defaultMonthNum,
    technician: effectiveTechnician || 0,
    prefillJob,
    csrfUpload: 'laptop-local',
    csrfNote: 'laptop-local',
    csrfBilling: 'laptop-local',
    csrfTravel: 'laptop-local',
    csrfComment: 'laptop-local',
    csrfStatusAdminRevert: 'laptop-local',
    csrfDispoInArbeit: 'laptop-local',
    billingFlagsEditable: false,
    is_admin: false,
    is_dispo: false,
    current_user_id: Number(effectiveTechnician || 0),
    techniciansForFilter: [],
    showAbgerechnet: parseMitAbgerechnet(query),
    belegCategories: BELEG_CATEGORIES,
    belegIconBase: 'icons/beleg/',
  };
}

/** Laufender Auftrag (in_arbeit), sonst nächster offener Auftrag (nach Einsatzdatum). */
function pickDefaultAbrechnungJob(db, technicianId) {
  if (!db || !technicianId || technicianId <= 0) return null;
  const mapRow = (r) => {
    const sid = r.server_id != null && r.server_id !== '' ? Number(r.server_id) : Number(r.id);
    const sd = parseJobDatetime(r.start_datetime);
    const ref = sd || new Date();
    return {
      serverJobId: sid,
      label: buildJobLabel(r, sid),
      status: String(r.status || ''),
      year: ref.getFullYear(),
      monthNum: ref.getMonth() + 1,
      can_write: monteurCanWriteJob(db, sid, technicianId),
    };
  };
  try {
    let row = db
      .prepare(
        `SELECT j.id, j.server_id, j.status, j.start_datetime, j.end_datetime, j.job_number, c.name AS customer_name
         FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         LEFT JOIN customers c ON c.id = j.customer_id
         WHERE LOWER(TRIM(j.status)) = 'in_arbeit'
         ORDER BY j.start_datetime ASC, j.id ASC
         LIMIT 1`,
      )
      .get(technicianId);
    if (row) return mapRow(row);
    row = db
      .prepare(
        `SELECT j.id, j.server_id, j.status, j.start_datetime, j.end_datetime, j.job_number, c.name AS customer_name
         FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         LEFT JOIN customers c ON c.id = j.customer_id
         WHERE LOWER(TRIM(j.status)) NOT IN ('erledigt', 'abgerechnet')
         ORDER BY j.start_datetime ASC, j.id ASC
         LIMIT 1`,
      )
      .get(technicianId);
    if (row) return mapRow(row);
  } catch (_) {
    /* ignore */
  }
  return null;
}

function buildBillingFallback(db, dispoJobId, technicianId) {
  let job = null;
  try {
    job = db
      .prepare(
        `SELECT j.id, j.server_id, j.status, j.start_datetime, j.end_datetime, j.job_number, c.name AS customer_name
         FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
         WHERE j.server_id = ? OR j.id = ?
         LIMIT 1`,
      )
      .get(dispoJobId, dispoJobId);
  } catch (_) {
    job = null;
  }
  const sid = job && job.server_id != null ? Number(job.server_id) : dispoJobId;
  let montageVerrechnet = 0;
  let travelComplete = 0;
  try {
    const cal = db
      .prepare(
        `SELECT montage_verrechnet, billing_travel_complete
         FROM calendar_cache_jobs WHERE server_job_id = ? AND technician_id = ? LIMIT 1`,
      )
      .get(sid, technicianId);
    if (cal) {
      montageVerrechnet = Number(cal.montage_verrechnet) === 1 ? 1 : 0;
      travelComplete = Number(cal.billing_travel_complete) === 1 ? 1 : 0;
    }
  } catch (_) {
    /* ignore */
  }
  const techs = [];
  try {
    const rows = db
      .prepare(
        `SELECT jt.technician_id, u.full_name AS technician_name
         FROM job_technicians jt
         INNER JOIN users u ON u.id = jt.technician_id
         WHERE jt.job_id = ?
         ORDER BY u.full_name ASC`,
      )
      .all(job ? job.id : dispoJobId);
    for (const t of rows) {
      techs.push({
        technician_id: Number(t.technician_id),
        technician_name: String(t.technician_name || '').trim() || `Techniker ${t.technician_id}`,
        reise_abgerechnet: travelComplete ? 1 : 0,
        reise_abgerechnet_at: null,
        reise_abgerechnet_by: null,
        reise_abgerechnet_by_name: null,
      });
    }
  } catch (_) {
    /* ignore */
  }
  const billing = {
    job_id: dispoJobId,
    job_status: job ? String(job.status || '') : '',
    montage_verrechnet: montageVerrechnet,
    montage_verrechnet_at: null,
    montage_verrechnet_by: null,
    montage_verrechnet_by_name: null,
    fakturierung_et: 0,
    fakturierung_et_at: null,
    fakturierung_et_by: null,
    fakturierung_et_by_name: null,
    show_fakturierung_et: false,
    technicians: techs,
    no_technicians_fallback: techs.length === 0,
    montage_abgerechnet_job_fallback: travelComplete ? 1 : 0,
    can_write: monteurCanWriteJob(db, dispoJobId, technicianId),
  };
  return billing;
}

function saveBillingCache(db, save, dispoJobId, billing) {
  db.prepare(
    `INSERT INTO abrechnung_billing_cache (job_server_id, billing_json, synced_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(job_server_id) DO UPDATE SET
       billing_json = excluded.billing_json,
       synced_at = excluded.synced_at`,
  ).run(dispoJobId, JSON.stringify(billing));
  if (typeof save === 'function') save();
}

function readBillingCache(db, dispoJobId) {
  try {
    const row = db
      .prepare('SELECT billing_json FROM abrechnung_billing_cache WHERE job_server_id = ?')
      .get(dispoJobId);
    if (!row || !row.billing_json) return null;
    return JSON.parse(row.billing_json);
  } catch (_) {
    return null;
  }
}

function listJobsFromSnapshot(db, technicianId, monat) {
  const row = db
    .prepare(
      'SELECT jobs_json FROM abrechnung_jobs_snapshot WHERE technician_id = ? AND period_ym = ?',
    )
    .get(technicianId, monat);
  if (!row || !row.jobs_json) return [];
  try {
    const jobs = JSON.parse(row.jobs_json);
    return Array.isArray(jobs) ? jobs : [];
  } catch (_) {
    return [];
  }
}

function listJobsFromSqlite(db, technicianId, monat) {
  if (!/^\d{4}-\d{2}$/.test(String(monat))) return [];
  const start = `${monat}-01`;
  const last = new Date(`${monat}-01T12:00:00`);
  last.setMonth(last.getMonth() + 1);
  last.setDate(0);
  const y = last.getFullYear();
  const m = String(last.getMonth() + 1).padStart(2, '0');
  const d = String(last.getDate()).padStart(2, '0');
  const end = `${y}-${m}-${d} 23:59:59`;
  try {
    const rows = db
      .prepare(
        `SELECT j.server_id, j.id AS local_id, j.job_number, j.status, j.start_datetime, j.end_datetime, c.name AS customer_name
         FROM jobs j
         INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
         INNER JOIN customers c ON c.id = j.customer_id
         WHERE j.start_datetime <= ?
           AND COALESCE(j.end_datetime, j.start_datetime) >= ?
         ORDER BY j.start_datetime ASC, j.id ASC`,
      )
      .all(technicianId, end, start);
    return rows.map((r) => {
      const sid = r.server_id != null && r.server_id !== '' ? Number(r.server_id) : Number(r.local_id);
      return {
        id: sid,
        label: buildJobLabel(r, sid),
        status: String(r.status || ''),
        can_write: monteurCanWriteJob(db, sid, technicianId),
        montage_abgerechnet: 0,
        montage_verrechnet: 0,
      };
    });
  } catch (_) {
    return [];
  }
}

function mergeJobsUnique(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const j of Array.isArray(primary) ? primary : []) {
    const id = j && j.id != null ? Number(j.id) : NaN;
    if (!Number.isFinite(id)) continue;
    seen.add(id);
    out.push(j);
  }
  for (const j of Array.isArray(secondary) ? secondary : []) {
    const id = j && j.id != null ? Number(j.id) : NaN;
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(j);
  }
  return out;
}

function listAbrechnungJobsPhp(db, monat, technicianId, includeAbgerechnet = false) {
  let jobs = listJobsFromSnapshot(db, technicianId, monat);
  const sqliteJobs = listJobsFromSqlite(db, technicianId, monat);
  if (!jobs.length) {
    jobs = sqliteJobs;
  } else {
    jobs = mergeJobsUnique(jobs, sqliteJobs);
  }
  if (!includeAbgerechnet) {
    jobs = jobs.filter((j) => String(j.status || '') !== 'abgerechnet');
  }
  jobs = jobs.map((j) => {
    const id = Number(j.id);
    return Object.assign({}, j, {
      id,
      can_write: monteurCanWriteJob(db, id, technicianId),
    });
  });
  return { ok: true, jobs, technicians: [], source: 'local' };
}

function updateCommentInCache(db, save, readCommentsFromRow, writeCommentsCache, dispoJobId, commentId, body) {
  const row = db
    .prepare('SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?')
    .get(dispoJobId);
  const comments = readCommentsFromRow(row);
  let found = false;
  for (const key of ['dispo', 'buchhaltung']) {
    comments[key] = (comments[key] || []).map((c) => {
      if (Number(c.id) === Number(commentId)) {
        found = true;
        return Object.assign({}, c, { body: String(body || ''), updated_at: new Date().toISOString() });
      }
      return c;
    });
  }
  if (!found) return { ok: false, status: 404, error: 'Kommentar nicht gefunden.' };
  writeCommentsCache(db, dispoJobId, comments);
  if (typeof save === 'function') save();
  return { ok: true, source: 'local' };
}

function deleteCommentInCache(db, save, readCommentsFromRow, writeCommentsCache, dispoJobId, commentId) {
  const row = db
    .prepare('SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?')
    .get(dispoJobId);
  const comments = readCommentsFromRow(row);
  let found = false;
  for (const key of ['dispo', 'buchhaltung']) {
    const before = (comments[key] || []).length;
    comments[key] = (comments[key] || []).filter((c) => Number(c.id) !== Number(commentId));
    if (comments[key].length < before) found = true;
  }
  if (!found) return { ok: false, status: 404, error: 'Kommentar nicht gefunden.' };
  writeCommentsCache(db, dispoJobId, comments);
  if (typeof save === 'function') save();
  return { ok: true, source: 'local' };
}

function resolveTechnicianDisplayName(db, technicianId) {
  const tid = Number(technicianId || 0);
  if (!db || tid <= 0) return '';
  try {
    const row = db.prepare('SELECT full_name, username FROM users WHERE id = ? LIMIT 1').get(tid);
    if (row) {
      const full = String(row.full_name || '').trim();
      if (full) return full;
      const user = String(row.username || '').trim();
      if (user) return user;
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

module.exports = {
  BELEG_CATEGORIES,
  belegPrefixAllowed,
  applyBelegPrefix,
  stripKnownBelegPrefix,
  resolveUniqueStoredName,
  buildPageConfig,
  parseMitAbgerechnet,
  pickDefaultAbrechnungJob,
  buildBillingFallback,
  saveBillingCache,
  readBillingCache,
  listAbrechnungJobsPhp,
  monteurCanWriteJob,
  updateCommentInCache,
  deleteCommentInCache,
  resolveTechnicianDisplayName,
};
