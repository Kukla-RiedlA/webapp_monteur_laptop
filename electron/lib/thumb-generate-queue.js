'use strict';

/**
 * Begrenzt parallele Thumbnail-Erzeugung (sharp), damit das Electron-Fenster nicht einfriert.
 */
function createThumbGenerateQueue(opts) {
  const concurrency = Math.max(1, Math.min(4, (opts && opts.concurrency) || 1));
  const queue = [];
  const inflight = new Map();
  let active = 0;

  function jobKey(arg) {
    if (arg && arg.key) return String(arg.key);
    return JSON.stringify(arg || {});
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (!job) break;
      active += 1;
      Promise.resolve()
        .then(() => job.run())
        .then(job.resolve, job.reject)
        .finally(() => {
          inflight.delete(job.key);
          active -= 1;
          pump();
        });
    }
  }

  function enqueue(arg, run) {
    const key = jobKey(arg);
    if (inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve, reject) => {
      queue.push({ key, run, resolve, reject });
      pump();
    });
    inflight.set(key, p);
    return p;
  }

  return { enqueue };
}

module.exports = { createThumbGenerateQueue };
