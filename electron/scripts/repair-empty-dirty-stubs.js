'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { ensureAnlagenstammLocalSchema, clearEmptyDirtyAnlagenstammStubs, lookupByFab } = require('../lib/anlagenstamm-local');

const fn = String(process.argv[2] || '7118').trim();
const dbPath = process.argv[3] || path.join(process.env.APPDATA || '', 'monteur-webapp', 'db', 'monteur.db');
const db = new Database(dbPath);
ensureAnlagenstammLocalSchema(db);
const before = lookupByFab(db, fn);
const removed = clearEmptyDirtyAnlagenstammStubs(db);
const after = lookupByFab(db, fn);
console.log(JSON.stringify({ dbPath, fn, before, removed, after }, null, 2));
db.close();
