/**
 * Kraftaufnehmer-Zeilen mit DMS Nr. und DMS Position (primär + Zusatz).
 */
(function (global) {
  'use strict';

  var MAX_EXTRA = 20;
  var FIELD_MAX = 100;
  var state = {
    containerId: 'kraftaufnehmerRows',
    primaryInputId: 'formKraftaufnehmer',
    primaryDmsInputId: 'formDmsNr',
    primaryDmsPosInputId: 'formDmsPosition',
    hiddenInputId: 'formKraftaufnehmerExtra',
    addButtonId: 'btnAddKraftaufnehmer',
    readOnly: false,
  };

  function trimVal(v) {
    return v == null ? '' : String(v).trim();
  }

  function clampField(v) {
    var s = trimVal(v);
    if (s.length > FIELD_MAX) return s.slice(0, FIELD_MAX);
    return s;
  }

  function emptyRow() {
    return { kraftaufnehmer: '', dms_nr: '', dms_position: '' };
  }

  function normalizeRow(item) {
    if (!item || typeof item !== 'object') {
      var s = clampField(item);
      if (!s) return null;
      return { kraftaufnehmer: s, dms_nr: '', dms_position: '' };
    }
    var ka = clampField(item.kraftaufnehmer != null ? item.kraftaufnehmer : item.type);
    var dms = clampField(item.dms_nr);
    var pos = clampField(item.dms_position);
    if (!ka && !dms && !pos) return null;
    return { kraftaufnehmer: ka, dms_nr: dms, dms_position: pos };
  }

  function normalizeExtras(items) {
    var out = [];
    if (!Array.isArray(items)) return out;
    for (var i = 0; i < items.length; i++) {
      var row = normalizeRow(items[i]);
      if (!row) continue;
      out.push(row);
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

  function readRowFields(rowEl) {
    if (!rowEl) return emptyRow();
    return {
      kraftaufnehmer: clampField(rowEl.querySelector('.kraftaufnehmer-field-ka') && rowEl.querySelector('.kraftaufnehmer-field-ka').value),
      dms_nr: clampField(rowEl.querySelector('.kraftaufnehmer-field-dms') && rowEl.querySelector('.kraftaufnehmer-field-dms').value),
      dms_position: clampField(rowEl.querySelector('.kraftaufnehmer-field-dmspos') && rowEl.querySelector('.kraftaufnehmer-field-dmspos').value),
    };
  }

  function rowHasContent(rowData) {
    return !!(rowData.kraftaufnehmer || rowData.dms_nr || rowData.dms_position);
  }

  function syncHidden() {
    var hidden = document.getElementById(state.hiddenInputId);
    var container = getContainer();
    var extras = [];
    if (container) {
      var extraRows = container.querySelectorAll('.kraftaufnehmer-row-extra');
      for (var i = 0; i < extraRows.length; i++) {
        var data = readRowFields(extraRows[i]);
        if (rowHasContent(data)) extras.push(data);
      }
    }
    if (hidden) hidden.value = extras.length ? JSON.stringify(extras) : '';
    return extras;
  }

  function makeFieldInput(className, value, placeholder) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = className;
    input.value = clampField(value);
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    if (state.readOnly) {
      input.readOnly = true;
      input.tabIndex = -1;
    } else {
      input.addEventListener('input', syncHidden);
    }
    return input;
  }

  function buildFieldsRow(rowData, isPrimary) {
    var fields = document.createElement('div');
    fields.className = 'kraftaufnehmer-row-fields';

    var kaInput = makeFieldInput('kraftaufnehmer-field-ka', rowData.kraftaufnehmer, 'Kraftaufnehmer');
    var dmsInput = makeFieldInput('kraftaufnehmer-field-dms', rowData.dms_nr, 'DMS Nr.');
    var posInput = makeFieldInput('kraftaufnehmer-field-dmspos', rowData.dms_position, 'DMS Position');

    if (isPrimary) {
      kaInput.name = 'kraftaufnehmer';
      kaInput.id = state.primaryInputId;
      dmsInput.name = 'dms_nr';
      dmsInput.id = state.primaryDmsInputId;
      posInput.name = 'dms_position';
      posInput.id = state.primaryDmsPosInputId;
    }

    fields.appendChild(kaInput);
    fields.appendChild(dmsInput);
    fields.appendChild(posInput);
    return fields;
  }

  function addExtraRow(rowData) {
    var container = getContainer();
    if (!container) return;
    var extraCount = container.querySelectorAll('.kraftaufnehmer-row-extra').length;
    if (extraCount >= MAX_EXTRA) return;

    rowData = normalizeRow(rowData || emptyRow()) || emptyRow();

    var row = document.createElement('div');
    row.className = 'kraftaufnehmer-row kraftaufnehmer-row-extra';
    row.appendChild(buildFieldsRow(rowData, false));

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

  function renderHead() {
    var head = document.createElement('div');
    head.className = 'kraftaufnehmer-row kraftaufnehmer-row-head';
    head.innerHTML =
      '<span class="kraftaufnehmer-col-label">Kraftaufnehmer</span>' +
      '<span class="kraftaufnehmer-col-label">DMS Nr.</span>' +
      '<span class="kraftaufnehmer-col-label">DMS Position</span>' +
      '<span class="kraftaufnehmer-col-label kraftaufnehmer-col-actions" aria-hidden="true"></span>';
    return head;
  }

  function init(opts) {
    opts = opts || {};
    state.containerId = opts.containerId || 'kraftaufnehmerRows';
    state.primaryInputId = opts.primaryInputId || 'formKraftaufnehmer';
    state.primaryDmsInputId = opts.primaryDmsInputId || 'formDmsNr';
    state.primaryDmsPosInputId = opts.primaryDmsPosInputId || 'formDmsPosition';
    state.hiddenInputId = opts.hiddenInputId || 'formKraftaufnehmerExtra';
    state.addButtonId = opts.addButtonId || 'btnAddKraftaufnehmer';
    state.readOnly = !!opts.readOnly;

    var container = getContainer();
    if (!container) return;

    var addBtn = document.getElementById(state.addButtonId);
    container.innerHTML = '';
    container.appendChild(renderHead());

    var primaryRow = document.createElement('div');
    primaryRow.className = 'kraftaufnehmer-row kraftaufnehmer-row-primary';
    primaryRow.appendChild(buildFieldsRow({
      kraftaufnehmer: opts.primaryValue || '',
      dms_nr: opts.primaryDmsNr || '',
      dms_position: opts.primaryDmsPosition || '',
    }, true));
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
            addExtraRow(emptyRow());
            var rows = container.querySelectorAll('.kraftaufnehmer-row-extra');
            if (rows.length) {
              var first = rows[rows.length - 1].querySelector('.kraftaufnehmer-field-ka');
              if (first) first.focus();
            }
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
