/**
 * Laptop-Gateway: Hinweise lokal sofort ablegen und priorisiert an Dispo pushen.
 */
const express = require('express');
const { parseMultipart } = require('./multipart-upload');
const {
  ensureHinweiseLocalSchema,
  saveCreateLocal,
  mergeRemoteWithLocal,
  getLocalFile,
  flushPendingHinweise,
} = require('./hinweise-local');
const { buildDispoMonteurHeaders } = require('./dispo-monteur-headers');
const { getOrCreateDeviceId } = require('./device-id');

function registerHinweiseRoutes(app, ctx) {
  function db() {
    return typeof ctx.db === 'function' ? ctx.db() : ctx.db;
  }

  function creds() {
    return typeof ctx.resolveDispoPushCreds === 'function' ? ctx.resolveDispoPushCreds() : null;
  }

  function headersFor(req, extra) {
    const c = creds();
    const techId = typeof ctx.getTechnicianId === 'function' ? ctx.getTechnicianId(req || {}) : 0;
    const dbDir = ctx.dbDir || ctx.DB_DIR || '';
    const deviceId = dbDir ? getOrCreateDeviceId(dbDir) : undefined;
    return buildDispoMonteurHeaders({
      technicianId: techId || '',
      authHeader: c && c.authHeader ? c.authHeader : undefined,
      deviceId,
      extra: extra || {},
    });
  }

  async function dispoUrl(pathPart) {
    const c = creds();
    if (!c || !c.baseUrl) {
      const err = new Error('Keine Dispo-Verbindung.');
      err.code = 'offline';
      throw err;
    }
    return String(c.baseUrl).replace(/\/$/, '') + pathPart;
  }

  function enqueueFlush(req) {
    const bg = ctx.bgJobs;
    if (!bg || typeof bg.enqueue !== 'function') return;
    const techId = typeof ctx.getTechnicianId === 'function' ? ctx.getTechnicianId(req || {}) : 0;
    const c = creds() || {};
    try {
      bg.enqueue(
        'hinweise_push',
        {
          technicianId: techId,
          baseUrl: c.baseUrl || '',
        },
        'hinweise_push:' + String(techId || '0'),
      );
      if (typeof bg.kick === 'function') bg.kick();
    } catch (e) {
      console.warn('[hinweise] enqueue flush:', e && e.message ? e.message : e);
    }
  }

  async function fetchDispoJson(req, pathPart) {
    const url = await dispoUrl(pathPart);
    const r = await fetch(url, { headers: headersFor(req) });
    const body = await r.text();
    let data = {};
    try {
      data = JSON.parse(body);
    } catch (_) {
      data = { ok: false, error: 'Ungültige Dispo-Antwort.' };
    }
    return { status: r.status, data };
  }

  app.get('/api/hinweise/mine', (req, res) => {
    const database = db();
    if (!database) return res.status(503).json({ ok: false, error: 'Lokale Datenbank nicht bereit.' });
    ensureHinweiseLocalSchema(database);
    const items = mergeRemoteWithLocal(database, [], null);
    res.json({
      ok: true,
      items,
      lamp: items.some((it) => it && it.status !== 'done') ? 'red' : 'off',
      popup: [],
      source: 'local',
    });
  });

  app.get('/api/hinweise', (req, res) => {
    const database = db();
    if (!database) return res.status(503).json({ ok: false, error: 'Lokale Datenbank nicht bereit.' });
    ensureHinweiseLocalSchema(database);
    const fab = String(req.query.fabrikationsnummer || '').trim();
    const status = String(req.query.status || '').trim().toLowerCase();
    if (status === 'done') {
      const rows = database
        .prepare(
          `SELECT * FROM hinweise_local WHERE status = 'done' ORDER BY datetime(created_at) DESC LIMIT 200`,
        )
        .all();
      const items = rows.map((row) => {
        const files = database
          .prepare(
            `SELECT id, original_name, mime, size_bytes FROM hinweis_files_local WHERE client_uuid = ? ORDER BY id`,
          )
          .all(row.client_uuid)
          .map((f) => ({
            id: f.id,
            original_name: f.original_name,
            mime: f.mime || '',
            url: '/api/hinweise/file?local=1&file_id=' + encodeURIComponent(String(f.id)),
          }));
        return {
          hinweis_id: row.server_id || 0,
          client_uuid: row.client_uuid,
          scope: row.scope,
          fabrikationsnummer: row.fabrikationsnummer || '',
          body: row.body || '',
          tag: row.tag || 'allgemein',
          deadline: row.deadline || null,
          validity: row.validity || 'permanent',
          pruefablauf: Number(row.pruefablauf) === 1,
          status: 'done',
          files,
          created_at: row.created_at,
        };
      });
      return res.json({ ok: true, items, total: items.length, source: 'local' });
    }
    res.json({
      ok: true,
      items: mergeRemoteWithLocal(database, [], fab || null),
      source: 'local',
    });
  });

  app.post('/api/hinweise/create', async (req, res) => {
    const database = db();
    if (!database) {
      return res.status(503).json({ ok: false, error: 'Lokale Datenbank nicht bereit.' });
    }
    ensureHinweiseLocalSchema(database);
    let fields = {};
    let files = [];
    try {
      const parsed = await parseMultipart(req);
      fields = parsed.fields || {};
      files = parsed.files || [];
    } catch (_) {
      fields = req.body && typeof req.body === 'object' ? req.body : {};
    }
    fields.scope = 'fn';
    const fab = String(fields.fabrikationsnummer || '').trim();
    const body = String(fields.body || '').trim();
    if (!fab) {
      return res.status(400).json({ ok: false, error: 'fabrikationsnummer erforderlich.' });
    }
    if (!body && !files.length) {
      return res.status(400).json({ ok: false, error: 'Text oder mindestens eine Datei erforderlich.' });
    }
    if (String(fields.validity || '') === 'until_date' && !String(fields.deadline || '').trim()) {
      return res.status(400).json({ ok: false, error: 'Datum erforderlich bei Gültigkeit „bis Datum“.' });
    }
    let local;
    try {
      local = saveCreateLocal(database, ctx.dbDir, fields, files);
      if (typeof ctx.save === 'function') ctx.save();
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Lokal speichern fehlgeschlagen.' });
    }
    enqueueFlush(req);
    setImmediate(() => {
      dispoUrl('/api/mobile/hinweise_create.php')
        .then((url) =>
          flushPendingHinweise(database, {
            dispoUrl: url,
            headers: headersFor(req),
            save: ctx.save,
          }),
        )
        .catch((e) => console.warn('[hinweise] immediate flush:', e && e.message ? e.message : e));
    });
    res.json({
      ok: true,
      hinweis: local && local.hinweis ? local.hinweis : local,
      hinweise: local && local.hinweise ? local.hinweise : local ? [local] : [],
      count: local && local.count != null ? local.count : 1,
      pending_push: true,
    });
  });

  app.post('/api/hinweise/action', express.json(), (req, res) => {
    const database = db();
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    const serverId = parseInt(body.id, 10);
    if (database && (action === 'done' || action === 'erledigt')) {
      ensureHinweiseLocalSchema(database);
      if (Number.isFinite(serverId) && serverId > 0) {
        database.prepare(`UPDATE hinweise_local SET status = 'done', pending_push = 1 WHERE server_id = ?`).run(serverId);
      }
      const uuid = String(body.client_uuid || '').trim();
      if (uuid) {
        database.prepare(`UPDATE hinweise_local SET status = 'done', pending_push = 1 WHERE client_uuid = ?`).run(uuid);
      }
    }
    res.json({ ok: true, pending_push: true, source: 'local' });
  });

  app.get('/api/hinweise/file', async (req, res) => {
    const wantDownload = String(req.query.download || '') === '1';
    function applyDownloadName(name) {
      if (!wantDownload) return;
      const raw = String(name || 'hinweis').replace(/[\r\n"]/g, '_').slice(0, 180);
      res.setHeader('Content-Disposition', `attachment; filename="${raw}"`);
    }
    const database = db();
    if (String(req.query.local || '') === '1' && database) {
      const fileId = parseInt(req.query.file_id, 10);
      const row = fileId > 0 ? getLocalFile(database, fileId) : null;
      if (!row || !row.abs_path) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.' });
      }
      const fs = require('fs');
      if (!fs.existsSync(row.abs_path)) {
        return res.status(404).json({ ok: false, error: 'Datei nicht gefunden.' });
      }
      res.setHeader('Content-Type', row.mime || 'application/octet-stream');
      applyDownloadName(row.original_name);
      return res.sendFile(row.abs_path);
    }
    try {
      const id = String(req.query.id || '');
      const url = await dispoUrl('/api/mobile/hinweis_file.php?id=' + encodeURIComponent(id));
      const r = await fetch(url, { headers: headersFor(req) });
      if (!r.ok) {
        res.status(r.status).json({ ok: false, error: 'Datei nicht gefunden.' });
        return;
      }
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      const cd = r.headers.get('content-disposition');
      if (wantDownload) {
        applyDownloadName((cd && /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd) || [])[1] || 'hinweis');
      } else if (cd) {
        res.setHeader('Content-Disposition', cd);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
  });
}

module.exports = { registerHinweiseRoutes, flushPendingHinweise };
