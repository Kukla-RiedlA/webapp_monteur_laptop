'use strict';

function run(db, sql) {
  if (db && typeof db.prepare === 'function') db.prepare(sql).run();
  else if (db && typeof db.run === 'function') db.run(sql);
}

function ensureSchema(db) {
  if (!db) return;
  run(db, `CREATE TABLE IF NOT EXISTS anlagenstamm_profinet_teilnehmer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fabrikationsnummer TEXT NOT NULL,
      mac TEXT NOT NULL,
      station_name TEXT,
      ip_address TEXT,
      subnet_mask TEXT,
      gateway TEXT,
      vendor TEXT,
      last_seen_name TEXT,
      last_seen_ip TEXT,
      last_written_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      UNIQUE (fabrikationsnummer, mac)
    )`);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_as_pn_local_fab ON anlagenstamm_profinet_teilnehmer (fabrikationsnummer)');
  run(db, `CREATE TABLE IF NOT EXISTS anlagenstamm_profinet_link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fabrikationsnummer TEXT NOT NULL,
      local_mac TEXT,
      local_port TEXT,
      peer_mac TEXT,
      peer_port TEXT,
      peer_name TEXT,
      scanned_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 1
    )`);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_as_pn_link_local_fab ON anlagenstamm_profinet_link (fabrikationsnummer)');
}

function text(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u0001-\u001F\u007F]/g, '')
    .trim();
}

function listByFab(db, fab) {
  ensureSchema(db);
  const fn = text(fab);
  if (!fn) return { teilnehmer: [], links: [] };
  const teilnehmer = db.prepare(
    `SELECT id, fabrikationsnummer, mac, station_name, ip_address, subnet_mask, gateway, vendor,
            last_seen_name, last_seen_ip, last_written_at, dirty, updated_at
     FROM anlagenstamm_profinet_teilnehmer
     WHERE fabrikationsnummer = ?
     ORDER BY mac`,
  ).all(fn).map(cleanStored);
  const links = db.prepare(
    `SELECT id, fabrikationsnummer, local_mac, local_port, peer_mac, peer_port, peer_name, scanned_at, dirty
     FROM anlagenstamm_profinet_link
     WHERE fabrikationsnummer = ?
     ORDER BY id`,
  ).all(fn).map(cleanStored);
  return { teilnehmer, links };
}

function cleanStored(row) {
  const out = Object.assign({}, row);
  ['station_name', 'ip_address', 'subnet_mask', 'gateway', 'vendor', 'last_seen_name', 'last_seen_ip', 'local_port', 'peer_port', 'peer_name'].forEach((key) => {
    if (out[key] != null) out[key] = text(out[key]);
  });
  return out;
}

function replaceSet(db, fab, teilnehmer, links, opts) {
  ensureSchema(db);
  const fn = text(fab);
  if (!fn) {
    const err = new Error('Fabrikationsnummer fehlt.');
    err.code = 'missing_fab';
    throw err;
  }
  const dirty = opts && opts.dirty === 0 ? 0 : 1;
  const now = new Date().toISOString();
  // db-compat.transaction() führt die Funktion sofort aus und gibt undefined zurück.
  // better-sqlite3 gibt eine Runner-Funktion zurück, die noch aufgerufen werden muss.
  const apply = () => {
    db.prepare('DELETE FROM anlagenstamm_profinet_teilnehmer WHERE fabrikationsnummer = ?').run(fn);
    db.prepare('DELETE FROM anlagenstamm_profinet_link WHERE fabrikationsnummer = ?').run(fn);
    const ins = db.prepare(
      `INSERT INTO anlagenstamm_profinet_teilnehmer (
         fabrikationsnummer, mac, station_name, ip_address, subnet_mask, gateway, vendor,
         last_seen_name, last_seen_ip, last_written_at, dirty, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (teilnehmer || []).forEach((row) => {
      const mac = text(row.mac).toLowerCase();
      if (!mac) return;
      ins.run(
        fn,
        mac,
        text(row.station_name),
        text(row.ip_address),
        text(row.subnet_mask),
        text(row.gateway),
        text(row.vendor),
        text(row.last_seen_name),
        text(row.last_seen_ip),
        text(row.last_written_at) || null,
        dirty,
        now,
      );
    });
    const insLink = db.prepare(
      `INSERT INTO anlagenstamm_profinet_link (
         fabrikationsnummer, local_mac, local_port, peer_mac, peer_port, peer_name, scanned_at, dirty
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (links || []).forEach((row) => {
      insLink.run(
        fn,
        text(row.local_mac).toLowerCase(),
        text(row.local_port),
        text(row.peer_mac).toLowerCase(),
        text(row.peer_port),
        text(row.peer_name),
        text(row.scanned_at) || now,
        dirty,
      );
    });
  };
  if (db && typeof db.transaction === 'function') {
    const ret = db.transaction(apply);
    if (typeof ret === 'function') ret();
  } else {
    apply();
  }
  return listByFab(db, fn);
}

function markClean(db, fab) {
  const fn = text(fab);
  if (!fn) return;
  db.prepare('UPDATE anlagenstamm_profinet_teilnehmer SET dirty = 0 WHERE fabrikationsnummer = ?').run(fn);
  db.prepare('UPDATE anlagenstamm_profinet_link SET dirty = 0 WHERE fabrikationsnummer = ?').run(fn);
}

module.exports = { ensureSchema, listByFab, replaceSet, markClean };
