/**
 * Laptop (Electron): RAMS Abrufen/Erstellen + Quiz-Wizard.
 * Nutzt MonteurRamsBridge aus app.js und lokale Proxy-Routen.
 */
(function () {
  'use strict';

  function htmlEscape(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isJobActive(job) {
    if (!job) return false;
    var s = String(job.status || '').toLowerCase();
    if (!s) return true;
    var inactive = ['closed', 'cancelled', 'archived', 'storno', 'abgeschlossen', 'erledigt'];
    return inactive.indexOf(s) === -1;
  }

  function getBridge() {
    var B = window.MonteurRamsBridge;
    if (!B || typeof B.getDispoBaseUrl !== 'function') {
      return null;
    }
    return B;
  }

  function monteurRamsProxy(body) {
    var B = getBridge();
    if (!B) return Promise.reject(new Error('MonteurRamsBridge fehlt'));
    var baseUrl = B.getDispoBaseUrl();
    if (!baseUrl) return Promise.reject(new Error('Dispo-Basis-URL fehlt (Einstellungen).'));
    return fetch(B.API_BASE + '/api/laptop_rams_proxy', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Technician-Id': String(B.getTechId()) },
        B.authHeaders()
      ),
      body: JSON.stringify(Object.assign({ baseUrl: baseUrl }, body))
    })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var j = {};
        try {
          j = JSON.parse(text);
        } catch (e) {
          throw new Error('Ungueltige JSON-Antwort vom Server.');
        }
        if (j.ok === false) {
          throw new Error(j.error || 'Fehler');
        }
        if (j.ok === true && j.data !== undefined) {
          return j.data;
        }
        return j;
      });
  }

  function monteurMobilePost(relPath, payload) {
    var B = getBridge();
    if (!B) return Promise.reject(new Error('MonteurRamsBridge fehlt'));
    var baseUrl = B.getDispoBaseUrl();
    if (!baseUrl) return Promise.reject(new Error('Dispo-Basis-URL fehlt.'));
    return fetch(B.API_BASE + '/api/laptop_mobile_post', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Technician-Id': String(B.getTechId()) },
        B.authHeaders()
      ),
      body: JSON.stringify({ baseUrl: baseUrl, path: relPath, payload: payload || {} })
    })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var j = {};
        try {
          j = JSON.parse(text);
        } catch (e) {
          throw new Error('Ungueltige JSON-Antwort.');
        }
        if (!j || j.ok === false) {
          throw new Error((j && j.error) || 'Fehler');
        }
        return j;
      });
  }

  function openWizardOverlay() {
    var el = document.getElementById('ramsWizardOverlay');
    if (!el) return;
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeWizardOverlay() {
    var el = document.getElementById('ramsWizardOverlay');
    if (!el) return;
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    var c = document.getElementById('ramsWizardContainer');
    if (c) c.innerHTML = '';
  }

  function loadRamsMyList() {
    var B = getBridge();
    var msg = document.getElementById('ramsListMessage');
    var ul = document.getElementById('ramsListItems');
    if (!B || !ul) return;
    if (!B.getTechId()) {
      if (msg) msg.textContent = 'Monteur-ID in Einstellungen eintragen.';
      ul.innerHTML = '';
      return;
    }
    var statusEl = document.getElementById('ramsListStatusFilter');
    var status = statusEl ? statusEl.value : '';
    var qp = {};
    if (status) qp.status = status;
    if (msg) msg.textContent = 'Lade RAMS ...';
    monteurRamsProxy({ action: 'list_my', method: 'GET', queryParams: qp })
      .then(function (data) {
        var items = (data && data.items) ? data.items : [];
        if (!items.length) {
          ul.innerHTML = '';
          if (msg) msg.textContent = 'Keine RAMS gefunden.';
          return;
        }
        if (msg) msg.textContent = '';
        var html = '';
        items.forEach(function (it) {
          var id = it.id;
          var docId = it.document_id || ('#' + id);
          var st = it.status_label || it.status || '';
          html += '<li><div class="rams-line"><strong>' + htmlEscape(docId) + '</strong> ';
          html += '<span class="muted">Auftrag ' + htmlEscape(String(it.job_number != null ? it.job_number : it.job_id)) + '</span> ';
          html += '<span class="rams-status">' + htmlEscape(st) + '</span></div>';
          html += '<div class="rams-actions">';
          html += '<button type="button" class="btn btn-primary" data-rams-quiz="' + String(id) + '">Quiz oeffnen</button>';
          var base = B.getDispoBaseUrl();
          if (base) {
            html += '<a class="btn btn-ghost" target="_blank" rel="noopener" href="' + htmlEscape(base + '/api/rams/pdf.php?id=' + encodeURIComponent(String(id)) + '&inline=1') + '">PDF</a>';
            html += '<a class="btn btn-ghost" target="_blank" rel="noopener" href="' + htmlEscape(base + '/api/rams/pdf.php?id=' + encodeURIComponent(String(id)) + '&inline=1&force_preview=1') + '">PDF Live</a>';
          }
          html += '</div></li>';
        });
        ul.innerHTML = html;
        Array.prototype.forEach.call(ul.querySelectorAll('[data-rams-quiz]'), function (btn) {
          btn.addEventListener('click', function () {
            var rid = parseInt(btn.getAttribute('data-rams-quiz'), 10);
            if (rid > 0) startWizardForRamsId(rid);
          });
        });
      })
      .catch(function (e) {
        if (msg) msg.textContent = (e && e.message) ? e.message : 'Fehler.';
        ul.innerHTML = '';
      });
  }

  function loadRamsJobsForCreate() {
    var B = getBridge();
    var msg = document.getElementById('ramsJobsMessage');
    var ul = document.getElementById('ramsJobsItems');
    if (!B || !ul) return;
    if (!B.getTechId()) {
      if (msg) msg.textContent = 'Monteur-ID in Einstellungen eintragen.';
      ul.innerHTML = '';
      return;
    }
    if (!B.getDispoBaseUrl()) {
      if (msg) msg.textContent = 'Dispo-Basis-URL fehlt.';
      ul.innerHTML = '';
      return;
    }
    if (msg) msg.textContent = 'Lade Auftraege ...';
    fetch(B.API_BASE + '/api/laptop_active_jobs_for_rams', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Technician-Id': String(B.getTechId()) },
        B.authHeaders()
      ),
      body: JSON.stringify({
        baseUrl: B.getDispoBaseUrl(),
        technician_id: B.getTechId()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          if (msg) msg.textContent = (j && j.error) ? j.error : 'Laden fehlgeschlagen.';
          ul.innerHTML = '';
          return;
        }
        var jobs = (j.jobs || []).filter(isJobActive);
        if (!jobs.length) {
          ul.innerHTML = '';
          if (msg) msg.textContent = 'Keine aktiven Auftraege.';
          return;
        }
        if (msg) msg.textContent = '';
        var html = '';
        jobs.forEach(function (job) {
          var label = job.job_number || ('#' + job.id);
          var sub = [job.customer_name, job.city].filter(Boolean).join(' · ');
          html += '<li><div class="rams-line"><strong>' + htmlEscape(String(label)) + '</strong>';
          if (sub) html += ' <span class="muted">' + htmlEscape(sub) + '</span>';
          html += '</div><div class="rams-actions">';
          html += '<button type="button" class="btn btn-primary" data-rams-create-job="' + String(job.id) + '">RAMS anlegen</button>';
          html += '</div></li>';
        });
        ul.innerHTML = html;
        Array.prototype.forEach.call(ul.querySelectorAll('[data-rams-create-job]'), function (btn) {
          btn.addEventListener('click', function () {
            var jid = parseInt(btn.getAttribute('data-rams-create-job'), 10);
            if (jid > 0) createBlankAndOpen(jid);
          });
        });
      })
      .catch(function (e) {
        if (msg) msg.textContent = (e && e.message) ? e.message : 'Fehler.';
        ul.innerHTML = '';
      });
  }

  function createBlankAndOpen(jobId) {
    var msg = document.getElementById('ramsJobsMessage');
    if (msg) msg.textContent = 'Lege RAMS an ...';
    monteurRamsProxy({ action: 'create_blank', method: 'POST', payload: { job_id: jobId, language: 'de' } })
      .then(function (data) {
        var ramsId = data && data.id ? parseInt(String(data.id), 10) : 0;
        if (!ramsId) {
          if (msg) msg.textContent = 'Keine RAMS-ID erhalten.';
          return;
        }
        if (msg) msg.textContent = '';
        startWizardForRamsId(ramsId);
      })
      .catch(function (e) {
        if (msg) msg.textContent = (e && e.message) ? e.message : 'Fehler.';
      });
  }

  function fetchDocAndCatalog(ramsId, lang) {
    var lp = lang === 'en' ? 'en' : 'de';
    return Promise.all([
      monteurRamsProxy({ action: 'document', method: 'GET', queryParams: { id: ramsId, lang: lp } }),
      monteurRamsProxy({ action: 'catalog', method: 'GET', queryParams: { lang: lp } })
    ]).then(function (arr) {
      return { doc: arr[0], catalog: arr[1] };
    });
  }

  function startWizardForRamsId(ramsId) {
    if (!window.RamsWizardCore || typeof window.RamsWizardCore.open !== 'function') {
      window.alert('Wizard nicht verfuegbar.');
      return;
    }
    var B = getBridge();
    var lang = 'de';
    fetchDocAndCatalog(ramsId, lang)
      .then(function (data) {
        openWizardOverlay();
        var container = document.getElementById('ramsWizardContainer');
        window.RamsWizardCore.open({
          container: container,
          doc: data.doc,
          catalog: data.catalog,
          lang: lang,
          onLanguageChange: function (newLang) {
            return fetchDocAndCatalog(ramsId, newLang);
          },
          onSavePayload: function (payload) {
            return monteurRamsProxy({ action: 'save', method: 'POST', payload: payload });
          },
          onSubmit: function (id) {
            return monteurRamsProxy({ action: 'submit', method: 'POST', payload: { id: id } }).catch(function (err) {
              throw err;
            });
          },
          onTechnicianChecklist: function (id, answers, note) {
            return monteurRamsProxy({
              action: 'technician_checklist',
              method: 'POST',
              payload: {
                id: id,
                role_key: 'prepared_by',
                answers: answers,
                note: note || ''
              }
            });
          },
          onSign: function (savedDoc) {
            return new Promise(function (resolve, reject) {
              if (!window.SignatureWidget || typeof window.SignatureWidget.open !== 'function') {
                reject(new Error('SignatureWidget fehlt.'));
                return;
              }
              var ramsId2 = savedDoc && savedDoc.id ? parseInt(String(savedDoc.id), 10) : ramsId;
              var nameSug = (B && B.getTechnicianDisplayName) ? (B.getTechnicianDisplayName() || '') : '';
              var pdfLang = savedDoc && savedDoc.language === 'en' ? 'EN' : 'DE';
              var techId = B && B.getTechId ? parseInt(String(B.getTechId()), 10) || 0 : 0;
              window.SignatureWidget.open({
                refType: 'rams_iso',
                refId: ramsId2,
                mobile: false,
                signerRole: 'techniker',
                pdfLanguage: pdfLang,
                signerNameSuggestion: nameSug,
                technicianUserId: techId,
                signerUserId: techId,
                customSessionOpen: function () {
                  return monteurMobilePost('/api/mobile/signature_session_open.php', {
                    ref_type: 'rams_iso',
                    ref_id: ramsId2,
                    signer_role: 'techniker',
                    pdf_language: pdfLang,
                    technician_id: techId
                  });
                },
                customSubmit: function (pl) {
                  return monteurMobilePost('/api/mobile/signature_submit.php', pl);
                },
                onSigned: function (sigRes) {
                  var evId = sigRes && sigRes.event_id ? parseInt(String(sigRes.event_id), 10) : 0;
                  if (!evId) {
                    reject(new Error('Signatur ohne event_id.'));
                    return;
                  }
                  var signerName = sigRes && sigRes.signer_name ? sigRes.signer_name : nameSug;
                  monteurRamsProxy({
                    action: 'sign_link',
                    method: 'POST',
                    payload: {
                      id: ramsId2,
                      role_key: 'prepared_by',
                      event_id: evId,
                      signer_name: signerName
                    }
                  })
                    .then(resolve)
                    .catch(reject);
                },
                onCancel: function () {
                  reject(new Error('Signatur abgebrochen.'));
                }
              });
            });
          },
          onClose: function () {
            closeWizardOverlay();
            loadRamsMyList();
          },
          onError: function () {}
        });
      })
      .catch(function (e) {
        window.alert((e && e.message) ? e.message : 'Wizard konnte nicht geoeffnet werden.');
      });
  }

  function setAuftraegeTab(tab) {
    document.querySelectorAll('.auftraege-tab').forEach(function (t) {
      var on = t.getAttribute('data-auftraege-tab') === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.auftraege-pane').forEach(function (p) {
      var match =
        (tab === 'list' && p.id === 'auftraegePaneList') ||
        (tab === 'rams-fetch' && p.id === 'auftraegePaneRamsFetch') ||
        (tab === 'rams-create' && p.id === 'auftraegePaneRamsCreate');
      p.classList.toggle('is-active', match);
      if (match) {
        p.removeAttribute('hidden');
      } else {
        p.setAttribute('hidden', '');
      }
    });
    if (tab === 'list' && typeof window.loadDienstreiseList === 'function') {
      window.loadDienstreiseList();
    }
    if (tab === 'rams-fetch') {
      loadRamsMyList();
    }
    if (tab === 'rams-create') {
      loadRamsJobsForCreate();
    }
  }

  function initAuftraegeRamsUi() {
    document.querySelectorAll('.auftraege-tab[data-auftraege-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-auftraege-tab');
        if (tab) setAuftraegeTab(tab);
      });
    });
    var rel = document.getElementById('ramsListReload');
    if (rel) rel.addEventListener('click', loadRamsMyList);
    var rj = document.getElementById('ramsJobsReload');
    if (rj) rj.addEventListener('click', loadRamsJobsForCreate);
    var sf = document.getElementById('ramsListStatusFilter');
    if (sf) sf.addEventListener('change', loadRamsMyList);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuftraegeRamsUi);
  } else {
    initAuftraegeRamsUi();
  }

  window.loadRamsMyList = loadRamsMyList;
  window.loadRamsJobsForCreate = loadRamsJobsForCreate;
})();
