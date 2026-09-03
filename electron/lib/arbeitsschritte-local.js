'use strict';

const GRUNDSTOCK_STEPS = [
  ['Kontrolle der Wägebrücke', 'check of weighing bridge'],
  ['Kontrolle des Fördergurtes', 'check of conveyor belt'],
  ['Reinigen der Waage', 'cleaning of the scale'],
  ['Kontr. der Rollen & Rollenflucht', 'check of rollers & roller aligment'],
  ['Zustand der Bandabstreifer', 'condition of belt scrapers'],
  ['Trommelkratzer', 'drum scraper'],
  ['Abstreifpflug', 'scraper plough'],
  ['Bandspannung', 'belt tensioning'],
  ['Bandlenkung', 'belt steering device'],
  ['Schmierstellen', 'lubrication points'],
  ['Kraftaufnehmer', 'load cell'],
  ['Tacho', 'tacho'],
  ['Schieflaufschalter', 'belt misalignment switch'],
  ['Kettentriebe', 'chain drives'],
  ['Überlastschutz', 'overload protection'],
  ['Wiegeelektronik', 'weighing electronics'],
  ['Tara', 'tare'],
  ['PGW-Test', 'test with test weight'],
  ['Regelung & Dosierung', 'control & dosing'],
  ['Kontrollwiegungen', 'check weighing procedures'],
  ['Kontrolle der Zellenradschleuse', 'check of rotary vane feeder'],
];

function combineBezeichnung(de, en) {
  de = String(de || '').trim();
  en = String(en || '').trim();
  if (!de) return en;
  if (!en) return de;
  return de + ' / ' + en;
}

function normalizeCatalogKind(kind) {
  return String(kind || 'service').toLowerCase() === 'ibn' ? 'ibn' : 'service';
}

function addCatalogKindColumn(db, table) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN catalog_kind TEXT NOT NULL DEFAULT 'service'`);
  } catch (_) {
    /* already exists */
  }
}

function ensureArbeitsschritteSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arbeitsschritte_global (
      id INTEGER PRIMARY KEY,
      bezeichnung_de TEXT NOT NULL,
      bezeichnung_en TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT,
      catalog_kind TEXT NOT NULL DEFAULT 'service'
    );
    CREATE TABLE IF NOT EXISTS arbeitsschritte_user (
      id INTEGER PRIMARY KEY,
      technician_id INTEGER NOT NULL,
      bezeichnung_de TEXT NOT NULL,
      bezeichnung_en TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT,
      catalog_kind TEXT NOT NULL DEFAULT 'service'
    );
    CREATE TABLE IF NOT EXISTS arbeitsschritte_preset_global (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type_code TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT,
      catalog_kind TEXT NOT NULL DEFAULT 'service'
    );
    CREATE TABLE IF NOT EXISTS arbeitsschritte_preset_user (
      id INTEGER PRIMARY KEY,
      technician_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type_code TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT,
      catalog_kind TEXT NOT NULL DEFAULT 'service'
    );
    CREATE TABLE IF NOT EXISTS arbeitsschritte_preset_step (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preset_scope TEXT NOT NULL,
      preset_id INTEGER NOT NULL,
      step_scope TEXT NOT NULL,
      step_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(preset_scope, preset_id, step_scope, step_id)
    );
    CREATE INDEX IF NOT EXISTS idx_as_global_sort ON arbeitsschritte_global(sort_order);
    CREATE INDEX IF NOT EXISTS idx_as_user_tech ON arbeitsschritte_user(technician_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_as_global_kind_sort ON arbeitsschritte_global(catalog_kind, sort_order);
    CREATE INDEX IF NOT EXISTS idx_as_user_kind_tech ON arbeitsschritte_user(catalog_kind, technician_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_as_preset_global_kind ON arbeitsschritte_preset_global(catalog_kind, type_code);
    CREATE INDEX IF NOT EXISTS idx_as_preset_user_kind ON arbeitsschritte_preset_user(catalog_kind, type_code);
  `);
  addCatalogKindColumn(db, 'arbeitsschritte_global');
  addCatalogKindColumn(db, 'arbeitsschritte_user');
  addCatalogKindColumn(db, 'arbeitsschritte_preset_global');
  addCatalogKindColumn(db, 'arbeitsschritte_preset_user');
  seedGrundstockIfEmpty(db);
}

