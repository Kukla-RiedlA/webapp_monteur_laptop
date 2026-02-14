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
  status TEXT NOT NULL DEFAULT 'geplant',
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
  street TEXT NOT NULL,
  house_number TEXT NOT NULL,
  zip TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  address_extra_1 TEXT,
  address_extra_2 TEXT,
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

CREATE INDEX IF NOT EXISTS idx_jobs_start ON jobs(start_datetime);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_technicians_tech ON job_technicians(technician_id);
CREATE INDEX IF NOT EXISTS idx_absences_tech ON absences(technician_id);
CREATE INDEX IF NOT EXISTS idx_absences_start ON absences(start_datetime);
