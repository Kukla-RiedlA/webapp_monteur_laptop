/**
 * Laptop-Renderer: Hinweis-Lampe + Popup.
 */
(function (global) {
  'use strict';
  var API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var lastPopupIds = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setLamp(state) {
    var btn = document.getElementById('hinweisLampBtn');
    if (!btn) return;
    btn.classList.remove('is-red', 'is-yellow', 'is-off');
    btn.classList.add(state === 'red' ? 'is-red' : state === 'yellow' ? 'is-yellow' : 'is-off');
  }

  function cardHtml(it) {
    var html = '<article class="hinweis-card' + (it.overdue ? ' is-overdue' : '') + '" data-hinweis-id="' + esc(it.hinweis_id) + '">';
    html += '<div class="hinweis-card-meta">' + esc(it.tag || '') +
      (it.fabrikationsnummer ? ' · FN ' + esc(it.fabrikationsnummer) : '') +
      (it.overdue ? ' · überfällig' : '') + '</div>';
    if (it.body) html += '<p class="hinweis-card-body">' + esc(it.body) + '</p>';
    (it.files || []).forEach(function (f) {
      html += '<div><a href="' + esc(API_BASE + '/api/hinweise/file?id=' + f.id) + '" target="_blank">' + esc(f.original_name) + '</a></div>';
    });
    html += '<div class="hinweis-card-actions">';
    html += '<button type="button" class="btn" data-hinweis-act="verwerfen">Verwerfen</button>';
    html += '<button type="button" class="btn" data-hinweis-act="aufheben">Aufheben</button>';
    html += '<button type="button" class="btn btn-primary" data-hinweis-act="erledigt">Erledigt</button>';
    html += '</div></article>';
    return html;
  }

  function ensureModal() {
    var m = document.getElementById('hinweisModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'hinweisModal';
    m.className = 'hinweis-modal';
    m.innerHTML = '<div class="hinweis-modal-card"><h2>Montagehinweise</h2><div id="hinweisModalBody"></div><button type="button" class="btn" id="hinweisModalClose">Schließen</button></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('is-open'); });
    document.getElementById('hinweisModalClose').addEventListener('click', function () { m.classList.remove('is-open'); });
    document.getElementById('hinweisModalBody').addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-hinweis-act]');
      if (!btn) return;
      var card = btn.closest('[data-hinweis-id]');
      var id = card ? parseInt(card.getAttribute('data-hinweis-id'), 10) : 0;
      fetch(API_BASE + '/api/hinweise/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hinweis_id: id, action: btn.getAttribute('data-hinweis-act') })
      }).then(function () { refresh(); loadAkte(); });
    });
    return m;
  }

  function openModal(items) {
    var m = ensureModal();
    document.getElementById('hinweisModalBody').innerHTML =
      items && items.length ? items.map(cardHtml).join('') : '<p>Keine Hinweise.</p>';
    m.classList.add('is-open');
  }

  function refresh() {
    return fetch(API_BASE + '/api/hinweise/mine')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) return;
        setLamp(d.lamp || 'off');
        var fresh = [];
        (d.popup || []).forEach(function (it) {
          var id = String(it.hinweis_id || '');
          if (!id || lastPopupIds[id]) return;
          lastPopupIds[id] = true;
          fresh.push(it);
        });
        if (fresh.length) openModal(fresh);
      })
      .catch(function () {});
  }

  function bindDropzone(zone) {
    if (!zone || zone.getAttribute('data-bound')) return;
    zone.setAttribute('data-bound', '1');
    var input = zone.querySelector('input[type="file"]');
    var list = zone.querySelector('[data-hinweis-drop-list]');
    function names() {
      if (!list || !input || !input.files) return;
      var n = [];
      for (var i = 0; i < input.files.length; i++) n.push(input.files[i].name);
      list.textContent = n.join(', ');
    }
    zone.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (input) input.click();
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('is-drag');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('is-drag');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-drag');
      if (!input || !e.dataTransfer || !e.dataTransfer.files) return;
      input.files = e.dataTransfer.files;
      names();
    });
    if (input) input.addEventListener('change', names);
  }

  function collectFormData(root) {
    var fd = new FormData();
    if (!root) return fd;
    var nodes = root.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.name || el.disabled) continue;
      var type = String(el.type || '').toLowerCase();
      if (type === 'file') {
        var files = el.files || [];
        for (var f = 0; f < files.length; f++) fd.append(el.name, files[f]);
        continue;
      }
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      fd.append(el.name, el.value);
    }
    return fd;
  }

  function resetCreateForm(root) {
    if (!root) return;
    root.querySelectorAll('input, select, textarea').forEach(function (el) {
      var type = String(el.type || '').toLowerCase();
      if (type === 'hidden') return;
      if (type === 'file') { el.value = ''; return; }
      if (el.tagName === 'SELECT') { el.selectedIndex = 0; return; }
      el.value = '';
    });
    var list = root.querySelector('[data-hinweis-drop-list]');
    if (list) list.textContent = '';
  }

  function loadAkte() {
    var list = document.getElementById('akteHinweiseList');
    if (!list) return;
    var fabEl = document.getElementById('formFab');
    var fab = fabEl ? String(fabEl.value || '').trim() : '';
    if (!fab) return;
    fetch(API_BASE + '/api/hinweise?fabrikationsnummer=' + encodeURIComponent(fab))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        list.innerHTML = items.length ? items.map(cardHtml).join('') : '<p class="muted">Keine Hinweise.</p>';
        var tab = document.querySelector('.akte-tab[data-akte-tab="hinweise"]');
        if (tab) tab.classList.toggle('has-open-hinweis', items.some(function (it) { return it.status === 'open'; }));
      })
      .catch(function () {});
    var form = document.getElementById('akteHinweisCreateForm');
    if (form && !form.getAttribute('data-bound')) {
      form.setAttribute('data-bound', '1');
      bindDropzone(form.querySelector('[data-hinweis-drop]'));
      form.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('[data-hinweis-save]');
        if (!btn || !form.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        var fd = collectFormData(form);
        fd.set('scope', 'fn');
        fd.set('fabrikationsnummer', fabEl ? String(fabEl.value || '').trim() : fab);
        fetch(API_BASE + '/api/hinweise/create', { method: 'POST', body: fd })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || d.ok === false) throw new Error((d && d.error) || 'Fehler');
            resetCreateForm(form);
            loadAkte();
            refresh();
          })
          .catch(function (err) { window.alert(err.message || 'Speichern fehlgeschlagen'); });
      });
    }
  }

  function init() {
    var btn = document.getElementById('hinweisLampBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        fetch(API_BASE + '/api/hinweise/mine').then(function (r) { return r.json(); }).then(function (d) {
          openModal((d && d.items) || []);
        }).catch(function () { openModal([]); });
      });
    }
    refresh();
    setInterval(refresh, 30000);
    loadAkte();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.KuklaLaptopHinweise = { refresh: refresh, loadAkte: loadAkte };
})(window);
