'use strict';

/**
 * Dispo-Web-Embed wie Dispo Desktop: Session-Cookies, /dispo-remote, Anlagenstamm list/save.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createDispoProxy, loadSession, saveSession } = require('./dispo-proxy');
const { performDispoLogin } = require('./dispo-login');
const { takePasswordFromRecord, attachSealedPassword } = require('./credential-vault');
const { applyDispoTlsPreference } = require('./dispo-tls');
const { registerDispoApiPhpProxyRoutes, createDispoHtmlProxyHandler } = require('./dispo-html-proxy');
const { setDispoPingResult } = require('./connection-state');
const { DEFAULT_DISPO_EXTERNAL_URL, DEFAULT_DISPO_INTERNAL_URL } = require('./dispo-defaults');
const { normalizeDispoBase, buildDispoBaseCandidates } = require('./dispo-base-fallback');

let dispoProxy = null;

function sessionPath(dbDir) {
  return path.join(dbDir, 'dispo_web_session.json');
}

function loadWebSession(dbDir) {
  const p = sessionPath(dbDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const taken = takePasswordFromRecord(raw);
    if (taken.migrated || (raw && (raw.dispo_password != null || raw.serverPassword != null))) {
      try {
        fs.writeFileSync(p, JSON.stringify(taken.record, null, 2), 'utf8');
      } catch (_) { /* ignore rewrite */ }
    }
    return { ...taken.record, dispo_password: taken.password };
  } catch (_) {
    return null;
  }
}

function saveWebSession(dbDir, data) {
  const p = sessionPath(dbDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const password = data && data.dispo_password != null ? data.dispo_password : '';
  const sealed = attachSealedPassword(data || {}, password);
  fs.writeFileSync(p, JSON.stringify(sealed.record, null, 2), 'utf8');
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
  const username = ((creds && creds.serverUsername) || stored.dispo_username || '').trim();
  const password =
    creds && creds.serverPassword != null && String(creds.serverPassword) !== ''
      ? String(creds.serverPassword)
      : stored.dispo_password || '';
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
  try {
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
  } catch (loginErr) {
    return {
      ok: false,
      authenticated: false,
      error: loginErr && loginErr.message ? loginErr.message : 'Dispo-Login fehlgeschlagen.',
    };
  }
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

  app.get('/api/dispo/auth-status', (_req, res) => {
    const stored = loadWebSession(dbDir) || {};
    const username = String(stored.dispo_username || '').trim();
    const hasPass = stored.dispo_password != null && String(stored.dispo_password) !== '';
    res.json({
      ok: true,
      has_credentials: !!(username && hasPass),
      username,
    });
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
}

/** Schneller Download-Versuch mit vorhandenen Session-Cookies (ohne Login-Probe). */
async function tryProxyFetchDispoBinary(dbDir, pathSuffix) {
  const { proxy } = applySessionToProxy(dbDir);
  const suffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
  try {
    const { res } = await proxy.fetchDispo(suffix, { method: 'GET' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || ct.includes('application/json')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { buf, contentDisposition: res.headers.get('content-disposition') || '' };
  } catch (_) {
    return null;
  }
}

module.exports = {
  registerMonteurDispoWebRoutes,
  ensureProxyAuthenticated,
  tryProxyFetchDispoBinary,
  getOrCreateProxy,
  saveWebSession,
  loadWebSession,
};
