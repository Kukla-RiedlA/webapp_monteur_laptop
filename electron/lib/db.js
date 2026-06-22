'use strict';

/**
 * better-sqlite3 persistence for Monteur Laptop (WAL, native).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureBackgroundJobsSchema } = require('./background_jobs');
const { ensureAnlagenstammLocalSchema } = require('./anlagenstamm-local');

let dbInstance = null;
let dbPath = null;
let lastPersistError = null;

function tryExec(db, sql) {
  try {
    db.exec(sql);
  } catch (_) {
    /* idempotent migration */
  }
}

function migrateJobTedIndexToFabRelPk(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_ted_index'").get();
  if (!row || !row.sql || row.sql.includes('PRIMARY KEY (local_job_id, fab, rel_path)')) return;
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE job_ted_index_v2 (
      local_job_id INTEGER NOT NULL,
      server_job_id INTEGER,
      rel_path TEXT NOT NULL,
      file_name TEXT,
      fab TEXT NOT NULL DEFAULT '',
      synced_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (local_job_id, fab, rel_path)
    )`);
    db.exec(`INSERT OR IGNORE INTO job_ted_index_v2 (local_job_id, server_job_id, rel_path, file_name, fab, synced_at)
      SELECT local_job_id, server_job_id, rel_path, file_name, COALESCE(NULLIF(TRIM(fab), ''), ''), synced_at FROM job_ted_index`);
    db.exec('DROP TABLE job_ted_index');
    db.exec('ALTER TABLE job_ted_index_v2 RENAME TO job_ted_index');
  });
  migrate();
}

function applyRuntimeMigrations(db) {
  tryExec(db, 'ALTER TABLE jobs ADD COLUMN eap_nummer TEXT');
  tryExec(db, 'ALTER TABLE jobs ADD COLUMN bestellnummer TEXT');
  tryExec(db, 'ALTER TABLE job_addresses ADD COLUMN endkunde TEXT');
  tryExec(db, 'ALTER TABLE absences ADD COLUMN comment TEXT');
  tryExec(db, 'ALTER TABLE absence_requests ADD COLUMN comment TEXT');
  tryExec(db, `CREATE TABLE IF NOT EXISTS job_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_job_contacts_job ON job_contacts(job_id)');
  tryExec(db, `CREATE TABLE IF NOT EXISTS job_hotel_addresses (
      job_id INTEGER PRIMARY KEY,
      endkunde TEXT,
      street TEXT,
      house_number TEXT,
      zip TEXT,
      city TEXT,
      country TEXT,
      address_extra_1 TEXT,
      address_extra_2 TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  tryExec(db, `CREATE TABLE IF NOT EXISTS job_hotel_selection (
      job_id INTEGER PRIMARY KEY,
      hotel_id INTEGER,
      comment TEXT,
      rating_stars INTEGER,
      rating_avg REAL,
      rating_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`);
  tryExec(db, `CREATE TABLE IF NOT EXISTS absence_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      technician_id INTEGER NOT NULL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT DEFAULT (datetime('now')),
      synced_at TEXT
    )`);
  tryExec(db, `CREATE TABLE IF NOT EXISTS dienstreisen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      running_number INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      company_name TEXT NOT NULL,
      city TEXT,
      country_code TEXT,
      folder_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_dienstreisen_year ON dienstreisen(year)');
  tryExec(db, `CREATE TABLE IF NOT EXISTS calendar_cache_technicians (
      technician_id INTEGER PRIMARY KEY,
      name TEXT,
      color TEXT,
      synced_at TEXT
    )`);
  tryExec(db, `CREATE TABLE IF NOT EXISTS calendar_cache_jobs (
      cache_key TEXT PRIMARY KEY,
      server_job_id INTEGER,
      technician_id INTEGER,
      customer_name TEXT,
      job_number TEXT,
      city TEXT,
      country TEXT,
      status TEXT,
      start_datetime TEXT,
      end_datetime TEXT,
      technician_name TEXT,
      technician_color TEXT,
      montage_verrechnet INTEGER DEFAULT 0,
      billing_travel_complete INTEGER DEFAULT 0,
      synced_at TEXT
    )`);
  tryExec(db, 'ALTER TABLE calendar_cache_jobs ADD COLUMN montage_verrechnet INTEGER DEFAULT 0');
  tryExec(db, 'ALTER TABLE calendar_cache_jobs ADD COLUMN billing_travel_complete INTEGER DEFAULT 0');
  tryExec(db, `CREATE TABLE IF NOT EXISTS calendar_cache_absences (
      cache_key TEXT PRIMARY KEY,
      server_absence_id INTEGER,
      technician_id INTEGER,
      type TEXT,
      comment TEXT,
      start_datetime TEXT,
      end_datetime TEXT,
      technician_name TEXT,
      technician_color TEXT,
      synced_at TEXT
    )`);
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_calendar_cache_jobs_range ON calendar_cache_jobs(start_datetime, end_datetime)');
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_calendar_cache_absences_range ON calendar_cache_absences(start_datetime, end_datetime)');
  tryExec(db, `CREATE TABLE IF NOT EXISTS anlagenstamm_tree_cache (
      fab TEXT PRIMARY KEY,
      projects_enabled INTEGER NOT NULL DEFAULT 0,
      tree_json TEXT,
      synced_at TEXT,
      content_signature TEXT,
      truncated INTEGER NOT NULL DEFAULT 0
    )`);
  tryExec(db, 'ALTER TABLE anlagenstamm_tree_cache ADD COLUMN content_signature TEXT');
  tryExec(db, 'ALTER TABLE anlagenstamm_tree_cache ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0');
  tryExec(db, `CREATE TABLE IF NOT EXISTS job_ted_index (
      local_job_id INTEGER NOT NULL,
      server_job_id INTEGER,
      rel_path TEXT NOT NULL,
      file_name TEXT,
      fab TEXT NOT NULL DEFAULT '',
      synced_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (local_job_id, fab, rel_path)
    )`);
  migrateJobTedIndexToFabRelPk(db);
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_anlagenstamm_tree_cache_synced ON anlagenstamm_tree_cache(synced_at)');
  tryExec(db, `CREATE TABLE IF NOT EXISTS image_thumb_cache (
      cache_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      thumb_max INTEGER NOT NULL DEFAULT 256,
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      thumb_blob BLOB NOT NULL,
      source_mtime TEXT,
      source_size INTEGER,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (cache_kind, scope_id, rel_path, thumb_max)
    )`);
  tryExec(db, 'CREATE INDEX IF NOT EXISTS idx_image_thumb_cache_scope ON image_thumb_cache(cache_kind, scope_id)');
  db.prepare("UPDATE jobs SET status = 'angelegt' WHERE LOWER(COALESCE(status, '')) = 'geplant'").run();
  ensureBackgroundJobsSchema(db);
  ensureAnlagenstammLocalSchema(db);
  const { ensureImageThumbCacheSchema } = require('./image-thumb-cache');
  ensureImageThumbCacheSchema(db);
}

/**
 * @param {{ dbPath: string }} options
 */
async function openMonteurDatabase(options = {}) {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  dbPath = options.dbPath || null;

  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
  }

  if (!dbPath) {
    dbInstance = new Database(':memory:');
  } else {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    dbInstance = new Database(dbPath);
  }

  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('busy_timeout = 5000');
  dbInstance.exec(schemaSql);
  applyRuntimeMigrations(dbInstance);
  lastPersistError = null;
  return dbInstance;
}

function getDb() {
  if (!dbInstance) throw new Error('DB not initialized');
  return dbInstance;
}

function persistDb(mode = 'PASSIVE') {
  if (!dbInstance) return;
  const allowed = new Set(['PASSIVE', 'FULL', 'TRUNCATE', 'RESTART']);
  const checkpointMode = allowed.has(mode) ? mode : 'PASSIVE';
  try {
    dbInstance.pragma(`wal_checkpoint(${checkpointMode})`);
    lastPersistError = null;
  } catch (e) {
    lastPersistError = e;
  }
}

/** Vor App-Ende / nach großem Sync: WAL in monteur.db überführen (Backup-Tools lesen nur .db). */
function flushDb() {
  persistDb('TRUNCATE');
}

function getLastPersistError() {
  return lastPersistError;
}

function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
  }
}

module.exports = {
  openMonteurDatabase,
  getDb,
  flushDb,
  persistDb,
  getLastPersistError,
  closeDatabase,
  getDbPath: () => dbPath,
};
