'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const calc = require('./zeitschreibung-calc');
const { generateZeitschreibungPdfBuffer } = require('./zeitschreibung-pdf');
const { generateZeitschreibungXlsxBuffer } = require('./zeitschreibung-xlsx');

function cfgPath(dbDir) {
  return path.join(dbDir, 'zeitschreibung_config.json');
}

function readConfig(dbDir) {
  const p = cfgPath(dbDir);
  try {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { basePath: String(j.basePath || '').trim() };
    }
  } catch (_) {
    /* ignore */
  }
  return { basePath: '' };
}

function writeConfig(dbDir, cfg) {
  fs.writeFileSync(cfgPath(dbDir), JSON.stringify({ basePath: String(cfg.basePath || '').trim() }, null, 2), 'utf8');
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      technician_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      sum_anw REAL NOT NULL DEFAULT 0,
      sum_montage REAL NOT NULL DEFAULT 0,
      sum_ue50 REAL NOT NULL DEFAULT 0,
      sum_ue100 REAL NOT NULL DEFAULT 0,
      sum_weg REAL NOT NULL DEFAULT 0,
      sum_urlaub REAL NOT NULL DEFAULT 0,
      sum_za_plus REAL NOT NULL DEFAULT 0,
      sum_za_minus REAL NOT NULL DEFAULT 0,
      sum_krank REAL NOT NULL DEFAULT 0,
      sum_day REAL NOT NULL DEFAULT 0,
      gesamt REAL NOT NULL DEFAULT 0,
      pdf_path TEXT,
      xlsx_path TEXT,
      server_id INTEGER,
      synced_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(technician_id, year, month)
    );
    CREATE TABLE IF NOT EXISTS timesheet_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timesheet_id INTEGER NOT NULL,
      day_date TEXT NOT NULL,
      weekday TEXT NOT NULL DEFAULT '',
      holiday_label TEXT NOT NULL DEFAULT '',
      anw REAL NOT NULL DEFAULT 0,
      montage REAL NOT NULL DEFAULT 0,
      ue50 REAL NOT NULL DEFAULT 0,
      ue100 REAL NOT NULL DEFAULT 0,
      weg REAL NOT NULL DEFAULT 0,
      urlaub REAL NOT NULL DEFAULT 0,
      za_plus REAL NOT NULL DEFAULT 0,
      za_minus REAL NOT NULL DEFAULT 0,
      krank REAL NOT NULL DEFAULT 0,
      day_sum REAL NOT NULL DEFAULT 0,
      bemerkung TEXT NOT NULL DEFAULT '',
      lohn_gesperrt INTEGER NOT NULL DEFAULT 0,
      UNIQUE(timesheet_id, day_date),
      FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS zeitschreibung_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timesheet_id INTEGER NOT NULL,
      op TEXT NOT NULL DEFAULT 'submit',
      payload_json TEXT,
      local_pdf_path TEXT,
      local_xlsx_path TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try {
    db.exec('ALTER TABLE timesheet_days ADD COLUMN lohn_gesperrt INTEGER NOT NULL DEFAULT 0');
  } catch (_) {
    /* Spalte existiert bereits */
  }
  const lohnOverrideCols = [
    'lohn_anw', 'lohn_montage', 'lohn_ue50', 'lohn_ue100', 'lohn_weg',
    'lohn_urlaub', 'lohn_za_plus', 'lohn_za_minus', 'lohn_krank',
  ];
  for (const col of lohnOverrideCols) {
    try {
      db.exec('ALTER TABLE timesheet_days ADD COLUMN ' + col + ' REAL');
    } catch (_) {
      /* exists */
    }
  }
  try {
    db.exec('ALTER TABLE timesheet_days ADD COLUMN lohn_bemerkung TEXT');
  } catch (_) {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE timesheet_days ADD COLUMN lohn_korrektur_meta TEXT');
  } catch (_) {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE timesheet_days ADD COLUMN korrekturen_json TEXT');
  } catch (_) {
    /* exists */
  }
}

