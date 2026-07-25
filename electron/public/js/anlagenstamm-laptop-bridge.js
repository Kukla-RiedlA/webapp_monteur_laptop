/**
 * Laptop-Brücke: TED offline öffnen, PROJEKTE NEU mit offline Struktur + hybriden Dateizugriff.
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';

  const pnExplorerState = {
    fab: '',
    jobId: null,
    tree: [],
    expanded: {},
    source: '',
  };
  const pnTreeCache = new Map();
  const pnTreeInflight = new Map();
  const pnPrefetchDone = new Set();

  function techHeaders(extra) {
    const h = Object.assign({}, extra || {});
    try {
      const tid = localStorage.getItem('monteur_technicianId');
      if (tid) h['X-Technician-Id'] = String(tid);
    } catch (_) { /* ignore */ }
    return h;
  }

  function getDispoCreds() {
    const out = { baseUrl: '', serverUsername: '', serverPassword: '' };
    try {
      if (typeof global.getDispoBaseUrl === 'function') out.baseUrl = global.getDispoBaseUrl() || '';
      if (typeof global.getDispoUsername === 'function') out.serverUsername = global.getDispoUsername() || '';
      if (typeof global.getDispoPassword === 'function') out.serverPassword = global.getDispoPassword() || '';
      if (!out.serverUsername && typeof global.getServerUsername === 'function') {
        out.serverUsername = global.getServerUsername() || '';
      }
      if (!out.serverPassword && typeof global.getServerPassword === 'function') {
        out.serverPassword = global.getServerPassword() || '';
      }
    } catch (_) { /* ignore */ }
    if (!out.baseUrl) {
      try { out.baseUrl = localStorage.getItem('monteur_serverUrl') || localStorage.getItem('monteur_dispoBaseUrl') || ''; } catch (_) { /* ignore */ }
    }
    if (!out.serverUsername) {
      try { out.serverUsername = (localStorage.getItem('monteur_serverUsername') || '').trim(); } catch (_) { /* ignore */ }
    }
    if (!out.serverPassword) {
      try { out.serverPassword = localStorage.getItem('monteur_serverPassword') || ''; } catch (_) { /* ignore */ }
    }
    return out;
  }

  function isRasterImage(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif'].includes(m ? m[1] : '');
  }

  function formatFileSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatFileDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bridgeToast(message) {
    showBridgeStatus(message);
    if (typeof global.showToast === 'function') {
      global.showToast(message);
      return;
    }
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText =
      'background:var(--card,#fff);border:1px solid var(--accent,#ccc);border-radius:8px;padding:0.75rem 1rem;margin-top:0.5rem;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      try { el.remove(); } catch (_) { /* ignore */ }
    }, 5000);
  }

  let bridgeStatusEl = null;

  function ensureBridgeStatusModal() {
    if (bridgeStatusEl) return bridgeStatusEl;
    const el = document.createElement('div');
    el.id = 'kuklaBridgeStatusModal';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-live', 'assertive');
    el.style.cssText =
      'position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';
    el.innerHTML =
      '<div class="kukla-bridge-status-box" style="background:var(--card,#fff);color:var(--text,#222);border:1px solid var(--accent,#6eb5ff);border-radius:10px;padding:1.25rem 1.5rem;min-width:300px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.35);text-align:center;">' +
      '<p class="kukla-bridge-status-text" style="margin:0 0 0.75rem;font-size:1rem;line-height:1.45;"></p>' +
      '<button type="button" class="btn btn-primary kukla-bridge-status-ok" style="display:none;min-width:5rem;">OK</button>' +
      '</div>';
    document.body.appendChild(el);
    const okBtn = el.querySelector('.kukla-bridge-status-ok');
    if (okBtn) {
      okBtn.addEventListener('click', () => hideBridgeStatus());
    }
    bridgeStatusEl = el;
    return el;
  }

  function showBridgeStatus(message, opts) {
    const el = ensureBridgeStatusModal();
    const text = el.querySelector('.kukla-bridge-status-text');
    const okBtn = el.querySelector('.kukla-bridge-status-ok');
    if (text) text.textContent = String(message || '');
    if (okBtn) okBtn.style.display = opts && opts.error ? 'inline-block' : 'none';
    el.style.display = 'flex';
  }

  function hideBridgeStatus() {
    if (bridgeStatusEl) bridgeStatusEl.style.display = 'none';
  }

  function showBridgeError(message) {
    showBridgeStatus(message, { error: true });
  }

  async function openLocalFilePath(filePath, opts) {
    const useExcel = !opts || opts.excel !== false;
    showBridgeStatus(useExcel ? 'Excel wird gestartet…' : 'Datei wird geöffnet…');
    const openFn =
      global.monteurApp &&
      (useExcel ? global.monteurApp.openExcel || global.monteurApp.openPath : global.monteurApp.openPath);
    if (!openFn) {
      showBridgeError('App-Bridge zum Öffnen nicht verfügbar.');
      throw new Error('App-Bridge zum Öffnen nicht verfügbar.');
    }
    const openRes = await openFn(String(filePath));
    hideBridgeStatus();
    if (openRes && openRes.error) {
      showBridgeError(openRes.error);
      throw new Error(openRes.error);
    }
  }

  function parseTedRelFromLine(link, line) {
    if (link && link.dataset.tedRelPath) return link.dataset.tedRelPath;
    const dl = line && line.querySelector('.ted-dl-link');
    const view = line && line.querySelector('.ted-view-link');
    if (dl && dl.dataset.tedRelPath) return dl.dataset.tedRelPath;
    if (view && view.dataset.tedRelPath) return view.dataset.tedRelPath;
    const sources = [
      dl && dl.getAttribute('href'),
      view && view.getAttribute('href'),
      link && link.getAttribute('href'),
      dl && dl.href,
      view && view.href,
      link && link.href,
    ];
    for (let i = 0; i < sources.length; i++) {
      const raw = sources[i];
      if (!raw || raw === '#') continue;
      try {
        const rel = new URL(raw, global.location.href).searchParams.get('rel_path');
        if (rel) return rel;
      } catch (_) { /* ignore */ }
      const m = String(raw).match(/[?&]rel_path=([^&]+)/);
      if (m && m[1]) {
        try {
          return decodeURIComponent(m[1]);
        } catch (_) {
          return m[1];
        }
      }
    }
    return '';
  }

  function stashTedRelOnLine(line) {
    if (!line || line.dataset.tedRelStashed === '1') return;
    const rel = parseTedRelFromLine(null, line);
    if (!rel) return;
    line.querySelectorAll('.ted-view-link, .ted-dl-link').forEach((a) => {
      a.dataset.tedRelPath = rel;
    });
    line.dataset.tedRelStashed = '1';
  }

  function pnNodeRelWithParent(n, parentRel) {
    const direct = String((n && (n.rel || n.path)) || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (direct) return direct;
    const name = pnNodeName(n);
    if (!name) return '';
    const parent = String(parentRel || '').replace(/\\/g, '/').replace(/\/$/, '');
    return parent ? parent + '/' + name : name;
  }

  function seedPnExpandedRoots(_tree) {
    return {};
  }

  function pnNodeChildren(n) {
    if (!n) return [];
    if (Array.isArray(n.children)) return n.children;
    if (Array.isArray(n.items)) return n.items;
    if (Array.isArray(n.nodes)) return n.nodes;
    return [];
  }

  function pnNodeType(n) {
    if (!n) return '';
    const t = String(n.type || n.kind || n.node_type || '').toLowerCase();
    if (t === 'file') return 'file';
    if (t === 'dir' || t === 'folder' || t === 'directory') return 'dir';
    return pnNodeChildren(n).length > 0 ? 'dir' : (n.rel || n.path ? 'file' : '');
  }

  function pnNodeName(n) {
    if (!n) return '';
    const name = n.name || n.label || n.basename || n.filename || n.file || '';
    if (name) return String(name);
    const p = String(n.rel || n.path || '');
    const segs = p.replace(/\\/g, '/').split('/');
    return segs[segs.length - 1] || p;
  }

  function pnNodeRel(n) {
    return String((n && (n.rel || n.path)) || '').replace(/\\/g, '/');
  }

  function pnNodeMtimeIso(n) {
    if (!n) return '';
    const raw = n.mtime_iso || n.modified_at || n.modified;
    if (raw) return String(raw);
    const m = n.mtime;
    if (typeof m === 'number' && m > 0) {
      const ms = m < 1e12 ? m * 1000 : m;
      return new Date(ms).toISOString();
    }
    return '';
  }

  async function resolveLocalJobForFab(fab) {
    const r = await fetch(
      api + '/api/anlagenstamm/projekte_neu_resolve_local?fab=' + encodeURIComponent(fab),
      { headers: techHeaders(), cache: 'no-store' },
    );
    const d = await r.json().catch(() => ({}));
    if (d && d.found && d.job_id) return Number(d.job_id);
    return null;
  }

  function pnTreeListUrl(fab, extraQs) {
    return (
      api +
      '/api/anlagenstamm_files_list.php?fabrikationsnummer=' +
      encodeURIComponent(fab) +
      '&fab=' +
      encodeURIComponent(fab) +
      (extraQs ? '&' + extraQs : '')
    );
  }

  function applyPnExplorerData(fab, data, target, modalParts) {
    const title = modalParts && modalParts.title;
    const hint = modalParts && modalParts.hint;
    const pn = (data && data.projekte_neu) || {};
    const tree = Array.isArray(pn.tree) ? pn.tree : [];
    const rootName = String(pn.root_name || '').trim();
    pnExplorerState.fab = fab;
    pnExplorerState.tree = tree;
    pnExplorerState.source = (data && data.source) || '';
    if (!pnExplorerState.expanded || typeof pnExplorerState.expanded !== 'object') {
      pnExplorerState.expanded = {};
    }
    if (title) title.textContent = 'PROJEKTE NEU · ' + fab;
    if (hint) {
      const srcLabel =
        data.source === 'local_cache' || data.source === 'local_scan'
          ? 'Struktur offline'
          : data.source === 'dispo_api' || data.source === 'dispo_online'
            ? 'Struktur aktualisiert (online)'
            : 'Struktur';
      hint.textContent = rootName ? srcLabel + ' · ' + rootName : srcLabel;
    }
    if (!target) return;
    if (!tree.length) {
      const offlineMiss =
        data.source === 'local_empty' || data.source === 'cache_miss'
          ? 'Ordnerstruktur noch nicht offline verfügbar. Bitte einmal online Anlagenstamm synchronisieren (lädt PROJEKTE-NEU-Bäume aus der Server-DB).'
          : pn.enabled === false
            ? 'PROJEKTE NEU ist für diese Fabrikationsnummer nicht verfügbar.'
            : 'Keine Einträge gefunden.';
      target.innerHTML = '<p class="muted" style="margin:0">' + offlineMiss + '</p>';
      return;
    }
    renderPnExplorerTree(target, fab);
  }

  function fetchPnTreeFromServer(fab, extraQs) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm) return Promise.resolve(null);
    const key = fabNorm + '|' + (extraQs || 'full');
    if (pnTreeInflight.has(key)) return pnTreeInflight.get(key);

    const isCacheOnly = extraQs && extraQs.indexOf('cache_only') >= 0;
    const creds = getDispoCreds();

    const p = (isCacheOnly
      ? fetch(pnTreeListUrl(fabNorm, extraQs), { headers: techHeaders(), cache: 'no-store' })
      : fetch(api + '/api/anlagenstamm_files_list', {
          method: 'POST',
          headers: techHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            baseUrl: creds.baseUrl,
            fab: fabNorm,
            serverUsername: creds.serverUsername,
            serverPassword: creds.serverPassword,
          }),
          cache: 'no-store',
        })
    )
      .then((r) => r.json().catch(() => null))
      .then((data) => {
        if (!data || (!data.success && !data.ok)) return null;
        const pn = (data && data.projekte_neu) || {};
        const hasTree = Array.isArray(pn.tree) && pn.tree.length > 0;
        if (!isCacheOnly && hasTree) {
          pnTreeCache.set(fabNorm, data);
        } else if (!isCacheOnly && !hasTree) {
          pnTreeCache.delete(fabNorm);
        }
        return data;
      })
      .finally(() => {
        pnTreeInflight.delete(key);
      });
    pnTreeInflight.set(key, p);
    return p;
  }

  function refreshPnTreeInBackground(fab, target, modalParts) {
    const fabNorm = String(fab || '').trim();
    if (!fabNorm) return;
    fetchPnTreeFromServer(fabNorm)
      .then((fresh) => {
        if (!fresh || pnExplorerState.fab !== fabNorm) return;
        let t = target;
        let parts = modalParts;
        if (!t) {
          const modal = document.getElementById('pnTreeModal');
          if (modal && modal.classList.contains('active')) {
            t = document.getElementById('pnTreeModalBody');
            parts = parts || {
              title: document.getElementById('pnTreeModalTitle'),
              hint: document.getElementById('pnTreeModalHint'),
            };
          }
        }
        if (t) applyPnExplorerData(fabNorm, fresh, t, parts);
      })
      .catch(() => {});
  }

  async function fetchPnTreeData(fab, opts) {
    opts = opts || {};
    const fabNorm = String(fab || '').trim();
    if (!fabNorm) return null;

    if (!opts.forceRefresh && pnTreeCache.has(fabNorm)) {
      const cached = pnTreeCache.get(fabNorm);
      refreshPnTreeInBackground(fabNorm);
      return cached;
    }

    const fast = await fetchPnTreeFromServer(fabNorm, 'cache_only=1');
    if (fast && fast.projekte_neu && fast.projekte_neu.tree && fast.projekte_neu.tree.length) {
      if (!opts.skipBackgroundRefresh) refreshPnTreeInBackground(fabNorm);
      return fast;
    }

    return fetchPnTreeFromServer(fabNorm);
  }

  function prefetchPnTree(fab) {
    const f = String(fab || '').trim();
    if (!f || pnPrefetchDone.has(f)) return;
    pnPrefetchDone.add(f);
    fetchPnTreeData(f).catch(() => {
      pnPrefetchDone.delete(f);
    });
  }

  function pnDownloadUrl(fab, relPath, extraQs) {
    let u =
      api +
      '/api/anlagenstamm_file_download.php?fabrikationsnummer=' +
      encodeURIComponent(fab) +
      '&fab=' +
      encodeURIComponent(fab) +
      '&source=projekte_neu&path=' +
      encodeURIComponent(relPath);
    try {
      const tid = localStorage.getItem('monteur_technicianId');
      if (tid) u += '&technician_id=' + encodeURIComponent(String(tid));
    } catch (_) { /* ignore */ }
    if (pnExplorerState.jobId) {
      u += '&job_id=' + encodeURIComponent(String(pnExplorerState.jobId));
    }
    if (extraQs) u += '&' + extraQs;
    return u;
  }

  function collectPnGalleryImages(fab) {
    if (!global.MonteurImageGallery) return [];
    return global.MonteurImageGallery.collectRasterFilesFromTree(pnExplorerState.tree, function (_n, name, rel) {
      return {
        url: pnDownloadUrl(fab, rel, 'inline=1'),
        thumbUrl: pnDownloadUrl(fab, rel, 'thumb=1&thumb_max=256'),
        label: name || rel,
      };
    });
  }

  function openPnImageGallery(fab, relPath, fileName) {
    const gallery = collectPnGalleryImages(fab);
    const label = fileName || relPath.split('/').pop() || 'Bild';
    let idx = 0;
    for (let i = 0; i < gallery.length; i++) {
      if (
        gallery[i].label === label ||
        String(gallery[i].url || '').indexOf(encodeURIComponent(relPath)) >= 0
      ) {
        idx = i;
        break;
      }
    }
    if (global.MonteurImageGallery) {
      return global.MonteurImageGallery.open(gallery, idx, {
        title: label,
        fallback: function () {
          return openPnFileExternal(fab, relPath);
        },
      });
    }
    return openPnFileExternal(fab, relPath);
  }

  function loadPnThumb(img, fab, relPath) {
    if (!img || !fab || !relPath) return;
    img.loading = 'lazy';
    img.src = pnDownloadUrl(fab, relPath, 'thumb=1&thumb_max=256');
    img.onerror = function () {
      img.onerror = null;
      fetch(pnDownloadUrl(fab, relPath, 'thumb=1&thumb_max=256'), { headers: techHeaders() })
        .then((r) => {
          if (!r.ok) throw new Error('thumb');
          return r.blob();
        })
        .then((blob) => {
          if (!img.parentNode) return;
          const prev = img.getAttribute('data-blob-url');
          if (prev) {
            try { URL.revokeObjectURL(prev); } catch (_) { /* ignore */ }
          }
          const objUrl = URL.createObjectURL(blob);
          img.setAttribute('data-blob-url', objUrl);
          img.src = objUrl;
        })
        .catch(() => {
          if (!img.parentNode) return;
          const ic = document.createElement('span');
          ic.className = 'icon';
          ic.textContent = '\uD83D\uDCC4';
          img.replaceWith(ic);
        });
    };
  }

  async function openPnFileExternal(fab, relPath) {
    const localPath = await resolvePnLocalPath(fab, relPath);
    await openLocalFilePath(localPath, { excel: false });
    return { ok: true, path: localPath };
  }

  async function resolvePnLocalPath(fab, relPath) {
    if (!relPath) throw new Error('Dateipfad fehlt.');
    const creds = getDispoCreds();

    showBridgeStatus('Datei wird geladen…');

    const r = await fetch(api + '/api/anlagenstamm_file_open', {
      method: 'POST',
      headers: techHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        baseUrl: creds.baseUrl,
        fab: fab,
        source: 'projekte_neu',
        path: relPath,
        job_id: pnExplorerState.jobId || undefined,
        fallbackName: relPath.split('/').pop() || 'download',
        serverUsername: creds.serverUsername,
        serverPassword: creds.serverPassword,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok || !d.path) {
      const err = d.error || 'Datei konnte nicht geladen werden';
      showBridgeError(err);
      throw new Error(err);
    }
    hideBridgeStatus();
    return d.path;
  }

  async function openPnFile(fab, relPath) {
    const fileName = relPath.split('/').pop() || '';
    if (isRasterImage(fileName)) {
      return openPnImageGallery(fab, relPath, fileName);
    }
    return openPnFileExternal(fab, relPath);
  }

  async function showPnFileContextMenu(fab, relPath, fileName) {
    if (!global.monteurApp || typeof global.monteurApp.showFileContextMenu !== 'function') return;
    const localPath = await resolvePnLocalPath(fab, relPath);
    await global.monteurApp.showFileContextMenu({
      localPath: localPath,
      fileName: fileName || relPath.split('/').pop() || 'Datei',
    });
  }

  function collectPnExplorerRows(nodes, level, parentRel) {
    const rows = [];
    const expanded = pnExplorerState.expanded;
    function walk(list, lvl, parentPath) {
      if (!Array.isArray(list)) return;
      list.forEach((node) => {
        const nodeType = pnNodeType(node);
        if (!nodeType) return;
        const rel = pnNodeRelWithParent(node, parentPath);
        const isDir = nodeType === 'dir';
        rows.push({
          level: lvl,
          name: pnNodeName(node),
          rel: rel,
          isDir: isDir,
          size: isDir ? null : (node.size != null ? node.size : ''),
          mtime: pnNodeMtimeIso(node),
        });
        if (isDir && rel && expanded[rel]) {
          walk(pnNodeChildren(node), lvl + 1, rel);
        }
      });
    }
    walk(nodes, level || 0, parentRel || '');
    return rows;
  }

  function renderPnExplorerTree(target, fab) {
    const rows = collectPnExplorerRows(pnExplorerState.tree, 0);
    const expanded = pnExplorerState.expanded;

    if (!rows.length) {
      target.innerHTML = '<p class="muted" style="margin:0">Keine Einträge im PROJEKTE-NEU-Baum.</p>';
      return;
    }

    let html = '<div class="dienstreise-explorer-list anlagen-pn-explorer-list">';
    rows.forEach((r) => {
      const levelClass = r.level > 0 ? ' level-' + Math.min(r.level, 6) : '';
      const toggle = r.isDir
        ? '<span class="explorer-toggle" data-pn-toggle aria-hidden="true">' +
          (expanded[r.rel] ? '\u25BC' : '\u25B6') +
          '</span>'
        : '<span class="explorer-toggle empty"></span>';
      const isImg = !r.isDir && isRasterImage(r.name);
      const nameVisual = isImg
        ? '<img class="dienstreise-explorer-thumb" data-pn-thumb alt="" />'
        : typeof window.windowsStyleFsIconHtml === 'function'
          ? window.windowsStyleFsIconHtml(r.name, !!r.isDir)
          : '<span class="fs-icon fs-icon-' + (r.isDir ? 'folder' : 'generic') + '" aria-hidden="true"></span>';
      html +=
        '<div class="dienstreise-explorer-row' +
        levelClass +
        '" data-is-dir="' +
        (r.isDir ? '1' : '0') +
        '" data-relative-path="' +
        escapeHtml(r.rel) +
        '">' +
        '<div class="dienstreise-explorer-name">' +
        toggle +
        nameVisual +
        ' <span class="dienstreise-explorer-filename">' +
        escapeHtml(r.name) +
        '</span></div>' +
        '<div class="dienstreise-explorer-size">' +
        escapeHtml(r.isDir ? '' : formatFileSize(r.size)) +
        '</div>' +
        '<div class="dienstreise-explorer-size">' +
        escapeHtml(formatFileDate(r.mtime)) +
        '</div>' +
        '<div class="dienstreise-explorer-actions">' +
        (r.isDir
          ? ''
          : (isImg
            ? '<button type="button" class="btn btn-ghost" data-pn-preview title="Bild in der App anzeigen">Vorschau</button>'
            : '') +
            '<button type="button" class="btn btn-ghost" data-pn-open title="Mit Standardprogramm öffnen">Öffnen</button>') +
        '</div></div>';
    });
    html += '</div>';
    target.innerHTML = html;

    target.querySelectorAll('[data-pn-thumb]').forEach((img) => {
      const row = img.closest('.dienstreise-explorer-row');
      const rel = row && row.getAttribute('data-relative-path');
      if (rel && !img.getAttribute('data-pn-thumb-loaded')) {
        img.setAttribute('data-pn-thumb-loaded', '1');
        loadPnThumb(img, fab, rel);
      }
      img.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!rel) return;
        const fileNameEl = row && row.querySelector('.dienstreise-explorer-filename');
        openPnImageGallery(fab, rel, fileNameEl ? fileNameEl.textContent.trim() : '').catch((e) => {
          if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
            showBridgeError(e && e.message ? e.message : String(e));
          }
        });
      });
    });

    target.querySelectorAll('[data-pn-preview]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const row = btn.closest('.dienstreise-explorer-row');
        const rel = row && row.getAttribute('data-relative-path');
        if (!rel) return;
        const fileNameEl = row && row.querySelector('.dienstreise-explorer-filename');
        openPnImageGallery(fab, rel, fileNameEl ? fileNameEl.textContent.trim() : '').catch((e) => {
          if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
            showBridgeError(e && e.message ? e.message : String(e));
          }
        });
      });
    });

    target.querySelectorAll('[data-pn-open]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const row = btn.closest('.dienstreise-explorer-row');
        const rel = row && row.getAttribute('data-relative-path');
        if (!rel) return;
        openPnFileExternal(fab, rel).catch((e) => {
          if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
            showBridgeError(e && e.message ? e.message : String(e));
          }
        });
      });
    });

    target.querySelectorAll('.dienstreise-explorer-row[data-is-dir="0"]').forEach((row) => {
      const rel = row.getAttribute('data-relative-path') || '';
      const fileNameEl = row.querySelector('.dienstreise-explorer-filename');
      const fileName = (fileNameEl && fileNameEl.textContent.trim()) || rel.split('/').pop() || '';
      const isImg = isRasterImage(fileName);
      row.style.cursor = 'pointer';
      row.setAttribute('title', isImg ? 'Bild in der App anzeigen' : 'Datei öffnen');
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (ev.target.closest('[data-pn-open]')) return;
        if (ev.target.closest('[data-pn-preview]')) return;
        if (ev.target.closest('[data-pn-thumb]')) return;
        if (!rel) return;
        if (isImg) {
          openPnImageGallery(fab, rel, fileName).catch((e) => {
            if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
              showBridgeError(e && e.message ? e.message : String(e));
            }
          });
          return;
        }
        openPnFileExternal(fab, rel).catch((e) => {
          if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
            showBridgeError(e && e.message ? e.message : String(e));
          }
        });
      });
      row.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (!global.monteurApp || typeof global.monteurApp.showFileContextMenu !== 'function') return;
        ev.preventDefault();
        const rel = row.getAttribute('data-relative-path');
        if (!rel) return;
        const fileNameEl = row.querySelector('.dienstreise-explorer-filename');
        const fileName = (fileNameEl && fileNameEl.textContent.trim()) || rel.split('/').pop() || 'Datei';
        showPnFileContextMenu(fab, rel, fileName).catch((e) => {
          if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
            showBridgeError(e && e.message ? e.message : String(e));
          }
        });
      });
    });

    target.querySelectorAll('.dienstreise-explorer-row[data-is-dir="1"]').forEach((row) => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (ev.target.closest('[data-pn-thumb]')) return;
        const rel = row.getAttribute('data-relative-path');
        if (!rel) return;
        if (expanded[rel]) delete expanded[rel];
        else expanded[rel] = true;
        renderPnExplorerTree(target, fab);
      });
    });
  }

  async function mountPnExplorer(fab, target, modalParts) {
    const title = modalParts && modalParts.title;
    const hint = modalParts && modalParts.hint;
    if (title) title.textContent = 'PROJEKTE NEU · ' + fab;
    if (hint) hint.textContent = 'Lade Ordnerstruktur…';

    const cached = pnTreeCache.get(fab);
    if (cached && cached.projekte_neu && cached.projekte_neu.tree && cached.projekte_neu.tree.length) {
      applyPnExplorerData(fab, cached, target, modalParts);
    } else if (target) {
      target.innerHTML = '<p class="muted" style="margin:0">Lade…</p>';
    }

    pnExplorerState.expanded = {};
    resolveLocalJobForFab(fab).then((jobId) => {
      pnExplorerState.jobId = jobId;
    });

    const data = await fetchPnTreeData(fab);
    if (!data) {
      if (hint) hint.textContent = 'Struktur nicht verfügbar.';
      if (target && !(cached && cached.projekte_neu && cached.projekte_neu.tree && cached.projekte_neu.tree.length)) {
        target.innerHTML = '<p class="muted" style="margin:0">Bitte Anlagenstamm synchronisieren oder online verbinden.</p>';
      }
      return;
    }
    applyPnExplorerData(fab, data, target, modalParts);
  }

  async function openPnProjectExplorer(fab) {
    const modal = document.getElementById('pnTreeModal');
    const body = document.getElementById('pnTreeModalBody');
    const title = document.getElementById('pnTreeModalTitle');
    const hint = document.getElementById('pnTreeModalHint');
    if (!modal || !body || !title) return;
    modal.classList.add('active');
    await mountPnExplorer(fab, body, { title: title, hint: hint });
  }

  function renderPnTree(fab, nodes, target) {
    if (!target) return;
    if (Array.isArray(nodes) && nodes.length) {
      pnExplorerState.fab = fab;
      pnExplorerState.tree = nodes;
      pnExplorerState.expanded = {};
      resolveLocalJobForFab(fab).then((jobId) => {
        pnExplorerState.jobId = jobId;
        renderPnExplorerTree(target, fab);
      });
      return;
    }
    target.innerHTML = '<p class="muted" style="margin:0">Lade PROJEKTE NEU…</p>';
    mountPnExplorer(fab, target, null).catch(() => {
      target.innerHTML = '<p class="muted" style="margin:0">Laden fehlgeschlagen.</p>';
    });
  }

  async function openTedExcel(rel, fab, fileName) {
    const relPath = String(rel || '').trim();
    if (!relPath) {
      showBridgeError('TED-Datei: Pfad (rel_path) fehlt.');
      throw new Error('TED-Datei: Pfad (rel_path) fehlt.');
    }

    const creds = getDispoCreds();
    showBridgeStatus('Datei wird geladen…');

    const r = await fetch(api + '/api/mechanik_ted_excel_open', {
      method: 'POST',
      headers: techHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        baseUrl: creds.baseUrl,
        rel_path: relPath,
        fab: fab,
        file_name: fileName,
        serverUsername: creds.serverUsername,
        serverPassword: creds.serverPassword,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok || !d.path) {
      let err = d.error || 'TED-Datei konnte nicht geöffnet werden';
      if (/not logged in/i.test(String(err))) {
        err =
          'Server-Zugang für Datei-Download fehlgeschlagen. Anlagenstamm-Anzeige kommt aus dem lokalen Cache — bitte unter Einstellungen Passwort speichern oder Sync ausführen.';
      }
      showBridgeError(err);
      throw new Error(err);
    }
    await openLocalFilePath(d.path, { excel: true });
    return d;
  }

  function handleTedLinkClick(link) {
    const line = link.closest('.ted-excel-line');
    const rel = parseTedRelFromLine(link, line);
    const fab =
      (link.closest('tr') && link.closest('tr').getAttribute('data-fab')) ||
      (link.closest('tr') &&
        link.closest('tr').querySelector('.pn-root-link') &&
        link.closest('tr').querySelector('.pn-root-link').getAttribute('data-fab')) ||
      '';
    const viewLink = line && line.querySelector('.ted-view-link');
    const fileName = ((viewLink && viewLink.textContent) || link.textContent || '').trim();
    const loadingEl = viewLink || link;
    loadingEl.classList.add('ted-excel-loading');
    openTedExcel(rel, fab, fileName)
      .catch((err) => {
        if (!bridgeStatusEl || bridgeStatusEl.style.display === 'none') {
          showBridgeError(err && err.message ? err.message : String(err));
        }
      })
      .finally(() => {
        loadingEl.classList.remove('ted-excel-loading');
      });
  }

  function bindTedLinks(root) {
    if (!root) return;
    root.querySelectorAll('.ted-excel-line').forEach((line) => stashTedRelOnLine(line));
    root.querySelectorAll('.ted-view-link, .ted-dl-link').forEach((link) => {
      const line = link.closest('.ted-excel-line');
      if (line) stashTedRelOnLine(line);
      link.removeAttribute('target');
      link.style.cursor = 'pointer';
      if (link.getAttribute('href') !== '#') link.setAttribute('href', '#');
    });
  }

  function setupTedLinks() {
    if (global.__anlagenstammTedLinksBound) return;
    global.__anlagenstammTedLinksBound = true;
    document.addEventListener(
      'click',
      (e) => {
        const link = e.target.closest('.ted-view-link, .ted-dl-link');
        if (!link) return;
        const host = document.getElementById('anlagenstamm-host');
        if (!host || !host.contains(link)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        handleTedLinkClick(link);
      },
      true,
    );
  }

  function setupPnRootLinks() {
    document.addEventListener(
      'mouseover',
      (e) => {
        const link = e.target.closest('.pn-root-link');
        if (!link) return;
        const host = document.getElementById('anlagenstamm-host');
        if (host && !host.contains(link)) return;
        const fab = (link.getAttribute('data-fab') || '').trim();
        if (fab) prefetchPnTree(fab);
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        const link = e.target.closest('.pn-root-link');
        if (!link) return;
        const host = document.getElementById('anlagenstamm-host');
        if (host && !host.contains(link)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const fab = (link.getAttribute('data-fab') || '').trim();
        if (!fab) return;
        openPnProjectExplorer(fab).catch((err) => {
          alert(err && err.message ? err.message : String(err));
        });
      },
      true,
    );
  }

  function onAnlagenstammDataSynced() {
    pnTreeCache.clear();
    pnPrefetchDone.clear();
    if (typeof global.loadList === 'function' && document.getElementById('tableBody')) {
      try { global.loadList(); } catch (_) { /* ignore */ }
    }
  }

  const observer = new MutationObserver(() => {
    bindTedLinks(document.getElementById('anlagenstamm-host') || document.body);
  });

  global.monteurAnlagenstammBridge = {
    bindTedLinks,
    renderPnTree,
    openPnProjectExplorer,
    init() {
      const host = document.getElementById('anlagenstamm-host');
      if (host) observer.observe(host, { childList: true, subtree: true });
      bindTedLinks(host || document.body);
      setupPnRootLinks();
      setupTedLinks();
      global.dispoDesktopAnlagenstamm = global.dispoDesktopAnlagenstamm || {};
      global.dispoDesktopAnlagenstamm.renderPnTree = renderPnTree;
      global.dispoDesktopAnlagenstamm.bindTedLinks = bindTedLinks;
      if (!global.__anlagenstammSyncedBound) {
        global.__anlagenstammSyncedBound = true;
        document.addEventListener('anlagenstamm-data-synced', onAnlagenstammDataSynced);
      }
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => global.monteurAnlagenstammBridge.init());
  } else {
    global.monteurAnlagenstammBridge.init();
  }
})(window);
