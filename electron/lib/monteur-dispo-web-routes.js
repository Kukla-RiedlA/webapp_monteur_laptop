'use strict';

/**
 * Dispo-Web-Embed wie Dispo Desktop: Session-Cookies, /dispo-remote, Anlagenstamm list/save.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createDispoProxy, loadSession, saveSession } = require('./dispo-proxy');
const { performDispoLogin } = require('./dispo-login');
const { applyDispoTlsPreference } = require('./dispo-tls');
const { registerDispoApiPhpProxyRoutes, createDispoHtmlProxyHandler } = require('./dispo-html-proxy');
const { setDispoPingResult } = require('./connection-state');
const { DEFAULT_DISPO_EXTERNAL_URL, DEFAULT_DISPO_INTERNAL_URL } = require('./dispo-defaults');
const { normalizeDispoBase, buildDispoBaseCandidates } = require('./dispo-base-fallback');
const { rowCount: anlagenstammLocalRowCount, listAnlagenstammForApi } = require('./anlagenstamm-local');

let dispoProxy = null;

function sessionPath(dbDir) {
  return path.join(dbDir, 'dispo_web_session.json');
}

function loadWebSession(dbDir) {
  const p = sessionPath(dbDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveWebSession(dbDir, data) {
  const p = sessionPath(dbDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function getOrCreateProxy() {
  if (!dispoProxy) {
    dispoProxy = createDispoProxy({ allowInsecureTls: true });
  }
  return dispoProxy;
}

function applySessionToProxy(dbDir) {
  const proxy = getOrCreateProxy();
  const stored = loadWebSession(dbDir) || {};
  if (stored.cookies) proxy.jar.loadJSON(stored.cookies);
  const ext = normalizeDispoBase(stored.dispo_external_url || stored.dispo_base || DEFAULT_DISPO_EXTERNAL_URL);
  const int = normalizeDispoBase(stored.dispo_internal_url || DEFAULT_DISPO_INTERNAL_URL);
  proxy.setConfig({
    baseUrl: normalizeDispoBase(stored.dispo_base || ext) || ext,
    externalUrl: ext,
    internalUrl: int,
    urlMode: stored.urlMode || 'auto',
    dispoUsername: stored.dispo_username || '',
    dispoPassword: stored.dispo_password || '',
    allowInsecureTls: true,
  });
  return { proxy, stored };
}

async function ensureProxyAuthenticated(dbDir, creds) {
  const { proxy, stored } = applySessionToProxy(dbDir);
  const username = (creds && creds.serverUsername) || stored.dispo_username || '';
  const password = (creds && creds.serverPassword) != null ? String(creds.serverPassword) : stored.dispo_password || '';
  const externalUrl = normalizeDispoBase(
    (creds && (creds.externalUrl || creds.baseUrl)) || stored.dispo_external_url || DEFAULT_DISPO_EXTERNAL_URL,
  );
  const internalUrl = normalizeDispoBase((creds && creds.internalUrl) || stored.dispo_internal_url || DEFAULT_DISPO_INTERNAL_URL);

  if (!username || !password) {
    return { ok: false, needLogin: true, error: 'Dispo-Anmeldedaten fehlen.' };
  }

  try {
    await proxy.getJson('/api/anlagenstamm_list.php?page=1&page_size=1&omit_fn_filter=1');
    return { ok: true, proxy, authenticated: true, base: proxy.config.baseUrl };
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) {
      /* Session evtl. abgelaufen — neu anmelden */
    }
  }

  proxy.setConfig({
    externalUrl,
    internalUrl,
    dispoUsername: username,
    dispoPassword: password,
  });
  const { sessionData, base } = await performDispoLogin(proxy, {
    username,
    password,
    dispo_base: externalUrl,
  });
  saveWebSession(dbDir, {
    cookies: proxy.jar.toJSON(),
    dispo_base: base,
    dispo_external_url: externalUrl,
    dispo_internal_url: internalUrl,
    dispo_username: sessionData.dispo_username || username,
    dispo_password: password,
    user_id: sessionData.user_id,
    role: sessionData.role,
  });
  proxy.setConfig({ baseUrl: base, dispoUsername: username, dispoPassword: password });
  return { ok: true, proxy, authenticated: true, base, reauth: true };
}