function copyLohnOverrides(from, to) {
  const src = from || {};
  const dst = to || {};
  const fields = [
    'lohn_anw', 'lohn_montage', 'lohn_ue50', 'lohn_ue100', 'lohn_weg',
    'lohn_urlaub', 'lohn_za_plus', 'lohn_za_minus', 'lohn_krank',
  ];
  for (const f of fields) {
    dst[f] = src[f] != null && src[f] !== '' ? calc.num(src[f]) : null;
  }
  dst.lohn_bemerkung = src.lohn_bemerkung != null ? String(src.lohn_bemerkung) : null;
  dst.lohn_korrektur_meta = src.lohn_korrektur_meta != null ? String(src.lohn_korrektur_meta) : null;
  if (src.korrekturen && typeof src.korrekturen === 'object') {
    dst.korrekturen = src.korrekturen;
    dst.korrekturen_json = JSON.stringify(src.korrekturen);
  } else if (src.korrekturen_json) {
    dst.korrekturen_json = String(src.korrekturen_json);
    try {
      dst.korrekturen = JSON.parse(dst.korrekturen_json);
    } catch (_) {
      dst.korrekturen = {};
    }
  } else {
    dst.korrekturen = {};
    dst.korrekturen_json = null;
  }
  return dst;
}

function getTechnicianName(db, technicianId) {
  try {
    const row = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(technicianId);
    if (row && row.full_name) return String(row.full_name);
    if (row && row.username) return String(row.username);
  } catch (_) {
    /* ignore */
  }
  return 'Monteur';
}

function loadTimesheet(db, technicianId, year, month) {
  const head = db
    .prepare('SELECT * FROM timesheets WHERE technician_id = ? AND year = ? AND month = ?')
    .get(technicianId, year, month);
  if (!head) {
    const days = calc.buildMonthDays(year, month);
    const sums = calc.columnSums(days);
    return {
      id: null,
      technician_id: technicianId,
      year,
      month,
      status: 'draft',
      days,
      sums,
      gesamt: calc.gesamtSum(sums),
      pdf_path: null,
      xlsx_path: null,
      server_id: null,
      synced_at: null,
    };
  }
  const dayRows = db
    .prepare('SELECT * FROM timesheet_days WHERE timesheet_id = ? ORDER BY day_date')
    .all(head.id);
  const byDate = {};
  for (const r of dayRows) byDate[r.day_date] = r;
  const days = calc.buildMonthDays(year, month, byDate);
  const sums = {
    anw: head.sum_anw,
    montage: head.sum_montage,
    ue50: head.sum_ue50,
    ue100: head.sum_ue100,
    weg: head.sum_weg,
    urlaub: head.sum_urlaub,
    za_plus: head.sum_za_plus,
    za_minus: head.sum_za_minus,
    krank: head.sum_krank,
    day_sum: head.sum_day,
  };
  return {
    id: head.id,
    technician_id: head.technician_id,
    year: head.year,
    month: head.month,
    status: head.status,
    days,
    sums,
    gesamt: head.gesamt,
    pdf_path: head.pdf_path,
    xlsx_path: head.xlsx_path,
    server_id: head.server_id,
    synced_at: head.synced_at,
  };
}

