/**
 * Anlagenakte-Reiter Parameter: Liste + Vergleich im eigenen Fenster.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function techId() {
    try {
      return String(localStorage.getItem('monteur_technicianId') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function fmtWhen(iso) {
    var s = String(iso || '').trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!m) return s;
    var out = m[3] + '.' + m[2] + '.' + m[1];
    if (m[4]) out += ' ' + m[4] + ':' + m[5];
    return out;
  }

  function fmtSize(n) {
    var v = Number(n || 0);
    if (!v) return '';
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  var lastFab = '';

  function currentFab() {
    if (lastFab) return lastFab;
    var ids = ['formFab', 'anlagenFabInput'];
    var i;
    for (i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && String(el.value || '').trim()) return String(el.value).trim();
    }
    var top = document.getElementById('akteTopbarFn');
    if (top) {
      var t = String(top.textContent || '').trim();
      if (t && t !== 'Anlage' && t !== 'Neue Anlage') return t;
    }
    var p = new URLSearchParams(window.location.search);
    return String(p.get('fab') || '').trim();
  }

  function isPwa() {
    return !!(root.PwaApi && typeof root.PwaApi.getJson === 'function');
  }

  function isMonteurLaptop() {
    return !!(root.KUKLA_MONTEUR_LAPTOP || root.monteurApp);
  }

  function usesHtmlCompareWindow() {
    var host = String(location.hostname || '');
    return host === '127.0.0.1' || host === 'localhost';
  }

  function jsonPost(url, body) {
    var headers = { 'Content-Type': 'application/json' };
    var tid = techId();
    if (tid) headers['X-Technician-Id'] = tid;
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function fetchList(fab) {
    if (isPwa()) {
      return root.PwaApi.getJson('/api/mobile/anlagenstamm_parameter_files_list.php?fab=' + encodeURIComponent(fab));
    }
    if (isMonteurLaptop()) {
      var payload = { fab: fab, technician_id: techId() };
      try {
        if (typeof root.getDispoBaseUrl === 'function') payload.baseUrl = root.getDispoBaseUrl();
        if (typeof root.getDispoUsername === 'function') payload.serverUsername = root.getDispoUsername();
      } catch (_) {}
      return jsonPost('/api/anlagenstamm_parameter_files_list', payload);
    }
    return jsonPost('/api/anlagenstamm_parameter_files_list.php', { fab: fab });
  }

  function openView(fab, fileId) {
    if (typeof root.kuklaAkteOpenParameterView === 'function') {
      root.kuklaAkteOpenParameterView(fab, fileId);
      return;
    }
    if (isPwa() && root.KuklaAnlagenAktePwa && typeof root.KuklaAnlagenAktePwa.openParameterView === 'function') {
      root.KuklaAnlagenAktePwa.openParameterView(fab, fileId);
    }
  }

  function downloadUrl(fab, fileId) {
    if (isPwa()) {
      return '/api/mobile/anlagenstamm_parameter_download.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
    }
    if (isMonteurLaptop()) {
      return '/api/anlagenstamm_parameter_download.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
    }
    return '/api/anlagenstamm_parameter_download.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
  }

  function pdfUrl(fab, fileId) {
    if (typeof root.kuklaAktePdfUrl === 'function') {
      return root.kuklaAktePdfUrl('parameter', { fab: fab, file_id: fileId });
    }
    if (isPwa()) {
      return '/api/mobile/anlagenstamm_parameter_pdf.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
    }
    return '/api/anlagenstamm_parameter_pdf.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fileId));
  }

  function triggerDownload(url) {
    if (isPwa() && root.PwaApi && typeof root.PwaApi.request === 'function') {
      root.PwaApi.request(url).then(function (res) {
        if (!res.ok) throw new Error('Download fehlgeschlagen');
        return res.blob();
      }).then(function (blob) {
        var href = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = href;
        a.download = 'parameterliste';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
      }).catch(function (e) {
        alert(e.message || 'Download fehlgeschlagen');
      });
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  function compareWindowUrl(fab, fromId, toId) {
    var q = 'fab=' + encodeURIComponent(fab) +
      '&from_file_id=' + encodeURIComponent(String(fromId)) +
      '&to_file_id=' + encodeURIComponent(String(toId));
    if (isPwa()) return '';
    if (usesHtmlCompareWindow()) return '/parameter-compare-window.html?' + q;
    return '/anlagenstamm_parameter_compare.php?' + q;
  }

  function openPwaCompareOverlay(fab, fromId, toId, fromName, toName) {
    var existing = document.getElementById('akteParamCompare');
    if (existing) existing.remove();
    var wrap = document.createElement('div');
    wrap.id = 'akteParamCompare';
    wrap.className = 'akte-viewer';
    wrap.innerHTML = '<div class="akte-viewer-box param-npp-overlay"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:10px">' +
      '<strong>Parameter-Vergleich</strong><button type="button" class="kukla-jobs-refresh" id="akteParamCompareClose">Schließen</button></div>' +
      '<p class="akte-muted">Vergleich wird berechnet …</p></div>';
    document.body.appendChild(wrap);
    document.getElementById('akteParamCompareClose').onclick = function () { wrap.remove(); };
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    var Cmp = root.KuklaParameterTextCompare;
    if (!Cmp || !root.PwaApi) return;
    Promise.all([
      root.PwaApi.getJson('/api/mobile/anlagenstamm_parameter_view.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(fromId))),
      root.PwaApi.getJson('/api/mobile/anlagenstamm_parameter_view.php?fab=' + encodeURIComponent(fab) + '&file_id=' + encodeURIComponent(String(toId))),
    ]).then(function (parts) {
      var a = parts[0];
      var b = parts[1];
      if (!a || !a.ok || !b || !b.ok) throw new Error((a && a.error) || (b && b.error) || 'Dateien nicht geladen');
      var diff = Cmp.compareParameterTextLines(a.raw_content || '', b.raw_content || '');
      var box = wrap.querySelector('.akte-viewer-box');
      var head = box.querySelector('div');
      box.innerHTML = '';
      box.appendChild(head);
      var host = document.createElement('div');
      host.innerHTML = Cmp.renderCompareHtml(diff, fromName || a.file && a.file.original_filename, toName || b.file && b.file.original_filename);
      box.appendChild(host);
      Cmp.bindOnlyDiff(host);
    }).catch(function (e) {
      var p = wrap.querySelector('p');
      if (p) p.textContent = e.message || String(e);
    });
  }

  function openCompare(fab, fromF, toF) {
    var fromId = fromF.id || fromF.local_id;
    var toId = toF.id || toF.local_id;
    if (isPwa()) {
      openPwaCompareOverlay(fab, fromId, toId, fromF.original_filename, toF.original_filename);
      return;
    }
    var url = compareWindowUrl(fab, fromId, toId);
    window.open(url, 'kukla_param_compare', 'width=1280,height=860,scrollbars=yes,resizable=yes');
  }

  function canUpload() {
    if (isPwa()) return false;
    return root.ANLAGENSTAMM_READ_ONLY !== true;
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = function () { reject(new Error('Datei konnte nicht gelesen werden.')); };
      reader.readAsDataURL(file);
    });
  }

  function postIngest(fab, filename, contentB64, mime) {
    var payload = {
      fab: fab,
      filename: filename,
      content: contentB64,
      source: 'upload',
      mime: mime || 'text/plain',
    };
    if (isMonteurLaptop()) {
      payload.technician_id = techId();
      try {
        if (typeof root.getDispoBaseUrl === 'function') payload.baseUrl = root.getDispoBaseUrl();
        if (typeof root.getDispoUsername === 'function') payload.serverUsername = root.getDispoUsername();
      } catch (_) {}
      return jsonPost('/api/anlagenstamm_parameter_ingest', payload);
    }
    return jsonPost('/api/anlagenstamm_parameter_ingest.php', payload);
  }

  function selectedFilesFromInput(input) {
    var out = [];
    if (!input || !input.files) return out;
    Array.prototype.forEach.call(input.files, function (f) { if (f) out.push(f); });
    return out;
  }

  function renderSelectedFiles(listEl, files) {
    if (!listEl) return;
    if (!files.length) {
      listEl.innerHTML = '<li class="akte-muted muted">Keine Datei gewählt.</li>';
      return;
    }
    listEl.innerHTML = files.map(function (f) {
      return '<li>' + esc(f.name) + (f.size ? ' · ' + esc(fmtSize(f.size)) : '') + '</li>';
    }).join('');
  }

  function ensureUploadModal() {
    var modal = document.getElementById('akteParamUploadModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'akteParamUploadModal';
    modal.className = 'parameterlisten-akte-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'akteParamUploadTitle');
    modal.innerHTML =
      '<div class="parameterlisten-akte-modal-dialog">' +
      '<div class="parameterlisten-akte-modal-head" id="akteParamUploadTitle">Parameterlisten hochladen</div>' +
      '<div class="parameterlisten-akte-modal-body">' +
      '<p class="akte-muted muted" id="akteParamUploadHint"></p>' +
      '<div class="parameterlisten-akte-upload-field">' +
      '<label>Parameterdateien</label>' +
      '<input type="file" id="akteParamUploadFiles" accept=".csv,.pal,.pa3,.txt,.pa4,.pa5,.pa6,.pa7" multiple>' +
      '<button type="button" class="btn btn-secondary kukla-jobs-refresh" id="akteParamUploadChoose">Datei auswählen …</button>' +
      '</div>' +
      '<ul class="parameterlisten-akte-upload-list" id="akteParamUploadList"></ul>' +
      '<p class="akte-muted muted" id="akteParamUploadStatus"></p>' +
      '</div>' +
      '<div class="parameterlisten-akte-modal-footer">' +
      '<button type="button" class="btn btn-secondary kukla-jobs-refresh" id="akteParamUploadCancel">Abbrechen</button>' +
      '<button type="button" class="btn btn-primary" id="akteParamUploadSubmit">Hochladen</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    var input = document.getElementById('akteParamUploadFiles');
    var listEl = document.getElementById('akteParamUploadList');
    var statusEl = document.getElementById('akteParamUploadStatus');
    var choose = document.getElementById('akteParamUploadChoose');
    var cancel = document.getElementById('akteParamUploadCancel');
    var submit = document.getElementById('akteParamUploadSubmit');
    modal._plFiles = [];
    function refreshList() {
      modal._plFiles = selectedFilesFromInput(input);
      renderSelectedFiles(listEl, modal._plFiles);
    }
    choose.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', refreshList);
    cancel.addEventListener('click', function () { closeUploadModal(); });
    modal.addEventListener('click', function (ev) { if (ev.target === modal) closeUploadModal(); });
    submit.addEventListener('click', function () {
      var fab = String(modal.getAttribute('data-pl-fab') || currentFab() || '').trim();
      var files = modal._plFiles || [];
      if (!fab) {
        statusEl.textContent = 'Fabrikationsnummer fehlt.';
        return;
      }
      if (!files.length) {
        statusEl.textContent = 'Bitte mindestens eine Datei wählen.';
        return;
      }
      submit.disabled = true;
      choose.disabled = true;
      statusEl.textContent = 'Hochladen …';
      var results = [];
      var i = 0;
      function next() {
        if (i >= files.length) {
          submit.disabled = false;
          choose.disabled = false;
          statusEl.textContent = results.join(' · ');
          var rootEl = document.getElementById('anlagenParameterRoot');
          if (rootEl) load(rootEl, fab);
          var failed = results.some(function (r) { return /fehlgeschlagen|Fehler|gehört zu/i.test(r); });
          if (!failed) {
            setTimeout(function () { closeUploadModal(); }, 700);
          }
          return;
        }
        var file = files[i];
        var name = file && file.name ? file.name : 'datei';
        fileToBase64(file).then(function (b64) {
          return postIngest(fab, name, b64, file.type || 'text/plain');
        }).then(function (data) {
          if (!data || !data.ok) throw new Error((data && data.error) || 'Hochladen fehlgeschlagen');
          var note = name + ': gespeichert';
          if (data.dispo_ingest_error) note += ' (Dispo: ' + data.dispo_ingest_error + ')';
          results.push(note);
        }).catch(function (err) {
          results.push(name + ': ' + (err && err.message ? err.message : String(err)));
        }).then(function () {
          i += 1;
          next();
        });
      }
      next();
    });
    refreshList();
    return modal;
  }

  function closeUploadModal() {
    var modal = document.getElementById('akteParamUploadModal');
    if (!modal) return;
    modal.hidden = true;
    var input = document.getElementById('akteParamUploadFiles');
    if (input) input.value = '';
    modal._plFiles = [];
    renderSelectedFiles(document.getElementById('akteParamUploadList'), []);
    var statusEl = document.getElementById('akteParamUploadStatus');
    if (statusEl) statusEl.textContent = '';
    var submit = document.getElementById('akteParamUploadSubmit');
    var choose = document.getElementById('akteParamUploadChoose');
    if (submit) submit.disabled = false;
    if (choose) choose.disabled = false;
  }

  function openUploadModal(fab) {
    var modal = ensureUploadModal();
    fab = String(fab || currentFab() || '').trim();
    modal.setAttribute('data-pl-fab', fab);
    var hint = document.getElementById('akteParamUploadHint');
    if (hint) {
      hint.textContent = fab
        ? ('Dateien für Anlage ' + fab + '. Es wird kein PDF erzeugt – das machen Sie bei Bedarf mit dem Button PDF.')
        : 'Fabrikationsnummer fehlt.';
    }
    var input = document.getElementById('akteParamUploadFiles');
    if (input) input.value = '';
    modal._plFiles = [];
    renderSelectedFiles(document.getElementById('akteParamUploadList'), []);
    var statusEl = document.getElementById('akteParamUploadStatus');
    if (statusEl) statusEl.textContent = '';
    modal.hidden = false;
  }

  function toolbarHtml(fab) {
    if (!canUpload()) return '';
    return '<div class="parameterlisten-akte-toolbar">' +
      '<button type="button" class="btn btn-primary" data-pl-act="upload">Hochladen</button>' +
      '</div>';
  }

  function renderList(rootEl, fab, files) {
    var list = Array.isArray(files) ? files.slice() : [];
    var html = toolbarHtml(fab);
    if (!list.length) {
      html += '<p class="akte-muted muted">Keine Parameterlisten für diese Fabrikationsnummer.</p>';
      rootEl.innerHTML = html;
      rootEl._plFiles = [];
      rootEl._plFab = fab;
      return;
    }
    html += '<p class="akte-muted muted" style="margin:0 0 8px">Zwei Listen ankreuzen – der Vergleich öffnet sich in einem eigenen Fenster.</p>';
    html += '<div class="parameterlisten-akte-list">';
    list.forEach(function (f) {
      var name = f.original_filename || 'parameterliste';
      var id = String(f.id || f.local_id || '');
      var meta = [];
      var when = fmtWhen(f.display_datetime || f.uploaded_at);
      if (when) meta.push(when);
      if (f.size) meta.push(fmtSize(f.size));
      if (f.source === 'projekte_neu') meta.push('Projekte neu');
      else if (f.source) meta.push('Upload');
      if (f.entry_count) meta.push(String(f.entry_count) + ' Werte');
      html += '<div class="parameterlisten-file-row" data-pl-file-id="' + esc(id) + '">';
      html += '<label class="parameterlisten-compare-check"><input type="checkbox" data-pl-compare="1"></label>';
      html += '<div class="parameterlisten-file-main"><div class="parameterlisten-file-title"><span class="name">' +
        esc(name) + '</span></div><div class="parameterlisten-file-meta">' + esc(meta.join(' · ')) + '</div></div>';
      html += '<div class="parameterlisten-file-actions">';
      html += '<button type="button" class="btn btn-secondary kukla-jobs-refresh" data-pl-act="open">Öffnen</button>';
      html += '<button type="button" class="btn btn-secondary kukla-jobs-refresh" data-pl-act="download">Herunterladen</button>';
      html += '<button type="button" class="btn btn-secondary kukla-jobs-refresh" data-pl-act="pdf">PDF</button>';
      html += '</div></div>';
    });
    html += '</div>';
    rootEl.innerHTML = html;
    rootEl._plFiles = list;
    rootEl._plFab = fab;
  }

  function bindRoot(rootEl) {
    if (!rootEl || rootEl.getAttribute('data-pl-akte-bound') === '1') return;
    rootEl.setAttribute('data-pl-akte-bound', '1');
    rootEl.addEventListener('change', function (ev) {
      var cb = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-pl-compare') === '1' ? ev.target : null;
      if (!cb) return;
      var checked = rootEl.querySelectorAll('input[data-pl-compare]:checked');
      if (cb.checked && checked.length > 2) {
        Array.prototype.forEach.call(checked, function (box) {
          if (box !== cb) box.checked = false;
        });
        checked = rootEl.querySelectorAll('input[data-pl-compare]:checked');
      }
      if (checked.length === 2) {
        var items = [];
        Array.prototype.forEach.call(checked, function (box) {
          var row = box.closest('.parameterlisten-file-row');
          var id = row ? row.getAttribute('data-pl-file-id') : '';
          var files = rootEl._plFiles || [];
          var hit = files.filter(function (f) { return String(f.id || f.local_id || '') === String(id); })[0];
          if (hit) items.push(hit);
        });
        if (items.length === 2) {
          items.sort(function (a, b) {
            return String(a.display_datetime || a.uploaded_at || '').localeCompare(String(b.display_datetime || b.uploaded_at || ''));
          });
          openCompare(rootEl._plFab || currentFab(), items[0], items[1]);
        }
      }
    });
    rootEl.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-pl-act]') : null;
      if (!btn || !rootEl.contains(btn)) return;
      ev.preventDefault();
      var row = btn.closest('.parameterlisten-file-row');
      var id = row ? row.getAttribute('data-pl-file-id') : '';
      var fab = rootEl._plFab || currentFab();
      var act = btn.getAttribute('data-pl-act');
      if (act === 'upload') openUploadModal(fab);
      else if (act === 'open') openView(fab, id);
      else if (act === 'download') triggerDownload(downloadUrl(fab, id));
      else if (act === 'pdf') triggerDownload(pdfUrl(fab, id));
    });
  }

  function load(rootEl, fab) {
    rootEl = rootEl || document.getElementById('anlagenParameterRoot');
    if (!rootEl) return;
    bindRoot(rootEl);
    fab = String(fab || currentFab() || '').trim();
    lastFab = fab;
    if (!fab) {
      rootEl.innerHTML = toolbarHtml('') + '<p class="akte-muted muted">Fabrikationsnummer fehlt.</p>';
      return;
    }
    rootEl.innerHTML = toolbarHtml(fab) + '<p class="akte-muted muted">Parameterlisten werden geladen …</p>';
    fetchList(fab).then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.error) || 'Liste fehlgeschlagen');
      renderList(rootEl, data.fab || fab, data.files || []);
    }).catch(function (e) {
      rootEl.innerHTML = toolbarHtml(fab) + '<p class="akte-muted muted">Fehler: ' + esc(e.message || String(e)) + '</p>';
      rootEl._plFab = fab;
    });
  }

  root.KuklaAnlagenParameterTab = {
    load: load,
    currentFab: currentFab,
  };
})(window);
