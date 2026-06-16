/**
 * Laptop-Brücke: X-Technician-Id, Hintergrund-Sync (offline-first), Dateien öffnen.
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';

  function techId() {
    try {
      if (typeof global.getTechId === 'function') return global.getTechId();
      if (global.MonteurRamsBridge && typeof global.MonteurRamsBridge.getTechId === 'function') {
        const bridged = global.MonteurRamsBridge.getTechId();
        if (bridged > 0) return bridged;
      }
      const el = document.getElementById('technicianId');
      if (el && el.value) {
        const fromInput = parseInt(el.value, 10);
        if (fromInput > 0) return fromInput;
      }
      const tid = localStorage.getItem('monteur_technicianId');
      return tid ? parseInt(tid, 10) : 0;
    } catch (_) {
      return 0;
    }
  }

  function dispoBaseUrl() {
    try {
      if (typeof global.getDispoBaseUrl === 'function') {
        const u = (global.getDispoBaseUrl() || '').trim();
        if (u) return u;
      }
    } catch (_) { /* ignore */ }
    try {
      return (localStorage.getItem('monteur_serverUrl') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const tid = techId();
    if (tid) h['X-Technician-Id'] = String(tid);
    try {
      const u = (localStorage.getItem('monteur_serverUsername') || '').trim();
      const p = localStorage.getItem('monteur_serverPassword') || '';
      if (u || p) {
        h.Authorization = 'Basic ' + btoa(u + ':' + p);
      }
    } catch (_) { /* ignore */ }
    return h;
  }

  global.kuklaAbrechnungFetchHeaders = authHeaders;

  if (!global.__kuklaAbrechnungFetchPatched) {
    global.__kuklaAbrechnungFetchPatched = true;
    const nativeFetch = global.fetch.bind(global);
    global.__kuklaAbrechnungNativeFetch = nativeFetch;
    global.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') >= 0 || url.indexOf('api/') === 0) {
        init = init || {};
        const headers = new Headers(init.headers || {});
        const ah = authHeaders();
        Object.keys(ah).forEach((k) => headers.set(k, ah[k]));
        init.headers = headers;
      }
      return nativeFetch(input, init);
    };
  }

  const nativeFetch = global.__kuklaAbrechnungNativeFetch || global.fetch.bind(global);

  function currentPeriodYm() {
    const ySel = document.getElementById('abYearSelect');
    const mSel = document.getElementById('abMonthNumSelect');
    if (!ySel || !mSel) return '';
    const y = parseInt(ySel.value, 10);
    const m = parseInt(mSel.value, 10);
    if (!y || !m) return '';
    return y + '-' + String(m).padStart(2, '0');
  }

  function currentJobServerId() {
    const sel = document.getElementById('abJobSelect');
    if (!sel || !sel.value) return 0;
    return parseInt(sel.value, 10) || 0;
  }

  function setSyncHint(text, isError) {
    const el = document.getElementById('abSyncHint');
    if (!el) return;
    if (!text) {
      el.textContent = '';
      el.style.display = 'none';
      el.classList.remove('ab-banner');
      return;
    }
    el.textContent = text;
    el.style.display = '';
    if (isError) el.classList.add('ab-banner');
    else el.classList.remove('ab-banner');
  }

  function scheduleAbrechnungBackgroundSync(opts) {
    opts = opts || {};
    const tid = techId();
    const period = opts.period_ym || currentPeriodYm();
    const jobServerId = opts.job_server_id != null ? opts.job_server_id : currentJobServerId();
    const showStatus = opts.showStatus !== false;
    if (!tid) {
      if (showStatus) setSyncHint('Kein Monteur gewählt — nur lokale Daten.', true);
      return Promise.resolve({ ok: false, skipped: true });
    }
    const baseUrl = dispoBaseUrl();
    if (!baseUrl) {
      if (showStatus) setSyncHint('Offline-Modus: nur lokal gespeicherte Abrechnungsdaten (Dispo-URL fehlt).', true);
      return Promise.resolve({ ok: false, skipped: true });
    }
    let serverUsername = '';
    let serverPassword = '';
    try {
      serverUsername = (localStorage.getItem('monteur_serverUsername') || '').trim();
      serverPassword = localStorage.getItem('monteur_serverPassword') || '';
    } catch (_) { /* ignore */ }
    if (showStatus) {
      setSyncHint('Hintergrund-Abgleich mit Dispo läuft — Anzeige aus lokalem Speicher (Dienstreise-Ordner).', false);
    }
    return nativeFetch(api + '/api/abrechnung/schedule_refresh', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        baseUrl: baseUrl,
        technicianId: tid,
        serverUsername: serverUsername,
        serverPassword: serverPassword,
        period_ym: period,
        job_server_id: jobServerId > 0 ? jobServerId : 0,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (dj) {
        if (!dj.ok) throw new Error(dj.error || 'Abgleich konnte nicht gestartet werden');
        return dj;
      })
      .catch(function (e) {
        if (showStatus) {
          setSyncHint(
            (typeof navigator !== 'undefined' && navigator.onLine === false)
              ? 'Offline — nur lokal gespeicherte Daten.'
              : 'Hintergrund-Abgleich: ' + (e && e.message ? e.message : String(e)),
            true,
          );
        }
        return { ok: false, error: e && e.message ? e.message : String(e) };
      });
  }

  global.kuklaAbrechnungScheduleRefresh = scheduleAbrechnungBackgroundSync;

  global.kuklaAbrechnungRunSync = function (opts) {
    return scheduleAbrechnungBackgroundSync(Object.assign({ showStatus: true }, opts || {}));
  };

  /** Offline-first: sofort lokale UI, Sync nur im Hintergrund. */
  global.kuklaAbrechnungOnPeriodChange = function (cb) {
    scheduleAbrechnungBackgroundSync({ showStatus: false, period_ym: currentPeriodYm(), job_server_id: 0 });
    if (typeof cb === 'function') cb();
  };

  global.kuklaAbrechnungOnJobChange = function (cb) {
    scheduleAbrechnungBackgroundSync({
      showStatus: false,
      period_ym: currentPeriodYm(),
      job_server_id: currentJobServerId(),
    });
    if (typeof cb === 'function') cb();
  };

  global.kuklaAbrechnungAfterMount = function () {
    scheduleAbrechnungBackgroundSync({ showStatus: true });
  };

  global.monteurAbrechnungFiles = {
    bindAbrechnungFileLi: function (li, meta) {
      if (!li || !meta) return;
      const a = li.querySelector('a');
      if (!a || a.dataset.laptopFileBound === '1') return;
      a.dataset.laptopFileBound = '1';
      a.addEventListener('click', async function (e) {
        if (!global.monteurApp || typeof global.monteurApp.openPath !== 'function') return;
        e.preventDefault();
        try {
          const r = await nativeFetch(api + '/api/abrechnung_file_open', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              job_id: meta.jobId,
              bucket: meta.bucket || 'dispo',
              filename: meta.filename || meta.fileName,
            }),
          });
          const d = await r.json();
          if (d.ok && d.local_path) await global.monteurApp.openPath(d.local_path);
          else window.open(a.href, '_blank');
        } catch (_) {
          window.open(a.href, '_blank');
        }
      });
    },
  };

  if (!global.dispoDesktopFiles) {
    global.dispoDesktopFiles = global.monteurAbrechnungFiles;
  }
})(window);
