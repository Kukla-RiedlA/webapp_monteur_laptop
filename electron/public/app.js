(function () {
  const API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  const getTechId = () => parseInt(document.getElementById('technicianId').value, 10) || 0;
  const getServerUrl = () => (document.getElementById('serverUrl').value || '').trim();
  const getServerUsername = () => (document.getElementById('serverUsername') && document.getElementById('serverUsername').value || '').trim();
  const getServerPassword = () => (document.getElementById('serverPassword') && document.getElementById('serverPassword').value || '');

  const SETTINGS_KEYS = { serverUrl: 'monteur_serverUrl', technicianId: 'monteur_technicianId', serverUsername: 'monteur_serverUsername', serverPassword: 'monteur_serverPassword', syncIntervalMinutes: 'monteur_syncIntervalMinutes' };

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

  function countryFlagImg(code) {
    if (!code || code.length !== 2) return '';
    const c = (code || '').toLowerCase();
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
      const land = (j.country || '').trim().toUpperCase().slice(0, 2);
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

  function setConnectionBadge(state) {
    const badge = document.getElementById('connectionBadge');
    if (state === 'online') {
      badge.textContent = 'Online';
      badge.className = 'online-badge';
    } else if (state === 'local') {
      badge.textContent = 'Lokal';
      badge.className = 'local-badge';
    } else {
      badge.textContent = 'Offline';
      badge.className = 'offline-badge';
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
        setConnectionBadge('offline');
      }
    } catch (e) {
      setConnectionBadge('offline');
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

  /** Zeitzone des Geräts für Tooltip (Zeitverschiebung). */
  function getTimezoneLabel() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = -new Date().getTimezoneOffset() / 60;
      const sign = offset >= 0 ? '+' : '';
      return tz + ' (UTC' + sign + offset + ')';
    } catch (_) {
      const offset = -new Date().getTimezoneOffset() / 60;
      const sign = offset >= 0 ? '+' : '';
      return 'UTC' + sign + offset;
    }
  }

  /** Firma, Ort, Länderkürzel für Kalender-Balken (Aufträge). Tooltip: alles + Zeitraum + Zeitverschiebung. */
  function jobBarText(job, maxLen) {
    const firma = (job.customer_name || job.customerName || job.job_number || 'Auftrag').trim();
    const ort = (job.city || '').trim();
    const land = (job.country || '').trim().toUpperCase().slice(0, 2);
    const parts = [firma];
    if (ort) parts.push(ort);
    if (land) parts.push(land);
    const full = parts.join(', ');
    const label = maxLen && full.length > maxLen ? full.substring(0, maxLen) : full;

    let title = full || firma;
    const startStr = formatJobTime(job.start_datetime);
    const endStr = formatJobTime(job.end_datetime);
    if (startStr || endStr) {
      title += '\nZeitraum: ' + (startStr || '?') + ' – ' + (endStr || '?');
    }
    title += '\nZeitverschiebung: ' + getTimezoneLabel();

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
        spanItems.filter(s => s.startCol === d).forEach(({ span, lane, item, type }) => {
          const bar = type === 'job' ? jobBarText(item, 40) : { label: (item.type || 'Abwesenheit').substring(0, 20), title: (item.type || '') };
          const color = item.technician_color || (type === 'job' ? '#4a90e2' : '#999');
          const cls = type === 'job' ? 'cal-bar job cal-bar-span' : 'cal-bar absence cal-bar-span';
          const w = span <= 1 ? '100%' : 'calc(' + span + ' * 100% + ' + (span - 1) + ' * 2px)';
          const style = type === 'job'
            ? 'background:' + color + '; top:' + (lane * 22) + 'px; width:' + w + ';'
            : '--stripes:' + color + '; top:' + (lane * 22) + 'px; width:' + w + ';';
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
