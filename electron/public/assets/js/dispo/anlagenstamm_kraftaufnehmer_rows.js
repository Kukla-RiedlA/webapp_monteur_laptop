/**
 * Wägezellen-Blöcke: Type, Seriennummer, Pos., Versorgungsspannung, Sensitivität (primär + Zusatz).
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
    primaryVersInputId: 'formVersSpannung',
    primarySensInputId: 'formSensitivitaet',
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
    return {
      kraftaufnehmer: '',
      dms_nr: '',
      dms_position: '',
      vers_spannung: '',
      sensitivitaet: '',
    };
  }

  function normalizeRow(item) {
    if (!item || typeof item !== 'object') {
      var s = clampField(item);
      if (!s) return null;
      return {
        kraftaufnehmer: s,
        dms_nr: '',
        dms_position: '',
        vers_spannung: '',
        sensitivitaet: '',
      };
    }
    var ka = clampField(item.kraftaufnehmer != null ? item.kraftaufnehmer : item.type);
    var dms = clampField(item.dms_nr);
    var pos = clampField(item.dms_position);
    var vers = clampField(item.vers_spannung != null ? item.vers_spannung : item.supplyVoltage);
    var sens = clampField(item.sensitivitaet != null ? item.sensitivitaet : item.sensitivity);
    if (!ka && !dms && !pos && !vers && !sens) return null;
    return {
      kraftaufnehmer: ka,
      dms_nr: dms,
      dms_position: pos,
      vers_spannung: vers,
      sensitivitaet: sens,
    };
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
      vers_spannung: clampField(rowEl.querySelector('.kraftaufnehmer-field-vers') && rowEl.querySelector('.kraftaufnehmer-field-vers').value),
      sensitivitaet: clampField(rowEl.querySelector('.kraftaufnehmer-field-sens') && rowEl.querySelector('.kraftaufnehmer-field-sens').value),
    };
  }

  function rowHasContent(rowData) {
    return !!(
      rowData.kraftaufnehmer ||
      rowData.dms_nr ||
      rowData.dms_position ||
      rowData.vers_spannung ||
      rowData.sensitivitaet
    );
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

  function makeLabeledField(className, value, labelText, placeholder) {
    var wrap = document.createElement('div');
    wrap.className = 'kraftaufnehmer-field';
    var lab = document.createElement('label');
    lab.textContent = labelText;
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
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function buildFieldsBlock(rowData, isPrimary) {
    var fields = document.createElement('div');
    fields.className = 'kraftaufnehmer-row-fields';

    var row1 = document.createElement('div');
    row1.className = 'kraftaufnehmer-row-line kraftaufnehmer-row-line-main';
    var ka = makeLabeledField('kraftaufnehmer-field-ka', rowData.kraftaufnehmer, 'Type', 'Type');
    var dms = makeLabeledField('kraftaufnehmer-field-dms', rowData.dms_nr, 'Seriennummer', 'Seriennummer');
    var pos = makeLabeledField('kraftaufnehmer-field-dmspos', rowData.dms_position, 'Pos.', 'Pos.');
    row1.appendChild(ka.wrap);
    row1.appendChild(dms.wrap);
    row1.appendChild(pos.wrap);

    var row2 = document.createElement('div');
    row2.className = 'kraftaufnehmer-row-line kraftaufnehmer-row-line-meas';
    var vers = makeLabeledField('kraftaufnehmer-field-vers', rowData.vers_spannung, 'Versorgungsspannung V', '');
    var sens = makeLabeledField('kraftaufnehmer-field-sens', rowData.sensitivitaet, 'Sensitivität mV/V', '');
    row2.appendChild(vers.wrap);
    row2.appendChild(sens.wrap);

    if (isPrimary) {
      ka.input.name = 'kraftaufnehmer';
      ka.input.id = state.primaryInputId;
      dms.input.name = 'dms_nr';
      dms.input.id = state.primaryDmsInputId;
      pos.input.name = 'dms_position';
      pos.input.id = state.primaryDmsPosInputId;
      vers.input.name = 'vers_spannung';
      vers.input.id = state.primaryVersInputId;
      sens.input.name = 'sensitivitaet';
      sens.input.id = state.primarySensInputId;
    }

    fields.appendChild(row1);
    fields.appendChild(row2);
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
    row.appendChild(buildFieldsBlock(rowData, false));

    if (!state.readOnly) {
      var actions = document.createElement('div');
      actions.className = 'kraftaufnehmer-row-actions';
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-secondary btn-kraftaufnehmer-remove';
      rm.textContent = '−';
      rm.title = 'Wägezelle entfernen';
      rm.addEventListener('click', function () {
        row.remove();
        syncHidden();
      });
      actions.appendChild(rm);
      row.appendChild(actions);
    }

    container.appendChild(row);
  }

  function init(opts) {
    opts = opts || {};
    state.containerId = opts.containerId || 'kraftaufnehmerRows';
    state.primaryInputId = opts.primaryInputId || 'formKraftaufnehmer';
    state.primaryDmsInputId = opts.primaryDmsInputId || 'formDmsNr';
    state.primaryDmsPosInputId = opts.primaryDmsPosInputId || 'formDmsPosition';
    state.primaryVersInputId = opts.primaryVersInputId || 'formVersSpannung';
    state.primarySensInputId = opts.primarySensInputId || 'formSensitivitaet';
    state.hiddenInputId = opts.hiddenInputId || 'formKraftaufnehmerExtra';
    state.addButtonId = opts.addButtonId || 'btnAddKraftaufnehmer';
    state.readOnly = !!opts.readOnly;

    var container = getContainer();
    if (!container) return;

    var addBtn = document.getElementById(state.addButtonId);
    container.innerHTML = '';

    var primaryRow = document.createElement('div');
    primaryRow.className = 'kraftaufnehmer-row kraftaufnehmer-row-primary';
    primaryRow.appendChild(buildFieldsBlock({
      kraftaufnehmer: opts.primaryValue || '',
      dms_nr: opts.primaryDmsNr || '',
      dms_position: opts.primaryDmsPosition || '',
      vers_spannung: opts.primaryVersSpannung || '',
      sensitivitaet: opts.primarySensitivitaet || '',
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
})(typeof window !== 'undefined' ? window : this);
