'use strict';

const crypto = require('crypto');

const ALLOWED_TYPES = new Set([
  'dienstreise_pull',
  'dienstreise_push',
  'dienstreise_finish',
  'sync_pull',
  'sync_push',
  'abrechnung_refresh',
  'anlagenstamm_db_sync',
]);

/** Niedrigere Zahl = früher in der Queue (vor sync_pull). */
const JOB_TYPE_PRIORITY = {
  dienstreise_pull: 10,
  dienstreise_finish: 15,
  dienstreise_push: 20,
  sync_push: 30,
  sync_pull: 40,
  abrechnung_refresh: 50,
  anlagenstamm_db_sync: 60,
};

const HIGH_PRIORITY_TYPES = new Set(['dienstreise_pull', 'dienstreise_push', 'dienstreise_finish', 'sync_push']);

/** running ohne Fortschritt → abbrechen (Refresh-Timeout Server ist 60 s). */
const STALE_RUNNING_MS = 8 * 60 * 1000;
/** Manifest/Liste nach refresh_done soll nicht stundenlang „Sync 1“ zeigen. */
const STALE_SLOW_PHASE_MS = 5 * 60 * 1000;
const SLOW_PROGRESS_PHASES = new Set(['refresh', 'refresh_done', 'manifest', 'start']);
/** interrupted blockiert Sync/UI nicht ewig. */
const STALE_INTERRUPTED_MS = 8 * 60 * 1000;
const MAX_RECOVER_ATTEMPTS = 2;

const JOB_TIMEOUT_MS = {
  dienstreise_pull: 90 * 60 * 1000,
  dienstreise_push: 25 * 60 * 1000,
  dienstreise_finish: 25 * 60 * 1000,
  sync_push: 20 * 60 * 1000,
  sync_pull: 35 * 60 * 1000,
  abrechnung_refresh: 15 * 60 * 1000,
  anlagenstamm_db_sync: 25 * 60 * 1000,
};

/** Gleichzeitig laufende Worker (z. B. Finish Job A während Pull Job B). */
const MAX_CONCURRENT_JOBS = 4;

/** Nur ein Lauf pro Typ (DB-/Sync-Exklusivität). */
const EXCLUSIVE_SINGLE_TYPES = new Set(['sync_pull', 'sync_push', 'abrechnung_refresh', 'anlagenstamm_db_sync']);

const DIENSTREISE_JOB_TYPES = new Set(['dienstreise_pull', 'dienstreise_push', 'dienstreise_finish']);

function localJobIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.job_id ?? payload.jobId ?? payload.local_job_id ?? payload.localJobId;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function jobsWouldConflict(typeA, payloadA, typeB, payloadB) {
  if (typeA === typeB && EXCLUSIVE_SINGLE_TYPES.has(typeA)) return true;
  const idA = DIENSTREISE_JOB_TYPES.has(typeA) ? localJobIdFromPayload(payloadA) : null;
  const idB = DIENSTREISE_JOB_TYPES.has(typeB) ? localJobIdFromPayload(payloadB) : null;
  if (idA != null && idB != null && idA === idB) return true;
  return false;
}

function execSchemaSql(db, sql) {
  if (db && typeof db.exec === 'function') {
    db.exec(sql);
  } else if (db && typeof db.run === 'function') {
    db.run(sql);
  } else if (db && db.prepare) {
    db.prepare(sql).run();
  }
}

