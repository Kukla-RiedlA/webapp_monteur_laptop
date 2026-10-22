(function () {
  var API_BASE = (typeof monteurApp !== 'undefined' && monteurApp.apiBase) ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var state = { job: null, themen: [], teilnehmer: [], revision: 0, ready: false, popupIndex: -1, pad: null };
  var saveTimer = null;

  function el(id) { return document.getElementById(id); }
  function techId() { return (typeof window.getTechId === 'function') ? window.getTechId() : 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function langs() {
    var out = [];
    if (el('schulungLangDe') && el('schulungLangDe').checked) out.push('de');
    if (el('schulungLangEn') && el('schulungLangEn').checked) out.push('en');
    if (!out.length) out.push('de');
    return out;
  }
  function enOnly() { var l = langs(); return l.indexOf('en') !== -1 && l.indexOf('de') === -1; }
  function dateLabel(job) {
    var a = job && job.start_datetime ? String(job.start_datetime).slice(0, 10) : '';
    var b = job && job.end_datetime ? String(job.end_datetime).slice(0, 10) : '';
    if (a && b && a !== b) return a + ' – ' + b;
    return a || b || '';
  }
  function fabsOf(job) {
    var raw = job && (job.fabrikationsnummern || job.fabs || job.anlagen);
    if (!Array.isArray(raw)) return [];
    return raw.map(function (row) {
      if (typeof row === 'string') return { fabrikationsnummer: row, type: '' };
      return {
        fabrikationsnummer: String(row.fabrikationsnummer || row.fn || row.fab || ''),
        type: String(row.type || row.typ || row.anlagen_type || ''),
      };
    }).filter(function (row) { return row.fabrikationsnummer || row.type; });
  }

  function kopfFromJob(job) {
    var fabs = fabsOf(job);
    var techNameEl = document.getElementById('technicianName');
    return {
      kunde: (job && (job.customer_name || job.endkunde)) || '',
      projekt: (el('schulungProjekt') && el('schulungProjekt').value) || (job && job.projekt) || '',
      datum: dateLabel(job),
      geliefertUeber: (job && (job.geliefert_ueber || job.geliefertUeber)) || (fabs[0] && fabs[0].geliefert_ueber) || '',
      servicetechniker: techNameEl ? techNameEl.textContent.trim() : '',
      ansprechperson: (job && (job.contact_person || job.ansprechpartner || job.ansprechperson)) || '',
    };
  }

  function payload() {
    var jobId = parseInt(el('schulungJob') && el('schulungJob').value, 10) || 0;
    return {
      job_id: jobId,
      languages: langs(),
      projekt: el('schulungProjekt') ? el('schulungProjekt').value : '',
      kopfdaten: kopfFromJob(state.job || {}),
      anlagen: fabsOf(state.job || {}),
      themen: state.themen,
      teilnehmer: state.teilnehmer,
      base_revision: state.revision,
      dispoBaseUrl: (typeof window.getDispoBaseUrl === 'function') ? window.getDispoBaseUrl() : '',
      serverUsername: (typeof window.getDispoUsername === 'function') ? window.getDispoUsername() : '',
    };
  }

  function renderKopf() {
    var box = el('schulungKopf');
    var anlagen = el('schulungAnlagen');
    if (!box || !state.job) return;
    var k = kopfFromJob(state.job);
    box.hidden = false;
    box.innerHTML =
      '<div><span>Kunde</span><strong>' + esc(k.kunde) + '</strong></div>' +
      '<div><span>Projekt</span><strong>' + esc(k.projekt) + '</strong></div>' +
      '<div><span>Datum</span><strong>' + esc(k.datum) + '</strong></div>' +
      '<div><span>geliefert über</span><strong>' + esc(k.geliefertUeber) + '</strong></div>' +
      '<div><span>Servicetechniker</span><strong>' + esc(k.servicetechniker) + '</strong></div>' +
      '<div><span>Ansprechperson</span><strong>' + esc(k.ansprechperson).replace(/\n/g, '<br>') + '</strong></div>';
    var fabs = fabsOf(state.job);
    if (anlagen) {
      anlagen.innerHTML = fabs.map(function (row) {
        return '<div class="schulung-anlage"><div>Fabr.-Nr. <strong>' + esc(row.fabrikationsnummer) + '</strong></div><div>Typ <strong>' + esc(row.type) + '</strong></div></div>';
      }).join('');
    }
  }

  function renderThemen() {
    var host = el('schulungThemen');
    if (!host) return;
    var onlyEn = enOnly();
    host.innerHTML = state.themen.map(function (step, idx) {
      var title = onlyEn ? (step.bezeichnung_en || step.bezeichnung_de) : step.bezeichnung_de;
      var sub = (!onlyEn && step.bezeichnung_en) ? '<div class="muted">' + esc(step.bezeichnung_en) + '</div>' : '';
      function btn(code, label) {
        return '<button type="button" class="btn btn-ghost' + (step.status === code ? ' is-on' : '') + '" data-schulung-status="' + code + '" data-idx="' + idx + '">' + label + '</button>';
      }
      return '<article class="schulung-thema"><div class="schulung-thema-bar"><strong>' + esc(title) + '</strong></div><div class="schulung-thema-body">' +
        sub +
        '<div class="schulung-status">' + btn('ok', 'vermittelt') + btn('nok', 'offen') + btn('na', 'entfällt') + '</div>' +
        '<input type="text" data-schulung-remark="' + idx + '" value="' + esc(step.bemerkung || '') + '" placeholder="Bemerkung">' +
        '</div></article>';
    }).join('');
  }

  function renderTeilnehmer() {
    var body = el('schulungTeilnehmer');
    if (!body) return;
    body.innerHTML = state.teilnehmer.map(function (row, idx) {
      var sig = row.signature_png ? '<img class="schulung-sig-preview" alt="" src="' + esc(row.signature_png) + '">' : '';
      return '<tr><td><input data-tn-name="' + idx + '" value="' + esc(row.name || '') + '"></td>' +
        '<td><input data-tn-fn="' + idx + '" value="' + esc(row.funktion || '') + '"></td>' +
        '<td>' + sig + '<button type="button" class="btn btn-ghost" data-tn-sign="' + idx + '">Unterschrift</button></td>' +
        '<td><button type="button" class="btn btn-ghost" data-tn-del="' + idx + '">Entfernen</button></td></tr>';
    }).join('');
  }

  function hint(text) {
    var node = el('schulungAutosaveHint');
    if (node) node.textContent = text;
  }

  async function post(localOnly, wantPdf) {
    var body = payload();
    body.local_only = !!localOnly;
    body.jsonOnly = true;
    body.pdf = !!wantPdf;
    var res = await fetch(API_BASE + '/api/protokolle/schulungsprotokoll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Technician-Id': String(techId()) },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok) throw new Error(data.error || 'Speichern fehlgeschlagen.');
    if (data.revision) state.revision = data.revision;
    var msg = 'Zuletzt gespeichert: ' + new Date().toLocaleTimeString();
    if (data.dispo_error) msg += ' · ' + data.dispo_error;
    hint(msg);
    if (wantPdf && data.pdf_base64) {
      var bin = atob(data.pdf_base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.pdf_filename || 'Schulungsprotokoll.pdf';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }
  }

  function scheduleSave() {
    if (!state.ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      post(true, false).catch(function (e) { hint(e.message || 'Lokales Speichern fehlgeschlagen.'); });
    }, 700);
  }

  async function loadDefaults(types) {
    var url = API_BASE + '/api/schulungsprotokoll/defaults?types=' + encodeURIComponent((types || []).join('|'));
    var res = await fetch(url, { headers: { 'X-Technician-Id': String(techId()) } });
    var data = await res.json();
    state.themen = (data && data.arbeitsschritte) ? data.arbeitsschritte : [];
  }

  async function loadJob(id) {
    state.ready = false;
    state.job = null;
    state.themen = [];
    state.teilnehmer = [];
    var url = API_BASE + '/api/job?id=' + encodeURIComponent(id) + '&technician_id=' + encodeURIComponent(techId()) + '&enrich_anlagenstamm=1&enrich_local_only=1';
    var res = await fetch(url, { headers: { 'X-Technician-Id': String(techId()) } });
    var data = await res.json();
    if (!data || !data.job) throw new Error((data && data.error) || 'Auftrag nicht geladen.');
    state.job = data.job;
    if (el('schulungProjekt') && !el('schulungProjekt').value) {
      el('schulungProjekt').value = data.job.projekt || data.job.project || '';
    }
    var draftRes = await fetch(API_BASE + '/api/protokolle/schulungsprotokoll?job_id=' + encodeURIComponent(id) + '&local_only=1', {
      headers: { 'X-Technician-Id': String(techId()) },
    });
    var draft = await draftRes.json().catch(function () { return {}; });
    if (draft && draft.ok && draft.data && Array.isArray(draft.data.themen) && draft.data.themen.length) {
      state.themen = draft.data.themen;
      state.teilnehmer = Array.isArray(draft.data.teilnehmer) ? draft.data.teilnehmer : [];
      state.revision = draft.data.revision || 0;
      if (draft.data.projekt && el('schulungProjekt')) el('schulungProjekt').value = draft.data.projekt;
      if (Array.isArray(draft.data.languages)) {
        if (el('schulungLangDe')) el('schulungLangDe').checked = draft.data.languages.indexOf('de') !== -1;
        if (el('schulungLangEn')) el('schulungLangEn').checked = draft.data.languages.indexOf('en') !== -1;
      }
    } else {
      await loadDefaults(fabsOf(state.job).map(function (row) { return row.type; }));
    }
    renderKopf();
    renderThemen();
    renderTeilnehmer();
    state.ready = true;
  }

  function openPopup(index) {
    state.popupIndex = index;
    var row = index >= 0 ? state.teilnehmer[index] : { name: '', funktion: '', signature_png: '' };
    el('schulungPopupName').value = row.name || '';
    el('schulungPopupFunktion').value = row.funktion || '';
    el('schulungPopup').hidden = false;
    var canvas = el('schulungPopupCanvas');
    if (window.KuklaSignaturePad) state.pad = window.KuklaSignaturePad.attach(canvas);
    if (state.pad) state.pad.clear();
  }
  function closePopup() {
    el('schulungPopup').hidden = true;
    state.popupIndex = -1;
    state.pad = null;
  }

  async function openProtokolleSchulung() {
    var select = el('schulungJob');
    if (!select) return;
    select.innerHTML = '<option value="">Lade…</option>';
    var from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    var to = new Date();
    to.setFullYear(to.getFullYear() + 1);
    var qs = 'technician_id=' + encodeURIComponent(techId()) +
      '&date_from=' + from.toISOString().slice(0, 10) +
      '&date_to=' + to.toISOString().slice(0, 10) +
      '&assigned_only=1';
    var res = await fetch(API_BASE + '/api/my_jobs?' + qs, { headers: { 'X-Technician-Id': String(techId()) } });
    var data = await res.json().catch(function () { return {}; });
    var jobs = (data && data.jobs) || [];
    select.innerHTML = '<option value="">-- Auftrag wählen --</option>' + jobs.map(function (job) {
      return '<option value="' + job.id + '">' + esc((job.job_number || '') + ' ' + (job.customer_name || '')) + '</option>';
    }).join('');
  }
  window.openProtokolleSchulung = function () {
    openProtokolleSchulung().catch(function (e) { hint(e.message || 'Aufträge nicht geladen.'); });
  };

  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'schulungJob') {
      var id = parseInt(ev.target.value, 10);
      if (!id) return;
      loadJob(id).catch(function (e) { hint(e.message || 'Auftrag nicht geladen.'); });
    }
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'btnSchulungSave') {
      ev.preventDefault();
      post(false, false).catch(function (e) { hint(e.message); });
    }
    if (t.id === 'btnSchulungPdf') {
      ev.preventDefault();
      post(false, true).catch(function (e) { hint(e.message); });
    }
    if (t.id === 'btnSchulungTeilnehmerAdd') {
      state.teilnehmer.push({ name: '', funktion: '', signature_png: '' });
      renderTeilnehmer();
      scheduleSave();
    }
    if (t.id === 'btnSchulungSelbst' || t.getAttribute('data-tn-sign') != null) {
      var idx = t.getAttribute('data-tn-sign');
      openPopup(idx == null ? -1 : parseInt(idx, 10));
    }
    if (t.id === 'btnSchulungPopupCancel') closePopup();
    if (t.id === 'btnSchulungPopupClear' && state.pad) state.pad.clear();
    var status = t.getAttribute('data-schulung-status');
    if (status != null) {
      var i = parseInt(t.getAttribute('data-idx'), 10);
      if (state.themen[i]) state.themen[i].status = status;
      renderThemen();
      scheduleSave();
    }
    var del = t.getAttribute('data-tn-del');
    if (del != null) {
      state.teilnehmer.splice(parseInt(del, 10), 1);
      renderTeilnehmer();
      scheduleSave();
    }
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'schulungProjekt') { renderKopf(); scheduleSave(); }
    var remark = t.getAttribute('data-schulung-remark');
    if (remark != null && state.themen[remark]) {
      state.themen[remark].bemerkung = t.value;
      scheduleSave();
    }
    var nameIdx = t.getAttribute('data-tn-name');
    if (nameIdx != null && state.teilnehmer[nameIdx]) {
      state.teilnehmer[nameIdx].name = t.value;
      scheduleSave();
    }
    var fnIdx = t.getAttribute('data-tn-fn');
    if (fnIdx != null && state.teilnehmer[fnIdx]) {
      state.teilnehmer[fnIdx].funktion = t.value;
      scheduleSave();
    }
  });
  var popupForm = el('schulungPopupForm');
  if (popupForm) {
    popupForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var row = {
        name: el('schulungPopupName').value.trim(),
        funktion: el('schulungPopupFunktion').value.trim(),
        signature_png: (state.pad && !state.pad.isEmpty()) ? state.pad.toDataUrl() : '',
      };
      if (!row.name) return;
      if (state.popupIndex >= 0 && state.teilnehmer[state.popupIndex]) {
        if (!row.signature_png) row.signature_png = state.teilnehmer[state.popupIndex].signature_png || '';
        state.teilnehmer[state.popupIndex] = row;
      } else {
        state.teilnehmer.push(row);
      }
      closePopup();
      renderTeilnehmer();
      scheduleSave();
    });
  }
})();
