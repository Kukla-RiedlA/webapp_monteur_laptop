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

function registerHinweiseRoutes(app, ctx) {
  function db() {
    return typeof ctx.db === 'function' ? ctx.db() : ctx.db;
  }

  function creds() {
    return typeof ctx.resolveDispoPushCreds === 'function' ? ctx.resolveDispoPushCreds() : null;
  }

  function headersFor(req, extra) {
    const c = creds();
    const h = Object.assign({}, extra || {});
    if (c && c.authHeader) Object.assign(h, c.authHeader);
    const techId = typeof ctx.getTechnicianId === 'function' ? ctx.getTechnicianId(req || {}) : 0;
    if (techId) h['X-Technician-Id'] = String(techId);
    if (h.Authorization) {
      h['X-Kukla-Authorization'] = h.Authorization;
      h['X-Authorization'] = h.Authorization;
    }
    return h;
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

  app.get('/api/hinweise/mine', async (req, res) => {
    const database = db();
    if (database) ensureHinweiseLocalSchema(database);
    try {
      const got = await fetchDispoJson(req, '/api/mobile/hinweise.php?mine=1');
      const data = got.data && typeof got.data === 'object' ? got.data : {};
      if (database) {
        data.items = mergeRemoteWithLocal(database, data.items || [], null);
        if (!data.lamp || data.lamp === 'off') {
          const pendingOpen = (data.items || []).some((it) => it && it.pending_push && it.status !== 'done');
          if (pendingOpen) data.lamp = 'red';
        }
        data.ok = data.ok !== false;
      }
      res.status(got.status && got.status >= 400 && data.ok === false ? got.status : 200).json(data);
    } catch (e) {
      if (database) {
        const items = mergeRemoteWithLocal(database, [], null);
        return res.json({
          ok: true,
          items,
          lamp: items.some((it) => it && it.status !== 'done') ? 'red' : 'off',
          popup: [],
          pending_push: true,
          error: e.message || 'offline',
        });
      }
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
  });

  app.get('/api/hinweise', async (req, res) => {
    const database = db();
    if (database) ensureHinweiseLocalSchema(database);
    const fab = String(req.query.fabrikationsnummer || '').trim();
    try {
      const q = new URLSearchParams();
      ['fabrikationsnummer', 'job_id', 'id', 'mine'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') q.set(k, String(req.query[k]));
      });
      const got = await fetchDispoJson(
        req,
        '/api/mobile/hinweise.php' + (q.toString() ? '?' + q.toString() : '?mine=1'),
      );
      const data = got.data && typeof got.data === 'object' ? got.data : {};
      if (database) {
        data.items = mergeRemoteWithLocal(database, data.items || [], fab || null);
        data.ok = data.ok !== false;
      }
      res.status(got.status && got.status >= 400 && data.ok === false ? got.status : 200).json(data);
    } catch (e) {
      if (database) {
        return res.json({
          ok: true,
          items: mergeRemoteWithLocal(database, [], fab || null),
          pending_push: true,
        });
      }
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
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
    res.json({ ok: true, hinweis: local, pending_push: true });
  });

  app.post('/api/hinweise/action', express.json(), async (req, res) => {
    try {
      const url = await dispoUrl('/api/mobile/hinweis_action.php');
      const r = await fetch(url, {
        method: 'POST',
        headers: headersFor(req, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(req.body || {}),
      });
      const body = await r.text();
      res.status(r.status).type('json').send(body);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
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
