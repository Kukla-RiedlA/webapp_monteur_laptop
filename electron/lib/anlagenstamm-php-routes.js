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
const { buildDispoMonteurHeaders } = require('./dispo-monteur-headers');
const { getOrCreateDeviceId } = require('./device-id');
const { parseMlPdfBuffer, isMlPdfCandidate, mlPdfLangRank, mlPdfMatchRank, mlFabFit } = require('./anlagenstamm-ml-pdf');
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
  let authHeader;
  if (u && p) {
    authHeader = { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
  }
  const dbDir = ctx.dbDir || ctx.DB_DIR || '';
  const deviceId = dbDir ? getOrCreateDeviceId(dbDir) : undefined;
  return buildDispoMonteurHeaders({ technicianId, authHeader, deviceId });
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

function preferOwnMlRels(rels, fab) {
  const list = [...new Set((rels || []).filter(Boolean))];
  const own = list.filter((rel) => mlFabFit(rel, fab) === 0);
  if (own.length) return own;
  return list.filter((rel) => mlFabFit(rel, fab) === 2);
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

async function parseLocalMlPdfPath(filePath, fab) {
  try {
    const buf = fs.readFileSync(filePath);
    return await parseMlPdfBuffer(buf, fab);
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

  function extrasWithOffline(req, payload) {
    if (payload && typeof ctx.annotateTedByFab === 'function') {
      try {
        payload.ted_by_fab = ctx.annotateTedByFab(ctx.getTechnicianId(req), payload.ted_by_fab || {});
      } catch (_) {}
    }
    return payload;
  }

  app.get('/api/anlagenstamm_list_extras.php', (req, res) => {
    // Offline-first: TED/PN aus SQLite. is_offline prüft nur bekannte lokale Pfade.
    res.json(extrasWithOffline(req, getAnlagenstammExtrasResponse(db(), req.query || {})));
  });

  app.post('/api/anlagenstamm_list_extras.php', express.json({ limit: '4mb' }), (req, res) => {
    res.json(extrasWithOffline(req, getAnlagenstammExtrasResponse(db(), req.body || {})));
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

  async function loadProjekteNeuTree(req, fab) {
    const technicianId = ctx.getTechnicianId(req);
    if (typeof ctx.readAnlagenstammTreeCache === 'function') {
      const cached = ctx.readAnlagenstammTreeCache(db(), fab);
      if (cached && Array.isArray(cached.tree) && cached.tree.length) {
        return { tree: cached.tree, source: 'local_cache', technicianId };
      }
    }
    if (typeof ctx.buildLocalProjekteNeuTreeForFab === 'function') {
      const local = ctx.buildLocalProjekteNeuTreeForFab(technicianId, fab);
      if (local && Array.isArray(local.tree) && local.tree.length) {
        return { tree: local.tree, source: 'local_files', technicianId };
      }
    }
    const apiData = await fetchDispoApiFilesList(ctx, technicianId, fab);
    if (apiData && apiData.projekte_neu && Array.isArray(apiData.projekte_neu.tree)) {
      const apiTree = apiData.projekte_neu.tree;
      if (apiTree.length && typeof ctx.upsertAnlagenstammTreeCache === 'function') {
        try {
          ctx.upsertAnlagenstammTreeCache(db(), fab, apiData.projekte_neu);
          if (typeof ctx.saveDb === 'function') ctx.saveDb();
        } catch (_) {}
      }
      return { tree: apiTree, source: 'dispo_api', offline: false, technicianId };
    }
    if (typeof ctx.ensureProxyAuthenticated === 'function') {
      try {
        const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : null;
        const auth = await ctx.ensureProxyAuthenticated(creds);
        if (auth && auth.ok && auth.authenticated && auth.proxy && typeof auth.proxy.getJson === 'function') {
          const data = await auth.proxy.getJson(
            '/api/anlagenstamm_files_list.php?fab=' + encodeURIComponent(fab),
          );
          if (data && data.projekte_neu && Array.isArray(data.projekte_neu.tree)) {
            const tree = data.projekte_neu.tree;
            if (tree.length && typeof ctx.upsertAnlagenstammTreeCache === 'function') {
              try {
                ctx.upsertAnlagenstammTreeCache(db(), fab, data.projekte_neu);
                if (typeof ctx.saveDb === 'function') ctx.saveDb();
              } catch (_) {}
            }
            return { tree, source: 'dispo_online', offline: false, technicianId };
          }
        }
      } catch (_) {}
    }
    return { tree: [], source: 'local_cache_empty', offline: true, technicianId };
  }

  function loadGalleryTreeFromCache(req, fab) {
    const technicianId = ctx.getTechnicianId(req);
    if (typeof ctx.readAnlagenstammTreeCache === 'function') {
      const cached = ctx.readAnlagenstammTreeCache(db(), fab);
      if (cached && Array.isArray(cached.tree) && cached.tree.length) {
        return { tree: cached.tree, source: 'local_cache', offline: true, technicianId };
      }
    }
    return { tree: [], source: 'local_cache_empty', offline: true, technicianId };
  }

  app.get('/api/anlagenstamm_gallery.php', (req, res) => {
    const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ ok: false, error: 'Fabrikationsnummer fehlt' });
    const loaded = loadGalleryTreeFromCache(req, fab);
    const tree = loaded.tree || [];
    const source = loaded.source || 'local_cache_empty';
    let extraFiles = [];
    let montagePending = true;
    if (typeof ctx.getCachedMontageGalleryFiles === 'function') {
      try {
        extraFiles = ctx.getCachedMontageGalleryFiles(fab) || [];
      } catch (_) {
        extraFiles = [];
      }
      const cacheMissing =
        typeof ctx.hasMontageGalleryCache === 'function' ? !ctx.hasMontageGalleryCache(fab) : extraFiles.length === 0;
      const cacheStale =
        typeof ctx.isMontageGalleryCacheStale === 'function' && ctx.isMontageGalleryCacheStale(fab);
      montagePending = cacheMissing || cacheStale;
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
    return res.json({
      ok: true,
      gallery,
      source,
      offline: !!loaded.offline,
      montage_pending: !!montagePending,
    });
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
    try {
      const cat = (local.categories || []).find((c) => c && c.slug === 'technische_berechnung');
      const docs = cat && Array.isArray(cat.documents) ? cat.documents : [];
      if (docs.length && typeof ctx.annotateTedByFab === 'function') {
        const ted = docs.map((d) => ({
          rel_path: d.rel_path || d.file_path || '',
          file_name: d.display_name || d.original_name || '',
        }));
        const annotated = ctx.annotateTedByFab(ctx.getTechnicianId(req), { [fab]: ted }) || {};
        const marked = Array.isArray(annotated[fab]) ? annotated[fab] : [];
        for (let i = 0; i < docs.length; i++) {
          const flag = marked[i] && (marked[i].is_offline === true || marked[i].is_offline === 1);
          docs[i].is_offline = !!flag;
        }
      }
    } catch (_) {
      /* Status bleibt unbekannt */
    }
    return res.json(local);
  });

  app.get('/api/anlagenstamm_files_list.php', async (req, res) => {
    const fab = String(req.query.fabrikationsnummer || req.query.fab || '').trim();
    if (!fab) return res.status(400).json({ success: false, error: 'fab erforderlich' });
    const technicianId = ctx.getTechnicianId(req);
    const cacheOnly = String(req.query.cache_only || '') === '1';

    function filesListPayload(pnRaw, source) {
      let tree = (pnRaw && pnRaw.tree) || [];
      if (typeof ctx.annotateProjekteNeuTree === 'function') {
        try {
          tree = ctx.annotateProjekteNeuTree(technicianId, fab, tree);
        } catch (_) {}
      }
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

    if (typeof ctx.buildLocalProjekteNeuTreeForFab === 'function') {
      const local = ctx.buildLocalProjekteNeuTreeForFab(technicianId, fab);
      if (local && local.tree && local.tree.length) {
        return res.json(filesListPayload(local, local.source || 'local_scan'));
      }
    }

    return res.json(
      filesListPayload(
        { enabled: false, tree: [], root_name: '' },
        cacheOnly ? 'cache_miss' : 'local_empty',
      ),
    );
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

    if (pathRel && mlFabFit(pathRel, fab) === 3) {
      return res.json({
        ok: false,
        error: 'Diese Datei gehört zu einer anderen Fabrikationsnummer.',
        file: pathRel,
      });
    }

    // Nur eine angeklickte Motorliste (MOTORL.doc, Motorliste.pdf, …) festnageln.
    // Sonst den ganzen PROJEKTE-NEU-Baum dieser FN durchsuchen: die Liste liegt
    // mal im FN-Ordner, mal darunter in einem Bereichsordner wie 9499-9509/9500.
    const clickedName = pathRel.split(/[/\\]/).pop() || '';
    const motorPath = pathRel && isMlPdfCandidate(clickedName, pathRel) ? pathRel : '';

    if (motorPath && typeof ctx.resolveProjekteNeuLocalFile === 'function') {
      try {
        const localPath = ctx.resolveProjekteNeuLocalFile(technicianId, fab, motorPath, jobId);
        if (localPath) {
          const parsed = await parseLocalMlPdfPath(localPath, fab);
          const hit = await parsedOk(parsed, motorPath, 'local_file');
          if (hit) return res.json(hit);
        }
      } catch (_) {}
    }

    let apiData = await fetchDispoApiMlPdfPrefill(ctx, technicianId, fab, motorPath, debug);
    if (apiData && apiData.ok && Array.isArray(apiData.motors) && apiData.motors.length) {
      return res.json(Object.assign({ source: 'dispo_api' }, apiData));
    }

    const explicitPath = motorPath !== '';
    let mlRels = [];
    if (explicitPath) {
      mlRels = [motorPath];
    } else {
      const loaded = await loadProjekteNeuTree(req, fab);
      collectMlPdfRels(loaded && loaded.tree, mlRels);
      if (!mlRels.length) {
        const list = await fetchDispoApiFilesList(ctx, technicianId, fab);
        const tree =
          list && list.projekte_neu && Array.isArray(list.projekte_neu.tree) ? list.projekte_neu.tree : [];
        collectMlPdfRels(tree, mlRels);
      }
      if (apiData && apiData.file) mlRels.push(String(apiData.file));
      mlRels = preferOwnMlRels(sortMlPdfRels(mlRels, fab), fab).slice(0, 8);
      for (const rel of mlRels) {
        const one = await fetchDispoApiMlPdfPrefill(ctx, technicianId, fab, rel, debug);
        if (one && one.ok && Array.isArray(one.motors) && one.motors.length) {
          return res.json(Object.assign({ source: 'dispo_api', file: one.file || rel }, one));
        }
        if (one && (one.ok === true || one.ok === false)) apiData = one;
      }
    }
    let downloadPath = mlRels[0] || pathRel || String((apiData && apiData.file) || '').trim();
    const mergedMotors = [];
    const usedFiles = [];
    for (const rel of mlRels) {
      let parsed = null;
      if (typeof ctx.resolveProjekteNeuLocalFile === 'function') {
        try {
          const localPath = ctx.resolveProjekteNeuLocalFile(technicianId, fab, rel, jobId);
          if (localPath) parsed = await parseLocalMlPdfPath(localPath, fab);
        } catch (_) {}
      }
      if (!parsed) {
        const buf = await downloadMlPdfViaSession(ctx, technicianId, fab, rel);
        if (buf) {
          try {
            parsed = await parseMlPdfBuffer(buf, fab);
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
          : usedFiles.length + ' Dateien, u. a. ' + String(usedFiles[0] || '').split('/').pop();
      return res.json({
        ok: true,
        motors: mergedMotors,
        file: label,
        files: usedFiles,
        source: 'dispo_file',
      });
    }

    if (mlRels.length) {
      const named = mlRels[0];
      const serverError = apiData ? String(apiData.error || apiData.note || '').trim() : '';
      return res.json({
        ok: false,
        error: serverError || ('Motorliste gefunden (' + named + '), der Text konnte nicht gelesen werden.'),
        file: named,
        files: mlRels,
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
        if (motorPath) qs.set('path', motorPath);
        if (debug) qs.set('debug', '1');
        const data = await auth.proxy.getJson(`/api/anlagenstamm_ml_pdf_prefill.php?${qs.toString()}`);
        if (data && data.ok && Array.isArray(data.motors) && data.motors.length) {
          return res.json(Object.assign({ source: 'dispo_online' }, data));
        }
        if (data && typeof data === 'object') {
          const fileFromDispo = String((data && data.file) || downloadPath || '').trim();
          if (fileFromDispo && mlFabFit(fileFromDispo, fab) !== 3) {
            const buf = await downloadMlPdfViaSession(ctx, technicianId, fab, fileFromDispo);
            if (buf) {
              const parsed = await parseMlPdfBuffer(buf, fab);
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
   * Rohtext: lokale Datei, Einzelwerte, Monteur-Download, sonst Dispo-Session.
   */
  app.get('/api/anlagenstamm_parameter_pdf.php', async (req, res) => {
    const fab = normalizeFabDigits(String(req.query.fab || req.query.fabrikationsnummer || ''));
    const fileId = parseInt(req.query.file_id, 10);
    if (!fab || !Number.isFinite(fileId) || fileId <= 0) {
      return res.status(400).json({ ok: false, error: 'file_id und fab erforderlich' });
    }
    function textFromBuffer(buf) {
      if (!buf || !buf.length) return '';
      const head = buf.slice(0, 40).toString('utf8').trim();
      if (head.startsWith('{') || head.startsWith('<')) return '';
      return decodeParameterFileBytes(buf);
    }
    let source = readParameterSourceText(db(), fileId, fab);
    let filename = source && source.filename ? source.filename : 'Parameterliste.csv';
    let text = source && source.text ? String(source.text) : '';
    const serverFileId =
      source && source.server_file_id && source.server_file_id > 0 ? source.server_file_id : fileId;
    if (!text.trim()) {
      const rel = String((source && (source.source_path || source.storage_relpath)) || '').trim();
      if (rel && typeof ctx.resolveProjekteNeuLocalFile === 'function') {
        try {
          const localPath = ctx.resolveProjekteNeuLocalFile(ctx.getTechnicianId(req), fab, rel, 0);
          if (localPath && fs.existsSync(localPath)) text = textFromBuffer(fs.readFileSync(localPath));
        } catch (_) {}
      }
      if (!text.trim() && rel && ctx.dbDir) {
        try {
          const { readCachedProjekteNeuFile } = require('./projekte-neu-file-cache');
          const cached = readCachedProjekteNeuFile(ctx.dbDir, fab, rel);
          if (cached) text = textFromBuffer(fs.readFileSync(cached));
        } catch (_) {}
      }
    }
    let remoteError = '';
    if (!text.trim()) {
      const creds = ctx.resolveDispoServerCreds ? ctx.resolveDispoServerCreds({}) : {};
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
          text = textFromBuffer(remote.buffer);
          const remoteName = remote.xDownloadFilename || '';
          if (remoteName) {
            try {
              filename = decodeURIComponent(remoteName);
            } catch (_) {
              filename = remoteName;
            }
          }
        } else if (remote && remote.error) {
          remoteError = String(remote.error);
        }
      } catch (e) {
        remoteError = e && e.message ? e.message : 'Parameterdatei nicht ladbar.';
      }
    }
    if (!text.trim() && typeof ctx.tryProxyFetchDispoBinary === 'function') {
      try {
        const suffix =
          '/api/anlagenstamm_parameter_download.php?fab=' +
          encodeURIComponent(fab) +
          '&file_id=' +
          encodeURIComponent(String(serverFileId));
        const got = await ctx.tryProxyFetchDispoBinary(suffix);
        if (got && got.buf) text = textFromBuffer(got.buf);
      } catch (_) {}
    }
    if (!text.trim()) {
      return res.status(404).json({
        ok: false,
        error: remoteError || 'Kein Rohtext für PDF',
      });
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
