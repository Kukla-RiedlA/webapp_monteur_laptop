/**
 * Anlagenakte: Tabs, Galerie, Dokument-Viewer (JSON/CSV), PDF on-demand.
 */
(function () {
  'use strict';

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function activateTab(id) {
    qsa('.akte-tab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-akte-tab') === id);
    });
    qsa('.akte-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.getAttribute('data-akte-panel') === id);
    });
  }

  function bindTabs() {
    qsa('.akte-tab').forEach(function (btn) {
      if (btn.getAttribute('data-akte-bound') === '1') return;
      btn.setAttribute('data-akte-bound', '1');
      btn.addEventListener('click', function () {
        activateTab(btn.getAttribute('data-akte-tab') || 'overview');
      });
    });
  }

  function closeViewer() {
    var el = document.getElementById('akteViewer');
    if (el) el.remove();
  }

  function openViewer(title, html) {
    closeViewer();
    var wrap = document.createElement('div');
    wrap.id = 'akteViewer';
    wrap.className = 'akte-viewer';
    wrap.innerHTML = '<div class="akte-viewer-box"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:10px"><strong>' +
      esc(title) + '</strong><button type="button" class="btn btn-secondary" id="akteViewerClose">Schließen</button></div>' + html + '</div>';
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) closeViewer();
    });
    document.body.appendChild(wrap);
    var c = document.getElementById('akteViewerClose');
    if (c) c.addEventListener('click', closeViewer);
  }

  function apiPrefix() {
    return (window.KUKLA_ANLAGENAKTE_API_PREFIX || '/api').replace(/\/$/, '');
  }

  function endpoint(name, query) {
    var url = apiPrefix() + '/' + String(name || '').replace(/^\//, '');
    if (query) url += (url.indexOf('?') >= 0 ? '&' : '?') + query;
    return url;
  }

  function jsonGet(url) {
    if (window.PwaApi && typeof window.PwaApi.getJson === 'function') {
      return window.PwaApi.getJson(url);
    }
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }

  var lastGalleryFab = null;
  function loadGallery() {
    var root = document.getElementById('akteGalleryRoot');
    var fabEl = document.getElementById('formFab');
    if (!root || !fabEl) return;
    var fab = (fabEl.value || '').trim();
    if (fab === lastGalleryFab && root.getAttribute('data-loaded') === '1') return;
    lastGalleryFab = fab;
    if (!fab) {
      root.innerHTML = '<p class="muted">Keine Fabrikationsnummer.</p>';
      root.removeAttribute('data-loaded');
      return;
    }
    root.innerHTML = '<p class="muted">Lade Galerie…</p>';
    var url = window.KUKLA_ANLAGENAKTE_GALLERY_URL
      ? (window.KUKLA_ANLAGENAKTE_GALLERY_URL + (window.KUKLA_ANLAGENAKTE_GALLERY_URL.indexOf('?') >= 0 ? '&' : '?') + 'fab=' + encodeURIComponent(fab))
      : endpoint('anlagenstamm_gallery.php', 'fab=' + encodeURIComponent(fab));
    jsonGet(url)
      .then(function (d) {
        var items = (d && d.gallery) || [];
        if (!items.length) {
          root.innerHTML = '<p class="muted">Keine Bilder in der Akte. Weitere Rasterdateien stehen unter Dateien (PROJEKTE NEU).</p>';
          root.setAttribute('data-loaded', '1');
          return;
        }
        var groups = [];
        var byFolder = {};
        items.forEach(function (it, idx) {
          it._idx = idx;
          var folder = String(it.parent_folder || '').trim() || 'Bilder';
          if (!byFolder[folder]) {
            byFolder[folder] = [];
            groups.push(folder);
          }
          byFolder[folder].push(it);
        });
        var html = '';
        groups.forEach(function (folder) {
          html += '<div class="akte-gallery-group"><h3>' + esc(folder) + '</h3><div class="akte-gallery-grid">';
          byFolder[folder].forEach(function (it) {
            html += '<figure class="akte-gallery-item" data-idx="' + it._idx + '"><img src="' + esc(it.thumb_url || it.full_url || '') +
              '" alt=""><figcaption>' + esc(it.title || '') + '</figcaption></figure>';
          });
          html += '</div></div>';
        });
        root.innerHTML = html;
        root.setAttribute('data-loaded', '1');
        qsa('.akte-gallery-item', root).forEach(function (fig) {
          fig.addEventListener('click', function () {
            var i = parseInt(fig.getAttribute('data-idx') || '0', 10);
            var it = items[i];
            if (!it) return;
            if (window.KuklaImageGallery && typeof window.KuklaImageGallery.open === 'function') {
              var gal = items.map(function (g) {
                return { title: g.title, src: g.full_url };
              });
              window.KuklaImageGallery.open({ items: gal, startIndex: i });
              return;
            }
            openViewer(it.title || 'Bild', '<img src="' + esc(it.full_url) + '" alt="" style="max-width:100%;height:auto">');
          });
        });
      })
      .catch(function () {
        root.innerHTML = '<p class="muted">Galerie konnte nicht geladen werden.</p>';
      });
  }

  window.kuklaAkteOpenProtocolView = function (table, id, extra) {
    extra = extra || {};
    var q = [];
    if (extra.document_id) q.push('document_id=' + encodeURIComponent(String(extra.document_id)));
    if (table) q.push('table=' + encodeURIComponent(table));
    if (id) q.push('id=' + encodeURIComponent(String(id)));
    var url = endpoint('anlagenstamm_protocol_view.php', q.join('&'));
    jsonGet(url)
      .then(function (d) {
        if (!d || !d.ok) {
          alert((d && d.error) || 'Anzeige fehlgeschlagen');
          return;
        }
        var slug = d.form_slug || d.table || table || '';
        var title = (window.kuklaAkteFormViewer && window.kuklaAkteFormViewer.titleForSlug)
          ? window.kuklaAkteFormViewer.titleForSlug(slug, d.table)
          : 'Protokoll';
        var html;
        if (window.kuklaAkteFormViewer && typeof window.kuklaAkteFormViewer.render === 'function') {
          html = window.kuklaAkteFormViewer.render(d.payload || d, slug, d.table);
        } else {
          html = '<pre>' + esc(JSON.stringify(d.payload || d, null, 2)) + '</pre>';
        }
        openViewer(title, html);
      })
      .catch(function (e) { alert(e.message || 'Fehler'); });
  };

  window.kuklaAkteOpenParameterView = function (fab, fileId) {
    var url = endpoint('anlagenstamm_parameter_view.php', 'fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId)));
    jsonGet(url)
      .then(function (d) {
        if (!d || !d.ok) {
          alert((d && d.error) || 'Anzeige fehlgeschlagen');
          return;
        }
        var raw = d.raw_content || '';
        var html = raw ? '<pre>' + esc(raw) + '</pre>' : '<pre>' + esc(JSON.stringify(d.entries || [], null, 2)) + '</pre>';
        openViewer('Parameterliste', html);
      })
      .catch(function (e) { alert(e.message || 'Fehler'); });
  };

  window.kuklaAktePdfUrl = function (kind, params) {
    var q = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]));
    }).join('&');
    if (kind === 'parameter') return endpoint('anlagenstamm_parameter_pdf.php', q);
    return endpoint('anlagenstamm_protocol_pdf.php', q);
  };

  function syncTitle() {
    var fab = qs('#formFab');
    var t = qs('#akteTopbarFn');
    if (fab && t) t.textContent = fab.value || 'Neue Anlage';
    var parts = [];
    ['#formType', '#formLeistung', '#formElektronik'].forEach(function (id) {
      var el = qs(id);
      if (el && el.value) parts.push(el.value);
    });
    var sub = qs('#akteTopbarSub');
    if (sub) sub.textContent = parts.join(' · ') || 'Stammdaten';
  }

  function initAkte() {
    if (document.body) document.body.classList.add('akte-page');
    bindTabs();
    syncTitle();
    var fab = qs('#formFab');
    if (fab) fab.addEventListener('input', syncTitle);
    loadGallery();
    var galTab = qs('.akte-tab[data-akte-tab="galerie"]');
    if (galTab && galTab.getAttribute('data-akte-gal-bound') !== '1') {
      galTab.setAttribute('data-akte-gal-bound', '1');
      galTab.addEventListener('click', function () {
        lastGalleryFab = null;
        loadGallery();
      });
    }
    if (!window._kuklaAkteGalleryWatch) {
      window._kuklaAkteGalleryWatch = true;
      setInterval(function () {
        var el = qs('#formFab');
        if (!el) return;
        var v = (el.value || '').trim();
        if (v !== lastGalleryFab) loadGallery();
        syncTitle();
      }, 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAkte);
  } else {
    initAkte();
  }
})();
