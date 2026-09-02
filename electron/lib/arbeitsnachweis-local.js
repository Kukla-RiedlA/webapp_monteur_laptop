'use strict';

/**
 * Arbeitsnachweis lokal in SQLite (gleiche Fachdaten wie Dispo documents / document_arbeitsnachweis).
 * Offline Source of Truth; Dispo-Sync über pending_changes.
 */

function tryExec(db, sql) {
  try {
    db.exec(sql);
  } catch (_) {
    /* already exists */
  }
}

function tableHasColumn(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => String(row.name) === column);
  } catch (_) {
    return false;
  }
}

function ensureArbeitsnachweisLocalSchema(db) {
  if (!db) return;
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      local_job_id INTEGER,
      server_job_id INTEGER,
      customer_id INTEGER,
      document_type TEXT NOT NULL DEFAULT 'arbeitsnachweis',
      number TEXT,
      document_date TEXT,
      status TEXT NOT NULL DEFAULT 'entwurf',
      language TEXT DEFAULT 'de',
      notes TEXT,
      content_version INTEGER NOT NULL DEFAULT 1,
      local_uuid TEXT,
      customer_name TEXT,
      created_by INTEGER,
      dirty INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  tryExec(db, 'CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_local_uuid ON documents(local_uuid)');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_documents_server_id ON documents(server_id)');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_documents_job ON documents(server_job_id, local_job_id)');
  ['server_id', 'local_job_id', 'server_job_id', 'customer_name', 'dirty', 'local_uuid', 'content_version', 'language'].forEach(
    (col) => {
      if (!tableHasColumn(db, 'documents', col)) {
        const types = {
          dirty: 'INTEGER NOT NULL DEFAULT 1',
          content_version: 'INTEGER NOT NULL DEFAULT 1',
        };
        tryExec(db, `ALTER TABLE documents ADD COLUMN ${col} ${types[col] || 'TEXT'}`);
      }
    },
  );
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS document_arbeitsnachweis (
      document_id INTEGER PRIMARY KEY,
      site TEXT,
      equipment_type TEXT,
      fabrikationsnummer TEXT,
      fabrikationsnummern TEXT,
      technician_name TEXT,
      car_info TEXT,
      total_km INTEGER,
      total_km_manual INTEGER NOT NULL DEFAULT 0,
      start_km INTEGER,
      end_km INTEGER,
      living_costs TEXT,
      naechtigung_beigestellt INTEGER NOT NULL DEFAULT 0,
      remarks TEXT,
      timesheet_applied INTEGER NOT NULL DEFAULT 0,
      save_contact INTEGER NOT NULL DEFAULT 0,
      signer_name TEXT,
      signer_email TEXT
    )`,
  );
  ['total_km_manual', 'timesheet_applied', 'save_contact', 'signer_name', 'signer_email', 'fabrikationsnummern', 'equipment_type', 'fabrikationsnummer', 'technician_name'].forEach(
    (col) => {
      if (!tableHasColumn(db, 'document_arbeitsnachweis', col)) {
        const intCols = { total_km_manual: 1, timesheet_applied: 1, save_contact: 1 };
        tryExec(
          db,
          `ALTER TABLE document_arbeitsnachweis ADD COLUMN ${col} ${intCols[col] ? 'INTEGER NOT NULL DEFAULT 0' : 'TEXT'}`,
        );
      }
    },
  );
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS document_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      quantity REAL,
      unit TEXT,
      item_date TEXT,
      item_time TEXT,
      normal_hours REAL,
      overtime_50 REAL,
      overtime_100 REAL,
      designation TEXT,
      type_no TEXT
    )`,
  );
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id, sort_order)');
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS document_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      signer_type TEXT NOT NULL,
      user_id INTEGER,
      signer_name TEXT,
      signer_email TEXT,
      signed_at TEXT,
      content_version INTEGER,
      invalidated_at TEXT
    )`,
  );
}

function newUuid() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID();
  } catch (_) {
    return 'an-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
}

function resolveJobIds(db, rawJobId) {
  const n = parseInt(rawJobId, 10);
  if (!Number.isFinite(n) || n <= 0) return { localJobId: 0, serverJobId: 0 };
  let byLocal = null;
  let byServer = null;
  try {
    byLocal = db.prepare('SELECT id, server_id FROM jobs WHERE id = ? LIMIT 1').get(n);
  } catch (_) {}
  try {
    byServer = db
      .prepare('SELECT id, server_id FROM jobs WHERE CAST(server_id AS TEXT) = CAST(? AS TEXT) LIMIT 1')
      .get(n);
  } catch (_) {}
  const row = byServer || byLocal;
  if (!row) return { localJobId: 0, serverJobId: n };
  const sid = row.server_id != null && String(row.server_id).trim() !== '' ? parseInt(row.server_id, 10) : 0;
  return { localJobId: parseInt(row.id, 10) || 0, serverJobId: sid || n };
}

function loadRow(db, id) {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!document) return null;
  const an = db.prepare('SELECT * FROM document_arbeitsnachweis WHERE document_id = ?').get(id) || null;
  const items = db.prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY sort_order, id').all(id) || [];
  const signatures =
    db.prepare('SELECT * FROM document_signatures WHERE document_id = ? ORDER BY id').all(id) || [];
  if (an && an.fabrikationsnummern) {
    try {
      const parsed = typeof an.fabrikationsnummern === 'string' ? JSON.parse(an.fabrikationsnummern) : an.fabrikationsnummern;
      an.fabrikationsnummern = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      an.fabrikationsnummern = [];
    }
  } else if (an) {
    an.fabrikationsnummern = [];
  }
  if (an) {
    an.total_km_manual = Number(an.total_km_manual) === 1;
    an.naechtigung_beigestellt = Number(an.naechtigung_beigestellt) === 1;
    an.timesheet_applied = Number(an.timesheet_applied) === 1;
    an.save_contact = Number(an.save_contact) === 1;
  }
  return { document, arbeitsnachweis: an, items, signatures };
}

function toPublic(loaded) {
  if (!loaded || !loaded.document) return { ok: true, document: null };
  const d = loaded.document;
  const an = loaded.arbeitsnachweis || {};
  return {
    ok: true,
    document: d,
    items: loaded.items || [],
    signatures: loaded.signatures || [],
    arbeitsnachweis: an,
    customer_name: d.customer_name || '',
    local_id: d.id,
    server_id: d.server_id || 0,
    document_id: d.server_id || 0,
    local_uuid: d.local_uuid || '',
    synced: !Number(d.dirty),
    status: d.status || 'entwurf',
    number: d.number || null,
    updated_at: d.updated_at || null,
    signer_name: an.signer_name || '',
    signer_email: an.signer_email || '',
    save_contact: !!an.save_contact,
    content_version: d.content_version || 1,
  };
}

function findByUuid(db, uuid) {
  const u = String(uuid || '').trim();
  if (!u) return null;
  const row = db.prepare('SELECT id FROM documents WHERE local_uuid = ? AND document_type = ?').get(u, 'arbeitsnachweis');
  return row ? loadRow(db, row.id) : null;
}

function findByJob(db, rawJobId) {
  const ids = resolveJobIds(db, rawJobId);
  let row = null;
  if (ids.serverJobId > 0) {
    row = db
      .prepare(
        `SELECT id FROM documents WHERE document_type = 'arbeitsnachweis' AND server_job_id = ?
         ORDER BY dirty DESC, updated_at DESC, id DESC LIMIT 1`,
      )
      .get(ids.serverJobId);
  }
  if (!row && ids.localJobId > 0) {
    row = db
      .prepare(
        `SELECT id FROM documents WHERE document_type = 'arbeitsnachweis' AND local_job_id = ?
         ORDER BY dirty DESC, updated_at DESC, id DESC LIMIT 1`,
      )
      .get(ids.localJobId);
  }
  return row ? loadRow(db, row.id) : null;
}

function findLatest(db, technicianId) {
  const tid = parseInt(technicianId, 10) || 0;
  let row = null;
  if (tid > 0) {
    row = db
      .prepare(
        `SELECT id FROM documents WHERE document_type = 'arbeitsnachweis' AND created_by = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(tid);
  }
  if (!row) {
    row = db
      .prepare(
        `SELECT id FROM documents WHERE document_type = 'arbeitsnachweis'
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get();
  }
  return row ? loadRow(db, row.id) : null;
}

function listByJob(db, rawJobId) {
  const ids = resolveJobIds(db, rawJobId);
  const rows = db
    .prepare(
      `SELECT id, server_id, local_uuid, number, document_date, status, language, dirty, updated_at, customer_name,
              server_job_id, local_job_id
       FROM documents WHERE document_type = 'arbeitsnachweis'
         AND (server_job_id = ? OR local_job_id = ?)
       ORDER BY updated_at DESC, id DESC LIMIT 50`,
    )
    .all(ids.serverJobId || -1, ids.localJobId || -1);
  return rows || [];
}

function upsertFromPayload(db, payload, opts) {
  ensureArbeitsnachweisLocalSchema(db);
  opts = opts || {};
  const techId = parseInt(opts.technicianId, 10) || 0;
  const an = (payload && payload.arbeitsnachweis) || {};
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const uuid = String((payload && payload.local_uuid) || '').trim() || newUuid();
  const jobRaw = parseInt(payload && payload.job_id, 10) || 0;
  const ids = resolveJobIds(db, jobRaw);
  const serverDocId = parseInt((payload && (payload.server_id || payload.document_id || payload.id)) || 0, 10) || 0;

  let existing = findByUuid(db, uuid);
  if (!existing && serverDocId > 0) {
    const bySrv = db
      .prepare('SELECT id FROM documents WHERE server_id = ? AND document_type = ?')
      .get(serverDocId, 'arbeitsnachweis');
    if (bySrv) existing = loadRow(db, bySrv.id);
  }
  if (!existing && jobRaw > 0 && opts.reuseJobDraft !== false) {
    existing = findByJob(db, jobRaw);
  }

  const status = String((payload && payload.status) || (existing && existing.document.status) || 'entwurf');
  const language = String((payload && payload.language) || 'de') === 'en' ? 'en' : 'de';
  const customerName = String((payload && payload.customer_name) || '').trim();
  const documentDate = String((payload && payload.document_date) || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const contentVersion = parseInt((payload && payload.content_version) || (existing && existing.document.content_version) || 1, 10) || 1;
  const number = (payload && payload.number) || (existing && existing.document.number) || null;
  const dirty = opts.dirty === false ? 0 : 1;
  const keepServerId = serverDocId > 0 ? serverDocId : existing && existing.document.server_id ? existing.document.server_id : null;

  let id = existing && existing.document.id;
  if (!id) {
    const info = db
      .prepare(
        `INSERT INTO documents (
          server_id, local_job_id, server_job_id, customer_id, document_type, number, document_date, status,
          language, content_version, local_uuid, customer_name, created_by, dirty, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'arbeitsnachweis', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        keepServerId,
        ids.localJobId || null,
        ids.serverJobId || jobRaw || null,
        parseInt(payload && payload.customer_id, 10) || null,
        number,
        documentDate,
        status,
        language,
        contentVersion,
        uuid,
        customerName || null,
        techId || null,
        dirty,
      );
    id = info.lastInsertRowid;
  } else {
    db.prepare(
      `UPDATE documents SET
        server_id = COALESCE(?, server_id),
        local_job_id = COALESCE(?, local_job_id),
        server_job_id = COALESCE(?, server_job_id),
        number = COALESCE(?, number),
        document_date = ?,
        status = ?,
        language = ?,
        content_version = ?,
        local_uuid = COALESCE(NULLIF(?, ''), local_uuid),
        customer_name = COALESCE(NULLIF(?, ''), customer_name),
        dirty = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      keepServerId,
      ids.localJobId || null,
      ids.serverJobId || jobRaw || null,
      number,
      documentDate,
      status,
      language,
      contentVersion,
      uuid,
      customerName,
      dirty,
      id,
    );
  }

  const fabs = Array.isArray(an.fabrikationsnummern) ? an.fabrikationsnummern : [];
  const fabsJson = fabs.length ? JSON.stringify(fabs) : null;
  const timesheetApplied = an.timesheet_applied != null
    ? (an.timesheet_applied ? 1 : 0)
    : existing && existing.arbeitsnachweis && existing.arbeitsnachweis.timesheet_applied
      ? 1
      : 0;
  const anRow = {
    site: an.site || '',
    equipment_type: an.equipment_type || '',
    fabrikationsnummer: an.fabrikationsnummer || '',
    fabrikationsnummern: fabsJson,
    technician_name: an.technician_name || '',
    car_info: an.car_info || '',
    total_km: an.total_km != null && an.total_km !== '' ? parseInt(an.total_km, 10) : null,
    total_km_manual: an.total_km_manual ? 1 : 0,
    start_km: an.start_km != null && an.start_km !== '' ? parseInt(an.start_km, 10) : null,
    end_km: an.end_km != null && an.end_km !== '' ? parseInt(an.end_km, 10) : null,
    living_costs: an.living_costs || '',
    naechtigung_beigestellt: an.naechtigung_beigestellt ? 1 : 0,
    remarks: an.remarks || '',
    timesheet_applied: timesheetApplied,
    save_contact: (function () {
      const incoming = payload && Object.prototype.hasOwnProperty.call(payload, 'save_contact')
        ? payload.save_contact
        : an.save_contact;
      if (incoming === true || incoming === 1 || incoming === '1') return 1;
      if (opts.dirty === false && existing && existing.arbeitsnachweis && existing.arbeitsnachweis.save_contact) return 1;
      if (incoming === false || incoming === 0 || incoming === '0') return 0;
      return existing && existing.arbeitsnachweis && existing.arbeitsnachweis.save_contact ? 1 : 0;
    })(),
    signer_name: (function () {
      const incoming = String((payload && payload.signer_name) || an.signer_name || '').trim();
      if (incoming) return incoming;
      if (opts.dirty === false && existing && existing.arbeitsnachweis && existing.arbeitsnachweis.signer_name) {
        return String(existing.arbeitsnachweis.signer_name);
      }
      return incoming;
    })(),
    signer_email: (function () {
      const incoming = String((payload && payload.signer_email) || an.signer_email || '').trim();
      if (incoming) return incoming;
      if (opts.dirty === false && existing && existing.arbeitsnachweis && existing.arbeitsnachweis.signer_email) {
        return String(existing.arbeitsnachweis.signer_email);
      }
      return incoming;
    })(),
  };
  const existsAn = db.prepare('SELECT 1 FROM document_arbeitsnachweis WHERE document_id = ?').get(id);
  if (existsAn) {
    db.prepare(
      `UPDATE document_arbeitsnachweis SET
        site=?, equipment_type=?, fabrikationsnummer=?, fabrikationsnummern=?, technician_name=?,
        car_info=?, total_km=?, total_km_manual=?, start_km=?, end_km=?, living_costs=?,
        naechtigung_beigestellt=?, remarks=?, timesheet_applied=?, save_contact=?, signer_name=?, signer_email=?
       WHERE document_id=?`,
    ).run(
      anRow.site, anRow.equipment_type, anRow.fabrikationsnummer, anRow.fabrikationsnummern, anRow.technician_name,
      anRow.car_info, anRow.total_km, anRow.total_km_manual, anRow.start_km, anRow.end_km, anRow.living_costs,
      anRow.naechtigung_beigestellt, anRow.remarks, anRow.timesheet_applied, anRow.save_contact,
      anRow.signer_name, anRow.signer_email, id,
    );
  } else {
    db.prepare(
      `INSERT INTO document_arbeitsnachweis (
        document_id, site, equipment_type, fabrikationsnummer, fabrikationsnummern, technician_name,
        car_info, total_km, total_km_manual, start_km, end_km, living_costs, naechtigung_beigestellt,
        remarks, timesheet_applied, save_contact, signer_name, signer_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, anRow.site, anRow.equipment_type, anRow.fabrikationsnummer, anRow.fabrikationsnummern, anRow.technician_name,
      anRow.car_info, anRow.total_km, anRow.total_km_manual, anRow.start_km, anRow.end_km, anRow.living_costs,
      anRow.naechtigung_beigestellt, anRow.remarks, anRow.timesheet_applied, anRow.save_contact,
      anRow.signer_name, anRow.signer_email,
    );
  }

  db.prepare('DELETE FROM document_items WHERE document_id = ?').run(id);
  const insItem = db.prepare(
    `INSERT INTO document_items (
      document_id, item_type, sort_order, description, quantity, unit, item_date, item_time,
      normal_hours, overtime_50, overtime_100, designation, type_no
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  items.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const it = String(row.item_type || 'arbeitszeile');
    if (it !== 'arbeitszeile' && it !== 'ersatzteil' && it !== 'position') return;
    insItem.run(
      id,
      it,
      parseInt(row.sort_order, 10) || i,
      row.description || null,
      row.quantity != null && row.quantity !== '' ? Number(row.quantity) : null,
      row.unit || null,
      row.item_date || null,
      row.item_time || null,
      row.normal_hours != null && row.normal_hours !== '' ? Number(row.normal_hours) : null,
      row.overtime_50 != null && row.overtime_50 !== '' ? Number(row.overtime_50) : null,
      row.overtime_100 != null && row.overtime_100 !== '' ? Number(row.overtime_100) : null,
      row.designation || null,
      row.type_no || null,
    );
  });

  return toPublic(loadRow(db, id));
}

function markSynced(db, localId, serverId, extra) {
  extra = extra || {};
  const n = parseInt(localId, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  db.prepare(
    `UPDATE documents SET dirty = 0, server_id = COALESCE(?, server_id),
      number = COALESCE(?, number), status = COALESCE(?, status),
      content_version = COALESCE(?, content_version),
      local_uuid = COALESCE(NULLIF(?, ''), local_uuid),
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    parseInt(serverId, 10) || null,
    extra.number || null,
    extra.status || null,
    parseInt(extra.content_version, 10) || null,
    extra.local_uuid ? String(extra.local_uuid) : '',
    n,
  );
  clearFailedPending(db, n);
}

function markDirty(db, localId) {
  const n = parseInt(localId, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  db.prepare(`UPDATE documents SET dirty = 1, updated_at = datetime('now') WHERE id = ?`).run(n);
}

function clearFailedPending(db, localId) {
  const n = parseInt(localId, 10);
  if (!Number.isFinite(n) || n <= 0 || !db) return;
  try {
    db.prepare(
      `DELETE FROM pending_changes_failed WHERE entity_type = 'arbeitsnachweis' AND CAST(entity_id AS INTEGER) = ?`,
    ).run(n);
  } catch (_) {
    try {
      db.prepare(
        `DELETE FROM pending_changes_failed WHERE entity_type = 'arbeitsnachweis' AND entity_id = ?`,
      ).run(String(n));
    } catch (_2) {
      /* schema ohne pending_changes_failed */
    }
  }
}

function markTimesheetApplied(db, localId) {
  const n = parseInt(localId, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  db.prepare('UPDATE document_arbeitsnachweis SET timesheet_applied = 1 WHERE document_id = ?').run(n);
  db.prepare(`UPDATE documents SET dirty = 1, updated_at = datetime('now') WHERE id = ?`).run(n);
}

function fromDispoPublic(payload) {
  if (!payload || !payload.document) return null;
  const d = payload.document;
  const an = payload.arbeitsnachweis || {};
  const serverId = parseInt(d.id, 10) || parseInt(payload.document_id, 10) || 0;
  return {
    id: serverId,
    server_id: serverId,
    document_id: serverId,
    local_uuid: d.local_uuid || payload.local_uuid || '',
    job_id: parseInt(d.job_id, 10) || parseInt(payload.job_id, 10) || 0,
    customer_id: parseInt(d.customer_id, 10) || 0,
    status: d.status || 'entwurf',
    language: d.language || 'de',
    customer_name: payload.customer_name || d.customer_name || '',
    document_date: d.document_date || '',
    content_version: d.content_version || 1,
    number: d.number || null,
    save_contact: !!(an.save_contact || payload.save_contact),
    signer_name: an.signer_name || payload.signer_name || '',
    signer_email: an.signer_email || payload.signer_email || '',
    arbeitsnachweis: Object.assign({}, an, {
      signer_name: an.signer_name || payload.signer_name || '',
      signer_email: an.signer_email || payload.signer_email || '',
      save_contact: !!(an.save_contact || payload.save_contact),
    }),
    items: Array.isArray(payload.items) ? payload.items : [],
  };
}

function contentWeight(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const items = Array.isArray(p.items) ? p.items : [];
  const an = p.arbeitsnachweis && typeof p.arbeitsnachweis === 'object' ? p.arbeitsnachweis : {};
  let n = 0;
  items.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    if (row.item_type === 'arbeitszeile') {
      const hrs =
        (parseFloat(row.normal_hours) || 0) +
        (parseFloat(row.overtime_50) || 0) +
        (parseFloat(row.overtime_100) || 0);
      if (String(row.description || '').trim() || String(row.item_time || '').trim() || hrs > 0) n += 3;
      else if (row.item_date) n += 1;
    } else if (row.item_type === 'ersatzteil') {
      if (String(row.designation || '').trim() || parseFloat(row.quantity) > 0) n += 2;
    }
  });
  ['car_info', 'living_costs', 'remarks', 'signer_name'].forEach((k) => {
    if (String(an[k] || '').trim()) n += 2;
  });
  ['start_km', 'end_km', 'total_km'].forEach((k) => {
    if (an[k] != null && an[k] !== '') n += 1;
  });
  return n;
}

function resolveSavePayload(snapshot, localPayload) {
  if (localPayload && (!snapshot || contentWeight(localPayload) >= contentWeight(snapshot))) {
    const meta = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return Object.assign({}, meta, localPayload);
  }
  return snapshot || localPayload || null;
}

function toDispoSavePayload(loaded) {
  if (!loaded || !loaded.document) return null;
  const d = loaded.document;
  const an = loaded.arbeitsnachweis || {};
  return {
    id: d.server_id || 0,
    local_uuid: d.local_uuid,
    job_id: d.server_job_id || 0,
    language: d.language || 'de',
    document_date: d.document_date,
    customer_name: d.customer_name || '',
    signer_name: an.signer_name || '',
    signer_email: an.signer_email || '',
    save_contact: !!an.save_contact,
    arbeitsnachweis: {
      site: an.site || '',
      equipment_type: an.equipment_type || '',
      fabrikationsnummer: an.fabrikationsnummer || '',
      fabrikationsnummern: an.fabrikationsnummern || [],
      technician_name: an.technician_name || '',
      car_info: an.car_info || '',
      living_costs: an.living_costs || '',
      start_km: an.start_km,
      end_km: an.end_km,
      total_km: an.total_km,
      total_km_manual: !!an.total_km_manual,
      naechtigung_beigestellt: !!an.naechtigung_beigestellt,
      remarks: an.remarks || '',
      timesheet_applied: !!an.timesheet_applied,
      signer_name: an.signer_name || '',
      signer_email: an.signer_email || '',
      save_contact: !!an.save_contact,
    },
    items: loaded.items || [],
  };
}

function queuePending(db, localId, action, payload) {
  const n = parseInt(localId, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  db.prepare(
    `DELETE FROM pending_changes WHERE entity_type = 'arbeitsnachweis' AND entity_id = ? AND action = ?`,
  ).run(n, action);
  db.prepare(
    `INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`,
  ).run('arbeitsnachweis', n, action, JSON.stringify(payload || {}));
}

module.exports = {
  ensureArbeitsnachweisLocalSchema,
  upsertFromPayload,
  findByUuid,
  findByJob,
  findLatest,
  listByJob,
  loadRow,
  toPublic,
  fromDispoPublic,
  markSynced,
  markDirty,
  markTimesheetApplied,
  contentWeight,
  resolveSavePayload,
  toDispoSavePayload,
  queuePending,
  clearFailedPending,
  resolveJobIds,
};
