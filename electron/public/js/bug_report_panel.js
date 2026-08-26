/**
 * Bugreport-Panel: Neuer Eintrag + Liste/Kommentare.
 * Konfiguration: window.KUKLA_BUG_REPORT
 */
(function () {
  'use strict';

  var root = document.getElementById('bugReportApp');
  if (!root) return;

  var cfg = window.KUKLA_BUG_REPORT || {};
  var endpoints = cfg.endpoints || {};
  var fallback = cfg.fallbackEndpoints || null;
  var actorName = String(cfg.actor_name || '');
  var appVersion = String(cfg.app_version || '');
  var appClient = String(cfg.app_client || 'web');
  var canResolve = !!cfg.can_resolve;
  var screenshotUrlFn = typeof cfg.screenshotUrl === 'function' ? cfg.screenshotUrl : null;

  var state = {
    pane: 'new',
    kind: 'bug',
    statusFilter: 'open',
    kindFilter: 'all',
    reports: [],
    openId: null,
    detail: null,
    screenshotDataUrl: '',
    busy: false,
    pin: false,
  };

  function ep(name) {
    return endpoints[name] || '';
  }

  function screenshotUrl(id) {
    if (screenshotUrlFn) return screenshotUrlFn(id);
    var u = ep('screenshot');
    if (!u) return '';
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(id);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDt(iso) {
    var s = String(iso || '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) return m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + m[5];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    return s;
  }

  function clientLabel(c) {
    if (c === 'laptop') return 'Laptop';
    if (c === 'desktop') return 'Desktop';
    return 'Web';
  }

  function kindLabel(k) {
    return k === 'wish' ? 'Wunsch' : 'Bug';
  }

  function setStatus(msg, isError) {
    var el = root.querySelector('[data-br-status]');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  async function apiFetch(name, opts) {
    opts = opts || {};
    var url = ep(name);
    if (opts.query) url += (url.indexOf('?') >= 0 ? '&' : '?') + opts.query;
    var init = {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    var r;
    try {
      r = await fetch(url, init);
    } catch (e1) {
      if (fallback && fallback[name]) {
        url = fallback[name];
        if (opts.query) url += (url.indexOf('?') >= 0 ? '&' : '?') + opts.query;
        r = await fetch(url, init);
      } else {
        throw e1;
      }
    }
    var data = {};
    var ct = (r.headers.get('content-type') || '');
    if (ct.indexOf('json') >= 0) {
      data = await r.json().catch(function () { return {}; });
    }
    if (!r.ok || data.ok === false) {
      if (fallback && fallback[name] && url.indexOf(fallback[name]) !== 0) {
        url = fallback[name];
        if (opts.query) url += (url.indexOf('?') >= 0 ? '&' : '?') + opts.query;
        r = await fetch(url, init);
        data = await r.json().catch(function () { return {}; });
        if (r.ok && data.ok !== false) return data;
      }
      var err = new Error((data && data.error) || ('HTTP ' + r.status));
      err.data = data;
      throw err;
    }
    return data;
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !String(file.type || '').startsWith('image/')) {
        reject(new Error('no-image'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(reader.error || new Error('read')); };
      reader.onload = function () {
        var src = String(reader.result || '');
        var img = new Image();
        img.onload = function () {
          var max = 1600;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(src);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { reject(new Error('decode')); };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
  }

  function firstImageFile(dt) {
    if (!dt) return null;
    var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
    var f = files.find(function (x) { return String(x.type || '').indexOf('image/') === 0; });
    return f || null;
  }

  function setScreenshot(dataUrl) {
    state.screenshotDataUrl = dataUrl || '';
    renderShotPreview();
  }

  function renderShotPreview() {
    var box = root.querySelector('[data-br-drop]');
    if (!box) return;
    var img = box.querySelector('img');
    var hint = box.querySelector('[data-br-drop-hint]');
    if (state.screenshotDataUrl) {
      if (!img) {
        img = document.createElement('img');
        img.alt = 'Screenshot';
        box.insertBefore(img, box.firstChild);
      }
      img.src = state.screenshotDataUrl;
      if (hint) hint.hidden = true;
    } else {
      if (img) img.remove();
      if (hint) hint.hidden = false;
    }
  }

  async function onPaste(ev) {
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var file = items[i].getAsFile();
        if (file) {
          ev.preventDefault();
          try {
            setScreenshot(await readImageFile(file));
            setStatus('Screenshot eingefügt.');
          } catch (e) {
            setStatus('Bild konnte nicht gelesen werden.', true);
          }
        }
        return;
      }
    }
    if (cfg.readClipboardImage) {
      try {
        var url = await cfg.readClipboardImage();
        if (url) {
          ev.preventDefault();
          setScreenshot(url);
          setStatus('Screenshot aus Zwischenablage.');
        }
      } catch (e2) { /* ignore */ }
    }
  }

  function bindDrop(zone) {
    if (!zone) return;
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('is-active');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('is-active');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-active');
      var file = firstImageFile(e.dataTransfer);
      if (!file) return;
      readImageFile(file).then(setScreenshot).catch(function () {
        setStatus('Bild konnte nicht gelesen werden.', true);
      });
    });
  }

  async function loadList() {
    var q = [];
    if (state.statusFilter === 'open' || state.statusFilter === 'done') q.push('status=' + state.statusFilter);
    if (state.kindFilter === 'bug' || state.kindFilter === 'wish') q.push('kind=' + state.kindFilter);
    var data = await apiFetch('list', { query: q.join('&') });
    state.reports = data.reports || [];
    if (typeof data.can_resolve === 'boolean') canResolve = data.can_resolve;
    if (data.actor_name) actorName = data.actor_name;
    var nameEl = root.querySelector('[data-br-actor]');
    if (nameEl) nameEl.value = actorName;
    renderList();
  }

  async function loadDetail(id) {
    var data = await apiFetch('get', { query: 'id=' + encodeURIComponent(id) });
    state.detail = data.report || null;
    if (typeof data.can_resolve === 'boolean') canResolve = data.can_resolve;
    renderList();
  }

  async function submitNew() {
    if (state.busy) return;
    var titleEl = root.querySelector('[data-br-title]');
    var bodyEl = root.querySelector('[data-br-body]');
    var title = titleEl ? String(titleEl.value || '').trim() : '';
    if (!title) {
      setStatus('Bitte einen Titel angeben.', true);
      if (titleEl) titleEl.focus();
      return;
    }
    state.busy = true;
    var live = window.KUKLA_BUG_REPORT || {};
    actorName = String(live.actor_name || actorName);
    appVersion = String(live.app_version || appVersion);
    canResolve = typeof live.can_resolve === 'boolean' ? live.can_resolve : canResolve;
    setStatus('Wird gesendet …');
    try {
      var payload = {
        kind: state.kind,
        title: title,
        body: bodyEl ? String(bodyEl.value || '').trim() : '',
        app_client: appClient,
        app_version: appVersion,
      };
      if (state.screenshotDataUrl) payload.screenshot_base64 = state.screenshotDataUrl;
      var data = await apiFetch('create', { method: 'POST', body: payload });
      if (titleEl) titleEl.value = '';
      if (bodyEl) bodyEl.value = '';
      setScreenshot('');
      setStatus((data.screenshot_error ? 'Gespeichert, Screenshot: ' + data.screenshot_error : 'Gespeichert.') + ' Die Liste ist aktuell.');
      state.pane = 'list';
      state.statusFilter = 'open';
      await loadList();
      render();
    } catch (e) {
      setStatus(e.message || 'Senden fehlgeschlagen.', true);
    } finally {
      state.busy = false;
    }
  }

  async function toggleDone(id, done) {
    if (!canResolve) return;
    try {
      await apiFetch('status', { method: 'POST', body: { id: id, status: done ? 'done' : 'open' } });
      await loadList();
      if (state.openId === id) await loadDetail(id);
    } catch (e) {
      setStatus(e.message || 'Status konnte nicht geändert werden.', true);
      renderList();
    }
  }

  async function submitComment(id) {
    var ta = root.querySelector('[data-br-comment-body]');
    var body = ta ? String(ta.value || '').trim() : '';
    if (!body) return;
    try {
      await apiFetch('comment', { method: 'POST', body: { report_id: id, body: body } });
      if (ta) ta.value = '';
      await loadDetail(id);
      await loadList();
    } catch (e) {
      setStatus(e.message || 'Kommentar fehlgeschlagen.', true);
    }
  }

  function renderNew() {
    var html = '';
    html += '<div class="bug-report-kind" role="group" aria-label="Art">';
    html += '<button type="button" data-br-kind="bug" aria-pressed="' + (state.kind === 'bug') + '">Bug</button>';
    html += '<button type="button" data-br-kind="wish" aria-pressed="' + (state.kind === 'wish') + '">Wunsch / Anregung</button>';
    html += '</div>';
    html += '<div class="bug-report-field"><label for="brTitle">' + (state.kind === 'wish' ? 'Kurztitel' : 'Welcher Bug') + '</label>';
    html += '<input id="brTitle" data-br-title maxlength="200" placeholder="' + (state.kind === 'wish' ? 'Worum geht es?' : 'Was geht schief?') + '"></div>';
    html += '<div class="bug-report-field"><label for="brBody">Kurze Beschreibung</label>';
    html += '<textarea id="brBody" data-br-body placeholder="Schritte, betroffene Stelle, erwartetes Verhalten"></textarea></div>';
    html += '<div class="bug-report-field"><label>Melder</label>';
    html += '<input data-br-actor readonly value="' + escapeHtml(actorName) + '"></div>';
    html += '<div class="bug-report-field"><label>Software-Version</label>';
    html += '<input data-br-version readonly value="' + escapeHtml(appVersion + (appVersion ? ' · ' : '') + clientLabel(appClient)) + '"></div>';
    html += '<div class="bug-report-field"><label>Screenshot</label>';
    html += '<div class="bug-report-drop" data-br-drop>';
    html += '<p class="bug-report-drop-hint" data-br-drop-hint>Bild einfügen (Strg+V), Datei wählen oder hierher ziehen</p>';
    html += '<div class="bug-report-row">';
    html += '<input type="file" accept="image/*" data-br-file title="Bild anhängen">';
    html += '<button type="button" class="btn" data-br-paste>Einfügen</button>';
    html += '<button type="button" class="btn" data-br-clear-shot>Bild entfernen</button>';
    html += '</div></div></div>';
    html += '<div class="bug-report-row"><button type="button" class="btn btn-primary" data-br-submit>Senden</button></div>';
    return html;
  }

  function renderComments(detail) {
    var comments = (detail && detail.comments) || [];
    var html = '<div class="bug-report-comments">';
    html += '<div class="bug-report-meta" style="margin-bottom:6px">Kommentare</div>';
    if (!comments.length) {
      html += '<p class="bug-report-empty">Noch keine Kommentare.</p>';
    }
    comments.forEach(function (c) {
      html += '<div class="bug-report-comment">';
      html += '<div class="bug-report-comment-meta">' + escapeHtml(c.author_name) + ' · ' + escapeHtml(formatDt(c.created_at)) + '</div>';
      html += '<div class="bug-report-comment-body">' + escapeHtml(c.body) + '</div>';
      html += '</div>';
    });
    html += '<div class="bug-report-field"><label>Neuer Kommentar (' + escapeHtml(actorName) + ')</label>';
    html += '<textarea data-br-comment-body rows="2" placeholder="Kommentar schreiben"></textarea></div>';
    html += '<button type="button" class="btn btn-primary" data-br-comment-send>Kommentar senden</button>';
    html += '</div>';
    return html;
  }

  function renderList() {
    var host = root.querySelector('[data-br-pane="list"]');
    if (!host) return;
    var html = '';
    html += '<div class="bug-report-filters">';
    ['open', 'done', 'all'].forEach(function (k) {
      var lab = k === 'open' ? 'Offen' : (k === 'done' ? 'Erledigt' : 'Alle');
      html += '<button type="button" class="bug-report-chip" data-br-status-filter="' + k + '" aria-pressed="' + (state.statusFilter === k) + '">' + lab + '</button>';
    });
    html += '<button type="button" class="bug-report-chip" data-br-kind-filter="all" aria-pressed="' + (state.kindFilter === 'all') + '">Bug + Wunsch</button>';
    html += '<button type="button" class="bug-report-chip" data-br-kind-filter="bug" aria-pressed="' + (state.kindFilter === 'bug') + '">Bug</button>';
    html += '<button type="button" class="bug-report-chip" data-br-kind-filter="wish" aria-pressed="' + (state.kindFilter === 'wish') + '">Wunsch</button>';
    html += '</div>';
    if (!state.reports.length) {
      html += '<p class="bug-report-empty">Keine Einträge.</p>';
      host.innerHTML = html;
      return;
    }
    state.reports.forEach(function (r) {
      var open = state.openId === r.id;
      var detail = open ? state.detail : null;
      html += '<article class="bug-report-card' + (r.status === 'done' ? ' is-done' : '') + '" data-br-card="' + escapeHtml(r.id) + '">';
      html += '<div class="bug-report-card-top">';
      html += '<input type="checkbox" data-br-done="' + escapeHtml(r.id) + '"' + (r.status === 'done' ? ' checked' : '') + (canResolve ? '' : ' disabled') + ' title="' + (canResolve ? 'Erledigt' : 'Nur Admin / Alois Riedl') + '">';
      html += '<div style="flex:1;min-width:0">';
      html += '<h2>' + escapeHtml(r.title) + '</h2>';
      html += '<div class="bug-report-meta">' + escapeHtml(kindLabel(r.kind)) + ' · ' + escapeHtml(r.reporter_name) + ' · ' + escapeHtml(formatDt(r.created_at));
      html += ' · ' + escapeHtml(r.app_version || '–') + ' · ' + escapeHtml(clientLabel(r.app_client));
      if (r.comment_count) html += ' · ' + r.comment_count + ' Kommentar' + (r.comment_count === 1 ? '' : 'e');
      html += '</div>';
      if (open) {
        if (detail && detail.body) html += '<div class="bug-report-body">' + escapeHtml(detail.body) + '</div>';
        else if (r.body) html += '<div class="bug-report-body">' + escapeHtml(r.body) + '</div>';
        if (detail && detail.has_screenshot) {
          html += '<img class="bug-report-shot" alt="Screenshot" src="' + escapeHtml(screenshotUrl(r.id)) + '">';
        } else if (r.has_screenshot) {
          html += '<img class="bug-report-shot" alt="Screenshot" src="' + escapeHtml(screenshotUrl(r.id)) + '">';
        }
        html += renderComments(detail || { comments: [] });
      } else {
        html += '<button type="button" class="btn" data-br-open="' + escapeHtml(r.id) + '" style="margin-top:6px">Details / Kommentare</button>';
      }
      html += '</div></div></article>';
    });
    host.innerHTML = html;
  }

  function render() {
    var newPane = root.querySelector('[data-br-pane="new"]');
    var listPane = root.querySelector('[data-br-pane="list"]');
    root.querySelectorAll('[data-br-pane-tab]').forEach(function (btn) {
      btn.setAttribute('aria-selected', btn.getAttribute('data-br-pane-tab') === state.pane ? 'true' : 'false');
    });
    if (newPane) {
      newPane.hidden = state.pane !== 'new';
      if (state.pane === 'new' && !newPane.dataset.ready) {
        newPane.innerHTML = renderNew();
        newPane.dataset.ready = '1';
        bindDrop(newPane.querySelector('[data-br-drop]'));
      }
      var kindBtns = newPane.querySelectorAll('[data-br-kind]');
      kindBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-br-kind') === state.kind ? 'true' : 'false');
      });
      var titleLab = newPane.querySelector('label[for="brTitle"]');
      if (titleLab) titleLab.textContent = state.kind === 'wish' ? 'Kurztitel' : 'Welcher Bug';
    }
    if (listPane) {
      listPane.hidden = state.pane !== 'list';
      if (state.pane === 'list') renderList();
    }
    var pinBtn = root.querySelector('[data-br-pin]');
    if (pinBtn) pinBtn.setAttribute('aria-pressed', state.pin ? 'true' : 'false');
  }

  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var paneTab = t.closest('[data-br-pane-tab]');
    if (paneTab) {
      state.pane = paneTab.getAttribute('data-br-pane-tab') || 'new';
      if (state.pane === 'list') loadList().catch(function (err) { setStatus(err.message, true); });
      render();
      return;
    }
    var kindBtn = t.closest('[data-br-kind]');
    if (kindBtn) {
      state.kind = kindBtn.getAttribute('data-br-kind') === 'wish' ? 'wish' : 'bug';
      render();
      return;
    }
    if (t.closest('[data-br-submit]')) {
      submitNew();
      return;
    }
    if (t.closest('[data-br-clear-shot]')) {
      setScreenshot('');
      return;
    }
    if (t.closest('[data-br-paste]')) {
      if (cfg.readClipboardImage) {
        cfg.readClipboardImage().then(function (url) {
          if (url) setScreenshot(url);
          else setStatus('Kein Bild in der Zwischenablage. Strg+V im Fenster nutzen.', true);
        }).catch(function () {
          setStatus('Zwischenablage nicht lesbar. Strg+V im Fenster nutzen.', true);
        });
      } else {
        setStatus('Bitte Strg+V im Fenster nutzen.');
      }
      return;
    }
    var stf = t.closest('[data-br-status-filter]');
    if (stf) {
      state.statusFilter = stf.getAttribute('data-br-status-filter') || 'open';
      loadList().catch(function (err) { setStatus(err.message, true); });
      return;
    }
    var kf = t.closest('[data-br-kind-filter]');
    if (kf) {
      state.kindFilter = kf.getAttribute('data-br-kind-filter') || 'all';
      loadList().catch(function (err) { setStatus(err.message, true); });
      return;
    }
    var openBtn = t.closest('[data-br-open]');
    if (openBtn) {
      state.openId = openBtn.getAttribute('data-br-open');
      loadDetail(state.openId).catch(function (err) { setStatus(err.message, true); });
      return;
    }
    var sendC = t.closest('[data-br-comment-send]');
    if (sendC && state.openId) {
      submitComment(state.openId);
      return;
    }
    var popupBtn = t.closest('[data-br-popup]');
    if (popupBtn && cfg.popupUrl) {
      window.open(cfg.popupUrl, 'kukla-bugreport', 'width=480,height=720,resizable=yes,scrollbars=yes');
      return;
    }
    var pinBtn = t.closest('[data-br-pin]');
    if (pinBtn && typeof cfg.setAlwaysOnTop === 'function') {
      state.pin = !state.pin;
      cfg.setAlwaysOnTop(state.pin);
      render();
    }
  });

  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-br-file]')) {
      var file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      readImageFile(file).then(setScreenshot).catch(function () {
        setStatus('Bild konnte nicht gelesen werden.', true);
      });
    }
    if (t && t.matches && t.matches('[data-br-done]')) {
      toggleDone(t.getAttribute('data-br-done'), !!t.checked);
    }
  });

  document.addEventListener('paste', function (e) {
    if (!root.contains(document.activeElement) && document.activeElement !== document.body) {
      if (!root.matches(':hover')) return;
    }
    onPaste(e);
  });

  document.addEventListener('dispo-push', function (ev) {
    var d = ev && ev.detail;
    if (!d || d.channel !== 'bug_report_new') return;
    if (state.pane === 'list') {
      loadList().catch(function () {});
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.pane === 'list') {
      loadList().catch(function () {});
    }
  });

  render();
  if (state.pane === 'list') {
    loadList().catch(function (err) { setStatus(err.message, true); });
  }
})();
