/**
 * Laptop-Gateway: Hinweise an Dispo-Mobile-API weiterreichen.
 */
function registerHinweiseRoutes(app, ctx) {
  const express = require('express');

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

  async function dispoUrl(path) {
    const c = creds();
    if (!c || !c.baseUrl) {
      const err = new Error('Keine Dispo-Verbindung.');
      err.code = 'offline';
      throw err;
    }
    return String(c.baseUrl).replace(/\/$/, '') + path;
  }

  app.get('/api/hinweise/mine', async (req, res) => {
    try {
      const url = await dispoUrl('/api/mobile/hinweise.php?mine=1');
      const r = await fetch(url, { headers: headersFor(req) });
      const body = await r.text();
      res.status(r.status).type('json').send(body);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
  });

  app.get('/api/hinweise', async (req, res) => {
    try {
      const q = new URLSearchParams();
      ['fabrikationsnummer', 'job_id', 'id', 'mine'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') q.set(k, String(req.query[k]));
      });
      const url = await dispoUrl('/api/mobile/hinweise.php' + (q.toString() ? '?' + q.toString() : '?mine=1'));
      const r = await fetch(url, { headers: headersFor(req) });
      const body = await r.text();
      res.status(r.status).type('json').send(body);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
  });

  app.post('/api/hinweise/create', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    try {
      const url = await dispoUrl('/api/mobile/hinweise_create.php');
      const ct = req.headers['content-type'] || 'application/octet-stream';
      const r = await fetch(url, {
        method: 'POST',
        headers: headersFor(req, { 'Content-Type': ct }),
        body: req.body,
      });
      const body = await r.text();
      res.status(r.status).type('json').send(body);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
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
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message || 'offline' });
    }
  });
}

module.exports = { registerHinweiseRoutes };
