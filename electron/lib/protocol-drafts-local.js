'use strict';

/**
 * Lokale Protokoll-Zwischenstände an FN (SQLite), analog Dispo monteur_protocol_drafts.
 * Legacy-JSON unter Dokumente_Monteur/ wird einmal importiert und danach entfernt.
 */

const fs = require('fs');
const path = require('path');
const {
  readLocalDraftFile,
  isEmptyMonteurDraftPayload,
  stripDraftMeta,
  resolveMonteurDraftJsonPath,
} = require('./multi-device-sync');

const KIND_BY_BASENAME = {
  'serviceprotokoll.json': 'serviceprotokoll',
  'montagebericht.json': 'montagebericht',
  'kontrollwiegungsprotokoll.json': 'kontrollwiegung',
  'schleppkettenprotokoll.json': 'schleppkette',
  'pruefzertifikat.json': 'pruefzertifikat',
};

const SENTINEL_FAB = '';

function kindFromBasename(basename) {
  const base = path.basename(String(basename || '').replace(/\\/g, '/')).toLowerCase();
  return KIND_BY_BASENAME[base] || null;
}

function isByFabKind(kind) {
  return kind !== 'montagebericht';
}

function emptyPayloadForKind(kind) {
  return isByFabKind(kind) ? { byFab: {} } : {};
}

function tryExec(db, sql) {
  try {
    db.exec(sql);
  } catch (_) {
    /* already exists */
  }
}

