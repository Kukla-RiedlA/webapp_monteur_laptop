'use strict';

/**
 * Multi-Device Gateway-Routen und Hilfen für den Monteur-Laptop.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { getOrCreateDeviceId, defaultDisplayName } = require('./device-id');
const {
  readLocalDraftFile,
  writeLocalDraftFile,
  stripDraftMeta,
  draftPayloadsEqual,
  isEmptyMonteurDraftPayload,
  pruneEmptyMonteurDraftJsons,
  reconcileLocalTreeWithManifest,
  formatBytes,
  writeConflictCopy,
  writePayloadConflictCopy,
  mergeByFabStores,
  mergeFlatProtocolStores,
  hasRealByFab,
  draftDataImageCount,
  draftTimestampNewer,
  resolveMonteurDraftJsonPath,
  MONTEUR_DRAFT_BASENAMES,
  DRAFT_JSON_ENDPOINTS,
} = require('./multi-device-sync');
const protocolDrafts = require('./protocol-drafts-local');

function ensureMultiDeviceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multi_device_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_job_id INTEGER,
      server_job_id INTEGER,
      rel_path TEXT,
      detail_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS jobs_pending_local_cleanup (
      local_job_id INTEGER PRIMARY KEY,
      server_job_id INTEGER,
      reason TEXT NOT NULL,
      status_on_server TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function authHeaderFromCreds(username, password) {
  const u = String(username || '').trim();
  const p = password != null ? String(password) : '';
  if (!u) return {};
  const token = Buffer.from(u + ':' + p, 'utf8').toString('base64');
  return { Authorization: 'Basic ' + token };
}

/**
 * @param {object} deps
 */
