'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { parseMultipart } = require('./multipart-upload');
const phpLocal = require('./abrechnung-php-local');

function getCore() {
  return require('./abrechnung-routes');
}

function jsonRes(res, data, status) {
  res.status(status || 200).json(data);
}

function technicianId(ctx, req) {
  if (typeof ctx.getTechnicianId === 'function') {
    const id = ctx.getTechnicianId(req);
    if (id) return id;
  }
  const raw = req.headers['x-technician-id'] || req.query.technician_id;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dispoCtx(ctx, req) {
  const tid = technicianId(ctx, req);
  const creds = typeof ctx.loadDispoCreds === 'function' ? ctx.loadDispoCreds() : {};
  const auth =
    typeof ctx.authHeaderFromCredentials === 'function'
      ? ctx.authHeaderFromCredentials(creds.serverUsername, creds.serverPassword)
      : {};
  return {
    db: ctx.db,
    save: ctx.save,
    dbDir: ctx.dbDir,
    technicianId: tid,
    baseUrl: creds.baseUrl || '',
    authHeader: auth,
    serverUsername: creds.serverUsername || '',
    serverPassword: creds.serverPassword || '',
  };
}

/** Sofortiger Outbox-Flush (Upload/Delete), damit Sync-Icon nicht bis Seitenwechsel hängt. */
async function flushOutboxFromCtx(ctx, d, tid) {
  if (!d || !d.baseUrl || !d.authHeader || !d.authHeader.Authorization) return false;
  const tech = tid || d.technicianId;
  if (!tech) return false;
  const flushCtx =
    typeof ctx.authHeaderFromCredentials === 'function'
      ? ctx
      : Object.assign({}, ctx, {
          authHeaderFromCredentials: function () {
            return d.authHeader;
          },
        });
  await getCore().flushAbrechnungOutbox(
    flushCtx,
    d.baseUrl,
    tech,
    d.serverUsername,
    d.serverPassword,
  );
  return true;
}

function fileStillPendingUpload(db, dispoJobId, bucket, fileName) {
  const keys = getCore().pendingAbrechnungOutboxKeys(db, dispoJobId, 'upload');
  const n = getCore().normalizeAbrechnungRelativeName(fileName);
  return keys.has(String(bucket || '').trim() + '\0' + n);
}

async function handleMultipartPost(req, res, handler) {
  try {
    const { fields, files } = await parseMultipart(req);
    const result = await handler(fields, files);
    if (result.status && result.status >= 400) {
      return jsonRes(res, { ok: false, error: result.error || 'Fehler' }, result.status);
    }
    jsonRes(res, result);
  } catch (e) {
    jsonRes(res, { ok: false, error: e.message }, 500);
  }
}

async function fetchBillingState(ctx, req, dispoJobId) {
  const { db, save, technicianId, baseUrl, authHeader } = dispoCtx(ctx, req);
  const forceOnline =
    req &&
    req.query &&
    (req.query.force_online === '1' ||
      req.query.force_online === 'true' ||
      req.query.refresh === '1');
  // Offline-First: Cache zuerst; Dispo nur bei force_online / abrechnung_refresh
  const cached = phpLocal.readBillingCache(db, dispoJobId);
  if (cached && !forceOnline) {
    return {
      ok: true,
      billing: Object.assign({}, cached, {
        can_write: phpLocal.monteurCanWriteJob(db, dispoJobId, technicianId),
      }),
      source: 'cache',
    };
  }
  if (forceOnline && baseUrl && authHeader && authHeader.Authorization) {
    try {
      const data = await getCore().dispoFetchJson(
        baseUrl,
        'abrechnung_job_billing_state.php',
        { job_id: String(dispoJobId) },
        authHeader,
        technicianId,
      );
      if (data && data.ok && data.billing) {
        const billing = Object.assign({}, data.billing, {
          can_write: phpLocal.monteurCanWriteJob(db, dispoJobId, technicianId),
        });
        phpLocal.saveBillingCache(db, save, dispoJobId, billing);
        return { ok: true, billing, source: 'dispo' };
      }
    } catch (e) {
      console.warn('[abrechnung/billing_state] Dispo:', e.message);
    }
  }
  if (cached) {
    return {
      ok: true,
      billing: Object.assign({}, cached, {
        can_write: phpLocal.monteurCanWriteJob(db, dispoJobId, technicianId),
      }),
      source: 'cache',
    };
  }
  const billing = phpLocal.buildBillingFallback(db, dispoJobId, technicianId);
  return { ok: true, billing, source: 'local_fallback' };
}

function registerAbrechnungPhpRoutes(app, ctx) {
  app.get('/api/abrechnung/page-config', (req, res) => {
    const tid = technicianId(ctx, req);
    res.json({ ok: true, config: phpLocal.buildPageConfig(ctx.db, tid, req.query || {}) });
  });

  /** Lokale Jobliste (ohne .php — umgeht Dispo-Proxy, liest SQLite + Snapshot). */
  app.get('/api/abrechnung/jobs', (req, res) => {
    const period = String(req.query.period || req.query.monat || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return jsonRes(res, { ok: false, error: 'period (YYYY-MM) fehlt oder ungültig.' }, 400);
    }
    let tid = technicianId(ctx, req);
    if (!tid) {
      const fromQuery = parseInt(req.query.technician_id || req.query.techniker || 0, 10);
      if (Number.isFinite(fromQuery) && fromQuery > 0) tid = fromQuery;
    }
    if (!tid) return jsonRes(res, { ok: false, error: 'technician_id fehlt.' }, 400);
    const includeAbgerechnet = phpLocal.parseMitAbgerechnet(req.query || {});
    jsonRes(res, phpLocal.listAbrechnungJobsPhp(ctx.db, period, tid, includeAbgerechnet));
  });

  app.get('/api/abrechnung_job_list.php', (req, res) => {
    const monat = String(req.query.monat || '').trim();
    if (!/^\d{4}-\d{2}$/.test(monat)) {
      return jsonRes(res, { ok: false, error: 'monat (YYYY-MM) fehlt oder ungültig.' }, 400);
    }
    let tid = technicianId(ctx, req);
    if (!tid) {
      const fromQuery = parseInt(req.query.techniker || req.query.technician_id || 0, 10);
      if (Number.isFinite(fromQuery) && fromQuery > 0) tid = fromQuery;
    }
    if (!tid) return jsonRes(res, { ok: false, error: 'technician_id fehlt.' }, 400);
    const includeAbgerechnet = phpLocal.parseMitAbgerechnet(req.query || {});
    jsonRes(res, phpLocal.listAbrechnungJobsPhp(ctx.db, monat, tid, includeAbgerechnet));
  });

  app.get('/api/abrechnung_job_billing_state.php', async (req, res) => {
    const jobId = Number(req.query.job_id || 0);
    if (!jobId) return jsonRes(res, { ok: false, error: 'job_id fehlt.' }, 400);
    const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
    const data = await fetchBillingState(ctx, req, dispoJobId);
    if (!data.ok) return jsonRes(res, data, data.status || 500);
    jsonRes(res, data);
  });

  app.get('/api/abrechnung_notes.php', async (req, res) => {
    const jobId = Number(req.query.job_id || 0);
    if (!jobId) return jsonRes(res, { ok: false, error: 'job_id fehlt.' }, 400);
    const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
    const forceOnline =
      req.query.force_online === '1' ||
      req.query.force_online === 'true' ||
      req.query.refresh === '1';
    const d = dispoCtx(ctx, req);
    // Offline-First: Notes aus Cache; Dispo-Sync nur bei force_online
    if (forceOnline && d.baseUrl && d.authHeader && d.authHeader.Authorization) {
      try {
        await getCore().syncCommentsOnlyFromDispo(
          { db: ctx.db, save: ctx.save },
          d.baseUrl,
          d.technicianId,
          d.authHeader,
          dispoJobId,
        );
      } catch (e) {
        console.warn('[abrechnung/notes] Dispo sync:', e.message);
      }
    }
    const row = ctx.db
      .prepare(
        'SELECT dispo, buchhaltung, comments_json, synced_at FROM abrechnung_notes_cache WHERE job_server_id = ?',
      )
      .get(dispoJobId);
    const comments = getCore().readCommentsFromRow(row);
    jsonRes(res, { ok: true, comments, source: row ? 'local' : 'empty' });
  });

  app.get('/api/abrechnung_bucket_list.php', (req, res) => {
    const jobId = Number(req.query.job_id || 0);
    const bucket = String(req.query.bucket || 'dispo').trim();
    if (!jobId || !bucket) {
      return jsonRes(res, { ok: false, error: 'job_id oder bucket ungültig.' }, 400);
    }
    const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
    const fileCtx = getCore().abrechnungFileCtxFrom(ctx);
    const metaRows = getCore().dedupeAbrechnungFileRows(
      ctx.db
        .prepare(
          `SELECT bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name
           FROM abrechnung_files_meta
           WHERE (job_server_id = ? OR job_server_id = ?) AND bucket = ?
           ORDER BY file_name`,
        )
        .all(dispoJobId, jobId, bucket),
    );
    const diskRows = getCore().scanLocalAbrechnungFilesFromDisk(fileCtx, ctx.db, jobId, bucket, ctx.dbDir);
    const pendingUpKeys = getCore().pendingAbrechnungOutboxKeys
      ? getCore().pendingAbrechnungOutboxKeys(ctx.db, dispoJobId, 'upload')
      : new Set();
    const diskKeep = diskRows.filter((r) => {
      const fn = String(r.file_name || '');
      return pendingUpKeys.has(bucket + '\0' + fn);
    });
    // Meta ohne Server-Bestätigung und ohne Pending-Upload ausblenden (Geister nach Server-Löschung).
    const metaKeep = metaRows.filter((r) => {
      const fn = String(r.file_name || '');
      if (pendingUpKeys.has(bucket + '\0' + fn)) return true;
      return r.synced_at != null && String(r.synced_at).trim() !== '';
    });
    const rows = getCore().dedupeAbrechnungFileRows(metaKeep.concat(diskKeep));
    const enriched = getCore().enrichAbrechnungFilesWithSyncState(
      ctx.db,
      dispoJobId,
      rows.map((r) => ({
        bucket: r.bucket || bucket,
        file_name: r.file_name,
        name: r.file_name,
        size_bytes: r.size_bytes != null ? r.size_bytes : null,
        synced_at: r.synced_at != null ? r.synced_at : null,
        uploaded_at: r.uploaded_at != null ? r.uploaded_at : r.synced_at != null ? r.synced_at : null,
        uploaded_by_name: r.uploaded_by_name != null ? r.uploaded_by_name : null,
      })),
    );
    const files = enriched
      .filter((f) => f.sync_state !== 'pending_delete')
      .map((f) => ({
        name: f.name || f.file_name,
        size_bytes: f.size_bytes != null ? f.size_bytes : null,
        uploaded_at: f.uploaded_at != null ? f.uploaded_at : null,
        uploaded_by_name: f.uploaded_by_name != null ? f.uploaded_by_name : null,
        server_present: f.server_present === true,
        sync_state: f.sync_state || 'idle',
      }));
    jsonRes(res, { ok: true, files, source: files.length ? 'local' : 'empty' });
  });

  app.get('/api/abrechnung_file_download.php', async (req, res) => {
    try {
      const jobId = Number(req.query.job_id || 0);
      const bucket = String(req.query.bucket || 'dispo').trim();
      const name = getCore().normalizeAbrechnungRelativeName(
        String(req.query.name || req.query.filename || ''),
      );
      if (!jobId || !name) return res.status(400).send('Parameter fehlen.');
      const fp = getCore().findLocalAbrechnungFilePath(
        ctx.dbDir,
        ctx.db,
        jobId,
        bucket,
        name,
        getCore().abrechnungFileCtxFrom(ctx),
      );
      if (fp) return res.sendFile(path.resolve(fp));
      const d = dispoCtx(ctx, req);
      const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      if (!d.baseUrl || !d.authHeader || !d.authHeader.Authorization) {
        return res.status(404).send('Datei nicht lokal — Hintergrund-Sync lädt nach.');
      }
      const dest = getCore().filePathLocal(
        ctx.dbDir,
        dispoJobId,
        bucket,
        name,
        getCore().abrechnungFileCtxFrom(ctx),
      );
      getCore().mkdirpSync(path.dirname(dest));
      await getCore().dispoDownloadFile(d.baseUrl, dispoJobId, bucket, name, dest, d.authHeader, d.technicianId);
      if (fs.existsSync(dest)) return res.sendFile(path.resolve(dest));
      return res.status(404).send('Datei nicht gefunden.');
    } catch (e) {
      res.status(500).send(e.message || String(e));
    }
  });

  app.post('/api/abrechnung_file_open', express.json(), (req, res) => {
    const jobId = Number(req.body?.job_id || 0);
    const bucket = String(req.body?.bucket || 'dispo').trim();
    const filename = path.basename(String(req.body?.filename || req.body?.name || ''));
    if (!jobId || !filename) return jsonRes(res, { ok: false, error: 'Parameter fehlen.' }, 400);
    const fp = getCore().findLocalAbrechnungFilePath(
      ctx.dbDir,
      ctx.db,
      jobId,
      bucket,
      filename,
      getCore().abrechnungFileCtxFrom(ctx),
    );
    if (!fp) return jsonRes(res, { ok: false, error: 'Datei nicht gefunden.' }, 404);
    jsonRes(res, { ok: true, local_path: fp });
  });

  app.post('/api/abrechnung_file_upload.php', (req, res) => {
    handleMultipartPost(req, res, async (fields, files) => {
      const jobId = Number(fields.job_id || 0);
      const bucket = String(fields.bucket || 'dispo').trim();
      const file = files.find((f) => f.field === 'file');
      if (!jobId || !file?.buffer?.length) {
        return { ok: false, status: 400, error: 'Upload unvollständig.' };
      }
      const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      const tid = Number(fields.technician_id || 0) || technicianId(ctx, req);
      if (!phpLocal.monteurCanWriteJob(ctx.db, dispoJobId, tid)) {
        return { ok: false, status: 403, error: 'Keine Berechtigung.' };
      }
      const origName = path.basename(file.filename || 'datei');
      const belegPrefixIn = String(fields.beleg_prefix || '').trim();
      const belegPrefix = phpLocal.belegPrefixAllowed(belegPrefixIn) ? belegPrefixIn : null;
      const probePath = getCore().filePathLocal(
        ctx.dbDir,
        dispoJobId,
        bucket,
        'probe.tmp',
        getCore().abrechnungFileCtxFrom(ctx),
      );
      const targetDir = path.dirname(probePath);
      getCore().mkdirpSync(targetDir);
      const safeName = phpLocal.resolveUniqueStoredName(origName, belegPrefix, targetDir);
      const localPath = path.join(targetDir, path.basename(safeName));
      fs.writeFileSync(localPath, file.buffer);
      const uploaderName = phpLocal.resolveTechnicianDisplayName(ctx.db, tid);
      const uploadedAt = new Date().toISOString();
      ctx.db
        .prepare(
          `INSERT INTO abrechnung_files_meta (
             job_server_id, bucket, file_name, size_bytes, synced_at, uploaded_at, uploaded_by_name, uploaded_by_user_id
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(job_server_id, bucket, file_name) DO UPDATE SET
             size_bytes = excluded.size_bytes,
             uploaded_at = excluded.uploaded_at,
             uploaded_by_name = excluded.uploaded_by_name,
             uploaded_by_user_id = excluded.uploaded_by_user_id`,
        )
        .run(dispoJobId, bucket, safeName, file.buffer.length, uploadedAt, uploaderName || null, tid || null);
      ctx.save();
      const d = dispoCtx(ctx, req);
      const uploadFields = { job_id: String(dispoJobId), bucket };
      // safeName ist bereits final inkl. Präfix — kein zweites beleg_prefix an Dispo,
      // sonst doppelte Unique-Logik Laptop+Server bei Retry.
      if (uploaderName) uploadFields.uploader_name = uploaderName;
      // Bereits lokal berechneter Name (inkl. Beleg-Präfix), damit Dispo denselben Basename speichert.
      const remoteName = safeName || origName;
      if (d.baseUrl && d.authHeader && d.authHeader.Authorization) {
        try {
          const upRes = await getCore().dispoUploadMultipart(
            d.baseUrl,
            uploadFields,
            file.buffer,
            remoteName,
            d.authHeader,
            tid || d.technicianId,
          );
          const serverName = getCore().normalizeAbrechnungRelativeName(
            (upRes && (upRes.name || upRes.file_name)) || safeName,
          );
          if (serverName && serverName !== safeName) {
            try {
              const altPath = path.join(targetDir, path.basename(serverName));
              if (fs.existsSync(localPath) && !fs.existsSync(altPath)) {
                fs.renameSync(localPath, altPath);
              }
            } catch (_) {
              /* ignore */
            }
            ctx.db
              .prepare(
                `UPDATE abrechnung_files_meta SET file_name = ?, synced_at = datetime('now')
                 WHERE job_server_id = ? AND bucket = ? AND file_name = ?`,
              )
              .run(serverName, dispoJobId, bucket, safeName);
          } else {
            ctx.db
              .prepare(
                `UPDATE abrechnung_files_meta SET synced_at = datetime('now')
                 WHERE job_server_id = ? AND bucket = ? AND file_name = ?`,
              )
              .run(dispoJobId, bucket, safeName);
          }
          getCore().clearAbrechnungOutboxUploadsForFile(ctx.db, dispoJobId, bucket, safeName);
          if (serverName && serverName !== safeName) {
            getCore().clearAbrechnungOutboxUploadsForFile(ctx.db, dispoJobId, bucket, serverName);
          }
          ctx.save();
          return { ok: true, name: serverName || safeName, source: 'dispo' };
        } catch (e) {
          ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
            'upload',
            JSON.stringify({
              job_id: dispoJobId,
              bucket,
              filename: safeName,
              local_path: localPath,
              beleg_prefix: '',
              orig_filename: remoteName,
              uploader_name: uploaderName || '',
            }),
          );
          ctx.save();
          try {
            await flushOutboxFromCtx(ctx, d, tid || d.technicianId);
          } catch (flushErr) {
            console.warn(
              '[abrechnung upload] outbox flush:',
              flushErr && flushErr.message ? flushErr.message : flushErr,
            );
          }
          if (!fileStillPendingUpload(ctx.db, dispoJobId, bucket, safeName)) {
            return { ok: true, name: safeName, source: 'dispo', queued: false };
          }
          return { ok: true, name: safeName, source: 'local', queued: true, error: e.message };
        }
      }
      ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
        'upload',
        JSON.stringify({
          job_id: dispoJobId,
          bucket,
          filename: safeName,
          local_path: localPath,
          beleg_prefix: '',
          orig_filename: remoteName,
          uploader_name: uploaderName || '',
        }),
      );
      ctx.save();
      return { ok: true, name: safeName, source: 'local', queued: true };
    });
  });

  app.post('/api/abrechnung_outbox_flush.php', async (req, res) => {
    try {
      const d = dispoCtx(ctx, req);
      const tid = technicianId(ctx, req) || d.technicianId;
      if (!d.baseUrl || !d.authHeader || !d.authHeader.Authorization || !tid) {
        return jsonRes(res, { ok: true, flushed: false, reason: 'offline' });
      }
      await flushOutboxFromCtx(ctx, d, tid);
      jsonRes(res, { ok: true, flushed: true });
    } catch (e) {
      jsonRes(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  app.post('/api/abrechnung_file_delete.php', (req, res) => {
    handleMultipartPost(req, res, async (fields) => {
      const jobId = Number(fields.job_id || 0);
      const bucket = String(fields.bucket || 'dispo').trim();
      const filename = path.basename(String(fields.filename || fields.name || ''));
      if (!jobId || !filename) return { ok: false, status: 400, error: 'Parameter fehlen.' };
      const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      const tid = technicianId(ctx, req);
      if (!phpLocal.monteurCanWriteJob(ctx.db, dispoJobId, tid)) {
        return { ok: false, status: 403, error: 'Keine Berechtigung.' };
      }
      const localPath = getCore().filePathLocal(
        ctx.dbDir,
        dispoJobId,
        bucket,
        filename,
        getCore().abrechnungFileCtxFrom(ctx),
      );
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch (_) {
        /* ignore */
      }
      ctx.db
        .prepare(
          'DELETE FROM abrechnung_files_meta WHERE (job_server_id = ? OR job_server_id = ?) AND bucket = ? AND file_name = ?',
        )
        .run(dispoJobId, jobId, bucket, filename);
      ctx.save();
      const d = dispoCtx(ctx, req);
      if (d.baseUrl && d.authHeader && d.authHeader.Authorization) {
        try {
          await getCore().dispoAbrechnungPostJson(
            d.baseUrl,
            'abrechnung_file_delete.php',
            { technician_id: d.technicianId, job_id: dispoJobId, bucket, name: filename },
            d.authHeader,
            d.technicianId,
          );
          return { ok: true, source: 'dispo' };
        } catch (e) {
          ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
            'delete',
            JSON.stringify({ job_id: dispoJobId, bucket, name: filename }),
          );
          ctx.save();
          return { ok: true, source: 'local', queued: true, error: e.message };
        }
      }
      ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
        'delete',
        JSON.stringify({ job_id: dispoJobId, bucket, name: filename }),
      );
      ctx.save();
      return { ok: true, source: 'local', queued: true };
    });
  });

  app.post('/api/abrechnung_note_save.php', (req, res) => {
    handleMultipartPost(req, res, async (fields) => {
      const jobId = Number(fields.job_id || 0);
      const bucket = String(fields.bucket || 'dispo').trim();
      const body = String(fields.body || '').trim();
      if (!jobId || !body) return { ok: false, status: 400, error: 'Eingabe unvollständig.' };
      const dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      const tid = technicianId(ctx, req);
      if (!phpLocal.monteurCanWriteJob(ctx.db, dispoJobId, tid)) {
        return { ok: false, status: 403, error: 'Keine Berechtigung.' };
      }
      const d = dispoCtx(ctx, req);
      if (d.baseUrl && d.authHeader && d.authHeader.Authorization) {
        try {
          await getCore().dispoAbrechnungPostJson(
            d.baseUrl,
            'abrechnung_note_save.php',
            { technician_id: d.technicianId, job_id: dispoJobId, bucket, body },
            d.authHeader,
            d.technicianId,
          );
          await getCore().syncCommentsOnlyFromDispo(
            { db: ctx.db, save: ctx.save },
            d.baseUrl,
            d.technicianId,
            d.authHeader,
            dispoJobId,
          );
          return { ok: true, source: 'dispo' };
        } catch (e) {
          getCore().appendOptimisticComment(ctx.db, dispoJobId, bucket, body);
          ctx.save();
          ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
            'note',
            JSON.stringify({ job_id: dispoJobId, bucket, body }),
          );
          ctx.save();
          return { ok: true, source: 'local', queued: true, error: e.message };
        }
      }
      getCore().appendOptimisticComment(ctx.db, dispoJobId, bucket, body);
      ctx.save();
      ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
        'note',
        JSON.stringify({ job_id: dispoJobId, bucket, body }),
      );
      ctx.save();
      return { ok: true, source: 'local', queued: true };
    });
  });

  app.post('/api/abrechnung_comment_edit.php', (req, res) => {
    handleMultipartPost(req, res, async (fields) => {
      const commentId = Number(fields.comment_id || fields.id || 0);
      const body = String(fields.body || '').trim();
      const jobId = Number(fields.job_id || 0);
      if (!commentId || !body) return { ok: false, status: 400, error: 'Eingabe unvollständig.' };
      let dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      if (!dispoJobId) {
        const found = phpLocal.findCommentInNotesCache(ctx.db, getCore().readCommentsFromRow, commentId);
        if (found) dispoJobId = found.jobServerId;
      }
      const writeCache = (db, jid, comments) => getCore().writeCommentsCache(db, jid, comments);
      const d = dispoCtx(ctx, req);
      if (d.baseUrl && d.authHeader && d.authHeader.Authorization) {
        try {
          await getCore().dispoAbrechnungPostJson(
            d.baseUrl,
            'abrechnung_comment_edit.php',
            { technician_id: d.technicianId, job_id: dispoJobId, comment_id: commentId, body },
            d.authHeader,
            d.technicianId,
          );
          await getCore().syncCommentsOnlyFromDispo(
            { db: ctx.db, save: ctx.save },
            d.baseUrl,
            d.technicianId,
            d.authHeader,
            dispoJobId,
          );
          return { ok: true, source: 'dispo' };
        } catch (e) {
          console.warn('[abrechnung/comment_edit] Dispo:', e.message);
        }
      }
      const local = phpLocal.updateCommentInCache(
        ctx.db,
        ctx.save,
        getCore().readCommentsFromRow,
        writeCache,
        dispoJobId,
        commentId,
        body,
      );
      if (!local.ok) return local;
      const queuedJobId = local.job_id || dispoJobId;
      ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
        'comment_edit',
        JSON.stringify({ job_id: queuedJobId, comment_id: commentId, body }),
      );
      ctx.save();
      try {
        await flushOutboxFromCtx(ctx, d, d.technicianId);
      } catch (_) {
        /* nächster Refresh */
      }
      return { ok: true, source: 'local', queued: true };
    });
  });

  app.post('/api/abrechnung_comment_delete.php', (req, res) => {
    handleMultipartPost(req, res, async (fields) => {
      const commentId = Number(fields.comment_id || fields.id || 0);
      const jobId = Number(fields.job_id || 0);
      if (!commentId) return { ok: false, status: 400, error: 'Eingabe unvollständig.' };
      let dispoJobId = getCore().resolveDispoJobIdForAbrechnung(ctx.db, jobId);
      if (!dispoJobId) {
        const found = phpLocal.findCommentInNotesCache(ctx.db, getCore().readCommentsFromRow, commentId);
        if (found) dispoJobId = found.jobServerId;
      }
      const writeCache = (db, jid, comments) => getCore().writeCommentsCache(db, jid, comments);
      const d = dispoCtx(ctx, req);
      if (d.baseUrl && d.authHeader && d.authHeader.Authorization) {
        try {
          await getCore().dispoAbrechnungPostJson(
            d.baseUrl,
            'abrechnung_comment_delete.php',
            { technician_id: d.technicianId, job_id: dispoJobId, comment_id: commentId },
            d.authHeader,
            d.technicianId,
          );
          await getCore().syncCommentsOnlyFromDispo(
            { db: ctx.db, save: ctx.save },
            d.baseUrl,
            d.technicianId,
            d.authHeader,
            dispoJobId,
          );
          return { ok: true, source: 'dispo' };
        } catch (e) {
          console.warn('[abrechnung/comment_delete] Dispo:', e.message);
        }
      }
      const local = phpLocal.deleteCommentInCache(
        ctx.db,
        ctx.save,
        getCore().readCommentsFromRow,
        writeCache,
        dispoJobId,
        commentId,
      );
      if (!local.ok) return local;
      const queuedJobId = local.job_id || dispoJobId;
      ctx.db.prepare('INSERT INTO abrechnung_outbox (op, payload) VALUES (?, ?)').run(
        'comment_delete',
        JSON.stringify({ job_id: queuedJobId, comment_id: commentId }),
      );
      ctx.save();
      try {
        await flushOutboxFromCtx(ctx, d, d.technicianId);
      } catch (_) {
        /* nächster Refresh */
      }
      return { ok: true, source: 'local', queued: true };
    });
  });

  app.post('/api/job_billing_flags.php', (_req, res) => {
    jsonRes(res, { ok: false, error: 'Billing-Flags sind in der Monteur-App nur lesbar.' }, 403);
  });

  app.post('/api/job_billing_travel_technician.php', (_req, res) => {
    jsonRes(res, { ok: false, error: 'Reise-Flags sind in der Monteur-App nur lesbar.' }, 403);
  });

  app.post('/api/job_status_admin_revert_erledigt.php', (_req, res) => {
    jsonRes(res, { ok: false, error: 'Keine Berechtigung.' }, 403);
  });

  app.post('/api/job_status_dispo_set_in_arbeit.php', (_req, res) => {
    jsonRes(res, { ok: false, error: 'Keine Berechtigung.' }, 403);
  });
}

module.exports = { registerAbrechnungPhpRoutes };
