(function (factory) {
  'use strict';

  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.install();
})(function () {
  'use strict';

  var PALETTE = ['#0e7b5a', '#1d4e89', '#c2410c', '#6d28d9', '#b45309', '#0f766e', '#be123c', '#0369a1', '#3f6212', '#7c3aed'];
  var ROW_H = 28;
  var MAX_ROWS = 250000;
  var RULER_RED = '#b42318';
  var RULER_BLUE = '#1d4e89';

  var I18N = {
    de: {
      title: 'CSV-Log',
      sub: 'Kurven aus Logdateien',
      folder: 'Ordner …',
      files: 'Dateien …',
      auto: 'Auto-Skalierung',
      zin: 'Zoom +',
      zout: 'Zoom −',
      left: '« Rückwärts',
      right: 'Vorwärts »',
      r1: 'Lineal 1',
      r2: 'Lineal 2',
      print: 'Drucken',
      ready: 'Bereit',
      delta: 'Zeitabstand ΔX',
      noCsv: 'Keine CSV-Dateien gefunden.',
      noValid: 'Keine gültigen CSV-Dateien.',
      noNum: 'Keine numerischen Spalten gefunden.',
      empty: 'Ordner oder CSV-Dateien wählen.',
      noX: 'Zeit- oder X-Spalte nicht lesbar.',
      noneOn: 'Keine Kurve ausgewählt. Legende anklicken.',
      rows: 'Zeilen',
      fileOne: 'Datei',
      fileMany: 'Dateien',
      lang: 'EN',
      printFail: 'Druckfenster blockiert.',
      printed: 'Druckansicht geöffnet.',
      rulerOn: 'aktiv – auf die Kurve klicken oder ziehen.',
      truncated: 'Anzeige auf 250000 Zeilen begrenzt.',
      nested: 'Unterordner mitgelesen.',
      reading: 'Lese Dateien …'
    },
    en: {
      title: 'CSV log',
      sub: 'Curves from log files',
      folder: 'Folder …',
      files: 'Files …',
      auto: 'Auto scale',
      zin: 'Zoom +',
      zout: 'Zoom −',
      left: '« Backward',
      right: 'Forward »',
      r1: 'Ruler 1',
      r2: 'Ruler 2',
      print: 'Print',
      ready: 'Ready',
      delta: 'Time diff ΔX',
      noCsv: 'No CSV files found.',
      noValid: 'No valid CSV files.',
      noNum: 'No numeric columns found.',
      empty: 'Choose a folder or CSV files.',
      noX: 'Time or X column could not be read.',
      noneOn: 'No curve selected. Click the legend.',
      rows: 'rows',
      fileOne: 'file',
      fileMany: 'files',
      lang: 'DE',
      printFail: 'Print window was blocked.',
      printed: 'Print view opened.',
      rulerOn: 'active – click or drag on the curve.',
      truncated: 'Display limited to 250000 rows.',
      nested: 'Subfolders included.',
      reading: 'Reading files …'
    }
  };

  var state = {
    lang: 'de',
    headers: [],
    rows: [],
    xs: [],
    nFinite: 0,
    series: [],
    xIsTime: false,
    xLabel: '',
    fileLabel: '',
    x0: 0,
    x1: 1,
    rulerMode: 0,
    ruler: [null, null],
    selected: -1,
    hover: -1,
    layout: null,
    bound: false,
    drag: null
  };

  var plotCanvas = null;
  var redrawQueued = false;

  function t(key) {
    var pack = I18N[state.lang] || I18N.de;
    return pack[key] != null ? pack[key] : key;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function headerKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function isUnnamed(value) {
    var key = headerKey(value);
    return !key || key.indexOf('unnamed') === 0;
  }

  function detectDelimiter(text) {
    var lines = String(text || '').split(/\r?\n/);
    var line = '';
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i]).trim() !== '') {
        line = lines[i];
        break;
      }
    }
    var counts = { ';': 0, ',': 0, '\t': 0 };
    var inQ = false;
    for (var c = 0; c < line.length; c++) {
      var ch = line.charAt(c);
      if (ch === '"') {
        if (inQ && line.charAt(c + 1) === '"') c++;
        else inQ = !inQ;
      } else if (!inQ && counts[ch] != null) counts[ch]++;
    }
    if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
    if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t';
    return ',';
  }

  function parseCsv(text, delimiter) {
    var rows = [];
    var row = [];
    var cur = '';
    var inQ = false;
    var src = String(text || '');
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delimiter) {
        row.push(cur);
        cur = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src.charAt(i + 1) === '\n') i++;
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else cur += ch;
    }
    if (cur.length || row.length) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  function parseNumber(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || s === '-' || s === '—') return null;
    var hasC = s.indexOf(',') >= 0;
    var hasD = s.indexOf('.') >= 0;
    if (hasC && hasD) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasC) s = s.replace(',', '.');
    if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function parseStamp(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m && (m[4] != null || s.length <= 10)) {
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return null;
  }

  function looksLikeHeader(row) {
    for (var i = 0; i < row.length; i++) {
      if (/[A-Za-zÄÖÜäöüß]/.test(String(row[i] || ''))) return true;
    }
    return false;
  }

  function parseFile(text) {
    var delim = detectDelimiter(text);
    var grid = parseCsv(text, delim).filter(function (row) {
      return row.some(function (cell) { return String(cell).trim() !== ''; });
    });
    if (!grid.length) return null;
    var headerRow = looksLikeHeader(grid[0]) ? grid.shift().slice() : null;
    var colCount = headerRow ? headerRow.length : 0;
    grid.forEach(function (row) {
      if (row.length > colCount) colCount = row.length;
    });
    var headers = [];
    var used = {};
    for (var i = 0; i < colCount; i++) {
      var name = headerRow ? String(headerRow[i] || '').trim() : ('Spalte ' + (i + 1));
      if (isUnnamed(name)) {
        headers.push(null);
        continue;
      }
      if (!name) name = 'Spalte ' + (i + 1);
      var unique = name;
      var n = 2;
      while (used[unique.toLowerCase()]) {
        unique = name + ' ' + n;
        n++;
      }
      used[unique.toLowerCase()] = 1;
      headers.push(unique);
    }
    return { headers: headers, records: grid };
  }

  function findCol(keys, names) {
    for (var i = 0; i < keys.length; i++) {
      if (names[keys[i]]) return i;
    }
    return -1;
  }

  function numericScore(rows, col) {
    var non = 0;
    var num = 0;
    for (var i = 0; i < rows.length; i++) {
      var raw = rows[i].cells[col];
      if (String(raw || '').trim() === '') continue;
      non++;
      if (parseNumber(raw) != null) num++;
    }
    return { non: non, num: num };
  }

  function isNumericCol(rows, col) {
    var score = numericScore(rows, col);
    return score.num >= 1 && score.num / score.non >= 0.5;
  }

  function buildDataset(fileTexts) {
    var parsed = [];
    var skipped = 0;
    (fileTexts || []).forEach(function (file) {
      try {
        var one = parseFile(file && file.text);
        if (!one) skipped++;
        else parsed.push(one);
      } catch (e) {
        skipped++;
      }
    });
    if (!parsed.length) return { ok: false, error: 'novalid', skipped: skipped };

    var headers = [];
    var headerPos = {};
    parsed.forEach(function (file) {
      file.headers.forEach(function (name) {
        if (!name) return;
        var key = name.toLowerCase();
        if (headerPos[key] == null) {
          headerPos[key] = headers.length;
          headers.push(name);
        }
      });
    });
    if (!headers.length) return { ok: false, error: 'novalid', skipped: skipped };

    var rows = [];
    var truncated = false;
    for (var f = 0; f < parsed.length && !truncated; f++) {
      var file = parsed[f];
      var map = file.headers.map(function (name) {
        if (!name) return -1;
        var idx = headerPos[name.toLowerCase()];
        return idx == null ? -1 : idx;
      });
      for (var r = 0; r < file.records.length; r++) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        var rec = file.records[r];
        var cells = new Array(headers.length);
        for (var c = 0; c < headers.length; c++) cells[c] = '';
        for (var c2 = 0; c2 < rec.length && c2 < map.length; c2++) {
          if (map[c2] >= 0) cells[map[c2]] = rec[c2] == null ? '' : String(rec[c2]);
        }
        rows.push({ cells: cells, x: null });
      }
    }
    if (!rows.length) return { ok: false, error: 'novalid', skipped: skipped };

    var keys = headers.map(headerKey);
    var dateI = findCol(keys, { date: 1, datum: 1 });
    var timeI = findCol(keys, { time: 1, zeit: 1, uhrzeit: 1 });
    var stampI = findCol(keys, { timestamp: 1, datetime: 1, zeitstempel: 1, 'date time': 1, datumzeit: 1, date_time: 1 });
    var exclude = {};
    var xIsTime = false;
    var xLabel = '';
    var mode = 'index';
    var xCol = -1;

    if (dateI >= 0 && timeI >= 0) mode = 'pair';
    else if (stampI >= 0) {
      mode = 'stamp';
      xCol = stampI;
    } else if (dateI >= 0) {
      mode = 'stamp';
      xCol = dateI;
    } else {
      xCol = 0;
      var dateHits = 0;
      var nonEmpty = 0;
      rows.forEach(function (row) {
        var raw = row.cells[xCol];
        if (String(raw || '').trim() === '') return;
        nonEmpty++;
        if (parseStamp(raw) != null) dateHits++;
      });
      if (nonEmpty && dateHits / nonEmpty >= 0.6) mode = 'stamp';
      else mode = 'pending';
    }

    if (mode === 'pair') {
      xIsTime = true;
      xLabel = headers[dateI] + ' ' + headers[timeI];
      exclude[dateI] = 1;
      exclude[timeI] = 1;
      rows.forEach(function (row) {
        row.x = parseStamp(String(row.cells[dateI] || '').trim() + ' ' + String(row.cells[timeI] || '').trim());
      });
    } else if (mode === 'stamp') {
      xIsTime = true;
      xLabel = headers[xCol];
      exclude[xCol] = 1;
      rows.forEach(function (row) { row.x = parseStamp(row.cells[xCol]); });
    }

    var numeric = [];
    for (var col = 0; col < headers.length; col++) {
      if (exclude[col]) continue;
      if (isNumericCol(rows, col)) numeric.push(col);
    }

    if (mode === 'pending') {
      var firstIsNum = numeric.length && numeric[0] === xCol;
      if (firstIsNum && numeric.length >= 2) {
        mode = 'number';
        xLabel = headers[xCol];
        exclude[xCol] = 1;
        numeric = numeric.filter(function (col) { return col !== xCol; });
        rows.forEach(function (row) { row.x = parseNumber(row.cells[xCol]); });
      } else {
        mode = 'index';
        xLabel = 'Index';
        rows.forEach(function (row, idx) { row.x = idx; });
      }
    }

    if ((mode === 'pair' || mode === 'stamp' || mode === 'number') && mode !== 'index') {
      rows.sort(function (a, b) {
        var an = a.x == null || !isFinite(a.x);
        var bn = b.x == null || !isFinite(b.x);
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        if (a.x === b.x) return 0;
        return a.x < b.x ? -1 : 1;
      });
    }

    if (!numeric.length) return { ok: false, error: 'nonum', skipped: skipped, truncated: truncated };

    var seriesNames = numeric.map(function (col) { return headers[col]; });
    rows.forEach(function (row) {
      row.y = numeric.map(function (col) {
        var n = parseNumber(row.cells[col]);
        return n == null ? null : n;
      });
    });

    return {
      ok: true,
      headers: headers,
      rows: rows,
      seriesNames: seriesNames,
      xIsTime: xIsTime,
      xLabel: xLabel,
      skipped: skipped,
      truncated: truncated
    };
  }

  function lowerBound(arr, n, x) {
    var lo = 0;
    var hi = n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function upperBound(arr, n, x) {
    var lo = 0;
    var hi = n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function nearestIndex(xs, n, x) {
    if (!n) return -1;
    var i = lowerBound(xs, n, x);
    if (i <= 0) return 0;
    if (i >= n) return n - 1;
    return (x - xs[i - 1] <= xs[i] - x) ? i - 1 : i;
  }

  function setStatus(text) {
    var node = el('csvLogStatus');
    if (node) node.textContent = text || '';
  }

  function applyLang() {
    var title = el('csvLogTitle');
    var sub = el('csvLogSub');
    if (title) title.textContent = t('title');
    if (sub) sub.textContent = t('sub');
    var map = {
      csvLogOpenFolder: 'folder',
      csvLogOpenFiles: 'files',
      csvLogAuto: 'auto',
      csvLogZoomIn: 'zin',
      csvLogZoomOut: 'zout',
      csvLogLeft: 'left',
      csvLogRight: 'right',
      csvLogRuler1: 'r1',
      csvLogRuler2: 'r2',
      csvLogPrint: 'print',
      csvLogLang: 'lang'
    };
    Object.keys(map).forEach(function (id) {
      var node = el(id);
      if (node) node.textContent = t(map[id]);
    });
    var view = el('viewCsvLog');
    if (view) view.setAttribute('aria-label', t('title'));
    updateDelta();
    if (state.selected >= 0) setStatus(rowSummary(state.selected));
    else if (state.ruler[0] != null || state.ruler[1] != null) updateRulerStatus();
    else if (!state.rows.length) setStatus(t('ready'));
  }

  function formatNum(n) {
    if (!isFinite(n)) return '';
    var abs = Math.abs(n);
    var s = (abs !== 0 && (abs >= 100000 || abs < 0.001))
      ? n.toExponential(2)
      : String(Math.round(n * 1000) / 1000);
    if (state.lang === 'de') s = s.replace('.', ',');
    return s;
  }

  function formatStamp(ms) {
    var d = new Date(ms);
    return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  function formatAxisTick(ms, span) {
    var d = new Date(ms);
    if (span < 36e5) return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    if (span < 8 * 864e5) return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '. ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  function formatDeltaValue(a, b) {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return '';
    if (state.xIsTime) {
      var sec = Math.round(Math.abs(b - a) / 1000);
      var days = Math.floor(sec / 86400);
      sec -= days * 86400;
      var h = Math.floor(sec / 3600);
      sec -= h * 3600;
      var m = Math.floor(sec / 60);
      sec -= m * 60;
      var body = pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
      if (days) body = days + (state.lang === 'de' ? ' Tage ' : ' d ') + body;
      return body;
    }
    return formatNum(Math.abs(b - a));
  }

  function formatX(value) {
    if (value == null || !isFinite(value)) return '';
    return state.xIsTime ? formatStamp(value) : formatNum(value);
  }

  function rowSummary(index) {
    if (index < 0 || !state.rows[index]) return '';
    var row = state.rows[index];
    var parts = [state.xLabel + ': ' + formatX(row.x)];
    var shown = 0;
    state.series.forEach(function (series, s) {
      if (!series.visible) return;
      var value = series.y[index];
      if (!isFinite(value)) return;
      if (shown >= 8) return;
      shown++;
      parts.push(series.name + ': ' + formatNum(value));
    });
    if (state.series.length > 8) parts.push('…');
    return parts.join(', ');
  }

  function updateDelta() {
    var node = el('csvLogDelta');
    if (!node) return;
    var a = state.ruler[0];
    var b = state.ruler[1];
    if (a == null || b == null || !state.nFinite) {
      node.textContent = '';
      return;
    }
    var i1 = nearestIndex(state.xs, state.nFinite, a);
    var i2 = nearestIndex(state.xs, state.nFinite, b);
    var dx = formatDeltaValue(state.xs[i1], state.xs[i2]);
    node.textContent = dx ? (t('delta') + ': ' + dx) : '';
  }

  function updateRulerStatus() {
    if (state.ruler[0] == null && state.ruler[1] == null) return;
    var bits = [];
    [0, 1].forEach(function (slot) {
      if (state.ruler[slot] == null || !state.nFinite) return;
      var idx = nearestIndex(state.xs, state.nFinite, state.ruler[slot]);
      bits.push((state.lang === 'de' ? 'Lineal ' : 'Ruler ') + (slot + 1) + ' ' + rowSummary(idx));
    });
    if (bits.length) setStatus(bits.join(' | '));
    updateDelta();
  }

  function dataXExtent() {
    if (!state.nFinite) return { min: 0, max: 1 };
    return { min: state.xs[0], max: state.xs[state.nFinite - 1] };
  }

  function setXRange(x0, x1) {
    var ext = dataXExtent();
    var span = ext.max - ext.min;
    var minSpan = state.xIsTime ? 1000 : Math.max(Math.abs(span) / 100000, 1e-9);
    if (!(x1 > x0)) {
      x0 = ext.min;
      x1 = ext.max === ext.min ? ext.max + minSpan : ext.max;
    }
    if (x1 - x0 < minSpan) {
      var mid = (x0 + x1) / 2;
      x0 = mid - minSpan / 2;
      x1 = mid + minSpan / 2;
    }
    state.x0 = x0;
    state.x1 = x1;
  }

  function autoScale() {
    var ext = dataXExtent();
    var pad = (ext.max - ext.min) * 0.02;
    if (!(ext.max > ext.min)) {
      setXRange(ext.min - 1, ext.max + 1);
    } else {
      setXRange(ext.min - pad, ext.max + pad);
    }
    renderPlot();
  }

  function zoomAt(scale, anchor) {
    var x0 = state.x0;
    var x1 = state.x1;
    var x = anchor == null ? (x0 + x1) / 2 : anchor;
    setXRange(x - (x - x0) * scale, x + (x1 - x) * scale);
    renderPlot();
  }

  function panBy(direction) {
    var width = state.x1 - state.x0;
    var shift = width * 0.2 * direction;
    setXRange(state.x0 + shift, state.x1 + shift);
    renderPlot();
  }

  function visibleYRange(layout) {
    var min = Infinity;
    var max = -Infinity;
    var i0 = lowerBound(state.xs, state.nFinite, state.x0);
    var i1 = upperBound(state.xs, state.nFinite, state.x1);
    state.series.forEach(function (series) {
      if (!series.visible) return;
      for (var i = i0; i < i1; i++) {
        var v = series.y[i];
        if (!isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    if (min === max) {
      min -= 1;
      max += 1;
    }
    var pad = (max - min) * 0.06;
    return { min: min - pad, max: max + pad };
  }

  function makeLayout() {
    var canvas = el('csvLogCanvas');
    var host = canvas ? canvas.parentElement : null;
    var w = Math.max(40, host ? host.clientWidth : 640);
    var h = Math.max(40, host ? host.clientHeight : 360);
    var dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    var left = 64;
    var right = 16;
    var top = 16;
    var bottom = 36;
    var yRange = state.nFinite ? visibleYRange() : { min: 0, max: 1 };
    var xSpan = (state.x1 - state.x0) || 1;
    var ySpan = (yRange.max - yRange.min) || 1;
    var plotW = Math.max(10, w - left - right);
    var plotH = Math.max(10, h - top - bottom);
    return {
      w: w,
      h: h,
      dpr: dpr,
      left: left,
      right: right,
      top: top,
      bottom: bottom,
      plotW: plotW,
      plotH: plotH,
      y0: yRange.min,
      y1: yRange.max,
      xToPx: function (x) { return left + ((x - state.x0) / xSpan) * plotW; },
      yToPx: function (y) { return top + ((yRange.max - y) / ySpan) * plotH; },
      pxToX: function (px) { return state.x0 + ((px - left) / plotW) * xSpan; }
    };
  }

  function themePaint() {
    var dark = document.documentElement.getAttribute('data-ui-theme') === 'dark';
    var bg = '#ffffff';
    var text = '#1a1a1a';
    var canvas = el('csvLogCanvas');
    if (canvas) {
      var cs = getComputedStyle(canvas);
      if (cs.backgroundColor) bg = cs.backgroundColor;
      text = getComputedStyle(document.body).color || text;
    }
    return {
      bg: bg,
      text: text,
      grid: dark ? 'rgba(255,255,255,0.16)' : '#e6e6e6',
      axis: dark ? 'rgba(255,255,255,0.72)' : '#5c5c5c',
      marker: '#0e7b5a'
    };
  }

  function sizeCanvas(canvas, layout) {
    canvas.width = Math.round(layout.w * layout.dpr);
    canvas.height = Math.round(layout.h * layout.dpr);
    canvas.style.width = layout.w + 'px';
    canvas.style.height = layout.h + 'px';
  }

  function prepareCtx(canvas, layout) {
    var ctx = canvas.getContext('2d');
    ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    return ctx;
  }

  function drawSeries(ctx, series, layout) {
    var y = series.y;
    var xs = state.xs;
    var i0 = lowerBound(xs, state.nFinite, state.x0);
    var i1 = upperBound(xs, state.nFinite, state.x1);
    if (i1 <= i0) return;
    ctx.beginPath();
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    var count = i1 - i0;
    if (count < layout.plotW * 2) {
      var started = false;
      for (var i = i0; i < i1; i++) {
        var v = y[i];
        if (!isFinite(v)) {
          started = false;
          continue;
        }
        var px = layout.xToPx(xs[i]);
        var py = layout.yToPx(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
    } else {
      var buckets = Math.max(1, Math.floor(layout.plotW));
      var minB = new Array(buckets);
      var maxB = new Array(buckets);
      for (var b = 0; b < buckets; b++) {
        minB[b] = Infinity;
        maxB[b] = -Infinity;
      }
      for (var j = i0; j < i1; j++) {
        var vv = y[j];
        if (!isFinite(vv)) continue;
        var px2 = layout.xToPx(xs[j]);
        var bi = Math.floor(((px2 - layout.left) / layout.plotW) * (buckets - 1));
        if (bi < 0) bi = 0;
        if (bi >= buckets) bi = buckets - 1;
        if (vv < minB[bi]) minB[bi] = vv;
        if (vv > maxB[bi]) maxB[bi] = vv;
      }
      var pen = false;
      for (var k = 0; k < buckets; k++) {
        if (minB[k] === Infinity) {
          pen = false;
          continue;
        }
        var xpx = layout.left + ((k + 0.5) / buckets) * layout.plotW;
        var yMax = layout.yToPx(maxB[k]);
        var yMin = layout.yToPx(minB[k]);
        if (!pen) {
          ctx.moveTo(xpx, yMax);
          pen = true;
        } else ctx.lineTo(xpx, yMax);
        if (yMin !== yMax) ctx.lineTo(xpx, yMin);
      }
    }
    ctx.stroke();
  }

  function drawPlot(ctx, layout, paint) {
    ctx.clearRect(0, 0, layout.w, layout.h);
    ctx.fillStyle = paint.bg;
    ctx.fillRect(0, 0, layout.w, layout.h);
    var noCurve = !state.series.some(function (s) { return s.visible; });
    if (!state.rows.length || !state.nFinite || noCurve) {
      ctx.fillStyle = paint.axis;
      ctx.font = '14px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      var hint = !state.rows.length ? t('empty') : (!state.nFinite ? t('noX') : t('noneOn'));
      ctx.fillText(hint, layout.w / 2, layout.h / 2);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.left, layout.top, layout.plotW, layout.plotH);
    ctx.clip();
    ctx.strokeStyle = paint.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.font = '11px Segoe UI, sans-serif';
    for (var g = 0; g <= 4; g++) {
      var yv = layout.y0 + ((layout.y1 - layout.y0) * g) / 4;
      var py = layout.yToPx(yv);
      ctx.beginPath();
      ctx.moveTo(layout.left, py);
      ctx.lineTo(layout.left + layout.plotW, py);
      ctx.stroke();
    }
    var span = state.x1 - state.x0;
    for (var gx = 0; gx <= 4; gx++) {
      var xv = state.x0 + (span * gx) / 4;
      var px = layout.xToPx(xv);
      ctx.beginPath();
      ctx.moveTo(px, layout.top);
      ctx.lineTo(px, layout.top + layout.plotH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    state.series.forEach(function (series) {
      if (series.visible) drawSeries(ctx, series, layout);
    });
    ctx.restore();

    ctx.fillStyle = paint.axis;
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var tick = 0; tick <= 4; tick++) {
      var yVal = layout.y0 + ((layout.y1 - layout.y0) * tick) / 4;
      ctx.fillText(formatNum(yVal), layout.left - 6, layout.yToPx(yVal));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var xt = 0; xt <= 4; xt++) {
      var xVal = state.x0 + (span * xt) / 4;
      var label = state.xIsTime ? formatAxisTick(xVal, span) : formatNum(xVal);
      ctx.fillText(label, layout.xToPx(xVal), layout.top + layout.plotH + 6);
    }
  }

  function drawVLine(ctx, x, color, dash) {
    var layout = state.layout;
    if (!layout || x == null || !isFinite(x)) return;
    var px = layout.xToPx(x);
    if (px < layout.left || px > layout.left + layout.plotW) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(px, layout.top);
    ctx.lineTo(px, layout.top + layout.plotH);
    ctx.stroke();
    ctx.restore();
  }

  function renderOverlay() {
    var canvas = el('csvLogCanvas');
    if (!canvas || !state.layout || !plotCanvas) return;
    var ctx = prepareCtx(canvas, state.layout);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(plotCanvas, 0, 0);
    ctx.setTransform(state.layout.dpr, 0, 0, state.layout.dpr, 0, 0);
    drawVLine(ctx, state.ruler[0], RULER_RED, [6, 4]);
    drawVLine(ctx, state.ruler[1], RULER_BLUE, [6, 4]);
    if (state.selected >= 0 && state.rows[state.selected] && isFinite(state.rows[state.selected].x)) {
      drawVLine(ctx, state.rows[state.selected].x, '#0e7b5a', []);
    }
    if (state.hover >= 0 && state.drag == null) {
      drawVLine(ctx, state.xs[state.hover], 'rgba(20,61,50,0.45)', [2, 3]);
    }
  }

  function renderPlot() {
    var canvas = el('csvLogCanvas');
    if (!canvas) return;
    if (!plotCanvas) plotCanvas = document.createElement('canvas');
    var layout = makeLayout();
    state.layout = layout;
    sizeCanvas(canvas, layout);
    sizeCanvas(plotCanvas, layout);
    var ctx = prepareCtx(plotCanvas, layout);
    drawPlot(ctx, layout, themePaint());
    renderOverlay();
    renderRows();
  }

  function queueRender() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      renderPlot();
    });
  }

  function renderLegend() {
    var host = el('csvLogLegend');
    if (!host) return;
    host.innerHTML = state.series.map(function (series, index) {
      return '<button type="button" class="csvlog-chip' + (series.visible ? '' : ' is-off') + '" data-series="' + index + '">' +
        '<span class="csvlog-swatch" style="background:' + series.color + '"></span>' + esc(series.name) + '</button>';
    }).join('');
  }

  function renderRows() {
    var body = el('csvLogTbody');
    var scroll = el('csvLogTableScroll');
    if (!body || !scroll) return;
    var count = state.rows.length;
    if (!count) {
      body.innerHTML = '';
      return;
    }
    var viewH = scroll.clientHeight || 160;
    var start = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 2);
    var vis = Math.ceil(viewH / ROW_H) + 6;
    var end = Math.min(count, start + vis);
    var top = start * ROW_H;
    var bot = Math.max(0, (count - end) * ROW_H);
    var cols = state.headers.length;
    var html = '<tr class="csvlog-pad"><td colspan="' + cols + '" style="height:' + top + 'px"></td></tr>';
    for (var i = start; i < end; i++) {
      var row = state.rows[i];
      html += '<tr data-i="' + i + '"' + (i === state.selected ? ' class="is-selected"' : '') + '>';
      for (var c = 0; c < cols; c++) html += '<td>' + esc(row.cells[c]) + '</td>';
      html += '</tr>';
    }
    html += '<tr class="csvlog-pad"><td colspan="' + cols + '" style="height:' + bot + 'px"></td></tr>';
    body.innerHTML = html;
  }

  function rebuildTable() {
    var table = el('csvLogTable');
    if (!table) return;
    var head = state.headers.map(function (name) { return '<th>' + esc(name) + '</th>'; }).join('');
    table.innerHTML = '<thead><tr>' + head + '</tr></thead><tbody id="csvLogTbody"></tbody>';
    var scroll = el('csvLogTableScroll');
    if (scroll) scroll.scrollTop = 0;
    renderRows();
  }

  function selectIndex(index, fromChart) {
    if (index < 0 || index >= state.rows.length) return;
    state.selected = index;
    setStatus(rowSummary(index));
    var row = state.rows[index];
    if (!fromChart && row && isFinite(row.x) && (row.x < state.x0 || row.x > state.x1)) {
      var width = state.x1 - state.x0;
      setXRange(row.x - width / 2, row.x + width / 2);
      renderPlot();
      return;
    }
    var scroll = el('csvLogTableScroll');
    if (fromChart && scroll) {
      var target = index * ROW_H - (scroll.clientHeight - ROW_H) / 2;
      scroll.scrollTop = Math.max(0, target);
    }
    renderRows();
    renderOverlay();
  }

  function applyDataset(data, fileLabel) {
    state.headers = data.headers;
    state.rows = data.rows;
    state.xIsTime = !!data.xIsTime;
    state.xLabel = data.xLabel || '';
    state.fileLabel = fileLabel || '';
    state.xs = data.rows.map(function (row) { return row.x == null ? NaN : row.x; });
    state.nFinite = 0;
    while (state.nFinite < state.xs.length && isFinite(state.xs[state.nFinite])) state.nFinite++;
    var keep = {};
    state.series.forEach(function (series) { keep[series.name] = series.visible; });
    state.series = data.seriesNames.map(function (name, index) {
      var y = new Float64Array(data.rows.length);
      for (var i = 0; i < data.rows.length; i++) {
        var v = data.rows[i].y[index];
        y[i] = v == null ? NaN : v;
      }
      return {
        name: name,
        color: PALETTE[index % PALETTE.length],
        visible: keep[name] !== false,
        y: y
      };
    });
    state.rows.forEach(function (row) { delete row.y; });
    state.ruler = [null, null];
    state.selected = -1;
    state.hover = -1;
    state.rulerMode = 0;
    syncRulerButtons();
    renderLegend();
    rebuildTable();
    var bits = [state.fileLabel, data.rows.length + ' ' + t('rows')];
    if (data.truncated) bits.push(t('truncated'));
    if (data.skipped) bits.push(data.skipped + ' ' + (state.lang === 'de' ? 'übersprungen' : 'skipped'));
    setStatus(bits.filter(Boolean).join(' · '));
    autoScale();
    updateDelta();
  }

  function decodeBytes(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (utf8.charCodeAt(0) === 0xFEFF) utf8 = utf8.slice(1);
    if (utf8.indexOf('\uFFFD') >= 0) {
      try { return new TextDecoder('windows-1252').decode(bytes); } catch (e) { /* UTF-8 behalten */ }
    }
    return utf8;
  }

  function collectCsvFiles(list, nested) {
    var files = [];
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (!file || !/\.csv$/i.test(file.name || '')) continue;
      var rel = file.webkitRelativePath || file.name;
      var depth = String(rel).split(/[/\\]/).length;
      if (!nested && depth > 2) continue;
      files.push(file);
    }
    files.sort(function (a, b) {
      var an = (a.webkitRelativePath || a.name || '').toLowerCase();
      var bn = (b.webkitRelativePath || b.name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return files;
  }

  function loadFiles(fileList, fromFolder) {
    var files = collectCsvFiles(fileList, false);
    var nested = false;
    if (fromFolder && !files.length) {
      files = collectCsvFiles(fileList, true);
      nested = files.length > 0;
    }
    if (!files.length) {
      setStatus(t('noCsv'));
      return;
    }
    setStatus(t('reading'));
    Promise.all(files.map(function (file) {
      return file.arrayBuffer().then(function (buf) {
        return { name: file.name, text: decodeBytes(buf) };
      }).catch(function () {
        return { name: file.name, text: '' };
      });
    })).then(function (texts) {
      var data = buildDataset(texts);
      if (!data.ok) {
        setStatus(data.error === 'nonum' ? t('noNum') : t('noValid'));
        return;
      }
      var label = files.length + ' ' + (files.length === 1 ? t('fileOne') : t('fileMany'));
      if (nested) label += ' · ' + t('nested');
      applyDataset(data, label);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : String(err));
    });
  }

  function syncRulerButtons() {
    var b1 = el('csvLogRuler1');
    var b2 = el('csvLogRuler2');
    if (b1) {
      b1.classList.toggle('is-on', state.rulerMode === 1);
      b1.setAttribute('aria-pressed', state.rulerMode === 1 ? 'true' : 'false');
    }
    if (b2) {
      b2.classList.toggle('is-on', state.rulerMode === 2);
      b2.setAttribute('aria-pressed', state.rulerMode === 2 ? 'true' : 'false');
    }
  }

  function setRulerMode(slot) {
    state.rulerMode = state.rulerMode === slot ? 0 : slot;
    syncRulerButtons();
    if (state.rulerMode) {
      setStatus((state.lang === 'de' ? 'Lineal ' : 'Ruler ') + slot + ' ' + t('rulerOn'));
    } else setStatus(t('ready'));
  }

  function setRuler(slot, x) {
    if (!isFinite(x)) return;
    state.ruler[slot - 1] = x;
    updateRulerStatus();
    renderOverlay();
  }

  function localX(ev) {
    var canvas = el('csvLogCanvas');
    if (!canvas) return 0;
    var rect = canvas.getBoundingClientRect();
    if (typeof ev.clientX === 'number') return ev.clientX - rect.left;
    return ev.offsetX || 0;
  }

  function hideTip() {
    var tip = el('csvLogTooltip');
    if (tip) tip.hidden = true;
    state.hover = -1;
  }

  function showTip(ev, index) {
    var tip = el('csvLogTooltip');
    var plot = el('csvLogCanvas') && el('csvLogCanvas').parentElement;
    if (!tip || !plot || index < 0) {
      hideTip();
      return;
    }
    var lines = [formatX(state.xs[index])];
    state.series.forEach(function (series) {
      if (!series.visible) return;
      var v = series.y[index];
      if (!isFinite(v)) return;
      lines.push(series.name + ': ' + formatNum(v));
    });
    tip.textContent = lines.join('\n');
    tip.hidden = false;
    var rect = plot.getBoundingClientRect();
    var x = ev.clientX - rect.left + 14;
    var y = ev.clientY - rect.top + 12;
    tip.style.left = '0px';
    tip.style.top = '0px';
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    if (x + tw > rect.width - 8) x = ev.clientX - rect.left - tw - 12;
    if (y + th > rect.height - 8) y = ev.clientY - rect.top - th - 12;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }

  function onPointerDown(ev) {
    if (!state.layout || !state.nFinite) return;
    var canvas = el('csvLogCanvas');
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* Zeiger schon weg */ }
    }
    canvas.focus();
    var x = state.layout.pxToX(localX(ev));
    if (state.rulerMode) {
      state.drag = { mode: 'ruler', slot: state.rulerMode };
      setRuler(state.rulerMode, x);
      return;
    }
    state.drag = {
      mode: 'pan',
      startPx: localX(ev),
      x0: state.x0,
      x1: state.x1,
      moved: false
    };
  }

  function onPointerMove(ev) {
    if (!state.layout || !state.nFinite) return;
    if (state.drag && state.drag.mode === 'ruler') {
      setRuler(state.drag.slot, state.layout.pxToX(localX(ev)));
      return;
    }
    if (state.drag && state.drag.mode === 'pan') {
      var dx = localX(ev) - state.drag.startPx;
      if (Math.abs(dx) > 3) state.drag.moved = true;
      var span = state.drag.x1 - state.drag.x0;
      var shift = -(dx / state.layout.plotW) * span;
      setXRange(state.drag.x0 + shift, state.drag.x1 + shift);
      hideTip();
      renderPlot();
      return;
    }
    var x = state.layout.pxToX(localX(ev));
    if (x < state.x0 || x > state.x1) {
      hideTip();
      renderOverlay();
      return;
    }
    var idx = nearestIndex(state.xs, state.nFinite, x);
    state.hover = idx;
    showTip(ev, idx);
    renderOverlay();
  }

  function onPointerUp(ev) {
    var drag = state.drag;
    state.drag = null;
    if (!drag || !state.layout || !state.nFinite) return;
    if (drag.mode === 'pan' && !drag.moved) {
      var x = state.layout.pxToX(localX(ev));
      selectIndex(nearestIndex(state.xs, state.nFinite, x), true);
    }
    if (drag.mode === 'ruler') {
      var xr = state.ruler[drag.slot - 1];
      if (xr != null) selectIndex(nearestIndex(state.xs, state.nFinite, xr), true);
    }
  }

  function onWheel(ev) {
    if (!state.nFinite || !state.layout) return;
    ev.preventDefault();
    if (ev.shiftKey) {
      var width = state.x1 - state.x0;
      var dir = ev.deltaY > 0 ? 1 : -1;
      setXRange(state.x0 + width * 0.2 * dir, state.x1 + width * 0.2 * dir);
      renderPlot();
      return;
    }
    var scale = ev.deltaY < 0 ? 0.8 : 1.25;
    zoomAt(scale, state.layout.pxToX(localX(ev)));
  }

  function printView() {
    var canvas = el('csvLogCanvas');
    if (!canvas) return;
    renderOverlay();
    var url = canvas.toDataURL('image/png');
    var win = window.open('', 'kukpit-csvlog-print', 'width=1100,height=760');
    if (!win) {
      setStatus(t('printFail'));
      return;
    }
    var delta = el('csvLogDelta') ? el('csvLogDelta').textContent : '';
    var status = el('csvLogStatus') ? el('csvLogStatus').textContent : '';
    win.document.open();
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(t('title')) + '</title>' +
      '<style>body{font-family:Segoe UI,sans-serif;color:#1a1a1a;margin:16px}h1{color:#0c6a4d;font-size:18px;margin:0 0 6px}' +
      '.bar{height:4px;background:#0e7b5a;margin:0 0 12px}p{margin:0 0 8px;color:#5c5c5c}img{max-width:100%;height:auto}</style></head><body>' +
      '<div class="bar"></div><h1>' + esc(t('title')) + '</h1><p>' + esc(status) + '</p><p>' + esc(delta) + '</p>' +
      '<img alt="" src="' + url + '"></body></html>'
    );
    win.document.close();
    win.focus();
    setTimeout(function () {
      try { win.print(); } catch (e) { /* Vorschau bleibt offen */ }
    }, 250);
    setStatus(t('printed'));
  }

  function bindClick(id, fn) {
    var node = el(id);
    if (node) node.addEventListener('click', fn);
  }

  function bindOnce() {
    if (state.bound || !el('viewCsvLog')) return;
    state.bound = true;
    try {
      var saved = localStorage.getItem('kukpit_csvlog_lang');
      if (saved === 'en' || saved === 'de') state.lang = saved;
    } catch (e) { /* Sprache bleibt Deutsch */ }
    applyLang();

    bindClick('csvLogOpenFolder', function () {
      var input = el('csvLogFolderInput');
      if (input) input.click();
    });
    bindClick('csvLogOpenFiles', function () {
      var input = el('csvLogFilesInput');
      if (input) input.click();
    });
    var folderInput = el('csvLogFolderInput');
    var filesInput = el('csvLogFilesInput');
    if (folderInput) {
      folderInput.addEventListener('change', function () {
        var list = folderInput.files ? Array.prototype.slice.call(folderInput.files) : [];
        folderInput.value = '';
        loadFiles(list, true);
      });
    }
    if (filesInput) {
      filesInput.addEventListener('change', function () {
        var list = filesInput.files ? Array.prototype.slice.call(filesInput.files) : [];
        filesInput.value = '';
        loadFiles(list, false);
      });
    }
    bindClick('csvLogAuto', autoScale);
    bindClick('csvLogZoomIn', function () { zoomAt(0.8, null); });
    bindClick('csvLogZoomOut', function () { zoomAt(1.25, null); });
    bindClick('csvLogLeft', function () { panBy(-1); });
    bindClick('csvLogRight', function () { panBy(1); });
    bindClick('csvLogRuler1', function () { setRulerMode(1); });
    bindClick('csvLogRuler2', function () { setRulerMode(2); });
    bindClick('csvLogPrint', printView);
    bindClick('csvLogLang', function () {
      state.lang = state.lang === 'de' ? 'en' : 'de';
      try { localStorage.setItem('kukpit_csvlog_lang', state.lang); } catch (e) { /* ignorieren */ }
      applyLang();
      renderPlot();
    });

    var legend = el('csvLogLegend');
    if (legend) {
      legend.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-series]');
        if (!btn) return;
        var index = parseInt(btn.getAttribute('data-series'), 10);
        if (!state.series[index]) return;
        state.series[index].visible = !state.series[index].visible;
        renderLegend();
        renderPlot();
      });
    }

    var canvas = el('csvLogCanvas');
    if (canvas) {
      canvas.tabIndex = 0;
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointerleave', function () {
        if (state.drag && state.drag.mode === 'pan') return;
        hideTip();
        renderOverlay();
      });
      canvas.addEventListener('wheel', onWheel, { passive: false });
    }

    var scroll = el('csvLogTableScroll');
    if (scroll) scroll.addEventListener('scroll', function () { renderRows(); });
    var table = el('csvLogTable');
    if (table) {
      table.addEventListener('click', function (ev) {
        var tr = ev.target.closest ? ev.target.closest('tr[data-i]') : null;
        if (!tr) return;
        selectIndex(parseInt(tr.getAttribute('data-i'), 10), false);
      });
    }

    document.addEventListener('keydown', function (ev) {
      var view = el('viewCsvLog');
      if (!view || !view.classList.contains('active')) return;
      var tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        panBy(-1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        panBy(1);
      }
    });

    var plot = canvas && canvas.parentElement;
    if (plot && typeof ResizeObserver !== 'undefined') {
      var observer = new ResizeObserver(function () { queueRender(); });
      observer.observe(plot);
    } else {
      window.addEventListener('resize', queueRender);
    }
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { queueRender(); }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-ui-theme']
      });
    }
    queueRender();
  }

  function openTool() {
    bindOnce();
    requestAnimationFrame(function () { renderPlot(); });
  }

  function install() {
    window.openCsvLogTool = openTool;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindOnce);
    else bindOnce();
  }

  return {
    install: install,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    parseNumber: parseNumber,
    parseStamp: parseStamp,
    buildDataset: buildDataset,
    nearestIndex: nearestIndex,
    lowerBound: lowerBound
  };
});