function registerMultiDeviceRoutes(deps) {
  const {
    app,
    db,
    DB_DIR,
    save,
    fetchWithTimeout,
    getTechnicianId,
    resolveDienstreiseReiseDirForJob,
    cleanupDienstreiseReiseDir,
    listProtectedPaths,
    bgJobs,
    getBgJobs,
    enqueueDienstreisePushForJob,
    getAppVersion,
  } = deps;

  const resolveBgJobs = () => (typeof getBgJobs === 'function' ? getBgJobs() : bgJobs);

  ensureMultiDeviceTables(db);
  try {
    // Pseudo-Konflikt-Banner aus Revisions-Bug leeren (alte Einträge sonst ewig sichtbar)
    db.prepare('DELETE FROM multi_device_conflicts').run();
    save();
  } catch (_) {
    /* ignore */
  }

  function deviceId() {
    return getOrCreateDeviceId(DB_DIR);
  }

  function draftBasename(opts) {
    return opts.basename || path.basename(String(opts.filePath || '').replace(/\\/g, '/'));
  }

  function readDraftState(opts) {
    const basename = draftBasename(opts);
    if (db && opts.localJobId && basename) {
      return protocolDrafts.readDraft(db, opts.localJobId, basename, opts.reiseDir);
    }
    return readLocalDraftFile(opts.filePath);
  }

  function writeDraftState(opts, payload, revision, serverUpdatedAt) {
    const basename = draftBasename(opts);
    if (db && opts.localJobId && basename) {
      protocolDrafts.writeDraft(
        db,
        opts.localJobId,
        basename,
        payload,
        revision,
        serverUpdatedAt,
        opts.reiseDir,
      );
      return;
    }
    writeLocalDraftFile(opts.filePath, payload, revision, serverUpdatedAt);
  }

  function preserveLocalDraftCopy(opts, payload) {
    const filePath =
      opts.filePath ||
      (opts.reiseDir && opts.basename
        ? resolveMonteurDraftJsonPath(opts.reiseDir, opts.basename, false)
        : '');
    return writePayloadConflictCopy(filePath, payload || {}, deviceId());
  }

  function clearDraftPushPending(opts) {
    const localJobId = opts && opts.localJobId;
    const basename = draftBasename(opts || {});
    if (!db || !localJobId || !basename) return;
    try {
      db.prepare(
        `DELETE FROM pending_changes WHERE entity_type = 'protocol_draft' AND entity_id = ? AND action = 'push'`,
      ).run(String(localJobId) + ':' + basename);
      save();
    } catch (_) {
      /* ignore */
    }
  }

  function queueDraftPushPending(opts) {
    const localJobId = opts && opts.localJobId;
    const basename = draftBasename(opts || {});
    if (!db || !localJobId || !basename) return false;
    const entityId = String(localJobId) + ':' + basename;
    const payload = {
      dispoBaseUrl: opts.dispoBaseUrl,
      endpoint: opts.endpoint,
      technicianId: opts.technicianId,
      serverJobId: opts.serverJobId,
      localJobId,
      reiseDir: opts.reiseDir || '',
      filePath: opts.filePath || '',
      basename,
      username: opts.username,
      password: opts.password,
    };
    try {
      db.prepare(
        `DELETE FROM pending_changes WHERE entity_type = 'protocol_draft' AND entity_id = ? AND action = 'push'`,
      ).run(entityId);
      db.prepare(
        `INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES (?, ?, ?, ?)`,
      ).run('protocol_draft', entityId, 'push', JSON.stringify(payload));
      save();
      return true;
    } catch (e) {
      console.warn('[draft_push] queue failed', basename, e && e.message ? e.message : e);
      return false;
    }
  }

  function clearConflictsForFile(localJobId, serverJobId, relPath) {
    const base = path.basename(String(relPath || '').replace(/\\/g, '/'));
    if (!base) return;
    try {
      if (localJobId != null && Number(localJobId) > 0) {
        db.prepare(
          'DELETE FROM multi_device_conflicts WHERE rel_path = ? AND local_job_id = ?',
        ).run(base, Number(localJobId));
      } else if (serverJobId != null && Number(serverJobId) > 0) {
        db.prepare(
          'DELETE FROM multi_device_conflicts WHERE rel_path = ? AND server_job_id = ?',
        ).run(base, Number(serverJobId));
      } else {
        db.prepare('DELETE FROM multi_device_conflicts WHERE rel_path = ?').run(base);
      }
      save();
    } catch (_) {
      /* ignore */
    }
  }

  async function registerDeviceOnDispo(opts) {
    const base = String(opts.dispoBaseUrl || '').replace(/\/$/, '');
    const technicianId = parseInt(opts.technicianId, 10);
    if (!base || !technicianId) return { ok: false, error: 'missing_params' };
    const id = deviceId();
    const auth = authHeaderFromCreds(opts.username, opts.password);
    try {
      const r = await fetchWithTimeout(base + '/dispo_api/api/monteur_device_register.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
        body: JSON.stringify({
          technician_id: technicianId,
          device_id: id,
          display_name: opts.displayName || defaultDisplayName(),
          app_version: (getAppVersion && getAppVersion()) || '',
          os_info: process.platform + ' ' + (process.arch || ''),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        return {
          ok: false,
          revoked: data.code === 'device_revoked' || !!data.revoked,
          error: data.error || r.statusText,
          peer_count: 0,
        };
      }
      return { ok: true, device_id: id, peer_count: Number(data.peer_count) || 0 };
    } catch (e) {
      return { ok: false, error: e.message || 'register_failed', peer_count: 0 };
    }
  }

  async function heartbeatOnDispo(opts) {
    const base = String(opts.dispoBaseUrl || '').replace(/\/$/, '');
    const technicianId = parseInt(opts.technicianId, 10);
    if (!base || !technicianId) return { ok: false };
    const auth = authHeaderFromCreds(opts.username, opts.password);
    try {
      const r = await fetchWithTimeout(base + '/dispo_api/api/monteur_device_heartbeat.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
        body: JSON.stringify({
          technician_id: technicianId,
          device_id: deviceId(),
          job_id: opts.serverJobId || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      return {
        ok: !!(r.ok && data.ok),
        peer_count: Number(data.peer_count) || 0,
        peers_on_job: data.peers_on_job || [],
        revoked: data.code === 'device_revoked',
      };
    } catch (_) {
      return { ok: false, peer_count: 0, peers_on_job: [] };
    }
  }

  async function pushJsonDraft(opts) {
    const tPush = Date.now();
    const base = String(opts.dispoBaseUrl || '').replace(/\/$/, '');
    const endpoint = opts.endpoint;
    const technicianId = parseInt(opts.technicianId, 10);
    const serverJobId = parseInt(opts.serverJobId, 10);
    const basename = draftBasename(opts);
    if (!base || !endpoint || !technicianId || !serverJobId || !basename) {
      return { ok: false, skipped: true };
    }
    const local = readDraftState(opts);
    if (isEmptyMonteurDraftPayload(local.payload) && (!local.revision || local.revision <= 0)) {
      return { ok: true, skipped: true, empty: true };
    }
    const auth = authHeaderFromCreds(opts.username, opts.password);
    const postHeaders = {
      'Content-Type': 'application/json',
      'X-Technician-Id': String(technicianId),
      'X-Device-Id': deviceId(),
      ...auth,
    };

    // Immer Server-Revision als base holen. Lokal kann hinterherhinken (erster Speichern
    // nach leerem Ordner, fehlendes Meta, paralleler Push) → sonst sofort 409 + .conflict-*.
    let baseRevision = local.revision;
    try {
      const getUrl =
        base +
        endpoint +
        '?job_id=' +
        encodeURIComponent(serverJobId) +
        '&technician_id=' +
        encodeURIComponent(technicianId);
      const gr = await fetchWithTimeout(getUrl, {
        headers: { 'X-Technician-Id': String(technicianId), ...auth },
      });
      const gd = await gr.json().catch(() => ({}));
      if (gr.ok && gd && gd.ok) {
        const remoteRev = parseInt(gd.revision, 10) || 0;
        const remotePayload = stripDraftMeta(gd.store || gd.data || {});
        if (
          remotePayload &&
          typeof remotePayload === 'object' &&
          !isEmptyMonteurDraftPayload(remotePayload)
        ) {
          if (hasRealByFab(local.payload) || hasRealByFab(remotePayload)) {
            const merged = mergeByFabStores(local.payload, remotePayload);
            local.payload = merged.payload;
          } else {
            const merged = mergeFlatProtocolStores(local.payload, remotePayload);
            if (draftDataImageCount(merged) > draftDataImageCount(local.payload)) {
              local.payload = merged;
            }
          }
        }
        if (remoteRev !== baseRevision) {
          console.warn(
            '[draft_push] align base_revision',
            basename,
            'local=',
            baseRevision,
            'server=',
            remoteRev,
          );
        }
        baseRevision = remoteRev;
      }
    } catch (_) {
      /* Preflight optional – Push versucht es trotzdem */
    }

    async function postWithBase(rev) {
      const r = await fetchWithTimeout(base + endpoint, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({
          technician_id: technicianId,
          job_id: serverJobId,
          store: local.payload,
          base_revision: rev,
          device_id: deviceId(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      return { r, data };
    }

    try {
      let { r, data } = await postWithBase(baseRevision);
      if (r.status === 409 && data.code === 'job_closed') {
        console.warn(
          '[draft_push] job_closed',
          basename,
          'job=',
          serverJobId,
        );
        return { ok: false, code: 'job_closed', error: data.error };
      }
      if (r.status === 409 && data.code === 'conflict') {
        const remotePayload = data.store || data.data || {};
        const remoteRev = parseInt(data.revision, 10) || 0;
        // Gleicher Fachinhalt, nur Revisions-Drift → Meta übernehmen
        if (draftPayloadsEqual(local.payload, remotePayload)) {
          writeDraftState(
            opts,
            stripDraftMeta(remotePayload),
            remoteRev,
            data.server_updated_at || null,
          );
          clearConflictsForFile(opts.localJobId, serverJobId, basename);
          clearDraftPushPending(opts);
          console.warn(
            '[draft_push] soft-resolve (equal payload)',
            basename,
            'rev',
            remoteRev,
          );
          return {
            ok: true,
            revision: remoteRev,
            code: null,
            soft_resolved: true,
          };
        }
        // Bewusstes Speichern auf diesem Gerät: mit Server-Revision erneut pushen (gemergter Store)
        if (remoteRev !== baseRevision) {
          console.warn(
            '[draft_push] retry with remote base_revision',
            basename,
            'localBase=',
            baseRevision,
            'remote=',
            remoteRev,
          );
          const mergedConflict =
            hasRealByFab(local.payload) || hasRealByFab(stripDraftMeta(remotePayload))
              ? mergeByFabStores(local.payload, stripDraftMeta(remotePayload))
              : { payload: mergeFlatProtocolStores(local.payload, stripDraftMeta(remotePayload)) };
          local.payload = mergedConflict.payload;
          const retry = await postWithBase(remoteRev);
          r = retry.r;
          data = retry.data;
          if (r.ok && data && data.ok) {
            writeDraftState(
              opts,
              stripDraftMeta(data.store || data.data || local.payload),
              data.revision != null ? data.revision : remoteRev + 1,
              data.server_updated_at || null,
            );
            clearConflictsForFile(opts.localJobId, serverJobId, basename);
            clearDraftPushPending(opts);
            return { ok: true, revision: data.revision, code: null, retried: true };
          }
          if (r.status === 409 && data.code === 'job_closed') {
            return { ok: false, code: 'job_closed', error: data.error };
          }
        }
        console.warn(
          '[draft_push] hard conflict',
          basename,
          'job=',
          serverJobId,
          'base=',
          baseRevision,
          'remote=',
          remoteRev,
        );
        preserveLocalDraftCopy(opts, local.payload);
        if (opts.filePath) writeConflictCopy(opts.filePath, deviceId());
        try {
          db.prepare(
            `INSERT INTO multi_device_conflicts (local_job_id, server_job_id, rel_path, detail_json)
             VALUES (?, ?, ?, ?)`,
          ).run(
            opts.localJobId || null,
            serverJobId,
            basename,
            JSON.stringify({
              code: 'conflict',
              revision: data.revision,
              local_base: baseRevision,
              kept: 'local',
            }),
          );
          save();
        } catch (_) {}
        return {
          ok: false,
          code: 'conflict',
          revision: data.revision,
          store: local.payload,
          kept_local: true,
        };
      }
      if (!r.ok || !data.ok) {
        console.warn(
          '[draft_push] failed',
          basename,
          r.status,
          data.error || data.code || r.statusText,
        );
        queueDraftPushPending(opts);
        return { ok: false, error: data.error || r.statusText, code: data.code, queued: true };
      }
      writeDraftState(
        opts,
        stripDraftMeta(data.store || data.data || local.payload),
        data.revision != null ? data.revision : local.revision + 1,
        data.server_updated_at || null,
      );
      clearConflictsForFile(opts.localJobId, serverJobId, basename);
      clearDraftPushPending(opts);
      return { ok: true, revision: data.revision, code: null };
    } catch (e) {
      console.warn('[draft_push] exception', basename, e && e.message ? e.message : e);
      queueDraftPushPending(opts);
      return { ok: false, error: e.message || 'draft_push_failed', queued: true };
    }
  }

  async function pullJsonDraft(opts) {
    const base = String(opts.dispoBaseUrl || '').replace(/\/$/, '');
    const endpoint = opts.endpoint;
    const technicianId = parseInt(opts.technicianId, 10);
    const serverJobId = parseInt(opts.serverJobId, 10);
    const basename = draftBasename(opts);
    if (!base || !endpoint || !technicianId || !serverJobId || !basename) {
      return { ok: false };
    }
    const auth = authHeaderFromCreds(opts.username, opts.password);
    try {
      const url =
        base +
        endpoint +
        '?job_id=' +
        encodeURIComponent(serverJobId) +
        '&technician_id=' +
        encodeURIComponent(technicianId);
      const r = await fetchWithTimeout(url, {
        headers: { 'X-Technician-Id': String(technicianId), ...auth },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        return { ok: false, error: data.error };
      }
      const payload = stripDraftMeta(data.store || data.data || {});
      const remoteRev = parseInt(data.revision, 10) || 0;
      const remoteEmpty = isEmptyMonteurDraftPayload(payload);
      const local = readDraftState(opts);
      const localEmpty = isEmptyMonteurDraftPayload(local.payload);
      const remoteTs = data.server_updated_at || null;
      const hasByFab = hasRealByFab(local.payload) || hasRealByFab(payload);

      if (remoteEmpty) {
        if (localEmpty) {
          if (remoteRev > 0) {
            writeDraftState(opts, payload, remoteRev, remoteTs);
          }
          return { ok: true, skipped: remoteRev <= 0, empty: true, revision: remoteRev };
        }
        return { ok: true, skipped: true, local_newer: true, empty_remote: true, revision: local.revision };
      }

      if (draftPayloadsEqual(local.payload, payload)) {
        if (remoteRev > (parseInt(local.revision, 10) || 0) || remoteTs) {
          writeDraftState(opts, payload, remoteRev, remoteTs || local.server_updated_at || null);
        }
        return { ok: true, skipped: true, revision: remoteRev || local.revision };
      }

      if (localEmpty) {
        writeDraftState(opts, payload, remoteRev, remoteTs);
        return { ok: true, revision: remoteRev, store: payload };
      }

      /* Gerät hat schon Inhalt: FN mergen (Inhalt vor Stub, sonst Zeitstempel). Leere Dispo wischt nicht. */
      if (hasByFab) {
        const merged = mergeByFabStores(local.payload, payload);
        if (!draftPayloadsEqual(merged.payload, local.payload)) {
          preserveLocalDraftCopy(opts, local.payload);
          writeDraftState(
            opts,
            merged.payload,
            Math.max(parseInt(local.revision, 10) || 0, remoteRev),
            local.server_updated_at || remoteTs,
          );
          return {
            ok: true,
            revision: Math.max(parseInt(local.revision, 10) || 0, remoteRev),
            store: merged.payload,
            merged: true,
            local_newer: true,
          };
        }
      }
      const locRev = parseInt(local.revision, 10) || 0;
      const remImgs = draftDataImageCount(payload);
      const locImgs = draftDataImageCount(local.payload);
      const remNewer = remoteRev > locRev || draftTimestampNewer(remoteTs, local.server_updated_at);
      if (!hasByFab && (remImgs > locImgs || remNewer)) {
        const mergedFlat = mergeFlatProtocolStores(local.payload, payload);
        const toWrite = remNewer ? payload : mergedFlat;
        writeDraftState(opts, toWrite, Math.max(locRev, remoteRev), remNewer ? remoteTs : local.server_updated_at || remoteTs);
        return { ok: true, revision: Math.max(locRev, remoteRev), store: toWrite, replaced: remNewer, merged: !remNewer };
      }
      return { ok: true, skipped: true, local_newer: true, revision: local.revision };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function pullAllJsonDrafts(opts) {
    const reiseDir = opts.reiseDir;
    const pulled = [];
    for (const basename of MONTEUR_DRAFT_BASENAMES) {
      const endpoint = DRAFT_JSON_ENDPOINTS[basename];
      if (!endpoint) continue;
      const result = await pullJsonDraft({
        dispoBaseUrl: opts.dispoBaseUrl,
        endpoint,
        technicianId: opts.technicianId,
        serverJobId: opts.serverJobId,
        localJobId: opts.localJobId,
        reiseDir,
        basename,
        filePath: reiseDir ? resolveMonteurDraftJsonPath(reiseDir, basename, false) : '',
        username: opts.username,
        password: opts.password,
      });
      if (result && result.local_newer) {
        try {
          await pushJsonDraft({
            dispoBaseUrl: opts.dispoBaseUrl,
            endpoint,
            technicianId: opts.technicianId,
            serverJobId: opts.serverJobId,
            localJobId: opts.localJobId,
            reiseDir,
            basename,
            filePath: reiseDir ? resolveMonteurDraftJsonPath(reiseDir, basename, false) : '',
            username: opts.username,
            password: opts.password,
          });
        } catch (pushErr) {
          console.warn('[draft_pull] local_newer push', basename, pushErr && pushErr.message ? pushErr.message : pushErr);
        }
      }
      pulled.push({
        basename,
        ok: !!(result && result.ok),
        skipped: !!(result && result.skipped),
        local_newer: !!(result && result.local_newer),
      });
    }
    if (reiseDir) pruneEmptyMonteurDraftJsons(reiseDir);
    return { ok: true, pulled };
  }

  function markJobPendingLocalCleanup(localJobId, serverJobId, reason, statusOnServer) {
    const lid = parseInt(localJobId, 10);
    if (!Number.isFinite(lid) || lid <= 0) return;
    db.prepare(
      `INSERT INTO jobs_pending_local_cleanup (local_job_id, server_job_id, reason, status_on_server, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(local_job_id) DO UPDATE SET
         server_job_id = excluded.server_job_id,
         reason = excluded.reason,
         status_on_server = excluded.status_on_server,
         created_at = datetime('now')`,
    ).run(lid, serverJobId || null, String(reason || 'status'), String(statusOnServer || ''));
    save();
  }

  function listPendingLocalCleanup() {
    try {
      return db
        .prepare(
          `SELECT c.local_job_id, c.server_job_id, c.reason, c.status_on_server, c.created_at,
                  cust.name AS customer_name, j.status AS local_status
           FROM jobs_pending_local_cleanup c
           LEFT JOIN jobs j ON j.id = c.local_job_id
           LEFT JOIN customers cust ON cust.id = j.customer_id
           ORDER BY datetime(c.created_at) DESC`,
        )
        .all();
    } catch (_) {
      return [];
    }
  }

  function listRecentConflicts(limit) {
    try {
      db.prepare(
        `DELETE FROM multi_device_conflicts WHERE datetime(created_at) < datetime('now', '-30 minutes')`,
      ).run();
      return db
        .prepare(
          `SELECT id, local_job_id, server_job_id, rel_path, detail_json, created_at
           FROM multi_device_conflicts
           ORDER BY id DESC LIMIT ?`,
        )
        .all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20)));
    } catch (_) {
      return [];
    }
  }

  app.post('/api/multi_device/conflicts/ack', express.json(), (req, res) => {
    try {
      const id = parseInt(String((req.body && req.body.id) || req.query.id || ''), 10);
      if (id > 0) {
        db.prepare('DELETE FROM multi_device_conflicts WHERE id = ?').run(id);
        save();
      } else {
        db.prepare('DELETE FROM multi_device_conflicts').run();
        save();
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/device_id', (req, res) => {
    res.json({ ok: true, device_id: deviceId(), display_name: defaultDisplayName() });
  });

  app.post('/api/device_register', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = parseInt(body.technician_id != null ? body.technician_id : getTechnicianId(req), 10);
      const result = await registerDeviceOnDispo({
        dispoBaseUrl: body.dispoBaseUrl || body.base_url || body.baseUrl,
        technicianId,
        username: body.dispoUsername || body.serverUsername,
        password: body.dispoPassword ?? body.serverPassword,
        displayName: body.display_name,
      });
      if (!result.ok) {
        return res.status(result.revoked ? 403 : 502).json(result);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/device_heartbeat', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = parseInt(body.technician_id != null ? body.technician_id : getTechnicianId(req), 10);
      let serverJobId = parseInt(body.job_id || body.server_job_id, 10) || 0;
      // Lokale job_id → server_id
      if (serverJobId > 0 && db) {
        try {
          const row = db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(serverJobId);
          if (row && row.server_id != null && String(row.server_id).trim() !== '') {
            serverJobId = parseInt(row.server_id, 10) || serverJobId;
          } else {
            const byServer = db.prepare('SELECT server_id FROM jobs WHERE server_id = ?').get(serverJobId);
            if (!byServer) {
              /* keep as-is; may already be server id */
            }
          }
        } catch (_) {}
      }
      const result = await heartbeatOnDispo({
        dispoBaseUrl: body.dispoBaseUrl || body.base_url || body.baseUrl,
        technicianId,
        username: body.dispoUsername || body.serverUsername,
        password: body.dispoPassword ?? body.serverPassword,
        serverJobId: serverJobId > 0 ? serverJobId : undefined,
      });
      res.status(result.revoked ? 403 : 200).json(Object.assign({ ok: !!result.ok }, result));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/devices', async (req, res) => {
    try {
      const technicianId = parseInt(req.query.technician_id || getTechnicianId(req), 10);
      const base = String(req.query.base_url || req.query.dispoBaseUrl || '').replace(/\/$/, '');
      if (!technicianId || !base) {
        return res.status(400).json({ ok: false, error: 'technician_id und base_url erforderlich.' });
      }
      const auth = authHeaderFromCreds(req.query.dispoUsername || req.query.serverUsername, req.query.dispoPassword ?? req.query.serverPassword);
      const r = await fetchWithTimeout(
        base + '/dispo_api/api/monteur_device_list.php?technician_id=' + encodeURIComponent(technicianId),
        { headers: { 'X-Technician-Id': String(technicianId), ...auth } },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        return res.status(r.status || 502).json({ ok: false, error: data.error || 'device_list_failed' });
      }
      res.json({
        ok: true,
        devices: data.devices || [],
        self_device_id: deviceId(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/device_revoke', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = parseInt(body.technician_id != null ? body.technician_id : getTechnicianId(req), 10);
      const target = String(body.device_id || '').trim();
      const base = String(body.dispoBaseUrl || body.base_url || '').replace(/\/$/, '');
      if (!technicianId || !target || !base) {
        return res.status(400).json({ ok: false, error: 'technician_id, device_id und base_url erforderlich.' });
      }
      if (target === deviceId()) {
        return res.status(400).json({ ok: false, error: 'Das aktuelle Gerät kann nicht widerrufen werden.' });
      }
      const auth = authHeaderFromCreds(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
      const r = await fetchWithTimeout(base + '/dispo_api/api/monteur_device_revoke.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId), ...auth },
        body: JSON.stringify({ technician_id: technicianId, device_id: target }),
      });
      const data = await r.json().catch(() => ({}));
      res.status(r.ok && data.ok ? 200 : 502).json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/dienstreise/delete_local_copy', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const localJobId = parseInt(body.job_id != null ? body.job_id : body.local_job_id, 10);
      if (!localJobId) return res.status(400).json({ ok: false, error: 'job_id erforderlich.' });
      const reiseDir = resolveDienstreiseReiseDirForJob(localJobId, { createIfMissing: false });
      let protectedPaths = [];
      try {
        protectedPaths = typeof listProtectedPaths === 'function' ? listProtectedPaths(db, localJobId) : [];
      } catch (_) {}
      if (reiseDir && fs.existsSync(reiseDir) && typeof cleanupDienstreiseReiseDir === 'function') {
        cleanupDienstreiseReiseDir(reiseDir, protectedPaths, { fastNoUpload: true });
      }
      db.prepare('DELETE FROM jobs_pending_local_cleanup WHERE local_job_id = ?').run(localJobId);
      save();
      res.json({ ok: true, local_job_id: localJobId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'Lokale Kopie konnte nicht gelöscht werden.' });
    }
  });

  app.post('/api/device_bootstrap/estimate', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const technicianId = parseInt(body.technician_id != null ? body.technician_id : getTechnicianId(req), 10);
      const base = String(body.dispoBaseUrl || body.base_url || '').replace(/\/$/, '');
      if (!technicianId || !base) {
        return res.status(400).json({ ok: false, error: 'technician_id und base_url erforderlich.' });
      }
      const auth = authHeaderFromCreds(body.dispoUsername || body.serverUsername, body.dispoPassword ?? body.serverPassword);
      const jobs = db
        .prepare(
          `SELECT j.id AS local_job_id, j.server_id, j.status, c.name AS customer_name
           FROM jobs j
           INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
           LEFT JOIN customers c ON c.id = j.customer_id
           WHERE LOWER(TRIM(COALESCE(j.status,''))) = 'in_arbeit'
             AND j.server_id IS NOT NULL AND TRIM(CAST(j.server_id AS TEXT)) != ''`,
        )
        .all(technicianId);
      const estimates = [];
      let totalBytes = 0;
      for (const job of jobs) {
        const serverJobId = parseInt(job.server_id, 10);
        try {
          const url =
            base +
            '/dispo_api/api/job_files_manifest.php?technician_id=' +
            encodeURIComponent(technicianId) +
            '&job_id=' +
            encodeURIComponent(serverJobId) +
            '&physical_only=1&rescan=1';
          const r = await fetchWithTimeout(url, {
            headers: { 'X-Technician-Id': String(technicianId), ...auth },
          });
          const data = await r.json().catch(() => ({}));
          const bytes = r.ok && data.ok ? Number(data.total_bytes) || 0 : 0;
          totalBytes += bytes;
          estimates.push({
            local_job_id: job.local_job_id,
            server_job_id: serverJobId,
            customer_name: job.customer_name || '',
            total_bytes: bytes,
            total_human: formatBytes(bytes),
            file_count: Array.isArray(data.files) ? data.files.length : 0,
            ok: !!(r.ok && data.ok),
          });
        } catch (e) {
          estimates.push({
            local_job_id: job.local_job_id,
            server_job_id: serverJobId,
            customer_name: job.customer_name || '',
            total_bytes: 0,
            total_human: '0 B',
            file_count: 0,
            ok: false,
            error: e.message,
          });
        }
      }
      res.json({
        ok: true,
        jobs: estimates,
        total_bytes: totalBytes,
        total_human: formatBytes(totalBytes),
        note: 'Nur physischer Job-Tree; Fileserver-Union wird lazy/on-demand geladen.',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/device_bootstrap', express.json(), async (req, res) => {
    try {
      const jobsSvc = resolveBgJobs();
      if (!jobsSvc) return res.status(503).json({ ok: false, error: 'Hintergrund-Jobs nicht bereit.' });
      const body = req.body || {};
      const technicianId = parseInt(body.technician_id != null ? body.technician_id : getTechnicianId(req), 10);
      if (!technicianId) return res.status(400).json({ ok: false, error: 'technician_id erforderlich.' });
      await registerDeviceOnDispo({
        dispoBaseUrl: body.dispoBaseUrl || body.base_url,
        technicianId,
        username: body.dispoUsername || body.serverUsername,
        password: body.dispoPassword ?? body.serverPassword,
      });
      const jobs = db
        .prepare(
          `SELECT j.id AS local_job_id
           FROM jobs j
           INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = ?
           WHERE LOWER(TRIM(COALESCE(j.status,''))) = 'in_arbeit'`,
        )
        .all(technicianId);
      const enqueued = [];
      for (const job of jobs) {
        const dedupeKey = 'device_bootstrap_pull:' + job.local_job_id;
        const { job_id } = jobsSvc.enqueue(
          'dienstreise_pull',
          Object.assign({}, body, {
            job_id: job.local_job_id,
            technicianId,
            technician_id: technicianId,
            bootstrap: true,
            physical_only: true,
          }),
          dedupeKey,
        );
        enqueued.push({ local_job_id: job.local_job_id, background_job_id: job_id });
      }
      jobsSvc.kick();
      res.status(202).json({
        ok: true,
        async: true,
        enqueued,
        message: 'Bootstrap gestartet: physischer Projektordner-Pull für in_arbeit-Aufträge.',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return {
    deviceId,
    registerDeviceOnDispo,
    heartbeatOnDispo,
    pushJsonDraft,
    queueDraftPushPending,
    pullJsonDraft,
    pullAllJsonDrafts,
    markJobPendingLocalCleanup,
    listPendingLocalCleanup,
    listRecentConflicts,
    reconcileLocalTreeWithManifest,
    ensureMultiDeviceTables,
  };
}

module.exports = {
  ensureMultiDeviceTables,
  registerMultiDeviceRoutes,
  getOrCreateDeviceId,
  defaultDisplayName,
};
