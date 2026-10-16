/**
 * Laptop: Hinweis-Lampe, Popup, Akte- und Projektdaten-Karten (Dispo-Vorlage).
 */
(function (global) {
  'use strict';
  var API_BASE = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var lastPopupIds = {};
  var TAGS = {
    inbetriebnahme: 'Inbetriebnahme',
    allgemein: 'Allgemein',
    service: 'Service',
    betrieb: 'Betrieb'
  };
  var VALIDITY_LABELS = {
    permanent: 'Dauerhaft',
    until_next_service: 'Bis nächsten Service',
    until_date: 'Bis Datum'
  };
  var modalTab = 'open';
  var lastOpenItems = [];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDt(iso) {
    var s = String(iso || '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) return m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + m[5];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    return s;
  }

  function setLamp(state) {
    var btn = document.getElementById('hinweisLampBtn');
    if (!btn) return;
    btn.classList.remove('is-red', 'is-yellow', 'is-off');
    btn.classList.add(state === 'red' ? 'is-red' : state === 'yellow' ? 'is-yellow' : 'is-off');
  }

  function fileIsImage(f) {
    if (!f) return false;
    if (f.is_image === true || f.is_image === 1 || f.is_image === '1') return true;
    var mime = String(f.mime || '').toLowerCase();
    if (mime.indexOf('image/') === 0) return true;
    return /\.(jpe?g|png|webp|gif)$/i.test(String(f.original_name || ''));
  }

  function fileHref(f, asDownload) {
    var href = '';
    if (f && f.url && String(f.url).indexOf('local=1') !== -1) {
      href = API_BASE + (String(f.url).charAt(0) === '/' ? f.url : '/' + f.url);
    } else if (f && f.id) {
      href = API_BASE + '/api/hinweise/file?id=' + encodeURIComponent(String(f.id));
    } else if (f && f.url) {
      var u = String(f.url);
      href = u.indexOf('http') === 0 ? u : API_BASE + (u.charAt(0) === '/' ? u : '/' + u);
      href = href.replace('/api/mobile/hinweis_file.php', '/api/hinweise/file');
    } else {
      return '';
    }
    if (asDownload && href.indexOf('download=') === -1) {
      href += (href.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
    }
    return href;
  }

  function filesHtml(files, asDownload) {
    files = files || [];
    if (!files.length) return '';
    var html = '<ul class="hinweis-files">';
    files.forEach(function (f) {
      var href = fileHref(f, asDownload && !fileIsImage(f));
      var viewHref = fileHref(f, false);
      if (!href) return;
      html += '<li class="hinweis-file">';
      if (fileIsImage(f) && viewHref) {
        html += '<a href="' + esc(viewHref) + '" target="_blank" rel="noopener">' +
          '<img class="hinweis-file-thumb" src="' + esc(viewHref) + '" alt=""></a>';
      }
      html += '<a href="' + esc(href) + '"' +
        (asDownload && !fileIsImage(f)
          ? ' download="' + esc(f.original_name || 'datei') + '"'
          : ' target="_blank" rel="noopener"') +
        '>' + esc(f.original_name || 'Datei') + '</a></li>';
    });
    return html + '</ul>';
  }

  function parseFabInput(str) {
    if (!str || typeof str !== 'string') return [];
    var parts = str.split(/[\s]*[,;][\s]*/).map(function (p) { return p.trim(); }).filter(Boolean);
    var numbers = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var m = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        var a = parseInt(m[1], 10);
        var b = parseInt(m[2], 10);
        if (String(m[2]).length < String(a).length) {
          var pow = Math.pow(10, m[2].length);
          b = Math.floor(a / pow) * pow + b;
        }
        if (a > b) { var t = a; a = b; b = t; }
        if (b - a > 500) continue;
        for (var n = a; n <= b; n++) numbers.push(String(n));
      } else numbers.push(p);
    }
    var seen = {};
    return numbers.filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  function renderModalFnChips(root) {
    var input = root.querySelector('[name="fabrikationsnummer"]');
    var box = root.querySelector('[data-hinweis-fn-chips]');
    if (!input || !box) return;
    var nums = parseFabInput(input.value || '');
    box.innerHTML = nums.map(function (fn) {
      return '<span class="hinweis-fn-chip" data-fn="' + esc(fn) + '">' +
        '<span class="hinweis-fn-chip-label">' + esc(fn) + '</span>' +
        '<button type="button" class="hinweis-fn-chip-x" data-hinweis-fn-remove="' + esc(fn) + '" aria-label="FN entfernen">✕</button></span>';
    }).join('');
  }

  function cardHtml(it, opts) {
    opts = opts || {};
    var overdue = !!it.overdue;
    var pruef = !!(it.pruefablauf === true || it.pruefablauf === 1 || it.pruefablauf === '1');
    var html = '<article class="hinweis-card' + (overdue ? ' is-overdue' : '') + (pruef ? ' is-pruefablauf' : '') + '" data-hinweis-id="' + esc(it.hinweis_id) + '">';
    html += '<div class="hinweis-card-meta">';
    html += '<span class="hinweis-tag">' + esc(TAGS[it.tag] || it.tag || '') + '</span>';
    if (pruef) html += '<span class="hinweis-badge-pruef">Bedienung / Prüfablauf</span>';
    html += it.scope === 'job' ? 'Auftrag' : 'FN';
    if (it.fabrikationsnummer) html += ' · FN ' + esc(it.fabrikationsnummer);
    if (it.job_number) html += ' · ' + esc(it.job_number);
    else if (it.job_id) html += ' · Auftrag #' + esc(it.job_id);
    html += ' · ' + esc(it.created_by_name || '') + ' · ' + esc(fmtDt(it.created_at));
    var val = it.validity || (it.deadline ? 'until_date' : 'permanent');
    if (VALIDITY_LABELS[val]) html += ' · ' + esc(VALIDITY_LABELS[val]);
    if (it.deadline) html += ' · ' + esc(fmtDt(it.deadline));
    if (overdue) html += ' · <strong>überfällig</strong>';
    if (it.status === 'done') html += ' · erledigt';
    html += '</div>';
    if (it.body) html += '<p class="hinweis-card-body">' + esc(it.body) + '</p>';
    html += filesHtml(it.files);
    if (!opts.readOnly && it.status !== 'done') {
      html += '<div class="hinweis-card-actions">';
      if (opts.jobView) {
        html += '<button type="button" class="btn btn-primary" data-hinweis-act="erledigt">Erledigt</button>';
      } else {
        html += '<button type="button" class="btn" data-hinweis-act="verwerfen">Verwerfen</button>';
        html += '<button type="button" class="btn" data-hinweis-act="aufheben">Aufheben</button>';
        html += '<button type="button" class="btn btn-primary" data-hinweis-act="erledigt">Erledigt</button>';
      }
      html += '</div>';
    }
    html += '</article>';
    return html;
  }

  function jobCardHtml(it) {
    if (it.status === 'done') return '';
    var html = '<article class="hinweis-card hinweis-card-job" data-hinweis-id="' + esc(it.hinweis_id) + '">';
    if (it.body) html += '<p class="hinweis-card-body">' + esc(it.body) + '</p>';
    html += filesHtml(it.files, true) || '<p class="muted">Keine Dateien.</p>';
    html += '<div class="hinweis-card-actions">';
    html += '<button type="button" class="btn btn-primary" data-hinweis-act="erledigt">Erledigt</button>';
    html += '</div></article>';
    return html;
  }

  function createFormHtml() {
    return '<form class="hinweis-create-form" id="hinweisModalCreateForm">' +
      '<input type="hidden" name="scope" value="fn">' +
      '<div class="hinweis-field hinweis-field-full"><label>Fabrikationsnummern</label>' +
      '<input type="text" name="fabrikationsnummer" autocomplete="off" placeholder="z. B. 11030; 11031-33">' +
      '<div class="hinweis-fn-chips" data-hinweis-fn-chips></div></div>' +
      '<div class="hinweis-field"><label>Tag</label><select name="tag">' +
      '<option value="allgemein">Allgemein</option><option value="inbetriebnahme">Inbetriebnahme</option>' +
      '<option value="service">Service</option><option value="betrieb">Betrieb</option></select></div>' +
      '<div class="hinweis-field"><label>Gültigkeit</label><select name="validity">' +
      '<option value="permanent">Dauerhaft</option>' +
      '<option value="until_next_service">Bis zum nächsten Service</option>' +
      '<option value="until_date">Bis zu einem Datum</option></select></div>' +
      '<div class="hinweis-field" data-hinweis-deadline-wrap style="display:none"><label>Gültig bis</label>' +
      '<input type="date" name="deadline"></div>' +
      '<div class="hinweis-field hinweis-field-full"><label class="hinweis-check">' +
      '<input type="checkbox" name="pruefablauf" value="1"> Bedienung / Prüfablauf</label></div>' +
      '<div class="hinweis-field hinweis-field-full"><label>Text</label>' +
      '<textarea name="body" rows="4" placeholder="Hinweistext und/oder Dateien"></textarea></div>' +
      '<div class="hinweis-field hinweis-field-full"><div class="hinweis-drop" data-hinweis-drop>' +
      'Dateien hierher ziehen oder klicken' +
      '<input type="file" name="files[]" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.docx,.xlsx,.zip">' +
      '<div class="hinweis-drop-list" data-hinweis-drop-list></div></div></div>' +
      '<div class="hinweis-create-actions"><button type="button" class="btn btn-primary" data-hinweis-save>Speichern</button></div>' +
      '</form>';
  }

  function ensureModal() {
    var m = document.getElementById('hinweisModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'hinweisModal';
    m.className = 'hinweis-modal';
    m.innerHTML =
      '<div class="hinweis-modal-card hinweis-modal-wide">' +
      '<h2>Montagehinweise</h2>' +
      '<div class="hinweis-modal-tabs" role="tablist">' +
      '<button type="button" data-hinweis-tab="open" class="is-active">Offen</button>' +
      '<button type="button" data-hinweis-tab="new">Neu</button>' +
      '<button type="button" data-hinweis-tab="history">Historie</button></div>' +
      '<div id="hinweisModalBody"></div>' +
      '<button type="button" class="btn" id="hinweisModalClose">Schließen</button></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('is-open'); });
    document.getElementById('hinweisModalClose').addEventListener('click', function () { m.classList.remove('is-open'); });
    m.querySelector('.hinweis-modal-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-hinweis-tab]');
      if (!btn) return;
      modalTab = btn.getAttribute('data-hinweis-tab') || 'open';
      m.querySelectorAll('[data-hinweis-tab]').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-hinweis-tab') === modalTab);
      });
      renderModalBody();
    });
    return m;
  }

  function sortPruefFirst(items) {
    return (items || []).slice().sort(function (a, b) {
      var ap = a && (a.pruefablauf === true || a.pruefablauf === 1) ? 1 : 0;
      var bp = b && (b.pruefablauf === true || b.pruefablauf === 1) ? 1 : 0;
      return bp - ap;
    });
  }

  function bindModalCreateForm(form) {
    if (!form || form.getAttribute('data-bound')) return;
    form.setAttribute('data-bound', '1');
    bindDropzone(form.querySelector('[data-hinweis-drop]'));
    var fabInput = form.querySelector('[name="fabrikationsnummer"]');
    if (fabInput) {
      fabInput.addEventListener('input', function () { renderModalFnChips(form); });
    }
    var valSel = form.querySelector('[name="validity"]');
    var wrap = form.querySelector('[data-hinweis-deadline-wrap]');
    function syncVal() {
      var v = valSel ? valSel.value : 'permanent';
      if (wrap) wrap.style.display = v === 'until_date' ? '' : 'none';
    }
    if (valSel) valSel.addEventListener('change', syncVal);
    syncVal();
    form.addEventListener('click', function (e) {
      var rm = e.target.closest && e.target.closest('[data-hinweis-fn-remove]');
      if (rm && form.contains(rm)) {
        e.preventDefault();
        var fn = rm.getAttribute('data-hinweis-fn-remove');
        if (fabInput) {
          fabInput.value = parseFabInput(fabInput.value || '').filter(function (n) { return n !== fn; }).join('; ');
          renderModalFnChips(form);
        }
        return;
      }
      var btn = e.target.closest && e.target.closest('[data-hinweis-save]');
      if (!btn || !form.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var fd = collectFormData(form);
      fd.set('scope', 'fn');
      if (!fd.get('pruefablauf')) fd.set('pruefablauf', '0');
      fetch(API_BASE + '/api/hinweise/create', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || d.ok === false) throw new Error((d && d.error) || 'Fehler');
          resetCreateForm(form);
          renderModalFnChips(form);
          syncVal();
          modalTab = 'open';
          ensureModal().querySelectorAll('[data-hinweis-tab]').forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-hinweis-tab') === 'open');
          });
          refresh().then(function () {
            return fetch(API_BASE + '/api/hinweise/mine').then(function (r) { return r.json(); });
          }).then(function (d2) {
            lastOpenItems = (d2 && d2.items) || [];
            renderModalBody();
          });
        })
        .catch(function (err) { window.alert(err.message || 'Speichern fehlgeschlagen'); });
    });
  }

  function renderModalBody() {
    var body = document.getElementById('hinweisModalBody');
    if (!body) return;
    if (modalTab === 'new') {
      body.innerHTML = createFormHtml();
      bindModalCreateForm(document.getElementById('hinweisModalCreateForm'));
      return;
    }
    if (modalTab === 'history') {
      body.innerHTML = '<p class="muted">Historie wird geladen…</p>';
      fetch(API_BASE + '/api/hinweise?status=done&overview=1&limit=100')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var items = sortPruefFirst((d && d.items) || []).filter(function (it) { return it && it.status === 'done'; });
          body.innerHTML = items.length
            ? items.map(function (it) { return cardHtml(it, { readOnly: true }); }).join('')
            : '<p class="muted">Keine erledigten Hinweise.</p>';
        })
        .catch(function () {
          body.innerHTML = '<p class="muted">Historie nicht verfügbar (offline?).</p>';
        });
      return;
    }
    var open = sortPruefFirst((lastOpenItems || []).filter(function (it) { return !it || it.status !== 'done'; }));
    body.innerHTML = open.length ? open.map(function (it) { return cardHtml(it); }).join('') : '<p>Keine Hinweise.</p>';
  }

  function openModal(items) {
    lastOpenItems = items || [];
    modalTab = 'open';
    var m = ensureModal();
    m.querySelectorAll('[data-hinweis-tab]').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-hinweis-tab') === 'open');
    });
    renderModalBody();
    m.classList.add('is-open');
  }

  function refresh() {
    return fetch(API_BASE + '/api/hinweise/mine')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) return d;
        setLamp(d.lamp || 'off');
        lastOpenItems = d.items || lastOpenItems;
        var fresh = [];
        (d.popup || []).forEach(function (it) {
          var id = String(it.hinweis_id || '');
          if (!id || lastPopupIds[id]) return;
          lastPopupIds[id] = true;
          fresh.push(it);
        });
        if (fresh.length) openModal(fresh);
        return d;
      })
      .catch(function () { return null; });
  }

  function bindDropzone(zone) {
    if (!zone || zone.getAttribute('data-bound')) return;
    zone.setAttribute('data-bound', '1');
    var input = zone.querySelector('input[type="file"]');
    var list = zone.querySelector('[data-hinweis-drop-list]');
    function names() {
      if (!list || !input || !input.files) return;
      var n = [];
      for (var i = 0; i < input.files.length; i++) n.push(input.files[i].name);
      list.textContent = n.join(', ');
    }
    zone.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (input) input.click();
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('is-drag');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('is-drag');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-drag');
      if (!input || !e.dataTransfer || !e.dataTransfer.files) return;
      input.files = e.dataTransfer.files;
      names();
    });
    if (input) input.addEventListener('change', names);
  }

  function collectFormData(root) {
    var fd = new FormData();
    if (!root) return fd;
    var nodes = root.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.name || el.disabled) continue;
      var type = String(el.type || '').toLowerCase();
      if (type === 'file') {
        var files = el.files || [];
        for (var f = 0; f < files.length; f++) fd.append(el.name, files[f]);
        continue;
      }
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      fd.append(el.name, el.value);
    }
    return fd;
  }

  function resetCreateForm(root) {
    if (!root) return;
    var keep = { scope: 1, job_id: 1, fabrikationsnummer: 1 };
    root.querySelectorAll('input, select, textarea').forEach(function (el) {
      var type = String(el.type || '').toLowerCase();
      if (type === 'hidden' && keep[el.name]) return;
      if (el.name === 'fabrikationsnummer' && el.tagName === 'SELECT') return;
      if (type === 'checkbox' || type === 'radio') return;
      if (type === 'file') { el.value = ''; return; }
      if (el.tagName === 'SELECT') { el.selectedIndex = 0; return; }
      el.value = '';
    });
    var list = root.querySelector('[data-hinweis-drop-list]');
    if (list) list.textContent = '';
  }

  function bindCreateForm(form, onOk) {
    if (!form || form.getAttribute('data-bound')) return;
    form.setAttribute('data-bound', '1');
    bindDropzone(form.querySelector('[data-hinweis-drop]'));
    form.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-hinweis-save]');
      if (!btn || !form.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var fd = collectFormData(form);
      fd.set('scope', 'fn');
      if (!fd.get('pruefablauf')) fd.set('pruefablauf', '0');
      fetch(API_BASE + '/api/hinweise/create', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || d.ok === false) throw new Error((d && d.error) || 'Fehler');
          resetCreateForm(form);
          if (typeof onOk === 'function') onOk();
          refresh();
        })
        .catch(function (err) { window.alert(err.message || 'Speichern fehlgeschlagen'); });
    });
  }

  function loadAkte() {
    var list = document.getElementById('akteHinweiseList');
    if (!list) return;
    var fabEl = document.getElementById('formFab');
    var fab = fabEl ? String(fabEl.value || '').trim() : '';
    if (!fab) {
      list.innerHTML = '<p class="muted">Keine Fabrikationsnummer.</p>';
      return;
    }
    fetch(API_BASE + '/api/hinweise?fabrikationsnummer=' + encodeURIComponent(fab))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        list.innerHTML = items.length ? items.map(function (it) { return cardHtml(it); }).join('') : '<p class="muted">Keine Hinweise.</p>';
        var tab = document.querySelector('.akte-tab[data-akte-tab="hinweise"]');
        if (tab) tab.classList.toggle('has-open-hinweis', items.some(function (it) { return it.status === 'open'; }));
      })
      .catch(function () {
        list.innerHTML = '<p class="muted">Hinweise konnten nicht geladen werden.</p>';
      });
    var form = document.getElementById('akteHinweisCreateForm');
    var hiddenFab = document.getElementById('akteHinweisFab');
    if (hiddenFab) hiddenFab.value = fab;
    bindCreateForm(form, loadAkte);
  }

  function serverJobId(job) {
    if (!job) return 0;
    var sid = job.server_id != null && job.server_id !== '' ? job.server_id : job.id;
    return parseInt(sid, 10) || 0;
  }

  function loadJob(job) {
    job = job || global.currentProjektdatenJob || null;
    var list = document.getElementById('jobHinweiseList');
    if (!list) return;
    var jid = serverJobId(job);
    if (jid <= 0) {
      list.innerHTML = '';
      var emptyCard = document.getElementById('jobHinweiseCard');
      if (emptyCard) emptyCard.hidden = true;
      return;
    }
    fetch(API_BASE + '/api/hinweise?job_id=' + encodeURIComponent(String(jid)))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = ((d && d.items) || []).filter(function (it) { return it && it.status !== 'done'; });
        var html = items.map(jobCardHtml).join('');
        list.innerHTML = html;
        var card = document.getElementById('jobHinweiseCard');
        if (card) card.hidden = !html;
      })
      .catch(function () {
        list.innerHTML = '';
        var card = document.getElementById('jobHinweiseCard');
        if (card) card.hidden = true;
      });
  }

  function postAction(id, act) {
    return fetch(API_BASE + '/api/hinweise/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hinweis_id: id, action: act })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.ok === false) throw new Error((d && d.error) || 'Aktion fehlgeschlagen');
    });
  }

  function onCardClick(e) {
    var btn = e.target.closest && e.target.closest('[data-hinweis-act]');
    if (!btn) return;
    var card = btn.closest('[data-hinweis-id]');
    var id = card ? parseInt(card.getAttribute('data-hinweis-id'), 10) : 0;
    var act = btn.getAttribute('data-hinweis-act');
    if (!id || !act) return;
    postAction(id, act)
      .then(function () {
        refresh();
        loadAkte();
        loadJob();
      })
      .catch(function (err) { window.alert(err.message || 'Aktion fehlgeschlagen'); });
  }

  function init() {
    var btn = document.getElementById('hinweisLampBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        fetch(API_BASE + '/api/hinweise/mine').then(function (r) { return r.json(); }).then(function (d) {
          openModal((d && d.items) || []);
        }).catch(function () { openModal([]); });
      });
    }
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('#hinweisModalBody, #akteHinweiseList, #jobHinweiseList')) {
        onCardClick(e);
      }
    });
    refresh();
    setInterval(refresh, 30000);
    loadAkte();
    loadJob();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.KuklaLaptopHinweise = { refresh: refresh, loadAkte: loadAkte, loadJob: loadJob };
})(window);
