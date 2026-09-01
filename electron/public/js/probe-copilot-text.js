/**
 * Copilot-Probe V1: Button „Text prüfen“ am Montagebericht-Feld Bemerkungen.
 * Sichtbar nur bei KUKLA_COPILOT_PROBE=1 (Main-Prozess).
 */
(function () {
  'use strict';

  var btn = document.getElementById('btnCopilotCheckText');
  var editor = document.getElementById('montageberichtBemerkungen');
  if (!btn || !editor) return;
  var api = window.monteurApp;
  if (!api || typeof api.copilotStatus !== 'function' || typeof api.copilotCheckText !== 'function') {
    return;
  }

  function editorPlain() {
    return String(editor.innerText || '').replace(/\u00a0/g, ' ').trim();
  }

  function applyPlain(text) {
    var escaped = String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    var lines = escaped.split(/\r?\n/);
    var html = lines.map(function (line) {
      return '<p>' + (line || '<br>') + '</p>';
    }).join('');
    editor.innerHTML = html;
    try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* ignore */ }
  }

  function closeOverlay(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function showModal(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay anlage-detail-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.zIndex = '10070';

    var box = document.createElement('div');
    box.className = 'modal-box mb-copilot-modal-box';
    box.style.maxWidth = '40rem';

    var title = document.createElement('h3');
    title.textContent = opts.title || 'Text prüfen';
    box.appendChild(title);

    var body;
    if (opts.editable) {
      body = document.createElement('textarea');
      body.className = 'mb-copilot-suggest';
      body.value = opts.message || '';
      body.setAttribute('aria-label', 'Vorschlag');
    } else {
      body = document.createElement('p');
      body.style.margin = '0.5rem 0 1rem';
      body.style.lineHeight = '1.45';
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = opts.message || '';
    }
    box.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    if (opts.editable) {
      var btnApply = document.createElement('button');
      btnApply.type = 'button';
      btnApply.className = 'btn btn-primary';
      btnApply.textContent = 'Übernehmen';
      btnApply.addEventListener('click', function () {
        applyPlain(body.value);
        closeOverlay(overlay);
      });
      var btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.className = 'btn btn-ghost';
      btnCancel.textContent = 'Abbrechen';
      btnCancel.addEventListener('click', function () { closeOverlay(overlay); });
      actions.appendChild(btnApply);
      actions.appendChild(btnCancel);
    } else {
      var btnClose = document.createElement('button');
      btnClose.type = 'button';
      btnClose.className = 'btn btn-primary';
      btnClose.textContent = 'Schließen';
      btnClose.addEventListener('click', function () { closeOverlay(overlay); });
      actions.appendChild(btnClose);
    }

    box.appendChild(actions);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeOverlay(overlay);
    });
    document.body.appendChild(overlay);
    if (opts.editable && body.focus) body.focus();
  }

  function setBusy(busy) {
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Prüfe…' : 'Text prüfen';
  }

  api.copilotStatus().then(function (st) {
    if (st && st.ok && st.enabled) {
      btn.hidden = false;
    }
  }).catch(function () { /* Probe bleibt unsichtbar */ });

  btn.addEventListener('click', function () {
    if (btn.disabled) return;
    var text = editorPlain();
    if (!text) {
      showModal({
        title: 'Text prüfen',
        message: 'Bitte zuerst einen Text in Bemerkungen eingeben.',
      });
      return;
    }
    setBusy(true);
    api.copilotCheckText(text).then(function (res) {
      setBusy(false);
      if (res && res.ok && res.text) {
        showModal({
          title: 'Vorschlag',
          message: res.text,
          editable: true,
        });
        return;
      }
      showModal({
        title: 'Text prüfen',
        message: (res && res.error) ? String(res.error) : 'Copilot-Prüfung ist fehlgeschlagen.',
      });
    }).catch(function (err) {
      setBusy(false);
      showModal({
        title: 'Text prüfen',
        message: (err && err.message) ? String(err.message) : 'Copilot-Prüfung ist fehlgeschlagen.',
      });
    });
  });
})();