function ensureProtocolDraftsSchema(db) {
  if (!db) return;
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS protocol_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_job_id INTEGER NOT NULL,
      protocol_kind TEXT NOT NULL,
      fabrikationsnummer TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (local_job_id, protocol_kind, fabrikationsnummer)
    )`,
  );
  tryExec(db, 'ALTER TABLE protocol_drafts ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0');
  tryExec(db, 'ALTER TABLE protocol_drafts ADD COLUMN frozen_at TEXT');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_protocol_drafts_job ON protocol_drafts(local_job_id)');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_protocol_drafts_fab ON protocol_drafts(fabrikationsnummer, protocol_kind)');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_protocol_drafts_fab_frozen ON protocol_drafts(fabrikationsnummer, frozen, frozen_at)');
  tryExec(
    db,
    `CREATE TABLE IF NOT EXISTS protocol_draft_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_job_id INTEGER NOT NULL,
      protocol_kind TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      server_updated_at TEXT,
      extra_json TEXT,
      UNIQUE (local_job_id, protocol_kind)
    )`,
  );
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_protocol_draft_meta_job ON protocol_draft_meta(local_job_id)');
}

function tableHasColumn(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => String(row.name) === column);
  } catch (_) {
    return false;
  }
}

function hasFrozenColumn(db) {
  return tableHasColumn(db, 'protocol_drafts', 'frozen');
}

function jobStatusIsClosed(db, localJobId) {
  try {
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(localJobId);
    const st = String((row && row.status) || '')
      .trim()
      .toLowerCase();
    return st === 'erledigt' || st === 'abgerechnet';
  } catch (_) {
    return false;
  }
}

function freezeJob(db, localJobId) {
  ensureProtocolDraftsSchema(db);
  const id = parseInt(localJobId, 10);
  if (!db || !Number.isFinite(id) || id <= 0 || !hasFrozenColumn(db)) return 0;
  const r = db
    .prepare(
      `UPDATE protocol_drafts
       SET frozen = 1, frozen_at = COALESCE(frozen_at, datetime('now'))
       WHERE local_job_id = ? AND frozen = 0`,
    )
    .run(id);
  return r && r.changes ? r.changes : 0;
}

function jobHasFrozenDrafts(db, localJobId, kind) {
  if (!hasFrozenColumn(db)) return false;
  try {
    const row = kind
      ? db
          .prepare(
            'SELECT COUNT(*) AS n FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ? AND frozen = 1',
          )
          .get(localJobId, kind)
      : db.prepare('SELECT COUNT(*) AS n FROM protocol_drafts WHERE local_job_id = ? AND frozen = 1').get(localJobId);
    return row && Number(row.n) > 0;
  } catch (_) {
    return false;
  }
}

function parseJsonObject(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
  } catch (_) {
    return fallback;
  }
}

function jobFabsFromRow(db, localJobId) {
  const out = [];
  try {
    const row = db.prepare('SELECT fabrikationsnummern FROM jobs WHERE id = ?').get(localJobId);
    const raw = row && row.fabrikationsnummern != null ? String(row.fabrikationsnummern).trim() : '';
    if (!raw) return out;
    if (raw[0] === '[' || raw[0] === '{') {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.fabrikationsnummern;
      if (Array.isArray(list)) {
        for (const item of list) {
          const fab =
            typeof item === 'string' || typeof item === 'number'
              ? String(item).trim()
              : String((item && (item.fabrikationsnummer || item.Fabrikationsnummer)) || '').trim();
          if (fab && !out.includes(fab)) out.push(fab);
        }
      }
      return out;
    }
    for (const part of raw.split(';')) {
      const fab = String(part || '').trim();
      if (fab && !out.includes(fab)) out.push(fab);
    }
  } catch (_) {
    /* ignore */
  }
  return out;
}

function montageberichtFabsFromPayload(payload) {
  const out = [];
  const push = (fab) => {
    const v = String(fab || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const p = payload && typeof payload === 'object' ? payload : {};
  for (const key of ['fabBemerkungen', 'fab_bemerkungen']) {
    const list = p[key];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (typeof row === 'string' || typeof row === 'number') push(row);
      else if (row && typeof row === 'object') {
        push(row.fabrikationsnummer || row.Fabrikationsnummer || row.fab);
      }
    }
  }
  const kopf = p.kopfdaten && typeof p.kopfdaten === 'object' ? p.kopfdaten : p;
  const list = kopf.fabrikationsnummern || p.fabrikationsnummern || p.fabs;
  if (Array.isArray(list)) {
    for (const row of list) {
      if (typeof row === 'string' || typeof row === 'number') push(row);
      else if (row && typeof row === 'object') push(row.fabrikationsnummer || row.Fabrikationsnummer);
    }
  } else if (typeof list === 'string' && list.trim()) {
    String(list)
      .split(/[,;\s]+/)
      .forEach((part) => push(part));
  }
  return out;
}

function montageberichtTargetFabs(db, localJobId, payload) {
  const all = [];
  for (const fab of montageberichtFabsFromPayload(payload).concat(jobFabsFromRow(db, localJobId))) {
    if (fab && !all.includes(fab)) all.push(fab);
  }
  return all.length ? all : [SENTINEL_FAB];
}

function deleteLegacyDraftFiles(reiseDir, basename) {
  if (!reiseDir) return;
  const base = path.basename(String(basename || '').replace(/\\/g, '/'));
  const candidates = [
    path.join(reiseDir, 'Dokumente_Monteur', base),
    path.join(reiseDir, base),
    path.join(reiseDir, 'Dokumente_Dispo', base),
    path.join(reiseDir, 'Dokumente_Anlage', base),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) fs.unlinkSync(cand);
    } catch (_) {
      /* ignore */
    }
  }
}

function readMetaRow(db, localJobId, kind) {
  try {
    return (
      db
        .prepare(
          'SELECT revision, server_updated_at, extra_json FROM protocol_draft_meta WHERE local_job_id = ? AND protocol_kind = ?',
        )
        .get(localJobId, kind) || null
    );
  } catch (_) {
    return null;
  }
}

function upsertRow(db, localJobId, kind, fab, payload) {
  if (hasFrozenColumn(db)) {
    db.prepare(
      `INSERT INTO protocol_drafts (local_job_id, protocol_kind, fabrikationsnummer, payload_json, updated_at, frozen)
       VALUES (?, ?, ?, ?, datetime('now'), 0)
       ON CONFLICT(local_job_id, protocol_kind, fabrikationsnummer)
       DO UPDATE SET
         payload_json = CASE WHEN protocol_drafts.frozen = 1 THEN protocol_drafts.payload_json ELSE excluded.payload_json END,
         updated_at = CASE WHEN protocol_drafts.frozen = 1 THEN protocol_drafts.updated_at ELSE datetime('now') END`,
    ).run(localJobId, kind, fab, JSON.stringify(payload || {}));
    return;
  }
  db.prepare(
    `INSERT INTO protocol_drafts (local_job_id, protocol_kind, fabrikationsnummer, payload_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(local_job_id, protocol_kind, fabrikationsnummer)
     DO UPDATE SET payload_json = excluded.payload_json, updated_at = datetime('now')`,
  ).run(localJobId, kind, fab, JSON.stringify(payload || {}));
}

function upsertMeta(db, localJobId, kind, revision, serverUpdatedAt, extra) {
  const extraJson = extra && typeof extra === 'object' && Object.keys(extra).length ? JSON.stringify(extra) : null;
  db.prepare(
    `INSERT INTO protocol_draft_meta (local_job_id, protocol_kind, revision, server_updated_at, extra_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(local_job_id, protocol_kind)
     DO UPDATE SET revision = excluded.revision, server_updated_at = excluded.server_updated_at, extra_json = excluded.extra_json`,
  ).run(localJobId, kind, Math.max(0, parseInt(revision, 10) || 0), serverUpdatedAt || null, extraJson);
}

function deleteKindRows(db, localJobId, kind) {
  if (hasFrozenColumn(db)) {
    db.prepare('DELETE FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ? AND frozen = 0').run(
      localJobId,
      kind,
    );
    return;
  }
  db.prepare('DELETE FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ?').run(localJobId, kind);
}

function persistPayload(db, localJobId, kind, payload, revision, serverUpdatedAt) {
  const keep = [];
  let extra = {};
  if (isByFabKind(kind)) {
    const byFab = payload && payload.byFab && typeof payload.byFab === 'object' ? payload.byFab : {};
    for (const [fabRaw, draft] of Object.entries(byFab)) {
      const fab = String(fabRaw || '').trim();
      if (!fab || !draft || typeof draft !== 'object') continue;
      upsertRow(db, localJobId, kind, fab, draft);
      keep.push(fab);
    }
    extra = Object.assign({}, stripDraftMeta(payload || {}));
    delete extra.byFab;
  } else {
    const fabs = montageberichtTargetFabs(db, localJobId, payload);
    for (const fab of fabs) {
      upsertRow(db, localJobId, kind, fab, stripDraftMeta(payload || {}));
      keep.push(fab);
    }
  }
  if (!keep.length) {
    deleteKindRows(db, localJobId, kind);
  } else {
    const placeholders = keep.map(() => '?').join(',');
    const frozenSql = hasFrozenColumn(db) ? ' AND frozen = 0' : '';
    db.prepare(
      `DELETE FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ? AND fabrikationsnummer NOT IN (${placeholders})${frozenSql}`,
    ).run(localJobId, kind, ...keep);
  }
  upsertMeta(db, localJobId, kind, revision, serverUpdatedAt, extra);
}

function assembleFromDb(db, localJobId, kind) {
  const meta = readMetaRow(db, localJobId, kind);
  const rows =
    db
      .prepare(
        `SELECT fabrikationsnummer, payload_json, updated_at
         FROM protocol_drafts
         WHERE local_job_id = ? AND protocol_kind = ?
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(localJobId, kind) || [];
  const extra = parseJsonObject(meta && meta.extra_json, {});
  const revision = meta ? parseInt(meta.revision, 10) || 0 : 0;
  const serverUpdated = meta && meta.server_updated_at ? String(meta.server_updated_at) : null;
  let localUpdatedAt = null;
  for (const row of rows) {
    const t = row && row.updated_at ? String(row.updated_at).trim() : '';
    if (t && (!localUpdatedAt || t > localUpdatedAt)) localUpdatedAt = t;
  }
  if (!rows.length && revision <= 0) {
    return { payload: emptyPayloadForKind(kind), revision: 0, server_updated_at: null, local_updated_at: null };
  }
  if (isByFabKind(kind)) {
    const byFab = {};
    let maxLocal = 0;
    for (const row of rows) {
      const fab = String(row.fabrikationsnummer || '').trim();
      if (!fab) continue;
      const draft = parseJsonObject(row.payload_json, null);
      if (!draft) continue;
      byFab[fab] = draft;
      const lid = parseInt(draft.local_id, 10) || 0;
      if (lid > maxLocal) maxLocal = lid;
    }
    const payload = Object.assign({}, extra, { byFab });
    let next = parseInt(extra.nextLocalId, 10) || 0;
    if (next < maxLocal + 1) next = maxLocal + 1;
    if (next > 1 || extra.nextLocalId != null) payload.nextLocalId = Math.max(1, next);
    return { payload, revision, server_updated_at: serverUpdated, local_updated_at: localUpdatedAt };
  }
  let payload = {};
  for (const row of rows) {
    const decoded = parseJsonObject(row.payload_json, null);
    if (decoded && Object.keys(decoded).length) {
      payload = decoded;
      break;
    }
  }
  if (!Object.keys(payload).length && extra && Object.keys(extra).length) payload = extra;
  return { payload, revision, server_updated_at: serverUpdated, local_updated_at: localUpdatedAt };
}

function importLegacyFile(db, localJobId, basename, reiseDir) {
  const kind = kindFromBasename(basename);
  if (!kind) return;
  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ?')
    .get(localJobId, kind);
  const hasRows = countRow && Number(countRow.n) > 0;
  let fileMeta = { payload: {}, revision: 0, server_updated_at: null };
  if (reiseDir) {
    try {
      const filePath = resolveMonteurDraftJsonPath(reiseDir, basename, false);
      fileMeta = readLocalDraftFile(filePath);
    } catch (_) {
      /* ignore */
    }
  }
  const empty = isEmptyMonteurDraftPayload(fileMeta.payload);
  if (hasRows || empty) {
    deleteLegacyDraftFiles(reiseDir, basename);
    return;
  }
  persistPayload(
    db,
    localJobId,
    kind,
    stripDraftMeta(fileMeta.payload),
    Math.max(1, parseInt(fileMeta.revision, 10) || 1),
    fileMeta.server_updated_at || new Date().toISOString(),
  );
  deleteLegacyDraftFiles(reiseDir, basename);
}

function readDraft(db, localJobId, basename, reiseDir) {
  ensureProtocolDraftsSchema(db);
  const kind = kindFromBasename(basename);
  if (!kind || !localJobId) {
    return { payload: {}, revision: 0, server_updated_at: null, local_updated_at: null };
  }
  importLegacyFile(db, localJobId, basename, reiseDir);
  return assembleFromDb(db, localJobId, kind);
}

function writeDraft(db, localJobId, basename, payload, revision, serverUpdatedAt, reiseDir) {
  ensureProtocolDraftsSchema(db);
  const kind = kindFromBasename(basename);
  if (!kind || !localJobId) return { ok: false };
  const closed = jobStatusIsClosed(db, localJobId);
  if (closed) freezeJob(db, localJobId);
  const clean = stripDraftMeta(payload && typeof payload === 'object' ? payload : {});
  const empty = isEmptyMonteurDraftPayload(clean);
  const rev = Math.max(0, parseInt(revision, 10) || 0);
  const ts = serverUpdatedAt || new Date().toISOString();
  if (empty && jobHasFrozenDrafts(db, localJobId, kind)) {
    const current = assembleFromDb(db, localJobId, kind);
    return {
      ok: false,
      code: 'draft_frozen',
      payload: current.payload,
      revision: current.revision,
      server_updated_at: current.server_updated_at,
    };
  }
  if (empty && rev <= 0) {
    deleteKindRows(db, localJobId, kind);
    const left = db
      .prepare('SELECT COUNT(*) AS n FROM protocol_drafts WHERE local_job_id = ? AND protocol_kind = ?')
      .get(localJobId, kind);
    if (!left || Number(left.n) === 0) {
      db.prepare('DELETE FROM protocol_draft_meta WHERE local_job_id = ? AND protocol_kind = ?').run(localJobId, kind);
    }
    deleteLegacyDraftFiles(reiseDir, basename);
    return { ok: true, payload: emptyPayloadForKind(kind), revision: 0, server_updated_at: null };
  }
  if (empty) {
    deleteKindRows(db, localJobId, kind);
    upsertMeta(db, localJobId, kind, rev, ts, null);
    deleteLegacyDraftFiles(reiseDir, basename);
    return { ok: true, payload: emptyPayloadForKind(kind), revision: rev, server_updated_at: ts };
  }
  persistPayload(db, localJobId, kind, clean, rev, ts);
  if (closed) freezeJob(db, localJobId);
  deleteLegacyDraftFiles(reiseDir, basename);
  return { ok: true, payload: clean, revision: rev, server_updated_at: ts };
}

function listDraftsForJob(db, localJobId) {
  ensureProtocolDraftsSchema(db);
  const out = [];
  for (const [basename, kind] of Object.entries(KIND_BY_BASENAME)) {
    const assembled = assembleFromDb(db, localJobId, kind);
    if (isEmptyMonteurDraftPayload(assembled.payload) && assembled.revision <= 0) continue;
    out.push({
      basename,
      kind,
      revision: assembled.revision,
      server_updated_at: assembled.server_updated_at,
      local_updated_at: assembled.local_updated_at,
      payload: assembled.payload,
    });
  }
  return out;
}

function readStore(db, localJobId, basename, reiseDir) {
  const meta = readDraft(db, localJobId, basename, reiseDir);
  const kind = kindFromBasename(basename);
  const payload = meta.payload && typeof meta.payload === 'object' ? meta.payload : emptyPayloadForKind(kind);
  if (isByFabKind(kind)) {
    if (!payload.byFab || typeof payload.byFab !== 'object') payload.byFab = {};
    if (!payload.nextLocalId) payload.nextLocalId = 1;
  }
  return payload;
}

function writeStore(db, localJobId, basename, store, reiseDir) {
  if (jobStatusIsClosed(db, localJobId)) {
    freezeJob(db, localJobId);
    const prev = readDraft(db, localJobId, basename, reiseDir);
    return { ok: false, code: 'draft_frozen', payload: prev.payload, revision: prev.revision, server_updated_at: prev.server_updated_at };
  }
  const prev = readDraft(db, localJobId, basename, reiseDir);
  const empty = isEmptyMonteurDraftPayload(store);
  const nextRev = empty && prev.revision <= 0 ? 0 : Math.max(1, (parseInt(prev.revision, 10) || 0) + 1);
  return writeDraft(db, localJobId, basename, store, nextRev, new Date().toISOString(), reiseDir);
}

module.exports = {
  KIND_BY_BASENAME,
  SENTINEL_FAB,
  kindFromBasename,
  ensureProtocolDraftsSchema,
  freezeJob,
  jobStatusIsClosed,
  readDraft,
  writeDraft,
  readStore,
  writeStore,
  listDraftsForJob,
  importLegacyFile,
  deleteLegacyDraftFiles,
};
