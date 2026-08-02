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
  var showAbgerechnetCb = document.getElementById('abShowAbgerechnet');
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

  var DEFAULT_BELEG_CATEGORIES = [
    { id: 'transport', label: 'Flug / Bahn / Transport', prefix: 'Transport', icon: 'flug_bahn_transport.png' },
    { id: 'hotel', label: 'Hotel', prefix: 'Hotel', icon: 'hotel.png' },
    { id: 'leihwagen', label: 'Leihauto', prefix: 'Leihwagen', icon: 'leihauto.png' },
    { id: 'arbeitsnachweis', label: 'Arbeitsnachweis', prefix: 'Arbeitsnachweis', icon: 'arbeitsnachweis.png' },
    { id: 'kfz', label: 'Maut / Parken', prefix: 'KFZ', icon: 'maut_parken.png' },
    { id: 'email', label: 'E-Mail', prefix: 'Email', icon: 'email.png' },
    { id: 'angebot', label: 'Angebot', prefix: 'Angebot', icon: 'angebot.png' },
    { id: 'bestellung', label: 'Bestellung', prefix: 'Bestellung', icon: 'bestellung.png' },
    { id: 'kommunikation', label: 'Kommunikation', prefix: 'Kommunikation', icon: 'kommunikation.png' },
    { id: 'gebuehren', label: 'Visa / Gebühren', prefix: 'Gebuehren', icon: 'visa_gebuehren.png' },
    { id: 'bewirtung', label: 'Kundenbewirtung', prefix: 'Bewirtung', icon: 'kundenbewirtung.png' },
    { id: 'sonstige', label: 'Sonstige Auslagen', prefix: 'Sonstige', icon: 'sonstige_auslagen.png' },
  ];

  function belegCategories() {
    return Array.isArray(cfg.belegCategories) && cfg.belegCategories.length
      ? cfg.belegCategories
      : DEFAULT_BELEG_CATEGORIES;
  }

  function staticAssetUrl(relPath) {
    var p = String(relPath || '').replace(/^\//, '');
    if (!p) return '';
    try {
      if (window.location && window.location.protocol !== 'file:') {
        return new URL(p, window.location.origin + '/').pathname;
      }
    } catch (e) { /* ignore */ }
    return p;
  }

  function belegIconUrl(icon) {
    var base = cfg.belegIconBase || 'icons/beleg/';
    base = String(base).replace(/^\//, '');
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return staticAssetUrl(base + icon);
  }

  function belegCategoryForFilename(name) {
    var base = String(name || '');
    if (base.indexOf('Firmenauto_') === 0) {
      var catsLegacy = belegCategories();
      for (var j = 0; j < catsLegacy.length; j++) {
        if (catsLegacy[j].id === 'arbeitsnachweis') return catsLegacy[j];
      }
    }
    var cats = belegCategories();
    for (var i = 0; i < cats.length; i++) {
      var prefix = String(cats[i].prefix || '');
      if (prefix && base.indexOf(prefix + '_') === 0) return cats[i];
    }
    return null;
  }

  function abUiIconImg(iconFile, alt, className) {
    var img = document.createElement('img');
    img.src = staticAssetUrl(iconFile);
    img.alt = alt || '';
    if (!alt) img.setAttribute('aria-hidden', 'true');
    img.className = className || 'ab-ui-icon';
    img.loading = 'lazy';
    return img;
  }

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
    }
    var q = 'monat=' + encodeURIComponent(m) + '&techniker=' + encodeURIComponent(String(t));
    if (showAbgerechnetChecked()) {
      q += '&mit_abgerechnet=1';
    }
    return q;
  }

  function showAbgerechnetChecked() {
    if (showAbgerechnetCb) {
      return !!showAbgerechnetCb.checked;
    }
    return cfg.showAbgerechnet === true;
  }

  function fetchJobList(cb) {
    fetch('/api/abrechnung_job_list.php?' + jobListQuery(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(cb)
      .catch(function () { cb({ ok: false, jobs: [] }); });
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
      var lbl = j.label || ('#' + j.id);
      if (j.status === 'abgerechnet') {
        lbl += ' (abgerechnet)';
      }
      o.textContent = lbl;
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

  function formatDeDtTime(value) {
    if (value == null || value === '') return '';
    var d;
    if (typeof value === 'number' && isFinite(value)) {
      d = value > 1e12 ? new Date(value) : new Date(value * 1000);
    } else {
      d = new Date(String(value));
    }
    if (isNaN(d.getTime())) return '';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yy = d.getFullYear();
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return dd + '.' + mm + '.' + yy + ' ' + hh + ':' + mi;
  }

  function fileUploadedAtLabel(file) {
    if (file && file.uploaded_at) return formatDeDtTime(file.uploaded_at);
    if (file && file.mtime) return formatDeDtTime(file.mtime);
    if (file && file.synced_at) return formatDeDtTime(file.synced_at);
    return '';
  }

  function buildFileMetaText(file) {
    var parts = [];
    var when = fileUploadedAtLabel(file);
    if (when) parts.push(when);
    if (file && file.uploaded_by_name) parts.push(String(file.uploaded_by_name));
    var size = typeof file.size_bytes === 'number' ? file.size_bytes : 0;
    if (size > 0) parts.push(Math.round(size / 1024) + ' KB');
    return parts.length ? (' · ' + parts.join(' · ')) : '';
  }

  function billingUiReadOnly() {
    return cfg.billingFlagsEditable !== true;
  }

  function billingStatusMeta(at, byName) {
    var parts = [];
    if (at) parts.push(formatDeDt(String(at)));
    if (byName) parts.push(String(byName));
    return parts.join(' · ');
  }

  function ensureBillingStatusReadonlyEl() {
    var fields = document.querySelector('.ab-billing-fields');
    if (!fields) return null;
    var el = document.getElementById('abBillingStatusReadonly');
    if (!el) {
      el = document.createElement('div');
      el.id = 'abBillingStatusReadonly';
      el.className = 'ab-billing-status-readonly';
      el.setAttribute('aria-live', 'polite');
      fields.insertBefore(el, fields.firstChild);
    }
    return el;
  }

  function makeBillingStatusChip(title, done, metaText) {
    var chip = document.createElement('div');
    chip.className = 'ab-billing-status-chip' + (done ? ' is-done' : ' is-open');
    var t = document.createElement('span');
    t.className = 'ab-billing-status-chip-title';
    t.textContent = done ? title : (title + ' · offen');
    chip.appendChild(t);
    if (done && metaText) {
      var m = document.createElement('span');
      m.className = 'ab-billing-status-chip-meta';
      m.textContent = metaText;
      chip.appendChild(m);
    } else if (done) {
      t.textContent = title + ' · erledigt';
    }
    return chip;
  }

  function renderBillingUiMode(b) {
    var montageBox = document.querySelector('.ab-montage-billing-box');
    var readonlyEl = ensureBillingStatusReadonlyEl();
    var ro = billingUiReadOnly();

    if (montageBox) montageBox.style.display = ro ? 'none' : '';
    if (elTravel) elTravel.style.display = ro ? 'none' : '';

    if (!ro) {
      if (readonlyEl) {
        readonlyEl.innerHTML = '';
        readonlyEl.style.display = 'none';
      }
      return;
    }

    if (!readonlyEl) return;
    if (!b) {
      readonlyEl.innerHTML = '';
      readonlyEl.style.display = 'none';
      return;
    }
    readonlyEl.style.display = 'flex';
    readonlyEl.innerHTML = '';

    readonlyEl.appendChild(makeBillingStatusChip(
      'Fakturierung Montage',
      !!b.montage_verrechnet,
      b.montage_verrechnet ? billingStatusMeta(b.montage_verrechnet_at, b.montage_verrechnet_by_name) : ''
    ));

    if (b.show_fakturierung_et) {
      readonlyEl.appendChild(makeBillingStatusChip(
        'Fakturierung ET',
        !!b.fakturierung_et,
        b.fakturierung_et ? billingStatusMeta(b.fakturierung_et_at, b.fakturierung_et_by_name) : ''
      ));
    }

    if (b.no_technicians_fallback) {
      readonlyEl.appendChild(makeBillingStatusChip(
        'Reisekosten abgerechnet',
        !!b.montage_abgerechnet_job_fallback,
        ''
      ));
    } else {
      (b.technicians || []).forEach(function (t) {
        readonlyEl.appendChild(makeBillingStatusChip(
          'Reisekosten abgerechnet — ' + (t.technician_name || ''),
          !!t.reise_abgerechnet,
          t.reise_abgerechnet ? billingStatusMeta(t.reise_abgerechnet_at, t.reise_abgerechnet_by_name) : ''
        ));
      });
    }
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
    if (!elTravel || billingUiReadOnly()) return;
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
        meta.style.textAlign = 'left';
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
          if (billingUiReadOnly()) {
            renderBillingUiMode(billingCache);
          } else {
            renderBillingUiMode(null);
            renderTravelCheckboxes(billingCache);
            bindTravelHandlers();
          }
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
        if (billingUiReadOnly()) {
          renderBillingUiMode(billingCache);
        } else {
          renderBillingUiMode(null);
          renderTravelCheckboxes(billingCache);
          bindTravelHandlers();
        }
        updateStatusActionButtons();
      })
      .catch(function () {
        alert('Netzwerkfehler beim Speichern der Abrechnungsflags.');
        fetchBillingState();
      });
  }

  function applyReadonlyUi(canWrite, status) {
    var ro = !canWrite;
    showBanner(ro ? 'Nur Lesen: keine Uploads und keine Kommentar-Änderungen für diesen Auftrag / Ihre Rolle.' : '');
    if (!canWrite) {
      resetCommentEdit();
    }
    document.querySelectorAll('.ab-beleg-upload').forEach(function (z) {
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
      renderBillingUiMode(null);
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
  var syncSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
  var checkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
  var warnSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  function abFileSyncStatusEl(file) {
    if (!cfg || cfg.fromLaptopEmbed !== true) return null;
    var state = String((file && file.sync_state) || 'idle');
    var present = file && file.server_present === true;
    var el = document.createElement('span');
    el.className = 'ab-file-sync-status';
    el.setAttribute('aria-hidden', 'false');
    if (state === 'pending_upload' || state === 'pending_delete' || state === 'syncing') {
      el.className += ' is-syncing';
      el.innerHTML = syncSvg;
      el.title = state === 'pending_delete' ? 'Löschen wird synchronisiert …' : 'Wird synchronisiert …';
    } else if (present) {
      el.className += ' is-online';
      el.innerHTML = checkSvg;
      el.title = 'Auf Server vorhanden';
    } else {
      el.className += ' is-offline';
      el.innerHTML = warnSvg;
      el.title = 'Noch nicht auf dem Server';
    }
    el.setAttribute('aria-label', el.title);
    return el;
  }

  function abCommentIconBtn(kind, title) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ab-comment-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = kind === 'edit' ? editSvg : trashSvg;
    return btn;
  }

  function abFileDeleteBtn(title) {
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ab-file-delete-btn btn-delete-ab-file';
    delBtn.title = title;
    delBtn.setAttribute('aria-label', title);
    delBtn.innerHTML = trashSvg;
    return delBtn;
  }

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
          var be = abCommentIconBtn('edit', 'Bearbeiten');
          be.addEventListener('click', function () {
            startCommentEdit(c.id, c.body || '');
          });
          act.appendChild(be);
        }
        if (c.can_delete) {
          var bd = abCommentIconBtn('delete', 'Löschen');
          bd.addEventListener('click', function () {
            if (!confirm('Kommentar löschen?')) return;
            if (editingCommentId === c.id) {
              resetCommentEdit();
            }
            var fd2 = new FormData();
            fd2.append('csrf_token', cfg.csrfComment || '');
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
    if (!id) return Promise.resolve([]);
    return fetch('/api/abrechnung_bucket_list.php?job_id=' + encodeURIComponent(String(id)) + '&bucket=' + encodeURIComponent(COMMENT_BUCKET), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) renderFiles(COMMENT_BUCKET, data.files);
        return data.ok ? (data.files || []) : [];
      })
      .catch(function () { return []; });
  }

  function flushAbrechnungOutbox() {
    if (!cfg || cfg.fromLaptopEmbed !== true) return Promise.resolve();
    return fetch('/api/abrechnung_outbox_flush.php', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
  }

  /** Sync-Pfeile bleiben sonst bis Seitenwechsel (Outbox-Flush nur bei Refresh). */
  function refreshFilesUntilIdle(attemptsLeft) {
    if (!cfg || cfg.fromLaptopEmbed !== true) {
      loadBucketList();
      return;
    }
    var left = typeof attemptsLeft === 'number' ? attemptsLeft : 6;
    flushAbrechnungOutbox()
      .then(function () { return loadBucketList(); })
      .then(function (files) {
        var pending = (files || []).some(function (f) {
          var st = String((f && f.sync_state) || '');
          return st === 'pending_upload' || st === 'pending_delete' || st === 'syncing';
        });
        if (!pending || left <= 0) return;
        setTimeout(function () { refreshFilesUntilIdle(left - 1); }, 700);
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
      var cat = belegCategoryForFilename(f.name);
      if (cat && cat.icon) {
        var fileIcon = document.createElement('img');
        fileIcon.src = belegIconUrl(cat.icon);
        fileIcon.alt = cat.label || '';
        fileIcon.className = 'ab-file-beleg-icon';
        fileIcon.setAttribute('aria-hidden', 'true');
        fileIcon.loading = 'lazy';
        li.appendChild(fileIcon);
      }
      if (canDel) {
        var delBtn = abFileDeleteBtn('Datei löschen');
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
                refreshFilesUntilIdle(2);
                return;
              }
              li.remove();
              if (res.warning) {
                try { console.warn('[abrechnung] delete:', res.warning); } catch (e) { /* ignore */ }
              }
              refreshFilesUntilIdle(4);
            })
            .catch(function () { alert('Fehler beim Löschen.'); });
        });
        li.appendChild(delBtn);
      }
      var syncStatus = abFileSyncStatusEl(f);
      if (syncStatus) li.appendChild(syncStatus);
      var a = document.createElement('a');
      a.href = url;
      a.textContent = f.name;
      a.draggable = true;
      var meta = document.createElement('span');
      meta.className = 'ab-file-meta muted';
      meta.textContent = buildFileMetaText(f);
      li.appendChild(a);
      li.appendChild(meta);
      li.addEventListener('dragstart', function (e) {
        try {
          e.dataTransfer.setData('DownloadURL', 'application/octet-stream:' + f.name + ':' + window.location.origin + url);
        } catch (err) { /* ignore */ }
      });
      ul.appendChild(li);
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

  function uploadFiles(fileList, belegPrefix) {
    var id = currentJobId();
    if (!id || !fileList || !fileList.length) return;
    setUiBusy(true);
    var i = 0;
    var prefix = belegPrefix ? String(belegPrefix) : '';
    function next() {
      if (i >= fileList.length) {
        setUiBusy(false);
        refreshFilesUntilIdle(6);
        return;
      }
      var fd = new FormData();
      fd.append('csrf_token', cfg.csrfUpload || '');
      fd.append('job_id', String(id));
      fd.append('bucket', COMMENT_BUCKET);
      if (prefix) {
        fd.append('beleg_prefix', prefix);
      }
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

  function renderBelegGrid(card) {
    var bucket = card.getAttribute('data-bucket');
    var grid = card.querySelector('[data-beleg-grid="' + bucket + '"]');
    if (!grid || grid.dataset.rendered === '1') return;
    grid.innerHTML = '';
    belegCategories().forEach(function (cat) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'ab-beleg-tile';
      tile.dataset.belegPrefix = cat.prefix || '';
      tile.title = cat.label || cat.prefix || '';
      var img = document.createElement('img');
      img.src = belegIconUrl(cat.icon || '');
      img.alt = cat.label || '';
      var lbl = document.createElement('span');
      lbl.className = 'ab-beleg-tile-label';
      lbl.textContent = cat.label || '';
      tile.appendChild(img);
      tile.appendChild(lbl);
      grid.appendChild(tile);
    });
    grid.dataset.rendered = '1';
  }

  function wireBelegUpload(card) {
    var bucket = card.getAttribute('data-bucket');
    if (!bucket) return;
    renderBelegGrid(card);
    var uploadWrap = card.querySelector('[data-beleg-upload="' + bucket + '"]');
    var finp = card.querySelector('.ab-file-input[data-bucket="' + bucket + '"]');
    var grid = card.querySelector('[data-beleg-grid="' + bucket + '"]');
    if (!uploadWrap || !finp || !grid) return;
    var pendingPrefix = '';
    grid.querySelectorAll('.ab-beleg-tile').forEach(function (tile) {
      var prefix = tile.dataset.belegPrefix || '';
      tile.addEventListener('click', function () {
        if (finp.disabled) return;
        pendingPrefix = prefix;
        finp.click();
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        tile.addEventListener(ev, function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!finp.disabled) tile.classList.add('dragover');
        });
      });
      tile.addEventListener('dragleave', function (e) {
        e.preventDefault();
        tile.classList.remove('dragover');
      });
      tile.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        tile.classList.remove('dragover');
        if (finp.disabled) return;
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          uploadFiles(e.dataTransfer.files, prefix);
        }
      });
    });
    finp.addEventListener('change', function () {
      uploadFiles(finp.files, pendingPrefix);
      pendingPrefix = '';
      finp.value = '';
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
    wireBelegUpload(card);
    wireNotes(card);
  });

  if (chMv) chMv.addEventListener('change', saveBillingFlags);
  if (chEt) chEt.addEventListener('change', saveBillingFlags);

  renderBillingUiMode(null);

  if (jobSelect) {
    jobSelect.addEventListener('change', function () {
      resetCommentEdit();
      var id = currentJobId();
      if (cfg.prefillJob && cfg.prefillJob.id !== id) {
        cfg.prefillJob = null;
      }
      loadAllForJob();
    });
  }

  function onPeriodChange() {
    fetchJobList(function (data) {
      fillJobDropdown(data.ok ? data.jobs : [], 0);
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
    });
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
  if (showAbgerechnetCb) {
    showAbgerechnetCb.addEventListener('change', onPeriodChange);
  }

  fetchJobList(function (data) {
    var jobs = data.ok ? data.jobs : [];
    var preId = 0;
    if (cfg.prefillJob && cfg.prefillJob.id) {
      preId = cfg.prefillJob.id;
    } else if (jobSelect && jobSelect.value) {
      preId = parseInt(jobSelect.value, 10) || 0;
    }
    fillJobDropdown(jobs, preId);
    if (currentJobId()) {
      loadAllForJob();
    } else {
      refreshReadonlyState();
    }
  });

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
})();