function seedGrundstockIfEmpty(db) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM arbeitsschritte_global WHERE catalog_kind = 'service'`).get();
  if (row && row.c > 0) return;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ins = db.prepare(
    `INSERT INTO arbeitsschritte_global (id, bezeichnung_de, bezeichnung_en, sort_order, server_id, updated_at, catalog_kind)
     VALUES (?, ?, ?, ?, ?, ?, 'service')`,
  );
  GRUNDSTOCK_STEPS.forEach(function (pair, idx) {
    const id = idx + 1;
    ins.run(id, pair[0], pair[1], idx + 1, id, now);
  });
}

function mapGlobalSteps(db, catalogKind) {
  const kind = normalizeCatalogKind(catalogKind);
  return db
    .prepare(`SELECT id, bezeichnung_de, bezeichnung_en, sort_order FROM arbeitsschritte_global WHERE catalog_kind = ? ORDER BY sort_order, id`)
    .all(kind)
    .map(function (row) {
      return {
        id: row.id,
        bezeichnung_de: row.bezeichnung_de,
        bezeichnung_en: row.bezeichnung_en,
        bezeichnung: combineBezeichnung(row.bezeichnung_de, row.bezeichnung_en),
        sort_order: row.sort_order,
        scope: 'global',
      };
    });
}

function mapUserSteps(db, technicianId, catalogKind) {
  const tid = parseInt(technicianId, 10);
  const kind = normalizeCatalogKind(catalogKind);
  if (!tid) return [];
  return db
    .prepare(
      `SELECT id, bezeichnung_de, bezeichnung_en, sort_order, server_id
       FROM arbeitsschritte_user WHERE technician_id = ? AND catalog_kind = ? ORDER BY sort_order, id`,
    )
    .all(tid, kind)
    .map(function (row) {
      return {
        id: row.id,
        bezeichnung_de: row.bezeichnung_de,
        bezeichnung_en: row.bezeichnung_en,
        bezeichnung: combineBezeichnung(row.bezeichnung_de, row.bezeichnung_en),
        sort_order: row.sort_order,
        scope: 'user',
        server_id: row.server_id,
      };
    });
}

function presetStepRefs(db, presetScope, presetId) {
  return db
    .prepare(
      `SELECT step_scope, step_id, sort_order FROM arbeitsschritte_preset_step
       WHERE preset_scope = ? AND preset_id = ? ORDER BY sort_order, id`,
    )
    .all(presetScope, presetId)
    .map(function (row) {
      return {
        step_scope: row.step_scope,
        step_id: row.step_id,
        sort_order: row.sort_order,
      };
    });
}

function listPresets(db, technicianId, catalogKind) {
  const kind = normalizeCatalogKind(catalogKind);
  const presets = [];
  const globalPresets = db
    .prepare(`SELECT id, name, type_code, sort_order FROM arbeitsschritte_preset_global WHERE catalog_kind = ? ORDER BY sort_order, id`)
    .all(kind);
  globalPresets.forEach(function (p) {
    presets.push({
      id: p.id,
      name: p.name,
      type_code: p.type_code,
      sort_order: p.sort_order,
      scope: 'global',
      step_refs: presetStepRefs(db, 'global', p.id),
    });
  });
  const tid = parseInt(technicianId, 10);
  if (tid > 0) {
    db.prepare(
      `SELECT id, name, type_code, sort_order FROM arbeitsschritte_preset_user
       WHERE technician_id = ? AND catalog_kind = ? ORDER BY sort_order, id`,
    )
      .all(tid, kind)
      .forEach(function (p) {
        presets.push({
          id: p.id,
          name: p.name,
          type_code: p.type_code,
          sort_order: p.sort_order,
          scope: 'user',
          step_refs: presetStepRefs(db, 'user', p.id),
        });
      });
  }
  return presets;
}

function listArbeitsschritteLocal(db, technicianId, catalogKind) {
  ensureArbeitsschritteSchema(db);
  const kind = normalizeCatalogKind(catalogKind);
  return {
    ok: true,
    catalog_kind: kind,
    steps: mapGlobalSteps(db, kind).concat(mapUserSteps(db, technicianId, kind)),
    presets: listPresets(db, technicianId, kind),
  };
}

function replacePresetStepsLocal(db, presetScope, presetId, stepRefs) {
  db.prepare(`DELETE FROM arbeitsschritte_preset_step WHERE preset_scope = ? AND preset_id = ?`).run(
    presetScope,
    presetId,
  );
  const ins = db.prepare(
    `INSERT INTO arbeitsschritte_preset_step (preset_scope, preset_id, step_scope, step_id, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let order = 1;
  (stepRefs || []).forEach(function (ref) {
    const stepScope = String(ref.step_scope || 'global').toLowerCase() === 'user' ? 'user' : 'global';
    const stepId = parseInt(ref.step_id, 10);
    if (!stepId) return;
    const sort = parseInt(ref.sort_order, 10) || order;
    ins.run(presetScope, presetId, stepScope, stepId, sort);
    order++;
  });
}

