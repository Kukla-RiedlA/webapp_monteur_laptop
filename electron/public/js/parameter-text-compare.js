/**
 * Zeilenvergleich analog Notepad++ Compare (Browser).
 * Trennstriche ohne alphanumerischen Inhalt gelten als gleich.
 */
(function (root) {
  'use strict';

  function isLinePlaceholder(value) {
    var s = String(value || '').trim();
    if (s.length < 3) return false;
    return s.replace(/[^0-9A-Za-zÄÖÜäöüß]/g, '') === '';
  }

  function splitParameterTextLines(text) {
    return String(text || '').split(/\r\n|\n|\r/);
  }

  function normalizeParameterLineForDiff(line) {
    var s = String(line == null ? '' : line).replace(/[ \t]+$/g, '');
    if (isLinePlaceholder(s)) return '\u0001PH';
    return s;
  }

  function tokenizeParamLine(line) {
    return String(line == null ? '' : line).split(/(\s+|;)/).filter(function (t) { return t !== ''; });
  }

  function inlineDiffParts(left, right) {
    var a = String(left == null ? '' : left);
    var b = String(right == null ? '' : right);
    if (a === b) {
      return { left: [{ text: a, changed: false }], right: [{ text: b, changed: false }] };
    }
    var ta = tokenizeParamLine(a);
    var tb = tokenizeParamLine(b);
    var n = ta.length;
    var m = tb.length;
    if (!n && !m) {
      return { left: [{ text: '', changed: false }], right: [{ text: '', changed: false }] };
    }
    var dp = [];
    var i;
    var j;
    for (i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        dp[i][j] = ta[i - 1] === tb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var aMarks = new Array(n).fill(true);
    var bMarks = new Array(m).fill(true);
    i = n;
    j = m;
    while (i > 0 && j > 0) {
      if (ta[i - 1] === tb[j - 1]) {
        aMarks[i - 1] = false;
        bMarks[j - 1] = false;
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i -= 1;
      else j -= 1;
    }
    function partsFrom(tokens, marks) {
      var parts = [];
      var buf = '';
      var chg = false;
      var k;
      for (k = 0; k < tokens.length; k++) {
        var c = !!marks[k];
        if (k === 0) {
          chg = c;
          buf = tokens[k];
          continue;
        }
        if (c === chg) buf += tokens[k];
        else {
          parts.push({ text: buf, changed: chg });
          buf = tokens[k];
          chg = c;
        }
      }
      if (buf || tokens.length === 0) parts.push({ text: buf, changed: chg });
      return parts.length ? parts : [{ text: '', changed: false }];
    }
    return { left: partsFrom(ta, aMarks), right: partsFrom(tb, bMarks) };
  }

  function lcsLineOps(aNorm, bNorm) {
    var n = aNorm.length;
    var m = bNorm.length;
    var dp = [];
    var i;
    var j;
    for (i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        dp[i][j] = aNorm[i - 1] === bNorm[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var ops = [];
    i = n;
    j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && aNorm[i - 1] === bNorm[j - 1]) {
        ops.push({ op: 'eq', li: i - 1, ri: j - 1 });
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push({ op: 'ins', li: -1, ri: j - 1 });
        j -= 1;
      } else {
        ops.push({ op: 'del', li: i - 1, ri: -1 });
        i -= 1;
      }
    }
    ops.reverse();
    return ops;
  }

  function compareParameterTextLines(leftText, rightText) {
    var left = splitParameterTextLines(leftText);
    var right = splitParameterTextLines(rightText);
    var lN = left.map(normalizeParameterLineForDiff);
    var rN = right.map(normalizeParameterLineForDiff);
    var ops = lcsLineOps(lN, rN);
    var rows = [];
    var summary = { changed: 0, added: 0, removed: 0, equal: 0 };
    var k;
    for (k = 0; k < ops.length; k++) {
      var cur = ops[k];
      var next = ops[k + 1];
      if (cur.op === 'del' && next && next.op === 'ins') {
        var lt = left[cur.li] || '';
        var rt = right[next.ri] || '';
        var type = (isLinePlaceholder(lt) && isLinePlaceholder(rt)) ||
          normalizeParameterLineForDiff(lt) === normalizeParameterLineForDiff(rt)
          ? 'equal'
          : 'changed';
        var inline = type === 'changed' ? inlineDiffParts(lt, rt) : null;
        rows.push({
          type: type,
          left_line_no: cur.li + 1,
          right_line_no: next.ri + 1,
          left_text: lt,
          right_text: rt,
          left_parts: inline ? inline.left : [{ text: lt, changed: false }],
          right_parts: inline ? inline.right : [{ text: rt, changed: false }],
        });
        if (type === 'changed') summary.changed += 1;
        else summary.equal += 1;
        k += 1;
        continue;
      }
      if (cur.op === 'eq') {
        rows.push({
          type: 'equal',
          left_line_no: cur.li + 1,
          right_line_no: cur.ri + 1,
          left_text: left[cur.li] || '',
          right_text: right[cur.ri] || '',
          left_parts: [{ text: left[cur.li] || '', changed: false }],
          right_parts: [{ text: right[cur.ri] || '', changed: false }],
        });
        summary.equal += 1;
        continue;
      }
      if (cur.op === 'del') {
        lt = left[cur.li] || '';
        if (isLinePlaceholder(lt)) {
          rows.push({
            type: 'equal',
            left_line_no: cur.li + 1,
            right_line_no: null,
            left_text: lt,
            right_text: '',
            left_parts: [{ text: lt, changed: false }],
            right_parts: [{ text: '', changed: false }],
          });
          summary.equal += 1;
          continue;
        }
        rows.push({
          type: 'removed',
          left_line_no: cur.li + 1,
          right_line_no: null,
          left_text: lt,
          right_text: '',
          left_parts: [{ text: lt, changed: true }],
          right_parts: [{ text: '', changed: false }],
        });
        summary.removed += 1;
        continue;
      }
      rt = right[cur.ri] || '';
      if (isLinePlaceholder(rt)) {
        rows.push({
          type: 'equal',
          left_line_no: null,
          right_line_no: cur.ri + 1,
          left_text: '',
          right_text: rt,
          left_parts: [{ text: '', changed: false }],
          right_parts: [{ text: rt, changed: false }],
        });
        summary.equal += 1;
        continue;
      }
      rows.push({
        type: 'added',
        left_line_no: null,
        right_line_no: cur.ri + 1,
        left_text: '',
        right_text: rt,
        left_parts: [{ text: '', changed: false }],
        right_parts: [{ text: rt, changed: true }],
      });
      summary.added += 1;
    }
    return { rows: rows, summary: summary };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderParts(parts, fallbackText) {
    var list = Array.isArray(parts) ? parts : [];
    if (!list.length) return esc(fallbackText != null ? String(fallbackText) : '');
    return list.map(function (p) {
      var t = esc(p && p.text != null ? String(p.text) : '');
      if (p && p.changed) return '<span class="param-npp-inline">' + t + '</span>';
      return t;
    }).join('');
  }

  function renderCompareHtml(diff, fromName, toName) {
    var rows = (diff && Array.isArray(diff.rows)) ? diff.rows : ((diff && diff.line_rows) || []);
    var sum = (diff && diff.summary) || {};
    var html = '<p class="param-npp-summary">' + esc(fromName || '') + ' → ' + esc(toName || '') +
      ' · geändert ' + (sum.changed || 0) +
      ', neu ' + (sum.added || 0) +
      ', entfernt ' + (sum.removed || 0) + '</p>';
    html += '<div class="param-npp-toolbar"><label><input type="checkbox" data-pl-npp-only-diff> Nur Unterschiede</label></div>';
    html += '<div class="param-npp-wrap">';
    html += '<div class="param-npp-head"><span>' + esc(fromName || 'älter') + '</span><span>' + esc(toName || 'neuer') + '</span></div>';
    rows.forEach(function (row) {
      var t = row && row.type ? String(row.type) : 'equal';
      html += '<div class="param-npp-row param-npp-' + esc(t) + '">';
      html += '<div class="param-npp-pane param-npp-left"><span class="param-npp-ln">' +
        (row.left_line_no ? String(row.left_line_no) : '') + '</span><pre class="param-npp-text">' +
        renderParts(row.left_parts, row.left_text) + '</pre></div>';
      html += '<div class="param-npp-pane param-npp-right"><span class="param-npp-ln">' +
        (row.right_line_no ? String(row.right_line_no) : '') + '</span><pre class="param-npp-text">' +
        renderParts(row.right_parts, row.right_text) + '</pre></div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function bindOnlyDiff(root) {
    var wrap = root && root.querySelector ? root.querySelector('.param-npp-wrap') : null;
    var cb = root && root.querySelector ? root.querySelector('[data-pl-npp-only-diff]') : null;
    if (!wrap || !cb) return;
    cb.onchange = function () {
      wrap.classList.toggle('is-only-diff', !!cb.checked);
    };
  }

  root.KuklaParameterTextCompare = {
    isLinePlaceholder: isLinePlaceholder,
    compareParameterTextLines: compareParameterTextLines,
    renderCompareHtml: renderCompareHtml,
    bindOnlyDiff: bindOnlyDiff,
  };
})(typeof window !== 'undefined' ? window : this);
