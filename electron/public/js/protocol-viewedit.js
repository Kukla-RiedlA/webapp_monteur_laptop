/**
 * KUKpit-Protokolle: Stift zeigt nur gefüllte Werte, Haken übernimmt, Kreuz verwirft.
 */
(function () {
  'use strict';

  var VIEWS = [
    'viewProtokolleArbeitsnachweis',
    'viewProtokolleMontagebericht',
    'viewProtokolleKontrollwiegungen',
    'viewProtokolleSchleppketten',
    'viewProtokollePruefzertifikat'
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function skipSection(section) {
    if (section.getAttribute('data-ve-skip') === '1') return true;
    var head = section.querySelector('.sp-v2-section-head');
    var t = String(head && head.textContent || '').toLowerCase();
    return /speichern|export|dateien|upload/.test(t);
  }

  function fieldText(el) {
    if (!el || el.disabled) return '';
    if (el.type === 'hidden' || el.type === 'file' || el.type === 'button' || el.type === 'submit') return '';
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (!el.checked) return '';
      if (el.type === 'radio') {
        var lab = el.closest('label');
        return lab ? String(lab.textContent || '').trim() : String(el.value || '');
      }
      return 'ja';
    }
    if (el.tagName === 'SELECT') {
      var opt = el.options[el.selectedIndex];
      var txt = opt ? String(opt.textContent || '').trim() : '';
      if (!String(el.value || '').trim() || /bitte wählen|please select/i.test(txt)) return '';
      return txt;
    }
    return String(el.value || '').trim();
  }

  function labelFor(el) {
    if (el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return String(lab.textContent || '').replace(/\s+/g, ' ').trim();
    }
    var wrap = el.closest('.sp-v2-field, label');
    if (wrap) {
      var l = wrap.querySelector('label');
      if (l && l !== wrap) return String(l.textContent || '').replace(/\s+/g, ' ').trim();
      if (wrap.tagName === 'LABEL' && el.type === 'checkbox') {
        return String(wrap.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    return el.getAttribute('aria-label') || el.name || '';
  }

  function isFlag(el) {
    return !el || el.name === 'in_summe' || el.name === 'in_pdf' || el.classList.contains('kw-in-pdf') || el.classList.contains('proto-print-cb') || el.type === 'hidden' || el.type === 'file' || el.type === 'button' || el.type === 'submit';
  }

  function isActionHeader(th) {
    var t = String(th.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    return t.length < 36 && /×|löschen|delete/i.test(t);
  }

  function tdValue(td) {
    if (!td) return '';
    var el = td.querySelector('input, select, textarea');
    if (!el) {
      var tx = String(td.textContent || '').replace(/\s+/g, ' ').trim();
      return tx === '–' || tx === '-' ? '' : tx;
    }
    if (isFlag(el)) return '';
    return fieldText(el);
  }

  function tableHtml(headers, rows, footer) {
    if (!rows.length) return '';
    var html = '<div class="proto-ve-scroll"><table class="proto-ve-table"><thead><tr>';
    headers.forEach(function (c) { html += '<th>' + esc(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>';
      r.forEach(function (c) { html += '<td>' + esc(c) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody>';
    if (footer && footer.some(function (c) { return String(c || '').trim(); })) {
      html += '<tfoot><tr>';
      footer.forEach(function (c) { html += '<td>' + esc(c) + '</td>'; });
      html += '</tr></tfoot>';
    }
    html += '</table></div>';
    return html;
  }

  function render(section) {
    var view = section.querySelector('[data-proto-view]');
    var body = section.querySelector('.sp-v2-section-body');
    if (!view || !body) return;
    var parts = [];
    var labs = [];
    var vals = [];
    var seen = {};
    body.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (el.closest('table') || el.closest('.sp-v2-fab-block') || el.closest('.an-fab-list') || el.closest('.sp-fab-chip') || isFlag(el)) return;
      var val = fieldText(el);
      if (!val) return;
      var lab = labelFor(el) || '';
      var key = lab + '\n' + val;
      if (seen[key]) return;
      seen[key] = 1;
      labs.push(lab);
      vals.push(val);
    });
    if (vals.length) parts.push(tableHtml(labs, [vals]));

    body.querySelectorAll('table').forEach(function (table) {
      var ths = Array.prototype.slice.call(table.querySelectorAll('thead th'));
      var keep = ths.map(function (th, i) {
        return { i: i, label: String(th.textContent || '').replace(/\s+/g, ' ').trim(), action: isActionHeader(th) };
      }).filter(function (c) { return !c.action; });
      if (!keep.length) return;
      var rows = [];
      table.querySelectorAll('tbody tr').forEach(function (tr) {
        var tds = Array.prototype.slice.call(tr.children);
        var row = keep.map(function (c) { return tdValue(tds[c.i]); });
        if (row.some(function (v) { return String(v || '').trim(); })) rows.push(row);
      });
      if (!rows.length) return;
      var footer = null;
      var ftr = table.querySelector('tfoot tr');
      if (ftr) {
        var flat = [];
        Array.prototype.slice.call(ftr.children).forEach(function (td) {
          var span = parseInt(td.getAttribute('colspan') || '1', 10) || 1;
          var text = String(td.textContent || '').replace(/\s+/g, ' ').trim();
          flat.push(text === '–' || text === '-' ? '' : text);
          for (var s = 1; s < span; s++) flat.push('');
        });
        footer = keep.map(function (c) { return flat[c.i] || ''; });
      }
      var caption = '';
      var wrap = table.closest('.sk-mess-table-wrap, .kw-wiegung-table-wrap, .an-table-wrap');
      var node = wrap ? wrap.previousElementSibling : table.previousElementSibling;
      while (node && node.classList && !node.classList.contains('sk-subhead')) node = node.previousElementSibling;
      if (node && node.classList && node.classList.contains('sk-subhead')) {
        caption = '<h3 class="sk-subhead">' + esc(String(node.textContent || '').replace(/\s+/g, ' ').trim()) + '</h3>';
      }
      parts.push(caption + tableHtml(keep.map(function (c) { return c.label; }), rows, footer));
    });

    view.innerHTML = parts.length
      ? parts.join('')
      : '<p class="proto-ve-empty">Stift zum Erfassen</p>';
  }

  function snapshot(section) {
    var data = [];
    section.querySelectorAll('.sp-v2-section-body input, .sp-v2-section-body select, .sp-v2-section-body textarea').forEach(function (el) {
      data.push({
        el: el,
        value: el.value,
        checked: !!el.checked
      });
    });
    section._protoSnap = data;
  }

  function restore(section) {
    (section._protoSnap || []).forEach(function (row) {
      if (!row.el) return;
      if (row.el.type === 'checkbox' || row.el.type === 'radio') row.el.checked = row.checked;
      else row.el.value = row.value;
      row.el.dispatchEvent(new Event('input', { bubbles: true }));
      row.el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function penSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="#0e7b5a" stroke-width="2" d="M4 20h4l10-10-4-4L4 16v4z"/><path fill="none" stroke="#0e7b5a" stroke-width="2" d="M13 6l4 4"/></svg>';
  }

  function bind(section) {
    if (section.getAttribute('data-proto-ve') === '1' || skipSection(section)) return;
    var body = section.querySelector('.sp-v2-section-body');
    var head = section.querySelector('.sp-v2-section-head');
    if (!body || !head) return;
    section.setAttribute('data-proto-ve', '1');
    section.classList.add('proto-ve');
    var view = document.createElement('div');
    view.className = 'proto-ve-view';
    view.setAttribute('data-proto-view', '1');
    section.insertBefore(view, body);
    var actions = document.createElement('span');
    actions.className = 'proto-ve-actions';
    actions.innerHTML =
      '<button type="button" class="proto-ve-btn" data-proto-apply title="Übernehmen" aria-label="Übernehmen">✓</button>' +
      '<button type="button" class="proto-ve-btn" data-proto-cancel title="Verwerfen" aria-label="Verwerfen">×</button>';
    var pen = document.createElement('button');
    pen.type = 'button';
    pen.className = 'proto-ve-pen';
    pen.title = 'Stift zum Ändern';
    pen.setAttribute('aria-label', 'Stift zum Ändern');
    pen.innerHTML = penSvg();
    head.appendChild(pen);
    head.appendChild(actions);
    pen.addEventListener('click', function (e) {
      e.preventDefault();
      snapshot(section);
      section.classList.add('is-editing');
    });
    actions.querySelector('[data-proto-apply]').addEventListener('click', function (e) {
      e.preventDefault();
      render(section);
      section.classList.remove('is-editing');
    });
    actions.querySelector('[data-proto-cancel]').addEventListener('click', function (e) {
      e.preventDefault();
      restore(section);
      render(section);
      section.classList.remove('is-editing');
    });
    render(section);
    section.addEventListener('input', function () {
      if (!section.classList.contains('is-editing')) render(section);
    });
    section.addEventListener('change', function () {
      if (!section.classList.contains('is-editing')) render(section);
    });
    section._protoFp = fingerprint(section);
  }

  function fingerprint(section) {
    var parts = [];
    section.querySelectorAll('.sp-v2-section-body input, .sp-v2-section-body select, .sp-v2-section-body textarea').forEach(function (el) {
      parts.push(String(el.value || '') + (el.checked ? '1' : '0'));
    });
    return parts.join('\u0001');
  }

  function refreshOpenViews() {
    VIEWS.forEach(function (id) {
      var root = document.getElementById(id);
      if (!root) return;
      root.querySelectorAll('.sp-v2-section').forEach(function (section) {
        if (!section.getAttribute('data-proto-ve')) {
          bind(section);
          return;
        }
        if (section.classList.contains('is-editing')) return;
        var fp = fingerprint(section);
        if (section._protoFp === fp) return;
        section._protoFp = fp;
        render(section);
      });
    });
  }

  function init() {
    VIEWS.forEach(function (id) {
      var root = document.getElementById(id);
      if (!root) return;
      root.querySelectorAll('.sp-v2-section').forEach(bind);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  setInterval(refreshOpenViews, 400);
})();
