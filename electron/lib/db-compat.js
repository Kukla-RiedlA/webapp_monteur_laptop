'use strict';

/**
 * better-sqlite3-Wrapper — API kompatibel zu background_jobs und server.js (ehem. sql.js-Wrapper).
 */
const { getDb, persistDb, getLastPersistError } = require('./db');

function createDbCompat() {
  const db = getDb();
  return {
    run(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          return stmt.run(...params);
        },
        get(...params) {
          return stmt.get(...params);
        },
        all(...params) {
          return stmt.all(...params);
        },
      };
    },
    transaction(fn) {
      db.transaction(fn)();
    },
    save() {
      persistDb('FULL');
      return !getLastPersistError();
    },
  };
}

module.exports = { createDbCompat };
