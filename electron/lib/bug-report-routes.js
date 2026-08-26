'use strict';

const { applyKuklaAuditHeaders } = require('./audit-client-headers');

function registerBugReportRoutes(app, ctx) {
  function authHeaders(req) {
    const creds = ctx.resolveDispoServerCreds(req.body || {});
    const auth = ctx.authHeaderFromCredentials(creds.serverUsername, creds.serverPassword);
    if (!creds.baseUrl || !auth) return null;
    const tid = ctx.getTechnicianId ? ctx.getTechnicianId(req) : 0;
    const headers = applyKuklaAuditHeaders(
      Object.assign(
        { Accept: 'application/json', 'X-Technician-Id': String(tid || '') },
        auth,
      ),
    );
    if (auth.Authorization) headers['X-Kukla-Authorization'] = auth.Authorization;
    return { baseUrl: String(creds.baseUrl).replace(/\/$/, ''), headers };
  }

  async function proxyJson(req, res, mobilePath, method, body) {
    const auth = authHeaders(req);
    if (!auth) {
      return res.status(503).json({ ok: false, error: 'Keine Dispo-Verbindung. Bitte in den Einstellungen anmelden.' });
    }
    const url = auth.baseUrl + mobilePath;
    const headers = Object.assign({}, auth.headers);
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const fetchFn = ctx.fetchWithTimeout || fetch;
      const r = await fetchFn(url, {
        method: method || 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : r.status).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'Server nicht erreichbar.' });
    }
  }

  app.get('/api/bug_report/list', (req, res) => {
    const q = [];
    if (req.query.status) q.push('status=' + encodeURIComponent(String(req.query.status)));
    if (req.query.kind) q.push('kind=' + encodeURIComponent(String(req.query.kind)));
    const suffix = q.length ? ('?' + q.join('&')) : '';
    return proxyJson(req, res, '/api/mobile/bug_report_list.php' + suffix, 'GET');
  });

  app.get('/api/bug_report/get', (req, res) => {
    const id = encodeURIComponent(String(req.query.id || ''));
    return proxyJson(req, res, '/api/mobile/bug_report_get.php?id=' + id, 'GET');
  });

  app.post('/api/bug_report/create', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    body.app_client = 'laptop';
    if (!body.app_version && ctx.getAppVersion) {
      body.app_version = ctx.getAppVersion() || '';
    }
    return proxyJson(req, res, '/api/mobile/bug_report_create.php', 'POST', body);
  });

  app.post('/api/bug_report/comment', (req, res) => {
    return proxyJson(req, res, '/api/mobile/bug_report_comment.php', 'POST', req.body || {});
  });

  app.post('/api/bug_report/set-status', (req, res) => {
    return proxyJson(req, res, '/api/mobile/bug_report_set_status.php', 'POST', req.body || {});
  });

  app.get('/api/bug_report/screenshot', async (req, res) => {
    const auth = authHeaders(req);
    if (!auth) {
      return res.status(503).json({ ok: false, error: 'Keine Dispo-Verbindung.' });
    }
    const id = encodeURIComponent(String(req.query.id || ''));
    const url = auth.baseUrl + '/api/mobile/bug_report_screenshot.php?id=' + id;
    try {
      const fetchFn = ctx.fetchWithTimeout || fetch;
      const headers = Object.assign({}, auth.headers);
      delete headers.Accept;
      const r = await fetchFn(url, { method: 'GET', headers });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json(data.ok === false ? data : { ok: false, error: 'Screenshot nicht verfügbar.' });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(buf.length));
      return res.end(buf);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'Screenshot-Abruf fehlgeschlagen.' });
    }
  });
}

module.exports = { registerBugReportRoutes };
