'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.APPDATA || '', 'monteur-webapp', 'db', 'monteur.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB nicht gefunden:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function count(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch (e) {
    return null;
  }
}

function treeNodeCount(treeJson) {
  if (!treeJson) return 0;
  let tree;
  try {
    tree = JSON.parse(treeJson);
  } catch (_) {
    return 0;
  }
  if (!Array.isArray(tree)) return 0;
  let n = 0;
  function walk(nodes) {
    for (const node of nodes) {
      n += 1;
      const kids = node.children || node.items || node.nodes || [];
      if (Array.isArray(kids) && kids.length) walk(kids);
    }
  }
  walk(tree);
  return n;
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

const treeStats = db
  .prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN tree_json IS NOT NULL AND length(tree_json) > 10 THEN 1 ELSE 0 END) AS with_tree,
            SUM(CASE WHEN tree_json IS NULL OR length(tree_json) <= 10 THEN 1 ELSE 0 END) AS empty_tree
     FROM anlagenstamm_tree_cache`,
  )
  .get();

let syncState = null;
try {
  syncState = db
    .prepare(
      `SELECT last_full_sync_at, stamm_phase_completed, pn_tree_phase_completed,
              stamm_next_page, pn_tree_next_page, pn_tree_total_pages, sync_error
       FROM anlagenstamm_sync_state WHERE id = 1`,
    )
    .get();
} catch (_) {}

function lookupFabTree(fab) {
  for (const k of [String(fab).trim(), String(parseInt(fab, 10))]) {
    if (!k || k === 'NaN') continue;
    const row = db
      .prepare(
        `SELECT fab, projects_enabled, tree_json, synced_at, truncated, content_signature
         FROM anlagenstamm_tree_cache WHERE fab = ?`,
      )
      .get(k);
    if (row) {
      return {
        fab: row.fab,
        projects_enabled: row.projects_enabled,
        synced_at: row.synced_at,
        truncated: row.truncated,
        tree_bytes: row.tree_json ? row.tree_json.length : 0,
        tree_nodes: treeNodeCount(row.tree_json),
        has_signature: !!(row.content_signature && String(row.content_signature).trim()),
      };
    }
  }
  return null;
}

function lookupStamm(fab) {
  const keys = [String(fab).trim()];
  if (/^\d+$/.test(keys[0])) keys.push(String(parseInt(keys[0], 10)));
  for (const k of keys) {
    const row = db
      .prepare(
        `SELECT id, fabrikationsnummer, dirty, synced_at
         FROM anlagenstamm_local WHERE TRIM(fabrikationsnummer) = ? LIMIT 1`,
      )
      .get(k);
    if (row) return row;
  }
  return null;
}

const lastPull = db
  .prepare(
    `SELECT id, status, updated_at, progress_phase, message
     FROM background_jobs WHERE type = 'sync_pull'
     ORDER BY datetime(updated_at) DESC LIMIT 5`,
  )
  .all();

const activeJobs = db
  .prepare(
    `SELECT id, type, status, progress_phase, message
     FROM background_jobs WHERE status IN ('queued', 'running')
     ORDER BY id DESC LIMIT 5`,
  )
  .all();

const sampleEmptyTrees = db
  .prepare(
    `SELECT fab, synced_at FROM anlagenstamm_tree_cache
     WHERE tree_json IS NULL OR length(tree_json) <= 10
     ORDER BY fab LIMIT 10`,
  )
  .all();

const report = {
  db_path: dbPath,
  db_size_mb: (fs.statSync(dbPath).size / 1048576).toFixed(1),
  table_count: tables.length,
  row_counts: {
    jobs: count('jobs'),
    job_technicians: count('job_technicians'),
    anlagenstamm_local: count('anlagenstamm_local'),
    anlagenstamm_tree_cache: count('anlagenstamm_tree_cache'),
    anlagenstamm_parameter_files: count('anlagenstamm_parameter_files'),
    calendar_cache_jobs: count('calendar_cache_jobs'),
    calendar_cache_absences: count('calendar_cache_absences'),
    pending_changes: count('pending_changes'),
    background_jobs: count('background_jobs'),
    job_ted_index: count('job_ted_index'),
    absences: count('absences'),
  },
  anlagenstamm_tree_cache: treeStats,
  anlagenstamm_sync_state: syncState,
  fab_3200: {
    stamm: lookupStamm('3200'),
    projekte_neu_tree: lookupFabTree('3200'),
  },
  last_sync_pull_jobs: lastPull,
  active_background_jobs: activeJobs,
  sample_empty_pn_trees: sampleEmptyTrees,
};

const issues = [];
if (!report.row_counts.jobs) issues.push('Keine Aufträge (jobs) in der DB.');
if (!report.row_counts.anlagenstamm_local) issues.push('Kein Anlagenstamm-Stamm (anlagenstamm_local) — Sync noch nicht gelaufen?');
if (!treeStats || !treeStats.with_tree) issues.push('Keine PROJEKTE-NEU-Bäume im Cache.');
if (!report.fab_3200.stamm) issues.push('FN 3200 nicht in anlagenstamm_local.');
if (!report.fab_3200.projekte_neu_tree || !report.fab_3200.projekte_neu_tree.tree_nodes) {
  issues.push('FN 3200: PROJEKTE-NEU-Ordnerstruktur fehlt oder ist leer.');
}
if (syncState && Number(syncState.pn_tree_phase_completed) !== 1) {
  issues.push('PROJEKTE-NEU-Vollsync noch nicht abgeschlossen (pn_tree_phase_completed=0).');
}
if (activeJobs.length) issues.push('Sync/Job läuft noch im Hintergrund.');

report.assessment = issues.length ? { ok: false, issues } : { ok: true, message: 'Kern-Daten und FN-3200-Baum vorhanden.' };

console.log(JSON.stringify(report, null, 2));
db.close();
