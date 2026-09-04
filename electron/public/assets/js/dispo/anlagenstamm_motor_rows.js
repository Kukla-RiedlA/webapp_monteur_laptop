/**
 * Motor-Karten im Anlagenstamm (Technik): Default leer, Plus legt an.
 * Persistenz über named inputs motor[i][feld] — kein JSON-Hidden-Feld.
 */
(function (global) {
  'use strict';

  var MAX = 20;
  var FIELD_MAX = 255;
  var KEYS = [
    'bezeichnung',
    'positionsnummer',
    'hersteller',
    'type',
    'seriennummer',
    'nennleistung_kw',
    'leistungsfaktor',
    'nenndrehzahl',
    'nennstrom',
    'getriebeuebersetzung',
    'getriebedrehzahl',
    'nennspannung',
    'nennfrequenz',
    'bauform',
    'schaltung',
    'isolationsklasse',
    'schutzart',
    'leerlaufstrom_50hz',
    'anlaufart',
    'fu_hersteller',
    'fu_type',
    'fu_nennstrom',
    'fu_nennstrom_eingestellt',
    'fu_max_speed',
    'fu_max_frequency',
    'laststrom_calculated',
    'laststrom_fat',
    'laststrom_sat',
  ];

  var LABELS = {
    bezeichnung: 'Bezeichnung',
    positionsnummer: 'Positionsnummer',
    hersteller: 'Hersteller',
    type: 'Type',
    seriennummer: 'Seriennummer',
    nennleistung_kw: 'Nennleistung kW',
    leistungsfaktor: 'cos φ',
    nenndrehzahl: 'Nenndrehzahl min-1',
    nennstrom: 'Nennstrom A',
    getriebeuebersetzung: 'Übersetzung 1:',
    getriebedrehzahl: 'Nenndrehzahl Getriebe min-1',
    nennspannung: 'Nennspannung V',
    nennfrequenz: 'Nennfrequenz Hz',
    bauform: 'Bauform',
    schaltung: 'Schaltung Y/∆',
    isolationsklasse: 'Isolationsklasse',
    schutzart: 'Schutzart',
    leerlaufstrom_50hz: 'Leerlaufstrom 50 Hz A',
    anlaufart: 'Anlaufart',
    fu_hersteller: 'FU Hersteller',
    fu_type: 'FU Type',
    fu_nennstrom: 'Nennstrom A',
    fu_nennstrom_eingestellt: 'eingestellt A',
    fu_max_speed: 'max. Speed min-1',
    fu_max_frequency: 'max. Frequency Hz',
    laststrom_calculated: 'Laststrom calculated A',
    laststrom_fat: 'Laststrom FAT A',
    laststrom_sat: 'Laststrom SAT A',
  };

  var GROUPS = [
    { title: 'Zuordnung', keys: ['bezeichnung', 'positionsnummer'] },
    {
      title: 'Motordaten',
      keys: [
        'hersteller',
        'type',
        'seriennummer',
        'nennleistung_kw',
        'leistungsfaktor',
        'nenndrehzahl',
        'nennstrom',
        'getriebeuebersetzung',
        'getriebedrehzahl',
        'nennspannung',
        'nennfrequenz',
        'bauform',
        'schaltung',
        'isolationsklasse',
        'schutzart',
        'leerlaufstrom_50hz',
      ],
    },
    { title: 'Zubehör', keys: ['anlaufart'] },
    {
      id: 'fu',
      title: 'Frequenzumrichter',
      keys: [
        'fu_hersteller',
        'fu_type',
        'fu_nennstrom',
        'fu_nennstrom_eingestellt',
        'fu_max_speed',
        'fu_max_frequency',
        'laststrom_calculated',
        'laststrom_fat',
        'laststrom_sat',
      ],
    },
  ];

  function isFuAnlaufart(v) {
    var s = String(v == null ? '' : v)
      .toLowerCase()
      .replace(/ü/g, 'u')
      .replace(/ä/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return false;
    if (s === 'fu' || s === 'fc') return true;
    if (s.indexOf('frequenzumrichter') !== -1) return true;
    if (s.indexOf('frequency converter') !== -1) return true;
    return /\bfreq\b/.test(s) && /\bconv/.test(s);
  }

  function syncFuVisibility(row) {
    if (!row) return;
    var inp = row.querySelector('input[data-motor-key="anlaufart"]');
    var fu = row.querySelector('.motor-row-fu-block');
    if (!fu) return;
    fu.style.display = isFuAnlaufart(inp && inp.value) ? '' : 'none';
  }

  function bindFuVisibility(row) {
    if (!row || row._fuBound) return;
    row._fuBound = true;
    var inp = row.querySelector('input[data-motor-key="anlaufart"]');
    if (inp) {
      inp.addEventListener('input', function () { syncFuVisibility(row); });
      inp.addEventListener('change', function () { syncFuVisibility(row); });
    }
    syncFuVisibility(row);
  }

  var state = {
    containerId: 'motorRows',
    addButtonId: 'btnAddMotor',
    readOnly: false,
  };

  function clamp(v) {
    var s = v == null ? '' : String(v).trim();
    if (s.length > FIELD_MAX) return s.slice(0, FIELD_MAX);
    return s;
  }

  function emptyRow() {
    var o = {};
    KEYS.forEach(function (k) {
      o[k] = '';
    });
    return o;
  }

  function normalize(item) {
    if (!item || typeof item !== 'object') return emptyRow();
    var o = emptyRow();
    KEYS.forEach(function (k) {
      o[k] = clamp(item[k]);
    });
    if (item.id) o.id = String(item.id);
    return o;
  }

  function getContainer() {
    return document.getElementById(state.containerId);
  }

  function reindex() {
    var container = getContainer();
    if (!container) return;
    var rows = container.querySelectorAll('.motor-row');
    for (var i = 0; i < rows.length; i++) {
      var inputs = rows[i].querySelectorAll('input[data-motor-key]');
      for (var j = 0; j < inputs.length; j++) {
        var key = inputs[j].getAttribute('data-motor-key');
        inputs[j].name = 'motor[' + i + '][' + key + ']';
      }
    }
  }

  function makeField(key, value, idx) {
    var wrap = document.createElement('div');
    wrap.className = 'kraftaufnehmer-field';
    var lab = document.createElement('label');
    lab.textContent = LABELS[key] || key;
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-motor-key', key);
    input.name = 'motor[' + idx + '][' + key + ']';
    input.value = clamp(value);
    input.autocomplete = 'off';
    if (state.readOnly) {
      input.readOnly = true;
      input.tabIndex = -1;
    }
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }

  function addRow(rowData) {
    var container = getContainer();
    if (!container) return;
    if (container.querySelectorAll('.motor-row').length >= MAX) return;
    var data = normalize(rowData || emptyRow());
    var idx = container.querySelectorAll('.motor-row').length;
    var row = document.createElement('div');
    row.className = 'kraftaufnehmer-row motor-row';
    var fields = document.createElement('div');
    fields.className = 'kraftaufnehmer-row-fields';
    GROUPS.forEach(function (g) {
      var wrap = document.createElement('div');
      if (g.id === 'fu') wrap.className = 'motor-row-fu-block';
      var head = document.createElement('div');
      head.className = 'motor-row-group-title';
      head.textContent = g.title;
      wrap.appendChild(head);
      var line = document.createElement('div');
      line.className = 'kraftaufnehmer-row-line motor-row-line';
      g.keys.forEach(function (k) {
        line.appendChild(makeField(k, data[k], idx));
      });
      wrap.appendChild(line);
      fields.appendChild(wrap);
    });
    row.appendChild(fields);
    if (!state.readOnly) {
      var actions = document.createElement('div');
      actions.className = 'kraftaufnehmer-row-actions';
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-secondary btn-kraftaufnehmer-remove';
      rm.textContent = '−';
      rm.title = 'Motor entfernen';
      rm.addEventListener('click', function () {
        row.remove();
        reindex();
      });
      actions.appendChild(rm);
      row.appendChild(actions);
    }
    container.appendChild(row);
    bindFuVisibility(row);
    reindex();
  }

  function setRows(list) {
    var container = getContainer();
    if (!container) return;
    container.innerHTML = '';
    if (!Array.isArray(list)) return;
    list.forEach(function (item) {
      addRow(item);
    });
  }

  function collectRows() {
    var container = getContainer();
    var out = [];
    if (!container) return out;
    var rows = container.querySelectorAll('.motor-row');
    for (var i = 0; i < rows.length; i++) {
      var data = emptyRow();
      var any = false;
      var inputs = rows[i].querySelectorAll('input[data-motor-key]');
      for (var j = 0; j < inputs.length; j++) {
        var key = inputs[j].getAttribute('data-motor-key');
        var val = clamp(inputs[j].value);
        data[key] = val;
        if (val) any = true;
      }
      if (any) out.push(data);
    }
    return out;
  }

  function init(opts) {
    opts = opts || {};
    state.containerId = opts.containerId || 'motorRows';
    state.addButtonId = opts.addButtonId || 'btnAddMotor';
    state.readOnly = !!opts.readOnly;
    var container = getContainer();
    if (!container) return;
    container.innerHTML = '';
    var rows = Array.isArray(opts.rows) ? opts.rows : [];
    rows.forEach(function (r) {
      addRow(r);
    });
    var addBtn = document.getElementById(state.addButtonId);
    if (addBtn) {
      addBtn.style.display = state.readOnly ? 'none' : '';
      if (!state.readOnly) {
        if (addBtn._motorBound) {
          addBtn.replaceWith(addBtn.cloneNode(true));
          addBtn = document.getElementById(state.addButtonId);
        }
        if (addBtn) {
          addBtn._motorBound = true;
          addBtn.addEventListener('click', function () {
            addRow(emptyRow());
            var last = container.querySelectorAll('.motor-row');
            var first = last.length ? last[last.length - 1].querySelector('input') : null;
            if (first) first.focus();
          });
        }
      }
    }
  }

  global.kuklaInitMotorRows = init;
  global.kuklaMotorAddRow = addRow;
  global.kuklaMotorSetRows = setRows;
  global.kuklaMotorCollectRows = collectRows;
})(typeof window !== 'undefined' ? window : this);