function mergeArbeitsschritteFromRemote(db, technicianId, remoteData) {
  ensureArbeitsschritteSchema(db);
  const tid = parseInt(technicianId, 10);
  if (!remoteData) return;
  const kind = normalizeCatalogKind(remoteData.catalog_kind);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  (remoteData.steps || []).forEach(function (step) {
    const scope = String(step.scope || 'user').toLowerCase();
    const sid = parseInt(step.id, 10);
    if (!sid) return;
    if (scope === 'global') {
      db.prepare(
        `INSERT INTO arbeitsschritte_global (id, bezeichnung_de, bezeichnung_en, sort_order, server_id, updated_at, catalog_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bezeichnung_de = excluded.bezeichnung_de,
           bezeichnung_en = excluded.bezeichnung_en, sort_order = excluded.sort_order,
           server_id = excluded.server_id, updated_at = excluded.updated_at,
           catalog_kind = excluded.catalog_kind`,
      ).run(
        sid,
        String(step.bezeichnung_de || ''),
        String(step.bezeichnung_en || ''),
        parseInt(step.sort_order, 10) || 0,
        sid,
        now,
        kind,
      );
    } else if (tid > 0) {
      const existing = db
        .prepare(`SELECT id FROM arbeitsschritte_user WHERE technician_id = ? AND server_id = ? AND catalog_kind = ?`)
        .get(tid, sid, kind);
      if (existing) {
        db.prepare(
          `UPDATE arbeitsschritte_user SET bezeichnung_de = ?, bezeichnung_en = ?, sort_order = ?, updated_at = ?, catalog_kind = ?
           WHERE id = ?`,
        ).run(
          String(step.bezeichnung_de || ''),
          String(step.bezeichnung_en || ''),
          parseInt(step.sort_order, 10) || 0,
          now,
          kind,
          existing.id,
        );
      } else {
        db.prepare(
          `INSERT INTO arbeitsschritte_user (technician_id, bezeichnung_de, bezeichnung_en, sort_order, server_id, updated_at, catalog_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          tid,
          String(step.bezeichnung_de || ''),
          String(step.bezeichnung_en || ''),
          parseInt(step.sort_order, 10) || 0,
          sid,
          now,
          kind,
        );
      }
    }
  });

  db.prepare(
    `DELETE FROM arbeitsschritte_preset_step WHERE preset_scope = 'global'
     AND preset_id IN (SELECT id FROM arbeitsschritte_preset_global WHERE catalog_kind = ?)`,
  ).run(kind);
  db.prepare(`DELETE FROM arbeitsschritte_preset_global WHERE catalog_kind = ?`).run(kind);

  const remoteUserPresetServerIds = new Set();
  const pendingPresetEntityIds = new Set();
  if (tid > 0) {
    try {
      const pend = db
        .prepare(
          `SELECT entity_id FROM pending_changes
           WHERE entity_type = 'arbeitsschritte' AND action IN ('preset_save','preset_delete')`,
        )
        .all();
      for (const p of pend) pendingPresetEntityIds.add(String(p.entity_id));
    } catch (_) {
      /* ignore */
    }
  }

  (remoteData.presets || []).forEach(function (preset) {
    const scope = String(preset.scope || 'user').toLowerCase() === 'global' ? 'global' : 'user';
    const sid = parseInt(preset.id, 10);
    if (!sid) return;
    if (scope === 'global') {
      db.prepare(
        `INSERT INTO arbeitsschritte_preset_global (id, name, type_code, sort_order, server_id, updated_at, catalog_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type_code = excluded.type_code,
           sort_order = excluded.sort_order, server_id = excluded.server_id, updated_at = excluded.updated_at,
           catalog_kind = excluded.catalog_kind`,
      ).run(
        sid,
        String(preset.name || ''),
        String(preset.type_code || '').slice(0, 6),
        parseInt(preset.sort_order, 10) || 0,
        sid,
        now,
        kind,
      );
      replacePresetStepsLocal(db, 'global', sid, preset.step_refs || []);
    } else if (tid > 0) {
      remoteUserPresetServerIds.add(sid);
      const existing = db
        .prepare(`SELECT id FROM arbeitsschritte_preset_user WHERE technician_id = ? AND server_id = ? AND catalog_kind = ?`)
        .get(tid, sid, kind);
      let localId = existing ? existing.id : null;
      if (localId && pendingPresetEntityIds.has(String(localId))) {
        return; // Pending-Save behalten
      }
      if (localId) {
        db.prepare(
          `UPDATE arbeitsschritte_preset_user SET name = ?, type_code = ?, sort_order = ?, updated_at = ?, catalog_kind = ? WHERE id = ?`,
        ).run(
          String(preset.name || ''),
          String(preset.type_code || '').slice(0, 6),
          parseInt(preset.sort_order, 10) || 0,
          now,
          kind,
          localId,
        );
      } else {
        const ins = db
          .prepare(
            `INSERT INTO arbeitsschritte_preset_user (technician_id, name, type_code, sort_order, server_id, updated_at, catalog_kind)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tid,
            String(preset.name || ''),
            String(preset.type_code || '').slice(0, 6),
            parseInt(preset.sort_order, 10) || 0,
            sid,
            now,
            kind,
          );
        localId = ins.lastInsertRowid;
      }
      replacePresetStepsLocal(db, 'user', localId, preset.step_refs || []);
    }
  });

  // Nur User-Presets mit server_id entfernen, die nicht mehr auf Dispo sind und kein Pending haben.
  // Lokale Negativ-IDs / Presets ohne server_id bleiben.
  if (tid > 0) {
    const localUserPresets = db
      .prepare(`SELECT id, server_id FROM arbeitsschritte_preset_user WHERE technician_id = ? AND catalog_kind = ?`)
      .all(tid, kind);
    for (const row of localUserPresets) {
      if (pendingPresetEntityIds.has(String(row.id))) continue;
      if (row.server_id == null || row.server_id === '') continue;
      const sid = parseInt(row.server_id, 10);
      if (!sid || remoteUserPresetServerIds.has(sid)) continue;
      db.prepare(`DELETE FROM arbeitsschritte_preset_step WHERE preset_scope = 'user' AND preset_id = ?`).run(row.id);
      db.prepare(`DELETE FROM arbeitsschritte_preset_user WHERE id = ? AND technician_id = ?`).run(row.id, tid);
    }
  }
}

function nextLocalStepId(db) {
  const row = db.prepare(`SELECT MIN(id) AS m FROM arbeitsschritte_user WHERE id < 0`).get();
  const m = row && row.m != null ? parseInt(row.m, 10) : 0;
  return m < 0 ? m - 1 : -1;
}

function nextLocalPresetId(db) {
  const row = db.prepare(`SELECT MIN(id) AS m FROM arbeitsschritte_preset_user WHERE id < 0`).get();
  const m = row && row.m != null ? parseInt(row.m, 10) : 0;
  return m < 0 ? m - 1 : -1;
}

function saveStepLocal(db, technicianId, body) {
  const tid = parseInt(technicianId, 10);
  if (!tid) throw new Error('technician_id erforderlich.');
  const de = String(body.bezeichnung_de || '').trim();
  const en = String(body.bezeichnung_en || '').trim();
  if (!de && !en) throw new Error('bezeichnung_de erforderlich.');
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  const kind = normalizeCatalogKind(body.catalog_kind);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let id = parseInt(body.id, 10);
  if (id > 0) {
    db.prepare(
      `UPDATE arbeitsschritte_user SET bezeichnung_de = ?, bezeichnung_en = ?, sort_order = ?, updated_at = ?, catalog_kind = ?
       WHERE id = ? AND technician_id = ?`,
    ).run(de, en, sortOrder, now, kind, id, tid);
  } else {
    id = nextLocalStepId(db);
    db.prepare(
      `INSERT INTO arbeitsschritte_user (id, technician_id, bezeichnung_de, bezeichnung_en, sort_order, updated_at, catalog_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tid, de, en, sortOrder, now, kind);
  }
  return { ok: true, id, scope: 'user' };
}

function deleteStepLocal(db, technicianId, stepId) {
  const tid = parseInt(technicianId, 10);
  const id = parseInt(stepId, 10);
  db.prepare(`DELETE FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`).run(id, tid);
  db.prepare(`DELETE FROM arbeitsschritte_preset_step WHERE step_scope = 'user' AND step_id = ?`).run(id);
  return { ok: true };
}

function promoteUserStepToGlobal(db, technicianId, localUserId, globalId) {
  const tid = parseInt(technicianId, 10);
  const uid = parseInt(localUserId, 10);
  const gid = parseInt(globalId, 10);
  if (!tid || !uid || !(gid > 0)) throw new Error('id erforderlich.');
  const row = db
    .prepare(
      `SELECT bezeichnung_de, bezeichnung_en, sort_order FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`,
    )
    .get(uid, tid);
  if (!row) throw new Error('Schritt nicht gefunden.');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const kindRow = db
    .prepare(`SELECT catalog_kind FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`)
    .get(uid, tid);
  const kind = normalizeCatalogKind(kindRow && kindRow.catalog_kind);
  db.prepare(
    `INSERT INTO arbeitsschritte_global (id, bezeichnung_de, bezeichnung_en, sort_order, server_id, updated_at, catalog_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET bezeichnung_de = excluded.bezeichnung_de,
       bezeichnung_en = excluded.bezeichnung_en, sort_order = excluded.sort_order,
       server_id = excluded.server_id, updated_at = excluded.updated_at,
       catalog_kind = excluded.catalog_kind`,
  ).run(gid, String(row.bezeichnung_de || ''), String(row.bezeichnung_en || ''), parseInt(row.sort_order, 10) || 0, gid, now, kind);

  const refs = db
    .prepare(
      `SELECT preset_scope, preset_id, sort_order FROM arbeitsschritte_preset_step WHERE step_scope = 'user' AND step_id = ?`,
    )
    .all(uid);
  refs.forEach(function (ref) {
    const exists = db
      .prepare(
        `SELECT id FROM arbeitsschritte_preset_step
         WHERE preset_scope = ? AND preset_id = ? AND step_scope = 'global' AND step_id = ?`,
      )
      .get(ref.preset_scope, ref.preset_id, gid);
    if (exists) {
      db.prepare(
        `DELETE FROM arbeitsschritte_preset_step
         WHERE preset_scope = ? AND preset_id = ? AND step_scope = 'user' AND step_id = ?`,
      ).run(ref.preset_scope, ref.preset_id, uid);
    } else {
      db.prepare(
        `UPDATE arbeitsschritte_preset_step SET step_scope = 'global', step_id = ?
         WHERE preset_scope = ? AND preset_id = ? AND step_scope = 'user' AND step_id = ?`,
      ).run(gid, ref.preset_scope, ref.preset_id, uid);
    }
  });
  db.prepare(`DELETE FROM arbeitsschritte_preset_step WHERE step_scope = 'user' AND step_id = ?`).run(uid);
  db.prepare(`DELETE FROM arbeitsschritte_user WHERE id = ? AND technician_id = ?`).run(uid, tid);
  return { ok: true, id: gid, scope: 'global' };
}

function savePresetLocal(db, technicianId, body) {
  const tid = parseInt(technicianId, 10);
  if (!tid) throw new Error('technician_id erforderlich.');
  const name = String(body.name || '').trim();
  const typeCode = String(body.type_code || '').trim().slice(0, 6);
  if (!name || !typeCode) throw new Error('name und type_code erforderlich.');
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  const kind = normalizeCatalogKind(body.catalog_kind);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let id = parseInt(body.id, 10);
  const stepRefs = Array.isArray(body.step_refs) ? body.step_refs : [];
  if (id > 0) {
    db.prepare(
      `UPDATE arbeitsschritte_preset_user SET name = ?, type_code = ?, sort_order = ?, updated_at = ?, catalog_kind = ?
       WHERE id = ? AND technician_id = ?`,
    ).run(name, typeCode, sortOrder, now, kind, id, tid);
  } else {
    id = nextLocalPresetId(db);
    db.prepare(
      `INSERT INTO arbeitsschritte_preset_user (id, technician_id, name, type_code, sort_order, updated_at, catalog_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tid, name, typeCode, sortOrder, now, kind);
  }
  replacePresetStepsLocal(db, 'user', id, stepRefs);
  return { ok: true, id };
}

function deletePresetLocal(db, technicianId, presetId) {
  const tid = parseInt(technicianId, 10);
  const id = parseInt(presetId, 10);
  db.prepare(`DELETE FROM arbeitsschritte_preset_step WHERE preset_scope = 'user' AND preset_id = ?`).run(id);
  db.prepare(`DELETE FROM arbeitsschritte_preset_user WHERE id = ? AND technician_id = ?`).run(id, tid);
  return { ok: true };
}

function queueArbeitsschrittePending(db, entityId, action, payload) {
  db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
    'arbeitsschritte',
    String(entityId),
    action,
    JSON.stringify(payload),
  );
}

function findMatchingPresetLocal(db, technicianId, anlagenType, catalogKind) {
  const haystack = String(anlagenType || '').trim();
  if (!haystack) return null;
  const data = listArbeitsschritteLocal(db, technicianId, catalogKind);
  const candidates = [];
  (data.presets || []).forEach(function (p) {
    const code = String(p.type_code || '').trim();
    if (!code) return;
    if (haystack.toLowerCase().indexOf(code.toLowerCase()) === -1) return;
    candidates.push({
      preset_scope: p.scope === 'global' ? 'global' : 'user',
      preset_id: p.id,
      type_code: code,
      name: p.name,
      sort_order: p.sort_order || 0,
      priority: p.scope === 'global' ? 1 : 0,
    });
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) {
    if (b.type_code.length !== a.type_code.length) return b.type_code.length - a.type_code.length;
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.preset_id - b.preset_id;
  });
  return candidates[0];
}

function presetStepsAsDefaults(db, presetScope, presetId) {
  const refs = presetStepRefs(db, presetScope, presetId);
  const out = [];
  refs.forEach(function (ref) {
    const table = ref.step_scope === 'user' ? 'arbeitsschritte_user' : 'arbeitsschritte_global';
    const row = db.prepare(`SELECT bezeichnung_de, bezeichnung_en FROM ${table} WHERE id = ?`).get(ref.step_id);
    if (!row) return;
    out.push({ bezeichnung: combineBezeichnung(row.bezeichnung_de, row.bezeichnung_en) });
  });
  return out;
}

function globalStepsAsDefaults(db, catalogKind) {
  return mapGlobalSteps(db, catalogKind).map(function (s) {
    return { bezeichnung: s.bezeichnung };
  });
}

function builtinDefaults() {
  return GRUNDSTOCK_STEPS.map(function (pair) {
    return { bezeichnung: combineBezeichnung(pair[0], pair[1]) };
  });
}

function resolveDefaultsLocal(db, technicianId, anlagenType, catalogKind) {
  ensureArbeitsschritteSchema(db);
  const kind = normalizeCatalogKind(catalogKind);
  const preset = findMatchingPresetLocal(db, technicianId, anlagenType, kind);
  if (preset) {
    const steps = presetStepsAsDefaults(db, preset.preset_scope, preset.preset_id);
    if (steps.length) {
      return {
        source: 'preset',
        arbeitsschritte: steps,
        preset_name: preset.name,
        preset_type_code: preset.type_code,
      };
    }
  }
  const global = globalStepsAsDefaults(db, kind);
  if (global.length) return { source: 'global', arbeitsschritte: global };
  if (kind === 'ibn') return { source: 'builtin', arbeitsschritte: [] };
  return { source: 'builtin', arbeitsschritte: builtinDefaults() };
}

function reorderUserStepsLocal(db, technicianId, orders) {
  const tid = parseInt(technicianId, 10);
  if (!tid) throw new Error('technician_id erforderlich.');
  if (!Array.isArray(orders) || !orders.length) return { ok: true };
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const stmt = db.prepare(
    `UPDATE arbeitsschritte_user SET sort_order = ?, updated_at = ? WHERE id = ? AND technician_id = ?`,
  );
  orders.forEach(function (row) {
    const id = parseInt(row.id, 10);
    const sort = parseInt(row.sort_order, 10) || 0;
    if (id > 0) stmt.run(sort, now, id, tid);
  });
  return { ok: true };
}

module.exports = {
  ensureArbeitsschritteSchema,
  listArbeitsschritteLocal,
  mergeArbeitsschritteFromRemote,
  saveStepLocal,
  deleteStepLocal,
  promoteUserStepToGlobal,
  savePresetLocal,
  deletePresetLocal,
  queueArbeitsschrittePending,
  resolveDefaultsLocal,
  reorderUserStepsLocal,
  builtinDefaults,
  combineBezeichnung,
};
