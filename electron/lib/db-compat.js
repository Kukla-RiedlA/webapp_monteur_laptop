'use strict';

/**
 * better-sqlite3-Wrapper — API kompatibel zu background_jobs und server.js (ehem. sql.js-Wrapper).
 */
const { getDb, persistDb, getLastPersistError } = require('./db');

function createDbCompat() {
  const db = getDb();
  return {
    exec(sql) {
      db.exec(sql);
    },
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
    // better-sqlite3 schreibt sofort. FULL-Checkpoint nach jedem save() blockiert den
    // Electron-Hauptprozess (glasiges Fenster, „Keine Rückmeldung“) während Sync.
    // TRUNCATE bleibt flushDb() / App-Ende vorbehalten.
    save() {
      persistDb('PASSIVE');
      return !getLastPersistError();
    },
  };
}

module.exports = { createDbCompat };
