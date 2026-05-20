'use strict';

const crypto = require('crypto');

const ALLOWED_TYPES = new Set([
  'dienstreise_pull',
  'dienstreise_push',
  'sync_pull',
  'sync_push',
  'abrechnung_refresh',
  'anlagenstamm_db_sync',
]);

function ensureBackgroundJobsSchema(sqlDb) {
  try {
    sqlDb.run(`CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT NOT NULL DEFAULT '{}',
      checkpoint_json TEXT,
      progress_phase TEXT,
      progress_current INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      dedupe_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e) {
    /* ignore */
  }
  try {
    sqlDb.run('CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)');
  } catch (e) {
    /* ignore */
  }
  try {
    sqlDb.run('CREATE INDEX IF NOT EXISTS idx_background_jobs_dedupe ON background_jobs(dedupe_key)');
  } catch (e) {
    /* ignore */
  }
}

function newJobId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

/**
 * @param {*} db sql.js DB-Wrapper (prepare/run wie in server.js)
 * @param {() => void} save
 * @param {{ executeJob: (job: object, helpers: object) => Promise<void> }} hooks
 */
function createBackgroundJobService(db, save, hooks) {
  const { executeJob } = hooks;
  let runnerBusy = false;
  /** @type {Map<string, AbortController>} */
  const abortControllers = new Map();

  function parseRow(row) {
    if (!row) return null;
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch (_) {}
    let checkpoint = null;
    try {
      checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null;
    } catch (_) {}
    return { ...row, payload, checkpoint };
  }

  function bump(rowId, patch) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => patch[k]);
    vals.push(rowId);
    db.prepare(`UPDATE background_jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
    const progressOnly =
      keys.length > 0 &&
      keys.every((k) =>
        k === 'progress_phase' || k === 'progress_current' || k === 'progress_total' || k === 'message',
      );
    if (progressOnly) {
      /* Fortschritt nur im RAM/Job-Zeile – kein save() (sql.js export während upsert). */
      return;
    }
    save();
  }

  function deleteQueuedByDedupe(dedupeKey) {
    if (!dedupeKey) return;
    db.prepare(`DELETE FROM background_jobs WHERE dedupe_key = ? AND status = 'queued'`).run(dedupeKey);
    save();
  }

  function markStaleRunningAsInterrupted() {
    const rows = db.prepare(`SELECT id FROM background_jobs WHERE status = 'running'`).all();
    for (const r of rows) {
      bump(r.id, {
        status: 'interrupted',
        message: 'Unterbrochen (App-Neustart).',
        error: null,
      });
    }
  }

  async function pump() {
    if (runnerBusy) return;
    const raw = db.prepare(`SELECT * FROM background_jobs WHERE status = 'queued' ORDER BY datetime(created_at) ASC LIMIT 1`).get();
    if (!raw) return;
    runnerBusy = true;
    const job = parseRow(raw);
    const ac = new AbortController();
    abortControllers.set(job.id, ac);
    bump(job.id, {
      status: 'running',
      progress_phase: 'start',
      message: null,
      error: null,
    });
    try {
      await executeJob(job, {
        signal: ac.signal,
        setProgress: (phase, cur, total, msg) =>
          bump(job.id, {
            progress_phase: phase || null,
            progress_current: cur != null ? cur : 0,
            progress_total: total != null ? total : 0,
            message: msg != null ? msg : null,
          }),
        mergeCheckpoint: (partial) => {
          const row = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
          let cur = {};
          try {
            cur = row && row.checkpoint_json ? JSON.parse(row.checkpoint_json) : {};
          } catch (_) {}
          const merged = Object.assign({}, cur, partial);
          job.checkpoint = merged;
          bump(job.id, { checkpoint_json: JSON.stringify(merged) });
        },
        readCheckpoint: () => {
          const row = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
          try {
            return row && row.checkpoint_json ? JSON.parse(row.checkpoint_json) : {};
          } catch (_) {
            return {};
          }
        },
      });
      bump(job.id, { status: 'completed', progress_phase: 'done', message: 'Fertig.', error: null });
    } catch (e) {
      const aborted = ac.signal.aborted || (e && e.name === 'AbortError');
      const row = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
      let chk = {};
      try {
        chk = row && row.checkpoint_json ? JSON.parse(row.checkpoint_json) : {};
      } catch (_) {}
      const hasResume =
        !!chk.refresh_done_at ||
        (Array.isArray(chk.completed) && chk.completed.length > 0) ||
        (chk.manifest && typeof chk.manifest === 'object' && Object.keys(chk.manifest).length > 0);
      if (aborted) {
        bump(job.id, { status: 'cancelled', error: 'Abgebrochen.', message: null });
      } else if (job.type === 'dienstreise_pull' && hasResume) {
        bump(job.id, {
          status: 'interrupted',
          error: e && e.message ? String(e.message) : String(e),
          message: 'Kopie unterbrochen – wird bei Online fortgesetzt.',
        });
      } else {
        bump(job.id, {
          status: 'failed',
          error: e && e.message ? String(e.message) : String(e),
          message: null,
        });
      }
    } finally {
      abortControllers.delete(job.id);
      runnerBusy = false;
      save();
      setImmediate(() => {
        pump().catch(() => {});
      });
    }
  }

  function findActiveJobIdByDedupe(dedupeKey) {
    if (!dedupeKey) return null;
    const row = db
      .prepare(
        `SELECT id, status FROM background_jobs
         WHERE dedupe_key = ? AND status IN ('queued', 'running')
         ORDER BY datetime(created_at) DESC LIMIT 1`,
      )
      .get(dedupeKey);
    return row && row.id ? row.id : null;
  }

  function enqueue(type, payload, dedupeKey) {
    if (!ALLOWED_TYPES.has(type)) {
      throw new Error('Unbekannter Job-Typ: ' + type);
    }
    const existingId = findActiveJobIdByDedupe(dedupeKey);
    if (existingId) {
      const row = db.prepare('SELECT status FROM background_jobs WHERE id = ?').get(existingId);
      if (row && row.status === 'queued') {
        bump(existingId, { payload_json: JSON.stringify(payload || {}) });
      }
      setImmediate(() => {
        pump().catch(() => {});
      });
      return { job_id: existingId };
    }
    const id = newJobId();
    deleteQueuedByDedupe(dedupeKey);
    db.prepare(
      `INSERT INTO background_jobs (id, type, status, payload_json, dedupe_key, progress_phase, progress_current, progress_total)
       VALUES (?, ?, 'queued', ?, ?, NULL, 0, 0)`,
    ).run(id, type, JSON.stringify(payload || {}), dedupeKey || null);
    save();
    setImmediate(() => {
      pump().catch(() => {});
    });
    return { job_id: id };
  }

  /** Wiederaufnehmbare dienstreise_pull-Jobs nach Online-Badge erneut einreihen (idempotent). */
  function recoverPullJobs() {
    const rows = db.prepare(
      `SELECT id, checkpoint_json, status FROM background_jobs WHERE type = 'dienstreise_pull' AND status IN ('failed', 'interrupted')`,
    ).all();
    let n = 0;
    for (const r of rows) {
      let recoverable = r.status === 'interrupted';
      if (!recoverable && r.checkpoint_json) {
        try {
          const c = JSON.parse(r.checkpoint_json);
          if (c.refresh_done_at || (Array.isArray(c.completed) && c.completed.length > 0)) recoverable = true;
        } catch (_) {}
      }
      if (!recoverable) continue;
      bump(r.id, { status: 'queued', error: null, message: 'Wiederaufnahme nach Online…' });
      n++;
    }
    save();
    setImmediate(() => {
      pump().catch(() => {});
    });
    return { reopened: n };
  }

  function cancelJob(jobId) {
    const row = db.prepare(`SELECT id, status FROM background_jobs WHERE id = ?`).get(jobId);
    if (!row) return { ok: false, error: 'Job nicht gefunden.' };
    if (row.status !== 'queued' && row.status !== 'running') {
      return { ok: false, error: 'Job kann nicht abgebrochen werden (Status: ' + row.status + ').' };
    }
    const ac = abortControllers.get(jobId);
    if (ac) ac.abort();
    bump(jobId, { status: 'cancelled', message: null, error: 'Abgebrochen.' });
    return { ok: true };
  }

  /**
   * @param {number|string} limit
   * @param {boolean | { activeOnly?: boolean, runningOnly?: boolean }} filter
   */
  function listJobs(limit, filter) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const activeOnly = filter === true || (filter && filter.activeOnly);
    const runningOnly = filter && filter.runningOnly;
    if (runningOnly) {
      return db
        .prepare(
          `SELECT * FROM background_jobs WHERE status = 'running'
           ORDER BY datetime(updated_at) DESC LIMIT ?`,
        )
        .all(lim)
        .map((r) => parseRow(r));
    }
    if (activeOnly) {
      return db
        .prepare(
          `SELECT * FROM background_jobs WHERE status IN ('queued','running','interrupted')
           ORDER BY datetime(updated_at) DESC LIMIT ?`,
        )
        .all(lim)
        .map((r) => parseRow(r));
    }
    return db.prepare(`SELECT * FROM background_jobs ORDER BY datetime(updated_at) DESC LIMIT ?`).all(lim).map((r) => parseRow(r));
  }

  function getJob(jobId) {
    const raw = db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).get(jobId);
    return parseRow(raw);
  }

  function kick() {
    setImmediate(() => pump().catch(() => {}));
  }

  return {
    enqueue,
    recoverPullJobs,
    cancelJob,
    listJobs,
    getJob,
    markStaleRunningAsInterrupted,
    kick,
    ALLOWED_TYPES,
  };
}

module.exports = {
  ensureBackgroundJobsSchema,
  createBackgroundJobService,
  ALLOWED_TYPES,
};
