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

  function countryList() {
    return window.HOTEL_COUNTRIES || [];
  }

  function countryByCode(code) {
    var want = String(code || '').toUpperCase();
    if (!want) return null;
    var list = countryList();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].code || '').toUpperCase() === want) return list[i];
    }
    return null;
  }

  function flagSrc(code) {
    var c = String(code || '').toLowerCase().slice(0, 2);
    return /^[a-z]{2}$/.test(c) ? 'flags/' + c + '.png' : '';
  }

  function validForFact(code) {
    var entry = countryByCode(code);
    if (!entry) return '<div class="dok-fact"><span>Gültig für</span><strong>—</strong></div>';
    var src = flagSrc(entry.code);
    var img = src ? '<img class="dok-flag" src="' + esc(src) + '" alt="" width="20" height="15">' : '';
    var mark = entry.flag ? esc(entry.flag) + ' ' : '';
    return '<div class="dok-fact"><span>Gültig für</span><strong>' + img + mark + esc(entry.name) + '</strong></div>';
  }

  function fillValidFor() {
    var sel = document.getElementById('dokValidFor');
    if (!sel || sel.getAttribute('data-ready') === '1') return;
    var html = '<option value="">Keine Angabe</option>';
    countryList().forEach(function (c, idx) {
      if (idx === 5) html += '<option value="" disabled>──────────</option>';
      html += '<option value="' + esc(c.code) + '">' + esc((c.name || '') + ' ' + (c.flag || '') + ' (' + (c.code || '') + ')') + '</option>';
    });
    sel.innerHTML = html;
    sel.setAttribute('data-ready', '1');
  }

  function showValidForFlag(code) {
    var img = document.getElementById('dokValidForFlag');
    if (!img) return;
    var src = flagSrc(code);
    if (!src) {
      img.hidden = true;
      img.removeAttribute('src');
      return;
    }
    img.hidden = false;
    img.onerror = function () { img.hidden = true; };
    img.src = src;
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
      function fact(label, value) {
        return '<div class="dok-fact"><span>' + esc(label) + '</span><strong>' + esc(value || '—') + '</strong></div>';
      }
      function deDate(value) {
        var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? (m[3] + '.' + m[2] + '.' + m[1]) : '—';
      }
      var line1 = fact('Nummer', d.document_number) + fact('Name', d.holder_name) + fact('Land', d.country) + validForFact(d.valid_for) + fact('Aussteller', d.issuer);
      if (d.title) line1 = fact('Bezeichnung', d.title) + line1;
      var line2 = fact('Ausstellung', deDate(d.issued_on)) + fact('Ablauf', deDate(d.valid_until))
        + fact('Vorlauf', String(d.reminder_days_before || 30) + ' Tage')
        + '<label class="dok-fact"><span>Erinnerung</span><strong><input type="checkbox" class="dok-remind" data-id="' + d.id + '"' + (d.reminder_enabled ? ' checked' : '') + '></strong></label>';
      return '<tr data-id="' + d.id + '">'
        + '<td><div class="dok-kind"><img alt="" src="icons/beleg/' + esc(d.doc_type) + '.png"><span>' + esc(d.doc_type_label || d.doc_type) + '</span></div></td>'
        + '<td>' + thumb + '</td>'
        + '<td><div class="dok-facts"><div class="dok-factline">' + line1 + '</div><div class="dok-factline">' + line2 + '</div></div></td>'
        + '<td class="dok-actions"><button type="button" class="btn btn-ghost dok-edit" data-id="' + d.id + '">Ändern</button> '
        + '<button type="button" class="btn btn-danger dok-del" data-id="' + d.id + '">Löschen</button></td>'
        + '</tr>';
    }).join('');
  }

  var docs = [];
  var editingId = 0;
  var imageSource = null;
  var imageEdited = false;
  var imageViewScale = 1;
  var cropRect = null;
  var cropDrag = null;

  function hideImageEdit() {
    imageSource = null;
    imageEdited = false;
    cropRect = null;
    cropDrag = null;
    var box = document.getElementById('dokImageEdit');
    if (box) box.hidden = true;
  }

  function drawImageEdit() {
    var canvas = document.getElementById('dokImageCanvas');
    if (!canvas || !imageSource) return;
    var maxW = 640;
    imageViewScale = imageSource.width > maxW ? maxW / imageSource.width : 1;
    canvas.width = Math.max(1, Math.round(imageSource.width * imageViewScale));
    canvas.height = Math.max(1, Math.round(imageSource.height * imageViewScale));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageSource, 0, 0, canvas.width, canvas.height);
    if (cropRect && cropRect.w > 2 && cropRect.h > 2) {
      ctx.strokeStyle = '#0e7b5a';
      ctx.lineWidth = 2;
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    }
  }

  function showImageEdit(dataUrl) {
    var img = new Image();
    img.onload = function () {
      imageSource = img;
      imageEdited = false;
      cropRect = null;
      var box = document.getElementById('dokImageEdit');
      if (box) box.hidden = false;
      drawImageEdit();
    };
    img.src = dataUrl;
  }

  function paintSource(width, height, draw) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    draw(ctx, c);
    var img = new Image();
    img.onload = function () {
      imageSource = img;
      imageEdited = true;
      cropRect = null;
      drawImageEdit();
    };
    img.src = c.toDataURL('image/jpeg', 0.92);
  }

  function rotateImage(dir) {
    if (!imageSource) return;
    var src = imageSource;
    paintSource(src.height, src.width, function (ctx, c) {
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(dir * Math.PI / 2);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
    });
  }

  function applyCrop() {
    if (!imageSource || !cropRect || cropRect.w < 8 || cropRect.h < 8) {
      setMsg('Zum Beschneiden zuerst ein Rechteck aufziehen.', true);
      return;
    }
    var sx = cropRect.x / imageViewScale;
    var sy = cropRect.y / imageViewScale;
    var sw = cropRect.w / imageViewScale;
    var sh = cropRect.h / imageViewScale;
    var src = imageSource;
    paintSource(sw, sh, function (ctx, c) {
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    });
  }

  function exportEditedJpeg() {
    return new Promise(function (resolve, reject) {
      if (!imageSource) { reject(new Error('image')); return; }
      var c = document.createElement('canvas');
      c.width = imageSource.width;
      c.height = imageSource.height;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(imageSource, 0, 0);
      c.toBlob(function (blob) {
        if (!blob) { reject(new Error('image')); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var raw = String(reader.result || '');
          var comma = raw.indexOf(',');
          resolve({ b64: comma >= 0 ? raw.slice(comma + 1) : raw, name: 'dokument.jpg' });
        };
        reader.onerror = function () { reject(new Error('image')); };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.92);
    });
  }

  function loadExistingImage(id) {
    fetch(fileUrl(id, 'file'), { headers: headers(false) })
      .then(function (r) { if (!r.ok) throw new Error('file'); return r.blob(); })
      .then(function (blob) {
        if (blob.type !== 'image/jpeg' && blob.type !== 'image/png') {
          setMsg('Nur Fotos lassen sich drehen und beschneiden.', true);
          return;
        }
        var reader = new FileReader();
        reader.onload = function () { showImageEdit(String(reader.result || '')); };
        reader.readAsDataURL(blob);
      })
      .catch(function () { setMsg('Bild nicht verfügbar.', true); });
  }

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

  function fileKind(file) {
    var type = String(file && file.type || '').toLowerCase();
    var name = String(file && file.name || '').toLowerCase();
    if (type === 'image/jpeg' || type === 'image/jpg' || /\.jpe?g$/.test(name)) return 'image/jpeg';
    if (type === 'image/png' || /\.png$/.test(name)) return 'image/png';
    if (type === 'application/pdf' || type === 'application/x-pdf' || /\.pdf$/.test(name)) return 'application/pdf';
    return '';
  }

  function namedIncoming(file) {
    var kind = fileKind(file);
    if (!kind) return null;
    var fallback = kind === 'application/pdf' ? 'einfuegen.pdf' : (kind === 'image/png' ? 'einfuegen.png' : 'einfuegen.jpg');
    var name = file.name && file.name !== 'image.png' ? file.name : fallback;
    if (file.type === kind && file.name === name) return file;
    return new File([file], name, { type: kind });
  }

  function setDropName(name) {
    var el = document.getElementById('dokDropName');
    if (el) el.textContent = name || '';
  }

  function clipboardFile(ev) {
    var cd = ev.clipboardData;
    if (!cd) return null;
    if (cd.files && cd.files.length) return cd.files[0];
    var items = cd.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) return f;
      }
    }
    return null;
  }

  function takeIncoming(file) {
    var ready = namedIncoming(file);
    if (!ready) { setMsg('Nur PDF, JPEG oder PNG.', true); return; }
    var modal = document.getElementById('dokModal');
    if (modal && modal.hidden) openForm(null);
    var input = document.getElementById('dokFile');
    var dt = new DataTransfer();
    dt.items.add(ready);
    input.files = dt.files;
    setDropName(ready.name);
    input.dispatchEvent(new Event('change'));
  }

  function bindFileTarget(el) {
    if (!el) return;
    el.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      el.classList.add('is-over');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('is-over'); });
    el.addEventListener('drop', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.remove('is-over');
      var dropped = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (dropped) takeIncoming(dropped);
    });
  }

  function openForm(doc) {
    fillTypes();
    fillValidFor();
    editingId = doc ? doc.id : 0;
    document.getElementById('dokFormTitle').textContent = doc ? 'Dokument ändern' : 'Dokument hinzufügen';
    document.querySelectorAll('.dok-type').forEach(function (btn) {
      btn.classList.toggle('is-on', doc && btn.getAttribute('data-type') === doc.doc_type);
    });
    document.getElementById('dokTitle').value = doc ? (doc.title || '') : '';
    document.getElementById('dokNumber').value = doc ? (doc.document_number || '') : '';
    document.getElementById('dokName').value = doc ? (doc.holder_name || '') : '';
    document.getElementById('dokCountry').value = doc ? (doc.country || '') : '';
    var validFor = document.getElementById('dokValidFor');
    if (validFor) validFor.value = doc && doc.valid_for ? doc.valid_for : '';
    showValidForFlag(validFor ? validFor.value : '');
    document.getElementById('dokIssuer').value = doc ? (doc.issuer || '') : '';
    document.getElementById('dokIssued').value = doc ? (doc.issued_on || '') : '';
    document.getElementById('dokUntil').value = doc ? (doc.valid_until || '') : '';
    document.getElementById('dokNotes').value = doc ? (doc.notes || '') : '';
    document.getElementById('dokDays').value = String(doc ? (doc.reminder_days_before || 30) : 30);
    document.getElementById('dokRemind').checked = !!(doc && doc.reminder_enabled);
    document.getElementById('dokFile').value = '';
    setDropName('');
    hideImageEdit();
    var editBtn = document.getElementById('dokEditImage');
    if (editBtn) {
      var isImg = !!(doc && doc.has_file && (doc.file_mime === 'image/jpeg' || doc.file_mime === 'image/png'));
      editBtn.hidden = !isImg;
    }
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
    var validFor = document.getElementById('dokValidFor');
    if (validFor) validFor.addEventListener('change', function () { showValidForFlag(validFor.value); });
    root.addEventListener('error', function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('dok-flag')) ev.target.hidden = true;
    }, true);
    document.getElementById('dokCancel').addEventListener('click', function () {
      hideImageEdit();
      document.getElementById('dokModal').hidden = true;
    });
    bindFileTarget(document.getElementById('dokDrop'));
    bindFileTarget(root);
    document.addEventListener('paste', function (ev) {
      var viewOn = root.classList.contains('active');
      var modal = document.getElementById('dokModal');
      if (!viewOn && !(modal && !modal.hidden)) return;
      var active = document.activeElement;
      var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.id !== 'dokFile';
      var pasted = clipboardFile(ev);
      if (!pasted) return;
      if (typing && ev.clipboardData && ev.clipboardData.getData('text')) return;
      ev.preventDefault();
      takeIncoming(pasted);
    });
    document.getElementById('dokFile').addEventListener('change', function () {
      var file = document.getElementById('dokFile').files[0];
      setDropName(file ? file.name : '');
      imageEdited = false;
      if (!file || (file.type !== 'image/jpeg' && file.type !== 'image/png')) {
        hideImageEdit();
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { showImageEdit(String(reader.result || '')); };
      reader.readAsDataURL(file);
    });
    document.getElementById('dokEditImage').addEventListener('click', function () {
      if (editingId) loadExistingImage(editingId);
    });
    document.getElementById('dokRotLeft').addEventListener('click', function () { rotateImage(-1); });
    document.getElementById('dokRotRight').addEventListener('click', function () { rotateImage(1); });
    document.getElementById('dokCropApply').addEventListener('click', applyCrop);
    var canvas = document.getElementById('dokImageCanvas');
    canvas.addEventListener('pointerdown', function (ev) {
      if (!imageSource) return;
      var rect = canvas.getBoundingClientRect();
      var x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      var y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      cropDrag = { x: x, y: y };
      cropRect = { x: x, y: y, w: 0, h: 0 };
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!cropDrag) return;
      var rect = canvas.getBoundingClientRect();
      var x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      var y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      cropRect = {
        x: Math.min(cropDrag.x, x),
        y: Math.min(cropDrag.y, y),
        w: Math.abs(x - cropDrag.x),
        h: Math.abs(y - cropDrag.y)
      };
      drawImageEdit();
    });
    function endCropDrag() { cropDrag = null; }
    canvas.addEventListener('pointerup', endCropDrag);
    canvas.addEventListener('pointerleave', endCropDrag);
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
          valid_for: document.getElementById('dokValidFor').value,
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
      if (imageEdited && imageSource) {
        exportEditedJpeg().then(function (out) { send(out.b64, out.name); }).catch(function () {
          setMsg('Bild konnte nicht übernommen werden.', true);
        });
        return;
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
