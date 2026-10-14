(function () {
  'use strict';

  var STORE_KEY = 'kukla_ftp_target';
  var state = {
    remotePath: '/',
    remoteEntries: [],
    localPath: '',
    localParent: '',
    localEntries: [],
    busy: false,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function apiBase() {
    if (window.monteurApp && window.monteurApp.apiBase) return String(window.monteurApp.apiBase);
    if (typeof monteurApp !== 'undefined' && monteurApp && monteurApp.apiBase) return String(monteurApp.apiBase);
    return 'http://127.0.0.1:39678';
  }

  function techId() {
    return typeof window.getTechId === 'function' ? window.getTechId() : 0;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clock() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  function log(text, isError) {
    var host = el('ftpLog');
    if (!host) return;
    var line = document.createElement('p');
    if (isError) line.className = 'is-err';
    line.textContent = clock() + '  ' + (text || '');
    host.appendChild(line);
    host.scrollTop = host.scrollHeight;
  }

  function saveToAnlagenstamm() {
    var box = el('ftpSaveAnlagenstamm');
    return !!(box && box.checked);
  }

  function updateHint() {
    var hint = el('ftpSaveHint');
    if (!hint) return;
    hint.textContent = saveToAnlagenstamm()
      ? 'Parameterlisten gehen in den Anlagenstamm und stehen danach in den Protokollen und in der Kundendokumentation. Andere Dateien nur im lokalen Ordner links.'
      : 'Alle Dateien nur im lokalen Ordner links. Nichts im Anlagenstamm.';
  }

  function dateRange() {
    var today = new Date();
    var from = new Date(today);
    from.setFullYear(from.getFullYear() - 1);
    var to = new Date(today);
    to.setFullYear(to.getFullYear() + 10);
    return {
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    };
  }

  function connectionBody(extra) {
    var body = {
      host: el('ftpHost') ? el('ftpHost').value.trim() : '',
      port: el('ftpPort') ? el('ftpPort').value : '21',
      user: el('ftpUser') ? el('ftpUser').value.trim() : '',
      password: el('ftpPassword') ? el('ftpPassword').value : '',
      path: state.remotePath || '/',
    };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        body[key] = extra[key];
      });
    }
    return body;
  }

  function rememberTarget() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        host: el('ftpHost') ? el('ftpHost').value.trim() : '',
        port: el('ftpPort') ? el('ftpPort').value : '21',
        user: el('ftpUser') ? el('ftpUser').value.trim() : '',
        local_dir: state.localPath || '',
      }));
    } catch (_) { /* Merkdaten sind optional */ }
  }

  function restoreTarget() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.host && el('ftpHost')) el('ftpHost').value = String(data.host);
      if (data && data.port && el('ftpPort')) el('ftpPort').value = String(data.port);
      if (data && data.user && el('ftpUser')) el('ftpUser').value = String(data.user);
      if (data && data.local_dir) state.localPath = String(data.local_dir);
    } catch (_) { /* alte oder leere Merkdaten */ }
  }

  function applyDefaultLogin() {
    var user = el('ftpUser');
    var password = el('ftpPassword');
    if (user && !user.value.trim()) user.value = 'kukla';
    if (password && !password.value) password.value = 'kukla';
  }

  async function localPost(path, body) {
    var tech = techId();
    var url = apiBase() + path + (tech ? '?technician_id=' + encodeURIComponent(tech) : '');
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Technician-Id': String(tech || ''),
      },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || 'Anfrage fehlgeschlagen');
    }
    return data;
  }

  async function loadJobs() {
    var select = el('ftpJob');
    if (!select) return;
    var current = select.value;
    var tech = techId();
    select.innerHTML = '<option value="">– Bitte wählen –</option>';
    if (!tech) return;
    var range = dateRange();
    var url = apiBase() + '/api/my_jobs?technician_id=' + encodeURIComponent(tech) +
      '&date_from=' + encodeURIComponent(range.date_from) +
      '&date_to=' + encodeURIComponent(range.date_to) +
      '&assigned_only=1';
    var res = await fetch(url, { headers: { 'X-Technician-Id': String(tech) } });
    var data = await res.json().catch(function () { return {}; });
    var jobs = data && data.ok && Array.isArray(data.jobs) ? data.jobs : [];
    jobs.forEach(function (job) {
      var opt = document.createElement('option');
      opt.value = job.id;
      opt.textContent = (job.job_number || job.id) + (job.customer_name ? ' – ' + job.customer_name : '');
      select.appendChild(opt);
    });
    if (current && Array.prototype.some.call(select.options, function (o) { return o.value === current; })) {
      select.value = current;
    }
  }

  function formatSize(size, type) {
    if (type === 'dir') return '';
    var n = Number(size) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fileType(entry) {
    if (!entry || entry.type === 'dir') return 'Ordner';
    var name = String(entry.name || '');
    var dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return 'Datei';
    return name.slice(dot + 1).toUpperCase();
  }

  function formatWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function joinRemote(dir, name) {
    var base = String(dir || '/');
    if (base === '/') return '/' + name;
    return base.replace(/\/+$/, '') + '/' + name;
  }

  function parentRemote(remotePath) {
    var dir = String(remotePath || '/');
    if (dir === '/') return '/';
    var parts = dir.split('/').filter(Boolean);
    parts.pop();
    return '/' + parts.join('/');
  }

  function renderLocal() {
    var body = el('ftpLocalBody');
    var pathInput = el('ftpLocalPath');
    if (pathInput) pathInput.value = state.localPath || '';
    if (!body) return;
    var html = '';
    if (state.localPath) {
      html += '<tr class="is-dir" data-local-up="1"><td class="is-name">..</td><td></td><td>Ordner</td><td></td></tr>';
    }
    state.localEntries.forEach(function (entry, index) {
      var dir = entry.type === 'dir';
      html += '<tr class="' + (dir ? 'is-dir' : '') + '" data-local-index="' + index + '">';
      html += '<td class="is-name" title="' + esc(entry.name) + '">' + esc(entry.name) + (dir ? '/' : '') + '</td>';
      html += '<td>' + esc(formatSize(entry.size, entry.type)) + '</td>';
      html += '<td>' + esc(fileType(entry)) + '</td>';
      html += '<td>' + esc(formatWhen(entry.mtime)) + '</td>';
      html += '</tr>';
    });
    if (!html) html = '<tr><td colspan="4">Ordner ist leer.</td></tr>';
    body.innerHTML = html;
  }

  function renderRemote() {
    var body = el('ftpRemoteBody');
    var pathInput = el('ftpRemotePath');
    if (pathInput) pathInput.value = state.remotePath || '/';
    if (!body) return;
    var html = '';
    if (state.remotePath && state.remotePath !== '/') {
      html += '<tr class="is-dir" data-remote-up="1"><td></td><td class="is-name">..</td><td></td><td>Ordner</td></tr>';
    }
    state.remoteEntries.forEach(function (entry, index) {
      var dir = entry.type === 'dir';
      html += '<tr class="' + (dir ? 'is-dir' : '') + '" data-remote-index="' + index + '">';
      html += '<td>' + (dir ? '' : '<input type="checkbox" data-ftp-file="' + index + '" aria-label="' + esc(entry.name) + '">') + '</td>';
      html += '<td class="is-name" title="' + esc(entry.name) + '">' + esc(entry.name) + (dir ? '/' : '') + '</td>';
      html += '<td>' + esc(formatSize(entry.size, entry.type)) + '</td>';
      html += '<td>' + esc(fileType(entry)) + '</td>';
      html += '</tr>';
    });
    if (!html) html = '<tr><td colspan="4">Dieser Ordner ist leer.</td></tr>';
    body.innerHTML = html;
    var all = el('ftpSelectAll');
    if (all) all.checked = false;
  }

  function joinLocal(dir, name) {
    var base = String(dir || '');
    var sep = base.indexOf('\\') >= 0 ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + sep + name;
  }

  async function openLocal(nextPath) {
    var data = await localPost('/api/ftp/local-list', { path: nextPath || '' });
    state.localPath = data.path || '';
    state.localParent = data.parent || '';
    state.localEntries = Array.isArray(data.entries) ? data.entries : [];
    renderLocal();
    rememberTarget();
  }

  async function openRemote(nextPath) {
    state.remotePath = nextPath || '/';
    log('Ordner lesen ' + state.remotePath);
    rememberTarget();
    var data = await localPost('/api/ftp/list', connectionBody());
    state.remotePath = data.path || state.remotePath;
    state.remoteEntries = Array.isArray(data.entries) ? data.entries : [];
    renderRemote();
    log(state.remoteEntries.length + ' Einträge');
  }

  function selectedNames() {
    var names = [];
    document.querySelectorAll('[data-ftp-file]').forEach(function (box) {
      if (!box.checked) return;
      var index = parseInt(box.getAttribute('data-ftp-file'), 10);
      var entry = state.remoteEntries[index];
      if (entry && entry.type !== 'dir') names.push(entry.name);
    });
    return names;
  }

  function resultLine(file) {
    if (!file.ok) return file.name + ': ' + (file.error || 'fehlgeschlagen');
    if (file.destination === 'anlagenstamm') {
      return file.name + ' → Anlagenstamm FN ' + (file.fab || '?') + ' (Protokolle und Kundendokumentation)';
    }
    return file.name + ' → ' + (file.saved_path || state.localPath || 'lokaler Ordner');
  }

  async function downloadNames(names) {
    if (!names.length) {
      log('Keine Datei ausgewählt.', true);
      return;
    }
    if (saveToAnlagenstamm()) {
      var jobId = el('ftpJob') ? parseInt(el('ftpJob').value, 10) : 0;
      if (!jobId) {
        log('Bitte einen Auftrag wählen.', true);
        return;
      }
    } else if (!state.localPath) {
      log('Bitte links einen Ordner wählen.', true);
      return;
    }
    log('Download startet: ' + names.length + ' Datei(en)');
    rememberTarget();
    var jobValue = el('ftpJob') && el('ftpJob').value ? parseInt(el('ftpJob').value, 10) : 0;
    var data = await localPost('/api/ftp/download', connectionBody({
      job_id: jobValue || undefined,
      names: names,
      save_to_anlagenstamm: saveToAnlagenstamm(),
      local_dir: state.localPath || '',
    }));
    var failed = 0;
    (data.files || []).forEach(function (file) {
      var line = resultLine(file);
      if (!file.ok) failed += 1;
      log(line, !file.ok);
    });
    if (!failed) log('Download fertig');
    if (state.localPath) {
      try { await openLocal(state.localPath); } catch (_) { /* Liste bleibt */ }
    }
  }

  function bindTable(body, kind) {
    if (!body || body.dataset.bound) return;
    body.dataset.bound = '1';
    body.addEventListener('click', function (ev) {
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-ftp-file') != null) return;
      var row = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
      if (!row) return;
      if (kind === 'local' && row.getAttribute('data-local-up') != null) return;
      if (kind === 'remote' && row.getAttribute('data-remote-up') != null) return;
      var box = row.querySelector('[data-ftp-file]');
      if (box && ev.target !== box) box.checked = !box.checked;
      body.querySelectorAll('tr').forEach(function (tr) { tr.classList.remove('is-selected'); });
      row.classList.add('is-selected');
    });
    body.addEventListener('dblclick', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
      if (!row || state.busy) return;
      state.busy = true;
      var task;
      if (kind === 'local') {
        if (row.getAttribute('data-local-up') != null) task = openLocal(state.localParent || state.localPath);
        else {
          var localIndex = parseInt(row.getAttribute('data-local-index'), 10);
          var localEntry = state.localEntries[localIndex];
          if (!localEntry || localEntry.type !== 'dir') {
            state.busy = false;
            return;
          }
          task = openLocal(joinLocal(state.localPath, localEntry.name));
        }
      } else if (row.getAttribute('data-remote-up') != null) {
        task = openRemote(parentRemote(state.remotePath));
      } else {
        var remoteIndex = parseInt(row.getAttribute('data-remote-index'), 10);
        var remoteEntry = state.remoteEntries[remoteIndex];
        if (!remoteEntry) {
          state.busy = false;
          return;
        }
        if (remoteEntry.type === 'dir') task = openRemote(joinRemote(state.remotePath, remoteEntry.name));
        else task = downloadNames([remoteEntry.name]);
      }
      Promise.resolve(task).catch(function (err) {
        log(err && err.message ? err.message : 'Fehler', true);
      }).then(function () {
        state.busy = false;
      });
    });
  }

  function bind() {
    bindTable(el('ftpLocalBody'), 'local');
    bindTable(el('ftpRemoteBody'), 'remote');
    var connectBtn = el('btnFtpConnect');
    var upBtn = el('btnFtpUp');
    var localUp = el('btnFtpLocalUp');
    var browse = el('btnFtpLocalBrowse');
    var downloadBtn = el('btnFtpDownload');
    var selectAll = el('ftpSelectAll');
    var saveBox = el('ftpSaveAnlagenstamm');
    if (connectBtn && !connectBtn.dataset.bound) {
      connectBtn.dataset.bound = '1';
      connectBtn.addEventListener('click', function () {
        if (state.busy) return;
        state.busy = true;
        openRemote('/').catch(function (err) {
          log(err && err.message ? err.message : 'Verbindung fehlgeschlagen', true);
        }).then(function () { state.busy = false; });
      });
    }
    if (upBtn && !upBtn.dataset.bound) {
      upBtn.dataset.bound = '1';
      upBtn.addEventListener('click', function () {
        if (state.busy || state.remotePath === '/') return;
        state.busy = true;
        openRemote(parentRemote(state.remotePath)).catch(function (err) {
          log(err && err.message ? err.message : 'Ordner nicht lesbar', true);
        }).then(function () { state.busy = false; });
      });
    }
    if (localUp && !localUp.dataset.bound) {
      localUp.dataset.bound = '1';
      localUp.addEventListener('click', function () {
        if (state.busy || !state.localPath) return;
        state.busy = true;
        var parent = state.localParent && state.localParent !== state.localPath ? state.localParent : state.localPath;
        openLocal(parent).catch(function (err) {
          log(err && err.message ? err.message : 'Ordner nicht lesbar', true);
        }).then(function () { state.busy = false; });
      });
    }
    if (browse && !browse.dataset.bound) {
      browse.dataset.bound = '1';
      browse.addEventListener('click', function () {
        var app = window.monteurApp || (typeof monteurApp !== 'undefined' ? monteurApp : null);
        if (!app || typeof app.chooseDienstreiseBasePath !== 'function') {
          log('Ordnerauswahl ist nur in der App verfügbar.', true);
          return;
        }
        app.chooseDienstreiseBasePath().then(function (picked) {
          if (!picked) return;
          return openLocal(picked);
        }).catch(function (err) {
          log(err && err.message ? err.message : 'Ordner nicht lesbar', true);
        });
      });
    }
    if (downloadBtn && !downloadBtn.dataset.bound) {
      downloadBtn.dataset.bound = '1';
      downloadBtn.addEventListener('click', function () {
        if (state.busy) return;
        state.busy = true;
        downloadNames(selectedNames()).catch(function (err) {
          log(err && err.message ? err.message : 'Download fehlgeschlagen', true);
        }).then(function () { state.busy = false; });
      });
    }
    if (selectAll && !selectAll.dataset.bound) {
      selectAll.dataset.bound = '1';
      selectAll.addEventListener('change', function () {
        var on = !!selectAll.checked;
        document.querySelectorAll('[data-ftp-file]').forEach(function (box) { box.checked = on; });
      });
    }
    if (saveBox && !saveBox.dataset.bound) {
      saveBox.dataset.bound = '1';
      saveBox.addEventListener('change', updateHint);
    }
    var localPath = el('ftpLocalPath');
    if (localPath && !localPath.dataset.bound) {
      localPath.dataset.bound = '1';
      localPath.addEventListener('change', function () {
        if (state.busy) return;
        state.busy = true;
        openLocal(localPath.value).catch(function (err) {
          log(err && err.message ? err.message : 'Ordner nicht lesbar', true);
        }).then(function () { state.busy = false; });
      });
    }
  }

  window.openFtpTool = function () {
    bind();
    restoreTarget();
    applyDefaultLogin();
    updateHint();
    loadJobs().catch(function () {});
    openLocal(state.localPath || '').catch(function (err) {
      log(err && err.message ? err.message : 'Lokaler Ordner nicht lesbar', true);
    });
  };
})();
