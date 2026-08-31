/**
 * Arbeitsnachweis – Laptop-Formular (Belegtyp arbeitsnachweis).
 */
(function () {
  var API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var pad = null;
  var jobData = null;
  var signedFingerprint = '';
  var lastCustomerSig = false;

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
  function authHeaders() {
    var h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    try {
      var u = window.getDispoUsername && window.getDispoUsername();
      var p = window.getDispoPassword && window.getDispoPassword();
      if (u && p) h.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(u + ':' + p)));
    } catch (e) {}
    var tid = window.getTechId && window.getTechId();
    if (tid) h['X-Technician-Id'] = String(tid);
    return h;
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
    var m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return String(s || '');
    return ('0' + m[1]).slice(-2) + ':' + m[2];
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
    var manual = el('anTotalKmManual').checked;
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
        total_km_manual: manual,
        naechtigung_beigestellt: !!(overnight && overnight.value === '1'),
        remarks: el('anRemarks').value
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
  function addWorkRow(row) {
    row = row || {};
    var times = splitTime(row.item_time);
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="date" data-f="date"></td>' +
      '<td class="an-cell-center"><input type="time" class="an-input-time" data-f="time_from" step="60"></td>' +
      '<td class="an-cell-center"><input type="time" class="an-input-time" data-f="time_to" step="60"></td>' +
      '<td><textarea data-f="works" rows="2"></textarea></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="n" step="0.25" min="0" max="24"></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="u50" step="0.25" min="0" max="24"></td>' +
      '<td class="an-cell-center"><input type="number" class="an-input-hrs" data-f="u100" step="0.25" min="0" max="24"></td>' +
      '<td><button type="button" class="btn btn-ghost an-del">×</button></td>';
    tr.querySelector('[data-f=date]').value = row.item_date || '';
    tr.querySelector('[data-f=time_from]').value = times.from;
    tr.querySelector('[data-f=time_to]').value = times.to;
    tr.querySelector('[data-f=works]').value = row.description || '';
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
  function updateTotalKm() {
    if (el('anTotalKmManual').checked) return;
    var s = parseInt(el('anStartKm').value, 10);
    var e = parseInt(el('anEndKm').value, 10);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) el('anTotalKm').value = String(e - s);
    else if (Number.isFinite(s) && Number.isFinite(e) && e < s) el('anTotalKm').value = '';
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
  async function loadJobs() {
    var techId = window.getTechId && window.getTechId();
    var r = await fetch(API_BASE + '/api/my_jobs?assigned_only=1&technician_id=' + encodeURIComponent(techId || ''), {
      headers: { 'X-Technician-Id': String(techId || '') }
    });
    var data = await r.json();
    var jobs = (data && data.jobs) || [];
    el('anJob').innerHTML = '<option value="">– Auftrag –</option>' + jobs.map(function (j) {
      var id = dispoJobId(j);
      return '<option value="' + id + '">' + (j.job_number || '#' + id) + ' ' + (j.customer_name || '') + '</option>';
    }).join('');
  }
  async function onJobChange() {
    var id = parseInt(el('anJob').value, 10);
    jobData = null;
    if (!id) {
      renderFabs([]);
      fillContacts([]);
      return;
    }
    var techId = window.getTechId && window.getTechId();
    var r = await fetch(API_BASE + '/api/job?id=' + id + '&technician_id=' + encodeURIComponent(techId || ''), {
      headers: Object.assign({ 'X-Technician-Id': String(techId || '') }, authHeaders())
    });
    var data = await r.json();
    jobData = data && data.job;
    if (!jobData) return;
    el('anCustomer').value = jobData.customer_name || '';
    el('anSite').value = siteFromJob(jobData);
    renderFabs(jobData.fabrikationsnummern);
    fillContacts(contactsFromJob(jobData));
    var pre = await proxy('prefill', { method: 'GET', queryParams: { job_id: id } }).catch(function () { return null; });
    var p = pre && pre.prefill;
    if (p) {
      if (!el('anSite').value && p.site) el('anSite').value = p.site;
      if (p.technician_name) el('anTech').value = p.technician_name;
      var preFabs = normalizeFabs(p.fabrikationsnummern);
      if (preFabs.length && !currentFabs().length) renderFabs(preFabs);
      var preContacts = p.job_contacts || p.contacts;
      if ((!el('anSignerContact').options || el('anSignerContact').options.length <= 1) && preContacts && preContacts.length) {
        fillContacts(preContacts);
      } else if (preContacts && preContacts.length && !contactsFromJob(jobData).length) {
        fillContacts(preContacts);
      }
    }
    if (!el('anTech').value) {
      var nameEl = document.getElementById('technicianName');
      el('anTech').value = (nameEl && (nameEl.value || nameEl.textContent)) || '';
    }
  }
  async function saveRemote() {
    var payload = collectPayload();
    if (!payload.job_id) {
      window.alert(lang() === 'en' ? 'Please select a job.' : 'Bitte einen Auftrag wählen.');
      return null;
    }
    var res = await proxy('save', { payload: payload });
    if (!res || !res.ok) {
      window.alert((res && res.error) || 'Speichern fehlgeschlagen.');
      return null;
    }
    el('anDocumentId').value = String(res.document_id);
    el('anContentVersion').value = String(res.content_version || 1);
    if (res.signature_invalidated) {
      lastCustomerSig = false;
      el('anSigStatus').textContent = lang() === 'en'
        ? 'Customer signature was cleared because the content changed.'
        : 'Kundenunterschrift wurde wegen Inhaltsänderung gelöscht.';
    }
    el('anAutosaveHint').textContent = (res.number ? res.number + ' · ' : '') + (res.status || 'entwurf');
    saveLocalDraft();
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
    window.alert(lang() === 'en' ? 'Transferred to timesheet.' : 'In die Zeitschreibung übernommen.');
  }
  function resetForm() {
    el('anForm').reset();
    el('anDocumentId').value = '';
    el('anLocalUuid').value = uuid();
    el('anContentVersion').value = '1';
    el('anWorkBody').innerHTML = '';
    el('anPartsBody').innerHTML = '';
    renderFabs([]);
    addWorkRow({ item_date: todayIso() });
    lastCustomerSig = false;
    signedFingerprint = '';
    el('anSigStatus').textContent = '';
    document.querySelector('input[name="anLang"][value="de"]').checked = true;
    applyLang();
  }
  function boot() {
    if (!el('anForm')) return;
    if (!el('anLocalUuid').value) el('anLocalUuid').value = uuid();
    if (!el('anWorkBody').children.length) addWorkRow({ item_date: todayIso() });
    el('btnAnAddWork').addEventListener('click', function () { addWorkRow({ item_date: nextWorkDate() }); });
    el('btnAnAddPart').addEventListener('click', function () { addPartRow(); });
    el('anJob').addEventListener('change', onJobChange);
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
    el('anForm').addEventListener('input', saveLocalDraft);
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
    resetForm();
    loadJobs().catch(function () {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
