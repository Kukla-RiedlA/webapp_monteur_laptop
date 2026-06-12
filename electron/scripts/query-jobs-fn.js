'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(process.env.APPDATA || '', 'monteur-webapp', 'db', 'monteur.db');
const fn = String(process.argv[3] || '7118').trim();
const db = new Database(dbPath, { readonly: true });
const jobs = db
  .prepare(`SELECT id, fabrikationsnummern FROM jobs WHERE fabrikationsnummern LIKE ?`)
  .all('%' + fn + '%');
console.log(JSON.stringify({ fn, jobs }, null, 2));
db.close();
