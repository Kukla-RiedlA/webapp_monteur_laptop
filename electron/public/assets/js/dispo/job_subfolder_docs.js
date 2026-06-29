/**
 * Abrechnung: eine Karte, Dateien in Dokumente_Dispo, Kommentare zusammengeführt.
 */
(function () {
  'use strict';

  var cfg = window.KUKLA_ABRECHNUNG || {};
  var jobSelect = document.getElementById('abJobSelect');
  var yearSelect = document.getElementById('abYearSelect');
  var monthNumSelect = document.getElementById('abMonthNumSelect');
  var techSelect = document.getElementById('abTechSelect');
  var mainBlocks = document.getElementById('abMainBlocks');
  var hintChoose = document.getElementById('abHintChoose');
  var banner = document.getElementById('abReadonlyBanner');
  var filterForm = document.getElementById('abrechnungFilterForm');
  var chMv = document.getElementById('abBillingMontageVerrechnet');
  var chEt = document.getElementById('abBillingEt');
  var elEtRow = document.getElementById('abEtRow');
  var elMvMeta = document.getElementById('abMvMeta');
  var elEtMeta = document.getElementById('abEtMeta');
  var elTravel = document.getElementById('abTravelMount');
  var billingCache = null;
  var wrapStatus = document.getElementById('abStatusActionsWrap');
  var btnAdminRevert = document.getElementById('abAdminRevertBtn');
  var btnDispoInArbeit = document.getElementById('abDispoInArbeitBtn');

  function parseUid() {
    return parseInt(String(cfg.current_user_id != null ? cfg.current_user_id : 0), 10) || 0;
  }

  function billingMvCheckboxEnabled(b) {
    if (cfg.billingFlagsEditable !== true) return false;
    var st = String(b.job_status || '');
    if (st !== 'abgerechnet') return true;
    if (cfg.is_admin === true) return true;
    var uid = parseUid();
    if (b.montage_verrechnet && (b.montage_verrechnet_by === uid)) return true;
    return false;
  }

  function billingEtCheckboxEnabled(b) {
    if (cfg.billingFlagsEditable !== true) return false;
    var st = String(b.job_status || '');
    if (st !== 'abgerechnet') return true;
    if (cfg.is_admin === true) return true;
    var uid = parseUid();
    if (b.fakturierung_et && (b.fakturierung_et_by === uid)) return true;
    return false;
  }

  function travelRowCheckboxEnabled(st, t) {
    if (cfg.billingFlagsEditable !== true) return false;
    if (String(st) !== 'abgerechnet') return true;
    if (cfg.is_admin === true) return true;
    var uid = parseUid();
    if (t.reise_abgerechnet && (t.reise_abgerechnet_by === uid)) return true;
    return false;
  }

  function updateStatusActionButtons() {
    if (!wrapStatus || !btnAdminRevert || !btnDispoInArbeit) return;
    var id = currentJobId();
    if (!id) {
      wrapStatus.style.display = 'none';
      btnAdminRevert.style.display = 'none';
      btnDispoInArbeit.style.display = 'none';
      return;
    }
    var st = '';
    if (billingCache && billingCache.job_status) {
      st = String(billingCache.job_status);
    } else {
      var opt = jobSelect && jobSelect.selectedIndex >= 0 ? jobSelect.options[jobSelect.selectedIndex] : null;
      st = opt && opt.dataset.status ? String(opt.dataset.status) : '';
    }
    var showWrap = false;
    if (cfg.is_admin === true && st === 'abgerechnet') {
      btnAdminRevert.style.display = '';
      showWrap = true;
    } else {
      btnAdminRevert.style.display = 'none';
    }
    var hasTech = billingCache && billingCache.technicians && billingCache.technicians.length > 0;
    if ((cfg.is_dispo === true || cfg.is_admin === true) && hasTech && (st === 'zugeteilt' || st === 'angelegt')) {
      btnDispoInArbeit.style.display = '';
      showWrap = true;
    } else {
      btnDispoInArbeit.style.display = 'none';
    }
    wrapStatus.style.display = showWrap ? 'flex' : 'none';
  }

  function currentJobId() {
    var v = jobSelect && jobSelect.value ? String(jobSelect.value) : '';
    var n = parseInt(v, 10);
    return isNaN(n) || n <= 0 ? 0 : n;
  }

  function setUiBusy(on) {
    if (mainBlocks) {
      mainBlocks.style.opacity = on ? '0.6' : '';
      mainBlocks.style.pointerEvents = on ? 'none' : '';
    }
  }

  function showBanner(msg) {
    if (!banner) return;
    if (!msg) {
      banner.style.display = 'none';
      banner.textContent = '';
      return;
    }
    banner.style.display = 'block';
    banner.textContent = msg;
  }

  function currentYm() {
    if (yearSelect && monthNumSelect && yearSelect.value !== '' && monthNumSelect.value !== '') {
      var y = parseInt(yearSelect.value, 10);
      var mo = parseInt(monthNumSelect.value, 10);
      if (!isNaN(y) && y > 0 && !isNaN(mo) && mo >= 1 && mo <= 12) {
        return y + '-' + (mo < 10 ? '0' : '') + mo;
      }
    }
    return cfg.month || '';
  }

  function jobListQuery() {
    var m = currentYm();
    var t = 0;
    var hideTech = cfg.hideTechnicianFilter === true || cfg.laptopMonthOnly === true;
    if (techSelect && techSelect.value) {
      t = parseInt(techSelect.value, 10) || 0;
    } else if (!hideTech) {
      t = typeof cfg.technician === 'number' ? cfg.technician : parseInt(String(cfg.technician || 0), 10) || 0;
    } else if (cfg.technician) {
      t = typeof cfg.technician === 'number' ? cfg.technician : parseInt(String(cfg.technician || 0), 10) || 0;
    }
    return 'monat=' + encodeURIComponent(m) + '&techniker=' + encodeURIComponent(String(t));
  }

  function pickAbrechnungDefaultJobId(jobs) {
    if (!jobs || !jobs.length) return 0;
    var i;
    for (i = 0; i < jobs.length; i++) {
      if (String(jobs[i].status || '').trim().toLowerCase() === 'in_arbeit') {
        return parseInt(jobs[i].id, 10) || 0;
      }
    }
    for (i = 0; i < jobs.length; i++) {
      var st = String(jobs[i].status || '').trim().toLowerCase();
      if (st !== 'erledigt' && st !== 'abgerechnet') {
        return parseInt(jobs[i].id, 10) || 0;
      }
    }
    return 0;
  }

  function fetchJobList(cb) {
    var errEl = document.getElementById('abFilterError');
    var m = currentYm();
    var url;
    if (cfg.laptopMonthOnly === true || cfg.fromLaptopEmbed === true) {
      var tid = cfg.technician || cfg.current_user_id || 0;
      url = '/api/abrechnung/jobs?period=' + encodeURIComponent(m) + '&technician_id=' + encodeURIComponent(String(tid));
    } else {
      url = '/api/abrechnung_job_list.php?' + jobListQuery();
    }
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        return r.text().then(function (text) {
          var data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (parseErr) {
            var hint = (text && text.length < 200) ? text.trim() : ('HTTP ' + r.status);
            throw new Error(hint || parseErr.message || 'Ungültige Server-Antwort');
          }
          if (!r.ok && data.ok !== false) {
            data = { ok: false, error: data.error || ('HTTP ' + r.status) };
          }
          return data;
        });
      })
      .then(function (data) {
        if (errEl) {
          if (!data || data.ok === false) {
            errEl.textContent = (data && data.error) ? data.error : 'Auftragsliste konnte nicht geladen werden.';
            errEl.style.display = '';
          } else {
            errEl.textContent = '';
            errEl.style.display = 'none';
          }
        }
        cb(data && data.ok !== false ? data : { ok: false, jobs: [] });
      })
      .catch(function (err) {
        if (errEl) {
          errEl.textContent = (err && err.message) ? err.message : 'Auftragsliste konnte nicht geladen werden.';
          errEl.style.display = '';
        }
        cb({ ok: false, jobs: [] });
      });
  }

  function fillJobDropdown(jobs, selectedId) {
    if (!jobSelect) return;
    var sel = selectedId > 0 ? selectedId : 0;
    jobSelect.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '— Auftrag wählen';
    jobSelect.appendChild(opt0);
    (jobs || []).forEach(function (j) {
      var o = document.createElement('option');
      o.value = String(j.id);
      o.textContent = j.label || ('#' + j.id);
      o.dataset.status = j.status || '';
      o.dataset.canWrite = j.can_write ? '1' : '0';
      jobSelect.appendChild(o);
    });
    if (sel > 0) {
      jobSelect.value = String(sel);
      if (jobSelect.value !== String(sel)) {
        var pj = cfg.prefillJob;
        if (pj && pj.id === sel && pj.label) {
          var ox = document.createElement('option');
          ox.value = String(sel);
          ox.textContent = pj.label + (pj.status === 'abgerechnet' ? ' (abgerechnet)' : '');
          ox.dataset.status = pj.status || '';
          ox.dataset.canWrite = pj.can_write ? '1' : '0';
          jobSelect.appendChild(ox);
          jobSelect.value = String(sel);
        }
      }
    }
  }

  function formatDeDt(iso) {
    if (!iso) return '';
    var s = String(iso);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    return s;
  }

  function applyMvEtMeta(b) {
    if (!b) return;
    if (elMvMeta) {
      if (b.montage_verrechnet && (b.montage_verrechnet_at || b.montage_verrechnet_by_name)) {
        elMvMeta.style.display = 'block';
        var parts = [];
        if (b.montage_verrechnet_at) parts.push(formatDeDt(String(b.montage_verrechnet_at)));
        if (b.montage_verrechnet_by_name) parts.push(String(b.montage_verrechnet_by_name));
        elMvMeta.textContent = parts.join(' · ');
      } else {
        elMvMeta.style.display = 'none';
        elMvMeta.textContent = '';
      }
    }
    if (elEtMeta) {
      if (b.fakturierung_et && (b.fakturierung_et_at || b.fakturierung_et_by_name)) {
        elEtMeta.style.display = 'block';
        var p2 = [];
        if (b.fakturierung_et_at) p2.push(formatDeDt(String(b.fakturierung_et_at)));
        if (b.fakturierung_et_by_name) p2.push(String(b.fakturierung_et_by_name));
        elEtMeta.textContent = p2.join(' · ');
      } else {
        elEtMeta.style.display = 'none';
        elEtMeta.textContent = '';
      }
    }
    if (elEtRow) {
      elEtRow.classList.toggle('visible', !!b.show_fakturierung_et);
    }
    if (chEt) {
      chEt.checked = !!(b.fakturierung_et);
      chEt.disabled = !billingEtCheckboxEnabled(b);
    }
  }

  function renderTravelCheckboxes(b) {
    if (!elTravel) return;
    elTravel.innerHTML = '';
    if (!b) return;
    var st = String(b.job_status || '');
    var editableBase = cfg.billingFlagsEditable === true;
    if (b.no_technicians_fallback) {
      var wrap = document.createElement('div');
      var label = document.createElement('label');
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.value = '1';
      inp.checked = !!b.montage_abgerechnet_job_fallback;
      inp.disabled = !(editableBase && (st !== 'abgerechnet' || cfg.is_admin === true));
      inp.dataset.techId = '0';
      var span = document.createElement('span');
      span.textContent = 'Reisekosten abgerechnet';
      label.appendChild(inp);
      label.appendChild(span);
      wrap.appendChild(label);
      elTravel.appendChild(wrap);
      return;
    }
    (b.technicians || []).forEach(function (t) {
      var w = document.createElement('div');
      var lb = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = '1';
      cb.checked = !!t.reise_abgerechnet;
      cb.disabled = !travelRowCheckboxEnabled(st, t);
      cb.dataset.techId = String(t.technician_id);
      var sp = document.createElement('span');
      sp.textContent = 'Reisekosten abgerechnet — ' + (t.technician_name || '');
      lb.appendChild(cb);
      lb.appendChild(sp);
      w.appendChild(lb);
      if (t.reise_abgerechnet && (t.reise_abgerechnet_at || t.reise_abgerechnet_by_name)) {
        var meta = document.createElement('div');
        meta.className = 'ab-billing-meta';
        var pr = [];
        if (t.reise_abgerechnet_at) pr.push(formatDeDt(String(t.reise_abgerechnet_at)));
        if (t.reise_abgerechnet_by_name) pr.push(String(t.reise_abgerechnet_by_name));
        meta.textContent = pr.join(' · ');
        w.appendChild(meta);
      }
      elTravel.appendChild(w);
    });
  }

  function bindTravelHandlers() {
    if (!elTravel) return;
    elTravel.querySelectorAll('input[type=checkbox]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = currentJobId();
        if (!id || !cfg.billingFlagsEditable) return;
        var tid = parseInt(inp.dataset.techId || '0', 10);
        if (isNaN(tid)) tid = 0;
        var fd = new FormData();
        fd.append('csrf_token', cfg.csrfTravel || '');
        fd.append('job_id', String(id));
        fd.append('technician_id', String(tid));
        fd.append('reise_abgerechnet', inp.checked ? '1' : '0');
        fetch('/api/job_billing_travel_technician.php', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (!res.ok) {
              alert(res.error || 'Speichern fehlgeschlagen');
              fetchBillingState();
              return;
            }
            billingCache = res.billing;
            if (res.status && jobSelect && jobSelect.selectedIndex >= 0) {
              jobSelect.options[jobSelect.selectedIndex].dataset.status = res.status;
            }
            applyMvEtMeta(billingCache);
            renderTravelCheckboxes(billingCache);
            bindTravelHandlers();
            updateStatusActionButtons();
          })
          .catch(function () {
            alert('Netzwerkfehler.');
            fetchBillingState();
          });
      });
    });
  }

  function fetchBillingState(cb) {
    var id = currentJobId();
    if (!id) {
      billingCache = null;
      if (cb) cb();
      return;
    }
    fetch('/api/abrechnung_job_billing_state.php?job_id=' + encodeURIComponent(String(id)), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && data.billing) {
          billingCache = data.billing;
          if (chMv) {
            chMv.checked = !!billingCache.montage_verrechnet;
            chMv.disabled = !billingMvCheckboxEnabled(billingCache);
          }
          if (chEt) {
            chEt.checked = !!billingCache.fakturierung_et;
            chEt.disabled = !billingEtCheckboxEnabled(billingCache);
          }
          applyMvEtMeta(billingCache);
          renderTravelCheckboxes(billingCache);
          bindTravelHandlers();
          updateStatusActionButtons();
        }
        if (cb) cb();
      })
      .catch(function () { if (cb) cb(); });
  }

  function saveBillingFlags() {
    var id = currentJobId();
    if (!id || !cfg.billingFlagsEditable || !chMv) return;
    var fd = new FormData();
    fd.append('csrf_token', cfg.csrfBilling || '');
    fd.append('job_id', String(id));
    fd.append('montage_verrechnet', chMv.checked ? '1' : '0');
    fd.append('fakturierung_et', chEt && chEt.checked ? '1' : '0');
    fetch('/api/job_billing_flags.php', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) {
          alert(res.error || 'Speichern fehlgeschlagen');
          fetchBillingState();
          return;
        }
        billingCache = res.billing;
        if (res.status && jobSelect && jobSelect.selectedIndex >= 0) {
          jobSelect.options[jobSelect.selectedIndex].dataset.status = res.status;
        }
        if (chMv) {
          chMv.checked = !!billingCache.montage_verrechnet;
          chMv.disabled = !billingMvCheckboxEnabled(billingCache);
        }
        if (chEt) {
          chEt.checked = !!billingCache.fakturierung_et;
          chEt.disabled = !billingEtCheckboxEnabled(billingCache);
        }
        applyMvEtMeta(billingCache);
        renderTravelCheckboxes(billingCache);
        bindTravelHandlers();
        updateStatusActionButtons();
      })
      .catch(function () {
        alert('Netzwerkfehler beim Speichern der Abrechnungsflags.');
        fetchBillingState();
      });
  }

  function applyReadonlyUi(canWrite, status) {
    var ro = !canWrite;
    showBanner(ro ? 'Nur Lesen, Auftrag bereits abgerechnet' : '');
    if (!canWrite) {
      resetCommentEdit();
    }
    document.querySelectorAll('.ab-dropzone').forEach(function (z) {
      z.classList.toggle('hidden', ro);
    });
    document.querySelectorAll('.ab-file-input').forEach(function (inp) {
      inp.disabled = ro;
    });
    document.querySelectorAll('.ab-note').forEach(function (ta) {
      ta.readOnly = ro;
    });
    document.querySelectorAll('.ab-save-note').forEach(function (b) {
      b.style.display = ro ? 'none' : '';
    });
    if (mainBlocks) {
      mainBlocks.style.opacity = '1';
      mainBlocks.style.pointerEvents = '';
    }
    if (hintChoose) {
      hintChoose.style.display = currentJobId() ? 'none' : '';
    }
    document.querySelectorAll('.ab-comment-actions').forEach(function (el) {
      el.style.display = ro ? 'none' : '';
    });
  }

  function refreshReadonlyState() {
    var id = currentJobId();
    if (!id) {
      showBanner('');
      if (mainBlocks) {
        mainBlocks.style.opacity = '0.5';
        mainBlocks.style.pointerEvents = 'none';
      }
      if (hintChoose) hintChoose.style.display = '';
      if (chMv) chMv.checked = false;
      if (chEt) chEt.checked = false;
      applyMvEtMeta({});
      if (elTravel) elTravel.innerHTML = '';
      resetCommentEdit();
      updateStatusActionButtons();
      return;
    }
    var opt = jobSelect && jobSelect.selectedIndex >= 0 ? jobSelect.options[jobSelect.selectedIndex] : null;
    var st = opt && opt.dataset.status ? opt.dataset.status : '';
    var cw = opt && opt.dataset.canWrite === '1';
    cfg.prefillJob = { id: id, status: st, can_write: cw, label: opt ? opt.textContent : '' };
    applyReadonlyUi(cw, st);
    fetchBillingState();
  }

  function currentJobCanWrite() {
    var opt = jobSelect && jobSelect.selectedIndex >= 0 ? jobSelect.options[jobSelect.selectedIndex] : null;
    return !!(opt && opt.dataset.canWrite === '1');
  }

  var editingCommentId = 0;
  var COMMENT_BUCKET = 'dispo';

  function getNoteSaveButton() {
    return document.querySelector('[data-note-save="' + COMMENT_BUCKET + '"]');
  }

  function getNoteCancelButton() {
    return document.querySelector('[data-note-cancel="' + COMMENT_BUCKET + '"]');
  }

  function applyCommentEditButtonUi() {
    var saveBtn = getNoteSaveButton();
    var cancelBtn = getNoteCancelButton();
    var id = editingCommentId || 0;
    var defLabel = (saveBtn && saveBtn.getAttribute('data-default-label')) || 'Kommentar hinzufügen';
    if (saveBtn) {
      saveBtn.textContent = id > 0 ? 'Kommentar ändern' : defLabel;
    }
    if (cancelBtn) {
      cancelBtn.style.display = id > 0 ? '' : 'none';
    }
  }

  function resetCommentEdit() {
    editingCommentId = 0;
    var ta = document.querySelector('[data-note="' + COMMENT_BUCKET + '"]');
    if (ta) ta.value = '';
    applyCommentEditButtonUi();
  }

  function startCommentEdit(commentId, body) {
    editingCommentId = commentId;
    var ta = document.querySelector('[data-note="' + COMMENT_BUCKET + '"]');
    if (ta) {
      ta.value = body != null ? String(body) : '';
      try {
        ta.focus();
        var len = ta.value.length;
        ta.setSelectionRange(len, len);
      } catch (e) { /* ignore */ }
    }
    applyCommentEditButtonUi();
    try {
      ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e2) { /* ignore */ }
  }

  var trashSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  var editSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  function mergedCommentsFromStore() {
    var c = window.__abComments || {};
    var list = [];
    (c.dispo || []).forEach(function (item) {
      var copy = {};
      Object.keys(item).forEach(function (k) { copy[k] = item[k]; });
      copy._bucket = 'dispo';
      list.push(copy);
    });
    (c.buchhaltung || []).forEach(function (item) {
      var copy2 = {};
      Object.keys(item).forEach(function (k) { copy2[k] = item[k]; });
      copy2._bucket = 'buchhaltung';
      list.push(copy2);
    });
    list.sort(function (a, b) {
      var da = String(a.created_at || '');
      var db = String(b.created_at || '');
      if (da !== db) return da < db ? -1 : (da > db ? 1 : 0);
      return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
    });
    return list;
  }

  function renderMergedComments() {
    var root = document.querySelector('[data-comments-list="' + COMMENT_BUCKET + '"]');
    if (!root) return;
    root.innerHTML = '';
    var ro = !currentJobCanWrite();
    mergedCommentsFromStore().forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'ab-comment-item';
      div.dataset.commentId = String(c.id);
      var head = document.createElement('div');
      head.className = 'ab-comment-head';
      var meta = document.createElement('span');
      var dt = c.created_at ? formatDeDt(String(c.created_at)) : '';
      var label = (c.author_name || '') + (dt ? ' · ' + dt : '');
      if (c._bucket === 'buchhaltung') {
        label += ' · Buchhaltung';
      }
      meta.textContent = label;
      head.appendChild(meta);
      if ((c.can_edit || c.can_delete) && !ro) {
        var act = document.createElement('span');
        act.className = 'ab-comment-actions';
        if (c.can_edit) {
          var be = document.createElement('button');
          be.type = 'button';
          be.className = 'ab-comment-icon-btn';
          be.title = 'Bearbeiten';
          be.setAttribute('aria-label', 'Kommentar bearbeiten');
          be.innerHTML = editSvg;
          be.addEventListener('click', function () {
            startCommentEdit(c.id, c.body || '');
          });
          act.appendChild(be);
        }
        if (c.can_delete) {
          var bd = document.createElement('button');
          bd.type = 'button';
          bd.className = 'ab-comment-icon-btn';
          bd.title = 'Löschen';
          bd.setAttribute('aria-label', 'Kommentar löschen');
          bd.innerHTML = trashSvg;
          bd.addEventListener('click', function () {
            if (!confirm('Kommentar löschen?')) return;
            if (editingCommentId === c.id) {
              resetCommentEdit();
            }
            var fd2 = new FormData();
            fd2.append('csrf_token', cfg.csrfComment || '');
            fd2.append('job_id', String(currentJobId()));
            fd2.append('comment_id', String(c.id));
            fetch('/api/abrechnung_comment_delete.php', { method: 'POST', body: fd2, credentials: 'same-origin' })
              .then(function (r) { return r.json(); })
              .then(function (res) {
                if (!res.ok) alert(res.error || 'Fehler');
                loadNotes();
              });
          });
          act.appendChild(bd);
        }
        head.appendChild(act);
      }
      var body = document.createElement('div');
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = c.body || '';
      div.appendChild(head);
      div.appendChild(body);
      root.appendChild(div);
    });
  }

  function loadNotes() {
    var id = currentJobId();
    if (!id) return;
    fetch('/api/abrechnung_notes.php?job_id=' + encodeURIComponent(String(id)), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.comments) return;
        window.__abComments = data.comments;
        renderMergedComments();
      });
  }

  function loadBucketList() {
    var id = currentJobId();
    if (!id) return;
    fetch('/api/abrechnung_bucket_list.php?job_id=' + encodeURIComponent(String(id)) + '&bucket=' + encodeURIComponent(COMMENT_BUCKET), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) renderFiles(COMMENT_BUCKET, data.files);
      });
  }

  function renderFiles(bucket, files) {
    var ul = document.querySelector('[data-file-list="' + bucket + '"]');
    if (!ul) return;
    ul.innerHTML = '';
    var id = currentJobId();
    var canDel = currentJobCanWrite();
    (files || []).forEach(function (f) {
      var li = document.createElement('li');
      li.draggable = true;
      var url = '/api/abrechnung_file_download.php?job_id=' + encodeURIComponent(String(id)) +
        '&bucket=' + encodeURIComponent(bucket) + '&name=' + encodeURIComponent(f.name);
      if (canDel) {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ab-file-delete-btn btn-delete-ab-file';
        delBtn.title = 'Datei löschen';
        delBtn.setAttribute('aria-label', 'Datei löschen');
        delBtn.innerHTML = trashSvg;
        delBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!confirm('Datei wirklich löschen?')) return;
          var fd = new FormData();
          fd.append('csrf_token', cfg.csrfUpload || '');
          fd.append('job_id', String(id));
          fd.append('bucket', bucket);
          fd.append('name', f.name);
          fetch('/api/abrechnung_file_delete.php', { method: 'POST', body: fd, credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (!res.ok) {
                alert(res.error || 'Löschen fehlgeschlagen');
                return;
              }
              li.remove();
            })
            .catch(function () { alert('Fehler beim Löschen.'); });
        });
        li.appendChild(delBtn);
      }
      var a = document.createElement('a');
      a.href = url;
      a.textContent = f.name;
      a.draggable = true;
      var size = typeof f.size_bytes === 'number' ? f.size_bytes : 0;
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.style.fontSize = '11px';
      meta.textContent = size ? (' · ' + Math.round(size / 1024) + ' KB') : '';
      li.appendChild(a);
      li.appendChild(meta);
      li.addEventListener('dragstart', function (e) {
        try {
          e.dataTransfer.setData('DownloadURL', 'application/octet-stream:' + f.name + ':' + window.location.origin + url);
        } catch (err) { /* ignore */ }
      });
      ul.appendChild(li);
      if (window.dispoDesktopFiles && window.dispoDesktopFiles.bindAbrechnungFileLi) {
        window.dispoDesktopFiles.bindAbrechnungFileLi(li, {
          kind: 'abrechnung_file',
          jobId: id,
          bucket: bucket,
          filename: f.name,
          fileName: f.name,
        });
      }
    });
  }

  function loadAllForJob() {
    var id = currentJobId();
    if (!id) {
      document.querySelectorAll('[data-file-list]').forEach(function (ul) { ul.innerHTML = ''; });
      document.querySelectorAll('[data-comments-list="' + COMMENT_BUCKET + '"]').forEach(function (r) { r.innerHTML = ''; });
      resetCommentEdit();
      return;
    }
    loadBucketList();
    loadNotes();
    refreshReadonlyState();
  }

  function uploadFiles(fileList) {
    var id = currentJobId();
    if (!id || !fileList || !fileList.length) return;
    setUiBusy(true);
    var i = 0;
    function next() {
      if (i >= fileList.length) {
        setUiBusy(false);
        loadBucketList();
        return;
      }
      var fd = new FormData();
      fd.append('csrf_token', cfg.csrfUpload || '');
      fd.append('job_id', String(id));
      fd.append('bucket', COMMENT_BUCKET);
      fd.append('file', fileList[i]);
      fetch('/api/abrechnung_file_upload.php', { method: 'POST', body: fd, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          i += 1;
          if (!res.ok) {
            alert(res.error || 'Upload fehlgeschlagen');
          }
          next();
        })
        .catch(function () {
          i += 1;
          next();
        });
    }
    next();
  }

  function wireDropzone(card) {
    var bucket = card.getAttribute('data-bucket');
    if (!bucket) return;
    var dz = card.querySelector('[data-dropzone="' + bucket + '"]');
    var finp = card.querySelector('.ab-file-input[data-bucket="' + bucket + '"]');
    if (!dz || !finp) return;
    dz.addEventListener('click', function () { if (!finp.disabled) finp.click(); });
    finp.addEventListener('change', function () {
      uploadFiles(finp.files);
      finp.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('dragover');
      });
    });
    dz.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dz.classList.remove('dragover');
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (finp.disabled) return;
      uploadFiles(e.dataTransfer.files);
    });
  }

  function wireNotes(card) {
    var bucket = card.getAttribute('data-bucket');
    if (!bucket) return;
    var btn = card.querySelector('[data-note-save="' + bucket + '"]');
    var cancelBtn = card.querySelector('[data-note-cancel="' + bucket + '"]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var jid = currentJobId();
      if (!jid) return;
      var ta = card.querySelector('[data-note="' + bucket + '"]');
      var body = ta ? ta.value : '';
      var editId = editingCommentId || 0;
      if (editId > 0) {
        var fdEdit = new FormData();
        fdEdit.append('csrf_token', cfg.csrfComment || '');
        fdEdit.append('job_id', String(jid));
        fdEdit.append('comment_id', String(editId));
        fdEdit.append('body', body);
        fetch('/api/abrechnung_comment_edit.php', { method: 'POST', body: fdEdit, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (!res.ok) alert(res.error || 'Speichern fehlgeschlagen');
            else {
              resetCommentEdit();
              loadNotes();
            }
          })
          .catch(function () { alert('Netzwerkfehler.'); });
        return;
      }
      var fd = new FormData();
      fd.append('csrf_token', cfg.csrfNote || '');
      fd.append('job_id', String(jid));
      fd.append('bucket', COMMENT_BUCKET);
      fd.append('body', body);
      fetch('/api/abrechnung_note_save.php', { method: 'POST', body: fd, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) alert(res.error || 'Speichern fehlgeschlagen');
          else if (ta) ta.value = '';
          loadNotes();
        });
    });
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        resetCommentEdit();
      });
    }
  }

  document.querySelectorAll('.ab-card[data-bucket]').forEach(function (card) {
    wireDropzone(card);
    wireNotes(card);
  });

  if (chMv) chMv.addEventListener('change', saveBillingFlags);
  if (chEt) chEt.addEventListener('change', saveBillingFlags);

  if (jobSelect) {
    jobSelect.addEventListener('change', function () {
      resetCommentEdit();
      var id = currentJobId();
      if (cfg.prefillJob && cfg.prefillJob.id !== id) {
        cfg.prefillJob = null;
      }
      function afterPick() {
        loadAllForJob();
      }
      if (cfg.fromLaptopEmbed === true && typeof window.kuklaAbrechnungOnJobChange === 'function') {
        window.kuklaAbrechnungOnJobChange(afterPick);
      } else {
        afterPick();
      }
    });
  }

  function onPeriodChange() {
    function refreshPeriodUi() {
      fetchJobList(function (data) {
        var jobs = data.ok ? data.jobs : [];
        var pickId = pickAbrechnungDefaultJobId(jobs);
        fillJobDropdown(jobs, pickId);
        if (pickId && currentJobId()) {
          if (hintChoose) hintChoose.style.display = 'none';
          loadAllForJob();
        } else {
          if (hintChoose) hintChoose.style.display = '';
          if (mainBlocks) {
            mainBlocks.style.opacity = '0.5';
            mainBlocks.style.pointerEvents = 'none';
          }
          document.querySelectorAll('[data-file-list]').forEach(function (ul) { ul.innerHTML = ''; });
          document.querySelectorAll('[data-comments-list]').forEach(function (r) { r.innerHTML = ''; });
          if (chMv) chMv.checked = false;
          if (elTravel) elTravel.innerHTML = '';
          resetCommentEdit();
        }
      });
    }
    if (cfg.fromLaptopEmbed === true && typeof window.kuklaAbrechnungOnPeriodChange === 'function') {
      window.kuklaAbrechnungOnPeriodChange(refreshPeriodUi);
    } else {
      refreshPeriodUi();
    }
  }
  if (yearSelect) {
    yearSelect.addEventListener('change', onPeriodChange);
  }
  if (monthNumSelect) {
    monthNumSelect.addEventListener('change', onPeriodChange);
  }
  if (techSelect) {
    techSelect.addEventListener('change', function () {
      onPeriodChange();
    });
  }

  function applyAbrechnungFilter() {
    var selId = currentJobId();
    fetchJobList(function (data) {
      fillJobDropdown(data.ok ? data.jobs : [], selId);
      if (selId) {
        loadAllForJob();
      } else {
        if (hintChoose) hintChoose.style.display = '';
        if (mainBlocks) {
          mainBlocks.style.opacity = '0.5';
          mainBlocks.style.pointerEvents = 'none';
        }
        document.querySelectorAll('[data-file-list]').forEach(function (ul) { ul.innerHTML = ''; });
        document.querySelectorAll('[data-comments-list]').forEach(function (r) { r.innerHTML = ''; });
        if (chMv) chMv.checked = false;
        if (elTravel) elTravel.innerHTML = '';
        resetCommentEdit();
        refreshReadonlyState();
      }
    });
  }

  if (filterForm) {
    filterForm.addEventListener('submit', function (e) {
      e.preventDefault();
      applyAbrechnungFilter();
    });
  }

  function runInitialJobListLoad() {
    fetchJobList(function (data) {
      var jobs = data.ok ? data.jobs : [];
      var preId = 0;
      if (cfg.prefillJob && cfg.prefillJob.id) {
        preId = cfg.prefillJob.id;
      } else if (jobSelect && jobSelect.value) {
        preId = parseInt(jobSelect.value, 10) || 0;
      } else {
        preId = pickAbrechnungDefaultJobId(jobs);
      }
      fillJobDropdown(jobs, preId);
      if (currentJobId()) {
        loadAllForJob();
      } else {
        refreshReadonlyState();
      }
    });
  }

  if (cfg.fromLaptopEmbed === true && window.__kuklaAbrechnungDeferInitialJobList === true) {
    window.kuklaAbrechnungRunInitialJobList = runInitialJobListLoad;
  } else {
    runInitialJobListLoad();
  }

  window.kuklaAbrechnungReloadCurrentJob = function () {
    loadAllForJob();
  };

  function postJobStatusAction(url, csrfToken, jobId, onOk) {
    var fd = new FormData();
    fd.append('csrf_token', csrfToken || '');
    fd.append('job_id', String(jobId));
    fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) {
          alert(res.error || 'Aktion fehlgeschlagen');
          return;
        }
        if (typeof onOk === 'function') onOk(res);
      })
      .catch(function () { alert('Netzwerkfehler.'); });
  }

  if (btnAdminRevert) {
    btnAdminRevert.addEventListener('click', function () {
      var jid = currentJobId();
      if (!jid) return;
      if (!window.confirm('Auftrag von „abgerechnet“ auf „erledigt“ zurücksetzen?')) return;
      postJobStatusAction('/api/job_status_admin_revert_erledigt.php', cfg.csrfStatusAdminRevert, jid, function () {
        if (billingCache) billingCache.job_status = 'erledigt';
        fetchJobList(function (data) {
          fillJobDropdown(data.ok ? data.jobs : [], jid);
          loadAllForJob();
        });
      });
    });
  }
  if (btnDispoInArbeit) {
    btnDispoInArbeit.addEventListener('click', function () {
      var jid = currentJobId();
      if (!jid) return;
      postJobStatusAction('/api/job_status_dispo_set_in_arbeit.php', cfg.csrfDispoInArbeit, jid, function () {
        if (billingCache) billingCache.job_status = 'in_arbeit';
        fetchJobList(function (data) {
          fillJobDropdown(data.ok ? data.jobs : [], jid);
          loadAllForJob();
        });
      });
    });
  }

  window.kuklaAbrechnungReapply = function (newCfg) {
    if (newCfg) {
      cfg = newCfg;
      window.KUKLA_ABRECHNUNG = newCfg;
    }
    var ySel = document.getElementById('abYearSelect');
    var mSel = document.getElementById('abMonthNumSelect');
    var tSel = document.getElementById('abTechSelect');
    if (ySel && cfg.year) ySel.value = String(cfg.year);
    if (mSel && cfg.monthNum) mSel.value = String(cfg.monthNum);
    if (tSel) tSel.value = String(cfg.technician || 0);
    fetchJobList(function (data) {
      var preId = (cfg.prefillJob && cfg.prefillJob.id) ? cfg.prefillJob.id : (currentJobId() || 0);
      fillJobDropdown(data.ok ? data.jobs : [], preId);
      if (preId > 0) loadAllForJob();
      else refreshReadonlyState();
    });
  };
})();
