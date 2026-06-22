'use strict';

const express = require('express');
const { parseMultipart } = require('./multipart-upload');
const {
  hasLocalAnlagenstammData,
  getAnlagenstammListResponse,
  getAnlagenstammFnFocusResponse,
  getAnlagenstammExtrasResponse,
  mergeAnlagenstammExtrasWithRemote,
  persistMergedExtrasToDb,
  getAnlagenstammByIdResponse,
  deleteAnlagenstammLocal,
} = require('./anlagenstamm-php-local');

function dispoMonteurHeaders(ctx, technicianId, credsOpt) {
  const creds =
    credsOpt && typeof credsOpt === 'object'
      ? credsOpt
      : ctx.resolveDispoServerCreds
        ? ctx.resolveDispoServerCreds({})
        : {};
  const u = String(
    creds.serverUsername || (ctx.getDispoUsername ? ctx.getDispoUsername() : '') || '',
  ).trim();
  const p = creds.serverPassword != null ? String(creds.serverPassword) : ctx.getDispoPassword ? String(ctx.getDispoPassword() || '') : '';
  const h = { 'X-Technician-Id': String(technicianId || '') };
  if (u) {
    const auth = 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64');
    h.Authorization = auth;
    h['X-Kukla-Authorization'] = auth;
  }
  return h;
}

