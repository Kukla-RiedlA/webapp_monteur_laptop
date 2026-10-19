(function () {
  'use strict';

  var suggestTimer = null;
  var suggestItems = [];
  var dr = {
    viewY: new Date().getFullYear(),
    viewM: new Date().getMonth(),
    selStart: null,
    selEnd: null,
    dragging: false,
    dragAnchor: null,
  };

  function apiBase() {
    if (typeof window.monteurApp !== 'undefined' && window.monteurApp.apiBase) {
      return String(window.monteurApp.apiBase).replace(/\/$/, '');
    }
    return 'http://127.0.0.1:39678';
  }

  function technicianId() {
    if (typeof window.getTechId === 'function') {
      var t = window.getTechId();
      return t > 0 ? t : 0;
    }
    var elTid = document.getElementById('technicianId');
    return elTid ? parseInt(elTid.value, 10) || 0 : 0;
  }

  function technicianDisplayName() {
    var btn = document.getElementById('technicianName');
    var name = btn && btn.textContent ? String(btn.textContent).trim() : '';
    return name || 'Sie (Auftragsersteller)';
  }

  function updateAssignedHint() {
    var hint = el('anNeuAssignedHint');
    if (!hint) return;
    hint.textContent = 'Zugewiesen: ' + technicianDisplayName();
  }

  function clampRequiredTechnicians() {
    var input = el('anNeuRequired');
    if (!input) return 1;
    var n = parseInt(input.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 99) n = 99;
    input.value = String(n);
    return n;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setHint(msg, isError) {
    var h = el('auftragNeuHint');
    if (!h) return;
    h.textContent = msg || '';
    h.style.color = isError ? '#b00020' : '';
  }

  function hideSuggest() {
    var list = el('anNeuCustomerSuggest');
    if (list) {
      list.hidden = true;
      list.innerHTML = '';
    }
    suggestItems = [];
  }

  function fillCustomer(c) {
    if (!c) return;
    el('anNeuCustomerName').value = c.name || '';
    el('anNeuCustomerServerId').value = c.server_id != null && c.server_id !== '' ? String(c.server_id) : '';
    el('anNeuCustStreet').value = c.street || '';
    el('anNeuCustHouse').value = c.house_number || '';
    el('anNeuCustZip').value = c.zip || '';
    el('anNeuCustCity').value = c.city || '';
    el('anNeuCustCountry').value = c.country || 'AT';
    el('anNeuCustPhone').value = c.phone || '';
    el('anNeuCustEmail').value = c.email || '';
    el('anNeuCustEx1').value = c.address_extra_1 || '';
    el('anNeuCustEx2').value = c.address_extra_2 || '';
  }

  function showSuggest(items) {
    var list = el('anNeuCustomerSuggest');
    if (!list) return;
    suggestItems = items || [];
    if (!suggestItems.length) {
      hideSuggest();
      return;
    }
    list.innerHTML = '';
    suggestItems.forEach(function (c) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      var line = (c.name || '') + (c.city ? ' – ' + c.city : '') + (c.street ? ', ' + c.street : '');
      li.textContent = line;
      li.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        fillCustomer(c);
        hideSuggest();
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function fetchSuggest(q) {
    var url = apiBase() + '/api/customers?q=' + encodeURIComponent(q) + '&limit=12';
    var tid = technicianId();
    if (tid) url += '&technician_id=' + encodeURIComponent(String(tid));
    fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) {
          hideSuggest();
          return;
        }
        showSuggest(data.customers || []);
      })
      .catch(function () {
        hideSuggest();
      });
  }

  function onCustomerInput() {
    el('anNeuCustomerServerId').value = '';
    var q = (el('anNeuCustomerName').value || '').trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (q.length < 1) {
      hideSuggest();
      return;
    }
    suggestTimer = setTimeout(function () {
      fetchSuggest(q);
    }, 180);
  }

  function copyCustomerToSite() {
    el('anNeuSiteEndkunde').value = el('anNeuCustomerName').value || '';
    el('anNeuSiteStreet').value = el('anNeuCustStreet').value || '';
    el('anNeuSiteHouse').value = el('anNeuCustHouse').value || '';
    el('anNeuSiteZip').value = el('anNeuCustZip').value || '';
    el('anNeuSiteCity').value = el('anNeuCustCity').value || '';
    el('anNeuSiteCountry').value = el('anNeuCustCountry').value || 'AT';
    el('anNeuSiteEx1').value = el('anNeuCustEx1').value || '';
    el('anNeuSiteEx2').value = el('anNeuCustEx2').value || '';
  }

  function parseFab(text) {
    var raw = (text || '').trim();
    if (!raw) return null;
    var parts = raw
      .split(/[\n;]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    if (!parts.length) return null;
    return JSON.stringify(
      parts.map(function (fab) {
        return { fabrikationsnummer: fab, type: '', leistung: '', position: '' };
      }),
    );
  }

  function toYMD(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseYMD(s) {
    if (!s) return null;
    var m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }

  function dayKey(d) {
    return toYMD(d);
  }

  function sameDay(a, b) {
    return a && b && dayKey(a) === dayKey(b);
  }

  function formatDe(d) {
    return d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function updateDateButtonLabel() {
    var btn = el('anNeuDateBtn');
    if (!btn) return;
    var noDate = el('anNeuNoDate') && el('anNeuNoDate').checked;
    if (noDate) {
      btn.textContent = 'Ohne Datum';
      btn.classList.add('is-empty');
      btn.disabled = true;
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    btn.disabled = false;
    var s = parseYMD(el('anNeuStart').value);
    var e = parseYMD(el('anNeuEnd').value);
    if (!s) {
      btn.textContent = 'Zeitraum wählen …';
      btn.classList.add('is-empty');
      return;
    }
    if (!e || sameDay(s, e)) {
      btn.textContent = formatDe(s);
    } else {
      btn.textContent = formatDe(s) + ' – ' + formatDe(e);
    }
    btn.classList.remove('is-empty');
  }

  function syncNoDateUi() {
    updateDateButtonLabel();
  }

  function orderedRange(a, b) {
    if (!a) return { start: null, end: null };
    if (!b) return { start: a, end: a };
    if (dayKey(a) <= dayKey(b)) return { start: a, end: b };
    return { start: b, end: a };
  }

  function buildCalendarGrid(y, m) {
    var first = new Date(y, m, 1, 12, 0, 0);
    var startPad = (first.getDay() + 6) % 7;
    var cells = [];
    var prev = new Date(y, m, 0, 12, 0, 0);
    var prevDays = prev.getDate();
    for (var i = startPad - 1; i >= 0; i--) {
      cells.push({ d: new Date(y, m - 1, prevDays - i, 12, 0, 0), inMonth: false });
    }
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      cells.push({ d: new Date(y, m, day, 12, 0, 0), inMonth: true });
    }
    var nextY = m === 11 ? y + 1 : y;
    var nextM = m === 11 ? 0 : m + 1;
    var dNext = 1;
    while (cells.length < 42) {
      cells.push({ d: new Date(nextY, nextM, dNext, 12, 0, 0), inMonth: false });
      dNext++;
    }
    return cells.slice(0, 42);
  }

  function renderCalendar() {
    var title = el('anNeuDateTitle');
    var grid = el('anNeuDateGrid');
    if (!title || !grid) return;
    var ref = new Date(dr.viewY, dr.viewM, 1, 12, 0, 0);
    title.textContent = ref.toLocaleString('de-AT', { month: 'long', year: 'numeric' });
    var range = orderedRange(dr.selStart, dr.selEnd);
    var r0 = range.start;
    var r1 = range.end;
    var cells = buildCalendarGrid(dr.viewY, dr.viewM);
    grid.innerHTML = '';
    cells.forEach(function (cell) {
      var d = cell.d;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kukla-daterange-day';
      if (!cell.inMonth) btn.classList.add('kukla-daterange-day--muted');
      btn.textContent = String(d.getDate());
      btn.dataset.ymd = toYMD(d);
      if (r0 && r1) {
        if (sameDay(r0, r1)) {
          if (sameDay(d, r0)) btn.classList.add('kukla-daterange-day--end');
        } else if (sameDay(d, r0)) {
          btn.classList.add('kukla-daterange-day--start');
        } else if (sameDay(d, r1)) {
          btn.classList.add('kukla-daterange-day--end');
        } else if (dayKey(d) > dayKey(r0) && dayKey(d) < dayKey(r1)) {
          btn.classList.add('kukla-daterange-day--inrange');
        }
      } else if (r0 && sameDay(d, r0)) {
        btn.classList.add('kukla-daterange-day--end');
      }
      btn.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        dr.dragging = true;
        dr.dragAnchor = d;
        dr.selStart = d;
        dr.selEnd = d;
        renderCalendar();
      });
      btn.addEventListener('mouseenter', function () {
        if (!dr.dragging || !dr.dragAnchor) return;
        dr.selStart = dr.dragAnchor;
        dr.selEnd = d;
        renderCalendar();
      });
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (dr.dragging) return;
        if (!dr.selStart || (dr.selStart && dr.selEnd && !sameDay(dr.selStart, dr.selEnd))) {
          dr.selStart = d;
          dr.selEnd = null;
        } else if (dr.selStart && !dr.selEnd) {
          dr.selEnd = d;
        } else {
          dr.selStart = d;
          dr.selEnd = null;
        }
        renderCalendar();
      });
      grid.appendChild(btn);
    });
  }

  function setModalOpen(open) {
    var modal = el('anNeuDateModal');
    var btn = el('anNeuDateBtn');
    if (!modal) return;
    if (open) {
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    } else {
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      dr.dragging = false;
      dr.dragAnchor = null;
    }
  }

  function openDateModal() {
    if (el('anNeuNoDate') && el('anNeuNoDate').checked) return;
    var s = parseYMD(el('anNeuStart').value);
    var e = parseYMD(el('anNeuEnd').value);
    dr.selStart = s;
    dr.selEnd = e || s;
    var t = s || new Date();
    dr.viewY = t.getFullYear();
    dr.viewM = t.getMonth();
    var hint = el('anNeuDateHint');
    if (hint) hint.textContent = 'Mit der Maus von–bis ziehen, oder zwei Tage anklicken.';
    setModalOpen(true);
    renderCalendar();
  }

  function applyDateModal() {
    if (!dr.selStart) {
      var hint = el('anNeuDateHint');
      if (hint) hint.textContent = 'Bitte mindestens einen Tag wählen.';
      return;
    }
    var range = orderedRange(dr.selStart, dr.selEnd || dr.selStart);
    el('anNeuStart').value = toYMD(range.start);
    el('anNeuEnd').value = toYMD(range.end);
    setModalOpen(false);
    updateDateButtonLabel();
  }

  function cancelDateModal() {
    setModalOpen(false);
  }

  function collectPayload() {
    var noDate = el('anNeuNoDate') && el('anNeuNoDate').checked;
    var start = noDate ? '' : el('anNeuStart').value || '';
    var end = noDate ? '' : el('anNeuEnd').value || '';
    var contact = {
      first_name: (el('anNeuContactFirst').value || '').trim(),
      last_name: (el('anNeuContactLast').value || '').trim(),
      title: (el('anNeuContactTitle').value || '').trim(),
      department: (el('anNeuContactDept').value || '').trim(),
      phone: (el('anNeuContactPhone').value || '').trim(),
      mobile: (el('anNeuContactMobile').value || '').trim(),
      email: (el('anNeuContactEmail').value || '').trim(),
    };
    var contacts = [];
    if (
      contact.first_name ||
      contact.last_name ||
      contact.title ||
      contact.department ||
      contact.phone ||
      contact.mobile ||
      contact.email
    ) {
      contacts.push(contact);
    }
    var hotel = {
      endkunde: (el('anNeuHotelName').value || '').trim(),
      street: (el('anNeuHotelStreet').value || '').trim(),
      house_number: (el('anNeuHotelHouse').value || '').trim(),
      zip: (el('anNeuHotelZip').value || '').trim(),
      city: (el('anNeuHotelCity').value || '').trim(),
      country: (el('anNeuHotelCountry').value || '').trim(),
      phone: (el('anNeuHotelPhone').value || '').trim(),
      email: (el('anNeuHotelEmail').value || '').trim(),
      website: (el('anNeuHotelWeb').value || '').trim(),
    };
    var hasHotel = Object.keys(hotel).some(function (k) {
      return hotel[k];
    });
    var serverId = (el('anNeuCustomerServerId').value || '').trim();
    return {
      technician_id: technicianId(),
      client_create_token:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      job_type: el('anNeuJobType').value,
      required_technicians: clampRequiredTechnicians(),
      date_not_fixed: el('anNeuDateNotFixed').checked ? 1 : 0,
      entry_permit_required: el('anNeuEntryPermit').checked ? 1 : 0,
      start_datetime: start,
      end_datetime: end,
      description: el('anNeuDescription').value || '',
      fabrikationsnummern: parseFab(el('anNeuFab').value),
      customer_server_id: serverId ? parseInt(serverId, 10) : null,
      customer_name: (el('anNeuCustomerName').value || '').trim(),
      customer_street: el('anNeuCustStreet').value || '',
      customer_house_number: el('anNeuCustHouse').value || '',
      customer_zip: el('anNeuCustZip').value || '',
      customer_city: el('anNeuCustCity').value || '',
      customer_country: el('anNeuCustCountry').value || '',
      customer_phone: el('anNeuCustPhone').value || '',
      customer_email: el('anNeuCustEmail').value || '',
      customer_address_extra_1: el('anNeuCustEx1').value || '',
      customer_address_extra_2: el('anNeuCustEx2').value || '',
      job_address: {
        endkunde: el('anNeuSiteEndkunde').value || '',
        street: el('anNeuSiteStreet').value || '',
        house_number: el('anNeuSiteHouse').value || '',
        zip: el('anNeuSiteZip').value || '',
        city: el('anNeuSiteCity').value || '',
        country: el('anNeuSiteCountry').value || 'AT',
        address_extra_1: el('anNeuSiteEx1').value || '',
        address_extra_2: el('anNeuSiteEx2').value || '',
      },
      hotel_address: hasHotel ? hotel : null,
      job_contacts: contacts,
      technician_ids: [technicianId()].filter(function (n) {
        return n > 0;
      }),
    };
  }

  function resetForm() {
    var form = el('auftragNeuForm');
    if (form) form.reset();
    el('anNeuCustomerServerId').value = '';
    el('anNeuCustCountry').value = 'AT';
    el('anNeuSiteCountry').value = 'AT';
    el('anNeuRequired').value = '1';
    el('anNeuStart').value = '';
    el('anNeuEnd').value = '';
    if (el('anNeuNoDate')) el('anNeuNoDate').checked = false;
    if (el('anNeuDateNotFixed')) el('anNeuDateNotFixed').checked = false;
    if (el('anNeuEntryPermit')) el('anNeuEntryPermit').checked = false;
    hideSuggest();
    setHint('');
    updateDateButtonLabel();
    updateAssignedHint();
  }

  function saveJob() {
    var name = (el('anNeuCustomerName').value || '').trim();
    if (!name) {
      setHint('Bitte Firma / Kunde eingeben.', true);
      el('anNeuCustomerName').focus();
      return;
    }
    var noDate = el('anNeuNoDate') && el('anNeuNoDate').checked;
    if (!noDate && !(el('anNeuStart').value || '').trim()) {
      setHint('Bitte Zeitraum wählen oder „Ohne Datum“ aktivieren.', true);
      return;
    }
    var payload = collectPayload();
    setHint('Speichere …');
    var btn = el('btnAuftragNeuSave');
    if (btn) btn.disabled = true;
    fetch(apiBase() + '/api/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { data: data };
        });
      })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          setHint((res.data && res.data.error) || 'Speichern fehlgeschlagen.', true);
          return;
        }
        setHint('Auftrag lokal angelegt. Sync übernimmt die Server-ID.');
        if (typeof window.showView === 'function') window.showView('dienstreise');
        if (typeof window.loadDienstreiseList === 'function') window.loadDienstreiseList();
        if (typeof window.openJobDetailsModal === 'function' && res.data.id) {
          setTimeout(function () {
            window.openJobDetailsModal(res.data.id);
          }, 200);
        }
        resetForm();
      })
      .catch(function (err) {
        setHint(err && err.message ? err.message : 'Netzwerkfehler.', true);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function initDateRange() {
    var btn = el('anNeuDateBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', openDateModal);
    var backdrop = el('anNeuDateBackdrop');
    var ok = el('anNeuDateOk');
    var cancel = el('anNeuDateCancel');
    var prev = el('anNeuDatePrev');
    var next = el('anNeuDateNext');
    if (backdrop) backdrop.addEventListener('click', cancelDateModal);
    if (cancel) cancel.addEventListener('click', cancelDateModal);
    if (ok) ok.addEventListener('click', applyDateModal);
    if (prev) {
      prev.addEventListener('click', function () {
        dr.viewM--;
        if (dr.viewM < 0) {
          dr.viewM = 11;
          dr.viewY--;
        }
        renderCalendar();
      });
    }
    if (next) {
      next.addEventListener('click', function () {
        dr.viewM++;
        if (dr.viewM > 11) {
          dr.viewM = 0;
          dr.viewY++;
        }
        renderCalendar();
      });
    }
    document.addEventListener('mouseup', function () {
      if (!dr.dragging) return;
      dr.dragging = false;
      dr.dragAnchor = null;
    });
  }

  function initAuftragNeu() {
    var nameInput = el('anNeuCustomerName');
    if (nameInput && !nameInput.dataset.bound) {
      nameInput.dataset.bound = '1';
      nameInput.addEventListener('input', onCustomerInput);
      nameInput.addEventListener('blur', function () {
        setTimeout(hideSuggest, 150);
      });
    }
    var copyBtn = el('btnAuftragNeuCopyCustomerAddr');
    if (copyBtn && !copyBtn.dataset.bound) {
      copyBtn.dataset.bound = '1';
      copyBtn.addEventListener('click', copyCustomerToSite);
    }
    var reqInput = el('anNeuRequired');
    if (reqInput && !reqInput.dataset.bound) {
      reqInput.dataset.bound = '1';
      reqInput.addEventListener('change', clampRequiredTechnicians);
      reqInput.addEventListener('blur', clampRequiredTechnicians);
    }
    var saveBtn = el('btnAuftragNeuSave');
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        saveJob();
      });
    }
    var cancelBtn = el('btnAuftragNeuCancel');
    if (cancelBtn && !cancelBtn.dataset.bound) {
      cancelBtn.dataset.bound = '1';
      cancelBtn.addEventListener('click', function () {
        resetForm();
        if (typeof window.showView === 'function') window.showView('dienstreise');
      });
    }
    var noDate = el('anNeuNoDate');
    if (noDate && !noDate.dataset.bound) {
      noDate.dataset.bound = '1';
      noDate.addEventListener('change', syncNoDateUi);
    }
    var neuBtn = el('btnNeuerAuftrag');
    if (neuBtn && !neuBtn.dataset.bound) {
      neuBtn.dataset.bound = '1';
      neuBtn.addEventListener('click', function () {
        resetForm();
        updateAssignedHint();
        if (typeof window.showView === 'function') window.showView('auftrag-neu');
      });
    }
    initDateRange();
    updateDateButtonLabel();
    updateAssignedHint();
  }

  window.initAuftragNeuView = function () {
    initAuftragNeu();
    updateAssignedHint();
    setHint('Status und ERP vergibt die Dispo. Offline speichern möglich.');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuftragNeu);
  } else {
    initAuftragNeu();
  }
})();
