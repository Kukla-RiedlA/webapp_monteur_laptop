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
const {
  buildLocalAnlagenstammDocumentsList,
  mergeRemoteDocumentsList,
} = require('./anlagenstamm-documents-local');
const fs = require('fs');
const { applyKuklaAuditHeaders } = require('./audit-client-headers');
const { parseMlPdfBuffer, isMlPdfCandidate, mlPdfLangRank, mlPdfMatchRank } = require('./anlagenstamm-ml-pdf');
const { readParameterSourceText, decodeParameterFileBytes, normalizeFabDigits } = require('./anlagenstamm-local');

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

async function fetchDispoApiGet(ctx, technicianId, fab, relativePhp, credsOpt, timeoutMs) {
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
    `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}&fab=${encodeURIComponent(fabNorm)}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
    const r = await fetch(url, { headers: dispoMonteurHeaders(ctx, technicianId, creds), signal: ac.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Monteur-API (dispo_api): Basic-Auth, optional Request-Creds oder persistierte Session. */
async function fetchDispoApiFilesList(ctx, technicianId, fab, credsOpt) {
  return fetchDispoApiGet(ctx, technicianId, fab, '/dispo_api/api/anlagenstamm_files_list.php', credsOpt, 12000);
}

async function fetchDispoApiDocumentsList(ctx, technicianId, fab, credsOpt) {
  return fetchDispoApiGet(
    ctx,
    technicianId,
    fab,
    '/dispo_api/api/anlagenstamm_documents_list.php',
    credsOpt,
    15000,
  );
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

function collectMlPdfRels(nodes, acc) {
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    const rel = String(n.rel || '').trim();
    const name = String(n.name || (rel ? rel.split('/').pop() : '') || '');
    if (rel && isMlPdfCandidate(name, rel)) acc.push(rel);
    if (Array.isArray(n.children)) collectMlPdfRels(n.children, acc);
  }
}

function sortMlPdfRels(rels, fab) {
  const fd = String(fab || '').replace(/\D/g, '');
  return [...new Set(rels.filter(Boolean))].sort((a, b) => {
    const match = mlPdfMatchRank(a) - mlPdfMatchRank(b);
    if (match) return match;
    const lang = mlPdfLangRank(a) - mlPdfLangRank(b);
    if (lang) return lang;
    const af = fd && String(a).includes(fd) ? 0 : 1;
    const bf = fd && String(b).includes(fd) ? 0 : 1;
    return af - bf;
  });
}

function mergeMotorRows(into, add) {
  const score = (row) =>
    Object.keys(row || {}).reduce((n, k) => n + (String(row[k] || '').trim() ? 1 : 0), 0);
  const index = new Map();
  into.forEach((row, i) => {
    const key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    index.set(key === '||' ? 'row-' + i : key, i);
  });
  for (const row of add || []) {
    if (!row || typeof row !== 'object') continue;
    let key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    if (key === '||' || !index.has(key)) {
      if (key === '||') key = 'row-' + into.length;
      index.set(key, into.length);
      into.push(row);
      continue;
    }
    const i = index.get(key);
    if (score(row) > score(into[i])) into[i] = row;
  }
  return into;
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
    let montagePending = true;
    if (typeof ctx.getCachedMontageGalleryFiles === 'function') {
      try {
        extraFiles = ctx.getCachedMontageGalleryFiles(fab) || [];
      } catch (_) {
        extraFiles = [];
      }
      montagePending =
        typeof ctx.hasMontageGalleryCache === 'function' ? !ctx.hasMontageGalleryCache(fab) : extraFiles.length === 0;
    } else if (typeof ctx.listMontageGalleryFiles === 'function') {
      try {
        extraFiles = ctx.listMontageGalleryFiles(fab) || [];
        montagePending = false;
      } catch (_) {
        extraFiles = [];
      }
    }
    const gallery = buildLocalAnlagenstammGallery(fab, tree, {
      technicianId: ctx.getTechnicianId(req),
      extraFiles,
    });
    try {
      console.log('[anlagenstamm_gallery]', fab, 'items=' + gallery.length, 'source=' + source);
    } catch (_) {}
    if (montagePending && typeof ctx.refreshMontageGalleryFiles === 'function') {
      setImmediate(() => {
        Promise.resolve()
          .then(() => ctx.refreshMontageGalleryFiles(fab))
          .catch(() => {});
      });
    }
    return res.json({ ok: true, gallery, source, montage_pending: !!montagePending });
  });

  app.get('/api/anlagenstamm_documents_list.php', async (req, res) => {
    const fab = String(req.query.fab || req.query.fabrikationsnummer || '').trim();
    if (!fab) return res.status(400).json({ ok: false, success: false, error: 'Fabrikationsnummer fehlt' });
    let local;
    try {
      local = buildLocalAnlagenstammDocumentsList(db(), fab);
    } catch (_) {
      local = {
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
    const technicianId = ctx.getTechnicianId ? ctx.getTechnicianId(req) : 0;
    let remote = null;
    try {
      remote = await fetchDispoApiDocumentsList(ctx, technicianId, fab);
    } catch (_) {
      remote = null;
    }
    if (
      !(remote && (remote.ok === true || remote.success === true) && Array.isArray(remote.categories)) &&
      typeof ctx.ensureProxyAuthenticated === 'function'
    ) {
      try {
        const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : null;
        const auth = await ctx.ensureProxyAuthenticated(creds);
        if (auth && auth.ok && auth.authenticated && auth.proxy && typeof auth.proxy.getJson === 'function') {
          const qs = new URLSearchParams({ fab }).toString();
          remote = await auth.proxy.getJson('/api/anlagenstamm_documents_list.php?' + qs);
        }
      } catch (_) {
        /* offline */
      }
    }
    if (remote && (remote.ok === true || remote.success === true) && Array.isArray(remote.categories)) {
      remote.source = remote.source || 'dispo_api';
      const merged = mergeRemoteDocumentsList(local, remote);
      try {
        const paramCat = (merged.categories || []).find((c) => c.slug === 'parameterliste');
        const n = paramCat && Array.isArray(paramCat.documents) ? paramCat.documents.length : 0;
        console.log('[anlagenstamm_documents]', fab, 'source=' + merged.source, 'param=' + n);
      } catch (_) {}
      return res.json(merged);
    }
    return res.json(local);
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

    const explicitPath = pathRel !== '';
    let mlRels = [];
    if (explicitPath) {
      mlRels = [pathRel];
    } else {
      const list = await fetchDispoApiFilesList(ctx, technicianId, fab);
      const tree =
        list && list.projekte_neu && Array.isArray(list.projekte_neu.tree) ? list.projekte_neu.tree : [];
      collectMlPdfRels(tree, mlRels);
      if (apiData && apiData.file) mlRels.push(String(apiData.file));
      mlRels = sortMlPdfRels(mlRels, fab).slice(0, 60);
    }
    let downloadPath = mlRels[0] || pathRel || String((apiData && apiData.file) || '').trim();
    const mergedMotors = [];
    const usedFiles = [];
    for (const rel of mlRels) {
      let parsed = null;
      if (typeof ctx.resolveProjekteNeuLocalFile === 'function') {
        try {
          const localPath = ctx.resolveProjekteNeuLocalFile(technicianId, fab, rel, jobId);
          if (localPath) parsed = await parseLocalMlPdfPath(localPath);
        } catch (_) {}
      }
      if (!parsed) {
        const buf = await downloadMlPdfViaSession(ctx, technicianId, fab, rel);
        if (buf) {
          try {
            parsed = await parseMlPdfBuffer(buf);
          } catch (_) {}
        }
      }
      const motors = parsed && Array.isArray(parsed.motors) ? parsed.motors : [];
      if (explicitPath) {
        const hit = parsed ? await parsedOk(parsed, rel, 'dispo_file') : null;
        if (hit) return res.json(hit);
      } else if (motors.length) {
        mergeMotorRows(mergedMotors, motors);
        usedFiles.push(rel);
      }
      downloadPath = rel;
    }
    if (!explicitPath && mergedMotors.length) {
      const label =
        usedFiles.length === 1
          ? usedFiles[0]
          : usedFiles.length + ' PDFs, u. a. ' + String(usedFiles[0] || '').split('/').pop();
      return res.json({
        ok: true,
        motors: mergedMotors,
        file: label,
        files: usedFiles,
        source: 'dispo_file',
      });
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

  /**
   * Parameter-PDF wie Protokolle/Parameterlisten (csv-to-pdf: PA-Ausdruck, PAL, DWC-7).
   */
  app.get('/api/anlagenstamm_parameter_pdf.php', async (req, res) => {
    const fab = normalizeFabDigits(String(req.query.fab || req.query.fabrikationsnummer || ''));
    const fileId = parseInt(req.query.file_id, 10);
    if (!fab || !Number.isFinite(fileId) || fileId <= 0) {
      return res.status(400).json({ ok: false, error: 'file_id und fab erforderlich' });
    }
    let source = readParameterSourceText(db(), fileId, fab);
    let filename = source && source.filename ? source.filename : 'Parameterliste.csv';
    let text = source && source.text ? String(source.text) : '';
    if (!text.trim()) {
      const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : {};
      const serverFileId =
        source && source.server_file_id && source.server_file_id > 0 ? source.server_file_id : fileId;
      try {
        const { proxyAnlagenstammParameterDownload } = require('./anlagenstamm-dispo-proxy');
        const remote = await proxyAnlagenstammParameterDownload(
          Object.assign({}, creds, {
            technician_id: ctx.getTechnicianId(req),
            fab,
            file_id: serverFileId,
          }),
        );
        if (remote && remote.ok && remote.buffer && remote.buffer.length) {
          text = decodeParameterFileBytes(remote.buffer);
          const remoteName = remote.xDownloadFilename || '';
          if (remoteName) {
            try {
              filename = decodeURIComponent(remoteName);
            } catch (_) {
              filename = remoteName;
            }
          }
        }
      } catch (e) {
        if (!text.trim()) {
          return res.status(502).json({
            ok: false,
            error: e && e.message ? e.message : 'Parameterdatei nicht ladbar.',
          });
        }
      }
    }
    if (!text.trim()) {
      return res.status(404).json({ ok: false, error: 'Kein Rohtext für PDF' });
    }
    try {
      const { csvToPdfBuffer } = require('./csv-to-pdf');
      const pdfBytes = await csvToPdfBuffer(text, { filename, sourcePath: filename });
      const outName = String(filename).replace(/\.(csv|txt|pa3|pa4|pa5|pa6|pa7|pal)$/i, '') + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="' + outName.replace(/"/g, '') + '"');
      return res.send(Buffer.from(pdfBytes));
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e && e.message ? e.message : 'Parameter-PDF fehlgeschlagen.',
      });
    }
  });

  /** Kompatibilität: alte List-Route delegiert. */
  app.get('/api/anlagenstamm/list', (req, res) => {
    const data = getAnlagenstammListResponse(db(), req.query);
    res.json(Object.assign({ ok: true }, data));
  });
}

module.exports = { registerAnlagenstammPhpRoutes };
