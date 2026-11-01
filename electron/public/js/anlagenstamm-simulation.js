/**
 * Anlagenakte Simulation: Bildschirm und Parameterlisten dieser Anlage.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function techId() {
    try { return String(localStorage.getItem('monteur_technicianId') || '').trim(); }
    catch (_) { return ''; }
  }

  function isPwa() {
    return !!(root.PwaApi && typeof root.PwaApi.getJson === 'function');
  }

  function isMonteurLaptop() {
    return !!(root.KUKLA_MONTEUR_LAPTOP || root.monteurApp);
  }

  function jsonPost(url, body) {
    var headers = { 'Content-Type': 'application/json' };
    var tid = techId();
    if (tid) headers['X-Technician-Id'] = tid;
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function currentFab() {
    if (root.KuklaAnlagenParameterTab && typeof root.KuklaAnlagenParameterTab.currentFab === 'function') {
      var fromTab = root.KuklaAnlagenParameterTab.currentFab();
      if (fromTab) return fromTab;
    }
    var ids = ['formFab', 'anlagenFabInput'];
    var i;
    for (i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && String(el.value || '').trim()) return String(el.value).trim();
    }
    var top = document.getElementById('akteTopbarFn');
    if (top) {
      var t = String(top.textContent || '').trim();
      if (t && t !== 'Anlage' && t !== 'Neue Anlage') return t;
    }
    return String(new URLSearchParams(window.location.search).get('fab') || '').trim();
  }

  function fetchList(fab) {
    if (isPwa()) {
      return root.PwaApi.getJson('/api/mobile/anlagenstamm_parameter_files_list.php?fab=' + encodeURIComponent(fab));
    }
    if (isMonteurLaptop()) {
      var payload = { fab: fab, technician_id: techId() };
      try {
        if (typeof root.getDispoBaseUrl === 'function') payload.baseUrl = root.getDispoBaseUrl();
        if (typeof root.getDispoUsername === 'function') payload.serverUsername = root.getDispoUsername();
      } catch (_) {}
      return jsonPost('/api/anlagenstamm_parameter_files_list', payload);
    }
    return jsonPost('/api/anlagenstamm_parameter_files_list.php', { fab: fab });
  }

  function downloadUrl(fab, fileId) {
    var q = 'fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
    if (isPwa()) return '/api/mobile/anlagenstamm_parameter_download.php?' + q;
    return '/api/anlagenstamm_parameter_download.php?' + q;
  }

  function fileText(fab, file) {
    var id = file.id || file.local_id || '';
    return fetch(downloadUrl(fab, id), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Liste nicht lesbar');
      return r.arrayBuffer().then(function (buf) {
        return root.OpcgTool && root.OpcgTool.decodeBuffer ? root.OpcgTool.decodeBuffer(buf) : new TextDecoder('utf-8').decode(buf);
      });
    });
  }

  function panel(rootEl) {
    return rootEl || document.querySelector('[data-akte-panel="simulation"]');
  }

  function fileId(file) {
    return String(file && (file.id || file.local_id) || '');
  }

  function fileStamp(file) {
    var name = String((file && (file.original_filename || file.name || file.display_name)) || '');
    var base = name.replace(/\\/g, '/').split('/').pop() || '';
    var match = base.match(/_(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])([0-5]\d)(?:([0-5]\d))?/);
    var raw = '';
    if (match) raw = match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5] + ':' + (match[6] || '00');
    else raw = String((file && (file.display_datetime || file.uploaded_at || file.mtime || file.created_at)) || '');
    var time = Date.parse(raw.replace(' ', 'T'));
    return isNaN(time) ? 0 : time;
  }

  function newestOf(files) {
    var best = null;
    var bestTime = -1;
    var bestId = -1;
    (files || []).forEach(function (file) {
      var time = fileStamp(file);
      var id = Number(file.id || file.local_id || 0);
      if (!best || time > bestTime || (time === bestTime && id > bestId)) {
        best = file;
        bestTime = time;
        bestId = id;
      }
    });
    return best;
  }

  function resetScreen(host) {
    var frame = host.querySelector('[data-opcg-frame]');
    if (!root.OpcgTool || !frame) return;
    root.OpcgTool.whenReady(frame, function () { root.OpcgTool.send(frame, [], true); });
  }

  function applyChecked(host, fab) {
    var frame = host.querySelector('[data-opcg-frame]');
    var status = host.querySelector('[data-opcg-status]');
    var boxes = host.querySelectorAll('[data-opcg-check]:checked');
    var files = host._opcgFiles || [];
    var chosen = [];
    Array.prototype.forEach.call(boxes, function (box) {
      var id = box.getAttribute('data-opcg-id');
      var hit = files.filter(function (f) { return String(f.id || f.local_id || '') === String(id); })[0];
      if (hit) chosen.push(hit);
    });
    host._opcgChecked = chosen.map(function (f) { return String(f.id || f.local_id || ''); });
    if (!root.OpcgTool || !frame) return;
    if (!chosen.length) {
      root.OpcgTool.whenReady(frame, function () { root.OpcgTool.send(frame, [], true); });
      if (status) status.textContent = '';
      return;
    }
    if (status) status.textContent = 'Parameter werden geladen …';
    Promise.all(chosen.map(function (f) { return fileText(fab, f); })).then(function (texts) {
      root.OpcgTool.whenReady(frame, function () { root.OpcgTool.send(frame, texts, true); });
      if (status) status.textContent = chosen.length + ' Liste(n) in der Simulation.';
    }).catch(function (err) {
      if (status) status.textContent = err && err.message ? err.message : 'Laden fehlgeschlagen.';
    });
  }

  function renderFiles(host, fab, files) {
    var listEl = host.querySelector('[data-opcg-lists]');
    if (!listEl) return;
    host._opcgFiles = files || [];
    var checked = {};
    (host._opcgChecked || []).forEach(function (id) { checked[id] = true; });
    if (!files.length) {
      listEl.innerHTML = '<p class="muted">Keine Parameterlisten für diese Fabrikationsnummer.</p>';
      return;
    }
    var html = '<p class="muted">Beim Öffnen wird die aktuellste Liste geladen.</p>';
    files.forEach(function (f) {
      var id = String(f.id || f.local_id || '');
      var name = f.original_filename || 'parameterliste';
      html += '<label class="opcg-sim-row"><input type="checkbox" data-opcg-check data-opcg-id="' + esc(id) + '"' +
        (checked[id] ? ' checked' : '') + '> <span>' + esc(name) + '</span></label>';
    });
    html += '<p class="muted" data-opcg-status></p>';
    listEl.innerHTML = html;
  }

  function ensureStyle() {
    if (document.getElementById('opcg-sim-style')) return;
    var style = document.createElement('style');
    style.id = 'opcg-sim-style';
    style.textContent = '.opcg-sim{display:flex;flex-direction:column;gap:12px;}' +
      '.opcg-sim-frame{width:100%;height:min(72vh,640px);border:0;background:#1c2430;}' +
      '.opcg-sim-row{display:flex;gap:8px;align-items:flex-start;margin:4px 0;}';
    document.head.appendChild(style);
  }

  function bind(host) {
    if (!host || host.getAttribute('data-opcg-sim') === '1') return;
    host.setAttribute('data-opcg-sim', '1');
    host.addEventListener('change', function (ev) {
      var box = ev.target;
      if (!box || !box.hasAttribute || !box.hasAttribute('data-opcg-check')) return;
      applyChecked(host, host._opcgFab || currentFab());
    });
  }

  function load(rootEl, fab) {
    var host = panel(rootEl);
    if (!host) return;
    ensureStyle();
    bind(host);
    fab = String(fab || currentFab() || '').trim();
    host._opcgFab = fab;
    host._opcgChecked = [];
    var token = (host._opcgToken || 0) + 1;
    host._opcgToken = token;
    var listEl = host.querySelector('[data-opcg-lists]');
    resetScreen(host);
    if (!fab) {
      if (listEl) listEl.innerHTML = '<p class="muted">Fabrikationsnummer fehlt.</p>';
      return;
    }
    if (listEl) listEl.innerHTML = '<p class="muted">Parameterlisten werden geladen …</p>';
    fetchList(fab).then(function (data) {
      if (host._opcgToken !== token) return;
      if (!data || !data.ok) throw new Error((data && data.error) || 'Liste fehlgeschlagen');
      var files = data.files || [];
      var newest = newestOf(files);
      host._opcgChecked = newest ? [fileId(newest)] : [];
      renderFiles(host, data.fab || fab, files);
      if (!newest) return;
      var frame = host.querySelector('[data-opcg-frame]');
      var status = host.querySelector('[data-opcg-status]');
      if (status) status.textContent = 'Parameter werden geladen …';
      return fileText(data.fab || fab, newest).then(function (text) {
        if (host._opcgToken !== token) return;
        if (root.OpcgTool && frame) {
          root.OpcgTool.whenReady(frame, function () { root.OpcgTool.send(frame, [text], true); });
        }
        if (status) status.textContent = (newest.original_filename || 'Liste') + ' geladen.';
      });
    }).catch(function (e) {
      if (host._opcgToken !== token) return;
      if (listEl) listEl.innerHTML = '<p class="muted">Fehler: ' + esc(e.message || String(e)) + '</p>';
    });
  }

  root.KuklaAnlagenSimulation = { load: load };
})(window);
