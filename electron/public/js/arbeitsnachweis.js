/**
 * Arbeitsnachweis – Laptop-Formular (Belegtyp arbeitsnachweis).
 */
(function () {
  var API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var pad = null;
  var jobData = null;
  var jobsCache = [];
  var signedFingerprint = '';
  var lastCustomerSig = false;
  var persistTimer = null;
  var jobLoadBusy = false;

  function el(id) { return document.getElementById(id); }
  function lang() {
    var r = document.querySelector('input[name="anLang"]:checked');
    return r && r.value === 'en' ? 'en' : 'de';
  }
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function getHeaders() {
    var h = { Accept: 'application/json' };
    try {
      var u = window.getDispoUsername && window.getDispoUsername();
      var p = window.getDispoPassword && window.getDispoPassword();
      if (u && p) h.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(u + ':' + p)));
    } catch (e) {}
    var tid = window.getTechId && window.getTechId();
    if (tid) h['X-Technician-Id'] = String(tid);
    return h;
  }
  function authHeaders() {
    return Object.assign({ 'Content-Type': 'application/json' }, getHeaders());
  }
  function anLocalGetUrl(params) {
    var q = new URLSearchParams(params || {});
    var base = (window.getDispoBaseUrl && window.getDispoBaseUrl()) || '';
    if (base) q.set('baseUrl', base);
    return API_BASE + '/api/arbeitsnachweis?' + q.toString();
  }
  function technicianDisplayName() {
    var nameEl = document.getElementById('technicianName');
    if (!nameEl) return '';
    return String(nameEl.value || nameEl.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function findCachedJob(localId, serverId) {
    for (var i = 0; i < jobsCache.length; i++) {
      var j = jobsCache[i];
      var lid = parseInt(j.id, 10) || 0;
      var sid = dispoJobId(j);
      if ((localId && lid === localId) || (serverId && (sid === serverId || lid === serverId)) || (localId && sid === localId)) {
        return j;
      }
    }
    return null;
  }
  function applyJobKopf(job) {
    if (!job) return;
    jobData = job;
    el('anCustomer').value = job.customer_name || job.customer || el('anCustomer').value || '';
    var site = siteFromJob(job);
    if (site) el('anSite').value = site;
    var fabs = normalizeFabs(job.fabrikationsnummern);
    if (fabs.length || !currentFabs().length) renderFabs(fabs);
    var contacts = contactsFromJob(job);
    fillContacts(contacts);
  }
  function flagOn(v) {
    return v === true || v === 1 || v === '1';
  }
  function setRadio(name, value) {
    var r = document.querySelector('input[name="' + name + '"][value="' + String(value) + '"]');
    if (r) r.checked = true;
  }
  function applyStatusUi(data) {
    data = data || {};
    var doc = data.document || {};
    var an = data.arbeitsnachweis || {};
    var st = data.status || doc.status || 'entwurf';
    var num = data.number || doc.number || '';
    if (an.timesheet_applied || data.timesheet_applied) {
      if (el('anTimesheetApplied')) el('anTimesheetApplied').value = flagOn(an.timesheet_applied) || flagOn(data.timesheet_applied) ? '1' : el('anTimesheetApplied').value;
    }
    var hint = (num ? num + ' · ' : '') + st;
    if (data.synced === false || data.offline) {
      hint += lang() === 'en' ? ' · saved locally' : ' · lokal gespeichert';
    }
    if (el('anAutosaveHint')) el('anAutosaveHint').textContent = hint;
    var tsBtn = el('btnAnTimesheet');
    if (tsBtn) {
      var applied = el('anTimesheetApplied') && el('anTimesheetApplied').value === '1';
      tsBtn.textContent = applied
        ? (lang() === 'en' ? 'Already transferred to timesheet' : 'Bereits in Zeitschreibung')
        : (lang() === 'en' ? 'Transfer hours to timesheet' : 'Zeiten in Zeitschreibung übernehmen');
    }
  }
  function applyPayload(data) {
    if (!data) return;
    var doc = data.document || {};
    var an = data.arbeitsnachweis || {};
    var items = Array.isArray(data.items) ? data.items : [];
    if (!data.document && data.job_id) {
      doc = data;
      an = data.arbeitsnachweis || {};
      items = data.items || [];
    }
    if (data.local_id && el('anLocalDocId')) el('anLocalDocId').value = String(data.local_id);
    else if (doc.id && (doc.server_id != null || doc.local_uuid)) {
      if (el('anLocalDocId')) el('anLocalDocId').value = String(doc.id);
    }
    var serverDocId = data.server_id || data.document_id || doc.server_id || 0;
    if (!serverDocId && data.document && doc.id && !doc.local_job_id) serverDocId = doc.id;
    if (serverDocId) el('anDocumentId').value = String(serverDocId);
    if (doc.local_uuid) el('anLocalUuid').value = doc.local_uuid;
    else if (data.local_uuid) el('anLocalUuid').value = data.local_uuid;
    if (doc.content_version) el('anContentVersion').value = String(doc.content_version);
    else if (data.content_version) el('anContentVersion').value = String(data.content_version);
    var jobId = doc.server_job_id || doc.job_id || data.job_id;
    if (jobId && el('anJob')) {
      el('anJob').value = String(jobId);
      if (el('anJob').value !== String(jobId)) {
        var opts = el('anJob').options;
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].value === String(jobId) || opts[i].dataset.serverId === String(jobId) || opts[i].dataset.localId === String(jobId)) {
            el('anJob').selectedIndex = i;
            break;
          }
        }
      }
    }
    setRadio('anLang', (doc.language || data.language) === 'en' ? 'en' : 'de');
    applyLang();
    el('anCustomer').value = data.customer_name || doc.customer_name || el('anCustomer').value || '';
    if (an.site) el('anSite').value = an.site;
    if (an.technician_name) el('anTech').value = an.technician_name;
    el('anCar').value = an.car_info || '';
    el('anLiving').value = an.living_costs || '';
    el('anStartKm').value = an.start_km != null && an.start_km !== '' ? an.start_km : '';
    el('anEndKm').value = an.end_km != null && an.end_km !== '' ? an.end_km : '';
    el('anTotalKm').value = an.total_km != null && an.total_km !== '' ? an.total_km : '';
    if (el('anTotalKm').value === '') updateTotalKm();
    setRadio('anOvernight', flagOn(an.naechtigung_beigestellt) ? '1' : '0');
    el('anRemarks').value = an.remarks || '';
    if (el('anTimesheetApplied')) el('anTimesheetApplied').value = flagOn(an.timesheet_applied) ? '1' : '0';
    if (el('anSaveContact')) el('anSaveContact').checked = flagOn(data.save_contact) || flagOn(an.save_contact);
    if (el('anSignerName') && (data.signer_name || an.signer_name)) el('anSignerName').value = data.signer_name || an.signer_name;
    if (el('anSignerEmail') && (data.signer_email || an.signer_email)) el('anSignerEmail').value = data.signer_email || an.signer_email;
    renderFabs(an.fabrikationsnummern);
    var work = items.filter(function (r) { return r && r.item_type === 'arbeitszeile'; });
    var parts = items.filter(function (r) { return r && r.item_type === 'ersatzteil'; });
    el('anWorkBody').innerHTML = '';
    if (work.length) work.forEach(function (r) { addWorkRow(r); });
    else addWorkRow({ item_date: todayIso() });
    el('anPartsBody').innerHTML = '';
    parts.forEach(function (r) { addPartRow(r); });
    applyStatusUi(data);
  }
  function dispoJobId(job) {
    if (!job) return 0;
    var sid = job.server_id != null && String(job.server_id).trim() !== '' ? job.server_id : job.id;
    return parseInt(sid, 10) || 0;
  }
  function proxy(action, opts) {
    opts = opts || {};
    var baseUrl = (window.getDispoBaseUrl && window.getDispoBaseUrl()) || '';
    return fetch(API_BASE + '/api/laptop_arbeitsnachweis_proxy', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        baseUrl: baseUrl,
        action: action,
        method: opts.method || (opts.payload ? 'POST' : 'GET'),
        queryParams: opts.queryParams || {},
        payload: opts.payload || null
      })
    }).then(function (r) { return r.json(); });
  }
  function draftKey() {
    return 'kukla_an_draft_' + (el('anLocalUuid').value || 'new');
  }
  function saveLocalDraft() {
    try {
      localStorage.setItem(draftKey(), JSON.stringify(collectPayload()));
    } catch (e) {}
  }
  function num(v) {
    var n = parseFloat(String(v || '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  function splitTime(s) {
    var t = String(s || '').trim();
    var m = t.match(/^(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
    if (m) return { from: padHm(m[1]), to: padHm(m[2]) };
    if (/^\d{1,2}:\d{2}$/.test(t)) return { from: padHm(t), to: '' };
    return { from: '', to: '' };
  }
  function padHm(s) {
    var t = String(s || '').trim();
    var m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return ('0' + m[1]).slice(-2) + ':' + m[2];
    m = t.match(/^(\d{3,4})$/);
    if (m) {
      var d = m[1];
      if (d.length === 3) d = '0' + d;
      return d.slice(0, 2) + ':' + d.slice(2);
    }
    return t;
  }
  function formatTimeTyping(raw) {
    var s = String(raw || '').replace(/[^\d:]/g, '');
    if (s.indexOf(':') === -1 && s.length > 2) s = s.slice(0, 2) + ':' + s.slice(2, 4);
    return s.slice(0, 5);
  }
  function bindTimeInput(inp) {
    if (!inp || inp.dataset.timeBound) return;
    inp.dataset.timeBound = '1';
    inp.addEventListener('input', function () {
      var next = formatTimeTyping(inp.value);
      if (next !== inp.value) inp.value = next;
    });
    inp.addEventListener('blur', function () {
      var t = padHm(inp.value);
      if (/^\d{2}:\d{2}$/.test(t)) inp.value = t;
    });
  }
  function joinTime(from, to) {
    from = padHm((from || '').trim());
    to = padHm((to || '').trim());
    if (from && to) return from + '–' + to;
    return from || to || '';
  }
  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }
  function addOneDay(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return todayIso();
    var d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function nextWorkDate() {
    var last = '';
    el('anWorkBody').querySelectorAll('[data-f=date]').forEach(function (inp) {
      if (inp.value) last = inp.value;
    });
    return last ? addOneDay(last) : todayIso();
  }
  function normalizeFabs(raw) {
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        var p = JSON.parse(raw);
        list = Array.isArray(p) ? p : [p];
      } catch (e) {
        list = String(raw).split(/[,;]+/).map(function (x) { return { fabrikationsnummer: x.trim(), type: '' }; });
      }
    }
    return list.map(function (x) {
      if (x && typeof x === 'object') {
        return {
          fabrikationsnummer: String(x.fabrikationsnummer || x.fn || x.fab || x.nr || '').trim(),
          type: String(x.type || x.Type || x.typ || x.Typ || '').trim()
        };
      }
      return { fabrikationsnummer: String(x || '').trim(), type: '' };
    }).filter(function (r) { return r.fabrikationsnummer || r.type; });
  }
  function siteFromJob(job) {
    if (!job) return '';
    var lines = [];
    var name = String(job.endkunde || '').trim() || String(job.customer_name || '').trim();
    if (name) lines.push(name);
    var street = [job.street, job.house_number].map(function (x) { return String(x || '').trim(); }).filter(Boolean).join(' ');
    if (street) lines.push(street);
    var zipCity = [job.zip, job.city].map(function (x) { return String(x || '').trim(); }).filter(Boolean).join(' ');
    if (zipCity) lines.push(zipCity);
    var country = String(job.country || '').trim();
    if (country) lines.push(country);
    var extra1 = String(job.address_extra_1 || '').trim();
    if (extra1) lines.push(extra1);
    var extra2 = String(job.address_extra_2 || '').trim();
    if (extra2) lines.push(extra2);
    return lines.join(', ');
  }
  function contactName(c) {
    c = c || {};
    var cn = String(c.contact_name || c.contactName || '').trim();
    if (cn) return cn;
    return (String(c.first_name || '') + ' ' + String(c.last_name || '')).trim();
  }
  function contactEmail(c) {
    c = c || {};
    return String(c.email || c.contact_email || '').trim();
  }
  function contactsFromJob(job) {
    if (!job) return [];
    if (Array.isArray(job.job_contacts) && job.job_contacts.length) {
      return job.job_contacts.filter(function (c) {
        return contactName(c) || contactEmail(c);
      });
    }
    var name = String(job.baustellen_ansprechpartner || job.job_contact_name || job.contact_person || job.contact_name || job.ansprechpartner || '').trim();
    var email = String(job.job_contact_email || job.baustelle_email || job.contact_email || '').trim();
    if (name || email) return [{ contact_name: name, email: email }];
    return [];
  }
  function collectWork() {
    var rows = [];
    el('anWorkBody').querySelectorAll('tr').forEach(function (tr, i) {
      var d = tr.querySelector('[data-f=date]');
      var tf = tr.querySelector('[data-f=time_from]');
      var tt = tr.querySelector('[data-f=time_to]');
      var w = tr.querySelector('[data-f=works]');
      var n = tr.querySelector('[data-f=n]');
      var a = tr.querySelector('[data-f=u50]');
      var b = tr.querySelector('[data-f=u100]');
      if (!d) return;
      if (!d.value && !w.value && !num(n.value) && !num(a.value) && !num(b.value)) return;
      rows.push({
        item_type: 'arbeitszeile',
        sort_order: i,
        item_date: d.value || '',
        item_time: joinTime(tf && tf.value, tt && tt.value),
        description: (w && w.value) || '',
        normal_hours: num(n && n.value),
        overtime_50: num(a && a.value),
        overtime_100: num(b && b.value)
      });
    });
    return rows;
  }
  function collectParts() {
    var rows = [];
    el('anPartsBody').querySelectorAll('tr').forEach(function (tr, i) {
      var q = tr.querySelector('[data-f=qty]');
      var d = tr.querySelector('[data-f=des]');
      var t = tr.querySelector('[data-f=type]');
      var c = tr.querySelector('[data-f=comment]');
      if (!d || (!d.value && !num(q && q.value) && !(c && c.value))) return;
      rows.push({
        item_type: 'ersatzteil',
        sort_order: i,
        quantity: num(q && q.value),
        designation: d.value || '',
        type_no: (t && t.value) || '',
        description: (c && c.value) || ''
      });
    });
    return rows;
  }
  function currentFabs() {
    try {
      return normalizeFabs(JSON.parse(el('anFabsJson').value || '[]'));
    } catch (e) {
      return [];
    }
  }
  function collectPayload() {
    var start = el('anStartKm').value;
    var end = el('anEndKm').value;
    var total = el('anTotalKm').value;
    var overnight = document.querySelector('input[name="anOvernight"]:checked');
    var fabs = currentFabs();
    var snapFn = fabs.map(function (r) { return r.fabrikationsnummer; }).filter(Boolean).join(', ');
    var snapTy = fabs.map(function (r) { return r.type; }).filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
    return {
      id: parseInt(el('anDocumentId').value, 10) || 0,
      local_uuid: el('anLocalUuid').value,
      job_id: parseInt(el('anJob').value, 10) || 0,
      language: lang(),
      document_date: (collectWork()[0] && collectWork()[0].item_date) || todayIso(),
      customer_name: el('anCustomer').value,
      signer_name: el('anSignerName').value,
      signer_email: el('anSignerEmail').value,
      save_contact: el('anSaveContact').checked,
      timesheet_applied: !!(el('anTimesheetApplied') && el('anTimesheetApplied').value === '1'),
      arbeitsnachweis: {
        site: el('anSite').value,
        equipment_type: snapTy,
        fabrikationsnummer: snapFn,
        fabrikationsnummern: fabs,
        technician_name: el('anTech').value,
        car_info: el('anCar').value,
        living_costs: el('anLiving').value,
        start_km: start === '' ? null : parseInt(start, 10),
        end_km: end === '' ? null : parseInt(end, 10),
        total_km: total === '' ? null : parseInt(total, 10),
        total_km_manual: isTotalKmManual(),
        naechtigung_beigestellt: !!(overnight && overnight.value === '1'),
        remarks: el('anRemarks').value,
        timesheet_applied: !!(el('anTimesheetApplied') && el('anTimesheetApplied').value === '1')
      },
      items: collectWork().concat(collectParts())
    };
  }
  function fingerprint(p) {
    var copy = JSON.parse(JSON.stringify(p));
    delete copy.id;
    delete copy.local_uuid;
    delete copy.signer_name;
    delete copy.signer_email;
    delete copy.save_contact;
    return JSON.stringify(copy);
  }
  function autoGrowTextarea(el) {
    if (!el) return;
    el.style.overflow = 'hidden';
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 42) + 'px';
  }
  function bindAutoGrow(el) {
    if (!el || el.getAttribute('data-an-grow') === '1') return;
    el.setAttribute('data-an-grow', '1');
    el.addEventListener('input', function () { autoGrowTextarea(el); });
    autoGrowTextarea(el);
  }
  function addWorkRow(row) {
    row = row || {};
    var times = splitTime(row.item_time);
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="date" data-f="date"></td>' +
      '<td class="an-cell-center"><input type="text" class="an-input-time" data-f="time_from" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="08:00"></td>' +
      '<td class="an-cell-center"><input type="text" class="an-input-time" data-f="time_to" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="17:00"></td>' +
      '<td><textarea data-f="works" rows="2"></textarea></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="n" step="0.25" min="0" max="24"></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="u50" step="0.25" min="0" max="24"></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="u100" step="0.25" min="0" max="24"></td>' +
      '<td><button type="button" class="btn btn-ghost an-del">×</button></td>';
    tr.querySelector('[data-f=date]').value = row.item_date || '';
    tr.querySelector('[data-f=time_from]').value = times.from;
    tr.querySelector('[data-f=time_to]').value = times.to;
    bindTimeInput(tr.querySelector('[data-f=time_from]'));
    bindTimeInput(tr.querySelector('[data-f=time_to]'));
    tr.querySelector('[data-f=works]').value = row.description || '';
    bindAutoGrow(tr.querySelector('[data-f=works]'));
    tr.querySelector('[data-f=n]').value = row.normal_hours != null && row.normal_hours !== '' ? row.normal_hours : '';
    tr.querySelector('[data-f=u50]').value = row.overtime_50 != null && row.overtime_50 !== '' ? row.overtime_50 : '';
    tr.querySelector('[data-f=u100]').value = row.overtime_100 != null && row.overtime_100 !== '' ? row.overtime_100 : '';
    tr.querySelector('.an-del').addEventListener('click', function () { tr.remove(); updateSums(); maybeInvalidate(); });
    tr.querySelectorAll('input,textarea').forEach(function (inp) {
      inp.addEventListener('input', function () { updateSums(); maybeInvalidate(); saveLocalDraft(); });
    });
    el('anWorkBody').appendChild(tr);
    updateSums();
  }
  function addPartRow(row) {
    row = row || {};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="an-cell-center"><input type="number" class="an-input-qty" data-f="qty" step="1" min="0" max="999"></td>' +
      '<td><input type="text" data-f="des"></td>' +
      '<td><input type="text" data-f="type"></td>' +
      '<td><input type="text" data-f="comment"></td>' +
      '<td><button type="button" class="btn btn-ghost an-del">×</button></td>';
    tr.querySelector('[data-f=qty]').value = row.quantity != null && row.quantity !== '' ? row.quantity : '';
    tr.querySelector('[data-f=des]').value = row.designation || '';
    tr.querySelector('[data-f=type]').value = row.type_no || '';
    tr.querySelector('[data-f=comment]').value = row.description || row.comment || '';
    tr.querySelector('.an-del').addEventListener('click', function () { tr.remove(); maybeInvalidate(); });
    tr.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function () { maybeInvalidate(); saveLocalDraft(); });
    });
    el('anPartsBody').appendChild(tr);
  }
  function updateSums() {
    var n = 0, a = 0, b = 0;
    collectWork().forEach(function (r) {
      n += r.normal_hours; a += r.overtime_50; b += r.overtime_100;
    });
    el('anSumN').textContent = String(Math.round(n * 100) / 100);
    el('anSum50').textContent = String(Math.round(a * 100) / 100);
    el('anSum100').textContent = String(Math.round(b * 100) / 100);
  }
  function kmNum(id) {
    var n = parseInt(el(id).value, 10);
    return Number.isFinite(n) ? n : null;
  }
  function computedTotalKm() {
    var s = kmNum('anStartKm');
    var e = kmNum('anEndKm');
    if (s == null || e == null) return null;
    return e >= s ? (e - s) : null;
  }
  function isTotalKmManual() {
    var t = kmNum('anTotalKm');
    var c = computedTotalKm();
    return t != null && c != null && t !== c;
  }
  function updateTotalKm() {
    var c = computedTotalKm();
    if (c != null) el('anTotalKm').value = String(c);
    else if (kmNum('anStartKm') != null && kmNum('anEndKm') != null) el('anTotalKm').value = '';
  }
  function maybeInvalidate() {
    if (!lastCustomerSig || !signedFingerprint) return;
    if (fingerprint(collectPayload()) === signedFingerprint) return;
    if (!window.confirm(lang() === 'en'
      ? 'Changing the content will invalidate the customer signature. Continue?'
      : 'Eine inhaltliche Änderung löscht die aktuelle Kundenunterschrift. Fortfahren?')) {
      return;
    }
    lastCustomerSig = false;
    el('anSigStatus').textContent = lang() === 'en'
      ? 'Customer signature will be cleared on save.'
      : 'Kundenunterschrift wird beim Speichern gelöscht.';
  }
  function applyLang() {
    var en = lang() === 'en';
    el('anConfirmText').textContent = en
      ? 'The customer confirms the working hours, executed works and, where applicable, spare parts stated in this working report.'
      : 'Der Auftraggeber bestätigt die in diesem Arbeitsnachweis angeführten Arbeitszeiten, durchgeführten Arbeiten und gegebenenfalls verwendeten Ersatzteile.';
  }
  function fillContacts(contacts) {
    var sel = el('anSignerContact');
    if (!sel) return;
    sel.innerHTML = '<option value="">– ' + (lang() === 'en' ? 'select / new' : 'wählen / neu') + ' –</option>';
    (contacts || []).forEach(function (c, i) {
      var name = contactName(c);
      var email = contactEmail(c);
      if (!name && !email) return;
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = name + (email ? ' <' + email + '>' : '');
      opt.dataset.name = name;
      opt.dataset.email = email;
      sel.appendChild(opt);
    });
  }
  function renderFabs(list) {
    var fabs = normalizeFabs(list);
    el('anFabsJson').value = JSON.stringify(fabs);
    var host = el('anFabList');
    if (!fabs.length) {
      host.innerHTML = '<p class="an-fab-empty">' + (lang() === 'en' ? 'No serial numbers on this job.' : 'Keine Fabrikationsnummern am Auftrag.') + '</p>';
      return;
    }
    var rows = fabs.map(function (r) {
      return '<tr><td>' + escapeHtml(r.fabrikationsnummer) + '</td><td>' + escapeHtml(r.type) + '</td></tr>';
    }).join('');
    host.innerHTML = '<table><thead><tr><th>Fabr.-Nr.</th><th>Typ / Type</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  async function fetchLocalJob(jobId, techId) {
    var r = await fetch(API_BASE + '/api/job?id=' + encodeURIComponent(jobId) + '&technician_id=' + encodeURIComponent(techId || ''), {
      headers: { 'X-Technician-Id': String(techId || ''), Accept: 'application/json' }
    });
    var data = await r.json().catch(function () { return null; });
    if (!data) return null;
    if (data.job && typeof data.job === 'object') return data.job;
    if (data.id || data.job_number || data.customer_name) return data;
    return null;
  }
  async function loadJobs() {
    var techId = window.getTechId && window.getTechId();
    var r = await fetch(API_BASE + '/api/my_jobs?assigned_only=1&technician_id=' + encodeURIComponent(techId || ''), {
      headers: { 'X-Technician-Id': String(techId || ''), Accept: 'application/json' }
    });
    var data = await r.json();
    var jobs = (data && data.jobs) || [];
    jobsCache = jobs;
    var sel = el('anJob');
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '– Auftrag –';
    sel.appendChild(ph);
    jobs.forEach(function (j) {
      var opt = document.createElement('option');
      var sid = dispoJobId(j);
      var lid = parseInt(j.id, 10) || 0;
      opt.value = String(sid || lid);
      opt.dataset.localId = String(lid);
      opt.dataset.serverId = String(sid || '');
      opt.textContent = (j.job_number || '#' + (sid || lid)) + ' ' + (j.customer_name || '');
      sel.appendChild(opt);
    });
  }
  async function onJobChange() {
    jobLoadBusy = true;
    try {
    var sel = el('anJob');
    var opt = sel.options[sel.selectedIndex];
    var id = parseInt(sel.value, 10);
    jobData = null;
    if (!id) {
      el('anCustomer').value = '';
      el('anSite').value = '';
      el('anTech').value = '';
      renderFabs([]);
      fillContacts([]);
      return;
    }
    var localId = parseInt(opt && opt.dataset.localId, 10) || id;
    var serverId = parseInt(opt && opt.dataset.serverId, 10) || id;
    applyJobKopf(findCachedJob(localId, serverId));
    if (!el('anTech').value) el('anTech').value = technicianDisplayName();
    var techId = window.getTechId && window.getTechId();
    try {
      var detail = await fetchLocalJob(localId, techId);
      if (!detail && serverId && serverId !== localId) detail = await fetchLocalJob(serverId, techId);
      if (detail) applyJobKopf(detail);
    } catch (e) { /* Liste reicht für die Kopfdaten */ }
    var pre = await proxy('prefill', { method: 'GET', queryParams: { job_id: serverId || id } }).catch(function () { return null; });
    var p = pre && pre.prefill;
    if (p) {
      if (p.customer_name && !el('anCustomer').value) el('anCustomer').value = p.customer_name;
      if (!el('anSite').value && p.site) el('anSite').value = p.site;
      if (p.technician_name) el('anTech').value = p.technician_name;
      var preFabs = normalizeFabs(p.fabrikationsnummern);
      if (preFabs.length && !currentFabs().length) renderFabs(preFabs);
      var preContacts = p.job_contacts || p.contacts;
      if (preContacts && preContacts.length) fillContacts(preContacts);
    }
    if (!el('anTech').value) el('anTech').value = technicianDisplayName();
    try {
      var saved = await fetch(anLocalGetUrl({ job_id: String(serverId || id) }), {
        headers: getHeaders()
      }).then(function (r) { return r.json(); });
      if (saved && saved.document) {
        applyPayload(saved);
        if (!el('anTech').value) el('anTech').value = technicianDisplayName();
        if (saved.synced === false) persistLocal().catch(function () {});
        return;
      }
    } catch (e2) { /* Prefill bleibt */ }
    var list = await proxy('list', { method: 'GET', queryParams: { job_id: serverId || id } }).catch(function () { return null; });
    if (list && list.documents && list.documents[0] && list.documents[0].id) {
      var got = await proxy('get', { method: 'GET', queryParams: { id: list.documents[0].id } }).catch(function () { return null; });
      if (got && got.document) {
        applyPayload(got);
        persistLocal().catch(function () {});
      }
    }
    } finally {
      jobLoadBusy = false;
    }
  }
  async function persistLocal() {
    var payload = collectPayload();
    if (!payload.job_id) return null;
    payload.baseUrl = (window.getDispoBaseUrl && window.getDispoBaseUrl()) || '';
    var data = await fetch(API_BASE + '/api/arbeitsnachweis', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).catch(function () { return null; });
    if (data && data.ok) {
      if (data.local_id && el('anLocalDocId')) el('anLocalDocId').value = String(data.local_id);
      if (data.document_id) el('anDocumentId').value = String(data.document_id);
      if (data.content_version) el('anContentVersion').value = String(data.content_version);
      if (el('anLocalUuid') && (data.local_uuid || (data.document && data.document.local_uuid))) {
        el('anLocalUuid').value = data.local_uuid || data.document.local_uuid;
      }
      applyStatusUi(data);
      saveLocalDraft();
    }
    return data;
  }
  async function saveRemote() {
    var payload = collectPayload();
    if (!payload.job_id) {
      window.alert(lang() === 'en' ? 'Please select a job.' : 'Bitte einen Auftrag wählen.');
      return null;
    }
    var res = await persistLocal();
    if (!res || !res.ok) {
      window.alert((res && res.error) || (lang() === 'en' ? 'Save failed.' : 'Speichern fehlgeschlagen.'));
      return null;
    }
    if (res.signature_invalidated) {
      lastCustomerSig = false;
      el('anSigStatus').textContent = lang() === 'en'
        ? 'Customer signature was cleared because the content changed.'
        : 'Kundenunterschrift wurde wegen Inhaltsänderung gelöscht.';
    }
    return res;
  }
  function previewHtml() {
    var p = collectPayload();
    var lines = [];
    lines.push((lang() === 'en' ? 'Customer: ' : 'Auftraggeber: ') + p.customer_name);
    lines.push((lang() === 'en' ? 'Site: ' : 'Baustelle: ') + p.arbeitsnachweis.site);
    currentFabs().forEach(function (f) {
      lines.push('FN ' + f.fabrikationsnummer + (f.type ? '  Typ ' + f.type : ''));
    });
    lines.push('');
    collectWork().forEach(function (r) {
      lines.push(r.item_date + '  ' + r.item_time + '  ' + r.description + '  N ' + r.normal_hours + ' Ü50 ' + r.overtime_50 + ' Ü100 ' + r.overtime_100);
    });
    lines.push('');
    collectParts().forEach(function (r) {
      lines.push((r.quantity || '') + ' × ' + r.designation + (r.type_no ? ' (' + r.type_no + ')' : '') + (r.description ? ' – ' + r.description : ''));
    });
    if (p.arbeitsnachweis.remarks) {
      lines.push('');
      lines.push(p.arbeitsnachweis.remarks);
    }
    lines.push('');
    lines.push(el('anConfirmText').textContent);
    return lines.join('\n');
  }
  async function signCustomer() {
    if (!pad || pad.isEmpty()) {
      window.alert(lang() === 'en' ? 'Please sign first.' : 'Bitte zuerst unterschreiben.');
      return;
    }
    var name = el('anSignerName').value.trim();
    var email = el('anSignerEmail').value.trim();
    if (!name || !email) {
      window.alert(lang() === 'en' ? 'Customer name and e-mail are required.' : 'Name und E-Mail des Auftraggebers sind erforderlich.');
      return;
    }
    var saved = await saveRemote();
    if (!saved) return;
    var sig = await proxy('signature', {
      payload: {
        document_id: saved.document_id,
        signer_type: 'kunde',
        signer_name: name,
        signer_email: email,
        signature_data: pad.toDataUrl(),
        save_contact: el('anSaveContact').checked,
        timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || '')
      }
    });
    if (!sig || !sig.ok) {
      window.alert((sig && sig.error) || 'Signatur fehlgeschlagen.');
      return;
    }
    lastCustomerSig = true;
    signedFingerprint = fingerprint(collectPayload());
    el('anSigStatus').textContent = lang() === 'en' ? 'Signed.' : 'Unterzeichnet.';
    el('anPreviewModal').hidden = true;
    await generatePdfAndMail(saved, pad.toDataUrl());
  }
  async function generatePdfAndMail(saved, customerPng) {
    var payload = collectPayload();
    payload.document = {
      number: saved && saved.number,
      language: payload.language,
      job_id: payload.job_id,
      content_version: saved && saved.content_version
    };
    payload.customer_signature_png = customerPng || '';
    payload.customer_signer_name = el('anSignerName').value;
    payload.job_id = payload.job_id;
    var pdfRes = await fetch(API_BASE + '/api/arbeitsnachweis/pdf', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).catch(function () { return null; });
    if (pdfRes && pdfRes.ok && pdfRes.pdf_base64 && saved && saved.document_id) {
      await proxy('pdf_upload', {
        payload: { document_id: saved.document_id, pdf_base64: pdfRes.pdf_base64 }
      }).catch(function () { return null; });
    }
    var en = lang() === 'en';
    var html = en
      ? '<p>Dear Sir or Madam,</p><p>Please find attached the working report.</p><p>Thank you very much.</p>'
      : '<p>Sehr geehrte Damen und Herren,</p><p>anbei erhalten Sie den Arbeitsnachweis.</p><p>Vielen Dank.</p>';
    var outlookBody = {
      recipients: [el('anSignerEmail').value.trim()].filter(Boolean),
      attachments: pdfRes && pdfRes.path ? [pdfRes.path] : [],
      subject: en ? 'Working report' : 'Arbeitsnachweis',
      html_body: html
    };
    fetch(API_BASE + '/api/arbeitsnachweis/outlook', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(outlookBody)
    }).then(function (r) { return r.json(); }).then(function (o) {
      if (o && o.outlook_error) {
        window.alert((en ? 'Outlook could not be opened: ' : 'Outlook konnte nicht geöffnet werden: ') + o.outlook_error);
      }
    }).catch(function () { /* Abschluss nicht blockieren */ });
  }
  async function transferTimesheet() {
    var saved = await saveRemote();
    if (!saved) return;
    var prev = await proxy('timesheet_preview', { payload: { document_id: saved.document_id, items: collectWork() } });
    if (!prev || !prev.ok) {
      window.alert((prev && prev.error) || 'Vorschau fehlgeschlagen.');
      return;
    }
    var mode = 'replace';
    if (prev.conflicts && prev.conflicts.length) {
      if (!window.confirm(lang() === 'en'
        ? 'Hours already exist on some days. OK = add, Cancel = replace those fields.'
        : 'An manchen Tagen sind bereits Montage/Weg/Ü-Stunden vorhanden. OK = addieren, Abbrechen = ersetzen.')) {
        mode = 'replace';
      } else {
        mode = 'add';
      }
    }
    var apply = await proxy('timesheet_apply', {
      payload: { document_id: saved.document_id, items: collectWork(), mode: mode }
    });
    if (!apply || !apply.ok) {
      window.alert((apply && apply.error) || 'Übernahme fehlgeschlagen.');
      return;
    }
    if (el('anTimesheetApplied')) el('anTimesheetApplied').value = '1';
    persistLocal().catch(function () {});
    applyStatusUi({ timesheet_applied: true, status: 'entwurf', number: saved.number, synced: saved.synced });
    window.alert(lang() === 'en' ? 'Transferred to timesheet.' : 'In die Zeitschreibung übernommen.');
  }
  function schedulePersist() {
    if (jobLoadBusy) return;
    saveLocalDraft();
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistLocal().catch(function () {});
    }, 700);
  }
  function resetForm() {
    el('anForm').reset();
    el('anDocumentId').value = '';
    if (el('anLocalDocId')) el('anLocalDocId').value = '';
    el('anLocalUuid').value = uuid();
    el('anContentVersion').value = '1';
    if (el('anTimesheetApplied')) el('anTimesheetApplied').value = '0';
    el('anWorkBody').innerHTML = '';
    el('anPartsBody').innerHTML = '';
    renderFabs([]);
    addWorkRow({ item_date: todayIso() });
    lastCustomerSig = false;
    signedFingerprint = '';
    el('anSigStatus').textContent = '';
    el('anAutosaveHint').textContent = 'Entwurf';
    document.querySelector('input[name="anLang"][value="de"]').checked = true;
    applyLang();
    applyStatusUi({ status: 'entwurf' });
  }
  function boot() {
    if (!el('anForm')) return;
    if (!el('anLocalUuid').value) el('anLocalUuid').value = uuid();
    if (!el('anWorkBody').children.length) addWorkRow({ item_date: todayIso() });
    el('btnAnAddWork').addEventListener('click', function () { addWorkRow({ item_date: nextWorkDate() }); });
    el('btnAnAddPart').addEventListener('click', function () { addPartRow(); });
    el('anJob').addEventListener('focus', function () { persistLocal().catch(function () {}); });
    el('anJob').addEventListener('change', function () { onJobChange().catch(function () {}); });
    el('anSignerContact').addEventListener('change', function () {
      var opt = el('anSignerContact').selectedOptions[0];
      if (!opt || !opt.dataset) return;
      if (opt.dataset.name) el('anSignerName').value = opt.dataset.name;
      if (opt.dataset.email) el('anSignerEmail').value = opt.dataset.email;
    });
    ['anStartKm', 'anEndKm'].forEach(function (id) {
      el(id).addEventListener('input', updateTotalKm);
    });
    document.querySelectorAll('input[name="anLang"]').forEach(function (r) {
      r.addEventListener('change', applyLang);
    });
    el('anForm').addEventListener('input', schedulePersist);
    el('anForm').addEventListener('change', schedulePersist);
    el('btnAnSave').addEventListener('click', function () { saveRemote(); });
    el('btnAnPdf').addEventListener('click', async function () {
      var saved = await saveRemote();
      if (saved) await generatePdfAndMail(saved, '');
    });
    el('btnAnTimesheet').addEventListener('click', transferTimesheet);
    el('btnAnPreview').addEventListener('click', function () {
      el('anPreviewBody').textContent = previewHtml();
      el('anPreviewModal').hidden = false;
      if (window.KuklaSignaturePad) pad = window.KuklaSignaturePad.attach(el('anSigCanvas'));
    });
    el('btnAnPreviewClose').addEventListener('click', function () { el('anPreviewModal').hidden = true; });
    el('btnAnSigClear').addEventListener('click', function () { if (pad) pad.clear(); });
    el('btnAnSign').addEventListener('click', signCustomer);
    loadJobs().catch(function () {});
  }
  window.openAndResetArbeitsnachweisForm = function () {
    loadJobs().then(function () {
      return fetch(anLocalGetUrl({ latest: '1' }), {
        headers: getHeaders()
      }).then(function (r) { return r.json(); });
    }).then(function (data) {
      if (data && data.document) applyPayload(data);
    }).catch(function () {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
