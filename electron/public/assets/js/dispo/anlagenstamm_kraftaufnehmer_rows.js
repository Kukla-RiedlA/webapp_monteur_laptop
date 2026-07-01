/**
 * Zusätzliche Kraftaufnehmer-Zeilen im Anlagenstamm-Bearbeiten-Formular.
 */
(function (global) {
  'use strict';

  var MAX_EXTRA = 20;
  var FIELD_MAX = 100;
  var state = {
    containerId: 'kraftaufnehmerRows',
    primaryInputId: 'formKraftaufnehmer',
    hiddenInputId: 'formKraftaufnehmerExtra',
    addButtonId: 'btnAddKraftaufnehmer',
    readOnly: false,
  };

  function trimVal(v) {
    return v == null ? '' : String(v).trim();
  }

  function normalizeExtras(items) {
    var out = [];
    if (!Array.isArray(items)) return out;
    for (var i = 0; i < items.length; i++) {
      var s = trimVal(items[i]);
      if (!s) continue;
      if (s.length > FIELD_MAX) s = s.slice(0, FIELD_MAX);
      out.push(s);
      if (out.length >= MAX_EXTRA) break;
    }
    return out;
  }

  function parseExtrasFromRow(row) {
    if (!row) return [];
    var raw = row.kraftaufnehmer_extra;
    if (Array.isArray(raw)) return normalizeExtras(raw);
    if (typeof raw === 'string' && trimVal(raw)) {
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? normalizeExtras(parsed) : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function getContainer() {
    return document.getElementById(state.containerId);
  }

  function syncHidden() {
    var hidden = document.getElementById(state.hiddenInputId);
    var container = getContainer();
    var extras = [];
    if (container) {
      var inputs = container.querySelectorAll('input.kraftaufnehmer-extra-input');
      for (var i = 0; i < inputs.length; i++) {
        var val = trimVal(inputs[i].value);
        if (val) extras.push(val.length > FIELD_MAX ? val.slice(0, FIELD_MAX) : val);
      }
    }
    if (hidden) hidden.value = extras.length ? JSON.stringify(extras) : '';
    return extras;
  }

  function addExtraRow(value) {
    var container = getContainer();
    if (!container) return;
    var extraCount = container.querySelectorAll('input.kraftaufnehmer-extra-input').length;
    if (extraCount >= MAX_EXTRA) return;

    var row = document.createElement('div');
    row.className = 'kraftaufnehmer-row kraftaufnehmer-row-extra';

    var label = document.createElement('label');
    label.className = 'kraftaufnehmer-sr-only';
    label.textContent = 'Kraftaufnehmer (Zusatz)';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'kraftaufnehmer-extra-input';
    input.value = trimVal(value).slice(0, FIELD_MAX);
    input.autocomplete = 'off';
    if (state.readOnly) {
      input.readOnly = true;
      input.tabIndex = -1;
    } else {
      input.addEventListener('input', syncHidden);
    }

    row.appendChild(label);
    row.appendChild(input);

    if (!state.readOnly) {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-secondary btn-kraftaufnehmer-remove';
      rm.textContent = '−';
      rm.title = 'Zeile entfernen';
      rm.addEventListener('click', function () {
        row.remove();
        syncHidden();
      });
      row.appendChild(rm);
    }

    container.appendChild(row);
  }

  function init(opts) {
    opts = opts || {};
    state.containerId = opts.containerId || 'kraftaufnehmerRows';
    state.primaryInputId = opts.primaryInputId || 'formKraftaufnehmer';
    state.hiddenInputId = opts.hiddenInputId || 'formKraftaufnehmerExtra';
    state.addButtonId = opts.addButtonId || 'btnAddKraftaufnehmer';
    state.readOnly = !!opts.readOnly;

    var container = getContainer();
    if (!container) return;

    var addBtn = document.getElementById(state.addButtonId);
    container.innerHTML = '';

    var primaryRow = document.createElement('div');
    primaryRow.className = 'kraftaufnehmer-row kraftaufnehmer-row-primary';

    var primaryLabel = document.createElement('label');
    primaryLabel.setAttribute('for', state.primaryInputId);
    primaryLabel.textContent = 'Kraftaufnehmer';

    var primaryInput = document.createElement('input');
    primaryInput.type = 'text';
    primaryInput.name = opts.primaryName || 'kraftaufnehmer';
    primaryInput.id = state.primaryInputId;
    primaryInput.value = trimVal(opts.primaryValue).slice(0, FIELD_MAX);
    primaryInput.autocomplete = 'off';
    if (state.readOnly) {
      primaryInput.readOnly = true;
      primaryInput.tabIndex = -1;
    }

    primaryRow.appendChild(primaryLabel);
    primaryRow.appendChild(primaryInput);
    container.appendChild(primaryRow);

    var extras = normalizeExtras(opts.extras);
    if (!extras.length && opts.row) extras = parseExtrasFromRow(opts.row);
    for (var i = 0; i < extras.length; i++) addExtraRow(extras[i]);

    if (addBtn) {
      addBtn.style.display = state.readOnly ? 'none' : '';
      if (!state.readOnly) {
        if (addBtn._kaBound) {
          addBtn.replaceWith(addBtn.cloneNode(true));
          addBtn = document.getElementById(state.addButtonId);
        }
        if (addBtn) {
          addBtn._kaBound = true;
          addBtn.addEventListener('click', function () {
            addExtraRow('');
            var inputs = container.querySelectorAll('input.kraftaufnehmer-extra-input');
            if (inputs.length) inputs[inputs.length - 1].focus();
            syncHidden();
          });
        }
      }
    }

    syncHidden();
  }

  global.kuklaInitKraftaufnehmerRows = init;
  global.kuklaCollectKraftaufnehmerExtra = syncHidden;
  global.kuklaParseKraftaufnehmerExtraFromRow = parseExtrasFromRow;
})(window);
