'use strict';

const DM_PREFIX = 'Dokumente_Monteur/';
/** Im Modus explicit: PROJEKTE NEU / Anlage nur über Baumauswahl, nicht pauschal aus Manifest. */
const SKIP_PULL_PREFIXES = ['Dokumente_Anlage'];
/** Im Modus explicit: immer vollständig laden (ohne Häkchen in der Offline-Auswahl). */
const ALWAYS_PULL_PREFIXES = [
  'Dokumente_Dispo',
  'Dokumente_Buchhaltung',
  /** Legacy-PWA-Fotos — kein FN-Ordner, sonst filtert shouldPullManifestFile sie weg. */
  'Dokumente_Monteur/Bilder',
];

/** Neu: …/Montage/<Auftrag>/Bilder/… sowie flache Dateien direkt unter Dokumente_Monteur/. */
function isMonteurPhotoManifestPath(relPath) {
  const norm = normManifestPath(relPath);
  if (!norm) return false;
  if (norm === 'Dokumente_Monteur/Bilder' || norm.startsWith('Dokumente_Monteur/Bilder/')) return true;
  if (/^Dokumente_Monteur\/[^/]+\/Montage\/[^/]+\/Bilder(\/|$)/i.test(norm)) return true;
  // ohne FN: Dateien direkt unter Dokumente_Monteur/ (kein Unterordner)
  if (/^Dokumente_Monteur\/[^/]+\.(jpe?g|png|webp)$/i.test(norm)) return true;
  return false;
}

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
      entry_kind TEXT NOT NULL DEFAULT 'dir',
      PRIMARY KEY (local_job_id, fab, rel_path)
    )`,
  ).run();
  try {
    db.prepare('ALTER TABLE job_offline_pull_paths ADD COLUMN entry_kind TEXT NOT NULL DEFAULT \'dir\'').run();
  } catch (_) {
    /* Spalte existiert */
  }
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_job_offline_pull_paths_job ON job_offline_pull_paths(local_job_id)',
  ).run();
}

function normRelPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function isTedInnerPath(inner) {
  const rel = normRelPath(inner);
  if (!rel) return false;
  return /^TED(\/|$)/i.test(rel);
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
    .prepare(`SELECT fab, rel_path, entry_kind FROM job_offline_pull_paths WHERE local_job_id = ?`)
    .all(localJobId);
  const map = new Map();
  for (const r of rows) {
    const fab = String(r.fab || '').trim();
    const rel = normRelPath(r.rel_path);
    if (!fab || !rel) continue;
    if (!map.has(fab)) map.set(fab, new Map());
    map.get(fab).set(rel, String(r.entry_kind || 'dir').toLowerCase() === 'file' ? 'file' : 'dir');
  }
  return map;
}

/**
 * @param {Map<string, Map<string, 'dir'|'file'>>} pathsByFab
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

function shouldAlwaysPullPrefix(relPath) {
  const norm = normManifestPath(relPath);
  for (const p of ALWAYS_PULL_PREFIXES) {
    if (norm === p || norm.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * @param {Map<string, Map<string, 'dir'|'file'>>} pathsByFab
 */
function pathMatchesSelection(inner, prefixesMap) {
  if (!prefixesMap || prefixesMap.size === 0) return false;
  for (const [prefix, kind] of prefixesMap) {
    const p = normRelPath(prefix);
    if (!p) continue;
    if (kind === 'file') {
      if (inner === p) return true;
      continue;
    }
    if (inner === p || inner.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * @param {string} relPath
 * @param {'legacy'|'explicit'} pullMode
 * @param {Map<string, Map<string, 'dir'|'file'>>} pathsByFab
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabMap
 */
function shouldPullManifestFile(relPath, pullMode, pathsByFab, fabMap) {
  const norm = normManifestPath(relPath);
  if (!norm) return false;
  if (pullMode === 'legacy') return true;
  if (shouldAlwaysPullPrefix(norm)) return true;
  if (isMonteurPhotoManifestPath(norm)) return true;
  if (shouldSkipPullPrefix(norm)) return false;
  if (!norm.startsWith(DM_PREFIX)) return false;
  const tail = norm.slice(DM_PREFIX.length);
  const slash = tail.indexOf('/');
  if (slash < 0) return false;
  const fnFolder = tail.slice(0, slash);
  const inner = tail.slice(slash + 1);
  // Montage-Arbeitsdateien lokal — außer PWA-Fotos unter …/Montage/…/Bilder/
  if (inner.startsWith('Montage/') && !/^Montage\/[^/]+\/Bilder(\/|$)/i.test(inner)) return false;
  if (isTedInnerPath(inner)) return false;
  const fab = findFabForCanonicalFolder(pathsByFab, fabMap, fnFolder);
  if (!fab) return false;
  const prefixes = pathsByFab.get(fab);
  return pathMatchesSelection(inner, prefixes);
}

/**
 * @param {Array<{ path: string }>} files
 */
function filterManifestForPull(files, pullMode, pathsByFab, fabMap) {
  if (pullMode === 'legacy') return files;
  return files.filter((f) => shouldPullManifestFile(f.path, pullMode, pathsByFab, fabMap));
}

/**
 * @param {Array<{ fab: string|number, path: string, kind?: string }>|string[]} offlinePathsRaw
 */
function normalizeOfflinePathsInput(offlinePathsRaw) {
  const out = [];
  for (const item of offlinePathsRaw || []) {
    if (item && typeof item === 'object' && item.fab != null && item.path != null) {
      const fab = String(item.fab).trim();
      const rel = normRelPath(item.path);
      const kind =
        String(item.kind || item.entry_kind || 'dir').toLowerCase() === 'file' ? 'file' : 'dir';
      if (fab && rel) out.push({ fab, path: rel, kind });
      continue;
    }
    const s = String(item || '').trim();
    const colon = s.indexOf(':');
    if (colon > 0) {
      const fab = s.slice(0, colon).trim();
      const rel = normRelPath(s.slice(colon + 1));
      if (fab && rel) out.push({ fab, path: rel, kind: 'dir' });
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

/** Sticky-Auftragsordner immer auf Desired setzen (nach Align/Rename). */
function updateMontageFolderNameInConfig(db, localJobId, montageFolderName) {
  ensureJobOfflinePullSchema(db);
  const name = String(montageFolderName || '').trim();
  if (!name) return false;
  const row = db.prepare('SELECT montage_folder_name FROM job_offline_pull_config WHERE local_job_id = ?').get(localJobId);
  const prev = row ? String(row.montage_folder_name || '').trim() : '';
  if (prev === name) return false;
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
  ensureJobOfflinePullSchema(db);
  const now = new Date().toISOString();
  const paths = normalizeOfflinePathsInput(offlinePathsRaw);
  db.prepare(`DELETE FROM job_offline_pull_paths WHERE local_job_id = ?`).run(localJobId);
  const ins = db.prepare(
    `INSERT INTO job_offline_pull_paths (local_job_id, fab, rel_path, entry_kind) VALUES (?, ?, ?, ?)`,
  );
  for (const p of paths) {
    ins.run(localJobId, p.fab, p.path, p.kind || 'dir');
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
    pullMode || 'legacy',
    montageFolderName || null,
    JSON.stringify(fabMap || []),
    now,
  );
}

module.exports = {
  ensureJobOfflinePullSchema,
  getOfflinePullConfig,
  getOfflinePullPathsByFab,
  findFabForCanonicalFolder,
  shouldPullManifestFile,
  shouldAlwaysPullPrefix,
  isMonteurPhotoManifestPath,
  filterManifestForPull,
  normalizeOfflinePathsInput,
  updateOfflinePullFabMap,
  ensureMontageFolderNameInConfig,
  updateMontageFolderNameInConfig,
  saveOfflinePullSelection,
  isTedInnerPath,
};
