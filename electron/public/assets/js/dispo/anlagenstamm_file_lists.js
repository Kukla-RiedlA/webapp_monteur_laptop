/**
 * Gemeinsame Logik: Anlagenstamm-Dateiliste + PROJEKTE-NEU-Baum (Popup + Hauptseite).
 * Erwartet JSON von /api/anlagenstamm_files_list.php (success, files, projekte_neu).
 */
(function (global) {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      return new Date(ts * 1000).toLocaleDateString('de-AT');
    } catch (e) {
      return '';
    }
  }

  function fmtSize(n) {
    var v = Number(n || 0);
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function pnTreeHasFiles(nodes) {
    if (!nodes || !nodes.length) return false;
    var stack = [].concat(nodes);
    while (stack.length) {
      var n = stack.pop();
      if (!n) continue;
      var t = ((n.type || '') + '').toLowerCase();
      var children = Array.isArray(n.children) ? n.children : (Array.isArray(n.items) ? n.items : (Array.isArray(n.nodes) ? n.nodes : []));
      if (t === 'file') return true;
      if (children && children.length) {
        for (var i = 0; i < children.length; i++) stack.push(children[i]);
      }
    }
    return false;
  }

  function pnNormalizeType(n) {
    if (!n) return '';
    var t = ((n.type || n.kind || n.node_type || '') + '').toLowerCase();
    if (t === 'file') return 'file';
    if (t === 'dir' || t === 'folder' || t === 'directory') return 'dir';
    var children = Array.isArray(n.children) ? n.children : (Array.isArray(n.items) ? n.items : (Array.isArray(n.nodes) ? n.nodes : []));
    if (children.length > 0) return 'dir';
    if (n.rel || n.path || n.filename || n.file || n.basename) return 'file';
    return '';
  }

  function pnNodeChildren(n) {
    if (!n) return [];
    if (Array.isArray(n.children)) return n.children;
    if (Array.isArray(n.items)) return n.items;
    if (Array.isArray(n.nodes)) return n.nodes;
    return [];
  }

  function pnNodeName(n) {
    if (!n) return '';
    var name = n.name || n.label || n.basename || n.filename || n.file || '';
    if (name) return String(name);
    var p = String(n.rel || n.path || '');
    if (!p) return '';
    var segs = p.replace(/\\/g, '/').split('/');
    return segs[segs.length - 1] || p;
  }

  function pnParentHeadingForSiblings(nodes) {
    if (!nodes || !nodes.length) return '';
    return String(nodes[0].parent_name || nodes[0].parentName || '').trim();
  }

  function pnNormalizeTree(nodes) {
    if (!Array.isArray(nodes)) return [];
    return nodes.map(function (raw) {
      if (!raw) return null;
      var type = pnNormalizeType(raw);
      if (!type) return null;
      return {
        type: type,
        name: pnNodeName(raw),
        parent_name: String(raw.parent_name || raw.parentName || '').trim(),
        rel: String(raw.rel || raw.path || ''),
        size: Number(raw.size || raw.bytes || 0),
        mtime: Number(raw.mtime || raw.modified || raw.updated_at || 0),
        children: pnNormalizeTree(pnNodeChildren(raw))
      };
    }).filter(Boolean);
  }

  function pnExtractData(raw) {
    var pn = raw || {};
    var treeRaw = [];
    if (Array.isArray(raw)) treeRaw = raw;
    else if (Array.isArray(pn.tree)) treeRaw = pn.tree;
    else if (Array.isArray(pn.nodes)) treeRaw = pn.nodes;
    else if (Array.isArray(pn.items)) treeRaw = pn.items;
    else if (Array.isArray(pn.folders)) treeRaw = pn.folders;
    else if (pn.tree && typeof pn.tree === 'object') treeRaw = Object.values(pn.tree);
    var tree = pnNormalizeTree(treeRaw);
    var enabled = !!pn.enabled;
    if (!enabled && tree.length) enabled = true;
    return { enabled: enabled, tree: tree };
  }

  function pnDebugLog(scope, payload) {
    try {
      if (!window || !window.console || !window.console.log) return;
      var raw = payload || {};
      var txt = '';
      try { txt = JSON.stringify(raw); } catch (e) { txt = String(raw); }
      window.console.log('[PN-DEBUG][' + scope + '] ' + txt);
    } catch (e) {}
  }

  function pnRasterImageByNameForLists(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    var ext = m ? m[1] : '';
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0;
  }

  function pnEnsureProjekteNeuImageLightboxLists() {
    var id = 'kuklaPnImageLightbox';
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.className = 'kukla-pn-lightbox';
    el.style.display = 'none';
    el.innerHTML = '<div class="kukla-pn-lightbox-backdrop"></div><div class="kukla-pn-lightbox-inner"><button type="button" class="kukla-pn-lightbox-close" aria-label="Schließen">&times;</button><img class="kukla-pn-lightbox-img" alt="" /></div>';
    document.body.appendChild(el);
    var img = el.querySelector('.kukla-pn-lightbox-img');
    function closeLb() {
      el.style.display = 'none';
      if (img) img.removeAttribute('src');
    }
    el.querySelector('.kukla-pn-lightbox-backdrop').addEventListener('click', closeLb);
    el.querySelector('.kukla-pn-lightbox-close').addEventListener('click', closeLb);
    document.addEventListener('keydown', function (ev) {
      try {
        if (ev.key === 'Escape' && el.style.display === 'flex') closeLb();
      } catch (e) {}
    });
    return el;
  }

  function pnProjekteNeuDownloadQueryLists(fab, rel) {
    var q =
      'fabrikationsnummer=' +
      encodeURIComponent(fab) +
      '&fab=' +
      encodeURIComponent(fab) +
      '&source=projekte_neu&path=' +
      encodeURIComponent(rel);
    try {
      var tid = localStorage.getItem('monteur_technicianId');
      if (tid) q += '&technician_id=' + encodeURIComponent(String(tid));
    } catch (e) {}
    return q;
  }

  function pnBuildGalleryImagesForLists(fab, nodes) {
    if (!window.MonteurImageGallery) return [];
    return window.MonteurImageGallery.collectRasterFilesFromTree(nodes, function (_n, name, rel) {
      var hrefBase = '/api/anlagenstamm_file_download.php?' + pnProjekteNeuDownloadQueryLists(fab, rel);
      return {
        url: hrefBase + '&inline=1',
        thumbUrl: hrefBase + '&thumb=1&thumb_max=256',
        label: name || rel,
      };
    });
  }

  function pnOpenProjekteNeuImageLightboxLists(url, title, galleryImages, galleryIndex) {
    if (window.MonteurImageGallery && Array.isArray(galleryImages) && galleryImages.length) {
      window.MonteurImageGallery.open(galleryImages, galleryIndex != null ? galleryIndex : 0, {
        title: title,
        fallback: function (item) {
          pnOpenProjekteNeuImageLightboxListsSingle((item && item.url) || url, title);
        },
      });
      return;
    }
    pnOpenProjekteNeuImageLightboxListsSingle(url, title);
  }

  function pnOpenProjekteNeuImageLightboxListsSingle(url, title) {
    var el = pnEnsureProjekteNeuImageLightboxLists();
    var img = el.querySelector('.kukla-pn-lightbox-img');
    if (img) {
      img.alt = title || '';
      img.src = url;
    }
    el.style.display = 'flex';
  }

  function walkTreeUl(fab, nodes, depth, galleryImages) {
    depth = depth || 0;
    if (depth === 0 && !galleryImages) {
      galleryImages = pnBuildGalleryImagesForLists(fab, nodes);
    }
    nodes = nodes || [];
    var ul = document.createElement('ul');
    ul.className = 'anlagen-pn-tree-ul';
    nodes.forEach(function (n) {
      if (!n || !n.type) return;
      var li = document.createElement('li');
      if (n.type === 'dir') {
        var strong = document.createElement('strong');
        strong.className = 'anlagen-pn-dir';
        strong.textContent = n.name || '(Ordner)';
        li.appendChild(strong);
        if (n.children && n.children.length) {
          li.appendChild(walkTreeUl(fab, n.children, depth + 1, galleryImages));
        }
      } else if (n.type === 'file') {
        var rel = n.rel || '';
        var label = n.name || rel || '(Datei)';
        var hrefBase = '/api/anlagenstamm_file_download.php?' + pnProjekteNeuDownloadQueryLists(fab, rel);
        var wrap = document.createElement('div');
        wrap.className = 'anlagen-pn-file-row';
        if (pnRasterImageByNameForLists(label)) {
          var thumb = document.createElement('img');
          thumb.className = 'anlagen-pn-thumb';
          thumb.loading = 'lazy';
          thumb.alt = label;
          thumb.src = hrefBase + '&thumb=1&thumb_max=256';
          thumb.addEventListener('click', function () {
            var fullUrl = hrefBase + '&inline=1';
            var idx = 0;
            for (var gi = 0; gi < galleryImages.length; gi++) {
              if (galleryImages[gi].url === fullUrl || String(galleryImages[gi].label) === label) {
                idx = gi;
                break;
              }
            }
            pnOpenProjekteNeuImageLightboxLists(fullUrl, label, galleryImages, idx);
          });
          wrap.appendChild(thumb);
        } else {
          var ic = document.createElement('span');
          ic.className = 'anlagen-pn-file-icon';
          ic.setAttribute('aria-hidden', 'true');
          ic.textContent = '\uD83D\uDCC4';
          wrap.appendChild(ic);
        }
        var link = document.createElement('a');
        link.href = hrefBase;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = label;
        if (pnRasterImageByNameForLists(label)) {
          link.addEventListener('click', function (ev) {
            ev.preventDefault();
            var fullUrl = hrefBase + '&inline=1';
            var idx = 0;
            for (var gj = 0; gj < galleryImages.length; gj++) {
              if (galleryImages[gj].url === fullUrl || String(galleryImages[gj].label) === label) {
                idx = gj;
                break;
              }
            }
            pnOpenProjekteNeuImageLightboxLists(fullUrl, label, galleryImages, idx);
          });
        }
        wrap.appendChild(link);
        var meta = document.createElement('span');
        meta.className = 'muted anlagen-pn-meta';
        meta.textContent = ' · ' + fmtSize(n.size) + ' · ' + fmtDate(n.mtime);
        wrap.appendChild(meta);
        li.appendChild(wrap);
      }
      ul.appendChild(li);
    });
    if (depth === 0) {
      var htxt = pnParentHeadingForSiblings(nodes);
      if (htxt) {
        var block = document.createElement('div');
        block.className = 'anlagen-pn-tree-block';
        var head = document.createElement('div');
        head.className = 'anlagen-pn-parent-heading';
        head.textContent = htxt;
        block.appendChild(head);
        block.appendChild(ul);
        return block;
      }
    }
    return ul;
  }

  function renderProjekteNeu(fab, pn, treeEl, hintEl) {
    if (treeEl) treeEl.innerHTML = '';
    var pnData = pnExtractData(pn);
    if (hintEl) {
      hintEl.textContent = pnData.enabled
        ? ''
        : 'PROJEKTE NEU ist nicht konfiguriert oder es wurde kein passender Fabrikationsordner auf dem Mount gefunden.';
    }
    if (!treeEl || !pnData.enabled) return;
    var nodes = pnData.tree || [];
    if (!nodes.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.style.margin = '0';
      p.textContent = 'Keine Einträge in diesem Fabrikationsordner.';
      treeEl.appendChild(p);
      return;
    }
    treeEl.appendChild(walkTreeUl(fab, nodes));
  }

  /**
   * @param {string} fab
   * @param {*} data Antwort von anlagenstamm_files_list
   * @param {{listUl: ?HTMLElement, pnTree: ?HTMLElement, pnHint: ?HTMLElement}} els
   */
  function applyFilesListResponse(fab, data, els) {
    var listUl = els && els.listUl;
    var pnTree = els && els.pnTree;
    var pnHint = els && els.pnHint;
    if (!data || (data.success !== true && data.ok !== true)) {
      pnDebugLog('main-apply-skip', { fab: fab, success: data && data.success, ok: data && data.ok, has_data: !!data });
      return;
    }
    var base = '/api/anlagenstamm_file_download.php';
    if (listUl) {
      var files = data.files || [];
      listUl.innerHTML = files.length
        ? files.map(function (f) {
          return '<li><a href="' + base + '?fabrikationsnummer=' + encodeURIComponent(fab) +
            '&fab=' + encodeURIComponent(fab) +
            '&file=' + encodeURIComponent(f.name) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a></li>';
        }).join('')
        : '<li class="muted">Keine Dateien.</li>';
    }
    var pn = pnExtractData(data.projekte_neu);
    pnDebugLog('main-apply', {
      fab: fab,
      success: data.success,
      ok: data.ok,
      files_count: (data.files || []).length,
      pn_enabled: pn.enabled,
      pn_tree_count: pn.tree.length,
      pn_has_files: pnTreeHasFiles(pn.tree || [])
    });
    renderProjekteNeu(fab, pn, pnTree, pnHint);
  }

  /**
   * @param {string} fab
   * @param {{listUl: ?HTMLElement, pnTree: ?HTMLElement, pnHint: ?HTMLElement}} els
   */
  var fetchSeq = 0;

  function pnFetchJsonForList(url) {
    return fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'manual' })
      .then(function (r) {
        var st = r.status;
        if (st >= 300 && st < 400) {
          return { data: null, status: st, meta: { hint: 'http_redirect' } };
        }
        return r.text().then(function (txt) {
          var data = null;
          if (txt) {
            try {
              data = JSON.parse(txt);
            } catch (e) {
              return { data: null, status: st, meta: { hint: 'not_json', head: txt.slice(0, 200) } };
            }
          }
          if (!r.ok && !data) {
            return { data: null, status: st, meta: { hint: 'http_' + st, head: (txt || '').slice(0, 120) } };
          }
          return { data: data, status: st, meta: null };
        });
      });
  }

  function fetchAndApply(fab, els, opts) {
    opts = opts || {};
    var seq = Number(opts.seq || 0);
    var attempt = Number(opts.attempt || 0);
    var maxAttempts = Number(opts.maxAttempts || 3);
    var retryDelayMs = Number(opts.retryDelayMs || 700);
    var listUl = els && els.listUl;
    var pnTree = els && els.pnTree;
    var pnHint = els && els.pnHint;
    if (!fab) {
      if (listUl) {
        listUl.innerHTML = '<li class="muted">Fabrikationsnummer eintragen und speichern, dann Dateien hochladen.</li>';
      }
      renderProjekteNeu('', { enabled: false, tree: [] }, pnTree, pnHint);
      if (pnHint) pnHint.textContent = 'PROJEKTE NEU erscheint, sobald eine Fabrikationsnummer gesetzt ist.';
      return Promise.resolve();
    }
    if (!seq) {
      fetchSeq += 1;
      seq = fetchSeq;
    }
    var pageQs = '';
    try { pageQs = (window.location && window.location.search) ? window.location.search : ''; } catch (e) { pageQs = ''; }
    var debugPn = pageQs.indexOf('debugpn=1') >= 0;
    var url = '/api/anlagenstamm_files_list.php?fabrikationsnummer=' + encodeURIComponent(fab) + '&fab=' + encodeURIComponent(fab) + '&_ts=' + Date.now() + (debugPn ? '&debugpn=1' : '');
    return pnFetchJsonForList(url)
      .then(function (pack) {
        if (seq !== fetchSeq) return;
        var d = pack ? pack.data : null;
        if (pack && pack.meta && !d) {
          pnDebugLog('main-fetch-meta', { fab: fab, hint: pack.meta.hint, status: pack.status, head: pack.meta.head || null });
        }
        var okResp = !!(d && (d.success === true || d.ok === true));
        if (!okResp) {
          if (attempt < maxAttempts) {
            return new Promise(function (resolve) {
              window.setTimeout(function () {
                resolve(fetchAndApply(fab, els, {
                  seq: seq,
                  attempt: attempt + 1,
                  maxAttempts: maxAttempts,
                  retryDelayMs: retryDelayMs
                }));
              }, retryDelayMs);
            });
          }
          return;
        }
        applyFilesListResponse(fab, d, els);
        var pn = pnExtractData(d.projekte_neu);
        if (pn.enabled && !pnTreeHasFiles(pn.tree || []) && attempt < maxAttempts) {
          return new Promise(function (resolve) {
            window.setTimeout(function () {
              resolve(fetchAndApply(fab, els, {
                seq: seq,
                attempt: attempt + 1,
                maxAttempts: maxAttempts,
                retryDelayMs: retryDelayMs
              }));
            }, retryDelayMs);
          });
        }
      })
      .catch(function () {
        if (seq !== fetchSeq) return;
        if (attempt >= maxAttempts) return;
        return new Promise(function (resolve) {
          window.setTimeout(function () {
            resolve(fetchAndApply(fab, els, {
              seq: seq,
              attempt: attempt + 1,
              maxAttempts: maxAttempts,
              retryDelayMs: retryDelayMs
            }));
          }, retryDelayMs);
        });
      });
  }

  global.anlagenstammApplyFilesListResponse = applyFilesListResponse;
  global.anlagenstammFetchFilesPanels = fetchAndApply;
})(window);
