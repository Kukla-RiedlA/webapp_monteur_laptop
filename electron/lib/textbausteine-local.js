'use strict';

function ensureTextbausteineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS textbausteine_global_categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS textbausteine_global (
      id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER,
      updated_at TEXT,
      FOREIGN KEY (category_id) REFERENCES textbausteine_global_categories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tb_global_cat ON textbausteine_global_categories(sort_order);
    CREATE INDEX IF NOT EXISTS idx_tb_global_item ON textbausteine_global(category_id);
  `);
}

function listTextbausteineLocal(db, technicianId) {
  ensureTextbausteineSchema(db);
  const tid = parseInt(technicianId, 10);
  const categories = [];
  const globalCats = db
    .prepare(
      `SELECT id, name, sort_order FROM textbausteine_global_categories ORDER BY sort_order, name`,
    )
    .all();
  for (const gc of globalCats) {
    const items = db
      .prepare(
        `SELECT id, text, sort_order FROM textbausteine_global WHERE category_id = ? ORDER BY sort_order, id`,
      )
      .all(gc.id)
      .map((row) => ({ id: row.id, text: row.text, sort_order: row.sort_order }));
    categories.push({
      id: gc.id,
      name: gc.name,
      sort_order: gc.sort_order,
      scope: 'global',
      items,
    });
  }
  if (tid > 0) {
    const userCats = db
      .prepare(
        `SELECT id, name, sort_order, server_id FROM textbausteine_user_categories
         WHERE technician_id = ? ORDER BY sort_order, name`,
      )
      .all(tid);
    for (const uc of userCats) {
      const items = db
        .prepare(
          `SELECT id, text, sort_order, server_id FROM textbausteine_user
           WHERE technician_id = ? AND category_id = ? ORDER BY sort_order, id`,
        )
        .all(tid, uc.id)
        .map((row) => ({
          id: row.id,
          text: row.text,
          sort_order: row.sort_order,
          server_id: row.server_id,
        }));
      categories.push({
        id: uc.id,
        name: uc.name,
        sort_order: uc.sort_order,
        scope: 'user',
        items,
      });
    }
  }
  return { ok: true, categories };
}

function mergeTextbausteineFromRemote(db, technicianId, remoteData) {
  ensureTextbausteineSchema(db);
  const tid = parseInt(technicianId, 10);
  if (!remoteData || !Array.isArray(remoteData.categories)) return;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const cat of remoteData.categories) {
    const scope = String(cat.scope || 'user').toLowerCase();
    if (scope === 'global') {
      const sid = parseInt(cat.id, 10);
      if (!sid) continue;
      db.prepare(
        `INSERT INTO textbausteine_global_categories (id, name, sort_order, server_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order,
           server_id = excluded.server_id, updated_at = excluded.updated_at`,
      ).run(sid, String(cat.name || ''), parseInt(cat.sort_order, 10) || 0, sid, now);
      for (const item of cat.items || []) {
        const iid = parseInt(item.id, 10);
        if (!iid) continue;
        db.prepare(
          `INSERT INTO textbausteine_global (id, category_id, text, sort_order, server_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text, sort_order = excluded.sort_order,
             server_id = excluded.server_id, updated_at = excluded.updated_at`,
        ).run(
          iid,
          sid,
          String(item.text || ''),
          parseInt(item.sort_order, 10) || 0,
          iid,
          now,
        );
      }
    } else if (tid > 0) {
      const sid = parseInt(cat.server_id || cat.id, 10) || null;
      let localCatId = null;
      if (sid) {
        const existing = db
          .prepare(`SELECT id FROM textbausteine_user_categories WHERE technician_id = ? AND server_id = ?`)
          .get(tid, sid);
        if (existing) localCatId = existing.id;
      }
      if (!localCatId) {
        const byName = db
          .prepare(`SELECT id FROM textbausteine_user_categories WHERE technician_id = ? AND name = ? LIMIT 1`)
          .get(tid, String(cat.name || ''));
        if (byName) localCatId = byName.id;
      }
      if (localCatId) {
        db.prepare(
          `UPDATE textbausteine_user_categories SET name = ?, sort_order = ?, server_id = COALESCE(server_id, ?), updated_at = ?
           WHERE id = ? AND technician_id = ?`,
        ).run(String(cat.name || ''), parseInt(cat.sort_order, 10) || 0, sid, now, localCatId, tid);
      } else {
        const ins = db
          .prepare(
            `INSERT INTO textbausteine_user_categories (technician_id, name, sort_order, server_id, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(tid, String(cat.name || ''), parseInt(cat.sort_order, 10) || 0, sid, now);
        localCatId = ins.lastInsertRowid;
      }
      for (const item of cat.items || []) {
        const itemSid = parseInt(item.server_id || item.id, 10) || null;
        let localItemId = null;
        if (itemSid) {
          const ex = db
            .prepare(`SELECT id FROM textbausteine_user WHERE technician_id = ? AND server_id = ?`)
            .get(tid, itemSid);
          if (ex) localItemId = ex.id;
        }
        if (localItemId) {
          db.prepare(
            `UPDATE textbausteine_user SET text = ?, sort_order = ?, category_id = ?, updated_at = ? WHERE id = ?`,
          ).run(String(item.text || ''), parseInt(item.sort_order, 10) || 0, localCatId, now, localItemId);
        } else {
          db.prepare(
            `INSERT INTO textbausteine_user (technician_id, category_id, text, sort_order, server_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            tid,
            localCatId,
            String(item.text || ''),
            parseInt(item.sort_order, 10) || 0,
            itemSid,
            now,
          );
        }
      }
    }
  }
}

function nextLocalTextbausteinCategoryId(db) {
  const row = db.prepare(`SELECT MIN(id) AS m FROM textbausteine_user_categories WHERE id < 0`).get();
  const m = row && row.m != null ? parseInt(row.m, 10) : 0;
  return m < 0 ? m - 1 : -1;
}

function nextLocalTextbausteinItemId(db) {
  const row = db.prepare(`SELECT MIN(id) AS m FROM textbausteine_user WHERE id < 0`).get();
  const m = row && row.m != null ? parseInt(row.m, 10) : 0;
  return m < 0 ? m - 1 : -1;
}

function saveCategoryLocal(db, technicianId, body) {
  const tid = parseInt(technicianId, 10);
  if (!tid) throw new Error('technician_id erforderlich.');
  const name = String(body.name || '').trim();
  if (!name) throw new Error('name erforderlich.');
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let id = parseInt(body.id, 10);
  if (id > 0) {
    db.prepare(
      `UPDATE textbausteine_user_categories SET name = ?, sort_order = ?, updated_at = ? WHERE id = ? AND technician_id = ?`,
    ).run(name, sortOrder, now, id, tid);
  } else {
    id = nextLocalTextbausteinCategoryId(db);
    db.prepare(
      `INSERT INTO textbausteine_user_categories (id, technician_id, name, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, tid, name, sortOrder, now);
  }
  return { ok: true, id, scope: 'user' };
}

function deleteCategoryLocal(db, technicianId, categoryId) {
  const tid = parseInt(technicianId, 10);
  const cid = parseInt(categoryId, 10);
  db.prepare(`DELETE FROM textbausteine_user WHERE technician_id = ? AND category_id = ?`).run(tid, cid);
  db.prepare(`DELETE FROM textbausteine_user_categories WHERE id = ? AND technician_id = ?`).run(cid, tid);
  return { ok: true };
}

function saveItemLocal(db, technicianId, body) {
  const tid = parseInt(technicianId, 10);
  const categoryId = parseInt(body.category_id, 10);
  if (!tid || !categoryId) throw new Error('category_id und technician_id erforderlich.');
  if (body.text === undefined) throw new Error('text erforderlich.');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  let id = parseInt(body.id, 10);
  if (id > 0) {
    db.prepare(
      `UPDATE textbausteine_user SET text = ?, sort_order = ?, category_id = ?, updated_at = ? WHERE id = ? AND technician_id = ?`,
    ).run(String(body.text), sortOrder, categoryId, now, id, tid);
  } else {
    id = nextLocalTextbausteinItemId(db);
    db.prepare(
      `INSERT INTO textbausteine_user (id, technician_id, category_id, text, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, tid, categoryId, String(body.text), sortOrder, now);
  }
  return { ok: true, id };
}

function deleteItemLocal(db, technicianId, itemId) {
  const tid = parseInt(technicianId, 10);
  const iid = parseInt(itemId, 10);
  db.prepare(`DELETE FROM textbausteine_user WHERE id = ? AND technician_id = ?`).run(iid, tid);
  return { ok: true };
}

function queueTextbausteinePending(db, entityId, action, payload) {
  db.prepare(`INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`).run(
    'textbausteine',
    String(entityId),
    action,
    JSON.stringify(payload),
  );
}

module.exports = {
  ensureTextbausteineSchema,
  listTextbausteineLocal,
  mergeTextbausteineFromRemote,
  saveCategoryLocal,
  deleteCategoryLocal,
  saveItemLocal,
  deleteItemLocal,
  queueTextbausteinePending,
};
