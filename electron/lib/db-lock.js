'use strict';

/**
 * Serialisiert SQLite-Persistenz (sql.js export) und optionale kritische DB-Abschnitte.
 * Verhindert „Statement closed“ / korrupte DB bei parallelem save() und prepare().
 */
function createDbLock() {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();

  function runWithDbLock(fn) {
    const run = async () => {
      await tail;
      return fn();
    };
    const next = run();
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * @param {() => void} syncSave – synchroner save()-Body des DB-Wrappers
   */
  function wrapSave(syncSave) {
    return function queuedSave() {
      runWithDbLock(() => {
        syncSave();
      }).catch((e) => {
        console.error('[db-lock] save failed:', e && e.message ? e.message : e);
      });
    };
  }

  return { runWithDbLock, wrapSave };
}

module.exports = { createDbLock };
