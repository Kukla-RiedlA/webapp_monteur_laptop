(function () {
  const API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  const getTechId = () => parseInt(document.getElementById('technicianId').value, 10) || 0;
  const getServerUrl = () => (document.getElementById('serverUrl').value || '').trim();
  const getServerUsername = () => (document.getElementById('serverUsername') && document.getElementById('serverUsername').value || '').trim();
  const getServerPassword = () => (document.getElementById('serverPassword') && document.getElementById('serverPassword').value || '');

  const SETTINGS_KEYS = {
    serverUrl: 'monteur_serverUrl',
    technicianId: 'monteur_technicianId',
    serverUsername: 'monteur_serverUsername',
    serverPassword: 'monteur_serverPassword',
    syncIntervalMinutes: 'monteur_syncIntervalMinutes',
    dienstreiseBasePath: 'monteur_dienstreiseBasePath',
    allowInsecureTls: 'monteur_allowInsecureTls',
  };

  function getDispoBaseUrl() {
    var u = getServerUrl();
    if (u) return u;
    try { return (localStorage.getItem(SETTINGS_KEYS.serverUrl) || '').trim(); } catch (e) { return ''; }
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
      if (url != null) document.getElementById('serverUrl').value = url;
      const techId = localStorage.getItem(SETTINGS_KEYS.technicianId);
      if (techId != null) document.getElementById('technicianId').value = techId;
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
      if (tlsEl && tls != null) tlsEl.checked = tls === '1';
    } catch (e) { /* ignore */ }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(SETTINGS_KEYS.serverUrl, (document.getElementById('serverUrl').value || '').trim());
      localStorage.setItem(SETTINGS_KEYS.technicianId, document.getElementById('technicianId').value || '');
      localStorage.setItem(SETTINGS_KEYS.serverUsername, (document.getElementById('serverUsername') && document.getElementById('serverUsername').value) || '');
      localStorage.setItem(SETTINGS_KEYS.serverPassword, (document.getElementById('serverPassword') && document.getElementById('serverPassword').value) || '');
      localStorage.setItem(SETTINGS_KEYS.syncIntervalMinutes, String(getSyncIntervalMinutes()));
      const pathEl = document.getElementById('dienstreiseBasePath');
      localStorage.setItem(SETTINGS_KEYS.dienstreiseBasePath, (pathEl && pathEl.value ? pathEl.value.trim() : '') || '');
      const tlsEl = document.getElementById('allowInsecureDispoTls');
      localStorage.setItem(SETTINGS_KEYS.allowInsecureTls, tlsEl && tlsEl.checked ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  function getSyncDateRange() {
    const today = new Date();
    const from = new Date(today);
    from.setMonth(from.getMonth() - 1);
    const to = new Date(today);
    to.setFullYear(to.getFullYear() + 1);
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
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
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

  /** Auftrag mit Status „geplant“: in der Laptop-App nur Anzeige, keine Änderungen. */
  function isJobGeplantReadOnly(job) {
    if (!job || typeof job !== 'object') return false;
    return String(job.status || '').trim().toLowerCase() === 'geplant';
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
    return raw === 'erledigt' || raw === 'completed' || raw === 'done' || raw === 'fertig';
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

  /**
   * Jede angehakte Option muss zutreffen (UND): predicates.every().
   * Keine aktive Checkbox → leere Ergebnisliste.
   */
  function filterOpenJobsList(jobs) {
    var arr = Array.isArray(jobs) ? jobs : [];
    if (!anyOpenJobFilterChecked()) {
      return [];
    }
    var cbNoDate = document.getElementById('openJobsFilterNoDate');
    var cbNoTech = document.getElementById('openJobsFilterNoTech');
    var cbAlle = document.getElementById('openJobsFilterAlleNonErledigt');
    var predicates = [];
    if (cbAlle && cbAlle.checked) {
      predicates.push(function (j) { return !isJobErledigtForOpenList(j); });
    }
    if (cbNoDate && cbNoDate.checked) {
      predicates.push(function (j) { return jobHasNoDateForOpenFilter(j); });
    }
    if (cbNoTech && cbNoTech.checked) {
      predicates.push(function (j) { return jobHasNoTechnicianForOpenFilter(j); });
    }
    if (predicates.length === 0) return [];
    return arr.filter(function (j) {
      if (!j || typeof j !== 'object') return false;
      for (var p = 0; p < predicates.length; p++) {
        if (!predicates[p](j)) return false;
      }
      return true;
    });
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
        : '<span class="status-badge status-' + (j.status || 'geplant').replace(' ', '_') + '">' + (j.status || 'geplant') + '</span>';
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
    return jobDetailsJobId || selectedJobIdOnDienstreisePage;
  }

  function getDienstreiseJobSnapshotByLocalId(localJobId) {
    var id = parseInt(localJobId, 10);
    if (!id) return null;
    var list = Array.isArray(dienstreisePageJobs) ? dienstreisePageJobs : [];
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (j && (j.id === id || j.id == id)) return j;
    }
    var cur = window.currentProjektdatenJob;
    if (cur && (cur.id === id || cur.id == id)) return cur;
    return null;
  }

  function updateDienstreiseWriteControlsState() {
    var jid = getDienstreiseExplorerJobId();
    var snap = jid ? getDienstreiseJobSnapshotByLocalId(jid) : null;
    var ro = isJobGeplantReadOnly(snap);
    var copyBtn = document.getElementById('btnDienstreiseCopyProject');
    var upBtn = document.getElementById('btnDienstreiseUpload');
    if (copyBtn) {
      copyBtn.disabled = !!ro;
      copyBtn.title = ro ? 'Auftrag ist geplant – nur Anzeige.' : '';
    }
    if (upBtn) {
      upBtn.disabled = !!ro;
      upBtn.title = ro ? 'Auftrag ist geplant – nur Anzeige.' : '';
    }
    var sub = document.getElementById('dienstreiseUploadSubfolder');
    var fi = document.getElementById('dienstreiseFileInput');
    if (sub) sub.disabled = !!ro;
    if (fi) fi.disabled = !!ro;
  }

  function openJobDetailsModal(jobId) {
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
    content.innerHTML = '<span class="empty">Wird geladen…</span>';

    function showJob(job) {
      if (!job) {
        content.innerHTML = '<span class="empty">Fehler: Auftrag nicht gefunden.</span>';
        return;
      }
      window.currentProjektdatenJob = job;
      content.innerHTML = renderJobDetailsContent(job);
      bindLeistungActions();
      loadMechanikTedLinks(job);
      if (typeof loadDienstreiseExplorer === 'function') loadDienstreiseExplorer(jobDetailsJobId, '');
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
    }

    function loadLocal() {
      var base = getDispoBaseUrl();
      var url = API_BASE + '/api/job?id=' + encodeURIComponent(jobId);
      var jobHeaders = Object.assign({ 'X-Technician-Id': String(techId) }, dispoBasicAuthHeaders(getDispoUsername, getDispoPassword));
      if (base) {
        url += '&enrich_anlagenstamm=1&base_url=' + encodeURIComponent(base);
      }
      fetch(url, { headers: jobHeaders })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.job) { showJob(data.job); return; }
          var cached = window.currentProjektdatenJob;
          if (cached && (cached.id === jobId || cached.id == jobId)) { showJob(cached); return; }
          showJob(null);
        })
        .catch(function (e) {
          var cached = window.currentProjektdatenJob;
          if (cached && (cached.id === jobId || cached.id == jobId)) { showJob(cached); return; }
          content.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
        });
    }

    var baseUrl = getDispoBaseUrl();
    if (baseUrl) {
      fetch(API_BASE + '/api/job_from_dispo', {
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
            return;
          }
          var cached = window.currentProjektdatenJob;
          if (cached && (cached.id === jobId || cached.id == jobId)) { showJob(cached); return; }
          loadLocal();
        })
        .catch(function () {
          var cached = window.currentProjektdatenJob;
          if (cached && (cached.id === jobId || cached.id == jobId)) { showJob(cached); return; }
          loadLocal();
        });
    } else {
      loadLocal();
    }
  }

  function closeJobDetailsModal() {
    var viewProjektdaten = document.getElementById('viewProjektdaten');
    if (viewProjektdaten) viewProjektdaten.classList.remove('active');
    jobDetailsJobId = null;
  }

  function renderJobDetailsContent(job) {
    var readOnlyGeplant = isJobGeplantReadOnly(job);
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
      var allowed = ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'p', 'br'];
      var div = document.createElement('div');
      div.innerHTML = s;
      function sanitize(node) {
        if (node.nodeType === 3) return escapeHtml(node.textContent);
        if (node.nodeType !== 1) return '';
        var tag = node.tagName.toLowerCase();
        if (allowed.indexOf(tag) === -1) {
          var out = '';
          for (var i = 0; i < node.childNodes.length; i++) out += sanitize(node.childNodes[i]);
          return out;
        }
        var out = '<' + tag + '>';
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

    var leistungRows = [];
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
            return { fabrikationsnummer: fn, type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: '' };
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
        if (val !== undefined && val !== null) {
          var s = String(val).trim();
          if (s.toLowerCase() === 'null') return '';
          return s;
        }
        var lower = keys[i].toLowerCase();
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && k.toLowerCase() === lower) {
          var v2 = r[k];
          if (v2 === undefined || v2 === null) continue;
          var s2 = String(v2).trim();
          if (s2.toLowerCase() === 'null') return '';
          return s2;
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
    window.currentProjektdatenLeistungRows = leistungRows;

    var html = '';
    if (readOnlyGeplant) {
      html += '<div class="projektdaten-readonly-banner" role="status">Auftrag ist <strong>geplant</strong> – hier nur Anzeige, keine Bearbeitung.</div>';
    }
    html += '<div class="modal-detail-grid">';
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
    (function () {
      var hotelLines = [];
      var hotelName = (job.hotel_endkunde || '').trim();
      if (hotelName) hotelLines.push(escapeHtml(hotelName));
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
      html += '<div class="modal-detail-section modal-detail-section-address-row">';
      html += '<div class="modal-address-contact-row">';
      html += '<div class="modal-detail-section"><h4>Auftragsadresse</h4><p class="modal-address">' + addressLine + '</p></div>';
      html += '<div class="modal-detail-section modal-hotel-display-wrap"><h4>Hotel Adresse</h4><p class="modal-address hotel-address-display' + (readOnlyGeplant ? ' hotel-address-readonly' : '') + '" data-job-id="' + escapeHtml(String(job.id)) + '"' + (readOnlyGeplant ? '' : ' title="Doppelklick zum Bearbeiten"') + '>' + hotelAddressLine + '</p>' + (readOnlyGeplant ? '' : '<p class="modal-hotel-hint muted">Doppelklick zum Bearbeiten</p>') + '</div>';
      html += '<div class="modal-detail-section"><h4>Kontakt (Baustellen-Ansprechpartner)</h4><dl class="modal-detail-dl">';
      html += '<dt>Ansprechpartner</dt><dd>' + v(name) + '</dd>';
      html += '<dt>Telefon</dt><dd>' + v(phone) + '</dd>';
      html += '<dt>E-Mail</dt><dd>' + v(email) + '</dd>';
      html += '</dl></div>';
      html += '</div></div>';
    })();
    html += '</div>';

    html += '<div class="modal-detail-section"><h4>Leistungsdaten (Anlagenstamm)</h4>';
    html += '<p class="modal-leistung-hint muted">' + (readOnlyGeplant ? 'Nur Anzeige (Auftrag geplant).' : 'Doppelklick auf eine Anlage öffnet die Anlagendetails.') + '</p>';
    var visibleIndices = [];
    for (var idx = 0; idx < leistungRows.length; idx++) {
      var r = leistungRows[idx];
      if (!r.fabrikationsnummer && !r.type && !r.leistung && !r.geliefert_ueber && !r.projekt && !r.bemerkungen) continue;
      visibleIndices.push(idx);
    }
    var useTwoCards = visibleIndices.length > 2;
    var vCell = function (x) { return escapeHtml(String(x == null ? '' : x)); };
    var leistungCellClass = readOnlyGeplant ? 'modal-leistung-cell-readonly' : 'modal-leistung-cell-clickable';
    function renderAnlagenTable(indices) {
      var out = '<div class="modal-leistung-wrap"><table class="modal-leistung-table modal-leistung-table-compact"><thead><tr>';
      out += '<th>FN</th><th>Type</th><th>Leistung</th>';
      out += '</tr></thead><tbody>';
      for (var k = 0; k < indices.length; k++) {
        var i = indices[k];
        var row = leistungRows[i];
        out += '<tr>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.fabrikationsnummer) + '</td>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.type) + '</td>';
        out += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.leistung) + '</td>';
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
      html += '<th>FN</th><th>Type</th><th>Leistung</th>';
      html += '</tr></thead><tbody id="modalLeistungTbody">';
      for (var i = 0; i < leistungRows.length; i++) {
        var row = leistungRows[i];
        if (!row.fabrikationsnummer && !row.type && !row.leistung && !row.geliefert_ueber && !row.projekt && !row.bemerkungen) continue;
        html += '<tr>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.fabrikationsnummer) + '</td>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.type) + '</td>';
        html += '<td class="' + leistungCellClass + '" data-row-index="' + escapeHtml(String(i)) + '">' + vCell(row.leistung) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';
    html += '<div class="modal-detail-section" id="mechanikTedLinksContainer"><h4>Mechanik-Excel (TED)</h4><p class="muted">Wird geladen…</p></div>';
    if (job.description) html += '<div class="modal-detail-section modal-detail-section-description"><h4>Bemerkungen</h4><div class="modal-description-wrap"><div class="modal-description-display">' + formatDescriptionForDisplay(job.description) + '</div></div></div>';
    return html;
  }

  function loadMechanikTedLinks(job) {
    var el = document.getElementById('mechanikTedLinksContainer');
    if (!el) return;
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
        if (!result.ok || !result.data || !result.data.ok) {
          el.innerHTML = '<p class="muted">Mechanik-Excel konnte nicht geladen werden' + (result.data && result.data.error ? ': ' + escapeHtml(String(result.data.error)) : '.') + '</p>';
          return;
        }
        var byFab = result.data.by_fab || {};
        var keys = Object.keys(byFab);
        if (keys.length === 0) {
          el.innerHTML = '<p class="muted">Keine TED-Dateien im Index für diese Fabrikationsnummern.</p>';
          return;
        }
        var root = baseUrl.replace(/\/$/, '');
        var html = '';
        keys.forEach(function (fab) {
          var files = byFab[fab] || [];
          if (files.length === 0) return;
          html += '<div class="kukla-ted-fab"><strong>FN ' + escapeHtml(String(fab)) + '</strong><ul>';
          files.forEach(function (f) {
            var href = root + (f.download_path || '');
            var dt = (f.file_mtime || '').toString();
            var w = f.fn_matches_filename === false ? ' ⚠' : '';
            html += '<li><a href="' + String(href).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + escapeHtml(String(f.file_name || '')) + '</a> <span class="muted">' + escapeHtml(dt) + '</span>' + w + '</li>';
          });
          html += '</ul></div>';
        });
        el.innerHTML = html || '<p class="muted">Keine Einträge.</p>';
      })
      .catch(function (e) {
        el.innerHTML = '<p class="muted">Mechanik-Excel (TED): Offline oder Dispo nicht erreichbar.</p>';
      });
  }

  function openAnlageDetailModal(rowIndex) {
    if (isJobGeplantReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
      return;
    }
    var rows = window.currentProjektdatenLeistungRows;
    if (!rows || !rows[rowIndex]) return;
    var row = rows[rowIndex];
    var jobId = jobDetailsJobId;
    if (!jobId) return;
    var attr = function (x) { return escapeHtml(String(x == null ? '' : x)).replace(/"/g, '&quot;'); };
    var modalHtml = '<div id="anlageDetailModal" class="modal-overlay anlage-detail-modal" role="dialog">';
    modalHtml += '<div class="modal-box anlage-detail-content">';
    modalHtml += '<h3>Anlagendetails</h3>';
    modalHtml += '<p class="anlage-detail-fn"><strong>Fabrikationsnummer:</strong> <span id="anlageDetailFn">' + attr(row.fabrikationsnummer) + '</span></p>';
    modalHtml += '<input type="hidden" id="anlageDetailRowIndex" value="' + attr(String(rowIndex)) + '">';
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
    function closeModal() {
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    }
    document.getElementById('anlageDetailCancel').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
    document.getElementById('anlageDetailSave').addEventListener('click', function () {
      var idx = parseInt(document.getElementById('anlageDetailRowIndex').value, 10);
      var rowsCopy = (window.currentProjektdatenLeistungRows || []).slice();
      if (!rowsCopy[idx]) return;
      rowsCopy[idx] = {
        fabrikationsnummer: rowsCopy[idx].fabrikationsnummer,
        type: (document.getElementById('anlageDetailType') && document.getElementById('anlageDetailType').value) || '',
        leistung: (document.getElementById('anlageDetailLeistung') && document.getElementById('anlageDetailLeistung').value) || '',
        nenngeschwindigkeit: (document.getElementById('anlageDetailNenngeschwindigkeit') && document.getElementById('anlageDetailNenngeschwindigkeit').value) || '',
        kraftaufnehmer: (document.getElementById('anlageDetailKraftaufnehmer') && document.getElementById('anlageDetailKraftaufnehmer').value) || '',
        dms_nr: (document.getElementById('anlageDetailDmsNr') && document.getElementById('anlageDetailDmsNr').value) || '',
        tacho: (document.getElementById('anlageDetailTacho') && document.getElementById('anlageDetailTacho').value) || '',
        elektronik: (document.getElementById('anlageDetailElektronik') && document.getElementById('anlageDetailElektronik').value) || '',
        material: (document.getElementById('anlageDetailMaterial') && document.getElementById('anlageDetailMaterial').value) || '',
        position: (document.getElementById('anlageDetailPosition') && document.getElementById('anlageDetailPosition').value) || '',
        geliefert_ueber: (document.getElementById('anlageDetailGeliefertUeber') && document.getElementById('anlageDetailGeliefertUeber').value) || '',
        projekt: (document.getElementById('anlageDetailProjekt') && document.getElementById('anlageDetailProjekt').value) || '',
        bemerkungen: (document.getElementById('anlageDetailBemerkungen') && document.getElementById('anlageDetailBemerkungen').value) || ''
      };
      var arr = rowsCopy.filter(function (r) { return r && (r.fabrikationsnummer || r.type || r.leistung || r.geliefert_ueber || r.projekt || r.bemerkungen); });
      if (arr.length === 0) arr = rowsCopy;
      api('/api/job', {
        method: 'PATCH',
        body: JSON.stringify({ job_id: parseInt(jobId, 10), fabrikationsnummern: JSON.stringify(arr) })
      }).then(function () {
        closeModal();
        openJobDetailsModal(jobId);
        if (typeof checkConnectionAndSync === 'function') { try { checkConnectionAndSync(); } catch (e) {} }
      }).catch(function (e) {
        alert('Speichern fehlgeschlagen: ' + e.message);
      });
    });
  }

  function addLeistungRow() {
    if (isJobGeplantReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
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
    if (isJobGeplantReadOnly(window.currentProjektdatenJob)) {
      alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
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
          type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: ''
        });
      }
    }
    api('/api/job', {
      method: 'PATCH',
      body: JSON.stringify({ job_id: parseInt(jobId, 10), fabrikationsnummern: JSON.stringify(arr) })
    }).then(function () {
      openJobDetailsModal(jobId);
      if (typeof checkConnectionAndSync === 'function') {
        try { checkConnectionAndSync(); } catch (e) {}
      }
    }).catch(function (e) {
      alert('Speichern fehlgeschlagen: ' + e.message);
    });
  }

  function bindLeistungActions() {
    var content = document.getElementById('viewProjektdatenContent');
    if (!content) return;
    content.querySelectorAll('.modal-leistung-cell-clickable').forEach(function (td) {
      td.addEventListener('dblclick', function () {
        var idx = td.getAttribute('data-row-index');
        if (idx !== null && idx !== '') openAnlageDetailModal(parseInt(idx, 10));
      });
    });
    bindHotelAddressDblclick();
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
    if (isJobGeplantReadOnly(job || window.currentProjektdatenJob)) {
      alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
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
    function updateHotelCountryFlag() {
      var sel = document.getElementById('hotel_edit_country');
      var flagEl = document.getElementById('hotel_edit_country_flag');
      if (!sel || !flagEl) return;
      var code = (sel.value || '').trim().toUpperCase().slice(0, 2);
      flagEl.innerHTML = code ? countryFlagImg(code) : '';
    }
    updateHotelCountryFlag();
    document.getElementById('hotel_edit_country').addEventListener('change', updateHotelCountryFlag);
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
      });
    }
    document.getElementById('hotelModalCancel').addEventListener('click', closeModal);
    document.getElementById('hotelModalSave').addEventListener('click', function () {
      var payload = {
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
        hotel_website: (document.getElementById('hotel_edit_website') && document.getElementById('hotel_edit_website').value) || ''
      };
      api('/api/job', { method: 'PATCH', body: JSON.stringify(payload) }).then(function () {
        closeModal();
        var updatedJob = { ...job, hotel_endkunde: payload.hotel_endkunde, hotel_street: payload.hotel_street, hotel_house_number: payload.hotel_house_number, hotel_zip: payload.hotel_zip, hotel_city: payload.hotel_city, hotel_country: payload.hotel_country, hotel_address_extra_1: payload.hotel_address_extra_1, hotel_address_extra_2: payload.hotel_address_extra_2, hotel_phone: payload.hotel_phone, hotel_email: payload.hotel_email, hotel_website: payload.hotel_website };
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
        var baseUrl = (typeof getServerUrl === 'function' ? getServerUrl() : '').trim();
        var techId = typeof getTechId === 'function' ? getTechId() : null;
        if (baseUrl && techId) {
          api('/api/sync_push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl: getServerUrl(),
              technicianId: getTechId(),
              serverUsername: typeof getServerUsername === 'function' ? getServerUsername() : '',
              serverPassword: typeof getServerPassword === 'function' ? getServerPassword() : ''
            })
          }).then(function (d) {
            if (d && d.ok && typeof showToast === 'function') showToast('Hotel-Adresse wurde in die Dispo übertragen.');
            else if (d && d.error && typeof showToast === 'function') {
              console.error('[Sync Push] Fehler:', d.error, d);
              showToast('Sync fehlgeschlagen: ' + d.error);
            }
          }).catch(function (e) {
            console.error('[Sync Push] Fehler:', e.message, e);
            if (typeof showToast === 'function') showToast('Sync fehlgeschlagen: ' + (e.message || 'Verbindung zur Dispo prüfen'));
          });
        }
        if (typeof checkConnectionAndSync === 'function') { try { checkConnectionAndSync(); } catch (e) {} }
      }).catch(function (e) {
        alert('Speichern fehlgeschlagen: ' + e.message);
      });
    });
  }

  async function updateJobStatus(jobId, status) {
    var techId = getTechId();
    if (techId) {
      try {
        var jr = await fetch(API_BASE + '/api/job?id=' + encodeURIComponent(jobId), { headers: { 'X-Technician-Id': String(techId) } });
        var jd = await jr.json();
        if (jd.job && isJobGeplantReadOnly(jd.job)) {
          alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
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
        if (jd2.job && isJobGeplantReadOnly(jd2.job)) {
          alert('Auftrag ist geplant – Bearbeitung in der App nicht erlaubt.');
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
    if (!techId) {
      cachedOpenJobs = [];
      if (list) list.innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
      return;
    }
    const baseUrl = getServerUrl();
    if (!baseUrl) {
      cachedOpenJobs = [];
      if (list) list.innerHTML = '<span class="empty">Server-Adresse in Einstellungen eintragen.</span>';
      return;
    }
    try {
      const cbAlleOpen = document.getElementById('openJobsFilterAlleNonErledigt');
      const includeErledigtOpen = cbAlleOpen && !cbAlleOpen.checked;
      const jobOpenQs = { base_url: baseUrl };
      if (includeErledigtOpen) jobOpenQs.include_erledigt = '1';
      const r = await fetch(API_BASE + '/api/jobs_open?' + qs(jobOpenQs), {
        headers: Object.assign({ 'X-Technician-Id': String(techId) }, dispoBasicAuthHeaders(getServerUsername, getServerPassword))
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        cachedOpenJobs = [];
        var errLine = (data && data.error) ? data.error : 'Fehler beim Laden.';
        if (data && data.hint) errLine += ' — ' + data.hint;
        if (data && data.detail && !data.hint) errLine += ' (' + String(data.detail).slice(0, 200) + ')';
        if (list) list.innerHTML = '<span class="empty">' + escapeHtml(errLine) + '</span>';
        return;
      }
      cachedOpenJobs = Array.isArray(data) ? data : [];
      renderOpenJobsWithFilters();
    } catch (e) {
      cachedOpenJobs = [];
      if (list) list.innerHTML = '<span class="empty">Fehler: ' + escapeHtml(e.message) + '</span>';
    }
  }

  async function loadJobsAndAbsences() {
    const techId = getTechId();
    if (!techId) {
      document.getElementById('jobsList').innerHTML = '<span class="empty">Monteur-ID in Einstellungen eintragen.</span>';
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
      el.textContent = (data.full_name && data.full_name.trim()) ? data.full_name.trim() : 'Techniker';
    } catch (e) {
      el.textContent = 'Techniker';
    }
  }

  function setConnectionBadge(state, reason) {
    const badge = document.getElementById('connectionBadge');
    const wrap = document.getElementById('connectionBadgeWrap');
    if (wrap) wrap.classList.toggle('clickable', state === 'online');
    if (state === 'online') {
      badge.textContent = 'Online';
      badge.className = 'online-badge';
      if (reason && String(reason).trim()) {
        badge.setAttribute('title', String(reason).trim());
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

  async function checkConnectionAndSync() {
    const base = getServerUrl().trim();
    const techId = getTechId();
    if (!techId) {
      setConnectionBadge('offline');
      loadJobsAndAbsences();
      return;
    }
    if (!base) {
      setConnectionBadge('local');
      loadJobsAndAbsences();
      return;
    }
    try {
      const resCheck = await fetch(API_BASE + '/api/check_connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: base,
          technicianId: techId,
          serverUsername: getServerUsername(),
          serverPassword: getServerPassword()
        })
      });
      const check = await resCheck.json().catch(function () { return {}; });
      if (check && check.ok === true) {
        const range = getSyncDateRange();
        const auth = { baseUrl: base, technicianId: techId, serverUsername: getServerUsername(), serverPassword: getServerPassword() };
        var syncProblems = [];
        try {
          await fetch(API_BASE + '/api/sync_pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...auth, date_from: range.date_from, date_to: range.date_to })
          }).then((r) => r.json()).then((d) => { if (!d.ok) throw new Error(d.error); });
        } catch (e) {
          console.error('[Sync Pull] checkConnectionAndSync:', e.message, e);
          syncProblems.push('Pull: ' + (e && e.message ? e.message : 'Fehler'));
        }
        try {
          await fetch(API_BASE + '/api/sync_push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(auth)
          }).then((r) => r.json()).then((d) => { if (!d.ok) throw new Error(d.error || (d && JSON.stringify(d))); });
        } catch (e) {
          console.error('[Sync Push] checkConnectionAndSync:', e.message, e);
          syncProblems.push('Push: ' + (e && e.message ? e.message : 'Fehler'));
        }
        if (syncProblems.length) {
          setConnectionBadge('online', syncProblems.join(' · ') + ' — Klicken zum erneuten Synchronisieren');
        } else {
          setConnectionBadge('online');
        }
        // Dienstreise-Projektordner (Dokumente_Monteur / Dokumente_Buchhaltung) periodisch mit dem Dispo-Server synchronisieren
        if (selectedJobIdOnDienstreisePage) {
          var syncSnap = typeof getDienstreiseJobSnapshotByLocalId === 'function' ? getDienstreiseJobSnapshotByLocalId(selectedJobIdOnDienstreisePage) : null;
          if (!isJobGeplantReadOnly(syncSnap)) {
            const bodySync = {
              job_id: selectedJobIdOnDienstreisePage,
              dispo_base_url: base,
              technician_id: techId,
              dispo_username: getServerUsername(),
              dispo_password: getServerPassword()
            };
            fetch(API_BASE + '/api/dienstreise/sync_to_dispo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bodySync)
            }).catch(() => { /* Fehler hier ignorieren, Verify bei „Erledigt“ prüft erneut */ });
          }
        }
      } else {
        var offMsg = (check && check.error) ? check.error : 'Verbindung fehlgeschlagen';
        if (!resCheck.ok && (!check || !check.error)) {
          offMsg = 'Lokaler Server (check_connection): HTTP ' + resCheck.status;
        }
        setConnectionBadge('offline', offMsg);
      }
    } catch (e) {
      setConnectionBadge('offline', e && e.message ? e.message : 'Verbindung fehlgeschlagen');
    }
    setNextSyncTime();
    loadJobsAndAbsences();
    loadOpenJobs();
  }

  function renderAbsences(data, requestsData) {
    const list = document.getElementById('absencesList');
    const absences = (data && data.absences) ? data.absences : [];
    const requests = (requestsData && requestsData.requests) ? requestsData.requests : [];
    const parts = [];
    absences.forEach(function(a) {
      if (a.from_absence_request && a.status === 'pending') return;
      const dateStr = formatDateRange(a.start_datetime, a.end_datetime);
      const isRequest = a.from_absence_request === true;
      const action = isRequest ? 'delete-absence-request' : 'delete-absence';
      const title = isRequest ? 'Anfrage aus der Liste entfernen' : 'Abwesenheit löschen (lokal und in der Dispo)';
      parts.push('<div class="job job-absence-row"><div class="job-info"><strong>' + escapeHtml(a.type || 'Abwesenheit') + '</strong><br><span class="job-meta">' + escapeHtml(dateStr) + '</span></div><button type="button" class="btn-icon btn-delete-absence" data-action="' + action + '" data-id="' + escapeHtml(String(a.id)) + '" title="' + escapeHtml(title) + '" aria-label="Löschen">🗑</button></div>');
    });
    requests.forEach(function(r) {
      if (r.status === 'approved') return;
      const dateStr = formatDateRange(r.start_datetime, r.end_datetime);
      var statusText;
      if (r.status === 'pending') statusText = 'Offen (wird geprüft)';
      else if (r.status === 'rejected') statusText = 'Abgelehnt';
      else if (r.status === 'error') statusText = 'Fehler bei Übertragung';
      else statusText = r.status || '';
      parts.push('<div class="job job-absence-row"><div class="job-info"><strong>' + escapeHtml(r.type || 'Abwesenheit') + '</strong> <span class="job-meta">' + escapeHtml(dateStr) + ' – ' + statusText + '</span></div><button type="button" class="btn-icon btn-delete-absence" data-action="delete-absence-request" data-id="' + escapeHtml(String(r.id)) + '" title="Anfrage aus der Liste entfernen" aria-label="Löschen">🗑</button></div>');
    });
    var hasErrorRequests = requests.some(function(r) { return r.status === 'error'; });
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
    var baseUrl = getServerUrl();
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
    syncIntervalId = setInterval(checkConnectionAndSync, ms);
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
    var base = getServerUrl().trim();
    var techId = getTechId();
    if (!techId || !base) return Promise.resolve();
    var badge = document.getElementById('connectionBadge');
    if (badge) badge.textContent = 'Wird synchronisiert…';
    return checkConnectionAndSync().finally(function () {
      startSyncInterval();
    });
  }

  document.getElementById('connectionBadgeWrap').addEventListener('click', function () {
    if (!this.classList.contains('clickable')) return;
    triggerManualSync();
  });

  loadSettingsFromStorage();
  function loadDienstreiseConfigFromServer() {
    fetch(API_BASE + '/api/dienstreise/config').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok && data.basePath) {
        var el = document.getElementById('dienstreiseBasePath');
        if (el) el.value = data.basePath;
        try { localStorage.setItem(SETTINGS_KEYS.dienstreiseBasePath, data.basePath); } catch (e) {}
      }
    }).catch(function () {});
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
  loadDispoTlsSettingFromServer().then(function () {
    checkConnectionAndSync();
  });
  startSyncInterval();
  startPushEvents();
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
        var base = getServerUrl().trim();
        var techId = getTechId();
        if (base && techId) {
          return checkConnectionAndSync();
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
      var base = (getServerUrl() || '').trim().replace(/\/+$/, '');
      if (!base) {
        alert('Bitte zuerst Server-Adresse (Dispo) in den Einstellungen eintragen.');
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
    var base = getServerUrl().trim();
    var techId = getTechId();
    if (!techId) {
      hint.textContent = 'Bitte zuerst Monteur-ID eintragen.';
      return;
    }
    if (!base) {
      hint.textContent = 'Bitte zuerst Server-Adresse (Dispo) eintragen.';
      return;
    }
    hint.textContent = 'Wird geholt…';
    checkConnectionAndSync().then(function () {
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
    var body = { id: parseInt(id, 10), base_url: getServerUrl() || undefined, serverUsername: getDispoUsername() || undefined, serverPassword: getDispoPassword() || undefined };
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
    if (!start || !end) {
      if (msgEl) msgEl.textContent = 'Bitte Start- und Enddatum angeben.';
      return;
    }
    var body = {
      start_datetime: start + 'T00:00:00',
      end_datetime: end + 'T23:59:59',
      type: type || 'Abwesenheit',
      base_url: getServerUrl() || undefined,
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
      const status = (j.status || 'erledigt').replace(' ', '_');
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
        '<span class="status-badge status-' + status + '">' + (j.status || 'erledigt') + '</span>' +
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
        if (parts.length > 0) parsedList = parts.map(function (fn) { return { fabrikationsnummer: fn, type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: '' }; });
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
          position: get(r, ['position', 'Position'])
        });
      });
    }
    if (rows.length === 0) rows.push({ fabrikationsnummer: '', type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: '' });
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

  function showView(name) {
    const viewStart = document.getElementById('viewStart');
    const viewEinstellungen = document.getElementById('viewEinstellungen');
    const viewProjektdaten = document.getElementById('viewProjektdaten');
    const viewDienstreise = document.getElementById('viewDienstreise');
    const viewArchiv = document.getElementById('viewArchiv');
    const viewAbwesenheiten = document.getElementById('viewAbwesenheiten');
    const protokolleViewIds = ['viewProtokolleMontagebericht', 'viewProtokolleParameterlisten', 'viewProtokolleKontrollwiegungen', 'viewProtokolleInbetriebnahme', 'viewProtokolleService'];
    viewStart.classList.remove('only-left', 'only-right', 'hidden');
    viewEinstellungen.classList.remove('active');
    if (viewProjektdaten) viewProjektdaten.classList.remove('active');
    if (viewDienstreise) viewDienstreise.classList.remove('active');
    protokolleViewIds.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    const viewTextbausteine = document.getElementById('viewTextbausteine');
    if (viewTextbausteine) viewTextbausteine.classList.remove('active');
    if (viewArchiv) viewArchiv.classList.remove('active');
    if (viewAbwesenheiten) viewAbwesenheiten.classList.remove('active');
    if (name === 'einstellungen') {
      viewStart.classList.add('hidden');
      viewEinstellungen.classList.add('active');
      updateTechnicianName();
      return;
    }
    if (name === 'dienstreise') {
      viewStart.classList.add('hidden');
      viewDienstreise.classList.add('active');
      loadDienstreiseList();
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
    if (name === 'start') {
      loadOpenJobs();
      loadCalendarMonth();
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

  /** Lokaler Kalender (SQLite) für einen Monteur – funktioniert ohne Dispo-Verbindung. */
  async function loadCalendarLocalMonth(start, end, techId) {
    const params = { technician_id: techId, date_from: start, date_to: end, include_erledigt: 1 };
    const [jRes, aRes, techRes] = await Promise.all([
      fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
      fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
      fetch(API_BASE + '/api/technician?technician_id=' + techId, { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()).catch(() => ({}))
    ]);
    var techColor = (techRes.color || techRes.farbe || '').toString().trim() || '#4a90e2';
    var techName = (techRes.full_name || techRes.name || '').toString().trim() || ('Techniker ' + techId);
    const jobs = (jRes.jobs || []).map(function (j) { return Object.assign({}, j, { technician_id: techId, technician_name: techName, technician_color: techColor }); });
    const absences = (aRes.absences || []).map(function (a) { return Object.assign({}, a, { technician_id: techId, technician_name: techName, technician_color: techColor }); });
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
      const base = getServerUrl();
      const myTechId = getTechId();
      if (!base) {
        if (!myTechId) {
          setCalendarError('Für „Alle Techniker“ Dispo-Server-URL eintragen – oder Monteur-ID setzen und Häkchen aus für Offline-Kalender.');
          return;
        }
        try {
          var localOnly = await loadCalendarLocalMonth(start, end, myTechId);
          jobs = localOnly.jobs;
          absences = localOnly.absences;
          showToast('Offline / keine Server-URL: nur Ihre gespeicherten Termine (lokal).');
        } catch (e) {
          renderCalendarGrid(gridStart, gridEnd, [], [], null);
          setCalendarError('Fehler: ' + e.message);
          return;
        }
        renderCalendarGrid(gridStart, gridEnd, jobs, absences, null);
        return;
      }
      try {
        const data = await fetch(API_BASE + '/api/calendar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: base,
            start,
            end,
            serverUsername: getServerUsername(),
            serverPassword: getServerPassword()
          })
        }).then(r => r.json());
        if (data.error) throw new Error(data.error);
        calendarApiData = data;
        jobs = data.jobs || [];
        var techList = (data.technicians && data.technicians.length) ? data.technicians : [];
        var techById = {};
        techList.forEach(function (t) {
          var id = t.id != null ? t.id : t.technician_id;
          if (id == null) return;
          var dispColor = (t.color || t.farbe || '').toString().trim();
          techById[id] = {
            name: (t.full_name || t.name || t.technician_name || '').trim() || ('Techniker ' + id),
            color: dispColor || '#4a90e2'
          };
        });
        // Abwesenheiten mit Technikerfarbe/Name anreichern (API liefert ggf. keine Farbe)
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
        if (myTechId) {
          try {
            var params = { technician_id: myTechId, date_from: start, date_to: end, include_erledigt: 1 };
            var local = await Promise.all([
              fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); }),
              fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); })
            ]);
            (local[0].jobs || []).forEach(function (j) {
              if (j.server_id != null) { localJobsByServerId[j.server_id] = j; localJobsByServerId[String(j.server_id)] = j; }
              if (j.id != null) { localJobsById[j.id] = j; localJobsById[String(j.id)] = j; }
            });
            var myTechInfo = { name: techById[myTechId] ? techById[myTechId].name : ('Techniker ' + myTechId), color: techById[myTechId] ? techById[myTechId].color : '#4a90e2' };
            jobs = jobs.map(function (j) {
              var tid = j.technician_id != null ? j.technician_id : j.technicianId;
              var info = techById[tid];
              var techDisplay = { technician_name: info ? info.name : ('Techniker ' + tid), technician_color: info ? info.color : '#4a90e2' };
              var sid = j.server_id != null ? j.server_id : j.id;
              var localJob = localJobsByServerId[j.server_id] || localJobsByServerId[j.id] || localJobsByServerId[String(j.server_id)] || localJobsByServerId[String(j.id)] || localJobsById[j.id] || localJobsById[String(j.id)];
              if (localJob) {
                return Object.assign({}, localJob, { technician_id: myTechId, technician_name: myTechInfo.name, technician_color: myTechInfo.color });
              }
              return Object.assign({}, j, techDisplay);
            });
            var serverJobIds = {};
            jobs.forEach(function (j) { serverJobIds[j.id] = true; if (j.server_id != null) serverJobIds[j.server_id] = true; });
            (local[0].jobs || []).forEach(function (j) {
              if (!serverJobIds[j.id] && !serverJobIds[j.server_id]) {
                jobs.push(Object.assign({}, j, { technician_id: myTechId, technician_name: myTechInfo.name, technician_color: myTechInfo.color }));
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
            var serverAbsIds = {};
            var serverAbsPeriodKeys = {};
            absences.forEach(function (a) {
              serverAbsIds[a.id] = true;
              if (a.server_id != null && a.server_id !== '') serverAbsIds[a.server_id] = true;
              serverAbsPeriodKeys[absenceCalendarDedupeKey(a)] = true;
            });
            (local[1].absences || []).forEach(function (a) {
              var enriched = Object.assign({}, a, { technician_id: myTechId, technician_name: techById[myTechId] ? techById[myTechId].name : ('Techniker ' + myTechId), technician_color: techById[myTechId] ? techById[myTechId].color : '#6c757d' });
              var periodKey = absenceCalendarDedupeKey(enriched, myTechId);
              if (!serverAbsIds[a.id] && !serverAbsIds[a.server_id] && !serverAbsPeriodKeys[periodKey]) {
                serverAbsPeriodKeys[periodKey] = true;
                absences.push(enriched);
              }
            });
          } catch (e) { /* lokale Termine optional */ }
        }
      } catch (e) {
        if (!myTechId) {
          renderCalendarGrid(gridStart, gridEnd, [], [], null);
          setCalendarError('Kalender laden fehlgeschlagen: ' + e.message);
          return;
        }
        try {
          var fb = await loadCalendarLocalMonth(start, end, myTechId);
          jobs = fb.jobs;
          absences = fb.absences;
          calendarApiData = null;
          showToast('Dispo nicht erreichbar – Anzeige: nur Ihre gespeicherten Termine (Offline).');
        } catch (e2) {
          renderCalendarGrid(gridStart, gridEnd, [], [], null);
          setCalendarError('Kalender laden fehlgeschlagen: ' + e.message);
          return;
        }
      }
    } else {
      const techId = getTechId();
      if (!techId) {
        setCalendarError('Monteur-ID eingeben.');
        return;
      }
      try {
        var loc = await loadCalendarLocalMonth(start, end, techId);
        jobs = loc.jobs;
        absences = loc.absences;
      } catch (e) {
        renderCalendarGrid(gridStart, gridEnd, [], [], null);
        setCalendarError('Fehler: ' + e.message);
        return;
      }
    }

    const techniciansFromApi = (calendarApiData && calendarApiData.technicians) ? calendarApiData.technicians : null;
    renderCalendarGrid(gridStart, gridEnd, jobs, absences, techniciansFromApi);
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
    const firma = (job.customer_name || job.customerName || job.job_number || 'Auftrag').trim();
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
    const isErledigt = statusRaw === 'erledigt' || statusRaw === 'completed' || statusRaw === 'done' || statusRaw === 'fertig';
    const labelHtml = isErledigt
      ? '<span class="cal-erledigt-check">✓</span> <span class="cal-bar-label">' + (label || 'Auftrag').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '</span> <span class="cal-erledigt-check">✓</span>'
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
    const monthLabel = new Date(calCurrentMonth.getFullYear(), calCurrentMonth.getMonth(), 1);
    const monthEl = document.getElementById('calMonthLabel');
    if (monthEl) monthEl.textContent = monthLabel.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

    const weekDays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const currentMonth = calCurrentMonth.getMonth();
    const todayYmd = toYmd(new Date());
    const gridCols = '40px repeat(7, minmax(0, 1fr))';
    const laneHeight = 25;
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
          band.title = (o.type || 'Abwesenheit') + (o.technician_name ? ' – ' + o.technician_name : '');
        } else {
          const j = o;
          band.className = 'month2-band month2-event';
          band.style.background = j.technician_color || '#4a90e2';
          band.setAttribute('data-job-id', String(j.id));
          band.style.cursor = 'pointer';
          const colSpan = colEnd - colStart;
          const maxChars = colSpan * 20;
          const bar = jobBarText(j, maxChars);
          band.title = (bar.title || '') + ' (Doppelklick: Projektdaten)';
          if (bar.labelHtml) band.innerHTML = bar.labelHtml; else band.textContent = bar.label || 'Auftrag';
          band.addEventListener('dblclick', function () {
            if (typeof openJobDetailsModal === 'function') openJobDetailsModal(j.id);
          });
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

  function renderDienstreiseExplorerTree() {
    var listEl = document.getElementById('dienstreiseExplorerList');
    var jobId = getDienstreiseExplorerJobId();
    if (!listEl || !jobId) return;
    if (!dienstreiseProtectedPathsByJob[jobId]) dienstreiseProtectedPathsByJob[jobId] = new Set();
    var protectedSet = dienstreiseProtectedPathsByJob[jobId];
    var drSnap = getDienstreiseJobSnapshotByLocalId(jobId);
    var drReadonlyGeplant = isJobGeplantReadOnly(drSnap);
    var rows = [];
    var expanded = dienstreiseExplorerExpanded;
    function addEntries(entries, level) {
      if (!entries) return;
      entries.forEach(function (e) {
        rows.push({ level: level, entry: e });
        if (e.isDirectory && expanded[e.relativePath]) {
          addEntries(expanded[e.relativePath], level + 1);
        }
      });
    }
    addEntries(dienstreiseExplorerRootEntries, 0);
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
      html += '<div class="dienstreise-explorer-row' + levelClass + '" data-full-path="' + escapeHtml(e.fullPath || '') + '" data-is-dir="' + (e.isDirectory ? '1' : '0') + '" data-relative-path="' + escapeHtml(e.relativePath || '') + '">' +
        '<div class="dienstreise-explorer-name">' + toggle + '<span class="icon" aria-hidden="true">' + icon + '</span> ' + escapeHtml(e.name) + '</div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(sizeStr) + '</div>' +
        '<div class="dienstreise-explorer-size">' + escapeHtml(mtimeStr) + '</div>' +
        '<div class="dienstreise-explorer-actions">' +
        protectControl +
        '<button type="button" class="btn btn-ghost" data-explorer-open title="Mit Standardprogramm bzw. Explorer öffnen">Öffnen</button>' +
        deleteBtn +
        '</div></div>';
    });
    listEl.innerHTML = html;
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
            loadDienstreiseExplorer(jobId, dienstreiseExplorerSubpath);
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
        var rel = row.getAttribute('data-relative-path');
        if (!rel) return;
        if (dienstreiseExplorerExpanded[rel]) {
          delete dienstreiseExplorerExpanded[rel];
          renderDienstreiseExplorerTree();
          return;
        }
        fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId) + '&subpath=' + encodeURIComponent(rel)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.entries) dienstreiseExplorerExpanded[rel] = data.entries;
          renderDienstreiseExplorerTree();
        });
      });
    });
  }

  function loadDienstreiseExplorer(jobId, subpath) {
    dienstreiseExplorerSubpath = subpath || '';
    var listEl = document.getElementById('dienstreiseExplorerList');
    var breadcrumbEl = document.getElementById('dienstreiseExplorerBreadcrumb');
    if (!listEl) return;
    if (!jobId) {
      listEl.innerHTML = '<span class="empty" id="dienstreiseExplorerPlaceholder">Auftrag wählen, dann Ordnerinhalt hier.</span>';
      if (breadcrumbEl) breadcrumbEl.textContent = 'Projektordner';
      dienstreiseExplorerRootEntries = [];
      dienstreiseExplorerExpanded = {};
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
      return;
    }
    listEl.innerHTML = '<span class="empty">Wird geladen …</span>';
    if (breadcrumbEl) breadcrumbEl.textContent = 'Projektordner';
    fetch(API_BASE + '/api/dienstreise/project_files?job_id=' + encodeURIComponent(jobId)).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok || !data.entries) {
        listEl.innerHTML = '<span class="empty">' + (data.error || 'Laden fehlgeschlagen.') + '</span>';
        if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
        return;
      }
      dienstreiseExplorerRootEntries = data.entries;
      dienstreiseExplorerExpanded = {};
      renderDienstreiseExplorerTree();
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
    }).catch(function () {
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
    fetch(API_BASE + '/api/my_jobs?technician_id=' + techId + '&date_from=' + range.date_from + '&date_to=' + range.date_to).then(function (r) { return r.json(); }).then(function (data) {
      var listEl = document.getElementById('dienstreiseList');
      if (!listEl) return;
      var jobs = (data && data.jobs) ? data.jobs : [];
      dienstreisePageJobs = jobs;
      if (jobs.length === 0) {
        listEl.innerHTML = '<span class="empty">Keine Aufträge.</span>';
        selectedJobIdOnDienstreisePage = null;
        if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
        return;
      }
      var html = jobs.map(function (j) {
        var dateStr = formatDateRange(j.start_datetime, j.end_datetime);
        var status = (j.status || 'geplant').replace(' ', '_');
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
          '<span class="status-badge status-' + status + '">' + (j.status || 'geplant') + '</span>' +
          (j.status !== 'erledigt' && String(j.status || '').toLowerCase() !== 'geplant' ? '<button class="btn btn-primary" data-status="erledigt">Erledigt</button>' : '') +
          '</div></div>';
      }).join('');
      listEl.innerHTML = html;
      if (typeof updateDienstreiseWriteControlsState === 'function') updateDienstreiseWriteControlsState();
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
    }).catch(function () {
      var listEl = document.getElementById('dienstreiseList');
      if (listEl) listEl.innerHTML = '<span class="empty">Laden fehlgeschlagen.</span>';
    });
  }

  document.getElementById('btnDienstreiseCopyProject').addEventListener('click', function () {
    var localJobId = jobDetailsJobId || selectedJobIdOnDienstreisePage;
    var snapCopy = localJobId ? getDienstreiseJobSnapshotByLocalId(localJobId) : null;
    if (isJobGeplantReadOnly(snapCopy)) {
      var h0 = document.getElementById('dienstreiseCopyHint');
      if (h0) h0.textContent = 'Auftrag ist geplant – nur Anzeige.';
      return;
    }
    var hint = document.getElementById('dienstreiseCopyHint');
    var progressWrap = document.getElementById('dienstreiseCopyProgressWrap');
    var progressBar = document.getElementById('dienstreiseCopyProgress');
    var progressLabel = document.getElementById('dienstreiseCopyProgressLabel');
    if (!localJobId) {
      hint.textContent = 'Bitte einen Auftrag öffnen (Doppelklick auf Auftrag oder Kalenderbalken).';
      return;
    }
    hint.textContent = '';
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar) { progressBar.value = 0; progressBar.max = 100; }
    if (progressLabel) progressLabel.textContent = 'Dispo wird aktualisiert …';
    var btn = document.getElementById('btnDienstreiseCopyProject');
    if (btn) btn.disabled = true;
    var includeBilderEl = document.getElementById('dienstreiseCopyIncludeBilder');
    var includeBilder = includeBilderEl && includeBilderEl.checked;
    var body = {
      job_id: localJobId,
      dispoBaseUrl: getDispoBaseUrl(),
      technicianId: getTechId(),
      dispoUsername: getDispoUsername(),
      dispoPassword: getDispoPassword(),
      include_bilder: includeBilder
    };
    var copyTimeoutMs = 120000; // 2 Min – wenn bis dahin weder done noch error kam, UI zurücksetzen
    var copyTimeoutId = setTimeout(function () {
      copyTimeoutId = null;
      var wrap = document.getElementById('dienstreiseCopyProgressWrap');
      var b = document.getElementById('btnDienstreiseCopyProject');
      var lbl = document.getElementById('dienstreiseCopyProgressLabel');
      var h = document.getElementById('dienstreiseCopyHint');
      if (wrap) wrap.style.display = 'none';
      if (b) b.disabled = false;
      if (lbl) lbl.textContent = '';
      if (h) { h.textContent = 'Zeitüberschreitung – Dispo-Antwort kam nicht. Bitte erneut versuchen.'; setTimeout(function () { var x = document.getElementById('dienstreiseCopyHint'); if (x) x.textContent = ''; }, 5000); }
    }, copyTimeoutMs);

    fetch(API_BASE + '/api/dienstreise/copy_project_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        if (copyTimeoutId) { clearTimeout(copyTimeoutId); copyTimeoutId = null; }
        return response.json().then(function (data) {
          throw new Error(data.error || 'Fehler ' + response.status);
        }).catch(function () { throw new Error('Fehler ' + response.status); });
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var completed = false;
      var hadError = false;
      function finish() {
        if (copyTimeoutId) { clearTimeout(copyTimeoutId); copyTimeoutId = null; }
        var wrap = document.getElementById('dienstreiseCopyProgressWrap');
        var lbl = document.getElementById('dienstreiseCopyProgressLabel');
        var b = document.getElementById('btnDienstreiseCopyProject');
        if (wrap) wrap.style.display = 'none';
        if (b) b.disabled = false;
        if (lbl) lbl.textContent = '';
      }
      function processLine(line) {
        line = line.trim();
        if (!line) return;
        var data;
        try { data = JSON.parse(line); } catch (e) { return; }
        if (data.phase === 'refresh') {
          if (progressLabel) progressLabel.textContent = 'Dispo wird aktualisiert …';
        } else if (data.phase === 'refresh_done') {
          if (progressLabel) progressLabel.textContent = 'Lade auf Laptop …';
        } else if (data.phase === 'download' && data.total != null) {
          if (progressBar) progressBar.max = data.total;
          if (progressBar) progressBar.value = 0;
        } else if (data.phase === 'file' && data.total != null) {
          if (progressBar) progressBar.value = data.current || 0;
          if (progressLabel && data.total > 0) progressLabel.textContent = 'Lade ' + (data.current || 0) + ' / ' + data.total;
        } else if (data.phase === 'done') {
          completed = true;
          finish();
          var h = document.getElementById('dienstreiseCopyHint');
          if (h) h.textContent = 'Fertig.';
          if (getDienstreiseExplorerJobId()) loadDienstreiseExplorer(getDienstreiseExplorerJobId(), dienstreiseExplorerSubpath);
          setTimeout(function () { var x = document.getElementById('dienstreiseCopyHint'); if (x) x.textContent = ''; }, 3000);
        } else if (data.phase === 'error') {
          hadError = true;
          finish();
          var hErr = document.getElementById('dienstreiseCopyHint');
          if (hErr) hErr.textContent = data.error || 'Fehler.';
        }
      }
      function readNext() {
        return reader.read().then(function (result) {
          if (result.value && result.value.length > 0) {
            buffer += decoder.decode(result.value, { stream: !result.done });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(function (line) {
              try { processLine(line); } catch (e) { /* Einzelne Zeile ignorieren */ }
            });
          }
          if (result.done) {
            if (buffer.trim()) try { processLine(buffer); } catch (e) { }
            finish();
            if (!completed && !hadError) {
              var hDone = document.getElementById('dienstreiseCopyHint');
              if (hDone) hDone.textContent = 'Fertig.';
              if (getDienstreiseExplorerJobId()) loadDienstreiseExplorer(getDienstreiseExplorerJobId(), dienstreiseExplorerSubpath);
              setTimeout(function () { var x = document.getElementById('dienstreiseCopyHint'); if (x) x.textContent = ''; }, 3000);
            }
            return;
          }
          return readNext();
        });
      }
      return readNext().catch(function (streamErr) {
        finish();
        hint.textContent = streamErr && streamErr.message ? streamErr.message : 'Verbindung abgebrochen.';
      });
    }).catch(function (err) {
      if (copyTimeoutId) { clearTimeout(copyTimeoutId); copyTimeoutId = null; }
      var wrap = document.getElementById('dienstreiseCopyProgressWrap');
      var b = document.getElementById('btnDienstreiseCopyProject');
      var lbl = document.getElementById('dienstreiseCopyProgressLabel');
      var h = document.getElementById('dienstreiseCopyHint');
      if (wrap) wrap.style.display = 'none';
      if (b) b.disabled = false;
      if (lbl) lbl.textContent = '';
      if (h) h.textContent = err && err.message ? err.message : 'Fehler beim Kopieren.';
    });
  });

  document.getElementById('btnDienstreiseUpload').addEventListener('click', function () {
    var localJobId = getDienstreiseExplorerJobId();
    var snapUp = localJobId ? getDienstreiseJobSnapshotByLocalId(localJobId) : null;
    if (isJobGeplantReadOnly(snapUp)) {
      var hintRo = document.getElementById('dienstreiseUploadHint');
      if (hintRo) hintRo.textContent = 'Auftrag ist geplant – nur Anzeige.';
      return;
    }
    var subfolder = document.getElementById('dienstreiseUploadSubfolder');
    var sub = subfolder && subfolder.value ? subfolder.value : 'Dokumente_Monteur';
    var fileInput = document.getElementById('dienstreiseFileInput');
    var hint = document.getElementById('dienstreiseUploadHint');
    if (!localJobId) { hint.textContent = 'Bitte einen Auftrag öffnen (Doppelklick auf Auftrag oder Kalenderbalken).'; return; }
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      hint.textContent = 'Bitte eine Datei wählen.';
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
            if (getDienstreiseExplorerJobId()) loadDienstreiseExplorer(getDienstreiseExplorerJobId(), dienstreiseExplorerSubpath);
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

  document.getElementById('btnViewStart').addEventListener('click', () => showView('start'));
  document.getElementById('btnViewDienstreise').addEventListener('click', () => showView('dienstreise'));
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
  document.getElementById('calShowAllTech').addEventListener('change', () => loadCalendarMonth());

  ['openJobsFilterNoDate', 'openJobsFilterNoTech', 'openJobsFilterAlleNonErledigt'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function () {
      if (id === 'openJobsFilterAlleNonErledigt' && typeof loadOpenJobs === 'function') loadOpenJobs();
      else renderOpenJobsWithFilters();
    });
  });
})();
