(function () {
  var API_BASE = (typeof monteurApp !== 'undefined' && monteurApp.apiBase) ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var state = { job: null, themen: [], teilnehmer: [], revision: 0, ready: false, popupIndex: -1, pad: null, presetNames: [], catalog: [] };
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
  function pickField(row, keys) {
    if (!row || typeof row !== 'object') return '';
    for (var i = 0; i < keys.length; i++) {
      if (row[keys[i]] != null && String(row[keys[i]]).trim()) return String(row[keys[i]]).trim();
    }
    return '';
  }

  function fabsOf(job) {
    var raw = job && (job.fabrikationsnummern != null ? job.fabrikationsnummern : (job.fabs || job.anlagen));
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === 'object') list = [raw];
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
        else if (parsed && typeof parsed === 'object') list = [parsed];
      } catch (e) {
        list = raw.split(/[\s;,]+/).map(function (part) { return part.trim(); }).filter(Boolean).map(function (fn) {
          return { fabrikationsnummer: fn };
        });
      }
    }
    return list.map(function (row) {
      if (typeof row === 'string') return { fabrikationsnummer: row, type: '', position: '', geliefert_ueber: '', projekt: '' };
      return {
        fabrikationsnummer: pickField(row, ['fabrikationsnummer', 'fn', 'fab', 'Fabrikationsnummer']),
        type: pickField(row, ['type', 'Type', 'typ', 'Typ', 'anlagen_type']),
        position: pickField(row, ['position', 'Position', 'pos', 'Pos']),
        geliefert_ueber: pickField(row, ['geliefert_ueber', 'geliefertUeber']),
        projekt: pickField(row, ['projekt', 'Projekt', 'project']),
      };
    }).filter(function (row) { return row.fabrikationsnummer || row.type || row.position; });
  }

  function deriveProjekt(job) {
    var rows = fabsOf(job);
    var vals = [];
    rows.forEach(function (row) { if (row.projekt) vals.push(row.projekt); });
    if (!vals.length) return (job && (job.projekt || job.project)) || '';
    var first = vals[0];
    for (var i = 1; i < vals.length; i++) {
      if (vals[i] !== first) return '';
    }
    return first;
  }

  function resolveAnsprechperson(job) {
    if (!job || typeof job !== 'object') return '';
    var names = [];
    var seen = {};
    function pushName(value) {
      var name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      names.push(name);
    }
    var contacts = Array.isArray(job.job_contacts) ? job.job_contacts : [];
    contacts.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var name = String(c.contact_name || '').trim();
      if (!name) name = (String(c.first_name || '') + ' ' + String(c.last_name || '')).trim();
      pushName(name);
    });
    if (names.length) return names.join('\n');
    var direct = [
      job.baustellen_ansprechpartner,
      job.job_contact_name,
      job.contact_name,
      job.ansprechpartner,
      job.ansprechperson,
      job.contact_person,
    ];
    for (var i = 0; i < direct.length; i++) {
      var val = direct[i] != null ? String(direct[i]).trim() : '';
      if (val) return val;
    }
    return '';
  }

  function kopfFromJob(job) {
    var fabs = fabsOf(job);
    var techNameEl = document.getElementById('technicianName');
    var projektInput = el('schulungProjekt');
    var projekt = projektInput && String(projektInput.value || '').trim()
      ? String(projektInput.value).trim()
      : deriveProjekt(job);
    var geliefert = '';
    fabs.forEach(function (row) { if (!geliefert && row.geliefert_ueber) geliefert = row.geliefert_ueber; });
    return {
      kunde: (job && (job.customer_name || job.endkunde)) || '',
      projekt: projekt,
      datum: dateLabel(job),
      geliefertUeber: geliefert || (job && (job.geliefert_ueber || job.geliefertUeber)) || '',
      servicetechniker: techNameEl ? techNameEl.textContent.trim() : '',
      ansprechperson: resolveAnsprechperson(job),
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
      if (!fabs.length) {
        anlagen.innerHTML = '';
      } else {
        var en = enOnly();
        var fabRowsHtml = fabs.map(function (row) {
          return '<tr><td class="mb-v2-fab-fn">' + esc(row.fabrikationsnummer) + '</td><td>' + esc(row.type) + '</td><td class="schulung-fab-pos">' + esc(row.position) + '</td></tr>';
        }).join('');
        anlagen.innerHTML =
          '<div class="mb-v2-fab-head">' + (en ? 'Equipment' : 'Anlagen') + '</div>' +
          '<div class="mb-v2-fab-wrap"><table class="mb-v2-fab-table schulung-fab-table">' +
          '<thead><tr><th>' + (en ? 'Serial No.' : 'Fabr.-Nr.') + '</th><th>' + (en ? 'Type' : 'Typ') + '</th><th>Pos.</th></tr></thead>' +
          '<tbody>' + fabRowsHtml + '</tbody></table></div>';
      }
    }
  }

  function splitHeading(text) {
    var value = String(text || '').trim();
    var idx = value.indexOf(': ');
    if (idx <= 0) return { title: value, body: value };
    var title = value.slice(0, idx).trim();
    var body = value.slice(idx + 2).trim();
    return { title: title || value, body: body || title || value };
  }

  function shapeThema(step) {
    if (!step || typeof step !== 'object') return step;
    if (step.erklaerung_de == null && step.bezeichnung_de) {
      var de = splitHeading(step.bezeichnung_de);
      if (de.title !== step.bezeichnung_de || de.body) {
        step.bezeichnung_de = de.title;
        step.erklaerung_de = de.body;
      }
    }
    if (step.erklaerung_en == null && step.bezeichnung_en) {
      var en = splitHeading(step.bezeichnung_en);
      step.bezeichnung_en = en.title;
      step.erklaerung_en = en.body;
    }
    if (step.erklaerung_de == null) step.erklaerung_de = step.bezeichnung_de || '';
    if (step.erklaerung_en == null) step.erklaerung_en = step.bezeichnung_en || '';
    return step;
  }

  function renderThemen() {
    var host = el('schulungThemen');
    if (!host) return;
    var onlyEn = enOnly();
    host.innerHTML = state.themen.map(function (step, idx) {
      shapeThema(step);
      var title = onlyEn ? (step.bezeichnung_en || step.bezeichnung_de) : step.bezeichnung_de;
      var explain = onlyEn ? (step.erklaerung_en || step.erklaerung_de || '') : (step.erklaerung_de || '');
      return '<article class="schulung-thema"><div class="schulung-thema-bar"><strong>' + esc(title) + '</strong>' +
        '<button type="button" class="schulung-remove" data-schulung-remove="' + idx + '" title="' + (onlyEn ? 'Remove' : 'Entfernen') + '" aria-label="' + (onlyEn ? 'Remove' : 'Entfernen') + '">×</button></div><div class="schulung-thema-body">' +
        '<textarea class="schulung-erklaerung" data-schulung-erklaerung="' + idx + '" rows="2" placeholder="' + (onlyEn ? 'Explanation' : 'Erklärung') + '">' + esc(explain) + '</textarea>' +
        '<input type="text" data-schulung-remark="' + idx + '" value="' + esc(step.bemerkung || '') + '" placeholder="' + (onlyEn ? 'Remark' : 'Bemerkung') + '">' +
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
    if (wantPdf) {
      var pdfPath = data.pdf_path || (Array.isArray(data.pdf_paths) && data.pdf_paths[0]) || '';
      if (pdfPath && typeof monteurApp !== 'undefined' && monteurApp && typeof monteurApp.openPdf === 'function') {
        var opened = await monteurApp.openPdf(String(pdfPath));
        if (opened && opened.ok === false) throw new Error(opened.error || 'PDF konnte nicht geöffnet werden.');
        hint(msg + ' · PDF im Viewer. Mit „Speichern unter“ sichern.');
      } else if (data.pdf_base64) {
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
  }

  function scheduleSave() {
    if (!state.ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      post(true, false).catch(function (e) { hint(e.message || 'Lokales Speichern fehlgeschlagen.'); });
    }, 700);
  }

  function jobTypes() {
    return fabsOf(state.job).map(function (row) { return row.type; }).filter(Boolean);
  }

  function renderPresetHint() {
    var node = el('schulungPresetHint');
    if (!node) return;
    var names = state.presetNames || [];
    if (state.stepsFromDraft) {
      node.textContent = enOnly() ? 'Saved steps' : 'Gespeicherte Schritte';
      return;
    }
    if (!names.length) {
      node.textContent = enOnly() ? 'Basic set, no type preset matched.' : 'Grundstock, kein Typ-Set erkannt.';
      return;
    }
    node.textContent = (enOnly() ? 'Set: ' : 'Set: ') + names.join(', ');
  }

  async function loadDefaults(types) {
    var url = API_BASE + '/api/schulungsprotokoll/defaults?types=' + encodeURIComponent((types || []).join('|'));
    var res = await fetch(url, { headers: { 'X-Technician-Id': String(techId()) } });
    var data = await res.json();
    state.stepsFromDraft = false;
    state.themen = (data && data.arbeitsschritte) ? data.arbeitsschritte : [];
    state.presetNames = (data && data.preset_names) ? data.preset_names : [];
    renderPresetHint();
  }

  function closeStepPicker() {
    var modal = el('schulungStepPicker');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function openStepPicker() {
    var res = await fetch(API_BASE + '/api/arbeitsschritte_list?technician_id=' + encodeURIComponent(techId()) + '&local_only=1&catalog_kind=schulung', {
      headers: { 'X-Technician-Id': String(techId()) },
    });
    var data = await res.json().catch(function () { return {}; });
    state.catalog = (data && data.steps) ? data.steps : [];
    var have = {};
    state.themen.forEach(function (step) { have[String(step.bezeichnung_de || '').trim()] = 1; });
    var list = el('schulungStepPickerList');
    var available = state.catalog.filter(function (step) { return !have[String(step.bezeichnung_de || '').trim()]; });
    if (list) {
      list.innerHTML = available.length ? available.map(function (step) {
        var key = String(step.scope || 'global') + ':' + step.id;
        return '<label class="as-row" style="display:flex;gap:0.5rem;align-items:center;padding:0.35rem 0"><input type="checkbox" data-schulung-pick="' + esc(key) + '"><span>' + esc(step.bezeichnung_de || '') + '</span></label>';
      }).join('') : '<p class="muted">Keine weiteren Schritte im Katalog.</p>';
    }
    var modal = el('schulungStepPicker');
    if (modal) {
      modal.classList.add('active');
      modal.setAttribute('aria-hidden', 'false');
    }
  }

  function applyStepPicker() {
    var list = el('schulungStepPickerList');
    if (!list) return;
    list.querySelectorAll('[data-schulung-pick]').forEach(function (box) {
      if (!box.checked) return;
      var key = box.getAttribute('data-schulung-pick');
      var step = state.catalog.find(function (row) { return String(row.scope || 'global') + ':' + row.id === key; });
      if (!step) return;
      state.themen.push(shapeThema({
        bezeichnung_de: step.bezeichnung_de || '',
        bezeichnung_en: step.bezeichnung_en || '',
        erklaerung_de: step.erklaerung_de,
        erklaerung_en: step.erklaerung_en,
        status: 'na',
        bemerkung: '',
        sort_order: state.themen.length + 1,
      }));
    });
    closeStepPicker();
    renderThemen();
    scheduleSave();
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
    if (el('schulungProjekt')) el('schulungProjekt').value = deriveProjekt(data.job);
    var draftRes = await fetch(API_BASE + '/api/protokolle/schulungsprotokoll?job_id=' + encodeURIComponent(id) + '&local_only=1', {
      headers: { 'X-Technician-Id': String(techId()) },
    });
    var draft = await draftRes.json().catch(function () { return {}; });
    await loadDefaults(jobTypes());
    if (draft && draft.ok && draft.data) {
      state.teilnehmer = Array.isArray(draft.data.teilnehmer) ? draft.data.teilnehmer : [];
      state.revision = draft.data.revision || 0;
      if (draft.data.projekt && el('schulungProjekt')) el('schulungProjekt').value = draft.data.projekt;
      if (Array.isArray(draft.data.languages)) {
        if (el('schulungLangDe')) el('schulungLangDe').checked = draft.data.languages.indexOf('de') !== -1;
        if (el('schulungLangEn')) el('schulungLangEn').checked = draft.data.languages.indexOf('en') !== -1;
      }
      var savedByTitle = {};
      (Array.isArray(draft.data.themen) ? draft.data.themen : []).forEach(function (step) {
        shapeThema(step);
        var key = String(step.bezeichnung_de || '').trim().toLowerCase();
        if (key) savedByTitle[key] = step;
      });
      state.themen = state.themen.map(function (step) {
        var saved = savedByTitle[String(step.bezeichnung_de || '').trim().toLowerCase()];
        if (!saved) return step;
        return {
          bezeichnung_de: step.bezeichnung_de,
          bezeichnung_en: step.bezeichnung_en,
          erklaerung_de: saved.erklaerung_de != null ? saved.erklaerung_de : step.erklaerung_de,
          erklaerung_en: saved.erklaerung_en != null ? saved.erklaerung_en : step.erklaerung_en,
          status: saved.status || step.status || 'na',
          bemerkung: saved.bemerkung || '',
          sort_order: step.sort_order,
        };
      });
      state.stepsFromDraft = false;
    }
    renderKopf();
    renderPresetHint();
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

  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function pickDefaultJobId(jobs, preferred) {
    if (!Array.isArray(jobs) || !jobs.length) return '';
    function inList(id) {
      if (id == null || id === '') return '';
      for (var i = 0; i < jobs.length; i++) {
        var job = jobs[i];
        if (!job) continue;
        if (job.id == id || job.server_id == id) return String(job.id);
      }
      return '';
    }
    var hit = inList(preferred);
    if (hit) return hit;
    var today = todayYmd();
    var todayJobs = jobs.filter(function (job) {
      if (!job) return false;
      var start = String(job.start_datetime || '').slice(0, 10);
      var end = String(job.end_datetime || job.start_datetime || '').slice(0, 10);
      if (start && end) return today >= start && today <= end;
      return !!(start && today === start);
    });
    if (todayJobs.length) {
      todayJobs.sort(function (a, b) {
        var sa = String(a.start_datetime || '');
        var sb = String(b.start_datetime || '');
        if (sa !== sb) return sa < sb ? 1 : -1;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
      return String(todayJobs[0].id);
    }
    if (jobs.length === 1) return String(jobs[0].id);
    return '';
  }

  var openToken = 0;
  async function openProtokolleSchulung(preferredId) {
    var token = ++openToken;
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
    if (token !== openToken) return;
    var jobs = (data && data.jobs) || [];
    select.innerHTML = '<option value="">-- Auftrag wählen --</option>' + jobs.map(function (job) {
      return '<option value="' + job.id + '">' + esc((job.job_number || '') + ' ' + (job.customer_name || '')) + '</option>';
    }).join('');
    var pick = pickDefaultJobId(jobs, preferredId);
    if (pick) {
      select.value = pick;
      await loadJob(pick);
    }
  }
  window.openProtokolleSchulung = function (preferredId) {
    openProtokolleSchulung(preferredId).catch(function (e) { hint(e.message || 'Aufträge nicht geladen.'); });
  };

  document.addEventListener('change', function (ev) {
    if (ev.target && (ev.target.id === 'schulungLangDe' || ev.target.id === 'schulungLangEn')) {
      renderThemen();
      renderKopf();
      scheduleSave();
    }
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
    if (t.id === 'btnSchulungAddStep') {
      ev.preventDefault();
      openStepPicker().catch(function (e) { hint(e.message || 'Katalog nicht geladen.'); });
    }
    if (t.id === 'btnSchulungResetSteps') {
      ev.preventDefault();
      loadDefaults(jobTypes()).then(function () {
        renderThemen();
        scheduleSave();
      }).catch(function (e) { hint(e.message || 'Set nicht geladen.'); });
    }
    if (t.id === 'btnSchulungStepPickerOk') applyStepPicker();
    if (t.id === 'btnSchulungStepPickerCancel') closeStepPicker();
    var removeIdx = t.getAttribute('data-schulung-remove');
    if (removeIdx != null) {
      state.themen.splice(parseInt(removeIdx, 10), 1);
      renderThemen();
      scheduleSave();
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
    var explainIdx = t.getAttribute('data-schulung-erklaerung');
    if (explainIdx != null && state.themen[explainIdx]) {
      if (enOnly()) state.themen[explainIdx].erklaerung_en = t.value;
      else state.themen[explainIdx].erklaerung_de = t.value;
      scheduleSave();
    }
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
