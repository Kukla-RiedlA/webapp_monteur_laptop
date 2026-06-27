'use strict';

const DM_PREFIX = 'Dokumente_Monteur/';
const SKIP_PULL_PREFIXES = ['Dokumente_Dispo', 'Dokumente_Buchhaltung', 'Dokumente_Anlage'];

function ensureJobOfflinePullSchema(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS job_offline_pull_config (
      local_job_id INTEGER PRIMARY KEY,
      pull_mode TEXT NOT NULL DEFAULT 'legacy',
      montage_folder_name TEXT,
      fab_map_json TEXT,
      updated_at TEXT
    )`,
  ).run();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS job_offline_pull_paths (
      local_job_id INTEGER NOT NULL,
      fab TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      PRIMARY KEY (local_job_id, fab, rel_path)
    )`,
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_job_offline_pull_paths_job ON job_offline_pull_paths(local_job_id)',
  ).run();
}

function getOfflinePullConfig(db, localJobId) {
  const row = db
    .prepare(
      `SELECT pull_mode, montage_folder_name, fab_map_json, updated_at
       FROM job_offline_pull_config WHERE local_job_id = ?`,
    )
    .get(localJobId);
  if (!row) {
    return { pull_mode: 'legacy', montage_folder_name: null, fab_map: [], updated_at: null };
  }
  let fab_map = [];
  try {
    fab_map = row.fab_map_json ? JSON.parse(row.fab_map_json) : [];
  } catch (_) {
    fab_map = [];
  }
  return {
    pull_mode: row.pull_mode || 'legacy',
    montage_folder_name: row.montage_folder_name || null,
    fab_map: Array.isArray(fab_map) ? fab_map : [],
    updated_at: row.updated_at || null,
  };
}

function getOfflinePullPathsByFab(db, localJobId) {
  const rows = db
    .prepare(`SELECT fab, rel_path FROM job_offline_pull_paths WHERE local_job_id = ?`)
    .all(localJobId);
  const map = new Map();
  for (const r of rows) {
    const fab = String(r.fab || '').trim();
    const rel = String(r.rel_path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!fab || !rel) continue;
    if (!map.has(fab)) map.set(fab, new Set());
    map.get(fab).add(rel);
  }
  return map;
}

/**
 * @param {Map<string, Set<string>>} pathsByFab
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabMap
 */
function findFabForCanonicalFolder(pathsByFab, fabMap, canonicalFolder) {
  const name = String(canonicalFolder || '').trim();
  if (!name) return null;
  for (const entry of fabMap || []) {
    if (String(entry.folder_name_canonical || '').trim() === name) {
      return String(entry.fab || '').trim();
    }
  }
  for (const [fab] of pathsByFab) {
    if (fab === name) return fab;
  }
  return null;
}

function normManifestPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function shouldSkipPullPrefix(relPath) {
  const norm = normManifestPath(relPath);
  for (const p of SKIP_PULL_PREFIXES) {
    if (norm === p || norm.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * @param {string} relPath
 * @param {'legacy'|'explicit'} pullMode
 * @param {Map<string, Set<string>>} pathsByFab
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabMap
 */
function shouldPullManifestFile(relPath, pullMode, pathsByFab, fabMap) {
  const norm = normManifestPath(relPath);
  if (!norm) return false;
  if (pullMode === 'legacy') return true;
  if (shouldSkipPullPrefix(norm)) return false;
  if (!norm.startsWith(DM_PREFIX)) return false;
  const tail = norm.slice(DM_PREFIX.length);
  const slash = tail.indexOf('/');
  if (slash < 0) return false;
  const fnFolder = tail.slice(0, slash);
  const inner = tail.slice(slash + 1);
  if (inner.startsWith('Montage/')) return false;
  const fab = findFabForCanonicalFolder(pathsByFab, fabMap, fnFolder);
  if (!fab) return false;
  const prefixes = pathsByFab.get(fab);
  if (!prefixes || prefixes.size === 0) return false;
  for (const prefix of prefixes) {
    const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
    if (!p) continue;
    if (inner === p || inner.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * @param {Array<{ path: string }>} files
 */
function filterManifestForPull(files, pullMode, pathsByFab, fabMap) {
  if (pullMode === 'legacy') return files;
  return files.filter((f) => shouldPullManifestFile(f.path, pullMode, pathsByFab, fabMap));
}

/**
 * @param {Array<{ fab: string|number, path: string }>|string[]} offlinePathsRaw
 */
function normalizeOfflinePathsInput(offlinePathsRaw) {
  const out = [];
  for (const item of offlinePathsRaw || []) {
    if (item && typeof item === 'object' && item.fab != null && item.path != null) {
      const fab = String(item.fab).trim();
      const rel = String(item.path)
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      if (fab && rel) out.push({ fab, path: rel });
      continue;
    }
    const s = String(item || '').trim();
    const colon = s.indexOf(':');
    if (colon > 0) {
      const fab = s.slice(0, colon).trim();
      const rel = s.slice(colon + 1).replace(/^\/+|\/+$/g, '');
      if (fab && rel) out.push({ fab, path: rel });
    }
  }
  return out;
}

function updateOfflinePullFabMap(db, localJobId, fabMap) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE job_offline_pull_config SET fab_map_json = ?, updated_at = ?
     WHERE local_job_id = ?`,
  ).run(JSON.stringify(fabMap || []), now, localJobId);
}

/** montage_folder_name setzen, wenn noch leer (ohne offline_paths zu löschen). */
function ensureMontageFolderNameInConfig(db, localJobId, montageFolderName) {
  ensureJobOfflinePullSchema(db);
  const name = String(montageFolderName || '').trim();
  if (!name) return false;
  const row = db.prepare('SELECT montage_folder_name FROM job_offline_pull_config WHERE local_job_id = ?').get(localJobId);
  if (row && String(row.montage_folder_name || '').trim()) return false;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO job_offline_pull_config (local_job_id, pull_mode, montage_folder_name, fab_map_json, updated_at)
     VALUES (?, 'legacy', ?, '[]', ?)
     ON CONFLICT(local_job_id) DO UPDATE SET
       montage_folder_name = excluded.montage_folder_name,
       updated_at = excluded.updated_at`,
  ).run(localJobId, name, now);
  return true;
}

function saveOfflinePullSelection(db, localJobId, pullMode, offlinePathsRaw, fabMap, montageFolderName) {
  const now = new Date().toISOString();
  const paths = normalizeOfflinePathsInput(offlinePathsRaw);
  db.prepare(`DELETE FROM job_offline_pull_paths WHERE local_job_id = ?`).run(localJobId);
  const ins = db.prepare(
    `INSERT INTO job_offline_pull_paths (local_job_id, fab, rel_path) VALUES (?, ?, ?)`,
  );
  for (const p of paths) {
    ins.run(localJobId, p.fab, p.path);
  }
  db.prepare(
    `INSERT INTO job_offline_pull_config (local_job_id, pull_mode, montage_folder_name, fab_map_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(local_job_id) DO UPDATE SET
       pull_mode = excluded.pull_mode,
       montage_folder_name = excluded.montage_folder_name,
       fab_map_json = excluded.fab_map_json,
       updated_at = excluded.updated_at`,
  ).run(
    localJobId,
    pullMode,
    montageFolderName || null,
    JSON.stringify(fabMap || []),
    now,
  );
}

module.exports = {
  ensureJobOfflinePullSchema,
  getOfflinePullConfig,
  getOfflinePullPathsByFab,
  shouldPullManifestFile,
  filterManifestForPull,
  normalizeOfflinePathsInput,
  saveOfflinePullSelection,
  updateOfflinePullFabMap,
  ensureMontageFolderNameInConfig,
  findFabForCanonicalFolder,
};