function registerMonteurDispoWebRoutes(app, ctx) {
  const dbDir = ctx.dbDir;
  applyDispoTlsPreference(dbDir, true);

  const webCtx = {
    dispoProxy: getOrCreateProxy(),
    getSession: () => loadWebSession(dbDir),
  };
  applySessionToProxy(dbDir);

  registerDispoApiPhpProxyRoutes(app, webCtx);

  app.use(
    '/dispo-remote',
    express.raw({ type: () => true, limit: '128mb' }),
    (req, _res, next) => {
      req.proxySuffix = req.originalUrl.replace(/^\/dispo-remote/, '') || '/';
      next();
    },
    createDispoHtmlProxyHandler(webCtx),
  );

  app.get('/api/dispo/web-base', (_req, res) => {
    res.json({ ok: true, prefix: '/dispo-remote' });
  });

  app.get('/api/dispo/ping', async (_req, res) => {
    try {
      const auth = await ensureProxyAuthenticated(dbDir, null);
      if (!auth.ok || !auth.authenticated) {
        setDispoPingResult({ online: false });
        return res.json({
          ok: false,
          online: false,
          needLogin: !!auth.needLogin,
          hint: auth.error || 'Nicht angemeldet',
        });
      }
      setDispoPingResult({ online: true });
      return res.json({ ok: true, online: true, base: auth.base });
    } catch (e) {
      setDispoPingResult({ online: false });
      return res.json({ ok: false, online: false, error: e.message || String(e) });
    }
  });

  app.post('/api/dispo/ensure-session', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const auth = await ensureProxyAuthenticated(dbDir, {
        serverUsername: body.serverUsername || body.dispo_username,
        serverPassword: body.serverPassword || body.dispo_password,
        baseUrl: body.baseUrl,
        externalUrl: body.externalUrl || body.baseUrl,
        internalUrl: body.internalUrl,
      });
      if (!auth.ok) {
        return res.status(401).json(auth);
      }
      res.json({ ok: true, base: auth.base, reauth: !!auth.reauth });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/anlagenstamm/list', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const pageSize = Math.min(1000, Math.max(10, parseInt(String(req.query.page_size || '100'), 10) || 100));
      const offset = (page - 1) * pageSize;
      const db = ctx.db;
      const total = db ? anlagenstammLocalRowCount(db) : 0;
      if (db && total > 0) {
        const rows = listAnlagenstammForApi(db, pageSize, offset);
        return res.json({
          ok: true,
          success: true,
          data: rows,
          rows,
          page,
          page_size: pageSize,
          total_count: total,
          total_pages: Math.ceil(total / pageSize) || 1,
          source: 'local_cache',
        });
      }
      const auth = await ensureProxyAuthenticated(dbDir, null);
      if (!auth.ok || !auth.authenticated) {
        return res.status(401).json({ ok: false, error: auth.error || 'Nicht angemeldet', needLogin: true });
      }
      const qs = new URLSearchParams(req.query).toString();
      const data = await auth.proxy.getJson('/api/anlagenstamm_list.php' + (qs ? '?' + qs : ''));
      return res.json(Object.assign({ source: 'dispo_online' }, data));
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: e.message, data: e.data });
    }
  });

  app.post('/api/anlagenstamm/save', express.json(), async (req, res) => {
    try {
      const auth = await ensureProxyAuthenticated(dbDir, req.body || {});
      if (!auth.ok || !auth.authenticated) {
        return res.status(401).json({ ok: false, error: auth.error || 'Nicht angemeldet', needLogin: true });
      }
      const { res: upstream } = await auth.proxy.fetchDispo('/api/anlagenstamm_save.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  registerMonteurDispoWebRoutes,
  ensureProxyAuthenticated,
  getOrCreateProxy,
};