/** Monteur-API (dispo_api): Basic-Auth, optional Request-Creds oder persistierte Session. */
async function fetchDispoApiFilesList(ctx, technicianId, fab, credsOpt) {
  const creds =
    credsOpt && typeof credsOpt === 'object'
      ? credsOpt
      : ctx.resolveDispoServerCreds
        ? ctx.resolveDispoServerCreds({})
        : {};
  const base = String(creds.baseUrl || (ctx.getDispoBaseUrl ? ctx.getDispoBaseUrl() : '') || '')
    .trim()
    .replace(/\/$/, '');
  const fabNorm = String(fab || '').trim();
  if (!base || !technicianId || !fabNorm) return null;
  const u = String(creds.serverUsername || (ctx.getDispoUsername ? ctx.getDispoUsername() : '') || '').trim();
  if (!u) return null;
  const url =
    `${base}/dispo_api/api/anlagenstamm_files_list.php?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabNorm)}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(url, { headers: dispoMonteurHeaders(ctx, technicianId, creds), signal: ac.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** TED/PN-Extras direkt per Basic-Auth (wie Sync), unabhängig von Proxy-Session. */
async function fetchDispoApiListExtras(ctx, body, credsOpt) {
  const creds =
    credsOpt && typeof credsOpt === 'object'
      ? credsOpt
      : ctx.resolveDispoServerCreds
        ? ctx.resolveDispoServerCreds(body || {})
        : {};
  const base = String(creds.baseUrl || (ctx.getDispoBaseUrl ? ctx.getDispoBaseUrl() : '') || '')
    .trim()
    .replace(/\/$/, '');
  const fabs = Array.isArray(body && body.fabs)
    ? body.fabs.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  const u = String(creds.serverUsername || (ctx.getDispoUsername ? ctx.getDispoUsername() : '') || '').trim();
  if (!base || !u || !fabs.length) return null;
  const url = `${base}/api/anlagenstamm_list_extras.php`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, dispoMonteurHeaders(ctx, null, creds)),
      body: JSON.stringify({ fabs }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data || data.success === false) return null;
    return data;
  } catch (_) {
    return null;
  }
}

async function fetchRemoteListExtras(ctx, body) {
  const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds(body || {}) : {};
  const viaApi = await fetchDispoApiListExtras(ctx, body, creds);
  if (viaApi) return viaApi;
  return proxyPostJson(ctx, '/api/anlagenstamm_list_extras.php', body || {}, creds);
}

async function proxyGetJson(ctx, path, credsOpt) {
  const creds =
    credsOpt && typeof credsOpt === 'object'
      ? credsOpt
      : ctx.resolveDispoServerCreds
        ? ctx.resolveDispoServerCreds({})
        : null;
  const auth = await ctx.ensureProxyAuthenticated(creds);
  if (!auth.ok || !auth.authenticated) return null;
  try {
    return await auth.proxy.getJson(path);
  } catch (_) {
    return null;
  }
}

async function proxyPostJson(ctx, path, body, credsOpt) {
  const creds =
    credsOpt && typeof credsOpt === 'object'
      ? credsOpt
      : ctx.resolveDispoServerCreds
        ? ctx.resolveDispoServerCreds(body || {})
        : null;
  const auth = await ctx.ensureProxyAuthenticated(creds);
  if (!auth.ok || !auth.authenticated) return null;
  try {
    const { res } = await auth.proxy.fetchDispo(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json().catch(() => ({}));
  } catch (_) {
    return null;
  }
}

function registerAnlagenstammPhpRoutes(app, ctx) {
  const db = () => ctx.db;

  app.get('/api/anlagenstamm_list.php', (req, res) => {
    res.json(getAnlagenstammListResponse(db(), req.query));
  });

  app.get('/api/anlagenstamm_get.php', (req, res) => {
    const id = req.query.id || req.query.ID;
    if (!id) return res.status(400).json({ success: false, error: 'id erforderlich' });
    res.json(getAnlagenstammByIdResponse(db(), id));
  });

  app.get('/api/anlagenstamm_fn_focus.php', (req, res) => {
    res.json(getAnlagenstammFnFocusResponse(db(), req.query));
  });

  app.get('/api/anlagenstamm_list_extras.php', async (req, res) => {
    const local = getAnlagenstammExtrasResponse(db(), req.query || {});
    if (!hasLocalAnlagenstammData(db())) return res.json(local);
    const body = req.query && req.query.fabs != null ? { fabs: req.query.fabs } : req.query || {};
    const remote = await fetchRemoteListExtras(ctx, body);
    const merged = mergeAnlagenstammExtrasWithRemote(local, remote);
    const n = persistMergedExtrasToDb(db(), merged);
    if (n > 0 && typeof ctx.saveDb === 'function') ctx.saveDb();
    return res.json(merged);
  });

  app.post('/api/anlagenstamm_list_extras.php', express.json({ limit: '4mb' }), async (req, res) => {
    const local = getAnlagenstammExtrasResponse(db(), req.body || {});
    if (!hasLocalAnlagenstammData(db())) return res.json(local);
    const remote = await fetchRemoteListExtras(ctx, req.body || {});
    const merged = mergeAnlagenstammExtrasWithRemote(local, remote);
    const n = persistMergedExtrasToDb(db(), merged);
    if (n > 0 && typeof ctx.saveDb === 'function') ctx.saveDb();
    return res.json(merged);
  });

  app.post('/api/anlagenstamm_save.php', async (req, res) => {
    try {
      const { fields, files } = await parseMultipart(req);
      if (files && files.length) {
        return res.status(400).json({ success: false, error: 'Datei-Upload nur über Server.' });
      }
      const technicianId = ctx.getTechnicianId(req);
      const body = Object.assign({}, fields, {
        technician_id: technicianId,
        serverUsername: fields.serverUsername || ctx.getDispoUsername(),
        serverPassword: fields.serverPassword || ctx.getDispoPassword(),
        baseUrl: fields.baseUrl || ctx.getDispoBaseUrl(),
        externalUrl: ctx.getDispoExternalUrl ? ctx.getDispoExternalUrl() : '',
        internalUrl: ctx.getDispoInternalUrl ? ctx.getDispoInternalUrl() : '',
      });
      const result = await ctx.performAnlagenstammSave(body, technicianId);
      if (!result.ok) {
        return res.json({ success: false, error: result.error || 'Speichern fehlgeschlagen' });
      }
      res.json({
        success: true,
        id: result.id,
        fabrikationsnummer: result.fabrikationsnummer,
        pending_sync: !!result.pending_sync,
        push_error: result.push_error || null,
        source: 'local_cache',
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  app.post('/api/anlagenstamm_delete.php', express.json(), (req, res) => {
    try {
      const payload = req.body || {};
      const out = deleteAnlagenstammLocal(db(), payload);
      if (out.success && typeof ctx.saveDb === 'function') ctx.saveDb();
      res.json(out);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  app.get('/api/anlagenstamm_files_list.php', async (req, res) => {
    const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ success: false, error: 'fab erforderlich' });
    const technicianId = ctx.getTechnicianId(req);
    const cacheOnly = String(req.query.cache_only || '') === '1';

    function filesListPayload(pnRaw, source) {
      const tree = (pnRaw && pnRaw.tree) || [];
      const rootName =
        (pnRaw && pnRaw.root_name) ||
        (tree[0] && (tree[0].name || tree[0].label) ? String(tree[0].name || tree[0].label) : '');
      return {
        success: true,
        ok: true,
        files: [],
        projekte_neu: {
          enabled: !pnRaw || pnRaw.enabled !== false,
          tree,
          root_name: String(rootName || '').trim(),
        },
        source,
      };
    }

    if (typeof ctx.readAnlagenstammTreeCache === 'function') {
      const cached = ctx.readAnlagenstammTreeCache(db(), fab);
      if (cached && cached.tree && cached.tree.length) {
        const payload = filesListPayload(
          {
            enabled: cached.projects_enabled,
            tree: cached.tree,
            root_name:
              cached.tree[0] && (cached.tree[0].name || cached.tree[0].label)
                ? String(cached.tree[0].name || cached.tree[0].label)
                : '',
          },
          'local_cache',
        );
        return res.json(payload);
      }
      if (
        cached &&
        (!cached.tree || !cached.tree.length) &&
        !(cached.content_signature && String(cached.content_signature).trim())
      ) {
        try {
          db().prepare('DELETE FROM anlagenstamm_tree_cache WHERE fab = ?').run(fab);
          if (typeof ctx.saveDb === 'function') ctx.saveDb();
        } catch (_) {
          /* ignore */
        }
      }
    }

    if (cacheOnly) {
      return res.json(filesListPayload({ enabled: false, tree: [], root_name: '' }, 'cache_miss'));
    }

    if (typeof ctx.buildLocalProjekteNeuTreeForFab === 'function') {
      const local = ctx.buildLocalProjekteNeuTreeForFab(technicianId, fab);
      if (local && local.tree && local.tree.length) {
        if (typeof ctx.upsertAnlagenstammTreeCache === 'function') {
          ctx.upsertAnlagenstammTreeCache(db(), fab, local);
          if (typeof ctx.saveDb === 'function') ctx.saveDb();
        }
        return res.json(filesListPayload(local, 'local_scan'));
      }
    }

    const apiData = await fetchDispoApiFilesList(ctx, technicianId, fab);
    if (apiData && apiData.projekte_neu) {
      if (typeof ctx.upsertAnlagenstammTreeCache === 'function') {
        ctx.upsertAnlagenstammTreeCache(db(), fab, apiData.projekte_neu);
        if (typeof ctx.saveDb === 'function') ctx.saveDb();
      }
      return res.json(Object.assign({ source: 'dispo_api' }, apiData));
    }

    const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : null;
    const auth = await ctx.ensureProxyAuthenticated(creds);
    if (!auth.ok || !auth.authenticated) {
      return res.json(filesListPayload({ enabled: false, tree: [], root_name: '' }, 'local_empty'));
    }
    try {
      const qs = new URLSearchParams(req.query).toString();
      const data = await auth.proxy.getJson(`/api/anlagenstamm_files_list.php${qs ? `?${qs}` : ''}`);
      if (typeof ctx.upsertAnlagenstammTreeCache === 'function' && data && data.projekte_neu) {
        ctx.upsertAnlagenstammTreeCache(db(), fab, data.projekte_neu);
        if (typeof ctx.saveDb === 'function') ctx.saveDb();
      }
      return res.json(Object.assign({ source: 'dispo_online' }, data));
    } catch (e) {
      return res.status(502).json({ success: false, error: e.message || String(e) });
    }
  });

  /** Kompatibilität: alte List-Route delegiert. */
  app.get('/api/anlagenstamm/list', (req, res) => {
    const data = getAnlagenstammListResponse(db(), req.query);
    res.json(Object.assign({ ok: true }, data));
  });
}

module.exports = { registerAnlagenstammPhpRoutes };
