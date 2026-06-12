'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(process.env.APPDATA || '', 'monteur-webapp', 'db', 'monteur.db');
const fn = String(process.argv[3] || '7118').trim();
const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    `SELECT id, fabrikationsnummer, type, leistung, dirty, synced_at
     FROM anlagenstamm_local
     WHERE TRIM(fabrikationsnummer) = TRIM(?)
        OR REPLACE(TRIM(fabrikationsnummer), ' ', '') = REPLACE(TRIM(?), ' ', '')
     ORDER BY dirty DESC, id`,
  )
  .all(fn, fn);
console.log(JSON.stringify({ dbPath, fn, rows }, null, 2));
db.close();