function persistTimesheet(db, technicianId, year, month, daysIn, status) {
  const byDate = {};
  for (const d of daysIn || []) {
    if (d && d.day_date) byDate[d.day_date] = d;
  }

  const existing = db
    .prepare('SELECT id, status FROM timesheets WHERE technician_id = ? AND year = ? AND month = ?')
    .get(technicianId, year, month);

  // Gesperrte Tage + Lohn-Overrides aus lokaler DB behalten.
  const lockedByDate = {};
  const prevByDate = {};
  if (existing) {
    try {
      const allPrev = db.prepare('SELECT * FROM timesheet_days WHERE timesheet_id = ?').all(existing.id);
      for (const r of allPrev) {
        prevByDate[r.day_date] = r;
        if (Number(r.lohn_gesperrt)) lockedByDate[r.day_date] = r;
      }
    } catch (_) {
      /* Spalte ggf. noch nicht da */
    }
  }

  for (const d of daysIn || []) {
    if (!d || !d.day_date) continue;
    const prev = prevByDate[d.day_date] || lockedByDate[d.day_date] || null;
    const locked = Number(d.lohn_gesperrt) || (prev && Number(prev.lohn_gesperrt)) ? 1 : 0;
    let row = Object.assign({}, d, { lohn_gesperrt: locked });
    if (locked && prev) {
      row = Object.assign({}, row, {
        anw: prev.anw,
        montage: prev.montage,
        ue50: prev.ue50,
        ue100: prev.ue100,
        weg: prev.weg,
        urlaub: prev.urlaub,
        za_plus: prev.za_plus,
        za_minus: prev.za_minus,
        krank: prev.krank,
        bemerkung: prev.bemerkung != null ? prev.bemerkung : row.bemerkung,
        lohn_gesperrt: 1,
      });
    }
    // Client (Pull) liefert Overrides; sonst lokale Overrides behalten
    const hasIncomingOverrides =
      Object.prototype.hasOwnProperty.call(d, 'korrekturen') ||
      Object.prototype.hasOwnProperty.call(d, 'korrekturen_json') ||
      Object.prototype.hasOwnProperty.call(d, 'lohn_anw') ||
      Object.prototype.hasOwnProperty.call(d, 'lohn_bemerkung') ||
      Object.prototype.hasOwnProperty.call(d, 'lohn_korrektur_meta');
    if (hasIncomingOverrides) copyLohnOverrides(d, row);
    else if (prev) copyLohnOverrides(prev, row);
    byDate[d.day_date] = row;
  }

  // Gesperrte Tage, die nicht im Payload waren, trotzdem behalten
  for (const dk of Object.keys(lockedByDate)) {
    if (byDate[dk]) continue;
    const r = lockedByDate[dk];
    byDate[dk] = Object.assign({}, r, { lohn_gesperrt: 1 });
    copyLohnOverrides(r, byDate[dk]);
  }

  const days = calc.buildMonthDays(year, month, byDate);
  for (const d of days) {
    // Monteur-day_sum bleibt Original; UI/Export nutzen effektiv
    d.day_sum = calc.daySum(d);
  }
  // Header-Summen effektiv (mit Lohn-Overrides)
  const sums = calc.columnSumsEffective
    ? calc.columnSumsEffective(days)
    : calc.columnSums(days);
  const gesamt = calc.gesamtSum(sums);

  // Nach Freigabe nicht durch erneutes Speichern auf draft zurücksetzen.
  let nextStatus = status === 'submitted' ? 'submitted' : 'draft';
  if (existing && existing.status === 'submitted' && nextStatus === 'draft') {
    nextStatus = 'submitted';
  }

  let id;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE timesheets SET status = ?, sum_anw=?, sum_montage=?, sum_ue50=?, sum_ue100=?, sum_weg=?,
       sum_urlaub=?, sum_za_plus=?, sum_za_minus=?, sum_krank=?, sum_day=?, gesamt=?, updated_at=datetime('now')
       WHERE id = ?`,
    ).run(
      nextStatus,
      sums.anw,
      sums.montage,
      sums.ue50,
      sums.ue100,
      sums.weg,
      sums.urlaub,
      sums.za_plus,
      sums.za_minus,
      sums.krank,
      sums.day_sum,
      gesamt,
      id,
    );
    db.prepare('DELETE FROM timesheet_days WHERE timesheet_id = ?').run(id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO timesheets (
          technician_id, year, month, status, sum_anw, sum_montage, sum_ue50, sum_ue100, sum_weg,
          sum_urlaub, sum_za_plus, sum_za_minus, sum_krank, sum_day, gesamt, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      )
      .run(
        technicianId,
        year,
        month,
        nextStatus,
        sums.anw,
        sums.montage,
        sums.ue50,
        sums.ue100,
        sums.weg,
        sums.urlaub,
        sums.za_plus,
        sums.za_minus,
        sums.krank,
        sums.day_sum,
        gesamt,
      );
    id = Number(info.lastInsertRowid);
  }

  const ins = db.prepare(
    `INSERT INTO timesheet_days (
      timesheet_id, day_date, weekday, holiday_label, anw, montage, ue50, ue100, weg,
      urlaub, za_plus, za_minus, krank, day_sum, bemerkung, lohn_gesperrt,
      lohn_anw, lohn_montage, lohn_ue50, lohn_ue100, lohn_weg, lohn_urlaub,
      lohn_za_plus, lohn_za_minus, lohn_krank, lohn_bemerkung, lohn_korrektur_meta, korrekturen_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const dayList = Array.isArray(days) ? days : [];
  db.transaction(() => {
    for (const d of dayList) {
      const ov = copyLohnOverrides(d, {});
      ins.run(
        id,
        d.day_date,
        d.weekday,
        d.holiday_label || '',
        calc.num(d.anw),
        calc.num(d.montage),
        calc.num(d.ue50),
        calc.num(d.ue100),
        calc.num(d.weg),
        calc.num(d.urlaub),
        calc.num(d.za_plus),
        calc.num(d.za_minus),
        calc.num(d.krank),
        calc.num(d.day_sum),
        d.bemerkung || '',
        Number(d.lohn_gesperrt) ? 1 : 0,
        ov.lohn_anw,
        ov.lohn_montage,
        ov.lohn_ue50,
        ov.lohn_ue100,
        ov.lohn_weg,
        ov.lohn_urlaub,
        ov.lohn_za_plus,
        ov.lohn_za_minus,
        ov.lohn_krank,
        ov.lohn_bemerkung,
        ov.lohn_korrektur_meta,
        ov.korrekturen_json,
      );
    }
  });

  return { id, days: dayList, sums, gesamt, status: nextStatus };
}

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function writeExportFiles(dbDir, db, writeFileWithRetry, technicianId, year, month, days, sums, gesamt) {
  const cfg = readConfig(dbDir);
  if (!cfg.basePath) {
    const err = new Error('Zeitaufzeichnungen-Ordner nicht konfiguriert. Bitte Basispfad wählen.');
    err.code = 'NO_BASE_PATH';
    throw err;
  }
  const techName = getTechnicianName(db, technicianId);
  const relFolder = calc.folderRel(year, month).replace(/\//g, path.sep);
  const dir = path.join(cfg.basePath, relFolder);
  mkdirp(dir);
  const stem = calc.fileStem(year, month, techName);
  const pdfPath = path.join(dir, `${stem}.pdf`);
  const xlsxPath = path.join(dir, `${stem}.xlsx`);
  const exportDays = calc.daysForExport(days);
  const exportSums = calc.columnSumsEffective(days);
  const exportGesamt = calc.gesamtSum(exportSums);
  const payload = {
    year,
    month,
    technicianName: techName,
    days: exportDays,
    sums: exportSums,
    gesamt: exportGesamt,
  };
  const pdfBuf = await generateZeitschreibungPdfBuffer(payload);
  const xlsxBuf = await generateZeitschreibungXlsxBuffer(payload);
  if (typeof writeFileWithRetry === 'function') {
    await writeFileWithRetry(pdfPath, pdfBuf);
    await writeFileWithRetry(xlsxPath, xlsxBuf);
  } else {
    fs.writeFileSync(pdfPath, pdfBuf);
    fs.writeFileSync(xlsxPath, xlsxBuf);
  }
  return { pdfPath, xlsxPath, techName };
}

function enqueueOutbox(db, timesheetId, pdfPath, xlsxPath, payload) {
  db.prepare('DELETE FROM zeitschreibung_outbox WHERE timesheet_id = ? AND op = ?').run(timesheetId, 'submit');
  db.prepare(
    `INSERT INTO zeitschreibung_outbox (timesheet_id, op, payload_json, local_pdf_path, local_xlsx_path)
     VALUES (?, 'submit', ?, ?, ?)`,
  ).run(timesheetId, JSON.stringify(payload || {}), pdfPath || null, xlsxPath || null);
}

async function tryFlushZeitschreibungNow(db, technicianId, resolveDispoPushCreds) {
  if (typeof resolveDispoPushCreds !== 'function') {
    return { flushed: 0, errors: [], attempted: false };
  }
  let creds = null;
  try {
    creds = await Promise.resolve(resolveDispoPushCreds(technicianId));
  } catch (_) {
    return { flushed: 0, errors: [], attempted: false };
  }
  if (!creds || !creds.baseUrl) {
    return { flushed: 0, errors: [], attempted: false };
  }
  try {
    const result = await flushZeitschreibungOutbox(
      db,
      creds.baseUrl,
      creds.authHeader || null,
      technicianId,
    );
    return { flushed: result.flushed || 0, errors: result.errors || [], attempted: true };
  } catch (e) {
    return {
      flushed: 0,
      errors: [e && e.message ? e.message : String(e)],
      attempted: true,
    };
  }
}

/**
 * Push pending timesheet saves/submits to Dispo.
 */
async function flushZeitschreibungOutbox(db, baseUrl, authHeader, technicianId, fetchFn) {
  const rows = db.prepare('SELECT * FROM zeitschreibung_outbox ORDER BY id ASC LIMIT 20').all();
  if (!rows.length) return { flushed: 0, errors: [] };
  const fetchImpl = fetchFn || fetch;
  const errors = [];
  let flushed = 0;
  for (const row of rows) {
    try {
      const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(row.timesheet_id);
      if (!ts) {
        db.prepare('DELETE FROM zeitschreibung_outbox WHERE id = ?').run(row.id);
        continue;
      }
      const days = db
        .prepare('SELECT * FROM timesheet_days WHERE timesheet_id = ? ORDER BY day_date')
        .all(row.timesheet_id);
      const status = ts.status === 'submitted' ? 'submitted' : 'draft';
      const body = {
        technician_id: ts.technician_id || technicianId,
        year: ts.year,
        month: ts.month,
        status,
        sums: {
          anw: ts.sum_anw,
          montage: ts.sum_montage,
          ue50: ts.sum_ue50,
          ue100: ts.sum_ue100,
          weg: ts.sum_weg,
          urlaub: ts.sum_urlaub,
          za_plus: ts.sum_za_plus,
          za_minus: ts.sum_za_minus,
          krank: ts.sum_krank,
          day_sum: ts.sum_day,
        },
        gesamt: ts.gesamt,
        days: days.map((d) => ({
          day_date: d.day_date,
          weekday: d.weekday,
          holiday_label: d.holiday_label,
          anw: d.anw,
          montage: d.montage,
          ue50: d.ue50,
          ue100: d.ue100,
          weg: d.weg,
          urlaub: d.urlaub,
          za_plus: d.za_plus,
          za_minus: d.za_minus,
          krank: d.krank,
          day_sum: d.day_sum,
          bemerkung: d.bemerkung,
        })),
      };
      const url = String(baseUrl || '').replace(/\/$/, '') + '/api/monteur_timesheet_submit.php';
      const headers = { 'Content-Type': 'application/json', 'X-Technician-Id': String(body.technician_id) };
      if (authHeader) headers.Authorization = authHeader;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const serverId = data.id != null ? Number(data.id) : null;
      db.prepare(
        `UPDATE timesheets SET server_id = COALESCE(?, server_id), synced_at = datetime('now') WHERE id = ?`,
      ).run(serverId, row.timesheet_id);
      db.prepare('DELETE FROM zeitschreibung_outbox WHERE id = ?').run(row.id);
      flushed += 1;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      errors.push(msg);
      db.prepare(
        `UPDATE zeitschreibung_outbox SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(msg, row.id);
    }
  }
  return { flushed, errors };
}

async function pullLohnLocksFromDispo(db, technicianId, year, month, resolveDispoPushCreds) {
  if (typeof resolveDispoPushCreds !== 'function') return false;
  let creds = null;
  try {
    creds = await Promise.resolve(resolveDispoPushCreds(technicianId));
  } catch (_) {
    return false;
  }
  if (!creds || !creds.baseUrl) return false;
  return pullLohnLocksWithCreds(db, technicianId, year, month, creds.baseUrl, creds.authHeader || null);
}

async function pullLohnLocksWithCreds(db, technicianId, year, month, baseUrl, authHeader) {
  if (!baseUrl || !technicianId || !year || !month) return false;
  const url =
    String(baseUrl || '').replace(/\/$/, '') +
    '/api/monteur_timesheet_get.php?technician_id=' +
    encodeURIComponent(technicianId) +
    '&year=' +
    encodeURIComponent(year) +
    '&month=' +
    encodeURIComponent(month);
  const headers = { Accept: 'application/json' };
  if (authHeader) headers.Authorization = authHeader;
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data || !data.ok || !Array.isArray(data.days)) return false;

  const local = loadTimesheet(db, technicianId, year, month);
  const byDate = {};
  for (const d of local.days || []) {
    byDate[d.day_date] = Object.assign({}, d);
  }
  let changed = false;
  for (const sd of data.days) {
    if (!sd || !sd.day_date) continue;
    const lock = Number(sd.lohn_gesperrt) ? 1 : 0;
    const cur = byDate[sd.day_date] || { day_date: sd.day_date };
    const prevLock = Number(cur.lohn_gesperrt) ? 1 : 0;
    const next = Object.assign({}, cur);
    copyLohnOverrides(sd, next);
    if (lock) {
      Object.assign(next, {
        anw: sd.anw,
        montage: sd.montage,
        ue50: sd.ue50,
        ue100: sd.ue100,
        weg: sd.weg,
        urlaub: sd.urlaub,
        za_plus: sd.za_plus,
        za_minus: sd.za_minus,
        krank: sd.krank,
        bemerkung: sd.bemerkung != null ? sd.bemerkung : cur.bemerkung,
        holiday_label: sd.holiday_label || cur.holiday_label || '',
        lohn_gesperrt: 1,
      });
      changed = true;
    } else if (prevLock) {
      next.lohn_gesperrt = 0;
      changed = true;
    } else if (
      sd.korrekturen &&
      Object.keys(sd.korrekturen).length > 0
    ) {
      changed = true;
    } else if (
      ['lohn_anw', 'lohn_montage', 'lohn_ue50', 'lohn_ue100', 'lohn_weg', 'lohn_urlaub', 'lohn_za_plus', 'lohn_za_minus', 'lohn_krank', 'lohn_bemerkung'].some(
        (k) => sd[k] != null || cur[k] != null,
      )
    ) {
      changed = true;
    }
    byDate[sd.day_date] = next;
  }
  if (!changed) return false;
  const mergedDays = Object.keys(byDate).map((k) => byDate[k]);
  persistTimesheet(db, technicianId, year, month, mergedDays, local.status || 'draft');
  return true;
}

/**
 * Holt Lohn-Sperren für aktuelle/nahe Monate und lokal vorhandene Monatsblätter.
 * Aufruf z. B. nach sync_push und vor Speichern.
 */
async function pullRecentLohnLocks(db, technicianId, baseUrl, authHeader) {
  if (!db || !technicianId || !baseUrl) return { pulled: 0 };
  ensureTables(db);
  const now = new Date();
  const pairs = new Map();
  const add = (y, m) => {
    if (!y || m < 1 || m > 12) return;
    pairs.set(y + '-' + m, { year: y, month: m });
  };
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;
  add(cy, cm);
  if (cm === 1) add(cy - 1, 12);
  else add(cy, cm - 1);
  if (cm === 12) add(cy + 1, 1);
  else add(cy, cm + 1);
  try {
    const rows = db
      .prepare('SELECT year, month FROM timesheets WHERE technician_id = ? ORDER BY year DESC, month DESC LIMIT 12')
      .all(technicianId);
    for (const r of rows || []) add(Number(r.year), Number(r.month));
  } catch (_) {
    /* ignore */
  }
  let pulled = 0;
  for (const { year, month } of pairs.values()) {
    try {
      const ok = await pullLohnLocksWithCreds(db, technicianId, year, month, baseUrl, authHeader);
      if (ok) pulled += 1;
    } catch (_) {
      /* ignore month */
    }
  }
  return { pulled };
}

function registerZeitschreibungRoutes(app, ctx) {
  const { getDb, dbDir, writeFileWithRetry, resolveDispoPushCreds } = ctx;
  ensureTables(getDb());

  app.get('/api/zeitschreibung/config', (req, res) => {
    try {
      res.json({ ok: true, ...readConfig(dbDir) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/zeitschreibung/config', express.json(), (req, res) => {
    try {
      const basePath = String((req.body && req.body.basePath) || '').trim();
      writeConfig(dbDir, { basePath });
      res.json({ ok: true, basePath });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/zeitschreibung', async (req, res) => {
    try {
      const db = getDb();
      ensureTables(db);
      const technicianId = parseInt(String(req.query.technician_id || ''), 10);
      const year = parseInt(String(req.query.year || ''), 10);
      const month = parseInt(String(req.query.month || ''), 10);
      if (!technicianId || !year || !month || month < 1 || month > 12) {
        return res.status(400).json({ ok: false, error: 'technician_id, year, month erforderlich' });
      }
      try {
        await pullLohnLocksFromDispo(db, technicianId, year, month, resolveDispoPushCreds);
      } catch (_) {
        /* offline / kein Dispo — lokale Locks behalten */
      }
      const data = loadTimesheet(db, technicianId, year, month);
      data.technician_name = getTechnicianName(db, technicianId);
      data.config = readConfig(dbDir);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/zeitschreibung/save', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const db = getDb();
      ensureTables(db);
      const body = req.body || {};
      const technicianId = parseInt(String(body.technician_id || ''), 10);
      const year = parseInt(String(body.year || ''), 10);
      const month = parseInt(String(body.month || ''), 10);
      if (!technicianId || !year || !month) {
        return res.status(400).json({ ok: false, error: 'technician_id, year, month erforderlich' });
      }
      try {
        await pullLohnLocksFromDispo(db, technicianId, year, month, resolveDispoPushCreds);
      } catch (_) {
        /* offline */
      }
      const saved = persistTimesheet(db, technicianId, year, month, body.days || [], 'draft');
      enqueueOutbox(db, saved.id, null, null, {
        technician_id: technicianId,
        year,
        month,
        status: saved.status,
      });
      const flush = await tryFlushZeitschreibungNow(db, technicianId, resolveDispoPushCreds);
      res.json({
        ok: true,
        id: saved.id,
        sums: saved.sums,
        gesamt: saved.gesamt,
        status: saved.status,
        synced: flush.flushed > 0,
        sync_pending: flush.flushed === 0,
        sync_errors: flush.errors || [],
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/zeitschreibung/submit', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const db = getDb();
      ensureTables(db);
      const body = req.body || {};
      const technicianId = parseInt(String(body.technician_id || ''), 10);
      const year = parseInt(String(body.year || ''), 10);
      const month = parseInt(String(body.month || ''), 10);
      if (!technicianId || !year || !month) {
        return res.status(400).json({ ok: false, error: 'technician_id, year, month erforderlich' });
      }
      try {
        await pullLohnLocksFromDispo(db, technicianId, year, month, resolveDispoPushCreds);
      } catch (_) {
        /* offline */
      }
      const saved = persistTimesheet(db, technicianId, year, month, body.days || [], 'submitted');
      const files = await writeExportFiles(
        dbDir,
        db,
        writeFileWithRetry,
        technicianId,
        year,
        month,
        saved.days,
        saved.sums,
        saved.gesamt,
      );
      db.prepare(
        `UPDATE timesheets SET pdf_path = ?, xlsx_path = ?, status = 'submitted', updated_at = datetime('now') WHERE id = ?`,
      ).run(files.pdfPath, files.xlsxPath, saved.id);
      enqueueOutbox(db, saved.id, files.pdfPath, files.xlsxPath, {
        technician_id: technicianId,
        year,
        month,
        status: 'submitted',
      });
      const flush = await tryFlushZeitschreibungNow(db, technicianId, resolveDispoPushCreds);
      res.json({
        ok: true,
        id: saved.id,
        status: 'submitted',
        sums: saved.sums,
        gesamt: saved.gesamt,
        pdf_path: files.pdfPath,
        xlsx_path: files.xlsxPath,
        synced: flush.flushed > 0,
        sync_pending: flush.flushed === 0,
        sync_errors: flush.errors || [],
      });
    } catch (e) {
      const code = e && e.code === 'NO_BASE_PATH' ? 400 : 500;
      res.status(code).json({ ok: false, error: e.message || String(e) });
    }
  });
}

module.exports = {
  registerZeitschreibungRoutes,
  flushZeitschreibungOutbox,
  pullRecentLohnLocks,
  ensureTables,
  loadTimesheet,
  readConfig,
};
