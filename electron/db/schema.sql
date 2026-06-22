-- SQLite-Schema für Offline-DB (Monteur WebApp)
-- Angelehnt an fsm; vereinfacht für lokale Nutzung und Sync.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'monteur',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  street TEXT,
  house_number TEXT,
  zip TEXT,
  city TEXT,
  country TEXT,
  phone TEXT,
  contact_person TEXT,
  contact_phone TEXT,
  contact_email TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  server_id INTEGER UNIQUE,
  job_number TEXT UNIQUE,
  customer_id INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'angelegt',
  required_technicians INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  fabrikationsnummern TEXT,
  eap_nummer TEXT,
  bestellnummer TEXT,
  updated_at TEXT,
  synced_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS job_addresses (
  job_id INTEGER PRIMARY KEY,
  endkunde TEXT,
  street TEXT NOT NULL,
  house_number TEXT NOT NULL,
  zip TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  address_extra_1 TEXT,
  address_extra_2 TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_hotel_addresses (
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
);

CREATE TABLE IF NOT EXISTS job_technicians (
  job_id INTEGER NOT NULL,
  technician_id INTEGER NOT NULL,
  PRIMARY KEY (job_id, technician_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (technician_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY,
  server_id INTEGER UNIQUE,
  technician_id INTEGER NOT NULL,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  type TEXT,
  comment TEXT,
  synced_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pending_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS absence_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  technician_id INTEGER NOT NULL,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  type TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_absence_requests_tech ON absence_requests(technician_id);
CREATE INDEX IF NOT EXISTS idx_absence_requests_status ON absence_requests(status);

CREATE TABLE IF NOT EXISTS dienstreisen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  running_number INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  company_name TEXT NOT NULL,
  city TEXT,
  country_code TEXT,
  folder_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dienstreisen_year ON dienstreisen(year);

CREATE TABLE IF NOT EXISTS job_files (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  server_id INTEGER,
  original_name TEXT,
  stored_name TEXT,
  stored_path TEXT,
  keep_local INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_files_job ON job_files(job_id);

-- Benutzer-Textbausteine (lokal + server_id nach Sync mit Dispo)
CREATE TABLE IF NOT EXISTS textbausteine_user_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  server_id INTEGER,
  updated_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS textbausteine_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  server_id INTEGER,
  updated_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES textbausteine_user_categories(id)
);
CREATE INDEX IF NOT EXISTS idx_tb_user_cat_tech ON textbausteine_user_categories(technician_id);
CREATE INDEX IF NOT EXISTS idx_tb_user_tech ON textbausteine_user(technician_id);

CREATE TABLE IF NOT EXISTS image_thumb_cache (
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
);
CREATE INDEX IF NOT EXISTS idx_image_thumb_cache_scope ON image_thumb_cache(cache_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_jobs_start ON jobs(start_datetime);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_technicians_tech ON job_technicians(technician_id);
CREATE INDEX IF NOT EXISTS idx_absences_tech ON absences(technician_id);
CREATE INDEX IF NOT EXISTS idx_absences_start ON absences(start_datetime);