function ensureBackgroundJobsSchema(db) {
  try {
    execSchemaSql(db, `CREATE TABLE IF NOT EXISTS background_jobs (
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
    execSchemaSql(db, 'CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)');
  } catch (e) {
    /* ignore */
  }
  try {
    execSchemaSql(db, 'CREATE INDEX IF NOT EXISTS idx_background_jobs_dedupe ON background_jobs(dedupe_key)');
  } catch (e) {
    /* ignore */
  }
}

function newJobId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

/**
 * @param {*} db DB-Wrapper (prepare/get/all/run, transaction, save)
 * @param {() => void} save
 * @param {{ executeJob: (job: object, helpers: object) => Promise<void> }} hooks
 */
function createBackgroundJobService(db, save, hooks) {
  const { executeJob } = hooks;
  let activeRunnerCount = 0;
  /** @type {Map<string, { type: string, payload: object }>} */
  const runningWorkers = new Map();
  /** @type {Map<string, AbortController>} */
  const abortControllers = new Map();

  function conflictsWithRunning(type, payload) {
    for (const running of runningWorkers.values()) {
      if (jobsWouldConflict(type, payload, running.type, running.payload)) return true;
    }
    return false;
  }

  function schedulePump() {
    setImmediate(() => {
      pump().catch(() => {});
    });
  }

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
      /* Fortschritt: WAL persistiert ohne Full-Export; save() optional übersprungen. */
      return;
    }
    save();
  }

  function deleteQueuedByDedupe(dedupeKey) {
    if (!dedupeKey) return;
    db.prepare(`DELETE FROM background_jobs WHERE dedupe_key = ? AND status = 'queued'`).run(dedupeKey);
    save();
  }

  function pullCheckpointHasResume(chk) {
    if (!chk || typeof chk !== 'object') return false;
    return (
      !!chk.refresh_done_at ||
      (Array.isArray(chk.completed) && chk.completed.length > 0) ||
      (Array.isArray(chk.ted_completed) && chk.ted_completed.length > 0) ||
      (chk.manifest && typeof chk.manifest === 'object' && Object.keys(chk.manifest).length > 0)
    );
  }

  function parsePayloadJson(raw) {
    try {
      return JSON.parse(raw || '{}');
    } catch (_) {
      return {};
    }
  }

  function jobAgeMs(updatedAt, now) {
    const updatedMs = updatedAt ? Date.parse(String(updatedAt).replace(' ', 'T') + 'Z') : NaN;
    return Number.isFinite(updatedMs) ? now - updatedMs : STALE_RUNNING_MS + 1;
  }

  /** status=running, aber kein aktiver Worker (z. B. nach Absturz ohne Neustart-Reap). */
  function reapOrphanRunningJobs(now) {
    const runningRows = db.prepare(`SELECT id FROM background_jobs WHERE status = 'running'`).all();
    let n = 0;
    for (const r of runningRows) {
      if (abortControllers.has(r.id)) continue;
      bump(r.id, {
        status: 'interrupted',
        message: 'Hänger erkannt – wird bei Sync fortgesetzt.',
        error: null,
        progress_phase: null,
      });
      n++;
    }
    return n;
  }

  /** Hängende / blockierende Jobs beenden — ohne manuelles DB-Eingreifen. */
  function reapStuckJobs() {
    const now = Date.now();
    reapOrphanRunningJobs(now);
    const runningRows = db
      .prepare(
        `SELECT id, type, payload_json, checkpoint_json, progress_phase, updated_at
         FROM background_jobs WHERE status = 'running'`,
      )
      .all();
    for (const r of runningRows) {
      const age = jobAgeMs(r.updated_at, now);
      const phase = r.progress_phase ? String(r.progress_phase) : '';
      const staleLimit = SLOW_PROGRESS_PHASES.has(phase) ? STALE_SLOW_PHASE_MS : STALE_RUNNING_MS;
      if (age < staleLimit) continue;
      const ac = abortControllers.get(r.id);
      if (ac) {
        try {
          ac.abort();
        } catch (_) {
          /* ignore */
        }
      }
      bump(r.id, {
        status: 'failed',
        error: 'Zeitüberschreitung – Hintergrund-Job wurde automatisch beendet.',
        message: null,
        progress_phase: null,
      });
    }

    const interruptedRows = db
      .prepare(
        `SELECT id, type, payload_json, checkpoint_json, error, updated_at
         FROM background_jobs WHERE status = 'interrupted'`,
      )
      .all();
    for (const r of interruptedRows) {
      const payload = parsePayloadJson(r.payload_json);
      let chk = {};
      try {
        chk = r.checkpoint_json ? JSON.parse(r.checkpoint_json) : {};
      } catch (_) {}
      const age = jobAgeMs(r.updated_at, now);
      const attempts = Number(chk.recover_attempts) || 0;
      const acceptJob = !!(payload && payload.accept_job);
      const hasResume = pullCheckpointHasResume(chk);
      const shouldFail =
        attempts >= MAX_RECOVER_ATTEMPTS ||
        age >= STALE_INTERRUPTED_MS ||
        (acceptJob && !hasResume);
      if (!shouldFail) continue;
      bump(r.id, {
        status: 'failed',
        error:
          (r.error && String(r.error).trim()) ||
          'Unterbrochen – automatisch beendet. Bitte erneut versuchen (Sync oder Auftrag annehmen).',
        message: null,
      });
    }
    save();
  }

  function markStaleRunningAsInterrupted() {
    const rows = db.prepare(`SELECT id FROM background_jobs WHERE status = 'running'`).all();
    for (const r of rows) {
      const ac = abortControllers.get(r.id);
      if (ac) {
        try {
          ac.abort();
        } catch (_) {
          /* ignore */
        }
      }
      bump(r.id, {
        status: 'interrupted',
        message: 'Unterbrochen (App-Neustart).',
        error: null,
      });
    }
    reapStuckJobs();
  }

  function countQueuedHighPriority() {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM background_jobs
         WHERE status IN ('queued', 'running') AND type IN ('dienstreise_pull', 'dienstreise_push', 'sync_push')`,
      )
      .get();
    return row && row.n != null ? Number(row.n) : 0;
  }

  const QUEUED_ORDER_SQL = `SELECT * FROM background_jobs WHERE status = 'queued'
         ORDER BY
           CASE type
             WHEN 'dienstreise_pull' THEN 10
             WHEN 'dienstreise_finish' THEN 15
             WHEN 'dienstreise_push' THEN 20
             WHEN 'sync_push' THEN 30
             WHEN 'sync_pull' THEN 40
             WHEN 'abrechnung_refresh' THEN 50
             WHEN 'anlagenstamm_db_sync' THEN 60
             ELSE 99
           END ASC,
           datetime(created_at) ASC`;

  function startJobIfQueued(job) {
    if (activeRunnerCount >= MAX_CONCURRENT_JOBS) return false;
    const row = db.prepare('SELECT status FROM background_jobs WHERE id = ?').get(job.id);
    if (!row || row.status !== 'queued') return false;
    if (conflictsWithRunning(job.type, job.payload)) return false;

    activeRunnerCount++;
    runningWorkers.set(job.id, { type: job.type, payload: job.payload });

    const ac = new AbortController();
    abortControllers.set(job.id, ac);
    bump(job.id, {
      status: 'running',
      progress_phase: 'start',
      message: null,
      error: null,
    });

    const jobTimeoutMs = JOB_TIMEOUT_MS[job.type] || 30 * 60 * 1000;
    let jobTimeoutId = null;
    const jobTimedOut = new Promise((_, reject) => {
      jobTimeoutId = setTimeout(() => {
        try {
          ac.abort();
        } catch (_) {
          /* ignore */
        }
        reject(
          new Error(
            'Zeitüberschreitung (' + Math.round(jobTimeoutMs / 60000) + ' Min) – Job wurde beendet.',
          ),
        );
      }, jobTimeoutMs);
    });

    (async () => {
      try {
        await Promise.race([
          executeJob(job, {
            signal: ac.signal,
            setProgress: (phase, cur, total, msg) =>
              bump(job.id, {
                progress_phase: phase || null,
                progress_current: cur != null ? cur : 0,
                progress_total: total != null ? total : 0,
                message: msg != null ? msg : null,
              }),
            mergeCheckpoint: (partial) => {
              const chkRow = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
              let cur = {};
              try {
                cur = chkRow && chkRow.checkpoint_json ? JSON.parse(chkRow.checkpoint_json) : {};
              } catch (_) {}
              const merged = Object.assign({}, cur, partial);
              job.checkpoint = merged;
              bump(job.id, { checkpoint_json: JSON.stringify(merged) });
            },
            readCheckpoint: () => {
              const chkRow = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
              try {
                return chkRow && chkRow.checkpoint_json ? JSON.parse(chkRow.checkpoint_json) : {};
              } catch (_) {
                return {};
              }
            },
          }),
          jobTimedOut,
        ]);
        bump(job.id, { status: 'completed', progress_phase: 'done', message: 'Fertig.', error: null });
      } catch (e) {
        const aborted = ac.signal.aborted || (e && e.name === 'AbortError');
        const chkRow = db.prepare('SELECT checkpoint_json FROM background_jobs WHERE id = ?').get(job.id);
        let chk = {};
        try {
          chk = chkRow && chkRow.checkpoint_json ? JSON.parse(chkRow.checkpoint_json) : {};
        } catch (_) {}
        const hasResume =
          !!chk.refresh_done_at ||
          (Array.isArray(chk.completed) && chk.completed.length > 0) ||
          (Array.isArray(chk.ted_completed) && chk.ted_completed.length > 0) ||
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
        if (jobTimeoutId) clearTimeout(jobTimeoutId);
        abortControllers.delete(job.id);
        runningWorkers.delete(job.id);
        activeRunnerCount = Math.max(0, activeRunnerCount - 1);
        save();
        schedulePump();
      }
    })().catch(() => {});

    return true;
  }

  async function pump() {
    reapStuckJobs();
    if (activeRunnerCount >= MAX_CONCURRENT_JOBS) return;
    const queuedRows = db.prepare(QUEUED_ORDER_SQL).all();
    if (!queuedRows.length) return;
    let started = 0;
    for (const raw of queuedRows) {
      if (activeRunnerCount >= MAX_CONCURRENT_JOBS) break;
      const job = parseRow(raw);
      if (startJobIfQueued(job)) started++;
    }
    if (!started && queuedRows.length > 0 && activeRunnerCount < MAX_CONCURRENT_JOBS) {
      /* Alle wartenden Jobs kollidieren mit laufenden — nichts zu tun bis ein Worker endet. */
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
    if (dedupeKey) {
      db.prepare(
        `UPDATE background_jobs SET status = 'cancelled', error = 'Ersetzt durch neuen Job.', message = NULL
         WHERE dedupe_key = ? AND status IN ('interrupted', 'failed')`,
      ).run(dedupeKey);
    }
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

  /**
   * Wiederaufnehmbare dienstreise_pull-Jobs (Delta-Kopie), nicht „Auftrag annehmen“ beim Sync.
   * @param {{ skipAcceptJob?: boolean }} opts
   */
  function recoverPullJobs(opts) {
    opts = opts || {};
    const skipAcceptJob = opts.skipAcceptJob !== false;
    reapStuckJobs();
    const rows = db
      .prepare(
        `SELECT id, payload_json, checkpoint_json, status FROM background_jobs
         WHERE type = 'dienstreise_pull' AND status IN ('failed', 'interrupted')`,
      )
      .all();
    let n = 0;
    for (const r of rows) {
      const payload = parsePayloadJson(r.payload_json);
      if (skipAcceptJob && payload.accept_job) continue;
      let chk = {};
      try {
        chk = r.checkpoint_json ? JSON.parse(r.checkpoint_json) : {};
      } catch (_) {}
      const attempts = Number(chk.recover_attempts) || 0;
      if (attempts >= MAX_RECOVER_ATTEMPTS) continue;
      let recoverable = r.status === 'interrupted';
      if (!recoverable) {
        recoverable = pullCheckpointHasResume(chk);
      }
      if (!recoverable) continue;
      chk.recover_attempts = attempts + 1;
      bump(r.id, {
        status: 'queued',
        error: null,
        message: 'Wiederaufnahme nach Online…',
        checkpoint_json: JSON.stringify(chk),
      });
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

  /** Laufende Jobs eines Typs abbrechen (z. B. sync_pull vor Auftrag annehmen). */
  function cancelRunningOfType(type) {
    const rows = db.prepare(`SELECT id FROM background_jobs WHERE status = 'running' AND type = ?`).all(type);
    let n = 0;
    for (const r of rows) {
      const x = cancelJob(r.id);
      if (x.ok) n++;
    }
    return n;
  }

  /** Pull/Push/Finish für denselben lokalen Auftrag abbrechen (vor Abschluss). */
  function cancelRunningDienstreiseForLocalJob(localJobId) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return 0;
    const rows = db
      .prepare(
        `SELECT id, type, payload_json FROM background_jobs
         WHERE status IN ('queued', 'running') AND type IN ('dienstreise_pull', 'dienstreise_push', 'dienstreise_finish')`,
      )
      .all();
    let n = 0;
    for (const r of rows) {
      const payload = parsePayloadJson(r.payload_json);
      if (localJobIdFromPayload(payload) !== lid) continue;
      if (r.status === 'queued') {
        bump(r.id, { status: 'cancelled', error: 'Abgebrochen für Abschluss.', message: null });
        n++;
        continue;
      }
      const x = cancelJob(r.id);
      if (x.ok) n++;
    }
    if (n) save();
    return n;
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
          `SELECT * FROM background_jobs WHERE status IN ('queued','running')
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
    schedulePump();
  }

  return {
    enqueue,
    recoverPullJobs,
    reapStuckJobs,
    cancelJob,
    cancelRunningOfType,
    cancelRunningDienstreiseForLocalJob,
    listJobs,
    getJob,
    markStaleRunningAsInterrupted,
    kick,
    countQueuedHighPriority,
    ALLOWED_TYPES,
  };
}

module.exports = {
  ensureBackgroundJobsSchema,
  createBackgroundJobService,
  ALLOWED_TYPES,
  JOB_TYPE_PRIORITY,
  HIGH_PRIORITY_TYPES,
};
