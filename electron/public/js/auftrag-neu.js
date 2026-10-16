(function () {
  'use strict';

  var suggestTimer = null;
  var suggestItems = [];

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
    suggestItems.forEach(function (c, idx) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.idx = String(idx);
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
    var parts = raw.split(/[\n;]+/).map(function (s) {
      return s.trim();
    }).filter(Boolean);
    if (!parts.length) return null;
    return JSON.stringify(
      parts.map(function (fab) {
        return { fabrikationsnummer: fab, type: '', leistung: '', position: '' };
      }),
    );
  }

  function collectPayload() {
    var noDate = el('anNeuNoDate') && el('anNeuNoDate').checked;
    var start = noDate ? '' : (el('anNeuStart').value || '');
    var end = noDate ? '' : (el('anNeuEnd').value || '');
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
      status: el('anNeuStatus').value || 'angelegt',
      required_technicians: parseInt(el('anNeuRequired').value, 10) || 1,
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
    el('anNeuStatus').value = 'zugeteilt';
    el('anNeuRequired').value = '1';
    hideSuggest();
    setHint('');
  }

  function saveJob() {
    var name = (el('anNeuCustomerName').value || '').trim();
    if (!name) {
      setHint('Bitte Firma / Kunde eingeben.', true);
      el('anNeuCustomerName').focus();
      return;
    }
    var payload = collectPayload();
    setHint('Speichere …');
    var btn = el('btnAuftragNeuSave');
    if (btn) btn.disabled = true;
    var url = apiBase() + '/api/job';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { okHttp: r.ok, data: data };
        });
      })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          setHint((res.data && res.data.error) || 'Speichern fehlgeschlagen.', true);
          return;
        }
        setHint('Auftrag lokal angelegt. Sync übernimmt die Server-ID.');
        if (typeof window.showView === 'function') {
          window.showView('dienstreise');
        }
        if (typeof window.loadDienstreiseList === 'function') {
          window.loadDienstreiseList();
        }
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

  function syncNoDateUi() {
    var noDate = el('anNeuNoDate') && el('anNeuNoDate').checked;
    ['anNeuStart', 'anNeuEnd'].forEach(function (id) {
      var i = el(id);
      if (i) i.disabled = !!noDate;
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
        if (typeof window.showView === 'function') window.showView('auftrag-neu');
      });
    }
    syncNoDateUi();
  }

  window.initAuftragNeuView = function () {
    initAuftragNeu();
    setHint('ERP-Nummer und Bestellnummer vergibt die Dispo später. Offline speichern möglich.');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuftragNeu);
  } else {
    initAuftragNeu();
  }
})();
