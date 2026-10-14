(function () {
  var TYPES = [
    ['reisepass', 'Reisepass'],
    ['visum_eta_esta', 'Visum/ETA/ESTA'],
    ['vignette', 'Vignette'],
    ['fuehrerschein', 'Führerschein'],
    ['oebb_vorteilskarte', 'ÖBB Vorteilskarte']
  ];

  function apiBase() {
    return (typeof monteurApp !== 'undefined' && monteurApp.apiBase) ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  }

  function techId() {
    return typeof window.getTechId === 'function' ? window.getTechId() : 0;
  }

  function headers(json) {
    var h = { 'X-Technician-Id': String(techId() || '') };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function setMsg(text, bad) {
    var el = document.getElementById('dokMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? '#b3261e' : '';
  }

  function fileUrl(id, part) {
    return apiBase() + '/api/doc-safe/file?id=' + encodeURIComponent(id) + '&part=' + part
      + '&technician_id=' + encodeURIComponent(String(techId() || ''));
  }

  function render(docs) {
    var body = document.getElementById('dokBody');
    if (!body) return;
    if (!docs.length) {
      body.innerHTML = '<tr><td colspan="4">Keine Dokumente.</td></tr>';
      return;
    }
    body.innerHTML = docs.map(function (d) {
      var thumb = '';
      if (d.has_preview) {
        thumb = '<img class="dok-thumb" alt="" data-id="' + d.id + '" data-part="preview" src="' + esc(fileUrl(d.id, 'preview')) + '">';
      } else if (d.has_file && (d.file_mime === 'image/jpeg' || d.file_mime === 'image/png')) {
        thumb = '<img class="dok-thumb" alt="" data-id="' + d.id + '" data-part="file" src="' + esc(fileUrl(d.id, 'file')) + '">';
      }
      var details = [
        d.title, d.document_number, d.holder_name, d.country, d.issuer,
        d.issued_on ? ('Ausstellung ' + d.issued_on) : '',
        d.valid_until ? ('Ablauf ' + d.valid_until) : ''
      ].filter(Boolean).map(esc).join('<br>');
      return '<tr data-id="' + d.id + '">'
        + '<td>' + thumb + '</td>'
        + '<td><img class="dok-kind" alt="" src="icons/beleg/' + esc(d.doc_type) + '.png"> ' + esc(d.doc_type_label || d.doc_type) + '</td>'
        + '<td>' + details
        + '<div>Vorlauf: ' + esc(String(d.reminder_days_before || 30)) + ' Tage</div>'
        + '<label><input type="checkbox" class="dok-remind" data-id="' + d.id + '"' + (d.reminder_enabled ? ' checked' : '') + '> Erinnerung</label></td>'
        + '<td><button type="button" class="btn btn-ghost dok-edit" data-id="' + d.id + '">Ändern</button> '
        + '<button type="button" class="btn btn-danger dok-del" data-id="' + d.id + '">Löschen</button></td>'
        + '</tr>';
    }).join('');
  }

  var docs = [];
  var editingId = 0;

  function load() {
    return fetch(apiBase() + '/api/doc-safe?technician_id=' + encodeURIComponent(String(techId() || '')), { headers: headers(false) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          setMsg((data && data.error) || 'Laden fehlgeschlagen.', true);
          return;
        }
        docs = data.documents || [];
        render(docs);
      })
      .catch(function () { setMsg('Laden fehlgeschlagen.', true); });
  }

  function syncThenLoad() {
    load().then(function () {
      fetch(apiBase() + '/api/doc-safe/sync', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ technician_id: techId() })
      }).then(function () { return load(); }).catch(function () {});
    });
  }

  function openOriginal(id, filename) {
    fetch(fileUrl(id, 'file'), { headers: headers(false) })
      .then(function (r) { if (!r.ok) throw new Error('no'); return r.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener');
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'dokument';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      })
      .catch(function () { setMsg('Datei nicht verfügbar.', true); });
  }

  function ensurePop() {
    var pop = document.getElementById('dokPreviewPop');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'dokPreviewPop';
    pop.className = 'kukla-file-preview-pop';
    pop.innerHTML = '<img alt="">';
    document.body.appendChild(pop);
    return pop;
  }

  function fillTypes() {
    var box = document.getElementById('dokTypes');
    if (!box || box.childElementCount) return;
    box.innerHTML = TYPES.map(function (t) {
      return '<button type="button" class="dok-type" data-type="' + t[0] + '"><img alt="" src="icons/beleg/' + t[0] + '.png"><span>' + esc(t[1]) + '</span></button>';
    }).join('');
  }

  function openForm(doc) {
    fillTypes();
    editingId = doc ? doc.id : 0;
    document.getElementById('dokFormTitle').textContent = doc ? 'Dokument ändern' : 'Dokument hinzufügen';
    document.querySelectorAll('.dok-type').forEach(function (btn) {
      btn.classList.toggle('is-on', doc && btn.getAttribute('data-type') === doc.doc_type);
    });
    document.getElementById('dokTitle').value = doc ? (doc.title || '') : '';
    document.getElementById('dokNumber').value = doc ? (doc.document_number || '') : '';
    document.getElementById('dokName').value = doc ? (doc.holder_name || '') : '';
    document.getElementById('dokCountry').value = doc ? (doc.country || '') : '';
    document.getElementById('dokIssuer').value = doc ? (doc.issuer || '') : '';
    document.getElementById('dokIssued').value = doc ? (doc.issued_on || '') : '';
    document.getElementById('dokUntil').value = doc ? (doc.valid_until || '') : '';
    document.getElementById('dokNotes').value = doc ? (doc.notes || '') : '';
    document.getElementById('dokDays').value = String(doc ? (doc.reminder_days_before || 30) : 30);
    document.getElementById('dokRemind').checked = !!(doc && doc.reminder_enabled);
    document.getElementById('dokFile').value = '';
    document.getElementById('dokModal').hidden = false;
  }

  function selectedType() {
    var on = document.querySelector('.dok-type.is-on');
    return on ? on.getAttribute('data-type') : '';
  }

  function bind() {
    var root = document.getElementById('viewDokumente');
    if (!root || root.getAttribute('data-bound') === '1') return;
    root.setAttribute('data-bound', '1');
    document.getElementById('dokAdd').addEventListener('click', function () { openForm(null); });
    document.getElementById('dokCancel').addEventListener('click', function () {
      document.getElementById('dokModal').hidden = true;
    });
    document.getElementById('dokTypes').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.dok-type');
      if (!btn) return;
      document.querySelectorAll('.dok-type').forEach(function (el) { el.classList.remove('is-on'); });
      btn.classList.add('is-on');
    });
    document.getElementById('dokForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var type = selectedType();
      if (!type) { setMsg('Dokumentenart wählen.', true); return; }
      var file = document.getElementById('dokFile').files[0];
      if (!editingId && !file) { setMsg('Datei wählen.', true); return; }
      function send(b64, name) {
        var body = {
          action: 'save',
          id: editingId || undefined,
          technician_id: techId(),
          doc_type: type,
          title: document.getElementById('dokTitle').value,
          document_number: document.getElementById('dokNumber').value,
          holder_name: document.getElementById('dokName').value,
          country: document.getElementById('dokCountry').value,
          issuer: document.getElementById('dokIssuer').value,
          issued_on: document.getElementById('dokIssued').value,
          valid_until: document.getElementById('dokUntil').value,
          notes: document.getElementById('dokNotes').value,
          reminder_days_before: document.getElementById('dokDays').value,
          reminder_enabled: document.getElementById('dokRemind').checked,
          original_filename: name || ''
        };
        if (b64) body.file_base64 = b64;
        fetch(apiBase() + '/api/doc-safe', { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || !data.ok) { setMsg((data && data.error) || 'Speichern fehlgeschlagen.', true); return; }
            document.getElementById('dokModal').hidden = true;
            setMsg('Gespeichert.');
            syncThenLoad();
          })
          .catch(function () { setMsg('Speichern fehlgeschlagen.', true); });
      }
      if (!file) { send('', ''); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || '');
        var comma = raw.indexOf(',');
        send(comma >= 0 ? raw.slice(comma + 1) : raw, file.name);
      };
      reader.readAsDataURL(file);
    });
    root.addEventListener('click', function (ev) {
      var del = ev.target.closest('.dok-del');
      if (del) {
        if (!window.confirm('Dokument wirklich löschen?')) return;
        fetch(apiBase() + '/api/doc-safe', {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify({ action: 'delete', id: parseInt(del.getAttribute('data-id'), 10), technician_id: techId() })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (!data || !data.ok) { setMsg('Löschen fehlgeschlagen.', true); return; }
          setMsg('Gelöscht.');
          syncThenLoad();
        }).catch(function () { setMsg('Löschen fehlgeschlagen.', true); });
        return;
      }
      var edit = ev.target.closest('.dok-edit');
      if (edit) {
        var id = parseInt(edit.getAttribute('data-id'), 10);
        var doc = docs.filter(function (d) { return d.id === id; })[0];
        if (doc) openForm(doc);
        return;
      }
      var img = ev.target.closest('.dok-thumb');
      if (img) {
        var docId = parseInt(img.getAttribute('data-id'), 10);
        var doc = docs.filter(function (d) { return d.id === docId; })[0];
        openOriginal(docId, doc && doc.original_filename);
      }
    });
    root.addEventListener('change', function (ev) {
      var box = ev.target.closest('.dok-remind');
      if (!box) return;
      var id = parseInt(box.getAttribute('data-id'), 10);
      var doc = docs.filter(function (d) { return d.id === id; })[0];
      if (!doc) return;
      var body = Object.assign({}, doc, { action: 'save', reminder_enabled: box.checked, technician_id: techId() });
      delete body.file_mime;
      fetch(apiBase() + '/api/doc-safe', { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (data) { if (!data || !data.ok) setMsg('Erinnerung nicht gespeichert.', true); })
        .catch(function () { setMsg('Erinnerung nicht gespeichert.', true); });
    });
    root.addEventListener('mouseover', function (ev) {
      var img = ev.target.closest('.dok-thumb');
      if (!img) return;
      var pop = ensurePop();
      pop.querySelector('img').src = img.src;
      pop.classList.add('is-open');
      var rect = img.getBoundingClientRect();
      pop.style.left = Math.min(rect.right + 8, window.innerWidth - 420) + 'px';
      pop.style.top = Math.max(8, rect.top) + 'px';
    });
    root.addEventListener('mouseout', function (ev) {
      if (!ev.target.closest('.dok-thumb')) return;
      var pop = document.getElementById('dokPreviewPop');
      if (pop) pop.classList.remove('is-open');
    });
  }

  window.kuklaLoadDokumente = function () {
    bind();
    syncThenLoad();
  };
})();
