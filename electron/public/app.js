(function () {
  const API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  const getTechId = () => parseInt(document.getElementById('technicianId').value, 10) || 0;
  const getServerUrl = () => (document.getElementById('serverUrl').value || '').trim();
  const getServerUsername = () => (document.getElementById('serverUsername') && document.getElementById('serverUsername').value || '').trim();
  const getServerPassword = () => (document.getElementById('serverPassword') && document.getElementById('serverPassword').value || '');

  const SETTINGS_KEYS = { serverUrl: 'monteur_serverUrl', technicianId: 'monteur_technicianId', serverUsername: 'monteur_serverUsername', serverPassword: 'monteur_serverPassword', syncIntervalMinutes: 'monteur_syncIntervalMinutes' };

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
    } catch (e) { /* ignore */ }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(SETTINGS_KEYS.serverUrl, (document.getElementById('serverUrl').value || '').trim());
      localStorage.setItem(SETTINGS_KEYS.technicianId, document.getElementById('technicianId').value || '');
      localStorage.setItem(SETTINGS_KEYS.serverUsername, (document.getElementById('serverUsername') && document.getElementById('serverUsername').value) || '');
      localStorage.setItem(SETTINGS_KEYS.serverPassword, (document.getElementById('serverPassword') && document.getElementById('serverPassword').value) || '');
      localStorage.setItem(SETTINGS_KEYS.syncIntervalMinutes, String(getSyncIntervalMinutes()));
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

  function renderJobs(data) {
    const list = document.getElementById('jobsList');
    const jobs = data.jobs || [];
    if (jobs.length === 0) {
      list.innerHTML = '<span class="empty">Keine Aufträge.</span>';
      return;
    }
    list.innerHTML = jobs.map((j) => {
      const start = (j.start_datetime || '').slice(0, 16).replace('T', ' ');
      const status = (j.status || 'geplant').replace(' ', '_');
      const firma = (j.customer_name || j.customerName || '').trim();
      const ort = (j.city || '').trim();
      const land = normalizeCountryToCode(j.country) || (j.country || '').trim().toUpperCase().slice(0, 2);
      const flagHtml = countryFlagImg(land);
      const parts = [];
      if (flagHtml) parts.push(flagHtml);
      if (firma) parts.push(escapeHtml(firma));
      if (ort) parts.push(escapeHtml(ort));
      if (land) parts.push(escapeHtml(land));
      const titleLine = parts.join(' · ');
      return (
        '<div class="job" data-job-id="' + j.id + '">' +
        '<div class="job-info">' +
        '<strong>' + (titleLine || 'Auftrag') + '</strong><br>' +
        '<span class="job-meta">' + start + ' · ' + (j.job_type || '') + '</span>' +
        '</div>' +
        '<div class="job-actions">' +
        '<span class="status-badge status-' + status + '">' + (j.status || 'geplant') + '</span>' +
        (j.status !== 'in_arbeit' ? '<button class="btn btn-ghost" data-status="in_arbeit">Start</button>' : '') +
        (j.status !== 'erledigt' ? '<button class="btn btn-primary" data-status="erledigt">Erledigt</button>' : '') +
        '</div></div>'
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

  function openJobDetailsModal(jobId) {
    var techId = getTechId();
    if (!techId) {
      alert('Bitte Monteur-ID in Einstellungen eintragen.');
      return;
    }
    var modal = document.getElementById('modalJobDetails');
    var content = document.getElementById('modalJobDetailsContent');
    if (!modal || !content) return;
    jobDetailsJobId = jobId;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    content.innerHTML = '<span class="empty">Wird geladen…</span>';

    function showJob(job) {
      if (!job) {
        content.innerHTML = '<span class="empty">Fehler: Auftrag nicht gefunden.</span>';
        return;
      }
      content.innerHTML = renderJobDetailsContent(job);
      bindLeistungActions();
    }

    function loadLocal() {
      var base = getDispoBaseUrl();
      var url = API_BASE + '/api/job?id=' + encodeURIComponent(jobId);
      if (base) {
        url += '&enrich_anlagenstamm=1&base_url=' + encodeURIComponent(base);
        var u = getDispoUsername(), p = getDispoPassword();
        if (u) url += '&serverUsername=' + encodeURIComponent(u);
        if (p) url += '&serverPassword=' + encodeURIComponent(p);
      }
      fetch(url, { headers: { 'X-Technician-Id': String(techId) } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.job) { showJob(null); return; }
          showJob(data.job);
        })
        .catch(function (e) {
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
          } else {
            loadLocal();
          }
        })
        .catch(function () { loadLocal(); });
    } else {
      loadLocal();
    }
  }

  function closeJobDetailsModal() {
    var modal = document.getElementById('modalJobDetails');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
    }
    jobDetailsJobId = null;
  }

  function renderJobDetailsContent(job) {
    var v = function (x) { return (x != null && String(x).trim() !== '' ? escapeHtml(String(x).trim()) : '–'); };
    var start = (job.start_datetime || '').slice(0, 16).replace('T', ' ');
    var end = (job.end_datetime || '').slice(0, 16).replace('T', ' ');
    var countryRaw = (job.country || '').trim();
    var countryCode = normalizeCountryToCode(job.country);
    var countryPart = countryCode ? (countryFlagImg(countryCode) + (countryRaw ? ' ' + escapeHtml(countryRaw) : ' ' + countryCode)) : (countryRaw ? escapeHtml(countryRaw) : '');
    var addressParts = [
      (job.street || '').trim(),
      (job.house_number || '').trim(),
      [ (job.zip || '').trim(), (job.city || '').trim() ].filter(Boolean).join(' '),
      countryPart,
      (job.address_extra_1 || '').trim(),
      (job.address_extra_2 || '').trim()
    ].filter(Boolean);
    var addressLine = addressParts.length ? addressParts.join(', ') : '–';

    var leistungRows = [];
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
    if (leistungRows.length === 0) {
      leistungRows.push({ fabrikationsnummer: '', type: '', leistung: '', nenngeschwindigkeit: '', kraftaufnehmer: '', dms_nr: '', tacho: '', elektronik: '', material: '', position: '' });
    }

    var html = '<div class="modal-detail-grid">';
    html += '<div class="modal-detail-section"><h4>Auftrag</h4><dl class="modal-detail-dl">';
    html += '<dt>Auftragsnummer</dt><dd>' + v(job.job_number) + '</dd>';
    html += '<dt>Typ</dt><dd>' + v(job.job_type) + '</dd>';
    html += '<dt>Zeitraum</dt><dd>' + (start && end ? start + ' – ' + end : v(job.start_datetime)) + '</dd>';
    html += '<dt>Status</dt><dd>' + v(job.status) + '</dd>';
    if (job.description) html += '<dt>Beschreibung</dt><dd>' + v(job.description) + '</dd>';
    html += '</dl></div>';
    html += '<div class="modal-detail-section"><h4>Kunde</h4><dl class="modal-detail-dl">';
    html += '<dt>Name</dt><dd>' + v(job.customer_name) + '</dd>';
    html += '<dt>Straße</dt><dd>' + v(job.customer_street) + ' ' + v(job.customer_house_number) + '</dd>';
    html += '<dt>Ort</dt><dd>' + v(job.customer_zip) + ' ' + v(job.customer_city) + '</dd>';
    html += '<dt>Telefon</dt><dd>' + v(job.customer_phone) + '</dd>';
    html += '</dl></div>';
    html += '<div class="modal-detail-section"><h4>Auftragsadresse</h4><p class="modal-address">' + addressLine + '</p></div>';
    html += '<div class="modal-detail-section"><h4>Kontakt</h4><dl class="modal-detail-dl">';
    html += '<dt>Ansprechpartner</dt><dd>' + v(job.contact_person) + '</dd>';
    html += '<dt>Telefon</dt><dd>' + v(job.contact_phone) + '</dd>';
    html += '<dt>E-Mail</dt><dd>' + v(job.contact_email) + '</dd>';
    html += '</dl></div>';
    html += '</div>';

    html += '<div class="modal-detail-section"><h4>Auftrag: ERP-Nummer / Bestellnummer</h4>';
    html += '<dl class="modal-detail-dl"><dt>ERP-Nummer (vom Auftrag)</dt><dd>' + v(job.eap_nummer) + '</dd>';
    html += '<dt>Bestellnummer (vom Auftrag)</dt><dd>' + v(job.bestellnummer) + '</dd></dl>';
    html += '<h4 style="margin-top:1rem">Leistungsdaten (wie Anlagenstamm)</h4>';
    html += '<table class="modal-leistung-table"><thead><tr>';
    html += '<th>Fabrikationsnummer</th><th>Type</th><th>Leistung</th><th>Nenngeschwindigkeit</th><th>Kraftaufnehmer</th><th>DMS Nr.</th><th>Tacho</th><th>Elektronik</th><th>Material</th><th>Position</th>';
    html += '</tr></thead><tbody id="modalLeistungTbody">';
    var attr = function (x) { return escapeHtml(String(x == null ? '' : x)).replace(/"/g, '&quot;'); };
    leistungRows.forEach(function (row) {
      html += '<tr><td><input type="text" value="' + attr(row.fabrikationsnummer) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.type) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.leistung) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.nenngeschwindigkeit) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.kraftaufnehmer) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.dms_nr) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.tacho) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.elektronik) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.material) + '"></td>';
      html += '<td><input type="text" value="' + attr(row.position) + '"></td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="modal-leistung-actions">';
    html += '<button type="button" class="btn btn-ghost" data-action="add-leistung-row">Zeile hinzufügen</button>';
    html += '<button type="button" class="btn btn-primary" data-action="save-leistung">Speichern</button>';
    html += '</div></div>';
    return html;
  }

  function addLeistungRow() {
    var tbody = document.getElementById('modalLeistungTbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    for (var i = 0; i < 10; i++) {
      var td = document.createElement('td');
      var input = document.createElement('input');
      input.type = 'text';
      input.value = '';
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  function saveLeistungDaten() {
    var jobId = jobDetailsJobId;
    if (!jobId) return;
    var tbody = document.getElementById('modalLeistungTbody');
    if (!tbody) return;
    var rows = tbody.getElementsByTagName('tr');
    var arr = [];
    for (var i = 0; i < rows.length; i++) {
      var inputs = rows[i].getElementsByTagName('input');
      if (inputs.length >= 10) {
        arr.push({
          fabrikationsnummer: inputs[0].value.trim(),
          type: inputs[1].value.trim(),
          leistung: inputs[2].value.trim(),
          nenngeschwindigkeit: inputs[3].value.trim(),
          kraftaufnehmer: inputs[4].value.trim(),
          dms_nr: inputs[5].value.trim(),
          tacho: inputs[6].value.trim(),
          elektronik: inputs[7].value.trim(),
          material: inputs[8].value.trim(),
          position: inputs[9].value.trim()
        });
      }
    }
    api('/api/job', {
      method: 'PATCH',
      body: JSON.stringify({ job_id: parseInt(jobId, 10), fabrikationsnummern: JSON.stringify(arr) })
    }).then(function () {
      var content = document.getElementById('modalJobDetailsContent');
      if (content) content.innerHTML = '<span class="empty">Gespeichert. Lade neu…</span>';
      var url = API_BASE + '/api/job?id=' + encodeURIComponent(jobId);
      fetch(url, { headers: { 'X-Technician-Id': String(getTechId()) } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.job && content) content.innerHTML = renderJobDetailsContent(data.job);
          bindLeistungActions();
        })
        .catch(function () { if (content) content.innerHTML = '<span class="empty">Fehler beim Neuladen.</span>'; });
      // Wenn online, Änderungen sofort zum Dispo-Server schieben; sonst bleiben sie in pending_changes für den nächsten Sync.
      if (typeof checkConnectionAndSync === 'function') {
        try { checkConnectionAndSync(); } catch (e) {}
      }
    }).catch(function (e) {
      alert('Speichern fehlgeschlagen: ' + e.message);
    });
  }

  function bindLeistungActions() {
    var content = document.getElementById('modalJobDetailsContent');
    if (!content) return;
    var btnAdd = content.querySelector('[data-action="add-leistung-row"]');
    var btnSave = content.querySelector('[data-action="save-leistung"]');
    if (btnAdd) btnAdd.addEventListener('click', addLeistungRow);
    if (btnSave) btnSave.addEventListener('click', saveLeistungDaten);
  }

  async function updateJobStatus(jobId, status) {
    try {
      await api('/api/job', {
        method: 'PATCH',
        body: JSON.stringify({ job_id: parseInt(jobId, 10), status }),
      });
      loadJobsAndAbsences();
    } catch (e) {
      alert('Fehler: ' + e.message);
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
      const [jRes, aRes] = await Promise.all([
        fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json()),
        fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then((r) => r.json())
      ]);
      renderJobs(jRes);
      renderAbsences(aRes);
      updateTechnicianName();
    } catch (e) {
      document.getElementById('jobsList').innerHTML = '<span class="empty">Fehler: ' + e.message + '</span>';
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
    if (state === 'online') {
      badge.textContent = 'Online';
      badge.className = 'online-badge';
      badge.removeAttribute('title');
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
      const check = await fetch(API_BASE + '/api/check_connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: base,
          technicianId: techId,
          serverUsername: getServerUsername(),
          serverPassword: getServerPassword()
        })
      }).then((r) => r.json());
      if (check.ok) {
        setConnectionBadge('online');
        const range = getSyncDateRange();
        const auth = { baseUrl: base, technicianId: techId, serverUsername: getServerUsername(), serverPassword: getServerPassword() };
        await fetch(API_BASE + '/api/sync_pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...auth, date_from: range.date_from, date_to: range.date_to })
        }).then((r) => r.json()).then((d) => { if (!d.ok) throw new Error(d.error); });
        try {
          await fetch(API_BASE + '/api/sync_push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(auth)
          }).then((r) => r.json()).then((d) => { if (!d.ok) throw new Error(d.error); });
        } catch (e) { /* Push fehlgeschlagen, Pull-Daten bleiben */ }
      } else {
        setConnectionBadge('offline', check.error || 'Verbindung fehlgeschlagen');
      }
    } catch (e) {
      setConnectionBadge('offline', e && e.message ? e.message : 'Verbindung fehlgeschlagen');
    }
    setNextSyncTime();
    loadJobsAndAbsences();
  }

  function renderAbsences(data) {
    const list = document.getElementById('absencesList');
    const absences = data.absences || [];
    if (absences.length === 0) {
      list.innerHTML = '<span class="empty">Keine Abwesenheiten.</span>';
      return;
    }
    list.innerHTML = absences.map((a) => {
      const start = (a.start_datetime || '').slice(0, 10);
      const end = (a.end_datetime || '').slice(0, 10);
      return '<div class="job"><div class="job-info"><strong>' + start + ' – ' + end + '</strong><br><span class="job-meta">' + (a.type || '') + '</span></div></div>';
    }).join('');
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

  loadSettingsFromStorage();
  checkConnectionAndSync();
  startSyncInterval();
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

  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    saveSettingsToStorage();
    startSyncInterval();
    updateTechnicianName();
    const base = getServerUrl().trim();
    const techId = getTechId();
    if (base && techId) {
      checkConnectionAndSync();
    }
    const hint = document.getElementById('settingsSavedHint');
    hint.textContent = 'Gespeichert.';
    clearTimeout(hint._hideTimeout);
    hint._hideTimeout = setTimeout(() => { hint.textContent = ''; }, 2000);
  });

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
      hint.textContent = 'Fertig.';
      clearTimeout(hint._syncHide);
      hint._syncHide = setTimeout(function () { hint.textContent = ''; }, 3000);
    }).catch(function (e) {
      hint.textContent = 'Fehler: ' + (e && e.message ? e.message : 'Unbekannt');
      clearTimeout(hint._syncHide);
      hint._syncHide = setTimeout(function () { hint.textContent = ''; }, 5000);
    });
  });

  var elJobClose = document.getElementById('modalJobDetailsClose');
  if (elJobClose) elJobClose.addEventListener('click', closeJobDetailsModal);
  var elJobOverlay = document.getElementById('modalJobDetails');
  if (elJobOverlay) elJobOverlay.addEventListener('click', function (e) {
    if (e.target.id === 'modalJobDetails') closeJobDetailsModal();
  });

  // —— Kalender ———
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

  function showView(name) {
    const viewStart = document.getElementById('viewStart');
    const viewEinstellungen = document.getElementById('viewEinstellungen');
    viewStart.classList.remove('only-left', 'only-right', 'hidden');
    viewEinstellungen.classList.remove('active');
    if (name === 'einstellungen') {
      viewStart.classList.add('hidden');
      viewEinstellungen.classList.add('active');
      updateTechnicianName();
      return;
    }
    if (name === 'auftraege') viewStart.classList.add('only-left');
    else if (name === 'kalender') viewStart.classList.add('only-right');
    if (name === 'kalender' || name === 'start') loadCalendarMonth();
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
      if (!base) {
        setCalendarError('Dispo-Server-URL eintragen und „Alle Techniker“ nutzen.');
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
        absences = data.absences || [];
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
        jobs = jobs.map(function (j) {
          var tid = j.technician_id != null ? j.technician_id : j.technicianId;
          var info = techById[tid];
          return Object.assign({}, j, {
            technician_name: info ? info.name : ('Techniker ' + tid),
            technician_color: info ? info.color : '#4a90e2'
          });
        });
        absences = absences.map(function (a) {
          var tid = a.technician_id != null ? a.technician_id : a.technicianId;
          var info = techById[tid];
          return Object.assign({}, a, {
            technician_name: info ? info.name : ('Techniker ' + tid),
            technician_color: info ? info.color : '#6c757d'
          });
        });
        var myTechId = getTechId();
        if (myTechId) {
          try {
            var params = { technician_id: myTechId, date_from: start, date_to: end };
            var local = await Promise.all([
              fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); }),
              fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(myTechId) } }).then(function (r) { return r.json(); })
            ]);
            var serverJobIds = {};
            jobs.forEach(function (j) { serverJobIds[j.id] = true; if (j.server_id != null) serverJobIds[j.server_id] = true; });
            (local[0].jobs || []).forEach(function (j) {
              if (!serverJobIds[j.id] && !serverJobIds[j.server_id]) {
                jobs.push(Object.assign({}, j, { technician_id: myTechId, technician_name: techById[myTechId] ? techById[myTechId].name : ('Techniker ' + myTechId), technician_color: techById[myTechId] ? techById[myTechId].color : '#4a90e2' }));
              }
            });
            var serverAbsIds = {};
            absences.forEach(function (a) { serverAbsIds[a.id] = true; serverAbsIds[a.server_id] = true; });
            (local[1].absences || []).forEach(function (a) {
              if (!serverAbsIds[a.id] && !serverAbsIds[a.server_id]) {
                absences.push(Object.assign({}, a, { technician_id: myTechId, technician_name: techById[myTechId] ? techById[myTechId].name : ('Techniker ' + myTechId), technician_color: techById[myTechId] ? techById[myTechId].color : '#6c757d' }));
              }
            });
          } catch (e) { /* lokale Termine optional */ }
        }
      } catch (e) {
        renderCalendarGrid(gridStart, gridEnd, [], [], null);
        setCalendarError('Kalender laden fehlgeschlagen: ' + e.message);
        return;
      }
    } else {
      const techId = getTechId();
      if (!techId) {
        setCalendarError('Monteur-ID eingeben.');
        return;
      }
      try {
        const params = { technician_id: techId, date_from: start, date_to: end };
        const [jRes, aRes] = await Promise.all([
          fetch(API_BASE + '/api/my_jobs?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then(r => r.json()),
          fetch(API_BASE + '/api/my_absences?' + qs(params), { headers: { 'X-Technician-Id': String(techId) } }).then(r => r.json())
        ]);
        jobs = (jRes.jobs || []).map(j => ({ ...j, technician_id: techId, technician_name: '', technician_color: '#4a90e2' }));
        absences = (aRes.absences || []).map(a => ({ ...a, technician_id: techId, technician_name: '', technician_color: '#6c757d' }));
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

  function assignLanes(spans) {
    const lanes = [];
    spans.sort((a, b) => a.startCol - b.startCol);
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

  /** Datum/Zeit formatieren (für Tooltip). */
  function formatJobTime(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    UA: 'Europe/Kyiv', UG: 'Africa/Kampala', UM: 'Pacific/Midway', US: 'America/New_York',
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
    UKR: 'Europe/Kyiv', UGA: 'Africa/Kampala', UMI: 'Pacific/Midway', USA: 'America/New_York',
    URY: 'America/Montevideo', UZB: 'Asia/Tashkent', VAT: 'Europe/Vatican', VCT: 'America/St_Vincent',
    VEN: 'America/Caracas', VGB: 'America/Virgin', VIR: 'America/Virgin', VNM: 'Asia/Ho_Chi_Minh',
    VUT: 'Pacific/Efate', WLF: 'Pacific/Wallis', WSM: 'Pacific/Apia', YEM: 'Asia/Aden',
    MYT: 'Indian/Mayotte', ZAF: 'Africa/Johannesburg', ZMB: 'Africa/Lusaka', ZWE: 'Africa/Harare',
    FRO: 'Atlantic/Faroe', HMD: 'Indian/Kerguelen',
    UK: 'Europe/London'
  };

  /** Zeitverschiebung von Österreich zur Zeit im Auftragsland. countryCode = 2 oder 3 Buchstaben. */
  function getTimezoneLabel(countryCode) {
    try {
      if (!countryCode || countryCode.length < 2) return null;
      var code = countryCode.toUpperCase().slice(0, 3);
      var tz = countryToTz[code] || countryToTz[code.slice(0, 2)];
      if (!tz) return null;
      var austria = getTimezoneOffsetHours('Europe/Vienna');
      var land = getTimezoneOffsetHours(tz);
      if (austria == null || land == null) return null;
      var diff = land - austria;
      var landName = code;
      try {
        landName = new Intl.DisplayNames(['de'], { type: 'region' }).of(code) || landName;
      } catch (_) { }
      var diffStr = diff === 0 ? '0 h' : (diff > 0 ? '+' : '') + diff + ' h';
      return 'Zeitverschiebung nach ' + landName + ': ' + diffStr;
    } catch (_) { return null; }
  }

  /** Firma, Ort, Länderkürzel für Kalender-Balken (Aufträge). Tooltip: Zeitverschiebung nur zwischen Österreich und Auftragsland (0 h, +1 h, -1 h …). */
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
    const label = maxLen && full.length > maxLen ? full.substring(0, maxLen) : full;

    let title = full || firma || 'Auftrag';
    const startStr = formatJobTime(job.start_datetime);
    const endStr = formatJobTime(job.end_datetime);
    if (startStr || endStr) {
      title += '\nZeitraum: ' + (startStr || '?') + ' – ' + (endStr || '?');
    }
    var tzLabel = null;
    try {
      tzLabel = getTimezoneLabel(land2 || land);
    } catch (_) { }
    if (tzLabel) title += '\n' + tzLabel;

    return { label: label || 'Auftrag', title };
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

    let html = '<div class="cal-grid">';
    html += '<div class="cal-head">KW</div>';
    weekDays.forEach(d => { html += '<div class="cal-head">' + d + '</div>'; });

    for (let w = 0; w < 6; w++) {
      const weekStart = new Date(gridStart);
      weekStart.setDate(weekStart.getDate() + w * 7);
      weekStart.setHours(12, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const weekStartYmd = toYmd(weekStart);
      const weekEndYmd = toYmd(weekEnd);
      const kw = getWeekNum(weekStart);

      const spanItems = [];
      jobs.filter(isMultiDay).forEach(j => {
        const sp = getWeekSpan(j, weekStartYmd, weekEndYmd);
        if (sp) spanItems.push({ ...sp, item: j, type: 'job' });
      });
      absences.filter(isMultiDay).forEach(a => {
        const sp = getWeekSpan(a, weekStartYmd, weekEndYmd);
        if (sp) spanItems.push({ ...sp, item: a, type: 'absence' });
      });
      assignLanes(spanItems);
      const numLanes = spanItems.length ? Math.max(...spanItems.map(s => s.lane)) + 1 : 0;
      const spanLaneHeight = numLanes * 22;

      html += '<div class="cal-head">' + kw + '</div>';
      for (let d = 0; d < 7; d++) {
        const cellDate = new Date(weekStart);
        cellDate.setDate(cellDate.getDate() + d);
        cellDate.setHours(12, 0, 0, 0);
        const ymd = toYmd(cellDate);
        const otherMonth = cellDate.getMonth() !== currentMonth;
        const isToday = ymd === todayYmd;
        html += '<div class="cal-cell' + (otherMonth ? ' other-month' : '') + (isToday ? ' today' : '') + '">';
        html += '<div class="cal-daynum">' + cellDate.getDate() + '</div>';
        html += '<div class="cal-cell-bars">';
        const dayJobs = jobs.filter(j => ymd >= startYmd(j) && ymd <= endYmd(j) && !isMultiDay(j));
        const dayAbs = absences.filter(a => ymd >= startYmd(a) && ymd <= endYmd(a) && !isMultiDay(a));
        dayJobs.forEach(j => {
          const bar = jobBarText(j, 14);
          const color = j.technician_color || '#4a90e2';
          html += '<div class="cal-bar job" style="background:' + color + '" title="' + escapeHtml(bar.title) + '">' + escapeHtml(bar.label) + '</div>';
        });
        dayAbs.forEach(a => {
          const label = (a.type || 'Abwesenheit').substring(0, 12);
          html += '<div class="cal-bar absence" style="--stripes:' + (a.technician_color || '#999') + '" title="' + escapeHtml(a.type || '') + '">' + escapeHtml(label) + '</div>';
        });
        html += '</div>';
        html += '<div class="cal-cell-span-lane" style="min-height:' + spanLaneHeight + 'px">';
        // Alle mehrtägigen Balken, die an diesem Tag sichtbar sind – je ein Segment pro Zelle (Breite 100%), gleiche Lane → keine Überlappung
        spanItems.filter(s => d >= s.startCol && d < s.startCol + s.span).forEach(({ lane, item, type }) => {
          const bar = type === 'job' ? jobBarText(item, 40) : { label: (item.type || 'Abwesenheit').substring(0, 20), title: (item.type || '') };
          const color = item.technician_color || (type === 'job' ? '#4a90e2' : '#999');
          const cls = type === 'job' ? 'cal-bar job cal-bar-span' : 'cal-bar absence cal-bar-span';
          const style = type === 'job'
            ? 'background:' + color + '; top:' + (lane * 22) + 'px; width:100%;'
            : '--stripes:' + color + '; top:' + (lane * 22) + 'px; width:100%;';
          html += '<div class="' + cls + '" style="' + style + '" title="' + escapeHtml(bar.title) + '">' + escapeHtml(bar.label) + '</div>';
        });
        html += '</div>';
        html += '</div>';
      }
    }
    html += '</div>';
    const calGrid = document.getElementById('calGrid');
    if (calGrid) calGrid.innerHTML = html;

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

  document.getElementById('btnViewStart').addEventListener('click', () => showView('start'));
  document.getElementById('btnViewAuftraege').addEventListener('click', () => showView('auftraege'));
  document.getElementById('btnViewKalender').addEventListener('click', () => showView('kalender'));
  document.getElementById('btnViewEinstellungen').addEventListener('click', () => showView('einstellungen'));

  document.getElementById('calPrev').addEventListener('click', () => {
    calCurrentMonth.setMonth(calCurrentMonth.getMonth() - 1);
    loadCalendarMonth();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calCurrentMonth.setMonth(calCurrentMonth.getMonth() + 1);
    loadCalendarMonth();
  });
  document.getElementById('calShowAllTech').addEventListener('change', () => loadCalendarMonth());
})();
