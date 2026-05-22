(function () {
  const API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';

  /** @param {string} jobId */
  function pollBackgroundJobUntilTerminal(jobId, onProgress, opts) {
    opts = opts || {};
    var interval = opts.interval || 750;
    var maxMs = opts.maxMs || 45 * 60 * 1000;
    var missingRetries = opts.missingRetries != null ? opts.missingRetries : 8;
    var t0 = Date.now();
    var missingCount = 0;
    return new Promise(function (resolve, reject) {
      function tick() {
        if (Date.now() - t0 > maxMs) {
          reject(new Error('Zeitüberschreitung beim Hintergrund-Job'));
          return;
        }
        fetch(API_BASE + '/api/background_jobs/' + encodeURIComponent(jobId))
          .then(function (r) {
            return r.json().then(function (data) {
              return { status: r.status, data: data };
            });
          })
          .then(function (x) {
            var data = x.data;
            var j = data && data.job;
            if (!j) {
              var errMsg = (data && data.error) || 'Job nicht gefunden';
              if (x.status === 404 && missingCount < missingRetries) {
                missingCount++;
                setTimeout(tick, Math.min(interval, 400));
                return;
              }
              reject(new Error(errMsg));
              return;
            }
            missingCount = 0;
            if (typeof onProgress === 'function') {
              try {
                onProgress(j);
              } catch (e) { /* ignore */ }
            }
            var st = j.status;
            if (st === 'completed' || st === 'failed' || st === 'cancelled') {
              resolve(j);
              return;
            }
            setTimeout(tick, interval);
          })
          .catch(reject);
      }
      tick();
    });
  }

  /** Nach sync_pull: auf dienstreise_pull-Jobs warten (Projektordner-Kopie läuft separat). */
  function waitForActiveDienstreisePullJobs(opts) {
    opts = opts || {};
    var interval = opts.interval || 800;
    var maxMs = opts.maxMs || 25 * 60 * 1000;
    var t0 = Date.now();
    return new Promise(function (resolve) {
      function tick() {
        if (Date.now() - t0 > maxMs) {
          console.warn('[Sync] Timeout beim Warten auf Projektordner-Kopie');
          resolve();
          return;
        }
        fetch(API_BASE + '/api/background_jobs?active=1&limit=80')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var jobs = (data && data.jobs) || [];
            var pulls = jobs.filter(function (j) {
              return j && j.type === 'dienstreise_pull';
            });
            if (!pulls.length) {
              resolve();
              return;
            }
            setTimeout(tick, interval);
          })
          .catch(function () {
            resolve();
          });
      }
      tick();
    });
  }

  function startBackgroundJobsPollingUi() {
    function refresh() {
      fetch(API_BASE + '/api/background_jobs?running=1&limit=10')
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          var wrap = document.getElementById('backgroundJobsWrap');
          var badge = document.getElementById('backgroundJobsBadge');
          var jobs = data && data.jobs ? data.jobs : [];
          if (!wrap || !badge) return;
          if (!jobs.length) {
            wrap.style.display = 'none';
            wrap.removeAttribute('title');
            return;
          }
          wrap.style.display = '';
          badge.textContent = 'Sync ' + jobs.length;
          var lines = jobs.slice(0, 8).map(function (j) {
            var ph = j.progress_phase || j.status || '';
            var msg = j.message ? String(j.message) : '';
            var cur = j.progress_current != null ? j.progress_current : '';
            var tot = j.progress_total != null ? j.progress_total : '';
            var prog = tot !== '' && Number(tot) > 0 ? ' (' + cur + '/' + tot + ')' : '';
            return (j.type || '?') + ': ' + ph + prog + (msg ? ' — ' + msg : '');
          });
          wrap.setAttribute(
            'title',
            'Laufende Hintergrund-Synchronisation (keine abgeschlossenen Aufträge):\n' + lines.join('\n'),
          );
        })
        .catch(function () {});
    }
    refresh();
    setInterval(refresh, 2800);
  }

  const getTechId = () => parseInt(document.getElementById('technicianId').value, 10) || 0;
  const getServerUsername = () => (document.getElementById('serverUsername') && document.getElementById('serverUsername').value || '').trim();
  const getServerPassword = () => (document.getElementById('serverPassword') && document.getElementById('serverPassword').value || '');

  /** Standard bei Neuinstallation (ohne gespeicherte Einstellungen); weiterhin editierbar. */
  const DEFAULT_DISPO_SERVER_URL = 'https://fsm.kukla.co.at:4433';
  const DEFAULT_DISPO_SERVER_URL_INTERNAL = 'https://10.0.0.180';
  const DEFAULT_ALLOW_INSECURE_TLS = true;

  const SETTINGS_KEYS = {
    serverUrl: 'monteur_serverUrl',
    serverUrlInternal: 'monteur_serverUrlInternal',
    technicianId: 'monteur_technicianId',
    monteurFullName: 'monteur_fullName',
    serverUsername: 'monteur_serverUsername',
    serverPassword: 'monteur_serverPassword',
    syncIntervalMinutes: 'monteur_syncIntervalMinutes',
    dienstreiseBasePath: 'monteur_dienstreiseBasePath',
    allowInsecureTls: 'monteur_allowInsecureTls',
    uiTheme: 'monteur_uiTheme',
  };

  function normalizeUiTheme(theme) {
    return theme === 'dark' ? 'dark' : 'kukla';
  }

  function applyUiTheme(theme) {
    var t = normalizeUiTheme(theme);
    document.documentElement.setAttribute('data-ui-theme', t);
    var el = document.getElementById('uiThemeDarkToggle');
    if (el) {
      el.checked = t === 'dark';
      el.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
    }
  }

  function persistUiThemeFromToggle() {
    var el = document.getElementById('uiThemeDarkToggle');
    var th = el && el.checked ? 'dark' : 'kukla';
    try { localStorage.setItem(SETTINGS_KEYS.uiTheme, th); } catch (e) { /* ignore */ }
    applyUiTheme(th);
  }

  const LS_ACTIVE_BASE = 'monteur_dispoActiveBase';
  const LS_ACTIVE_SOURCE = 'monteur_dispoActiveSource';

  function getDispoExternalUrl() {
    return (document.getElementById('serverUrl').value || '').trim();
  }

  function getDispoInternalUrl() {
    var el = document.getElementById('serverUrlInternal');
    return el ? (el.value || '').trim() : '';
  }

  /** Alias: externe Dispo-Basis-URL (Einstellungen). */
  function getServerUrl() {
    return getDispoExternalUrl();
  }

  /** Für Sync/Dispo: zuletzt erfolgreich gewählte Basis (intern/extern), sonst externe URL. */
  function getDispoBaseUrl() {
    try {
      var active = (localStorage.getItem(LS_ACTIVE_BASE) || '').trim();
      if (active) return active;
    } catch (e) { /* ignore */ }
    var u = getDispoExternalUrl();
    if (u) return u;
    try { return (localStorage.getItem(SETTINGS_KEYS.serverUrl) || '').trim(); } catch (e2) { return ''; }
  }

  function setDispoActiveBase(url, source) {
    var u = (url || '').toString().trim().replace(/\/+$/, '');
    if (!u) return;
    try {
      localStorage.setItem(LS_ACTIVE_BASE, u);
      if (source) localStorage.setItem(LS_ACTIVE_SOURCE, String(source));
    } catch (e) { /* ignore */ }
    syncUpdateFeedToMain();
  }

  function getAllowInsecureTlsSetting() {
    var el = document.getElementById('allowInsecureDispoTls');
    if (el) return !!el.checked;
    try {
      return localStorage.getItem(SETTINGS_KEYS.allowInsecureTls) === '1';
    } catch (e) {
      return true;
    }
  }

  function syncUpdateFeedToMain() {
    if (!window.monteurApp || typeof window.monteurApp.setUpdateFeedBase !== 'function') return;
    var base = getDispoBaseUrl();
    if (!base) return;
    window.monteurApp.setUpdateFeedBase(base, getAllowInsecureTlsSetting()).catch(function () {});
  }

  function isPrivateLanHostname(hostname) {
    var h = (hostname || '').toString().trim().toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  }

  /** Kandidaten für Verbindungs-/Dispo-Abfragen (aktiv → extern → intern). */
  function buildDispoBaseCandidatesClient() {
    var active = (getDispoBaseUrl() || '').trim().replace(/\/+$/, '');
    var ext = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
    var intUrl = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
    var out = [];
    var seen = {};
    function add(u) {
      if (!u || seen[u]) return;
      seen[u] = true;
      out.push(u);
    }
    add(active);
    var activePrivate = false;
    try {
      activePrivate = active && isPrivateLanHostname(new URL(active).hostname);
    } catch (e) { /* ignore */ }
    if (activePrivate) {
      add(ext);
      add(intUrl);
    } else {
      add(ext);
      add(intUrl);
    }
    return out;
  }

  function dispoBasePayloadExtra() {
    return {
      externalUrl: getDispoExternalUrl(),
      internalUrl: getDispoInternalUrl(),
    };
  }

  function applyDispoUsedBaseUrl(d) {
    if (!d || !d._used_base_url) return d;
    var used = String(d._used_base_url).trim().replace(/\/+$/, '');
    if (used) {
      var ext = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
      var intUrl = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
      var src = used === ext ? 'external' : (used === intUrl ? 'internal' : 'fallback');
      if (used !== (getDispoBaseUrl() || '').trim().replace(/\/+$/, '')) {
        setDispoActiveBase(used, src);
      }
    }
    delete d._used_base_url;
    return d;
  }

  /** Auto-Probe parallel (10 s serverseitig); gewählte URL in localStorage. */
  async function pickDispoBase() {
    var ext = getDispoExternalUrl();
    var int = getDispoInternalUrl();
    var techId = getTechId();
    function clearActive() {
      try {
        localStorage.removeItem(LS_ACTIVE_BASE);
        localStorage.removeItem(LS_ACTIVE_SOURCE);
      } catch (e) { /* ignore */ }
    }
    if (!techId || (!ext && !int)) {
      clearActive();
      return { ok: false };
    }
    try {
      var r = await fetch(API_BASE + '/api/dispo_pick_base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
        body: JSON.stringify({
          externalUrl: ext,
          internalUrl: int,
          technicianId: techId,
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword(),
        }),
      });
      var data = await r.json().catch(function () { return {}; });
      if (data && data.ok && data.selected_base_url) {
        try {
          localStorage.setItem(LS_ACTIVE_BASE, String(data.selected_base_url).trim());
          localStorage.setItem(LS_ACTIVE_SOURCE, (data.preferred_source || '').toString());
        } catch (e) { /* ignore */ }
        syncUpdateFeedToMain();
        return data;
      }
      clearActive();
      return data && typeof data === 'object' ? data : { ok: false };
    } catch (e) {
      clearActive();
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  function getDispoUsername() {
    var u = getServerUsername();
    if (u !== undefined) return u;
    try { return (localStorage.getItem(SETTINGS_KEYS.serverUsername) || '').trim(); } catch (e) { return ''; }
  }
  function getDispoPassword() {
    var p = getServerPassword();
    if (p !== undefined) return p;
    try { return localStorage.getItem(SETTINGS_KEYS.serverPassword) || ''; } catch (e) { return ''; }
  }

  function getSyncIntervalMinutes() {
    const el = document.getElementById('syncIntervalMinutes');
    const v = el ? parseInt(el.value, 10) : NaN;
    if (!Number.isFinite(v) || v < 1) return 5;
    return Math.min(1440, v);
  }

  function loadSettingsFromStorage() {
    try {
      const url = localStorage.getItem(SETTINGS_KEYS.serverUrl);
      document.getElementById('serverUrl').value =
        url != null ? url : DEFAULT_DISPO_SERVER_URL;
      const urlInt = localStorage.getItem(SETTINGS_KEYS.serverUrlInternal);
      var elInt = document.getElementById('serverUrlInternal');
      if (elInt) {
        elInt.value = urlInt != null ? urlInt : DEFAULT_DISPO_SERVER_URL_INTERNAL;
      }
      const techId = localStorage.getItem(SETTINGS_KEYS.technicianId);
      if (techId != null) document.getElementById('technicianId').value = techId;
      const fullNameStored = localStorage.getItem(SETTINGS_KEYS.monteurFullName);
      var elFullName = document.getElementById('monteurFullName');
      if (elFullName && fullNameStored != null) elFullName.value = fullNameStored;
      const username = localStorage.getItem(SETTINGS_KEYS.serverUsername);
      if (username != null) document.getElementById('serverUsername').value = username;
      const password = localStorage.getItem(SETTINGS_KEYS.serverPassword);
      if (password != null) document.getElementById('serverPassword').value = password;
      const interval = localStorage.getItem(SETTINGS_KEYS.syncIntervalMinutes);
      if (interval != null) {
        const el = document.getElementById('syncIntervalMinutes');
        if (el) el.value = Math.max(1, Math.min(1440, parseInt(interval, 10) || 5));
      }
      const basePath = localStorage.getItem(SETTINGS_KEYS.dienstreiseBasePath);
      if (basePath != null) {
        const el = document.getElementById('dienstreiseBasePath');
        if (el) el.value = basePath;
      }
      const tls = localStorage.getItem(SETTINGS_KEYS.allowInsecureTls);
      const tlsEl = document.getElementById('allowInsecureDispoTls');
      if (tlsEl) {
        tlsEl.checked = tls != null ? tls === '1' : DEFAULT_ALLOW_INSECURE_TLS;
      }
      const uiTh = localStorage.getItem(SETTINGS_KEYS.uiTheme);
      applyUiTheme(uiTh);
    } catch (e) { /* ignore */ }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(SETTINGS_KEYS.serverUrl, (document.getElementById('serverUrl').value || '').trim());
      var intEl = document.getElementById('serverUrlInternal');
      localStorage.setItem(SETTINGS_KEYS.serverUrlInternal, intEl ? (intEl.value || '').trim() : '');
      localStorage.setItem(SETTINGS_KEYS.technicianId, document.getElementById('technicianId').value || '');
      var elFn = document.getElementById('monteurFullName');
      localStorage.setItem(SETTINGS_KEYS.monteurFullName, elFn ? (elFn.value || '').trim() : '');
      localStorage.setItem(SETTINGS_KEYS.serverUsername, (document.getElementById('serverUsername') && document.getElementById('serverUsername').value) || '');
      localStorage.setItem(SETTINGS_KEYS.serverPassword, (document.getElementById('serverPassword') && document.getElementById('serverPassword').value) || '');
      localStorage.setItem(SETTINGS_KEYS.syncIntervalMinutes, String(getSyncIntervalMinutes()));
      const pathEl = document.getElementById('dienstreiseBasePath');
      localStorage.setItem(SETTINGS_KEYS.dienstreiseBasePath, (pathEl && pathEl.value ? pathEl.value.trim() : '') || '');
      const tlsEl = document.getElementById('allowInsecureDispoTls');
      localStorage.setItem(SETTINGS_KEYS.allowInsecureTls, tlsEl && tlsEl.checked ? '1' : '0');
      const themeEl = document.getElementById('uiThemeDarkToggle');
      const th = themeEl && themeEl.checked ? 'dark' : 'kukla';
      localStorage.setItem(SETTINGS_KEYS.uiTheme, th);
    } catch (e) { /* ignore */ }
  }

  function getSyncDateRange() {
    const today = new Date();
    // Vergangenheit einbeziehen: laufende in_arbeit-Aufträge haben oft Enddatum vor „heute“ und fehlen sonst im Dispo-Pull → wurden lokal gelöscht.
    const from = new Date(today);
    from.setFullYear(from.getFullYear() - 1);
    const to = new Date(today);
    to.setFullYear(to.getFullYear() + 10);
    return {
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10)
    };
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') p.set(k, v); });
    return p.toString();
  }

  var abrechnungCurrentJobs = [];

  function abrechnungAuthHeaders() {
    return Object.assign(
      { 'X-Technician-Id': String(getTechId()) },
      dispoBasicAuthHeaders(getDispoUsername, getDispoPassword)
    );
  }

  function abrechnungBody(extra) {
    return Object.assign({
      baseUrl: getDispoBaseUrl(),
      technicianId: getTechId(),
      serverUsername: getDispoUsername(),
      serverPassword: getDispoPassword()
    }, extra || {});
  }

  /** Nur Abrechnungs-Ansicht: bearbeiten solange nicht endgültig abgerechnet (Status oder beide Flags). */
  function abrechnungEffectiveCanWrite(job) {
    if (!job || typeof job !== 'object') return true;
    if (job.can_write === false) return false;
    var st = String(job.status != null ? job.status : '').trim();
    if (st === 'abgerechnet') return false;
    var ma = Number(job.montage_abgerechnet);
    var mv = Number(job.montage_verrechnet);
    if (Number.isFinite(ma) && Number.isFinite(mv) && ma === 1 && mv === 1) return false;
    return true;
  }

  async function abrechnungFetchOutboxCount() {
    try {
      const r = await fetch(API_BASE + '/api/abrechnung/outbox_count?technician_id=' + encodeURIComponent(getTechId()), {
        headers: abrechnungAuthHeaders()
      });
      const j = await r.json();
      return j && j.ok ? (j.count != null ? j.count : 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  async function updateAbrechnungStatusLine() {
    var el = document.getElementById('abrechnungStatusLine');
    if (!el) return;
    var parts = [];
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      parts.push('Offline — Anzeige aus lokalem Cache.');
    } else {
      parts.push('Netzwerk verfügbar.');
    }
    var n = await abrechnungFetchOutboxCount();
    if (n > 0) {
      parts.push('<span class="pending">' + n + ' ausstehende Änderungen (Sync)</span>');
    }
    el.innerHTML = parts.join(' ');
  }

  function abrechnungSelectedJobObj() {
    var sel = document.getElementById('abrechnungJobSelect');
    var id = sel && sel.value ? parseInt(sel.value, 10) : 0;
    if (!id) return null;
    for (var i = 0; i < abrechnungCurrentJobs.length; i++) {
      if (abrechnungCurrentJobs[i].id === id) return abrechnungCurrentJobs[i];
    }
    return { id: id, can_write: true };
  }

  function renderAbrechnungCommentList(ulEl, items) {
    if (!ulEl) return;
    ulEl.innerHTML = '';
    var list = Array.isArray(items) ? items : [];
    list.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'abrechnung-comment-item';
      var meta = document.createElement('div');
      meta.className = 'abrechnung-comment-meta';
      var parts = [];
      if (c.author_name) parts.push(String(c.author_name));
      if (c.created_at) parts.push(String(c.created_at));
      meta.textContent = parts.join(' · ');
      var body = document.createElement('div');
      body.className = 'abrechnung-comment-body';
      body.textContent = c.body != null ? String(c.body) : '';
      li.appendChild(meta);
      li.appendChild(body);
      ulEl.appendChild(li);
    });
    if (list.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Noch keine Kommentare.';
      ulEl.appendChild(empty);
    }
  }

  function formatAbrechnungFileSize(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    var b = Number(n);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function abrechnungFileBasename(fn) {
    var s = String(fn || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** Öffnen/Download mit Basic-Auth (Browser-Link ohne fetch sendet keine Authorization-Header). */
  async function openAbrechnungFile(jobId, bucket, fileName) {
    try {
      var base = (getDispoBaseUrl() || '').trim();
      var params = { job_server_id: jobId, bucket: bucket, name: fileName };
      if (base) params.base_url = base;
      var u = getDispoUsername();
      var p = getDispoPassword();
      if (u != null && String(u).trim() !== '') {
        params.serverUsername = String(u).trim();
        params.serverPassword = p != null ? String(p) : '';
      }
      var r = await fetch(API_BASE + '/api/abrechnung/file?' + qs(params), { headers: abrechnungAuthHeaders() });
      if (!r.ok) {
        var errText = await r.text().catch(function () { return ''; });
        throw new Error(errText || ('HTTP ' + r.status));
      }
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var lower = abrechnungFileBasename(fileName).toLowerCase();
      if (/\.(pdf|png|jpg|jpeg|gif|webp|svg)$/i.test(lower)) {
        window.open(url, '_blank', 'noopener');
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 120000);
      } else {
        var a = document.createElement('a');
        a.href = url;
        a.download = abrechnungFileBasename(fileName) || 'datei';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e2) {} }, 3000);
      }
    } catch (e) {
      window.alert((e && e.message) ? e.message : String(e));
    }
  }

  function renderAbrechnungFileList(ulEl, bucket, files, jobId, canWrite) {
    if (!ulEl) return;
    ulEl.innerHTML = '';
    var list = (files || []).filter(function (f) {
      var b = f.bucket != null ? String(f.bucket) : '';
      return b === bucket;
    });
    list.forEach(function (f) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#';
      a.className = 'abrechnung-file-link';
      a.setAttribute('role', 'button');
      var label = (f.file_name || f.name || '') + (f.size_bytes != null ? ' (' + formatAbrechnungFileSize(f.size_bytes) + ')' : '');
      if (f.remote_only) label += ' · Dispo';
      a.textContent = label || '(Datei)';
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        openAbrechnungFile(jobId, bucket, f.file_name || f.name);
      });
      li.appendChild(a);
      if (canWrite) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-ghost';
        del.textContent = 'Löschen';
        del.addEventListener('click', function () {
          if (!window.confirm('Datei wirklich löschen?')) return;
          abrechnungDeleteFile(jobId, bucket, f.file_name || f.name);
        });
        li.appendChild(del);
      }
      ulEl.appendChild(li);
    });
    if (list.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Keine Dateien (mit Dispo-URL unter Einstellungen werden Namen geladen; Klick lädt die Datei).';
      ulEl.appendChild(empty);
    }
  }

  async function abrechnungDeleteFile(jobId, bucket, name) {
    try {
      var r = await fetch(API_BASE + '/api/abrechnung/delete_file', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, abrechnungAuthHeaders()),
        body: JSON.stringify(abrechnungBody({ job_server_id: jobId, bucket: bucket, name: name }))
      });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Löschen fehlgeschlagen');
      if (j.queued && typeof showToast === 'function') showToast('Löschen wird ausgeführt, sobald die Dispo erreichbar ist.');
      await refreshAbrechnungNativeUi(false);
    } catch (e) {
      window.alert((e && e.message) ? e.message : String(e));
    }
  }

  async function loadAbrechnungJobsIntoSelect(period) {
    var tid = getTechId();
    var sel = document.getElementById('abrechnungJobSelect');
    if (!sel) return;
    var prev = sel.value;
    var r = await fetch(API_BASE + '/api/abrechnung/jobs?' + qs({ technician_id: tid, period: period }), { headers: abrechnungAuthHeaders() });
    var j = await r.json();
    abrechnungCurrentJobs = (j && j.jobs) ? j.jobs : [];
    sel.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = abrechnungCurrentJobs.length ? '— Auftrag wählen —' : '— Keine Aufträge im Cache (Monat abgleichen) —';
    sel.appendChild(opt0);
    abrechnungCurrentJobs.forEach(function (job) {
      var o = document.createElement('option');
      o.value = String(job.id);
      o.textContent = job.label || ('#' + job.id);
      sel.appendChild(o);
    });
    if (prev && abrechnungCurrentJobs.some(function (x) { return String(x.id) === prev; })) sel.value = prev;
  }

  async function loadAbrechnungBundleForSelection() {
    var sel = document.getElementById('abrechnungJobSelect');
    var jid = sel && sel.value ? parseInt(sel.value, 10) : 0;
    var nd = document.getElementById('abrechnungNoteDispo');
    var nb = document.getElementById('abrechnungNoteBuch');
    var cd = document.getElementById('abrechnungCommentsDispo');
    var cb = document.getElementById('abrechnungCommentsBuch');
    var fd = document.getElementById('abrechnungFilesDispo');
    var fb = document.getElementById('abrechnungFilesBuch');
    var meta = document.getElementById('abrechnungJobMeta');
    var sd = document.getElementById('btnAbrechnungSaveDispo');
    var sb = document.getElementById('btnAbrechnungSaveBuch');
    var ud = document.getElementById('abrechnungUploadDispo');
    var ub = document.getElementById('abrechnungUploadBuch');
    var job = abrechnungSelectedJobObj();
    var canWrite = abrechnungEffectiveCanWrite(job);

    if (!jid) {
      if (cd) cd.innerHTML = '';
      if (cb) cb.innerHTML = '';
      if (nd) { nd.value = ''; nd.disabled = true; }
      if (nb) { nb.value = ''; nb.disabled = true; }
      if (fd) fd.innerHTML = '';
      if (fb) fb.innerHTML = '';
      if (sd) sd.disabled = true;
      if (sb) sb.disabled = true;
      if (ud) { ud.disabled = true; ud.value = ''; }
      if (ub) { ub.disabled = true; ub.value = ''; }
      if (meta) meta.textContent = '';
      return;
    }

    var tid = getTechId();
    var bundleQs = { technician_id: tid, job_server_id: jid };
    var baseDispo = (getDispoBaseUrl() || '').trim();
    if (baseDispo) bundleQs.base_url = baseDispo;
    var uAuth = getDispoUsername();
    var pAuth = getDispoPassword();
    if (uAuth != null && String(uAuth).trim() !== '') {
      bundleQs.serverUsername = String(uAuth).trim();
      bundleQs.serverPassword = pAuth != null ? String(pAuth) : '';
    }
    var r = await fetch(API_BASE + '/api/abrechnung/bundle?' + qs(bundleQs), { headers: abrechnungAuthHeaders() });
    var j = await r.json();
    if (!j.ok) {
      if (meta) meta.textContent = j.error || 'Daten konnten nicht geladen werden.';
      return;
    }
    var metaParts = [];
    metaParts.push(canWrite ? 'Bearbeitung für diesen Auftrag erlaubt.' : 'Nur Lesen: Auftrag nicht zur Bearbeitung freigegeben.');
    if (j.job_id_for_dispo != null && parseInt(j.job_id_for_dispo, 10) !== jid) {
      metaParts.push('Dispo-Auftrags-ID ' + j.job_id_for_dispo + ' (Auswahl ' + jid + ').');
    }
    var fc = Array.isArray(j.files) ? j.files.length : 0;
    if (fc === 0 && j.dispo_files_error) {
      metaParts.push('Dateien von Dispo: ' + j.dispo_files_error);
    }
    if (j.dispo_comments_error) {
      metaParts.push('Kommentare von Dispo: ' + j.dispo_comments_error);
    }
    if (meta) meta.textContent = metaParts.join(' ');
    var comments = j.comments || { dispo: [], buchhaltung: [] };
    renderAbrechnungCommentList(cd, comments.dispo);
    renderAbrechnungCommentList(cb, comments.buchhaltung);
    if (nd) { nd.value = ''; nd.placeholder = 'Neuen Kommentar …'; nd.disabled = !canWrite; }
    if (nb) { nb.value = ''; nb.placeholder = 'Neuen Kommentar …'; nb.disabled = !canWrite; }
    renderAbrechnungFileList(fd, 'dispo', j.files, jid, canWrite);
    renderAbrechnungFileList(fb, 'buchhaltung', j.files, jid, canWrite);
    if (sd) sd.disabled = !canWrite;
    if (sb) sb.disabled = !canWrite;
    if (ud) ud.disabled = !canWrite;
    if (ub) ub.disabled = !canWrite;
  }

  async function refreshAbrechnungNativeUi(withServerSync) {
    var view = document.getElementById('viewAbrechnung');
    if (!view || !view.classList.contains('active')) return;
    var periodEl = document.getElementById('abrechnungPeriod');
    var period = (periodEl && periodEl.value) ? periodEl.value : new Date().toISOString().slice(0, 7);
    var tid = getTechId();
    var meta = document.getElementById('abrechnungJobMeta');
    if (!tid) {
      if (meta) meta.textContent = 'Monteur-ID fehlt — bitte unter Einstellungen setzen.';
      return;
    }
    var base = (getDispoBaseUrl() || '').trim();
    if (withServerSync && base && typeof navigator !== 'undefined' && navigator.onLine !== false) {
      try {
        var selEl = document.getElementById('abrechnungJobSelect');
        var selId = selEl && selEl.value ? parseInt(selEl.value, 10) : 0;
        var r = await fetch(API_BASE + '/api/background_jobs', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, abrechnungAuthHeaders()),
          body: JSON.stringify({
            type: 'abrechnung_refresh',
            payload: abrechnungBody({ period_ym: period, job_server_id: selId > 0 ? selId : 0 }),
            dedupe_key: 'abrechnung_refresh:' + tid + ':' + period
          })
        });
        var dj = await r.json();
        if (!dj.ok) throw new Error(dj.error || 'Abgleich-Job konnte nicht gestartet werden.');
        if (!dj.job_id) throw new Error('Keine job_id vom Server.');
        var fj = await pollBackgroundJobUntilTerminal(dj.job_id, null, {});
        if (fj.status !== 'completed') throw new Error(fj.error || fj.message || 'Abgleich fehlgeschlagen.');
        var chk = fj.checkpoint && typeof fj.checkpoint === 'object' ? fj.checkpoint : {};
        var partial = !!chk.abrechnung_partial;
        if (typeof showToast === 'function') {
          showToast(
            partial
              ? 'Abrechnung aktualisiert (teilweise nur lokaler Stand — gleicher Datenbestand wie Kalender/Dienstreise).'
              : 'Abrechnung mit Dispo abgeglichen.'
          );
        }
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        if (typeof showToast === 'function') showToast('Abgleich: ' + msg);
        else window.alert('Abgleich: ' + msg);
      }
    } else if (withServerSync && !base) {
      if (typeof showToast === 'function') showToast('Keine Dispo-URL — nur lokaler Cache.');
    }
    await updateAbrechnungStatusLine();
    try {
      await loadAbrechnungJobsIntoSelect(period);
      await loadAbrechnungBundleForSelection();
    } catch (e) {
      if (meta) meta.textContent = (e && e.message) ? e.message : String(e);
    }
  }

  async function abrechnungSaveNote(bucket) {
    var sel = document.getElementById('abrechnungJobSelect');
    var jid = sel && sel.value ? parseInt(sel.value, 10) : 0;
    var ta = bucket === 'dispo' ? document.getElementById('abrechnungNoteDispo') : document.getElementById('abrechnungNoteBuch');
    if (!jid || !ta) return;
    try {
      var r = await fetch(API_BASE + '/api/abrechnung/note', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, abrechnungAuthHeaders()),
        body: JSON.stringify(abrechnungBody({ job_server_id: jid, bucket: bucket, body: ta.value }))
      });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Speichern fehlgeschlagen');
      if (j.queued && typeof showToast === 'function') showToast('Kommentar lokal gespeichert; Sync bei Verbindung.');
      else if (typeof showToast === 'function') showToast('Kommentar gespeichert.');
      await updateAbrechnungStatusLine();
      await loadAbrechnungBundleForSelection();
    } catch (e) {
      window.alert((e && e.message) ? e.message : String(e));
    }
  }

  function wireAbrechnungFileUpload(inputId, bucket) {
    var inp = document.getElementById(inputId);
    if (!inp) return;
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var sel = document.getElementById('abrechnungJobSelect');
      var jid = sel && sel.value ? parseInt(sel.value, 10) : 0;
      if (!jid) return;
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result;
        var b64 = typeof dataUrl === 'string' && dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : '';
        fetch(API_BASE + '/api/abrechnung/upload', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, abrechnungAuthHeaders()),
          body: JSON.stringify(abrechnungBody({
            job_server_id: jid,
            bucket: bucket,
            filename: f.name,
            content_base64: b64
          }))
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            inp.value = '';
            if (!j.ok) throw new Error(j.error || 'Upload fehlgeschlagen');
            if (j.queued && typeof showToast === 'function') showToast('Upload eingereiht (wird synchronisiert).');
            return refreshAbrechnungNativeUi(false);
          })
          .catch(function (e) {
            inp.value = '';
            window.alert((e && e.message) ? e.message : String(e));
          });
      };
      reader.readAsDataURL(f);
    });
  }

  /** HTTP Basic an den lokalen Electron-Server (127.0.0.1) – Passwort nicht in der URL. */
  function dispoBasicAuthHeaders(getUserFn, getPassFn) {
    var u = (getUserFn && typeof getUserFn === 'function' ? getUserFn() : '') || '';
    u = String(u).trim();
    var p = getPassFn && typeof getPassFn === 'function' ? getPassFn() : '';
    p = p != null ? String(p) : '';
    if (!u) return {};
    try {
      return { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(u + ':' + p))) };
    } catch (e) {
      return { Authorization: 'Basic ' + btoa(u + ':' + p) };
    }
  }

  async function api(path, opts = {}) {
    const techId = getTechId();
    const url = API_BASE + path + (path.includes('?') ? '&' : '?') + (techId ? 'technician_id=' + techId : '');
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId), ...opts.headers },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = data.error || res.statusText || 'Anfrage fehlgeschlagen';
      if (res.status === 404 && String(path).indexOf('anlagenstamm_search') !== -1) {
        msg = 'Lokaler Server: Route nicht gefunden (404). Bitte die Monteur-App vollständig beenden (auch aus dem Infobereich) und neu starten – oder Installer/Update einspielen, damit der aktuelle Electron-Server mit Anlagenstamm-Suche geladen wird.';
      }
      if (res.status === 404 && String(path).indexOf('anlagenstamm_save') !== -1) {
        msg = 'Lokaler Server: Route nicht gefunden (404). Bitte die Monteur-App vollständig beenden (auch aus dem Infobereich) und neu starten – oder Installer/Update einspielen, damit der aktuelle Electron-Server mit Anlagenstamm-Speichern geladen wird.';
      }
      throw new Error(msg);
    }
    return data;
  }

  function monteurBridge() {
    try {
      if (typeof monteurApp !== 'undefined' && monteurApp) return monteurApp;
      if (typeof window !== 'undefined' && window.monteurApp) return window.monteurApp;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * IPC-Antwort vom Main-Prozess: ok kann fehlen, wenn nur rows geliefert wird.
   */
  function normalizeAnlagenstammSearchResponse(d) {
    if (!d || typeof d !== 'object') throw new Error('Suche fehlgeschlagen');
    if (d.ok === false) throw new Error(d.error ? d.error : 'Suche fehlgeschlagen');
    applyDispoUsedBaseUrl(d);
    if (d.ok === true) {
      if ('_httpStatus' in d) delete d._httpStatus;
      return d;
    }
    if (Array.isArray(d.rows)) {
      if ('_httpStatus' in d) delete d._httpStatus;
      return d;
    }
    throw new Error(d.error ? d.error : 'Suche fehlgeschlagen');
  }

  function normalizeAnlagenstammSaveResponse(d) {
    if (!d || typeof d !== 'object') throw new Error('Speichern fehlgeschlagen');
    if (d.ok === false) throw new Error(d.error ? d.error : 'Speichern fehlgeschlagen');
    applyDispoUsedBaseUrl(d);
    if (d.ok !== true && d.id == null) {
      throw new Error(d.error ? d.error : 'Speichern fehlgeschlagen');
    }
    if ('_httpStatus' in d) delete d._httpStatus;
    return d;
  }

  /**
   * Anlagenstamm: lokal-first (SQLite + pending_changes), Dispo-IPC nur als Fallback.
   */
  async function anlagenstammSearchDispo(payload) {
    var body = Object.assign({}, payload, { technician_id: getTechId() });
    try {
      return normalizeAnlagenstammSearchResponse(
        await api('/api/anlagenstamm_search', { method: 'POST', body: JSON.stringify(body) }),
      );
    } catch (localErr) {
      var ma = monteurBridge();
      if (ma) {
        if (typeof ma.ipcInvoke === 'function') {
          return normalizeAnlagenstammSearchResponse(await ma.ipcInvoke('anlagenstamm:search', body));
        }
        if (typeof ma.anlagenstammSearch === 'function') {
          return normalizeAnlagenstammSearchResponse(await ma.anlagenstammSearch(body));
        }
      }
      throw localErr;
    }
  }

  async function anlagenstammSaveDispo(payload) {
    var body = Object.assign({}, payload, { technician_id: getTechId() });
    try {
      return normalizeAnlagenstammSaveResponse(
        await api('/api/anlagenstamm_save', { method: 'POST', body: JSON.stringify(body) }),
      );
    } catch (localErr) {
      var ma = monteurBridge();
      if (ma) {
        if (typeof ma.ipcInvoke === 'function') {
          return normalizeAnlagenstammSaveResponse(await ma.ipcInvoke('anlagenstamm:save', body));
        }
        if (typeof ma.anlagenstammSave === 'function') {
          return normalizeAnlagenstammSaveResponse(await ma.anlagenstammSave(body));
        }
      }
      var hint = (localErr && localErr.message) ? localErr.message : String(localErr);
      throw new Error(
        'Lokal speichern fehlgeschlagen: ' + hint + ' — Monteur-App vollständig beenden und neu starten.',
      );
    }
  }

  /** Ländername (DE) oder Bezeichnung → ISO-2-Code für Flagge und Zeitverschiebung. */
  var countryNameToCode = {
    Neukaledonien: 'NC', 'Französisch-Polynesien': 'PF', 'Wallis und Futuna': 'WF',
    Réunion: 'RE', Mayotte: 'YT', Martinique: 'MQ', Guadeloupe: 'GP',
    'Saint-Martin': 'MF', 'Saint Martin': 'MF', 'Saint‑Martin': 'MF',
    'Saint-Barthélemy': 'BL', 'Saint Barthélemy': 'BL',
    'Saint-Pierre und Miquelon': 'PM',
    Anguilla: 'AI', Bermuda: 'BM', 'Britische Jungferninseln': 'VG', 'Kaimaninseln': 'KY',
    Falklandinseln: 'FK', Montserrat: 'MS', 'Turks- und Caicosinseln': 'TC',
    Gibraltar: 'GI', 'Saint Helena, Ascension und Tristan da Cunha': 'SH', 'St. Helena': 'SH',
    Pitcairninseln: 'PN', 'Britisches Territorium im Indischen Ozean': 'IO',
    'Südgeorgien und die Südlichen Sandwichinseln': 'GS', 'Puerto Rico': 'PR',
    Guam: 'GU', 'Amerikanisch-Samoa': 'AS', 'Amerikanische Jungferninseln': 'VI',
    'Nördliche Marianen': 'MP', 'Wake Island': 'UM', Midwayinseln: 'UM', 'Johnston-Atoll': 'UM',
    'Navassa Island': 'UM', Kingmanriff: 'UM', 'Palmyra-Atoll': 'UM',
    Grönland: 'GL', 'Färöer Inseln': 'FO', 'Färöer': 'FO',
    Aruba: 'AW', Curaçao: 'CW', 'Curaçao': 'CW', 'Sint Maarten': 'SX',
    Bonaire: 'BQ', 'Sint Eustatius': 'BQ', Saba: 'BQ',
    Norfolkinsel: 'NF', 'Weihnachtsinsel': 'CX', 'Cocos (Keeling)-Inseln': 'CC',
    'Cocos-Inseln': 'CC', 'Heard und McDonaldinseln': 'HM',
    Tokelau: 'TK', 'Cookinseln': 'CK', 'Cookinseln (frei assoziiert)': 'CK',
    'Niue': 'NU', 'Niue (frei assoziiert)': 'NU',
    'Ross-Abhängigkeit': 'AQ', 'Ross-Abhängigkeit (Antarktis)': 'AQ',
    Hongkong: 'HK', 'Hong Kong': 'HK', Macau: 'MO', 'Macao': 'MO',
    Åland: 'AX', 'Åland (Finnland)': 'AX', Aland: 'AX',
    Südtirol: 'IT', 'Südtirol (Italien)': 'IT', Zanzibar: 'TZ', 'Zanzibar (Tansania)': 'TZ',
    Azoren: 'PT', 'Azoren (Portugal)': 'PT', Madeira: 'PT', 'Madeira (Portugal)': 'PT',
    'Kanarische Inseln': 'ES', 'Kanaren': 'ES', 'Kanarische Inseln (Spanien)': 'ES',
    Ceuta: 'ES', 'Ceuta (Spanien)': 'ES', Melilla: 'ES', 'Melilla (Spanien)': 'ES'
  };

  function normalizeCountryToCode(country) {
    if (!country || typeof country !== 'string') return '';
    var s = country.trim();
    if (s.length === 2 && /^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
    if (s.length === 3 && /^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
    var key = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    if (countryNameToCode[s]) return countryNameToCode[s];
    if (countryNameToCode[key]) return countryNameToCode[key];
    for (var n in countryNameToCode) { if (s.toLowerCase() === n.toLowerCase()) return countryNameToCode[n]; }
    return s.slice(0, 2).toUpperCase();
  }

  function countryFlagImg(code) {
    var c = (code && code.length === 2) ? code : normalizeCountryToCode(code);
    if (!c || c.length !== 2) return '';
    c = c.toLowerCase();
    if (!/^[a-z]{2}$/.test(c)) return '';
    return '<img src="flags/' + c + '.png" alt="" class="job-flag" width="20" height="15" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  /** Auftrag mit Status „angelegt“ (nur Anzeige, außer Fabrikationsnummern-Zeile). Legacy: „geplant“. */
  function isJobAngelegtReadOnly(job) {
    if (!job || typeof job !== 'object') return false;
    var s = String(job.status || '').trim().toLowerCase();
    return s === 'angelegt' || s === 'geplant';
  }

  /** Fabrikationsnummern dürfen auch bei angelegt/geplant/zugeteilt bearbeitet werden. */
  function canEditProjektdatenFabrikationsnummern(job) {
    if (!job || typeof job !== 'object') return false;
    var s = String(job.status || '').trim().toLowerCase();
    return s !== 'abgerechnet';
  }

  /** Button „Auftrag annehmen“ (wie Server: angelegt / geplant / zugeteilt). */
  function jobCanAcceptJob(job) {
    if (!job || typeof job !== 'object') return false;
    var s = String(job.status || '').trim().toLowerCase();
    return s === 'angelegt' || s === 'geplant' || s === 'zugeteilt';
  }

  var acceptJobStreamBusy = false;
  /** @type {number | null} */
  var acceptJobActiveLocalJobId = null;
  /** Letzter Poll-Stand, damit nach erneutem Rendern der Liste der Balken wiederhergestellt werden kann. */
  var acceptJobLastProgressRow = null;
  /** @type {HTMLButtonElement | null} */
  var acceptJobActiveButton = null;
  var acceptJobUiTimeoutId = null;
  var restoreAcceptJobBgFetchInFlight = false;

  function finishAcceptJobStreamUi() {
    acceptJobStreamBusy = false;
    acceptJobActiveLocalJobId = null;
    acceptJobLastProgressRow = null;
    acceptJobActiveButton = null;
    if (acceptJobUiTimeoutId) {
      clearTimeout(acceptJobUiTimeoutId);
      acceptJobUiTimeoutId = null;
    }
    var wrap = document.getElementById('acceptJobProgressWrap');
    var lbl = document.getElementById('acceptJobProgressLabel');
    if (wrap) wrap.style.display = 'none';
    if (lbl) lbl.textContent = '';
    document.querySelectorAll('[data-action="accept-job"]').forEach(function (b) {
      b.disabled = false;
      b.classList.remove('btn-accept-job--busy');
      b.removeAttribute('aria-busy');
      b.style.pointerEvents = '';
      var bar = b.querySelector('.btn-accept-job-progress');
      if (bar) {
        try {
          bar.indeterminate = false;
        } catch (e) {}
        bar.removeAttribute('value');
        bar.setAttribute('max', '100');
        bar.value = 0;
      }
    });
  }

  /** Nach Abschluss des Background-Jobs (normal oder nach App-Neustart). */
  function handleAcceptJobPollFinished(localJobId, j, hint) {
    var chk = j.checkpoint && typeof j.checkpoint === 'object' ? j.checkpoint : {};
    var warn = chk.status_sync_warning;
    if (j.status === 'completed') {
      var doneMsg = 'Auftrag angenommen.';
      if (warn) doneMsg += ' Hinweis: ' + String(warn);
      if (hint) hint.textContent = doneMsg;
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
      if (getDienstreiseExplorerJobId() == localJobId && typeof loadDienstreiseExplorer === 'function') {
        if (startPageActiveJobId == localJobId) {
          loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start');
        } else {
          loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal');
        }
      }
      if (jobDetailsJobId == localJobId && typeof openJobDetailsModal === 'function') {
        openJobDetailsModal(localJobId);
      }
      setTimeout(function () {
        var x = document.getElementById('acceptJobHint');
        if (x && (!warn || !x.textContent.includes('Hinweis:'))) x.textContent = '';
      }, warn ? 8000 : 4000);
    } else {
      if (hint) hint.textContent = j.error || j.message || 'Auftrag annehmen fehlgeschlagen.';
    }
  }

  /**
   * Nach Neustart: RAM-Zustand leer, aber SQLite kann noch queued/running/interrupted
   * dienstreise_pull mit accept_job haben — UI und Polling wieder anbinden.
   */
  function restoreAcceptJobStreamFromBackgroundJobs() {
    if (acceptJobStreamBusy || restoreAcceptJobBgFetchInFlight) return;
    restoreAcceptJobBgFetchInFlight = true;
    fetch(API_BASE + '/api/background_jobs?active=1&limit=25')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.jobs)) return;
        var jobs = data.jobs;
        var accepts = [];
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (!j || j.type !== 'dienstreise_pull') continue;
          var p = j.payload;
          if (!p || !p.accept_job) continue;
          var st = j.status;
          if (st !== 'queued' && st !== 'running' && st !== 'interrupted') continue;
          accepts.push(j);
        }
        if (!accepts.length) return;
        accepts.sort(function (a, b) {
          var pr = { running: 3, queued: 2, interrupted: 1 };
          var pa = pr[a.status] || 0;
          var pb = pr[b.status] || 0;
          if (pb !== pa) return pb - pa;
          return 0;
        });
        var bg = accepts[0];
        var localId = parseInt(bg.payload.job_id, 10);
        if (!localId) return;
        var hint = document.getElementById('acceptJobHint');
        acceptJobStreamBusy = true;
        acceptJobActiveLocalJobId = localId;
        acceptJobLastProgressRow = {
          progress_phase: bg.progress_phase,
          progress_current: bg.progress_current,
          progress_total: bg.progress_total,
          message: bg.message
        };
        acceptJobActiveButton = null;
        if (hint) hint.textContent = '';
        var progressWrap = document.getElementById('acceptJobProgressWrap');
        if (progressWrap) progressWrap.style.display = 'none';
        applyAcceptJobStreamBusyUi();
        updateAcceptJobButtonProgress({
          progress_phase: bg.progress_phase,
          progress_current: bg.progress_current,
          progress_total: bg.progress_total,
          message: bg.message
        });
        acceptJobUiTimeoutId = setTimeout(function () {
          acceptJobUiTimeoutId = null;
          finishAcceptJobStreamUi();
          var h = document.getElementById('acceptJobHint');
          if (h) {
            h.textContent = 'Zeitüberschreitung – Auftrag annehmen. Bitte erneut versuchen.';
            setTimeout(function () {
              var x = document.getElementById('acceptJobHint');
              if (x) x.textContent = '';
            }, 5000);
          }
        }, 600000);
        pollBackgroundJobUntilTerminal(bg.id, function (j) {
          updateAcceptJobButtonProgress(j);
        })
          .then(function (j) {
            if (acceptJobUiTimeoutId) {
              clearTimeout(acceptJobUiTimeoutId);
              acceptJobUiTimeoutId = null;
            }
            finishAcceptJobStreamUi();
            handleAcceptJobPollFinished(localId, j, hint);
          })
          .catch(function (err) {
            if (acceptJobUiTimeoutId) {
              clearTimeout(acceptJobUiTimeoutId);
              acceptJobUiTimeoutId = null;
            }
            finishAcceptJobStreamUi();
            if (hint) hint.textContent = err && err.message ? err.message : 'Fehler beim Annehmen.';
          });
      })
      .catch(function () {})
      .finally(function () {
        restoreAcceptJobBgFetchInFlight = false;
      });
  }

  function resolveAcceptJobActiveButton() {
    var btn = acceptJobActiveButton;
    if (btn && typeof btn.isConnected === 'boolean' && btn.isConnected) return btn;
    var lid = acceptJobActiveLocalJobId;
    if (lid == null) return null;
    var jobEl = document.querySelector('#dienstreiseList .job[data-job-id="' + String(lid) + '"]');
    btn = jobEl ? jobEl.querySelector('[data-action="accept-job"]') : null;
    acceptJobActiveButton = btn;
    return btn;
  }

  /** Während accept_job_stream: Busy-Zustand auf alle Annahme-Buttons; aktiver Auftrag per ID. */
  function applyAcceptJobStreamBusyUi() {
    var activeId = acceptJobActiveLocalJobId;
    acceptJobActiveButton = null;
    document.querySelectorAll('[data-action="accept-job"]').forEach(function (b) {
      var row = b.closest('.job');
      var jid = row ? parseInt(row.getAttribute('data-job-id'), 10) : NaN;
      if (activeId != null && jid === activeId) {
        acceptJobActiveButton = b;
        b.classList.add('btn-accept-job--busy');
        b.setAttribute('aria-busy', 'true');
        b.style.pointerEvents = 'none';
        b.disabled = false;
        var t = b.querySelector('.btn-accept-job-progress-text');
        var bar = b.querySelector('.btn-accept-job-progress');
        if (t && !acceptJobLastProgressRow) t.textContent = 'Dispo wird aktualisiert …';
        if (bar && !acceptJobLastProgressRow) {
          try {
            bar.indeterminate = true;
          } catch (e) {}
        }
      } else {
        b.disabled = true;
      }
    });
  }

  function updateAcceptJobButtonProgress(jobRow) {
    if (!jobRow || typeof jobRow !== 'object') return;
    acceptJobLastProgressRow = {
      progress_phase: jobRow.progress_phase,
      progress_current: jobRow.progress_current,
      progress_total: jobRow.progress_total,
      message: jobRow.message
    };
    var btn = resolveAcceptJobActiveButton();
    if (!btn) return;
    var lbl = btn.querySelector('.btn-accept-job-progress-text');
    var bar = btn.querySelector('.btn-accept-job-progress');
    if (!lbl || !bar) return;
    var phase = (jobRow.progress_phase || '').toString();
    var cur = jobRow.progress_current != null ? jobRow.progress_current : 0;
    var tot = jobRow.progress_total != null ? jobRow.progress_total : 0;
    var msg = jobRow.message ? String(jobRow.message) : '';

    if (phase === 'refresh' || phase === 'start') {
      lbl.textContent = msg || 'Dispo wird aktualisiert …';
      try {
        bar.indeterminate = true;
      } catch (e) {}
    } else if (phase === 'refresh_done' || phase === 'manifest') {
      lbl.textContent = msg || 'Unterlagen werden vorbereitet …';
      try {
        bar.indeterminate = true;
      } catch (e) {}
    } else if (phase === 'download' || phase === 'file') {
      lbl.textContent = msg && String(msg).trim() ? String(msg) : 'Unterlagen werden geladen …';
      if (tot > 0) {
        try {
          bar.indeterminate = false;
        } catch (e2) {}
        bar.max = tot;
        bar.value = Math.min(cur, tot);
      } else {
        try {
          bar.indeterminate = true;
        } catch (e3) {}
      }
    } else if (msg) {
      lbl.textContent = msg;
    }
  }

  function validateAcceptJobPrerequisites(localJobId) {
    if (!localJobId) return 'Bitte einen Auftrag wählen.';
    if (!getTechId()) return 'Bitte Monteur-ID in Einstellungen eintragen.';
    if (!(getDispoBaseUrl() || '').trim()) return 'Bitte Dispo-URL in Einstellungen eintragen.';
    if (!getDispoUsername() || !getDispoPassword()) {
      return 'Dispo-Zugangsdaten fehlen: Benutzername und Passwort in den Einstellungen eintragen.';
    }
    var snap = getDienstreiseJobSnapshotByLocalId(localJobId);
    if (!jobCanAcceptJob(snap)) return 'Auftrag kann nur im Status Angelegt oder Zugeteilt angenommen werden.';
    return null;
  }

  function runAcceptJobStream(localJobId, triggerButton) {
    if (acceptJobStreamBusy) return;
    var errMsg = validateAcceptJobPrerequisites(localJobId);
    var hint = document.getElementById('acceptJobHint');
    if (errMsg) {
      if (hint) hint.textContent = errMsg;
      return;
    }
    acceptJobStreamBusy = true;
    acceptJobActiveLocalJobId = localJobId;
    acceptJobLastProgressRow = null;
    acceptJobActiveButton = triggerButton && triggerButton.nodeType === 1 ? triggerButton : null;
    if (hint) hint.textContent = '';
    var progressWrap = document.getElementById('acceptJobProgressWrap');
    if (progressWrap) progressWrap.style.display = 'none';

    applyAcceptJobStreamBusyUi();

    var body = {
      job_id: localJobId,
      dispoBaseUrl: getDispoBaseUrl(),
      technicianId: getTechId(),
      dispoUsername: getDispoUsername(),
      dispoPassword: getDispoPassword(),
      include_bilder: false
    };
    var copyTimeoutMs = 600000;
    acceptJobUiTimeoutId = setTimeout(function () {
      acceptJobUiTimeoutId = null;
      finishAcceptJobStreamUi();
      if (hint) {
        hint.textContent = 'Zeitüberschreitung – Dispo-Antwort kam nicht. Bitte erneut versuchen.';
        setTimeout(function () { var x = document.getElementById('acceptJobHint'); if (x) x.textContent = ''; }, 5000);
      }
    }, copyTimeoutMs);

    fetch(API_BASE + '/api/dienstreise/accept_job_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        if (!response.ok) {
          if (acceptJobUiTimeoutId) {
            clearTimeout(acceptJobUiTimeoutId);
            acceptJobUiTimeoutId = null;
          }
          return response.json().then(function (data) {
            throw new Error((data && data.error) || 'Fehler ' + response.status);
          });
        }
        if (response.status === 202) {
          return response.json().then(function (data) {
            var jobId = data && data.job_id;
            if (!jobId) throw new Error('Keine job_id vom Server.');
            return pollBackgroundJobUntilTerminal(jobId, function (j) {
              updateAcceptJobButtonProgress(j);
            }).then(function (j) {
              if (acceptJobUiTimeoutId) {
                clearTimeout(acceptJobUiTimeoutId);
                acceptJobUiTimeoutId = null;
              }
              finishAcceptJobStreamUi();
              handleAcceptJobPollFinished(localJobId, j, hint);
            });
          });
        }
        if (acceptJobUiTimeoutId) {
          clearTimeout(acceptJobUiTimeoutId);
          acceptJobUiTimeoutId = null;
        }
        throw new Error('Unerwartete Server-Antwort (Status ' + response.status + ').');
      })
      .catch(function (err) {
        if (acceptJobUiTimeoutId) {
          clearTimeout(acceptJobUiTimeoutId);
          acceptJobUiTimeoutId = null;
        }
        finishAcceptJobStreamUi();
        if (hint) hint.textContent = err && err.message ? err.message : 'Fehler beim Annehmen.';
      });
  }

  /** CSS-Klasse status-* (geplant aus Cache wird wie angelegt gemappt). */
  function jobStatusBadgeClass(statusRaw) {
    var s = String(statusRaw || 'angelegt').trim().toLowerCase().replace(/\s+/g, '_');
    if (s === 'geplant') return 'angelegt';
    return s;
  }

  /** Kurzlabel fuer Anzeige (nicht die internen Langtexte). */
  function jobStatusDisplayLabel(statusRaw) {
    var s = String(statusRaw || '').trim().toLowerCase();
    if (s === 'geplant' || s === 'angelegt') return 'Angelegt';
    if (s === 'zugeteilt') return 'Zugeteilt';
    if (s === 'in_arbeit') return 'In Arbeit';
    if (s === 'erledigt') return 'Erledigt';
    if (s === 'abgerechnet') return 'Abgerechnet';
    return statusRaw ? String(statusRaw) : 'Angelegt';
  }

  /** Rohliste vom Dispo (jobs_open), für clientseitige Filter unter „Offene Aufträge“. */
  var cachedOpenJobs = [];

  function isJobErledigtForOpenList(job) {
    var v = '';
    if (job && job.status != null) v = job.status;
    else if (job && job.job_status != null) v = job.job_status;
    var raw = String(v || '')
      .trim()
      .toLowerCase();
    return raw === 'erledigt' || raw === 'abgerechnet' || raw === 'completed' || raw === 'done' || raw === 'fertig';
  }

  function isJobAbgerechnet(job) {
    if (!job || typeof job !== 'object') return false;
    return String(job.status || '').trim().toLowerCase() === 'abgerechnet';
  }

  function jobHasNoDateForOpenFilter(job) {
    if (!job || typeof job !== 'object') return false;
    var s = job.start_datetime && String(job.start_datetime).trim() ? String(job.start_datetime).trim().slice(0, 10) : '';
    var e = job.end_datetime && String(job.end_datetime).trim() ? String(job.end_datetime).trim().slice(0, 10) : '';
    return !s && !e;
  }

  function jobHasNoTechnicianForOpenFilter(job) {
    if (!job || typeof job !== 'object') return false;
    var ac = job.assigned_count;
    if (ac != null && String(ac).trim() !== '') {
      var n = parseInt(String(ac), 10);
      return !isNaN(n) && n === 0;
    }
    var req = job.required_technicians;
    if (req != null && String(req).trim() !== '') {
      var r = parseInt(String(req), 10);
      if (!isNaN(r) && r > 0) return false;
    }
    return false;
  }

  function anyOpenJobFilterChecked() {
    var cbNoDate = document.getElementById('openJobsFilterNoDate');
    var cbNoTech = document.getElementById('openJobsFilterNoTech');
    var cbAlle = document.getElementById('openJobsFilterAlleNonErledigt');
    return Boolean(
      (cbNoDate && cbNoDate.checked) ||
      (cbNoTech && cbNoTech.checked) ||
      (cbAlle && cbAlle.checked)
    );
  }

  /** Einsatzdatum aufsteigend; ohne Datum ans Ende, bei gleichem Datum nach id. */
  function sortOpenJobsByEinsatzdatumAsc(jobs) {
    var arr = Array.isArray(jobs) ? jobs.slice() : [];
    function sortKey(job) {
      var s = job.start_datetime && String(job.start_datetime).trim()
        ? String(job.start_datetime).trim().slice(0, 10)
        : '';
      var e = job.end_datetime && String(job.end_datetime).trim()
        ? String(job.end_datetime).trim().slice(0, 10)
        : '';
      var d = s || e;
      if (!d) return { noDate: 1, ymd: '9999-12-31', id: Number(job.id) || 0 };
      return { noDate: 0, ymd: d, id: Number(job.id) || 0 };
    }
    arr.sort(function (a, b) {
      var ka = sortKey(a);
      var kb = sortKey(b);
      if (ka.noDate !== kb.noDate) return ka.noDate - kb.noDate;
      if (ka.ymd !== kb.ymd) return ka.ymd < kb.ymd ? -1 : ka.ymd > kb.ymd ? 1 : 0;
      return ka.id - kb.id;
    });
    return arr;
  }

  var startPageActiveJobId = null;
  var startPageActiveJobSnapshot = null;

  function isStartViewVisible() {
    var el = document.getElementById('viewStart');
    return el && !el.classList.contains('hidden');
  }

  function pickStartActiveJob(jobs) {
    var arr = Array.isArray(jobs) ? jobs : [];
    var open = arr.filter(function (j) {
      return j && !isJobErledigtForOpenList(j);
    });
    if (!open.length) return null;
    var inArbeit = open.filter(function (j) {
      return String(j.status || '').trim().toLowerCase() === 'in_arbeit';
    });
    if (inArbeit.length) {
      return sortOpenJobsByEinsatzdatumAsc(inArbeit)[0];
    }
    return sortOpenJobsByEinsatzdatumAsc(open)[0];
  }

  /** Nur Baustellen-Ansprechpartner (job_contacts / baustellen_ansprechpartner), nicht Kundenkontakt. */
  function getBaustellenContactsForJob(job) {
    if (!job || typeof job !== 'object') return [];
    var out = [];
    if (Array.isArray(job.job_contacts)) {
      job.job_contacts.forEach(function (c) {
        var name = (c && (c.contact_name || c.contactName)) ? String(c.contact_name || c.contactName).trim() : '';
        var phone = (c && (c.contact_phone || c.contactPhone)) ? String(c.contact_phone || c.contactPhone).trim() : '';
        var email = (c && (c.contact_email || c.contactEmail)) ? String(c.contact_email || c.contactEmail).trim() : '';
        if (name || phone || email) {
          out.push({ contact_name: name, contact_phone: phone, contact_email: email });
        }
      });
    }
    if (out.length) return out;
    var bName = job.baustellen_ansprechpartner != null ? String(job.baustellen_ansprechpartner).trim() : '';
    var bPhone =
      job.job_contact_phone != null
        ? String(job.job_contact_phone).trim()
        : job.baustelle_phone != null
          ? String(job.baustelle_phone).trim()
          : '';
    var bEmail =
      job.job_contact_email != null
        ? String(job.job_contact_email).trim()
        : job.baustelle_email != null
          ? String(job.baustelle_email).trim()
          : '';
    if (bName || bPhone || bEmail) {
      out.push({ contact_name: bName, contact_phone: bPhone, contact_email: bEmail });
    }
    return out;
  }

  function renderStartJobContactsHtml(job) {
    var lines = [];
    getBaustellenContactsForJob(job).forEach(function (c) {
      var name = (c.contact_name || '').trim();
      var phone = (c.contact_phone || '').trim();
      var email = (c.contact_email || '').trim();
      if (!name && !phone && !email) return;
      var parts = [];
      if (name) parts.push(escapeHtml(name));
      if (phone) parts.push(escapeHtml(phone));
      var line = parts.join(' · ');
      if (email) line += ' <span class="muted">(' + escapeHtml(email) + ')</span>';
      lines.push('<span class="start-contact-line">' + line + '</span>');
    });
    return lines.length ? lines.join('') : '<span class="muted">Kein Baustellen-Ansprechpartner hinterlegt.</span>';
  }

  function renderStartActiveJob(job) {
    var titleEl = document.getElementById('startActiveJobTitle');
    var subEl = document.getElementById('startActiveJobSubtitle');
    var metaEl = document.getElementById('startActiveJobMeta');
    if (!titleEl) return;
    if (!job) {
      startPageActiveJobId = null;
      startPageActiveJobSnapshot = null;
      titleEl.innerHTML = '<span class="empty">Kein aktiver Auftrag.</span>';
      if (subEl) subEl.innerHTML = '';
      if (metaEl) metaEl.innerHTML = '';
      loadDienstreiseExplorer(null, '', 'start');
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      return;
    }
    startPageActiveJobId = job.id;
    startPageActiveJobSnapshot = job;
    var firma = (job.customer_name || job.customerName || '').trim();
    var ort = (job.city || '').trim();
    var land = normalizeCountryToCode(job.country) || (job.country || '').trim().toUpperCase().slice(0, 2);
    var flagHtml = countryFlagImg(land);
    var parts = [];
    if (flagHtml) parts.push(flagHtml);
    if (firma) parts.push(escapeHtml(firma));
    if (ort) parts.push(escapeHtml(ort));
    titleEl.innerHTML = parts.join(' ') || '<span class="empty">Auftrag</span>';
    if (subEl) subEl.innerHTML = renderStartJobContactsHtml(job);
    if (metaEl) {
      var dateStr = formatDateRange(job.start_datetime, job.end_datetime);
      var stClass = jobStatusBadgeClass(job.status);
      var stLabel = jobStatusDisplayLabel(job.status);
      metaEl.innerHTML =
        escapeHtml(dateStr) +
        ' · <span class="status-badge status-' +
        stClass +
        '">' +
        escapeHtml(stLabel) +
        '</span>';
    }
    loadDienstreiseExplorer(job.id, '', 'start');
    if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
  }

  function loadStartActiveJobById(localJobId, jobSnapshot) {
    var techId = getTechId();
    if (!techId || !localJobId) {
      renderStartActiveJob(null);
      return Promise.resolve(null);
    }
    var range = getSyncDateRange();
    return fetch(
      API_BASE +
        '/api/my_jobs?' +
        qs({
          technician_id: techId,
          date_from: range.date_from,
          date_to: range.date_to,
          assigned_only: '1',
        }),
      { headers: { 'X-Technician-Id': String(techId) } },
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var jobs = data && data.jobs ? data.jobs : [];
        var found = null;
        for (var i = 0; i < jobs.length; i++) {
          if (jobs[i] && (jobs[i].id === localJobId || jobs[i].id == localJobId)) {
            found = jobs[i];
            break;
          }
        }
        renderStartActiveJob(found || null);
        return found;
      })
      .catch(function () {
        renderStartActiveJob(null);
        return null;
      });
  }

  async function loadStartActiveJob() {
    var titleEl = document.getElementById('startActiveJobTitle');
    if (!titleEl) return;
    var techId = getTechId();
    if (!techId) {
      renderStartActiveJob(null);
      titleEl.innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
      return;
    }
    titleEl.innerHTML = '<span class="empty">Wird geladen…</span>';
    var range = getSyncDateRange();
    try {
      var res = await fetch(
        API_BASE +
          '/api/my_jobs?' +
          qs({
            technician_id: techId,
            date_from: range.date_from,
            date_to: range.date_to,
            assigned_only: '1',
          }),
        { headers: { 'X-Technician-Id': String(techId) } },
      );
      var data = await res.json().catch(function () {
        return {};
      });
      var jobs = data && data.jobs ? data.jobs : [];
      jobs = jobs.filter(function (j) {
        return j && !isJobAbgerechnet(j);
      });
      renderStartActiveJob(pickStartActiveJob(jobs));
    } catch (e) {
      titleEl.innerHTML = '<span class="empty">Aufträge nicht lesbar: ' + escapeHtml(e.message) + '</span>';
    }
  }

  function getStartUploadRelativeDir() {
    if (startExplorerSubpath && String(startExplorerSubpath).trim()) {
      return String(startExplorerSubpath).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    }
    var subEl = document.getElementById('startUploadSubfolder');
    return subEl && subEl.value ? subEl.value : 'Dokumente_Monteur';
  }

  function uploadDienstreiseFiles(localJobId, relativeDir, fileList, hintEl) {
    if (!localJobId || !fileList || !fileList.length) {
      if (hintEl) hintEl.textContent = 'Keine Dateien.';
      return Promise.resolve(false);
    }
    var relDir = (relativeDir || 'Dokumente_Monteur').replace(/\\/g, '/').replace(/\/+$/, '');
    var snap = getDienstreiseJobSnapshotByLocalId(localJobId) || startPageActiveJobSnapshot;
    if (isJobAngelegtReadOnly(snap)) {
      if (hintEl) hintEl.textContent = 'Auftrag ist angelegt – nur Anzeige.';
      return Promise.resolve(false);
    }
    if (hintEl) hintEl.textContent = 'Hochladen …';
    var chain = Promise.resolve();
    var okCount = 0;
    var files = Array.prototype.slice.call(fileList);
    files.forEach(function (file) {
      chain = chain.then(function () {
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () {
            var b64 = reader.result;
            if (typeof b64 === 'string' && b64.indexOf('base64,') !== -1) {
              b64 = b64.slice(b64.indexOf('base64,') + 7);
            }
            fetch(API_BASE + '/api/dienstreise/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                job_id: localJobId,
                relative_path: relDir,
                filename: file.name,
                content: b64,
              }),
            })
              .then(function (r) {
                return r.text().then(function (text) {
                  var data;
                  try {
                    data = text ? JSON.parse(text) : {};
                  } catch (_) {
                    data = {};
                  }
                  if (r.ok && data.ok) okCount++;
                  resolve();
                });
              })
              .catch(function () {
                resolve();
              });
          };
          reader.onerror = function () {
            resolve();
          };
          reader.readAsDataURL(file);
        });
      });
    });
    return chain.then(function () {
      if (hintEl) {
        hintEl.textContent = okCount ? okCount + ' Datei(en) hochgeladen.' : 'Upload fehlgeschlagen.';
        if (okCount) setTimeout(function () { hintEl.textContent = ''; }, 3000);
      }
      if (okCount && getDienstreiseExplorerJobId()) {
        var ejid = getDienstreiseExplorerJobId();
        if (startPageActiveJobId == ejid) {
          loadDienstreiseExplorer(ejid, startExplorerSubpath, 'start');
        } else {
          loadDienstreiseExplorer(ejid, dienstreiseExplorerSubpath, 'modal');
        }
      }
      return okCount > 0;
    });
  }

  function dedupeOpenJobsById(jobs) {
    var arr = Array.isArray(jobs) ? jobs : [];
    var seen = new Set();
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var j = arr[i];
      if (!j || j.id == null) continue;
      var id = String(j.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(j);
    }
    return out;
  }

  function filterOpenJobsList(jobs) {
    var arr = Array.isArray(jobs) ? jobs : [];
    if (!anyOpenJobFilterChecked()) return [];
    var cbNoDate = document.getElementById('openJobsFilterNoDate');
    var cbNoTech = document.getElementById('openJobsFilterNoTech');
    var cbAlle = document.getElementById('openJobsFilterAlleNonErledigt');
    var wantNoDate = Boolean(cbNoDate && cbNoDate.checked);
    var wantNoTech = Boolean(cbNoTech && cbNoTech.checked);
    var wantAlle = Boolean(cbAlle && cbAlle.checked);
    return arr.filter(function (j) {
      if (!j || typeof j !== 'object') return false;
      if (wantAlle) return !isJobErledigtForOpenList(j);
      var byNoDate = wantNoDate && jobHasNoDateForOpenFilter(j);
      var byNoTech = wantNoTech && jobHasNoTechnicianForOpenFilter(j);
      if (wantNoDate && wantNoTech) return byNoDate && byNoTech;
      if (wantNoDate) return byNoDate;
      if (wantNoTech) return byNoTech;
      return false;
    });
  }

  function renderOpenJobsWithFilters() {
    var list = document.getElementById('jobsList');
    if (!anyOpenJobFilterChecked()) {
      if (list) list.innerHTML = '<span class="empty">Kein Filter aktiv – bitte eine Option ankreuzen.</span>';
      return;
    }
    renderJobs(sortOpenJobsByEinsatzdatumAsc(dedupeOpenJobsById(filterOpenJobsList(cachedOpenJobs))));
  }

  function renderJobs(data) {
    const list = document.getElementById('jobsList');
    const jobs = Array.isArray(data) ? data : (data && data.jobs) ? data.jobs : [];
    if (jobs.length === 0) {
      list.innerHTML = '<span class="empty">Keine Aufträge.</span>';
      return;
    }
    list.innerHTML = jobs.map((j) => {
      const dateStr = formatDateRange(j.start_datetime, j.end_datetime);
      const firma = (j.customer_name || '').trim();
      const ort = (j.city || '').trim();
      const land = normalizeCountryToCode(j.country) || (j.country || '').trim().toUpperCase().slice(0, 2);
      const flagHtml = countryFlagImg(land);
      const parts = [];
      if (flagHtml) parts.push(flagHtml);
      if (firma) parts.push(escapeHtml(firma));
      if (ort) parts.push(escapeHtml(ort));
      if (land) parts.push(escapeHtml(land));
      const titleLine = parts.join(' · ');
      const hasOpenJobMeta = j.assigned_count != null && j.required_technicians != null;
      const statusHtml = hasOpenJobMeta
        ? '<span class="job-meta">' + Number(j.assigned_count) + ' / ' + Number(j.required_technicians) + ' Techniker</span>'
        : '<span class="status-badge status-' + jobStatusBadgeClass(j.status) + '">' + escapeHtml(jobStatusDisplayLabel(j.status)) + '</span>';
      return (
        '<div class="job" data-job-id="' + j.id + '">' +
        '<div class="job-info">' +
        '<strong>' + (titleLine || 'Auftrag') + '</strong><br>' +
        '<span class="job-meta">' + escapeHtml(dateStr) + (j.job_type ? ' · ' + (j.job_type || '') : '') + '</span>' +
        '</div>' +
        '<div class="job-actions">' + statusHtml + '</div></div>'
      );
    }).join('');
    list.querySelectorAll('.job-actions [data-status]').forEach((btn) => {
      btn.addEventListener('click', () => updateJobStatus(btn.closest('.job').dataset.jobId, btn.dataset.status));
    });
    list.querySelectorAll('.job').forEach((row) => {
      row.addEventListener('dblclick', function (e) {
        if (e.target.closest('button')) return;
        var jobId = row.getAttribute('data-job-id');
        if (jobId) openJobDetailsModal(jobId);
      });
    });
  }

  var jobDetailsJobId = null;

  function getDienstreiseExplorerJobId() {
    return jobDetailsJobId || selectedJobIdOnDienstreisePage || startPageActiveJobId;
  }

  function getDienstreiseJobSnapshotByLocalId(localJobId) {
    var id = parseInt(localJobId, 10);
    if (!id) return null;
    if (startPageActiveJobSnapshot && (startPageActiveJobSnapshot.id === id || startPageActiveJobSnapshot.id == id)) {
      return startPageActiveJobSnapshot;
    }
    var list = Array.isArray(dienstreisePageJobs) ? dienstreisePageJobs : [];
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (j && (j.id === id || j.id == id)) return j;
    }
    var cur = window.currentProjektdatenJob;
    if (cur && (cur.id === id || cur.id == id)) return cur;
    return null;
  }

  function getDienstreiseExplorerUi(uiKey) {
    if (uiKey === 'start') {
      return {
        key: 'start',
        getListEl: function () {
          return document.getElementById('startExplorerList');
        },
        getBreadcrumbEl: function () {
          return document.getElementById('startExplorerBreadcrumb');
        },
        getSubpath: function () {
          return startExplorerSubpath;
        },
        setSubpath: function (s) {
          startExplorerSubpath = s || '';
        },
        getRootEntries: function () {
          return startExplorerRootEntries;
        },
        setRootEntries: function (e) {
          startExplorerRootEntries = e || [];
        },
        getExpanded: function () {
          return startExplorerExpanded;
        },
        clearExpanded: function () {
          startExplorerExpanded = {};
        },
      };
    }
    return {
      key: 'modal',
      getListEl: function () {
        return document.getElementById('dienstreiseExplorerList');
      },
      getBreadcrumbEl: function () {
        return document.getElementById('dienstreiseExplorerBreadcrumb');
      },
      getSubpath: function () {
        return dienstreiseExplorerSubpath;
      },
      setSubpath: function (s) {
        dienstreiseExplorerSubpath = s || '';
      },
      getRootEntries: function () {
        return dienstreiseExplorerRootEntries;
      },
      setRootEntries: function (e) {
        dienstreiseExplorerRootEntries = e || [];
      },
      getExpanded: function () {
        return dienstreiseExplorerExpanded;
      },
      clearExpanded: function () {
        dienstreiseExplorerExpanded = {};
      },
    };
  }

  function updateDienstreiseWriteControlsState() {
    var jid = getDienstreiseExplorerJobId();
    var snap = jid ? getDienstreiseJobSnapshotByLocalId(jid) : null;
    var ro = isJobAngelegtReadOnly(snap);
    var upBtn = document.getElementById('btnDienstreiseUpload');
    if (upBtn) {
      upBtn.disabled = !!ro;
      upBtn.title = ro ? 'Auftrag ist angelegt – nur Anzeige.' : '';
    }
    var sub = document.getElementById('dienstreiseUploadSubfolder');
    var fi = document.getElementById('dienstreiseFileInput');
    if (sub) sub.disabled = !!ro;
    if (fi) fi.disabled = !!ro;
    var startUp = document.getElementById('btnStartUpload');
    var startFi = document.getElementById('startFileInput');
    var startSub = document.getElementById('startUploadSubfolder');
    var startMk = document.getElementById('startBtnMkdir');
    var startMkName = document.getElementById('startMkdirName');
    var startMkParent = document.getElementById('startMkdirParent');
    var startDrop = document.getElementById('startDropZone');
    if (startUp) startUp.disabled = !!ro;
    if (startFi) startFi.disabled = !!ro;
    if (startSub) startSub.disabled = !!ro;
    if (startMk) startMk.disabled = !!ro;
    if (startMkName) startMkName.disabled = !!ro;
    if (startMkParent) startMkParent.disabled = !!ro;
    if (startDrop) {
      startDrop.classList.toggle('start-drop-readonly', !!ro);
      startDrop.setAttribute('aria-disabled', ro ? 'true' : 'false');
    }
  }

  /** Firmenname / Ort / Flagge neben der Überschrift „Projektdaten“. */
  function updateProjektdatenHeadingMeta(job) {
    var el = document.getElementById('projektdatenHeadingMeta');
    if (!el) return;
    if (!job || typeof job !== 'object') {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    var firma = (job.endkunde != null && String(job.endkunde).trim() !== '')
      ? String(job.endkunde).trim()
      : (job.customer_name || '').trim();
    var ort = (job.city || '').trim();
    var land = normalizeCountryToCode(job.country) || (job.country || '').trim().toUpperCase().slice(0, 2);
    var flagHtml = countryFlagImg(land);
    var chunks = [];
    if (firma) chunks.push('<span class="projektdaten-heading-firma">' + escapeHtml(firma) + '</span>');
    if (ort) chunks.push('<span class="projektdaten-heading-ort">' + escapeHtml(ort) + '</span>');
    if (flagHtml) chunks.push(flagHtml);
    if (!chunks.length) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = chunks.join('<span class="projektdaten-heading-sep">·</span>');
  }

  var projektdatenFabSaveBusy = false;
  /** Verhindert, dass ein veralteter Hintergrund-/api/job-Refresh frisch gespeicherte FN überschreibt. */
  var projektdatenFabSavedAt = 0;
  var PROJEKTDATEN_FAB_SAVE_GUARD_MS = 120000;

  function showProjektdatenJob(job, displayOpts) {
    displayOpts = displayOpts || {};
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    if (!job) {
      updateProjektdatenHeadingMeta(null);
      content.innerHTML = '<span class="empty">Fehler: Auftrag nicht gefunden.</span>';
      return;
    }
    if (job.id != null) jobDetailsJobId = job.id;
    window.currentProjektdatenJob = job;
    updateProjektdatenHeadingMeta(job);
    content.innerHTML = renderJobDetailsContent(job);
    bindLeistungActions();
    if (!displayOpts.skipDeferredLoads && getDispoBaseUrl()) {
      setTimeout(function () {
        loadMechanikTedLinks(job);
        loadHotelChoicesByFab(job);
      }, 0);
    }
    var skipExplorer = displayOpts.skipExplorerReload === true;
    if (!skipExplorer && typeof loadDienstreiseExplorer === 'function') {
      var listEl = document.getElementById('dienstreiseExplorerList');
      var explorerStale =
        !jobIdsEqual(projektdatenExplorerJobId, jobDetailsJobId) ||
        !listEl ||
        !!listEl.querySelector('#dienstreiseExplorerPlaceholder') ||
        (listEl.textContent && /Wird geladen/i.test(listEl.textContent));
      if (explorerStale) {
        loadDienstreiseExplorer(jobDetailsJobId, '', 'modal');
        projektdatenExplorerJobId = jobDetailsJobId;
      }
    }
    if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
  }

  function openJobDetailsModal(jobId, options) {
    options = options || {};
    var techId = getTechId();
    if (!techId) {
      alert('Bitte Monteur-ID in Einstellungen eintragen.');
      return;
    }
    var content = document.getElementById('viewProjektdatenContent');
    var viewProjektdaten = document.getElementById('viewProjektdaten');
    var viewStart = document.getElementById('viewStart');
    var viewEinstellungen = document.getElementById('viewEinstellungen');
    if (!content || !viewProjektdaten) return;
    jobDetailsJobId = jobId;
    if (viewStart) viewStart.classList.add('hidden');
    if (viewEinstellungen) viewEinstellungen.classList.remove('active');
    viewProjektdaten.classList.add('active');
    updateProjektdatenHeadingMeta(null);

    function showJob(job, opts) {
      showProjektdatenJob(job, opts || {});
    }

    var cachedJob = window.currentProjektdatenJob;
    var hasCachedJob = cachedJob && jobIdsEqual(cachedJob.id, jobId);
    var syncPullRefresh = options.syncPullRefresh === true;
    var forceReloadFromDb = options.forceReloadFromDb === true;
    if (hasCachedJob && !options.fromDispo && !syncPullRefresh && !forceReloadFromDb) {
      showJob(cachedJob, {});
    } else if (!hasCachedJob || options.fromDispo || forceReloadFromDb) {
      content.innerHTML = '<span class="empty">Wird geladen…</span>';
    }

    function applyRecentFabSaveToJob(job) {
      if (!job || !projektdatenFabSavedAt || Date.now() - projektdatenFabSavedAt >= PROJEKTDATEN_FAB_SAVE_GUARD_MS) {
        return job;
      }
      var rows = window.currentProjektdatenLeistungRows;
      if (rows && rows.length) {
        return Object.assign({}, job, {
          fabrikationsnummern: JSON.stringify(leistungRowsForJobPatch(rows)),
        });
      }
      if (window.currentProjektdatenJob && window.currentProjektdatenJob.fabrikationsnummern) {
        return Object.assign({}, job, {
          fabrikationsnummern: window.currentProjektdatenJob.fabrikationsnummern,
        });
      }
      return job;
    }

    function applyJobFromFetch(job, silent) {
      if (!job) {
        if (!silent) showJob(null);
        return true;
      }
      if (silent) {
        job = applyRecentFabSaveToJob(job);
      }
      if (silent) {
        if (document.getElementById('anlageDetailModal')) {
          return true;
        }
        var prevRows = window.currentProjektdatenLeistungRows || [];
        var nextRows = buildLeistungRowsFromJob(job);
        var prevFns = prevRows.map(function (r) { return String(r.fabrikationsnummer || '').trim(); }).join('\t');
        var nextFns = nextRows.map(function (r) { return String(r.fabrikationsnummer || '').trim(); }).join('\t');
        var tableNeedsRebuild =
          prevRows.length !== nextRows.length ||
          prevFns !== nextFns;
        if (
          jobIdsEqual(jobDetailsJobId, jobId) &&
          tableNeedsRebuild
        ) {
          showProjektdatenJob(job, { skipExplorerReload: true, skipDeferredLoads: true });
          return true;
        }
        window.currentProjektdatenJob = job;
        if (jobIdsEqual(jobDetailsJobId, jobId)) {
          window.currentProjektdatenLeistungRows = nextRows;
          refreshProjektdatenLeistungTableFromRows();
          updateProjektdatenHeadingMeta(job);
        }
        return true;
      }
      showJob(job);
      return true;
    }

    function loadLocal(skipEnrich, silent) {
      var url = API_BASE + '/api/job?id=' + encodeURIComponent(jobId);
      var jobHeaders = Object.assign({ 'X-Technician-Id': String(techId) }, dispoBasicAuthHeaders(getDispoUsername, getDispoPassword));
      if (!skipEnrich) {
        url += '&enrich_anlagenstamm=1&enrich_local_only=1';
      }
      return fetch(url, { headers: jobHeaders })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.job) return applyJobFromFetch(data.job, silent);
          var cached = window.currentProjektdatenJob;
          if (cached && jobIdsEqual(cached.id, jobId)) return applyJobFromFetch(cached, silent);
          if (!silent) showJob(null);
          return false;
        })
        .catch(function (e) {
          var cached = window.currentProjektdatenJob;
          if (cached && jobIdsEqual(cached.id, jobId)) return applyJobFromFetch(cached, silent);
          if (!silent) {
            content.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
          }
          return false;
        });
    }

    function loadFromDispo() {
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) return Promise.resolve(false);
      return fetch(API_BASE + '/api/job_from_dispo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
        body: JSON.stringify({
          baseUrl: baseUrl,
          jobId: jobId,
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok && data.job) {
            showJob(data.job);
            return true;
          }
          return false;
        })
        .catch(function () {
          return false;
        });
    }

    if (options.fromDispo) {
      content.innerHTML = '<span class="empty">Wird geladen…</span>';
      loadFromDispo().then(function (ok) {
        if (!ok) loadLocal(false, false);
      });
      return;
    }

    if (!document.getElementById('anlageDetailModal')) {
      loadLocal(false, hasCachedJob && !forceReloadFromDb);
    }
  }

  function closeJobDetailsModal() {
    var viewProjektdaten = document.getElementById('viewProjektdaten');
    if (viewProjektdaten) viewProjektdaten.classList.remove('active');
    updateProjektdatenHeadingMeta(null);
    jobDetailsJobId = null;
    projektdatenExplorerJobId = null;
  }

  /** Wie Dispo job_form.js: Komma/Semikolon, Bereiche 100-103 und Kurzform 11030-32. */
  function parseFabInputSemicolonList(str) {
    if (!str || typeof str !== 'string') return [];
    var parts = str.split(/[\s]*[,;][\s]*/).map(function (p) { return p.trim(); }).filter(Boolean);
    var numbers = [];
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi];
      var m = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        var a = parseInt(m[1], 10);
        var b = parseInt(m[2], 10);
        if (String(m[2]).length < String(a).length) {
          var pow = Math.pow(10, m[2].length);
          b = Math.floor(a / pow) * pow + b;
        }
        for (var n = a; n <= b; n++) numbers.push(String(n));
      } else {
        numbers.push(p);
      }
    }
    return numbers;
  }

  function formatFabrikationsnummernInputValue(rows) {
    if (!rows || !rows.length) return '';
    return rows.map(function (r) { return String(r && r.fabrikationsnummer != null ? r.fabrikationsnummer : '').trim(); }).filter(Boolean).join('; ');
  }

  function findLeistungRowByFab(rows, fn) {
    var fnStr = String(fn || '').trim();
    if (!fnStr) return null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var rfn = String(r.fabrikationsnummer || '').trim();
      if (rfn === fnStr) return r;
      var a = Number(rfn);
      var b = Number(fnStr);
      if (rfn !== '' && fnStr !== '' && !isNaN(a) && !isNaN(b) && a === b) return r;
    }
    return null;
  }

  function emptyLeistungRowTemplate(fn) {
    return {
      fabrikationsnummer: fn || '',
      type: '',
      leistung: '',
      nenngeschwindigkeit: '',
      kraftaufnehmer: '',
      dms_nr: '',
      tacho: '',
      elektronik: '',
      material: '',
      position: '',
      geliefert_ueber: '',
      projekt: '',
      bemerkungen: ''
    };
  }

  function sanitizeLeistungField(val) {
    if (val == null) return '';
    var s = String(val).trim();
    if (!s || s.toLowerCase() === 'null') return '';
    return s;
  }

  function formatLeistungCellDisplay(val) {
    var s = sanitizeLeistungField(val);
    return s === '' ? '–' : s;
  }

  function mergeFabListIntoLeistungRows(numbers, existingRows) {
    var existing = Array.isArray(existingRows) ? existingRows : [];
    var out = [];
    var seen = {};
    for (var i = 0; i < numbers.length; i++) {
      var fn = String(numbers[i] || '').trim();
      if (!fn || seen[fn]) continue;
      seen[fn] = true;
      var prev = findLeistungRowByFab(existing, fn);
      if (prev) {
        out.push({
          fabrikationsnummer: fn,
          type: sanitizeLeistungField(prev.type),
          leistung: sanitizeLeistungField(prev.leistung),
          nenngeschwindigkeit: sanitizeLeistungField(prev.nenngeschwindigkeit),
          kraftaufnehmer: sanitizeLeistungField(prev.kraftaufnehmer),
          dms_nr: sanitizeLeistungField(prev.dms_nr),
          tacho: sanitizeLeistungField(prev.tacho),
          elektronik: sanitizeLeistungField(prev.elektronik),
          material: sanitizeLeistungField(prev.material),
          position: sanitizeLeistungField(prev.position),
          geliefert_ueber: sanitizeLeistungField(prev.geliefert_ueber),
          projekt: sanitizeLeistungField(prev.projekt),
          bemerkungen: sanitizeLeistungField(prev.bemerkungen)
        });
      } else {
        out.push(emptyLeistungRowTemplate(fn));
      }
    }
    return out;
  }

  /** Zeile in der FN-Tabelle anzeigen (FN reicht; leere Platzhalterzeile ohne FN ausblenden). */
  function leistungRowShowInTable(r) {
    if (!r) return false;
    if (String(r.fabrikationsnummer || '').trim()) return true;
    return leistungRowHasVisibleData(r);
  }

  function leistungRowHasVisibleData(r) {
    if (!r) return false;
    return !!(
      sanitizeLeistungField(r.fabrikationsnummer) ||
      sanitizeLeistungField(r.type) ||
      sanitizeLeistungField(r.leistung) ||
      sanitizeLeistungField(r.nenngeschwindigkeit) ||
      sanitizeLeistungField(r.kraftaufnehmer) ||
      sanitizeLeistungField(r.dms_nr) ||
      sanitizeLeistungField(r.tacho) ||
      sanitizeLeistungField(r.elektronik) ||
      sanitizeLeistungField(r.material) ||
      sanitizeLeistungField(r.position) ||
      sanitizeLeistungField(r.geliefert_ueber) ||
      sanitizeLeistungField(r.projekt) ||
      sanitizeLeistungField(r.bemerkungen)
    );
  }

  function jobIdsEqual(a, b) {
    return a != null && b != null && (a === b || String(a) === String(b));
  }

  function buildLeistungRowsFromJob(job) {
    var leistungRows = [];
    if (!job) return leistungRows;
    var fab = job.fabrikationsnummern != null ? job.fabrikationsnummern : (job.fabrikation != null ? job.fabrikation : (job.job_fabrikation != null ? job.job_fabrikation : null));
    var parsedList = null;
    if (fab != null && (typeof fab === 'string' && (fab = fab.trim()) !== '')) {
      try {
        var parsed = JSON.parse(fab);
        parsedList = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null);
      } catch (err) {
        var parts = fab.split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts.length > 0) {
          parsedList = parts.map(function (fn) {
            return {
              fabrikationsnummer: fn,
              type: '',
              leistung: '',
              nenngeschwindigkeit: '',
              kraftaufnehmer: '',
              dms_nr: '',
              tacho: '',
              elektronik: '',
              material: '',
              position: '',
              geliefert_ueber: '',
              projekt: '',
              bemerkungen: ''
            };
          });
        }
      }
    } else if (fab != null && Array.isArray(fab)) {
      parsedList = fab;
    } else if (fab != null && typeof fab === 'object' && !Array.isArray(fab)) {
      parsedList = [fab];
    }
    var get = function (r, keys) {
      if (!r || typeof r !== 'object') return '';
      for (var i = 0; i < keys.length; i++) {
        if (r[keys[i]] !== undefined) return sanitizeLeistungField(r[keys[i]]);
        var lower = keys[i].toLowerCase();
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && k.toLowerCase() === lower) {
          return sanitizeLeistungField(r[k]);
        }
      }
      return '';
    };
    if (parsedList && parsedList.length > 0) {
      parsedList.forEach(function (row) {
        var r = row && typeof row === 'object' ? row : {};
        leistungRows.push({
          fabrikationsnummer: get(r, ['fabrikationsnummer', 'fab']),
          type: get(r, ['type', 'Type', 'typ', 'Typ']),
          leistung: get(r, ['leistung', 'Leistung']),
          nenngeschwindigkeit: get(r, ['nenngeschwindigkeit', 'Nenngeschwindigkeit']),
          kraftaufnehmer: get(r, ['kraftaufnehmer', 'Kraftaufnehmer']),
          dms_nr: get(r, ['dms_nr', 'DMS Nr.', 'dms_nr']),
          tacho: get(r, ['tacho', 'Tacho']),
          elektronik: get(r, ['elektronik', 'Elektronik']),
          material: get(r, ['material', 'Material']),
          position: get(r, ['position', 'Position']),
          geliefert_ueber: get(r, ['geliefert_ueber', 'geliefertUeber']),
          projekt: get(r, ['projekt', 'Projekt']),
          bemerkungen: get(r, ['bemerkungen', 'Bemerkungen'])
        });
      });
    }
    if (leistungRows.length === 0) {
      leistungRows.push({ fabrikationsnummer: '', type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: '', geliefert_ueber: '', projekt: '', bemerkungen: '' });
    }
    return leistungRows;
  }

  function leistungRowsForJobPatch(rows) {
    var arr = (rows || []).filter(leistungRowHasVisibleData);
    return arr.length > 0 ? arr : (rows || []).slice();
  }

  function refreshProjektdatenLeistungTableFromRows() {
    var rows = window.currentProjektdatenLeistungRows || [];
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    function applyRowToTr(tr, row) {
      var cells = tr.querySelectorAll('td');
      if (cells.length < 4) return;
      var fabDisp = sanitizeLeistungField(row.fabrikationsnummer);
      cells[0].textContent = fabDisp;
      if (cells[0].getAttribute('data-fab') != null) cells[0].setAttribute('data-fab', fabDisp);
      cells[1].textContent = formatLeistungCellDisplay(row.type);
      cells[2].textContent = formatLeistungCellDisplay(row.leistung);
      cells[3].textContent = formatLeistungCellDisplay(row.position);
    }
    content.querySelectorAll('.projektdaten-leistung-row[data-row-index]').forEach(function (tr) {
      var i = parseInt(tr.getAttribute('data-row-index'), 10);
      if (!Number.isFinite(i) || !rows[i]) return;
      applyRowToTr(tr, rows[i]);
    });
    content.querySelectorAll('td.modal-leistung-cell-clickable[data-row-index]').forEach(function (td) {
      var i = parseInt(td.getAttribute('data-row-index'), 10);
      if (!Number.isFinite(i) || !rows[i]) return;
      var row = rows[i];
      var col = td.cellIndex;
      if (col === 0) {
        var fabTd = sanitizeLeistungField(row.fabrikationsnummer);
        td.textContent = fabTd;
        if (td.getAttribute('data-fab') != null) td.setAttribute('data-fab', fabTd);
      } else if (col === 1) td.textContent = formatLeistungCellDisplay(row.type);
      else if (col === 2) td.textContent = formatLeistungCellDisplay(row.leistung);
      else if (col === 3) td.textContent = formatLeistungCellDisplay(row.position);
    });
  }

  function applyAnlageDetailBuiltToProjektdaten(built) {
    if (!built) return;
    projektdatenFabSavedAt = Date.now();
    window.currentProjektdatenLeistungRows = built.rowsCopy;
    if (window.currentProjektdatenJob) {
      window.currentProjektdatenJob = Object.assign({}, window.currentProjektdatenJob, {
        fabrikationsnummern: JSON.stringify(built.arr)
      });
    }
    refreshProjektdatenLeistungTableFromRows();
  }

  function mergeAnlagenstammFieldsIntoOpenJob(fab, fields) {
    fab = String(fab || '').trim();
    if (!fab || !fields) return false;
    var normalized = {
      type: sanitizeLeistungField(fields.type),
      leistung: sanitizeLeistungField(fields.leistung),
      nenngeschwindigkeit: sanitizeLeistungField(fields.nenngeschwindigkeit),
      kraftaufnehmer: sanitizeLeistungField(fields.kraftaufnehmer),
      dms_nr: sanitizeLeistungField(fields.dms_nr),
      tacho: sanitizeLeistungField(fields.tacho),
      elektronik: sanitizeLeistungField(fields.elektronik),
      material: sanitizeLeistungField(fields.material),
      position: sanitizeLeistungField(fields.position),
      geliefert_ueber: sanitizeLeistungField(fields.geliefert_ueber),
      projekt: sanitizeLeistungField(fields.projekt),
      bemerkungen: sanitizeLeistungField(fields.bemerkungen)
    };
    var rows = (window.currentProjektdatenLeistungRows || []).slice();
    var touched = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].fabrikationsnummer || '').trim() !== fab) continue;
      rows[i] = Object.assign({}, rows[i], normalized);
      touched = true;
    }
    if (!touched) return false;
    window.currentProjektdatenLeistungRows = rows;
    var arr = leistungRowsForJobPatch(rows);
    if (window.currentProjektdatenJob) {
      window.currentProjektdatenJob = Object.assign({}, window.currentProjektdatenJob, {
        fabrikationsnummern: JSON.stringify(arr)
      });
    }
    refreshProjektdatenLeistungTableFromRows();
    return true;
  }

  var anlageDetailStammLoadToken = 0;
  var anlageDetailOpenToken = 0;

  var ANLAGE_DETAIL_STAMM_KEYS = [
    'type', 'leistung', 'nenngeschwindigkeit', 'kraftaufnehmer', 'dms_nr',
    'tacho', 'elektronik', 'material', 'position', 'geliefert_ueber', 'projekt', 'bemerkungen'
  ];

  function mergeLeistungRowWithAnlagenstamm(row, st) {
    if (!row || !st) return row;
    var out = Object.assign({}, row);
    ANLAGE_DETAIL_STAMM_KEYS.forEach(function (key) {
      var stVal = sanitizeLeistungField(st[key]);
      if (!stVal) return;
      if (!sanitizeLeistungField(out[key])) out[key] = stVal;
    });
    return out;
  }

  function persistAnlageRowToAnlagenstamm(row) {
    var fab = String((row && row.fabrikationsnummer) || '').trim();
    if (!fab) return Promise.resolve();
    var stammIdEl = document.getElementById('anlageDetailStammId');
    var stammId = stammIdEl && stammIdEl.value ? parseInt(stammIdEl.value, 10) : parseInt(row.id, 10);
    var payload = Object.assign({
      baseUrl: getDispoBaseUrl(),
      serverUsername: getServerUsername(),
      serverPassword: getServerPassword(),
      id: Number.isFinite(stammId) && stammId > 0 ? stammId : 0,
      fabrikationsnummer: fab,
      type: sanitizeLeistungField(row.type),
      leistung: sanitizeLeistungField(row.leistung),
      nenngeschwindigkeit: sanitizeLeistungField(row.nenngeschwindigkeit),
      kraftaufnehmer: sanitizeLeistungField(row.kraftaufnehmer),
      material: sanitizeLeistungField(row.material),
      tacho: sanitizeLeistungField(row.tacho),
      elektronik: sanitizeLeistungField(row.elektronik),
      dms_nr: sanitizeLeistungField(row.dms_nr),
      position: sanitizeLeistungField(row.position),
      geliefert_ueber: sanitizeLeistungField(row.geliefert_ueber),
      projekt: sanitizeLeistungField(row.projekt),
      bemerkungen: sanitizeLeistungField(row.bemerkungen)
    }, dispoBasePayloadExtra());
    return anlagenstammSaveDispo(payload);
  }

  var projektdatenExplorerJobId = null;

  function refreshProjektdatenAfterFabSave(job, hintEl) {
    projektdatenFabSavedAt = Date.now();
    window.currentProjektdatenLeistungRows = buildLeistungRowsFromJob(job);
    window.currentProjektdatenJob = job;
    showProjektdatenJob(job, { skipExplorerReload: true, skipDeferredLoads: true });
    if (hintEl) {
      hintEl.textContent = 'Fabrikationsnummern gespeichert.';
      setTimeout(function () {
        var h = document.getElementById('projektdatenFabHint');
        if (h) h.textContent = '';
      }, 2500);
    }
  }

  function saveProjektdatenFabrikationsnummernFromRows(rows, hintEl) {
    var jobId = jobDetailsJobId;
    if (!jobId) return Promise.reject(new Error('Kein Auftrag'));
    var arr = (rows || []).filter(leistungRowHasVisibleData);
    projektdatenFabSaveBusy = true;
    return api('/api/job', {
      method: 'PATCH',
      body: JSON.stringify({ job_id: parseInt(jobId, 10), fabrikationsnummern: JSON.stringify(arr) })
    }).then(function () {
      var job = Object.assign({}, window.currentProjektdatenJob || {});
      job.fabrikationsnummern = JSON.stringify(arr);
      refreshProjektdatenAfterFabSave(job, hintEl);
    }).finally(function () {
      projektdatenFabSaveBusy = false;
    });
  }

  function applyProjektdatenFabInput() {
    if (projektdatenFabSaveBusy) return;
    if (!canEditProjektdatenFabrikationsnummern(window.currentProjektdatenJob)) return;
    var input = document.getElementById('projektdatenFabrikationsnummern');
    var hint = document.getElementById('projektdatenFabHint');
    if (!input) return;
    var raw = (input.value || '').trim();
    if (!raw) {
      return saveProjektdatenFabrikationsnummernFromRows([], hint).catch(function (e) {
        if (hint) hint.textContent = 'Speichern fehlgeschlagen.';
        alert('Speichern fehlgeschlagen: ' + (e && e.message ? e.message : String(e)));
      });
    }
    var numbers = parseFabInputSemicolonList(raw);
    if (numbers.length === 0) {
      if (hint) hint.textContent = 'Keine gültige Fabrikationsnummer erkannt.';
      return;
    }
    var merged = mergeFabListIntoLeistungRows(numbers, window.currentProjektdatenLeistungRows || []);
    return saveProjektdatenFabrikationsnummernFromRows(merged, hint).catch(function (e) {
      if (hint) hint.textContent = 'Speichern fehlgeschlagen.';
      alert('Speichern fehlgeschlagen: ' + (e && e.message ? e.message : String(e)));
    });
  }

  function renderJobDetailsContent(job) {
    var readOnlyAngelegt = isJobAngelegtReadOnly(job);
    var v = function (x) { return (x != null && String(x).trim() !== '' ? escapeHtml(String(x).trim()) : '–'); };
    function decodeHtmlEntities(str) {
      if (str == null || str === '') return '';
      var d = document.createElement('div');
      d.innerHTML = String(str);
      return (d.textContent || d.innerText || '').trim();
    }
    /** Beschreibung/Bemerkungen wie in der Dispo formatieren: HTML erlauben (nur sichere Tags), Zeilenumbrüche erhalten. */
    function formatDescriptionForDisplay(str) {
      if (str == null || str === '') return '';
      var s = String(str).trim();
      if (!s) return '';
      if (s.indexOf('\n') !== -1) s = s.replace(/\n/g, '<br>');
      var allowed = ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'p', 'br', 'span', 'h1', 'h2', 'h3', 'div'];
      var div = document.createElement('div');
      div.innerHTML = s;
      function safeSpanStyle(el) {
        var style = (el.getAttribute('style') || '').trim();
        if (!style) return '';
        var parts = [];
        var cm = style.match(/(?:^|;\s*)color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/i);
        if (cm) parts.push('color:' + cm[1].trim());
        var bm = style.match(/(?:^|;\s*)background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/i);
        if (bm) parts.push('background-color:' + bm[1].trim());
        return parts.length ? ' style="' + parts.join(';') + '"' : '';
      }
      function sanitize(node) {
        if (node.nodeType === 3) return escapeHtml(node.textContent);
        if (node.nodeType !== 1) return '';
        var tag = node.tagName.toLowerCase();
        if (allowed.indexOf(tag) === -1) {
          var out = '';
          for (var i = 0; i < node.childNodes.length; i++) out += sanitize(node.childNodes[i]);
          return out;
        }
        var open = '<' + tag;
        if (tag === 'span') open += safeSpanStyle(node);
        open += '>';
        var out = open;
        for (var j = 0; j < node.childNodes.length; j++) out += sanitize(node.childNodes[j]);
        if (tag !== 'br') out += '</' + tag + '>';
        return out;
      }
      var result = '';
      for (var k = 0; k < div.childNodes.length; k++) result += sanitize(div.childNodes[k]);
      return result.trim();
    }
    var dateRangeStr = formatDateRange(job.start_datetime, job.end_datetime);
    var countryRaw = (job.country || '').trim();
    var countryCode = normalizeCountryToCode(job.country);
    var countryPart = countryCode ? (countryFlagImg(countryCode) + (countryRaw ? ' ' + escapeHtml(countryRaw) : ' ' + countryCode)) : (countryRaw ? escapeHtml(countryRaw) : '');
    // Auftragsadresse (Einsatzadresse): Endkunde als Firmenname, dann Straße, PLZ Ort, Land
    var addressLines = [];
    var nameLine = (job.endkunde != null && String(job.endkunde).trim() !== '') ? String(job.endkunde).trim() : (job.customer_name || '').trim();
    if (nameLine) addressLines.push(escapeHtml(nameLine));
    var streetLine = [ (job.street || '').trim(), (job.house_number || '').trim() ].filter(Boolean).join(' ');
    if (streetLine) addressLines.push(escapeHtml(streetLine));
    var zipCityLine = [ (job.zip || '').trim(), (job.city || '').trim() ].filter(Boolean).join(' ');
    if (zipCityLine) addressLines.push(escapeHtml(zipCityLine));
    if (countryPart) addressLines.push(countryPart);
    var extra1 = (job.address_extra_1 || '').trim();
    if (extra1) addressLines.push(escapeHtml(extra1));
    var extra2 = (job.address_extra_2 || '').trim();
    if (extra2) addressLines.push(escapeHtml(extra2));
    var addressLine = addressLines.length ? addressLines.join('<br>') : '–';

    var leistungRows = buildLeistungRowsFromJob(job);
    window.currentProjektdatenLeistungRows = leistungRows;

    var html = '';
    if (readOnlyAngelegt) {
      html += '<div class="projektdaten-readonly-banner" role="status">Auftrag ist <strong>angelegt</strong> – hier nur Anzeige, keine Bearbeitung.</div>';
    }
    html += '<div class="projektdaten-meta-stack">';
    html += '<details class="projektdaten-meta-details">';
    html += '<summary>Auftrag, Kunde &amp; ERP-Nummern</summary>';
    html += '<div class="projektdaten-meta-details-body">';
    html += '<div class="modal-detail-section modal-detail-section-address-row"><div class="modal-address-contact-row">';
    html += '<div class="modal-detail-section"><h4>Auftrag</h4><dl class="modal-detail-dl">';
    html += '<dt>Auftragsnummer</dt><dd>' + v(job.job_number) + '</dd>';
    html += '<dt>Typ</dt><dd>' + v(job.job_type) + '</dd>';
    html += '<dt>Zeitraum</dt><dd>' + (dateRangeStr ? v(dateRangeStr) : v(formatDateOnly(job.start_datetime) || job.start_datetime)) + '</dd>';
    html += '<dt>Status</dt><dd>' + v(job.status) + '</dd>';
    html += '</dl></div>';
    html += '<div class="modal-detail-section"><h4>Kunde</h4><dl class="modal-detail-dl">';
    html += '<dt>Name</dt><dd>' + v(job.customer_name) + '</dd>';
    html += '<dt>Straße</dt><dd>' + v(job.customer_street) + ' ' + v(job.customer_house_number) + '</dd>';
    html += '<dt>Ort</dt><dd>' + v(job.customer_zip) + ' ' + v(job.customer_city) + '</dd>';
    html += '<dt>Telefon</dt><dd>' + v(job.customer_phone) + '</dd>';
    html += '</dl></div>';
    html += '<div class="modal-detail-section"><h4>Auftrag: ERP-Nummer / Bestellnummer</h4>';
    html += '<dl class="modal-detail-dl"><dt>ERP-Nummer</dt><dd>' + v(job.eap_nummer) + '</dd>';
    html += '<dt>Bestellnummer</dt><dd>' + v(job.bestellnummer) + '</dd></dl></div>';
    html += '</div></div>';
    html += '</div></details>';
    (function () {
      function renderHotelRatingStars(avgRaw, countRaw) {
        var count = Number(countRaw || 0);
        var avg = Number(avgRaw);
        if (!count || !isFinite(avg)) return '<span class="muted">Keine Bewertung</span>';
        var rounded = Math.round(avg * 2) / 2;
        var full = Math.floor(rounded);
        var hasHalf = (rounded - full) >= 0.5;
        var empty = 5 - full - (hasHalf ? 1 : 0);
        var stars = '';
        for (var i = 0; i < full; i++) stars += '★';
        if (hasHalf) stars += '½';
        for (var j = 0; j < empty; j++) stars += '☆';
        return '<span class="hotel-rating-stars">' + escapeHtml(stars) + '</span> <span class="muted">(' + escapeHtml(String(count)) + ')</span>';
      }
      var hotelLines = [];
      var hotelName = (job.hotel_endkunde || '').trim();
      if (hotelName) hotelLines.push(escapeHtml(hotelName) + ' ' + renderHotelRatingStars(job.hotel_rating_avg, job.hotel_rating_count));
      var hotelStreet = [ (job.hotel_street || '').trim(), (job.hotel_house_number || '').trim() ].filter(Boolean).join(' ');
      if (hotelStreet) hotelLines.push(escapeHtml(hotelStreet));
      var hotelZipCity = [ (job.hotel_zip || '').trim(), (job.hotel_city || '').trim() ].filter(Boolean).join(' ');
      if (hotelZipCity) hotelLines.push(escapeHtml(hotelZipCity));
      var hotelCountry = (job.hotel_country || '').trim();
      if (hotelCountry) {
        var hotelCountryCode = normalizeCountryToCode(job.hotel_country) || (job.hotel_country || '').trim().toUpperCase().slice(0, 2);
        var hotelFlagHtml = countryFlagImg(hotelCountryCode);
        var hotelCountryUpper = (hotelCountry || '').toUpperCase();
        var hotelCountryEntry = (typeof window.HOTEL_COUNTRIES !== 'undefined' && Array.isArray(window.HOTEL_COUNTRIES)) ? window.HOTEL_COUNTRIES.find(function (x) { var c = (x.code || '').toUpperCase(); return c === hotelCountryUpper || c === hotelCountryCode; }) : null;
        var hotelCountryName = (hotelCountryEntry && hotelCountryEntry.name) ? hotelCountryEntry.name : hotelCountry;
        hotelLines.push(hotelFlagHtml ? (escapeHtml(hotelCountryName) + ' ' + hotelFlagHtml + ' ' + escapeHtml(hotelCountryCode)) : escapeHtml(hotelCountry));
      }
      var hotelExtra1 = (job.hotel_address_extra_1 || '').trim();
      if (hotelExtra1) hotelLines.push(escapeHtml(hotelExtra1));
      var hotelExtra2 = (job.hotel_address_extra_2 || '').trim();
      if (hotelExtra2) hotelLines.push(escapeHtml(hotelExtra2));
      var hotelPhone = (job.hotel_phone || '').trim();
      if (hotelPhone) hotelLines.push('Tel. ' + escapeHtml(hotelPhone));
      var hotelEmail = (job.hotel_email || '').trim();
      if (hotelEmail) hotelLines.push(escapeHtml(hotelEmail));
      var hotelWebsite = (job.hotel_website || '').trim();
      if (hotelWebsite) hotelLines.push(escapeHtml(hotelWebsite));
      var hotelAddressLine = hotelLines.length ? hotelLines.join('<br>') : '–';
      var c = (job.job_contacts && Array.isArray(job.job_contacts) && job.job_contacts[0]) ? job.job_contacts[0] : null;
      var name = (c && (c.contact_name || c.contactName)) ? (c.contact_name || c.contactName) : (job.contact_person || job.contact_name || '');
      var phone = (c && (c.contact_phone || c.contactPhone)) ? (c.contact_phone || c.contactPhone) : (job.contact_phone || '');
      var email = (c && (c.contact_email || c.contactEmail)) ? (c.contact_email || c.contactEmail) : (job.contact_email || '');
      html += '<details class="projektdaten-meta-details">';
      html += '<summary>Adressen &amp; Kontakt</summary>';
      html += '<div class="projektdaten-meta-details-body">';
      html += '<div class="modal-detail-section modal-detail-section-address-row">';
      html += '<div class="modal-address-contact-row">';
      html += '<div class="modal-detail-section"><h4>Auftragsadresse</h4><p class="modal-address">' + addressLine + '</p></div>';
      html += '<div class="modal-detail-section modal-hotel-display-wrap"><h4>Hotel Adresse</h4><p class="modal-address hotel-address-display' + (readOnlyAngelegt ? ' hotel-address-readonly' : '') + '" data-job-id="' + escapeHtml(String(job.id)) + '"' + (readOnlyAngelegt ? '' : ' title="Doppelklick zum Bearbeiten"') + '>' + hotelAddressLine + '</p>' + (readOnlyAngelegt ? '' : '<p class="modal-hotel-hint muted">Doppelklick zum Bearbeiten</p>') + '</div>';
      html += '<div class="modal-detail-section"><h4>Kontakt (Baustellen-Ansprechpartner)</h4><dl class="modal-detail-dl">';
      html += '<dt>Ansprechpartner</dt><dd>' + v(name) + '</dd>';
      html += '<dt>Telefon</dt><dd>' + v(phone) + '</dd>';
      html += '<dt>E-Mail</dt><dd>' + v(email) + '</dd>';
      html += '</dl></div>';
      html += '</div></div>';
      html += '</div></details>';
    })();
    html += '</div>';

    html += '<div class="projektdaten-leistung-split">';
    html += '<div class="projektdaten-leistung-split-main">';
    html += '<div class="modal-detail-section"><h4>Leistungsdaten (Anlagenstamm)</h4>';
    if (readOnlyAngelegt) {
      html += '<p class="modal-leistung-hint muted">Nur Anzeige (Auftrag angelegt).</p>';
    }
    var fabInputValue = formatFabrikationsnummernInputValue(leistungRows);
    var fabEditAllowed = canEditProjektdatenFabrikationsnummern(job);
    if (!fabEditAllowed) {
      html += '<p class="modal-leistung-fab-display"><strong>Fabrikationsnummern:</strong> ' + (fabInputValue ? escapeHtml(fabInputValue) : '–') + '</p>';
    } else {
      html += '<div class="modal-leistung-fab-row">';
      html += '<label for="projektdatenFabrikationsnummern">Fabrikationsnummern</label>';
      html += '<input type="text" id="projektdatenFabrikationsnummern" class="modal-leistung-fab-input" autocomplete="off" placeholder="z.B. 11030-32; 5060, 4603" value="' + escapeHtml(fabInputValue) + '" />';
      html += '<span class="modal-leistung-hint muted" style="margin-top:0.25rem;display:block">Trennzeichen: Komma oder Semikolon. Bereich 100-103 oder Kurzform 11030-32.</span>';
      html += '<span id="projektdatenFabHint" class="settings-saved-hint" aria-live="polite"></span>';
      html += '</div>';
    }
    var visibleIndices = [];
    for (var idx = 0; idx < leistungRows.length; idx++) {
      if (!leistungRowShowInTable(leistungRows[idx])) continue;
      visibleIndices.push(idx);
    }
    var useTwoCards = visibleIndices.length > 2;
    var vCellFab = function (x) { return escapeHtml(sanitizeLeistungField(x)); };
    var vCellStamm = function (x) { return escapeHtml(formatLeistungCellDisplay(x)); };
    var leistungCellClass = readOnlyAngelegt ? 'modal-leistung-cell-readonly' : 'modal-leistung-cell-clickable';
    function renderAnlagenTable(indices) {
      var out = '<div class="modal-leistung-wrap"><table class="modal-leistung-table modal-leistung-table-compact"><thead><tr>';
      out += '<th>FN</th><th>Type</th><th>Leistung</th><th>Position</th>';
      out += '</tr></thead><tbody>';
      for (var k = 0; k < indices.length; k++) {
        var i = indices[k];
        var row = leistungRows[i];
        out += '<tr class="projektdaten-leistung-row" data-row-index="' + escapeHtml(String(i)) + '">';
        out += '<td class="' + leistungCellClass + ' hotel-fab-cell" data-row-index="' + escapeHtml(String(i)) + '" data-fab="' + escapeHtml(String(row.fabrikationsnummer || '')) + '">' + vCellFab(row.fabrikationsnummer) + '</td>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.type) + '</td>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.leistung) + '</td>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.position) + '</td>';
        out += '</tr>';
      }
      out += '</tbody></table></div>';
      return out;
    }
    if (useTwoCards) {
      var mid = Math.ceil(visibleIndices.length / 2);
      var chunk1 = visibleIndices.slice(0, mid);
      var chunk2 = visibleIndices.slice(mid);
      html += '<div class="modal-leistung-cards">';
      html += '<div class="card modal-leistung-card">' + renderAnlagenTable(chunk1) + '</div>';
      html += '<div class="card modal-leistung-card">' + renderAnlagenTable(chunk2) + '</div>';
      html += '</div>';
    } else {
      html += '<div class="modal-leistung-wrap"><table class="modal-leistung-table modal-leistung-table-compact"><thead><tr>';
      html += '<th>FN</th><th>Type</th><th>Leistung</th><th>Position</th>';
      html += '</tr></thead><tbody id="modalLeistungTbody">';
      for (var i = 0; i < leistungRows.length; i++) {
        var row = leistungRows[i];
        if (!leistungRowShowInTable(row)) continue;
        html += '<tr class="projektdaten-leistung-row" data-row-index="' + escapeHtml(String(i)) + '">';
        html += '<td class="' + leistungCellClass + ' hotel-fab-cell" data-row-index="' + escapeHtml(String(i)) + '" data-fab="' + escapeHtml(String(row.fabrikationsnummer || '')) + '">' + vCellFab(row.fabrikationsnummer) + '</td>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.type) + '</td>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.leistung) + '</td>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCellStamm(row.position) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';
    html += '</div>';
    html += '<aside class="projektdaten-leistung-split-side" aria-label="PROJEKTE NEU">';
    html += '<h4 class="projektdaten-projekte-neu-heading">PROJEKTE NEU</h4>';
    html += '<div id="projektdatenProjekteNeuMsg" class="projektdaten-projekte-neu-msg muted"></div>';
    html += '<div id="projektdatenProjekteNeuTree" class="projektdaten-projekte-neu-tree"></div>';
    html += '</aside>';
    html += '</div>';
    html += '<div class="modal-detail-section projektdaten-projektordner-section" style="margin-top:1rem">';
    html += '<h4>Projektordner (lokal)</h4>';
    html += '<div class="dienstreise-explorer-toolbar" style="margin:0.35rem 0">';
    html += '<span class="dienstreise-explorer-breadcrumb" id="dienstreiseExplorerBreadcrumb" title="Projektordner">Projektordner</span>';
    html += '</div>';
    html += '<div id="dienstreiseExplorerList" class="dienstreise-explorer-list" aria-label="Dateien im Projektordner">';
    html += '<span class="empty" id="dienstreiseExplorerPlaceholder">Noch kein Projektordner – Auftrag unter Aufträge annehmen.</span>';
    html += '</div>';
    if (!readOnlyAngelegt) {
      html += '<div class="settings-row" style="margin-top:0.75rem">';
      html += '<label>Dokument hochladen</label>';
      html += '<div class="dienstreise-upload-row">';
      html += '<select id="dienstreiseUploadSubfolder" class="dienstreise-select">';
      html += '<option value="Dokumente_Dispo">Dokumente_Dispo</option>';
      html += '<option value="Dokumente_Monteur">Dokumente_Monteur</option>';
      html += '<option value="Dokumente_Anlage">Dokumente_Anlage</option>';
      html += '<option value="Dokumente_Buchhaltung">Dokumente_Buchhaltung</option>';
      html += '</select>';
      html += '<input type="file" id="dienstreiseFileInput" accept="*" style="max-width: 220px;" />';
      html += '<button type="button" class="btn btn-ghost" id="btnDienstreiseUpload">Hochladen</button>';
      html += '</div>';
      html += '<span id="dienstreiseUploadHint" class="settings-saved-hint" aria-live="polite"></span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="modal-detail-section" id="mechanikTedLinksContainer"><h4>Mechanik-Excel (TED)</h4><p class="muted">Wird geladen…</p></div>';
    if (job.description) html += '<div class="modal-detail-section modal-detail-section-description"><h4>Bemerkungen</h4><div class="modal-description-wrap"><div class="modal-description-display">' + formatDescriptionForDisplay(job.description) + '</div></div></div>';
    return html;
  }

  /** @returns {string[]} Fabrikationsnummern in Auftragsreihenfolge (wie Modal-Tabelle). */
  function parseJobFabrikationsnummernOrdered(job) {
    var raw = job && job.fabrikationsnummern;
    if (raw == null || raw === '') return [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(function (r) {
          if (r && typeof r === 'object') return String(r.fabrikationsnummer || r.Fabrikationsnummer || '').trim();
          if (r != null) return String(r).trim();
          return '';
        }).filter(Boolean);
      }
    } catch (e) { /* legacy Semikolon/Komma */ }
    return String(raw).split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
  }

  /** Kurzname oder Index-Relativpfad zu PROJEKTE NEU (Schlüssel inkl. numerischer FN-Normalisierung). */
  function projekteNeuDisplayPathForFab(fab, pnByFab, pnRelByFab) {
    var keys = [];
    var s = String(fab || '').trim();
    if (s) keys.push(s);
    if (s && /^\d+$/.test(s)) {
      var n = String(parseInt(s, 10));
      if (keys.indexOf(n) === -1) keys.push(n);
    }
    var i;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      var label = pnByFab && pnByFab[k];
      if (label != null && String(label).trim() !== '') return String(label).trim();
    }
    for (i = 0; i < keys.length; i++) {
      var k2 = keys[i];
      var rel = pnRelByFab && pnRelByFab[k2];
      if (rel != null && String(rel).trim() !== '') return String(rel).trim();
    }
    return '';
  }

  var mechanikTedLoadToken = 0;

  function loadMechanikTedLinks(job) {
    var el = document.getElementById('mechanikTedLinksContainer');
    if (!el) return;
    var loadToken = ++mechanikTedLoadToken;
    var expectedJobId = job && job.id != null ? job.id : null;
    var baseUrl = getDispoBaseUrl();
    var techId = getTechId();
    if (!baseUrl || !techId || !job) {
      el.innerHTML = '<p class="muted">Mechanik-Excel (TED): nur mit Dispo-Server-URL in den Einstellungen und Online-Verbindung.</p>';
      return;
    }
    var jobId = (job.server_id != null && job.server_id !== '') ? job.server_id : job.id;
    if (jobId == null || jobId === '') {
      el.innerHTML = '<p class="muted">Keine Auftrags-ID für TED-Abfrage.</p>';
      return;
    }
    el.innerHTML = '<p class="muted">Lade Mechanik-Excel…</p>';
    fetch(API_BASE + '/api/mechanik_ted_excel_from_dispo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
      body: JSON.stringify({
        baseUrl: baseUrl,
        jobId: jobId,
        serverUsername: getDispoUsername(),
        serverPassword: getDispoPassword()
      })
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        if (loadToken !== mechanikTedLoadToken || !jobIdsEqual(expectedJobId, jobDetailsJobId)) return;
        if (!result.ok || !result.data || !result.data.ok) {
          el.innerHTML = '<p class="muted">Mechanik-Excel konnte nicht geladen werden' + (result.data && result.data.error ? ': ' + escapeHtml(String(result.data.error)) : '.') + '</p>';
          return;
        }
        var byFab = result.data.by_fab || {};
        var pnByFab = result.data.pn_by_fab || {};
        var pnRelByFab = result.data.pn_folder_relpath_by_fab || {};
        var keysFromApi = Object.keys(byFab);
        if (keysFromApi.length === 0) {
          el.innerHTML = '<p class="muted">Keine Fabrikationsnummern am Auftrag (oder keine Daten von der Dispo).</p>';
          return;
        }
        var fabOrder = parseJobFabrikationsnummernOrdered(job);
        var seenFab = {};
        var orderedFabs = [];
        fabOrder.forEach(function (f) {
          if (!f || seenFab[f]) return;
          if (keysFromApi.indexOf(f) === -1) return;
          seenFab[f] = true;
          orderedFabs.push(f);
        });
        keysFromApi.forEach(function (f) {
          if (!seenFab[f]) {
            seenFab[f] = true;
            orderedFabs.push(f);
          }
        });
        var html = '<div class="kukla-ted-fab-list">';
        orderedFabs.forEach(function (fab) {
          var files = byFab[fab] || [];
          var pnLabel = projekteNeuDisplayPathForFab(fab, pnByFab, pnRelByFab);
          html += '<div class="kukla-ted-fab-box card">';
          html += '<div class="kukla-ted-fab-head"><strong>FN ' + escapeHtml(String(fab)) + '</strong></div>';
          html += '<div class="kukla-ted-fab-body">';
          if (files.length === 0) {
            html += '<p class="muted kukla-ted-empty">Keine TED-Dateien im Index für diese FN.</p>';
          } else {
            html += '<ul class="kukla-ted-ul">';
            files.forEach(function (f) {
              var rel = String(f.rel_path || '').trim();
              var dt = (f.file_mtime || '').toString();
              var w = f.fn_matches_filename === false ? ' ⚠' : '';
              var fn = String(f.file_name || '').trim();
              html += '<li><button type="button" class="btn btn-ghost ted-open-file" data-ted-rel="' + String(rel).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '" data-ted-job-id="' + String(jobId).replace(/"/g, '&quot;') + '" data-ted-local-job-id="' + String(job.id).replace(/"/g, '&quot;') + '" data-ted-fab="' + String(fab).replace(/"/g, '&quot;') + '" data-ted-filename="' + String(fn).replace(/"/g, '&quot;') + '">' + escapeHtml(fn || rel.split(/[/\\]/).pop() || 'Excel') + '</button> <span class="muted">' + escapeHtml(dt) + '</span>' + w + '</li>';
            });
            html += '</ul>';
          }
          html += '<details class="kukla-ted-pn-details">';
          html += '<summary class="kukla-ted-pn-summary">Projekte Neu Pfad</summary>';
          html += '<div class="kukla-ted-pn-path">' + (pnLabel ? escapeHtml(pnLabel) : '<span class="muted">—</span>') + '</div>';
          html += '</details>';
          html += '</div></div>';
        });
        html += '</div>';
        el.innerHTML = html;
        el.querySelectorAll('.ted-open-file[data-ted-rel]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var rel = btn.getAttribute('data-ted-rel') || '';
            var tedJobId = btn.getAttribute('data-ted-job-id') || '';
            var tedLocalJobId = btn.getAttribute('data-ted-local-job-id') || '';
            var tedFab = btn.getAttribute('data-ted-fab') || '';
            var tedFileName = btn.getAttribute('data-ted-filename') || '';
            if (!rel) return;
            openTedExcelOnDevice(rel, tedJobId, tedLocalJobId, tedFab, tedFileName, btn);
          });
        });
      })
      .catch(function (e) {
        if (loadToken !== mechanikTedLoadToken || !jobIdsEqual(expectedJobId, jobDetailsJobId)) return;
        el.innerHTML = '<p class="muted">Mechanik-Excel (TED): Offline oder Dispo nicht erreichbar.</p>';
      });
  }

  var hotelChoicesLoadToken = 0;

  function loadHotelChoicesByFab(job) {
    var content = document.getElementById('viewProjektdatenContent');
    if (!content || !job) return;
    var loadToken = ++hotelChoicesLoadToken;
    var expectedJobId = job.id;
    var baseUrl = getDispoBaseUrl();
    var techId = getTechId();
    if (!baseUrl || !techId) return;
    var jobId = (job.server_id != null && job.server_id !== '') ? job.server_id : job.id;
    if (jobId == null || jobId === '') return;
    fetch(API_BASE + '/api/job_hotels_from_dispo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
      body: JSON.stringify({
        baseUrl: baseUrl,
        jobId: jobId,
        serverUsername: getDispoUsername(),
        serverPassword: getDispoPassword()
      })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (loadToken !== hotelChoicesLoadToken || !jobIdsEqual(expectedJobId, jobDetailsJobId)) return;
        if (!res.ok || !res.data || !res.data.ok) return;
        var byFab = res.data.by_fab || {};
        function hotelListForFab(byFabMap, fabKey) {
          var f = String(fabKey || '').trim();
          if (!f) return null;
          var list = byFabMap[f];
          if (Array.isArray(list) && list.length > 0) return list;
          if (/^\d+$/.test(f)) {
            var num = parseInt(f, 10);
            var k;
            for (k in byFabMap) {
              if (!Object.prototype.hasOwnProperty.call(byFabMap, k)) continue;
              var ks = String(k).trim();
              if (!/^\d+$/.test(ks)) continue;
              if (parseInt(ks, 10) !== num) continue;
              list = byFabMap[k];
              if (Array.isArray(list) && list.length > 0) return list;
            }
          }
          return null;
        }
        content.querySelectorAll('.hotel-fab-cell[data-fab]').forEach(function (cell) {
          var fab = (cell.getAttribute('data-fab') || '').trim();
          var hotels = hotelListForFab(byFab, fab);
          if (!hotels) return;
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-ghost fn-hotel-picker-btn';
          btn.style.marginLeft = '8px';
          btn.textContent = '🏨';
          btn.title = 'Hotels zu dieser FN anzeigen';
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            openHotelSelectionByFabModal(job, hotels);
          });
          // Sonst feuert dblclick auf der übergeordneten Zelle → Anlagendetails (siehe bindLeistungActions).
          btn.addEventListener('dblclick', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
          });
          cell.appendChild(btn);
        });
      }).catch(function () {});
  }

  function openHotelSelectionByFabModal(job, hotels) {
    if (!Array.isArray(hotels) || hotels.length === 0) return;
    var modal = document.createElement('div');
    // .modal-overlay allein ist display:none – wie Anlagen-Dialog .anlage-detail-modal nutzen (sichtbar + zentriert).
    modal.className = 'modal-overlay anlage-detail-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    var html = '<div class="modal-box"><h3>Hoteladresse auswählen</h3><div class="modal-detail-section">';
    hotels.forEach(function (h, idx) {
      var name = (h.name || '').trim() || 'Hotel';
      var line2 = [h.street || '', h.house_number || ''].filter(Boolean).join(' ');
      var line3 = [h.zip || '', h.city || ''].filter(Boolean).join(' ');
      html += '<div style="border:1px solid #3b4756;border-radius:8px;padding:8px;margin-bottom:8px;">';
      html += '<div><strong>' + escapeHtml(name) + '</strong></div>';
      if (line2) html += '<div class="muted">' + escapeHtml(line2) + '</div>';
      if (line3) html += '<div class="muted">' + escapeHtml(line3) + '</div>';
      html += '<button type="button" class="btn btn-primary js-hotel-select" data-idx="' + String(idx) + '">Als Auftrags-Hotel übernehmen</button>';
      html += '</div>';
    });
    html += '</div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="hotelSelectClose">Schließen</button></div></div>';
    modal.innerHTML = html;
    document.body.appendChild(modal);
    function close() { if (modal && modal.parentNode) modal.parentNode.removeChild(modal); }
    var closeBtn = modal.querySelector('#hotelSelectClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelectorAll('.js-hotel-select').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-idx') || -1);
        if (!Number.isFinite(idx) || idx < 0 || !hotels[idx]) return;
        var h = hotels[idx];
        api('/api/job', {
          method: 'PATCH',
          body: JSON.stringify({
            job_id: Number(job.id),
            hotel_endkunde: h.name || '',
            hotel_street: h.street || '',
            hotel_house_number: h.house_number || '',
            hotel_zip: h.zip || '',
            hotel_city: h.city || '',
            hotel_country: h.country || '',
            hotel_address_extra_1: h.address_extra_1 || '',
            hotel_address_extra_2: h.address_extra_2 || '',
            hotel_phone: h.phone || '',
            hotel_email: h.email || '',
            hotel_website: h.website || '',
            hotel_selection: { hotel_id: Number(h.id || 0), comment: '', rating_stars: null }
          })
        }).then(function () {
          close();
          openJobDetailsModal(job.id);
        }).catch(function (e) {
          alert('Hotelauswahl fehlgeschlagen: ' + e.message);
        });
      });
    });
  }

  var tedExcelDownloadToken = 0;

  function setTedExcelDownloadLoading(isLoading, label) {
    var ov = document.getElementById('tedExcelDownloadOverlay');
    if (!ov) return;
    if (isLoading) {
      ov.hidden = false;
      ov.setAttribute('aria-busy', 'true');
      var lbl = ov.querySelector('.ted-excel-download-label');
      if (lbl) lbl.textContent = label || 'Excel wird geladen…';
    } else {
      ov.hidden = true;
      ov.setAttribute('aria-busy', 'false');
    }
  }

  function openTedExcelOnDevice(relPath, jobId, localJobId, fab, fileName, triggerBtn) {
    relPath = String(relPath || '').trim();
    jobId = jobId != null && jobId !== '' ? jobId : null;
    localJobId = localJobId != null && localJobId !== '' ? localJobId : null;
    fab = String(fab || '').trim();
    fileName = String(fileName || '').trim();
    var baseUrl = getDispoBaseUrl();
    var techId = getTechId();
    if (!relPath || !baseUrl || !techId || jobId == null || jobId === '') {
      alert('TED-Datei kann nicht geöffnet werden (Pfad, Auftrag oder Verbindung fehlt).');
      return;
    }
    var loadToken = ++tedExcelDownloadToken;
    var loadLabel = fileName
      ? 'Lädt ' + fileName + '…'
      : 'Excel wird geladen…';
    setTedExcelDownloadLoading(true, loadLabel);
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.setAttribute('aria-busy', 'true');
    }
    function finishLoading() {
      if (loadToken !== tedExcelDownloadToken) return;
      setTedExcelDownloadLoading(false);
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.removeAttribute('aria-busy');
      }
    }
    fetch(API_BASE + '/api/mechanik_ted_excel_open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
      body: JSON.stringify({
        baseUrl: baseUrl,
        jobId: jobId,
        local_job_id: localJobId,
        rel_path: relPath,
        fab: fab,
        file_name: fileName,
        serverUsername: getDispoUsername(),
        serverPassword: getDispoPassword()
      })
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok || !result.data || result.data.ok !== true || !result.data.path) {
          var err = (result.data && result.data.error) ? String(result.data.error) : 'Download fehlgeschlagen.';
          alert('TED-Datei: ' + err);
          return;
        }
        setTedExcelDownloadLoading(true, 'Starte Excel…');
        var openFn = (typeof monteurApp !== 'undefined' && (monteurApp.openExcel || monteurApp.openPath))
          ? (monteurApp.openExcel || monteurApp.openPath)
          : null;
        if (openFn) {
          return openFn(String(result.data.path)).then(function (openRes) {
            if (openRes && openRes.error) alert('Excel konnte nicht gestartet werden: ' + openRes.error);
          });
        }
        alert('Datei gespeichert unter: ' + result.data.path);
      })
      .catch(function (e) {
        alert('TED-Datei: ' + (e && e.message ? e.message : 'Netzwerkfehler'));
      })
      .finally(finishLoading);
  }

  function fillAnlageDetailFieldsFromLocalStamm(fab, rowIndex) {
    fab = String(fab || '').trim();
    if (!fab) return Promise.resolve();
    var loadToken = ++anlageDetailStammLoadToken;
    return fetch(API_BASE + '/api/anlagenstamm_lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId() || '') },
      body: JSON.stringify({ fab: fab })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (loadToken !== anlageDetailStammLoadToken) return;
        if (!document.getElementById('anlageDetailModal')) return;
        if (!data || !data.ok || !data.row) return;
        var st = data.row;
        var idEl = document.getElementById('anlageDetailStammId');
        if (idEl && st.id != null && parseInt(st.id, 10) > 0) {
          idEl.value = String(parseInt(st.id, 10));
        }
        function setFromStammIfEmpty(id, val) {
          var el = document.getElementById(id);
          if (!el) return;
          var v = sanitizeLeistungField(val);
          if (!v) return;
          if (!String(el.value || '').trim()) el.value = v;
        }
        setFromStammIfEmpty('anlageDetailType', st.type);
        setFromStammIfEmpty('anlageDetailLeistung', st.leistung);
        setFromStammIfEmpty('anlageDetailNenngeschwindigkeit', st.nenngeschwindigkeit);
        setFromStammIfEmpty('anlageDetailKraftaufnehmer', st.kraftaufnehmer);
        setFromStammIfEmpty('anlageDetailDmsNr', st.dms_nr);
        setFromStammIfEmpty('anlageDetailTacho', st.tacho);
        setFromStammIfEmpty('anlageDetailElektronik', st.elektronik);
        setFromStammIfEmpty('anlageDetailMaterial', st.material);
        setFromStammIfEmpty('anlageDetailPosition', st.position);
        setFromStammIfEmpty('anlageDetailGeliefertUeber', st.geliefert_ueber);
        setFromStammIfEmpty('anlageDetailProjekt', st.projekt);
        var ta = document.getElementById('anlageDetailBemerkungen');
        if (ta && !String(ta.value || '').trim()) {
          var bv = sanitizeLeistungField(st.bemerkungen);
          if (bv) ta.value = bv;
        }
      })
      .catch(function () {});
  }

  function openAnlageDetailModal(rowIndex) {
    if (isJobAngelegtReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var rows = window.currentProjektdatenLeistungRows;
    if (!rows || !rows[rowIndex]) return;
    var baseRow = rows[rowIndex];
    var fab = String(baseRow.fabrikationsnummer || '').trim();
    var openToken = ++anlageDetailOpenToken;
    openAnlageDetailModalWithRow(rowIndex, baseRow, 0);
    if (!fab) return;
    fetch(API_BASE + '/api/anlagenstamm_lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId() || '') },
      body: JSON.stringify({ fab: fab })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (openToken !== anlageDetailOpenToken) return;
        var idEl = document.getElementById('anlageDetailStammId');
        if (!idEl) return;
        var st = data && data.ok && data.row ? data.row : null;
        var sid = st && st.id != null && parseInt(st.id, 10) > 0 ? parseInt(st.id, 10) : 0;
        if (sid > 0) idEl.value = String(sid);
      })
      .catch(function () {});
  }

  function openAnlageDetailModalWithRow(rowIndex, row, initialStammId) {
    var jobId = jobDetailsJobId;
    if (!jobId) return;
    var attr = function (x) { return escapeHtml(String(x == null ? '' : x)).replace(/"/g, '&quot;'); };
    var modalHtml = '<div id="anlageDetailModal" class="modal-overlay anlage-detail-modal" role="dialog">';
    modalHtml += '<div class="modal-box anlage-detail-content">';
    modalHtml += '<h3>Anlagendetails</h3>';
    modalHtml += '<p class="anlage-detail-fn"><strong>Fabrikationsnummer:</strong> <span id="anlageDetailFn">' + attr(row.fabrikationsnummer) + '</span></p>';
    modalHtml += '<input type="hidden" id="anlageDetailRowIndex" value="' + attr(String(rowIndex)) + '">';
    modalHtml += '<input type="hidden" id="anlageDetailStammId" value="' + attr(String(initialStammId > 0 ? initialStammId : 0)) + '">';
    modalHtml += '<div class="anlage-detail-fields">';
    modalHtml += '<div class="anlage-detail-col"><dl class="anlage-detail-dl">';
    modalHtml += '<dt>Type</dt><dd><input type="text" id="anlageDetailType" value="' + attr(row.type) + '"></dd>';
    modalHtml += '<dt>Leistung</dt><dd><input type="text" id="anlageDetailLeistung" value="' + attr(row.leistung) + '"></dd>';
    modalHtml += '<dt>Nenngeschwindigkeit</dt><dd><input type="text" id="anlageDetailNenngeschwindigkeit" value="' + attr(row.nenngeschwindigkeit) + '"></dd>';
    modalHtml += '<dt>Kraftaufnehmer</dt><dd><input type="text" id="anlageDetailKraftaufnehmer" value="' + attr(row.kraftaufnehmer) + '"></dd>';
    modalHtml += '<dt>DMS Nr.</dt><dd><input type="text" id="anlageDetailDmsNr" value="' + attr(row.dms_nr) + '"></dd>';
    modalHtml += '<dt>Tacho</dt><dd><input type="text" id="anlageDetailTacho" value="' + attr(row.tacho) + '"></dd>';
    modalHtml += '</dl></div>';
    modalHtml += '<div class="anlage-detail-col"><dl class="anlage-detail-dl">';
    modalHtml += '<dt>Elektronik</dt><dd><input type="text" id="anlageDetailElektronik" value="' + attr(row.elektronik) + '"></dd>';
    modalHtml += '<dt>Material</dt><dd><input type="text" id="anlageDetailMaterial" value="' + attr(row.material) + '"></dd>';
    modalHtml += '<dt>Position</dt><dd><input type="text" id="anlageDetailPosition" value="' + attr(row.position) + '"></dd>';
    modalHtml += '<dt>Geliefert über</dt><dd><input type="text" id="anlageDetailGeliefertUeber" value="' + attr(row.geliefert_ueber) + '"></dd>';
    modalHtml += '<dt>Projekt</dt><dd><input type="text" id="anlageDetailProjekt" value="' + attr(row.projekt) + '"></dd>';
    modalHtml += '<dt>Bemerkungen</dt><dd><textarea id="anlageDetailBemerkungen" rows="3">' + attr(row.bemerkungen) + '</textarea></dd>';
    modalHtml += '</dl></div></div>';
    modalHtml += '<details class="anlage-detail-projekte-neu" id="anlageDetailProjekteNeuToggle">';
    modalHtml += '<summary><strong>PROJEKTE NEU</strong></summary>';
    modalHtml += '<div id="anlageDetailProjekteNeuMessage" class="muted" style="margin:0.5rem 0">Lade Struktur…</div>';
    modalHtml += '<div id="anlageDetailProjekteNeuTree" style="margin-top:0.35rem"></div>';
    modalHtml += '</details>';
    modalHtml += '<div class="anlage-detail-actions">';
    modalHtml += '<button type="button" class="btn btn-primary" id="anlageDetailSave">Speichern</button>';
    modalHtml += ' <button type="button" class="btn btn-ghost" id="anlageDetailCancel">Abbrechen</button>';
    modalHtml += '</div></div></div>';
    var existing = document.getElementById('anlageDetailModal');
    if (existing) existing.remove();
    var wrap = document.getElementById('viewProjektdatenContent');
    if (!wrap) wrap = document.body;
    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    while (div.firstChild) wrap.appendChild(div.firstChild);
    var modal = document.getElementById('anlageDetailModal');
    if (!modal) return;
    var pnToggle = document.getElementById('anlageDetailProjekteNeuToggle');
    var pnFab = String(row.fabrikationsnummer || '').trim();
    function loadAnlagePnTree() {
      loadProjekteNeuTreeIntoHost(pnFab, {
        msgEl: document.getElementById('anlageDetailProjekteNeuMessage'),
        treeHost: document.getElementById('anlageDetailProjekteNeuTree'),
        toggleEl: pnToggle,
        jobId: jobId,
        allowOnline: false
      });
    }
    if (pnToggle) {
      pnToggle.addEventListener('toggle', function () {
        if (!pnToggle.open || pnToggle.getAttribute('data-loaded') === '1') return;
        loadAnlagePnTree();
      });
    }
    function syncModalInputsFromBuiltRow(row) {
      if (!row) return;
      var map = [
        ['anlageDetailType', row.type],
        ['anlageDetailLeistung', row.leistung],
        ['anlageDetailNenngeschwindigkeit', row.nenngeschwindigkeit],
        ['anlageDetailKraftaufnehmer', row.kraftaufnehmer],
        ['anlageDetailDmsNr', row.dms_nr],
        ['anlageDetailTacho', row.tacho],
        ['anlageDetailElektronik', row.elektronik],
        ['anlageDetailMaterial', row.material],
        ['anlageDetailPosition', row.position],
        ['anlageDetailGeliefertUeber', row.geliefert_ueber],
        ['anlageDetailProjekt', row.projekt]
      ];
      map.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el) el.value = sanitizeLeistungField(pair[1]);
      });
      var ta = document.getElementById('anlageDetailBemerkungen');
      if (ta) ta.value = sanitizeLeistungField(row.bemerkungen);
    }
    function closeModal() {
      anlageDetailStammLoadToken += 1;
      anlageDetailOpenToken += 1;
      projekteNeuThumbQueue.length = 0;
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    }
    document.getElementById('anlageDetailCancel').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
    var anlageSaveBusy = false;
    var anlageSaveQueued = null;
    var anlageDetailIgnoreBlur = false;
    function buildAnlageRowsFromModalDom() {
      var idxEl = document.getElementById('anlageDetailRowIndex');
      if (!idxEl) return null;
      var idx = parseInt(idxEl.value, 10);
      var rowsCopy = (window.currentProjektdatenLeistungRows || []).slice();
      if (!Number.isFinite(idx) || !rowsCopy[idx]) return null;
      rowsCopy[idx] = {
        fabrikationsnummer: rowsCopy[idx].fabrikationsnummer,
        type: sanitizeLeistungField(document.getElementById('anlageDetailType') && document.getElementById('anlageDetailType').value),
        leistung: sanitizeLeistungField(document.getElementById('anlageDetailLeistung') && document.getElementById('anlageDetailLeistung').value),
        nenngeschwindigkeit: sanitizeLeistungField(document.getElementById('anlageDetailNenngeschwindigkeit') && document.getElementById('anlageDetailNenngeschwindigkeit').value),
        kraftaufnehmer: sanitizeLeistungField(document.getElementById('anlageDetailKraftaufnehmer') && document.getElementById('anlageDetailKraftaufnehmer').value),
        dms_nr: sanitizeLeistungField(document.getElementById('anlageDetailDmsNr') && document.getElementById('anlageDetailDmsNr').value),
        tacho: sanitizeLeistungField(document.getElementById('anlageDetailTacho') && document.getElementById('anlageDetailTacho').value),
        elektronik: sanitizeLeistungField(document.getElementById('anlageDetailElektronik') && document.getElementById('anlageDetailElektronik').value),
        material: sanitizeLeistungField(document.getElementById('anlageDetailMaterial') && document.getElementById('anlageDetailMaterial').value),
        position: sanitizeLeistungField(document.getElementById('anlageDetailPosition') && document.getElementById('anlageDetailPosition').value),
        geliefert_ueber: sanitizeLeistungField(document.getElementById('anlageDetailGeliefertUeber') && document.getElementById('anlageDetailGeliefertUeber').value),
        projekt: sanitizeLeistungField(document.getElementById('anlageDetailProjekt') && document.getElementById('anlageDetailProjekt').value),
        bemerkungen: sanitizeLeistungField(document.getElementById('anlageDetailBemerkungen') && document.getElementById('anlageDetailBemerkungen').value)
      };
      var arr = leistungRowsForJobPatch(rowsCopy);
      return { rowsCopy: rowsCopy, arr: arr, rowIdx: idx };
    }
    function flushAnlageDetailSaveQueue() {
      if (!anlageSaveQueued) return;
      var next = anlageSaveQueued;
      anlageSaveQueued = null;
      runAnlageDetailPersist(next.built, next.closeAfter);
    }
    function runAnlageDetailPersist(built, closeAfter) {
      var rowIdx = built && Number.isFinite(built.rowIdx) ? built.rowIdx : NaN;
      var savedRow = Number.isFinite(rowIdx) ? built.rowsCopy[rowIdx] : null;
      var jobPatchBody = {
        job_id: parseInt(jobId, 10),
        fabrikationsnummern: JSON.stringify(built.arr),
      };
      api('/api/job', { method: 'PATCH', body: JSON.stringify(jobPatchBody) })
        .then(function (jobRes) {
          var patchOk =
            jobRes &&
            (jobRes.ok === true || jobRes.updated === 'fabrikationsnummern' || jobRes.pending_sync === true);
          if (!patchOk) {
            throw new Error(
              (jobRes && jobRes.error) ? jobRes.error : 'Auftrag (Fabrikationsnummern) konnte nicht lokal gespeichert werden.',
            );
          }
          applyAnlageDetailBuiltToProjektdaten(built);
          projektdatenFabSavedAt = Date.now();
          if (!closeAfter && savedRow) syncModalInputsFromBuiltRow(savedRow);
          return jobRes;
        })
        .then(function (jobRes) {
          if (typeof showToast !== 'function') return;
          if (closeAfter) {
            showToast(
              jobRes && jobRes.pending_sync
                ? 'Projektdaten lokal gespeichert – Dispo-Abgleich beim Sync.'
                : 'Projektdaten gespeichert.',
            );
          }
        })
        .catch(function (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        })
        .finally(function () {
          anlageSaveBusy = false;
          if (anlageSaveQueued) flushAnlageDetailSaveQueue();
        });
    }
    function persistAnlageDetail(closeAfter) {
      if (!document.getElementById('anlageDetailModal')) return;
      anlageDetailStammLoadToken += 1;
      var built = buildAnlageRowsFromModalDom();
      if (!built) return;
      if (closeAfter) {
        anlageDetailIgnoreBlur = true;
        closeModal();
        setTimeout(function () { anlageDetailIgnoreBlur = false; }, 0);
      }
      if (anlageSaveBusy) {
        anlageSaveQueued = { built: built, closeAfter: closeAfter };
        return;
      }
      anlageSaveBusy = true;
      runAnlageDetailPersist(built, closeAfter);
    }
    var anlageDetailSaveDebounce = null;
    function scheduleAnlageDetailSave(closeAfter) {
      if (anlageDetailSaveDebounce) clearTimeout(anlageDetailSaveDebounce);
      anlageDetailSaveDebounce = setTimeout(function () {
        anlageDetailSaveDebounce = null;
        persistAnlageDetail(closeAfter);
      }, closeAfter ? 0 : 450);
    }
    modal.querySelectorAll('input[type="text"]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        anlageDetailStammLoadToken += 1;
      });
      inp.addEventListener('blur', function () {
        if (anlageDetailIgnoreBlur) return;
        scheduleAnlageDetailSave(false);
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (anlageDetailSaveDebounce) clearTimeout(anlageDetailSaveDebounce);
          persistAnlageDetail(true);
        }
      });
    });
    var anlageTa = document.getElementById('anlageDetailBemerkungen');
    if (anlageTa) {
      anlageTa.addEventListener('input', function () {
        anlageDetailStammLoadToken += 1;
      });
      anlageTa.addEventListener('blur', function () {
        if (anlageDetailIgnoreBlur) return;
        scheduleAnlageDetailSave(false);
      });
    }
    var saveBtn = document.getElementById('anlageDetailSave');
    if (saveBtn) {
      saveBtn.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      saveBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (anlageDetailSaveDebounce) clearTimeout(anlageDetailSaveDebounce);
        persistAnlageDetail(true);
      });
    }
  }

  function addLeistungRow() {
    if (isJobAngelegtReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var tbody = document.getElementById('modalLeistungTbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'text';
    input.value = '';
    input.setAttribute('data-fab', '');
    td.appendChild(input);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function saveLeistungDaten() {
    if (isJobAngelegtReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var jobId = jobDetailsJobId;
    if (!jobId) return;
    var tbody = document.getElementById('modalLeistungTbody');
    if (!tbody) return;
    var rows = tbody.getElementsByTagName('tr');
    var arr = [];
    for (var i = 0; i < rows.length; i++) {
      var input = rows[i].querySelector('input[data-fab]');
      if (input) {
        var fn = input.value.trim();
        arr.push({
          fabrikationsnummer: fn,
          type: '',
          leistung: '',
          nenngeschwindigkeit: '',
          kraftaufnehmer: '',
          dms_nr: '',
          tacho: '',
          elektronik: '',
          material: '',
          position: '',
          geliefert_ueber: '',
          projekt: '',
          bemerkungen: ''
        });
      }
    }
    api('/api/job', {
      method: 'PATCH',
      body: JSON.stringify({ job_id: parseInt(jobId, 10), fabrikationsnummern: JSON.stringify(arr) })
    }).then(function () {
      var job = Object.assign({}, window.currentProjektdatenJob || {});
      job.fabrikationsnummern = JSON.stringify(arr);
      refreshProjektdatenAfterFabSave(job, null);
    }).catch(function (e) {
      alert('Speichern fehlgeschlagen: ' + e.message);
    });
  }

  function bindProjektdatenFabInput() {
    var input = document.getElementById('projektdatenFabrikationsnummern');
    if (!input || input.getAttribute('data-fab-bound') === '1') return;
    input.setAttribute('data-fab-bound', '1');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
    input.addEventListener('blur', function () {
      if (projektdatenFabSaveBusy) return;
      applyProjektdatenFabInput();
    });
  }

  function bindLeistungActions() {
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    if (content.getAttribute('data-leistung-delegate-bound') !== '1') {
      content.setAttribute('data-leistung-delegate-bound', '1');
      content.addEventListener('click', function (ev) {
        if (ev.button !== 0) return;
        if (ev.target.closest && (ev.target.closest('.fn-hotel-picker-btn') || ev.target.closest('button') || ev.target.closest('a'))) return;
        var tr = ev.target.closest('.projektdaten-leistung-row');
        if (!tr || !content.contains(tr)) return;
        var treeHost = document.getElementById('projektdatenProjekteNeuTree');
        var msgEl = document.getElementById('projektdatenProjekteNeuMsg');
        if (!treeHost || !msgEl) return;
        content.querySelectorAll('.projektdaten-leistung-row').forEach(function (r) {
          r.classList.remove('projektdaten-fn-row-selected');
        });
        tr.classList.add('projektdaten-fn-row-selected');
        var fabCell = tr.querySelector('[data-fab]');
        var fabVal = fabCell ? String(fabCell.getAttribute('data-fab') || '').trim() : '';
        loadProjekteNeuTreeIntoHost(fabVal, {
          msgEl: msgEl,
          treeHost: treeHost,
          jobId: jobDetailsJobId,
          allowOnline: false,
          keepTreeWhileLoading: true,
        });
      });
    }
    bindProjektdatenFabInput();
    content.querySelectorAll('.modal-leistung-cell-clickable').forEach(function (td) {
      td.addEventListener('dblclick', function (e) {
        if (e.target && e.target.closest && e.target.closest('.fn-hotel-picker-btn')) return;
        var idx = td.getAttribute('data-row-index');
        if (idx !== null && idx !== '') openAnlageDetailModal(parseInt(idx, 10));
      });
    });
    bindHotelAddressDblclick();
    var treeHostInit = document.getElementById('projektdatenProjekteNeuTree');
    var msgElInit = document.getElementById('projektdatenProjekteNeuMsg');
    if (treeHostInit && msgElInit) {
      content.querySelectorAll('.projektdaten-fn-row-selected').forEach(function (r) {
        r.classList.remove('projektdaten-fn-row-selected');
      });
      var firstRow = content.querySelector('.projektdaten-leistung-row');
      if (firstRow) {
        firstRow.classList.add('projektdaten-fn-row-selected');
        var fc = firstRow.querySelector('[data-fab]');
        var fv = fc ? String(fc.getAttribute('data-fab') || '').trim() : '';
        loadProjekteNeuTreeIntoHost(fv, {
          msgEl: msgElInit,
          treeHost: treeHostInit,
          jobId: jobDetailsJobId,
          allowOnline: false,
          keepTreeWhileLoading: true,
        });
      } else {
        msgElInit.textContent = '';
        treeHostInit.innerHTML = '';
      }
    }
  }

  function bindHotelAddressDblclick() {
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    content.querySelectorAll('.hotel-address-display').forEach(function (el) {
      el.addEventListener('dblclick', function () {
        var job = window.currentProjektdatenJob;
        if (job) openHotelAddressModal(job);
      });
    });
  }

  /**
   * Parst eingefügten Fließtext (E-Mail, Webseite) in Hotel-Adressfelder.
   * @param {string} raw - Rohtext
   * @param {{ code: string, name: string }[]} [countries] - Optionale Länderliste für Land-Erkennung
   * @returns {{ endkunde: string, street: string, house_number: string, zip: string, city: string, country: string, address_extra_1: string, address_extra_2: string, phone: string, email: string, website: string }}
   */
  function parseHotelAddressPaste(raw, countries) {
    var out = { endkunde: '', street: '', house_number: '', zip: '', city: '', country: '', address_extra_1: '', address_extra_2: '', phone: '', email: '', website: '' };
    var text = (raw || '').trim();
    if (!text) return out;
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length === 0 && text) { lines = text.split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
    // Eine Zeile mit Kommas (z. B. "Vivotel Gelsenkirchen, Hagenstraße 4, 45894 Gelsenkirchen") in Teile zerlegen
    if (lines.length === 1 && lines[0].indexOf(',') >= 0) {
      lines = lines[0].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (lines.length === 0) return out;
    var remainder = lines.slice();
    var emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    var urlRe = /https?:\/\/[^\s]+/;
    var urlWwwRe = /www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*/;
    var phoneRe = /[\+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{8,}/;
    for (var i = 0; i < remainder.length; i++) {
      var line = remainder[i];
      var emailMatch = line.match(emailRe);
      if (emailMatch && !out.email) { out.email = emailMatch[0]; line = line.replace(emailMatch[0], '').trim(); }
      var urlMatch = line.match(urlRe);
      if (urlMatch && !out.website) { out.website = urlMatch[0].replace(/[.,;:!?)]+$/, ''); line = line.replace(urlMatch[0], '').trim(); }
      if (!out.website) {
        var urlWwwMatch = line.match(urlWwwRe);
        if (urlWwwMatch) { out.website = ('https://' + urlWwwMatch[0]).replace(/[.,;:!?)]+$/, ''); line = line.replace(urlWwwMatch[0], '').trim(); }
      }
      var phoneMatch = line.match(phoneRe);
      if (phoneMatch && !out.phone) { out.phone = phoneMatch[0].trim(); line = line.replace(phoneMatch[0], '').trim(); }
      remainder[i] = line;
    }
    remainder = remainder.map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    remainder = remainder.filter(function (s) {
      if (s.length === 0 || /^[\s\-–—,.:;]+$/.test(s)) return false;
      if (!/[a-zA-Z0-9]{2,}/.test(s)) return false;
      if (/^(tel|fax|phone|mobile|mobil):/i.test(s) || (/(tel|fax|phone)\s*:/i.test(s) && /[\d+()\-.\s]{5,}/.test(s))) return false;
      if (/^(tel|fax|phone|telefon|mobile|mobil|e-?mail|webseite|website|www\.?|https?):?\s*[-–—\s]*$/i.test(s)) return false;
      if (s.length <= 3 && /^[a-z\-]+$/i.test(s)) return false;
      return true;
    });
    var countryCodes = { 'usa': 'US', 'united states': 'US', 'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'germany': 'DE', 'deutschland': 'DE', 'austria': 'AT', 'österreich': 'AT', 'switzerland': 'CH', 'schweiz': 'CH', 'india': 'IN', 'indien': 'IN', 'china': 'CN', 'france': 'FR', 'italy': 'IT', 'spain': 'ES', 'netherlands': 'NL' };
    var countryList = (countries && Array.isArray(countries)) ? countries : [];
    function matchCountry(str) {
      var s = (str || '').toLowerCase().trim();
      if (!s) return '';
      if (/^a\s*-?\s*/.test(s)) return 'AT';
      var code = countryCodes[s];
      if (code) return code;
      for (var c = 0; c < countryList.length; c++) {
        var item = countryList[c];
        var itemCode = (item.code || '').toUpperCase().slice(0, 2);
        var itemName = (item.name || '').toLowerCase();
        // Nur exakten 2-Buchstaben-Code matchen, nicht „Vivotel“ → VI (Jungferninseln)
        if ((s.length === 2 && itemCode === s.toUpperCase()) || itemName === s || (itemName && itemName.indexOf(s) === 0)) return itemCode;
      }
      if (/^(at|de|ch|us|gb|uk|fr|it|es|nl|in|cn|jp)$/i.test(s)) return s.toUpperCase().slice(0, 2);
      return '';
    }
    var zip5 = /\b(\d{5})\b/;
    var zip4 = /\b(\d{4})\b/;
    var zip5plus4 = /\b(\d{5}-\d{4})\b/;
    var zip6 = /\b(\d{6})\b/;
    var ukPostcode = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
    var countryLineIdx = -1;
    var countryCode = '';
    for (var k = remainder.length - 1; k >= 0; k--) {
      countryCode = matchCountry(remainder[k]);
      if (countryCode) { countryLineIdx = k; out.country = countryCode; break; }
    }
    if (countryLineIdx >= 0) {
      var countryLine = remainder[countryLineIdx];
      if (!/\b\d{4,5}\b/.test(countryLine)) remainder.splice(countryLineIdx, 1);
    }
    var zipLineIdx = -1;
    var zipVal = '';
    var cityVal = '';
    var zipLineHadComma = false;
    var zipLineStreetPart = '';
    var zipLineBeforePart = '';
    for (var z = 0; z < remainder.length; z++) {
      var ln = remainder[z];
      var m5 = ln.match(zip5);
      var m54 = ln.match(zip5plus4);
      var m6 = ln.match(zip6);
      var m4 = ln.match(zip4);
      var mUK = ln.match(ukPostcode);
      function setZipAndCity(matchVal) {
        zipVal = matchVal;
        zipLineIdx = z;
        var idx = ln.indexOf(matchVal);
        var before = ln.substring(0, idx).trim().replace(/\s*[•·]\s*$/, '').trim();
        var after = ln.substring(idx + matchVal.length).replace(/\s+/g, ' ').trim();
        cityVal = after;
        if (before && /[a-zA-Z]/.test(before)) zipLineBeforePart = before;
      }
      if (m54) { setZipAndCity(m54[1]); break; }
      if (mUK) { setZipAndCity(mUK[1].replace(/\s+/g, ' ')); break; }
      if (m6) { setZipAndCity(m6[1]); break; }
      if (m5) { setZipAndCity(m5[1]); break; }
      var isAddressLine = ln.indexOf(',') >= 0 || /^a\s*-\s*/i.test(ln);
      if (m4 && !zipVal && isAddressLine && !/tel|fax|phone/i.test(ln)) {
        zipVal = m4[1]; zipLineIdx = z;
        if (ln.indexOf(',') >= 0) {
          var parts2 = ln.split(',').map(function (p) { return p.trim(); });
          for (var p2 = 0; p2 < parts2.length; p2++) {
            if (parts2[p2].indexOf(zipVal) >= 0) {
              zipLineHadComma = true;
              zipLineStreetPart = p2 === 0 ? (parts2[1] || '') : (parts2[0] || '');
              cityVal = parts2[p2].replace(m4[1], '').replace(/^a\s*-\s*/i, '').replace(/\s+/g, ' ').trim();
              break;
            }
          }
        } else {
          cityVal = ln.replace(m4[1], '').replace(/^a\s*-\s*/i, '').replace(/\s+/g, ' ').trim();
        }
        if (/^a\s*-?\s*/i.test(ln)) out.country = 'AT';
        break;
      }
    }
    if (zipLineIdx >= 0) {
      out.zip = zipVal;
      out.city = (cityVal || '').replace(/^[\s,.\-–—]+/, '').replace(/[\s,.\-–—]+$/, '').trim();
      if (zipLineHadComma && zipLineStreetPart) remainder[zipLineIdx] = zipLineStreetPart;
      else if (zipLineBeforePart) remainder[zipLineIdx] = zipLineBeforePart;
      else remainder.splice(zipLineIdx, 1);
    }
    var streetLines = remainder.filter(function (s) {
      if (s.length === 0 || /^[\s\-–—,.:;]+$/.test(s)) return false;
      if (!/[a-zA-Z]/.test(s)) return false;
      if (/^(tel|fax|phone|telefon|mobile|mobil):/i.test(s) || (/(tel|fax|phone)\s*:/i.test(s) && /[\d+()\-.\s]{5,}/.test(s))) return false;
      if (/^(e-?mail|webseite|website|www\.?|https?):?\s*[-–—\s]*$/i.test(s)) return false;
      return true;
    });
    if (streetLines.length > 0) {
      out.endkunde = streetLines[0];
      if (streetLines.length > 1) {
        var lastLine = streetLines[streetLines.length - 1];
        var rest = streetLines.length > 2 ? lastLine : streetLines[1];
        var houseMatch = rest.match(/\s+(\d+[0-9a-zA-Z\/\-]*)\s*$/);
        if (houseMatch) {
          out.house_number = houseMatch[1];
          out.street = rest.replace(houseMatch[0], '').trim();
        } else {
          out.street = rest;
        }
        if (streetLines.length > 2) out.address_extra_1 = streetLines[1];
      }
    }
    return out;
  }

  function openHotelAddressModal(job) {
    if (isJobAngelegtReadOnly(job || window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var jobId = job && (job.id != null) ? job.id : jobDetailsJobId;
    if (!jobId) return;
    var attr = function (v) { return escapeHtml(String(v == null ? '' : v)).replace(/"/g, '&quot;'); };
    var modalHtml = '<div id="hotelAddressModalOverlay" class="hotel-modal-overlay">';
    modalHtml += '<div class="hotel-modal-card address-card">';
    modalHtml += '<h3>Hotel Adresse</h3>';
    modalHtml += '<div class="hotel-paste-wrap"><label>Adresse einfügen</label><textarea id="hotel_paste_address" class="hotel-paste-textarea" rows="4" placeholder="Komplette Adresse hier einfügen (z. B. aus E-Mail oder Webseite)"></textarea><button type="button" class="btn btn-ghost hotel-paste-btn" id="hotelPasteApply">In Felder übernehmen</button></div>';
    modalHtml += '<div class="row row-full-width"><div><label>Hotel</label><input type="text" id="hotel_edit_endkunde" value="' + attr(job.hotel_endkunde) + '" placeholder="Name oder Firma"></div></div>';
    modalHtml += '<div class="row"><div><label>Straße</label><input type="text" id="hotel_edit_street" value="' + attr(job.hotel_street) + '"></div><div style="max-width:80px"><label>Hausnr.</label><input type="text" id="hotel_edit_house_number" value="' + attr(job.hotel_house_number) + '" maxlength="32"></div></div>';
    modalHtml += '<div class="row row-city-to-edge"><div style="max-width:70px"><label>PLZ</label><input type="text" id="hotel_edit_zip" value="' + attr(job.hotel_zip) + '" maxlength="7"></div><div><label>Ort</label><input type="text" id="hotel_edit_city" value="' + attr(job.hotel_city) + '"></div></div>';
    var currentCountry = (job.hotel_country || '').trim();
    modalHtml += '<label>Land</label><div class="hotel-country-select-wrap">';
    modalHtml += '<span id="hotel_edit_country_flag" class="hotel-country-flag" aria-hidden="true"></span>';
    modalHtml += '<select id="hotel_edit_country" autocomplete="off">';
    modalHtml += '<option value="">Bitte wählen</option>';
    var countriesList = (typeof window.HOTEL_COUNTRIES !== 'undefined' && Array.isArray(window.HOTEL_COUNTRIES)) ? window.HOTEL_COUNTRIES : [];
    countriesList.forEach(function (c) {
      var sel = (currentCountry === (c.code || '')) ? ' selected' : '';
      var label = (c.name || '') + ' ' + (c.flag || '') + ' (' + (c.code || '') + ')';
      modalHtml += '<option value="' + attr(c.code) + '"' + sel + '>' + escapeHtml(label) + '</option>';
    });
    modalHtml += '</select></div>';
    modalHtml += '<label>Adresszusatz 1</label><input type="text" id="hotel_edit_extra_1" value="' + attr(job.hotel_address_extra_1) + '">';
    modalHtml += '<label>Adresszusatz 2</label><input type="text" id="hotel_edit_extra_2" value="' + attr(job.hotel_address_extra_2) + '">';
    modalHtml += '<label>Telefon</label><input type="tel" id="hotel_edit_phone" value="' + attr(job.hotel_phone) + '" placeholder="+43 ...">';
    modalHtml += '<label>E-Mail</label><input type="email" id="hotel_edit_email" value="' + attr(job.hotel_email) + '">';
    modalHtml += '<label>Webseite</label><input type="url" id="hotel_edit_website" value="' + attr(job.hotel_website) + '" placeholder="https://">';
    modalHtml += '<label>Kommentar zum Hotel</label><textarea id="hotel_edit_comment" rows="2" placeholder="Interner Kommentar">' + attr(job.hotel_comment || '') + '</textarea>';
    var rParsed = parseInt(String(job.hotel_rating_stars || ''), 10);
    var rInit = isFinite(rParsed) && rParsed >= 1 && rParsed <= 5 ? String(rParsed) : '';
    modalHtml += '<label>Bewertung</label>';
    modalHtml += '<input type="hidden" id="hotel_edit_rating" value="' + attr(rInit) + '">';
    modalHtml += '<div class="hotel-star-rating" role="group" aria-label="Hotelbewertung">';
    for (var ri = 1; ri <= 5; ri++) {
      var rOn = rInit !== '' && ri <= parseInt(rInit, 10);
      modalHtml += '<button type="button" class="hotel-star-btn' + (rOn ? ' hotel-star-btn--active' : '') + '" data-star="' + ri + '" aria-label="' + ri + ' von 5 Sternen">' + (rOn ? '★' : '☆') + '</button>';
    }
    modalHtml += '</div>';
    modalHtml += '<button type="button" class="btn btn-ghost hotel-rating-clear" id="hotel_rating_clear">Keine Bewertung</button>';
    modalHtml += '<div class="hotel-modal-actions"><button type="button" class="btn btn-primary" id="hotelModalSave">Speichern</button> <button type="button" class="btn btn-ghost" id="hotelModalCancel">Abbrechen</button></div>';
    modalHtml += '</div></div>';
    var existing = document.getElementById('hotelAddressModalOverlay');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    while (div.firstChild) document.body.appendChild(div.firstChild);
    var overlay = document.getElementById('hotelAddressModalOverlay');
    if (!overlay) return;
    function closeModal() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    function collectHotelModalPayload() {
      return {
        job_id: parseInt(jobId, 10),
        hotel_endkunde: (document.getElementById('hotel_edit_endkunde') && document.getElementById('hotel_edit_endkunde').value) || '',
        hotel_street: (document.getElementById('hotel_edit_street') && document.getElementById('hotel_edit_street').value) || '',
        hotel_house_number: (document.getElementById('hotel_edit_house_number') && document.getElementById('hotel_edit_house_number').value) || '',
        hotel_zip: (document.getElementById('hotel_edit_zip') && document.getElementById('hotel_edit_zip').value) || '',
        hotel_city: (document.getElementById('hotel_edit_city') && document.getElementById('hotel_edit_city').value) || '',
        hotel_country: (document.getElementById('hotel_edit_country') && document.getElementById('hotel_edit_country').value) || '',
        hotel_address_extra_1: (document.getElementById('hotel_edit_extra_1') && document.getElementById('hotel_edit_extra_1').value) || '',
        hotel_address_extra_2: (document.getElementById('hotel_edit_extra_2') && document.getElementById('hotel_edit_extra_2').value) || '',
        hotel_phone: (document.getElementById('hotel_edit_phone') && document.getElementById('hotel_edit_phone').value) || '',
        hotel_email: (document.getElementById('hotel_edit_email') && document.getElementById('hotel_edit_email').value) || '',
        hotel_website: (document.getElementById('hotel_edit_website') && document.getElementById('hotel_edit_website').value) || '',
        hotel_comment: (document.getElementById('hotel_edit_comment') && document.getElementById('hotel_edit_comment').value) || '',
        hotel_rating_stars: (document.getElementById('hotel_edit_rating') && document.getElementById('hotel_edit_rating').value) || ''
      };
    }
    function applyHotelPayloadToJob(payload) {
      var updatedJob = Object.assign({}, job, {
        hotel_endkunde: payload.hotel_endkunde,
        hotel_street: payload.hotel_street,
        hotel_house_number: payload.hotel_house_number,
        hotel_zip: payload.hotel_zip,
        hotel_city: payload.hotel_city,
        hotel_country: payload.hotel_country,
        hotel_address_extra_1: payload.hotel_address_extra_1,
        hotel_address_extra_2: payload.hotel_address_extra_2,
        hotel_phone: payload.hotel_phone,
        hotel_email: payload.hotel_email,
        hotel_website: payload.hotel_website,
        hotel_comment: payload.hotel_comment,
        hotel_rating_stars: payload.hotel_rating_stars
      });
      Object.assign(job, updatedJob);
      window.currentProjektdatenJob = updatedJob;
      return updatedJob;
    }
    function refreshHotelProjektdatenContent(updatedJob) {
      var viewProjektdaten = document.getElementById('viewProjektdaten');
      var viewStart = document.getElementById('viewStart');
      var viewEinstellungen = document.getElementById('viewEinstellungen');
      if (viewStart) viewStart.classList.add('hidden');
      if (viewEinstellungen) viewEinstellungen.classList.remove('active');
      if (viewProjektdaten) viewProjektdaten.classList.add('active');
      var content = document.getElementById('viewProjektdatenContent');
      if (content) {
        window.currentProjektdatenJob = updatedJob;
        content.innerHTML = renderJobDetailsContent(updatedJob);
        bindLeistungActions();
        if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      }
    }
    function runHotelDispoSyncPush() {
      var auth = typeof buildDispoSyncAuthPayload === 'function' ? buildDispoSyncAuthPayload() : null;
      if (!isValidDispoSyncAuth(auth)) return;
      fetch(API_BASE + '/api/sync_push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auth)
      })
        .then(function (res) {
          return res.json().then(function (d) {
            return { d: d };
          });
        })
        .then(function (x) {
          var d = x.d;
          if (!d || !d.ok) {
            if (typeof showToast === 'function') showToast('Sync fehlgeschlagen: ' + (d && d.error ? d.error : 'Unbekannt'));
            return;
          }
          if (d.job_id) {
            return pollBackgroundJobUntilTerminal(d.job_id, null, {}).then(function (j) {
              if (j.status === 'completed' && typeof showToast === 'function') {
                showToast('Hotel-Adresse wurde in die Dispo übertragen.');
              } else if (j.status !== 'completed' && typeof showToast === 'function') {
                showToast('Sync fehlgeschlagen: ' + (j.error || j.message || j.status));
              }
            });
          }
          if (typeof showToast === 'function') showToast('Hotel-Adresse wurde in die Dispo übertragen.');
        })
        .catch(function (e) {
          console.error('[Sync Push] Fehler:', e.message, e);
          if (typeof showToast === 'function') showToast('Sync fehlgeschlagen: ' + (e.message || 'Verbindung zur Dispo prüfen'));
        });
    }
    var hotelSaveBusy = false;
    var hotelSaveNeedsRetry = false;
    var hotelSaveRetryCloseAfter = false;
    function persistHotelModal(closeAfter) {
      if (!document.getElementById('hotelAddressModalOverlay')) return;
      if (hotelSaveBusy) {
        hotelSaveNeedsRetry = true;
        hotelSaveRetryCloseAfter = hotelSaveRetryCloseAfter || closeAfter;
        return;
      }
      var payload = collectHotelModalPayload();
      hotelSaveBusy = true;
      api('/api/job', { method: 'PATCH', body: JSON.stringify(payload) })
        .then(function () {
          var updatedJob = applyHotelPayloadToJob(payload);
          if (closeAfter) {
            closeModal();
            refreshHotelProjektdatenContent(updatedJob);
            runHotelDispoSyncPush();
            if (typeof checkConnectionAndSync === 'function') { try { checkConnectionAndSync({ blockingSync: false }); } catch (e) {} }
          }
        })
        .catch(function (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        })
        .finally(function () {
          hotelSaveBusy = false;
          if (hotelSaveNeedsRetry && document.getElementById('hotelAddressModalOverlay')) {
            hotelSaveNeedsRetry = false;
            var rc = hotelSaveRetryCloseAfter;
            hotelSaveRetryCloseAfter = false;
            persistHotelModal(rc);
          }
        });
    }
    function updateHotelCountryFlag() {
      var sel = document.getElementById('hotel_edit_country');
      var flagEl = document.getElementById('hotel_edit_country_flag');
      if (!sel || !flagEl) return;
      var code = (sel.value || '').trim().toUpperCase().slice(0, 2);
      flagEl.innerHTML = code ? countryFlagImg(code) : '';
    }
    updateHotelCountryFlag();
    document.getElementById('hotel_edit_country').addEventListener('change', function () {
      updateHotelCountryFlag();
      persistHotelModal(false);
    });
    function applyHotelModalStars(n) {
      var num = parseInt(String(n), 10);
      if (!isFinite(num) || num < 1) num = 0;
      var hidR = document.getElementById('hotel_edit_rating');
      if (hidR) hidR.value = num > 0 ? String(num) : '';
      var wrapStars = document.querySelector('#hotelAddressModalOverlay .hotel-star-rating');
      if (!wrapStars) return;
      wrapStars.querySelectorAll('.hotel-star-btn').forEach(function (b) {
        var si = parseInt(b.getAttribute('data-star'), 10);
        var on = isFinite(si) && si <= num;
        b.classList.toggle('hotel-star-btn--active', on);
        b.textContent = on ? '★' : '☆';
      });
    }
    var starWrapInit = document.querySelector('#hotelAddressModalOverlay .hotel-star-rating');
    if (starWrapInit) {
      starWrapInit.querySelectorAll('.hotel-star-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var ns = parseInt(b.getAttribute('data-star'), 10);
          if (isFinite(ns)) applyHotelModalStars(ns);
          persistHotelModal(false);
        });
      });
    }
    var hotelRatingClear = document.getElementById('hotel_rating_clear');
    if (hotelRatingClear) {
      hotelRatingClear.addEventListener('click', function () {
        applyHotelModalStars(0);
        persistHotelModal(false);
      });
    }
    var hotelPasteApply = document.getElementById('hotelPasteApply');
    var hotelPasteAddress = document.getElementById('hotel_paste_address');
    if (hotelPasteApply && hotelPasteAddress) {
      hotelPasteApply.addEventListener('click', function () {
        var countriesListForParser = (typeof window.HOTEL_COUNTRIES !== 'undefined' && Array.isArray(window.HOTEL_COUNTRIES)) ? window.HOTEL_COUNTRIES : [];
        var parsed = parseHotelAddressPaste(hotelPasteAddress.value, countriesListForParser);
        if (!(document.getElementById('hotel_edit_endkunde'))) return;
        var set = function (id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
        set('hotel_edit_endkunde', parsed.endkunde);
        set('hotel_edit_street', parsed.street);
        set('hotel_edit_house_number', parsed.house_number);
        set('hotel_edit_zip', parsed.zip);
        set('hotel_edit_city', parsed.city);
        set('hotel_edit_extra_1', parsed.address_extra_1);
        set('hotel_edit_extra_2', parsed.address_extra_2);
        set('hotel_edit_phone', parsed.phone);
        set('hotel_edit_email', parsed.email);
        set('hotel_edit_website', parsed.website);
        var countrySel = document.getElementById('hotel_edit_country');
        if (countrySel && parsed.country) {
          var opt = countrySel.querySelector('option[value="' + parsed.country + '"]');
          if (opt) countrySel.value = parsed.country; else countrySel.value = '';
        }
        updateHotelCountryFlag();
        persistHotelModal(false);
      });
    }
    overlay.querySelectorAll('input').forEach(function (inp) {
      if (inp.type === 'hidden') return;
      inp.addEventListener('blur', function () {
        persistHotelModal(false);
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          persistHotelModal(false);
        }
      });
    });
    var hotelCommentTa = document.getElementById('hotel_edit_comment');
    if (hotelCommentTa) {
      hotelCommentTa.addEventListener('blur', function () {
        persistHotelModal(false);
      });
    }
    document.getElementById('hotelModalCancel').addEventListener('click', closeModal);
    document.getElementById('hotelModalSave').addEventListener('click', function () {
      persistHotelModal(true);
    });
  }

  async function updateJobStatus(jobId, status) {
    var techId = getTechId();
    if (techId) {
      try {
        var jr = await fetch(API_BASE + '/api/job?id=' + encodeURIComponent(jobId), { headers: { 'X-Technician-Id': String(techId) } });
        var jd = await jr.json();
        if (jd.job && isJobAngelegtReadOnly(jd.job)) {
          alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
          return;
        }
      } catch (e) { /* weiter */ }
    }
    if (status === 'erledigt' && !confirm('Ist der Auftrag wirklich erledigt?')) return;
    try {
      await api('/api/job', {
        method: 'PATCH',
        body: JSON.stringify({ job_id: parseInt(jobId, 10), status }),
      });
      loadJobsAndAbsences();
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  async function finishAndCleanup(jobId) {
    var techIdPre = getTechId();
    if (techIdPre) {
      try {
        var jr2 = await fetch(API_BASE + '/api/job?id=' + encodeURIComponent(jobId), { headers: { 'X-Technician-Id': String(techIdPre) } });
        var jd2 = await jr2.json();
        if (jd2.job && isJobAngelegtReadOnly(jd2.job)) {
          alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
          return;
        }
      } catch (e) { /* weiter */ }
    }
    if (!confirm('Ist der Auftrag wirklich erledigt?')) return;
    var techId = getTechId();
    var baseUrl = getDispoBaseUrl();
    var u = getDispoUsername();
    var p = getDispoPassword();
    var protectedSet = dienstreiseProtectedPathsByJob[jobId] || new Set();
    var body = {
      job_id: jobId,
      protectedPaths: Array.from(protectedSet),
      dispoBaseUrl: baseUrl,
      dispoExternalUrl: getDispoExternalUrl(),
      dispoInternalUrl: getDispoInternalUrl(),
      technicianId: techId,
      dispoUsername: u,
      dispoPassword: p
    };
    try {
      var r = await fetch(API_BASE + '/api/dienstreise/finish_and_cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data || data.ok === false) {
        alert('Abschluss fehlgeschlagen: ' + (data && data.error ? data.error : ('Status ' + r.status)));
        return;
      }
      loadJobsAndAbsences();
      loadDienstreiseList();
    } catch (e) {
      alert('Abschluss fehlgeschlagen: ' + (e && e.message ? e.message : 'Unbekannter Fehler'));
    }
  }

  async function loadOpenJobs() {
    const techId = getTechId();
    const list = document.getElementById('jobsList');
    const cbNoDateOpen = document.getElementById('openJobsFilterNoDate');
    const cbNoTechOpen = document.getElementById('openJobsFilterNoTech');
    const cbAlleOpen = document.getElementById('openJobsFilterAlleNonErledigt');
    const anyFilterOn = Boolean(
      (cbNoDateOpen && cbNoDateOpen.checked) ||
      (cbNoTechOpen && cbNoTechOpen.checked) ||
      (cbAlleOpen && cbAlleOpen.checked)
    );
    if (!anyFilterOn) {
      cachedOpenJobs = [];
      renderOpenJobsWithFilters();
      return;
    }
    if (!techId) {
      cachedOpenJobs = [];
      if (list) list.innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
      return;
    }
    const jobOpenQs = {};
    if (cbAlleOpen && cbAlleOpen.checked) {
      jobOpenQs.include_erledigt = '0';
    } else {
      if (cbNoDateOpen && cbNoDateOpen.checked) jobOpenQs.filter_no_date = '1';
      if (cbNoTechOpen && cbNoTechOpen.checked) jobOpenQs.filter_no_technician = '1';
    }
    try {
      const localRes = await fetch(API_BASE + '/api/jobs_open_local?' + qs(jobOpenQs), {
        headers: { 'X-Technician-Id': String(techId) },
      });
      const localData = await localRes.json().catch(function () { return []; });
      if (localRes.ok && Array.isArray(localData)) {
        cachedOpenJobs = localData;
        renderOpenJobsWithFilters();
      }
    } catch (e) {
      if (!cachedOpenJobs.length && list) {
        list.innerHTML = '<span class="empty">Lokale Aufträge nicht lesbar: ' + escapeHtml(e.message) + '</span>';
      }
      return;
    }
    if (!cachedOpenJobs.length && list) {
      list.innerHTML =
        '<span class="empty">Keine lokalen offenen Aufträge. Filter setzen oder einmal mit Dispo synchronisieren (Badge).</span>';
    }
  }

  async function loadJobsAndAbsences() {
    const techId = getTechId();
    if (!techId) {
      var jobsListEl = document.getElementById('jobsList');
      if (jobsListEl) jobsListEl.innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
      document.getElementById('absencesList').innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
      updateTechnicianName();
      return;
    }
    const range = getSyncDateRange();
    const params = { technician_id: techId, date_from: range.date_from, date_to: range.date_to };
    try {
      const [aRes, reqRes] = await Promise.all([
        fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
        fetch(API_BASE + '/api/my_absence_requests?' + qs({ technician_id: techId }), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()).catch(() => ({ ok: true, requests: [] }))
      ]);
      renderAbsences(aRes, reqRes);
      updateTechnicianName();
    } catch (e) {
      document.getElementById('absencesList').innerHTML = '<span class="empty">Fehler: ' + e.message + '</span>';
      updateTechnicianName();
    }
  }

  var resolveMonteurProfileInFlight = null;
  var resolveMonteurProfileDebounceTimer = null;
  var RESOLVE_MONTEUR_PROFILE_DEBOUNCE_MS = 600;

  function applyMonteurProfileFromConnection(check) {
    if (!check) return false;
    var changed = false;
    var tid = parseInt(check.technician_id, 10);
    if (Number.isFinite(tid) && tid > 0) {
      var elId = document.getElementById('technicianId');
      if (elId && String(elId.value) !== String(tid)) {
        elId.value = String(tid);
        changed = true;
      }
    }
    var fullName = check.full_name != null ? String(check.full_name).trim() : '';
    if (fullName) {
      var elFn = document.getElementById('monteurFullName');
      if (elFn && elFn.value !== fullName) {
        elFn.value = fullName;
        changed = true;
      }
    }
    if (changed) {
      saveSettingsToStorage();
    }
    if (fullName) {
      var elToolbar = document.getElementById('technicianName');
      if (elToolbar) elToolbar.textContent = fullName;
    }
    return changed || !!fullName || (Number.isFinite(tid) && tid > 0);
  }

  function setMonteurProfileResolveHint(text, isOk) {
    var el = document.getElementById('monteurProfileHint');
    if (!el) return;
    var msg = (text != null ? String(text) : '').trim();
    el.textContent = msg;
    el.style.color = isOk ? '' : 'var(--danger, #c62828)';
  }

  function tryResolveMonteurProfileViaCheckConnection() {
    var ext = getDispoExternalUrl();
    var intUrl = getDispoInternalUrl();
    if (!ext && !intUrl) {
      setMonteurProfileResolveHint('Bitte mindestens eine Dispo-URL eintragen.');
      return Promise.resolve(false);
    }
    return fetch(API_BASE + '/api/check_connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalUrl: ext,
        internalUrl: intUrl,
        technicianId: getTechId(),
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword(),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (check) {
        applyMonteurProfileFromConnection(check);
        if (check && check.used_base_url) {
          var connectedBase = String(check.used_base_url).trim().replace(/\/+$/, '');
          var extNorm = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
          var intNorm = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
          var src = connectedBase === intNorm ? 'internal' : connectedBase === extNorm ? 'external' : 'fallback';
          setDispoActiveBase(connectedBase, src);
        }
        if (getTechId()) {
          setMonteurProfileResolveHint('Monteur-ID aus Dispo übernommen.', true);
          updateTechnicianName();
          return true;
        }
        var err =
          (check && check.error) ||
          'Monteur-ID konnte nicht ermittelt werden (Dispo-Login oder monteur_auth prüfen).';
        setMonteurProfileResolveHint(err);
        return false;
      });
  }

  function resolveMonteurProfileFromDispo() {
    var user = getServerUsername();
    if (!user) {
      setMonteurProfileResolveHint('Bitte Dispo-Benutzername eintragen.');
      return Promise.resolve(false);
    }
    if (!getServerPassword()) {
      setMonteurProfileResolveHint('Bitte Dispo-Passwort eintragen (danach Speichern oder Feld verlassen).');
      return Promise.resolve(false);
    }
    var ext = getDispoExternalUrl();
    var intUrl = getDispoInternalUrl();
    if (!ext && !intUrl) {
      setMonteurProfileResolveHint('Bitte mindestens eine Dispo-URL eintragen.');
      return Promise.resolve(false);
    }
    if (resolveMonteurProfileInFlight) return resolveMonteurProfileInFlight;
    setMonteurProfileResolveHint('Ermittle Monteur-ID…');
    resolveMonteurProfileInFlight = fetch(API_BASE + '/api/monteur_profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalUrl: ext,
        internalUrl: intUrl,
        serverUsername: user,
        serverPassword: getServerPassword(),
      }),
    })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
      })
      .then(function (data) {
        if (data && data.ok === true) {
          applyMonteurProfileFromConnection(data);
          if (data.used_base_url) {
            var connectedBase = String(data.used_base_url).trim().replace(/\/+$/, '');
            var extNorm = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
            var intNorm = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
            var src = connectedBase === intNorm ? 'internal' : connectedBase === extNorm ? 'external' : 'fallback';
            setDispoActiveBase(connectedBase, src);
          }
          if (getTechId()) {
            setMonteurProfileResolveHint('Monteur-ID aus Dispo übernommen.', true);
            updateTechnicianName();
            return true;
          }
        }
        if (data && parseInt(data.technician_id, 10) > 0) {
          applyMonteurProfileFromConnection(data);
          if (getTechId()) {
            setMonteurProfileResolveHint('Monteur-ID aus Dispo übernommen.', true);
            updateTechnicianName();
            return true;
          }
        }
        if (data && data.error) {
          return tryResolveMonteurProfileViaCheckConnection().then(function (ok) {
            if (!ok && data.error) setMonteurProfileResolveHint(data.error);
            return ok;
          });
        }
        return tryResolveMonteurProfileViaCheckConnection();
      })
      .catch(function () {
        return tryResolveMonteurProfileViaCheckConnection();
      })
      .finally(function () {
        resolveMonteurProfileInFlight = null;
      });
    return resolveMonteurProfileInFlight;
  }

  function scheduleResolveMonteurProfileFromDispo() {
    if (!getServerUsername()) return;
    clearTimeout(resolveMonteurProfileDebounceTimer);
    resolveMonteurProfileDebounceTimer = setTimeout(function () {
      resolveMonteurProfileFromDispo();
    }, RESOLVE_MONTEUR_PROFILE_DEBOUNCE_MS);
  }

  function wireMonteurProfileAutoResolve() {
    ['serverUsername', 'serverPassword'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', scheduleResolveMonteurProfileFromDispo);
      el.addEventListener('change', scheduleResolveMonteurProfileFromDispo);
      el.addEventListener('blur', function () {
        clearTimeout(resolveMonteurProfileDebounceTimer);
        try { saveSettingsToStorage(); } catch (e) { /* ignore */ }
        if (getServerUsername()) resolveMonteurProfileFromDispo();
      });
    });
    ['serverUrl', 'serverUrlInternal'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', scheduleResolveMonteurProfileFromDispo);
      el.addEventListener('blur', function () {
        if (getServerUsername()) resolveMonteurProfileFromDispo();
      });
    });
  }

  async function updateTechnicianName() {
    const el = document.getElementById('technicianName');
    if (!el) return;
    const techId = getTechId();
    if (!techId) {
      el.textContent = '';
      return;
    }
    try {
      const data = await fetch(API_BASE + '/api/technician?technician_id=' + techId, { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json());
      const fullName = (data && data.full_name && String(data.full_name).trim()) ? String(data.full_name).trim() : '';
      const username = (data && data.username && String(data.username).trim()) ? String(data.username).trim() : '';
      if (fullName) {
        el.textContent = fullName;
      } else if (username) {
        el.textContent = username;
      } else {
        el.textContent = 'Techniker ' + String(techId);
      }
    } catch (e) {
      el.textContent = 'Techniker ' + String(techId);
    }
  }

  /** idle | checking | local | offline | online | online_syncing | degraded */
  var connectionUiState = 'idle';

  function preferLocalProjekteNeuOnly() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return connectionUiState === 'offline' || connectionUiState === 'local';
  }

  function setConnectionBadge(state, reason) {
    const badge = document.getElementById('connectionBadge');
    const wrap = document.getElementById('connectionBadgeWrap');
    if (!badge) return;
    connectionUiState = state || 'idle';
    if (wrap) wrap.classList.add('clickable');
    if (state === 'checking') {
      badge.textContent = 'Prüfe…';
      badge.className = 'offline-badge';
      badge.setAttribute('title', reason && String(reason).trim() ? String(reason).trim() : 'Verbindung wird geprüft…');
    } else if (state === 'online' || state === 'online_syncing' || state === 'degraded') {
      badge.textContent = 'Online';
      badge.className = state === 'degraded' ? 'offline-badge' : 'online-badge';
      if (reason && String(reason).trim()) {
        badge.setAttribute('title', String(reason).trim());
      } else if (state === 'online_syncing') {
        badge.setAttribute('title', 'Synchronisiere…');
      } else {
        badge.setAttribute('title', 'Klicken zum sofortigen Synchronisieren');
      }
    } else if (state === 'local') {
      badge.textContent = 'Lokal';
      badge.className = 'local-badge';
      badge.removeAttribute('title');
    } else {
      badge.textContent = 'Offline';
      badge.className = 'offline-badge';
      if (reason && String(reason).trim()) {
        badge.setAttribute('title', String(reason).trim());
      } else {
        badge.removeAttribute('title');
      }
    }
  }

  var checkConnectionAndSyncInFlight = null;
  var localListsRefreshAt = 0;
  var LOCAL_LISTS_REFRESH_MS = 12000;
  var startViewDataLoadedAt = 0;
  var START_VIEW_DATA_MS = 0;

  /** Sofort lokale Listen/Kalender/Abwesenheiten — ohne Dispo-Probe. */
  function bootstrapLocalData(force) {
    var techId = getTechId();
    if (!techId) {
      if (getServerUsername() && getServerPassword() && (getDispoExternalUrl() || getDispoInternalUrl())) {
        return resolveMonteurProfileFromDispo().then(function () {
          if (!getTechId()) {
            setConnectionBadge('offline');
            return Promise.resolve();
          }
          return bootstrapLocalData(force);
        });
      }
      setConnectionBadge('offline');
      return Promise.resolve();
    }
    setConnectionBadge('local', 'Lokale Daten — Sync im Hintergrund');
    localListsRefreshAt = Date.now();
    return Promise.all([
      loadJobsAndAbsences(),
      loadStartActiveJob(),
      loadCalendarMonth().catch(function () {}),
    ]).then(function () {
      if (force) localListsRefreshAt = 0;
    });
  }

  function maybeRefreshLocalLists(force) {
    var now = Date.now();
    if (!force && now - localListsRefreshAt < LOCAL_LISTS_REFRESH_MS) return;
    localListsRefreshAt = now;
    loadJobsAndAbsences();
    if (isStartViewVisible()) loadStartActiveJob();
  }

  var backgroundDispoSyncInFlight = null;

  async function applySyncBadgeAfterRun(syncProblems) {
    if (syncProblems && syncProblems.length) {
      setConnectionBadge('degraded', syncProblems.join(' · ') + ' — Klicken zum erneuten Synchronisieren');
      return;
    }
    try {
      var stRes = await fetch(API_BASE + '/api/sync_status');
      var st = await stRes.json().catch(function () { return {}; });
      if (!st.ok) {
        setConnectionBadge('online');
        return;
      }
      if (st.last_sync_pull && st.last_sync_pull.status === 'failed') {
        var errMsg = st.last_sync_pull.error || 'Letzter Sync fehlgeschlagen';
        setConnectionBadge('degraded', errMsg + ' — Klicken zum erneuten Synchronisieren');
        return;
      }
      if (st.high_priority_jobs > 0) {
        setConnectionBadge('online_syncing', 'Kopie/Sync läuft — Daten lokal verfügbar');
        return;
      }
      if (st.pending_changes > 0) {
        setConnectionBadge('online', 'Online — ' + st.pending_changes + ' Änderung(en) ausstehend');
        return;
      }
      setConnectionBadge('online');
    } catch (_) {
      setConnectionBadge('online');
    }
    if (isStartViewVisible() && typeof loadStartActiveJob === 'function') {
      loadStartActiveJob();
    }
  }

  /** Auth für sync_push/sync_pull; null wenn Monteur-ID oder Dispo-Basis fehlt. */
  function buildDispoSyncAuth(connectedBaseFallback) {
    var syncBase = (typeof getDispoBaseUrl === 'function' ? getDispoBaseUrl() : '').trim().replace(/\/+$/, '');
    if (!syncBase && connectedBaseFallback) {
      syncBase = String(connectedBaseFallback).trim().replace(/\/+$/, '');
    }
    var techId = typeof getTechId === 'function' ? getTechId() : 0;
    if (!syncBase || !techId) return null;
    return {
      baseUrl: syncBase,
      technicianId: techId,
      serverUsername: getServerUsername(),
      serverPassword: getServerPassword(),
    };
  }

  function isValidDispoSyncAuth(auth) {
    if (!auth || typeof auth !== 'object') return false;
    var base = (auth.baseUrl || auth.base_url || '').toString().trim().replace(/\/+$/, '');
    var tid = parseInt(auth.technicianId != null ? auth.technicianId : auth.technician_id, 10);
    return !!base && Number.isFinite(tid) && tid > 0;
  }

  /** Sync-Body immer frisch aus Einstellungen (vermeidet Race: Profil da, baseUrl noch leer). */
  function buildDispoSyncAuthPayload(connectedBaseFallback) {
    var syncBase = (typeof getDispoBaseUrl === 'function' ? getDispoBaseUrl() : '').trim().replace(/\/+$/, '');
    if (!syncBase && connectedBaseFallback) {
      syncBase = String(connectedBaseFallback).trim().replace(/\/+$/, '');
    }
    if (!syncBase) {
      var ext = (typeof getDispoExternalUrl === 'function' ? getDispoExternalUrl() : '').trim().replace(/\/+$/, '');
      var intUrl = (typeof getDispoInternalUrl === 'function' ? getDispoInternalUrl() : '').trim().replace(/\/+$/, '');
      syncBase = ext || intUrl;
    }
    return {
      baseUrl: syncBase,
      technicianId: typeof getTechId === 'function' ? getTechId() : 0,
      serverUsername: typeof getServerUsername === 'function' ? getServerUsername() : '',
      serverPassword: typeof getServerPassword === 'function' ? getServerPassword() : '',
    };
  }

  function resolveProjekteNeuFabForPath(fab, relPath) {
    var rel = String(relPath || '').replace(/^\/+/, '');
    var m = rel.match(/(?:^|\/)Bilder\/(\d+)\//i);
    if (m && m[1]) return m[1];
    return fab;
  }

  async function runDispoPushPull(auth, range, opts) {
    opts = opts || {};
    var syncProblems = [];
    var fallbackBase = opts && opts.connectedBaseFallback;
    if (!isValidDispoSyncAuth(auth) && getServerUsername() && getServerPassword()) {
      await resolveMonteurProfileFromDispo();
    }
    var syncPayload = buildDispoSyncAuthPayload(fallbackBase);
    if (!isValidDispoSyncAuth(syncPayload)) {
      return syncProblems;
    }
    try {
      await fetch(API_BASE + '/api/background_jobs/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(function () {});
    } catch (e) { /* ignore */ }
    try {
      var pushRes = await fetch(API_BASE + '/api/sync_push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syncPayload),
      });
      var pushData = await pushRes.json().catch(function () { return {}; });
      if (!pushData.ok) throw new Error(pushData.error || 'Push konnte nicht gestartet werden.');
      if (pushData.job_id) {
        var pushJob = await pollBackgroundJobUntilTerminal(pushData.job_id, null, {});
        if (pushJob.status === 'failed') {
          throw new Error(pushJob.error || 'Push fehlgeschlagen.');
        }
      }
    } catch (e) {
      var pushMsg = e && e.message ? e.message : 'Fehler';
      if (/technician/i.test(pushMsg) && /baseUrl/i.test(pushMsg)) {
        console.log('[Sync Push] übersprungen:', pushMsg);
      } else {
        console.warn('[Sync Push]', pushMsg, e);
      }
      syncProblems.push('Push: ' + pushMsg);
    }
    try {
      var pullRes = await fetch(API_BASE + '/api/sync_pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          Object.assign({}, syncPayload, { date_from: range.date_from, date_to: range.date_to }),
        ),
      });
      var pullData = await pullRes.json().catch(function () { return {}; });
      if (!pullData.ok) {
        if (pullData.deferred) {
          console.log('[Sync Pull] zurückgestellt:', pullData.error || 'Kopie/Push aktiv');
        } else {
          throw new Error(pullData.error || 'Pull konnte nicht gestartet werden.');
        }
      } else if (pullData.job_id) {
        var pullJob = await pollBackgroundJobUntilTerminal(pullData.job_id, null, {});
        if (pullJob.status === 'completed') {
          await waitForActiveDienstreisePullJobs({});
          maybeRefreshLocalLists(true);
          if (
            selectedJobIdOnDienstreisePage &&
            typeof loadDienstreiseExplorer === 'function'
          ) {
            try {
              loadDienstreiseExplorer(selectedJobIdOnDienstreisePage, dienstreiseExplorerSubpath, 'page');
            } catch (explorerErr) {
              console.warn('[Sync] Explorer-Refresh:', explorerErr);
            }
          }
          var skipProjektRefresh =
            jobDetailsJobId &&
            projektdatenFabSavedAt &&
            Date.now() - projektdatenFabSavedAt < PROJEKTDATEN_FAB_SAVE_GUARD_MS;
          if (
            !skipProjektRefresh &&
            jobDetailsJobId &&
            window.currentProjektdatenJob &&
            typeof openJobDetailsModal === 'function'
          ) {
            openJobDetailsModal(jobDetailsJobId, { syncPullRefresh: true });
          }
        } else if (pullJob.status === 'failed') {
          throw new Error(pullJob.error || 'Pull fehlgeschlagen.');
        }
      }
    } catch (e) {
      console.error('[Sync Pull] runDispoPushPull:', e.message, e);
      syncProblems.push('Pull: ' + (e && e.message ? e.message : 'Fehler'));
    }
    return syncProblems;
  }

  function runDispoPushPullInBackground(auth, range, syncBase, techId) {
    if (backgroundDispoSyncInFlight) return backgroundDispoSyncInFlight;
    setConnectionBadge('online_syncing', 'Synchronisiere im Hintergrund…');
    backgroundDispoSyncInFlight = runDispoPushPull(auth, range, { connectedBaseFallback: syncBase })
      .then(function (syncProblems) {
        applySyncBadgeAfterRun(syncProblems);
        if (selectedJobIdOnDienstreisePage) {
          var syncSnap =
            typeof getDienstreiseJobSnapshotByLocalId === 'function'
              ? getDienstreiseJobSnapshotByLocalId(selectedJobIdOnDienstreisePage)
              : null;
          if (!isJobAngelegtReadOnly(syncSnap)) {
            fetch(API_BASE + '/api/dienstreise/sync_to_dispo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                job_id: selectedJobIdOnDienstreisePage,
                dispo_base_url: syncBase,
                technician_id: techId,
                dispo_username: getServerUsername(),
                dispo_password: getServerPassword(),
              }),
            }).catch(function () {});
          }
        }
      })
      .catch(function (e) {
        console.error('[Sync] Hintergrund:', e && e.message ? e.message : e);
        setConnectionBadge('degraded', (e && e.message ? e.message : 'Sync-Fehler') + ' — Klicken zum erneuten Synchronisieren');
      })
      .finally(function () {
        backgroundDispoSyncInFlight = null;
      });
    return backgroundDispoSyncInFlight;
  }

  async function checkConnectionAndSync(opts) {
    opts = opts || {};
    if (checkConnectionAndSyncInFlight) {
      return checkConnectionAndSyncInFlight;
    }
    checkConnectionAndSyncInFlight = checkConnectionAndSyncBody(opts).finally(function () {
      checkConnectionAndSyncInFlight = null;
    });
    return checkConnectionAndSyncInFlight;
  }

  async function checkConnectionAndSyncBody(opts) {
    opts = opts || {};
    var blockingSync = opts.blockingSync === true;
    var techId = getTechId();
    var hasLogin = !!(getServerUsername() && getServerPassword());
    if (!techId && !hasLogin) {
      setConnectionBadge('offline');
      return bootstrapLocalData(true);
    }
    var ext = getDispoExternalUrl();
    var intUrl = getDispoInternalUrl();
    if (!ext && !intUrl) {
      return bootstrapLocalData(true);
    }
    if (!blockingSync) {
      bootstrapLocalData(false);
    }
    setConnectionBadge('checking', 'Prüfe Verbindung…');
    try {
      if (hasLogin && !getTechId()) {
        await resolveMonteurProfileFromDispo();
        techId = getTechId();
      }
      const resCheck = await fetch(API_BASE + '/api/check_connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalUrl: ext,
          internalUrl: intUrl,
          technicianId: techId,
          serverUsername: getServerUsername(),
          serverPassword: getServerPassword(),
        }),
      });
      var check = await resCheck.json().catch(function () { return {}; });
      applyMonteurProfileFromConnection(check);
      if (check && check.ok === true) {
        var connectedBase = (check.used_base_url || '').toString().trim().replace(/\/+$/, '');
        if (connectedBase) {
          var extNorm = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
          var intNorm = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
          var src = connectedBase === intNorm ? 'internal' : connectedBase === extNorm ? 'external' : 'fallback';
          setDispoActiveBase(connectedBase, src);
        }
        updateTechnicianName();
        const range = getSyncDateRange();
        techId = getTechId();
        const auth = buildDispoSyncAuth(connectedBase);
        if (!auth) {
          setConnectionBadge(
            'online',
            'Online — für Sync Monteur-ID in Einstellungen und erreichbare Dispo-URL nötig',
          );
          if (blockingSync) return bootstrapLocalData(true);
          return;
        }
        var syncBase = auth.baseUrl;
        if (blockingSync) {
          setConnectionBadge('online_syncing', 'Synchronisiere mit Dispo…');
          var syncProblems = await runDispoPushPull(auth, range, { connectedBaseFallback: connectedBase });
          applySyncBadgeAfterRun(syncProblems);
          if (selectedJobIdOnDienstreisePage) {
            var syncSnap =
              typeof getDienstreiseJobSnapshotByLocalId === 'function'
                ? getDienstreiseJobSnapshotByLocalId(selectedJobIdOnDienstreisePage)
                : null;
            if (!isJobAngelegtReadOnly(syncSnap)) {
              fetch(API_BASE + '/api/dienstreise/sync_to_dispo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  job_id: selectedJobIdOnDienstreisePage,
                  dispo_base_url: syncBase,
                  technician_id: techId,
                  dispo_username: getServerUsername(),
                  dispo_password: getServerPassword(),
                }),
              }).catch(function () {});
            }
          }
        } else if (isValidDispoSyncAuth(auth)) {
          setConnectionBadge('online');
          runDispoPushPullInBackground(auth, range, syncBase, techId);
        } else {
          setConnectionBadge('online', 'Online — Dispo-Zugangsdaten für Sync eintragen');
        }
      } else {
        var offMsg = (check && check.error) ? check.error : 'Verbindung fehlgeschlagen';
        setConnectionBadge('offline', offMsg);
      }
    } catch (e) {
      setConnectionBadge('offline', e && e.message ? e.message : 'Verbindung fehlgeschlagen');
    }
    setNextSyncTime();
    if (blockingSync) {
      return bootstrapLocalData(true);
    }
  }

  function absenceEndDateYmd(item) {
    if (!item || item.end_datetime == null) return '';
    var s = String(item.end_datetime).trim().replace('T', ' ');
    return s ? s.slice(0, 10) : '';
  }

  /** Abwesenheit abgelaufen, wenn das Enddatum vor dem heutigen Kalendertag liegt. */
  function isAbsenceExpired(item) {
    var endYmd = absenceEndDateYmd(item);
    if (!endYmd || !/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) return false;
    var today = new Date();
    var todayYmd =
      today.getFullYear() +
      '-' +
      String(today.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(today.getDate()).padStart(2, '0');
    return endYmd < todayYmd;
  }

  function renderAbsences(data, requestsData) {
    const list = document.getElementById('absencesList');
    const absences = (data && data.absences) ? data.absences : [];
    const requests = (requestsData && requestsData.requests) ? requestsData.requests : [];
    const parts = [];
    absences.forEach(function(a) {
      if (a.from_absence_request && a.status === 'pending') return;
      if (isAbsenceExpired(a)) return;
      const dateStr = formatDateRange(a.start_datetime, a.end_datetime);
      const isRequest = a.from_absence_request === true;
      const action = isRequest ? 'delete-absence-request' : 'delete-absence';
      const title = isRequest ? 'Anfrage aus der Liste entfernen' : 'Abwesenheit löschen (lokal und in der Dispo)';
      var cmt = (a.comment && String(a.comment).trim()) ? (' · ' + escapeHtml(String(a.comment).trim())) : '';
      parts.push('<div class="job job-absence-row"><div class="job-info"><strong>' + escapeHtml(a.type || 'Abwesenheit') + '</strong><br><span class="job-meta">' + escapeHtml(dateStr) + cmt + '</span></div><button type="button" class="btn-icon btn-delete-absence" data-action="' + action + '" data-id="' + escapeHtml(String(a.id)) + '" title="' + escapeHtml(title) + '" aria-label="Löschen">🗑</button></div>');
    });
    requests.forEach(function(r) {
      if (r.status === 'approved') return;
      if (isAbsenceExpired(r)) return;
      const dateStr = formatDateRange(r.start_datetime, r.end_datetime);
      var statusText;
      if (r.status === 'pending') statusText = 'Offen (wird geprüft)';
      else if (r.status === 'rejected') statusText = 'Abgelehnt';
      else if (r.status === 'error') statusText = 'Fehler bei Übertragung';
      else statusText = r.status || '';
      var cmt2 = (r.comment && String(r.comment).trim()) ? (' · ' + escapeHtml(String(r.comment).trim())) : '';
      parts.push('<div class="job job-absence-row"><div class="job-info"><strong>' + escapeHtml(r.type || 'Abwesenheit') + '</strong> <span class="job-meta">' + escapeHtml(dateStr) + ' – ' + escapeHtml(statusText) + cmt2 + '</span></div><button type="button" class="btn-icon btn-delete-absence" data-action="delete-absence-request" data-id="' + escapeHtml(String(r.id)) + '" title="Anfrage aus der Liste entfernen" aria-label="Löschen">🗑</button></div>');
    });
    var hasErrorRequests = requests.some(function(r) { return r.status === 'error' && !isAbsenceExpired(r); });
    var btnCleanup = document.getElementById('btnCleanupErrorRequests');
    if (btnCleanup) btnCleanup.style.display = hasErrorRequests ? 'inline-block' : 'none';
    if (parts.length === 0) {
      list.innerHTML = '<span class="empty">Keine Abwesenheiten.</span>';
      return;
    }
    list.innerHTML = parts.join('');
  }

  function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText = 'background:var(--card);border:1px solid var(--accent);border-radius:8px;padding:0.75rem 1rem;margin-top:0.5rem;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function() { el.remove(); }, 5000);
  }

  var eventSourceRef = null;
  function startPushEvents() {
    var techId = getTechId();
    var baseUrl = getDispoBaseUrl();
    if (eventSourceRef) { eventSourceRef.close(); eventSourceRef = null; }
    if (!techId) return;
    var url = API_BASE + '/api/events?technician_id=' + encodeURIComponent(techId) + '&base_url=' + encodeURIComponent(baseUrl || '');
    try {
      eventSourceRef = new EventSource(url);
      eventSourceRef.onmessage = function(ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.channel === 'absence_request_decided' && msg.payload) {
            var status = msg.payload.status;
            if (status === 'approved') showToast('Ihre Abwesenheit wurde bestätigt.');
            else if (status === 'rejected') showToast('Ihre Abwesenheit wurde abgelehnt.');
            loadJobsAndAbsences();
          }
        } catch (e) {}
      };
    } catch (e) {}
  }

  let syncIntervalId = null;
  let countdownTickId = null;
  let nextSyncTime = 0;

  function startSyncInterval() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    const ms = getSyncIntervalMinutes() * 60 * 1000;
    syncIntervalId = setInterval(function () {
      checkConnectionAndSync({ blockingSync: false });
    }, ms);
    if (!countdownTickId) {
      countdownTickId = setInterval(updateCountdownRing, 1000);
    }
  }

  function updateCountdownRing() {
    const wrap = document.getElementById('connectionBadgeWrap');
    if (!wrap) return;
    const intervalMs = getSyncIntervalMinutes() * 60 * 1000;
    if (nextSyncTime <= 0 || intervalMs <= 0) {
      wrap.style.setProperty('--countdown', '1');
      return;
    }
    const remaining = Math.max(0, nextSyncTime - Date.now());
    const value = intervalMs > 0 ? remaining / intervalMs : 1;
    wrap.style.setProperty('--countdown', String(value));
  }

  function setNextSyncTime() {
    nextSyncTime = Date.now() + getSyncIntervalMinutes() * 60 * 1000;
    updateCountdownRing();
  }

  function triggerManualSync() {
    setConnectionBadge('checking', 'Manueller Sync…');
    return checkConnectionAndSync({ blockingSync: true }).finally(function () {
      startSyncInterval();
    });
  }

  document.getElementById('connectionBadgeWrap').addEventListener('click', function () {
    triggerManualSync();
  });

  loadSettingsFromStorage();
  wireMonteurProfileAutoResolve();
  if (getServerUsername() && getServerPassword()) {
    resolveMonteurProfileFromDispo();
  }
  (function wireUiThemeToggle() {
    var themeToggle = document.getElementById('uiThemeDarkToggle');
    if (themeToggle) {
      themeToggle.addEventListener('change', function () {
        persistUiThemeFromToggle();
      });
    }
  })();
  function loadDienstreiseConfigFromServer() {
    fetch(API_BASE + '/api/dienstreise/config').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok && data.basePath) {
        var el = document.getElementById('dienstreiseBasePath');
        if (el) el.value = data.basePath;
        try { localStorage.setItem(SETTINGS_KEYS.dienstreiseBasePath, data.basePath); } catch (e) {}
      }
    }).catch(function () {});
  }
  function ensureDefaultDispoTlsIfUnset() {
    var stored = null;
    try {
      stored = localStorage.getItem(SETTINGS_KEYS.allowInsecureTls);
    } catch (e) { /* ignore */ }
    if (stored != null) return Promise.resolve();
    var el = document.getElementById('allowInsecureDispoTls');
    if (el) el.checked = DEFAULT_ALLOW_INSECURE_TLS;
    return fetch(API_BASE + '/api/settings_dispo_tls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowInsecureTls: DEFAULT_ALLOW_INSECURE_TLS }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.ok) {
          try {
            localStorage.setItem(SETTINGS_KEYS.allowInsecureTls, DEFAULT_ALLOW_INSECURE_TLS ? '1' : '0');
          } catch (e) { /* ignore */ }
        }
      })
      .catch(function () {});
  }

  function loadDispoTlsSettingFromServer() {
    return fetch(API_BASE + '/api/settings_dispo_tls').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) {
        var el = document.getElementById('allowInsecureDispoTls');
        if (el) el.checked = !!data.allowInsecureTls;
        try { localStorage.setItem(SETTINGS_KEYS.allowInsecureTls, data.allowInsecureTls ? '1' : '0'); } catch (e) {}
      }
    }).catch(function () {});
  }
  loadDienstreiseConfigFromServer();
  bootstrapLocalData(false)
    .then(function () {
      return ensureDefaultDispoTlsIfUnset();
    })
    .then(function () {
      return loadDispoTlsSettingFromServer();
    })
    .then(function () {
      syncUpdateFeedToMain();
      return checkConnectionAndSync({ blockingSync: false });
    })
    .then(function () {
      startPushEvents();
    })
    .catch(function () {
      startPushEvents();
    });
  startSyncInterval();
  startBackgroundJobsPollingUi();
  window.addEventListener('online', function () {
    if (typeof checkConnectionAndSync === 'function') {
      try { checkConnectionAndSync({ blockingSync: false }); } catch (e) { /* ignore */ }
    }
  });
  // Startansicht und Kalender erst nach Layout-Aufbau, damit das Grid sofort sichtbar ist
  function initStartView() {
    showView('start');
  }
  function runAfterLayout(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(fn); });
    } else {
      requestAnimationFrame(function () { requestAnimationFrame(fn); });
    }
  }
  runAfterLayout(initStartView);

  (function initAppUpdateUi() {
    var chip = document.getElementById('appUpdateHint');
    var btnCheck = document.getElementById('btnCheckAppUpdate');
    var checkHint = document.getElementById('checkAppUpdateHint');
    var updateState = 'idle';

    function setChipVisible(show, label) {
      if (!chip) return;
      if (show) {
        chip.hidden = false;
        if (label) chip.textContent = label;
      } else {
        chip.hidden = true;
      }
    }

    function clearCheckHintLater(ms) {
      if (!checkHint) return;
      clearTimeout(checkHint._hideTimeout);
      checkHint._hideTimeout = setTimeout(function () {
        if (checkHint.textContent && checkHint.textContent !== 'Prüfe …') {
          checkHint.textContent = '';
        }
      }, ms || 5000);
    }

    function applyUpdateStatus(payload) {
      if (!payload || !payload.state) return;
      updateState = payload.state;
      if (payload.state === 'available') {
        setChipVisible(true, 'Update verfügbar');
        if (chip && payload.latestVersion) {
          chip.title = 'Neu: ' + payload.latestVersion + ' — Klick zum Herunterladen';
        }
        if (checkHint) {
          checkHint.textContent = payload.latestVersion
            ? 'Update ' + payload.latestVersion + ' verfügbar.'
            : 'Update verfügbar.';
          clearCheckHintLater(8000);
        }
      } else if (payload.state === 'downloading') {
        var dlLabel = 'Lädt …';
        var pct = payload.percent != null ? payload.percent : 0;
        if (pct > 0) {
          dlLabel += ' ' + pct + '%';
        } else if (payload.transferred > 0 && payload.total > 0) {
          dlLabel +=
            ' ' +
            (Math.round(payload.transferred / 1048576) || 0) +
            ' / ' +
            (Math.round(payload.total / 1048576) || 0) +
            ' MB';
        }
        setChipVisible(true, dlLabel);
        if (checkHint) checkHint.textContent = dlLabel.replace('Lädt', 'Download');
      } else if (payload.state === 'ready') {
        setChipVisible(true, 'Installieren');
        if (chip) chip.title = 'Update bereit — Klick zum Installieren';
        if (checkHint) {
          checkHint.textContent = 'Update bereit — im Dialog oder hier installieren.';
          clearCheckHintLater(10000);
        }
      } else if (payload.state === 'not-available') {
        setChipVisible(false);
        if (checkHint && checkHint.textContent === 'Prüfe …') {
          checkHint.textContent = 'Keine neuere Version gefunden.';
          clearCheckHintLater(5000);
        }
      } else if (payload.state === 'error') {
        if (checkHint && payload.message) {
          checkHint.textContent = payload.message;
          clearCheckHintLater(8000);
        }
      }
    }

    if (chip) {
      chip.addEventListener('click', function () {
        if (!window.monteurApp) return;
        if (updateState === 'ready' && typeof monteurApp.installAppUpdateNow === 'function') {
          monteurApp.installAppUpdateNow();
        } else if (updateState === 'available' && typeof monteurApp.startAppUpdateDownload === 'function') {
          monteurApp.startAppUpdateDownload();
        } else if (typeof monteurApp.checkForAppUpdates === 'function') {
          syncUpdateFeedToMain();
          monteurApp.checkForAppUpdates();
        }
      });
    }

    if (btnCheck) {
      btnCheck.addEventListener('click', function () {
        if (!window.monteurApp || typeof monteurApp.checkForAppUpdates !== 'function') {
          if (checkHint) checkHint.textContent = 'Nur in der installierten Desktop-App verfügbar.';
          clearCheckHintLater(6000);
          return;
        }
        if (!getDispoBaseUrl()) {
          if (checkHint) checkHint.textContent = 'Bitte Dispo-Adresse eintragen und Verbindung prüfen.';
          clearCheckHintLater(6000);
          return;
        }
        if (checkHint) checkHint.textContent = 'Prüfe …';
        syncUpdateFeedToMain();
        monteurApp.checkForAppUpdates().then(function (res) {
          if (res && res.skipped) {
            if (checkHint) checkHint.textContent = 'Entwicklungsmodus — kein Auto-Update.';
            clearCheckHintLater(6000);
            return;
          }
          if (res && res.ok === false) {
            if (checkHint) {
              checkHint.textContent = res.error || 'Prüfung fehlgeschlagen.';
              clearCheckHintLater(8000);
            }
          }
        }).catch(function (e) {
          if (checkHint) {
            checkHint.textContent = e && e.message ? e.message : 'Prüfung fehlgeschlagen.';
            clearCheckHintLater(8000);
          }
        });
      });
    }

    var tlsElUpdate = document.getElementById('allowInsecureDispoTls');
    if (tlsElUpdate) {
      tlsElUpdate.addEventListener('change', syncUpdateFeedToMain);
    }

    if (window.monteurApp && typeof monteurApp.onAppUpdateStatus === 'function') {
      monteurApp.onAppUpdateStatus(applyUpdateStatus);
    }
    syncUpdateFeedToMain();
  })();

  fetch(API_BASE + '/api/version').then(function (r) { return r.json(); }).then(function (d) {
    var el = document.getElementById('appVersion');
    if (el && d && d.version) el.textContent = d.version;
  }).catch(function () {});

  var browseBtn = document.getElementById('btnDienstreiseBaseBrowse');
  if (browseBtn && window.monteurApp && typeof window.monteurApp.chooseDienstreiseBasePath === 'function') {
    browseBtn.addEventListener('click', function () {
      window.monteurApp.chooseDienstreiseBasePath().then(function (selectedPath) {
        if (!selectedPath) return;
        var input = document.getElementById('dienstreiseBasePath');
        if (input) input.value = selectedPath;
        saveSettingsToStorage();
        fetch(API_BASE + '/api/dienstreise/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ basePath: selectedPath })
        }).catch(function () {});
      });
    });
  }

  document.getElementById('btnSaveSettings').addEventListener('click', function () {
    saveSettingsToStorage();
    syncUpdateFeedToMain();
    var pathEl = document.getElementById('dienstreiseBasePath');
    var basePath = (pathEl && pathEl.value ? pathEl.value.trim() : '') || '';
    var tlsEl = document.getElementById('allowInsecureDispoTls');
    var tlsOn = !!(tlsEl && tlsEl.checked);
    fetch(API_BASE + '/api/dienstreise/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ basePath: basePath }) }).catch(function () {});
    fetch(API_BASE + '/api/settings_dispo_tls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowInsecureTls: tlsOn }),
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; })
      .then(function () {
        startSyncInterval();
        startPushEvents();
        updateTechnicianName();
        var techIdAfterSave = getTechId();
        var hasLoginAfterSave = !!(getServerUsername() && getServerPassword());
        if ((getDispoExternalUrl() || getDispoInternalUrl()) && (techIdAfterSave || hasLoginAfterSave)) {
          var prepSave = hasLoginAfterSave && !techIdAfterSave ? resolveMonteurProfileFromDispo() : Promise.resolve();
          return prepSave.then(function () {
            return checkConnectionAndSync({ blockingSync: false });
          });
        }
        return Promise.resolve();
      })
      .finally(function () {
        var hint = document.getElementById('settingsSavedHint');
        hint.textContent = 'Gespeichert.';
        clearTimeout(hint._hideTimeout);
        hint._hideTimeout = setTimeout(function () { hint.textContent = ''; }, 2000);
      });
  });

  var btnOpenProfileForQr = document.getElementById('btnOpenProfileForQr');
  if (btnOpenProfileForQr) {
    btnOpenProfileForQr.addEventListener('click', function () {
      var base = (getDispoBaseUrl() || '').trim().replace(/\/+$/, '');
      if (!base) {
        alert('Bitte zuerst eine Dispo-Adresse eintragen und Verbindung prüfen (Einstellungen).');
        return;
      }
      var profileUrl = base + '/profile.php';
      if (typeof monteurApp !== 'undefined' && monteurApp.openExternal) {
        monteurApp.openExternal(profileUrl);
      } else {
        window.open(profileUrl, '_blank');
      }
    });
  }

  document.getElementById('btnSyncNow').addEventListener('click', function () {
    var hint = document.getElementById('syncNowHint');
    var techId = getTechId();
    var hasLogin = !!(getServerUsername() && getServerPassword());
    if (!techId && !hasLogin) {
      hint.textContent = 'Bitte Dispo-Benutzername und Passwort eintragen.';
      return;
    }
    if (!getDispoExternalUrl() && !getDispoInternalUrl()) {
      hint.textContent = 'Bitte mindestens eine Dispo-Adresse (extern oder intern) eintragen.';
      return;
    }
    hint.textContent = 'Wird geholt…';
    var prep = hasLogin && !techId ? resolveMonteurProfileFromDispo() : Promise.resolve();
    prep.then(function () {
      return checkConnectionAndSync({ blockingSync: true });
    }).then(function () {
      startSyncInterval();
      hint.textContent = 'Fertig.';
      clearTimeout(hint._syncHide);
      hint._syncHide = setTimeout(function () { hint.textContent = ''; }, 3000);
    }).catch(function (e) {
      hint.textContent = 'Fehler: ' + (e && e.message ? e.message : 'Unbekannt');
      clearTimeout(hint._syncHide);
      hint._syncHide = setTimeout(function () { hint.textContent = ''; }, 5000);
    });
  });


  function openAbsenceRequestModal() {
    var modal = document.getElementById('modalAbsenceRequest');
    if (!modal) return;
    var start = document.getElementById('absenceRequestStart');
    var end = document.getElementById('absenceRequestEnd');
    if (start && end) {
      var t = new Date();
      start.value = t.toISOString().slice(0, 10);
      end.value = t.toISOString().slice(0, 10);
    }
    document.getElementById('absenceRequestMsg').textContent = '';
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeAbsenceRequestModal() {
    var modal = document.getElementById('modalAbsenceRequest');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
    }
  }
  document.getElementById('btnRequestAbsence').addEventListener('click', openAbsenceRequestModal);
  document.getElementById('absencesList').addEventListener('click', function(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-action="delete-absence"], [data-action="delete-absence-request"]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    if (!id) return;
    var isRequest = btn.getAttribute('data-action') === 'delete-absence-request';
    if (isRequest) {
      if (!confirm('Diese Anfrage (z. B. abgelehnt) aus der Liste entfernen?')) return;
      fetch(API_BASE + '/api/absence_request?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) }
      }).then(function(r) { return r.text(); }).then(function(text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (e) {
          loadJobsAndAbsences();
          if (text && (text.trim().indexOf('<') === 0 || text.indexOf('<!DOCTYPE') === 0)) {
            showToast('App-Server antwortete mit HTML statt JSON. Liste wurde aktualisiert.');
          } else {
            showToast('Antwort konnte nicht gelesen werden. Liste wurde aktualisiert.');
          }
          return;
        }
        if (data.ok) {
          loadJobsAndAbsences();
          showToast('Anfrage entfernt.');
        } else {
          alert(data.error || 'Entfernen fehlgeschlagen');
        }
      }).catch(function(err) {
        loadJobsAndAbsences();
        alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt'));
      });
      return;
    }
    if (!confirm('Abwesenheit wirklich löschen? (lokal und in der Dispo)')) return;
    var body = { id: parseInt(id, 10), base_url: getDispoBaseUrl() || undefined, serverUsername: getDispoUsername() || undefined, serverPassword: getDispoPassword() || undefined };
    fetch(API_BASE + '/api/absence?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) {
        loadJobsAndAbsences();
        showToast('Abwesenheit gelöscht.');
      } else {
        alert(data.error || 'Löschen fehlgeschlagen');
      }
    }).catch(function(err) { alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt')); });
  });
  document.getElementById('btnCleanupErrorRequests').addEventListener('click', function() {
    fetch(API_BASE + '/api/absence_requests_cleanup_errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) {
        loadJobsAndAbsences();
        showToast(data.deleted ? data.deleted + ' fehlerhafte Einträge entfernt.' : 'Fertig.');
      }
    }).catch(function(e) { showToast('Fehler: ' + (e && e.message ? e.message : 'Unbekannt')); });
  });
  document.getElementById('absenceRequestCancel').addEventListener('click', closeAbsenceRequestModal);
  var modalAbsenceOverlay = document.getElementById('modalAbsenceRequest');
  if (modalAbsenceOverlay) modalAbsenceOverlay.addEventListener('click', function (e) {
    if (e.target.id === 'modalAbsenceRequest') closeAbsenceRequestModal();
  });
  document.getElementById('absenceRequestForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var startEl = document.getElementById('absenceRequestStart');
    var endEl = document.getElementById('absenceRequestEnd');
    var typeEl = document.getElementById('absenceRequestType');
    var msgEl = document.getElementById('absenceRequestMsg');
    var start = startEl && startEl.value ? startEl.value : '';
    var end = endEl && endEl.value ? endEl.value : '';
    var type = (typeEl && typeEl.value) ? typeEl.value.trim() : 'Abwesenheit';
    var commentEl = document.getElementById('absenceRequestComment');
    var cmtV = (commentEl && commentEl.value) ? commentEl.value.trim() : '';
    if (!start || !end) {
      if (msgEl) msgEl.textContent = 'Bitte Start- und Enddatum angeben.';
      return;
    }
    var body = {
      start_datetime: start + 'T00:00:00',
      end_datetime: end + 'T23:59:59',
      type: type || 'Abwesenheit',
      comment: cmtV === '' ? null : cmtV,
      base_url: getDispoBaseUrl() || undefined,
      serverUsername: getDispoUsername() || undefined,
      serverPassword: getDispoPassword() || undefined
    };
    msgEl.textContent = 'Wird gesendet…';
    fetch(API_BASE + '/api/absence_request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (data) {
      closeAbsenceRequestModal();
      if (msgEl) msgEl.textContent = '';
      loadJobsAndAbsences();
      showToast('Anfrage wurde gesendet und wird von der Dispo geprüft.');
    }).catch(function (err) {
      if (msgEl) msgEl.textContent = 'Fehler: ' + (err && err.message ? err.message : 'Unbekannt');
    });
  });

  // —— Kalender & Archiv ———
  let calCurrentMonth = new Date();
  calCurrentMonth.setDate(1);
  calCurrentMonth.setHours(12, 0, 0, 0);

  function pad2(n) { return String(n).padStart(2, '0'); }
  function toYmd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function mondayOf(d) {
    const x = new Date(d);
    x.setHours(12, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  function getWeekNum(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() + 3 - (x.getDay() + 6) % 7);
    const w1 = new Date(x.getFullYear(), 0, 4);
    return 1 + Math.round(((x.getTime() - w1.getTime()) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
  }

  /* Feiertage AT (wie Dispo-Kalender) */
  const holidayCache = {};
  function easterSunday(year) {
    const f = Math.floor;
    const a = year % 19;
    const b = f(year / 100);
    const c = year % 100;
    const d = f(b / 4);
    const e = b % 4;
    const g = f((8 * b + 13) / 25);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = f(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = f((a + 11 * h + 22 * l) / 451);
    const month = f((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }
  function getAustrianHolidaysNamed(year) {
    if (holidayCache[year]) return holidayCache[year];
    const map = new Map();
    const fixed = {
      '01-01': 'Neujahr', '01-06': 'Heilige Drei Könige', '05-01': 'Staatsfeiertag',
      '08-15': 'Mariä Himmelfahrt', '10-26': 'Nationalfeiertag', '11-01': 'Allerheiligen',
      '12-08': 'Mariä Empfängnis', '12-25': 'Weihnachten', '12-26': 'Stefanitag'
    };
    Object.entries(fixed).forEach(function (e) { map.set(year + '-' + e[0], e[1]); });
    const easter = easterSunday(year);
    function add(offsetDays, name) {
      const d = new Date(easter);
      d.setDate(d.getDate() + offsetDays);
      map.set(d.toISOString().slice(0, 10), name);
    }
    add(1, 'Ostermontag');
    add(39, 'Christi Himmelfahrt');
    add(50, 'Pfingstmontag');
    add(60, 'Fronleichnam');
    holidayCache[year] = map;
    return map;
  }
  function getHolidayName(dateObj) {
    const y = dateObj.getFullYear();
    const iso = toYmd(dateObj);
    return getAustrianHolidaysNamed(y).get(iso) || '';
  }

  const ARCHIV_VISIBLE_YEARS = 2;
  let archivCurrentYear = new Date().getFullYear();
  var archivJobsList = [];
  var archivExpandedJobId = null;
  var archivFolderRoot = {};
  var archivFolderExpanded = {};
  var archivJobDetailsCache = {};

  function getArchivFilters() {
    const customerEl = document.getElementById('archivFilterCustomer');
    const monthEl = document.getElementById('archivFilterMonth');
    const fabEl = document.getElementById('archivFilterFab');
    const countryEl = document.getElementById('archivFilterCountry');
    const yearEl = document.getElementById('archivFilterYear');
    const customer = customerEl && customerEl.value ? customerEl.value.trim() : '';
    const month = monthEl && monthEl.value ? monthEl.value.trim() : '';
    const fabrikationsnummer = fabEl && fabEl.value ? fabEl.value.trim() : '';
    const country = countryEl && countryEl.value ? countryEl.value.trim() : '';
    let year = archivCurrentYear;
    if (yearEl && yearEl.value) {
      const y = parseInt(yearEl.value, 10);
      if (!isNaN(y) && y > 1900) year = y;
    }
    archivCurrentYear = year;
    return { customer, month, fabrikationsnummer, country, year };
  }

  function initArchivYearSelect() {
    const sel = document.getElementById('archivFilterYear');
    if (!sel) return;
    const now = new Date();
    const currentYear = now.getFullYear();
    archivCurrentYear = currentYear;
    sel.innerHTML = '';
    for (let i = 0; i < ARCHIV_VISIBLE_YEARS; i++) {
      const y = currentYear - i;
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = y === currentYear ? (y + ' (aktuelles Jahr)') : String(y);
      sel.appendChild(opt);
    }
    sel.value = String(currentYear);
  }

  function renderArchivJobs(data) {
    const listEl = document.getElementById('archivList');
    if (!listEl) return;
    const jobs = (data && data.jobs) ? data.jobs : [];
    archivJobsList = jobs;
    if (archivExpandedJobId != null && !jobs.some(function (j) { return j.id === archivExpandedJobId; })) archivExpandedJobId = null;
    if (!jobs.length) {
      listEl.innerHTML = '<span class="empty">Keine Aufträge im Archiv.</span>';
      return;
    }
    const html = jobs.map(function (j) {
      const dateStr = formatDateRange(j.start_datetime, j.end_datetime);
      const status = jobStatusBadgeClass(j.status || 'erledigt');
      const statusLabel = jobStatusDisplayLabel(j.status || 'erledigt');
      const firma = (j.customer_name || j.customerName || '').trim();
      const ort = (j.city || '').trim();
      const land = normalizeCountryToCode(j.country) || (j.country || '').trim().toUpperCase().slice(0, 2);
      const flagHtml = countryFlagImg(land);
      const parts = [];
      if (flagHtml) parts.push(flagHtml);
      if (firma) parts.push(escapeHtml(firma));
      if (ort) parts.push(escapeHtml(ort));
      if (land) parts.push(escapeHtml(land));
      const titleLine = parts.join(' · ') || 'Auftrag';
      const jobNum = (j.job_number || '').trim();
      const subtitle = (jobNum ? escapeHtml(jobNum) + ' · ' : '') + escapeHtml(dateStr);
      const isExpanded = archivExpandedJobId === j.id;
      return (
        '<div class="archiv-job-item" data-job-id="' + j.id + '">' +
        '<div class="archiv-job-row' + (isExpanded ? ' expanded' : '') + '" role="button" tabindex="0" aria-expanded="' + isExpanded + '">' +
        '<span class="archiv-toggle" aria-hidden="true">' + (isExpanded ? '▼' : '▶') + '</span>' +
        '<div class="job">' +
        '<div class="job-info">' +
        '<strong>' + titleLine + '</strong><br>' +
        '<span class="job-meta">' + subtitle + (j.job_type ? ' · ' + escapeHtml(j.job_type || '') : '') + '</span>' +
        '</div>' +
        '<div class="job-actions">' +
        '<span class="status-badge status-' + status + '">' + escapeHtml(statusLabel) + '</span>' +
        '</div></div></div>' +
        '<div class="archiv-job-expand" style="display:' + (isExpanded ? 'block' : 'none') + '">' +
        (isExpanded ? '' : '') +
        '</div></div>'
      );
    }).join('');
    listEl.innerHTML = html;
    if (archivExpandedJobId != null) {
      var expandEl = listEl.querySelector('.archiv-job-item[data-job-id="' + archivExpandedJobId + '"] .archiv-job-expand');
      if (expandEl && expandEl.innerHTML === '') loadArchivJobExpandContent(archivExpandedJobId, expandEl);
    }
    listEl.querySelectorAll('.archiv-job-row').forEach(function (row) {
      function toggleExpand() {
        var item = row.closest('.archiv-job-item');
        var jobId = item ? parseInt(item.getAttribute('data-job-id'), 10) : 0;
        if (!jobId) return;
        var expandEl = item ? item.querySelector('.archiv-job-expand') : null;
        if (archivExpandedJobId === jobId) {
          archivExpandedJobId = null;
          if (expandEl) expandEl.style.display = 'none';
          row.classList.remove('expanded');
          row.setAttribute('aria-expanded', 'false');
          var t = row.querySelector('.archiv-toggle');
          if (t) t.textContent = '▶';
          return;
        }
        var prev = listEl.querySelector('.archiv-job-item[data-job-id="' + archivExpandedJobId + '"]');
        if (prev) {
          var prevRow = prev.querySelector('.archiv-job-row');
          var prevExpand = prev.querySelector('.archiv-job-expand');
          if (prevRow) { prevRow.classList.remove('expanded'); prevRow.setAttribute('aria-expanded', 'false'); var pt = prevRow.querySelector('.archiv-toggle'); if (pt) pt.textContent = '▶'; }
          if (prevExpand) prevExpand.style.display = 'none';
        }
        archivExpandedJobId = jobId;
        if (expandEl) {
          expandEl.style.display = 'block';
          if (expandEl.innerHTML === '') loadArchivJobExpandContent(jobId, expandEl);
        }
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        var toggle = row.querySelector('.archiv-toggle');
        if (toggle) toggle.textContent = '▼';
      }
      row.addEventListener('click', toggleExpand);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleExpand();
        }
      });
    });
  }

  function buildArchivJobDetailHtml(job) {
    var v = function (x) { return (x != null && String(x).trim() !== '' ? escapeHtml(String(x).trim()) : '–'); };
    var dateRangeStr = formatDateRange(job.start_datetime, job.end_datetime);
    var addressLines = [];
    var nameLine = (job.endkunde != null && String(job.endkunde).trim() !== '') ? String(job.endkunde).trim() : (job.customer_name || '').trim();
    if (nameLine) addressLines.push(escapeHtml(nameLine));
    var streetLine = [(job.street || '').trim(), (job.house_number || '').trim()].filter(Boolean).join(' ');
    if (streetLine) addressLines.push(escapeHtml(streetLine));
    var zipCityLine = [(job.zip || '').trim(), (job.city || '').trim()].filter(Boolean).join(' ');
    if (zipCityLine) addressLines.push(escapeHtml(zipCityLine));
    var archivCountry = (job.country || '').trim();
    if (archivCountry) {
      var archivCountryCode = normalizeCountryToCode(job.country) || archivCountry.toUpperCase().slice(0, 2);
      var archivFlagHtml = countryFlagImg(archivCountryCode);
      addressLines.push(archivFlagHtml ? (archivFlagHtml + ' ' + escapeHtml(archivCountry)) : escapeHtml(archivCountry));
    }
    var extra1 = (job.address_extra_1 || '').trim();
    if (extra1) addressLines.push(escapeHtml(extra1));
    var extra2 = (job.address_extra_2 || '').trim();
    if (extra2) addressLines.push(escapeHtml(extra2));
    var addressLine = addressLines.length ? addressLines.join('<br>') : '–';
    var cell = function (x) { return (x == null || String(x).trim() === '' ? '' : escapeHtml(String(x).trim())); };
    var html = '<div class="archiv-detail-grid">';
    html += '<div class="archiv-detail-section"><h4>Auftrag</h4><dl class="modal-detail-dl">';
    html += '<dt>Auftragsnummer</dt><dd>' + v(job.job_number) + '</dd>';
    html += '<dt>Typ</dt><dd>' + v(job.job_type) + '</dd>';
    html += '<dt>Zeitraum</dt><dd>' + (dateRangeStr ? v(dateRangeStr) : v(formatDateOnly(job.start_datetime) || job.start_datetime)) + '</dd>';
    html += '<dt>Status</dt><dd>' + v(job.status) + '</dd>';
    if (job.description) html += '<dt>Bemerkungen</dt><dd>' + (escapeHtml(String(job.description).trim()) || '–') + '</dd>';
    html += '</dl></div>';
    html += '<div class="archiv-detail-section"><h4>Kunde</h4><dl class="modal-detail-dl">';
    html += '<dt>Name</dt><dd>' + v(job.customer_name) + '</dd>';
    html += '<dt>Straße</dt><dd>' + v(job.customer_street) + ' ' + v(job.customer_house_number) + '</dd>';
    html += '<dt>Ort</dt><dd>' + v(job.customer_zip) + ' ' + v(job.customer_city) + '</dd>';
    html += '<dt>Telefon</dt><dd>' + v(job.customer_phone) + '</dd>';
    html += '</dl></div>';
    html += '<div class="archiv-detail-section"><h4>Auftragsadresse</h4><p class="modal-address">' + addressLine + '</p></div>';
    html += '<div class="archiv-detail-section"><h4>Kontakt</h4><dl class="modal-detail-dl">';
    (function () {
      var c = (job.job_contacts && job.job_contacts[0]) ? job.job_contacts[0] : null;
      var name = c ? (c.contact_name || '') : (job.contact_person || '');
      var phone = c ? (c.contact_phone || '') : (job.contact_phone || '');
      var email = c ? (c.contact_email || '') : (job.contact_email || '');
      html += '<dt>Ansprechpartner</dt><dd>' + v(name) + '</dd>';
      html += '<dt>Telefon</dt><dd>' + v(phone) + '</dd>';
      html += '<dt>E-Mail</dt><dd>' + v(email) + '</dd>';
    })();
    html += '</dl></div>';
    html += '<div class="archiv-detail-section"><h4>ERP / Bestellung</h4><dl class="modal-detail-dl">';
    html += '<dt>ERP-Nummer</dt><dd>' + v(job.eap_nummer) + '</dd>';
    html += '<dt>Bestellnummer</dt><dd>' + v(job.bestellnummer) + '</dd></dl></div>';
    html += '</div>';
    var fabRows = parseFabrikationsnummernRows(job);
    html += '<div class="archiv-detail-section"><h4>Fabrikationsnummern / Leistungsdaten</h4>';
    html += '<div class="archiv-fab-table-wrap"><table class="archiv-fab-table"><thead><tr>';
    html += '<th>Fabrikationsnummer</th><th>Type</th><th>Leistung</th><th>Nenngeschwindigkeit</th><th>Kraftaufnehmer</th><th>DMS Nr.</th><th>Tacho</th><th>Elektronik</th><th>Material</th><th>Position</th>';
    html += '</tr></thead><tbody>';
    fabRows.forEach(function (row) {
      html += '<tr>';
      html += '<td>' + cell(row.fabrikationsnummer) + '</td><td>' + cell(row.type) + '</td><td>' + cell(row.leistung) + '</td>';
      html += '<td>' + cell(row.nenngeschwindigkeit) + '</td><td>' + cell(row.kraftaufnehmer) + '</td><td>' + cell(row.dms_nr) + '</td>';
      html += '<td>' + cell(row.tacho) + '</td><td>' + cell(row.elektronik) + '</td><td>' + cell(row.material) + '</td><td>' + cell(row.position) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }

  function parseFabrikationsnummernRows(job) {
    var fab = job.fabrikationsnummern != null ? job.fabrikationsnummern : (job.Fabrikationsnummern != null ? job.Fabrikationsnummern : (job.fabrikation != null ? job.fabrikation : (job.job_fabrikation != null ? job.job_fabrikation : null)));
    var parsedList = null;
    if (fab != null && (typeof fab === 'string' && (fab = fab.trim()) !== '')) {
      try {
        var parsed = JSON.parse(fab);
        parsedList = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null);
      } catch (err) {
        var parts = fab.split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts.length > 0) {
          parsedList = parts.map(function (fn) {
            return {
              fabrikationsnummer: fn,
              type: '',
              leistung: '',
              nenngeschwindigkeit: '',
              kraftaufnehmer: '',
              dms_nr: '',
              tacho: '',
              elektronik: '',
              material: '',
              position: '',
              geliefert_ueber: '',
              projekt: '',
              bemerkungen: ''
            };
          });
        }
      }
    } else if (fab != null && Array.isArray(fab)) {
      parsedList = fab;
    } else if (fab != null && typeof fab === 'object' && !Array.isArray(fab)) {
      parsedList = [fab];
    }
    var get = function (r, keys) {
      if (!r || typeof r !== 'object') return '';
      for (var i = 0; i < keys.length; i++) {
        var val = r[keys[i]];
        if (val !== undefined && val !== null) { var s = String(val).trim(); if (s.toLowerCase() === 'null') return ''; return s; }
        var lower = keys[i].toLowerCase();
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && k.toLowerCase() === lower) {
          var v2 = r[k]; if (v2 === undefined || v2 === null) continue;
          var s2 = String(v2).trim(); if (s2.toLowerCase() === 'null') return ''; return s2;
        }
      }
      return '';
    };
    var rows = [];
    if (parsedList && parsedList.length > 0) {
      parsedList.forEach(function (row) {
        var r = row && typeof row === 'object' ? row : {};
        rows.push({
          fabrikationsnummer: get(r, ['fabrikationsnummer', 'Fabrikationsnummer', 'fab', 'FabrikationsNr']),
          type: get(r, ['type', 'Type', 'typ', 'Typ']),
          leistung: get(r, ['leistung', 'Leistung']),
          nenngeschwindigkeit: get(r, ['nenngeschwindigkeit', 'Nenngeschwindigkeit']),
          kraftaufnehmer: get(r, ['kraftaufnehmer', 'Kraftaufnehmer']),
          dms_nr: get(r, ['dms_nr', 'DMS Nr.', 'dms_nr']),
          tacho: get(r, ['tacho', 'Tacho']),
          elektronik: get(r, ['elektronik', 'Elektronik']),
          material: get(r, ['material', 'Material']),
          position: get(r, ['position', 'Position']),
          geliefert_ueber: get(r, ['geliefert_ueber', 'geliefertUeber']),
          projekt: get(r, ['projekt', 'Projekt']),
          bemerkungen: get(r, ['bemerkungen', 'Bemerkungen'])
        });
      });
    }
    if (rows.length === 0) {
      rows.push({
        fabrikationsnummer: '',
        type: '',
        leistung: '',
        nenngeschwindigkeit: '',
        kraftaufnehmer: '',
        dms_nr: '',
        tacho: '',
        elektronik: '',
        material: '',
        position: '',
        geliefert_ueber: '',
        projekt: '',
        bemerkungen: ''
      });
    }
    return rows;
  }

  function renderArchivFolderTree(jobId, containerEl) {
    if (!containerEl) return;
    var root = archivFolderRoot[jobId];
    var expanded = archivFolderExpanded[jobId];
    if (!expanded) archivFolderExpanded[jobId] = {};
    expanded = archivFolderExpanded[jobId];
    var rows = [];
    function addEntries(entries, level) {
      if (!entries) return;
      entries.forEach(function (e) {
        rows.push({ level: level, entry: e });
        if (e.isDirectory && expanded[e.relativePath]) addEntries(expanded[e.relativePath], level + 1);
      });
    }
    addEntries(root || [], 0);
    if (rows.length === 0) {
      containerEl.innerHTML = '<p class="empty">Keine Ordner/Dateien gespeichert.</p>';
      return;
    }
    var html = '<div class="archiv-folder-tree">';
    rows.forEach(function (r) {
      var e = r.entry;
      var levelClass = r.level > 0 ? ' level-' + Math.min(r.level, 6) : '';
      var icon = e.isDirectory ? '📁' : '📄';
      var sizeStr = e.isDirectory ? '' : formatFileSize(e.size);
      var mtimeStr = formatFileDate(e.mtime);
      var isOpen = e.isDirectory && expanded[e.relativePath];
      var toggle = e.isDirectory ? ('<span class="archiv-folder-toggle" data-rel="' + escapeHtml(e.relativePath || '') + '">' + (isOpen ? '▼' : '▶') + '</span>') : '<span class="archiv-folder-toggle empty"></span>';
      var openBtn = e.isDirectory ? '' : '<button type="button" class="btn btn-ghost archiv-folder-open" title="Datei öffnen">Öffnen</button>';
      html += '<div class="archiv-folder-row' + levelClass + '" data-is-dir="' + (e.isDirectory ? '1' : '0') + '" data-relative-path="' + escapeHtml(e.relativePath || '') + '" data-full-path="' + escapeHtml(e.fullPath || '') + '">' +
        '<div class="archiv-folder-name">' + toggle + '<span class="icon">' + icon + '</span> ' + escapeHtml(e.name) + '</div>' +
        '<div class="archiv-folder-meta">' + escapeHtml(sizeStr) + ' ' + escapeHtml(mtimeStr) + '</div>' +
        (openBtn ? '<div class="archiv-folder-actions">' + openBtn + '</div>' : '') + '</div>';
    });
    html += '</div>';
    containerEl.innerHTML = html;
    containerEl.querySelectorAll('.archiv-folder-row[data-is-dir="0"]').forEach(function (row) {
      var fullPath = row.getAttribute('data-full-path');
      if (!fullPath) return;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('.archiv-folder-actions')) return;
        if (typeof monteurApp !== 'undefined' && monteurApp.openPath) monteurApp.openPath(fullPath);
      });
      var openBtn = row.querySelector('.archiv-folder-open');
      if (openBtn) openBtn.addEventListener('click', function (ev) { ev.stopPropagation(); if (typeof monteurApp !== 'undefined' && monteurApp.openPath) monteurApp.openPath(fullPath); });
    });
    containerEl.querySelectorAll('.archiv-folder-row[data-is-dir="1"]').forEach(function (row) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', function (ev) {
        var rel = row.getAttribute('data-relative-path');
        if (!rel) return;
        if (expanded[rel]) {
          delete expanded[rel];
          renderArchivFolderTree(jobId, containerEl);
          return;
        }
        fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId) + '&subpath=' + encodeURIComponent(rel)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.entries) expanded[rel] = data.entries;
          renderArchivFolderTree(jobId, containerEl);
        });
      });
    });
  }

  function loadArchivJobExpandContent(jobId, expandEl) {
    expandEl.innerHTML = '<p class="empty">Wird geladen…</p>';
    var headers = {};
    var techId = getTechId();
    if (techId) headers['X-Technician-Id'] = String(techId);
    Promise.all([
      fetch(API_BASE + '/api/job?id=' + encodeURIComponent(jobId), { headers: headers }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId)).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var jobRes = results[0];
      var filesRes = results[1];
      var job = (jobRes && jobRes.ok && jobRes.job) ? jobRes.job : null;
      if (!job) {
        expandEl.innerHTML = '<p class="empty">Auftragsdetails konnten nicht geladen werden.</p>';
        return;
      }
      archivJobDetailsCache[jobId] = job;
      var rootEntries = (filesRes && filesRes.ok && filesRes.entries) ? filesRes.entries : [];
      archivFolderRoot[jobId] = rootEntries;
      if (!archivFolderExpanded[jobId]) archivFolderExpanded[jobId] = {};
      var detailHtml = buildArchivJobDetailHtml(job);
      expandEl.innerHTML = detailHtml + '<div class="archiv-detail-section"><h4>Gespeicherte Ordner &amp; Dateien</h4><div class="archiv-folder-container" data-job-id="' + jobId + '"></div></div>';
      var container = expandEl.querySelector('.archiv-folder-container');
      if (container) renderArchivFolderTree(jobId, container);
    }).catch(function (e) {
      expandEl.innerHTML = '<p class="empty">Fehler: ' + escapeHtml(e.message || String(e)) + '</p>';
    });
  }

  async function loadArchiv() {
    const listEl = document.getElementById('archivList');
    if (!listEl) return;
    const techId = getTechId();
    if (!techId) {
      listEl.innerHTML = '<span class="empty">Bitte Monteur-ID in Einstellungen eintragen.</span>';
      return;
    }
    const filters = getArchivFilters();
    const params = {
      year: filters.year,
      customer: filters.customer || undefined,
      month: filters.month || undefined,
      fabrikationsnummer: filters.fabrikationsnummer || undefined,
      country: filters.country || undefined
    };
    listEl.innerHTML = '<span class="empty">Wird geladen…</span>';
    try {
      const data = await api('/api/my_jobs_archive?' + qs(params));
      renderArchivJobs(data);
    } catch (e) {
      listEl.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message || String(e)) + '</span>';
    }
  }

  function formatAnlagenstammSize(size) {
    var s = Number(size || 0);
    if (s < 1024) return s + ' B';
    if (s < 1024 * 1024) return Math.round(s / 1024) + ' KB';
    return (s / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatAnlagenstammMtime(ts) {
    var n = Number(ts || 0);
    if (!n) return '';
    try {
      return new Date(n * 1000).toLocaleDateString('de-AT');
    } catch (e) {
      return '';
    }
  }

  function pnParentHeadingForSiblings(nodes) {
    if (!nodes || !nodes.length) return '';
    return String(nodes[0].parent_name || nodes[0].parentName || '').trim();
  }

  function buildAnlagenstammFormHtml(a, fabFallback) {
    var fab = (a && a.fabrikationsnummer) ? String(a.fabrikationsnummer) : String(fabFallback || '');
    var idVal = (a && a.id) ? String(a.id) : '';
    function v(key) {
      return a && a[key] != null ? escapeHtml(String(a[key])) : '';
    }
    if (!a || !a.id) {
      return '<div class="empty" style="margin-top:0.5rem">Kein Stammdatensatz für <strong>' + escapeHtml(fab) + '</strong>. Bitte in der Dispo anlegen oder andere F.N. wählen.</div>';
    }
    return '<div class="anlagenstamm-form-wrap">' +
      '<input type="hidden" id="as-form-id" value="' + escapeHtml(idVal) + '">' +
      '<div class="anlagenstamm-form-section"><h4>Identifikation</h4><div class="anlagenstamm-form-grid">' +
      '<div class="form-full"><label for="as-form-fab">Fabrikationsnummer</label><input type="text" id="as-form-fab" value="' + v('fabrikationsnummer') + '" required></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Technik</h4><div class="anlagenstamm-form-grid">' +
      '<div><label for="as-form-type">Type</label><input type="text" id="as-form-type" value="' + v('type') + '"></div>' +
      '<div><label for="as-form-leistung">Leistung</label><input type="text" id="as-form-leistung" value="' + v('leistung') + '"></div>' +
      '<div><label for="as-form-nenngeschwindigkeit">Nenngeschwindigkeit</label><input type="text" id="as-form-nenngeschwindigkeit" value="' + v('nenngeschwindigkeit') + '"></div>' +
      '<div><label for="as-form-kraftaufnehmer">Kraftaufnehmer</label><input type="text" id="as-form-kraftaufnehmer" value="' + v('kraftaufnehmer') + '"></div>' +
      '<div><label for="as-form-material">Material</label><input type="text" id="as-form-material" value="' + v('material') + '"></div>' +
      '<div><label for="as-form-position">Position</label><input type="text" id="as-form-position" value="' + v('position') + '"></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Elektronik</h4><div class="anlagenstamm-form-grid">' +
      '<div><label for="as-form-tacho">Tacho</label><input type="text" id="as-form-tacho" value="' + v('tacho') + '"></div>' +
      '<div><label for="as-form-elektronik">Elektronik</label><input type="text" id="as-form-elektronik" value="' + v('elektronik') + '"></div>' +
      '<div><label for="as-form-dms">DMS-Nr.</label><input type="text" id="as-form-dms" value="' + v('dms_nr') + '"></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Vertrieb / Projekt</h4><div class="anlagenstamm-form-grid">' +
      '<div class="form-full"><label for="as-form-geliefert">Geliefert über</label><input type="text" id="as-form-geliefert" value="' + v('geliefert_ueber') + '" placeholder="z. B. Kunde, Händler"></div>' +
      '<div class="form-full"><label for="as-form-projekt">Projekt</label><input type="text" id="as-form-projekt" value="' + v('projekt') + '"></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Letzter Kunde (nur Anzeige)</h4><div class="anlagenstamm-form-grid">' +
      '<div><label>Letzter Kunde</label><input type="text" readonly value="' + (a && a.aktueller_kunde != null ? escapeHtml(String(a.aktueller_kunde)) : '') + '"></div>' +
      '<div><label>Letzter Besuch</label><input type="text" readonly value="' + (a && a.letzter_besuch != null ? escapeHtml(String(a.letzter_besuch)) : '') + '"></div>' +
      '</div><p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0 0">Wird durch Auftragsabschluss in der Dispo gepflegt, nicht hier.</p></div>' +
      '<div class="anlagenstamm-form-section"><h4>Bemerkungen</h4><div class="anlagenstamm-form-grid">' +
      '<div class="form-full"><label for="as-form-bemerkungen">Bemerkungen</label><textarea id="as-form-bemerkungen" rows="3">' + v('bemerkungen') + '</textarea></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-actions">' +
      '<button type="button" class="btn btn-primary" id="btnAnlagenstammSave">In Dispo speichern</button>' +
      '<span class="muted" style="font-size:0.8rem">Änderungen gehen direkt in den zentralen Anlagenstamm (Datenbank).</span>' +
      '</div></div>';
  }

  /** Index der Ergebniszeile, die am ehesten zu den Suchfeldern passt (für Scroll + Fokus). */
  function pickAnlagenstammFocusRowIndex(rows, fn, kunde, typ, land) {
    if (!rows || !rows.length) return 0;
    var fnT = (fn || '').trim();
    var fnL = fnT.toLowerCase();
    if (fnL) {
      var i;
      for (i = 0; i < rows.length; i++) {
        var ex = String(rows[i].fabrikationsnummer || '').trim().toLowerCase();
        if (ex === fnL) return i;
      }
      for (i = 0; i < rows.length; i++) {
        var pr = String(rows[i].fabrikationsnummer || '').trim().toLowerCase();
        if (pr.indexOf(fnL) !== -1) return i;
      }
    }
    var terms = [fnT, (kunde || '').trim(), (typ || '').trim(), (land || '').trim()]
      .map(function (t) { return t.toLowerCase(); })
      .filter(Boolean);
    if (!terms.length) return 0;
    var bestI = 0;
    var bestScore = -1;
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var blob = [r.fabrikationsnummer, r.type, r.aktueller_kunde, r.projekt]
        .map(function (x) { return String(x || '').toLowerCase(); })
        .join('\u0001');
      var sc = 0;
      for (var t = 0; t < terms.length; t++) {
        if (terms[t] && blob.indexOf(terms[t]) !== -1) sc++;
      }
      if (sc > bestScore) {
        bestScore = sc;
        bestI = k;
      }
    }
    return bestI;
  }

  function scrollAnlagenstammResultsToTr(resEl, tr) {
    if (!resEl || !tr) return;
    var thead = resEl.querySelector('thead');
    var anchorBottom = thead ? thead.getBoundingClientRect().bottom : resEl.getBoundingClientRect().top;
    var trTop = tr.getBoundingClientRect().top;
    resEl.scrollTop += trTop - anchorBottom;
  }

  async function searchAnlagenstammList() {
    var msgEl = document.getElementById('anlagenstammMessage');
    var resEl = document.getElementById('anlagenstammSearchResults');
    if (!getDispoBaseUrl()) {
      try {
        var picked = await pickDispoBase();
        if (!picked || !picked.ok) {
          if (msgEl) msgEl.textContent = 'Dispo-Basis fehlt oder nicht erreichbar. Bitte unter Einstellungen URLs prüfen und Verbindung testen.';
          return;
        }
      } catch (e) {
        if (msgEl) msgEl.textContent = 'Dispo-Basis konnte nicht gewählt werden: ' + (e.message || String(e));
        return;
      }
    }
    var fn = ((document.getElementById('anlagenstammFilterFn') || {}).value || '').trim();
    var kunde = ((document.getElementById('anlagenstammFilterKunde') || {}).value || '').trim();
    var typ = ((document.getElementById('anlagenstammFilterType') || {}).value || '').trim();
    var land = ((document.getElementById('anlagenstammFilterLand') || {}).value || '').trim();
    if (!fn && !kunde && !typ && !land) {
      if (msgEl) msgEl.textContent = 'Mindestens ein Suchkriterium eintragen.';
      if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
      return;
    }
    if (msgEl) msgEl.textContent = 'Suche läuft…';
    if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
    try {
      var data = await anlagenstammSearchDispo(Object.assign({
        baseUrl: getDispoBaseUrl(),
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword(),
        filter_fn: fn,
        filter_aktueller_kunde: kunde,
        filter_type: typ,
        filter_land: land,
        page: 1,
        page_size: 50
      }, dispoBasePayloadExtra()));
      var rows = (data && data.rows) ? data.rows : [];
      if (resEl) {
        if (!rows.length) {
          resEl.style.display = 'block';
          resEl.innerHTML = '<div class="empty" style="padding:0.5rem">Keine Treffer.</div>';
        } else {
          var th = '<thead><tr><th>F.N.</th><th>Type</th><th>Letzter Kunde</th><th>Projekt</th></tr></thead>';
          var tb = rows.map(function (r) {
            var f = String(r.fabrikationsnummer || '').trim();
            return '<tr data-as-fab="' + escapeHtml(f) + '" tabindex="0"><td>' + escapeHtml(f) + '</td><td>' + escapeHtml(r.type || '') + '</td><td>' + escapeHtml(r.aktueller_kunde || '') + '</td><td>' + escapeHtml(r.projekt || '') + '</td></tr>';
          }).join('');
          resEl.style.display = 'block';
          resEl.innerHTML = '<table>' + th + '<tbody>' + tb + '</tbody></table>';
          resEl.querySelectorAll('tbody tr[data-as-fab]').forEach(function (tr) {
            function open() {
              var f = (tr.getAttribute('data-as-fab') || '').trim();
              if (f) loadAnlagenstammDetail(f);
            }
            tr.addEventListener('click', function () {
              resEl.querySelectorAll('tbody tr.anlagenstamm-search-row-focus').forEach(function (x) {
                x.classList.remove('anlagenstamm-search-row-focus');
              });
              tr.classList.add('anlagenstamm-search-row-focus');
              open();
            });
            tr.addEventListener('keydown', function (ev) {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                resEl.querySelectorAll('tbody tr.anlagenstamm-search-row-focus').forEach(function (x) {
                  x.classList.remove('anlagenstamm-search-row-focus');
                });
                tr.classList.add('anlagenstamm-search-row-focus');
                open();
              }
            });
          });
          var focusIdx = pickAnlagenstammFocusRowIndex(rows, fn, kunde, typ, land);
          var trArr = resEl.querySelectorAll('tbody tr[data-as-fab]');
          if (trArr.length && focusIdx >= 0 && focusIdx < trArr.length) {
            var focusTr = trArr[focusIdx];
            focusTr.classList.add('anlagenstamm-search-row-focus');
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                try {
                  resEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                  scrollAnlagenstammResultsToTr(resEl, focusTr);
                  try {
                    focusTr.focus({ preventScroll: true });
                  } catch (fe) { /* ignore */ }
                } catch (scrollEx) { /* ignore */ }
              });
            });
          }
        }
      }
      if (msgEl) {
        msgEl.textContent = rows.length
          ? rows.length + ' Treffer. Passende Zeile markiert; in der Liste nach oben/unten scrollen. Anklicken für Details.'
          : '';
      }
      if (rows.length === 1) {
        var onlyFab = String(rows[0].fabrikationsnummer || '').trim();
        if (onlyFab) loadAnlagenstammDetail(onlyFab);
      }
    } catch (e) {
      var errText = (e && e.message) ? e.message : String(e);
      try {
        console.error(
          '[Kukla Anlagenstamm Suche]',
          errText,
          '| Dispo-Basis:',
          getDispoBaseUrl(),
          '| Hinweis: Die Abfrage läuft im Electron-Hauptprozess (IPC), sie erscheint nicht als „fetch“ zur Dispo im Renderer-Network-Tab.'
        );
      } catch (logEx) { /* ignore */ }
      if (msgEl) msgEl.textContent = 'Fehler: ' + errText;
      if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
    }
  }

  function readAnlagenstammFormPayload() {
    var fabEl = document.getElementById('as-form-fab');
    if (!fabEl) return null;
    return Object.assign({
      baseUrl: getDispoBaseUrl(),
      serverUsername: getServerUsername(),
      serverPassword: getServerPassword(),
      id: parseInt((document.getElementById('as-form-id') || {}).value || '0', 10) || 0,
      fabrikationsnummer: (fabEl.value || '').trim(),
      type: ((document.getElementById('as-form-type') || {}).value || ''),
      leistung: ((document.getElementById('as-form-leistung') || {}).value || ''),
      nenngeschwindigkeit: ((document.getElementById('as-form-nenngeschwindigkeit') || {}).value || ''),
      kraftaufnehmer: ((document.getElementById('as-form-kraftaufnehmer') || {}).value || ''),
      material: ((document.getElementById('as-form-material') || {}).value || ''),
      tacho: ((document.getElementById('as-form-tacho') || {}).value || ''),
      elektronik: ((document.getElementById('as-form-elektronik') || {}).value || ''),
      dms_nr: ((document.getElementById('as-form-dms') || {}).value || ''),
      position: ((document.getElementById('as-form-position') || {}).value || ''),
      geliefert_ueber: ((document.getElementById('as-form-geliefert') || {}).value || ''),
      projekt: ((document.getElementById('as-form-projekt') || {}).value || ''),
      bemerkungen: ((document.getElementById('as-form-bemerkungen') || {}).value || '')
    }, dispoBasePayloadExtra());
  }

  function applyAnlagenstammFormFromRow(a, fab) {
    var cardEl = document.getElementById('anlagenstammCard');
    if (!cardEl) return;
    cardEl.innerHTML = buildAnlagenstammFormHtml(a, fab);
    var saveBtn = document.getElementById('btnAnlagenstammSave');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveAnlagenstammFromForm(); });
  }

  async function saveAnlagenstammFromForm() {
    var msgEl = document.getElementById('anlagenstammMessage');
    var payload = readAnlagenstammFormPayload();
    if (!payload) return;
    if (!payload.fabrikationsnummer) {
      if (msgEl) msgEl.textContent = 'Fabrikationsnummer fehlt.';
      return;
    }
    if (msgEl) msgEl.textContent = 'Speichern…';
    try {
      var data = await anlagenstammSaveDispo(payload);
      if (!data || !data.ok) {
        throw new Error((data && data.error) ? data.error : 'Speichern fehlgeschlagen');
      }
      var row = {
        id: data.id,
        fabrikationsnummer: payload.fabrikationsnummer,
        type: payload.type,
        leistung: payload.leistung,
        nenngeschwindigkeit: payload.nenngeschwindigkeit,
        kraftaufnehmer: payload.kraftaufnehmer,
        material: payload.material,
        tacho: payload.tacho,
        elektronik: payload.elektronik,
        dms_nr: payload.dms_nr,
        position: payload.position,
        geliefert_ueber: payload.geliefert_ueber,
        projekt: payload.projekt,
        bemerkungen: payload.bemerkungen
      };
      applyAnlagenstammFormFromRow(row, payload.fabrikationsnummer);
      mergeAnlagenstammFieldsIntoOpenJob(payload.fabrikationsnummer, row);
      if (jobDetailsJobId) {
        var arr = leistungRowsForJobPatch(window.currentProjektdatenLeistungRows || []);
        api('/api/job', {
          method: 'PATCH',
          body: JSON.stringify({ job_id: parseInt(jobDetailsJobId, 10), fabrikationsnummern: JSON.stringify(arr) })
        }).catch(function () { /* Auftrag-Patch best-effort */ });
      }
      var detailModal = document.getElementById('anlageDetailModal');
      if (detailModal && detailModal.parentNode) {
        detailModal.parentNode.removeChild(detailModal);
      }
      if (msgEl) {
        if (data.push_error) {
          msgEl.textContent = 'Lokal gespeichert – Dispo: ' + data.push_error;
        } else {
          msgEl.textContent = data.pending_sync
            ? 'Lokal gespeichert – wird beim nächsten Sync mit Dispo abgeglichen.'
            : 'Gespeichert (lokal und Dispo).';
        }
      }
      if (data.push_error) {
        showToast('Lokal gespeichert – Dispo: ' + data.push_error);
      } else {
        showToast(data.pending_sync ? 'Lokal gespeichert.' : 'Gespeichert.');
      }
    } catch (e) {
      var saveErr = (e && e.message) ? e.message : String(e);
      try {
        console.error('[Kukla Anlagenstamm Speichern]', saveErr, '| Dispo-Basis:', getDispoBaseUrl());
      } catch (logEx) { /* ignore */ }
      if (msgEl) msgEl.textContent = 'Fehler: ' + saveErr;
    }
  }

  async function loadAnlagenstammDetail(fab) {
    var msgEl = document.getElementById('anlagenstammMessage');
    var cardEl = document.getElementById('anlagenstammCard');
    var filesEl = document.getElementById('anlagenstammFiles');
    fab = (fab || '').trim();
    if (!fab) {
      if (msgEl) msgEl.textContent = 'Keine Fabrikationsnummer.';
      return;
    }
    if (msgEl) msgEl.textContent = 'Lade Stammdaten…';
    if (cardEl) cardEl.innerHTML = '';
    if (filesEl) { filesEl.style.display = 'none'; filesEl.innerHTML = ''; }
    var pnSecL = document.getElementById('anlagenstammPnSection');
    var pnTreeL = document.getElementById('anlagenstammPnTree');
    var pnHintL = document.getElementById('anlagenstammPnHint');
    if (pnSecL) pnSecL.style.display = 'none';
    if (pnTreeL) pnTreeL.innerHTML = '';
    if (pnHintL) pnHintL.textContent = '';
    try {
      var payload = {
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      };
      var lookup = await api('/api/anlagenstamm_lookup', { method: 'POST', body: JSON.stringify(payload) });
      var a = lookup && (lookup.anlage || lookup.row) ? (lookup.anlage || lookup.row) : null;
      if (cardEl) {
        applyAnlagenstammFormFromRow(a, fab);
      }
      if (msgEl) msgEl.textContent = '';
      var files = await api('/api/anlagenstamm_files_list', { method: 'POST', body: JSON.stringify(payload) });
      var list = (files && files.files) ? files.files : [];
      if (filesEl) {
        filesEl.style.display = '';
        filesEl.innerHTML = list.length
          ? list.map(function (f) {
              return '<div class="anlagenstamm-files-row"><span>' + escapeHtml(f.name || '') + ' <span class="muted">(' + escapeHtml(formatAnlagenstammSize(f.size)) + ')</span></span>' +
                '<button class="btn btn-ghost" data-anlage-file="' + encodeURIComponent(f.name || '') + '">Download</button></div>';
            }).join('')
          : '<div class="anlagenstamm-files-row"><span class="empty">Keine Dokumente gefunden.</span></div>';
        filesEl.querySelectorAll('[data-anlage-file]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            downloadAnlagenstammFile(fab, decodeURIComponent(btn.getAttribute('data-anlage-file') || '')).catch(function (err) {
              if (msgEl) msgEl.textContent = 'Fehler: ' + (err.message || String(err));
            });
          });
        });
      }
      var pnSection = document.getElementById('anlagenstammPnSection');
      var pnTreeEl = document.getElementById('anlagenstammPnTree');
      var pnHintEl = document.getElementById('anlagenstammPnHint');
      if (pnSection && pnTreeEl && pnHintEl) {
        pnSection.style.display = 'block';
        pnTreeEl.innerHTML = '';
        var pnRaw = files && files.projekte_neu ? files.projekte_neu : {};
        var cached = await fetch(API_BASE + '/api/anlagenstamm_tree_cached?fab=' + encodeURIComponent(fab), {
          headers: { 'X-Technician-Id': String(getTechId() || '') }
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
        var cachedTree = (cached && cached.found && Array.isArray(cached.tree)) ? cached.tree : [];
        var usedCache = cached && cached.found && (cached.projects_enabled === true || cached.projects_enabled === 1);
        if (pnRaw && pnRaw.enabled) {
          pnHintEl.textContent = 'Ordner zum Aufklappen – Datei per Klick öffnen.';
          var tr = Array.isArray(pnRaw.tree) ? pnRaw.tree : [];
          if (!tr.length) {
            pnTreeEl.innerHTML = '<div class="empty" style="padding:0.35rem 0">Keine Einträge in diesem Fabrikationsordner.</div>';
          } else {
            appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, fab, tr, msgEl);
          }
        } else if (usedCache && cachedTree.length) {
          pnHintEl.textContent = 'PROJEKTE NEU (lokaler Cache). Verbindung prüfen für Aktualisierung.';
          appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, fab, cachedTree, msgEl);
        } else {
          pnHintEl.textContent = 'PROJEKTE NEU ist nicht verfügbar oder der Fabrikationsordner wurde auf dem Mount nicht gefunden.';
        }
      }
      if (msgEl) msgEl.textContent = '';
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Fehler: ' + (e.message || String(e));
      var pnSecE = document.getElementById('anlagenstammPnSection');
      var pnTreeE = document.getElementById('anlagenstammPnTree');
      var pnHintE = document.getElementById('anlagenstammPnHint');
      if (pnSecE) pnSecE.style.display = 'none';
      if (pnTreeE) pnTreeE.innerHTML = '';
      if (pnHintE) pnHintE.textContent = '';
    }
  }

  async function downloadAnlagenstammFile(fab, file) {
    if (!fab || !file) return;
    const technicianId = getTechId();
    // Bevorzugt direkt lokal öffnen (Windows-Dateizuordnung).
    const openResp = await fetch(API_BASE + '/api/anlagenstamm_file_open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify({
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        file: file,
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      })
    });
    const openData = await openResp.json().catch(function () { return {}; });
    if (openResp.ok && openData && openData.ok === true && openData.path && typeof monteurApp !== 'undefined' && monteurApp.openPath) {
      const openResult = await monteurApp.openPath(String(openData.path));
      if (!openResult || openResult.ok !== false) {
        showToast('Datei wird direkt lokal geöffnet.');
        return;
      }
      if (openResult && openResult.error) {
        showToast('Direkt öffnen fehlgeschlagen: ' + openResult.error);
      }
      // Wenn direktes Öffnen fehlschlägt, auf Download zurückfallen.
    } else if (openData && openData.error) {
      showToast('Direkt öffnen nicht möglich: ' + openData.error + ' – Download wird verwendet.');
    }

    const resp = await fetch(API_BASE + '/api/anlagenstamm_file_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify({
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        file: file,
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      })
    });
    if (!resp.ok) {
      let err = 'Öffnen/Download fehlgeschlagen.';
      try {
        const j = await resp.json();
        if (j && j.error) err = j.error;
      } catch (_) {}
      throw new Error(err);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function downloadAnlagenstammProjekteNeu(fab, relPath, fallbackName) {
    if (!fab || !relPath) return;
    const technicianId = getTechId();
    // Bevorzugt direkt lokal öffnen (Windows-Dateizuordnung).
    const openResp = await fetch(API_BASE + '/api/anlagenstamm_file_open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify({
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        source: 'projekte_neu',
        path: relPath,
        fallbackName: fallbackName || '',
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      })
    });
    const openData = await openResp.json().catch(function () { return {}; });
    if (openResp.ok && openData && openData.ok === true && openData.path && typeof monteurApp !== 'undefined' && monteurApp.openPath) {
      const openResult = await monteurApp.openPath(String(openData.path));
      if (!openResult || openResult.ok !== false) {
        showToast('Datei wird direkt lokal geöffnet.');
        return;
      }
      if (openResult && openResult.error) {
        showToast('Direkt öffnen fehlgeschlagen: ' + openResult.error);
      }
      // Wenn direktes Öffnen fehlschlägt, auf Download zurückfallen.
    } else if (openData && openData.error) {
      showToast('Direkt öffnen nicht möglich: ' + openData.error + ' – Download wird verwendet.');
    }

    const resp = await fetch(API_BASE + '/api/anlagenstamm_file_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify({
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        source: 'projekte_neu',
        path: relPath,
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      })
    });
    if (!resp.ok) {
      let err = 'Öffnen/Download fehlgeschlagen.';
      try {
        const j = await resp.json();
        if (j && j.error) err = j.error;
      } catch (_) {}
      throw new Error(err);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    var parts = relPath.split('/');
    a.download = (fallbackName && String(fallbackName).trim()) || parts[parts.length - 1] || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function openAnlagenstammProjekteNeuLocal(fab, relPath, fallbackName, opts) {
    opts = opts || {};
    if (!fab || !relPath) return;
    const technicianId = getTechId();
    const jobId = resolveProjekteNeuJobId(opts);
    const body = {
      fab: fab,
      source: 'projekte_neu',
      path: relPath,
      fallbackName: fallbackName || '',
      job_id: jobId,
    };
    if (!preferLocalProjekteNeuOnly()) {
      body.baseUrl = getDispoBaseUrl();
      body.serverUsername = getServerUsername();
      body.serverPassword = getServerPassword();
    }
    const resp = await fetch(API_BASE + '/api/anlagenstamm_file_open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || !data || data.ok !== true || !data.path) {
      throw new Error((data && data.error) ? data.error : 'Öffnen fehlgeschlagen.');
    }
    if (typeof monteurApp !== 'undefined' && monteurApp.openPath) {
      const openRes = await monteurApp.openPath(String(data.path));
      if (openRes && openRes.ok === false) {
        throw new Error(openRes.error || 'Datei konnte nicht mit lokalem Programm geöffnet werden.');
      }
      return;
    }
    throw new Error('Lokales Öffnen ist in dieser Umgebung nicht verfügbar.');
  }

  function isProjekteNeuRasterImage(fileName) {
    var m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    var ext = m ? m[1] : '';
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif'].indexOf(ext) >= 0;
  }

  function handleProjekteNeuFileResponse(resp, opts) {
    opts = opts || {};
    if (!resp.ok) {
      return resp.json().catch(function () { return {}; }).then(function (j) {
        var err = new Error((j && j.error) ? j.error : 'HTTP ' + resp.status);
        err.localUnavailable =
          resp.status === 404 ||
          (j && (j.error === 'local_unavailable' || j.local_unavailable === true));
        throw err;
      });
    }
    return resp.blob().then(function (blob) {
      if (opts.thumb) {
        function normMime(s) {
          return String(s || '').toLowerCase().trim().split(';')[0].trim();
        }
        var hdrCt = normMime(resp.headers.get('content-type'));
        var blobCt = normMime(blob.type);
        var ct = hdrCt || blobCt;
        if (ct.indexOf('image/') === 0) return blob;
        if (ct.indexOf('application/json') === 0 || ct.indexOf('text/html') === 0 || ct.indexOf('text/plain') === 0) {
          throw new Error('thumb_not_image');
        }
        if (blob.size > 0 && blob.size < 12 * 1024 * 1024) return blob;
        throw new Error('thumb_not_image');
      }
      return blob;
    });
  }

  var projekteNeuThumbQueue = [];
  var projekteNeuThumbActive = 0;
  var PROJEKTE_NEU_THUMB_MAX_PARALLEL = 3;

  function drainProjekteNeuThumbQueue() {
    while (projekteNeuThumbActive < PROJEKTE_NEU_THUMB_MAX_PARALLEL && projekteNeuThumbQueue.length) {
      var job = projekteNeuThumbQueue.shift();
      if (!job || !job.timg || !job.timg.parentNode) continue;
      projekteNeuThumbActive += 1;
      fetchProjekteNeuFileBlob(job.fab, job.rel, job.fetchOpts)
        .then(job.setThumbBlob)
        .catch(job.showFileIcon)
        .finally(function () {
          projekteNeuThumbActive -= 1;
          drainProjekteNeuThumbQueue();
        });
    }
  }

  function enqueueProjekteNeuThumbnailLoad(timg, fab, rel, opts) {
    opts = opts || {};
    var fetchOpts = {
      thumb: true,
      thumbMax: opts.thumbMax || 256,
      jobId: resolveProjekteNeuJobId(opts),
    };
    function setThumbBlob(blob) {
      if (!timg || !timg.parentNode) return;
      var prev = timg.getAttribute('data-blob-url');
      if (prev) {
        try { URL.revokeObjectURL(prev); } catch (_) {}
      }
      var url = URL.createObjectURL(blob);
      timg.setAttribute('data-blob-url', url);
      timg.src = url;
    }
    function showFileIcon() {
      if (!timg || !timg.parentNode) return;
      var fileRow = timg.parentNode;
      var ic = document.createElement('span');
      ic.className = 'projekte-neu-file-icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = '\uD83D\uDCC4';
      fileRow.replaceChild(ic, timg);
    }
    projekteNeuThumbQueue.push({ timg: timg, fab: fab, rel: rel, fetchOpts: fetchOpts, setThumbBlob: setThumbBlob, showFileIcon: showFileIcon });
    drainProjekteNeuThumbQueue();
  }

  function loadProjekteNeuThumbnailImg(timg, fab, rel, opts) {
    if (!timg || !timg.parentNode) return;
    if (typeof IntersectionObserver !== 'undefined') {
      if (timg.getAttribute('data-pn-thumb-io') === '1') return;
      timg.setAttribute('data-pn-thumb-io', '1');
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (ent) {
            if (!ent.isIntersecting) return;
            io.disconnect();
            enqueueProjekteNeuThumbnailLoad(timg, fab, rel, opts);
          });
        },
        { rootMargin: '120px', threshold: 0.01 },
      );
      io.observe(timg);
      return;
    }
    enqueueProjekteNeuThumbnailLoad(timg, fab, rel, opts);
  }

  function resolveProjekteNeuJobId(opts) {
    opts = opts || {};
    if (opts.jobId != null && opts.jobId !== '') return parseInt(opts.jobId, 10) || null;
    if (typeof jobDetailsJobId !== 'undefined' && jobDetailsJobId) return jobDetailsJobId;
    if (typeof getDienstreiseExplorerJobId === 'function') {
      var ex = getDienstreiseExplorerJobId();
      if (ex) return ex;
    }
    return null;
  }

  function fetchProjekteNeuFileBlob(fab, relPath, opts) {
    opts = opts || {};
    var effectiveFab = resolveProjekteNeuFabForPath(fab, relPath);
    var technicianId = getTechId();
    var jobId = resolveProjekteNeuJobId(opts);
    function fetchLocal() {
      if (!jobId) {
        return fetch(API_BASE + '/api/anlagenstamm/projekte_neu_resolve_local?fab=' + encodeURIComponent(fab), {
          headers: { 'X-Technician-Id': String(technicianId || '') }
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.found && j.job_id) jobId = j.job_id;
          return jobId;
        });
      }
      return Promise.resolve(jobId);
    }
    function fetchBlobFromUrl(url) {
      return fetch(url, { headers: { 'X-Technician-Id': String(technicianId || '') } }).then(function (resp) {
        return handleProjekteNeuFileResponse(resp, opts);
      });
    }
    function tryLocalProjekteNeuFile(resolvedJobId) {
      var q =
        'job_id=' +
        encodeURIComponent(resolvedJobId) +
        '&fab=' +
        encodeURIComponent(effectiveFab) +
        '&path=' +
        encodeURIComponent(relPath);
      if (opts.thumb) q += '&thumb=1&thumbMax=' + encodeURIComponent(String(opts.thumbMax || 256));
      if (opts.inline) q += '&inline=1';
      return fetchBlobFromUrl(API_BASE + '/api/dienstreise/projekte_neu_file?' + q);
    }
    function tryLocalProjectFile(resolvedJobId) {
      var relNorm = String(relPath || '').replace(/^\/+/, '');
      var candidates = [relNorm, 'Dokumente_Monteur/' + relNorm];
      var chain = Promise.reject(new Error('local_unavailable'));
      candidates.forEach(function (relTry) {
        chain = chain.catch(function () {
          var q =
            'job_id=' +
            encodeURIComponent(resolvedJobId) +
            '&path=' +
            encodeURIComponent(relTry);
          if (opts.thumb) q += '&thumb=1&thumbMax=' + encodeURIComponent(String(opts.thumbMax || 256));
          if (opts.inline) q += '&inline=1';
          return fetchBlobFromUrl(API_BASE + '/api/dienstreise/project_file?' + q);
        });
      });
      return chain;
    }
    return fetchLocal().then(function (resolvedJobId) {
      if (!resolvedJobId) {
        if (opts.allowDispo === true && !preferLocalProjekteNeuOnly()) {
          return fetchDispoProjekteNeuFileBlob(fab, relPath, opts, technicianId);
        }
        return Promise.reject(
          new Error('Kein lokaler Auftrag für diese FN – Dateien erst nach „Auftrag annehmen“ (Dienstreise-Pull) offline nutzbar.'),
        );
      }
      return tryLocalProjekteNeuFile(resolvedJobId)
        .catch(function (err) {
          if (!err || !err.localUnavailable) throw err;
          if (
            !preferLocalProjekteNeuOnly() &&
            (getDispoBaseUrl() || '').trim() &&
            getTechId() &&
            getServerUsername()
          ) {
            return fetchDispoProjekteNeuFileBlob(effectiveFab, relPath, opts, technicianId);
          }
          if (opts.thumb) throw err;
          return tryLocalProjectFile(resolvedJobId);
        })
        .catch(function (err) {
          if (opts.allowDispo === true && !preferLocalProjekteNeuOnly()) {
            return fetchDispoProjekteNeuFileBlob(effectiveFab, relPath, opts, technicianId);
          }
          throw err;
        });
    });
  }

  function fetchDispoProjekteNeuFileBlob(fab, relPath, opts, technicianId) {
    if (preferLocalProjekteNeuOnly()) {
      return Promise.reject(new Error('Datei nicht lokal verfügbar (offline).'));
    }
    return fetch(API_BASE + '/api/anlagenstamm_file_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify({
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        source: 'projekte_neu',
        path: relPath,
        job_id: resolveProjekteNeuJobId(opts),
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword(),
        thumb: !!opts.thumb,
        thumbMax: opts.thumbMax || 256,
        inline: !!opts.inline
      })
    }).then(function (resp) {
      return handleProjekteNeuFileResponse(resp, opts);
    });
  }

  function bindProjekteNeuLightboxOnce() {
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb || lb.getAttribute('data-bound') === '1') return;
    lb.setAttribute('data-bound', '1');
    var bd = lb.querySelector('.projekte-neu-lightbox-backdrop');
    var cl = lb.querySelector('.projekte-neu-lightbox-close');
    if (bd) bd.addEventListener('click', closeProjekteNeuImageLightbox);
    if (cl) cl.addEventListener('click', closeProjekteNeuImageLightbox);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && lb.style.display === 'flex') closeProjekteNeuImageLightbox();
    });
  }

  function projekteNeuRevokeLightboxBlobUrl() {
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb) return;
    var prev = lb.getAttribute('data-blob-url') || '';
    if (prev) {
      try { URL.revokeObjectURL(prev); } catch (_) {}
      lb.removeAttribute('data-blob-url');
    }
    var im = lb.querySelector('.projekte-neu-lightbox-img');
    if (im) im.removeAttribute('src');
  }

  function setProjekteNeuLightboxLoading(isLoading, label) {
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb) return;
    var loader = lb.querySelector('.projekte-neu-lightbox-loader');
    var im = lb.querySelector('.projekte-neu-lightbox-img');
    if (loader) {
      loader.hidden = !isLoading;
      loader.style.display = isLoading ? 'block' : 'none';
      var lbl = loader.querySelector('.projekte-neu-lightbox-loader-label');
      if (lbl && label) lbl.textContent = label;
    }
    if (im) {
      im.style.visibility = isLoading ? 'hidden' : 'visible';
      im.style.opacity = isLoading ? '0' : '1';
    }
  }

  function showProjekteNeuImageLightboxShell() {
    bindProjekteNeuLightboxOnce();
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb) return;
    lb.hidden = false;
    lb.style.display = 'flex';
  }

  function closeProjekteNeuImageLightbox() {
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb) return;
    lb.hidden = true;
    lb.style.display = 'none';
    setProjekteNeuLightboxLoading(false);
    var im = lb.querySelector('.projekte-neu-lightbox-img');
    if (im) {
      im.onload = null;
      im.onerror = null;
    }
    projekteNeuRevokeLightboxBlobUrl();
  }

  function openProjekteNeuImageLightbox(blobUrl, altText) {
    showProjekteNeuImageLightboxShell();
    setProjekteNeuLightboxLoading(true, 'Bild wird geladen…');
    projekteNeuRevokeLightboxBlobUrl();
    var lb = document.getElementById('projekteNeuImageLightbox');
    if (!lb) return;
    var im = lb.querySelector('.projekte-neu-lightbox-img');
    if (!im) return;
    if (altText) im.alt = String(altText);
    im.onload = function () {
      setProjekteNeuLightboxLoading(false);
    };
    im.onerror = function () {
      setProjekteNeuLightboxLoading(false);
      showToast('Bild konnte nicht angezeigt werden.');
    };
    im.src = blobUrl;
    lb.setAttribute('data-blob-url', blobUrl);
    if (im.complete && im.naturalWidth > 0) {
      setProjekteNeuLightboxLoading(false);
    }
  }

  function openProjekteNeuImageInLightbox(fab, rel, opts) {
    opts = opts || {};
    showProjekteNeuImageLightboxShell();
    setProjekteNeuLightboxLoading(true, 'Bild wird geladen…');
    var lb = document.getElementById('projekteNeuImageLightbox');
    var im = lb ? lb.querySelector('.projekte-neu-lightbox-img') : null;
    if (im) {
      im.removeAttribute('src');
      if (opts.alt) im.alt = String(opts.alt);
    }
    fetchProjekteNeuFileBlob(fab, rel, { inline: true, jobId: resolveProjekteNeuJobId(opts) })
      .then(function (blob) {
        openProjekteNeuImageLightbox(URL.createObjectURL(blob), opts.alt);
      })
      .catch(function (err) {
        closeProjekteNeuImageLightbox();
        if (typeof opts.onError === 'function') opts.onError(err);
        else showToast('Bild konnte nicht geladen werden.');
      });
  }

  function fetchDienstreiseProjectFileBlob(jobId, relativePath, opts) {
    opts = opts || {};
    var q =
      'job_id=' +
      encodeURIComponent(jobId) +
      '&path=' +
      encodeURIComponent(relativePath);
    if (opts.thumb) q += '&thumb=1&thumbMax=' + encodeURIComponent(String(opts.thumbMax || 256));
    if (opts.inline) q += '&inline=1';
    return fetch(API_BASE + '/api/dienstreise/project_file?' + q, {
      headers: { 'X-Technician-Id': String(getTechId() || '') },
    }).then(function (resp) {
      return handleProjekteNeuFileResponse(resp, opts);
    });
  }

  function loadDienstreiseExplorerThumbnailImg(img, jobId, relativePath) {
    if (!img || !jobId || !relativePath) return;
    var fetchOpts = { thumb: true, thumbMax: 256 };
    function setThumbBlob(blob) {
      if (!img.parentNode) return;
      var prev = img.getAttribute('data-blob-url');
      if (prev) {
        try { URL.revokeObjectURL(prev); } catch (_) {}
      }
      var url = URL.createObjectURL(blob);
      img.setAttribute('data-blob-url', url);
      img.src = url;
    }
    function showFileIcon() {
      if (!img.parentNode) return;
      var nameCell = img.closest('.dienstreise-explorer-name');
      if (!nameCell) return;
      var ic = document.createElement('span');
      ic.className = 'icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = '\uD83D\uDCC4';
      nameCell.replaceChild(ic, img);
    }
    fetchDienstreiseProjectFileBlob(jobId, relativePath, fetchOpts)
      .then(setThumbBlob)
      .catch(showFileIcon);
  }

  function openDienstreiseProjectImageInLightbox(jobId, relativePath, opts) {
    opts = opts || {};
    showProjekteNeuImageLightboxShell();
    setProjekteNeuLightboxLoading(true, 'Bild wird geladen…');
    var lb = document.getElementById('projekteNeuImageLightbox');
    var im = lb ? lb.querySelector('.projekte-neu-lightbox-img') : null;
    if (im) {
      im.removeAttribute('src');
      if (opts.alt) im.alt = String(opts.alt);
    }
    fetchDienstreiseProjectFileBlob(jobId, relativePath, { inline: true })
      .then(function (blob) {
        openProjekteNeuImageLightbox(URL.createObjectURL(blob), opts.alt);
      })
      .catch(function (err) {
        closeProjekteNeuImageLightbox();
        if (typeof opts.onError === 'function') opts.onError(err);
        else showToast('Bild konnte nicht geladen werden.');
      });
  }

  function buildAnlageDetailProjekteNeuTree(fab, nodes, depth, msgEl) {
    depth = depth || 0;
    function notifyErr(err, optsNotify) {
      optsNotify = optsNotify || {};
      var msg = (err && err.message) ? err.message : String(err);
      if (optsNotify.thumbOnly) {
        try { console.warn('[PROJEKTE NEU]', msg); } catch (_) {}
        return;
      }
      var msgNode = msgEl || document.getElementById('anlageDetailProjekteNeuMessage');
      if (msgNode) msgNode.textContent = 'Fehler: ' + msg;
    }
    var wrap = document.createElement('ul');
    wrap.style.margin = depth === 0 ? '0.35rem 0 0.2rem 0' : '0.2rem 0 0.2rem 1rem';
    wrap.style.paddingLeft = depth === 0 ? '0.3rem' : '0.85rem';
    (nodes || []).forEach(function (n) {
      if (!n || !n.type) return;
      var li = document.createElement('li');
      li.style.margin = '0.15rem 0';
      if (n.type === 'dir') {
        var details = document.createElement('details');
        var summary = document.createElement('summary');
        summary.style.cursor = 'pointer';
        summary.textContent = String(n.name || 'Ordner');
        details.appendChild(summary);
        if (Array.isArray(n.children) && n.children.length) {
          details.appendChild(buildAnlageDetailProjekteNeuTree(fab, n.children, depth + 1, msgEl));
        } else {
          var em = document.createElement('div');
          em.className = 'muted';
          em.textContent = 'Keine Untereinträge.';
          em.style.margin = '0.25rem 0 0.2rem 0.8rem';
          details.appendChild(em);
        }
        li.appendChild(details);
      } else if (n.type === 'file') {
        var rel = String(n.rel || '').trim();
        var label = String(n.name || rel || 'Datei');
        var fileRow = document.createElement('div');
        fileRow.className = 'projekte-neu-file-row';
        if (isProjekteNeuRasterImage(label)) {
          var timg = document.createElement('img');
          timg.className = 'projekte-neu-thumb';
          timg.alt = label;
          timg.loading = 'lazy';
          fileRow.appendChild(timg);
          loadProjekteNeuThumbnailImg(timg, fab, rel, { jobId: jobDetailsJobId, thumbMax: 256 });
          timg.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            openProjekteNeuImageInLightbox(fab, rel, {
              jobId: jobDetailsJobId,
              alt: label,
              onError: function (err) { notifyErr(err, { thumbOnly: false }); },
            });
          });
        } else {
          var ic0 = document.createElement('span');
          ic0.className = 'projekte-neu-file-icon';
          ic0.setAttribute('aria-hidden', 'true');
          ic0.textContent = '\uD83D\uDCC4';
          fileRow.appendChild(ic0);
        }
        var actions = document.createElement('div');
        actions.className = 'projekte-neu-file-actions';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost';
        btn.style.padding = '0.15rem 0.25rem';
        btn.style.textAlign = 'left';
        btn.textContent = label;
        btn.addEventListener('click', function () {
          openAnlagenstammProjekteNeuLocal(fab, rel, String(n.name || ''), { jobId: jobDetailsJobId }).catch(function (err) {
            notifyErr(err);
            var hint = (err && err.message) ? err.message : 'Dokument konnte nicht geöffnet werden.';
            showToast(hint.indexOf('offline') >= 0 || hint.indexOf('lokal') >= 0 ? hint : 'Dokument konnte nicht geöffnet werden.');
          });
        });
        actions.appendChild(btn);
        fileRow.appendChild(actions);
        li.appendChild(fileRow);
        if (n.size != null || n.mtime != null) {
          var meta = document.createElement('span');
          meta.className = 'muted';
          meta.textContent = ' ' + formatAnlagenstammSize(n.size || 0) + (n.mtime ? (' · ' + formatAnlagenstammMtime(n.mtime)) : '');
          li.appendChild(meta);
        }
      }
      wrap.appendChild(li);
    });
    return wrap;
  }

  /** Wie Projektdaten: Vorschaubilder + Lightbox; optional gleicher Parent-Heading wie früher im reinen UL-Renderer. */
  function appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, fab, nodes, msgEl) {
    if (!pnTreeEl || !nodes || !nodes.length) return;
    bindProjekteNeuLightboxOnce();
    var treeRoot = buildAnlageDetailProjekteNeuTree(fab, nodes, 0, msgEl);
    var htxt = pnParentHeadingForSiblings(nodes);
    if (htxt) {
      var block = document.createElement('div');
      block.className = 'anlagenstamm-pn-tree-block';
      var det = document.createElement('details');
      det.className = 'anlagenstamm-pn-details';
      var sum = document.createElement('summary');
      sum.className = 'anlagenstamm-pn-parent-heading';
      sum.textContent = htxt;
      det.appendChild(sum);
      det.appendChild(treeRoot);
      block.appendChild(det);
      pnTreeEl.appendChild(block);
    } else {
      pnTreeEl.appendChild(treeRoot);
    }
  }

  function fetchJsonLocal(path, hdrs, timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, timeoutMs);
    var fetchOpts = Object.assign({}, hdrs || {});
    if (ctrl) fetchOpts.signal = ctrl.signal;
    return fetch(path, fetchOpts)
      .then(function (r) {
        return r.json().catch(function () { return {}; });
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  if (!loadProjekteNeuTreeIntoHost._tokensByHost) {
    loadProjekteNeuTreeIntoHost._tokensByHost = new WeakMap();
  }
  function bumpProjekteNeuHostToken(treeHost) {
    var prev = loadProjekteNeuTreeIntoHost._tokensByHost.get(treeHost) || 0;
    var next = prev + 1;
    loadProjekteNeuTreeIntoHost._tokensByHost.set(treeHost, next);
    return next;
  }
  function isProjekteNeuHostTokenCurrent(treeHost, loadToken) {
    return loadProjekteNeuTreeIntoHost._tokensByHost.get(treeHost) === loadToken;
  }

  async function loadProjekteNeuTreeIntoHost(fab, opts) {
    opts = opts || {};
    var msg = opts.msgEl || null;
    var treeHost = opts.treeHost || null;
    var toggleEl = opts.toggleEl != null ? opts.toggleEl : null;
    var allowOnline = opts.allowOnline !== false;
    var technicianId = getTechId();
    if (!treeHost) return;
    var loadToken = bumpProjekteNeuHostToken(treeHost);
    if (!fab) {
      if (msg) msg.textContent = 'Keine Fabrikationsnummer vorhanden.';
      treeHost.innerHTML = '';
      return;
    }
    if (msg) msg.textContent = 'Lade Struktur…';
    if (!opts.keepTreeWhileLoading) treeHost.innerHTML = '';
    function renderTree(tree, statusText) {
      treeHost.innerHTML = '';
      if (tree && tree.length) {
        treeHost.appendChild(buildAnlageDetailProjekteNeuTree(fab, tree, 0, msg));
        if (msg) msg.textContent = statusText || 'Lokale Projektdateien (nach Auftragsübernahme).';
      } else if (msg) {
        msg.textContent = statusText || 'Keine Dokumente im PROJEKTE-NEU-Baum gefunden.';
      }
      if (toggleEl) toggleEl.setAttribute('data-loaded', '1');
    }
    try {
      var jobId = resolveProjekteNeuJobId(opts);
      var hdrs = { headers: { 'X-Technician-Id': String(technicianId || '') } };
      var resolved = jobId
        ? { found: true, job_id: jobId }
        : await fetchJsonLocal(
            API_BASE + '/api/anlagenstamm/projekte_neu_resolve_local?fab=' + encodeURIComponent(fab),
            hdrs,
            12000,
          );
      if (!isProjekteNeuHostTokenCurrent(treeHost, loadToken)) return;
      if (resolved && resolved.found && resolved.job_id) jobId = resolved.job_id;
      var cached = await fetchJsonLocal(
        API_BASE + '/api/anlagenstamm_tree_cached?fab=' + encodeURIComponent(fab),
        hdrs,
        12000,
      );
      if (!isProjekteNeuHostTokenCurrent(treeHost, loadToken)) return;
      var cachedTreeEarly = (cached && cached.found && Array.isArray(cached.tree)) ? cached.tree : [];
      if (cachedTreeEarly.length) {
        renderTree(cachedTreeEarly);
        return;
      }
      if (jobId) {
        var localTree = await fetchJsonLocal(
          API_BASE +
            '/api/dienstreise/projekte_neu_tree?job_id=' +
            encodeURIComponent(jobId) +
            '&fab=' +
            encodeURIComponent(fab) +
            '&rescan=0',
          hdrs,
          60000,
        );
        if (!isProjekteNeuHostTokenCurrent(treeHost, loadToken)) return;
        if (localTree && localTree.ok && localTree.enabled && Array.isArray(localTree.tree) && localTree.tree.length) {
          return renderTree(localTree.tree);
        }
      }
      if (!allowOnline || (!getDispoExternalUrl() && !getDispoInternalUrl())) {
        if (msg) {
          msg.textContent = 'Keine lokalen PROJEKTE-NEU-Daten für diese FN. Bitte Auftrag annehmen (Dienstreise-Pull kopiert Dokumente_Monteur) – der Anlagenstamm-DB-Sync enthält nur Stammdaten, keine Ordnerliste.';
        }
        return;
      }
      var payload = {
        baseUrl: getDispoBaseUrl(),
        fab: fab,
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword()
      };
      var files = await api('/api/anlagenstamm_files_list', { method: 'POST', body: JSON.stringify(payload) });
      var pnRaw = files && files.projekte_neu ? files.projekte_neu : {};
      if (!pnRaw || !pnRaw.enabled) {
        if (msg) msg.textContent = 'PROJEKTE NEU ist für diese Anlage nicht verfügbar (weder lokal noch am Server).';
        return;
      }
      var tree = Array.isArray(pnRaw.tree) ? pnRaw.tree : [];
      if (!tree.length) {
        if (msg) msg.textContent = 'Keine Dokumente im PROJEKTE-NEU-Baum gefunden.';
        return;
      }
      renderTree(tree, 'Noch keine lokale Kopie – Struktur vom Server (nach „Auftrag annehmen“ offline nutzbar).');
    } catch (e) {
      if (!isProjekteNeuHostTokenCurrent(treeHost, loadToken)) return;
      var errText = (e && e.message) ? e.message : String(e);
      if (msg) {
        msg.textContent =
          errText.indexOf('abort') >= 0 || errText === 'The user aborted a request.'
            ? 'Lokale Abfrage Zeitüberschreitung – Server beschäftigt? Bitte kurz warten und FN-Zeile erneut anklicken.'
            : 'Fehler: ' + errText;
      }
    } finally {
      if (isProjekteNeuHostTokenCurrent(treeHost, loadToken) && msg && msg.textContent === 'Lade Struktur…') {
        msg.textContent = 'Keine lokalen PROJEKTE-NEU-Daten für diese FN.';
      }
    }
  }

  async function loadAnlageDetailProjekteNeuTree(fab, toggleEl) {
    await loadProjekteNeuTreeIntoHost(fab, {
      msgEl: document.getElementById('anlageDetailProjekteNeuMessage'),
      treeHost: document.getElementById('anlageDetailProjekteNeuTree'),
      toggleEl: toggleEl,
      jobId: jobDetailsJobId,
      allowOnline: false
    });
  }

  function showView(name) {
    const viewStart = document.getElementById('viewStart');
    const viewEinstellungen = document.getElementById('viewEinstellungen');
    const viewProjektdaten = document.getElementById('viewProjektdaten');
    const viewDienstreise = document.getElementById('viewDienstreise');
    const viewAbrechnung = document.getElementById('viewAbrechnung');
    const viewArchiv = document.getElementById('viewArchiv');
    const viewAbwesenheiten = document.getElementById('viewAbwesenheiten');
    const viewAnlagenstamm = document.getElementById('viewAnlagenstamm');
    const protokolleViewIds = ['viewProtokolleMontagebericht', 'viewProtokolleParameterlisten', 'viewProtokolleKontrollwiegungen', 'viewProtokolleInbetriebnahme', 'viewProtokolleService'];
    viewStart.classList.remove('only-left', 'only-right', 'hidden');
    viewEinstellungen.classList.remove('active');
    if (viewProjektdaten) viewProjektdaten.classList.remove('active');
    if (viewDienstreise) viewDienstreise.classList.remove('active');
    if (viewAbrechnung) viewAbrechnung.classList.remove('active');
    protokolleViewIds.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    const viewTextbausteine = document.getElementById('viewTextbausteine');
    if (viewTextbausteine) viewTextbausteine.classList.remove('active');
    if (viewArchiv) viewArchiv.classList.remove('active');
    if (viewAbwesenheiten) viewAbwesenheiten.classList.remove('active');
    if (viewAnlagenstamm) viewAnlagenstamm.classList.remove('active');
    if (name === 'einstellungen') {
      viewStart.classList.add('hidden');
      viewEinstellungen.classList.add('active');
      updateTechnicianName();
      if (getServerUsername() && getServerPassword()) resolveMonteurProfileFromDispo();
      return;
    }
    if (name === 'dienstreise') {
      viewStart.classList.add('hidden');
      viewDienstreise.classList.add('active');
      loadDienstreiseList();
      return;
    }
    if (name === 'abrechnung') {
      viewStart.classList.add('hidden');
      if (viewAbrechnung) viewAbrechnung.classList.add('active');
      var perEl = document.getElementById('abrechnungPeriod');
      if (perEl && !perEl.value) {
        perEl.value = new Date().toISOString().slice(0, 7);
      }
      refreshAbrechnungNativeUi(false);
      return;
    }
    if (name && name.startsWith('protokolle-')) {
      viewStart.classList.add('hidden');
      const map = {
        'protokolle-montagebericht': 'viewProtokolleMontagebericht',
        'protokolle-parameterlisten': 'viewProtokolleParameterlisten',
        'protokolle-kontrollwiegungen': 'viewProtokolleKontrollwiegungen',
        'protokolle-inbetriebnahme': 'viewProtokolleInbetriebnahme',
        'protokolle-service': 'viewProtokolleService'
      };
      const viewId = map[name];
      if (viewId) {
        const el = document.getElementById(viewId);
        if (el) el.classList.add('active');
      }
      if (name === 'protokolle-montagebericht' && typeof window.openAndResetMontageberichtForm === 'function') {
        window.openAndResetMontageberichtForm();
      }
      if (name === 'protokolle-kontrollwiegungen' && typeof window.openProtokolleKontrollwiegungen === 'function') {
        window.openProtokolleKontrollwiegungen();
      }
      return;
    }
    if (name === 'textbausteine') {
      viewStart.classList.add('hidden');
      if (viewTextbausteine) {
        viewTextbausteine.classList.add('active');
        if (typeof loadTbCategories === 'function') loadTbCategories();
      }
      return;
    }
    if (name === 'archiv') {
      viewStart.classList.add('hidden');
      viewArchiv.classList.add('active');
      initArchivYearSelect();
      loadArchiv();
      return;
    }
    if (name === 'abwesenheiten') {
      viewStart.classList.add('hidden');
      if (viewAbwesenheiten) viewAbwesenheiten.classList.add('active');
      loadJobsAndAbsences();
      return;
    }
    if (name === 'anlagenstamm') {
      viewStart.classList.add('hidden');
      if (viewAnlagenstamm) viewAnlagenstamm.classList.add('active');
      return;
    }
    if (name === 'start') {
      var nowStart = Date.now();
      if (nowStart - startViewDataLoadedAt >= START_VIEW_DATA_MS) {
        startViewDataLoadedAt = nowStart;
        loadStartActiveJob();
        loadCalendarMonth();
      }
    }
  }

  /** Kalender: gleiche Abwesenheit nicht doppelt (Server-Absence vs. lokale Anfrage / andere IDs). */
  function absenceCalendarDedupeKey(a, technicianIdOverride) {
    var tid = technicianIdOverride != null ? technicianIdOverride : (a.technician_id != null ? a.technician_id : a.technicianId);
    function normDt(v) {
      if (v == null) return '';
      var s = String(v).replace('T', ' ').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
      return s;
    }
    return String(tid || '') + '\t' + normDt(a.start_datetime) + '\t' + normDt(a.end_datetime);
  }

  /** Abrechnungs-Flags aus Kalender-API/Cache (montage_verrechnet, billing_travel_complete). */
  function calendarBillingFlagsFrom(src) {
    if (!src) return {};
    var out = {};
    if (src.montage_verrechnet != null && src.montage_verrechnet !== '') {
      out.montage_verrechnet = Number(src.montage_verrechnet) === 1 ? 1 : 0;
    }
    if (src.billing_travel_complete != null && src.billing_travel_complete !== '') {
      out.billing_travel_complete = Number(src.billing_travel_complete) === 1 ? 1 : 0;
    }
    return out;
  }

  var CALENDAR_UNASSIGNED_COLOR_DEFAULT = '#94a3b8';

  function isCalendarJobUnassigned(job) {
    if (!job || typeof job !== 'object') return false;
    var tid = job.technician_id != null ? job.technician_id : job.technicianId;
    if (tid === 0 || tid === '0') return true;
    if (String(job.technician_name || '').trim() === 'Nicht zugewiesen') return true;
    return jobHasNoTechnicianForOpenFilter(job);
  }

  function calendarUnassignedLane(techById, job) {
    var u = techById && (techById[0] || techById['0']);
    var fromJobColor = job && job.technician_color ? String(job.technician_color).trim() : '';
    return {
      technician_id: 0,
      technician_name: (job && job.technician_name) || (u && u.name) || 'Nicht zugewiesen',
      technician_color: fromJobColor || (u && u.color) || CALENDAR_UNASSIGNED_COLOR_DEFAULT
    };
  }

  function calendarJobTechFields(job, techById, viewerTechId) {
    if (isCalendarJobUnassigned(job)) {
      return calendarUnassignedLane(techById, job);
    }
    var tid = job.technician_id != null ? job.technician_id : job.technicianId;
    if (tid == null || tid === '') {
      tid = viewerTechId != null ? viewerTechId : tid;
    }
    var info = tid != null ? (techById[tid] || techById[Number(tid)]) : null;
    return {
      technician_id: tid,
      technician_name: info ? info.name : (job.technician_name || (tid != null ? 'Techniker ' + tid : 'Unbekannt')),
      technician_color: info ? info.color : (job.technician_color || '#4a90e2')
    };
  }

  function buildTechByIdFromCalendarTechnicians(techList) {
    var techById = {};
    (techList || []).forEach(function (t) {
      var id = t.id != null ? t.id : t.technician_id;
      if (id == null) return;
      var dispColor = (t.color || t.farbe || '').toString().trim();
      var n = Number(id);
      var entry = {
        name: (t.full_name || t.name || t.technician_name || '').trim() || (n === 0 ? 'Nicht zugewiesen' : 'Techniker ' + id),
        color: dispColor || (n === 0 ? CALENDAR_UNASSIGNED_COLOR_DEFAULT : '#4a90e2')
      };
      techById[id] = entry;
      if (!Number.isNaN(n)) techById[n] = entry;
    });
    return techById;
  }

  /** Billing-Flags aus Kalender-Jobs (Cache/API) in lokale Job-Liste übernehmen. */
  function mergeCalendarBillingIntoJobs(jobs, billingSources, techId) {
    if (!Array.isArray(jobs) || !Array.isArray(billingSources) || !billingSources.length) return jobs;
    var billingByKey = {};
    billingSources.forEach(function (cj) {
      var sid = cj.id != null ? String(cj.id) : (cj.server_job_id != null ? String(cj.server_job_id) : '');
      var tid = cj.technician_id != null ? String(cj.technician_id) : '';
      if (!sid) return;
      if (tid) billingByKey[sid + ':' + tid] = cj;
      billingByKey[sid] = cj;
    });
    return jobs.map(function (j) {
      var sid = j.server_id != null ? String(j.server_id) : (j.id != null ? String(j.id) : '');
      if (!sid) return j;
      var tid = techId != null ? String(techId) : (j.technician_id != null ? String(j.technician_id) : '');
      var cj = (tid && billingByKey[sid + ':' + tid]) || billingByKey[sid];
      if (!cj) return j;
      return Object.assign({}, j, calendarBillingFlagsFrom(cj));
    });
  }

  async function fetchCalendarCachedMonth(start, end, techId) {
    return fetch(API_BASE + '/api/calendar_cached?' + qs({ start: start, end: end }), {
      headers: { 'X-Technician-Id': String(techId || 0) }
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  /** Ohne „Alle Techniker“: keine Lane „Nicht zugewiesen“ / keine unzugewiesenen Aufträge. */
  function filterCalendarJobsForView(jobs, showAll) {
    if (showAll) return Array.isArray(jobs) ? jobs : [];
    return (Array.isArray(jobs) ? jobs : []).filter(function (j) { return !isCalendarJobUnassigned(j); });
  }

  function filterCalendarTechniciansForLegend(technicians, showAll) {
    if (showAll || !Array.isArray(technicians)) return technicians;
    return technicians.filter(function (t) {
      var id = t.id != null ? t.id : t.technician_id;
      return Number(id) !== 0;
    });
  }

  /** Lokaler Kalender (SQLite) für einen Monteur – funktioniert ohne Dispo-Verbindung. */
  async function loadCalendarLocalMonth(start, end, techId, includeUnassigned) {
    const params = { technician_id: techId, date_from: start, date_to: end, include_erledigt: 1 };
    if (!includeUnassigned) {
      params.assigned_only = '1';
    }
    const [jRes, aRes, techRes, cached] = await Promise.all([
      fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
      fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
      fetch(API_BASE + '/api/technician?technician_id=' + techId, { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()).catch(() => ({})),
      fetchCalendarCachedMonth(start, end, techId).catch(function () { return {}; })
    ]);
    var techColor = (techRes.color || techRes.farbe || '').toString().trim() || '#4a90e2';
    var techName = (techRes.full_name || techRes.name || '').toString().trim() || ('Techniker ' + techId);
    var techById = buildTechByIdFromCalendarTechnicians(cached && cached.ok ? cached.technicians : []);
    techById[techId] = { name: techName, color: techColor };
    const jobs = (jRes.jobs || []).map(function (j) {
      return Object.assign({}, j, calendarJobTechFields(j, techById, techId));
    });
    const absences = (aRes.absences || []).map(function (a) {
      return Object.assign({}, a, { technician_id: techId, technician_name: techName, technician_color: techColor });
    });
    return { jobs: jobs, absences: absences };
  }

  async function loadCalendarMonth() {
    const first = new Date(calCurrentMonth.getFullYear(), calCurrentMonth.getMonth(), 1, 12, 0, 0, 0);
    const gridStart = mondayOf(first);
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridEnd.getDate() + 41);
    const start = toYmd(gridStart);
    const end = toYmd(gridEnd);

    let jobs = [];
    let absences = [];
    let calendarApiData = null;
    const showAll = document.getElementById('calShowAllTech').checked;

    // Sofort leeres Grid rendern, damit Zeilen/Spalten immer sichtbar sind
    renderCalendarGrid(gridStart, gridEnd, [], [], null);

    if (showAll) {
      const myTechId = getTechId();
      if (!myTechId) {
        setCalendarError('Monteur-ID eingeben (oder Häkchen „Alle Techniker“ aus für nur eigene Termine).');
        return;
      }
      try {
        var data = await fetchCalendarCachedMonth(start, end, myTechId);
        if (!data || data.ok !== true) {
          throw new Error((data && data.error) || 'Kalender-Cache nicht lesbar.');
        }
        var hasCached = (data.jobs || []).length > 0 || (data.absences || []).length > 0;
        if (!hasCached) {
          setCalendarError('Kalender noch nicht synchronisiert — Badge klicken (Sync mit Dispo).');
          renderCalendarGrid(gridStart, gridEnd, [], [], null);
          return;
        }
        calendarApiData = data;
        jobs = data.jobs || [];
        var techList = (data.technicians && data.technicians.length) ? data.technicians : [];
        var techById = buildTechByIdFromCalendarTechnicians(techList);
        absences = (data.absences || []).map(function (a) {
          var tid = a.technician_id != null ? a.technician_id : a.technicianId;
          var info = tid != null ? techById[tid] : null;
          return Object.assign({}, a, {
            technician_id: tid,
            technician_name: info ? info.name : (a.technician_name || (tid ? 'Techniker ' + tid : 'Unbekannt')),
            technician_color: info ? info.color : (a.technician_color || '#6c757d')
          });
        });
        var localJobsByServerId = {};
        var localJobsById = {};
        var params = { technician_id: myTechId, date_from: start, date_to: end, include_erledigt: 1 };
        var local = await Promise.all([
          fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); }),
          fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); })
        ]);
        (local[0].jobs || []).forEach(function (j) {
          if (j.server_id != null) { localJobsByServerId[j.server_id] = j; localJobsByServerId[String(j.server_id)] = j; }
          if (j.id != null) { localJobsById[j.id] = j; localJobsById[String(j.id)] = j; }
        });
        jobs = jobs.map(function (j) {
          var localJob =
            localJobsByServerId[j.server_id] ||
            localJobsByServerId[j.id] ||
            localJobsByServerId[String(j.server_id)] ||
            localJobsByServerId[String(j.id)] ||
            localJobsById[j.id] ||
            localJobsById[String(j.id)];
          var techDisplay = calendarJobTechFields(j, techById, myTechId);
          if (localJob) {
            return Object.assign({}, localJob, calendarBillingFlagsFrom(j), techDisplay);
          }
          return Object.assign({}, j, techDisplay);
        });
        var serverJobIds = {};
        jobs.forEach(function (j) {
          serverJobIds[j.id] = true;
          if (j.server_id != null) serverJobIds[j.server_id] = true;
        });
        (local[0].jobs || []).forEach(function (j) {
          if (!serverJobIds[j.id] && !serverJobIds[j.server_id]) {
            jobs.push(Object.assign({}, j, calendarJobTechFields(j, techById, myTechId)));
          }
        });
        var seenJobKey = {};
        jobs = jobs.filter(function (j) {
          var key = j.server_id != null ? String(j.server_id) : (j.id != null ? String(j.id) : null);
          if (key == null) return true;
          if (seenJobKey[key]) return false;
          seenJobKey[key] = true;
          return true;
        });
        jobs = filterCalendarJobsForView(jobs, true);
        var serverAbsIds = {};
        var serverAbsPeriodKeys = {};
        absences.forEach(function (a) {
          serverAbsIds[a.id] = true;
          if (a.server_id != null && a.server_id !== '') serverAbsIds[a.server_id] = true;
          serverAbsPeriodKeys[absenceCalendarDedupeKey(a)] = true;
        });
        (local[1].absences || []).forEach(function (a) {
          var enriched = Object.assign({}, a, {
            technician_id: myTechId,
            technician_name: techById[myTechId] ? techById[myTechId].name : 'Techniker ' + myTechId,
            technician_color: techById[myTechId] ? techById[myTechId].color : '#6c757d'
          });
          var periodKey = absenceCalendarDedupeKey(enriched, myTechId);
          if (!serverAbsIds[a.id] && !serverAbsIds[a.server_id] && !serverAbsPeriodKeys[periodKey]) {
            serverAbsPeriodKeys[periodKey] = true;
            absences.push(enriched);
          }
        });
      } catch (e) {
        renderCalendarGrid(gridStart, gridEnd, [], [], null);
        setCalendarError('Kalender (Cache): ' + e.message);
        return;
      }
    } else {
      const techId = getTechId();
      if (!techId) {
        setCalendarError('Monteur-ID eingeben.');
        return;
      }
      try {
        var loc = await loadCalendarLocalMonth(start, end, techId, false);
        jobs = loc.jobs;
        absences = loc.absences;
        try {
          var cachedBilling = await fetchCalendarCachedMonth(start, end, techId);
          if (cachedBilling && cachedBilling.ok === true && Array.isArray(cachedBilling.jobs)) {
            jobs = mergeCalendarBillingIntoJobs(jobs, cachedBilling.jobs, techId);
            calendarApiData = cachedBilling;
          }
        } catch (_) { /* Billing aus Cache optional */ }
      } catch (e) {
        renderCalendarGrid(gridStart, gridEnd, [], [], null);
        setCalendarError('Fehler: ' + e.message);
        return;
      }
    }

    jobs = filterCalendarJobsForView(jobs, showAll);
    const techniciansFromApi = filterCalendarTechniciansForLegend(
      (calendarApiData && calendarApiData.technicians) ? calendarApiData.technicians : null,
      showAll
    );
    renderCalendarGrid(gridStart, gridEnd, jobs, absences, techniciansFromApi);

    // Performance: Eigener-Techniker-Modus rendert sofort aus lokaler DB.
    // Optionale zentrale Dispo-Farbe wird asynchron nachgeladen und bei Bedarf nachgerendert.
    if (!showAll) {
      const techId = getTechId();
      if (techId) {
        fetchCalendarCachedMonth(start, end, techId)
          .then(function (cached) {
            const tlist = Array.isArray(cached && cached.technicians) ? cached.technicians : [];
            const me = tlist.find(function (t) {
              const id = t && (t.id != null ? t.id : t.technician_id);
              return Number(id) === Number(techId);
            });
            const dispoColor = me && (me.color || me.farbe) ? String(me.color || me.farbe).trim() : '';
            var patchedJobs = jobs;
            if (cached && cached.ok === true && Array.isArray(cached.jobs)) {
              patchedJobs = mergeCalendarBillingIntoJobs(jobs, cached.jobs, techId);
            }
            if (dispoColor) {
              patchedJobs = patchedJobs.map(function (j) {
                if (isCalendarJobUnassigned(j)) return j;
                return Object.assign({}, j, { technician_color: dispoColor });
              });
            }
            var patchedAbsences = dispoColor
              ? absences.map(function (a) { return Object.assign({}, a, { technician_color: dispoColor }); })
              : absences;
            if (dispoColor || (cached && cached.ok === true && Array.isArray(cached.jobs))) {
              renderCalendarGrid(
                gridStart,
                gridEnd,
                filterCalendarJobsForView(patchedJobs, false),
                patchedAbsences,
                filterCalendarTechniciansForLegend(techniciansFromApi, false)
              );
            }
          })
          .catch(function () { /* optional */ });
      }
    }
  }

  function startYmd(item) { return (item.start_datetime || '').toString().slice(0, 10); }
  function endYmd(item) { return (item.end_datetime || '').toString().slice(0, 10); }
  function isMultiDay(item) { const s = startYmd(item), e = endYmd(item); return s && e && s !== e; }

  // Mehrtägige Balken: nur an der Wochengrenze (So/Mo) teilen, sonst durchgängig pro Woche.
  function getWeekSpan(item, weekStartYmd, weekEndYmd) {
    const s = startYmd(item), e = endYmd(item);
    if (!s || !e || e < weekStartYmd || s > weekEndYmd) return null;
    const startInWeek = s < weekStartYmd ? weekStartYmd : s;
    const endInWeek = e > weekEndYmd ? weekEndYmd : e;
    const weekStart = new Date(weekStartYmd + 'T12:00:00');
    const startDate = new Date(startInWeek + 'T12:00:00');
    const endDate = new Date(endInWeek + 'T12:00:00');
    const startCol = Math.round((startDate - weekStart) / 86400000);
    const endCol = Math.round((endDate - weekStart) / 86400000);
    return { startCol, span: endCol - startCol + 1 };
  }

  // Referenz: startCol, dann Span absteigend. Kein Balken überdeckt anderen; erstes freies Lane. Abwesenheit über Auftrag durch zwei Ebenen (Jobs zuerst, dann Abwesenheiten ins Overlay).
  function assignLanes(spans) {
    const lanes = [];
    spans.sort((a, b) => {
      if (a.startCol !== b.startCol) return a.startCol - b.startCol;
      return (b.span - a.span) || 0;
    });
    for (const s of spans) {
      const end = s.startCol + s.span;
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        const conflict = lanes[i].some((t) => !(end <= t.startCol || t.startCol + t.span <= s.startCol));
        if (!conflict) { lanes[i].push(s); s.lane = i; placed = true; break; }
      }
      if (!placed) { lanes.push([s]); s.lane = lanes.length - 1; }
    }
    return lanes;
  }

  /** Nur Datum anzeigen (ohne Uhrzeit), einheitlich überall. */
  function formatDateOnly(s) {
    if (!s || !String(s).trim()) return '';
    const str = String(s).trim().slice(0, 10);
    const d = new Date(str + 'T12:00:00');
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  /** Datumsbereich: ein Tag = nur ein Datum, sonst „von – bis“. Immer ohne Uhrzeit. */
  function formatDateRange(start, end) {
    const s = (start && String(start).trim()) ? String(start).trim().slice(0, 10) : '';
    const e = (end && String(end).trim()) ? String(end).trim().slice(0, 10) : '';
    if (!s) return formatDateOnly(e) || '';
    if (!e || s === e) return formatDateOnly(s);
    return formatDateOnly(s) + ' – ' + formatDateOnly(e);
  }
  /** @deprecated Nutze formatDateOnly/formatDateRange. Datum ohne Uhrzeit für Tooltip. */
  function formatJobTime(s) {
    return formatDateOnly(s);
  }

  /** UTC-Offset einer Zeitzone in Stunden. Immer mit aktuellem Datum (new Date()), damit Sommer-/Winterzeit stimmt. */
  function getTimezoneOffsetHours(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date());
      const p = parts.find(function (x) { return x.type === 'timeZoneName'; });
      if (!p || !p.value) return null;
      var val = p.value.replace(/\s/g, '');
      var m = val.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
      if (!m) m = val.match(/GMT([+-])(\d{1,2})/);
      if (!m) return null;
      var h = parseInt(m[2], 10) + (m[3] ? parseInt(m[3], 10) / 60 : 0);
      if (m[1] === '-') h = -h;
      return h;
    } catch (_) { return null; }
  }

  /** Alle Länder (2- und 3-Buchstaben ISO) → IANA-Zeitzone (UN + weitere). */
  var countryToTz = {
    AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul', AG: 'America/Antigua', AI: 'America/Anguilla',
    AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AO: 'Africa/Luanda', AQ: 'Antarctica/McMurdo',
    AR: 'America/Argentina/Buenos_Aires', AS: 'Pacific/Pago_Pago', AT: 'Europe/Vienna',
    AU: 'Australia/Sydney', AW: 'America/Aruba', AX: 'Europe/Mariehamn', AZ: 'Asia/Baku',
    BA: 'Europe/Sarajevo', BB: 'America/Barbados', BD: 'Asia/Dhaka', BE: 'Europe/Brussels',
    BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia', BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura',
    BJ: 'Africa/Porto-Novo', BL: 'America/St_Barthelemy', BM: 'Atlantic/Bermuda', BN: 'Asia/Brunei',
    BO: 'America/La_Paz', BQ: 'America/Kralendijk', BR: 'America/Sao_Paulo', BS: 'America/Nassau',
    BT: 'Asia/Thimphu', BV: 'Europe/Oslo', BW: 'Africa/Gaborone', BY: 'Europe/Minsk',
    BZ: 'America/Belize', CA: 'America/Toronto', CC: 'Indian/Cocos', CD: 'Africa/Kinshasa',
    CF: 'Africa/Bangui', CG: 'Africa/Brazzaville', CH: 'Europe/Zurich', CI: 'Africa/Abidjan',
    CK: 'Pacific/Rarotonga', CL: 'America/Santiago', CM: 'Africa/Douala', CN: 'Asia/Shanghai',
    CO: 'America/Bogota', CR: 'America/Costa_Rica', CU: 'America/Havana', CV: 'Atlantic/Cape_Verde',
    CW: 'America/Curacao', CX: 'Indian/Christmas', CY: 'Asia/Nicosia', CZ: 'Europe/Prague',
    DE: 'Europe/Berlin', DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen', DM: 'America/Dominica',
    DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers', EC: 'America/Guayaquil', EE: 'Europe/Tallinn',
    EG: 'Africa/Cairo', EH: 'Africa/El_Aaiun', ER: 'Africa/Asmara', ES: 'Europe/Madrid',
    ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FK: 'Atlantic/Stanley',
    FM: 'Pacific/Pohnpei', FO: 'Atlantic/Faroe', FR: 'Europe/Paris', GA: 'Africa/Libreville',
    GB: 'Europe/London', GD: 'America/Grenada', GE: 'Asia/Tbilisi', GF: 'America/Cayenne',
    GG: 'Europe/Guernsey', GH: 'Africa/Accra', GI: 'Europe/Gibraltar', GL: 'America/Nuuk',
    GM: 'Africa/Banjul', GN: 'Africa/Conakry', GP: 'America/Guadeloupe', GQ: 'Africa/Malabo',
    GR: 'Europe/Athens', GS: 'Atlantic/South_Georgia', GT: 'America/Guatemala', GU: 'Pacific/Guam',
    GW: 'Africa/Bissau', GY: 'America/Guyana', HK: 'Asia/Hong_Kong', HN: 'America/Tegucigalpa',
    HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince', HU: 'Europe/Budapest', ID: 'Asia/Jakarta',
    IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man', IN: 'Asia/Kolkata',
    IO: 'Indian/Chagos', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik',
    IT: 'Europe/Rome', JE: 'Europe/Jersey', JM: 'America/Jamaica', JO: 'Asia/Amman',
    JP: 'Asia/Tokyo', KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh',
    KI: 'Pacific/Tarawa', KM: 'Indian/Comoro', KN: 'America/St_Kitts', KP: 'Asia/Pyongyang',
    KR: 'Asia/Seoul', KW: 'Asia/Kuwait', KY: 'America/Cayman', KZ: 'Asia/Almaty',
    LA: 'Asia/Vientiane', LB: 'Asia/Beirut', LC: 'America/St_Lucia', LI: 'Europe/Vaduz',
    LK: 'Asia/Colombo', LR: 'Africa/Monrovia', LS: 'Africa/Maseru', LT: 'Europe/Vilnius',
    LU: 'Europe/Luxembourg', LV: 'Europe/Riga', LY: 'Africa/Tripoli', MA: 'Africa/Casablanca',
    MC: 'Europe/Monaco', MD: 'Europe/Chisinau', ME: 'Europe/Podgorica', MF: 'America/Marigot',
    MG: 'Indian/Antananarivo', MH: 'Pacific/Majuro', MK: 'Europe/Skopje', ML: 'Africa/Bamako',
    MM: 'Asia/Yangon', MN: 'Asia/Ulaanbaatar', MO: 'Asia/Macau', MP: 'Pacific/Guam',
    MQ: 'America/Martinique', MR: 'Africa/Nouakchott', MS: 'America/Montserrat', MT: 'Europe/Malta',
    MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MX: 'America/Mexico_City',
    MY: 'Asia/Kuala_Lumpur', MZ: 'Africa/Maputo', NA: 'Africa/Windhoek', NC: 'Pacific/Noumea',
    NE: 'Africa/Niamey', NF: 'Pacific/Norfolk', NG: 'Africa/Lagos', NI: 'America/Managua',
    NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu', NR: 'Pacific/Nauru',
    NU: 'Pacific/Niue', NZ: 'Pacific/Auckland', OM: 'Asia/Muscat', PA: 'America/Panama',
    PE: 'America/Lima', PF: 'Pacific/Tahiti', PG: 'Pacific/Port_Moresby', PH: 'Asia/Manila',
    PK: 'Asia/Karachi', PL: 'Europe/Warsaw', PM: 'America/Miquelon', PN: 'Pacific/Pitcairn',
    PR: 'America/Puerto_Rico', PS: 'Asia/Gaza', PT: 'Europe/Lisbon', PW: 'Pacific/Palau',
    PY: 'America/Asuncion', QA: 'Asia/Qatar', RE: 'Indian/Reunion', RO: 'Europe/Bucharest',
    RS: 'Europe/Belgrade', RU: 'Europe/Moscow', RW: 'Africa/Kigali', SA: 'Asia/Riyadh',
    SB: 'Pacific/Guadalcanal', SC: 'Indian/Mahe', SD: 'Africa/Khartoum', SE: 'Europe/Stockholm',
    SG: 'Asia/Singapore', SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana', SJ: 'Arctic/Longyearbyen',
    SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino', SN: 'Africa/Dakar',
    SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SS: 'Africa/Juba', ST: 'Africa/Sao_Tome',
    SV: 'America/El_Salvador', SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
    TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena', TF: 'Indian/Kerguelen', TG: 'Africa/Lome',
    TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe', TK: 'Pacific/Fakaofo', TL: 'Asia/Dili',
    TM: 'Asia/Ashgabat', TN: 'Africa/Tunis', TO: 'Pacific/Tongatapu', TR: 'Europe/Istanbul',
    TT: 'America/Port_of_Spain', TV: 'Pacific/Funafuti', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam',
    UA: 'Europe/Kyiv', UG: 'Africa/Kampala', UM: 'Pacific/Midway', US: 'America/Chicago',
    UY: 'America/Montevideo', UZ: 'Asia/Tashkent', VA: 'Europe/Vatican', VC: 'America/St_Vincent',
    VE: 'America/Caracas', VG: 'America/Virgin', VI: 'America/Virgin', VN: 'Asia/Ho_Chi_Minh',
    VU: 'Pacific/Efate', WF: 'Pacific/Wallis', WS: 'Pacific/Apia', YE: 'Asia/Aden',
    YT: 'Indian/Mayotte', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare',
    FO: 'Atlantic/Faroe', HM: 'Indian/Kerguelen',
    AND: 'Europe/Andorra', ARE: 'Asia/Dubai', AFG: 'Asia/Kabul', ATG: 'America/Antigua', AIA: 'America/Anguilla',
    ALB: 'Europe/Tirane', ARM: 'Asia/Yerevan', AGO: 'Africa/Luanda', ATA: 'Antarctica/McMurdo',
    ARG: 'America/Argentina/Buenos_Aires', ASM: 'Pacific/Pago_Pago', AUT: 'Europe/Vienna',
    AUS: 'Australia/Sydney', ABW: 'America/Aruba', ALA: 'Europe/Mariehamn', AZE: 'Asia/Baku',
    BIH: 'Europe/Sarajevo', BRB: 'America/Barbados', BGD: 'Asia/Dhaka', BEL: 'Europe/Brussels',
    BFA: 'Africa/Ouagadougou', BGR: 'Europe/Sofia', BHR: 'Asia/Bahrain', BDI: 'Africa/Bujumbura',
    BEN: 'Africa/Porto-Novo', BLM: 'America/St_Barthelemy', BMU: 'Atlantic/Bermuda', BRN: 'Asia/Brunei',
    BOL: 'America/La_Paz', BES: 'America/Kralendijk', BRA: 'America/Sao_Paulo', BHS: 'America/Nassau',
    BTN: 'Asia/Thimphu', BVT: 'Europe/Oslo', BWA: 'Africa/Gaborone', BLR: 'Europe/Minsk',
    BLZ: 'America/Belize', CAN: 'America/Toronto', CCK: 'Indian/Cocos', COD: 'Africa/Kinshasa',
    CAF: 'Africa/Bangui', COG: 'Africa/Brazzaville', CHE: 'Europe/Zurich', CIV: 'Africa/Abidjan',
    COK: 'Pacific/Rarotonga', CHL: 'America/Santiago', CMR: 'Africa/Douala', CHN: 'Asia/Shanghai',
    COL: 'America/Bogota', CRI: 'America/Costa_Rica', CUB: 'America/Havana', CPV: 'Atlantic/Cape_Verde',
    CUW: 'America/Curacao', CXR: 'Indian/Christmas', CYP: 'Asia/Nicosia', CZE: 'Europe/Prague',
    DEU: 'Europe/Berlin', DJI: 'Africa/Djibouti', DNK: 'Europe/Copenhagen', DMA: 'America/Dominica',
    DOM: 'America/Santo_Domingo', DZA: 'Africa/Algiers', ECU: 'America/Guayaquil', EST: 'Europe/Tallinn',
    EGY: 'Africa/Cairo', ESH: 'Africa/El_Aaiun', ERI: 'Africa/Asmara', ESP: 'Europe/Madrid',
    ETH: 'Africa/Addis_Ababa', FIN: 'Europe/Helsinki', FJI: 'Pacific/Fiji', FLK: 'Atlantic/Stanley',
    FSM: 'Pacific/Pohnpei', FRO: 'Atlantic/Faroe', FRA: 'Europe/Paris', GAB: 'Africa/Libreville',
    GBR: 'Europe/London', GRD: 'America/Grenada', GEO: 'Asia/Tbilisi', GUF: 'America/Cayenne',
    GGY: 'Europe/Guernsey', GHA: 'Africa/Accra', GIB: 'Europe/Gibraltar', GRL: 'America/Nuuk',
    GMB: 'Africa/Banjul', GIN: 'Africa/Conakry', GLP: 'America/Guadeloupe', GNQ: 'Africa/Malabo',
    GRC: 'Europe/Athens', SGS: 'Atlantic/South_Georgia', GTM: 'America/Guatemala', GUM: 'Pacific/Guam',
    GNB: 'Africa/Bissau', GUY: 'America/Guyana', HKG: 'Asia/Hong_Kong', HND: 'America/Tegucigalpa',
    HRV: 'Europe/Zagreb', HTI: 'America/Port-au-Prince', HUN: 'Europe/Budapest', IDN: 'Asia/Jakarta',
    IRL: 'Europe/Dublin', ISR: 'Asia/Jerusalem', IMN: 'Europe/Isle_of_Man', IND: 'Asia/Kolkata',
    IOT: 'Indian/Chagos', IRQ: 'Asia/Baghdad', IRN: 'Asia/Tehran', ISL: 'Atlantic/Reykjavik',
    ITA: 'Europe/Rome', JEY: 'Europe/Jersey', JAM: 'America/Jamaica', JOR: 'Asia/Amman',
    JPN: 'Asia/Tokyo', KEN: 'Africa/Nairobi', KGZ: 'Asia/Bishkek', KHM: 'Asia/Phnom_Penh',
    KIR: 'Pacific/Tarawa', COM: 'Indian/Comoro', KNA: 'America/St_Kitts', PRK: 'Asia/Pyongyang',
    KOR: 'Asia/Seoul', KWT: 'Asia/Kuwait', CYM: 'America/Cayman', KAZ: 'Asia/Almaty',
    LAO: 'Asia/Vientiane', LBN: 'Asia/Beirut', LCA: 'America/St_Lucia', LIE: 'Europe/Vaduz',
    LKA: 'Asia/Colombo', LBR: 'Africa/Monrovia', LSO: 'Africa/Maseru', LTU: 'Europe/Vilnius',
    LUX: 'Europe/Luxembourg', LVA: 'Europe/Riga', LBY: 'Africa/Tripoli', MAR: 'Africa/Casablanca',
    MCO: 'Europe/Monaco', MDA: 'Europe/Chisinau', MNE: 'Europe/Podgorica', MAF: 'America/Marigot',
    MDG: 'Indian/Antananarivo', MHL: 'Pacific/Majuro', MKD: 'Europe/Skopje', MLI: 'Africa/Bamako',
    MMR: 'Asia/Yangon', MNG: 'Asia/Ulaanbaatar', MAC: 'Asia/Macau', MNP: 'Pacific/Guam',
    MTQ: 'America/Martinique', MRT: 'Africa/Nouakchott', MSR: 'America/Montserrat', MLT: 'Europe/Malta',
    MUS: 'Indian/Mauritius', MDV: 'Indian/Maldives', MWI: 'Africa/Blantyre', MEX: 'America/Mexico_City',
    MYS: 'Asia/Kuala_Lumpur', MOZ: 'Africa/Maputo', NAM: 'Africa/Windhoek', NCL: 'Pacific/Noumea',
    NER: 'Africa/Niamey', NFK: 'Pacific/Norfolk', NGA: 'Africa/Lagos', NIC: 'America/Managua',
    NLD: 'Europe/Amsterdam', NOR: 'Europe/Oslo', NPL: 'Asia/Kathmandu', NRU: 'Pacific/Nauru',
    NIU: 'Pacific/Niue', NZL: 'Pacific/Auckland', OMN: 'Asia/Muscat', PAN: 'America/Panama',
    PER: 'America/Lima', PYF: 'Pacific/Tahiti', PNG: 'Pacific/Port_Moresby', PHL: 'Asia/Manila',
    PAK: 'Asia/Karachi', POL: 'Europe/Warsaw', SPM: 'America/Miquelon', PCN: 'Pacific/Pitcairn',
    PRI: 'America/Puerto_Rico', PSE: 'Asia/Gaza', PRT: 'Europe/Lisbon', PLW: 'Pacific/Palau',
    PRY: 'America/Asuncion', QAT: 'Asia/Qatar', REU: 'Indian/Reunion', ROU: 'Europe/Bucharest',
    SRB: 'Europe/Belgrade', RUS: 'Europe/Moscow', RWA: 'Africa/Kigali', SAU: 'Asia/Riyadh',
    SLB: 'Pacific/Guadalcanal', SYC: 'Indian/Mahe', SDN: 'Africa/Khartoum', SWE: 'Europe/Stockholm',
    SGP: 'Asia/Singapore', SHN: 'Atlantic/St_Helena', SVN: 'Europe/Ljubljana', SJM: 'Arctic/Longyearbyen',
    SVK: 'Europe/Bratislava', SLE: 'Africa/Freetown', SMR: 'Europe/San_Marino', SEN: 'Africa/Dakar',
    SOM: 'Africa/Mogadishu', SUR: 'America/Paramaribo', SSD: 'Africa/Juba', STP: 'Africa/Sao_Tome',
    SLV: 'America/El_Salvador', SXM: 'America/Lower_Princes', SYR: 'Asia/Damascus', SWZ: 'Africa/Mbabane',
    TCA: 'America/Grand_Turk', TCD: 'Africa/Ndjamena', ATF: 'Indian/Kerguelen', TGO: 'Africa/Lome',
    THA: 'Asia/Bangkok', TJK: 'Asia/Dushanbe', TKL: 'Pacific/Fakaofo', TLS: 'Asia/Dili',
    TKM: 'Asia/Ashgabat', TUN: 'Africa/Tunis', TON: 'Pacific/Tongatapu', TUR: 'Europe/Istanbul',
    TTO: 'America/Port_of_Spain', TUV: 'Pacific/Funafuti', TWN: 'Asia/Taipei', TZA: 'Africa/Dar_es_Salaam',
    UKR: 'Europe/Kyiv', UGA: 'Africa/Kampala', UMI: 'Pacific/Midway', USA: 'America/Chicago',
    URY: 'America/Montevideo', UZB: 'Asia/Tashkent', VAT: 'Europe/Vatican', VCT: 'America/St_Vincent',
    VEN: 'America/Caracas', VGB: 'America/Virgin', VIR: 'America/Virgin', VNM: 'Asia/Ho_Chi_Minh',
    VUT: 'Pacific/Efate', WLF: 'Pacific/Wallis', WSM: 'Pacific/Apia', YEM: 'Asia/Aden',
    MYT: 'Indian/Mayotte', ZAF: 'Africa/Johannesburg', ZMB: 'Africa/Lusaka', ZWE: 'Africa/Harare',
    FRO: 'Atlantic/Faroe', HMD: 'Indian/Kerguelen',
    UK: 'Europe/London'
  };

  /** Aktuelle Ortszeit (HH:mm) im Auftragsland. countryCode = 2 oder 3 Buchstaben. */
  function getLocalTimeHhmm(countryCode) {
    try {
      if (!countryCode || countryCode.length < 2) return null;
      var code = countryCode.toUpperCase().slice(0, 3);
      var tz = countryToTz[code] || countryToTz[code.slice(0, 2)];
      if (!tz) return null;
      var now = new Date();
      return now.toLocaleTimeString('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (_) { return null; }
  }

  /** Firma, Ort, Länderkürzel für Kalender-Balken (Aufträge). Tooltip: Lokale Uhrzeit (HH:mm) im Auftragsland. */
  function jobBarText(job, maxLen) {
    const firma = (job.customer_name || job.customer || job.customerName || job.job_number || 'Auftrag').trim();
    const ort = (job.city || '').trim();
    const countryCode = normalizeCountryToCode(job.country) || (job.country || '').trim().toUpperCase().slice(0, 2);
    const land = countryCode.slice(0, 3);
    const land2 = countryCode.slice(0, 2);
    const parts = [firma];
    if (ort) parts.push(ort);
    if (land2) parts.push(land2);
    const full = parts.join(', ');
    const label = maxLen && full.length > maxLen ? (maxLen <= 4 ? full.substring(0, maxLen) : full.substring(0, maxLen - 4) + ',...') : full;
    const statusRaw = (job.status != null ? job.status : job.Status != null ? job.Status : job.job_status != null ? job.job_status : '').toString().trim().toLowerCase();
    const isErledigt = statusRaw === 'erledigt' || statusRaw === 'abgerechnet' || statusRaw === 'completed' || statusRaw === 'done' || statusRaw === 'fertig';
    const isMontage = Number(job.montage_verrechnet) === 1;
    const isReise = Number(job.billing_travel_complete) === 1;
    const escLabel = (label || 'Auftrag').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const checkParts = [];
    if (isErledigt) checkParts.push('<span class="cal-check cal-check-erledigt" title="Erledigt">✓</span>');
    if (isMontage) checkParts.push('<span class="cal-check cal-check-montage" title="Fakturierung Montage">✓</span>');
    if (isReise) checkParts.push('<span class="cal-check cal-check-reise" title="Reisekosten abgerechnet">✓</span>');
    const labelHtml = checkParts.length
      ? checkParts.join('') + ' <span class="cal-bar-label">' + escLabel + '</span>'
      : null;

    let title = full || firma || 'Auftrag';
    const dateRangeStr = formatDateRange(job.start_datetime, job.end_datetime);
    if (dateRangeStr) title += '\nZeitraum: ' + dateRangeStr;
    var tzLabel = null;
    if (job.local_time_hhmm) {
      tzLabel = 'Lokale Uhrzeit: ' + job.local_time_hhmm;
    } else {
      try {
        var hhmm = getLocalTimeHhmm(land2 || land);
        if (hhmm) tzLabel = 'Lokale Uhrzeit: ' + hhmm;
      } catch (_) { }
    }
    if (tzLabel) title += '\n' + tzLabel;

    return { label: label || 'Auftrag', title, labelHtml };
  }

  function setCalendarError(text) {
    const el = document.getElementById('calError');
    if (el) {
      el.textContent = text || '';
      el.style.display = text ? 'block' : 'none';
    }
  }

  function renderCalendarGrid(gridStart, gridEnd, jobs, absences, techniciansFromApi) {
    setCalendarError('');
    const myTechIdForDetails = Number(getTechId());
    const monthLabel = new Date(calCurrentMonth.getFullYear(), calCurrentMonth.getMonth(), 1);
    const monthEl = document.getElementById('calMonthLabel');
    if (monthEl) monthEl.textContent = monthLabel.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

    const weekDays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const currentMonth = calCurrentMonth.getMonth();
    const todayYmd = toYmd(new Date());
    const gridCols = '40px repeat(7, minmax(0, 1fr))';
    const laneHeight = 21;
    const overlayTop = 22;
    const overlayBottom = 4;

    const calGrid = document.getElementById('calGrid');
    if (!calGrid) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'cal-grid-wrapper';

    // Header-Zeile wie bisher (KW + Mo–So)
    const headerRow = document.createElement('div');
    headerRow.className = 'cal-grid cal-month-header';
    headerRow.style.display = 'grid';
    headerRow.style.gridTemplateColumns = gridCols;
    headerRow.style.gap = '0';
    headerRow.innerHTML = '<div class="cal-head">KW</div>' + weekDays.map(function (d) { return '<div class="cal-head">' + d + '</div>'; }).join('');
    wrapper.appendChild(headerRow);

    // Pro Woche: gleiche Grundstruktur wie Monatskalender (Grid + Bands-Overlay), alle Balken im Overlay mit grid-column/grid-row
    for (let w = 0; w < 6; w++) {
      const weekStart = new Date(gridStart);
      weekStart.setDate(weekStart.getDate() + w * 7);
      weekStart.setHours(12, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const weekStartYmd = toYmd(weekStart);
      const weekEndYmd = toYmd(weekEnd);
      const kw = getWeekNum(weekStart);

      const segments = [];
      jobs.forEach(function (j) {
        if (isMultiDay(j)) {
          const sp = getWeekSpan(j, weekStartYmd, weekEndYmd);
          if (sp) segments.push({ startCol: sp.startCol, span: sp.span, item: j, type: 'job' });
        } else {
          const ymd = startYmd(j);
          if (ymd >= weekStartYmd && ymd <= weekEndYmd) {
            const d = new Date(ymd + 'T12:00:00');
            const startCol = Math.round((d - weekStart) / 86400000);
            segments.push({ startCol: startCol, span: 1, item: j, type: 'job' });
          }
        }
      });
      absences.forEach(function (a) {
        if (isMultiDay(a)) {
          const sp = getWeekSpan(a, weekStartYmd, weekEndYmd);
          if (sp) segments.push({ startCol: sp.startCol, span: sp.span, item: a, type: 'absence' });
        } else {
          const ymd = startYmd(a);
          if (ymd >= weekStartYmd && ymd <= weekEndYmd) {
            const d = new Date(ymd + 'T12:00:00');
            const startCol = Math.round((d - weekStart) / 86400000);
            segments.push({ startCol: startCol, span: 1, item: a, type: 'absence' });
          }
        }
      });

      assignLanes(segments);
      const numLanes = segments.length ? Math.max.apply(null, segments.map(function (s) { return s.lane; })) + 1 : 0;
      const neededHeight = Math.max(56, overlayTop + numLanes * laneHeight + overlayBottom);

      const weekRow = document.createElement('div');
      weekRow.className = 'cal-week-row';

      const weekGrid = document.createElement('div');
      weekGrid.className = 'cal-week-grid';
      weekGrid.style.display = 'grid';
      weekGrid.style.gridTemplateColumns = gridCols;
      weekGrid.style.gap = '0';
      let cellsHtml = '<div class="cal-head">' + kw + '</div>';
      for (let d = 0; d < 7; d++) {
        const cellDate = new Date(weekStart);
        cellDate.setDate(cellDate.getDate() + d);
        cellDate.setHours(12, 0, 0, 0);
        const ymd = toYmd(cellDate);
        const otherMonth = cellDate.getMonth() !== currentMonth;
        const isToday = ymd === todayYmd;
        const hname = getHolidayName(cellDate);
        const holidayCls = hname ? ' day-holiday' : '';
        const holidayHtml = hname ? '<div class="holiday-name">' + escapeHtml(hname) + '</div>' : '';
        cellsHtml += '<div class="cal-cell' + (otherMonth ? ' other-month' : '') + (isToday ? ' today' : '') + holidayCls + '" style="min-height:' + neededHeight + 'px"><div class="cal-daynum">' + cellDate.getDate() + '</div>' + holidayHtml + '</div>';
      }
      weekGrid.innerHTML = cellsHtml;
      weekRow.appendChild(weekGrid);

      const bands = document.createElement('div');
      bands.className = 'cal-week-bands';
      bands.style.gridTemplateColumns = gridCols;
      bands.style.gridAutoRows = laneHeight + 'px';

      var segsOrdered = segments.filter(function (s) { return s.type === 'job'; }).concat(segments.filter(function (s) { return s.type === 'absence'; }));
      segsOrdered.forEach(function (seg) {
        const band = document.createElement('div');
        const o = seg.item;
        const colStart = 2 + seg.startCol;
        const colEnd = 2 + seg.startCol + seg.span;
        band.style.gridColumn = colStart + ' / ' + colEnd;
        band.style.gridRow = (seg.lane + 1) + ' / ' + (seg.lane + 2);

        if (seg.type === 'absence') {
          band.className = 'month2-band month2-absence';
          band.style.setProperty('--stripes', o.technician_color || '#999');
          band.textContent = (o.type || 'Abwesenheit') + (o.technician_name ? ' – ' + (o.technician_name.substring(0, 20)) : '');
          var ttip = (o.type || 'Abwesenheit') + (o.technician_name ? ' – ' + o.technician_name : '');
          if (o.comment && String(o.comment).trim()) ttip += ' | ' + String(o.comment).trim();
          band.title = ttip;
        } else {
          const j = o;
          band.className = 'month2-band month2-event';
          band.style.background = j.technician_color || '#4a90e2';
          band.setAttribute('data-job-id', String(j.id));
          const jobTechId = Number(j.technician_id);
          const isOwnTechJob = Number.isFinite(myTechIdForDetails) && myTechIdForDetails > 0 && Number.isFinite(jobTechId) && jobTechId === myTechIdForDetails;
          band.style.cursor = isOwnTechJob ? 'pointer' : 'default';
          const colSpan = colEnd - colStart;
          const maxChars = colSpan * 20;
          const bar = jobBarText(j, maxChars);
          band.title = isOwnTechJob ? ((bar.title || '') + ' (Doppelklick: Projektdaten)') : (bar.title || '');
          if (bar.labelHtml) band.innerHTML = bar.labelHtml; else band.textContent = bar.label || 'Auftrag';
          if (isOwnTechJob) {
            band.addEventListener('click', function (ev) {
              if (ev.detail > 1) return;
              if (typeof loadStartActiveJobById === 'function') loadStartActiveJobById(j.id, j);
            });
            band.addEventListener('dblclick', function () {
              if (typeof openJobDetailsModal === 'function') openJobDetailsModal(j.id);
            });
          }
        }
        bands.appendChild(band);
      });

      weekRow.appendChild(bands);
      wrapper.appendChild(weekRow);
    }

    calGrid.innerHTML = '';
    calGrid.appendChild(wrapper);

    // Legende: Farbe = Techniker (ID immer normalisiert, damit 3 und "3" nicht doppelt vorkommen)
    const techMap = new Map();
    function normId(id) {
      if (id == null || id === '') return null;
      const n = Number(id);
      return Number.isNaN(n) ? id : n;
    }
    function addTech(item) {
      const id = normId(item.technician_id);
      if (id == null) return;
      const color = item.technician_color || '#4a90e2';
      const name = (item.technician_name || item.technicianName || '').trim();
      if (techMap.has(id)) {
        if (color) techMap.get(id).color = color;
        if (name) techMap.get(id).name = name;
        return;
      }
      let displayName = name;
      if (!displayName && techMap.size === 0) {
        const el = document.getElementById('technicianName');
        displayName = (el && el.textContent) ? el.textContent.trim() : '';
      }
      techMap.set(id, { name: displayName || 'Techniker ' + id, color });
    }
    // Zuerst alle Techniker aus der API-Legende (falls vorhanden), dann aus Jobs/Abwesenheiten ergänzen
    if (Array.isArray(techniciansFromApi) && techniciansFromApi.length > 0) {
      techniciansFromApi.forEach(t => {
        const id = normId(t.id ?? t.technician_id);
        if (id == null) return;
        techMap.set(id, {
          name: (t.name || t.full_name || t.technician_name || '').trim() || 'Techniker ' + id,
          color: t.color || '#4a90e2'
        });
      });
    }
    jobs.forEach(addTech);
    absences.forEach(addTech);
    const legendEl = document.getElementById('calLegend');
    if (legendEl) {
      if (techMap.size === 0) {
        legendEl.innerHTML = '';
      } else {
        const entries = Array.from(techMap.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
        const items = entries.map(([id, t]) =>
          '<span class="cal-legend-item"><span class="cal-legend-swatch" style="background:' + escapeHtml(t.color) + '"></span>' + escapeHtml(t.name) + '</span>'
        );
        legendEl.innerHTML = '<span class="cal-legend-title">Legende:</span>' + items.join('');
      }
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  var selectedJobIdOnDienstreisePage = null;
  var dienstreisePageJobs = [];
  var dienstreiseExplorerSubpath = '';
  var dienstreiseExplorerRootEntries = [];
  var dienstreiseExplorerExpanded = {};
  var startExplorerSubpath = '';
  var startExplorerRootEntries = [];
  var startExplorerExpanded = {};
  var dienstreiseProtectedPathsByJob = {};

  function formatFileSize(bytes) {
    if (bytes == null || bytes === '') return '';
    var n = parseInt(bytes, 10);
    if (isNaN(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatFileDate(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderDienstreiseExplorerTree(uiKey) {
    var ui = getDienstreiseExplorerUi(uiKey || 'modal');
    var listEl = ui.getListEl();
    var jobId = getDienstreiseExplorerJobId();
    if (!listEl || !jobId) return;
    if (!dienstreiseProtectedPathsByJob[jobId]) dienstreiseProtectedPathsByJob[jobId] = new Set();
    var protectedSet = dienstreiseProtectedPathsByJob[jobId];
    var drSnap = getDienstreiseJobSnapshotByLocalId(jobId);
    var drReadonlyGeplant = isJobAngelegtReadOnly(drSnap);
    var rows = [];
    var expanded = ui.getExpanded();
    function addEntries(entries, level) {
      if (!entries) return;
      entries.forEach(function (e) {
        rows.push({ level: level, entry: e });
        if (e.isDirectory && expanded[e.relativePath]) {
          addEntries(expanded[e.relativePath], level + 1);
        }
      });
    }
    addEntries(ui.getRootEntries(), 0);
    if (rows.length === 0) {
      listEl.innerHTML = '<span class="empty">Ordner leer.</span>';
      return;
    }
    var html = '';
    rows.forEach(function (r) {
      var e = r.entry;
      var levelClass = r.level > 0 ? ' level-' + Math.min(r.level, 6) : '';
      var icon = e.isDirectory ? '📁' : '📄';
      var sizeStr = e.isDirectory ? '' : formatFileSize(e.size);
      var mtimeStr = formatFileDate(e.mtime);
      var toggle = e.isDirectory ? ('<span class="explorer-toggle" data-explorer-toggle aria-label="' + (expanded[e.relativePath] ? 'Einklappen' : 'Ausklappen') + '">' + (expanded[e.relativePath] ? '▼' : '▶') + '</span>') : '<span class="explorer-toggle empty"></span>';
      var relPath = e.relativePath || '';
      var isProtected = relPath && protectedSet.has(relPath);
      var protectControl = drReadonlyGeplant ? '' : ('<label style="display:inline-flex;align-items:center;gap:0.25rem;"><input type="checkbox" data-explorer-protect ' + (isProtected ? 'checked' : '') + '>Nicht löschen</label>');
      var deleteBtn = (drReadonlyGeplant || e.isDirectory) ? '' : '<button type="button" class="btn btn-ghost btn-delete-file" data-explorer-delete title="Datei löschen (lokal und auf Dispo)">Löschen</button>';
      var isRasterImage = !e.isDirectory && isProjekteNeuRasterImage(e.name);
      var previewBtn = isRasterImage
        ? '<button type="button" class="btn btn-ghost" data-explorer-preview title="Bild in der App anzeigen">Vorschau</button>'
        : '';
      var nameVisual = isRasterImage
        ? '<img class="dienstreise-explorer-thumb" data-explorer-thumb alt="" />'
        : ('<span class="icon" aria-hidden="true">' + icon + '</span>');
      html += '<div class="dienstreise-explorer-row' + levelClass + '" data-full-path="' + escapeHtml(e.fullPath || '') + '" data-is-dir="' + (e.isDirectory ? '1' : '0') + '" data-relative-path="' + escapeHtml(relPath) + '">' +
        '<div class="dienstreise-explorer-name">' + toggle + nameVisual + ' <span class="dienstreise-explorer-filename">' + escapeHtml(e.name) + '</span></div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(sizeStr) + '</div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(mtimeStr) + '</div>' +
        '<div class="dienstreise-explorer-actions">' +
        protectControl +
        previewBtn +
        '<button type="button" class="btn btn-ghost" data-explorer-open title="Mit Standardprogramm bzw. Explorer öffnen">Öffnen</button>' +
        deleteBtn +
        '</div></div>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('[data-explorer-thumb]').forEach(function (img) {
      var row = img.closest('.dienstreise-explorer-row');
      var rel = row && row.getAttribute('data-relative-path');
      var fileName = row && row.querySelector('.dienstreise-explorer-filename');
      if (rel) loadDienstreiseExplorerThumbnailImg(img, jobId, rel);
      img.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!rel) return;
        openDienstreiseProjectImageInLightbox(jobId, rel, {
          alt: fileName ? fileName.textContent : '',
        });
      });
    });
    listEl.querySelectorAll('[data-explorer-preview]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = btn.closest('.dienstreise-explorer-row');
        var rel = row && row.getAttribute('data-relative-path');
        var fileName = row && row.querySelector('.dienstreise-explorer-filename');
        if (!rel) return;
        openDienstreiseProjectImageInLightbox(jobId, rel, {
          alt: fileName ? fileName.textContent : '',
        });
      });
    });
    listEl.querySelectorAll('[data-explorer-open]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = btn.closest('.dienstreise-explorer-row');
        var fullPath = row && row.getAttribute('data-full-path');
        if (fullPath && typeof monteurApp !== 'undefined' && monteurApp.openPath) monteurApp.openPath(fullPath);
      });
    });
    listEl.querySelectorAll('[data-explorer-delete]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = btn.closest('.dienstreise-explorer-row');
        var relPath = row && row.getAttribute('data-relative-path');
        if (!relPath || !jobId) return;
        if (!confirm('Datei wirklich löschen? (lokal und auf dem Dispo-Server)')) return;
        var body = {
          job_id: jobId,
          relative_path: relPath,
          dispoBaseUrl: getDispoBaseUrl(),
          technicianId: getTechId(),
          dispoUsername: getDispoUsername(),
          dispoPassword: getDispoPassword()
        };
        fetch(API_BASE + '/api/dienstreise/delete_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json();         }).then(function (data) {
          if (data.ok) {
            loadDienstreiseExplorer(jobId, ui.getSubpath(), ui.key);
            if (data.warning) showToast(data.warning);
          } else {
            alert(data.error || 'Löschen fehlgeschlagen.');
          }
        }).catch(function (err) {
          alert('Löschen fehlgeschlagen: ' + (err && err.message ? err.message : String(err)));
        });
      });
    });
    listEl.querySelectorAll('[data-explorer-protect]').forEach(function (cb) {
      cb.addEventListener('change', function (ev) {
        var row = cb.closest('.dienstreise-explorer-row');
        if (!row) return;
        var rel = row.getAttribute('data-relative-path') || '';
        if (!rel) return;
        if (cb.checked) protectedSet.add(rel);
        else protectedSet.delete(rel);
      });
    });
    listEl.querySelectorAll('.dienstreise-explorer-row[data-is-dir="1"]').forEach(function (row) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (ev.target.closest('[data-explorer-thumb]')) return;
        var rel = row.getAttribute('data-relative-path');
        if (!rel) return;
        if (ui.key === 'start') {
          startExplorerSubpath = rel;
          var mp = document.getElementById('startMkdirParent');
          var upSub = document.getElementById('startUploadSubfolder');
          var top = rel.split('/')[0];
          if (mp && top) mp.value = top;
          if (upSub && top) upSub.value = top;
        }
        var expandedMap = ui.getExpanded();
        if (expandedMap[rel]) {
          delete expandedMap[rel];
          renderDienstreiseExplorerTree(ui.key);
          return;
        }
        fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId) + '&subpath=' + encodeURIComponent(rel)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.entries) expandedMap[rel] = data.entries;
          renderDienstreiseExplorerTree(ui.key);
        });
      });
    });
  }

  function loadDienstreiseExplorer(jobId, subpath, uiKey) {
    var ui = getDienstreiseExplorerUi(uiKey || 'modal');
    ui.setSubpath(subpath || '');
    var requestJobId = jobId;
    var listEl = ui.getListEl();
    var breadcrumbEl = ui.getBreadcrumbEl();
    if (!listEl) return;
    if (!jobId) {
      listEl.innerHTML =
        ui.key === 'start'
          ? '<span class="empty">Kein Auftrag ausgewählt.</span>'
          : '<span class="empty" id="dienstreiseExplorerPlaceholder">Auftrag wählen, dann Ordnerinhalt hier.</span>';
      if (breadcrumbEl) breadcrumbEl.textContent = 'Projektordner';
      ui.setRootEntries([]);
      ui.clearExpanded();
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      return;
    }
    listEl.innerHTML = '<span class="empty">Wird geladen …</span>';
    if (breadcrumbEl) {
      breadcrumbEl.textContent = ui.getSubpath() ? 'Projektordner / ' + ui.getSubpath() : 'Projektordner';
    }
    fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId)).then(function (r) { return r.json(); }).then(function (data) {
      if (!jobIdsEqual(requestJobId, getDienstreiseExplorerJobId())) return;
      if (!data.ok || !data.entries) {
        listEl.innerHTML = '<span class="empty">' + (data.error || 'Laden fehlgeschlagen.') + '</span>';
        if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
        return;
      }
      ui.setRootEntries(data.entries);
      ui.clearExpanded();
      renderDienstreiseExplorerTree(ui.key);
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
    }).catch(function () {
      if (!jobIdsEqual(requestJobId, getDienstreiseExplorerJobId())) return;
      listEl.innerHTML = '<span class="empty">Laden fehlgeschlagen.</span>';
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
    });
  }

  function loadDienstreiseList() {
    var techId = getTechId();
    if (!techId) {
      var listEl = document.getElementById('dienstreiseList');
      if (listEl) listEl.innerHTML = '<span class="empty">Bitte Monteur-ID in Einstellungen eintragen.</span>';
      return;
    }
    var range = getSyncDateRange();
    fetch(API_BASE + '/api/my_jobs?' + qs({
      technician_id: techId,
      date_from: range.date_from,
      date_to: range.date_to,
      assigned_only: '1'
    })).then(function (r) { return r.json(); }).then(function (data) {
      var listEl = document.getElementById('dienstreiseList');
      if (!listEl) return;
      var jobs = (data && data.jobs) ? data.jobs : [];
      jobs = jobs.filter(function (j) { return !isJobAbgerechnet(j); });
      dienstreisePageJobs = jobs;
      if (jobs.length === 0) {
        listEl.innerHTML = '<span class="empty">Keine Aufträge.</span>';
        selectedJobIdOnDienstreisePage = null;
        if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
        return;
      }
      var html = jobs.map(function (j) {
        var dateStr = formatDateRange(j.start_datetime, j.end_datetime);
        var stClass = jobStatusBadgeClass(j.status);
        var stLabel = jobStatusDisplayLabel(j.status);
        var firma = (j.customer_name || j.customerName || '').trim();
        var ort = (j.city || '').trim();
        var land = normalizeCountryToCode(j.country) || (j.country || '').trim().toUpperCase().slice(0, 2);
        var flagHtml = countryFlagImg(land);
        var parts = [];
        if (flagHtml) parts.push(flagHtml);
        if (firma) parts.push(escapeHtml(firma));
        if (ort) parts.push(escapeHtml(ort));
        if (land) parts.push(escapeHtml(land));
        var titleLine = parts.join(' · ') || 'Auftrag';
        var sel = j.id === selectedJobIdOnDienstreisePage ? ' selected' : '';
        return '<div class="job' + sel + '" data-job-id="' + escapeHtml(String(j.id)) + '">' +
          '<div class="job-info"><strong>' + (titleLine || 'Auftrag') + '</strong><br><span class="job-meta">' + escapeHtml(dateStr) + (j.job_type ? ' · ' + (j.job_type || '') : '') + '</span></div>' +
          '<div class="job-actions">' +
          '<span class="status-badge status-' + stClass + '">' + escapeHtml(stLabel) + '</span>' +
          (jobCanAcceptJob(j)
            ? '<button type="button" class="btn btn-accept-job" data-action="accept-job">' +
              '<span class="btn-accept-job-label">Auftrag annehmen</span>' +
              '<span class="btn-accept-job-progress-wrap">' +
              '<span class="btn-accept-job-progress-text"></span>' +
              '<progress class="btn-accept-job-progress" max="100" value="0"></progress>' +
              '</span></button>'
            : '') +
          (j.status !== 'erledigt' && String(j.status || '').toLowerCase() !== 'abgerechnet' && !isJobAngelegtReadOnly(j) ? '<button class="btn btn-primary" data-status="erledigt">Erledigt</button>' : '') +
          '</div></div>';
      }).join('');
      listEl.innerHTML = html;
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      listEl.querySelectorAll('.job-actions [data-action="accept-job"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var jobId = parseInt(btn.closest('.job').getAttribute('data-job-id'), 10);
          if (!jobId) return;
          selectedJobIdOnDienstreisePage = jobId;
          runAcceptJobStream(jobId, btn);
        });
      });
      listEl.querySelectorAll('.job-actions [data-status]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var status = btn.getAttribute('data-status');
          var jobId = parseInt(btn.closest('.job').getAttribute('data-job-id'), 10);
          if (!jobId) return;
          if (status === 'erledigt') {
            finishAndCleanup(jobId);
          } else {
            updateJobStatus(jobId, status);
          }
        });
      });
      listEl.querySelectorAll('.job').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.closest('button')) return;
          selectedJobIdOnDienstreisePage = parseInt(el.getAttribute('data-job-id'), 10);
          loadDienstreiseList();
        });
        el.addEventListener('dblclick', function (e) {
          if (e.target.closest('button')) return;
          var jobId = parseInt(el.getAttribute('data-job-id'), 10);
          if (jobId && typeof openJobDetailsModal === 'function') openJobDetailsModal(jobId);
        });
      });
      if (acceptJobStreamBusy && acceptJobActiveLocalJobId != null) {
        applyAcceptJobStreamBusyUi();
        if (acceptJobLastProgressRow) {
          updateAcceptJobButtonProgress(acceptJobLastProgressRow);
        }
      }
      restoreAcceptJobStreamFromBackgroundJobs();
    }).catch(function () {
      var listEl = document.getElementById('dienstreiseList');
      if (listEl) listEl.innerHTML = '<span class="empty">Laden fehlgeschlagen.</span>';
    });
  }

  (function initDienstreiseUploadDelegation() {
    var root = document.getElementById('viewProjektdaten');
    if (!root) return;
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('#btnDienstreiseUpload');
      if (!btn || btn.disabled) return;
    var localJobId = getDienstreiseExplorerJobId();
    var snapUp = localJobId ? getDienstreiseJobSnapshotByLocalId(localJobId) : null;
    if (isJobAngelegtReadOnly(snapUp)) {
      var hintRo = document.getElementById('dienstreiseUploadHint');
      if (hintRo) hintRo.textContent = 'Auftrag ist angelegt – nur Anzeige.';
      return;
    }
    var subfolder = document.getElementById('dienstreiseUploadSubfolder');
    var sub = subfolder && subfolder.value ? subfolder.value : 'Dokumente_Monteur';
    var fileInput = document.getElementById('dienstreiseFileInput');
    var hint = document.getElementById('dienstreiseUploadHint');
    if (!localJobId) { if (hint) hint.textContent = 'Bitte einen Auftrag öffnen (Doppelklick auf Auftrag oder Kalenderbalken).'; return; }
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      if (hint) hint.textContent = 'Bitte eine Datei wählen.';
      return;
    }
    var file = fileInput.files[0];
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = reader.result;
      if (typeof b64 === 'string' && b64.indexOf('base64,') !== -1) b64 = b64.slice(b64.indexOf('base64,') + 7);
      hint.textContent = 'Hochladen …';
      fetch(API_BASE + '/api/dienstreise/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: localJobId, subfolder: sub, filename: file.name, content: b64 })
      }).then(function (r) {
        return r.text().then(function (text) {
          var data;
          try { data = text ? JSON.parse(text) : {}; } catch (e) {
            hint.textContent = r.status === 413 ? 'Datei zu groß.' : ('Server antwortete mit Fehlerseite (Status ' + r.status + ').');
            return;
          }
          if (!r.ok) {
            hint.textContent = (data && data.error) ? data.error : ('Fehler: ' + r.status);
            return;
          }
          hint.textContent = data.ok ? 'Hochgeladen.' : (data.error || 'Fehler.');
          if (data.ok) {
            fileInput.value = '';
            setTimeout(function () { hint.textContent = ''; }, 3000);
            if (getDienstreiseExplorerJobId()) {
              if (startPageActiveJobId == getDienstreiseExplorerJobId()) {
                loadDienstreiseExplorer(getDienstreiseExplorerJobId(), startExplorerSubpath, 'start');
              } else {
                loadDienstreiseExplorer(getDienstreiseExplorerJobId(), dienstreiseExplorerSubpath, 'modal');
              }
            }
            if (sub === 'Dokumente_Dispo' || sub === 'Dokumente_Monteur' || sub === 'Dokumente_Anlage' || sub === 'Dokumente_Buchhaltung') {
              var bodySync = {
                job_id: localJobId,
                dispo_base_url: getDispoBaseUrl(),
                technician_id: getTechId(),
                dispo_username: getDispoUsername(),
                dispo_password: getDispoPassword()
              };
              fetch(API_BASE + '/api/dienstreise/sync_to_dispo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodySync)
              }).catch(function () { /* Sync-Fehler hier nur protokollieren/ignorieren; Verify bei Erledigt prüft erneut */ });
            }
          }
        });
      }).catch(function (err) {
        hint.textContent = 'Upload fehlgeschlagen. ' + (err && err.message ? err.message : '');
      });
    };
    reader.readAsDataURL(file);
    });
  })();

  document.getElementById('btnViewStart').addEventListener('click', () => showView('start'));
  document.getElementById('btnViewDienstreise').addEventListener('click', () => showView('dienstreise'));
  (function initAbrechnungView() {
    var btn = document.getElementById('btnViewAbrechnung');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!getTechId()) {
          window.alert('Bitte unter Einstellungen die Monteur-ID eintragen.');
          return;
        }
        showView('abrechnung');
      });
    }
    var sync = document.getElementById('btnAbrechnungSync');
    if (sync) sync.addEventListener('click', function () { refreshAbrechnungNativeUi(true); });
    var reload = document.getElementById('btnAbrechnungReload');
    if (reload) reload.addEventListener('click', function () { refreshAbrechnungNativeUi(false); });
    var period = document.getElementById('abrechnungPeriod');
    if (period) period.addEventListener('change', function () { refreshAbrechnungNativeUi(false); });
    var jobSel = document.getElementById('abrechnungJobSelect');
    if (jobSel) jobSel.addEventListener('change', function () { loadAbrechnungBundleForSelection(); });
    var sd = document.getElementById('btnAbrechnungSaveDispo');
    if (sd) sd.addEventListener('click', function () { abrechnungSaveNote('dispo'); });
    var sb = document.getElementById('btnAbrechnungSaveBuch');
    if (sb) sb.addEventListener('click', function () { abrechnungSaveNote('buchhaltung'); });
    wireAbrechnungFileUpload('abrechnungUploadDispo', 'dispo');
    wireAbrechnungFileUpload('abrechnungUploadBuch', 'buchhaltung');
    window.addEventListener('online', function () {
      var v = document.getElementById('viewAbrechnung');
      if (v && v.classList.contains('active')) refreshAbrechnungNativeUi(false);
    });
    window.addEventListener('offline', function () {
      var v = document.getElementById('viewAbrechnung');
      if (v && v.classList.contains('active')) updateAbrechnungStatusLine();
    });
  })();
  (function initProtokolleDropdown() {
    const btn = document.getElementById('btnViewProtokolle');
    const dropdown = document.getElementById('protokolleDropdown');
    if (!btn || !dropdown) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
      btn.setAttribute('aria-expanded', dropdown.classList.contains('open'));
    });
    dropdown.querySelectorAll('.toolbar-dropdown-item').forEach(function (item) {
      item.addEventListener('click', function () {
        const view = item.getAttribute('data-view');
        if (view) showView(view);
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('click', function (e) {
      if (dropdown.classList.contains('open') && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  })();
  document.getElementById('btnViewTextbausteine').addEventListener('click', () => showView('textbausteine'));
  document.getElementById('btnViewArchiv').addEventListener('click', () => showView('archiv'));
  document.getElementById('btnViewAnlagenstamm').addEventListener('click', () => showView('anlagenstamm'));
  document.getElementById('btnAnlagenstammSearch').addEventListener('click', () => searchAnlagenstammList());
  ['anlagenstammFilterFn', 'anlagenstammFilterKunde', 'anlagenstammFilterType', 'anlagenstammFilterLand'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          searchAnlagenstammList();
        }
      });
    }
  });
  (function initAbwesenheitenDropdown() {
    const btn = document.getElementById('btnViewAbwesenheiten');
    const dropdown = document.getElementById('abwesenheitenDropdown');
    if (!btn || !dropdown) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
      btn.setAttribute('aria-expanded', dropdown.classList.contains('open'));
    });
    dropdown.querySelectorAll('.toolbar-dropdown-item').forEach(function (item) {
      item.addEventListener('click', function () {
        const view = item.getAttribute('data-view');
        if (view) showView(view);
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('click', function (e) {
      if (dropdown.classList.contains('open') && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  })();
  document.getElementById('btnViewEinstellungen').addEventListener('click', () => showView('einstellungen'));

  (function initProtokolleMontagebericht() {
    const btnAbbrechen = document.getElementById('btnMontageberichtAbbrechen');
    const form = document.getElementById('montageberichtForm');
    const divMontage = document.getElementById('protokolleMontagebericht');
    const jobSelect = document.getElementById('montageberichtJob');
    const grundInput = document.getElementById('montageberichtGrund');
    const fabContainer = document.getElementById('montageberichtFabBemerkungen');
    const kopfdatenEl = document.getElementById('montageberichtKopfdaten');
    const toolbarEl = document.getElementById('montageberichtToolbar');
    const toolbarFont = document.getElementById('mbToolbarFont');
    const toolbarSize = document.getElementById('mbToolbarSize');

    let montageberichtJobData = null;
    let montageberichtActiveEditor = null;

    async function loadMontageberichtJobs() {
      const range = getSyncDateRange();
      const r = await fetch(API_BASE + '/api/my_jobs?' + qs({ technician_id: getTechId(), date_from: range.date_from, date_to: range.date_to }), { headers: { 'X-Technician-Id': String(getTechId()) } });
      const data = await r.json();
      if (!data.ok || !data.jobs) return [];
      return data.jobs;
    }

    async function loadJobWithAnlagenstamm(jobId) {
      const baseUrl = getDispoBaseUrl();
      const techId = getTechId();
      if (baseUrl) {
        const liveResp = await fetch(API_BASE + '/api/job_from_dispo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
          body: JSON.stringify({
            baseUrl: baseUrl,
            jobId: jobId,
            serverUsername: getDispoUsername(),
            serverPassword: getDispoPassword()
          })
        });
        const liveData = await liveResp.json().catch(function () { return {}; });
        if (liveResp.ok && liveData && liveData.ok && liveData.job) {
          return liveData.job;
        }
        throw new Error((liveData && liveData.error) || ('Live-Auftragsdaten konnten nicht geladen werden (HTTP ' + liveResp.status + ').'));
      }
      const url = API_BASE + '/api/job?id=' + jobId + '&technician_id=' + techId + '&enrich_anlagenstamm=1&base_url=' + encodeURIComponent(baseUrl);
      const r = await fetch(url, {
        headers: Object.assign({ 'X-Technician-Id': String(techId) }, dispoBasicAuthHeaders(getDispoUsername, getDispoPassword))
      });
      const data = await r.json();
      return data.job;
    }

    function escapeHtml(s) {
      if (s == null) return '';
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function formatDateRange(start, end) {
      if (!start && !end) return '';
      var s = (start || '').toString().slice(0, 10);
      var e = (end || '').toString().slice(0, 10);
      if (s && e && s !== e) return s + ' – ' + e;
      return s || e;
    }

    /** Liest projekt aus einem FN-Objekt (Anlagenstamm / angereicherte JSON). */
    function readProjektFromFabRow(r) {
      if (r == null) return '';
      if (typeof r === 'object') {
        var v = r.projekt != null ? r.projekt : (r.Projekt != null ? r.Projekt : (r.project != null ? r.project : ''));
        return String(v).replace(/\s+/g, ' ').trim();
      }
      return '';
    }

    /**
     * Einheitliches Projekt aus Anlagenstamm: alle nicht-leeren projekt-Werte müssen übereinstimmen.
     * Leere Einträge (fehlender Stamm, noch nicht gemerged) zählen nicht – reicht z. B. wenn alle befüllten FN dasselbe Projekt haben.
     */
    function deriveMontageberichtProjektFromAnlagenstamm(job) {
      if (!job || !job.fabrikationsnummern) return '';
      var parsed;
      try {
        parsed = JSON.parse(job.fabrikationsnummern);
      } catch (e) {
        return '';
      }
      if (!Array.isArray(parsed) || parsed.length === 0) return '';
      var projs = [];
      parsed.forEach(function (r) {
        projs.push(readProjektFromFabRow(r));
      });
      var nonEmpty = projs.filter(function (p) {
        return p !== '';
      });
      if (nonEmpty.length === 0) return '';
      var first = nonEmpty[0];
      for (var i = 1; i < nonEmpty.length; i++) {
        if (nonEmpty[i] !== first) return '';
      }
      return first;
    }

    function resolveMontageberichtAnsprechperson(job) {
      if (!job || typeof job !== 'object') return '';
      if (Array.isArray(job.job_contacts)) {
        for (var i = 0; i < job.job_contacts.length; i++) {
          var c = job.job_contacts[i] || {};
          var name = (
            c.contact_name != null ? String(c.contact_name) :
            (c.name != null ? String(c.name) :
            (c.contactPerson != null ? String(c.contactPerson) :
            (c.ansprechpartner != null ? String(c.ansprechpartner) : '')))
          ).trim();
          if (name) return name;
        }
      }
      var direct = [
        job.baustellen_ansprechpartner,
        job.job_contact_name,
        job.contact_person,
        job.contact_name,
        job.ansprechpartner
      ];
      for (var j = 0; j < direct.length; j++) {
        var val = (direct[j] != null ? String(direct[j]) : '').trim();
        if (val) return val;
      }
      return '';
    }

    function renderKopfdaten(job) {
      var techName = '';
      try {
        var techEl = document.getElementById('technicianName');
        if (techEl) techName = techEl.textContent || '';
      } catch (e) {}
      var k = {
        kunde: job.customer_name || '',
        datum: formatDateRange(job.start_datetime, job.end_datetime),
        servicetechniker: techName,
        ansprechperson: resolveMontageberichtAnsprechperson(job)
      };
      var fabList = [];
      var parsed = null;
      if (job.fabrikationsnummern) {
        try {
          parsed = JSON.parse(job.fabrikationsnummern);
          if (Array.isArray(parsed)) {
            fabList = parsed.map(function (r) {
              if (r && typeof r === 'object' && (r.fabrikationsnummer || r.Fabrikationsnummer)) return String(r.fabrikationsnummer || r.Fabrikationsnummer).trim();
              if (r != null && (typeof r === 'string' || typeof r === 'number')) return String(r).trim();
              return '';
            }).filter(Boolean);
          }
        } catch (e) {
          fabList = (job.fabrikationsnummern || '').split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
        }
      }
      var geliefertUeber = '';
      k.fabrikationsnummern = fabList.map(function (f, i) {
        var type = '';
        var position = '';
        var gu = '';
        var fn = (f != null && f !== '') ? String(f).trim() : '';
        if (parsed && Array.isArray(parsed) && parsed[i]) {
          var r = parsed[i];
          type = (r.type || r.Type || '').toString().trim();
          position = (r.position || r.Position || '').toString().trim();
          gu = (r.geliefert_ueber || r.geliefertUeber || '').toString().trim();
          if (gu && !geliefertUeber) geliefertUeber = gu;
          if (!fn && (r.fabrikationsnummer || r.Fabrikationsnummer)) fn = String(r.fabrikationsnummer || r.Fabrikationsnummer).trim();
        }
        return { fabrikationsnummer: fn, type: type, position: position, geliefert_ueber: gu, bemerkungen: '' };
      });
      k.geliefertUeber = geliefertUeber || (k.fabrikationsnummern[0] && k.fabrikationsnummern[0].geliefert_ueber) || '';
      var auftragsnr = (job.job_number != null && String(job.job_number).trim()) ? String(job.job_number).trim() : '';
      kopfdatenEl.innerHTML = '<div><strong>Kunde:</strong> ' + escapeHtml(k.kunde) + '</div>' +
        (auftragsnr ? '<div class="kopfdaten-secondary"><strong>Auftragsnr.:</strong> ' + escapeHtml(auftragsnr) + '</div>' : '') +
        '<div class="kopfdaten-fn"><strong>FN.:</strong> ' + escapeHtml(fabList.join(', ')) + '</div>' +
        '<div class="kopfdaten-secondary">' + escapeHtml(k.geliefertUeber) + '</div>' +
        '<div><strong>Datum:</strong> ' + escapeHtml(k.datum) + '</div>' +
        '<div><strong>Servicetechniker:</strong> ' + escapeHtml(k.servicetechniker) + '</div>' +
        '<div><strong>Ansprechperson:</strong> ' + escapeHtml(k.ansprechperson) + '</div>';
      return k;
    }

    function renderFabBemerkungen(fabList) {
      var html = '';
      fabList.forEach(function (f) {
        var fn = (f && (f.fabrikationsnummer ?? f.Fabrikationsnummer)) != null ? String(f.fabrikationsnummer ?? f.Fabrikationsnummer).trim() : '';
        if (fn === 'undefined') fn = '';
        var t = (f && (f.type ?? f.Type)) != null ? String(f.type ?? f.Type).trim() : '';
        var p = (f && (f.position ?? f.Position)) != null ? String(f.position ?? f.Position).trim() : '';
        var rowInpStyle = 'flex:1 1 8rem;min-width:6rem;box-sizing:border-box;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--bg);color:var(--text);font-size:0.9rem';
        var rowFlex = 'display:flex;align-items:center;gap:0.4rem;flex-wrap:nowrap;width:100%';
        html += '<div class="montagebericht-fab-block" data-fab="' + escapeHtml(fn) + '" style="margin-bottom:1rem;border:1px solid var(--accent);border-radius:6px;overflow:hidden;background:var(--card)">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.9rem" class="montagebericht-fab-kopf">';
        html += '<tr>';
        html += '<td style="border:1px solid var(--accent);padding:0.45rem 0.55rem;vertical-align:middle;width:22%;background:var(--bg)"><strong>FN.:</strong> ' + escapeHtml(fn || '–') + '</td>';
        html += '<td style="border:1px solid var(--accent);padding:0.45rem 0.55rem;width:39%;vertical-align:middle;background:var(--bg)"><div style="' + rowFlex + '"><strong>Type:</strong>' +
          '<input type="text" data-mb-type="" autocomplete="off" value="' + escapeHtml(t) + '" placeholder="aus Anlagenstamm" style="' + rowInpStyle + '"></div></td>';
        html += '<td style="border:1px solid var(--accent);padding:0.45rem 0.55rem;width:39%;vertical-align:middle;background:var(--bg)"><div style="' + rowFlex + '"><strong>Pos.Nr.:</strong>' +
          '<input type="text" data-mb-position="" autocomplete="off" value="' + escapeHtml(p) + '" placeholder="aus Anlagenstamm" style="' + rowInpStyle + '"></div></td>';
        html += '</tr></table>';
        html += '<div style="padding:0.5rem 0.55rem 0.6rem">';
        html += '<label class="muted" style="font-size:0.8rem;display:block;margin-bottom:0.25rem">Bemerkungen / Textbausteine</label>';
        html += '<div data-fab-rich="' + escapeHtml(fn) + '" data-mb-editor="fab" class="mb-rich-editor" contenteditable="true" spellcheck="true" style="min-height:3rem" title="Textbaustein hierher ziehen"></div>';
        html += '</div></div>';
      });
      fabContainer.innerHTML = html;
      initFabBemerkungenDropTargets();
    }

    function stripHtmlForPlain(html) {
      if (!html) return '';
      var d = document.createElement('div');
      d.innerHTML = html;
      return (d.textContent || d.innerText || '').trim();
    }

    function normalizeMontageberichtHtml(html) {
      var raw = (html == null) ? '' : String(html);
      var d = document.createElement('div');
      d.innerHTML = raw;
      d.querySelectorAll('script,style').forEach(function (n) { n.remove(); });
      d.querySelectorAll('*').forEach(function (node) {
        var tag = (node.tagName || '').toLowerCase();
        if (['b', 'strong', 'i', 'em', 'u', 'span', 'div', 'p', 'ul', 'ol', 'li', 'br'].indexOf(tag) === -1) {
          var txt = document.createTextNode(node.textContent || '');
          node.parentNode.replaceChild(txt, node);
          return;
        }
        var attrs = Array.prototype.slice.call(node.attributes || []);
        attrs.forEach(function (a) {
          if (a.name !== 'style') node.removeAttribute(a.name);
        });
      });
      return d.innerHTML;
    }

    function setRichEditorHtml(el, html) {
      if (!el) return;
      el.innerHTML = normalizeMontageberichtHtml(html || '');
      autoResizeFabTextarea(el);
    }

    function getRichEditorHtml(el) {
      if (!el) return '';
      return normalizeMontageberichtHtml(el.innerHTML || '');
    }

    function getRichEditorPlain(el) {
      return stripHtmlForPlain(getRichEditorHtml(el));
    }

    function autoResizeFabTextarea(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, 52) + 'px';
    }

    function ensureEditorFocus(el) {
      if (!el) return false;
      el.focus();
      montageberichtActiveEditor = el;
      return true;
    }

    function insertHtmlIntoEditor(el, html) {
      if (!ensureEditorFocus(el)) return;
      var safeHtml = normalizeMontageberichtHtml(html);
      try {
        document.execCommand('insertHTML', false, safeHtml);
      } catch (e) {
        el.innerHTML += safeHtml;
      }
      autoResizeFabTextarea(el);
    }

    function extractTextbausteineFromHtml(html, plainFallback) {
      var rawHtml = normalizeMontageberichtHtml(html || '');
      var div = document.createElement('div');
      div.innerHTML = rawHtml;
      var out = [];
      div.querySelectorAll('li').forEach(function (li) {
        var liHtml = normalizeMontageberichtHtml(li.innerHTML || '');
        var liPlain = stripHtmlForPlain(liHtml);
        if (liPlain) out.push({ text: liPlain, html: liHtml });
      });
      if (out.length > 0) return out;
      var plain = (plainFallback || stripHtmlForPlain(rawHtml) || '').trim();
      if (!plain) return [];
      return plain.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (t) {
        return { text: t, html: escapeHtml(t) };
      });
    }

    function updateMontageberichtToolbarState() {
      if (!toolbarEl || !montageberichtActiveEditor) return;
      var sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || !montageberichtActiveEditor.contains(sel.anchorNode)) return;
      ['bold', 'italic', 'underline', 'insertUnorderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'].forEach(function (cmd) {
        var btn = toolbarEl.querySelector('[data-mb-cmd="' + cmd + '"]');
        if (!btn) return;
        var active = false;
        try { active = !!document.queryCommandState(cmd); } catch (e) { active = false; }
        btn.classList.toggle('active', active);
      });
    }

    function bindMontageberichtToolbar() {
      if (!toolbarEl || toolbarEl.dataset.mbBound) return;
      toolbarEl.dataset.mbBound = '1';
      if (typeof document.execCommand === 'function') {
        try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      }
      toolbarEl.querySelectorAll('[data-mb-cmd]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var cmd = btn.getAttribute('data-mb-cmd');
          if (!cmd || !ensureEditorFocus(montageberichtActiveEditor)) return;
          try { document.execCommand(cmd, false, null); } catch (e) {}
          updateMontageberichtToolbarState();
          autoResizeFabTextarea(montageberichtActiveEditor);
        });
      });
      if (toolbarFont) {
        toolbarFont.addEventListener('change', function () {
          if (!ensureEditorFocus(montageberichtActiveEditor)) return;
          try { document.execCommand('fontName', false, toolbarFont.value || 'Calibri'); } catch (e) {}
          autoResizeFabTextarea(montageberichtActiveEditor);
        });
      }
      if (toolbarSize) {
        toolbarSize.addEventListener('change', function () {
          if (!ensureEditorFocus(montageberichtActiveEditor)) return;
          try { document.execCommand('fontSize', false, toolbarSize.value || '3'); } catch (e) {}
          autoResizeFabTextarea(montageberichtActiveEditor);
        });
      }
      document.addEventListener('selectionchange', updateMontageberichtToolbarState);
      form.addEventListener('focusin', function (ev) {
        var editor = ev.target && ev.target.closest('[data-mb-editor], [data-fab-rich]');
        if (!editor) return;
        montageberichtActiveEditor = editor;
        updateMontageberichtToolbarState();
      });
    }

    function initFabBemerkungenDropTargets() {
      fabContainer.querySelectorAll('[data-fab-rich]').forEach(function (el) {
        el.style.overflow = 'hidden';
        el.addEventListener('input', function () { autoResizeFabTextarea(el); });
        autoResizeFabTextarea(el);
        el.addEventListener('dragover', function (e) {
          if (e.dataTransfer.types.indexOf('text/plain') >= 0 || e.dataTransfer.types.indexOf('text/html') >= 0) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            el.classList.add('drop-target');
          }
        });
        el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
        el.addEventListener('drop', function (e) {
          el.classList.remove('drop-target');
          e.preventDefault();
          var html = (e.dataTransfer.getData('text/html') || '').trim();
          var text = (e.dataTransfer.getData('text/plain') || stripHtmlForPlain(html) || '').trim();
          if (!html && text) {
            html = '<ul><li>' + escapeHtml(text.replace(/\r?\n/g, ' ').trim()) + '</li></ul>';
          } else if (html && html.indexOf('<li') === -1 && text) {
            html = '<ul><li>' + escapeHtml(text.replace(/\r?\n/g, ' ').trim()) + '</li></ul>';
          }
          if (html) insertHtmlIntoEditor(el, html);
        });
      });
      bindMontageberichtToolbar();
    }

    var montageberichtTbCategories = [];

    function renderMontageberichtChips() {
      var listEl = document.getElementById('montageberichtTbList');
      var categorySelect = document.getElementById('montageberichtTbCategory');
      if (!listEl) return;
      var categoryId = categorySelect && categorySelect.value ? parseInt(categorySelect.value, 10) : null;
      var items = [];
      if (categoryId) {
        var cat = montageberichtTbCategories.find(function (c) { return c.id === categoryId; });
        if (cat && cat.items) items = cat.items;
      } else {
        montageberichtTbCategories.forEach(function (cat) {
          (cat.items || []).forEach(function (item) { items.push(item); });
        });
      }
      var html = '';
      items.forEach(function (item) {
        var plain = stripHtmlForPlain(item.text || '').slice(0, 60) + (stripHtmlForPlain(item.text || '').length > 60 ? '…' : '');
        html += '<div class="montagebericht-tb-chip" draggable="true" data-text="' + escapeHtml(item.text || '') + '" title="' + escapeHtml(plain) + '">' + escapeHtml(plain) + '</div>';
      });
      listEl.innerHTML = html || '<span class="muted" style="font-size:0.8rem">Keine Textbausteine</span>';
      listEl.querySelectorAll('.montagebericht-tb-chip').forEach(function (chip) {
        chip.addEventListener('dragstart', function (e) {
          chip.classList.add('dragging');
          var text = chip.dataset.text || '';
          e.dataTransfer.setData('text/plain', stripHtmlForPlain(text));
          e.dataTransfer.setData('text/html', text);
          e.dataTransfer.effectAllowed = 'copy';
        });
        chip.addEventListener('dragend', function () { chip.classList.remove('dragging'); });
      });
    }

    async function loadMontageberichtTextbausteine() {
      var listEl = document.getElementById('montageberichtTbList');
      var categorySelect = document.getElementById('montageberichtTbCategory');
      if (!listEl) return;
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) { listEl.innerHTML = '<span class="muted" style="font-size:0.8rem">Dispo-URL in Einstellungen eintragen</span>'; return; }
      try {
        var r = await fetch(API_BASE + '/api/textbausteine_list?base_url=' + encodeURIComponent(baseUrl) + '&technician_id=' + getTechId(), { headers: { 'X-Technician-Id': String(getTechId()) } });
        var data = await r.json();
        if (!data.ok || !data.categories) {
          montageberichtTbCategories = [];
          if (categorySelect) categorySelect.innerHTML = '<option value="">– Kategorie –</option>';
          listEl.innerHTML = '<span class="muted" style="font-size:0.8rem">Keine Textbausteine</span>';
          return;
        }
        montageberichtTbCategories = data.categories;
        if (categorySelect) {
          categorySelect.innerHTML = '<option value="">Alle</option>' +
            montageberichtTbCategories.map(function (cat) {
              return '<option value="' + cat.id + '">' + escapeHtml(cat.name || '') + '</option>';
            }).join('');
          if (!categorySelect.dataset.mbBound) {
            categorySelect.dataset.mbBound = '1';
            categorySelect.addEventListener('change', renderMontageberichtChips);
          }
        }
        renderMontageberichtChips();
      } catch (e) {
        listEl.innerHTML = '<span class="muted" style="font-size:0.8rem">Fehler: ' + escapeHtml(e.message) + '</span>';
      }
    }

    function openAndResetMontageberichtForm() {
      if (divMontage) divMontage.style.display = 'block';
      try { delete window._kuklaMontageberichtSign; } catch (e) { window._kuklaMontageberichtSign = null; }
      montageberichtJobData = null;
      if (jobSelect) jobSelect.innerHTML = '<option value="">Lade…</option>';
      if (grundInput) setRichEditorHtml(grundInput, '');
      var bemerkEl = document.getElementById('montageberichtBemerkungen');
      if (bemerkEl) setRichEditorHtml(bemerkEl, '');
      var langEl = document.getElementById('montageberichtLang');
      if (langEl) langEl.value = 'de';
      var projEl = document.getElementById('montageberichtProjekt');
      if (projEl) projEl.value = '';
      if (kopfdatenEl) kopfdatenEl.innerHTML = '';
      if (fabContainer) fabContainer.innerHTML = '';
      bindMontageberichtToolbar();
      loadMontageberichtJobs().then(function (jobs) {
        if (jobSelect) {
          jobSelect.innerHTML = '<option value="">-- Auftrag wählen --</option>' +
            jobs.map(function (j) { return '<option value="' + j.id + '">' + escapeHtml((j.job_number || '') + ' ' + (j.customer_name || '')) + '</option>'; }).join('');
        }
      });
      loadMontageberichtTextbausteine();
    }
    window.openAndResetMontageberichtForm = openAndResetMontageberichtForm;

    if (btnAbbrechen) btnAbbrechen.addEventListener('click', function () { openAndResetMontageberichtForm(); });
    if (jobSelect) {
      jobSelect.addEventListener('change', async function () {
        var id = parseInt(this.value, 10);
        if (!id) {
          kopfdatenEl.innerHTML = ''; fabContainer.innerHTML = ''; montageberichtJobData = null;
          if (grundInput) setRichEditorHtml(grundInput, '');
          var bemerkEl = document.getElementById('montageberichtBemerkungen'); if (bemerkEl) setRichEditorHtml(bemerkEl, '');
          var langEl = document.getElementById('montageberichtLang'); if (langEl) langEl.value = 'de';
          var projElClear = document.getElementById('montageberichtProjekt'); if (projElClear) projElClear.value = '';
          return;
        }
        try {
          montageberichtJobData = await loadJobWithAnlagenstamm(id);
          var k = renderKopfdaten(montageberichtJobData);
          renderFabBemerkungen(k.fabrikationsnummern || []);
          var projEl = document.getElementById('montageberichtProjekt');
          if (projEl) projEl.value = deriveMontageberichtProjektFromAnlagenstamm(montageberichtJobData);
          try {
            var loadR = await fetch(API_BASE + '/api/protokolle/montagebericht?job_id=' + id, { headers: { 'X-Technician-Id': String(getTechId()) } });
            var loadData = await loadR.json();
            if (loadData.ok && loadData.data) {
              var d = loadData.data;
              if (grundInput) setRichEditorHtml(grundInput, d.grundDesEinsatzes_html || d.grundDesEinsatzes || '');
              var bemerkEl = document.getElementById('montageberichtBemerkungen');
              if (bemerkEl) setRichEditorHtml(bemerkEl, d.bemerkungen_html || ((d.bemerkungen != null && d.bemerkungen !== '') ? d.bemerkungen : ''));
              var langEl = document.getElementById('montageberichtLang'); if (langEl && d.language) langEl.value = d.language;
              if (projEl && d.projekt != null && String(d.projekt).trim()) projEl.value = String(d.projekt).trim();
              if (Array.isArray(d.fabBemerkungen) && d.fabBemerkungen.length) {
                fabContainer.querySelectorAll('.montagebericht-fab-block').forEach(function (block) {
                  var fab = (block.getAttribute('data-fab') || '').trim();
                  var fb = d.fabBemerkungen.find(function (x) { return (x.fabrikationsnummer || '') === fab; });
                  if (!fb) return;
                  var ti = block.querySelector('input[data-mb-type]');
                  var pi = block.querySelector('input[data-mb-position]');
                  if (ti && fb.type != null) ti.value = String(fb.type);
                  if (pi && fb.position != null) pi.value = String(fb.position);
                  var ta = block.querySelector('[data-fab-rich]');
                  if (ta) {
                    var valHtml = fb.bemerkungen_html || '';
                    if (!valHtml && fb.bemerkungen) valHtml = '<p>' + escapeHtml(String(fb.bemerkungen)).replace(/\r?\n/g, '<br>') + '</p>';
                    if (!valHtml && Array.isArray(fb.textbausteine) && fb.textbausteine.length) {
                      valHtml = '<ul>' + fb.textbausteine.map(function (t) { return '<li>' + escapeHtml((t && t.text) || '') + '</li>'; }).join('') + '</ul>';
                    }
                    setRichEditorHtml(ta, valHtml);
                  }
                });
              }
            }
          } catch (loadErr) { /* gespeicherte Daten optional */ }
        } catch (e) {
          kopfdatenEl.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
        }
      });
    }
    var btnSignMb = document.getElementById('btnMontageberichtSign');
    if (btnSignMb) {
      btnSignMb.addEventListener('click', function () {
        var st = window._kuklaMontageberichtSign;
        if (!st || !st.pdfRel || !st.localJobId) {
          alert('Zuerst „PDF & DOCX erstellen“ ausführen – danach ist der Montagebericht-PDF für die Signatur verfügbar.');
          return;
        }
        if (typeof window.SignatureWidget === 'undefined' || typeof window.SignatureWidget.open !== 'function') {
          alert('Signatur-Widget nicht geladen.');
          return;
        }
        var baseUrl = getDispoBaseUrl();
        if (!baseUrl) {
          alert('Dispo-Server-URL in den Einstellungen setzen.');
          return;
        }
        var techId = getTechId();
        var techName = '';
        try {
          var tel = document.getElementById('technicianName');
          if (tel) techName = (tel.textContent || '').trim();
        } catch (err) {}
        btnSignMb.disabled = true;
        fetch(API_BASE + '/api/montagebericht_signature_stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
          body: JSON.stringify({
            localJobId: st.localJobId,
            relativePath: st.pdfRel,
            baseUrl: baseUrl,
            serverUsername: getDispoUsername(),
            serverPassword: getDispoPassword()
          })
        })
          .then(function (r) {
            return r.text().then(function (t) {
              return { ok: r.ok, status: r.status, text: t };
            });
          })
          .then(function (res) {
            var stageJ;
            try {
              stageJ = JSON.parse(res.text || '{}');
            } catch (e) {
              throw new Error('Staging-Antwort ist kein JSON.');
            }
            if (!res.ok || !stageJ.staging_key) {
              throw new Error((stageJ && stageJ.error) ? stageJ.error : 'PDF-Staging fehlgeschlagen.');
            }
            var stagingKey = stageJ.staging_key;
            window.SignatureWidget.open({
              refType: 'montagebericht',
              refId: 0,
              stagingKey: stagingKey,
              signerRole: 'techniker',
              technicianUserId: techId,
              signerUserId: techId,
              signerNameSuggestion: techName,
              customSessionOpen: function () {
                return fetch(API_BASE + '/api/dispo_signature_session_open', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
                  body: JSON.stringify({
                    baseUrl: baseUrl,
                    serverUsername: getDispoUsername(),
                    serverPassword: getDispoPassword(),
                    payload: {
                      ref_type: 'montagebericht',
                      ref_id: 0,
                      signer_role: 'techniker',
                      pdf_language: 'DE',
                      staging_key: stagingKey,
                      technician_id: techId
                    }
                  })
                }).then(function (r2) {
                  return r2.text().then(function (t2) {
                    var j2;
                    try {
                      j2 = JSON.parse(t2 || '{}');
                    } catch (e2) {
                      throw new Error('Ungültige JSON-Antwort (Session).');
                    }
                    if (!r2.ok) throw new Error((j2 && j2.error) ? j2.error : 'Session HTTP ' + r2.status);
                    if (j2.ok === false) throw new Error((j2 && j2.error) ? j2.error : 'Session fehlgeschlagen');
                    return j2;
                  });
                });
              },
              customSubmit: function (payload) {
                return fetch(API_BASE + '/api/dispo_signature_submit', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
                  body: JSON.stringify({
                    baseUrl: baseUrl,
                    serverUsername: getDispoUsername(),
                    serverPassword: getDispoPassword(),
                    payload: payload
                  })
                }).then(function (r3) {
                  return r3.text().then(function (t3) {
                    var j3;
                    try {
                      j3 = JSON.parse(t3 || '{}');
                    } catch (e3) {
                      throw new Error('Ungültige JSON-Antwort (Submit).');
                    }
                    if (!r3.ok) throw new Error((j3 && j3.error) ? j3.error : 'Submit HTTP ' + r3.status);
                    if (j3.ok === false) throw new Error((j3 && j3.error) ? j3.error : 'Signatur fehlgeschlagen');
                    return j3;
                  });
                });
              },
              onSigned: function () {
                if (typeof showToast === 'function') showToast('Montagebericht signiert (Dispo).');
              },
              onCancel: function () {}
            });
          })
          .catch(function (err) {
            alert(err && err.message ? err.message : 'Signatur fehlgeschlagen.');
          })
          .then(function () {
            btnSignMb.disabled = false;
          });
      });
    }
    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var submitBtn = e.submitter;
        var jsonOnly = !!(submitBtn && submitBtn.id === 'btnMontageberichtSaveJson');
        if (!submitBtn || (submitBtn.id !== 'btnMontageberichtSaveJson' && submitBtn.id !== 'btnMontageberichtSavePdf')) {
          return;
        }
        if (!montageberichtJobData) { alert('Bitte Auftrag wählen.'); return; }
        var fabBemerkungen = [];
        fabContainer.querySelectorAll('.montagebericht-fab-block').forEach(function (block) {
          var fn = (block.getAttribute('data-fab') || '').trim();
          if (fn === 'undefined') fn = '';
          var typeInp = block.querySelector('input[data-mb-type]');
          var posInp = block.querySelector('input[data-mb-position]');
          var ta = block.querySelector('[data-fab-rich]');
          var t = typeInp ? (typeInp.value || '').trim() : '';
          var pos = posInp ? (posInp.value || '').trim() : '';
          var bemerkungen = ta ? getRichEditorPlain(ta) : '';
          var bemerkungenHtml = ta ? getRichEditorHtml(ta) : '';
          var textbausteine = extractTextbausteineFromHtml(bemerkungenHtml, bemerkungen);
          fabBemerkungen.push({
            fabrikationsnummer: fn,
            type: t,
            position: pos,
            bemerkungen: bemerkungen,
            bemerkungen_html: bemerkungenHtml,
            textbausteine: textbausteine
          });
        });
        var parsedFab = montageberichtJobData.fabrikationsnummern ? (function () {
          try {
            var p = JSON.parse(montageberichtJobData.fabrikationsnummern);
            return Array.isArray(p) ? p : [];
          } catch (e) { return []; }
        }()) : [];
        var fabWithDetails = parsedFab.map(function (r) {
          return {
            fabrikationsnummer: (r.fabrikationsnummer || r.Fabrikationsnummer || '').toString().trim(),
            type: (r.type || r.Type || '').toString().trim(),
            position: (r.position || r.Position || '').toString().trim(),
            geliefert_ueber: (r.geliefert_ueber || r.geliefertUeber || '').toString().trim()
          };
        });
        fabContainer.querySelectorAll('.montagebericht-fab-block').forEach(function (block) {
          var fn = (block.getAttribute('data-fab') || '').trim();
          var typeInp = block.querySelector('input[data-mb-type]');
          var posInp = block.querySelector('input[data-mb-position]');
          var t = typeInp ? (typeInp.value || '').trim() : '';
          var pos = posInp ? (posInp.value || '').trim() : '';
          for (var i = 0; i < fabWithDetails.length; i++) {
            if (fabWithDetails[i].fabrikationsnummer === fn) {
              fabWithDetails[i].type = t;
              fabWithDetails[i].position = pos;
              break;
            }
          }
        });
        var geliefertUeberVal = (fabWithDetails[0] && fabWithDetails[0].geliefert_ueber) || '';
        var bemerkungenEl = document.getElementById('montageberichtBemerkungen');
        var bemerkungenVal = bemerkungenEl ? getRichEditorPlain(bemerkungenEl) : '';
        var bemerkungenValHtml = bemerkungenEl ? getRichEditorHtml(bemerkungenEl) : '';
        var grundVal = grundInput ? getRichEditorPlain(grundInput) : '';
        var grundValHtml = grundInput ? getRichEditorHtml(grundInput) : '';
        var projektVal = (document.getElementById('montageberichtProjekt') && document.getElementById('montageberichtProjekt').value) ? document.getElementById('montageberichtProjekt').value.trim() : '';
        if (!projektVal) {
          alert('Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm oder manuell).');
          return;
        }
        var kopfdaten = {
          kunde: montageberichtJobData.customer_name,
          projekt: projektVal,
          datum: formatDateRange(montageberichtJobData.start_datetime, montageberichtJobData.end_datetime),
          servicetechniker: (document.getElementById('technicianName') || {}).textContent || '',
          ansprechperson: resolveMontageberichtAnsprechperson(montageberichtJobData),
          geliefertUeber: geliefertUeberVal,
          fabrikationsnummern: fabWithDetails,
          bemerkungen: bemerkungenVal,
          bemerkungen_html: bemerkungenValHtml
        };
        var body = {
          job_id: parseInt(jobSelect.value, 10),
          language: document.getElementById('montageberichtLang').value || 'de',
          kopfdaten: kopfdaten,
          fabBemerkungen: fabBemerkungen,
          grundDesEinsatzes: grundVal,
          grundDesEinsatzes_html: grundValHtml,
          freitext: '',
          jsonOnly: jsonOnly,
          dispoBaseUrl: getDispoBaseUrl(),
          technicianId: getTechId(),
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        };
        try {
          if (submitBtn) submitBtn.disabled = true;
          var r = await fetch(API_BASE + '/api/protokolle/montagebericht', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
            body: JSON.stringify(body)
          });
          var data = await r.json().catch(function () { return {}; });
          if (!r.ok || !data.ok) {
            alert('Fehler: ' + (data.error || r.status));
            return;
          }
          if (!data.jsonOnly && data.saved && data.saved.length) {
            window._kuklaMontageberichtSign = {
              localJobId: parseInt(jobSelect.value, 10),
              pdfRel: data.saved[0]
            };
          }
          if (data.warning) {
            console.warn('[Montagebericht] Warnung vom Server:', data.warning);
          }
          if (typeof showToast === 'function') {
            if (data.jsonOnly) showToast('Zwischenstand gespeichert (nur Daten, kein PDF/DOCX).');
            else showToast('Montagebericht gespeichert (inkl. PDF & DOCX).');
          }
          if (!data.jsonOnly && typeof showView === 'function') showView('start');
        } catch (err) {
          alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt'));
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

  })();

  (function initProtokolleKontrollwiegungen() {
    var jobSelect = document.getElementById('kontrollwiegungJob');
    var kopfdatenEl = document.getElementById('kontrollwiegungKopfdaten');
    var fabSelect = document.getElementById('kontrollwiegungFab');
    var datumEl = document.getElementById('kontrollwiegungDatum');
    var zeilenContainer = document.getElementById('kontrollwiegungZeilen');
    var addRowBtn = document.getElementById('kontrollwiegungAddRow');
    var form = document.getElementById('kontrollwiegungForm');
    var pdfBtn = document.getElementById('kontrollwiegungPdf');
    var abbrechenBtn = document.getElementById('kontrollwiegungAbbrechen');

    var kontrollwiegungJobData = null;
    var wiegungen = [];
    var lastProtokollId = null;

    function escapeHtml(s) {
      if (s == null) return '';
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    function formatDateRange(start, end) {
      if (!start && !end) return '';
      var s = (start || '').toString().slice(0, 10);
      var e = (end || '').toString().slice(0, 10);
      if (s && e && s !== e) return s + ' – ' + e;
      return s || e;
    }

    function calcRow(bandwaage, tara, brutto) {
      var kontrollwaage = (parseFloat(brutto) || 0) - (parseFloat(tara) || 0);
      var fehlerKg = (parseFloat(bandwaage) || 0) - kontrollwaage;
      var fehlerProzent = kontrollwaage !== 0 ? (fehlerKg / kontrollwaage) * 100 : null;
      return { kontrollwaage: kontrollwaage, fehlerKg: fehlerKg, fehlerProzent: fehlerProzent };
    }

    function renderKopfdatenKontrollwiegung(job) {
      var techName = '';
      try {
        var techEl = document.getElementById('technicianName');
        if (techEl) techName = techEl.textContent || '';
      } catch (e) {}
      var datum = formatDateRange(job.start_datetime, job.end_datetime);
      var fabList = [];
      if (job.fabrikationsnummern) {
        try {
          var parsed = JSON.parse(job.fabrikationsnummern);
          if (Array.isArray(parsed)) {
            fabList = parsed.map(function (r) {
              if (r && typeof r === 'object' && (r.fabrikationsnummer || r.Fabrikationsnummer)) return String(r.fabrikationsnummer || r.Fabrikationsnummer).trim();
              if (r != null && (typeof r === 'string' || typeof r === 'number')) return String(r).trim();
              return '';
            }).filter(Boolean);
          }
        } catch (e) {
          fabList = (job.fabrikationsnummern || '').split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
        }
      }
      kopfdatenEl.innerHTML = '<div><strong>Kunde:</strong> ' + escapeHtml(job.customer_name || '') + '</div>' +
        '<div><strong>Projekt:</strong> ' + escapeHtml(job.job_number || job.description || '') + '</div>' +
        '<div><strong>FN:</strong> ' + escapeHtml(fabList.join(', ')) + '</div>' +
        '<div><strong>Datum:</strong> ' + escapeHtml(datum) + '</div>' +
        '<div><strong>Servicetechniker:</strong> ' + escapeHtml(techName) + '</div>';
    }

    function fillFabSelect(job) {
      var opts = ['<option value="">– aus Auftrag –</option>'];
      var fabList = [];
      if (job && job.fabrikationsnummern) {
        try {
          var parsed = JSON.parse(job.fabrikationsnummern);
          if (Array.isArray(parsed)) {
            parsed.forEach(function (r) {
              var fn = (r && (r.fabrikationsnummer || r.Fabrikationsnummer)) != null ? String(r.fabrikationsnummer || r.Fabrikationsnummer).trim() : '';
              if (fn) fabList.push(fn);
            });
          }
        } catch (e) {
          fabList = (job.fabrikationsnummern || '').split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
        }
      }
      fabList.forEach(function (fn) { opts.push('<option value="' + escapeHtml(fn) + '">' + escapeHtml(fn) + '</option>'); });
      fabSelect.innerHTML = opts.join('');
    }

    function getRowData(rowEl) {
      var num = (rowEl.querySelector('.kw-num') || {}).textContent || '';
      var bandwaage = (rowEl.querySelector('input[name="bandwaage_kg"]') || {}).value;
      var tara = (rowEl.querySelector('input[name="tara_kg"]') || {}).value;
      var brutto = (rowEl.querySelector('input[name="brutto_kg"]') || {}).value;
      var leistung = (rowEl.querySelector('input[name="leistung_th"]') || {}).value;
      var bemerkung = (rowEl.querySelector('input[name="bemerkung"], textarea[name="bemerkung"]') || {}).value;
      var teilung = (rowEl.querySelector('input[name="teilung_kontrollwaage"]') || {}).value;
      var bereichMax = (rowEl.querySelector('input[name="bereich_max"]') || {}).value;
      var letzteEichung = (rowEl.querySelector('input[name="letzte_eichung"]') || {}).value;
      return {
        bandwaage_kg: bandwaage,
        tara_kg: tara,
        brutto_kg: brutto,
        leistung_th: leistung,
        bemerkung: bemerkung || '',
        teilung_kontrollwaage: teilung || '',
        bereich_max: bereichMax || '',
        letzte_eichung: letzteEichung || ''
      };
    }

    function updateRowCalculations(rowEl) {
      var bandwaage = parseFloat((rowEl.querySelector('input[name="bandwaage_kg"]') || {}).value) || 0;
      var tara = parseFloat((rowEl.querySelector('input[name="tara_kg"]') || {}).value) || 0;
      var brutto = parseFloat((rowEl.querySelector('input[name="brutto_kg"]') || {}).value) || 0;
      var c = calcRow(bandwaage, tara, brutto);
      var kwEl = rowEl.querySelector('.kw-kontrollwaage');
      var fkEl = rowEl.querySelector('.kw-fehler-kg');
      var fpEl = rowEl.querySelector('.kw-fehler-prozent');
      if (kwEl) kwEl.textContent = c.kontrollwaage.toFixed(2);
      if (fkEl) fkEl.textContent = c.fehlerKg.toFixed(2);
      if (fpEl) fpEl.textContent = c.fehlerProzent != null ? c.fehlerProzent.toFixed(2) + ' %' : '–';
    }

    function buildRowHtml(idx) {
      var n = idx + 1;
      var w = wiegungen[idx] || {};
      var style = 'margin-bottom:0.5rem;padding:0.75rem;background:var(--bg);border:1px solid var(--accent);border-radius:4px';
      var row = '<div class="kontrollwiegung-row" data-idx="' + idx + '" style="' + style + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem">' +
        '<span class="kw-num" style="font-weight:bold">' + n + '.</span>' +
        '<button type="button" class="btn btn-ghost kw-remove" style="font-size:0.85rem">Wiegung entfernen</button></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:0.5rem">' +
        '<div class="form-group"><label>Bandwaage [kg]</label><input type="number" step="any" name="bandwaage_kg" value="' + escapeHtml((w.bandwaage_kg != null ? w.bandwaage_kg : '')) + '" placeholder="kg" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Tara [kg]</label><input type="number" step="any" name="tara_kg" value="' + escapeHtml((w.tara_kg != null ? w.tara_kg : '')) + '" placeholder="kg" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Brutto [kg]</label><input type="number" step="any" name="brutto_kg" value="' + escapeHtml((w.brutto_kg != null ? w.brutto_kg : '')) + '" placeholder="kg" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Leistung [t/h]</label><input type="number" step="any" name="leistung_th" value="' + escapeHtml((w.leistung_th != null ? w.leistung_th : '')) + '" placeholder="t/h" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Teilung Kontrollwaage</label><input type="text" name="teilung_kontrollwaage" value="' + escapeHtml((w.teilung_kontrollwaage != null ? w.teilung_kontrollwaage : '')) + '" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Bereich max</label><input type="text" name="bereich_max" value="' + escapeHtml((w.bereich_max != null ? w.bereich_max : '')) + '" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group"><label>Letzte Eichung</label><input type="text" name="letzte_eichung" value="' + escapeHtml((w.letzte_eichung != null ? w.letzte_eichung : '')) + '" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label>Bemerkung</label><input type="text" name="bemerkung" value="' + escapeHtml((w.bemerkung != null ? w.bemerkung : '')) + '" style="width:100%;padding:0.4rem;border:1px solid var(--accent);border-radius:4px;background:var(--card);color:var(--text)"></div>' +
        '</div>' +
        '<div style="margin-top:0.5rem;font-size:0.9rem;color:var(--text-muted)">' +
        'Kontrollwaage [kg]: <span class="kw-kontrollwaage">–</span> &nbsp; Fehler [kg]: <span class="kw-fehler-kg">–</span> &nbsp; Fehler [%]: <span class="kw-fehler-prozent">–</span>' +
        '</div></div>';
      return row;
    }

    function renderZeilen() {
      zeilenContainer.innerHTML = '';
      wiegungen.forEach(function (w, idx) {
        var div = document.createElement('div');
        div.innerHTML = buildRowHtml(idx);
        var rowEl = div.firstElementChild;
        zeilenContainer.appendChild(rowEl);
        rowEl.querySelectorAll('input').forEach(function (inp) {
          inp.addEventListener('input', function () { updateRowCalculations(rowEl); });
        });
        updateRowCalculations(rowEl);
        rowEl.querySelector('.kw-remove').addEventListener('click', function () {
          wiegungen.splice(idx, 1);
          renderZeilen();
        });
      });
    }

    function addRow() {
      wiegungen.push({
        bandwaage_kg: '',
        tara_kg: '',
        brutto_kg: '',
        leistung_th: '',
        bemerkung: '',
        teilung_kontrollwaage: '',
        bereich_max: '',
        letzte_eichung: ''
      });
      renderZeilen();
    }

    async function loadJobWithAnlagenstammKw(jobId) {
      var baseUrl = getDispoBaseUrl();
      var url = API_BASE + '/api/job?id=' + jobId + '&technician_id=' + getTechId() + '&enrich_anlagenstamm=1&base_url=' + encodeURIComponent(baseUrl);
      var r = await fetch(url, {
        headers: Object.assign({ 'X-Technician-Id': String(getTechId()) }, dispoBasicAuthHeaders(getDispoUsername, getDispoPassword))
      });
      var data = await r.json();
      return data.job;
    }

    async function loadKontrollwiegungJobs() {
      var range = getSyncDateRange();
      var r = await fetch(API_BASE + '/api/my_jobs?' + qs({ technician_id: getTechId(), date_from: range.date_from, date_to: range.date_to }), { headers: { 'X-Technician-Id': String(getTechId()) } });
      var data = await r.json();
      if (!data.ok || !data.jobs) return [];
      return data.jobs;
    }

    if (addRowBtn) addRowBtn.addEventListener('click', addRow);
    if (abbrechenBtn) abbrechenBtn.addEventListener('click', function () { if (typeof showView === 'function') showView('start'); });

    if (jobSelect) {
      jobSelect.addEventListener('change', async function () {
        var id = parseInt(this.value, 10);
        if (!id) {
          kopfdatenEl.innerHTML = '';
          fabSelect.innerHTML = '<option value="">– aus Auftrag –</option>';
          kontrollwiegungJobData = null;
          return;
        }
        try {
          kontrollwiegungJobData = await loadJobWithAnlagenstammKw(id);
          renderKopfdatenKontrollwiegung(kontrollwiegungJobData);
          fillFabSelect(kontrollwiegungJobData);
        } catch (e) {
          kopfdatenEl.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
        }
      });
    }

    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!kontrollwiegungJobData) { alert('Bitte Auftrag wählen.'); return; }
        var fab = (fabSelect && fabSelect.value) ? fabSelect.value.trim() : '';
        if (!fab) { alert('Bitte Fabrikationsnummer wählen.'); return; }
        var datum = (datumEl && datumEl.value) ? datumEl.value.trim() : '';
        if (!datum) { alert('Bitte Datum der Durchführung angeben.'); return; }
        var rows = zeilenContainer.querySelectorAll('.kontrollwiegung-row');
        var wiegungenPayload = [];
        rows.forEach(function (rowEl) {
          wiegungenPayload.push(getRowData(rowEl));
        });
        if (wiegungenPayload.length === 0) { alert('Mindestens eine Wiegung erforderlich.'); return; }
        var body = {
          technician_id: getTechId(),
          job_id: parseInt(jobSelect.value, 10),
          fabrikationsnummer: fab,
          durchfuehrungsdatum: datum,
          wiegungen: wiegungenPayload,
          base_url: getDispoBaseUrl(),
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        };
        try {
          var r = await fetch(API_BASE + '/api/kontrollwiegungsprotokoll_save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
            body: JSON.stringify(body)
          });
          var data = await r.json().catch(function () { return {}; });
          if (!r.ok || !data.ok) {
            alert('Fehler: ' + (data.error || r.status));
            return;
          }
          if (data.warning) alert(data.warning);
          else if (typeof showToast === 'function') showToast('Kontrollwiegungsprotokoll gespeichert.');
          lastProtokollId = data.protokoll_id != null ? data.protokoll_id : null;
          if (pdfBtn) {
            pdfBtn.style.display = lastProtokollId != null ? 'inline-block' : 'none';
          }
        } catch (err) {
          alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt'));
        }
      });
    }

    if (pdfBtn) {
      pdfBtn.addEventListener('click', async function () {
        if (!lastProtokollId) return;
        var url = API_BASE + '/api/kontrollwiegungsprotokoll_pdf?id=' + encodeURIComponent(lastProtokollId) + '&base_url=' + encodeURIComponent(getDispoBaseUrl());
        try {
          var r = await fetch(url, { headers: { 'X-Technician-Id': String(getTechId()) } });
          if (!r.ok) { alert('PDF konnte nicht geladen werden.'); return; }
          var blob = await r.blob();
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'Kontrollwiegungsprotokoll.pdf';
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (e) { alert('Fehler: ' + (e && e.message ? e.message : 'Unbekannt')); }
      });
    }

    window.openProtokolleKontrollwiegungen = function () {
      loadKontrollwiegungJobs().then(function (jobs) {
        if (jobSelect) {
          jobSelect.innerHTML = '<option value="">– Bitte wählen –</option>' +
            jobs.map(function (j) { return '<option value="' + j.id + '">' + escapeHtml((j.job_number || '') + ' ' + (j.customer_name || '')) + '</option>'; }).join('');
        }
        if (wiegungen.length === 0) addRow();
        else renderZeilen();
        if (datumEl && !datumEl.value) {
          var today = new Date();
          datumEl.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        }
        lastProtokollId = null;
        if (pdfBtn) pdfBtn.style.display = 'none';
      });
    };
  })();

  (function initProtokolleParameterlisten() {
    var jobSelect = document.getElementById('parameterlistenJob');
    var fileInput = document.getElementById('parameterlistenFiles');
    var btnUpload = document.getElementById('btnParameterlistenUpload');
    var resultsEl = document.getElementById('parameterlistenResults');

    // Datei-Dialog nur über Button öffnen, wenn ein Auftrag gewählt ist (vermeidet Absturz beim Abbrechen)
    var btnChooseFiles = document.getElementById('btnParameterlistenChooseFiles');
    if (btnChooseFiles && fileInput && jobSelect) {
      btnChooseFiles.addEventListener('click', function () {
        if (!jobSelect.value || !String(jobSelect.value).trim()) {
          alert('Bitte zuerst einen Auftrag wählen.');
          return;
        }
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        try {
          if (!fileInput.files || fileInput.files.length === 0) {
            fileInput.value = '';
          }
        } catch (_) { /* Abbrechen sauber abfangen */ }
      });
    }

    async function loadParameterlistenJobs() {
      if (!jobSelect) return;
      var range = getSyncDateRange();
      var r = await fetch(API_BASE + '/api/my_jobs?' + qs({ technician_id: getTechId(), date_from: range.date_from, date_to: range.date_to }), { headers: { 'X-Technician-Id': String(getTechId()) } });
      var data = await r.json();
      if (!data.ok || !data.jobs) return;
      var jobs = data.jobs;
      var currentVal = jobSelect.value;
      jobSelect.innerHTML = '<option value="">– Bitte wählen –</option>';
      jobs.forEach(function (job) {
        var opt = document.createElement('option');
        opt.value = job.id;
        opt.textContent = (job.job_number || job.id) + (job.customer_name ? ' – ' + job.customer_name : '');
        jobSelect.appendChild(opt);
      });
      if (currentVal) jobSelect.value = currentVal;
    }

    function escapeHtml(s) {
      if (s == null) return '';
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function readFileAsBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var b64 = reader.result;
          if (b64 && b64.indexOf('base64,') !== -1) b64 = b64.split('base64,')[1];
          resolve(b64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    if (btnUpload) {
      btnUpload.addEventListener('click', async function () {
        if (!jobSelect || !fileInput) return;
        await loadParameterlistenJobs();
        var jobId = jobSelect.value ? parseInt(jobSelect.value, 10) : null;
        var files = fileInput.files;
        if (!jobId) {
          alert('Bitte einen Auftrag wählen.');
          return;
        }
        if (!files || files.length === 0) {
          alert('Bitte mindestens eine CSV-Datei auswählen.');
          return;
        }
        if (resultsEl) {
          resultsEl.style.display = 'block';
          resultsEl.innerHTML = '<p class="muted">Lade hoch …</p>';
        }
        var outcomes = [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          var filename = file.name || 'datei.csv';
          try {
            var content = await readFileAsBase64(file);
            var r = await fetch(API_BASE + '/api/protokolle/parameterlisten', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
              body: JSON.stringify({ job_id: jobId, filename: filename, content: content })
            });
            var data = await r.json().catch(function () { return {}; });
            if (data.ok) {
              outcomes.push({ file: filename, ok: true, savedCsv: data.savedCsv, savedPdf: data.savedPdf });
            } else {
              outcomes.push({ file: filename, ok: false, error: data.error || 'Unbekannter Fehler' });
            }
          } catch (err) {
            outcomes.push({ file: filename, ok: false, error: err && err.message ? err.message : 'Fehler' });
          }
        }
        if (resultsEl) {
          var html = '';
          outcomes.forEach(function (o) {
            if (o.ok) {
              html += '<p><strong>' + escapeHtml(o.file) + '</strong>: gespeichert (CSV + PDF)</p>';
            } else {
              html += '<p><strong>' + escapeHtml(o.file) + '</strong>: <span class="error">' + escapeHtml(o.error) + '</span></p>';
            }
          });
          resultsEl.innerHTML = html || '<p class="muted">Keine Dateien.</p>';
        }
        if (typeof showToast === 'function' && outcomes.length > 0) {
          var okCount = outcomes.filter(function (o) { return o.ok; }).length;
          if (okCount === outcomes.length) showToast('Alle ' + okCount + ' Datei(en) gespeichert.');
          else if (okCount > 0) showToast(okCount + ' gespeichert, ' + (outcomes.length - okCount) + ' Fehler.');
          else showToast('Fehler beim Hochladen.');
        }
        fileInput.value = '';
      });
    }

    if (document.getElementById('btnViewProtokolle')) {
      document.getElementById('btnViewProtokolle').addEventListener('click', function () {
        loadParameterlistenJobs();
      });
    }
  })();

  (function initTextbausteineView() {
    var tbCategories = [];
    var selectedCategoryId = null;
    var selectedCategoryScope = null;
    var editingItemId = null;

    function escapeHtml(s) {
      if (s == null) return '';
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function stripHtml(html) {
      if (!html) return '';
      var d = document.createElement('div');
      d.innerHTML = html;
      return (d.textContent || d.innerText || '').trim();
    }

    window.loadTbCategories = async function () {
      var listEl = document.getElementById('tbCategoryList');
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) {
        if (listEl) listEl.innerHTML = '<span class="empty">Dispo-URL in Einstellungen eintragen.</span>';
        return;
      }
      try {
        var r = await fetch(API_BASE + '/api/textbausteine_list?base_url=' + encodeURIComponent(baseUrl) + '&technician_id=' + getTechId(), { headers: { 'X-Technician-Id': String(getTechId()) } });
        var data = await r.json();
        if (!data.ok || !data.categories) {
          tbCategories = [];
          if (listEl) listEl.innerHTML = '<span class="empty">Fehler oder keine Daten.</span>';
          return;
        }
        tbCategories = data.categories;
        var html = '';
        tbCategories.forEach(function (cat) {
          var scope = cat.scope || 'user';
          var sel = selectedCategoryId === cat.id && selectedCategoryScope === scope ? ' selected' : '';
          html += '<div class="textbausteine-category' + sel + '" data-id="' + cat.id + '" data-scope="' + escapeHtml(scope) + '">' + escapeHtml(cat.name) + (scope === 'global' ? ' <span class="muted" style="font-size:0.75rem">(global)</span>' : '') + '</div>';
        });
        if (listEl) listEl.innerHTML = html || '<span class="empty">Keine Kategorien.</span>';
        listEl.querySelectorAll('.textbausteine-category').forEach(function (el) {
          el.addEventListener('click', function () {
            selectedCategoryId = parseInt(el.dataset.id, 10);
            selectedCategoryScope = el.dataset.scope || 'user';
            loadTbCategories();
            loadTbItems();
          });
        });
      } catch (e) {
        if (listEl) listEl.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
      }
    };

    function loadTbItems() {
      var detailArea = document.getElementById('tbDetailArea');
      var hint = document.getElementById('tbSelectHint');
      var titleEl = document.getElementById('tbCategoryTitle');
      var itemList = document.getElementById('tbItemList');
      var cat = tbCategories.find(function (c) { return c.id === selectedCategoryId && (c.scope || 'user') === selectedCategoryScope; });
      if (!cat) {
        if (detailArea) detailArea.style.display = 'none';
        if (hint) { hint.style.display = 'block'; hint.textContent = 'Kategorie wählen oder neue anlegen.'; }
        return;
      }
      if (detailArea) detailArea.style.display = 'block';
      if (hint) hint.style.display = 'none';
      if (titleEl) titleEl.textContent = cat.name + (cat.scope === 'global' ? ' (global, nur lesbar)' : '');
      var isUserCategory = cat.scope === 'user';
      var btnNewItem = document.getElementById('btnTbNewItem');
      if (btnNewItem) btnNewItem.style.display = isUserCategory ? '' : 'none';
      var items = cat.items || [];
      var html = '';
      items.forEach(function (item) {
        var itemScope = item.scope || cat.scope || 'user';
        var showActions = itemScope === 'user';
        var actionsHtml = showActions
          ? '<div class="textbausteine-item-actions">' +
            '<button type="button" class="btn btn-ghost btn-edit-tb" data-id="' + item.id + '">Bearbeiten</button> ' +
            '<button type="button" class="btn btn-ghost btn-delete-tb" data-id="' + item.id + '">Löschen</button> ' +
            '<button type="button" class="btn btn-ghost btn-publish-tb" data-id="' + item.id + '">Für alle freigeben</button></div>'
          : '';
        html += '<div class="textbausteine-item" data-id="' + item.id + '" data-scope="' + escapeHtml(itemScope) + '">' +
          '<div class="textbausteine-item-content">' + (item.text ? item.text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') : '') + '</div>' +
          actionsHtml + '</div>';
      });
      if (itemList) itemList.innerHTML = html || '<span class="empty">Keine Textbausteine in dieser Kategorie.</span>';
      itemList.querySelectorAll('.btn-edit-tb').forEach(function (btn) {
        btn.addEventListener('click', function () { openTbEditor(parseInt(btn.dataset.id, 10)); });
      });
      itemList.querySelectorAll('.btn-delete-tb').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteTbItem(parseInt(btn.dataset.id, 10)); });
      });
      itemList.querySelectorAll('.btn-publish-tb').forEach(function (btn) {
        btn.addEventListener('click', function () { publishTbItem(parseInt(btn.dataset.id, 10)); });
      });
    }

    function openTbEditor(itemId) {
      editingItemId = itemId;
      var editor = document.getElementById('richtextEditor');
      var modal = document.getElementById('modalTbEditor');
      var titleEl = document.getElementById('modalTbEditorTitle');
      if (itemId) {
        var item = null;
        tbCategories.some(function (cat) {
          item = (cat.items || []).find(function (i) { return i.id === itemId; });
          return !!item;
        });
        if (editor) editor.innerHTML = item ? item.text : '';
        if (titleEl) titleEl.textContent = 'Textbaustein bearbeiten';
      } else {
        if (editor) editor.innerHTML = '';
        if (titleEl) titleEl.textContent = 'Neuer Textbaustein';
      }
      if (modal) modal.classList.add('active');
      if (editor) editor.focus();
    }

    function closeTbEditor() {
      editingItemId = null;
      var modal = document.getElementById('modalTbEditor');
      if (modal) modal.classList.remove('active');
    }

    document.querySelectorAll('.richtext-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cmd = btn.dataset.cmd;
        if (!cmd) return;
        document.execCommand(cmd, false, null);
        document.getElementById('richtextEditor').focus();
      });
    });

    document.getElementById('btnTbEditorSave').addEventListener('click', async function () {
      var editor = document.getElementById('richtextEditor');
      var html = editor ? editor.innerHTML : '';
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) { alert('Dispo-URL in Einstellungen eintragen.'); return; }
      if (!selectedCategoryId) { alert('Kategorie wählen.'); return; }
      try {
        var body = {
          base_url: baseUrl,
          technician_id: getTechId(),
          category_id: selectedCategoryId,
          text: html,
          id: editingItemId || undefined
        };
        var r = await fetch(API_BASE + '/api/textbausteine_save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
          body: JSON.stringify(body)
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok || !data.ok) {
          alert('Fehler: ' + (data.error || r.status));
          return;
        }
        if (typeof showToast === 'function') showToast('Textbaustein gespeichert.');
        closeTbEditor();
        loadTbCategories();
        loadTbItems();
      } catch (e) {
        alert('Fehler: ' + (e && e.message ? e.message : 'Unbekannt'));
      }
    });

    document.getElementById('btnTbEditorCancel').addEventListener('click', closeTbEditor);

    async function publishTbItem(id) {
      if (!confirm('Diesen Textbaustein für alle Techniker freigeben? Er wird danach nur noch in der Dispo vom Admin bearbeitet.')) return;
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) { alert('Dispo-URL in Einstellungen eintragen.'); return; }
      try {
        var r = await fetch(API_BASE + '/api/textbausteine_publish_global', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
          body: JSON.stringify({ base_url: baseUrl, technician_id: getTechId(), item_id: id })
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok || !data.ok) {
          alert('Fehler: ' + (data.error || r.status));
          return;
        }
        if (typeof showToast === 'function') showToast('Textbaustein für alle freigegeben.');
        loadTbCategories();
        loadTbItems();
      } catch (e) {
        alert('Fehler: ' + (e && e.message ? e.message : 'Unbekannt'));
      }
    }

    async function deleteTbItem(id) {
      if (!confirm('Textbaustein wirklich löschen?')) return;
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) return;
      try {
        var r = await fetch(API_BASE + '/api/textbausteine_delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
          body: JSON.stringify({ base_url: baseUrl, technician_id: getTechId(), id: id })
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok || !data.ok) {
          alert('Fehler: ' + (data.error || r.status));
          return;
        }
        if (typeof showToast === 'function') showToast('Textbaustein gelöscht.');
        loadTbCategories();
        loadTbItems();
      } catch (e) {
        alert('Fehler: ' + (e && e.message ? e.message : 'Unbekannt'));
      }
    }

    document.getElementById('btnTbNewItem').addEventListener('click', function () {
      if (!selectedCategoryId) { alert('Zuerst Kategorie wählen.'); return; }
      openTbEditor(null);
    });

    document.getElementById('btnTbNewCategory').addEventListener('click', function () {
      document.getElementById('modalTbCategoryTitle').textContent = 'Neue Kategorie';
      document.getElementById('tbCategoryName').value = '';
      document.getElementById('modalTbCategory').classList.add('active');
    });

    document.getElementById('btnTbCategorySave').addEventListener('click', async function () {
      var name = (document.getElementById('tbCategoryName').value || '').trim();
      if (!name) { alert('Name eingeben.'); return; }
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) { alert('Dispo-URL in Einstellungen eintragen.'); return; }
      try {
        var r = await fetch(API_BASE + '/api/textbausteine_category_save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
          body: JSON.stringify({ base_url: baseUrl, technician_id: getTechId(), name: name })
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok || !data.ok) {
          var msg = data.error || (r.status ? 'HTTP ' + r.status : 'Unbekannter Fehler');
          alert('Fehler: ' + msg);
          return;
        }
        if (typeof showToast === 'function') showToast('Kategorie gespeichert.');
        document.getElementById('modalTbCategory').classList.remove('active');
        loadTbCategories();
      } catch (e) {
        alert('Fehler: ' + (e && e.message ? e.message : 'Unbekannt'));
      }
    });

    document.getElementById('btnTbCategoryCancel').addEventListener('click', function () {
      document.getElementById('modalTbCategory').classList.remove('active');
    });
  })();

  const btnArchivApply = document.getElementById('btnArchivFilterApply');
  if (btnArchivApply) {
    btnArchivApply.addEventListener('click', function () {
      loadArchiv();
    });
  }
  const btnArchivReset = document.getElementById('btnArchivFilterReset');
  if (btnArchivReset) {
    btnArchivReset.addEventListener('click', function () {
      const customerEl = document.getElementById('archivFilterCustomer');
      const monthEl = document.getElementById('archivFilterMonth');
      const fabEl = document.getElementById('archivFilterFab');
      const countryEl = document.getElementById('archivFilterCountry');
      if (customerEl) customerEl.value = '';
      if (monthEl) monthEl.value = '';
      if (fabEl) fabEl.value = '';
      if (countryEl) countryEl.value = '';
      initArchivYearSelect();
      loadArchiv();
    });
  }

  document.getElementById('calPrev').addEventListener('click', () => {
    calCurrentMonth.setMonth(calCurrentMonth.getMonth() - 1);
    loadCalendarMonth();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calCurrentMonth.setMonth(calCurrentMonth.getMonth() + 1);
    loadCalendarMonth();
  });
  document.getElementById('calToday').addEventListener('click', () => {
    const now = new Date();
    calCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    loadCalendarMonth();
  });
  document.getElementById('calShowAllTech').addEventListener('change', () => loadCalendarMonth());

  (function initStartPageControls() {
    var dropZone = document.getElementById('startDropZone');
    var viewStart = document.getElementById('viewStart');
    if (dropZone) {
      dropZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drop-target');
      });
      dropZone.addEventListener('dragleave', function () {
        dropZone.classList.remove('drop-target');
      });
      dropZone.addEventListener('drop', function (e) {
        e.preventDefault();
        dropZone.classList.remove('drop-target');
        var jid = startPageActiveJobId;
        if (!jid || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        uploadDienstreiseFiles(jid, getStartUploadRelativeDir(), e.dataTransfer.files, document.getElementById('startUploadHint'));
      });
    }
    if (viewStart) {
      viewStart.addEventListener('paste', function (e) {
        if (!isStartViewVisible() || !startPageActiveJobId) return;
        var files = e.clipboardData && e.clipboardData.files;
        if (!files || !files.length) return;
        e.preventDefault();
        uploadDienstreiseFiles(startPageActiveJobId, getStartUploadRelativeDir(), files, document.getElementById('startUploadHint'));
      });
    }
    var btnUp = document.getElementById('btnStartUpload');
    if (btnUp) {
      btnUp.addEventListener('click', function () {
        var jid = startPageActiveJobId;
        var fi = document.getElementById('startFileInput');
        var hint = document.getElementById('startUploadHint');
        if (!jid) {
          if (hint) hint.textContent = 'Kein aktiver Auftrag.';
          return;
        }
        if (!fi || !fi.files || !fi.files.length) {
          if (hint) hint.textContent = 'Bitte Datei(en) wählen.';
          return;
        }
        uploadDienstreiseFiles(jid, getStartUploadRelativeDir(), fi.files, hint).then(function () {
          if (fi) fi.value = '';
        });
      });
    }
    var btnMk = document.getElementById('startBtnMkdir');
    if (btnMk) {
      btnMk.addEventListener('click', function () {
        var jid = startPageActiveJobId;
        var hint = document.getElementById('startMkdirHint');
        var parentEl = document.getElementById('startMkdirParent');
        var nameEl = document.getElementById('startMkdirName');
        if (!jid) {
          if (hint) hint.textContent = 'Kein aktiver Auftrag.';
          return;
        }
        var parentPath = parentEl && parentEl.value ? parentEl.value : 'Dokumente_Monteur';
        var folderName = nameEl && nameEl.value ? nameEl.value.trim() : '';
        if (!folderName) {
          if (hint) hint.textContent = 'Ordnername eingeben.';
          return;
        }
        if (hint) hint.textContent = 'Wird angelegt …';
        fetch(API_BASE + '/api/dienstreise/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: jid,
            parent_subpath: parentPath,
            folder_name: folderName,
          }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (!data.ok) {
              if (hint) hint.textContent = data.error || 'Anlegen fehlgeschlagen.';
              return;
            }
            if (hint) hint.textContent = 'Ordner angelegt.';
            if (nameEl) nameEl.value = '';
            setTimeout(function () {
              if (hint) hint.textContent = '';
            }, 2500);
            loadDienstreiseExplorer(jid, startExplorerSubpath, 'start');
          })
          .catch(function (err) {
            if (hint) hint.textContent = err && err.message ? err.message : 'Anlegen fehlgeschlagen.';
          });
      });
    }
  })();

  /** Bridge fuer rams_wizard.js (nach Laden von app.js verfuegbar). */
  window.MonteurRamsBridge = {
    API_BASE: API_BASE,
    getDispoBaseUrl: getDispoBaseUrl,
    getTechId: getTechId,
    authHeaders: function () {
      return dispoBasicAuthHeaders(getServerUsername, getServerPassword);
    },
    getTechnicianDisplayName: function () {
      return '';
    }
  };
  window.loadDienstreiseList = loadDienstreiseList;
})();
