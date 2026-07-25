(function () {
  const API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';

  /** POST mit Timeout (verhindert endloses „Prüfe…“ wenn der Server blockiert). */
  function fetchApiPostJson(path, body, timeoutMs) {
    var ac = new AbortController();
    var ms = timeoutMs || 28000;
    var timer = setTimeout(function () {
      ac.abort();
    }, ms);
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: 'HTTP ' + r.status };
        });
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') {
          return { ok: false, error: 'Timeout nach ' + Math.round(ms / 1000) + ' s' };
        }
        throw e;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

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
            if (st === 'completed' || st === 'failed' || st === 'cancelled' || st === 'interrupted') {
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
              return (
                j &&
                j.type === 'dienstreise_pull' &&
                (j.status === 'queued' || j.status === 'running')
              );
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
    var wrap = document.getElementById('backgroundJobsWrap');
    if (wrap && !wrap._syncCancelBound) {
      wrap._syncCancelBound = true;
      wrap.style.cursor = 'pointer';
      wrap.addEventListener('click', function () {
        fetch(API_BASE + '/api/background_jobs?running=1&limit=10')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var jobs = (data && data.jobs) || [];
            if (!jobs.length) return;
            var first = jobs[0];
            var label = (first.type || 'Sync') + (first.progress_phase ? ' (' + first.progress_phase + ')' : '');
            if (!window.confirm('Hängenden Sync abbrechen?\n\n' + label + '\n\nFortsetzung beim nächsten Online-Sync.')) {
              return;
            }
            return Promise.all(
              jobs.map(function (j) {
                return fetch(API_BASE + '/api/background_jobs/' + encodeURIComponent(j.id) + '/cancel', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}',
                });
              }),
            ).then(function () {
              return fetch(API_BASE + '/api/background_jobs/reap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              });
            });
          })
          .then(function () {
            if (typeof applySyncBadgeAfterRun === 'function') applySyncBadgeAfterRun([]);
          })
          .catch(function () {});
      });
    }
    function refresh() {
      fetch(API_BASE + '/api/background_jobs/reap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .catch(function () {})
        .then(function () {
          return fetch(API_BASE + '/api/background_jobs?running=1&limit=10');
        })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          var wrapEl = document.getElementById('backgroundJobsWrap');
          var badge = document.getElementById('backgroundJobsBadge');
          var jobs = data && data.jobs ? data.jobs : [];
          if (!wrapEl || !badge) return;
          if (!jobs.length) {
            wrapEl.style.display = 'none';
            wrapEl.removeAttribute('title');
            if (typeof applySyncBadgeAfterRun === 'function') {
              applySyncBadgeAfterRun([]).catch(function () {});
            }
            return;
          }
          wrapEl.style.display = '';
          badge.textContent = 'Sync ' + jobs.length;
          var lines = jobs.slice(0, 8).map(function (j) {
            var ph = j.progress_phase || j.status || '';
            var msg = j.message ? String(j.message) : '';
            var cur = j.progress_current != null ? j.progress_current : '';
            var tot = j.progress_total != null ? j.progress_total : '';
            var prog = tot !== '' && Number(tot) > 0 ? ' (' + cur + '/' + tot + ')' : '';
            return (j.type || '?') + ': ' + ph + prog + (msg ? ' — ' + msg : '');
          });
          wrapEl.setAttribute(
            'title',
            'Laufende Hintergrund-Synchronisation — Klick zum Abbrechen:\n' + lines.join('\n'),
          );
        })
        .catch(function () {});
    }
    refresh();
    setInterval(refresh, 2800);
  }

  const getTechId = () => parseInt(document.getElementById('technicianId').value, 10) || 0;
  window.getTechId = getTechId;
  window.getDispoBaseUrl = getDispoBaseUrl;
  window.getDispoUsername = getDispoUsername;
  window.getDispoPassword = getDispoPassword;
  window.getDispoExternalUrl = getDispoExternalUrl;
  window.getDispoInternalUrl = getDispoInternalUrl;
  const getServerUsername = () => (document.getElementById('serverUsername') && document.getElementById('serverUsername').value || '').trim();
  const getServerPassword = () => (document.getElementById('serverPassword') && document.getElementById('serverPassword').value || '');

  /** Standard bei Neuinstallation (ohne gespeicherte Einstellungen); weiterhin editierbar. */
  const DEFAULT_DISPO_SERVER_URL = 'https://fsm.kukla.co.at:4433';
  const DEFAULT_DISPO_SERVER_URL_INTERNAL = 'https://10.0.0.180';
  const SETTINGS_KEYS = {
    serverUrl: 'monteur_serverUrl',
    serverUrlInternal: 'monteur_serverUrlInternal',
    technicianId: 'monteur_technicianId',
    monteurFullName: 'monteur_fullName',
    serverUsername: 'monteur_serverUsername',
    serverPassword: 'monteur_serverPassword',
    syncIntervalMinutes: 'monteur_syncIntervalMinutes',
    dienstreiseBasePath: 'monteur_dienstreiseBasePath',
    zeitschreibungBasePath: 'monteur_zeitschreibungBasePath',
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
    return el ? (el.value || '').trim().replace(/\/+$/, '') : '';
  }

  /** Alias: externe Dispo-Basis-URL (Einstellungen). */
  function getServerUrl() {
    return getDispoExternalUrl();
  }

  /** Alte interne Default-URL (:4433) auf Standard-HTTPS ohne Port normalisieren. */
  function migrateLegacyInternalDispoBase(url) {
    var u = (url || '').toString().trim().replace(/\/+$/, '');
    if (!u) return u;
    try {
      var p = new URL(u);
      if (p.hostname === '10.0.0.180' && p.port === '4433') {
        p.port = '';
        return p.origin;
      }
    } catch (e) { /* ignore */ }
    return u;
  }

  /** Für Sync/Dispo: zuletzt erfolgreich gewählte Basis (intern/extern), sonst externe URL. */
  function getDispoBaseUrl() {
    try {
      var active = migrateLegacyInternalDispoBase(localStorage.getItem(LS_ACTIVE_BASE));
      if (active) {
        var stored = (localStorage.getItem(LS_ACTIVE_BASE) || '').trim().replace(/\/+$/, '');
        if (stored && stored !== active) {
          try { localStorage.setItem(LS_ACTIVE_BASE, active); } catch (e) { /* ignore */ }
        }
        return active;
      }
    } catch (e) { /* ignore */ }
    var ext = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
    if (ext) return ext;
    var intUrl = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
    if (intUrl) return intUrl;
    try {
      return (localStorage.getItem(SETTINGS_KEYS.serverUrl) || '').trim();
    } catch (e2) {
      return '';
    }
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

  /** Fest: selbstsigniertes Dispo-HTTPS (kein UI-Schalter). */
  function getAllowInsecureTlsSetting() {
    return true;
  }

  var autoAppUpdateCheckTimer = null;

  function triggerAutoAppUpdateCheck() {
    if (!window.monteurApp || typeof monteurApp.checkForAppUpdates !== 'function') {
      return Promise.resolve();
    }
    if (!getDispoBaseUrl()) return Promise.resolve();
    syncUpdateFeedToMain();
    return window.monteurApp.checkForAppUpdates({ manual: false }).catch(function () {
      return null;
    });
  }

  function scheduleAutoAppUpdateCheck() {
    if (autoAppUpdateCheckTimer) clearTimeout(autoAppUpdateCheckTimer);
    autoAppUpdateCheckTimer = setTimeout(function () {
      autoAppUpdateCheckTimer = null;
      triggerAutoAppUpdateCheck();
    }, 2500);
  }

  function syncUpdateFeedToMain() {
    if (!window.monteurApp || typeof window.monteurApp.setUpdateFeedBase !== 'function') return;
    var base = getDispoBaseUrl();
    if (!base) return;
    window.monteurApp
      .setUpdateFeedBase(base, getAllowInsecureTlsSetting())
      .then(function () {
        scheduleAutoAppUpdateCheck();
      })
      .catch(function () {});
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

  /** Kandidaten für Fallback (LAN zuerst wenn interne URL ein Privatnetz ist). */
  function buildDispoBaseCandidatesClient() {
    var active = '';
    try {
      active = (localStorage.getItem(LS_ACTIVE_BASE) || '').trim().replace(/\/+$/, '');
    } catch (e) { /* ignore */ }
    var ext = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
    var intUrl = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
    var activePrivate = false;
    var intPrivate = false;
    if (active) {
      try {
        activePrivate = isPrivateLanHostname(new URL(active).hostname);
      } catch (e) { /* ignore */ }
    }
    if (intUrl) {
      try {
        intPrivate = isPrivateLanHostname(new URL(intUrl).hostname);
      } catch (e) { /* ignore */ }
    }
    var out = [];
    var seen = {};
    function add(u) {
      if (!u || seen[u]) return;
      seen[u] = true;
      out.push(u);
    }
    if (intPrivate && activePrivate) {
      add(active);
      add(intUrl);
      add(ext);
      return out;
    }
    if (active && !activePrivate) add(active);
    add(ext);
    if (activePrivate) add(active);
    add(intUrl);
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
    if (u) return u;
    try { return (localStorage.getItem(SETTINGS_KEYS.serverUsername) || '').trim(); } catch (e) { return ''; }
  }
  function getDispoPassword() {
    var p = getServerPassword();
    if (p) return p;
    try { return localStorage.getItem(SETTINGS_KEYS.serverPassword) || ''; } catch (e) { return ''; }
  }

  function getSyncIntervalMinutes() {
    const el = document.getElementById('syncIntervalMinutes');
    const v = el ? parseInt(el.value, 10) : NaN;
    if (!Number.isFinite(v) || v < 1) return 5;
    return Math.min(1440, v);
  }

  function formatServerHealthServiceLabel(key) {
    var map = {
      apache: 'Apache',
      mariadb: 'MariaDB',
      desktop: 'Desktop',
      push: 'Push',
      mounts: 'Mounts',
    };
    return map[key] || key;
  }

  function formatServerHealthLine(data) {
    if (!data || !data.ok) {
      return data && data.error ? String(data.error) : 'Health-Status nicht verfügbar.';
    }
    var services = data.services && typeof data.services === 'object' ? data.services : {};
    var keys = ['apache', 'mariadb', 'desktop'];
    var parts = [];
    keys.forEach(function (key) {
      if (!services[key]) return;
      var svc = services[key];
      var label = formatServerHealthServiceLabel(key);
      if (svc.skipped) {
        parts.push(label + ': —');
      } else if (svc.ok) {
        parts.push(label + ': OK');
      } else {
        parts.push(label + ': Fehler');
      }
    });
    if (!parts.length && data.message) return String(data.message);
    return parts.length ? parts.join(' · ') : 'Keine Service-Daten.';
  }

  function serverMaintenanceAuthHeaders() {
    return dispoBasicAuthHeaders(getServerUsername, getServerPassword);
  }

  function syncServerRebootPolicy() {
    return fetch(API_BASE + '/api/server/reboot_policy', {
      headers: Object.assign({ 'X-Technician-Id': String(getTechId() || '') }, serverMaintenanceAuthHeaders()),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .catch(function () {
        return {};
      });
  }

  function loadServerRebootAllowedState() {
    return fetch(API_BASE + '/api/server/reboot_allowed', {
      headers: Object.assign({ 'X-Technician-Id': String(getTechId() || '') }, serverMaintenanceAuthHeaders()),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .catch(function () {
        return {};
      });
  }

  function loadServerMaintenanceHealth() {
    var summaryEl = document.getElementById('serverMaintenanceHealthSummary');
    if (summaryEl) summaryEl.textContent = 'Wird geladen…';
    return fetch(API_BASE + '/api/server/health', {
      headers: Object.assign({ 'X-Technician-Id': String(getTechId() || '') }, serverMaintenanceAuthHeaders()),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (data) {
        if (summaryEl) summaryEl.textContent = formatServerHealthLine(data);
        return data;
      })
      .catch(function () {
        if (summaryEl) summaryEl.textContent = 'Health-Status nicht verfügbar.';
        return {};
      });
  }

  function refreshServerMaintenanceZone() {
    var zone = document.getElementById('serverMaintenanceZone');
    var hintEl = document.getElementById('serverMaintenancePolicyHint');
    var btnReboot = document.getElementById('btnServerReboot');
    if (!zone) return Promise.resolve();
    if (!getServerUsername() || !getServerPassword()) {
      zone.hidden = true;
      return Promise.resolve();
    }
    return Promise.all([syncServerRebootPolicy(), loadServerRebootAllowedState()])
      .then(function (results) {
        var policyData = results[0] || {};
        var allowedData = results[1] || {};
        var allowed = !!(allowedData.ok && allowedData.allowed);
        zone.hidden = !allowed;
        if (!allowed) return;
        if (hintEl) {
          var hintParts = [];
          if (allowedData.stale) {
            hintParts.push('Hinweis: Reboot-Policy aus lokalem Cache (veraltet oder Sync nicht möglich).');
          } else if (policyData.from_cache) {
            hintParts.push('Policy aus lokalem Cache (Server-Sync nicht erreichbar).');
          } else {
            hintParts.push('Geplanter Neustart in ca. 1 Minute. Alle Dienste sind kurz nicht erreichbar.');
          }
          if (allowedData.reboot_enabled === false) {
            hintParts.push('Server-Reboot ist derzeit auf dem Server deaktiviert.');
          }
          hintEl.textContent = hintParts.join(' ');
        }
        if (btnReboot) {
          btnReboot.disabled = allowedData.reboot_enabled === false;
        }
        return loadServerMaintenanceHealth();
      })
      .catch(function () {
        zone.hidden = true;
      });
  }

  async function loadSettingsSyncStatus() {
    var summaryEl = document.getElementById('settings-sync-summary');
    var dbEl = document.getElementById('settings-db-size');
    if (!summaryEl && !dbEl) return;
    if (summaryEl) summaryEl.textContent = 'Wird geladen…';
    try {
      var r = await fetch(API_BASE + '/api/sync_status');
      var data = await r.json().catch(function () {
        return {};
      });
      if (!data.ok) {
        if (summaryEl) summaryEl.textContent = 'Sync-Status nicht verfügbar.';
        return;
      }
      if (summaryEl) {
        summaryEl.textContent =
          'Uploads ausstehend: ' +
          (data.pending_uploads != null ? data.pending_uploads : 0) +
          ', Events: ' +
          (data.pending_events != null ? data.pending_events : data.pending_changes || 0) +
          ', Kalender: ' +
          (data.calendar_cache_synced_at || '—') +
          ', Jobs: ' +
          (data.last_jobs_sync || '—');
      }
      if (dbEl) {
        var size = data.db_size_human || '—';
        var files = data.dienstreise_files_configured
          ? data.dienstreise_files_cache_human || '—'
          : '—';
        dbEl.textContent =
          'Lokale Datenbank: ' +
          size +
          ' · Projektordner (Dienstreise): ' +
          files +
          ', lokal';
        dbEl.title = data.db_path ? 'Pfad: ' + data.db_path : '';
      }
      if (typeof updateMultiDeviceUiFromSyncStatus === 'function') {
        updateMultiDeviceUiFromSyncStatus(data);
      }
    } catch (e) {
      if (summaryEl) summaryEl.textContent = 'Sync-Status konnte nicht geladen werden.';
    }
  }

  function loadSettingsFromStorage() {
    try {
      const url = localStorage.getItem(SETTINGS_KEYS.serverUrl);
      document.getElementById('serverUrl').value =
        url != null ? url : DEFAULT_DISPO_SERVER_URL;
      const urlInt = localStorage.getItem(SETTINGS_KEYS.serverUrlInternal);
      var elInt = document.getElementById('serverUrlInternal');
      if (elInt) {
        var intLoaded = urlInt != null ? urlInt : DEFAULT_DISPO_SERVER_URL_INTERNAL;
        if (intLoaded.replace(/\/+$/, '') === 'https://10.0.0.180:4433') {
          intLoaded = DEFAULT_DISPO_SERVER_URL_INTERNAL;
          try { localStorage.setItem(SETTINGS_KEYS.serverUrlInternal, intLoaded); } catch (e) { /* ignore */ }
        }
        elInt.value = intLoaded;
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
      const zsBasePath = localStorage.getItem(SETTINGS_KEYS.zeitschreibungBasePath);
      if (zsBasePath != null) {
        const zsEl = document.getElementById('zeitschreibungBasePath');
        if (zsEl) zsEl.value = zsBasePath;
      }
      const uiTh = localStorage.getItem(SETTINGS_KEYS.uiTheme);
      applyUiTheme(uiTh);
    } catch (e) { /* ignore */ }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(SETTINGS_KEYS.serverUrl, (document.getElementById('serverUrl').value || '').trim());
      var intEl = document.getElementById('serverUrlInternal');
      var intSave = intEl ? (intEl.value || '').trim().replace(/\/+$/, '') : '';
      localStorage.setItem(SETTINGS_KEYS.serverUrlInternal, intSave);
      localStorage.setItem(SETTINGS_KEYS.technicianId, document.getElementById('technicianId').value || '');
      var elFn = document.getElementById('monteurFullName');
      localStorage.setItem(SETTINGS_KEYS.monteurFullName, elFn ? (elFn.value || '').trim() : '');
      localStorage.setItem(SETTINGS_KEYS.serverUsername, (document.getElementById('serverUsername') && document.getElementById('serverUsername').value) || '');
      localStorage.setItem(SETTINGS_KEYS.serverPassword, (document.getElementById('serverPassword') && document.getElementById('serverPassword').value) || '');
      localStorage.setItem(SETTINGS_KEYS.syncIntervalMinutes, String(getSyncIntervalMinutes()));
      const pathEl = document.getElementById('dienstreiseBasePath');
      localStorage.setItem(SETTINGS_KEYS.dienstreiseBasePath, (pathEl && pathEl.value ? pathEl.value.trim() : '') || '');
      const zsPathEl = document.getElementById('zeitschreibungBasePath');
      localStorage.setItem(
        SETTINGS_KEYS.zeitschreibungBasePath,
        (zsPathEl && zsPathEl.value ? zsPathEl.value.trim() : '') || '',
      );
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

  /** Lokale Aufträge nur für den eingeloggten Monteur (mit job_technicians-Zuordnung). */
  async function fetchMyAssignedJobs() {
    var techId = getTechId();
    if (!techId) return [];
    var range = getSyncDateRange();
    var r = await fetch(
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
    var data = await r.json();
    if (!data.ok || !data.jobs) return [];
    return data.jobs;
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') p.set(k, v); });
    return p.toString();
  }

  function anlagenstammDispoBody(extra) {
    return Object.assign({
      baseUrl: getDispoBaseUrl(),
      externalUrl: getDispoExternalUrl(),
      internalUrl: getDispoInternalUrl(),
      serverUsername: getDispoUsername(),
      serverPassword: getDispoPassword()
    }, extra || {});
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

  /** TED-Excel in Projektordner/TED nur nach Annahme (lokal in_arbeit). */
  function jobStatusAllowsTedFilePull(job) {
    if (!job || typeof job !== 'object') return false;
    return String(job.status || '').trim().toLowerCase() === 'in_arbeit';
  }

  /** Button „Freigeben“: Push nach Dispo, Status zugeteilt, lokaler Ordner löschen; Multi-Device-Warnung bei Peers. */
  function jobStatusAllowsReleaseJob(job) {
    if (!job || typeof job !== 'object') return false;
    return String(job.status || '').trim().toLowerCase() === 'in_arbeit';
  }

  var acceptJobStreamBusy = false;
  /** @type {number | null} */
  var acceptJobActiveLocalJobId = null;
  /** Letzter Poll-Stand, damit nach erneutem Rendern der Liste der Balken wiederhergestellt werden kann. */
  var acceptJobLastProgressRow = null;
  /** @type {HTMLButtonElement | null} */
  var acceptJobActiveButton = null;
  var acceptJobUiTimeoutId = null;

  var finishJobStreamBusy = false;
  var finishJobActiveLocalJobId = null;
  var finishJobLastProgressRow = null;
  var finishJobActiveButton = null;
  var finishJobUiTimeoutId = null;
  var restoreFinishJobBgFetchInFlight = false;
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
      if (typeof loadDienstreiseExplorer === 'function') {
        if (getDienstreiseExplorerJobId('start') == localJobId) {
          loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start');
        }
        if (getDienstreiseExplorerJobId('modal') == localJobId) {
          loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal');
        }
      }
      if (jobDetailsJobId == localJobId && isProjektdatenViewVisible() && typeof openJobDetailsModal === 'function') {
        openJobDetailsModal(localJobId);
      }
      setTimeout(function () {
        var x = document.getElementById('acceptJobHint');
        if (x && (!warn || !x.textContent.includes('Hinweis:'))) x.textContent = '';
      }, warn ? 8000 : 4000);
    } else {
      var failMsg = j.error || j.message;
      if (j.status === 'interrupted') {
        failMsg =
          failMsg ||
          'Kopie unterbrochen (automatisch beendet). Bitte Verbindung prüfen und „Auftrag annehmen“ erneut versuchen.';
      }
      if (hint) hint.textContent = failMsg || 'Auftrag annehmen fehlgeschlagen.';
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
    }
  }

  /**
   * Nach Neustart: laufende accept_job-Pulls wieder an die UI binden (nicht interrupted — die sind beendet).
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
          if (st !== 'queued' && st !== 'running') continue;
          accepts.push(j);
        }
        if (!accepts.length) {
          finishAcceptJobStreamUi();
          return;
        }
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

  function validateAcceptJobPrerequisites(localJobId, opts) {
    opts = opts || {};
    if (!localJobId) return 'Bitte einen Auftrag wählen.';
    if (!getTechId()) return 'Bitte Monteur-ID in Einstellungen eintragen.';
    if (!opts.allowOffline) {
      if (!(getDispoBaseUrl() || '').trim()) return 'Bitte Dispo-URL in Einstellungen eintragen.';
      if (!getDispoUsername() || !getDispoPassword()) {
        return 'Dispo-Zugangsdaten fehlen: Benutzername und Passwort in den Einstellungen eintragen.';
      }
    }
    var snap = getDienstreiseJobSnapshotByLocalId(localJobId);
    if (!jobCanAcceptJob(snap)) return 'Auftrag kann nur im Status Angelegt oder Zugeteilt angenommen werden.';
    return null;
  }

  function shouldPreferOfflineAccept() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (typeof connectionUiState === 'string' && (connectionUiState === 'offline' || connectionUiState === 'local')) {
      return true;
    }
    if (!(getDispoBaseUrl() || '').trim()) return true;
    if (!getDispoUsername() || !getDispoPassword()) return true;
    return false;
  }

  function handleAcceptJobOfflineFinished(localJobId, data, hint) {
    if (data && data.ok) {
      var doneMsg = 'Auftrag lokal angenommen.';
      if (data.hint) doneMsg += ' ' + String(data.hint);
      if (hint) hint.textContent = doneMsg;
      if (typeof showToast === 'function') showToast(doneMsg);
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
      if (typeof loadDienstreiseExplorer === 'function') {
        if (getDienstreiseExplorerJobId('start') == localJobId) {
          loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start');
        }
        if (getDienstreiseExplorerJobId('modal') == localJobId) {
          loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal');
        }
      }
      if (jobDetailsJobId == localJobId && isProjektdatenViewVisible() && typeof openJobDetailsModal === 'function') {
        openJobDetailsModal(localJobId);
      }
      setTimeout(function () {
        var x = document.getElementById('acceptJobHint');
        if (x) x.textContent = '';
      }, 6000);
    } else {
      if (hint) hint.textContent = (data && data.error) || 'Offline-Annahme fehlgeschlagen.';
    }
  }

  function runAcceptJobOffline(localJobId, triggerButton, acceptOpts) {
    if (acceptJobStreamBusy) return;
    var errMsg = validateAcceptJobPrerequisites(localJobId, { allowOffline: true });
    var hint = document.getElementById('acceptJobHint');
    if (errMsg) {
      if (hint) hint.textContent = errMsg;
      return;
    }
    acceptJobStreamBusy = true;
    acceptJobActiveLocalJobId = localJobId;
    acceptJobActiveButton = triggerButton && triggerButton.nodeType === 1 ? triggerButton : null;
    if (hint) hint.textContent = 'Nehme Auftrag offline an …';
    applyAcceptJobStreamBusyUi();
    var body = {
      job_id: localJobId,
      technician_id: getTechId(),
      offline_paths: acceptOpts && Object.prototype.hasOwnProperty.call(acceptOpts, 'offline_paths') ? acceptOpts.offline_paths : {},
      fab_map: acceptOpts && acceptOpts.fab_map ? acceptOpts.fab_map : undefined,
      montage_folder_name: acceptOpts && acceptOpts.montage_folder_name ? acceptOpts.montage_folder_name : undefined
    };
    fetch(API_BASE + '/api/dienstreise/accept_offline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || !data.ok) throw new Error((data && data.error) || 'Fehler ' + r.status);
          return data;
        });
      })
      .then(function (data) {
        handleAcceptJobOfflineFinished(localJobId, data, hint);
      })
      .catch(function (err) {
        if (hint) hint.textContent = err && err.message ? err.message : 'Offline-Annahme fehlgeschlagen.';
      })
      .finally(function () {
        finishAcceptJobStreamUi();
      });
  }

  var ACCEPT_OFFLINE_LS_KEY = 'kukla_accept_offline_paths_v1';
  var acceptOfflinePending = null;
  var acceptOfflinePreviewAbort = null;
  var acceptOfflinePreviewTimer = null;
  var acceptOfflinePreviewTriggerBtn = null;
  var ACCEPT_OFFLINE_PREVIEW_TIMEOUT_MS = 120000;

  function acceptOfflineLoadingHtml(message) {
    var msg = message || 'Verbinde mit Dispo …';
    return (
      '<div class="accept-offline-loading">' +
      '<p class="muted" id="acceptOfflineLoadingMsg">' + escapeHtml(msg) + '</p>' +
      '<progress max="100" value="0" id="acceptOfflineLoadingBar"></progress>' +
      '<p class="muted" style="font-size:0.8rem;">Bei langsamer Verbindung kann dies eine Minute dauern. Sie können „Keine“ wählen und nur Status/Struktur offline laden.</p>' +
      '</div>'
    );
  }

  function setAcceptOfflinePreviewTriggerBusy(busy) {
    var btn = acceptOfflinePreviewTriggerBtn;
    if (!btn || !btn.nodeType) return;
    if (busy) {
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      btn.classList.add('btn-accept-job--busy');
      var bar = btn.querySelector('.btn-accept-job-progress');
      if (bar) {
        try {
          bar.indeterminate = true;
        } catch (e) {}
      }
      var lbl = btn.querySelector('.btn-accept-job-progress-text');
      if (lbl) lbl.textContent = 'Lade Auswahl …';
    } else if (!acceptJobStreamBusy) {
      btn.disabled = false;
      btn.classList.remove('btn-accept-job--busy');
      btn.removeAttribute('aria-busy');
      var bar2 = btn.querySelector('.btn-accept-job-progress');
      if (bar2) {
        try {
          bar2.indeterminate = false;
        } catch (e2) {}
        bar2.value = 0;
      }
      var lbl2 = btn.querySelector('.btn-accept-job-progress-text');
      if (lbl2) lbl2.textContent = '';
    }
  }

  function clearAcceptOfflinePreviewFetch() {
    if (acceptOfflinePreviewAbort) {
      try {
        acceptOfflinePreviewAbort.abort();
      } catch (_) {}
      acceptOfflinePreviewAbort = null;
    }
    if (acceptOfflinePreviewTimer) {
      clearInterval(acceptOfflinePreviewTimer);
      acceptOfflinePreviewTimer = null;
    }
    setAcceptOfflinePreviewTriggerBusy(false);
    acceptOfflinePreviewTriggerBtn = null;
  }

  function loadRememberedOfflinePaths() {
    try {
      var raw = localStorage.getItem(ACCEPT_OFFLINE_LS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveRememberedOfflinePaths(paths) {
    try {
      localStorage.setItem(ACCEPT_OFFLINE_LS_KEY, JSON.stringify(paths || []));
    } catch (_) {}
  }

  function offlinePathKey(fab, rel, kind) {
    return String(fab) + ':' + String(rel || '').replace(/^\/+|\/+$/g, '') + ':' + (kind || 'dir');
  }

  function offlinePathFromKey(key) {
    var s = String(key || '');
    var last = s.lastIndexOf(':');
    if (last <= 0) return null;
    var kind = s.slice(last + 1);
    var rest = s.slice(0, last);
    var first = rest.indexOf(':');
    if (first < 0) return null;
    return {
      fab: rest.slice(0, first),
      path: rest.slice(first + 1),
      kind: kind || 'dir',
    };
  }

  function ensureAcceptOfflineSelectedKeys() {
    if (!acceptOfflinePending) return new Set();
    if (!acceptOfflinePending.selectedKeys) acceptOfflinePending.selectedKeys = new Set();
    return acceptOfflinePending.selectedKeys;
  }

  function offlineFolderCheckboxState(nodeId, selectedKeys, nodeIndex, nodeMeta) {
    var meta = nodeMeta && nodeMeta[nodeId];
    if (!meta) return { checked: false, indeterminate: false };
    if (selectedKeys.has(meta.key)) return { checked: true, indeterminate: false };
    var kids = (nodeIndex && nodeIndex[nodeId]) || [];
    if (!kids.length) return { checked: false, indeterminate: false };
    var nSel = 0;
    kids.forEach(function (d) {
      var dm = nodeMeta[d.id];
      if (dm && selectedKeys.has(dm.key)) nSel++;
    });
    if (nSel === 0) return { checked: false, indeterminate: false };
    if (nSel === kids.length) return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  }

  function applyOfflineNodeSelection(nodeId, selected, selectedKeys, nodeIndex, nodeMeta) {
    var meta = nodeMeta && nodeMeta[nodeId];
    if (!meta || !selectedKeys) return;
    if (meta.kind === 'dir') {
      if (selected) {
        selectedKeys.add(meta.key);
        (nodeIndex[nodeId] || []).forEach(function (d) {
          var dm = nodeMeta[d.id];
          if (dm) selectedKeys.add(dm.key);
        });
      } else {
        selectedKeys.delete(meta.key);
        (nodeIndex[nodeId] || []).forEach(function (d) {
          var dm = nodeMeta[d.id];
          if (dm) selectedKeys.delete(dm.key);
        });
      }
      return;
    }
    if (selected) selectedKeys.add(meta.key);
    else selectedKeys.delete(meta.key);
  }

  function refreshAcceptOfflineCheckboxStates(bodyEl) {
    if (!bodyEl || !acceptOfflinePending) return;
    var selectedKeys = acceptOfflinePending.selectedKeys;
    var nodeIndex = acceptOfflinePending.nodeIndex || {};
    var nodeMeta = acceptOfflinePending.nodeMeta || {};
    if (!selectedKeys) return;
    bodyEl.querySelectorAll('input[data-offline-path]').forEach(function (cb) {
      var nodeId = cb.getAttribute('data-offline-node');
      var kind = cb.getAttribute('data-offline-kind');
      if (kind === 'dir') {
        var st = offlineFolderCheckboxState(nodeId, selectedKeys, nodeIndex, nodeMeta);
        cb.checked = st.checked;
        cb.indeterminate = st.indeterminate;
      } else {
        cb.indeterminate = false;
        var meta = nodeMeta[nodeId];
        cb.checked = !!(meta && selectedKeys.has(meta.key));
      }
    });
  }

  function acceptOfflineNodeRel(node, parentRel) {
    var name = String(node && node.name != null ? node.name : '').trim();
    var parent = String(parentRel || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    var raw = String(node && node.rel != null ? node.rel : name)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (raw && raw.indexOf('/') >= 0) return raw;
    if (parent) return parent + '/' + (raw || name);
    return raw || name;
  }

  function acceptOfflineNodeId(fab, rel) {
    return 'ao_' + String(fab) + '_' + String(rel || '').replace(/[^a-zA-Z0-9]+/g, '_');
  }

  function flattenAcceptOfflineNodes(nodes, fab, out, parentRel) {
    (nodes || []).forEach(function (node) {
      if (!node) return;
      var rel = acceptOfflineNodeRel(node, parentRel);
      var kind = node.type === 'file' ? 'file' : 'dir';
      out.push({ fab: fab, rel: rel, kind: kind, is_ted: !!node.is_ted });
      if (node.children && node.children.length) flattenAcceptOfflineNodes(node.children, fab, out, rel);
    });
    return out;
  }

  function renderAcceptOfflineTreeNodes(fab, nodes, level, expanded, selectedKeys, validKeys, nodeMeta, nodeIndex, parentRel) {
    var html = '';
    (nodes || []).forEach(function (node) {
      if (!node) return;
      var rel = acceptOfflineNodeRel(node, parentRel);
      var kind = node.type === 'file' ? 'file' : 'dir';
      var isDir = kind === 'dir';
      var isTed = !!node.is_ted;
      var key = offlinePathKey(fab, rel, kind);
      validKeys.add(key);
      var nodeId = acceptOfflineNodeId(fab, rel);
      if (nodeMeta) nodeMeta[nodeId] = { fab: fab, rel: rel, kind: kind, key: key };
      var pad = 0.35 + Math.min(level, 8) * 0.85;
      var icon = isDir ? '📁' : '📄';
      if (isTed) {
        html +=
          '<div class="accept-offline-row muted" style="margin-left:' +
          pad +
          'rem;font-size:0.85rem;" title="Bereits im Anlagenstamm (TED)">' +
          icon +
          ' ' +
          escapeHtml(node.name || rel) +
          ' <span class="muted">(Anlagenstamm)</span></div>';
      } else {
        var st = isDir
          ? offlineFolderCheckboxState(nodeId, selectedKeys, nodeIndex, nodeMeta)
          : { checked: selectedKeys.has(key), indeterminate: false };
        var checked = st.checked ? ' checked' : '';
        html += '<div class="accept-offline-row" style="margin-left:' + pad + 'rem;display:flex;align-items:center;gap:0.25rem;font-size:0.85rem;">';
        if (isDir) {
          var isExp = !!expanded[nodeId];
          html +=
            '<button type="button" class="btn btn-ghost accept-offline-toggle" data-offline-toggle="' +
            escapeHtml(nodeId) +
            '" style="min-width:1.25rem;padding:0;">' +
            (isExp ? '▼' : '▶') +
            '</button>';
        } else {
          html += '<span style="display:inline-block;min-width:1.25rem;"></span>';
        }
        html +=
          '<label style="display:inline-flex;align-items:center;gap:0.35rem;flex:1;">' +
          '<input type="checkbox" data-offline-path data-fab="' +
          escapeHtml(String(fab)) +
          '" data-offline-path-val="' +
          escapeHtml(rel) +
          '" data-offline-kind="' +
          kind +
          '" data-offline-node="' +
          escapeHtml(nodeId) +
          '"' +
          checked +
          '> ' +
          icon +
          ' ' +
          escapeHtml(node.name || rel) +
          '</label></div>';
        if (isDir && expanded[nodeId] && node.children && node.children.length) {
          html += renderAcceptOfflineTreeNodes(
            fab,
            node.children,
            level + 1,
            expanded,
            selectedKeys,
            validKeys,
            nodeMeta,
            nodeIndex,
            rel,
          );
        }
      }
    });
    return html;
  }

  function bindAcceptOfflineTreeEvents(bodyEl) {
    if (!bodyEl || bodyEl._acceptOfflineBound) return;
    bodyEl._acceptOfflineBound = true;
    bodyEl.addEventListener('click', function (e) {
      var toggle = e.target.closest('[data-offline-toggle]');
      if (toggle && acceptOfflinePending) {
        e.preventDefault();
        var id = toggle.getAttribute('data-offline-toggle');
        if (!acceptOfflinePending.expanded) acceptOfflinePending.expanded = {};
        acceptOfflinePending.expanded[id] = !acceptOfflinePending.expanded[id];
        if (acceptOfflinePending.lastPreview) renderAcceptOfflinePreview(acceptOfflinePending.lastPreview);
        return;
      }
    });
    bodyEl.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-offline-path')) return;
      if (!acceptOfflinePending || !acceptOfflinePending.nodeIndex) return;
      var selectedKeys = ensureAcceptOfflineSelectedKeys();
      var nodeId = cb.getAttribute('data-offline-node');
      var kind = cb.getAttribute('data-offline-kind');
      applyOfflineNodeSelection(
        nodeId,
        cb.checked,
        selectedKeys,
        acceptOfflinePending.nodeIndex,
        acceptOfflinePending.nodeMeta,
      );
      refreshAcceptOfflineCheckboxStates(bodyEl);
    });
  }

  function buildAcceptOfflineNodeIndex(fab, nodes, index, list, meta, parentRel) {
    (nodes || []).forEach(function (node) {
      if (!node || node.is_ted) return;
      var rel = acceptOfflineNodeRel(node, parentRel);
      var kind = node.type === 'file' ? 'file' : 'dir';
      var nodeId = acceptOfflineNodeId(fab, rel);
      var key = offlinePathKey(fab, rel, kind);
      if (meta) meta[nodeId] = { fab: fab, rel: rel, kind: kind, key: key };
      var descend = [];
      flattenAcceptOfflineNodes(node.children || [], fab, [], rel).forEach(function (d) {
        if (d.is_ted) return;
        var cid = acceptOfflineNodeId(fab, d.rel);
        var dkey = offlinePathKey(fab, d.rel, d.kind);
        if (meta) meta[cid] = { fab: fab, rel: d.rel, kind: d.kind, key: dkey };
        descend.push({ id: cid, rel: d.rel, kind: d.kind, key: dkey });
      });
      index[nodeId] = descend;
      list.push({ id: nodeId, fab: fab, rel: rel, kind: kind, key: key });
      if (node.children && node.children.length) {
        buildAcceptOfflineNodeIndex(fab, node.children, index, list, meta, rel);
      }
    });
  }

  function closeAcceptOfflineModal() {
    clearAcceptOfflinePreviewFetch();
    var modal = document.getElementById('modalAcceptOffline');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      modal.style.display = '';
    }
    var hintEl = document.getElementById('acceptOfflineHint');
    if (hintEl) hintEl.textContent = '';
    var confirmBtn = document.getElementById('acceptOfflineBtnConfirm');
    if (confirmBtn) confirmBtn.disabled = false;
    acceptOfflinePending = null;
    var jobHint = document.getElementById('acceptJobHint');
    if (jobHint && jobHint.textContent && jobHint.textContent.indexOf('Ordnerauswahl') !== -1) {
      jobHint.textContent = '';
    }
  }

  function collectCheckedOfflinePaths() {
    var out = [];
    if (acceptOfflinePending && acceptOfflinePending.selectedKeys && acceptOfflinePending.selectedKeys.size) {
      var validKeys = acceptOfflinePending.validKeys || new Set();
      acceptOfflinePending.selectedKeys.forEach(function (key) {
        if (validKeys.size && !validKeys.has(key)) return;
        var p = offlinePathFromKey(key);
        if (p && p.path) out.push({ fab: p.fab, path: p.path, kind: p.kind || 'dir' });
      });
      return out;
    }
    var bodyEl = document.getElementById('acceptOfflineBody');
    if (!bodyEl) return out;
    bodyEl.querySelectorAll('input[type="checkbox"][data-offline-path]:checked').forEach(function (cb) {
      var fab = cb.getAttribute('data-fab');
      var rel = cb.getAttribute('data-offline-path-val') || cb.getAttribute('data-offline-path');
      var kind = cb.getAttribute('data-offline-kind') || 'dir';
      if (fab && rel) out.push({ fab: fab, path: rel, kind: kind });
    });
    return out;
  }

  function setAllOfflineCheckboxes(checked) {
    if (!acceptOfflinePending) return;
    var selectedKeys = ensureAcceptOfflineSelectedKeys();
    if (checked) {
      selectedKeys.clear();
      (acceptOfflinePending.validKeys || new Set()).forEach(function (k) {
        selectedKeys.add(k);
      });
    } else {
      selectedKeys.clear();
    }
    var bodyEl = document.getElementById('acceptOfflineBody');
    if (bodyEl) refreshAcceptOfflineCheckboxStates(bodyEl);
  }

  function renderAcceptOfflinePreview(preview) {
    var bodyEl = document.getElementById('acceptOfflineBody');
    var hintEl = document.getElementById('acceptOfflineHint');
    if (!bodyEl) return;
    if (acceptOfflinePending) acceptOfflinePending.lastPreview = preview;
    var remembered = loadRememberedOfflinePaths();
    var validKeys = new Set();
    var expanded = (acceptOfflinePending && acceptOfflinePending.expanded) || {};
    var nodeIndex = {};
    var nodeMeta = {};
    var selectedKeys = ensureAcceptOfflineSelectedKeys();
    var html = '';
    (preview.fabs || []).forEach(function (fabBlock) {
      var fab = fabBlock.fab;
      var fnName = fabBlock.folder_name_canonical || fab;
      var tree = fabBlock.tree || [];
      html += '<div class="accept-offline-fab" style="margin-bottom:0.75rem;">';
      html += '<strong>FN ' + escapeHtml(String(fab)) + '</strong>';
      html += ' <span class="muted">(' + escapeHtml(String(fnName)) + ')</span>';
      if (!tree.length) {
        html += '<p class="muted" style="font-size:0.85rem;margin:0.35rem 0;">Keine Projektordner am Server – nur Status/Struktur offline.</p>';
      } else {
        buildAcceptOfflineNodeIndex(fab, tree, nodeIndex, [], nodeMeta, '');
        html += renderAcceptOfflineTreeNodes(
          fab,
          tree,
          0,
          expanded,
          selectedKeys,
          validKeys,
          nodeMeta,
          nodeIndex,
          '',
        );
      }
      html += '</div>';
    });
    bodyEl.innerHTML = html || '<p class="muted">Keine PROJEKTE-NEU-Ordner verfügbar.</p>';
    bindAcceptOfflineTreeEvents(bodyEl);
    if (acceptOfflinePending && !acceptOfflinePending.selectedKeysInitialized) {
      selectedKeys.clear();
      remembered.forEach(function (p) {
        var k =
          p && typeof p === 'object'
            ? offlinePathKey(p.fab, p.path, p.kind || 'dir')
            : String(p || '');
        if (validKeys.has(k)) selectedKeys.add(k);
      });
      acceptOfflinePending.selectedKeysInitialized = true;
    }
    refreshAcceptOfflineCheckboxStates(bodyEl);
    if (hintEl) {
      hintEl.textContent = preview.preview_degraded
        ? (preview.hint || preview.error || 'Vorschau eingeschränkt – Sie können trotzdem annehmen (ohne Projektdateien).')
        : 'Dokumente_Dispo und Dokumente_Buchhaltung werden immer vollständig geladen. Hier nur PROJEKTE NEU wählen; TED liegt im Anlagenstamm.';
    }
    if (acceptOfflinePending) {
      acceptOfflinePending.validKeys = validKeys;
      acceptOfflinePending.nodeIndex = nodeIndex;
      acceptOfflinePending.nodeMeta = nodeMeta;
      if (!acceptOfflinePending.expanded) acceptOfflinePending.expanded = expanded;
    }
    var confirmBtn = document.getElementById('acceptOfflineBtnConfirm');
    if (confirmBtn) confirmBtn.disabled = false;
  }

  function openAcceptOfflineModal(localJobId, triggerButton) {
    var errMsg = validateAcceptJobPrerequisites(localJobId, { allowOffline: true });
    var hint = document.getElementById('acceptJobHint');
    if (errMsg) {
      if (hint) hint.textContent = errMsg;
      return;
    }
    if (shouldPreferOfflineAccept()) {
      runAcceptJobOffline(localJobId, triggerButton, { offline_paths: {} });
      return;
    }
    var modal = document.getElementById('modalAcceptOffline');
    var bodyEl = document.getElementById('acceptOfflineBody');
    if (!modal || !bodyEl) {
      runAcceptJobOffline(localJobId, triggerButton, { offline_paths: {} });
      return;
    }
    clearAcceptOfflinePreviewFetch();
    acceptOfflinePending = {
      localJobId: localJobId,
      triggerButton: triggerButton,
      fab_map: [],
      montage_folder_name: null,
      selectedKeys: null,
      selectedKeysInitialized: false,
      expanded: {},
    };
    acceptOfflinePreviewTriggerBtn = triggerButton && triggerButton.nodeType === 1 ? triggerButton : null;
    setAcceptOfflinePreviewTriggerBusy(true);
    if (hint) hint.textContent = 'Verbinde mit Dispo – Ordnerauswahl wird geladen …';
    if (typeof showToast === 'function') showToast('Ordnerauswahl wird geladen …');
    bodyEl.innerHTML = acceptOfflineLoadingHtml('Verbinde mit Dispo …');
    var confirmBtn = document.getElementById('acceptOfflineBtnConfirm');
    if (confirmBtn) confirmBtn.disabled = true;
    var hintEl = document.getElementById('acceptOfflineHint');
    if (hintEl) hintEl.textContent = '';
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    var loadStart = Date.now();
    acceptOfflinePreviewTimer = setInterval(function () {
      var sec = Math.floor((Date.now() - loadStart) / 1000);
      var msgEl = document.getElementById('acceptOfflineLoadingMsg');
      if (msgEl) {
        msgEl.textContent = 'Verbinde mit Dispo … (' + sec + ' s – langsame Verbindung?)';
      }
      var bar = document.getElementById('acceptOfflineLoadingBar');
      if (bar) {
        var pct = Math.min(95, Math.floor((sec / 90) * 100));
        try {
          bar.value = pct;
        } catch (_) {}
      }
    }, 1000);
    acceptOfflinePreviewAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var previewTimeoutId = setTimeout(function () {
      if (acceptOfflinePreviewAbort) {
        try {
          acceptOfflinePreviewAbort.abort();
        } catch (_) {}
      }
    }, ACCEPT_OFFLINE_PREVIEW_TIMEOUT_MS);
    var q =
      'job_id=' + encodeURIComponent(localJobId) +
      '&technician_id=' + encodeURIComponent(getTechId()) +
      '&dispoBaseUrl=' + encodeURIComponent(getDispoBaseUrl() || '');
    var extra = dispoBasePayloadExtra();
    if (extra.externalUrl) q += '&externalUrl=' + encodeURIComponent(extra.externalUrl);
    if (extra.internalUrl) q += '&internalUrl=' + encodeURIComponent(extra.internalUrl);
    if (getDispoUsername()) q += '&dispo_username=' + encodeURIComponent(getDispoUsername());
    if (getDispoPassword()) q += '&dispo_password=' + encodeURIComponent(getDispoPassword());
    var fetchOpts = {};
    if (acceptOfflinePreviewAbort) fetchOpts.signal = acceptOfflinePreviewAbort.signal;
    fetch(API_BASE + '/api/dienstreise/accept_offline_preview?' + q, fetchOpts)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || 'Vorschau fehlgeschlagen.');
        if (!acceptOfflinePending || acceptOfflinePending.localJobId !== localJobId) return;
        acceptOfflinePending.fab_map = data.fab_map || [];
        acceptOfflinePending.montage_folder_name = data.montage_folder_name || null;
        renderAcceptOfflinePreview(data);
        if (confirmBtn) confirmBtn.disabled = false;
        if (hint) hint.textContent = '';
      })
      .catch(function (err) {
        if (!acceptOfflinePending || acceptOfflinePending.localJobId !== localJobId) return;
        var aborted = err && err.name === 'AbortError';
        bodyEl.innerHTML =
          '<p class="muted">' +
          escapeHtml(
            aborted
              ? 'Zeitüberschreitung bei der Dispo-Verbindung.'
              : err && err.message
                ? err.message
                : 'Vorschau fehlgeschlagen.',
          ) +
          '</p>';
        if (hintEl) {
          hintEl.textContent = aborted
            ? '„Keine“ wählen → nur Status/Struktur offline. Oder erneut versuchen.'
            : 'Sie können „Keine“ wählen und ohne Projektdateien annehmen.';
        }
        acceptOfflinePending.previewFailed = true;
        acceptOfflinePending.fab_map = [];
        if (confirmBtn) confirmBtn.disabled = false;
        if (hint && !aborted) hint.textContent = hintEl ? hintEl.textContent : '';
      })
      .finally(function () {
        clearTimeout(previewTimeoutId);
        if (acceptOfflinePreviewTimer) {
          clearInterval(acceptOfflinePreviewTimer);
          acceptOfflinePreviewTimer = null;
        }
        acceptOfflinePreviewAbort = null;
        setAcceptOfflinePreviewTriggerBusy(false);
      });
  }

  function runAcceptJobStream(localJobId, triggerButton, acceptOpts) {
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

    var body = Object.assign({
      job_id: localJobId,
      dispoBaseUrl: getDispoBaseUrl(),
      technicianId: getTechId(),
      dispoUsername: getDispoUsername(),
      dispoPassword: getDispoPassword(),
      include_bilder: false
    }, dispoBasePayloadExtra());
    if (acceptOpts && Object.prototype.hasOwnProperty.call(acceptOpts, 'offline_paths')) {
      body.offline_paths = acceptOpts.offline_paths;
      if (acceptOpts.fab_map) body.fab_map = acceptOpts.fab_map;
      if (acceptOpts.montage_folder_name) body.montage_folder_name = acceptOpts.montage_folder_name;
    }
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

  function isProjektdatenViewVisible() {
    var el = document.getElementById('viewProjektdaten');
    return !!(el && el.classList.contains('active'));
  }

  function pickStartActiveJob(jobs) {
    var arr = Array.isArray(jobs) ? jobs : [];
    var inArbeit = arr.filter(function (j) {
      return j && String(j.status || '').trim().toLowerCase() === 'in_arbeit';
    });
    if (!inArbeit.length) return null;
    return sortOpenJobsByEinsatzdatumAsc(inArbeit)[0];
  }

  /** Nur Baustellen-Ansprechpartner (job_contacts / baustellen_ansprechpartner), nicht Kundenkontakt. */
  function normalizeJobContactRow(c) {
    c = c || {};
    var phone = (c.phone != null ? String(c.phone) : '').trim();
    var mobile = (c.mobile != null ? String(c.mobile) : '').trim();
    var legacyPhone = (c.contact_phone != null ? String(c.contact_phone) : '').trim();
    // contact_phone ist Legacy-Spiegel (phone||mobile) – nicht als Festnetz übernehmen, wenn es die Mobilnummer ist.
    if (!phone && legacyPhone && legacyPhone !== mobile) phone = legacyPhone;
    if (phone && mobile && phone === mobile) phone = '';
    return {
      first_name: (c.first_name != null ? String(c.first_name) : '').trim(),
      last_name: (c.last_name != null ? String(c.last_name) : '').trim(),
      title: (c.title != null ? String(c.title) : '').trim(),
      department: (c.department != null ? String(c.department) : '').trim(),
      phone: phone,
      mobile: mobile,
      email: (c.email != null ? String(c.email) : (c.contact_email != null ? String(c.contact_email) : '')).trim(),
      contact_name: (c.contact_name != null ? String(c.contact_name) : (c.contactName != null ? String(c.contactName) : '')).trim()
    };
  }

  function formatJobContactDisplayName(c) {
    var row = normalizeJobContactRow(c);
    if (row.contact_name) return row.contact_name;
    return (row.first_name + ' ' + row.last_name).trim();
  }

  function getJobContactAnzeigenameField(c) {
    var row = normalizeJobContactRow(c);
    var combined = (row.first_name + ' ' + row.last_name).trim();
    if (row.contact_name && row.contact_name !== combined) return row.contact_name;
    return '';
  }

  function jobContactRowHasAny(row) {
    return !!(row.first_name || row.last_name || row.title || row.department || row.phone || row.mobile || row.email || row.contact_name);
  }

  function normalizeDialCountryCode(cc) {
    var s = String(cc == null ? '' : cc).trim().replace(/\s+/g, '');
    if (!s || s === '+') return '';
    if (s.charAt(0) !== '+') s = '+' + s.replace(/^\++/, '');
    return s;
  }

  function composeMobilePhone(cc, area, number) {
    var dial = normalizeDialCountryCode(cc);
    var areaPart = String(area == null ? '' : area).trim();
    var num = String(number == null ? '' : number).trim().replace(/\s+/g, ' ');
    var parts = [];
    if (dial) parts.push(dial);
    if (areaPart) parts.push(areaPart);
    if (num) parts.push(num);
    return parts.join(' ');
  }

  function composeLandlinePhone(cc, area, number, ext) {
    var dial = normalizeDialCountryCode(cc);
    var areaPart = String(area == null ? '' : area).trim();
    var num = String(number == null ? '' : number).trim();
    var extension = String(ext == null ? '' : ext).trim();
    var parts = [];
    if (dial) parts.push(dial);
    if (areaPart) parts.push(areaPart);
    if (num) parts.push(num);
    if (!parts.length && !extension) return '';
    var base = parts.join(' ');
    if (extension) return base ? (base + ' - ' + extension) : extension;
    return base;
  }

  function isLikelyOnlyCountryCode(value) {
    return /^\+\d{1,4}$/.test(String(value == null ? '' : value).trim().replace(/\s+/g, ''));
  }

  function parseMobilePhone(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return { cc: '+', area: '', number: '' };
    var dial = '+';
    var rest = raw;
    var compact = raw.replace(/\s+/g, '');
    if (/^\+\d{1,4}$/.test(compact)) {
      return { cc: compact, area: '', number: '' };
    }
    var m = raw.match(/^(\+\d{1,4})\s+(.*)$/);
    if (m) {
      dial = m[1];
      rest = String(m[2] || '').trim();
    } else if (/^(\+\d{1,4})(.*)$/.test(raw)) {
      var m2 = raw.match(/^(\+\d{1,4})\s*(.*)$/);
      if (m2) {
        dial = m2[1];
        rest = String(m2[2] || '').trim();
      }
    }
    var tokens = rest.split(/\s+/).filter(Boolean);
    if (!tokens.length) return { cc: dial, area: '', number: '' };
    if (tokens.length === 1) return { cc: dial, area: '', number: tokens[0] };
    return { cc: dial, area: tokens[0], number: tokens.slice(1).join(' ') };
  }

  function parseLandlinePhone(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return { cc: '+', area: '', number: '', ext: '' };
    var extension = '';
    var extMatch = raw.match(/\s+-\s+(\S+)\s*$/);
    if (extMatch) {
      extension = extMatch[1];
      raw = raw.slice(0, extMatch.index).trim();
    }
    var dial = '+';
    var rest = raw;
    var compact = raw.replace(/\s+/g, '');
    if (/^\+\d{1,4}$/.test(compact)) {
      return { cc: compact, area: '', number: '', ext: extension };
    }
    var m = raw.match(/^(\+\d{1,4})\s+(.*)$/);
    if (m) {
      dial = m[1];
      rest = String(m[2] || '').trim();
    }
    var tokens = rest.split(/\s+/).filter(Boolean);
    if (!tokens.length) return { cc: dial, area: '', number: '', ext: extension };
    if (tokens.length === 1) return { cc: dial, area: '', number: tokens[0], ext: extension };
    return { cc: dial, area: tokens[0], number: tokens.slice(1).join(' '), ext: extension };
  }

  /** Prefill für Edit-UI; Legacy phone=+CC + mobile=Nummer → Mobil. */
  function splitJobContactPhonesForEdit(row) {
    var phone = (row && row.phone) ? String(row.phone).trim() : '';
    var mobile = (row && row.mobile) ? String(row.mobile).trim() : '';
    // Gleicher String in phone und mobile (Legacy-Spiegel) → nur Mobil anzeigen
    if (phone && mobile && phone === mobile) {
      phone = '';
    }
    if (isLikelyOnlyCountryCode(phone) && mobile && mobile.charAt(0) !== '+') {
      return {
        mobile: parseMobilePhone(composeMobilePhone(phone, '', mobile)),
        landline: { cc: '+', area: '', number: '', ext: '' }
      };
    }
    return {
      mobile: parseMobilePhone(mobile),
      landline: parseLandlinePhone(phone)
    };
  }

  function getBaustellenContactsForJob(job) {
    if (!job || typeof job !== 'object') return [];
    var out = [];
    if (Array.isArray(job.job_contacts)) {
      job.job_contacts.forEach(function (c) {
        var row = normalizeJobContactRow(c);
        if (jobContactRowHasAny(row)) out.push(row);
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
      out.push(normalizeJobContactRow({ contact_name: bName, contact_phone: bPhone, contact_email: bEmail }));
    }
    return out;
  }

  function renderJobContactDisplayLines(c) {
    var row = normalizeJobContactRow(c);
    var lines = [];
    var name = formatJobContactDisplayName(row);
    if (name) lines.push('<strong>' + escapeHtml(name) + '</strong>');
    if (row.title) lines.push(escapeHtml(row.title));
    if (row.department) lines.push(escapeHtml(row.department));
    if (row.mobile) lines.push('Telefon Mobil: ' + escapeHtml(row.mobile));
    if (row.phone) lines.push('Telefon Fest: ' + escapeHtml(row.phone));
    if (row.email) lines.push(escapeHtml(row.email));
    return lines;
  }

  function renderJobContactPhoneDlHtml(row, emptyDash) {
    var html = '';
    if (row.mobile) html += '<dt>Telefon Mobil</dt><dd>' + escapeHtml(row.mobile) + '</dd>';
    if (row.phone) html += '<dt>Telefon Fest</dt><dd>' + escapeHtml(row.phone) + '</dd>';
    if (!html) html = '<dt>Telefon</dt><dd>' + (emptyDash ? '–' : '') + '</dd>';
    return html;
  }

  function renderJobContactPhoneArchivHtml(row, v) {
    var html = '';
    if (row.mobile) html += '<dt>Telefon Mobil</dt><dd>' + v(row.mobile) + '</dd>';
    if (row.phone) html += '<dt>Telefon Fest</dt><dd>' + v(row.phone) + '</dd>';
    if (!html) html = '<dt>Telefon</dt><dd>' + v('') + '</dd>';
    return html;
  }

  function renderJobSiteContactsProjektdatenHtml(job) {
    var contacts = getBaustellenContactsForJob(job);
    if (!contacts.length) {
      return '<dl class="modal-detail-dl">'
        + '<dt>Ansprechpartner</dt><dd>–</dd>'
        + '<dt>Telefon</dt><dd>–</dd>'
        + '<dt>E-Mail</dt><dd>–</dd>'
        + '</dl>';
    }
    if (contacts.length === 1) {
      var row = contacts[0];
      var name = formatJobContactDisplayName(row) || '–';
      var email = row.email || '–';
      return '<dl class="modal-detail-dl">'
        + '<dt>Ansprechpartner</dt><dd>' + escapeHtml(name) + (row.title ? '<br><span class="muted">' + escapeHtml(row.title) + '</span>' : '') + (row.department ? '<br><span class="muted">' + escapeHtml(row.department) + '</span>' : '') + '</dd>'
        + renderJobContactPhoneDlHtml(row, true)
        + '<dt>E-Mail</dt><dd>' + escapeHtml(email) + '</dd>'
        + '</dl>';
    }
    var blocks = contacts.map(function (c, idx) {
      var lines = renderJobContactDisplayLines(c);
      return '<div class="job-site-contact-block">'
        + '<div class="job-site-contact-block-title">Ansprechpartner ' + (idx + 1) + '</div>'
        + '<div class="job-site-contact-block-body">' + (lines.length ? lines.join('<br>') : '–') + '</div></div>';
    }).join('');
    return '<div class="job-site-contacts-list">' + blocks + '</div>';
  }

  function renderArchivJobContactsHtml(job, v) {
    var contacts = getBaustellenContactsForJob(job);
    if (!contacts.length) {
      return '<dt>Ansprechpartner</dt><dd>' + v('') + '</dd>'
        + '<dt>Telefon</dt><dd>' + v('') + '</dd>'
        + '<dt>E-Mail</dt><dd>' + v('') + '</dd>';
    }
    if (contacts.length === 1) {
      var row = contacts[0];
      return '<dt>Ansprechpartner</dt><dd>' + v(formatJobContactDisplayName(row)) + (row.title ? '<br>' + v(row.title) : '') + '</dd>'
        + renderJobContactPhoneArchivHtml(row, v)
        + '<dt>E-Mail</dt><dd>' + v(row.email) + '</dd>';
    }
    return contacts.map(function (c, idx) {
      return '<dt>Ansprechpartner ' + (idx + 1) + '</dt><dd>' + v(formatJobContactDisplayName(c)) + '</dd>'
        + renderJobContactPhoneArchivHtml(normalizeJobContactRow(c), v)
        + '<dt>E-Mail</dt><dd>' + v(c.email) + '</dd>';
    }).join('');
  }

  function renderStartJobContactsHtml(job) {
    var lines = [];
    getBaustellenContactsForJob(job).forEach(function (c) {
      var contactLines = renderJobContactDisplayLines(c);
      if (!contactLines.length) return;
      lines.push('<span class="start-contact-line">' + contactLines.join('<br>') + '</span>');
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
    var prevActiveJobId = startPageActiveJobId;
    startPageActiveJobId = job.id;
    startPageActiveJobSnapshot = job;
    var sameJob = jobIdsEqual(prevActiveJobId, job.id);
    var firma = (job.customer_name || job.customerName || '').trim();
    var ort = (job.city || '').trim();
    var land = normalizeCountryToCode(job.country) || (job.country || '').trim().toUpperCase().slice(0, 2);
    var flagHtml = countryFlagImg(land);
    var parts = [];
    if (flagHtml) parts.push(flagHtml);
    if (firma) parts.push(escapeHtml(firma));
    if (ort) parts.push(escapeHtml(ort));
    setElementHtmlIfChanged(titleEl, parts.join(' ') || '<span class="empty">Auftrag</span>');
    if (subEl) setElementHtmlIfChanged(subEl, renderStartJobContactsHtml(job));
    if (metaEl) {
      var dateStr = formatDateRange(job.start_datetime, job.end_datetime);
      var stClass = jobStatusBadgeClass(job.status);
      var stLabel = jobStatusDisplayLabel(job.status);
      setElementHtmlIfChanged(
        metaEl,
        escapeHtml(dateStr) +
          ' · <span class="status-badge status-' +
          stClass +
          '">' +
          escapeHtml(stLabel) +
          '</span>'
      );
    }
    // Gleicher Auftrag (z. B. nach Sync): Soft-Refresh — Ordner offen lassen, kein Flackern.
    loadDienstreiseExplorer(job.id, sameJob ? startExplorerSubpath : '', 'start', {
      soft: sameJob,
    });
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
    return subEl && subEl.value ? subEl.value : 'Dokumente_Anlage';
  }

  function uploadDienstreiseFiles(localJobId, relativeDir, fileList, hintEl) {
    if (!localJobId || !fileList || !fileList.length) {
      if (hintEl) hintEl.textContent = 'Keine Dateien.';
      return Promise.resolve(false);
    }
    var relDir = (relativeDir || 'Dokumente_Anlage').replace(/\\/g, '/').replace(/\/+$/, '');
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
      if (okCount) {
        if (getDienstreiseExplorerJobId('start') == localJobId) {
          loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start');
        }
        if (getDienstreiseExplorerJobId('modal') == localJobId) {
          loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal');
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

  function getDienstreiseExplorerJobId(uiKey) {
    if (uiKey === 'start') return startPageActiveJobId;
    if (uiKey === 'page') return selectedJobIdOnDienstreisePage;
    if (uiKey === 'modal') return jobDetailsJobId || selectedJobIdOnDienstreisePage;
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
        setExpanded: function (map) {
          startExplorerExpanded = map && typeof map === 'object' ? map : {};
        },
        clearExpanded: function () {
          startExplorerExpanded = {};
        },
        getLoadedJobId: function () {
          return startExplorerLoadedJobId;
        },
        setLoadedJobId: function (id) {
          startExplorerLoadedJobId = id != null ? parseInt(id, 10) || null : null;
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
      setExpanded: function (map) {
        dienstreiseExplorerExpanded = map && typeof map === 'object' ? map : {};
      },
      clearExpanded: function () {
        dienstreiseExplorerExpanded = {};
      },
      getLoadedJobId: function () {
        return dienstreiseExplorerLoadedJobId;
      },
      setLoadedJobId: function (id) {
        dienstreiseExplorerLoadedJobId = id != null ? parseInt(id, 10) || null : null;
      },
    };
  }

  function updateDienstreiseWriteControlsState() {
    var jid = getDienstreiseExplorerJobId('modal');
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
    var startJid = getDienstreiseExplorerJobId('start');
    var startSnap = startJid ? getDienstreiseJobSnapshotByLocalId(startJid) : null;
    var startRo = isJobAngelegtReadOnly(startSnap);
    if (startUp) startUp.disabled = !!startRo;
    if (startFi) startFi.disabled = !!startRo;
    if (startSub) startSub.disabled = !!startRo;
    if (startMk) startMk.disabled = !!startRo;
    if (startMkName) startMkName.disabled = !!startRo;
    if (startMkParent) startMkParent.disabled = !!startRo;
    if (startDrop) {
      startDrop.classList.toggle('start-drop-readonly', !!startRo);
      startDrop.setAttribute('aria-disabled', startRo ? 'true' : 'false');
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
    // Hintergrund-Refresh (Sync): Ansicht nicht wechseln, wenn Nutzer woanders ist (z. B. Anlagenstamm).
    if (options.syncPullRefresh && !isProjektdatenViewVisible()) {
      return;
    }
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
        body: JSON.stringify(Object.assign({
          baseUrl: baseUrl,
          jobId: jobId,
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        }, dispoBasePayloadExtra()))
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

  /** Fabrikationsnummern aufsteigend (numerisch wenn möglich, sonst localeCompare). */
  function compareFabrikationsnummer(a, b) {
    var sa = String(a == null ? '' : a).trim();
    var sb = String(b == null ? '' : b).trim();
    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;
    var na = /^\d+$/.test(sa) ? parseInt(sa, 10) : NaN;
    var nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : NaN;
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return sa.localeCompare(sb, 'de', { numeric: true, sensitivity: 'base' });
  }

  function sortLeistungRowsByFab(rows) {
    return (rows || []).slice().sort(function (a, b) {
      return compareFabrikationsnummer(a && a.fabrikationsnummer, b && b.fabrikationsnummer);
    });
  }

  function sortFabrikationsnummerStrings(list) {
    return (list || []).slice().sort(compareFabrikationsnummer);
  }

  function formatFabrikationsnummernInputValue(rows) {
    if (!rows || !rows.length) return '';
    return sortFabrikationsnummerStrings(
      rows.map(function (r) { return String(r && r.fabrikationsnummer != null ? r.fabrikationsnummer : '').trim(); }).filter(Boolean),
    ).join('; ');
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
      dms_position: '',
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
    return sortLeistungRowsByFab(out);
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
              dms_position: '',
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
          dms_position: get(r, ['dms_position', 'DMS Position', 'dmsPosition']),
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
      leistungRows.push({ fabrikationsnummer: '', type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', dms_position: '', tacho: '', elektronik: '', material: '', position: '', geliefert_ueber: '', projekt: '', bemerkungen: '' });
    }
    return sortLeistungRowsByFab(leistungRows);
  }

  function leistungRowsForJobPatch(rows) {
    var arr = (rows || []).filter(leistungRowHasVisibleData);
    return sortLeistungRowsByFab(arr.length > 0 ? arr : (rows || []).slice());
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
      dms_position: sanitizeLeistungField(fields.dms_position),
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
    'type', 'leistung', 'nenngeschwindigkeit', 'kraftaufnehmer', 'dms_nr', 'dms_position',
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
    var arr = sortLeistungRowsByFab((rows || []).filter(leistungRowHasVisibleData));
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
      html += '<details class="projektdaten-meta-details">';
      html += '<summary>Adressen &amp; Kontakt</summary>';
      html += '<div class="projektdaten-meta-details-body">';
      html += '<div class="modal-detail-section modal-detail-section-address-row">';
      html += '<div class="modal-address-contact-row">';
      html += '<div class="modal-detail-section"><h4>Auftragsadresse</h4><p class="modal-address job-site-address-display' + (readOnlyAngelegt ? ' job-site-address-readonly' : '') + '" data-job-id="' + escapeHtml(String(job.id)) + '"' + (readOnlyAngelegt ? '' : ' title="Doppelklick zum Bearbeiten"') + '>' + addressLine + '</p>' + (readOnlyAngelegt ? '' : '<p class="modal-hotel-hint muted">Doppelklick zum Bearbeiten</p>') + '</div>';
      html += '<div class="modal-detail-section modal-hotel-display-wrap"><h4>Hotel Adresse</h4><p class="modal-address hotel-address-display' + (readOnlyAngelegt ? ' hotel-address-readonly' : '') + '" data-job-id="' + escapeHtml(String(job.id)) + '"' + (readOnlyAngelegt ? '' : ' title="Doppelklick zum Bearbeiten"') + '>' + hotelAddressLine + '</p>' + (readOnlyAngelegt ? '' : '<p class="modal-hotel-hint muted">Doppelklick zum Bearbeiten</p>') + '</div>';
      html += '<div class="modal-detail-section"><h4>Kontakt (Baustellen-Ansprechpartner)</h4>';
      html += '<div class="job-site-contact-display' + (readOnlyAngelegt ? ' job-site-contact-readonly' : '') + '" data-job-id="' + escapeHtml(String(job.id)) + '"' + (readOnlyAngelegt ? '' : ' title="Doppelklick zum Bearbeiten"') + '>';
      html += renderJobSiteContactsProjektdatenHtml(job);
      html += '</div>' + (readOnlyAngelegt ? '' : '<p class="modal-hotel-hint muted">Doppelklick zum Bearbeiten</p>') + '</div>';
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
      html += '<option value="Dokumente_Anlage" selected>Dokumente_Anlage (temporär)</option>';
      html += '</select>';
      html += '<input type="file" id="dienstreiseFileInput" accept="*" style="max-width: 220px;" />';
      html += '<button type="button" class="btn btn-ghost" id="btnDienstreiseUpload">Hochladen</button>';
      html += '</div>';
      html += '<p class="muted" style="font-size:0.8rem;margin:0.25rem 0;">Temporäre Uploads – werden beim Abschluss gelöscht.</p>';
      html += '<span id="dienstreiseUploadHint" class="settings-saved-hint" aria-live="polite"></span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="modal-detail-section" id="mechanikTedLinksContainer"><h4>Mechanik-Excel (TED)</h4><p class="muted">Wird geladen…</p></div>';
    if (job.description) html += '<div class="modal-detail-section modal-detail-section-description"><h4>Bemerkungen</h4><div class="modal-description-wrap"><div class="modal-description-display">' + formatDescriptionForDisplay(job.description) + '</div></div></div>';
    return html;
  }

  /** @returns {string[]} Fabrikationsnummern aufsteigend nach FN. */
  function parseJobFabrikationsnummernOrdered(job) {
    var raw = job && job.fabrikationsnummern;
    if (raw == null || raw === '') return [];
    var out = [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        out = parsed.map(function (r) {
          if (r && typeof r === 'object') return String(r.fabrikationsnummer || r.Fabrikationsnummer || '').trim();
          if (r != null) return String(r).trim();
          return '';
        }).filter(Boolean);
      }
    } catch (e) { /* legacy Semikolon/Komma */ }
    if (!out.length) {
      out = String(raw).split(/[\s;,]+/).map(function (p) { return p.trim(); }).filter(Boolean);
    }
    return sortFabrikationsnummerStrings(out);
  }

  /** Anzeigename des PROJEKTE-NEU-Fabrikationsordners (Sidebar Projektdaten). */
  function projekteNeuFolderLabel(fab, folderName) {
    var folder = String(folderName || '').trim();
    if (folder) return folder;
    return String(fab || '').trim();
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
  var mechanikTedPullInFlightByJob = {};
  var mechanikTedPullLastStartedAt = {};
  var mechanikTedPulledForJobId = null;
  var MECHANIK_TED_PULL_MIN_INTERVAL_MS = 30000;

  /**
   * TED-Liste kommt live von Dispo; Projektordner/TED zeigt nur lokal Gespeichertes.
   * Nach Anzeige der FN-Liste fehlende Excel-Dateien nachladen.
   */
  function refreshTedFoldersAfterSync() {
    var seen = {};
    function pullForLocalId(localId) {
      var lid = parseInt(localId, 10);
      if (!lid || seen[lid]) return;
      seen[lid] = true;
      var snap =
        typeof getDienstreiseJobSnapshotByLocalId === 'function' ? getDienstreiseJobSnapshotByLocalId(lid) : null;
      if (!snap || isJobAngelegtReadOnly(snap) || isJobAbgerechnet(snap) || !jobStatusAllowsTedFilePull(snap)) return;
      pullMechanikTedExcelIntoProjectFolder(snap, { forceRetry: true });
    }
    if (window.currentProjektdatenJob && window.currentProjektdatenJob.id != null) {
      pullForLocalId(window.currentProjektdatenJob.id);
    }
    if (typeof startPageActiveJobId !== 'undefined' && startPageActiveJobId) pullForLocalId(startPageActiveJobId);
    if (selectedJobIdOnDienstreisePage) pullForLocalId(selectedJobIdOnDienstreisePage);
  }

  function pullMechanikTedExcelIntoProjectFolder(job, pullOpts) {
    pullOpts = pullOpts || {};
    if (!job || job.id == null) return;
    var localJobId = parseInt(job.id, 10);
    if (!localJobId) return;
    if (isJobAngelegtReadOnly(job) || isJobAbgerechnet(job) || !jobStatusAllowsTedFilePull(job)) return;
    var baseUrl = (getDispoBaseUrl() || '').trim();
    var techId = getTechId();
    if (!baseUrl || !techId || !getDispoUsername() || !getDispoPassword()) return;
    if (mechanikTedPullInFlightByJob[localJobId]) return;
    var last = mechanikTedPullLastStartedAt[localJobId] || 0;
    var forcePull = !!pullOpts.forceRetry || mechanikTedPulledForJobId !== localJobId;
    if (Date.now() - last < MECHANIK_TED_PULL_MIN_INTERVAL_MS && !forcePull) return;
    var serverJobId = job.server_id != null && job.server_id !== '' ? job.server_id : job.id;
    mechanikTedPullLastStartedAt[localJobId] = Date.now();
    mechanikTedPullInFlightByJob[localJobId] = true;
    fetchApiPostJson(
      '/api/mechanik_ted_excel_pull_job',
      {
        baseUrl: baseUrl,
        externalUrl: getDispoExternalUrl(),
        internalUrl: getDispoInternalUrl(),
        jobId: serverJobId,
        local_job_id: localJobId,
        serverUsername: getDispoUsername(),
        serverPassword: getDispoPassword(),
        force: !!pullOpts.forceRetry,
      },
      120000,
    )
      .then(function (data) {
        if (!data || data.ok !== true) {
          console.warn('[ted_pull_job]', data && data.error ? data.error : 'fehlgeschlagen');
          return;
        }
        if (data.present < data.expected) {
          console.warn(
            '[ted_pull_job] unvollständig:',
            data.present + '/' + data.expected,
            'failed=' + (data.failed || 0),
            'job',
            localJobId,
            data.dispo_base_url || '',
          );
          if (!pullOpts.forceRetry && (data.failed || 0) > 0) {
            setTimeout(function () {
              pullMechanikTedExcelIntoProjectFolder(job, { forceRetry: true });
            }, 4000);
          } else if (!pullOpts.forceRetry && data.expected > 0 && data.present === 0) {
            setTimeout(function () {
              pullMechanikTedExcelIntoProjectFolder(job, { forceRetry: true });
            }, 4000);
          }
        }
        if (data.present > 0 && typeof showToast === 'function' && pullOpts.showToastOnComplete) {
          showToast('TED: ' + data.present + ' Datei(en) im Projektordner.');
        }
        if (data.dispo_base_url) {
          var used = String(data.dispo_base_url).trim().replace(/\/+$/, '');
          var extNorm = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
          var intNorm = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
          var src = used === intNorm ? 'internal' : used === extNorm ? 'external' : 'fallback';
          setDispoActiveBase(used, src);
        }
        mechanikTedPulledForJobId = localJobId;
        if (!jobIdsEqual(localJobId, jobDetailsJobId) && localJobId !== startPageActiveJobId) return;
        if (typeof loadDienstreiseExplorer === 'function') {
          if (jobIdsEqual(localJobId, jobDetailsJobId)) {
            loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal', { skipAutoPull: true });
          }
          if (localJobId === startPageActiveJobId) {
            loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start', { skipAutoPull: true });
          }
        }
      })
      .catch(function (e) {
        console.warn('[ted_pull_job]', e && e.message ? e.message : e);
      })
      .finally(function () {
        delete mechanikTedPullInFlightByJob[localJobId];
      });
  }

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
        keysFromApi.slice().sort(compareFabrikationsnummer).forEach(function (f) {
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
        if (jobStatusAllowsTedFilePull(job)) {
          pullMechanikTedExcelIntoProjectFolder(job);
        }
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
    modalHtml += '<div id="anlageDetailProjekteNeuMessage" class="muted" style="margin:0.5rem 0">Aufklappen für Ordnerstruktur und Dateien.</div>';
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
      pnToggle.addEventListener('toggle', function () {
        if (!pnToggle.open) return;
        var treeHostPn = document.getElementById('anlageDetailProjekteNeuTree');
        if (treeHostPn) loadPendingProjekteNeuThumbsIn(treeHostPn);
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
          dms_position: '',
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
    bindJobSiteAddressContactDblclick();
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

  function refreshProjektdatenJobContent(updatedJob) {
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

  function runProjektdatenDispoSyncPush() {
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
              showToast('Änderungen wurden in die Dispo übertragen.');
            } else if (j.status !== 'completed' && typeof showToast === 'function') {
              showToast('Sync fehlgeschlagen: ' + (j.error || j.message || j.status));
            }
          });
        }
        if (typeof showToast === 'function') showToast('Änderungen wurden in die Dispo übertragen.');
      })
      .catch(function (e) {
        console.error('[Sync Push] Fehler:', e.message, e);
        if (typeof showToast === 'function') showToast('Sync fehlgeschlagen: ' + (e.message || 'Verbindung zur Dispo prüfen'));
      });
  }

  function bindJobSiteAddressContactDblclick() {
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    content.querySelectorAll('.job-site-address-display').forEach(function (el) {
      el.addEventListener('dblclick', function () {
        var job = window.currentProjektdatenJob;
        if (job) openJobSiteAddressModal(job);
      });
    });
    content.querySelectorAll('.job-site-contact-display').forEach(function (el) {
      el.addEventListener('dblclick', function () {
        var job = window.currentProjektdatenJob;
        if (job) openJobSiteContactModal(job);
      });
    });
  }

  function openJobSiteAddressModal(job) {
    if (isJobAngelegtReadOnly(job || window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var jobId = job && (job.id != null) ? job.id : jobDetailsJobId;
    if (!jobId) return;
    var attr = function (v) { return escapeHtml(String(v == null ? '' : v)).replace(/"/g, '&quot;'); };
    var modalHtml = '<div id="jobSiteAddressModalOverlay" class="hotel-modal-overlay">';
    modalHtml += '<div class="hotel-modal-card address-card">';
    modalHtml += '<h3>Auftragsadresse (Baustelle)</h3>';
    modalHtml += '<div class="hotel-paste-wrap"><label>Adresse einfügen</label><textarea id="job_site_paste_address" class="hotel-paste-textarea" rows="4" placeholder="Komplette Adresse hier einfügen"></textarea><button type="button" class="btn btn-ghost hotel-paste-btn" id="jobSitePasteApply">In Felder übernehmen</button></div>';
    modalHtml += '<div class="row row-full-width"><div><label>Endkunde / Firma</label><input type="text" id="job_site_edit_endkunde" value="' + attr(job.endkunde) + '" placeholder="Name oder Firma"></div></div>';
    modalHtml += '<div class="row"><div><label>Straße</label><input type="text" id="job_site_edit_street" value="' + attr(job.street) + '"></div><div style="max-width:80px"><label>Hausnr.</label><input type="text" id="job_site_edit_house_number" value="' + attr(job.house_number) + '" maxlength="32"></div></div>';
    modalHtml += '<div class="row row-city-to-edge"><div style="max-width:110px"><label>PLZ</label><input type="text" id="job_site_edit_zip" value="' + attr(job.zip) + '" maxlength="32" autocomplete="postal-code"></div><div><label>Ort</label><input type="text" id="job_site_edit_city" value="' + attr(job.city) + '"></div></div>';
    var currentCountry = (job.country || '').trim();
    modalHtml += '<label>Land</label><div class="hotel-country-select-wrap">';
    modalHtml += '<span id="job_site_edit_country_flag" class="hotel-country-flag" aria-hidden="true"></span>';
    modalHtml += '<select id="job_site_edit_country" autocomplete="off">';
    modalHtml += '<option value="">Bitte wählen</option>';
    var countriesList = (typeof window.HOTEL_COUNTRIES !== 'undefined' && Array.isArray(window.HOTEL_COUNTRIES)) ? window.HOTEL_COUNTRIES : [];
    countriesList.forEach(function (c) {
      var code = (c.code || '').toUpperCase();
      var sel = (currentCountry.toUpperCase() === code || currentCountry === (c.name || '')) ? ' selected' : '';
      var label = (c.name || '') + ' ' + (c.flag || '') + ' (' + (c.code || '') + ')';
      modalHtml += '<option value="' + attr(c.code) + '"' + sel + '>' + escapeHtml(label) + '</option>';
    });
    modalHtml += '</select></div>';
    modalHtml += '<label>Adresszusatz 1</label><input type="text" id="job_site_edit_extra_1" value="' + attr(job.address_extra_1) + '">';
    modalHtml += '<label>Adresszusatz 2</label><input type="text" id="job_site_edit_extra_2" value="' + attr(job.address_extra_2) + '">';
    modalHtml += '<div class="hotel-modal-actions"><button type="button" class="btn btn-primary" id="jobSiteModalSave">Speichern</button> <button type="button" class="btn btn-ghost" id="jobSiteModalCancel">Abbrechen</button></div>';
    modalHtml += '</div></div>';
    var existing = document.getElementById('jobSiteAddressModalOverlay');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    while (div.firstChild) document.body.appendChild(div.firstChild);
    var overlay = document.getElementById('jobSiteAddressModalOverlay');
    if (!overlay) return;
    function closeModal() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    function collectPayload() {
      return {
        job_id: parseInt(jobId, 10),
        endkunde: (document.getElementById('job_site_edit_endkunde') && document.getElementById('job_site_edit_endkunde').value) || '',
        street: (document.getElementById('job_site_edit_street') && document.getElementById('job_site_edit_street').value) || '',
        house_number: (document.getElementById('job_site_edit_house_number') && document.getElementById('job_site_edit_house_number').value) || '',
        zip: (document.getElementById('job_site_edit_zip') && document.getElementById('job_site_edit_zip').value) || '',
        city: (document.getElementById('job_site_edit_city') && document.getElementById('job_site_edit_city').value) || '',
        country: (document.getElementById('job_site_edit_country') && document.getElementById('job_site_edit_country').value) || '',
        address_extra_1: (document.getElementById('job_site_edit_extra_1') && document.getElementById('job_site_edit_extra_1').value) || '',
        address_extra_2: (document.getElementById('job_site_edit_extra_2') && document.getElementById('job_site_edit_extra_2').value) || ''
      };
    }
    function applyPayloadToJob(payload) {
      var updatedJob = Object.assign({}, job, {
        endkunde: payload.endkunde,
        street: payload.street,
        house_number: payload.house_number,
        zip: payload.zip,
        city: payload.city,
        country: payload.country,
        address_extra_1: payload.address_extra_1,
        address_extra_2: payload.address_extra_2
      });
      Object.assign(job, updatedJob);
      window.currentProjektdatenJob = updatedJob;
      return updatedJob;
    }
    function updateCountryFlag() {
      var sel = document.getElementById('job_site_edit_country');
      var flagEl = document.getElementById('job_site_edit_country_flag');
      if (!sel || !flagEl) return;
      var code = (sel.value || '').trim().toUpperCase().slice(0, 2);
      flagEl.innerHTML = code ? countryFlagImg(code) : '';
    }
    updateCountryFlag();
    document.getElementById('job_site_edit_country').addEventListener('change', updateCountryFlag);
    document.getElementById('jobSitePasteApply').addEventListener('click', function () {
      var ta = document.getElementById('job_site_paste_address');
      var parsed = parseHotelAddressPaste(ta ? ta.value : '', countriesList);
      if (parsed.endkunde) document.getElementById('job_site_edit_endkunde').value = parsed.endkunde;
      if (parsed.street) document.getElementById('job_site_edit_street').value = parsed.street;
      if (parsed.house_number) document.getElementById('job_site_edit_house_number').value = parsed.house_number;
      if (parsed.zip) document.getElementById('job_site_edit_zip').value = parsed.zip;
      if (parsed.city) document.getElementById('job_site_edit_city').value = parsed.city;
      if (parsed.country) document.getElementById('job_site_edit_country').value = parsed.country;
      if (parsed.address_extra_1) document.getElementById('job_site_edit_extra_1').value = parsed.address_extra_1;
      if (parsed.address_extra_2) document.getElementById('job_site_edit_extra_2').value = parsed.address_extra_2;
      updateCountryFlag();
    });
    document.getElementById('jobSiteModalCancel').addEventListener('click', closeModal);
    document.getElementById('jobSiteModalSave').addEventListener('click', function () {
      var payload = collectPayload();
      api('/api/job', { method: 'PATCH', body: JSON.stringify(payload) })
        .then(function () {
          var updatedJob = applyPayloadToJob(payload);
          closeModal();
          refreshProjektdatenJobContent(updatedJob);
          runProjektdatenDispoSyncPush();
          if (typeof checkConnectionAndSync === 'function') { try { checkConnectionAndSync({ blockingSync: false }); } catch (e) {} }
        })
        .catch(function (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        });
    });
  }

  function openJobSiteContactModal(job) {
    if (isJobAngelegtReadOnly(job || window.currentProjektdatenJob)) {
      alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var jobId = job && (job.id != null) ? job.id : jobDetailsJobId;
    if (!jobId) return;
    var initialContacts = getBaustellenContactsForJob(job);
    if (!initialContacts.length) {
      initialContacts = [normalizeJobContactRow({})];
    }
    var attr = function (v) { return escapeHtml(String(v == null ? '' : v)).replace(/"/g, '&quot;'); };
    var modalHtml = '<div id="jobSiteContactModalOverlay" class="hotel-modal-overlay">';
    modalHtml += '<div class="hotel-modal-card address-card job-site-contacts-modal">';
    modalHtml += '<h3>Baustellen-Ansprechpartner</h3>';
    modalHtml += '<p class="job-site-contact-form-hint muted">Alle Felder optional. Es wird nur ein Eintrag gespeichert, wenn mindestens ein Feld ausgefüllt ist.</p>';
    modalHtml += '<div id="jobSiteContactsEditor" class="job-site-contacts-editor"></div>';
    modalHtml += '<button type="button" class="btn btn-ghost job-site-contact-add-btn" id="jobSiteContactAdd">+ ANSPRECHPARTNER</button>';
    modalHtml += '<div class="hotel-modal-actions"><button type="button" class="btn btn-primary" id="jobSiteContactSave">Speichern</button> <button type="button" class="btn btn-ghost" id="jobSiteContactCancel">Abbrechen</button></div>';
    modalHtml += '</div></div>';
    var existing = document.getElementById('jobSiteContactModalOverlay');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    while (div.firstChild) document.body.appendChild(div.firstChild);
    var overlay = document.getElementById('jobSiteContactModalOverlay');
    if (!overlay) return;
    var editor = document.getElementById('jobSiteContactsEditor');
    function closeModal() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    function bindRemoveButton(btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.job-site-contact-edit-row');
        if (!row || !row.parentNode) return;
        row.parentNode.removeChild(row);
        if (!editor.querySelector('.job-site-contact-edit-row')) {
          var emptyWrap = document.createElement('div');
          emptyWrap.innerHTML = buildContactRowHtml(normalizeJobContactRow({}), 0, false);
          if (emptyWrap.firstChild) editor.appendChild(emptyWrap.firstChild);
        }
        refreshRemoveButtons();
      });
    }
    function buildContactRowHtml(c, index, showRemove) {
      var row = normalizeJobContactRow(c);
      var phones = splitJobContactPhonesForEdit(row);
      var anzeigename = getJobContactAnzeigenameField(c);
      var rowHtml = '<div class="job-site-contact-edit-row" data-index="' + index + '">';
      rowHtml += '<div class="row job-site-contact-name-row">';
      rowHtml += '<div><label>Vorname</label><input type="text" class="job-site-contact-first-name" value="' + attr(row.first_name) + '"></div>';
      rowHtml += '<div><label>Nachname</label><input type="text" class="job-site-contact-last-name" value="' + attr(row.last_name) + '"></div>';
      rowHtml += '<div class="job-site-contact-title-col"><label>Titel</label><input type="text" class="job-site-contact-title" value="' + attr(row.title) + '"></div>';
      rowHtml += '</div>';
      rowHtml += '<label>Abteilung / Funktion</label><input type="text" class="job-site-contact-department" value="' + attr(row.department) + '">';
      rowHtml += '<div class="row job-site-contact-phone-mobile-row job-site-contact-comm-row">';
      rowHtml += '<div class="job-site-contact-phone-parts">';
      rowHtml += '<label>Telefon Mobil</label>';
      rowHtml += '<div class="job-site-contact-phone-inputs">';
      rowHtml += '<input type="tel" class="job-site-contact-mobile-cc" value="' + attr(phones.mobile.cc) + '" placeholder="+49" title="Ländervorwahl" aria-label="Ländervorwahl Mobil">';
      rowHtml += '<input type="tel" class="job-site-contact-mobile-area" value="' + attr(phones.mobile.area) + '" placeholder="Vorwahl" aria-label="Vorwahl Mobil">';
      rowHtml += '<input type="tel" class="job-site-contact-mobile-num" value="' + attr(phones.mobile.number) + '" placeholder="Nummer" aria-label="Mobilnummer">';
      rowHtml += '</div></div>';
      if (showRemove) {
        rowHtml += '<div class="job-site-contact-remove-col"><label aria-hidden="true">&nbsp;</label><button type="button" class="btn btn-ghost job-site-contact-remove" title="Entfernen" aria-label="Ansprechpartner entfernen">−</button></div>';
      }
      rowHtml += '</div>';
      rowHtml += '<div class="job-site-contact-phone-parts job-site-contact-phone-landline">';
      rowHtml += '<label>Telefon Fest</label>';
      rowHtml += '<div class="job-site-contact-phone-inputs job-site-contact-phone-landline-inputs">';
      rowHtml += '<input type="tel" class="job-site-contact-phone-cc" value="' + attr(phones.landline.cc) + '" placeholder="+49" title="Ländervorwahl" aria-label="Ländervorwahl Festnetz">';
      rowHtml += '<input type="tel" class="job-site-contact-phone-area" value="' + attr(phones.landline.area) + '" placeholder="Vorwahl" aria-label="Ortsvorwahl">';
      rowHtml += '<input type="tel" class="job-site-contact-phone-num" value="' + attr(phones.landline.number) + '" placeholder="Nummer" aria-label="Festnetznummer">';
      rowHtml += '<input type="tel" class="job-site-contact-phone-ext" value="' + attr(phones.landline.ext) + '" placeholder="Durchwahl" aria-label="Durchwahl">';
      rowHtml += '</div></div>';
      rowHtml += '<label>E-Mail</label><input type="email" class="job-site-contact-email" value="' + attr(row.email) + '">';
      rowHtml += '<label>Anzeigename <span class="muted">(optional, falls abweichend von Vor- und Nachname)</span></label>';
      rowHtml += '<input type="text" class="job-site-contact-display-name" value="' + attr(anzeigename) + '">';
      rowHtml += '</div>';
      return rowHtml;
    }
    function refreshRemoveButtons() {
      if (!editor) return;
      var rows = editor.querySelectorAll('.job-site-contact-edit-row');
      rows.forEach(function (row, i) {
        row.setAttribute('data-index', String(i));
        var commRow = row.querySelector('.job-site-contact-comm-row');
        var removeCol = row.querySelector('.job-site-contact-remove-col');
        var removeBtn = row.querySelector('.job-site-contact-remove');
        if (rows.length > 1) {
          if (!removeCol && commRow) {
            var col = document.createElement('div');
            col.className = 'job-site-contact-remove-col';
            col.innerHTML = '<label aria-hidden="true">&nbsp;</label><button type="button" class="btn btn-ghost job-site-contact-remove" title="Entfernen" aria-label="Ansprechpartner entfernen">−</button>';
            commRow.appendChild(col);
            bindRemoveButton(col.querySelector('.job-site-contact-remove'));
          }
        } else if (removeCol) {
          removeCol.remove();
        } else if (removeBtn) {
          removeBtn.remove();
        }
      });
    }
    function renderEditorRows(contacts) {
      if (!editor) return;
      editor.innerHTML = contacts.map(function (c, i) {
        return buildContactRowHtml(c, i, contacts.length > 1);
      }).join('');
      editor.querySelectorAll('.job-site-contact-remove').forEach(bindRemoveButton);
    }
    function readRowContact(row) {
      function val(sel) {
        var el = row.querySelector(sel);
        return el ? String(el.value || '').trim() : '';
      }
      return normalizeJobContactRow({
        first_name: val('.job-site-contact-first-name'),
        last_name: val('.job-site-contact-last-name'),
        title: val('.job-site-contact-title'),
        department: val('.job-site-contact-department'),
        phone: composeLandlinePhone(
          val('.job-site-contact-phone-cc'),
          val('.job-site-contact-phone-area'),
          val('.job-site-contact-phone-num'),
          val('.job-site-contact-phone-ext')
        ),
        mobile: composeMobilePhone(
          val('.job-site-contact-mobile-cc'),
          val('.job-site-contact-mobile-area'),
          val('.job-site-contact-mobile-num')
        ),
        email: val('.job-site-contact-email'),
        contact_name: val('.job-site-contact-display-name')
      });
    }
    function collectContactsFromEditor() {
      if (!editor) return [];
      var contacts = [];
      editor.querySelectorAll('.job-site-contact-edit-row').forEach(function (row) {
        var contact = readRowContact(row);
        if (jobContactRowHasAny(contact)) contacts.push(contact);
      });
      return contacts;
    }
    renderEditorRows(initialContacts);
    document.getElementById('jobSiteContactAdd').addEventListener('click', function () {
      if (!editor) return;
      var count = editor.querySelectorAll('.job-site-contact-edit-row').length;
      var wrapper = document.createElement('div');
      wrapper.innerHTML = buildContactRowHtml(normalizeJobContactRow({}), count, true);
      var row = wrapper.firstChild;
      if (!row) return;
      editor.appendChild(row);
      refreshRemoveButtons();
    });
    document.getElementById('jobSiteContactCancel').addEventListener('click', closeModal);
    document.getElementById('jobSiteContactSave').addEventListener('click', function () {
      var contacts = collectContactsFromEditor();
      var payload = { job_id: parseInt(jobId, 10), job_contacts: contacts };
      api('/api/job', { method: 'PATCH', body: JSON.stringify(payload) })
        .then(function () {
          var updatedJob = Object.assign({}, job, { job_contacts: contacts });
          Object.assign(job, updatedJob);
          window.currentProjektdatenJob = updatedJob;
          closeModal();
          refreshProjektdatenJobContent(updatedJob);
          runProjektdatenDispoSyncPush();
          if (typeof checkConnectionAndSync === 'function') { try { checkConnectionAndSync({ blockingSync: false }); } catch (e) {} }
        })
        .catch(function (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
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
    var ukPostcode = /\b([A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2})\b/i;
    var caPostcode = /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i;
    var nlPostcode = /\b(\d{4}\s+[A-Z]{2})\b/i;
    var iePostcode = /\b([A-Z]\d{2}\s+[A-Z0-9]{4})\b/i;
    var provCaPostcode = /,\s*([A-Z]{2})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)\s*$/i;
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
      var mCA = ln.match(caPostcode);
      var mNL = ln.match(nlPostcode);
      var mIE = ln.match(iePostcode);
      var mProvCA = ln.match(provCaPostcode);
      function setZipAndCity(matchVal, cityOverride) {
        zipVal = matchVal;
        zipLineIdx = z;
        var idx = ln.indexOf(matchVal);
        var before = ln.substring(0, idx).trim().replace(/\s*[•·]\s*$/, '').trim();
        var after = ln.substring(idx + matchVal.length).replace(/\s+/g, ' ').trim();
        cityVal = cityOverride != null ? cityOverride : after;
        if (before && /[a-zA-Z]/.test(before)) zipLineBeforePart = before;
      }
      if (mProvCA) {
        var caZipRaw = mProvCA[2].replace(/\s/g, '').toUpperCase();
        var cityFromProv = ln.replace(/,\s*[A-Z]{2}\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\s*$/i, '').trim();
        if (cityFromProv.indexOf(',') >= 0) {
          var cp = cityFromProv.split(',').map(function (p) { return p.trim(); });
          cityFromProv = cp[cp.length - 1];
        }
        setZipAndCity(caZipRaw.slice(0, 3) + ' ' + caZipRaw.slice(3), cityFromProv);
        if (!out.country) out.country = 'CA';
        break;
      }
      if (m54) { setZipAndCity(m54[1]); break; }
      if (mUK) { setZipAndCity(mUK[1].replace(/\s+/g, ' ').toUpperCase()); break; }
      if (mCA) {
        var caNorm = mCA[1].replace(/\s/g, '').toUpperCase();
        setZipAndCity(caNorm.slice(0, 3) + ' ' + caNorm.slice(3));
        if (!out.country) out.country = 'CA';
        break;
      }
      if (mNL) { setZipAndCity(mNL[1].replace(/\s+/g, ' ').toUpperCase()); break; }
      if (mIE) { setZipAndCity(mIE[1].replace(/\s+/g, ' ').toUpperCase()); break; }
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
    modalHtml += '<div class="row row-city-to-edge"><div style="max-width:110px"><label>PLZ</label><input type="text" id="hotel_edit_zip" value="' + attr(job.hotel_zip) + '" maxlength="32" autocomplete="postal-code"></div><div><label>Ort</label><input type="text" id="hotel_edit_city" value="' + attr(job.hotel_city) + '"></div></div>';
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
      refreshProjektdatenJobContent(updatedJob);
    }
    function runHotelDispoSyncPush() {
      runProjektdatenDispoSyncPush();
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

  function finishFinishJobStreamUi() {
    finishJobStreamBusy = false;
    finishJobActiveLocalJobId = null;
    finishJobLastProgressRow = null;
    finishJobActiveButton = null;
    if (finishJobUiTimeoutId) {
      clearTimeout(finishJobUiTimeoutId);
      finishJobUiTimeoutId = null;
    }
    document.querySelectorAll('[data-action="finish-job"]').forEach(function (b) {
      b.disabled = false;
      b.classList.remove('btn-finish-job--busy');
      var bar = b.querySelector('.btn-finish-job-progress');
      if (bar) {
        try {
          bar.indeterminate = false;
          bar.removeAttribute('value');
        } catch (e) { /* ignore */ }
      }
    });
  }

  function handleFinishJobPollFinished(localJobId, j, hint) {
    if (j.status === 'completed') {
      if (hint) hint.textContent = 'Auftrag abgeschlossen.';
      if (typeof loadJobsAndAbsences === 'function') loadJobsAndAbsences();
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
      setTimeout(function () {
        var x = document.getElementById('finishJobHint');
        if (x) x.textContent = '';
      }, 4000);
    } else {
      var failMsg = j.error || j.message;
      if (j.status === 'interrupted') {
        failMsg =
          failMsg ||
          'Abschluss unterbrochen. Bitte Verbindung prüfen und erneut „Erledigt“ wählen.';
      }
      if (hint) hint.textContent = failMsg || 'Abschluss fehlgeschlagen.';
      if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
    }
  }

  function restoreFinishJobStreamFromBackgroundJobs() {
    if (finishJobStreamBusy || restoreFinishJobBgFetchInFlight) return;
    restoreFinishJobBgFetchInFlight = true;
    fetch(API_BASE + '/api/background_jobs?active=1&limit=80')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var jobs = (data && data.jobs) || [];
        for (var i = 0; i < jobs.length; i++) {
          var bg = jobs[i];
          if (!bg || bg.type !== 'dienstreise_finish' || (bg.status !== 'running' && bg.status !== 'queued')) continue;
          var p = bg.payload || {};
          var localId = parseInt(p.job_id, 10);
          if (!localId) continue;
          var hint = document.getElementById('finishJobHint');
          finishJobStreamBusy = true;
          finishJobActiveLocalJobId = localId;
          finishJobLastProgressRow = {
            progress_phase: bg.progress_phase,
            progress_current: bg.progress_current,
            progress_total: bg.progress_total,
            message: bg.message,
          };
          applyFinishJobStreamBusyUi();
          if (finishJobLastProgressRow) updateFinishJobButtonProgress(finishJobLastProgressRow);
          finishJobUiTimeoutId = setTimeout(function () {
            finishJobUiTimeoutId = null;
            finishFinishJobStreamUi();
            if (hint) hint.textContent = 'Zeitüberschreitung beim Abschluss.';
          }, 25 * 60 * 1000);
          pollBackgroundJobUntilTerminal(
            bg.id,
            function (j) {
              finishJobLastProgressRow = j;
              updateFinishJobButtonProgress(j);
            },
            { maxMs: 25 * 60 * 1000 },
          )
            .then(function (j) {
              if (finishJobUiTimeoutId) {
                clearTimeout(finishJobUiTimeoutId);
                finishJobUiTimeoutId = null;
              }
              finishFinishJobStreamUi();
              handleFinishJobPollFinished(localId, j, hint);
            })
            .catch(function (err) {
              if (finishJobUiTimeoutId) {
                clearTimeout(finishJobUiTimeoutId);
                finishJobUiTimeoutId = null;
              }
              finishFinishJobStreamUi();
              if (hint) hint.textContent = err && err.message ? err.message : 'Abschluss fehlgeschlagen.';
            });
          break;
        }
      })
      .catch(function () {})
      .finally(function () {
        restoreFinishJobBgFetchInFlight = false;
      });
  }

  function applyFinishJobStreamBusyUi() {
    var activeId = finishJobActiveLocalJobId;
    finishJobActiveButton = null;
    document.querySelectorAll('[data-action="finish-job"]').forEach(function (b) {
      var row = b.closest('.job');
      var jid = row ? parseInt(row.getAttribute('data-job-id'), 10) : NaN;
      b.disabled = true;
      if (activeId != null && jid === activeId) {
        finishJobActiveButton = b;
        b.classList.add('btn-finish-job--busy');
        b.disabled = false;
      }
    });
  }

  function updateFinishJobButtonProgress(jobRow) {
    var btn = finishJobActiveButton;
    if (!btn) {
      var lid = finishJobActiveLocalJobId;
      if (lid == null) return;
      var jobEl = document.querySelector('#dienstreiseList .job[data-job-id="' + String(lid) + '"]');
      btn = jobEl ? jobEl.querySelector('[data-action="finish-job"]') : null;
      finishJobActiveButton = btn;
    }
    if (!btn) return;
    var lbl = btn.querySelector('.btn-finish-job-progress-text');
    var bar = btn.querySelector('.btn-finish-job-progress');
    if (!lbl || !bar) return;
    var phase = (jobRow.progress_phase || '').toString();
    var st = (jobRow.status || '').toString();
    var cur = jobRow.progress_current != null ? jobRow.progress_current : 0;
    var tot = jobRow.progress_total != null ? jobRow.progress_total : 0;
    var msg = jobRow.message ? String(jobRow.message) : '';

    if (st === 'queued' && !phase) {
      lbl.textContent = 'Wartet auf Start …';
      try {
        bar.indeterminate = true;
      } catch (eQ) { /* ignore */ }
      return;
    }

    if (
      phase === 'finish_sync' ||
      phase === 'finish_status' ||
      phase === 'start'
    ) {
      lbl.textContent = msg || 'Abschluss läuft …';
      try {
        bar.indeterminate = true;
      } catch (e) { /* ignore */ }
    } else if (phase === 'finish_cleanup') {
      lbl.textContent = msg && String(msg).trim() ? String(msg) : 'Lokale Downloads werden entfernt …';
      if (tot > 0) {
        try {
          bar.indeterminate = false;
          bar.max = tot;
          bar.value = Math.min(cur, tot);
        } catch (e2) { /* ignore */ }
      } else {
        try {
          bar.indeterminate = true;
        } catch (e3) { /* ignore */ }
      }
    } else if (phase === 'finish_verify' || phase === 'finish') {
      lbl.textContent = msg && String(msg).trim() ? String(msg) : 'Abgleich mit Dispo …';
      if (tot > 0) {
        try {
          bar.indeterminate = false;
        } catch (e2) { /* ignore */ }
        bar.max = tot;
        bar.value = Math.min(cur, tot);
      } else {
        try {
          bar.indeterminate = true;
        } catch (e3) { /* ignore */ }
      }
    } else if (msg) {
      lbl.textContent = msg;
    }
  }

  function runFinishJobStream(localJobId, triggerButton) {
    if (finishJobStreamBusy) return;
    var techIdPre = getTechId();
    if (techIdPre) {
      try {
        var snap = getDienstreiseJobSnapshotByLocalId(localJobId);
        if (snap && isJobAngelegtReadOnly(snap)) {
          alert('Auftrag ist angelegt – Bearbeitung in der App nicht erlaubt.');
          return;
        }
      } catch (e) { /* weiter */ }
    }
    if (!confirm('Ist der Auftrag wirklich erledigt?')) return;

    finishJobStreamBusy = true;
    finishJobActiveLocalJobId = localJobId;
    finishJobLastProgressRow = null;
    finishJobActiveButton = triggerButton && triggerButton.nodeType === 1 ? triggerButton : null;
    var hint = document.getElementById('finishJobHint');
    if (hint) {
      hint.textContent =
        'Hinweis: Lokale Downloads werden danach entfernt (auf OneDrive kann das kurz dauern).';
    }
    applyFinishJobStreamBusyUi();

    var protectedSet = getDienstreiseProtectedSet(localJobId);
    var body = {
      job_id: localJobId,
      protectedPaths: Array.from(protectedSet),
      dispoBaseUrl: getDispoBaseUrl(),
      dispoExternalUrl: getDispoExternalUrl(),
      dispoInternalUrl: getDispoInternalUrl(),
      technicianId: getTechId(),
      dispoUsername: getDispoUsername(),
      dispoPassword: getDispoPassword(),
    };

    finishJobUiTimeoutId = setTimeout(function () {
      finishJobUiTimeoutId = null;
      finishFinishJobStreamUi();
      if (hint) hint.textContent = 'Zeitüberschreitung – Abschluss antwortet nicht. Bitte erneut versuchen.';
    }, 25 * 60 * 1000);

    fetch(API_BASE + '/api/dienstreise/finish_and_cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { response: response, data: data };
        });
      })
      .then(function (pack) {
        var response = pack.response;
        var data = pack.data;
        if (!response.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || 'Fehler ' + response.status);
        }
        if (response.status !== 202) {
          throw new Error('Unerwartete Server-Antwort (Status ' + response.status + ').');
        }
        var bgJobId = data && data.job_id;
        if (!bgJobId) throw new Error('Keine job_id vom Server.');
        return pollBackgroundJobUntilTerminal(
          bgJobId,
          function (j) {
            updateFinishJobButtonProgress(j);
          },
          { maxMs: 25 * 60 * 1000 },
        ).then(function (j) {
          if (finishJobUiTimeoutId) {
            clearTimeout(finishJobUiTimeoutId);
            finishJobUiTimeoutId = null;
          }
          finishFinishJobStreamUi();
          handleFinishJobPollFinished(localJobId, j, hint);
        });
      })
      .catch(function (err) {
        if (finishJobUiTimeoutId) {
          clearTimeout(finishJobUiTimeoutId);
          finishJobUiTimeoutId = null;
        }
        finishFinishJobStreamUi();
        var msg = err && err.message ? err.message : 'Unbekannter Fehler';
        if (hint) hint.textContent = msg;
        else alert('Abschluss fehlgeschlagen: ' + msg);
      });
  }

  function finishAndCleanup(jobId, triggerButton) {
    runFinishJobStream(jobId, triggerButton);
  }

  function releaseDienstreiseJob(jobId, triggerButton) {
    if (!jobId) return;
    var techId = getTechId();
    if (!techId) {
      alert('Monteur-ID in Einstellungen eintragen.');
      return;
    }
    var proceed = function (peerWarning) {
      var msg =
        'Auftrag freigeben?\n\nLokale Dateien werden zuerst nach Dispo synchronisiert, danach Status „Zugeteilt“. Auf diesem Gerät wird der Projektordner gelöscht.' +
        (peerWarning ? '\n\n' + peerWarning : '');
      if (!confirm(msg)) return;
      var btn = triggerButton;
      if (btn) btn.disabled = true;
      fetch(API_BASE + '/api/dienstreise/release_job', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Technician-Id': String(techId),
        },
        body: JSON.stringify({
          job_id: jobId,
          technician_id: techId,
          dispoBaseUrl: getDispoBaseUrl(),
          dispoExternalUrl: getDispoExternalUrl(),
          dispoInternalUrl: getDispoInternalUrl(),
          dispoUsername: getDispoUsername(),
          dispoPassword: getDispoPassword(),
          confirm_peers: true,
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data };
          });
        })
        .then(function (res) {
          if (!res.ok || !res.data || !res.data.ok) {
            throw new Error((res.data && res.data.error) || 'Freigabe fehlgeschlagen.');
          }
          if (jobIdsEqual(selectedJobIdOnDienstreisePage, jobId)) {
            selectedJobIdOnDienstreisePage = null;
            if (typeof loadDienstreiseExplorer === 'function') {
              loadDienstreiseExplorer(jobId, '', 'modal', { skipAutoPull: true });
              loadDienstreiseExplorer(jobId, '', 'start', { skipAutoPull: true });
            }
          }
          if (typeof loadJobsAndAbsences === 'function') loadJobsAndAbsences();
          if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
          alert(res.data.warning ? 'Freigegeben.\n\n' + res.data.warning : 'Auftrag freigegeben.');
        })
        .catch(function (e) {
          alert(e.message || 'Freigabe fehlgeschlagen.');
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    };
    try {
      // Optional: Presence-Warnung
      fetch(API_BASE + '/api/device_heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technician_id: techId,
          dispoBaseUrl: getDispoBaseUrl(),
          dispoUsername: getDispoUsername(),
          dispoPassword: getDispoPassword(),
          job_id: jobId,
        }),
      })
        .then(function (r) {
          return r.json().catch(function () {
            return {};
          });
        })
        .then(function (hb) {
          var peers = (hb && hb.peers_on_job) || [];
          var warn = '';
          if (peers.length) {
            warn =
              'Achtung: Auftrag ist auf anderem Gerät noch geöffnet (' +
              peers
                .map(function (p) {
                  return p.display_name || p.device_id;
                })
                .join(', ') +
              '). Freigeben setzt den Status global zurück.';
          }
          proceed(warn);
        })
        .catch(function () {
          proceed('');
        });
    } catch (_) {
      proceed('');
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
    return fetchApiPostJson(
      '/api/check_connection',
      {
        externalUrl: ext,
        internalUrl: intUrl,
        technicianId: getTechId(),
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword(),
      },
      28000,
    ).then(function (check) {
        applyMonteurProfileFromConnection(check);
        if (check && check.used_base_url) {
          var connectedBase = String(check.used_base_url).trim().replace(/\/+$/, '');
          var extNorm = (getDispoExternalUrl() || '').trim().replace(/\/+$/, '');
          var intNorm = (getDispoInternalUrl() || '').trim().replace(/\/+$/, '');
          var src = connectedBase === intNorm ? 'internal' : connectedBase === extNorm ? 'external' : 'fallback';
          setDispoActiveBase(connectedBase, src);
        }
        if (getTechId()) {
          setMonteurProfileResolveHint('Monteur-ID ' + getTechId() + ' (gespeichert).', true);
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

  /** Einstellungen: gespeicherte ID anzeigen; Dispo nur still prüfen (kein Hinweis-Flackern). */
  function refreshMonteurProfileHintForSettings() {
    var tid = getTechId();
    if (tid > 0) {
      setMonteurProfileResolveHint('Monteur-ID ' + tid + ' (gespeichert).', true);
      if (getServerUsername() && getServerPassword() && (getDispoExternalUrl() || getDispoInternalUrl())) {
        verifyMonteurProfileInBackground();
      }
      return;
    }
    if (getServerUsername() && getServerPassword()) {
      resolveMonteurProfileFromDispo();
    }
  }

  var verifyMonteurProfileInBackgroundInFlight = false;
  function verifyMonteurProfileInBackground() {
    var tid = getTechId();
    if (!tid || verifyMonteurProfileInBackgroundInFlight || resolveMonteurProfileInFlight) {
      return Promise.resolve(false);
    }
    verifyMonteurProfileInBackgroundInFlight = true;
    return tryResolveMonteurProfileViaCheckConnection()
      .then(function (ok) {
        if (!ok && getTechId() > 0) {
          setMonteurProfileResolveHint(
            'Monteur-ID ' + getTechId() + ' — Dispo nicht erreichbar (URL/Login prüfen).',
            false,
          );
        }
        return ok;
      })
      .finally(function () {
        verifyMonteurProfileInBackgroundInFlight = false;
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
    var existingId = getTechId();
    if (existingId > 0) {
      setMonteurProfileResolveHint('Monteur-ID ' + existingId + ' (gespeichert).', true);
    }
    if (resolveMonteurProfileInFlight) return resolveMonteurProfileInFlight;
    if (!existingId) {
      setMonteurProfileResolveHint('Ermittle Monteur-ID…');
    } else {
      return verifyMonteurProfileInBackground();
    }
    resolveMonteurProfileInFlight = tryResolveMonteurProfileViaCheckConnection()
      .then(function (ok) {
        if (ok) {
          if (getTechId()) {
            setMonteurProfileResolveHint('Monteur-ID ' + getTechId() + ' (gespeichert).', true);
          }
          return true;
        }
        return fetch(API_BASE + '/api/monteur_profile', {
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
                var src =
                  connectedBase === intNorm ? 'internal' : connectedBase === extNorm ? 'external' : 'fallback';
                setDispoActiveBase(connectedBase, src);
              }
              if (getTechId()) {
                setMonteurProfileResolveHint('Monteur-ID ' + getTechId() + ' (gespeichert).', true);
                updateTechnicianName();
                return true;
              }
            }
            if (data && parseInt(data.technician_id, 10) > 0) {
              applyMonteurProfileFromConnection(data);
              if (getTechId()) {
                setMonteurProfileResolveHint('Monteur-ID ' + getTechId() + ' (gespeichert).', true);
                updateTechnicianName();
                return true;
              }
            }
            if (data && data.error) {
              setMonteurProfileResolveHint(data.error);
            }
            return false;
          });
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
  var lastDispoReachable = false;
  var lastDispoReachableAt = 0;
  var lastDispoOfflineReason = '';
  var DISPO_REACHABLE_MAX_AGE_MS = 90000;
  var CONNECTION_PROBE_INTERVAL_MS = 60000;
  var connectionProbeIntervalId = null;

  function isOsNetworkOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function markDispoReachable() {
    lastDispoReachable = true;
    lastDispoReachableAt = Date.now();
    lastDispoOfflineReason = '';
  }

  function markDispoUnreachable(reason) {
    lastDispoReachable = false;
    lastDispoReachableAt = Date.now();
    lastDispoOfflineReason = (reason && String(reason).trim()) || 'Dispo nicht erreichbar';
  }

  function isDispoReachableForBadge() {
    if (isOsNetworkOffline()) return false;
    if (!lastDispoReachable) return false;
    return Date.now() - lastDispoReachableAt <= DISPO_REACHABLE_MAX_AGE_MS;
  }

  function isLikelyDispoNetworkError(msg) {
    var s = String(msg || '').toLowerCase();
    return /timeout|nicht erreichbar|dispo-probe|failed to fetch|network|econnrefused|enotfound|abort|zeitüberschreitung/i.test(s);
  }

  function preferLocalProjekteNeuOnly() {
    if (isOsNetworkOffline()) return true;
    if (!isDispoReachableForBadge()) return true;
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
    } else if (state === 'degraded') {
      badge.textContent = 'Sync-Probleme';
      badge.className = 'offline-badge';
      if (reason && String(reason).trim()) {
        badge.setAttribute('title', String(reason).trim());
      } else {
        badge.setAttribute('title', 'Klicken zum erneuten Synchronisieren');
      }
    } else if (state === 'online' || state === 'online_syncing') {
      badge.textContent = 'Online';
      badge.className = 'online-badge';
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
      typeof loadDienstreiseList === 'function' ? Promise.resolve(loadDienstreiseList()) : Promise.resolve(),
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
    loadCalendarMonth().catch(function () {});
    if (typeof loadDienstreiseList === 'function') loadDienstreiseList();
  }

  var backgroundDispoSyncInFlight = null;
  var pendingBackgroundDispoSync = null;

  async function applySyncBadgeAfterRun(syncProblems) {
    if (isOsNetworkOffline() || !isDispoReachableForBadge()) {
      setConnectionBadge(
        'offline',
        (lastDispoOfflineReason || 'Dispo nicht erreichbar') + ' — lokale Daten verfügbar',
      );
      return;
    }
    if (syncProblems && syncProblems.length) {
      var allNetwork = syncProblems.every(function (p) {
        return isLikelyDispoNetworkError(p);
      });
      if (allNetwork) {
        markDispoUnreachable(syncProblems[0]);
        setConnectionBadge('offline', lastDispoOfflineReason + ' — lokale Daten verfügbar');
        return;
      }
      setConnectionBadge('degraded', syncProblems.join(' · ') + ' — Klicken zum erneuten Synchronisieren');
      return;
    }
    try {
      var stRes = await fetch(API_BASE + '/api/sync_status');
      var st = await stRes.json().catch(function () { return {}; });
      if (!st.ok) {
        setConnectionBadge(
          connectionUiState === 'offline' || connectionUiState === 'local' ? connectionUiState : 'degraded',
          'Sync-Status nicht abrufbar — lokale Daten verfügbar',
        );
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
        updateMultiDeviceUiFromSyncStatus(st);
        return;
      }
      setConnectionBadge('online');
      updateMultiDeviceUiFromSyncStatus(st);
    } catch (_) {
      setConnectionBadge(
        connectionUiState === 'offline' || connectionUiState === 'local' ? connectionUiState : 'degraded',
        'Sync-Status nicht abrufbar — lokale Daten verfügbar',
      );
    }
    if (isStartViewVisible() && typeof loadStartActiveJob === 'function') {
      loadStartActiveJob();
    }
  }

  var multiDeviceBannerDismissedKey = '';
  var multiDevicePendingCleanupJobId = null;

  function updateMultiDeviceUiFromSyncStatus(st) {
    if (!st || typeof st !== 'object') return;
    var banner = document.getElementById('multiDeviceBanner');
    var textEl = document.getElementById('multiDeviceBannerText');
    var btnDel = document.getElementById('btnMultiDeviceDeleteLocal');
    if (!banner || !textEl) return;
    var cleanup = Array.isArray(st.jobs_pending_local_cleanup) ? st.jobs_pending_local_cleanup : [];
    var conflicts = Array.isArray(st.conflicts) ? st.conflicts : [];
    var peerHint =
      st.peer_count != null && Number(st.peer_count) > 0
        ? 'Weitere Geräte online: ' + st.peer_count + '. '
        : '';
    if (cleanup.length) {
      var item = cleanup[0];
      multiDevicePendingCleanupJobId = item.local_job_id;
      var key = 'cleanup:' + item.local_job_id + ':' + (item.status_on_server || '');
      if (multiDeviceBannerDismissedKey === key) {
        banner.hidden = true;
        return;
      }
      var reasonLabel =
        item.reason === 'released_remote'
          ? 'auf einem anderen Gerät freigegeben (zugeteilt)'
          : 'auf einem anderen Gerät abgeschlossen';
      var name = item.customer_name ? String(item.customer_name) : 'Auftrag #' + item.local_job_id;
      textEl.textContent =
        peerHint +
        name +
        ' wurde ' +
        reasonLabel +
        '. Schreiben ist gesperrt. Lokale Kopie bei Bedarf manuell löschen.';
      if (btnDel) btnDel.hidden = false;
      banner.hidden = false;
      return;
    }
    if (conflicts.length) {
      var ckey = 'conflict:' + conflicts[0].id;
      if (multiDeviceBannerDismissedKey === ckey) {
        banner.hidden = true;
        return;
      }
      multiDevicePendingCleanupJobId = null;
      textEl.textContent =
        peerHint +
        'Sync-Konflikt: ' +
        (conflicts[0].rel_path || 'Datei') +
        ' — lokale Kopie als .conflict-* gesichert, Server-Stand übernommen.';
      if (btnDel) btnDel.hidden = true;
      banner.hidden = false;
      return;
    }
    multiDevicePendingCleanupJobId = null;
    if (peerHint) {
      textEl.textContent = peerHint.trim();
      if (btnDel) btnDel.hidden = true;
      banner.hidden = false;
      return;
    }
    banner.hidden = true;
  }

  async function deletePendingLocalCopy() {
    if (!multiDevicePendingCleanupJobId) return;
    var jobId = multiDevicePendingCleanupJobId;
    if (!confirm('Lokale Dienstreise-Kopie für Auftrag ' + jobId + ' wirklich löschen?')) return;
    try {
      var r = await fetch(API_BASE + '/api/dienstreise/delete_local_copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) {
        alert(data.error || 'Löschen fehlgeschlagen.');
        return;
      }
      multiDevicePendingCleanupJobId = null;
      var banner = document.getElementById('multiDeviceBanner');
      if (banner) banner.hidden = true;
      if (typeof loadJobsAndAbsences === 'function') loadJobsAndAbsences();
    } catch (e) {
      alert(e.message || 'Löschen fehlgeschlagen.');
    }
  }

  async function registerAndHeartbeatDevice() {
    var auth = buildDispoSyncAuthPayload();
    if (!isValidDispoSyncAuth(auth)) return;
    try {
      await fetch(API_BASE + '/api/device_register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technician_id: auth.technicianId,
          dispoBaseUrl: auth.baseUrl,
          dispoUsername: auth.serverUsername,
          dispoPassword: auth.serverPassword,
        }),
      });
      var hb = await fetch(API_BASE + '/api/device_heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technician_id: auth.technicianId,
          dispoBaseUrl: auth.baseUrl,
          dispoUsername: auth.serverUsername,
          dispoPassword: auth.serverPassword,
        }),
      });
      var hbData = await hb.json().catch(function () { return {}; });
      if (hbData && hbData.peer_count != null) {
        updateMultiDeviceUiFromSyncStatus({ peer_count: hbData.peer_count, jobs_pending_local_cleanup: [], conflicts: [] });
      }
    } catch (_) {}
  }

  async function refreshMonteurDevicesList() {
    var list = document.getElementById('monteurDevicesList');
    var selfHint = document.getElementById('selfDeviceIdHint');
    var auth = buildDispoSyncAuthPayload();
    if (!list) return;
    if (!isValidDispoSyncAuth(auth)) {
      list.innerHTML = '<span class="empty">Dispo-Login nötig.</span>';
      return;
    }
    list.innerHTML = '<span class="empty">Lade…</span>';
    try {
      var q =
        '?technician_id=' +
        encodeURIComponent(auth.technicianId) +
        '&base_url=' +
        encodeURIComponent(auth.baseUrl) +
        '&dispoUsername=' +
        encodeURIComponent(auth.serverUsername || '') +
        '&dispoPassword=' +
        encodeURIComponent(auth.serverPassword || '');
      var r = await fetch(API_BASE + '/api/devices' + q);
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) {
        list.innerHTML = '<span class="empty">' + (data.error || 'Geräteliste fehlgeschlagen') + '</span>';
        return;
      }
      if (selfHint) selfHint.textContent = 'Dieses Gerät: ' + (data.self_device_id || '—');
      var devices = data.devices || [];
      if (!devices.length) {
        list.innerHTML = '<span class="empty">Keine Geräte registriert.</span>';
        return;
      }
      list.innerHTML = devices
        .map(function (d) {
          var isSelf = d.device_id === data.self_device_id;
          var revoked = !!d.revoked_at;
          var label =
            (d.display_name || d.device_id) +
            (isSelf ? ' (dieses Gerät)' : '') +
            (revoked ? ' — widerrufen' : '') +
            (d.last_seen_at ? ' · zuletzt ' + d.last_seen_at : '');
          var btn =
            !isSelf && !revoked
              ? '<button type="button" class="btn btn-ghost btn-revoke-device" data-device-id="' +
                String(d.device_id).replace(/"/g, '') +
                '">Widerrufen</button>'
              : '';
          return (
            '<div class="monteur-device-row' +
            (isSelf ? ' self' : '') +
            '"><span>' +
            label +
            '</span>' +
            btn +
            '</div>'
          );
        })
        .join('');
      list.querySelectorAll('.btn-revoke-device').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var did = btn.getAttribute('data-device-id');
          if (!did || !confirm('Gerät wirklich widerrufen? Es kann danach nicht mehr syncen.')) return;
          var rr = await fetch(API_BASE + '/api/device_revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              technician_id: auth.technicianId,
              device_id: did,
              dispoBaseUrl: auth.baseUrl,
              dispoUsername: auth.serverUsername,
              dispoPassword: auth.serverPassword,
            }),
          });
          var rd = await rr.json().catch(function () { return {}; });
          if (!rr.ok || !rd.ok) alert(rd.error || 'Widerruf fehlgeschlagen.');
          refreshMonteurDevicesList();
        });
      });
    } catch (e) {
      list.innerHTML = '<span class="empty">' + (e.message || 'Fehler') + '</span>';
    }
  }

  async function runDeviceBootstrap() {
    var hint = document.getElementById('deviceBootstrapHint');
    var est = document.getElementById('deviceBootstrapEstimate');
    var auth = buildDispoSyncAuthPayload();
    if (!isValidDispoSyncAuth(auth)) {
      if (hint) hint.textContent = 'Dispo-Login nötig.';
      return;
    }
    if (hint) hint.textContent = 'Schätze Speicher…';
    try {
      var er = await fetch(API_BASE + '/api/device_bootstrap/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technician_id: auth.technicianId,
          dispoBaseUrl: auth.baseUrl,
          dispoUsername: auth.serverUsername,
          dispoPassword: auth.serverPassword,
        }),
      });
      var ed = await er.json().catch(function () { return {}; });
      if (est && ed.ok) {
        est.textContent =
          'Geschätzt: ' +
          (ed.total_human || '0 B') +
          ' für ' +
          (ed.jobs ? ed.jobs.length : 0) +
          ' Auftrag/Aufträge (nur physischer Tree, Union lazy).';
      }
      if (!ed.ok) {
        if (hint) hint.textContent = ed.error || 'Schätzung fehlgeschlagen';
        return;
      }
      if (
        !confirm(
          'Bootstrap starten?\nGeschätzte Download-Menge: ' +
            (ed.total_human || '?') +
            '\n(Nur physische Projektordner.)',
        )
      ) {
        if (hint) hint.textContent = 'Abgebrochen.';
        return;
      }
      if (hint) hint.textContent = 'Bootstrap läuft…';
      var br = await fetch(API_BASE + '/api/device_bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technician_id: auth.technicianId,
          dispoBaseUrl: auth.baseUrl,
          dispoUsername: auth.serverUsername,
          dispoPassword: auth.serverPassword,
          baseUrl: auth.baseUrl,
          serverUsername: auth.serverUsername,
          serverPassword: auth.serverPassword,
        }),
      });
      var bd = await br.json().catch(function () { return {}; });
      if (!br.ok || !bd.ok) {
        if (hint) hint.textContent = bd.error || 'Bootstrap fehlgeschlagen';
        return;
      }
      if (hint) {
        hint.textContent =
          'Gestartet: ' + ((bd.enqueued && bd.enqueued.length) || 0) + ' Pull-Job(s). Fortschritt in der Sync-Anzeige.';
      }
    } catch (e) {
      if (hint) hint.textContent = e.message || 'Fehler';
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
    var ext = (typeof getDispoExternalUrl === 'function' ? getDispoExternalUrl() : '').trim().replace(/\/+$/, '');
    var intUrl = (typeof getDispoInternalUrl === 'function' ? getDispoInternalUrl() : '').trim().replace(/\/+$/, '');
    return {
      baseUrl: syncBase,
      externalUrl: ext,
      internalUrl: intUrl,
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
      await fetch(API_BASE + '/api/background_jobs/reap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(function () {});
      await fetch(API_BASE + '/api/background_jobs/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipAcceptJob: true }),
      }).catch(function () {});
    } catch (e) { /* ignore */ }
    try {
      var pullRes = await fetch(API_BASE + '/api/sync_pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          Object.assign({}, syncPayload, {
            date_from: range.date_from,
            date_to: range.date_to,
            force_anlagenstamm_full: opts.forceAnlagenstammFull === true,
          }),
        ),
      });
      var pullData = await pullRes.json().catch(function () { return {}; });
      if (!pullData.ok) {
        if (pullData.deferred) {
          console.log('[Sync Pull] zurückgestellt:', pullData.error || 'Kopie/Push aktiv');
          var deferredOk = false;
          for (var deferAttempt = 0; deferAttempt < 12 && !deferredOk; deferAttempt++) {
            await fetch(API_BASE + '/api/background_jobs/reap', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(function () {});
            await waitForActiveDienstreisePullJobs({ maxMs: 2 * 60 * 1000 });
            pullRes = await fetch(API_BASE + '/api/sync_pull', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                Object.assign({}, syncPayload, {
                  date_from: range.date_from,
                  date_to: range.date_to,
                  force_anlagenstamm_full: opts.forceAnlagenstammFull === true,
                }),
              ),
            });
            pullData = await pullRes.json().catch(function () {
              return {};
            });
            if (pullData.ok) {
              deferredOk = true;
              break;
            }
            if (!pullData.deferred) {
              throw new Error(pullData.error || 'Pull konnte nicht gestartet werden.');
            }
          }
          if (!deferredOk) {
            throw new Error(
              pullData.error ||
                'Sync konnte nicht starten — ein anderer Kopiervorgang läuft noch. Bitte kurz warten und erneut versuchen.',
            );
          }
        } else {
          throw new Error(pullData.error || 'Pull konnte nicht gestartet werden.');
        }
      }
      if (pullData.ok && pullData.job_id) {
        var pullJob = await pollBackgroundJobUntilTerminal(pullData.job_id, null, {});
        if (pullJob.status === 'completed') {
          await waitForActiveDienstreisePullJobs({});
          maybeRefreshLocalLists(true);
          try {
            document.dispatchEvent(new CustomEvent('anlagenstamm-data-synced'));
          } catch (_) { /* ignore */ }
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
            isProjektdatenViewVisible() &&
            typeof openJobDetailsModal === 'function'
          ) {
            openJobDetailsModal(jobDetailsJobId, { syncPullRefresh: true });
          }
        } else if (pullJob.status === 'failed' || pullJob.status === 'interrupted') {
          throw new Error(pullJob.error || 'Pull fehlgeschlagen.');
        }
      }
    } catch (e) {
      console.error('[Sync Pull] runDispoPushPull:', e.message, e);
      syncProblems.push('Pull: ' + (e && e.message ? e.message : 'Fehler'));
    }
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
        if (pushJob.status === 'failed' || pushJob.status === 'interrupted') {
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
    return syncProblems;
  }

  function runDispoPushPullInBackground(auth, range, syncBase, techId) {
    if (backgroundDispoSyncInFlight) {
      pendingBackgroundDispoSync = { auth: auth, range: range, syncBase: syncBase, techId: techId };
      return backgroundDispoSyncInFlight;
    }
    setConnectionBadge('online_syncing', 'Synchronisiere im Hintergrund…');
    backgroundDispoSyncInFlight = runDispoPushPull(auth, range, { connectedBaseFallback: syncBase })
      .then(function (syncProblems) {
        applySyncBadgeAfterRun(syncProblems);
        if (!syncProblems || !syncProblems.length) {
          bootstrapLocalData(true);
        } else {
          maybeRefreshLocalLists(true);
        }
        refreshTedFoldersAfterSync();
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
        var syncErr = e && e.message ? e.message : 'Sync-Fehler';
        if (isLikelyDispoNetworkError(syncErr)) {
          markDispoUnreachable(syncErr);
          setConnectionBadge('offline', lastDispoOfflineReason + ' — lokale Daten verfügbar');
        } else {
          setConnectionBadge('degraded', syncErr + ' — Klicken zum erneuten Synchronisieren');
        }
      })
      .finally(function () {
        backgroundDispoSyncInFlight = null;
        if (pendingBackgroundDispoSync) {
          var pending = pendingBackgroundDispoSync;
          pendingBackgroundDispoSync = null;
          runDispoPushPullInBackground(pending.auth, pending.range, pending.syncBase, pending.techId);
        }
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
    var probeOnly = opts.probeOnly === true;
    var techId = getTechId();
    var hasLogin = !!(getServerUsername() && getServerPassword());
    if (isOsNetworkOffline()) {
      markDispoUnreachable('Keine Netzwerkverbindung');
      setConnectionBadge('offline', 'Keine Netzwerkverbindung — lokale Daten verfügbar');
      if (!probeOnly) return bootstrapLocalData(!blockingSync);
      return;
    }
    if (!techId && !hasLogin) {
      markDispoUnreachable('Nicht angemeldet');
      setConnectionBadge('offline');
      return bootstrapLocalData(true);
    }
    var ext = getDispoExternalUrl();
    var intUrl = getDispoInternalUrl();
    if (!ext && !intUrl) {
      return bootstrapLocalData(true);
    }
    if (!blockingSync && !probeOnly) {
      bootstrapLocalData(false);
    }
    if (!probeOnly || connectionUiState === 'online' || connectionUiState === 'online_syncing' || connectionUiState === 'idle') {
      setConnectionBadge('checking', 'Prüfe Verbindung…');
    }
    try {
      if (hasLogin && !getTechId()) {
        await resolveMonteurProfileFromDispo();
        techId = getTechId();
      }
      var check = await fetchApiPostJson(
        '/api/check_connection',
        {
          externalUrl: ext,
          internalUrl: intUrl,
          technicianId: techId,
          serverUsername: getServerUsername(),
          serverPassword: getServerPassword(),
        },
        probeOnly ? 15000 : 28000,
      );
      applyMonteurProfileFromConnection(check);
      if (check && check.ok === true) {
        markDispoReachable();
        if (probeOnly) {
          setConnectionBadge('online');
          return;
        }
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
          try {
            await registerAndHeartbeatDevice();
          } catch (_) {}
          var syncProblems = await runDispoPushPull(auth, range, {
            connectedBaseFallback: connectedBase,
            forceAnlagenstammFull: opts.forceAnlagenstammFull === true,
          });
          applySyncBadgeAfterRun(syncProblems);
          scheduleAutoAppUpdateCheck();
          refreshTedFoldersAfterSync();
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
          scheduleAutoAppUpdateCheck();
          runDispoPushPullInBackground(auth, range, syncBase, techId);
        } else {
          setConnectionBadge('online', 'Online — Dispo-Zugangsdaten für Sync eintragen');
        }
      } else {
        var offMsg = (check && check.error) ? check.error : 'Verbindung fehlgeschlagen';
        markDispoUnreachable(offMsg);
        setConnectionBadge('offline', offMsg);
      }
    } catch (e) {
      var failMsg = e && e.message ? e.message : 'Verbindung fehlgeschlagen';
      markDispoUnreachable(failMsg);
      setConnectionBadge('offline', failMsg);
    }
    if (!probeOnly) {
      setNextSyncTime();
    }
    if (blockingSync) {
      return bootstrapLocalData(true);
    }
  }

  function probeConnectionOnly() {
    if (checkConnectionAndSyncInFlight) {
      return checkConnectionAndSyncInFlight;
    }
    return checkConnectionAndSync({ blockingSync: false, probeOnly: true });
  }

  function startConnectionProbeInterval() {
    if (connectionProbeIntervalId) clearInterval(connectionProbeIntervalId);
    connectionProbeIntervalId = setInterval(function () {
      probeConnectionOnly();
    }, CONNECTION_PROBE_INTERVAL_MS);
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

  /** Kalender: abgelaufene Abwesenheiten ausblenden (wie in der Abwesenheiten-Liste). */
  function filterActiveCalendarAbsences(absences) {
    return (Array.isArray(absences) ? absences : []).filter(function (a) {
      return !isAbsenceExpired(a);
    });
  }

  /** Kalender = gleiche sichtbare Menge wie Abwesenheiten-View (pending nur unter Anfragen, nicht doppelt). */
  function filterCalendarAbsencesForView(absences) {
    return filterActiveCalendarAbsences(absences).filter(function (a) {
      if (a.from_absence_request && a.status === 'pending') return false;
      return true;
    });
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
    if (checkConnectionAndSyncInFlight) {
      return checkConnectionAndSyncInFlight;
    }
    setConnectionBadge('checking', 'Manueller Sync…');
    var maxMs = 10 * 60 * 1000;
    var guard = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error('Sync dauert zu lange (>' + Math.round(maxMs / 60000) + ' Min) — bitte erneut versuchen'));
      }, maxMs);
    });
    return Promise.race([checkConnectionAndSync({ blockingSync: true, forceAnlagenstammFull: true }), guard])
      .catch(function (e) {
        console.warn('[manual_sync]', e && e.message ? e.message : e);
        setConnectionBadge(
          'degraded',
          (e && e.message ? e.message : 'Sync fehlgeschlagen') + ' — erneut klicken',
        );
      })
      .finally(function () {
        startSyncInterval();
      });
  }

  document.getElementById('connectionBadgeWrap').addEventListener('click', function () {
    triggerManualSync();
  });

  loadSettingsFromStorage();
  wireMonteurProfileAutoResolve();
  if (getTechId() > 0) {
    setMonteurProfileResolveHint('Monteur-ID ' + getTechId() + ' (gespeichert).', true);
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
  function loadZeitschreibungConfigFromServer() {
    fetch(API_BASE + '/api/zeitschreibung/config').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok && data.basePath) {
        var el = document.getElementById('zeitschreibungBasePath');
        if (el) el.value = data.basePath;
        try { localStorage.setItem(SETTINGS_KEYS.zeitschreibungBasePath, data.basePath); } catch (e) {}
      }
    }).catch(function () {});
  }
  function applyFixedDispoTlsOnServer() {
    return fetch(API_BASE + '/api/settings_dispo_tls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowInsecureTls: true }),
    }).catch(function () {});
  }
  loadDienstreiseConfigFromServer();
  loadZeitschreibungConfigFromServer();
  fetch(API_BASE + '/api/background_jobs/reap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(function () {});
  if (window.monteurWebEmbed && typeof monteurWebEmbed.init === 'function') {
    monteurWebEmbed.init().catch(function () {});
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'dispo-desktop-open-pdf' || !d.url) return;
    if (window.monteurApp && typeof monteurApp.openExternal === 'function') {
      monteurApp.openExternal(d.url);
    }
  });
  bootstrapLocalData(false)
    .then(function () {
      return applyFixedDispoTlsOnServer();
    })
    .then(function () {
      return ensureDispoWebSession();
    })
    .then(function () {
      syncUpdateFeedToMain();
      return checkConnectionAndSync({ blockingSync: false });
    })
    .then(function () {
      startPushEvents();
      if (getServerUsername() && getServerPassword()) {
        refreshServerMaintenanceZone().catch(function () {});
      }
    })
    .catch(function () {
      startPushEvents();
    });
  startSyncInterval();
  startConnectionProbeInterval();
  startBackgroundJobsPollingUi();
  window.addEventListener('online', function () {
    if (typeof checkConnectionAndSync === 'function') {
      try { checkConnectionAndSync({ blockingSync: false }); } catch (e) { /* ignore */ }
    }
    scheduleAutoAppUpdateCheck();
  });
  window.addEventListener('offline', function () {
    markDispoUnreachable('Keine Netzwerkverbindung');
    setConnectionBadge('offline', 'Keine Netzwerkverbindung — lokale Daten verfügbar');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      probeConnectionOnly();
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
      var prevUpdateState = updateState;
      var keepCurrentUpdateAction =
        payload.state === 'checking' &&
        !payload.manual &&
        (prevUpdateState === 'available' || prevUpdateState === 'downloading' || prevUpdateState === 'ready');
      if (!keepCurrentUpdateAction) updateState = payload.state;
      if (payload.state === 'checking') {
        if (payload.manual) {
          setChipVisible(true, 'Prüfe Update…');
          if (chip) chip.title = 'Server-Update wird geprüft';
        } else if (prevUpdateState !== 'available' && prevUpdateState !== 'downloading' && prevUpdateState !== 'ready') {
          setChipVisible(false);
        }
      } else if (payload.state === 'available') {
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
        monteurApp.checkForAppUpdates({ manual: true }).then(function (res) {
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

    if (window.monteurApp && typeof monteurApp.onAppUpdateStatus === 'function') {
      monteurApp.onAppUpdateStatus(applyUpdateStatus);
    }
    syncUpdateFeedToMain();
    scheduleAutoAppUpdateCheck();
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

  var zsBrowseBtn = document.getElementById('btnZeitschreibungBaseBrowse');
  if (zsBrowseBtn && window.monteurApp && typeof window.monteurApp.chooseDienstreiseBasePath === 'function') {
    zsBrowseBtn.addEventListener('click', function () {
      window.monteurApp.chooseDienstreiseBasePath().then(function (selectedPath) {
        if (!selectedPath) return;
        var input = document.getElementById('zeitschreibungBasePath');
        if (input) input.value = selectedPath;
        saveSettingsToStorage();
        fetch(API_BASE + '/api/zeitschreibung/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ basePath: selectedPath }),
        }).catch(function () {});
      });
    });
  }

  document.getElementById('btnSaveSettings').addEventListener('click', function () {
    saveSettingsToStorage();
    syncUpdateFeedToMain();
    var pathEl = document.getElementById('dienstreiseBasePath');
    var basePath = (pathEl && pathEl.value ? pathEl.value.trim() : '') || '';
    fetch(API_BASE + '/api/dienstreise/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ basePath: basePath }) }).catch(function () {});
    var zsPathEl = document.getElementById('zeitschreibungBasePath');
    var zsBasePath = (zsPathEl && zsPathEl.value ? zsPathEl.value.trim() : '') || '';
    fetch(API_BASE + '/api/zeitschreibung/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePath: zsBasePath }),
    }).catch(function () {});
    applyFixedDispoTlsOnServer()
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

  var btnSelfUninstall = document.getElementById('btnSelfUninstall');
  var btnServerReboot = document.getElementById('btnServerReboot');
  if (btnServerReboot) {
    btnServerReboot.addEventListener('click', function () {
      var hint = document.getElementById('serverRebootHint');
      if (!getServerUsername() || !getServerPassword()) {
        if (hint) hint.textContent = 'Dispo-Zugangsdaten fehlen.';
        return;
      }
      var firstOk = window.confirm(
        'Der Kukla-Server wird in ca. 1 Minute neu gestartet. Alle Dienste sind danach kurz nicht erreichbar. Fortfahren?',
      );
      if (!firstOk) return;
      var typed = window.prompt('Zur Bestätigung bitte NEUSTART eingeben.', '');
      if (typed !== 'NEUSTART') {
        if (hint) hint.textContent = 'Abgebrochen.';
        return;
      }
      btnServerReboot.disabled = true;
      if (hint) hint.textContent = 'Reboot wird angefordert …';
      fetch(API_BASE + '/api/server/reboot', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId() || '') },
          serverMaintenanceAuthHeaders(),
        ),
        body: JSON.stringify({}),
      })
        .then(function (r) {
          return r.json().catch(function () {
            return {};
          }).then(function (data) {
            if (!r.ok || !data.ok) {
              throw new Error((data && data.error) || 'Reboot fehlgeschlagen.');
            }
            if (hint) hint.textContent = data.message || 'Server-Neustart geplant (+1 min).';
            return loadServerMaintenanceHealth();
          });
        })
        .catch(function (err) {
          if (hint) hint.textContent = 'Fehler: ' + (err && err.message ? err.message : String(err));
        })
        .finally(function () {
          loadServerRebootAllowedState().then(function (allowedData) {
            if (btnServerReboot) {
              btnServerReboot.disabled = !(allowedData && allowedData.ok && allowedData.allowed && allowedData.reboot_enabled !== false);
            }
          });
        });
    });
  }
  if (btnSelfUninstall) {
    btnSelfUninstall.addEventListener('click', function () {
      var hint = document.getElementById('selfUninstallHint');
      if (!window.monteurApp || typeof window.monteurApp.uninstallAppAndRemoveLocalData !== 'function') {
        if (hint) hint.textContent = 'Deinstallation ist in dieser Umgebung nicht verfügbar.';
        return;
      }
      var firstOk = window.confirm(
        'Diese Aktion deinstalliert die Monteur-WebApp auf diesem PC und löscht die lokale App-Datenbank vollständig. Fortfahren?',
      );
      if (!firstOk) return;
      var typed = window.prompt(
        'Zur Bestätigung bitte DEINSTALLIEREN eingeben. Danach wird die App geschlossen.',
        '',
      );
      if (typed !== 'DEINSTALLIEREN') {
        if (hint) hint.textContent = 'Abgebrochen.';
        return;
      }
      btnSelfUninstall.disabled = true;
      if (hint) hint.textContent = 'Deinstallation wird vorbereitet …';
      window.monteurApp
        .uninstallAppAndRemoveLocalData()
        .then(function (result) {
          if (!result || !result.ok) {
            throw new Error((result && result.error) || 'Deinstallation konnte nicht gestartet werden.');
          }
          if (hint) hint.textContent = 'App wird geschlossen, lokale Daten werden gelöscht und die Deinstallation startet …';
        })
        .catch(function (err) {
          btnSelfUninstall.disabled = false;
          if (hint) hint.textContent = 'Fehler: ' + (err && err.message ? err.message : String(err));
        });
    });
  }

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

  var btnDeviceBootstrap = document.getElementById('btnDeviceBootstrap');
  if (btnDeviceBootstrap) {
    btnDeviceBootstrap.addEventListener('click', function () {
      runDeviceBootstrap();
    });
  }
  var btnRefreshDevices = document.getElementById('btnRefreshDevices');
  if (btnRefreshDevices) {
    btnRefreshDevices.addEventListener('click', function () {
      refreshMonteurDevicesList();
    });
  }
  var btnMultiDeviceDeleteLocal = document.getElementById('btnMultiDeviceDeleteLocal');
  if (btnMultiDeviceDeleteLocal) {
    btnMultiDeviceDeleteLocal.addEventListener('click', function () {
      deletePendingLocalCopy();
    });
  }
  var btnMultiDeviceDismiss = document.getElementById('btnMultiDeviceDismiss');
  if (btnMultiDeviceDismiss) {
    btnMultiDeviceDismiss.addEventListener('click', function () {
      var banner = document.getElementById('multiDeviceBanner');
      if (banner) banner.hidden = true;
      multiDeviceBannerDismissedKey =
        'dismiss:' + Date.now() + ':' + (multiDevicePendingCleanupJobId || '');
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
    var syncNowMaxMs = 40 * 60 * 1000;
    var syncWork = prep.then(function () {
      return checkConnectionAndSync({ blockingSync: true, forceAnlagenstammFull: true });
    });
    Promise.race([
      syncWork,
      new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(
            new Error(
              'Zeitüberschreitung beim Holen von Dispo. Bitte Verbindung prüfen und erneut versuchen.',
            ),
          );
        }, syncNowMaxMs);
      }),
    ])
      .then(function () {
        startSyncInterval();
        hint.textContent = 'Fertig.';
        loadSettingsSyncStatus().catch(function () {});
        refreshMonteurDevicesList().catch(function () {});
        clearTimeout(hint._syncHide);
        hint._syncHide = setTimeout(function () {
          hint.textContent = '';
        }, 3000);
      })
      .catch(function (e) {
        hint.textContent = 'Fehler: ' + (e && e.message ? e.message : 'Unbekannt');
        clearTimeout(hint._syncHide);
        hint._syncHide = setTimeout(function () {
          hint.textContent = '';
        }, 8000);
        finishAcceptJobStreamUi();
      })
      .finally(function () {
        fetch(API_BASE + '/api/background_jobs/reap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(function () {});
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
  var acceptOfflineBtnCancel = document.getElementById('acceptOfflineBtnCancel');
  if (acceptOfflineBtnCancel) acceptOfflineBtnCancel.addEventListener('click', closeAcceptOfflineModal);
  var acceptOfflineBtnAll = document.getElementById('acceptOfflineBtnAll');
  if (acceptOfflineBtnAll) acceptOfflineBtnAll.addEventListener('click', function () { setAllOfflineCheckboxes(true); });
  var acceptOfflineBtnNone = document.getElementById('acceptOfflineBtnNone');
  if (acceptOfflineBtnNone) acceptOfflineBtnNone.addEventListener('click', function () { setAllOfflineCheckboxes(false); });
  var acceptOfflineBtnConfirm = document.getElementById('acceptOfflineBtnConfirm');
  if (acceptOfflineBtnConfirm) {
    acceptOfflineBtnConfirm.addEventListener('click', function () {
      if (!acceptOfflinePending) return;
      var paths = collectCheckedOfflinePaths();
      saveRememberedOfflinePaths(paths);
      var pending = acceptOfflinePending;
      closeAcceptOfflineModal();
      var acceptOpts = {
        offline_paths: paths,
        fab_map: pending.fab_map,
        montage_folder_name: pending.montage_folder_name
      };
      if (shouldPreferOfflineAccept() || pending.previewFailed) {
        runAcceptJobOffline(pending.localJobId, pending.triggerButton, acceptOpts);
      } else {
        runAcceptJobStream(pending.localJobId, pending.triggerButton, acceptOpts);
      }
    });
  }
  var modalAcceptOffline = document.getElementById('modalAcceptOffline');
  if (modalAcceptOffline) {
    modalAcceptOffline.addEventListener('click', function (e) {
      if (e.target.id === 'modalAcceptOffline') closeAcceptOfflineModal();
    });
  }
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
    html += renderArchivJobContactsHtml(job, v);
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
              dms_position: '',
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
          dms_position: get(r, ['dms_position', 'DMS Position', 'dmsPosition']),
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
        dms_position: '',
        tacho: '',
        elektronik: '',
        material: '',
        position: '',
        geliefert_ueber: '',
        projekt: '',
        bemerkungen: ''
      });
    }
    return sortLeistungRowsByFab(rows);
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
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Kraftaufnehmer</h4><div class="anlagenstamm-form-grid">' +
      '<div class="form-full kraftaufnehmer-block" id="kraftaufnehmerBlock">' +
      '<div id="kraftaufnehmerRows"></div>' +
      '<button type="button" class="btn btn-secondary btn-kraftaufnehmer-add" id="btnAddKraftaufnehmer">+ Kraftaufnehmer</button>' +
      '<input type="hidden" id="as-form-kraftaufnehmer-extra" name="kraftaufnehmer_extra" value="">' +
      '</div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Technik (Forts.)</h4><div class="anlagenstamm-form-grid">' +
      '<div><label for="as-form-material">Material</label><input type="text" id="as-form-material" value="' + v('material') + '"></div>' +
      '<div><label for="as-form-position">Position</label><input type="text" id="as-form-position" value="' + v('position') + '"></div>' +
      '</div></div>' +
      '<div class="anlagenstamm-form-section"><h4>Elektronik</h4><div class="anlagenstamm-form-grid">' +
      '<div><label for="as-form-tacho">Tacho</label><input type="text" id="as-form-tacho" value="' + v('tacho') + '"></div>' +
      '<div><label for="as-form-elektronik">Elektronik</label><input type="text" id="as-form-elektronik" value="' + v('elektronik') + '"></div>' +
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

  function updateAnlagenstammModeBadge(useWeb) {
    var badge = document.getElementById('anlagenstammModeBadge');
    if (!badge) return;
    badge.hidden = false;
    if (useWeb) {
      badge.textContent = 'Dispo-Web';
      badge.classList.remove('offline');
      badge.title = 'Anlagenstamm wie dispo/anlagenstamm.php (online)';
    } else {
      badge.textContent = 'Offline (lokaler Cache)';
      badge.classList.add('offline');
      badge.title = 'Anlagenstamm offline-first — Daten aus monteur.db';
    }
  }

  async function ensureDispoWebSession() {
    var base = getDispoBaseUrl();
    if (!base || !getDispoUsername() || !getServerPassword()) return false;
    try {
      var r = await fetch(API_BASE + '/api/dispo/ensure-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: base,
          externalUrl: getDispoExternalUrl(),
          internalUrl: getDispoInternalUrl(),
          serverUsername: getDispoUsername(),
          serverPassword: getServerPassword(),
        }),
      });
      var d = await r.json().catch(function () {
        return {};
      });
      return !!d.ok;
    } catch (e) {
      return false;
    }
  }

  async function loadAbrechnungViewDesktopStyle() {
    var host = document.getElementById('abrechnung-host');
    if (!host) return;
    delete host.dataset.inited;
    delete host.dataset.reloadBound;
    if (window.monteurAbrechnung && typeof window.monteurAbrechnung.load === 'function') {
      await window.monteurAbrechnung.load(host);
    } else {
      host.innerHTML = '<p class="ab-muted">Abrechnungsmodul konnte nicht geladen werden.</p>';
    }
  }

  async function loadAnlagenstammViewDesktopStyle() {
    var legacy = document.getElementById('anlagenstamm-legacy-wrap');
    var host = document.getElementById('anlagenstamm-host');
    var web = window.monteurWebEmbed;
    if (web && web.showNativeContent) web.showNativeContent('anlagenstamm');
    if (legacy) legacy.hidden = true;
    if (host) {
      host.hidden = false;
      if (host.dataset.inited === '1' && host.querySelector('#tableBody')) {
        updateAnlagenstammModeBadge(false);
        return;
      }
      host.innerHTML = '';
      if (window.monteurAnlagenstamm && typeof window.monteurAnlagenstamm.load === 'function') {
        await window.monteurAnlagenstamm.load(host, false);
        host.dataset.inited = '1';
      }
    }
    updateAnlagenstammModeBadge(false);
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
    if (typeof window.kuklaCollectKraftaufnehmerExtra === 'function') window.kuklaCollectKraftaufnehmerExtra();
    var extraEl = document.getElementById('as-form-kraftaufnehmer-extra');
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
      kraftaufnehmer_extra: extraEl ? (extraEl.value || '') : '',
      material: ((document.getElementById('as-form-material') || {}).value || ''),
      tacho: ((document.getElementById('as-form-tacho') || {}).value || ''),
      elektronik: ((document.getElementById('as-form-elektronik') || {}).value || ''),
      dms_nr: ((document.getElementById('as-form-dms') || {}).value || ''),
      dms_position: ((document.getElementById('as-form-dms-position') || {}).value || ''),
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
    if (typeof window.kuklaInitKraftaufnehmerRows === 'function') {
      var extras = (typeof window.kuklaParseKraftaufnehmerExtraFromRow === 'function')
        ? window.kuklaParseKraftaufnehmerExtraFromRow(a || {})
        : [];
      window.kuklaInitKraftaufnehmerRows({
        primaryInputId: 'as-form-kraftaufnehmer',
        primaryDmsInputId: 'as-form-dms',
        primaryDmsPosInputId: 'as-form-dms-position',
        hiddenInputId: 'as-form-kraftaufnehmer-extra',
        primaryValue: (a && a.kraftaufnehmer) ? String(a.kraftaufnehmer) : '',
        primaryDmsNr: (a && a.dms_nr) ? String(a.dms_nr) : '',
        primaryDmsPosition: (a && a.dms_position) ? String(a.dms_position) : '',
        extras: extras,
        readOnly: false
      });
    }
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
        kraftaufnehmer_extra: payload.kraftaufnehmer_extra,
        material: payload.material,
        tacho: payload.tacho,
        elektronik: payload.elektronik,
        dms_nr: payload.dms_nr,
        dms_position: payload.dms_position,
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

  function fmtDateTimeLocal(v) {
    var s = String(v || '').trim();
    if (!s) return '';
    var d = new Date(s.replace(' ', 'T'));
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('de-DE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function readDownloadNameFromResponse(resp, fallbackName) {
    if (!resp || !resp.headers) return fallbackName;
    var xName = resp.headers.get('x-download-filename');
    if (xName) {
      try { return decodeURIComponent(xName); } catch (_) { return xName; }
    }
    var cd = resp.headers.get('content-disposition') || '';
    var utf = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf && utf[1]) {
      try { return decodeURIComponent(utf[1].trim().replace(/^"|"$/g, '')); } catch (_) {}
    }
    var plain = cd.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plain && plain[2]) {
      try { return decodeURIComponent(plain[2].trim()); } catch (_) { return plain[2].trim(); }
    }
    return fallbackName;
  }

  function aspTrendOptionLabel(f) {
    var name = String(f.original_filename || 'Datei');
    var date = fmtDateTimeLocal(f.uploaded_at);
    return name + ' (' + date + ')';
  }

  function renderAspTrendChangesTable(changes, showUnchanged) {
    var rows = Array.isArray(changes) ? changes : [];
    if (!showUnchanged) {
      rows = rows.filter(function (c) { return c.status !== 'unchanged'; });
    }
    if (!rows.length) {
      return '<p class="empty" style="padding:0.5rem 0.7rem">Keine Änderungen (oder nur unveränderte Werte – Filter aktivieren).</p>';
    }
    var statusLabel = { changed: 'Geändert', added: 'Neu', removed: 'Entfernt', unchanged: 'Gleich' };
    var statusClass = { changed: 'asp-trend-changed', added: 'asp-trend-added', removed: 'asp-trend-removed', unchanged: 'asp-trend-unchanged' };
    var body = rows.map(function (c) {
      var st = c.status || 'unchanged';
      var unit = c.unit ? ' <span class="muted">[' + escapeHtml(c.unit) + ']</span>' : '';
      return '<tr>' +
        '<td><span class="asp-trend-badge ' + (statusClass[st] || '') + '">' + escapeHtml(statusLabel[st] || st) + '</span></td>' +
        '<td>' + escapeHtml(c.param_key || '') + unit + '</td>' +
        '<td>' + escapeHtml(c.value_old != null ? String(c.value_old) : '') + '</td>' +
        '<td>' + escapeHtml(c.value_new != null ? String(c.value_new) : '') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="anlagenstamm-trend-table"><thead><tr>' +
      '<th>Status</th><th>Parameter</th><th>Wert vorher</th><th>Wert nachher</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function wireAspTrendToolbar(fabNorm, list) {
    var chron = list.slice().sort(function (a, b) {
      var ta = Date.parse(String(a.uploaded_at || '').replace(' ', 'T'));
      var tb = Date.parse(String(b.uploaded_at || '').replace(' ', 'T'));
      if (isNaN(ta)) ta = 0;
      if (isNaN(tb)) tb = 0;
      return ta - tb;
    });
    var selFrom = document.getElementById('aspTrendFrom');
    var selTo = document.getElementById('aspTrendTo');
    if (!selFrom || !selTo) return;
    var opts = chron.map(function (f) {
      return '<option value="' + escapeHtml(String(f.id)) + '">' + escapeHtml(aspTrendOptionLabel(f)) + '</option>';
    }).join('');
    selFrom.innerHTML = opts;
    selTo.innerHTML = opts;
    if (chron.length >= 2) {
      selFrom.value = String(chron[0].id);
      selTo.value = String(chron[chron.length - 1].id);
    }
    var btnCompare = document.getElementById('btnAspTrendCompare');
    var btnChain = document.getElementById('btnAspTrendChain');
    if (btnCompare) {
      btnCompare.disabled = chron.length < 2;
      btnCompare.onclick = function () {
        loadAnlagenstammParameterTrend(fabNorm, {
          from_file_id: parseInt(selFrom.value, 10),
          to_file_id: parseInt(selTo.value, 10)
        });
      };
    }
    if (btnChain) {
      btnChain.disabled = chron.length < 2;
      btnChain.onclick = function () {
        loadAnlagenstammParameterTrend(fabNorm, { chain: true });
      };
    }
  }

  async function loadAnlagenstammParameterTrend(fab, opts) {
    opts = opts || {};
    var trendEl = document.getElementById('anlagenstammParameterTrend');
    var msgEl = document.getElementById('anlagenstammMessage');
    if (!trendEl) return;
    var fabNorm = String(fab || '').trim();
    if (!fabNorm) {
      trendEl.style.display = 'none';
      trendEl.innerHTML = '';
      return;
    }
    var showUnchanged = !!(document.getElementById('aspTrendShowUnchanged') && document.getElementById('aspTrendShowUnchanged').checked);
    trendEl.style.display = '';
    trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Trend wird berechnet…</div>';
    try {
      var body = anlagenstammDispoBody({ fab: fabNorm });
      if (opts.chain) body.mode = 'chain';
      else {
        if (opts.from_file_id) body.from_file_id = opts.from_file_id;
        if (opts.to_file_id) body.to_file_id = opts.to_file_id;
      }
      var data = await api('/api/anlagenstamm_parameter_trend', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (data && data.cache_notice) {
        if (msgEl) msgEl.textContent = data.cache_notice;
      }
      if (!data || !data.ok) {
        throw new Error((data && data.error) ? data.error : 'Trend fehlgeschlagen');
      }
      if (data.steps && Array.isArray(data.steps)) {
        if (!data.steps.length) {
          trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Parameter-Trend (alle Schritte)</div>' +
            '<p class="empty" style="padding:0.5rem 0.7rem">' + escapeHtml(data.message || 'Keine aufeinanderfolgenden Vergleiche möglich.') + '</p>';
          return;
        }
        trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Parameter-Trend: ' + data.steps.length + ' Schritt(e), jeweils alle Einzelwerte</div>' +
          data.steps.map(function (step) {
            var sum = step.summary || {};
            var title = 'Schritt ' + step.step_index + ': ' + escapeHtml(step.from_label || '') + ' → ' + escapeHtml(step.to_label || '') +
              ' <span class="muted">(' + escapeHtml(fmtDateTimeLocal(step.from_uploaded_at)) + ' → ' + escapeHtml(fmtDateTimeLocal(step.to_uploaded_at)) + ')</span>' +
              ' — geändert: ' + (sum.changed || 0) + ', neu: ' + (sum.added || 0) + ', entfernt: ' + (sum.removed || 0) + ', gleich: ' + (sum.unchanged || 0);
            return '<details class="anlagenstamm-trend-step"><summary>' + title + '</summary>' +
              renderAspTrendChangesTable(step.changes, showUnchanged) + '</details>';
          }).join('');
        return;
      }
      var fromF = data.from_file || {};
      var toF = data.to_file || {};
      var sum = data.summary || {};
      trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Vergleich: ' + escapeHtml(fromF.original_filename || '') + ' → ' + escapeHtml(toF.original_filename || '') +
        ' <span class="muted">(' + escapeHtml(fmtDateTimeLocal(fromF.uploaded_at)) + ' → ' + escapeHtml(fmtDateTimeLocal(toF.uploaded_at)) + ')</span></div>' +
        '<p style="padding:0.35rem 0.7rem;margin:0;font-size:0.84rem" class="muted">Einzelwerte: geändert ' + (sum.changed || 0) +
        ', neu ' + (sum.added || 0) + ', entfernt ' + (sum.removed || 0) + ', unverändert ' + (sum.unchanged || 0) + ' (von ' + (sum.total_keys || 0) + ' Zeilen)</p>' +
        renderAspTrendChangesTable(data.changes, showUnchanged);
    } catch (e) {
      trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Parameter-Trend</div>' +
        '<p class="empty" style="padding:0.5rem 0.7rem">Fehler: ' + escapeHtml(e.message || String(e)) + '</p>';
      if (msgEl) msgEl.textContent = 'Trend: ' + (e.message || String(e));
    }
  }

  async function loadAnlagenstammParameterFiles(fab) {
    var msgEl = document.getElementById('anlagenstammMessage');
    var wrapEl = document.getElementById('anlagenstammParameterList');
    var trendEl = document.getElementById('anlagenstammParameterTrend');
    if (!wrapEl) return;
    var fabNorm = String(fab || '').trim();
    if (!fabNorm) {
      wrapEl.style.display = 'none';
      wrapEl.innerHTML = '';
      if (trendEl) { trendEl.style.display = 'none'; trendEl.innerHTML = ''; }
      return;
    }
    try {
      var data = await api('/api/anlagenstamm_parameter_files_list', {
        method: 'POST',
        body: JSON.stringify(anlagenstammDispoBody({ fab: fabNorm }))
      });
      if (data && data.cache_notice && msgEl) {
        msgEl.textContent = data.cache_notice;
      } else if (msgEl && data && data.data_source === 'dispo') {
        msgEl.textContent = '';
      }
      var list = data && Array.isArray(data.files) ? data.files : [];
      wrapEl._aspFiles = list;
      if (!list.length) {
        wrapEl.style.display = '';
        wrapEl.innerHTML = '<div class="anlagenstamm-paramlist-head">Parameterlisten</div>' +
          '<div class="anlagenstamm-paramlist-row"><span class="empty">Noch keine gespeicherten Parameterdateien für diese F.N.</span></div>';
        if (trendEl) { trendEl.style.display = 'none'; trendEl.innerHTML = ''; }
        return;
      }
      wrapEl.style.display = '';
      var trendToolbar = '<div class="anlagenstamm-trend-toolbar">' +
        '<label>Von <select id="aspTrendFrom"></select></label>' +
        '<label>Zu <select id="aspTrendTo"></select></label>' +
        '<button type="button" class="btn btn-primary" id="btnAspTrendCompare">Einzelvergleich</button>' +
        '<button type="button" class="btn btn-ghost" id="btnAspTrendChain">Gesamttrend (alle Schritte)</button>' +
        '<label><input type="checkbox" id="aspTrendShowUnchanged"> Unveränderte anzeigen</label>' +
        '</div>';
      var cacheBanner = (data && data.data_source === 'cache')
        ? '<p class="muted" style="padding:0.35rem 0.7rem;margin:0">' +
          escapeHtml(data.cache_notice || 'Cache – nicht mit Dispo synchron') +
          '</p>'
        : '';
      wrapEl.innerHTML = cacheBanner +
        '<div class="anlagenstamm-paramlist-head">Parameterlisten (' + list.length + ')</div>' +
        trendToolbar +
        list.map(function (f) {
          var sourceLabel = f.source === 'projekte_neu' ? 'Projekte neu' : 'Upload';
          var who = f.technician_name ? String(f.technician_name) : (f.source === 'projekte_neu' ? '—' : 'Unbekannt');
          var status = f.source_file_status === 'original_deleted' ? 'Originaldatei gelöscht' : '';
          var name = String(f.original_filename || '');
          var date = fmtDateTimeLocal(f.uploaded_at);
          return '<div class="anlagenstamm-paramlist-row">' +
            '<div><strong>' + escapeHtml(name) + '</strong>' + (status ? '<div class="muted">' + escapeHtml(status) + '</div>' : '') + '</div>' +
            '<div>' + escapeHtml(sourceLabel) + '</div>' +
            '<div>' + escapeHtml(who) + '<div class="muted">' + escapeHtml(date) + '</div></div>' +
            '<div>' + escapeHtml(String(f.entry_count || 0)) + ' Werte</div>' +
            '<div><button class="btn btn-ghost" data-asp-file-id="' + encodeURIComponent(String(f.id || '')) + '" data-asp-filename="' + encodeURIComponent(name) + '">Download</button></div>' +
            '</div>';
        }).join('');
      wireAspTrendToolbar(fabNorm, list);
      var chkUnchanged = document.getElementById('aspTrendShowUnchanged');
      if (chkUnchanged) {
        chkUnchanged.addEventListener('change', function () {
          var fromSel = document.getElementById('aspTrendFrom');
          var toSel = document.getElementById('aspTrendTo');
          if (fromSel && toSel && fromSel.value && toSel.value) {
            loadAnlagenstammParameterTrend(fabNorm, {
              from_file_id: parseInt(fromSel.value, 10),
              to_file_id: parseInt(toSel.value, 10)
            });
          }
        });
      }
      if (list.length >= 2 && trendEl) {
        loadAnlagenstammParameterTrend(fabNorm, {
          from_file_id: list[list.length - 1].id,
          to_file_id: list[0].id
        });
      }
      wrapEl.querySelectorAll('[data-asp-file-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var fileId = parseInt(decodeURIComponent(btn.getAttribute('data-asp-file-id') || ''), 10);
          var fileName = decodeURIComponent(btn.getAttribute('data-asp-filename') || '');
          if (!fileId) return;
          downloadAnlagenstammParameterFile(fabNorm, fileId, fileName).catch(function (err) {
            if (msgEl) msgEl.textContent = 'Fehler: ' + (err.message || String(err));
          });
        });
      });
    } catch (e) {
      wrapEl.style.display = '';
      wrapEl.innerHTML = '<div class="anlagenstamm-paramlist-head">Parameterlisten</div>' +
        '<div class="anlagenstamm-paramlist-row"><span class="empty">Fehler beim Laden: ' + escapeHtml(e.message || String(e)) + '</span></div>';
      if (trendEl) { trendEl.style.display = 'none'; trendEl.innerHTML = ''; }
    }
  }

  async function loadAnlagenstammDetail(fab) {
    var msgEl = document.getElementById('anlagenstammMessage');
    var cardEl = document.getElementById('anlagenstammCard');
    var filesEl = document.getElementById('anlagenstammFiles');
    var paramEl = document.getElementById('anlagenstammParameterList');
    var trendEl = document.getElementById('anlagenstammParameterTrend');
    var paramBtn = document.getElementById('btnAnlagenstammParameterList');
    fab = (fab || '').trim();
    if (!fab) {
      if (msgEl) msgEl.textContent = 'Keine Fabrikationsnummer.';
      return;
    }
    if (msgEl) msgEl.textContent = 'Lade Stammdaten…';
    if (cardEl) cardEl.innerHTML = '';
    if (filesEl) { filesEl.style.display = 'none'; filesEl.innerHTML = ''; }
    if (paramEl) { paramEl.style.display = 'none'; paramEl.innerHTML = ''; }
    if (trendEl) { trendEl.style.display = 'none'; trendEl.innerHTML = ''; }
    if (paramBtn) {
      paramBtn.disabled = false;
      paramBtn.setAttribute('data-fab', fab);
    }
    var pnSecL = document.getElementById('anlagenstammPnSection');
    var pnTreeL = document.getElementById('anlagenstammPnTree');
    var pnHintL = document.getElementById('anlagenstammPnHint');
    var pnToggleL = document.getElementById('anlagenstammPnToggle');
    if (pnSecL) pnSecL.style.display = 'none';
    if (pnTreeL) pnTreeL.innerHTML = '';
    if (pnHintL) pnHintL.textContent = '';
    if (pnToggleL) {
      pnToggleL.open = false;
      pnToggleL.removeAttribute('data-pn-rendered');
      pnToggleL._pnPending = null;
    }
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
      await loadAnlagenstammParameterFiles(fab);
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
      var pnToggle = document.getElementById('anlagenstammPnToggle');
      if (pnSection && pnTreeEl && pnHintEl) {
        pnSection.style.display = 'block';
        pnTreeEl.innerHTML = '';
        if (pnToggle) {
          pnToggle.open = false;
          pnToggle.removeAttribute('data-pn-rendered');
        }
        var pnRaw = files && files.projekte_neu ? files.projekte_neu : {};
        var cached = await fetch(API_BASE + '/api/anlagenstamm_tree_cached?fab=' + encodeURIComponent(fab), {
          headers: { 'X-Technician-Id': String(getTechId() || '') }
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
        var cachedTree = (cached && cached.found && Array.isArray(cached.tree)) ? cached.tree : [];
        var usedCache = cached && cached.found && (cached.projects_enabled === true || cached.projects_enabled === 1);
        if (pnRaw && pnRaw.enabled) {
          var tr = Array.isArray(pnRaw.tree) ? pnRaw.tree : [];
          scheduleAnlagenstammPnTreeRender(pnTreeEl, fab, tr, msgEl, pnHintEl, pnToggle);
        } else if (usedCache && cachedTree.length) {
          pnHintEl.textContent = 'PROJEKTE NEU (lokaler Cache). Aufklappen für Ordner – Verbindung prüfen für Aktualisierung.';
          scheduleAnlagenstammPnTreeRender(pnTreeEl, fab, cachedTree, msgEl, pnHintEl, pnToggle);
        } else {
          pnHintEl.textContent = 'PROJEKTE NEU ist nicht verfügbar oder der Fabrikationsordner wurde auf dem Mount nicht gefunden.';
          if (pnToggle) pnToggle._pnPending = null;
        }
      }
      if (msgEl) msgEl.textContent = '';
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Fehler: ' + (e.message || String(e));
      var pnSecE = document.getElementById('anlagenstammPnSection');
      var pnTreeE = document.getElementById('anlagenstammPnTree');
      var pnHintE = document.getElementById('anlagenstammPnHint');
      var pnToggleE = document.getElementById('anlagenstammPnToggle');
      if (pnSecE) pnSecE.style.display = 'none';
      if (pnTreeE) pnTreeE.innerHTML = '';
      if (pnHintE) pnHintE.textContent = '';
      if (pnToggleE) {
        pnToggleE.open = false;
        pnToggleE.removeAttribute('data-pn-rendered');
        pnToggleE._pnPending = null;
      }
    }
  }

  async function downloadAnlagenstammParameterFile(fab, fileId, fileName) {
    if (!fab || !fileId) return;
    const technicianId = getTechId();
    const resp = await fetch(API_BASE + '/api/anlagenstamm_parameter_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(technicianId || '') },
      body: JSON.stringify(anlagenstammDispoBody({ fab: fab, file_id: fileId }))
    });
    if (!resp.ok) {
      let err = 'Download fehlgeschlagen.';
      try {
        const j = await resp.json();
        if (j && j.error) err = j.error;
      } catch (_) {}
      throw new Error(err);
    }
    const blob = await resp.blob();
    const disp = resp.headers.get('content-disposition') || '';
    const xName = resp.headers.get('x-download-filename') || '';
    let name = fileName || 'parameterliste';
    if (xName) {
      try { name = decodeURIComponent(xName); } catch (_) { name = xName; }
    } else {
      const m = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
      if (m && m[1]) {
        try { name = decodeURIComponent(m[1]); } catch (_) { name = m[1]; }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Download gestartet.');
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
    a.download = readDownloadNameFromResponse(resp, file);
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
    var fallback = (fallbackName && String(fallbackName).trim()) || parts[parts.length - 1] || 'download';
    a.download = readDownloadNameFromResponse(resp, fallback);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function openAnlagenstammProjekteNeuLocal(fab, relPath, fallbackName, opts) {
    opts = opts || {};
    if (!fab || !relPath) return;
    if (isProjekteNeuRasterImage(fallbackName || relPath)) {
      openProjekteNeuImageInLightbox(fab, relPath, {
        jobId: resolveProjekteNeuJobId(opts),
        alt: fallbackName || relPath,
        galleryImages: opts.galleryImages,
        treeNodes: opts.treeNodes,
        onError: opts.onError,
      });
      return;
    }
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

  function projekteNeuThumbImgUrl(fab, rel, opts) {
    opts = opts || {};
    var q =
      'fabrikationsnummer=' +
      encodeURIComponent(fab) +
      '&fab=' +
      encodeURIComponent(fab) +
      '&source=projekte_neu&path=' +
      encodeURIComponent(rel) +
      '&thumb=1&thumb_max=256';
    var tid = typeof getTechId === 'function' ? getTechId() : null;
    if (tid) q += '&technician_id=' + encodeURIComponent(String(tid));
    var jid = resolveProjekteNeuJobId(opts);
    if (jid) q += '&job_id=' + encodeURIComponent(String(jid));
    return API_BASE + '/api/anlagenstamm_file_download.php?' + q;
  }

  function dienstreiseThumbImgUrl(jobId, rel) {
    var q =
      'job_id=' +
      encodeURIComponent(jobId) +
      '&path=' +
      encodeURIComponent(rel) +
      '&thumb=1&thumbMax=256';
    var tid = typeof getTechId === 'function' ? getTechId() : null;
    if (tid) q += '&technician_id=' + encodeURIComponent(String(tid));
    return API_BASE + '/api/dienstreise/project_file?' + q;
  }

  function showProjekteNeuThumbFileIcon(timg) {
    if (!timg || !timg.parentNode) return;
    var fileRow = timg.parentNode;
    var ic = document.createElement('span');
    ic.className = 'projekte-neu-file-icon';
    ic.setAttribute('aria-hidden', 'true');
    ic.textContent = '\uD83D\uDCC4';
    fileRow.replaceChild(ic, timg);
  }

  function showDienstreiseExplorerThumbFileIcon(img) {
    if (!img || !img.parentNode) return;
    var nameCell = img.closest('.dienstreise-explorer-name');
    if (!nameCell) return;
    var ic = document.createElement('span');
    ic.className = 'icon';
    ic.setAttribute('aria-hidden', 'true');
    ic.textContent = '\uD83D\uDCC4';
    nameCell.replaceChild(ic, img);
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
      showProjekteNeuThumbFileIcon(timg);
    }
    projekteNeuThumbQueue.push({ timg: timg, fab: fab, rel: rel, fetchOpts: fetchOpts, setThumbBlob: setThumbBlob, showFileIcon: showFileIcon });
    drainProjekteNeuThumbQueue();
  }

  function loadProjekteNeuThumbnailImg(timg, fab, rel, opts) {
    if (!timg || !timg.parentNode) return;
    var directUrl = projekteNeuThumbImgUrl(fab, rel, opts);
    timg.loading = 'lazy';
    timg.src = directUrl;
    timg.onerror = function () {
      timg.onerror = null;
      enqueueProjekteNeuThumbnailLoad(timg, fab, rel, opts);
    };
  }

  function isProjekteNeuThumbInOpenDetails(timg) {
    var el = timg;
    while (el && el !== document.body) {
      if (el.tagName === 'DETAILS' && !el.open) return false;
      el = el.parentElement;
    }
    return true;
  }

  function loadPendingProjekteNeuThumbsIn(container) {
    if (!container) return;
    container.querySelectorAll('img.projekte-neu-thumb-pending').forEach(function (timg) {
      if (!isProjekteNeuThumbInOpenDetails(timg)) return;
      var fab = timg.getAttribute('data-pn-fab');
      var rel = timg.getAttribute('data-pn-rel');
      if (!fab || !rel) return;
      timg.classList.remove('projekte-neu-thumb-pending');
      var jobId = timg.getAttribute('data-pn-job-id');
      loadProjekteNeuThumbnailImg(timg, fab, rel, {
        jobId: jobId || undefined,
        thumbMax: parseInt(timg.getAttribute('data-pn-thumb-max') || '256', 10) || 256,
      });
    });
  }

  function bindProjekteNeuLazyThumbnails(root) {
    if (!root || root.getAttribute('data-pn-lazy-thumbs') === '1') return;
    root.setAttribute('data-pn-lazy-thumbs', '1');
    root.addEventListener('toggle', function (ev) {
      var det = ev.target;
      if (!det || det.tagName !== 'DETAILS' || !det.open) return;
      loadPendingProjekteNeuThumbsIn(det);
    }, true);
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
      var candidates = [relNorm, 'Dokumente_Anlage/' + relNorm];
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

  function projekteNeuImageApiUrl(fab, rel, inline, jobIdOpt) {
    var q =
      'fabrikationsnummer=' +
      encodeURIComponent(fab) +
      '&fab=' +
      encodeURIComponent(fab) +
      '&source=projekte_neu&path=' +
      encodeURIComponent(rel);
    var tid = typeof getTechId === 'function' ? getTechId() : null;
    if (tid) q += '&technician_id=' + encodeURIComponent(String(tid));
    var jid = jobIdOpt != null ? jobIdOpt : (typeof jobDetailsJobId !== 'undefined' ? jobDetailsJobId : null);
    if (jid) q += '&job_id=' + encodeURIComponent(String(jid));
    if (inline) q += '&inline=1';
    return API_BASE + '/api/anlagenstamm_file_download.php?' + q;
  }

  function collectProjekteNeuGalleryImages(fab, nodes, jobIdOpt) {
    if (!window.MonteurImageGallery) return [];
    return window.MonteurImageGallery.collectRasterFilesFromTree(nodes, function (_n, name, rel) {
      return {
        url: projekteNeuImageApiUrl(fab, rel, true, jobIdOpt),
        thumbUrl: projekteNeuImageApiUrl(fab, rel, false, jobIdOpt) + '&thumb=1&thumb_max=256',
        label: name || rel,
      };
    });
  }

  function collectDienstreiseExplorerGalleryImages(jobId, listEl) {
    if (!listEl || !window.MonteurImageGallery) return [];
    var tid = typeof getTechId === 'function' ? getTechId() : null;
    var out = [];
    listEl.querySelectorAll('.dienstreise-explorer-row[data-relative-path]').forEach(function (row) {
      var rel = row.getAttribute('data-relative-path') || '';
      var nameEl = row.querySelector('.dienstreise-explorer-filename');
      var name = nameEl ? nameEl.textContent : rel;
      if (!rel || !isProjekteNeuRasterImage(name)) return;
      var base =
        API_BASE +
        '/api/dienstreise/project_file?job_id=' +
        encodeURIComponent(jobId) +
        '&path=' +
        encodeURIComponent(rel);
      if (tid) base += '&technician_id=' + encodeURIComponent(String(tid));
      out.push({
        url: base + '&inline=1',
        thumbUrl: base + '&thumb=1&thumbMax=256',
        label: String(name || rel).trim(),
      });
    });
    return out;
  }

  function openMonteurImageGalleryOrLightbox(images, index, lightboxFn, title) {
    if (window.MonteurImageGallery && window.monteurApp && window.monteurApp.openImageGallery) {
      return window.MonteurImageGallery.open(images, index, {
        title: title,
        fallback: function (item) {
          if (typeof lightboxFn === 'function') lightboxFn(item);
        },
      }).then(function (res) {
        if ((!res || res.ok === false) && typeof lightboxFn === 'function' && images && images[index]) {
          lightboxFn(images[index]);
        }
        return res;
      });
    }
    if (typeof lightboxFn === 'function' && images && images[index]) lightboxFn(images[index]);
    return Promise.resolve({ ok: false, fallback: true });
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
    var gallery = Array.isArray(opts.galleryImages) ? opts.galleryImages : null;
    if (!gallery && Array.isArray(opts.treeNodes)) {
      gallery = collectProjekteNeuGalleryImages(fab, opts.treeNodes);
    }
    if (gallery && gallery.length && window.MonteurImageGallery) {
      var idx = 0;
      for (var gi = 0; gi < gallery.length; gi++) {
        if (String(gallery[gi].url || '').indexOf(encodeURIComponent(rel)) >= 0) {
          idx = gi;
          break;
        }
      }
      openMonteurImageGalleryOrLightbox(gallery, idx, function (item) {
        openProjekteNeuImageInLightboxBlob(fab, rel, opts);
      }, opts.alt || fab);
      return;
    }
    openProjekteNeuImageInLightboxBlob(fab, rel, opts);
  }

  function openProjekteNeuImageInLightboxBlob(fab, rel, opts) {
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
    img.loading = 'lazy';
    img.src = dienstreiseThumbImgUrl(jobId, relativePath);
    img.onerror = function () {
      img.onerror = null;
      fetchDienstreiseProjectFileBlob(jobId, relativePath, { thumb: true, thumbMax: 256 })
        .then(function (blob) {
          if (!img.parentNode) return;
          var prev = img.getAttribute('data-blob-url');
          if (prev) {
            try { URL.revokeObjectURL(prev); } catch (_) {}
          }
          var url = URL.createObjectURL(blob);
          img.setAttribute('data-blob-url', url);
          img.src = url;
        })
        .catch(function () {
          showDienstreiseExplorerThumbFileIcon(img);
        });
    };
  }

  function openDienstreiseProjectImageInLightbox(jobId, relativePath, opts) {
    opts = opts || {};
    var gallery = Array.isArray(opts.galleryImages) ? opts.galleryImages : null;
    if (!gallery && opts.listEl) {
      gallery = collectDienstreiseExplorerGalleryImages(jobId, opts.listEl);
    }
    if (gallery && gallery.length && window.MonteurImageGallery) {
      var idx = 0;
      for (var gi = 0; gi < gallery.length; gi++) {
        if (String(gallery[gi].label || '').trim() === String(opts.alt || '').trim()) {
          idx = gi;
          break;
        }
      }
      openMonteurImageGalleryOrLightbox(gallery, idx, function () {
        openDienstreiseProjectImageInLightboxBlob(jobId, relativePath, opts);
      }, opts.alt || 'Bildergalerie');
      return;
    }
    openDienstreiseProjectImageInLightboxBlob(jobId, relativePath, opts);
  }

  function openDienstreiseProjectImageInLightboxBlob(jobId, relativePath, opts) {
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

  function buildAnlageDetailProjekteNeuTree(fab, nodes, depth, msgEl, galleryImages) {
    depth = depth || 0;
    if (depth === 0 && !galleryImages) {
      galleryImages = collectProjekteNeuGalleryImages(fab, nodes, jobDetailsJobId);
    }
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
        details.open = false;
        var summary = document.createElement('summary');
        summary.style.cursor = 'pointer';
        summary.textContent = String(n.name || 'Ordner');
        details.appendChild(summary);
        if (Array.isArray(n.children) && n.children.length) {
          details.appendChild(buildAnlageDetailProjekteNeuTree(fab, n.children, depth + 1, msgEl, galleryImages));
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
          timg.className = 'projekte-neu-thumb projekte-neu-thumb-pending';
          timg.alt = label;
          timg.setAttribute('data-pn-fab', fab);
          timg.setAttribute('data-pn-rel', rel);
          timg.setAttribute('data-pn-thumb-max', '256');
          if (jobDetailsJobId) timg.setAttribute('data-pn-job-id', String(jobDetailsJobId));
          fileRow.appendChild(timg);
          timg.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            openProjekteNeuImageInLightbox(fab, rel, {
              jobId: jobDetailsJobId,
              alt: label,
              galleryImages: galleryImages,
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
          if (isProjekteNeuRasterImage(label)) {
            openProjekteNeuImageInLightbox(fab, rel, {
              jobId: jobDetailsJobId,
              alt: label,
              galleryImages: galleryImages,
              onError: function (err) { notifyErr(err, { thumbOnly: false }); },
            });
            return;
          }
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

  /** PROJEKTE NEU im Anlagenstamm: Baum erst beim Aufklappen rendern. */
  function scheduleAnlagenstammPnTreeRender(pnTreeEl, fab, nodes, msgEl, pnHintEl, pnToggle) {
    if (!pnTreeEl) return;
    var tree = Array.isArray(nodes) ? nodes : [];
    if (pnHintEl && !pnHintEl.textContent) {
      pnHintEl.textContent = tree.length
        ? 'Aufklappen für Ordner – Vorschaubilder laden beim Öffnen eines Ordners.'
        : 'Aufklappen – keine Einträge in diesem Fabrikationsordner.';
    }
    if (!pnToggle) {
      if (!tree.length) {
        pnTreeEl.innerHTML = '<div class="empty" style="padding:0.35rem 0">Keine Einträge in diesem Fabrikationsordner.</div>';
        return;
      }
      appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, fab, tree, msgEl);
      return;
    }
    pnToggle._pnPending = { fab: fab, tree: tree, msgEl: msgEl };
    if (pnToggle.getAttribute('data-pn-toggle-bound') !== '1') {
      pnToggle.setAttribute('data-pn-toggle-bound', '1');
      pnToggle.addEventListener('toggle', function () {
        if (!pnToggle.open || pnToggle.getAttribute('data-pn-rendered') === '1') return;
        var pending = pnToggle._pnPending;
        pnTreeEl.innerHTML = '';
        if (!pending || !pending.tree || !pending.tree.length) {
          pnTreeEl.innerHTML = '<div class="empty" style="padding:0.35rem 0">Keine Einträge in diesem Fabrikationsordner.</div>';
        } else {
          appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, pending.fab, pending.tree, pending.msgEl);
        }
        pnToggle.setAttribute('data-pn-rendered', '1');
      });
    }
  }

  /** Wie Projektdaten: Vorschaubilder + Lightbox; optional gleicher Parent-Heading wie früher im reinen UL-Renderer. */
  function appendProjekteNeuTreeForAnlagenstamm(pnTreeEl, fab, nodes, msgEl) {
    if (!pnTreeEl || !nodes || !nodes.length) return;
    bindProjekteNeuLightboxOnce();
    var treeRoot = buildAnlageDetailProjekteNeuTree(fab, nodes, 0, msgEl);
    bindProjekteNeuLazyThumbnails(treeRoot);
    var htxt = pnParentHeadingForSiblings(nodes);
    if (htxt) {
      var block = document.createElement('div');
      block.className = 'anlagenstamm-pn-tree-block';
      var det = document.createElement('details');
      det.className = 'anlagenstamm-pn-details';
      det.open = false;
      var sum = document.createElement('summary');
      sum.className = 'anlagenstamm-pn-parent-heading';
      sum.textContent = htxt;
      det.appendChild(sum);
      det.appendChild(treeRoot);
      block.appendChild(det);
      pnTreeEl.appendChild(block);
      bindProjekteNeuLazyThumbnails(block);
    } else {
      pnTreeEl.appendChild(treeRoot);
    }
    loadPendingProjekteNeuThumbsIn(pnTreeEl);
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
    if (msg) {
      msg.textContent = 'Lade Struktur…';
      msg.classList.remove('projektdaten-projekte-neu-folder');
    }
    if (!opts.keepTreeWhileLoading) treeHost.innerHTML = '';
    function renderTree(tree, statusText, folderName) {
      treeHost.innerHTML = '';
      if (tree && tree.length) {
        var treeRoot = buildAnlageDetailProjekteNeuTree(fab, tree, 0, msg);
        treeHost.appendChild(treeRoot);
        bindProjekteNeuLazyThumbnails(treeHost);
        if (!toggleEl || toggleEl.open) {
          loadPendingProjekteNeuThumbsIn(treeHost);
        }
        if (msg) {
          if (statusText) {
            msg.textContent = statusText;
            msg.classList.remove('projektdaten-projekte-neu-folder');
          } else {
            msg.textContent = projekteNeuFolderLabel(fab, folderName);
            msg.classList.add('projektdaten-projekte-neu-folder');
          }
        }
      } else if (msg) {
        msg.textContent = statusText || 'Keine Dokumente im PROJEKTE-NEU-Baum gefunden.';
        msg.classList.remove('projektdaten-projekte-neu-folder');
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
        renderTree(cachedTreeEarly, '', cached && cached.folder);
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
          return renderTree(localTree.tree, '', localTree.folder);
        }
      }
      if (!allowOnline || (!getDispoExternalUrl() && !getDispoInternalUrl())) {
        if (msg) {
          msg.textContent = 'Keine lokalen PROJEKTE-NEU-Daten für diese FN. Bitte Anlagenstamm synchronisieren (lädt Ordnerstruktur aus der Server-DB) – Dateien werden bei Bedarf online geladen und lokal zwischengespeichert.';
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
      renderTree(
        tree,
        'Noch keine lokale Kopie – Struktur vom Server (nach „Auftrag annehmen“ offline nutzbar).',
        pnRaw.folder_name,
      );
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
      allowOnline: true,
    });
  }

  function showView(name) {
    const viewStart = document.getElementById('viewStart');
    const viewEinstellungen = document.getElementById('viewEinstellungen');
    const viewProjektdaten = document.getElementById('viewProjektdaten');
    const viewDienstreise = document.getElementById('viewDienstreise');
    const viewAbrechnung = document.getElementById('view-abrechnung');
    const viewZeitschreibung = document.getElementById('view-zeitschreibung');
    const viewArchiv = document.getElementById('viewArchiv');
    const viewAbwesenheiten = document.getElementById('viewAbwesenheiten');
    const viewAnlagenstamm = document.getElementById('viewAnlagenstamm');
    const protokolleViewIds = ['viewProtokolleMontagebericht', 'viewProtokolleParameterlisten', 'viewProtokolleKontrollwiegungen', 'viewProtokolleInbetriebnahme', 'viewProtokolleService'];
    viewStart.classList.remove('only-left', 'only-right', 'hidden');
    viewEinstellungen.classList.remove('active');
    if (viewProjektdaten) viewProjektdaten.classList.remove('active');
    // Verhindert, dass Sync/Background-Refresh zurück auf Projektdaten springt.
    jobDetailsJobId = null;
    projektdatenExplorerJobId = null;
    if (typeof updateProjektdatenHeadingMeta === 'function') updateProjektdatenHeadingMeta(null);
    if (viewDienstreise) viewDienstreise.classList.remove('active');
    if (viewAbrechnung) viewAbrechnung.classList.remove('active');
    if (viewZeitschreibung) viewZeitschreibung.classList.remove('active');
    protokolleViewIds.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    const viewTextbausteine = document.getElementById('viewTextbausteine');
    if (viewTextbausteine) viewTextbausteine.classList.remove('active');
    const viewArbeitsschritte = document.getElementById('viewArbeitsschritte');
    if (viewArbeitsschritte) viewArbeitsschritte.classList.remove('active');
    if (viewArchiv) viewArchiv.classList.remove('active');
    if (viewAbwesenheiten) viewAbwesenheiten.classList.remove('active');
    if (viewAnlagenstamm) viewAnlagenstamm.classList.remove('active');
    if (name === 'einstellungen') {
      viewStart.classList.add('hidden');
      viewEinstellungen.classList.add('active');
      updateTechnicianName();
      refreshMonteurProfileHintForSettings();
      loadSettingsSyncStatus().catch(function () {});
      refreshServerMaintenanceZone().catch(function () {});
      refreshMonteurDevicesList().catch(function () {});
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
      loadAbrechnungViewDesktopStyle().catch(function (e) {
        window.alert((e && e.message) ? e.message : String(e));
      });
      return;
    }
    if (name === 'zeitschreibung') {
      viewStart.classList.add('hidden');
      if (viewZeitschreibung) viewZeitschreibung.classList.add('active');
      const host = document.getElementById('zeitschreibung-host');
      if (host && window.monteurZeitschreibung && typeof window.monteurZeitschreibung.load === 'function') {
        window.monteurZeitschreibung.load(host).catch(function (e) {
          window.alert((e && e.message) ? e.message : String(e));
        });
      }
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
      if (name === 'protokolle-service' && typeof window.openProtokolleService === 'function') {
        window.openProtokolleService();
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
    if (name === 'arbeitsschritte') {
      viewStart.classList.add('hidden');
      if (viewArbeitsschritte) {
        viewArbeitsschritte.classList.add('active');
        if (typeof loadArbeitsschritteView === 'function') loadArbeitsschritteView();
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
      loadAnlagenstammViewDesktopStyle().catch(function (e) {
        console.warn('[anlagenstamm]', e && e.message ? e.message : e);
      });
      return;
    }
    if (name === 'start') {
      var nowStart = Date.now();
      if (nowStart - startViewDataLoadedAt >= START_VIEW_DATA_MS) {
        startViewDataLoadedAt = nowStart;
        loadStartActiveJob();
        loadCalendarMonth();
      } else if (startPageActiveJobId) {
        loadDienstreiseExplorer(startPageActiveJobId, startExplorerSubpath, 'start');
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

  /** „Datum nicht fix“: Anzeige wenn lokal oder Kalender-Cache gesetzt (0 blockiert nicht 1). */
  function mergeDateNotFixedFlag(localVal, cacheVal) {
    return Number(localVal) === 1 || Number(cacheVal) === 1 ? 1 : 0;
  }

  /** Kalender-Flags aus Cache/API (Abrechnung + „Datum nicht fix“). */
  function calendarBillingFlagsFrom(src) {
    if (!src) return {};
    var out = {};
    if (src.montage_verrechnet != null && src.montage_verrechnet !== '') {
      out.montage_verrechnet = Number(src.montage_verrechnet) === 1 ? 1 : 0;
    }
    if (src.billing_travel_complete != null && src.billing_travel_complete !== '') {
      out.billing_travel_complete = Number(src.billing_travel_complete) === 1 ? 1 : 0;
    }
    if (src.date_not_fixed != null && src.date_not_fixed !== '') {
      out.date_not_fixed = Number(src.date_not_fixed) === 1 ? 1 : 0;
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

  /** Lokale jobs.id für Kalender-Aktionen (Klick, Modal) — nie blind server_job_id. */
  function calendarLocalActionJobId(job) {
    if (!job) return null;
    var lid = job.local_job_id != null ? parseInt(job.local_job_id, 10) : NaN;
    if (Number.isFinite(lid) && lid > 0) return lid;
    var sid = job.server_id != null ? String(job.server_id).trim() : '';
    var jid = job.id != null ? String(job.id).trim() : '';
    if (jid && (!sid || jid !== sid)) {
      var idNum = parseInt(job.id, 10);
      if (Number.isFinite(idNum) && idNum > 0) return idNum;
    }
    return null;
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
      var fromCache = calendarBillingFlagsFrom(cj);
      var merged = Object.assign({}, j, fromCache);
      if (cj.local_job_id != null) merged.local_job_id = cj.local_job_id;
      merged.date_not_fixed = mergeDateNotFixedFlag(j.date_not_fixed, cj.date_not_fixed);
      return merged;
    });
  }

  async function fetchCalendarCachedMonth(start, end, techId) {
    return fetch(API_BASE + '/api/calendar_cached?' + qs({ start: start, end: end }), {
      headers: { 'X-Technician-Id': String(techId || 0) }
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  /** Sichtbaren Monat online von Dispo in den lokalen Kalender-Cache schreiben (Umbuchungen). */
  async function refreshCalendarCacheFromDispo(start, end, techId) {
    var baseUrl = (typeof getDispoBaseUrl === 'function' ? getDispoBaseUrl() : '') || '';
    baseUrl = String(baseUrl).trim().replace(/\/+$/, '');
    if (!baseUrl) return { ok: false, skipped: true };
    var user = typeof getDispoUsername === 'function' ? getDispoUsername() : '';
    var pass = typeof getDispoPassword === 'function' ? getDispoPassword() : '';
    if (!user || !pass) return { ok: false, skipped: true };
    try {
      var r = await fetch(API_BASE + '/api/calendar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Technician-Id': String(techId || 0)
        },
        body: JSON.stringify({
          baseUrl: baseUrl,
          start: start,
          end: end,
          serverUsername: user,
          serverPassword: pass,
          skipJobEnrich: true
        })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data || data.ok === false) {
        return { ok: false, error: (data && data.error) || ('HTTP ' + r.status) };
      }
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
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
      return Object.assign({}, j, calendarJobTechFields(j, techById, techId), {
        local_job_id: j.id != null ? j.id : null,
      });
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
        // Dispo ist Quelle: sichtbaren Zeitraum zuerst in den Cache ziehen, sonst bleiben Umbuchungen hängen.
        var refresh = await refreshCalendarCacheFromDispo(start, end, myTechId);
        if (refresh && refresh.ok === false && !refresh.skipped) {
          console.warn('[Kalender] Cache-Refresh:', refresh.error || 'fehlgeschlagen');
        }
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
            var cacheFlags = calendarBillingFlagsFrom(j);
            // Termin/Zuweisung kommen aus dem Cache (Dispo); lokal nur ID/Billing anreichern.
            var mergedJob = Object.assign({}, j, cacheFlags, techDisplay, {
              local_job_id: localJob.id,
              id: localJob.id,
              server_id: localJob.server_id != null ? localJob.server_id : j.id
            });
            mergedJob.date_not_fixed = mergeDateNotFixedFlag(localJob.date_not_fixed, j.date_not_fixed);
            return mergedJob;
          }
          return Object.assign({}, j, techDisplay, {
            local_job_id: j.local_job_id != null ? j.local_job_id : null,
          });
        });
        // Keine lokalen Aufträge mehr anhängen, die im Dispo-Cache fehlen — sonst bleiben
        // umgebuchte Termine (z. B. Georgia-Pacific / alte Köprinner-Zuweisung) sichtbar.
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
    absences = filterCalendarAbsencesForView(absences);
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
    const full = parts.join(', ');
    const label = maxLen && full.length > maxLen ? (maxLen <= 4 ? full.substring(0, maxLen) : full.substring(0, maxLen - 4) + ',...') : full;
    const statusRaw = (job.status != null ? job.status : job.Status != null ? job.Status : job.job_status != null ? job.job_status : '').toString().trim().toLowerCase();
    const isErledigt = statusRaw === 'erledigt' || statusRaw === 'abgerechnet' || statusRaw === 'completed' || statusRaw === 'done' || statusRaw === 'fertig';
    const isMontage = Number(job.montage_verrechnet) === 1;
    const isReise = Number(job.billing_travel_complete) === 1;
    const dateNotFixed = Number(job.date_not_fixed) === 1;
    const escLabel = (label || 'Auftrag').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const checkParts = [];
    if (dateNotFixed) checkParts.push('<strong class="cal-date-not-fixed" title="Datum nicht fix">???</strong>');
    const flagHtml = countryFlagImg(countryCode);
    if (flagHtml) checkParts.push('<span class="cal-bar-flag">' + flagHtml + '</span>');
    if (isErledigt) checkParts.push('<span class="cal-check cal-check-erledigt" title="Erledigt">✓</span>');
    if (isMontage) checkParts.push('<span class="cal-check cal-check-montage" title="Fakturierung Montage">✓</span>');
    if (isReise) checkParts.push('<span class="cal-check cal-check-reise" title="Reisekosten abgerechnet">✓</span>');
    const labelHtml = checkParts.length
      ? '<span class="cal-bar-inner">' + checkParts.join('') + '<span class="cal-bar-label">' + escLabel + '</span></span>'
      : null;

    let titleParts = [firma];
    if (ort) titleParts.push(ort);
    if (land2) titleParts.push(land2);
    let title = titleParts.join(', ') || firma || 'Auftrag';
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
          const actionJobId = calendarLocalActionJobId(j);
          const canActOnJob = isOwnTechJob && actionJobId != null;
          band.style.cursor = canActOnJob ? 'pointer' : 'default';
          const colSpan = colEnd - colStart;
          const maxChars = colSpan * 20;
          const bar = jobBarText(j, maxChars);
          band.title = canActOnJob
            ? ((bar.title || '') + ' (Doppelklick: Projektdaten)')
            : isOwnTechJob && !actionJobId
              ? ((bar.title || '') + ' (noch nicht lokal zugeordnet – Sync ausführen)')
              : (bar.title || '');
          if (bar.labelHtml) band.innerHTML = bar.labelHtml; else band.textContent = bar.label || 'Auftrag';
          if (canActOnJob) {
            band.addEventListener('click', function (ev) {
              if (ev.detail > 1) return;
              if (typeof loadStartActiveJobById === 'function') loadStartActiveJobById(actionJobId, j);
            });
            band.addEventListener('dblclick', function () {
              if (typeof openJobDetailsModal === 'function') openJobDetailsModal(actionJobId);
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
  var dienstreiseExplorerLoadedJobId = null;
  var startExplorerSubpath = '';
  var startExplorerRootEntries = [];
  var startExplorerExpanded = {};
  var startExplorerLoadedJobId = null;
  var explorerLoadSeqByUi = { start: 0, modal: 0, page: 0 };
  var explorerSoftRefreshTimers = { start: null, modal: null, page: null };
  var dienstreiseProtectedPathsByJob = {};
  var projectFolderAutoPullInFlightByJob = {};
  var projectFolderAutoPullLastStartedAt = {};
  var PROJECT_FOLDER_AUTO_PULL_MIN_INTERVAL_MS = 5 * 60 * 1000;

  function applyDienstreiseProtectedPaths(jobId, paths) {
    var key = String(jobId);
    dienstreiseProtectedPathsByJob[key] = new Set(
      (paths || [])
        .map(function (p) {
          return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        })
        .filter(Boolean)
    );
    return dienstreiseProtectedPathsByJob[key];
  }

  function normalizeExplorerRelPath(rel) {
    return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  function getDienstreiseProtectedSet(jobId) {
    var key = String(jobId);
    if (!dienstreiseProtectedPathsByJob[key]) dienstreiseProtectedPathsByJob[key] = new Set();
    return dienstreiseProtectedPathsByJob[key];
  }

  function isExplorerPathProtected(protectedSet, relPath) {
    return !!(relPath && protectedSet.has(normalizeExplorerRelPath(relPath)));
  }

  function loadDienstreiseProtectedPaths(jobId) {
    var techId = getTechId();
    var q =
      'job_id=' +
      encodeURIComponent(jobId) +
      (techId ? '&technician_id=' + encodeURIComponent(techId) : '');
    return fetch(API_BASE + '/api/dienstreise/protected_paths?' + q, {
      headers: techId ? { 'X-Technician-Id': String(techId) } : {},
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.paths)) {
          applyDienstreiseProtectedPaths(jobId, data.paths);
        } else if (data && data.error) {
          console.warn('[protected_paths]', data.error);
        }
        return data;
      })
      .catch(function (err) {
        console.warn('[protected_paths]', err && err.message ? err.message : err);
        return null;
      });
  }

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

  function isDienstreiseAnlageDbEntry(e) {
    return !!(e && (e.isAnlageDb || e.is_anlage_db));
  }

  function dienstreiseAnlageOfflineBadge(e) {
    if (!isDienstreiseAnlageDbEntry(e) || e.isDirectory) return '';
    if (e.isOffline || e.is_offline) {
      return ' <span class="dienstreise-anlage-offline-badge" title="Offline verfügbar" style="color:#2e7d32;font-size:0.75rem;">●</span>';
    }
    return ' <span class="dienstreise-anlage-online-badge muted" title="Online – wird beim Öffnen geladen" style="font-size:0.75rem;">☁</span>';
  }

  function openDienstreiseAnlageDbFile(row, jobId) {
    var fab = row.getAttribute('data-fab');
    var pnRel = row.getAttribute('data-pn-rel');
    var fileNameEl = row.querySelector('.dienstreise-explorer-filename');
    var name = fileNameEl ? fileNameEl.textContent.trim() : '';
    if (!fab || !pnRel) return Promise.reject(new Error('Pfad unvollständig.'));
    if (isProjekteNeuRasterImage(name || pnRel)) {
      openProjekteNeuImageInLightbox(fab, pnRel, { jobId: jobId, alt: name });
      return Promise.resolve();
    }
    return openAnlagenstammProjekteNeuLocal(fab, pnRel, name, { jobId: jobId });
  }

  function explorerEntryStructSig(e) {
    if (!e) return '';
    return [
      normalizeExplorerRelPath(e.relativePath || ''),
      e.isDirectory ? '1' : '0',
      e.name != null ? String(e.name) : '',
      e.isOffline || e.is_offline ? '1' : '0',
      e.isAnlageDb || e.is_anlage_db ? '1' : '0',
    ].join('|');
  }

  function explorerEntryMetaSig(e) {
    if (!e) return '';
    return [
      e.size != null ? String(e.size) : '',
      e.mtime != null ? String(e.mtime) : '',
    ].join('|');
  }

  function buildExplorerTreeSignature(rootEntries, expanded, protectedSet, mode) {
    // mode: 'struct' = Pfade/Namen/Expand (kein Zittern), 'meta' = Größe/mtime, 'full' = beides
    var useStruct = mode !== 'meta';
    var useMeta = mode === 'meta' || mode === 'full';
    var parts = [];
    function walk(entries, level) {
      if (!entries) return;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var rel = normalizeExplorerRelPath(e.relativePath || '');
        var bit = level + ':';
        if (useStruct) bit += explorerEntryStructSig(e) + ':' + (protectedSet && protectedSet.has(rel) ? '1' : '0');
        if (useMeta) bit += (useStruct ? ':' : '') + explorerEntryMetaSig(e);
        parts.push(bit);
        if (e.isDirectory && expanded && expanded[e.relativePath]) {
          walk(expanded[e.relativePath], level + 1);
        }
      }
    }
    walk(rootEntries, 0);
    return parts.join('\n');
  }

  function explorerListHasTreeRows(listEl) {
    return !!(listEl && listEl.querySelector && listEl.querySelector('.dienstreise-explorer-row'));
  }

  function setElementHtmlIfChanged(el, html, attrKey) {
    if (!el) return false;
    var key = attrKey || 'data-html-sig';
    var prev = el.getAttribute(key);
    if (prev === html) return false;
    el.setAttribute(key, html);
    el.innerHTML = html;
    return true;
  }

  function patchExplorerTreeMeta(listEl, rows, protectedSet) {
    if (!listEl || !rows) return;
    var byRel = {};
    rows.forEach(function (r) {
      var e = r && r.entry;
      if (!e) return;
      byRel[normalizeExplorerRelPath(e.relativePath || '')] = e;
    });
    listEl.querySelectorAll('.dienstreise-explorer-row').forEach(function (row) {
      var rel = normalizeExplorerRelPath(row.getAttribute('data-relative-path') || '');
      var e = byRel[rel];
      if (!e) return;
      var sizeCells = row.querySelectorAll('.dienstreise-explorer-size');
      if (sizeCells[0]) {
        sizeCells[0].textContent = e.isDirectory ? '' : formatFileSize(e.size);
      }
      if (sizeCells[1]) {
        sizeCells[1].textContent = formatFileDate(e.mtime);
      }
      var cb = row.querySelector('[data-explorer-protect]');
      if (cb && protectedSet) {
        var want = isExplorerPathProtected(protectedSet, rel);
        if (cb.checked !== want) cb.checked = want;
      }
      if (e.fullPath) row.setAttribute('data-full-path', e.fullPath);
    });
  }

  function pruneExplorerExpandedToExisting(rootEntries, expanded) {
    var next = {};
    var present = {};
    function mark(entries) {
      if (!entries) return;
      entries.forEach(function (e) {
        if (!e || !e.isDirectory) return;
        var rel = e.relativePath;
        if (!rel) return;
        present[rel] = true;
        if (expanded[rel]) mark(expanded[rel]);
      });
    }
    mark(rootEntries);
    Object.keys(expanded || {}).forEach(function (rel) {
      if (present[rel] && Array.isArray(expanded[rel])) next[rel] = expanded[rel];
    });
    return next;
  }

  function refreshExplorerExpandedEntries(jobId, expanded) {
    var keys = Object.keys(expanded || {});
    if (!keys.length) return Promise.resolve(expanded || {});
    return Promise.all(
      keys.map(function (rel) {
        return fetch(
          API_BASE +
            '/api/dienstreise/project_files?job_id=' +
            encodeURIComponent(jobId) +
            '&subpath=' +
            encodeURIComponent(rel)
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (data && data.ok && Array.isArray(data.entries)) {
              expanded[rel] = data.entries;
            } else {
              delete expanded[rel];
            }
          })
          .catch(function () {
            /* alte Einträge behalten */
          });
      })
    ).then(function () {
      return expanded;
    });
  }

  function renderDienstreiseExplorerTree(uiKey, opts) {
    opts = opts || {};
    var ui = getDienstreiseExplorerUi(uiKey || 'modal');
    var listEl = ui.getListEl();
    var jobId = getDienstreiseExplorerJobId(ui.key);
    if (!listEl || !jobId) return;
    var protectedSet = getDienstreiseProtectedSet(jobId);
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
      listEl.removeAttribute('data-explorer-sig');
      listEl.removeAttribute('data-explorer-meta-sig');
      listEl.innerHTML = '<span class="empty">Ordner leer.</span>';
      return;
    }
    var structSig = buildExplorerTreeSignature(ui.getRootEntries(), expanded, protectedSet, 'struct');
    var metaSig = buildExplorerTreeSignature(ui.getRootEntries(), expanded, protectedSet, 'meta');
    var sameStruct =
      !opts.forceDom &&
      listEl.getAttribute('data-explorer-sig') === structSig &&
      explorerListHasTreeRows(listEl);
    if (sameStruct) {
      if (listEl.getAttribute('data-explorer-meta-sig') !== metaSig) {
        patchExplorerTreeMeta(listEl, rows, protectedSet);
        listEl.setAttribute('data-explorer-meta-sig', metaSig);
      }
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
      var relPath = normalizeExplorerRelPath(e.relativePath || '');
      var isProtected = isExplorerPathProtected(protectedSet, relPath);
      var isAnlageDb = isDienstreiseAnlageDbEntry(e);
      var isOfflineAnlage = !!(e.isOffline || e.is_offline);
      var protectControl = drReadonlyGeplant ? '' : ('<label style="display:inline-flex;align-items:center;gap:0.25rem;"><input type="checkbox" data-explorer-protect ' + (isProtected ? 'checked' : '') + '>Nicht löschen</label>');
      var deleteBtn =
        drReadonlyGeplant || e.isDirectory || (isAnlageDb && !isOfflineAnlage)
          ? ''
          : '<button type="button" class="btn btn-ghost btn-delete-file" data-explorer-delete title="Datei löschen (lokal und auf Dispo)">Löschen</button>';
      var isRasterImage = !e.isDirectory && isProjekteNeuRasterImage(e.name);
      var previewBtn = isRasterImage
        ? '<button type="button" class="btn btn-ghost" data-explorer-preview title="Bild in der App anzeigen">Vorschau</button>'
        : '';
      var nameVisual = isRasterImage
        ? '<img class="dienstreise-explorer-thumb" data-explorer-thumb alt="" />'
        : ('<span class="icon" aria-hidden="true">' + icon + '</span>');
      var anlageAttrs =
        isAnlageDb
          ? ' data-anlage-db="1" data-fab="' +
            escapeHtml(String(e.fab || '')) +
            '" data-pn-rel="' +
            escapeHtml(String(e.pnRel || e.pn_rel || '')) +
            '" data-is-offline="' +
            (isOfflineAnlage ? '1' : '0') +
            '"'
          : '';
      html +=
        '<div class="dienstreise-explorer-row' +
        levelClass +
        '" data-full-path="' +
        escapeHtml(e.fullPath || '') +
        '" data-is-dir="' +
        (e.isDirectory ? '1' : '0') +
        '" data-relative-path="' +
        escapeHtml(relPath) +
        '"' +
        anlageAttrs +
        '>' +
        '<div class="dienstreise-explorer-name">' +
        toggle +
        nameVisual +
        ' <span class="dienstreise-explorer-filename">' +
        escapeHtml(e.name) +
        '</span>' +
        dienstreiseAnlageOfflineBadge(e) +
        '</div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(sizeStr) + '</div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(mtimeStr) + '</div>' +
        '<div class="dienstreise-explorer-actions">' +
        protectControl +
        previewBtn +
        '<button type="button" class="btn btn-ghost" data-explorer-open title="Mit Standardprogramm bzw. Explorer öffnen">Öffnen</button>' +
        deleteBtn +
        '</div></div>';
    });
    listEl.setAttribute('data-explorer-sig', structSig);
    listEl.setAttribute('data-explorer-meta-sig', metaSig);
    listEl.innerHTML = html;
    listEl.querySelectorAll('[data-explorer-thumb]').forEach(function (img) {
      var row = img.closest('.dienstreise-explorer-row');
      var rel = row && row.getAttribute('data-relative-path');
      var fileName = row && row.querySelector('.dienstreise-explorer-filename');
      if (row && row.getAttribute('data-anlage-db') === '1') {
        var fabThumb = row.getAttribute('data-fab');
        var pnRelThumb = row.getAttribute('data-pn-rel');
        if (fabThumb && pnRelThumb) {
          loadProjekteNeuThumbnailImg(img, fabThumb, pnRelThumb, { jobId: jobId, thumbMax: 256 });
        }
      } else if (rel) {
        loadDienstreiseExplorerThumbnailImg(img, jobId, rel);
      }
      img.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!row) return;
        if (row.getAttribute('data-anlage-db') === '1') {
          openDienstreiseAnlageDbFile(row, jobId).catch(function (err) {
            showToast((err && err.message) ? err.message : 'Bild konnte nicht geladen werden.');
          });
          return;
        }
        if (!rel) return;
        openDienstreiseProjectImageInLightbox(jobId, rel, {
          alt: fileName ? fileName.textContent : '',
          listEl: listEl,
        });
      });
    });
    listEl.querySelectorAll('[data-explorer-preview]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = btn.closest('.dienstreise-explorer-row');
        var rel = row && row.getAttribute('data-relative-path');
        var fileName = row && row.querySelector('.dienstreise-explorer-filename');
        if (row && row.getAttribute('data-anlage-db') === '1') {
          openDienstreiseAnlageDbFile(row, jobId).catch(function (err) {
            showToast((err && err.message) ? err.message : 'Vorschau fehlgeschlagen.');
          });
          return;
        }
        if (!rel) return;
        openDienstreiseProjectImageInLightbox(jobId, rel, {
          alt: fileName ? fileName.textContent : '',
          listEl: listEl,
        });
      });
    });
    listEl.querySelectorAll('[data-explorer-open]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = btn.closest('.dienstreise-explorer-row');
        if (!row) return;
        if (row.getAttribute('data-anlage-db') === '1' && row.getAttribute('data-is-dir') === '0') {
          openDienstreiseAnlageDbFile(row, jobId).catch(function (err) {
            alert((err && err.message) ? err.message : 'Öffnen fehlgeschlagen.');
          });
          return;
        }
        var fullPath = row.getAttribute('data-full-path');
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
            loadDienstreiseExplorer(jobId, ui.getSubpath(), ui.key, { soft: true });
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
      cb.addEventListener('click', function (ev) {
        ev.stopPropagation();
      });
      cb.addEventListener('change', function (ev) {
        ev.stopPropagation();
        var row = cb.closest('.dienstreise-explorer-row');
        if (!row) return;
        var rel = normalizeExplorerRelPath(row.getAttribute('data-relative-path') || '');
        if (!rel) return;
        var isDir = row.getAttribute('data-is-dir') === '1';
        var checked = !!cb.checked;
        if (checked) {
          protectedSet.add(rel);
          if (isDir) {
            // sichtbare Nachkommen sofort mitnehmen (Server kaskadiert zusätzlich per FS-Walk)
            listEl.querySelectorAll('.dienstreise-explorer-row').forEach(function (r) {
              var childRel = normalizeExplorerRelPath(r.getAttribute('data-relative-path') || '');
              if (childRel && childRel.indexOf(rel + '/') === 0) protectedSet.add(childRel);
            });
          }
        } else if (isDir) {
          Array.from(protectedSet).forEach(function (p) {
            if (p === rel || p.indexOf(rel + '/') === 0) protectedSet.delete(p);
          });
        } else {
          protectedSet.delete(rel);
        }
        cb.disabled = true;
        fetch(API_BASE + '/api/dienstreise/protected_paths', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Technician-Id': String(getTechId() || ''),
          },
          body: JSON.stringify({
            job_id: jobId,
            technician_id: getTechId() || undefined,
            relative_path: rel,
            protected: checked,
            cascade: isDir
          })
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (data && data.ok && Array.isArray(data.paths)) {
              applyDienstreiseProtectedPaths(jobId, data.paths);
            } else if (data && !data.ok) {
              showToast(data.error || '„Nicht löschen“ konnte nicht gespeichert werden.');
              return loadDienstreiseProtectedPaths(jobId);
            }
          })
          .catch(function () {
            showToast('„Nicht löschen“ konnte nicht gespeichert werden.');
            return loadDienstreiseProtectedPaths(jobId);
          })
          .then(function () {
            renderDienstreiseExplorerTree(ui.key, { forceDom: true });
          });
      });
    });
    listEl.querySelectorAll('.dienstreise-explorer-row[data-is-dir="0"]').forEach(function (row) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (ev.target.closest('[data-explorer-thumb]')) return;
        if (row.getAttribute('data-anlage-db') === '1') {
          openDienstreiseAnlageDbFile(row, jobId).catch(function (err) {
            showToast((err && err.message) ? err.message : 'Datei konnte nicht geöffnet werden.');
          });
        }
      });
      row.addEventListener('contextmenu', function (ev) {
        if (ev.target.closest('.dienstreise-explorer-actions')) return;
        if (!window.monteurApp || typeof monteurApp.showFileContextMenu !== 'function') return;
        ev.preventDefault();
        var fullPath = row.getAttribute('data-full-path');
        if (!fullPath) return;
        var fileNameEl = row.querySelector('.dienstreise-explorer-filename');
        var fileName = fileNameEl ? fileNameEl.textContent.trim() : '';
        monteurApp.showFileContextMenu({ localPath: fullPath, fileName: fileName || fullPath.split(/[/\\]/).pop() || 'Datei' });
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
          renderDienstreiseExplorerTree(ui.key, { forceDom: true });
          return;
        }
        fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId) + '&subpath=' + encodeURIComponent(rel)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.entries) expandedMap[rel] = data.entries;
          renderDienstreiseExplorerTree(ui.key, { forceDom: true });
        });
      });
    });
  }

  function maybeAutoPullDienstreiseProjectFolder(jobId, uiKey) {
    var localJobId = parseInt(jobId, 10);
    if (!localJobId) return;
    if (projectFolderAutoPullInFlightByJob[localJobId]) return;
    var lastStarted = projectFolderAutoPullLastStartedAt[localJobId] || 0;
    if (Date.now() - lastStarted < PROJECT_FOLDER_AUTO_PULL_MIN_INTERVAL_MS) return;
    var dispoBaseUrl = (getDispoBaseUrl() || '').trim();
    var technicianId = getTechId();
    if (!dispoBaseUrl || !technicianId || !getDispoUsername() || !getDispoPassword()) return;
    var snap = getDienstreiseJobSnapshotByLocalId(localJobId);
    if (snap && (isJobAngelegtReadOnly(snap) || isJobAbgerechnet(snap))) return;
    if (!snap || String(snap.status || '').trim().toLowerCase() !== 'in_arbeit') return;
    projectFolderAutoPullLastStartedAt[localJobId] = Date.now();
    projectFolderAutoPullInFlightByJob[localJobId] = true;
    setConnectionBadge('online_syncing', 'Projektordner wird mit Dispo aktualisiert …');
    fetch(API_BASE + '/api/dienstreise/copy_project_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({
        job_id: localJobId,
        dispoBaseUrl: dispoBaseUrl,
        technicianId: technicianId,
        dispoUsername: getDispoUsername(),
        dispoPassword: getDispoPassword(),
        include_bilder: false,
      }, dispoBasePayloadExtra())),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok || !data.ok) {
            throw new Error((data && data.error) || 'Projektordner-Pull konnte nicht gestartet werden.');
          }
          if (!data.job_id) return null;
          return pollBackgroundJobUntilTerminal(data.job_id, null, { maxMs: 25 * 60 * 1000 });
        });
      })
      .then(function (jobRow) {
        if (jobRow && (jobRow.status === 'failed' || jobRow.status === 'interrupted')) {
          throw new Error(jobRow.error || 'Projektordner-Pull fehlgeschlagen.');
        }
        if (!jobIdsEqual(localJobId, getDienstreiseExplorerJobId(uiKey))) return;
        loadDienstreiseExplorer(localJobId, uiKey === 'start' ? startExplorerSubpath : dienstreiseExplorerSubpath, uiKey, {
          skipAutoPull: true,
          soft: true,
        });
        applySyncBadgeAfterRun([]);
      })
      .catch(function (err) {
        console.warn('[dienstreise_auto_pull]', err && err.message ? err.message : err);
        var pullErr = err && err.message ? err.message : 'Projektordner-Pull fehlgeschlagen';
        if (isLikelyDispoNetworkError(pullErr)) {
          markDispoUnreachable(pullErr);
          setConnectionBadge('offline', lastDispoOfflineReason + ' — lokale Daten verfügbar');
        }
      })
      .finally(function () {
        delete projectFolderAutoPullInFlightByJob[localJobId];
      });
  }

  function loadDienstreiseExplorer(jobId, subpath, uiKey, opts) {
    opts = opts || {};
    var ui = getDienstreiseExplorerUi(uiKey || 'modal');
    if (subpath != null && subpath !== undefined) ui.setSubpath(subpath || '');
    var requestJobId = jobId;
    var listEl = ui.getListEl();
    var breadcrumbEl = ui.getBreadcrumbEl();
    if (!listEl) return;
    if (!jobId) {
      var clearKey = ui.key === 'page' ? 'page' : ui.key;
      if (explorerSoftRefreshTimers[clearKey]) {
        clearTimeout(explorerSoftRefreshTimers[clearKey]);
        explorerSoftRefreshTimers[clearKey] = null;
      }
      listEl.removeAttribute('data-explorer-sig');
      listEl.removeAttribute('data-explorer-meta-sig');
      listEl.innerHTML =
        ui.key === 'start'
          ? '<span class="empty">Kein Auftrag ausgewählt.</span>'
          : '<span class="empty" id="dienstreiseExplorerPlaceholder">Auftrag wählen, dann Ordnerinhalt hier.</span>';
      if (breadcrumbEl) breadcrumbEl.textContent = 'Projektordner';
      ui.setRootEntries([]);
      ui.clearExpanded();
      ui.setLoadedJobId(null);
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      return;
    }

    var sameJob = jobIdsEqual(jobId, ui.getLoadedJobId());
    var soft =
      opts.soft === true ||
      (opts.soft !== false && sameJob && explorerListHasTreeRows(listEl) && !opts.forceHard);

    var seqKey = ui.key === 'page' ? 'page' : ui.key;
    if (soft && !opts.immediate) {
      if (explorerSoftRefreshTimers[seqKey]) clearTimeout(explorerSoftRefreshTimers[seqKey]);
      explorerSoftRefreshTimers[seqKey] = setTimeout(function () {
        explorerSoftRefreshTimers[seqKey] = null;
        loadDienstreiseExplorer(jobId, ui.getSubpath(), uiKey, Object.assign({}, opts, { soft: true, immediate: true }));
      }, 220);
      return;
    }

    if (!soft) {
      if (explorerSoftRefreshTimers[seqKey]) {
        clearTimeout(explorerSoftRefreshTimers[seqKey]);
        explorerSoftRefreshTimers[seqKey] = null;
      }
      listEl.removeAttribute('data-explorer-sig');
      listEl.removeAttribute('data-explorer-meta-sig');
      listEl.innerHTML = '<span class="empty">Wird geladen …</span>';
      ui.clearExpanded();
    }
    if (breadcrumbEl) {
      var crumb = ui.getSubpath() ? 'Projektordner / ' + ui.getSubpath() : 'Projektordner';
      if (breadcrumbEl.textContent !== crumb) breadcrumbEl.textContent = crumb;
    }

    if (!explorerLoadSeqByUi[seqKey]) explorerLoadSeqByUi[seqKey] = 0;
    var loadSeq = ++explorerLoadSeqByUi[seqKey];

    var filesP = fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId)).then(function (r) {
      return r.json();
    });
    var protectP = loadDienstreiseProtectedPaths(jobId);
    Promise.all([filesP, protectP])
      .then(function (results) {
        if (loadSeq !== explorerLoadSeqByUi[seqKey]) return null;
        if (!jobIdsEqual(requestJobId, getDienstreiseExplorerJobId(ui.key))) return null;
        var data = results[0];
        if (!data.ok) {
          if (!soft) {
            listEl.innerHTML = '<span class="empty">' + escapeHtml(data.error || 'Laden fehlgeschlagen.') + '</span>';
          }
          if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
          return null;
        }
        if (data.folder_missing) {
          listEl.removeAttribute('data-explorer-sig');
          listEl.removeAttribute('data-explorer-meta-sig');
          listEl.innerHTML =
            '<span class="empty">' + escapeHtml(data.hint || 'Noch kein Projektordner — bitte Auftrag annehmen.') + '</span>';
          ui.setRootEntries([]);
          ui.clearExpanded();
          ui.setLoadedJobId(jobId);
          if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
          return null;
        }
        if (!Array.isArray(data.entries)) {
          if (!soft) {
            listEl.innerHTML = '<span class="empty">Laden fehlgeschlagen.</span>';
          }
          if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
          return null;
        }
        ui.setRootEntries(data.entries);
        ui.setLoadedJobId(jobId);
        if (!soft) {
          ui.clearExpanded();
          renderDienstreiseExplorerTree(ui.key, { forceDom: true });
          if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
          if (!opts.skipAutoPull) maybeAutoPullDienstreiseProjectFolder(jobId, ui.key);
          return null;
        }
        var expanded = pruneExplorerExpandedToExisting(data.entries, ui.getExpanded());
        ui.setExpanded(expanded);
        return refreshExplorerExpandedEntries(jobId, expanded).then(function (freshExpanded) {
          if (loadSeq !== explorerLoadSeqByUi[seqKey]) return;
          if (!jobIdsEqual(requestJobId, getDienstreiseExplorerJobId(ui.key))) return;
          ui.setExpanded(pruneExplorerExpandedToExisting(ui.getRootEntries(), freshExpanded || {}));
          renderDienstreiseExplorerTree(ui.key);
          if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
          if (!opts.skipAutoPull) maybeAutoPullDienstreiseProjectFolder(jobId, ui.key);
        });
      })
      .catch(function () {
        if (loadSeq !== explorerLoadSeqByUi[seqKey]) return;
        if (!jobIdsEqual(requestJobId, getDienstreiseExplorerJobId(ui.key))) return;
        if (!soft) {
          listEl.innerHTML = '<span class="empty">Laden fehlgeschlagen.</span>';
        }
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
          (jobStatusAllowsReleaseJob(j)
            ? '<button type="button" class="btn btn-release-job" data-action="release-job">Freigeben</button>'
            : '') +
          (j.status !== 'erledigt' && String(j.status || '').toLowerCase() !== 'abgerechnet' && !isJobAngelegtReadOnly(j)
            ? '<button type="button" class="btn btn-finish-job" data-action="finish-job">' +
              '<span class="btn-finish-job-label">Erledigt</span>' +
              '<span class="btn-finish-job-progress-wrap">' +
              '<span class="btn-finish-job-progress-text"></span>' +
              '<progress class="btn-finish-job-progress" max="100" value="0"></progress>' +
              '</span></button>'
            : '') +
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
          openAcceptOfflineModal(jobId, btn);
        });
      });
      listEl.querySelectorAll('.job-actions [data-action="finish-job"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var jobId = parseInt(btn.closest('.job').getAttribute('data-job-id'), 10);
          if (!jobId) return;
          finishAndCleanup(jobId, btn);
        });
      });
      listEl.querySelectorAll('.job-actions [data-action="release-job"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var jobId = parseInt(btn.closest('.job').getAttribute('data-job-id'), 10);
          if (!jobId) return;
          releaseDienstreiseJob(jobId, btn);
        });
      });
      listEl.querySelectorAll('.job-actions [data-status]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var status = btn.getAttribute('data-status');
          var jobId = parseInt(btn.closest('.job').getAttribute('data-job-id'), 10);
          if (!jobId || status === 'erledigt') return;
          updateJobStatus(jobId, status);
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
      if (finishJobStreamBusy && finishJobActiveLocalJobId != null) {
        applyFinishJobStreamBusyUi();
        if (finishJobLastProgressRow) {
          updateFinishJobButtonProgress(finishJobLastProgressRow);
        }
      }
      restoreAcceptJobStreamFromBackgroundJobs();
      restoreFinishJobStreamFromBackgroundJobs();
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
    var localJobId = getDienstreiseExplorerJobId('modal');
    var snapUp = localJobId ? getDienstreiseJobSnapshotByLocalId(localJobId) : null;
    if (isJobAngelegtReadOnly(snapUp)) {
      var hintRo = document.getElementById('dienstreiseUploadHint');
      if (hintRo) hintRo.textContent = 'Auftrag ist angelegt – nur Anzeige.';
      return;
    }
    var subfolder = document.getElementById('dienstreiseUploadSubfolder');
    var sub = subfolder && subfolder.value ? subfolder.value : 'Dokumente_Anlage';
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
            if (localJobId) {
              if (getDienstreiseExplorerJobId('start') == localJobId) {
                loadDienstreiseExplorer(localJobId, startExplorerSubpath, 'start');
              }
              if (getDienstreiseExplorerJobId('modal') == localJobId) {
                loadDienstreiseExplorer(localJobId, dienstreiseExplorerSubpath, 'modal');
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
  })();
  (function initZeitschreibungView() {
    var btn = document.getElementById('btnViewZeitschreibung');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!getTechId()) {
          window.alert('Bitte unter Einstellungen die Monteur-ID eintragen.');
          return;
        }
        showView('zeitschreibung');
      });
    }
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
  (function initBausteineDropdown() {
    const btn = document.getElementById('btnViewBausteine');
    const dropdown = document.getElementById('bausteineDropdown');
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
  document.getElementById('btnViewArchiv').addEventListener('click', () => showView('archiv'));
  document.getElementById('btnViewAnlagenstamm').addEventListener('click', () => showView('anlagenstamm'));
  document.getElementById('btnAnlagenstammSearch').addEventListener('click', () => searchAnlagenstammList());
  var btnAnlagenstammParameterList = document.getElementById('btnAnlagenstammParameterList');
  if (btnAnlagenstammParameterList) {
    btnAnlagenstammParameterList.addEventListener('click', function () {
      var fab = (btnAnlagenstammParameterList.getAttribute('data-fab') || '').trim();
      if (!fab) return;
      loadAnlagenstammParameterFiles(fab);
    });
  }
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
      return fetchMyAssignedJobs();
    }

    async function loadJobWithAnlagenstamm(jobId) {
      const baseUrl = getDispoBaseUrl();
      const techId = getTechId();
      const headers = Object.assign(
        { 'X-Technician-Id': String(techId) },
        dispoBasicAuthHeaders(getDispoUsername, getDispoPassword),
      );
      const localUrl =
        API_BASE +
        '/api/job?id=' +
        encodeURIComponent(jobId) +
        '&technician_id=' +
        encodeURIComponent(techId) +
        '&enrich_anlagenstamm=1&enrich_local_only=1&base_url=' +
        encodeURIComponent(baseUrl || '');
      let localJob = null;
      try {
        const localRes = await fetch(localUrl, { headers: headers });
        const localData = await localRes.json().catch(function () {
          return {};
        });
        if (localRes.ok && localData.ok && localData.job) {
          localJob = localData.job;
          if (preferLocalProjekteNeuOnly() || connectionUiState === 'offline' || connectionUiState === 'local') {
            return localJob;
          }
          if (parseJobFabrikationsnummernOrdered(localJob).length > 0) {
            return localJob;
          }
        }
      } catch (e) {
        /* Dispo-Fallback */
      }
      if (baseUrl && !preferLocalProjekteNeuOnly()) {
        try {
          const liveResp = await fetch(API_BASE + '/api/job_from_dispo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId) },
            body: JSON.stringify(
              Object.assign(
                {
                  baseUrl: baseUrl,
                  jobId: jobId,
                  serverUsername: getDispoUsername(),
                  serverPassword: getDispoPassword(),
                },
                dispoBasePayloadExtra(),
              ),
            ),
          });
          const liveData = await liveResp.json().catch(function () {
            return {};
          });
          if (liveResp.ok && liveData && liveData.ok && liveData.job) {
            return liveData.job;
          }
        } catch (e) {
          /* lokaler Stand */
        }
      }
      if (localJob) {
        return localJob;
      }
      const url =
        API_BASE +
        '/api/job?id=' +
        jobId +
        '&technician_id=' +
        techId +
        '&enrich_anlagenstamm=1&base_url=' +
        encodeURIComponent(baseUrl || '');
      const r = await fetch(url, { headers: headers });
      const data = await r.json();
      if (!data || !data.job) {
        throw new Error((data && data.error) || 'Auftragsdaten konnten nicht geladen werden.');
      }
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
      var contacts = getBaustellenContactsForJob(job);
      if (contacts.length) {
        return contacts.map(function (c) { return formatJobContactDisplayName(c); }).filter(Boolean).join(', ');
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
      var leistungRows = sortLeistungRowsByFab(buildLeistungRowsFromJob(job).filter(leistungRowShowInTable));
      var geliefertUeber = '';
      k.fabrikationsnummern = leistungRows.map(function (row) {
        var gu = sanitizeLeistungField(row.geliefert_ueber);
        if (gu && !geliefertUeber) geliefertUeber = gu;
        return {
          fabrikationsnummer: sanitizeLeistungField(row.fabrikationsnummer),
          type: sanitizeLeistungField(row.type),
          position: sanitizeLeistungField(row.position),
          geliefert_ueber: gu,
          bemerkungen: ''
        };
      });
      k.geliefertUeber = geliefertUeber || (k.fabrikationsnummern[0] && k.fabrikationsnummern[0].geliefert_ueber) || '';
      var fabList = k.fabrikationsnummern.map(function (r) { return r.fabrikationsnummer; }).filter(Boolean);
      var auftragsnr = (job.job_number != null && String(job.job_number).trim()) ? String(job.job_number).trim() : '';
      kopfdatenEl.innerHTML =
        '<div class="mb-v2-kopfdaten-row"><strong>Kunde:</strong> ' + escapeHtml(k.kunde) + '</div>' +
        (auftragsnr ? '<div class="mb-v2-kopfdaten-row kopfdaten-secondary"><strong>Auftragsnr.:</strong> ' + escapeHtml(auftragsnr) + '</div>' : '') +
        '<div class="kopfdaten-fn"><strong>FN.:</strong> ' + escapeHtml(fabList.join(', ')) + '</div>' +
        (k.geliefertUeber ? '<div class="kopfdaten-secondary">' + escapeHtml(k.geliefertUeber) + '</div>' : '') +
        '<div class="mb-v2-kopfdaten-row"><strong>Datum:</strong> ' + escapeHtml(k.datum) + '</div>' +
        '<div class="mb-v2-kopfdaten-row"><strong>Servicetechniker:</strong> ' + escapeHtml(k.servicetechniker) + '</div>' +
        '<div class="mb-v2-kopfdaten-row"><strong>Ansprechperson:</strong> ' + escapeHtml(k.ansprechperson) + '</div>';
      kopfdatenEl.hidden = false;
      kopfdatenEl.removeAttribute('aria-hidden');
      return k;
    }

    function renderFabBemerkungen(fabList) {
      var html = '';
      fabList.forEach(function (f) {
        var fn = (f && (f.fabrikationsnummer ?? f.Fabrikationsnummer)) != null ? String(f.fabrikationsnummer ?? f.Fabrikationsnummer).trim() : '';
        if (fn === 'undefined') fn = '';
        var t = (f && (f.type ?? f.Type)) != null ? String(f.type ?? f.Type).trim() : '';
        var p = (f && (f.position ?? f.Position)) != null ? String(f.position ?? f.Position).trim() : '';
        html += '<div class="montagebericht-fab-block" data-fab="' + escapeHtml(fn) + '">';
        html += '<table class="montagebericht-fab-kopf">';
        html += '<tr>';
        html += '<td style="width:22%"><strong>FN.:</strong> ' + escapeHtml(fn || '–') + '</td>';
        html += '<td style="width:39%"><div class="montagebericht-fab-row-flex"><strong>Type:</strong>' +
          '<input type="text" data-mb-type="" autocomplete="off" value="' + escapeHtml(t) + '" placeholder="aus Anlagenstamm"></div></td>';
        html += '<td style="width:39%"><div class="montagebericht-fab-row-flex"><strong>Pos.Nr.:</strong>' +
          '<input type="text" data-mb-position="" autocomplete="off" value="' + escapeHtml(p) + '" placeholder="aus Anlagenstamm"></div></td>';
        html += '</tr></table>';
        html += '<div class="montagebericht-fab-body">';
        html += '<label>Bemerkungen / Textbausteine</label>';
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
      var baseUrl = (getDispoBaseUrl() || '').trim();
      try {
        var listUrl = API_BASE + '/api/textbausteine_list?technician_id=' + getTechId();
        if (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) {
          listUrl += '&local_only=1';
        } else if (baseUrl) {
          listUrl += '&base_url=' + encodeURIComponent(baseUrl);
        }
        var r = await fetch(listUrl, { headers: { 'X-Technician-Id': String(getTechId()) } });
        var data = await r.json();
        if (!data.ok || !data.categories) {
          montageberichtTbCategories = [];
          if (categorySelect) categorySelect.innerHTML = '<option value="">– Kategorie –</option>';
          listEl.innerHTML = '<span class="muted" style="font-size:0.8rem">Keine Textbausteine (lokal leer – nach Sync verfügbar)</span>';
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

    function getMontageberichtLanguages() {
      var langs = [];
      var deEl = document.getElementById('montageberichtLangDe');
      var enEl = document.getElementById('montageberichtLangEn');
      if (deEl && deEl.checked) langs.push('de');
      if (enEl && enEl.checked) langs.push('en');
      return langs;
    }

    function setMontageberichtLanguages(langsOrSingle) {
      var set = {};
      var list = Array.isArray(langsOrSingle)
        ? langsOrSingle
        : (langsOrSingle != null && String(langsOrSingle).trim() !== '' ? [langsOrSingle] : []);
      list.forEach(function (l) {
        var code = String(l || '').toLowerCase().slice(0, 2);
        if (code === 'de' || code === 'en') set[code] = true;
      });
      var deEl = document.getElementById('montageberichtLangDe');
      var enEl = document.getElementById('montageberichtLangEn');
      if (!set.de && !set.en) set.de = true;
      if (deEl) deEl.checked = !!set.de;
      if (enEl) enEl.checked = !!set.en;
    }

    function openAndResetMontageberichtForm() {
      if (divMontage) divMontage.style.display = 'block';
      try { delete window._kuklaMontageberichtSign; } catch (e) { window._kuklaMontageberichtSign = null; }
      montageberichtJobData = null;
      if (jobSelect) jobSelect.innerHTML = '<option value="">Lade…</option>';
      if (grundInput) setRichEditorHtml(grundInput, '');
      var bemerkEl = document.getElementById('montageberichtBemerkungen');
      if (bemerkEl) setRichEditorHtml(bemerkEl, '');
      setMontageberichtLanguages(['de']);
      var projEl = document.getElementById('montageberichtProjekt');
      if (projEl) projEl.value = '';
      if (kopfdatenEl) {
        kopfdatenEl.innerHTML = '';
        kopfdatenEl.hidden = true;
        kopfdatenEl.setAttribute('aria-hidden', 'true');
      }
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
          if (kopfdatenEl) {
            kopfdatenEl.innerHTML = '';
            kopfdatenEl.hidden = true;
            kopfdatenEl.setAttribute('aria-hidden', 'true');
          }
          fabContainer.innerHTML = ''; montageberichtJobData = null;
          if (grundInput) setRichEditorHtml(grundInput, '');
          var bemerkEl = document.getElementById('montageberichtBemerkungen'); if (bemerkEl) setRichEditorHtml(bemerkEl, '');
          var langEl = document.getElementById('montageberichtLangDe'); if (langEl) setMontageberichtLanguages(['de']);
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
              var langEl = document.getElementById('montageberichtLangDe');
              if (langEl || document.getElementById('montageberichtLangEn')) {
                if (Array.isArray(d.languages) && d.languages.length) setMontageberichtLanguages(d.languages);
                else if (d.language) setMontageberichtLanguages([d.language]);
              }
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
          kopfdatenEl.hidden = false;
          kopfdatenEl.removeAttribute('aria-hidden');
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
        var languages = getMontageberichtLanguages();
        if (!languages.length) {
          alert('Bitte mindestens eine Sprache auswählen (Deutsch und/oder Englisch).');
          return;
        }
        var body = {
          job_id: parseInt(jobSelect.value, 10),
          language: languages[0],
          languages: languages,
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
            else {
              var langNote = Array.isArray(data.languages) && data.languages.length > 1
                ? ' (DE + GB)'
                : (Array.isArray(data.languages) && data.languages[0] === 'en' ? ' (GB)' : ' (DE)');
              showToast('Montagebericht gespeichert (inkl. PDF & DOCX)' + langNote + '.');
            }
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
      var fabList = parseJobFabrikationsnummernOrdered(job);
      kopfdatenEl.innerHTML = '<div><strong>Kunde:</strong> ' + escapeHtml(job.customer_name || '') + '</div>' +
        '<div><strong>Projekt:</strong> ' + escapeHtml(job.job_number || job.description || '') + '</div>' +
        '<div><strong>FN:</strong> ' + escapeHtml(fabList.join(', ')) + '</div>' +
        '<div><strong>Datum:</strong> ' + escapeHtml(datum) + '</div>' +
        '<div><strong>Servicetechniker:</strong> ' + escapeHtml(techName) + '</div>';
    }

    function fillFabSelect(job) {
      var opts = ['<option value="">– aus Auftrag –</option>'];
      var fabList = parseJobFabrikationsnummernOrdered(job);
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
      var techId = getTechId();
      var headers = Object.assign(
        { 'X-Technician-Id': String(techId) },
        dispoBasicAuthHeaders(getDispoUsername, getDispoPassword),
      );
      var localUrl =
        API_BASE +
        '/api/job?id=' +
        encodeURIComponent(jobId) +
        '&technician_id=' +
        encodeURIComponent(techId) +
        '&enrich_anlagenstamm=1&enrich_local_only=1&base_url=' +
        encodeURIComponent(baseUrl || '');
      try {
        var localRes = await fetch(localUrl, { headers: headers });
        var localData = await localRes.json().catch(function () {
          return {};
        });
        if (localRes.ok && localData.ok && localData.job) {
          return localData.job;
        }
      } catch (e) {
        /* Fallback */
      }
      var url =
        API_BASE +
        '/api/job?id=' +
        jobId +
        '&technician_id=' +
        techId +
        '&enrich_anlagenstamm=1&base_url=' +
        encodeURIComponent(baseUrl || '');
      var r = await fetch(url, { headers: headers });
      var data = await r.json();
      return data.job;
    }

    async function loadKontrollwiegungJobs() {
      return fetchMyAssignedJobs();
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

  (function initProtokolleService() {
    var jobSelect = document.getElementById('serviceprotokollJob');
    var kopfdatenEl = document.getElementById('serviceprotokollKopfdaten');
    var fabHidden = document.getElementById('serviceprotokollFab');
    var fabButtonsEl = document.getElementById('serviceprotokollFabButtons');
    var fabGroupEl = document.getElementById('serviceprotokollFabGroup');
    var datumEl = document.getElementById('serviceprotokollDatum');
    var stepsContainer = document.getElementById('serviceprotokollArbeitsschritte');
    var addStepBtn = document.getElementById('serviceprotokollAddStep');
    var form = document.getElementById('serviceprotokollForm');
    var abbrechenBtn = document.getElementById('serviceprotokollAbbrechen');

    var serviceJobData = null;
    var arbeitsschritte = [];
    var lastProtokollId = null;
    var defaultsSource = 'global';
    var serviceprotokollDraftStore = { byFab: {} };
    var activeFab = '';
    var SP_LAST_JOB_KEY = 'kukla_sp_last_job_id';
    var serviceprotokollJobLoadToken = 0;
    var serviceprotokollFabLoadToken = 0;
    var serviceprotokollFormReadyFab = '';
    var serviceprotokollFabSwitching = false;
    var spSignaturePads = {};

    function initSpSignaturePad(canvasId) {
      var canvas = document.getElementById(canvasId);
      if (!canvas || spSignaturePads[canvasId]) return;
      var ctx = canvas.getContext('2d');
      var dpr = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
      function resizeCanvas() {
        var cw = canvas.clientWidth || 400;
        var ch = canvas.clientHeight || 100;
        canvas.width = Math.floor(cw * dpr);
        canvas.height = Math.floor(ch * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#111';
      }
      resizeCanvas();
      var drawing = false;
      var pad = {
        canvas: canvas,
        ctx: ctx,
        resize: resizeCanvas,
        clear: function () {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
        isEmpty: function () {
          var w = canvas.width;
          var h = canvas.height;
          if (!w || !h) return true;
          var data = ctx.getImageData(0, 0, w, h).data;
          for (var i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) return false;
          }
          return true;
        },
        toDataUrl: function () {
          return pad.isEmpty() ? '' : canvas.toDataURL('image/png');
        },
        fromDataUrl: function (url) {
          pad.clear();
          if (!url) return;
          var img = new Image();
          img.onload = function () {
            var cw = canvas.clientWidth || 400;
            var ch = canvas.clientHeight || 100;
            ctx.drawImage(img, 0, 0, cw, ch);
          };
          img.src = url;
        }
      };
      function posFromEvent(ev) {
        var rect = canvas.getBoundingClientRect();
        var clientX = ev.clientX != null ? ev.clientX : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        var clientY = ev.clientY != null ? ev.clientY : (ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0);
        return { x: clientX - rect.left, y: clientY - rect.top };
      }
      function startDraw(ev) {
        drawing = true;
        var p = posFromEvent(ev);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        if (ev.preventDefault) ev.preventDefault();
      }
      function moveDraw(ev) {
        if (!drawing) return;
        var p = posFromEvent(ev);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        if (ev.preventDefault) ev.preventDefault();
      }
      function endDraw() { drawing = false; }
      canvas.addEventListener('mousedown', startDraw);
      canvas.addEventListener('mousemove', moveDraw);
      canvas.addEventListener('mouseup', endDraw);
      canvas.addEventListener('mouseleave', endDraw);
      canvas.addEventListener('touchstart', startDraw, { passive: false });
      canvas.addEventListener('touchmove', moveDraw, { passive: false });
      canvas.addEventListener('touchend', endDraw);
      spSignaturePads[canvasId] = pad;
    }

    function clearSpSignaturePad(canvasId) {
      var pad = spSignaturePads[canvasId];
      if (pad) pad.clear();
    }

    function collectAbschlussPayload() {
      var statusEl = document.querySelector('input[name="serviceprotokollStatus"]:checked');
      var monteurEl = document.getElementById('serviceprotokollMonteur');
      return {
        status: statusEl ? String(statusEl.value || '') : '',
        bemerkungen: (document.getElementById('serviceprotokollAbschlussBemerkungen') || {}).value || '',
        monteur_id: monteurEl ? String(monteurEl.value || '') : '',
        monteur_name: monteurEl && monteurEl.selectedOptions && monteurEl.selectedOptions[0]
          ? String(monteurEl.selectedOptions[0].textContent || '').trim() : '',
        signature_monteur: (spSignaturePads.spSignatureMonteurCanvas || {}).toDataUrl
          ? spSignaturePads.spSignatureMonteurCanvas.toDataUrl() : '',
        signature_kunde: (spSignaturePads.spSignatureKundeCanvas || {}).toDataUrl
          ? spSignaturePads.spSignatureKundeCanvas.toDataUrl() : ''
      };
    }

    function applyAbschlussPayload(abschluss) {
      abschluss = abschluss || {};
      var status = String(abschluss.status || 'geprueft');
      document.querySelectorAll('input[name="serviceprotokollStatus"]').forEach(function (el) {
        el.checked = el.value === status;
      });
      var bemEl = document.getElementById('serviceprotokollAbschlussBemerkungen');
      if (bemEl) bemEl.value = abschluss.bemerkungen != null ? String(abschluss.bemerkungen) : '';
      var monteurEl = document.getElementById('serviceprotokollMonteur');
      if (monteurEl && abschluss.monteur_id) monteurEl.value = String(abschluss.monteur_id);
      if (spSignaturePads.spSignatureMonteurCanvas) {
        spSignaturePads.spSignatureMonteurCanvas.fromDataUrl(abschluss.signature_monteur || '');
      }
      if (spSignaturePads.spSignatureKundeCanvas) {
        spSignaturePads.spSignatureKundeCanvas.fromDataUrl(abschluss.signature_kunde || '');
      }
    }

    function clearAbschlussFields() {
      applyAbschlussPayload({ status: 'geprueft', bemerkungen: '', signature_monteur: '', signature_kunde: '' });
      populateServiceprotokollMonteurSelect();
    }

    function populateServiceprotokollMonteurSelect() {
      var sel = document.getElementById('serviceprotokollMonteur');
      if (!sel) return;
      var techId = getTechId();
      var techName = '';
      try {
        var tel = document.getElementById('technicianName');
        if (tel) techName = (tel.textContent || '').trim();
      } catch (e) {}
      sel.innerHTML = '';
      var opt = document.createElement('option');
      opt.value = String(techId || '');
      opt.textContent = techName || ('Monteur ' + (techId || ''));
      sel.appendChild(opt);
    }

    function updateVersSpannungHint() {
      var hint = document.getElementById('spVersSpannungHint');
      var inp = document.getElementById('spMessVersSpannung');
      if (!hint || !inp) return;
      var raw = String(inp.value || '').trim().replace(',', '.');
      if (raw === '') {
        hint.textContent = 'Sollbereich: 5,0 – 10,0 V';
        hint.className = 'sp-v2-hint is-warn';
        return;
      }
      var v = parseFloat(raw);
      if (!isFinite(v)) {
        hint.textContent = 'Sollbereich: 5,0 – 10,0 V';
        hint.className = 'sp-v2-hint is-warn';
        return;
      }
      if (v >= 5 && v <= 10) {
        hint.textContent = '✓ Sollbereich: 5,0 – 10,0 V';
        hint.className = 'sp-v2-hint is-ok';
      } else {
        hint.textContent = 'Außerhalb Sollbereich (5,0 – 10,0 V)';
        hint.className = 'sp-v2-hint is-warn';
      }
    }

    initSpSignaturePad('spSignatureMonteurCanvas');
    initSpSignaturePad('spSignatureKundeCanvas');
    populateServiceprotokollMonteurSelect();
    document.querySelectorAll('[data-sp-sig-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearSpSignaturePad(btn.getAttribute('data-sp-sig-clear') || '');
      });
    });
    var versSpEl = document.getElementById('spMessVersSpannung');
    if (versSpEl) {
      versSpEl.addEventListener('input', updateVersSpannungHint);
      versSpEl.addEventListener('change', updateVersSpannungHint);
    }
    var stickySaveBtn = document.getElementById('btnServiceprotokollStickySave');
    if (stickySaveBtn) {
      stickySaveBtn.addEventListener('click', function () {
        var btn = document.getElementById('btnServiceprotokollSaveJson');
        if (btn) btn.click();
      });
    }

    function rememberServiceprotokollJobId(jobId) {
      if (!jobId) return;
      try { localStorage.setItem(SP_LAST_JOB_KEY, String(jobId)); } catch (e) {}
    }

    function jobIdInServiceJobList(jobs, id) {
      if (id == null || id === '' || !Array.isArray(jobs)) return '';
      for (var i = 0; i < jobs.length; i++) {
        var j = jobs[i];
        if (!j) continue;
        if (j.id == id) return String(j.id);
        if (j.server_id != null && j.server_id == id) return String(j.id);
      }
      return '';
    }

    function resolveDefaultServiceprotokollJobId(jobs) {
      if (!Array.isArray(jobs) || !jobs.length) return '';
      var preferred = '';
      if (typeof getDienstreiseExplorerJobId === 'function') {
        preferred = jobIdInServiceJobList(jobs, getDienstreiseExplorerJobId());
      }
      if (!preferred && typeof startPageActiveJobId !== 'undefined' && startPageActiveJobId) {
        preferred = jobIdInServiceJobList(jobs, startPageActiveJobId);
      }
      if (!preferred) {
        try {
          preferred = jobIdInServiceJobList(jobs, new URLSearchParams(window.location.search).get('job_id'));
        } catch (e) {}
      }
      if (!preferred) {
        try { preferred = jobIdInServiceJobList(jobs, localStorage.getItem(SP_LAST_JOB_KEY)); } catch (e2) {}
      }
      if (!preferred) {
        var today = new Date().toISOString().slice(0, 10);
        var todayJobs = jobs.filter(function (j) {
          var s = (j.start_datetime || '').toString().slice(0, 10);
          var e = (j.end_datetime || '').toString().slice(0, 10);
          if (s && e) return today >= s && today <= e;
          if (s) return today === s;
          if (e) return today === e;
          return false;
        });
        if (todayJobs.length >= 1) preferred = String(todayJobs[0].id);
      }
      if (!preferred && jobs.length === 1) preferred = String(jobs[0].id);
      return preferred;
    }

    function jobHasFabrikationsnummern(job) {
      return parseJobFabrikationsnummernOrdered(job || {}).length > 0;
    }

    function setServiceprotokollJobLoading(loading) {
      if (jobSelect) jobSelect.disabled = !!loading;
    }

    function isServiceprotokollFormReadyForFab(fab) {
      fab = String(fab || '').trim();
      return fab !== '' && getActiveFab() === fab && serviceprotokollFormReadyFab === fab;
    }

    function isServiceprotokollApplyToAnlagenstammEnabled() {
      var el = document.getElementById('serviceprotokollApplyToAnlagenstamm');
      return !!(el && el.checked);
    }

    function setServiceprotokollApplyToAnlagenstamm(enabled) {
      var el = document.getElementById('serviceprotokollApplyToAnlagenstamm');
      if (el) el.checked = !!enabled;
    }

    function mergeSavedDraftIntoMemory(fab, body) {
      fab = String(fab || '').trim();
      if (!fab || !body) return;
      if (!serviceprotokollDraftStore.byFab) serviceprotokollDraftStore.byFab = {};
      var prev = serviceprotokollDraftStore.byFab[fab] || {};
      serviceprotokollDraftStore.byFab[fab] = Object.assign({}, prev, {
        fabrikationsnummer: fab,
        durchfuehrungsdatum: body.durchfuehrungsdatum || prev.durchfuehrungsdatum || '',
        projekt: body.projekt || prev.projekt || '',
        arbeitsschritte: Array.isArray(body.arbeitsschritte) ? body.arbeitsschritte : (prev.arbeitsschritte || []),
        messwerte: body.messwerte && typeof body.messwerte === 'object' ? body.messwerte : (prev.messwerte || {}),
        bemerkungen: body.bemerkungen != null ? body.bemerkungen : (prev.bemerkungen || ''),
        kopf_pos_nr: body.kopf_pos_nr != null ? body.kopf_pos_nr : (prev.kopf_pos_nr || ''),
        kopf_qmax: body.kopf_qmax != null ? body.kopf_qmax : (prev.kopf_qmax || ''),
        kopf_type: body.kopf_type != null ? body.kopf_type : (prev.kopf_type || ''),
        kopf_dwc: body.kopf_dwc != null ? body.kopf_dwc : (prev.kopf_dwc || ''),
        abschluss: body.abschluss && typeof body.abschluss === 'object' ? body.abschluss : (prev.abschluss || {}),
        updatedAt: new Date().toISOString()
      });
    }

    function isServiceprotokollFabLoadCurrent(loadToken, fab) {
      return loadToken === serviceprotokollFabLoadToken && getActiveFab() === String(fab || '').trim();
    }

    function clearServiceprotokollFabFormShell() {
      clearKopfFields();
      clearMesswerteFields();
      var projEl = document.getElementById('serviceprotokollProjekt');
      if (projEl) projEl.value = '';
      var bemEl = document.getElementById('serviceprotokollBemerkungen');
      if (bemEl) bemEl.value = '';
      clearAbschlussFields();
      arbeitsschritte = [];
      if (stepsContainer) {
        stepsContainer.innerHTML = '<tr><td colspan="5" class="muted" style="padding:0.75rem;text-align:center">Fabrikationsnummer wird geladen …</td></tr>';
      }
    }

    function anlagenstammRowToKopfAndMess(row) {
      if (!row) return { kopf: {}, mess: null };
      return {
        kopf: {
          kopf_pos_nr: row.position != null ? String(row.position).trim() : '',
          kopf_qmax: row.leistung != null ? String(row.leistung).trim() : '',
          kopf_type: row.type != null ? String(row.type).trim() : '',
          kopf_dwc: row.elektronik != null ? String(row.elektronik).trim() : '',
          projekt: row.projekt != null ? String(row.projekt).trim() : '',
        },
        mess: {
          mess_waegezelle_type: row.kraftaufnehmer != null ? String(row.kraftaufnehmer).trim() : '',
          mess_waegezelle_seriennummer: row.dms_nr != null ? String(row.dms_nr).trim() : '',
        },
      };
    }

    function getActiveFab() {
      if (activeFab) return activeFab;
      return fabHidden && fabHidden.value ? fabHidden.value.trim() : '';
    }

    function setActiveFabValue(fab) {
      activeFab = fab ? String(fab).trim() : '';
      if (fabHidden) fabHidden.value = activeFab;
    }

    function collectArbeitsschrittePayload() {
      syncStepsFromDom();
      return arbeitsschritte.map(function (s, i) {
        var de = (s.bezeichnung_de || '').trim();
        var en = (s.bezeichnung_en || '').trim();
        return {
          sort_order: i + 1,
          bezeichnung_de: de,
          bezeichnung_en: en,
          bezeichnung: combineBilingualLabel(de, en),
          status: s.status || 'na',
          bemerkung: s.bemerkung || ''
        };
      });
    }

    function draftPayloadFromCache(fab, cached) {
      return {
        fabrikationsnummer: fab,
        durchfuehrungsdatum: cached.durchfuehrungsdatum || '',
        projekt: String(cached.projekt || '').trim() || (serviceJobData ? resolveServiceprotokollProjekt(serviceJobData, fab) : ''),
        arbeitsschritte: Array.isArray(cached.arbeitsschritte) ? cached.arbeitsschritte : [],
        messwerte: cached.messwerte || {},
        bemerkungen: cached.bemerkungen || '',
        kopf_pos_nr: cached.kopf_pos_nr || '',
        kopf_qmax: cached.kopf_qmax || '',
        kopf_type: cached.kopf_type || '',
        kopf_dwc: cached.kopf_dwc || '',
        abschluss: cached.abschluss || { status: 'geprueft' }
      };
    }

    function collectDraftPayloadForFab(fab) {
      fab = String(fab || '').trim();
      var cached = serviceprotokollDraftStore.byFab && serviceprotokollDraftStore.byFab[fab];
      if (!isServiceprotokollFormReadyForFab(fab) || getActiveFab() !== fab) {
        if (cached) return draftPayloadFromCache(fab, cached);
        var jobKopf = kopfFromJobFabRow(serviceJobData, fab);
        return {
          fabrikationsnummer: fab,
          durchfuehrungsdatum: datumEl ? datumEl.value.trim() : '',
          projekt: serviceJobData ? resolveServiceprotokollProjekt(serviceJobData, fab) : (jobKopf.projekt || ''),
          arbeitsschritte: [],
          messwerte: {},
          bemerkungen: '',
          kopf_pos_nr: jobKopf.kopf_pos_nr || '',
          kopf_qmax: jobKopf.kopf_qmax || '',
          kopf_type: jobKopf.kopf_type || '',
          kopf_dwc: jobKopf.kopf_dwc || '',
          abschluss: { status: 'geprueft' }
        };
      }
      var projektVal = (document.getElementById('serviceprotokollProjekt') || {}).value || '';
      projektVal = String(projektVal).trim();
      if (!projektVal && serviceJobData) {
        projektVal = resolveServiceprotokollProjekt(serviceJobData, fab);
      }
      return {
        fabrikationsnummer: fab,
        durchfuehrungsdatum: datumEl ? datumEl.value.trim() : '',
        projekt: projektVal,
        arbeitsschritte: collectArbeitsschrittePayload(),
        messwerte: collectMesswerte(),
        bemerkungen: (document.getElementById('serviceprotokollBemerkungen') || {}).value || '',
        kopf_pos_nr: (document.getElementById('serviceprotokollPos') || {}).value || '',
        kopf_qmax: (document.getElementById('serviceprotokollQmax') || {}).value || '',
        kopf_type: (document.getElementById('serviceprotokollType') || {}).value || '',
        kopf_dwc: (document.getElementById('serviceprotokollDwc') || {}).value || '',
        abschluss: collectAbschlussPayload()
      };
    }

    function stashDraftInMemory(fab, opts) {
      opts = opts || {};
      if (!fab) return;
      fab = String(fab).trim();
      if (!opts.force && !isServiceprotokollFormReadyForFab(fab)) return;
      if (getActiveFab() !== fab) return;
      var payload = collectDraftPayloadForFab(fab);
      if (!serviceprotokollDraftStore.byFab) serviceprotokollDraftStore.byFab = {};
      serviceprotokollDraftStore.byFab[fab] = Object.assign({}, payload, { updatedAt: new Date().toISOString() });
    }

    async function persistDraftJsonForFab(fab, opts) {
      opts = opts || {};
      if (!fab || !jobSelect || !jobSelect.value || !serviceJobData) return;
      fab = String(fab).trim();
      if (!opts.skipStash && isServiceprotokollFormReadyForFab(fab)) {
        stashDraftInMemory(fab);
      }
      if (!opts.skipAnlagenstamm && isServiceprotokollApplyToAnlagenstammEnabled() && isServiceprotokollFormReadyForFab(fab)) {
        try {
          await persistServiceprotokollMesswerteToAnlagenstamm(fab);
        } catch (e) { /* optional bei FN-Wechsel */ }
      }
      var cached = serviceprotokollDraftStore.byFab && serviceprotokollDraftStore.byFab[fab];
      if (!opts.payloadSnapshot && !isServiceprotokollFormReadyForFab(fab) && !cached) return;
      var payload = opts.payloadSnapshot || collectDraftPayloadForFab(fab);
      if (!payload.projekt) return;
      var body = {
        technician_id: getTechId(),
        job_id: parseInt(jobSelect.value, 10),
        fabrikationsnummer: fab,
        durchfuehrungsdatum: payload.durchfuehrungsdatum,
        arbeitsschritte: payload.arbeitsschritte,
        messwerte: payload.messwerte,
        projekt: payload.projekt,
        bemerkungen: payload.bemerkungen,
        kopf_pos_nr: payload.kopf_pos_nr,
        kopf_qmax: payload.kopf_qmax,
        kopf_type: payload.kopf_type,
        kopf_dwc: payload.kopf_dwc,
        apply_to_anlagenstamm: isServiceprotokollApplyToAnlagenstammEnabled() || undefined,
        jsonOnly: true,
        skip_dispo_sync: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) || undefined,
        base_url: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) ? undefined : getDispoBaseUrl(),
        dispoBaseUrl: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) ? undefined : getDispoBaseUrl(),
        serverUsername: getDispoUsername(),
        serverPassword: getDispoPassword()
      };
      var persistPromise = fetch(API_BASE + '/api/protokolle/serviceprotokoll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify(body)
      }).catch(function () { /* optional bei FN-Wechsel */ });
      if (opts.background) return;
      await persistPromise;
    }

    function renderFabButtonsActive() {
      if (!fabButtonsEl) return;
      var cur = getActiveFab();
      fabButtonsEl.querySelectorAll('.sp-fab-btn').forEach(function (btn) {
        btn.classList.toggle('is-active', btn.getAttribute('data-fab') === cur);
      });
    }

    async function buildAllProtokollPayloads() {
      var cur = getActiveFab();
      if (cur) {
        stashDraftInMemory(cur);
        await persistDraftJsonForFab(cur);
      }
      var fns = parseJobFabrikationsnummernOrdered(serviceJobData || {});
      if (!fns.length) return { error: 'Keine Fabrikationsnummern im Auftrag.' };
      var missing = [];
      var protokolle = [];
      fns.forEach(function (fn) {
        var draft = serviceprotokollDraftStore.byFab && serviceprotokollDraftStore.byFab[fn];
        var steps = Array.isArray(draft && draft.arbeitsschritte) ? draft.arbeitsschritte : [];
        var hasStep = steps.some(function (s) {
          var de = (s.bezeichnung_de != null ? s.bezeichnung_de : (s.bezeichnung || '')).trim();
          var en = (s.bezeichnung_en || '').trim();
          return de !== '' || en !== '';
        });
        if (!hasStep) {
          missing.push(fn);
          return;
        }
        var proj = String((draft && draft.projekt) || '').trim() || resolveServiceprotokollProjekt(serviceJobData, fn);
        if (!proj) {
          missing.push(fn + ' (Projekt)');
          return;
        }
        protokolle.push({
          fabrikationsnummer: fn,
          projekt: proj,
          arbeitsschritte: steps,
          messwerte: (draft && draft.messwerte) || {},
          bemerkungen: (draft && draft.bemerkungen) || '',
          kopf_pos_nr: (draft && draft.kopf_pos_nr) || '',
          kopf_qmax: (draft && draft.kopf_qmax) || '',
          kopf_type: (draft && draft.kopf_type) || '',
          kopf_dwc: (draft && draft.kopf_dwc) || '',
          abschluss: (draft && draft.abschluss) || (fn === cur ? collectAbschlussPayload() : { status: 'geprueft' })
        });
      });
      if (missing.length) {
        return { error: 'Bitte alle Fabrikationsnummern ausfüllen: ' + missing.join(', ') };
      }
      return { protokolle: protokolle };
    }

    function updateAllPdfButtonVisibility(job) {
      var allPdfBtn = document.getElementById('btnServiceprotokollSaveAllPdf');
      if (!allPdfBtn) return;
      var fns = job ? parseJobFabrikationsnummernOrdered(job) : [];
      allPdfBtn.style.display = fns.length >= 2 ? 'inline-block' : 'none';
    }

    function renderFabButtons(job) {
      if (!fabButtonsEl) return;
      var fns = job ? parseJobFabrikationsnummernOrdered(job) : [];
      if (fabGroupEl) fabGroupEl.style.display = fns.length ? 'block' : 'none';
      updateAllPdfButtonVisibility(job);
      fabButtonsEl.innerHTML = '';
      if (!fns.length) {
        setActiveFabValue('');
        return;
      }
      fns.forEach(function (fn) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost sp-fab-btn' + (fn === getActiveFab() ? ' is-active' : '');
        btn.setAttribute('data-fab', fn);
        btn.textContent = fn;
        btn.addEventListener('click', function () {
          switchServiceprotokollFab(fn);
        });
        fabButtonsEl.appendChild(btn);
      });
    }

    async function switchServiceprotokollFab(newFab) {
      newFab = newFab ? String(newFab).trim() : '';
      if (!newFab) return;
      var cur = getActiveFab();
      if (cur === newFab) return;
      var loadToken = ++serviceprotokollFabLoadToken;
      serviceprotokollFabSwitching = true;
      var persistSnapshot = null;
      if (cur) {
        if (isServiceprotokollFormReadyForFab(cur)) {
          stashDraftInMemory(cur);
          if (serviceprotokollDraftStore.byFab && serviceprotokollDraftStore.byFab[cur]) {
            var snapCandidate = serviceprotokollDraftStore.byFab[cur];
            if (isMeaningfulServiceprotokollDraft(snapCandidate)) {
              persistSnapshot = Object.assign({}, snapCandidate);
            }
          }
        }
        if (persistSnapshot) {
          persistDraftJsonForFab(cur, {
            skipAnlagenstamm: true,
            background: true,
            payloadSnapshot: persistSnapshot
          });
        }
      }
      serviceprotokollFormReadyFab = '';
      setActiveFabValue(newFab);
      renderFabButtonsActive();
      clearServiceprotokollFabFormShell();
      try {
        await loadDefaultsForFab(newFab, loadToken);
      } finally {
        if (loadToken === serviceprotokollFabLoadToken) {
          serviceprotokollFabSwitching = false;
          notifyReactBridge(true);
        }
      }
    }

    function applyServiceprotokollDraft(fab) {
      if (!fab || !serviceprotokollDraftStore.byFab) return false;
      var draft = serviceprotokollDraftStore.byFab[fab];
      if (!draft || !isMeaningfulServiceprotokollDraft(draft)) return false;
      if (draft.durchfuehrungsdatum && datumEl) datumEl.value = draft.durchfuehrungsdatum;
      if (draft.projekt) {
        var projEl = document.getElementById('serviceprotokollProjekt');
        if (projEl) projEl.value = draft.projekt;
      }
      applyKopfFields({
        kopf_pos_nr: draft.kopf_pos_nr || '',
        kopf_qmax: draft.kopf_qmax || '',
        kopf_type: draft.kopf_type || '',
        kopf_dwc: draft.kopf_dwc || ''
      });
      var bemEl = document.getElementById('serviceprotokollBemerkungen');
      if (bemEl && draft.bemerkungen != null) bemEl.value = draft.bemerkungen;
      var mess = draft.messwerte || {};
      var messMap = [
        ['spMessType', mess.waegezelle_type],
        ['spMessSeriennummer', mess.waegezelle_seriennummer],
        ['spMessVersSpannung', mess.vers_spannung]
      ];
      messMap.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el && pair[1] != null) el.value = pair[1];
      });
      applyPgTestToForm(normalizePgTestCells(mess));
      applyMessMatrixToForm(normalizeMessMatrix(mess));
      updateVersSpannungHint();
      if (draft.abschluss) applyAbschlussPayload(draft.abschluss);
      if (Array.isArray(draft.arbeitsschritte) && draft.arbeitsschritte.length > 0) {
        arbeitsschritte = draft.arbeitsschritte.map(function (row) {
          return stepFromRaw(row);
        });
        renderSteps();
      }
      return true;
    }

    async function loadServiceprotokollDraftsForJob(jobId) {
      serviceprotokollDraftStore = { byFab: {} };
      if (!jobId) return;
      try {
        var r = await fetch(API_BASE + '/api/protokolle/serviceprotokoll?job_id=' + encodeURIComponent(jobId), {
          headers: { 'X-Technician-Id': String(getTechId()) }
        });
        var data = await r.json().catch(function () { return {}; });
        if (r.ok && data.ok && data.store && data.store.byFab) {
          serviceprotokollDraftStore = data.store;
        }
      } catch (e) { /* optional */ }
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

    function renderKopfdatenService(job) {
      /* Kopfdaten (Kunde, FN, Zeitraum, Monteur) nur im PDF – nicht im Formular anzeigen. */
      void job;
    }

    function readProjektFromFabRow(r) {
      if (r == null) return '';
      if (typeof r === 'object') {
        var v = r.projekt != null ? r.projekt : (r.Projekt != null ? r.Projekt : (r.project != null ? r.project : ''));
        return String(v).replace(/\s+/g, ' ').trim();
      }
      return '';
    }

    function resolveServiceprotokollProjekt(job, fab) {
      if (!job || !job.fabrikationsnummern) return '';
      try {
        var parsed = JSON.parse(job.fabrikationsnummern);
        if (!Array.isArray(parsed) || parsed.length === 0) return '';
        if (fab) {
          for (var i = 0; i < parsed.length; i++) {
            var rowFn = (parsed[i] && parsed[i].fabrikationsnummer) ? String(parsed[i].fabrikationsnummer).trim() : '';
            if (rowFn === fab) return readProjektFromFabRow(parsed[i]);
          }
        }
        var projs = parsed.map(readProjektFromFabRow).filter(function (p) { return p !== ''; });
        if (!projs.length) return '';
        var first = projs[0];
        for (var j = 1; j < projs.length; j++) {
          if (projs[j] !== first) return '';
        }
        return first;
      } catch (e) {
        return '';
      }
    }

    function applyServiceprotokollProjekt(job, fab, kopfProjekt) {
      var projEl = document.getElementById('serviceprotokollProjekt');
      if (!projEl) return;
      var fromKopf = kopfProjekt != null ? String(kopfProjekt).trim() : '';
      if (fromKopf) {
        projEl.value = fromKopf;
        return;
      }
      projEl.value = resolveServiceprotokollProjekt(job, fab);
    }

    function applyKopfFields(kopf) {
      kopf = kopf || {};
      var pos = document.getElementById('serviceprotokollPos');
      var qmax = document.getElementById('serviceprotokollQmax');
      var type = document.getElementById('serviceprotokollType');
      var dwc = document.getElementById('serviceprotokollDwc');
      if (pos) pos.value = kopf.kopf_pos_nr || '';
      if (qmax) qmax.value = kopf.kopf_qmax || '';
      if (type) type.value = kopf.kopf_type || '';
      if (dwc) dwc.value = kopf.kopf_dwc || '';
    }

    function readKopfFieldsFromForm() {
      var projEl = document.getElementById('serviceprotokollProjekt');
      return {
        kopf_pos_nr: (document.getElementById('serviceprotokollPos') || {}).value || '',
        kopf_qmax: (document.getElementById('serviceprotokollQmax') || {}).value || '',
        kopf_type: (document.getElementById('serviceprotokollType') || {}).value || '',
        kopf_dwc: (document.getElementById('serviceprotokollDwc') || {}).value || '',
        projekt: projEl ? (projEl.value || '') : ''
      };
    }

    function mergeKopfFillGaps(currentKopf, fillKopf) {
      currentKopf = currentKopf || {};
      fillKopf = fillKopf || {};
      var out = {};
      ['kopf_pos_nr', 'kopf_qmax', 'kopf_type', 'kopf_dwc', 'projekt'].forEach(function (k) {
        var cur = currentKopf[k] != null ? String(currentKopf[k]).trim() : '';
        var fill = fillKopf[k] != null ? String(fillKopf[k]).trim() : '';
        out[k] = cur || fill || '';
      });
      return out;
    }

    function isMeaningfulServiceprotokollDraft(draft) {
      if (!draft || typeof draft !== 'object') return false;
      var kopfKeys = ['kopf_pos_nr', 'kopf_qmax', 'kopf_type', 'kopf_dwc'];
      for (var i = 0; i < kopfKeys.length; i++) {
        if (String(draft[kopfKeys[i]] || '').trim()) return true;
      }
      if (String(draft.bemerkungen || '').trim()) return true;
      var steps = Array.isArray(draft.arbeitsschritte) ? draft.arbeitsschritte : [];
      for (var j = 0; j < steps.length; j++) {
        var s = steps[j] || {};
        if (s.status && s.status !== 'na') return true;
        if (String(s.bemerkung || '').trim()) return true;
      }
      var mess = draft.messwerte;
      if (mess && typeof mess === 'object') {
        if (String(mess.waegezelle_type || '').trim()) return true;
        if (String(mess.waegezelle_seriennummer || '').trim()) return true;
        if (String(mess.vers_spannung || '').trim()) return true;
      }
      return false;
    }

    function clearKopfFields() {
      applyKopfFields({});
    }

    var SP_MESS_PGTEST_IDS = [
      'spMessPgTest1', 'spMessPgTest2', 'spMessPgTest3', 'spMessPgTest4'
    ];
    var SP_MESS_FIELD_IDS = [
      'spMessType', 'spMessSeriennummer', 'spMessVersSpannung',
      'spMessDmsKg', 'spMessDmsMv', 'spMessDmsMa', 'spMessDmsG',
      'spMessTaraKg', 'spMessTaraMv', 'spMessTaraMa', 'spMessTaraG',
      'spMessPgKg', 'spMessPgMv', 'spMessPgMa', 'spMessPgG'
    ].concat(SP_MESS_PGTEST_IDS);
    var SP_MESS_ROW_FORM = [
      { key: 'dms', prefix: 'spMessDms' },
      { key: 'tara', prefix: 'spMessTara' },
      { key: 'pruefgewicht', prefix: 'spMessPg' }
    ];

    function normalizePgTestCells(mess) {
      mess = mess || {};
      var raw = mess.pruefgewichtstest;
      if (Array.isArray(raw)) {
        return SP_MESS_PGTEST_IDS.map(function (_, i) {
          return raw[i] != null ? String(raw[i]) : '';
        });
      }
      var legacy = mess.taraspeicher != null ? String(mess.taraspeicher) : '';
      return [legacy, '', '', ''];
    }

    function applyPgTestToForm(cells) {
      SP_MESS_PGTEST_IDS.forEach(function (id, i) {
        var el = document.getElementById(id);
        if (el) el.value = (cells && cells[i] != null) ? String(cells[i]) : '';
      });
    }

    function collectPgTestFromForm() {
      return SP_MESS_PGTEST_IDS.map(function (id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
      });
    }

    function emptyMessRow() {
      return { kg: '', mv: '', ma: '', g_prozent: '' };
    }

    function normalizeMessMatrix(mess) {
      mess = mess || {};
      if (mess.mess_matrix && typeof mess.mess_matrix === 'object') {
        var mm = mess.mess_matrix;
        return {
          dms: Object.assign(emptyMessRow(), mm.dms || {}),
          tara: Object.assign(emptyMessRow(), mm.tara || {}),
          pruefgewicht: Object.assign(emptyMessRow(), mm.pruefgewicht || {})
        };
      }
      var gPct = mess.g_prozent != null ? String(mess.g_prozent) : '';
      return {
        dms: {
          kg: '',
          mv: mess.dms_entlastet != null ? String(mess.dms_entlastet) : '',
          ma: mess.ma != null ? String(mess.ma) : '',
          g_prozent: ''
        },
        tara: {
          kg: '',
          mv: mess.tara != null ? String(mess.tara) : '',
          ma: '',
          g_prozent: gPct
        },
        pruefgewicht: {
          kg: mess.kg != null ? String(mess.kg) : '',
          mv: mess.pruefgewicht != null ? String(mess.pruefgewicht) : (mess.mv != null ? String(mess.mv) : ''),
          ma: '',
          g_prozent: gPct
        }
      };
    }

    function applyMessMatrixToForm(matrix) {
      SP_MESS_ROW_FORM.forEach(function (cfg) {
        var row = (matrix && matrix[cfg.key]) || emptyMessRow();
        var fields = ['kg', 'mv', 'ma', 'g_prozent'];
        var suffixes = ['Kg', 'Mv', 'Ma', 'G'];
        for (var i = 0; i < fields.length; i++) {
          var el = document.getElementById(cfg.prefix + suffixes[i]);
          if (el) el.value = row[fields[i]] != null ? row[fields[i]] : '';
        }
      });
    }

    function collectMessMatrixFromForm() {
      var matrix = {};
      SP_MESS_ROW_FORM.forEach(function (cfg) {
        matrix[cfg.key] = {
          kg: (document.getElementById(cfg.prefix + 'Kg') || {}).value || '',
          mv: (document.getElementById(cfg.prefix + 'Mv') || {}).value || '',
          ma: (document.getElementById(cfg.prefix + 'Ma') || {}).value || '',
          g_prozent: (document.getElementById(cfg.prefix + 'G') || {}).value || ''
        };
      });
      return matrix;
    }

    function messwerteLegacyFromMatrix(matrix) {
      var d = matrix.dms || emptyMessRow();
      var t = matrix.tara || emptyMessRow();
      var p = matrix.pruefgewicht || emptyMessRow();
      return {
        dms_entlastet: d.mv || '',
        tara: t.mv || '',
        pruefgewicht: p.mv || '',
        kg: p.kg || '',
        mv: p.mv || d.mv || '',
        ma: d.ma || p.ma || '',
        g_prozent: p.g_prozent || t.g_prozent || ''
      };
    }

    function clearMesswerteFields() {
      SP_MESS_FIELD_IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
    }

    function messSeriennummerFromStamm(apiKopf, jobKopf) {
      var sn = (apiKopf && apiKopf.mess_waegezelle_seriennummer != null) ? String(apiKopf.mess_waegezelle_seriennummer).trim() : '';
      if (!sn && apiKopf && apiKopf.dms_nr != null) sn = String(apiKopf.dms_nr).trim();
      if (!sn && jobKopf && jobKopf.dms_nr != null) sn = String(jobKopf.dms_nr).trim();
      return sn;
    }

    function messTypeFromStamm(apiKopf, jobKopf) {
      var v = (apiKopf && apiKopf.mess_waegezelle_type != null) ? String(apiKopf.mess_waegezelle_type).trim() : '';
      if (!v && jobKopf && jobKopf.kraftaufnehmer) v = String(jobKopf.kraftaufnehmer).trim();
      return v;
    }

    function applyMessTypeFromStamm(apiKopf, jobKopf) {
      var typeEl = document.getElementById('spMessType');
      if (typeEl && !(typeEl.value || '').trim()) {
        typeEl.value = messTypeFromStamm(apiKopf, jobKopf);
      }
      var snEl = document.getElementById('spMessSeriennummer');
      if (snEl && !(snEl.value || '').trim()) {
        snEl.value = messSeriennummerFromStamm(apiKopf, jobKopf);
      }
    }

    function lookupAnlagenstammRowForFab(fab) {
      fab = String(fab || '').trim();
      if (!fab) return Promise.resolve(null);
      return fetch(API_BASE + '/api/anlagenstamm_lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify({ fab: fab, local_only: 1 })
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          if (data && data.ok && data.row) return data.row;
          return null;
        })
        .catch(function () { return null; });
    }

    function patchServiceJobFabStammFields(fab, fields) {
      if (!serviceJobData || !serviceJobData.fabrikationsnummern || !fields) return;
      try {
        var parsed = JSON.parse(serviceJobData.fabrikationsnummern);
        if (!Array.isArray(parsed)) return;
        var fabKey = String(fab || '').trim();
        var touched = false;
        for (var i = 0; i < parsed.length; i++) {
          if (String(parsed[i].fabrikationsnummer || '').trim() !== fabKey) continue;
          if (fields.kraftaufnehmer) parsed[i].kraftaufnehmer = fields.kraftaufnehmer;
          if (fields.dms_nr) parsed[i].dms_nr = fields.dms_nr;
          if (fields.elektronik) parsed[i].elektronik = fields.elektronik;
          touched = true;
        }
        if (touched) {
          serviceJobData = Object.assign({}, serviceJobData, { fabrikationsnummern: JSON.stringify(parsed) });
        }
      } catch (e) { /* ignore */ }
    }

    async function persistServiceprotokollMesswerteToAnlagenstamm(fab) {
      fab = String(fab || '').trim();
      if (!fab || !isServiceprotokollApplyToAnlagenstammEnabled()) return;
      var typeVal = sanitizeLeistungField((document.getElementById('spMessType') || {}).value);
      var snVal = sanitizeLeistungField((document.getElementById('spMessSeriennummer') || {}).value);
      var dwcVal = sanitizeLeistungField((document.getElementById('serviceprotokollDwc') || {}).value);
      if (!typeVal && !snVal && !dwcVal) return;
      var existing = await lookupAnlagenstammRowForFab(fab);
      var payload = Object.assign({
        baseUrl: getDispoBaseUrl(),
        serverUsername: getServerUsername(),
        serverPassword: getServerPassword(),
        id: existing && existing.id ? parseInt(existing.id, 10) : 0,
        fabrikationsnummer: fab
      }, dispoBasePayloadExtra());
      if (typeVal) payload.kraftaufnehmer = typeVal;
      if (snVal) payload.dms_nr = snVal;
      if (dwcVal) payload.elektronik = dwcVal;
      await anlagenstammSaveDispo(payload);
      patchServiceJobFabStammFields(fab, {
        kraftaufnehmer: typeVal || (existing && existing.kraftaufnehmer) || '',
        dms_nr: snVal || (existing && existing.dms_nr) || '',
        elektronik: dwcVal || (existing && existing.elektronik) || ''
      });
      mergeAnlagenstammFieldsIntoOpenJob(fab, {
        kraftaufnehmer: payload.kraftaufnehmer || '',
        dms_nr: payload.dms_nr || '',
        elektronik: payload.elektronik || ''
      });
    }

    async function applyAnlagenstammFelderFromLocalStamm(fab, opts) {
      opts = opts || {};
      var loadToken = opts.loadToken;
      var row = await lookupAnlagenstammRowForFab(fab);
      if (loadToken != null && !isServiceprotokollFabLoadCurrent(loadToken, fab)) return;
      if (!row) return;
      var mapped = anlagenstammRowToKopfAndMess(row);
      var jobKopf = kopfFromJobFabRow(serviceJobData, fab);
      var fromStamm = mergeServiceprotokollKopf(mapped.kopf, jobKopf);
      var merged = opts.preferStamm
        ? mergeKopfFillGaps(fromStamm, readKopfFieldsFromForm())
        : mergeKopfFillGaps(readKopfFieldsFromForm(), fromStamm);
      applyKopfFields(merged);
      applyServiceprotokollProjekt(serviceJobData, fab, merged.projekt);
      if (opts.preferStamm) {
        var typeEl = document.getElementById('spMessType');
        var snEl = document.getElementById('spMessSeriennummer');
        var typeVal = messTypeFromStamm(mapped.mess, jobKopf);
        var snVal = messSeriennummerFromStamm(mapped.mess, jobKopf);
        if (typeEl) typeEl.value = typeVal;
        if (snEl) snEl.value = snVal;
        updateVersSpannungHint();
      } else {
        applyMessTypeFromStamm(mapped.mess, jobKopf);
      }
    }

    function kopfFromJobFabRow(job, fab) {
      if (!job || !job.fabrikationsnummern || !fab) return {};
      try {
        var parsed = JSON.parse(job.fabrikationsnummern);
        if (!Array.isArray(parsed)) return {};
        for (var i = 0; i < parsed.length; i++) {
          var row = parsed[i];
          var rowFn = (row && row.fabrikationsnummer) ? String(row.fabrikationsnummer).trim() : '';
          if (rowFn !== fab) continue;
          return {
            kopf_pos_nr: row.position != null ? String(row.position).trim() : '',
            kopf_qmax: row.leistung != null ? String(row.leistung).trim() : '',
            kopf_type: row.type != null ? String(row.type).trim() : '',
            kopf_dwc: row.elektronik != null ? String(row.elektronik).trim() : '',
            kraftaufnehmer: row.kraftaufnehmer != null ? String(row.kraftaufnehmer).trim() : '',
            dms_nr: row.dms_nr != null ? String(row.dms_nr).trim() : '',
            projekt: readProjektFromFabRow(row)
          };
        }
      } catch (e) {}
      return {};
    }

    function builtinServiceprotokollSteps() {
      return [
        'Kontrolle der Wägebrücke / check of weighing bridge',
        'Kontrolle des Fördergurtes / check of conveyor belt',
        'Reinigen der Waage / cleaning of the scale',
        'Kontr. der Rollen & Rollenflucht / check of rollers & roller aligment',
        'Zustand der Bandabstreifer / condition of belt scrapers',
        'Trommelkratzer / drum scraper',
        'Abstreifpflug / scraper plough',
        'Bandspannung / belt tensioning',
        'Bandlenkung / belt steering device',
        'Schmierstellen / lubrication points',
        'Kraftaufnehmer / load cell',
        'Tacho / tacho',
        'Schieflaufschalter / belt misalignment switch',
        'Kettentriebe / chain drives',
        'Überlastschutz / overload protection',
        'Wiegeelektronik / weighing electronics',
        'Tara / tare',
        'PGW-Test / test with test weight',
        'Regelung & Dosierung / control & dosing',
        'Kontrollwiegungen / check weighing procedures',
        'Kontrolle der Zellenradschleuse / check of rotary vane feeder'
      ].map(function (bez) {
        var parts = splitBilingualLabel(bez);
        return { bezeichnung_de: parts.de, bezeichnung_en: parts.en, status: 'na', bemerkung: '' };
      });
    }

    function splitBilingualLabel(bez) {
      var s = String(bez || '').trim();
      var m = s.match(/^(.+?)\s\/\s+(.+)$/);
      if (m) return { de: m[1].trim(), en: m[2].trim() };
      m = s.match(/^(.+?)\/\s+(.+)$/);
      if (m) return { de: m[1].trim(), en: m[2].trim() };
      return { de: s, en: '' };
    }

    function combineBilingualLabel(de, en) {
      de = String(de || '').trim();
      en = String(en || '').trim();
      if (!de) return en;
      if (!en) return de;
      return de + ' / ' + en;
    }

    function stepFromRaw(row) {
      row = row || {};
      var de = row.bezeichnung_de != null ? String(row.bezeichnung_de).trim() : '';
      var en = row.bezeichnung_en != null ? String(row.bezeichnung_en).trim() : '';
      if (!de && !en && row.bezeichnung) {
        var parts = splitBilingualLabel(row.bezeichnung);
        de = parts.de;
        en = parts.en;
      }
      return {
        bezeichnung_de: de,
        bezeichnung_en: en,
        status: row.status || 'na',
        bemerkung: row.bemerkung || ''
      };
    }

    function collectPdfLanguages() {
      var deEl = document.getElementById('spPdfDe');
      var enEl = document.getElementById('spPdfEn');
      var langs = [];
      if (!deEl || deEl.checked) langs.push('de');
      if (enEl && enEl.checked) langs.push('en');
      return langs.length ? langs : ['de'];
    }

    function mergeServiceprotokollKopf(apiKopf, jobKopf) {
      var kopf = {};
      ['kopf_pos_nr', 'kopf_qmax', 'kopf_type', 'kopf_dwc', 'projekt'].forEach(function (k) {
        var v = (apiKopf && apiKopf[k] != null) ? String(apiKopf[k]).trim() : '';
        if (!v && jobKopf && jobKopf[k]) v = String(jobKopf[k]).trim();
        if (v) kopf[k] = v;
      });
      return kopf;
    }

    function mapDefaultsToSteps(rows) {
      return rows.map(function (row) {
        return stepFromRaw({ bezeichnung: row.bezeichnung || '', status: 'na', bemerkung: '' });
      });
    }

    function buildStepRowHtml(idx) {
      var s = arbeitsschritte[idx] || { bezeichnung_de: '', bezeichnung_en: '', status: 'na', bemerkung: '' };
      var status = s.status || 'na';
      var rowClass = 'serviceprotokoll-step sp-step-row sp-step-' + status;
      var textCell = '<input type="text" class="sp-bezeichnung-de sp-step-label-input" value="' + escapeHtml(s.bezeichnung_de || '') + '" placeholder="Arbeitsschritt">' +
        '<input type="hidden" class="sp-bezeichnung-en" value="' + escapeHtml(s.bezeichnung_en || '') + '">';
      return '<tr class="' + rowClass + '" data-idx="' + idx + '" data-status="' + escapeHtml(status) + '">' +
        '<td class="sp-col-nr">' + (idx + 1) + '</td>' +
        '<td class="sp-col-status"><div class="sp-status-group" role="group" aria-label="Ergebnis Schritt ' + (idx + 1) + '">' +
        '<button type="button" class="btn btn-ghost sp-status' + (status === 'ok' ? ' is-active' : '') + '" data-status="ok">OK</button>' +
        '<button type="button" class="btn btn-ghost sp-status' + (status === 'nok' ? ' is-active' : '') + '" data-status="nok">n.i.O.</button>' +
        '<button type="button" class="btn btn-ghost sp-status' + (status === 'na' ? ' is-active' : '') + '" data-status="na">n.a.</button>' +
        '</div></td>' +
        '<td class="sp-col-text">' + textCell + '</td>' +
        '<td class="sp-col-bem"><input type="text" class="sp-bemerkung" value="' + escapeHtml(s.bemerkung || '') + '" placeholder="optional"></td>' +
        '<td class="sp-col-act"><button type="button" class="btn btn-ghost sp-remove" title="Zeile löschen" aria-label="Zeile löschen"><img class="sp-v2-icon" src="icons/x-delete-green.svg" alt="" aria-hidden="true"></button></td></tr>';
    }

    function syncStepsFromDom() {
      if (!stepsContainer) return;
      var rows = stepsContainer.querySelectorAll('.serviceprotokoll-step');
      var next = [];
      rows.forEach(function (rowEl, i) {
        var deEl = rowEl.querySelector('.sp-bezeichnung-de');
        var enEl = rowEl.querySelector('.sp-bezeichnung-en');
        var prev = arbeitsschritte[i] || {};
        var de = deEl ? (deEl.value || '').trim() : '';
        var en = enEl ? (enEl.value || '').trim() : (prev.bezeichnung_en || '');
        next.push({
          bezeichnung_de: de,
          bezeichnung_en: en,
          status: rowEl.getAttribute('data-status') || 'na',
          bemerkung: (rowEl.querySelector('.sp-bemerkung') || {}).value || '',
          sort_order: i + 1
        });
      });
      arbeitsschritte = next.length ? next : [{ bezeichnung_de: '', bezeichnung_en: '', status: 'na', bemerkung: '' }];
    }

    function renderSteps() {
      if (!stepsContainer) return;
      if (!arbeitsschritte.length) {
        stepsContainer.innerHTML = '<tr><td colspan="5" class="muted" style="padding:0.75rem;text-align:center">FN wählen, um Arbeitsschritte zu laden.</td></tr>';
        return;
      }
      stepsContainer.innerHTML = arbeitsschritte.map(function (_, i) { return buildStepRowHtml(i); }).join('');
      stepsContainer.querySelectorAll('.serviceprotokoll-step').forEach(function (rowEl) {
        var idx = parseInt(rowEl.getAttribute('data-idx'), 10);
        rowEl.querySelectorAll('.sp-status').forEach(function (btn) {
          btn.addEventListener('click', function () {
            syncStepsFromDom();
            arbeitsschritte[idx].status = btn.getAttribute('data-status') || 'na';
            renderSteps();
          });
        });
        var up = rowEl.querySelector('.sp-up');
        var down = rowEl.querySelector('.sp-down');
        var rem = rowEl.querySelector('.sp-remove');
        if (up) up.addEventListener('click', function () {
          syncStepsFromDom();
          if (idx <= 0) return;
          var tmp = arbeitsschritte[idx - 1];
          arbeitsschritte[idx - 1] = arbeitsschritte[idx];
          arbeitsschritte[idx] = tmp;
          renderSteps();
        });
        if (down) down.addEventListener('click', function () {
          syncStepsFromDom();
          if (idx >= arbeitsschritte.length - 1) return;
          var tmp = arbeitsschritte[idx + 1];
          arbeitsschritte[idx + 1] = arbeitsschritte[idx];
          arbeitsschritte[idx] = tmp;
          renderSteps();
        });
        if (rem) rem.addEventListener('click', function () {
          syncStepsFromDom();
          arbeitsschritte.splice(idx, 1);
          if (arbeitsschritte.length === 0) arbeitsschritte.push({ bezeichnung_de: '', bezeichnung_en: '', status: 'na', bemerkung: '' });
          renderSteps();
        });
      });
    }

    async function resetArbeitsschritteToDefaults() {
      var fab = getActiveFab();
      if (!fab) {
        alert('Bitte Fabrikationsnummer wählen.');
        return;
      }
      var techId = getTechId();
      var q = 'fabrikationsnummer=' + encodeURIComponent(fab) + '&technician_id=' + encodeURIComponent(techId) + '&local_only=1';
      try {
        var r = await fetch(API_BASE + '/api/serviceprotokoll_defaults?' + q, {
          headers: { 'X-Technician-Id': String(techId) }
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok || !data.ok) throw new Error(data.error || 'Defaults konnten nicht geladen werden.');
        if (Array.isArray(data.arbeitsschritte) && data.arbeitsschritte.length > 0) {
          defaultsSource = data.source || 'global';
          arbeitsschritte = mapDefaultsToSteps(data.arbeitsschritte);
        } else {
          defaultsSource = 'builtin';
          arbeitsschritte = builtinServiceprotokollSteps();
        }
        renderSteps();
        if (isServiceprotokollFormReadyForFab(fab)) stashDraftInMemory(fab);
        notifyReactBridge(true);
      } catch (e) {
        alert((e && e.message) ? e.message : 'Liste konnte nicht zurückgesetzt werden.');
      }
    }

    async function loadDefaultsForFab(fab, loadToken) {
      fab = fab ? String(fab).trim() : '';
      if (loadToken == null) loadToken = ++serviceprotokollFabLoadToken;
      serviceprotokollFormReadyFab = '';
      if (!fab) {
        if (!isServiceprotokollFabLoadCurrent(loadToken, fab)) return;
        arbeitsschritte = builtinServiceprotokollSteps();
        renderSteps();
        return;
      }
      clearKopfFields();
      clearMesswerteFields();
      if (!isServiceprotokollFabLoadCurrent(loadToken, fab)) return;
      var jobKopf = kopfFromJobFabRow(serviceJobData, fab);
      var draftApplied = applyServiceprotokollDraft(fab);
      if (!draftApplied) {
        arbeitsschritte = builtinServiceprotokollSteps();
      }
      var mergedJobKopf = mergeKopfFillGaps(readKopfFieldsFromForm(), mergeServiceprotokollKopf(null, jobKopf));
      applyKopfFields(mergedJobKopf);
      applyServiceprotokollProjekt(serviceJobData, fab, mergedJobKopf.projekt);
      if (!draftApplied) {
        applyMessTypeFromStamm(null, jobKopf);
      }
      renderSteps();

      await applyAnlagenstammFelderFromLocalStamm(fab, {
        loadToken: loadToken,
        preferStamm: !draftApplied
      });
      if (!isServiceprotokollFabLoadCurrent(loadToken, fab)) return;

      var techId = getTechId();
      var q = 'fabrikationsnummer=' + encodeURIComponent(fab) + '&technician_id=' + encodeURIComponent(techId) + '&local_only=1';
      try {
        var r = await fetch(API_BASE + '/api/serviceprotokoll_defaults?' + q, {
          headers: { 'X-Technician-Id': String(techId) }
        });
        if (!isServiceprotokollFabLoadCurrent(loadToken, fab)) return;
        var data = await r.json().catch(function () { return {}; });
        var apiKopfRaw = data && data.ok ? data.kopf : null;
        if (r.ok && data.ok) {
          if (!draftApplied) {
            if (Array.isArray(data.arbeitsschritte) && data.arbeitsschritte.length > 0) {
              defaultsSource = data.source || 'global';
              arbeitsschritte = mapDefaultsToSteps(data.arbeitsschritte);
            } else {
              defaultsSource = 'builtin';
            }
          }
          var mergedKopf = mergeKopfFillGaps(
            readKopfFieldsFromForm(),
            mergeServiceprotokollKopf(apiKopfRaw, jobKopf)
          );
          applyKopfFields(mergedKopf);
          applyServiceprotokollProjekt(serviceJobData, fab, mergedKopf.projekt);
          applyMessTypeFromStamm(apiKopfRaw, jobKopf);
        } else if (!draftApplied) {
          defaultsSource = 'builtin';
        }
      } catch (e) {
        if (!draftApplied) defaultsSource = 'builtin';
      }
      if (!isServiceprotokollFabLoadCurrent(loadToken, fab)) return;
      renderSteps();
      if (isServiceprotokollFabLoadCurrent(loadToken, fab)) {
        serviceprotokollFormReadyFab = fab;
      }
      if (!serviceprotokollFabSwitching) {
        notifyReactBridge();
      }
    }

    function collectMesswerte() {
      var matrix = collectMessMatrixFromForm();
      var legacy = messwerteLegacyFromMatrix(matrix);
      return Object.assign({
        waegezelle_type: (document.getElementById('spMessType') || {}).value || '',
        waegezelle_seriennummer: (document.getElementById('spMessSeriennummer') || {}).value || '',
        vers_spannung: (document.getElementById('spMessVersSpannung') || {}).value || '',
        pruefgewichtstest: collectPgTestFromForm(),
        mess_matrix: matrix
      }, legacy);
    }

    async function loadServiceJobWithAnlagenstamm(jobId) {
      var techId = getTechId();
      var headers = Object.assign({ 'X-Technician-Id': String(techId) }, dispoBasicAuthHeaders(getDispoUsername, getDispoPassword));
      var jobUrl = API_BASE + '/api/job?id=' + encodeURIComponent(jobId) + '&technician_id=' + encodeURIComponent(techId) +
        '&enrich_anlagenstamm=1&enrich_local_only=1';
      try {
        var localRes = await fetch(jobUrl, { headers: headers });
        var localData = await localRes.json().catch(function () { return {}; });
        if (localRes.ok && localData.ok && localData.job) {
          return localData.job;
        }
      } catch (e) { /* Fallback */ }
      var url = API_BASE + '/api/job?id=' + jobId + '&technician_id=' + techId;
      var r = await fetch(url, { headers: headers });
      var data = await r.json();
      return data.job;
    }

    async function applyServiceprotokollJobSelection(id) {
      var loadToken = ++serviceprotokollJobLoadToken;
      serviceprotokollFormReadyFab = '';
      serviceJobData = null;
      setActiveFabValue('');
      if (!id) {
        if (kopfdatenEl) {
        kopfdatenEl.innerHTML = '';
        kopfdatenEl.hidden = true;
        kopfdatenEl.setAttribute('aria-hidden', 'true');
      }
        renderFabButtons(null);
        updateAllPdfButtonVisibility(null);
        var projClear = document.getElementById('serviceprotokollProjekt');
        if (projClear) projClear.value = '';
        arbeitsschritte = [];
        if (stepsContainer) stepsContainer.innerHTML = '<tr><td colspan="5" class="muted" style="padding:0.75rem;text-align:center">Auftrag wählen, um Arbeitsschritte zu laden.</td></tr>';
        return;
      }
      setServiceprotokollJobLoading(true);
      try {
        var jobPromise = loadServiceJobWithAnlagenstamm(id);
        var draftsPromise = loadServiceprotokollDraftsForJob(id);
        var job = await jobPromise;
        await draftsPromise;
        if (loadToken !== serviceprotokollJobLoadToken) return;
        serviceJobData = job;
        rememberServiceprotokollJobId(id);
        if (serviceJobData) renderKopfdatenService(serviceJobData);
        renderFabButtons(serviceJobData);
        var fns = parseJobFabrikationsnummernOrdered(serviceJobData || {});
        var firstFab = fns.length ? fns[0] : '';
        if (firstFab) {
          var fabLoadToken = ++serviceprotokollFabLoadToken;
          setActiveFabValue(firstFab);
          renderFabButtonsActive();
          await loadDefaultsForFab(firstFab, fabLoadToken);
        }
      } catch (e) {
        if (loadToken === serviceprotokollJobLoadToken) {
          alert('Auftrag konnte nicht geladen werden.');
        }
      } finally {
        if (loadToken === serviceprotokollJobLoadToken) setServiceprotokollJobLoading(false);
        if (loadToken === serviceprotokollJobLoadToken) notifyReactBridge();
      }
    }

    async function loadServiceJobs() {
      return fetchMyAssignedJobs();
    }

    if (addStepBtn) {
      addStepBtn.addEventListener('click', function () {
        openSpStepPickerModal();
      });
    }

    if (jobSelect) {
      jobSelect.addEventListener('change', function () {
        applyServiceprotokollJobSelection(jobSelect.value || '');
      });
    }

    if (form) {
      form.addEventListener('input', function () {
        var fab = getActiveFab();
        if (isServiceprotokollFormReadyForFab(fab)) stashDraftInMemory(fab);
      });
      form.addEventListener('change', function () {
        var fab = getActiveFab();
        if (isServiceprotokollFormReadyForFab(fab)) stashDraftInMemory(fab);
      });
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var submitBtn = e.submitter;
        var jsonOnly = !!(submitBtn && submitBtn.id === 'btnServiceprotokollSaveJson');
        if (!submitBtn || (submitBtn.id !== 'btnServiceprotokollSaveJson' && submitBtn.id !== 'btnServiceprotokollSavePdf')) {
          return;
        }
        if (!serviceJobData) { alert('Bitte Auftrag wählen.'); return; }
        var fab = getActiveFab();
        if (!fab) { alert('Bitte Fabrikationsnummer wählen.'); return; }
        var datum = (datumEl && datumEl.value) ? datumEl.value.trim() : '';
        if (!jsonOnly && !datum) { alert('Bitte Datum angeben.'); return; }
        var projektVal = (document.getElementById('serviceprotokollProjekt') && document.getElementById('serviceprotokollProjekt').value) ? document.getElementById('serviceprotokollProjekt').value.trim() : '';
        if (!projektVal) { alert('Bitte das Feld „Projekt“ ausfüllen (Anlagenstamm / manuell).'); return; }
        syncStepsFromDom();
        var stepsPayload = collectArbeitsschrittePayload().filter(function (s) { return s.bezeichnung_de !== '' || s.bezeichnung_en !== ''; });
        if (!jsonOnly && stepsPayload.length === 0) { alert('Mindestens ein Arbeitsschritt mit Bezeichnung erforderlich.'); return; }
        var pdfLangs = jsonOnly ? [] : collectPdfLanguages();
        if (!jsonOnly && !pdfLangs.length) { alert('Bitte mindestens eine PDF-Sprache wählen (DE und/oder EN).'); return; }
        var body = {
          technician_id: getTechId(),
          job_id: parseInt(jobSelect.value, 10),
          fabrikationsnummer: fab,
          durchfuehrungsdatum: datum,
          arbeitsschritte: stepsPayload,
          messwerte: collectMesswerte(),
          projekt: projektVal,
          bemerkungen: (document.getElementById('serviceprotokollBemerkungen') || {}).value || '',
          kopf_pos_nr: (document.getElementById('serviceprotokollPos') || {}).value || '',
          kopf_qmax: (document.getElementById('serviceprotokollQmax') || {}).value || '',
          kopf_type: (document.getElementById('serviceprotokollType') || {}).value || '',
          kopf_dwc: (document.getElementById('serviceprotokollDwc') || {}).value || '',
          abschluss: collectAbschlussPayload(),
          apply_to_anlagenstamm: isServiceprotokollApplyToAnlagenstammEnabled() || undefined,
          jsonOnly: jsonOnly,
          local_only: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) || undefined,
          skip_dispo_sync: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) || undefined,
          base_url: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) ? undefined : getDispoBaseUrl(),
          dispoBaseUrl: (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) ? undefined : getDispoBaseUrl(),
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        };
        if (!jsonOnly) body.pdf_languages = pdfLangs;
        var submitButtons = form.querySelectorAll('button[type="submit"]');
        submitButtons.forEach(function (b) { b.disabled = true; });
        try {
          stashDraftInMemory(fab);
          var r = await fetch(API_BASE + '/api/protokolle/serviceprotokoll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
            body: JSON.stringify(body)
          });
          var data = await r.json().catch(function () { return {}; });
          if (!r.ok || !data.ok) {
            alert('Fehler: ' + (data.error || r.status));
            return;
          }
          if (data.warning) console.warn('[Serviceprotokoll]', data.warning);
          mergeSavedDraftIntoMemory(fab, body);
          loadServiceprotokollDraftsForJob(body.job_id).catch(function () { /* Hintergrund-Sync */ });
          if (getActiveFab() === fab) {
            serviceprotokollFormReadyFab = fab;
          }
          if (data.jsonOnly) {
            if (typeof showToast === 'function') showToast('Zwischenstand gespeichert (serviceprotokoll.json).');
          } else {
            lastProtokollId = data.protokoll_id != null ? data.protokoll_id : null;
            if (typeof showToast === 'function') {
              var msg = 'PDF erstellt – Sie können das Formular weiter bearbeiten und erneut „PDF erstellen“ wählen.';
              if (data.saved && data.saved.length) msg += ' (' + data.saved.join(', ') + ')';
              showToast(msg);
            }
          }
        } catch (err) {
          alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt'));
        } finally {
          submitButtons.forEach(function (b) { b.disabled = false; });
        }
      });
    }

    var allPdfBtn = document.getElementById('btnServiceprotokollSaveAllPdf');
    if (allPdfBtn) {
      allPdfBtn.addEventListener('click', async function () {
        if (!serviceJobData || !jobSelect || !jobSelect.value) {
          alert('Bitte Auftrag wählen.');
          return;
        }
        var datum = (datumEl && datumEl.value) ? datumEl.value.trim() : '';
        if (!datum) { alert('Bitte Datum angeben.'); return; }
        var pdfLangs = collectPdfLanguages();
        if (!pdfLangs.length) { alert('Bitte mindestens eine PDF-Sprache wählen (DE und/oder EN).'); return; }
        var built = await buildAllProtokollPayloads();
        if (built.error) { alert(built.error); return; }
        var body = {
          technician_id: getTechId(),
          job_id: parseInt(jobSelect.value, 10),
          durchfuehrungsdatum: datum,
          protokolle: built.protokolle,
          pdf_languages: pdfLangs,
          apply_to_anlagenstamm: isServiceprotokollApplyToAnlagenstammEnabled() || undefined,
          base_url: getDispoBaseUrl(),
          dispoBaseUrl: getDispoBaseUrl(),
          serverUsername: getDispoUsername(),
          serverPassword: getDispoPassword()
        };
        allPdfBtn.disabled = true;
        try {
          var curFab = getActiveFab();
          if (curFab) {
            try {
              await persistServiceprotokollMesswerteToAnlagenstamm(curFab);
            } catch (persistErr) {
              console.warn('[Serviceprotokoll] Anlagenstamm Kraftaufnehmer/DMS/DWC:', persistErr);
            }
          }
          var r = await fetch(API_BASE + '/api/protokolle/serviceprotokoll/all-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
            body: JSON.stringify(body)
          });
          var data = await r.json().catch(function () { return {}; });
          if (!r.ok || !data.ok) {
            alert('Fehler: ' + (data.error || r.status));
            return;
          }
          if (data.warning) console.warn('[Serviceprotokoll]', data.warning);
          await loadServiceprotokollDraftsForJob(body.job_id);
          if (typeof showToast === 'function') {
            var savedCount = data.saved && data.saved.length ? data.saved.length : 0;
            var expectedCount = built.protokolle.length * (pdfLangs.length || 1);
            var toastMsg = savedCount + ' PDF-Datei(en) lokal gespeichert (je FN im zugehörigen Ordner).';
            if (savedCount < expectedCount) {
              toastMsg += ' Erwartet: ' + expectedCount + '.';
            }
            if (data.saved && data.saved.length) toastMsg += ' ' + data.saved.join(', ');
            showToast(toastMsg);
          }
        } catch (err) {
          alert('Fehler: ' + (err && err.message ? err.message : 'Unbekannt'));
        } finally {
          allPdfBtn.disabled = false;
        }
      });
    }

    function spIsoToDisplay(iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
      if (!m) return String(iso || '');
      return m[3] + '.' + m[2] + '.' + m[1];
    }

    function spDisplayToIso(display) {
      var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(display || '').trim());
      if (!m) return String(display || '');
      return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }

    function spCollectJobOptions() {
      if (!jobSelect) return [];
      var out = [];
      for (var i = 0; i < jobSelect.options.length; i++) {
        var opt = jobSelect.options[i];
        if (!opt || !opt.value) continue;
        out.push({ id: String(opt.value), label: String(opt.textContent || '').trim() });
      }
      return out;
    }

    function spPullPayloadForReact() {
      syncStepsFromDom();
      var matrix = collectMessMatrixFromForm();
      var pgTest = collectPgTestFromForm();
      var statusEl = document.querySelector('input[name="serviceprotokollStatus"]:checked');
      var monteurEl = document.getElementById('serviceprotokollMonteur');
      var jobOpt = jobSelect && jobSelect.selectedOptions && jobSelect.selectedOptions[0];
      var monteurLabel = '';
      if (monteurEl && monteurEl.selectedOptions && monteurEl.selectedOptions[0]) {
        monteurLabel = String(monteurEl.selectedOptions[0].textContent || '').trim();
      }
      return {
        jobId: jobSelect ? String(jobSelect.value || '') : '',
        jobs: spCollectJobOptions(),
        fabNumbers: parseJobFabrikationsnummernOrdered(serviceJobData || {}),
        form: {
          order: jobOpt ? String(jobOpt.textContent || '').trim() : '',
          project: (document.getElementById('serviceprotokollProjekt') || {}).value || '',
          date: spIsoToDisplay(datumEl ? datumEl.value : ''),
          activeFab: getActiveFab(),
          plantType: (document.getElementById('serviceprotokollType') || {}).value || '',
          qmax: (document.getElementById('serviceprotokollQmax') || {}).value || '',
          qmaxUnit: 't/h',
          position: (document.getElementById('serviceprotokollPos') || {}).value || '',
          dwc: (document.getElementById('serviceprotokollDwc') || {}).value || '',
          loadcellType: (document.getElementById('spMessType') || {}).value || '',
          serialNumber: (document.getElementById('spMessSeriennummer') || {}).value || '',
          supplyVoltage: (document.getElementById('spMessVersSpannung') || {}).value || '',
          generalRemarks: (document.getElementById('serviceprotokollBemerkungen') || {}).value || '',
          status: statusEl ? String(statusEl.value || 'geprueft') : 'geprueft',
          monteur: monteurLabel,
          closingRemarks: (document.getElementById('serviceprotokollAbschlussBemerkungen') || {}).value || '',
          pdfDe: !!(document.getElementById('spPdfDe') && document.getElementById('spPdfDe').checked),
          pdfEn: !!(document.getElementById('spPdfEn') && document.getElementById('spPdfEn').checked),
          applyToAnlagenstamm: isServiceprotokollApplyToAnlagenstammEnabled()
        },
        measurements: [
          { id: 'dms', label: 'DMS entlastet / released', kg: matrix.dms.kg, mv: matrix.dms.mv, ma: matrix.dms.ma, g: matrix.dms.g_prozent },
          { id: 'tara', label: 'Tara / tare', kg: matrix.tara.kg, mv: matrix.tara.mv, ma: matrix.tara.ma, g: matrix.tara.g_prozent },
          { id: 'pg', label: 'Prüfgewicht / test load', kg: matrix.pruefgewicht.kg, mv: matrix.pruefgewicht.mv, ma: matrix.pruefgewicht.ma, g: matrix.pruefgewicht.g_prozent }
        ],
        testLoad: {
          weight: pgTest[0] || '',
          display: pgTest[1] || '',
          deviation: pgTest[2] || '',
          value4: pgTest[3] || ''
        },
        workSteps: arbeitsschritte.map(function (s, i) {
          return {
            id: String(i + 1),
            label: String(s.bezeichnung_de || s.bezeichnung || '').trim(),
            result: (s.status === 'ok' || s.status === 'nok' || s.status === 'na') ? s.status : 'na',
            remark: String(s.bemerkung || '')
          };
        })
      };
    }

    function spApplyPayloadFromReact(payload) {
      if (serviceprotokollFabSwitching) return;
      if (!payload || !payload.form) return;
      var f = payload.form;
      var setVal = function (id, val) {
        var el = document.getElementById(id);
        if (el && val != null) el.value = String(val);
      };
      setVal('serviceprotokollProjekt', f.project);
      if (datumEl) datumEl.value = spDisplayToIso(f.date);
      setVal('serviceprotokollType', f.plantType);
      setVal('serviceprotokollQmax', f.qmax);
      setVal('serviceprotokollPos', f.position);
      setVal('serviceprotokollDwc', f.dwc);
      setVal('spMessType', f.loadcellType);
      setVal('spMessSeriennummer', f.serialNumber);
      setVal('spMessVersSpannung', f.supplyVoltage);
      setVal('serviceprotokollBemerkungen', f.generalRemarks);
      setVal('serviceprotokollAbschlussBemerkungen', f.closingRemarks);
      var pdfDe = document.getElementById('spPdfDe');
      var pdfEn = document.getElementById('spPdfEn');
      if (pdfDe) pdfDe.checked = !!f.pdfDe;
      if (pdfEn) pdfEn.checked = !!f.pdfEn;
      setServiceprotokollApplyToAnlagenstamm(!!f.applyToAnlagenstamm);
      document.querySelectorAll('input[name="serviceprotokollStatus"]').forEach(function (el) {
        el.checked = el.value === (f.status || 'geprueft');
      });
      if (Array.isArray(payload.measurements) && payload.measurements.length) {
        var mm = {
          dms: { kg: payload.measurements[0].kg || '', mv: payload.measurements[0].mv || '', ma: payload.measurements[0].ma || '', g_prozent: payload.measurements[0].g || '' },
          tara: { kg: payload.measurements[1].kg || '', mv: payload.measurements[1].mv || '', ma: payload.measurements[1].ma || '', g_prozent: payload.measurements[1].g || '' },
          pruefgewicht: { kg: payload.measurements[2].kg || '', mv: payload.measurements[2].mv || '', ma: payload.measurements[2].ma || '', g_prozent: payload.measurements[2].g || '' }
        };
        applyMessMatrixToForm(mm);
      }
      if (payload.testLoad) {
        var tl = payload.testLoad;
        applyPgTestToForm([tl.weight || '', tl.display || '', tl.deviation || '', tl.value4 || '']);
      }
      if (Array.isArray(payload.workSteps)) {
        arbeitsschritte = payload.workSteps.map(function (s) {
          return {
            bezeichnung_de: String(s.label || ''),
            bezeichnung_en: '',
            status: s.result || 'na',
            bemerkung: String(s.remark || '')
          };
        });
        if (!arbeitsschritte.length) {
          arbeitsschritte = [{ bezeichnung_de: '', bezeichnung_en: '', status: 'na', bemerkung: '' }];
        }
        renderSteps();
      }
      if (f.activeFab && f.activeFab !== getActiveFab()) {
        setActiveFabValue(f.activeFab);
        renderFabButtonsActive();
      }
      updateVersSpannungHint();
    }

    function notifyReactBridge(forceSync) {
      if (typeof window.serviceprotokollReactBridge !== 'undefined' &&
          window.serviceprotokollReactBridge &&
          typeof window.serviceprotokollReactBridge.syncToReact === 'function') {
        window.serviceprotokollReactBridge.syncToReact(!!forceSync);
      }
    }

    window.serviceprotokollBridge = {
      pullPayload: spPullPayloadForReact,
      applyPayload: spApplyPayloadFromReact,
      selectJob: function (jobId) {
        if (!jobSelect || !jobId) return;
        jobSelect.value = jobId;
        applyServiceprotokollJobSelection(jobId).then(function () {
          notifyReactBridge();
        });
      },
      selectFab: function (fab) {
        return switchServiceprotokollFab(fab);
      },
      triggerAction: function (action) {
        if (action === 'cancel') {
          if (abbrechenBtn) abbrechenBtn.click();
          return;
        }
        if (action === 'stickySave' && stickySaveBtn) {
          stickySaveBtn.click();
          return;
        }
        if (action === 'saveJson') {
          var jsonBtn = document.getElementById('btnServiceprotokollSaveJson');
          if (jsonBtn) jsonBtn.click();
          return;
        }
        if (action === 'pdf') {
          var pdfBtn = document.getElementById('btnServiceprotokollSavePdf');
          if (pdfBtn) pdfBtn.click();
          return;
        }
        if (action === 'pdfAll') {
          var allBtn = document.getElementById('btnServiceprotokollSaveAllPdf');
          if (allBtn) allBtn.click();
          return;
        }
        if (action === 'openStepPicker') {
          openSpStepPickerModal();
          return;
        }
        if (action === 'resetWorkSteps') {
          resetArbeitsschritteToDefaults();
        }
      }
    };

    var spCatalogCache = [];
    var spCatalogPresetsCache = [];
    var spCatalogPickKeys = {};
    var spActivePresetStepKeys = {};

    function spCatalogStepKey(scope, id) {
      return String(scope || 'global') + ':' + id;
    }

    function labelOfCatalogStep(s) {
      return s.bezeichnung || combineBilingualLabel(s.bezeichnung_de, s.bezeichnung_en);
    }

    function findMatchingPresetForSp(presets, anlagenType) {
      var haystack = (anlagenType || '').trim();
      if (!haystack) return null;
      var hayLower = haystack.toLowerCase();
      var candidates = [];
      (presets || []).forEach(function (p) {
        var code = (p.type_code || '').trim();
        if (!code || hayLower.indexOf(code.toLowerCase()) < 0) return;
        candidates.push({
          preset: p,
          codeLen: code.length,
          priority: (p.scope || 'user') === 'global' ? 1 : 0,
          sortOrder: p.sort_order || 0,
          id: p.id || 0
        });
      });
      if (!candidates.length) return null;
      candidates.sort(function (a, b) {
        if (b.codeLen !== a.codeLen) return b.codeLen - a.codeLen;
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.id - b.id;
      });
      return candidates[0].preset;
    }

    function buildPresetStepKeySet(preset) {
      var keys = {};
      ((preset && preset.step_refs) || []).forEach(function (r) {
        keys[spCatalogStepKey(r.step_scope || 'global', r.step_id)] = true;
      });
      return keys;
    }

    function resolveSpActivePresetStepKeys() {
      var typeEl = document.getElementById('serviceprotokollType');
      var anlagenType = typeEl ? typeEl.value : '';
      var preset = findMatchingPresetForSp(spCatalogPresetsCache, anlagenType);
      return buildPresetStepKeySet(preset);
    }

    function isCatalogStepInProtocol(s) {
      var label = String(labelOfCatalogStep(s)).toLowerCase();
      return currentStepLabels().indexOf(label) >= 0;
    }

    function isCatalogStepInActivePreset(s) {
      return !!spActivePresetStepKeys[spCatalogStepKey(s.scope, s.id)];
    }

    function filterAvailableSpCatalogSteps(steps) {
      return (steps || []).filter(function (s) {
        return !isCatalogStepInProtocol(s) && !isCatalogStepInActivePreset(s);
      });
    }

    function hideSpCatalogNewStepPanel() {
      var panel = document.getElementById('spCatalogNewStepPanel');
      if (panel) panel.style.display = 'none';
      var de = document.getElementById('spCatalogStepDe');
      var en = document.getElementById('spCatalogStepEn');
      if (de) de.value = '';
      if (en) en.value = '';
    }

    function renderSpCatalogList() {
      var listEl = document.getElementById('spCatalogList');
      if (!listEl) return;
      var available = filterAvailableSpCatalogSteps(spCatalogCache);
      if (!available.length) {
        listEl.innerHTML = '<p class="muted" style="padding:0.75rem">Keine weiteren Schritte verfügbar (bereits im Protokoll oder im Typ-Preset enthalten).</p>';
        return;
      }
      listEl.innerHTML = available.map(function (s) {
        var k = spCatalogStepKey(s.scope, s.id);
        var checked = spCatalogPickKeys[k] ? ' checked' : '';
        var global = s.scope === 'global';
        return '<div class="as-row" data-cat-key="' + escapeHtml(k) + '">'
          + '<span class="as-drag" aria-hidden="true" style="visibility:hidden">≡</span>'
          + '<input type="checkbox" class="as-row-check sp-catalog-check"' + checked + ' data-cat-key="' + escapeHtml(k) + '">'
          + '<div class="as-row-main"><strong>' + escapeHtml(s.bezeichnung_de || splitBilingualLabel(s.bezeichnung || '').de) + '</strong>'
          + ((s.bezeichnung_en || splitBilingualLabel(s.bezeichnung || '').en) ? ' <span class="muted">/ ' + escapeHtml(s.bezeichnung_en || splitBilingualLabel(s.bezeichnung || '').en) + '</span>' : '')
          + (global ? ' <span class="muted">(global)</span>' : '') + '</div></div>';
      }).join('');
      listEl.querySelectorAll('.sp-catalog-check').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var key = cb.getAttribute('data-cat-key');
          if (cb.checked) spCatalogPickKeys[key] = true;
          else delete spCatalogPickKeys[key];
        });
      });
    }

    function closeSpStepPickerModal() {
      var modal = document.getElementById('modalSpCatalog');
      if (modal) modal.classList.remove('active');
      hideSpCatalogNewStepPanel();
      spCatalogPickKeys = {};
    }

    async function openSpStepPickerModal() {
      try {
        syncStepsFromDom();
        spCatalogPickKeys = {};
        hideSpCatalogNewStepPanel();
        await loadSpCatalogData();
        spActivePresetStepKeys = resolveSpActivePresetStepKeys();
        renderSpCatalogList();
        var modal = document.getElementById('modalSpCatalog');
        if (modal) modal.classList.add('active');
      } catch (e) {
        alert('Katalog konnte nicht geladen werden: ' + (e && e.message ? e.message : e));
      }
    }

    function applySpStepPickerSelection() {
      syncStepsFromDom();
      Object.keys(spCatalogPickKeys).forEach(function (key) {
        if (!spCatalogPickKeys[key]) return;
        var s = spCatalogCache.find(function (x) { return spCatalogStepKey(x.scope, x.id) === key; });
        if (!s) return;
        arbeitsschritte.push({
          bezeichnung_de: s.bezeichnung_de || splitBilingualLabel(s.bezeichnung || '').de,
          bezeichnung_en: s.bezeichnung_en || splitBilingualLabel(s.bezeichnung || '').en,
          status: 'na',
          bemerkung: ''
        });
      });
      renderSteps();
      var fab = getActiveFab();
      if (isServiceprotokollFormReadyForFab(fab)) stashDraftInMemory(fab);
      notifyReactBridge(true);
      closeSpStepPickerModal();
    }

    async function createSpCatalogNewStep() {
      var de = (document.getElementById('spCatalogStepDe') || {}).value || '';
      var en = (document.getElementById('spCatalogStepEn') || {}).value || '';
      de = de.trim();
      en = en.trim();
      if (!de && !en) {
        alert('Bitte mindestens eine Bezeichnung (DE oder EN) eingeben.');
        return;
      }
      var maxSort = spCatalogCache.reduce(function (m, s) { return Math.max(m, s.sort_order || 0); }, 0);
      var body = {
        base_url: getDispoBaseUrl(),
        technician_id: getTechId(),
        bezeichnung_de: de,
        bezeichnung_en: en,
        sort_order: maxSort + 1
      };
      var r = await fetch(API_BASE + '/api/arbeitsschritte_save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify(body)
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
      hideSpCatalogNewStepPanel();
      await loadSpCatalogData();
      spActivePresetStepKeys = resolveSpActivePresetStepKeys();
      var newId = data.id != null ? parseInt(data.id, 10) : 0;
      if (newId > 0) spCatalogPickKeys[spCatalogStepKey('user', newId)] = true;
      renderSpCatalogList();
    }


    function currentStepLabels() {
      syncStepsFromDom();
      return arbeitsschritte.map(function (s) {
        return combineBilingualLabel(s.bezeichnung_de, s.bezeichnung_en).toLowerCase();
      });
    }

    async function loadSpCatalogData() {
      var listUrl = API_BASE + '/api/arbeitsschritte_list?technician_id=' + getTechId();
      var baseUrl = (getDispoBaseUrl() || '').trim();
      if (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) {
        listUrl += '&local_only=1';
      } else if (baseUrl) {
        listUrl += '&base_url=' + encodeURIComponent(baseUrl);
      }
      var r = await fetch(listUrl, { headers: { 'X-Technician-Id': String(getTechId()) } });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok || !Array.isArray(data.steps)) {
        spCatalogCache = [];
        spCatalogPresetsCache = [];
        return spCatalogCache;
      }
      spCatalogCache = data.steps;
      spCatalogPresetsCache = data.presets || [];
      return spCatalogCache;
    }

    var btnSpCatalog = document.getElementById('btnSpAddFromCatalog');
    if (btnSpCatalog) {
      btnSpCatalog.addEventListener('click', function () {
        openSpStepPickerModal();
      });
    }
    var btnSpResetSteps = document.getElementById('btnSpResetSteps');
    if (btnSpResetSteps) {
      btnSpResetSteps.addEventListener('click', function () {
        resetArbeitsschritteToDefaults();
      });
    }
    var btnSpCatalogNew = document.getElementById('btnSpCatalogNewStep');
    if (btnSpCatalogNew) {
      btnSpCatalogNew.addEventListener('click', function () {
        var panel = document.getElementById('spCatalogNewStepPanel');
        if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });
    }
    var btnSpCatalogStepCreate = document.getElementById('btnSpCatalogStepCreate');
    if (btnSpCatalogStepCreate) {
      btnSpCatalogStepCreate.addEventListener('click', function () {
        createSpCatalogNewStep().catch(function (e) { alert(e.message || e); });
      });
    }
    var btnSpCatalogStepCancelNew = document.getElementById('btnSpCatalogStepCancelNew');
    if (btnSpCatalogStepCancelNew) {
      btnSpCatalogStepCancelNew.addEventListener('click', hideSpCatalogNewStepPanel);
    }
    var btnSpCatalogAdd = document.getElementById('btnSpCatalogAdd');
    if (btnSpCatalogAdd) {
      btnSpCatalogAdd.addEventListener('click', applySpStepPickerSelection);
    }
    var btnSpCatalogCancel = document.getElementById('btnSpCatalogCancel');
    if (btnSpCatalogCancel) {
      btnSpCatalogCancel.addEventListener('click', closeSpStepPickerModal);
    }

    if (abbrechenBtn) {
      abbrechenBtn.addEventListener('click', function () {
        if (typeof window.openProtokolleService === 'function') window.openProtokolleService();
      });
    }

    window.openProtokolleService = function () {
      loadServiceJobs().then(function (jobs) {
        if (jobSelect) {
          jobSelect.innerHTML = '<option value="">– Bitte wählen –</option>' +
            jobs.map(function (j) {
              return '<option value="' + j.id + '">' + escapeHtml((j.job_number || '') + ' ' + (j.customer_name || '')) + '</option>';
            }).join('');
        }
        serviceJobData = null;
        serviceprotokollDraftStore = { byFab: {} };
        serviceprotokollFormReadyFab = '';
        arbeitsschritte = [];
        setActiveFabValue('');
        renderFabButtons(null);
        updateAllPdfButtonVisibility(null);
        if (kopfdatenEl) {
        kopfdatenEl.innerHTML = '';
        kopfdatenEl.hidden = true;
        kopfdatenEl.setAttribute('aria-hidden', 'true');
      }
        ['serviceprotokollPos', 'serviceprotokollQmax', 'serviceprotokollType', 'serviceprotokollDwc', 'serviceprotokollProjekt', 'serviceprotokollBemerkungen', 'serviceprotokollAbschlussBemerkungen'
        ].concat(SP_MESS_FIELD_IDS).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.value = '';
        });
        clearAbschlussFields();
        setServiceprotokollApplyToAnlagenstamm(false);
        updateVersSpannungHint();
        if (datumEl && !datumEl.value) {
          var today = new Date();
          datumEl.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        }
        lastProtokollId = null;
        if (stepsContainer) stepsContainer.innerHTML = '<tr><td colspan="5" class="muted" style="padding:0.75rem;text-align:center">Auftrag wählen, um Arbeitsschritte zu laden.</td></tr>';
        var defaultJobId = resolveDefaultServiceprotokollJobId(jobs);
        if (defaultJobId && jobSelect) {
          jobSelect.value = defaultJobId;
          applyServiceprotokollJobSelection(defaultJobId);
        }
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
      var jobs = await fetchMyAssignedJobs();
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
              body: JSON.stringify(anlagenstammDispoBody({ job_id: jobId, filename: filename, content: content }))
            });
            var data = await r.json().catch(function () { return {}; });
            if (!r.ok) {
              outcomes.push({
                file: filename,
                ok: false,
                error: (data && data.error) ? data.error : ('HTTP ' + r.status),
              });
            } else if (data.ok) {
              var warnParts = [];
              if (data.ingest_error) warnParts.push('Cache: ' + data.ingest_error);
              if (data.dispo_ingest_error) warnParts.push('Dispo: ' + data.dispo_ingest_error);
              else if (data.dispo_ingest_skipped) warnParts.push('Dispo: nicht konfiguriert (Einstellungen prüfen)');
              else if (data.dispo_ingest_ok) warnParts.push('Dispo: übernommen');
              outcomes.push({
                file: filename,
                ok: true,
                savedCsv: data.savedCsv,
                savedPdf: data.savedPdf,
                warn: warnParts.length ? warnParts.join(' · ') : '',
              });
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
              html += '<p><strong>' + escapeHtml(o.file) + '</strong>: gespeichert (CSV + PDF)' +
                (o.warn ? ' <span class="muted">(' + escapeHtml(o.warn) + ')</span>' : '') + '</p>';
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
      var baseUrl = (getDispoBaseUrl() || '').trim();
      try {
        var listUrl = API_BASE + '/api/textbausteine_list?technician_id=' + getTechId();
        if (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) {
          listUrl += '&local_only=1';
        } else if (baseUrl) {
          listUrl += '&base_url=' + encodeURIComponent(baseUrl);
        }
        var r = await fetch(listUrl, { headers: { 'X-Technician-Id': String(getTechId()) } });
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

  (function initArbeitsschritteView() {
    var asSteps = [];
    var asPresets = [];
    var editingStepId = 0;
    var selectedPresetId = 0;
    var selectedPresetScope = '';
    var checkedKeys = {};
    var dragFromIndex = -1;

    function esc(s) {
      if (s == null) return '';
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function stepKey(scope, id) {
      return String(scope || 'global') + ':' + id;
    }

    function listUrl() {
      var url = API_BASE + '/api/arbeitsschritte_list?technician_id=' + getTechId();
      var baseUrl = (getDispoBaseUrl() || '').trim();
      if (typeof preferLocalProjekteNeuOnly === 'function' && preferLocalProjekteNeuOnly()) {
        url += '&local_only=1';
      } else if (baseUrl) {
        url += '&base_url=' + encodeURIComponent(baseUrl);
      }
      return url;
    }

    function sortStepsDefault() {
      asSteps.sort(function (a, b) {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
        return a.id - b.id;
      });
    }

    function sortStepsForPreset(refs) {
      var refOrder = {};
      (refs || []).forEach(function (r, idx) {
        refOrder[stepKey(r.step_scope || 'global', r.step_id)] = idx;
      });
      asSteps.sort(function (a, b) {
        var ka = stepKey(a.scope, a.id);
        var kb = stepKey(b.scope, b.id);
        var aIn = Object.prototype.hasOwnProperty.call(refOrder, ka);
        var bIn = Object.prototype.hasOwnProperty.call(refOrder, kb);
        if (aIn && bIn) return refOrder[ka] - refOrder[kb];
        if (aIn) return -1;
        if (bIn) return 1;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.id - b.id;
      });
      checkedKeys = {};
      (refs || []).forEach(function (r) {
        checkedKeys[stepKey(r.step_scope || 'global', r.step_id)] = true;
      });
    }

    function updatePresetToolbarState() {
      var canSaveUser = selectedPresetId > 0 && selectedPresetScope === 'user';
      var btnSave = document.getElementById('btnAsPresetSave');
      var btnDel = document.getElementById('btnAsPresetDelete');
      if (btnSave) btnSave.disabled = !canSaveUser;
      if (btnDel) btnDel.disabled = !canSaveUser;
    }

    function renderPresetSelect() {
      var sel = document.getElementById('asPresetSelect');
      if (!sel) return;
      var html = '<option value="">— Preset wählen —</option>';
      asPresets.forEach(function (p) {
        var label = p.name + ' [' + p.type_code + ']' + (p.scope === 'global' ? ' (global)' : '');
        var val = (p.scope || 'user') + ':' + p.id;
        var selected = p.id === selectedPresetId && (p.scope || 'user') === selectedPresetScope;
        html += '<option value="' + esc(val) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
      });
      sel.innerHTML = html;
    }

    function applyPresetByValue(val) {
      if (!val) {
        selectedPresetId = 0;
        selectedPresetScope = '';
        var nameEl = document.getElementById('asPresetName');
        var typeEl = document.getElementById('asPresetType');
        if (nameEl) nameEl.value = '';
        if (typeEl) typeEl.value = '';
        checkedKeys = {};
        sortStepsDefault();
        renderPresetSelect();
        renderSteps();
        updatePresetToolbarState();
        return;
      }
      var parts = String(val).split(':');
      var scope = parts[0] || 'user';
      var pid = parseInt(parts[1], 10) || 0;
      var p = asPresets.find(function (x) { return x.id === pid && (x.scope || 'user') === scope; });
      if (!p) return;
      selectedPresetId = pid;
      selectedPresetScope = scope;
      var nameEl = document.getElementById('asPresetName');
      var typeEl = document.getElementById('asPresetType');
      if (nameEl) nameEl.value = p.name || '';
      if (typeEl) typeEl.value = p.type_code || '';
      sortStepsForPreset(p.step_refs || []);
      renderPresetSelect();
      renderSteps();
      updatePresetToolbarState();
    }

    function collectStepRefsFromDom() {
      var refs = [];
      var order = 1;
      document.querySelectorAll('#asStepList .as-row').forEach(function (row) {
        var cb = row.querySelector('input.as-row-check');
        if (!cb || !cb.checked) return;
        refs.push({
          step_scope: row.getAttribute('data-scope') || 'global',
          step_id: parseInt(row.getAttribute('data-id'), 10),
          sort_order: order++
        });
      });
      return refs;
    }

    async function persistUserOrder() {
      var orders = [];
      document.querySelectorAll('#asStepList .as-row').forEach(function (row, idx) {
        if ((row.getAttribute('data-scope') || '') !== 'user') return;
        orders.push({ id: parseInt(row.getAttribute('data-id'), 10), sort_order: idx + 1 });
      });
      if (!orders.length) return;
      var r = await fetch(API_BASE + '/api/arbeitsschritte_reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify({
          base_url: getDispoBaseUrl(),
          technician_id: getTechId(),
          orders: orders
        })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Reihenfolge speichern fehlgeschlagen');
    }

    function bindRowDragDrop() {
      var list = document.getElementById('asStepList');
      if (!list) return;
      list.querySelectorAll('.as-row').forEach(function (row) {
        row.addEventListener('dragstart', function (e) {
          dragFromIndex = parseInt(row.getAttribute('data-index'), 10);
          row.classList.add('as-row--dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragFromIndex));
        });
        row.addEventListener('dragend', function () {
          row.classList.remove('as-row--dragging');
          list.querySelectorAll('.as-row').forEach(function (r) { r.classList.remove('as-row--dragover'); });
          dragFromIndex = -1;
        });
        row.addEventListener('dragover', function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('as-row--dragover');
        });
        row.addEventListener('dragleave', function () {
          row.classList.remove('as-row--dragover');
        });
        row.addEventListener('drop', function (e) {
          e.preventDefault();
          row.classList.remove('as-row--dragover');
          var from = dragFromIndex;
          var to = parseInt(row.getAttribute('data-index'), 10);
          if (from < 0 || to < 0 || from === to) return;
          var moved = asSteps.splice(from, 1)[0];
          asSteps.splice(to, 0, moved);
          renderSteps();
          persistUserOrder().catch(function (err) { alert(err.message || err); });
        });
      });
    }

    function renderSteps() {
      var stepList = document.getElementById('asStepList');
      if (!stepList) return;
      if (!asSteps.length) {
        stepList.innerHTML = '<p class="muted">Keine Schritte.</p>';
        return;
      }
      stepList.innerHTML = asSteps.map(function (s, idx) {
        var global = s.scope === 'global';
        var k = stepKey(s.scope, s.id);
        var checked = checkedKeys[k] ? ' checked' : '';
        return '<div class="as-row" draggable="true" data-id="' + s.id + '" data-scope="' + esc(s.scope || 'global') + '" data-index="' + idx + '">'
          + '<span class="as-drag" title="Ziehen zum Sortieren">≡</span>'
          + '<input type="checkbox" class="as-row-check"' + checked + ' data-key="' + esc(k) + '">'
          + '<div class="as-row-main"><strong>' + esc(s.bezeichnung_de) + '</strong>'
          + (s.bezeichnung_en ? ' <span class="muted">/ ' + esc(s.bezeichnung_en) + '</span>' : '')
          + (global ? ' <span class="muted">(global)</span>' : '') + '</div>'
          + '<div class="as-row-actions">'
          + (global ? '' : '<button type="button" class="btn btn-ghost btn-as-edit-step" data-id="' + s.id + '">Bearbeiten</button>'
            + '<button type="button" class="btn btn-ghost btn-as-pub-step" data-id="' + s.id + '">Für alle</button>'
            + '<button type="button" class="btn btn-ghost btn-as-del-step" data-id="' + s.id + '">Löschen</button>')
          + '</div></div>';
      }).join('');
      stepList.querySelectorAll('.as-row-check').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var key = cb.getAttribute('data-key');
          if (cb.checked) checkedKeys[key] = true;
          else delete checkedKeys[key];
        });
      });
      stepList.querySelectorAll('.btn-as-edit-step').forEach(function (btn) {
        btn.addEventListener('click', function () { openStep(parseInt(btn.getAttribute('data-id'), 10)); });
      });
      stepList.querySelectorAll('.btn-as-pub-step').forEach(function (btn) {
        btn.addEventListener('click', function () { publishStep(parseInt(btn.getAttribute('data-id'), 10)); });
      });
      stepList.querySelectorAll('.btn-as-del-step').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteStep(parseInt(btn.getAttribute('data-id'), 10)); });
      });
      bindRowDragDrop();
    }

    window.loadArbeitsschritteView = async function () {
      var stepList = document.getElementById('asStepList');
      try {
        var r = await fetch(listUrl(), { headers: { 'X-Technician-Id': String(getTechId()) } });
        var data = await r.json();
        if (!data.ok) throw new Error(data.error || 'Laden fehlgeschlagen');
        asSteps = data.steps || [];
        asPresets = data.presets || [];
        if (!selectedPresetId) {
          sortStepsDefault();
        } else {
          var p = asPresets.find(function (x) {
            return x.id === selectedPresetId && (x.scope || 'user') === selectedPresetScope;
          });
          if (p) sortStepsForPreset(p.step_refs || []);
          else sortStepsDefault();
        }
        renderPresetSelect();
        renderSteps();
        updatePresetToolbarState();
      } catch (e) {
        if (stepList) stepList.innerHTML = '<span class="empty">Fehler: ' + esc(e.message) + '</span>';
      }
    };

    function openStep(id) {
      editingStepId = id || 0;
      var s = asSteps.find(function (x) { return x.id === id && x.scope === 'user'; }) || {};
      document.getElementById('modalAsStepTitle').textContent = id ? 'Schritt bearbeiten' : 'Neuer Schritt';
      document.getElementById('asStepDe').value = s.bezeichnung_de || '';
      document.getElementById('asStepEn').value = s.bezeichnung_en || '';
      document.getElementById('modalAsStep').classList.add('active');
    }

    async function saveStep() {
      var maxSort = asSteps.reduce(function (m, s) { return Math.max(m, s.sort_order || 0); }, 0);
      var body = {
        base_url: getDispoBaseUrl(),
        technician_id: getTechId(),
        id: editingStepId || undefined,
        bezeichnung_de: document.getElementById('asStepDe').value,
        bezeichnung_en: document.getElementById('asStepEn').value,
        sort_order: editingStepId ? undefined : maxSort + 1
      };
      var r = await fetch(API_BASE + '/api/arbeitsschritte_save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify(body)
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
      document.getElementById('modalAsStep').classList.remove('active');
      await window.loadArbeitsschritteView();
    }

    async function deleteStep(id) {
      if (!confirm('Schritt löschen?')) return;
      var r = await fetch(API_BASE + '/api/arbeitsschritte_delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify({ base_url: getDispoBaseUrl(), technician_id: getTechId(), id: id })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Löschen fehlgeschlagen');
      await window.loadArbeitsschritteView();
    }

    async function publishStep(id) {
      var baseUrl = getDispoBaseUrl();
      if (!baseUrl) { alert('Dispo-URL in Einstellungen eintragen.'); return; }
      var r = await fetch(API_BASE + '/api/arbeitsschritte_publish_global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify({ base_url: baseUrl, technician_id: getTechId(), id: id })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Freigabe fehlgeschlagen');
      await window.loadArbeitsschritteView();
    }

    async function savePreset(id) {
      var refs = collectStepRefsFromDom();
      var body = {
        base_url: getDispoBaseUrl(),
        technician_id: getTechId(),
        name: document.getElementById('asPresetName').value,
        type_code: document.getElementById('asPresetType').value,
        step_refs: refs
      };
      if (id) body.id = id;
      var r = await fetch(API_BASE + '/api/arbeitsschritte_preset_save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify(body)
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
      return data;
    }

    async function deletePreset() {
      if (!selectedPresetId || selectedPresetScope !== 'user') return;
      if (!confirm('Preset löschen?')) return;
      var r = await fetch(API_BASE + '/api/arbeitsschritte_preset_delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(getTechId()) },
        body: JSON.stringify({
          base_url: getDispoBaseUrl(),
          technician_id: getTechId(),
          id: selectedPresetId
        })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok || !data.ok) throw new Error(data.error || 'Löschen fehlgeschlagen');
      selectedPresetId = 0;
      selectedPresetScope = '';
      checkedKeys = {};
      await window.loadArbeitsschritteView();
    }

    var presetSelect = document.getElementById('asPresetSelect');
    if (presetSelect) {
      presetSelect.addEventListener('change', function () {
        applyPresetByValue(this.value);
      });
    }
    var btnPresetSave = document.getElementById('btnAsPresetSave');
    if (btnPresetSave) {
      btnPresetSave.addEventListener('click', function () {
        if (!selectedPresetId || selectedPresetScope !== 'user') return;
        savePreset(selectedPresetId).then(function () {
          return window.loadArbeitsschritteView();
        }).catch(function (e) { alert(e.message); });
      });
    }
    var btnPresetCreate = document.getElementById('btnAsPresetCreate');
    if (btnPresetCreate) {
      btnPresetCreate.addEventListener('click', function () {
        savePreset(0).then(function (data) {
          selectedPresetId = data && data.id ? data.id : 0;
          selectedPresetScope = 'user';
          return window.loadArbeitsschritteView();
        }).then(function () {
          if (selectedPresetId) applyPresetByValue('user:' + selectedPresetId);
        }).catch(function (e) { alert(e.message); });
      });
    }
    var btnPresetDelete = document.getElementById('btnAsPresetDelete');
    if (btnPresetDelete) {
      btnPresetDelete.addEventListener('click', function () {
        deletePreset().catch(function (e) { alert(e.message); });
      });
    }
    var btnNewStep = document.getElementById('btnAsNewStep');
    if (btnNewStep) btnNewStep.addEventListener('click', function () { openStep(0); });
    var btnAsStepSave = document.getElementById('btnAsStepSave');
    if (btnAsStepSave) btnAsStepSave.addEventListener('click', function () { saveStep().catch(function (e) { alert(e.message); }); });
    var btnAsStepCancel = document.getElementById('btnAsStepCancel');
    if (btnAsStepCancel) btnAsStepCancel.addEventListener('click', function () { document.getElementById('modalAsStep').classList.remove('active'); });
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
        var parentPath = parentEl && parentEl.value ? parentEl.value : 'Dokumente_Anlage';
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
