'use strict';

const express = require('express');
const { parseMultipart } = require('./multipart-upload');
const {
  getAnlagenstammListResponse,
  getAnlagenstammFnFocusResponse,
  getAnlagenstammExtrasResponse,
  getAnlagenstammByIdResponse,
} = require('./anlagenstamm-php-local');
const { buildLocalAnlagenstammGallery } = require('./anlagenstamm-gallery-local');
const { buildLocalAnlagenstammDocumentsList } = require('./anlagenstamm-documents-local');
const fs = require('fs');
const { applyKuklaAuditHeaders } = require('./audit-client-headers');
const { parseMlPdfBuffer } = require('./anlagenstamm-ml-pdf');

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
  const h = applyKuklaAuditHeaders({ 'X-Technician-Id': String(technicianId || '') });
  if (u && p) {
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

async function fetchDispoApiMlPdfPrefill(ctx, technicianId, fab, pathRel, debug, credsOpt) {
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
  const qs = new URLSearchParams({
    technician_id: String(technicianId),
    fab: fabNorm,
  });
  if (pathRel) qs.set('path', String(pathRel));
  if (debug) qs.set('debug', '1');
  const url = `${base}/dispo_api/api/anlagenstamm_ml_pdf_prefill.php?${qs.toString()}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(url, { headers: dispoMonteurHeaders(ctx, technicianId, creds), signal: ac.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (_) {
    return null;
  }
}

async function parseLocalMlPdfPath(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return await parseMlPdfBuffer(buf);
  } catch (_) {
    return null;
  }
}

function looksLikePdfBuffer(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.slice(0, 24).toString('utf8').trim();
  if (head.startsWith('{') || head.startsWith('<')) return false;
  return buf.slice(0, 5).toString('latin1') === '%PDF-' || buf.length > 80;
}

async function downloadMlPdfViaSession(ctx, technicianId, fab, pathRel) {
  if (!pathRel || typeof ctx.tryProxyFetchDispoBinary !== 'function') return null;
  const qs =
    `fab=${encodeURIComponent(fab)}&fabrikationsnummer=${encodeURIComponent(fab)}` +
    `&source=projekte_neu&path=${encodeURIComponent(pathRel)}`;
  const suffixes = [
    `/api/anlagenstamm_file_download.php?${qs}`,
    `/dispo_api/api/anlagenstamm_file_download.php?technician_id=${encodeURIComponent(technicianId || '')}&${qs}`,
  ];
  for (const suffix of suffixes) {
    try {
      const hit = await ctx.tryProxyFetchDispoBinary(suffix);
      if (hit && looksLikePdfBuffer(hit.buf)) return hit.buf;
    } catch (_) {}
  }
  return null;
}

/** TD-Prefill (pdftotext auf dem Dispo-Server). Länger timeout, PDF/Word-Parse. */
async function fetchDispoApiTdPdfPrefill(ctx, technicianId, fab, pathRel, debug, credsOpt) {
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
  const qs = new URLSearchParams({
    technician_id: String(technicianId),
    fab: fabNorm,
  });
  if (pathRel) qs.set('path', String(pathRel));
  if (debug) qs.set('debug', '1');
  const url = `${base}/dispo_api/api/anlagenstamm_td_pdf_prefill.php?${qs.toString()}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(url, { headers: dispoMonteurHeaders(ctx, technicianId, creds), signal: ac.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!data || typeof data !== 'object') return null;
    return data;
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

  app.get('/api/anlagenstamm_list_extras.php', (req, res) => {
    // Offline-first: TED/PN aus SQLite, kein Warten auf Dispo (sonst hängt die ganze App).
    res.json(getAnlagenstammExtrasResponse(db(), req.query || {}));
  });

  app.post('/api/anlagenstamm_list_extras.php', express.json({ limit: '4mb' }), (req, res) => {
    res.json(getAnlagenstammExtrasResponse(db(), req.body || {}));
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

  app.post('/api/anlagenstamm_delete.php', express.json(), async (req, res) => {
    try {
      const technicianId = ctx.getTechnicianId(req);
      const payload = req.body || {};
      const body = Object.assign({}, payload, {
        technician_id: technicianId,
        serverUsername: payload.serverUsername || (ctx.getDispoUsername ? ctx.getDispoUsername() : ''),
        serverPassword: payload.serverPassword || (ctx.getDispoPassword ? ctx.getDispoPassword() : ''),
        baseUrl: payload.baseUrl || (ctx.getDispoBaseUrl ? ctx.getDispoBaseUrl() : ''),
        externalUrl: ctx.getDispoExternalUrl ? ctx.getDispoExternalUrl() : '',
        internalUrl: ctx.getDispoInternalUrl ? ctx.getDispoInternalUrl() : '',
      });
      if (typeof ctx.performAnlagenstammDelete === 'function') {
        const result = await ctx.performAnlagenstammDelete(body, technicianId);
        if (!result.success) {
          return res.json({ success: false, error: result.error || 'Löschen fehlgeschlagen' });
        }
        return res.json({
          success: true,
          id: result.id,
          fabrikationsnummer: result.fabrikationsnummer,
          pending_sync: !!result.pending_sync,
          push_error: result.push_error || null,
          source: result.source || 'local_cache',
        });
      }
      return res.status(501).json({ success: false, error: 'Löschen nicht verfügbar.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  app.get('/api/anlagenstamm_gallery.php', (req, res) => {
    const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'Fabrikationsnummer fehlt' });
    let tree = [];
    let source = 'local_cache_empty';
    if (typeof ctx.readAnlagenstammTreeCache === 'function') {
      const cached = ctx.readAnlagenstammTreeCache(db(), fab);
      if (cached && Array.isArray(cached.tree) && cached.tree.length) {
        tree = cached.tree;
        source = 'local_cache';
      }
    }
    let extraFiles = [];
    try {
      extraFiles =
        typeof ctx.listMontageGalleryFiles === 'function' ? ctx.listMontageGalleryFiles(fab) || [] : [];
    } catch (_) {
      extraFiles = [];
    }
    const gallery = buildLocalAnlagenstammGallery(fab, tree, {
      technicianId: ctx.getTechnicianId(req),
      extraFiles,
    });
    try {
      console.log('[anlagenstamm_gallery]', fab, 'items=' + gallery.length, 'source=' + source);
    } catch (_) {}
    if (typeof ctx.prewarmAnlagenstammGalleryThumbs === 'function' && gallery.length) {
      const technicianId = ctx.getTechnicianId(req);
      setImmediate(() => {
        try {
          ctx.prewarmAnlagenstammGalleryThumbs(fab, gallery, technicianId);
        } catch (_) {
          /* ignore */
        }
      });
    }
    return res.json({ ok: true, gallery, source });
  });

  app.get('/api/anlagenstamm_documents_list.php', (req, res) => {
    const fab = String(req.query.fab || req.query.fabrikationsnummer || '').trim();
    if (!fab) return res.status(400).json({ ok: false, success: false, error: 'Fabrikationsnummer fehlt' });
    let payload;
    try {
      payload = buildLocalAnlagenstammDocumentsList(db(), fab);
    } catch (_) {
      payload = {
        ok: true,
        success: true,
        fab,
        parameter_fab: fab,
        categories: [],
        events: [],
        timeline: [],
        source: 'local_fast',
      };
    }
    return res.json(payload);
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
        return res.json(filesListPayload(local, 'local_cache'));
      }
    }

    const apiData = await fetchDispoApiFilesList(ctx, technicianId, fab);
    if (apiData && apiData.projekte_neu) {
      if (typeof ctx.upsertAnlagenstammTreeCache === 'function') {
        ctx.upsertAnlagenstammTreeCache(db(), fab, apiData.projekte_neu);
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
      }
      return res.json(Object.assign({ source: 'dispo_online' }, data));
    } catch (e) {
      return res.status(502).json({ success: false, error: e.message || String(e) });
    }
  });

  app.get(['/api/anlagenstamm_ml_pdf_prefill.php', '/api/anlagenstamm_ml_pdf_prefill'], async (req, res) => {
    const fab = String(req.query.fab || req.query.fabrikationsnummer || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'fab fehlt.' });
    const pathRel = String(req.query.path || '').trim();
    const debug = String(req.query.debug || '') === '1';
    const technicianId = ctx.getTechnicianId(req);
    const jobId = req.query.job_id;

    async function parsedOk(parsed, fileLabel, source) {
      const motors = parsed && Array.isArray(parsed.motors) ? parsed.motors : [];
      if (!motors.length) return null;
      const out = { ok: true, motors, file: fileLabel || pathRel || '', source };
      if (debug && parsed.text) out.text_head = String(parsed.text).slice(0, 800);
      return out;
    }

    if (pathRel && typeof ctx.resolveProjekteNeuLocalFile === 'function') {
      try {
        const localPath = ctx.resolveProjekteNeuLocalFile(technicianId, fab, pathRel, jobId);
        if (localPath) {
          const parsed = await parseLocalMlPdfPath(localPath);
          const hit = await parsedOk(parsed, pathRel, 'local_file');
          if (hit) return res.json(hit);
        }
      } catch (_) {}
    }

    const apiData = await fetchDispoApiMlPdfPrefill(ctx, technicianId, fab, pathRel, debug);
    if (apiData && apiData.ok && Array.isArray(apiData.motors) && apiData.motors.length) {
      return res.json(Object.assign({ source: 'dispo_api' }, apiData));
    }

    let downloadPath = pathRel || String((apiData && apiData.file) || '').trim();
    if (downloadPath) {
      const buf = await downloadMlPdfViaSession(ctx, technicianId, fab, downloadPath);
      if (buf) {
        try {
          const parsed = await parseMlPdfBuffer(buf);
          const hit = await parsedOk(parsed, downloadPath, 'dispo_file');
          if (hit) return res.json(hit);
          if (parsed && parsed.ok) {
            return res.json({
              ok: true,
              motors: [],
              file: downloadPath,
              note: parsed.note || 'PDF gelesen, aber keine Antriebe zugeordnet.',
              source: 'dispo_file',
            });
          }
        } catch (_) {}
      }
    }

    if (apiData && typeof apiData === 'object' && (apiData.ok === true || apiData.ok === false)) {
      return res.json(Object.assign({ source: 'dispo_api' }, apiData));
    }

    const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : null;
    const auth = await ctx.ensureProxyAuthenticated(creds);
    if (auth && auth.ok && auth.authenticated) {
      try {
        const qs = new URLSearchParams({ fab });
        if (pathRel) qs.set('path', pathRel);
        if (debug) qs.set('debug', '1');
        const data = await auth.proxy.getJson(`/api/anlagenstamm_ml_pdf_prefill.php?${qs.toString()}`);
        if (data && data.ok && Array.isArray(data.motors) && data.motors.length) {
          return res.json(Object.assign({ source: 'dispo_online' }, data));
        }
        if (data && typeof data === 'object') {
          const fileFromDispo = String((data && data.file) || downloadPath || '').trim();
          if (fileFromDispo) {
            const buf = await downloadMlPdfViaSession(ctx, technicianId, fab, fileFromDispo);
            if (buf) {
              const parsed = await parseMlPdfBuffer(buf);
              const hit = await parsedOk(parsed, fileFromDispo, 'dispo_file');
              if (hit) return res.json(hit);
            }
          }
          return res.json(Object.assign({ source: 'dispo_online' }, data || {}));
        }
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message || String(e) });
      }
    }
    return res.status(503).json({
      ok: false,
      error: 'Keine Motorliste gefunden (PDF oder Anlagenstamm).',
    });
  });

  app.get('/api/anlagenstamm_td_pdf_prefill.php', async (req, res) => {
    const fab = String(req.query.fab || req.query.fabrikationsnummer || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'fab fehlt.' });
    const pathRel = String(req.query.path || '').trim();
    const debug = String(req.query.debug || '') === '1';
    const technicianId = ctx.getTechnicianId(req);

    const apiData = await fetchDispoApiTdPdfPrefill(ctx, technicianId, fab, pathRel, debug);
    if (apiData && (apiData.ok === true || apiData.ok === false)) {
      return res.json(Object.assign({ source: 'dispo_api' }, apiData));
    }

    const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : null;
    const auth = await ctx.ensureProxyAuthenticated(creds);
    if (auth && auth.ok && auth.authenticated) {
      try {
        const qs = new URLSearchParams({ fab });
        if (pathRel) qs.set('path', pathRel);
        if (debug) qs.set('debug', '1');
        const data = await auth.proxy.getJson(`/api/anlagenstamm_td_pdf_prefill.php?${qs.toString()}`);
        return res.json(Object.assign({ source: 'dispo_online' }, data || {}));
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message || String(e) });
      }
    }
    return res.status(503).json({
      ok: false,
      error: 'TD-Daten nur online (Dispo-Server). Bitte Verbindung prüfen.',
    });
  });

  /** Kompatibilität: alte List-Route delegiert. */
  app.get('/api/anlagenstamm/list', (req, res) => {
    const data = getAnlagenstammListResponse(db(), req.query);
    res.json(Object.assign({ ok: true }, data));
  });
}

module.exports = { registerAnlagenstammPhpRoutes };
