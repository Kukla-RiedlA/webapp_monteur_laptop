'use strict';

/**
 * Persistente „Nicht löschen“-Pfade pro lokalem Auftrag (Explorer).
 * Default: Dokumente_Monteur + Nachkommen beim ersten Init.
 */

const fs = require('fs');
const path = require('path');

const DOKUMENTE_MONTEUR = 'Dokumente_Monteur';

function normalizeRelPath(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function isUnderDokumenteMonteur(rel) {
  const n = normalizeRelPath(rel);
  return n === DOKUMENTE_MONTEUR || n.startsWith(DOKUMENTE_MONTEUR + '/');
}

function ensureJobProtectedPathsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_protected_paths (
    local_job_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    PRIMARY KEY (local_job_id, relative_path)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS job_protected_paths_meta (
    local_job_id INTEGER PRIMARY KEY,
    initialized INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_job_protected_paths_job ON job_protected_paths(local_job_id)',
  );
  db.exec(`CREATE TABLE IF NOT EXISTS job_protected_paths_repair (
    key TEXT PRIMARY KEY,
    done INTEGER NOT NULL DEFAULT 0
  )`);
  // Einmalig: leere Inits nach dem „paths is not iterable“-Bug zurücksetzen,
  // damit der Monteur-Default erneut greifen kann. Danach: leere Liste = bewusste Abwahl.
  try {
    const done = db
      .prepare(`SELECT done FROM job_protected_paths_repair WHERE key = 'empty_init_v1'`)
      .get();
    if (!done || !done.done) {
      db.prepare(
        `UPDATE job_protected_paths_meta
         SET initialized = 0
         WHERE initialized = 1
           AND NOT EXISTS (
             SELECT 1 FROM job_protected_paths p
             WHERE p.local_job_id = job_protected_paths_meta.local_job_id
           )`,
      ).run();
      db.prepare(
        `INSERT OR REPLACE INTO job_protected_paths_repair (key, done) VALUES ('empty_init_v1', 1)`,
      ).run();
    }
  } catch (_) {
    /* ignore */
  }
}

function defaultIgnorable(name) {
  if (!name || name === '.' || name === '..') return true;
  if (name.startsWith('.')) return true;
  const lower = String(name).toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store';
}

/**
 * @param {string} absRoot absolute Ordnerwurzel (z. B. …/Dokumente_Monteur)
 * @param {string} relRoot relativer Pfad derselben Wurzel
 * @param {(name: string) => boolean} [isIgnorable]
 * @returns {string[]} relative Pfade inkl. relRoot
 */
function collectRelPathsUnder(absRoot, relRoot, isIgnorable) {
  const ign = typeof isIgnorable === 'function' ? isIgnorable : defaultIgnorable;
  const rootRel = normalizeRelPath(relRoot);
  const out = [];
  if (!absRoot || !fs.existsSync(absRoot)) {
    if (rootRel) out.push(rootRel);
    return out;
  }
  function walk(absDir, relBase) {
    if (relBase) out.push(relBase);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (ign(e.name)) continue;
      const full = path.join(absDir, e.name);
      const rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  walk(absRoot, rootRel);
  return out;
}

function listProtectedPaths(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return [];
  const rows = db
    .prepare(
      'SELECT relative_path FROM job_protected_paths WHERE local_job_id = ? ORDER BY relative_path',
    )
    .all(lid);
  return rows.map((r) => normalizeRelPath(r.relative_path)).filter(Boolean);
}

function isProtectedPathsInitialized(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return false;
  const row = db
    .prepare('SELECT initialized FROM job_protected_paths_meta WHERE local_job_id = ?')
    .get(lid);
  return !!(row && row.initialized);
}

function markProtectedPathsInitialized(db, localJobId) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return;
  db.prepare(
    `INSERT INTO job_protected_paths_meta (local_job_id, initialized) VALUES (?, 1)
     ON CONFLICT(local_job_id) DO UPDATE SET initialized = 1`,
  ).run(lid);
}

function insertProtectedPath(db, localJobId, relativePath) {
  const lid = parseInt(localJobId, 10);
  const rel = normalizeRelPath(relativePath);
  if (!Number.isFinite(lid) || lid <= 0 || !rel) return false;
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO job_protected_paths (local_job_id, relative_path) VALUES (?, ?)',
    )
    .run(lid, rel);
  return info.changes > 0;
}

function insertProtectedPaths(db, localJobId, relativePaths) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return 0;
  const list = Array.isArray(relativePaths) ? relativePaths : [];
  if (!list.length) return 0;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO job_protected_paths (local_job_id, relative_path) VALUES (?, ?)',
  );
  let n = 0;
  const apply = () => {
    for (const p of list) {
      const rel = normalizeRelPath(p);
      if (!rel) continue;
      const info = stmt.run(lid, rel);
      if (info.changes > 0) n += 1;
    }
  };
  // db-compat: transaction(fn) führt fn sofort aus und gibt nichts zurück.
  // better-sqlite3 native: transaction(fn) gibt eine Runner-Funktion zurück.
  if (typeof db.transaction === 'function') {
    const runner = db.transaction(apply);
    if (typeof runner === 'function') runner();
  } else {
    apply();
  }
  return n;
}

function deleteProtectedPath(db, localJobId, relativePath) {
  const lid = parseInt(localJobId, 10);
  const rel = normalizeRelPath(relativePath);
  if (!Number.isFinite(lid) || lid <= 0 || !rel) return 0;
  const info = db
    .prepare('DELETE FROM job_protected_paths WHERE local_job_id = ? AND relative_path = ?')
    .run(lid, rel);
  return info.changes;
}

