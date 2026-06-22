/**
 * Anlagenstamm: kategorisierte Dokumente, Ereignisse, Timeline (Popup + Modal).
 * Erwartet #anlagenDocsRoot und #formFab.
 */
(function () {
  'use strict';

  var readOnly = !!window.ANLAGENSTAMM_READ_ONLY;
  var root = document.getElementById('anlagenDocsRoot');
  var formFab = document.getElementById('formFab');
  if (!root || !formFab) {
    return;
  }

  var loadSeq = 0;
  var lastDocsData = null;

  function ensureParamTrendStyles() {
    if (document.getElementById('anlagenParamTrendStyles')) return;
    var st = document.createElement('style');
    st.id = 'anlagenParamTrendStyles';
    st.textContent =
      '.anlagenstamm-trend-toolbar{padding:8px 10px;border-bottom:1px solid #b0b0b0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#f4f4f4}' +
      '.anlagenstamm-trend-toolbar label{font-size:12px;display:flex;align-items:center;gap:4px}' +
      '.anlagenstamm-trend-toolbar select{min-width:11rem;max-width:100%;padding:4px 6px;font-size:12px}' +
      '.anlagenstamm-trend-wrap{margin-top:10px;border:1px solid #b0b0b0;border-radius:6px;overflow:hidden;background:#fff}' +
      '.anlagenstamm-trend-head{padding:8px 10px;font-weight:600;border-bottom:1px solid #b0b0b0;font-size:13px}' +
      '.anlagenstamm-trend-table{width:100%;border-collapse:collapse;font-size:12px}' +
      '.anlagenstamm-trend-table th,.anlagenstamm-trend-table td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}' +
      '.anlagenstamm-trend-table thead th{background:#eee}' +
      '.asp-trend-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}' +
      '.asp-trend-changed{background:rgba(255,193,7,0.35)}.asp-trend-added{background:rgba(40,167,69,0.25)}' +
      '.asp-trend-removed{background:rgba(220,53,69,0.25)}.asp-trend-unchanged{background:rgba(128,128,128,0.15);color:#666}' +
      '.anlagenstamm-trend-step{border-top:1px solid #b0b0b0}.anlagenstamm-trend-step summary{cursor:pointer;padding:6px 10px;font-weight:600;font-size:12px}';
    document.head.appendChild(st);
  }

  function paramDownloadFab(data, formFabVal) {
    var pf = data && data.parameter_fab ? String(data.parameter_fab).trim() : '';
    return pf || formFabVal;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDateIso(iso) {
    if (!iso) return '';
    try {
      var p = String(iso).split('-');
      if (p.length === 3) return p[2] + '.' + p[1] + '.' + p[0];
    } catch (e) {}
    return String(iso);
  }

  function fmtSize(n) {
    var v = Number(n || 0);
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fabVal() {
    return (formFab.value || '').trim();
  }

  function closeLightbox() {
    var lb = document.getElementById('anlagenLightbox');
    if (lb) lb.remove();
  }

  function openLightbox(url, title, galleryImages, galleryIndex) {
    if (window.MonteurImageGallery && Array.isArray(galleryImages) && galleryImages.length) {
      window.MonteurImageGallery.open(galleryImages, galleryIndex != null ? galleryIndex : 0, {
        title: title,
        fallback: function (item) {
          openLightboxSingle((item && item.url) || url, title);
        },
      });
      return;
    }
    openLightboxSingle(url, title);
  }

  function openLightboxSingle(url, title) {
    closeLightbox();
    var wrap = document.createElement('div');
    wrap.id = 'anlagenLightbox';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;cursor:zoom-out';
    wrap.setAttribute('role', 'dialog');
    wrap.innerHTML = '<div style="max-width:96vw;max-height:96vh;text-align:center"><img alt="" style="max-width:100%;max-height:92vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 32px rgba(0,0,0,.5)" src="' + esc(url) + '"><div style="color:#eee;margin-top:8px;font-size:13px">' + esc(title || '') + '</div></div>';
    wrap.addEventListener('click', closeLightbox);
    document.body.appendChild(wrap);
  }

  function deleteDocument(id, legacy) {
    if (legacy || !id) return;
    if (!confirm('Dokument wirklich löschen?')) return;
    fetch('/api/anlagenstamm_document_delete.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.success)) refresh();
        else alert((d && d.error) ? d.error : 'Löschen fehlgeschlagen');
      })
      .catch(function (e) { alert('Fehler: ' + e.message); });
  }

  function deleteEvent(id) {
    if (!id) return;
    if (!confirm('Ereignis wirklich löschen?')) return;
    fetch('/api/anlagenstamm_event_delete.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.success)) refresh();
        else alert((d && d.error) ? d.error : 'Löschen fehlgeschlagen');
      })
      .catch(function (e) { alert('Fehler: ' + e.message); });
  }

  function uploadCategory(slug) {
    var fab = fabVal();
    if (!fab) {
      alert('Bitte Fabrikationsnummer eintragen.');
      return;
    }
    var fileEl = root.querySelector('.anlagen-doc-file[data-slug="' + slug + '"]');
    var notesEl = root.querySelector('.anlagen-doc-notes[data-slug="' + slug + '"]');
    var dateEl = root.querySelector('.anlagen-doc-date[data-slug="' + slug + '"]');
    var jobEl = root.querySelector('.anlagen-doc-job[data-slug="' + slug + '"]');
    var msgEl = root.querySelector('.anlagen-doc-msg[data-slug="' + slug + '"]');
    var f = fileEl && fileEl.files && fileEl.files[0];
    if (!f) {
      if (msgEl) msgEl.textContent = 'Bitte Datei wählen.';
      return;
    }
    var fd = new FormData();
    fd.append('fabrikationsnummer', fab);
    fd.append('document_type', slug);
    fd.append('file', f);
    if (notesEl && notesEl.value) fd.append('notes', notesEl.value.trim());
    if (dateEl && dateEl.value) fd.append('document_date', dateEl.value.trim());
    if (jobEl && jobEl.value.trim()) fd.append('job_id', jobEl.value.trim());
    if (msgEl) msgEl.textContent = 'Lade hoch…';
    fetch('/api/anlagenstamm_document_upload.php', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.success)) {
          if (msgEl) msgEl.textContent = 'Hochgeladen.';
          if (fileEl) fileEl.value = '';
          if (notesEl) notesEl.value = '';
          refresh();
        } else {
          if (msgEl) msgEl.textContent = (d && d.error) ? d.error : 'Fehler';
        }
      })
      .catch(function (e) {
        if (msgEl) msgEl.textContent = 'Fehler: ' + e.message;
      });
  }

  function saveEvent() {
    var fab = fabVal();
    if (!fab) {
      alert('Fabrikationsnummer fehlt.');
      return;
    }
    var id = parseInt(String(document.getElementById('anlagenEventEditId') && document.getElementById('anlagenEventEditId').value || '0'), 10);
    var typeEl = document.getElementById('anlagenEventType');
    var dateEl = document.getElementById('anlagenEventDate');
    var titleEl = document.getElementById('anlagenEventTitle');
    var notesEl = document.getElementById('anlagenEventNotes');
    var jobEl = document.getElementById('anlagenEventJob');
    var msgEl = document.getElementById('anlagenEventFormMsg');
    var payload = {
      fabrikationsnummer: fab,
      event_type: typeEl ? typeEl.value.trim() : '',
      event_date: dateEl ? dateEl.value.trim() : '',
      title: titleEl ? titleEl.value.trim() : '',
      notes: notesEl ? notesEl.value.trim() : '',
      job_id: jobEl && jobEl.value.trim() ? jobEl.value.trim() : null
    };
    if (id > 0) payload.id = id;
    if (msgEl) msgEl.textContent = '';
    fetch('/api/anlagenstamm_event_save.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.success)) {
          if (msgEl) msgEl.textContent = 'Gespeichert.';
          if (titleEl) titleEl.value = '';
          if (notesEl) notesEl.value = '';
          if (jobEl) jobEl.value = '';
          var hid = document.getElementById('anlagenEventEditId');
          if (hid) hid.value = '0';
          refresh();
        } else {
          if (msgEl) msgEl.textContent = (d && d.error) ? d.error : 'Fehler';
        }
      })
      .catch(function (e) {
        if (msgEl) msgEl.textContent = 'Fehler: ' + e.message;
      });
  }

  function fmtDateTimeLocal(iso) {
    if (!iso) return '';
    var s = String(iso).replace(' ', 'T');
    try {
      var d = new Date(s);
      if (!isNaN(d.getTime())) {
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
    } catch (e) {}
    return String(iso);
  }

  function renderAspTrendChangesTable(changes, showUnchanged) {
    var rows = Array.isArray(changes) ? changes : [];
    if (!showUnchanged) {
      rows = rows.filter(function (c) { return c.status !== 'unchanged'; });
    }
    if (!rows.length) {
      return '<p class="muted" style="margin:8px 10px;font-size:12px">Keine Änderungen (oder nur unveränderte Werte – Filter aktivieren).</p>';
    }
    var statusLabel = { changed: 'Geändert', added: 'Neu', removed: 'Entfernt', unchanged: 'Gleich' };
    var statusClass = { changed: 'asp-trend-changed', added: 'asp-trend-added', removed: 'asp-trend-removed', unchanged: 'asp-trend-unchanged' };
    var body = rows.map(function (c) {
      var st = c.status || 'unchanged';
      var unit = c.unit ? ' <span class="muted">[' + esc(c.unit) + ']</span>' : '';
      return '<tr>' +
        '<td><span class="asp-trend-badge ' + (statusClass[st] || '') + '">' + esc(statusLabel[st] || st) + '</span></td>' +
        '<td>' + esc(c.param_key || '') + unit + '</td>' +
        '<td>' + esc(c.value_old != null ? String(c.value_old) : '') + '</td>' +
        '<td>' + esc(c.value_new != null ? String(c.value_new) : '') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="anlagenstamm-trend-table"><thead><tr><th>Status</th><th>Parameter</th><th>Wert vorher</th><th>Wert nachher</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function loadParameterTrend(downloadFab, opts) {
    opts = opts || {};
    var trendEl = document.getElementById('anlagenParamTrend');
    if (!trendEl || !downloadFab) return;
    var showUnchanged = !!(document.getElementById('anlagenAspShowUnchanged') && document.getElementById('anlagenAspShowUnchanged').checked);
    trendEl.style.display = '';
    trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Vergleich wird berechnet…</div>';
    var body = { fab: downloadFab };
    if (opts.chain) {
      body.chain = true;
      body.mode = 'chain';
    } else {
      if (opts.from_file_id) body.from_file_id = opts.from_file_id;
      if (opts.to_file_id) body.to_file_id = opts.to_file_id;
    }
    fetch('/api/anlagenstamm_parameter_trend.php', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          throw new Error((data && data.error) ? data.error : 'Vergleich fehlgeschlagen');
        }
        if (data.steps && Array.isArray(data.steps)) {
          if (!data.steps.length) {
            trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Parameter-Trend</div><p class="muted" style="margin:8px 10px;font-size:12px">' +
              esc(data.message || 'Keine aufeinanderfolgenden Vergleiche möglich.') + '</p>';
            return;
          }
          trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Gesamttrend: ' + data.steps.length + ' Schritt(e)</div>' +
            data.steps.map(function (step) {
              var sum = step.summary || {};
              var title = 'Schritt ' + step.step_index + ': ' + esc(step.from_label || '') + ' → ' + esc(step.to_label || '') +
                ' <span class="muted">(' + esc(fmtDateTimeLocal(step.from_uploaded_at)) + ' → ' + esc(fmtDateTimeLocal(step.to_uploaded_at)) + ')</span>' +
                ' — geändert: ' + (sum.changed || 0) + ', neu: ' + (sum.added || 0) + ', entfernt: ' + (sum.removed || 0);
              return '<details class="anlagenstamm-trend-step"><summary>' + title + '</summary>' +
                renderAspTrendChangesTable(step.changes, showUnchanged) + '</details>';
            }).join('');
          return;
        }
        var fromF = data.from_file || {};
        var toF = data.to_file || {};
        var sum = data.summary || {};
        trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Vergleich: ' + esc(fromF.original_filename || '') + ' → ' + esc(toF.original_filename || '') +
          ' <span class="muted">(' + esc(fmtDateTimeLocal(fromF.uploaded_at)) + ' → ' + esc(fmtDateTimeLocal(toF.uploaded_at)) + ')</span></div>' +
          '<p class="muted" style="margin:6px 10px;font-size:12px">geändert ' + (sum.changed || 0) + ', neu ' + (sum.added || 0) +
          ', entfernt ' + (sum.removed || 0) + ', unverändert ' + (sum.unchanged || 0) + '</p>' +
          renderAspTrendChangesTable(data.changes, showUnchanged);
      })
      .catch(function (e) {
        trendEl.innerHTML = '<div class="anlagenstamm-trend-head">Parameter-Vergleich</div><p class="muted" style="margin:8px 10px;font-size:12px">Fehler: ' + esc(e.message || String(e)) + '</p>';
      });
  }

  function wireParameterTrend(paramDocs, downloadFab) {
    ensureParamTrendStyles();
    var chron = (paramDocs || []).slice().sort(function (a, b) {
      var ta = Date.parse(String(a.created_at || a.document_date || '').replace(' ', 'T'));
      var tb = Date.parse(String(b.created_at || b.document_date || '').replace(' ', 'T'));
      if (isNaN(ta)) ta = 0;
      if (isNaN(tb)) tb = 0;
      return ta - tb;
    });
    var selFrom = document.getElementById('anlagenAspFrom');
    var selTo = document.getElementById('anlagenAspTo');
    if (!selFrom || !selTo) return;
    function optLabel(d) {
      return (d.display_name || d.original_name || 'Liste') + ' (' + fmtDateTimeLocal(d.created_at || d.document_date) + ')';
    }
    selFrom.innerHTML = chron.map(function (d) {
      return '<option value="' + esc(String(d.parameter_file_id)) + '">' + esc(optLabel(d)) + '</option>';
    }).join('');
    selTo.innerHTML = chron.slice().reverse().map(function (d) {
      return '<option value="' + esc(String(d.parameter_file_id)) + '">' + esc(optLabel(d)) + '</option>';
    }).join('');
    if (chron.length >= 2) {
      selFrom.value = String(chron[0].parameter_file_id);
      selTo.value = String(chron[chron.length - 1].parameter_file_id);
    }
    var btnPair = document.getElementById('anlagenAspCompare');
    var btnChain = document.getElementById('anlagenAspChain');
    if (btnPair) {
      btnPair.disabled = chron.length < 2;
      btnPair.onclick = function () {
        loadParameterTrend(downloadFab, {
          from_file_id: parseInt(selFrom.value, 10),
          to_file_id: parseInt(selTo.value, 10)
        });
      };
    }
    if (btnChain) {
      btnChain.disabled = chron.length < 2;
      btnChain.onclick = function () {
        loadParameterTrend(downloadFab, { chain: true });
      };
    }
    var chk = document.getElementById('anlagenAspShowUnchanged');
    if (chk) {
      chk.onchange = function () {
        if (btnPair && !btnPair.disabled) btnPair.click();
      };
    }
    if (chron.length >= 2) {
      loadParameterTrend(downloadFab, {
        from_file_id: chron[0].parameter_file_id,
        to_file_id: chron[chron.length - 1].parameter_file_id
      });
    }
  }

  function renderCategories(categories, fab, downloadFab) {
    var html = '';
    (categories || []).forEach(function (cat) {
      var slug = cat.slug || '';
      var label = cat.label || slug;
      var docs = cat.documents || [];
      var isImage = !!cat.is_image;
      html += '<details class="anlagen-doc-cat" style="margin-bottom:10px;border:1px solid #b0b0b0;border-radius:6px;background:#e8e8e8;padding:8px 10px">';
      html += '<summary style="cursor:pointer;font-weight:600">' + esc(label) + ' <span class="muted">(' + docs.length + ')</span></summary>';
      html += '<div style="margin-top:10px">';
      if (!readOnly) {
        html += '<div class="anlagen-doc-upload-row" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:10px">';
        html += '<input type="file" class="anlagen-doc-file" data-slug="' + esc(slug) + '" style="max-width:220px;font-size:12px">';
        html += '<input type="date" class="anlagen-doc-date" data-slug="' + esc(slug) + '" style="padding:6px;font-size:12px" value="">';
        html += '<input type="text" class="anlagen-doc-notes" data-slug="' + esc(slug) + '" placeholder="Notiz" style="flex:1;min-width:120px;padding:6px;font-size:12px">';
        html += '<input type="number" class="anlagen-doc-job" data-slug="' + esc(slug) + '" placeholder="Job-ID" style="width:88px;padding:6px;font-size:12px">';
        html += '<button type="button" class="btn btn-primary btn-anlagen-doc-upload" data-slug="' + esc(slug) + '" style="font-size:12px">Hochladen</button>';
        html += '<span class="muted anlagen-doc-msg" data-slug="' + esc(slug) + '" style="font-size:12px"></span>';
        html += '</div>';
      }
      if (isImage && docs.length) {
        html += '<div class="anlagen-doc-gallery" style="display:flex;flex-wrap:wrap;gap:8px">';
        docs.forEach(function (d) {
          if (d.legacy) {
            var hLegacy = '/api/anlagenstamm_file_download.php?fabrikationsnummer=' + encodeURIComponent(fab) + '&fab=' + encodeURIComponent(fab) + '&file=' + encodeURIComponent(d.display_name || d.original_name || '');
            html += '<div style="text-align:center;font-size:11px;max-width:120px"><a href="' + esc(hLegacy) + '" target="_blank" rel="noopener"><img src="' + esc(hLegacy) + '" alt="" style="width:112px;height:112px;object-fit:cover;border-radius:4px;border:1px solid #ccc"></a><div class="muted">' + esc(d.display_name || '') + '</div></div>';
          } else if (d.id) {
            var th = '/api/anlagenstamm_document_thumb.php?id=' + encodeURIComponent(String(d.id));
            var full = '/api/anlagenstamm_document_download.php?id=' + encodeURIComponent(String(d.id)) + '&inline=1';
            html += '<div style="text-align:center;font-size:11px;max-width:120px">';
            html += '<img src="' + esc(th) + '" alt="" style="width:112px;height:112px;object-fit:cover;border-radius:4px;border:1px solid #ccc;cursor:pointer" data-full="' + esc(full) + '" data-title="' + esc(d.display_name || '') + '" class="anlagen-doc-thumb">';
            html += '<div class="muted" style="word-break:break-all">' + esc(d.display_name || '') + '</div>';
            if (!readOnly) {
              html += '<button type="button" class="btn btn-delete anlagen-doc-del" data-id="' + esc(String(d.id)) + '" style="margin-top:4px;padding:4px 8px;font-size:11px">Löschen</button>';
            }
            html += '</div>';
          }
        });
        html += '</div>';
      } else if (docs.length) {
        html += '<ul class="files-list" style="margin:0;padding-left:0;list-style:none">';
        docs.forEach(function (d) {
          var href;
          if (d.parameter_file_id) {
            href = '/api/anlagenstamm_parameter_download.php?fab=' + encodeURIComponent(downloadFab || fab) + '&file_id=' + encodeURIComponent(String(d.parameter_file_id));
          } else if (d.legacy) {
            href = '/api/anlagenstamm_file_download.php?fabrikationsnummer=' + encodeURIComponent(fab) + '&fab=' + encodeURIComponent(fab) + '&file=' + encodeURIComponent(d.display_name || d.original_name || '');
          } else {
            href = '/api/anlagenstamm_document_download.php?id=' + encodeURIComponent(String(d.id));
          }
          html += '<li style="margin:6px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px">';
          html += '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(d.display_name || 'Datei') + '</a>';
          html += '<span class="muted">' + esc(fmtSize(d.size_bytes)) + ' · ' + esc(fmtDateIso(d.document_date)) + '</span>';
          if (d.uploaded_by_username) html += '<span class="muted">' + esc(d.uploaded_by_username) + '</span>';
          if (d.notes) html += '<span class="muted">' + esc(d.notes) + '</span>';
          if (!readOnly && d.id && !d.legacy && !d.parameter_file_id) {
            html += '<button type="button" class="btn btn-delete anlagen-doc-del" data-id="' + esc(String(d.id)) + '" style="padding:4px 8px;font-size:11px">Löschen</button>';
          }
          if (d.legacy) html += ' <span class="muted">(Bestandsdatei)</span>';
          if (d.parameter_file_id) html += ' <span class="muted">(Parameter-DB)</span>';
          html += '</li>';
        });
        html += '</ul>';
        if (slug === 'parameterliste' && docs.length >= 2) {
          html += '<div class="anlagenstamm-trend-toolbar" style="margin-top:10px;border:1px solid #b0b0b0;border-radius:6px">';
          html += '<label>Von <select id="anlagenAspFrom"></select></label>';
          html += '<label>Zu <select id="anlagenAspTo"></select></label>';
          html += '<button type="button" class="btn btn-primary" id="anlagenAspCompare">Einzelvergleich</button>';
          html += '<button type="button" class="btn" id="anlagenAspChain">Gesamttrend</button>';
          html += '<label><input type="checkbox" id="anlagenAspShowUnchanged"> Unveränderte</label>';
          html += '</div>';
          html += '<div id="anlagenParamTrend" class="anlagenstamm-trend-wrap" style="display:none"></div>';
        }
      } else {
        html += '<p class="muted" style="margin:0;font-size:12px">Keine Einträge.</p>';
      }
      html += '</div></details>';
    });
    return html;
  }

  function eventTypeOptions(categories) {
    var o = '<option value="">— Typ —</option>';
    (categories || []).forEach(function (c) {
      o += '<option value="' + esc(c.slug) + '">' + esc(c.label) + '</option>';
    });
    o += '<option value="sonstiges">Sonstiges</option>';
    return o;
  }

  function renderEventsTab(data) {
    var fab = fabVal();
    var cats = data.categories || [];
    var events = data.events || [];
    var html = '';
    if (!readOnly) {
      html += '<div style="background:#e8e8e8;border:1px solid #b0b0b0;border-radius:6px;padding:12px;margin-bottom:12px">';
      html += '<input type="hidden" id="anlagenEventEditId" value="0">';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">';
      html += '<div><label style="font-size:11px">Typ</label><select id="anlagenEventType" style="width:100%;padding:6px;font-size:12px">' + eventTypeOptions(cats) + '</select></div>';
      html += '<div><label style="font-size:11px">Datum</label><input type="date" id="anlagenEventDate" style="width:100%;padding:6px;font-size:12px"></div>';
      html += '</div>';
      html += '<div style="margin-bottom:8px"><label style="font-size:11px">Titel</label><input type="text" id="anlagenEventTitle" style="width:100%;padding:6px;font-size:12px" placeholder="Kurzbeschreibung"></div>';
      html += '<div style="margin-bottom:8px"><label style="font-size:11px">Notiz</label><textarea id="anlagenEventNotes" rows="2" style="width:100%;padding:6px;font-size:12px"></textarea></div>';
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
      html += '<input type="number" id="anlagenEventJob" placeholder="Job-ID (optional)" style="width:120px;padding:6px;font-size:12px">';
      html += '<button type="button" class="btn btn-primary" id="anlagenEventSaveBtn">Ereignis speichern</button>';
      html += '<span class="muted" id="anlagenEventFormMsg" style="font-size:12px"></span>';
      html += '</div></div>';
    }
    if (!events.length) {
      html += '<p class="muted">Keine Ereignisse.</p>';
      return html;
    }
    html += '<ul class="files-list" style="list-style:none;padding:0">';
    events.forEach(function (ev) {
      html += '<li style="margin:8px 0;padding:8px;background:#f3f3f3;border-radius:6px;border:1px solid #ddd">';
      html += '<strong>' + esc(ev.title || '') + '</strong> <span class="muted">' + esc(fmtDateIso(ev.event_date)) + ' · ' + esc(ev.event_type || '') + '</span>';
      if (ev.created_by_username) html += ' <span class="muted">' + esc(ev.created_by_username) + '</span>';
      if (ev.notes) html += '<div class="muted" style="margin-top:4px;font-size:12px">' + esc(ev.notes) + '</div>';
      if (!readOnly) {
        html += '<div style="margin-top:6px"><button type="button" class="btn btn-delete anlagen-event-del" data-id="' + esc(String(ev.id)) + '" style="padding:4px 8px;font-size:11px">Löschen</button></div>';
      }
      html += '</li>';
    });
    html += '</ul>';
    return html;
  }

  function renderTimeline(data) {
    var items = data.timeline || [];
    if (!items.length) {
      return '<p class="muted">Keine Einträge.</p>';
    }
    var html = '<ul class="files-list" style="list-style:none;padding:0">';
    items.forEach(function (it) {
      var line = '';
      if (it.kind === 'event') {
        line = '<strong>' + esc(it.title || '') + '</strong> <span class="muted">Ereignis · ' + esc(fmtDateIso(it.date)) + '</span>';
      } else {
        line = '<strong>' + esc(it.title || '') + '</strong> <span class="muted">' + esc(it.subtitle || '') + ' · ' + esc(fmtDateIso(it.date)) + '</span>';
        if (it.legacy) line += ' <span class="muted">(Bestandsdatei)</span>';
      }
      html += '<li style="margin:6px 0">' + line + '</li>';
    });
    html += '</ul>';
    return html;
  }

  function renderAll(data) {
    lastDocsData = data;
    var fab = fabVal();
    var downloadFab = paramDownloadFab(data, fab);
    var categories = data.categories || [];
    var tab = root.getAttribute('data-active-tab') || 'docs';
    var nav = '<div class="anlagen-docs-tabs" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">';
    nav += '<button type="button" class="btn anlagen-tab-btn' + (tab === 'docs' ? ' btn-primary' : '') + '" data-tab="docs">Dokumente</button>';
    nav += '<button type="button" class="btn anlagen-tab-btn' + (tab === 'events' ? ' btn-primary' : '') + '" data-tab="events">Ereignisse</button>';
    nav += '<button type="button" class="btn anlagen-tab-btn' + (tab === 'timeline' ? ' btn-primary' : '') + '" data-tab="timeline">Timeline</button>';
    nav += '</div>';
    var body = '';
    if (tab === 'docs') body = renderCategories(categories, fab, downloadFab);
    else if (tab === 'events') body = renderEventsTab(data);
    else body = renderTimeline(data);
    root.innerHTML = '<h3 style="margin:0 0 10px 0;font-size:14px">Dokumente &amp; Ereignisse (Anlagenstamm)</h3>' + nav + '<div class="anlagen-docs-tab-body">' + body + '</div>';

    root.querySelectorAll('.anlagen-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        root.setAttribute('data-active-tab', btn.getAttribute('data-tab') || 'docs');
        renderAll(data);
      });
    });
    root.querySelectorAll('.btn-anlagen-doc-upload').forEach(function (btn) {
      btn.addEventListener('click', function () {
        uploadCategory(btn.getAttribute('data-slug') || '');
      });
    });
    var docGallery = [];
    root.querySelectorAll('.anlagen-doc-thumb').forEach(function (thumb) {
      var full = thumb.getAttribute('data-full') || '';
      if (!full) return;
      docGallery.push({
        url: full,
        thumbUrl: thumb.getAttribute('src') || full,
        label: thumb.getAttribute('data-title') || '',
      });
    });
    root.querySelectorAll('.anlagen-doc-thumb').forEach(function (img) {
      img.addEventListener('click', function (e) {
        e.preventDefault();
        var full = img.getAttribute('data-full') || '';
        var title = img.getAttribute('data-title') || '';
        var idx = 0;
        for (var i = 0; i < docGallery.length; i++) {
          if (docGallery[i].url === full) {
            idx = i;
            break;
          }
        }
        openLightbox(full, title, docGallery, idx);
      });
    });
    root.querySelectorAll('.anlagen-doc-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        deleteDocument(parseInt(btn.getAttribute('data-id') || '0', 10), false);
      });
    });
    root.querySelectorAll('.anlagen-event-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        deleteEvent(parseInt(btn.getAttribute('data-id') || '0', 10));
      });
    });
    var saveEv = document.getElementById('anlagenEventSaveBtn');
    if (saveEv) saveEv.addEventListener('click', saveEvent);
    var paramCat = (categories || []).filter(function (c) { return c.slug === 'parameterliste'; })[0];
    var paramDocs = paramCat && paramCat.documents ? paramCat.documents.filter(function (d) { return d.parameter_file_id; }) : [];
    if (paramDocs.length >= 2) {
      wireParameterTrend(paramDocs, downloadFab);
    }
  }

  function refresh() {
    var fab = fabVal();
    var seq = ++loadSeq;
    if (!fab) {
      root.innerHTML = '<p class="muted" style="margin:0">Fabrikationsnummer eintragen, um Dokumente zu laden.</p>';
      return;
    }
    root.innerHTML = '<p class="muted">Lade…</p>';
    fetch('/api/anlagenstamm_documents_list.php?fab=' + encodeURIComponent(fab) + '&_ts=' + Date.now(), {
      credentials: 'same-origin',
      cache: 'no-store'
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== loadSeq) return;
        if (!data || !data.ok) {
          root.innerHTML = '<p class="muted">Konnte Dokumente nicht laden.</p>';
          return;
        }
        renderAll(data);
      })
      .catch(function () {
        if (seq !== loadSeq) return;
        root.innerHTML = '<p class="muted">Netzwerkfehler.</p>';
      });
  }

  window.anlagenstammDocumentsRefresh = refresh;
  formFab.addEventListener('blur', refresh);
  formFab.addEventListener('change', refresh);
  refresh();
})();
