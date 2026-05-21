'use strict';

/**
 * Serialisiert SQLite-Persistenz (sql.js export) und optionale kritische DB-Abschnitte.
 * Verhindert „Statement closed“ / korrupte DB bei parallelem save() und prepare().
 */
function createDbLock() {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  let saveInProgress = false;

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
   * @param {() => boolean} syncSave – synchroner save()-Body des DB-Wrappers (true = OK)
   * Rückgabewert muss synchron sein (Express: if (!save())).
   */
  function wrapSave(syncSave) {
    return function queuedSave() {
      if (saveInProgress) {
        console.warn('[db-lock] paralleler save() – warte auf vorherigen Schreibvorgang');
      }
      saveInProgress = true;
      try {
        return syncSave() !== false;
      } catch (e) {
        console.error('[db-lock] save failed:', e && e.message ? e.message : e);
        return false;
      } finally {
        saveInProgress = false;
      }
    };
  }

  return { runWithDbLock, wrapSave };
}

module.exports = { createDbLock };