function deleteProtectedPathCascade(db, localJobId, relativePath) {
  const lid = parseInt(localJobId, 10);
  const rel = normalizeRelPath(relativePath);
  if (!Number.isFinite(lid) || lid <= 0 || !rel) return 0;
  const info = db
    .prepare(
      `DELETE FROM job_protected_paths
       WHERE local_job_id = ?
         AND (relative_path = ? OR relative_path LIKE ?)`,
    )
    .run(lid, rel, rel + '/%');
  return info.changes;
}

/**
 * Fügt Pfad (+ Vorfahren) unter Dokumente_Monteur ein.
 * Nach Init: neue Pfade immer; Vorfahren nur wenn Dokumente_Monteur noch geschützt ist
 * (sonst würde ein Abwählen der Wurzel durch Layout/Writes rückgängig gemacht).
 */
function protectPathIfUnderDokumenteMonteur(db, localJobId, relativePath) {
  const lid = parseInt(localJobId, 10);
  const norm = normalizeRelPath(relativePath);
  if (!Number.isFinite(lid) || lid <= 0 || !isUnderDokumenteMonteur(norm)) return false;

  const parts = norm.split('/').filter(Boolean);
  const ancestors = [];
  let cur = '';
  for (const part of parts) {
    cur = cur ? cur + '/' + part : part;
    ancestors.push(cur);
  }

  if (!isProtectedPathsInitialized(db, lid)) {
    insertProtectedPaths(db, lid, ancestors);
    return true;
  }

  const rootRow = db
    .prepare(
      'SELECT 1 AS ok FROM job_protected_paths WHERE local_job_id = ? AND relative_path = ?',
    )
    .get(lid, DOKUMENTE_MONTEUR);
  if (rootRow) {
    insertProtectedPaths(db, lid, ancestors);
  } else {
    // Wurzel abgewählt: trotzdem neue Datei/Ordner selbst default schützen
    insertProtectedPath(db, lid, norm);
  }
  return true;
}

/**
 * Einmaliges Seeding: Dokumente_Monteur + alle vorhandenen Nachkommen.
 * Nur wenn initialized=0. Leere Liste nach Init = bewusste Abwahl (kein erneutes Seeden).
 */
function seedDokumenteMonteurProtectedPaths(db, localJobId, reiseDir, isIgnorable) {
  const lid = parseInt(localJobId, 10);
  if (!Number.isFinite(lid) || lid <= 0) return listProtectedPaths(db, lid);
  if (isProtectedPathsInitialized(db, lid)) return listProtectedPaths(db, lid);

  const monteurAbs = reiseDir ? path.join(reiseDir, DOKUMENTE_MONTEUR) : null;
  const paths = collectRelPathsUnder(monteurAbs, DOKUMENTE_MONTEUR, isIgnorable);
  if (!paths.includes(DOKUMENTE_MONTEUR)) paths.unshift(DOKUMENTE_MONTEUR);
  insertProtectedPaths(db, lid, paths);
  markProtectedPathsInitialized(db, lid);
  return listProtectedPaths(db, lid);
}

/**
 * @returns {{ paths: string[], added?: number, removed?: number }}
 */
function setProtectedPathState(db, localJobId, relativePath, protectedFlag, opts) {
  const lid = parseInt(localJobId, 10);
  const rel = normalizeRelPath(relativePath);
  const cascade = !!(opts && opts.cascade);
  const reiseDir = opts && opts.reiseDir;
  const isIgnorable = opts && opts.isIgnorable;

  if (!Number.isFinite(lid) || lid <= 0 || !rel) {
    return { paths: listProtectedPaths(db, lid), added: 0, removed: 0 };
  }

  let added = 0;
  let removed = 0;

  if (protectedFlag) {
    const toAdd = [rel];
    if (cascade && reiseDir) {
      const abs = path.join(reiseDir, ...rel.split('/'));
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        toAdd.push(...collectRelPathsUnder(abs, rel, isIgnorable));
      }
    }
    added = insertProtectedPaths(db, lid, toAdd);
  } else if (cascade) {
    removed = deleteProtectedPathCascade(db, lid, rel);
  } else {
    removed = deleteProtectedPath(db, lid, rel);
  }

  return { paths: listProtectedPaths(db, lid), added, removed };
}

/**
 * Exact-match Schutz (kein Prefix für Dateien).
 */
function buildExactProtectedMatcher(protectedPaths) {
  const protectedSet = new Set(
    (protectedPaths || []).map((p) => normalizeRelPath(p)).filter(Boolean),
  );
  return function isProtectedExact(rel) {
    return protectedSet.has(normalizeRelPath(rel));
  };
}

/**
 * Top-Level darf per rmSync nur weg, wenn kein geschützter Pfad darunter/gleich liegt.
 */
function canRmSyncTopLevelEntryExact(relName, protectedPathsNorm) {
  const norm = normalizeRelPath(relName);
  for (const p of protectedPathsNorm || []) {
    const pn = normalizeRelPath(p);
    if (pn === norm || pn.startsWith(norm + '/')) return false;
  }
  return true;
}

module.exports = {
  DOKUMENTE_MONTEUR,
  normalizeRelPath,
  isUnderDokumenteMonteur,
  ensureJobProtectedPathsSchema,
  collectRelPathsUnder,
  listProtectedPaths,
  isProtectedPathsInitialized,
  markProtectedPathsInitialized,
  insertProtectedPath,
  insertProtectedPaths,
  deleteProtectedPath,
  deleteProtectedPathCascade,
  protectPathIfUnderDokumenteMonteur,
  seedDokumenteMonteurProtectedPaths,
  setProtectedPathState,
  buildExactProtectedMatcher,
  canRmSyncTopLevelEntryExact,
};
