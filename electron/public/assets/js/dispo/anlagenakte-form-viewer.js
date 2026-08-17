/**
 * Schreibgeschützte Formular-Ansicht für Akte-JSONs (Service, KW, Schleppkette, Montagebericht).
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isHtml(s) {
    return typeof s === 'string' && /<[a-z][\s\S]*>/i.test(s);
  }

  function looksLikeSignature(key, val) {
    var k = String(key || '').toLowerCase();
    if (k.indexOf('signatur') >= 0 || k.indexOf('signature') >= 0) return true;
    if (typeof val === 'string' && val.indexOf('data:image') === 0) return true;
    return false;
  }

  function labelFor(key) {
    var map = {
      grundDesEinsatzes: 'Grund des Einsatzes',
      grundDesEinsatzes_html: 'Grund des Einsatzes',
      bemerkungen: 'Bemerkungen',
      bemerkungen_html: 'Bemerkungen',
      projekt: 'Projekt',
      language: 'Sprache',
      languages: 'Sprachen',
      fabrikationsnummer: 'F.N.',
      Fabrikationsnummer: 'F.N.',
      type: 'Type',
      position: 'Position / Pos.Nr.',
      durchfuehrungsdatum: 'Durchführungsdatum',
      kopf_pos_nr: 'Pos.Nr.',
      kopf_qmax: 'Qmax',
      kopf_type: 'Type',
      kopf_dwc: 'DWC',
      arbeitsschritte: 'Arbeitsschritte',
      messwerte: 'Messwerte',
      waegezelle_type: 'Wägezelle Type',
      waegezelle_seriennummer: 'Wägezelle Seriennr.',
      bezeichnung: 'Bezeichnung',
      erledigt: 'Erledigt',
      kopfdaten: 'Kopfdaten',
      fabBemerkungen: 'Anlagen / Fabrikationsnummern',
      technician: 'Monteur',
      kunde: 'Kunde',
      datum: 'Datum',
      schleppkette: 'Schleppkette',
      kontrollwiegung: 'Kontrollwiegung'
    };
    if (map[key]) return map[key];
    if (String(key).slice(-5) === '_html') return labelFor(String(key).slice(0, -5));
    return String(key || '').replace(/_/g, ' ');
  }

  function titleForSlug(slug, table) {
    var s = String(slug || table || '').toLowerCase();
    if (s.indexOf('montage') >= 0) return 'Montagebericht';
    if (s.indexOf('service') >= 0) return 'Serviceprotokoll';
    if (s.indexOf('kontroll') >= 0) return 'Kontrollwiegung';
    if (s.indexOf('wieg') >= 0) return 'Wiegeprotokoll';
    if (s.indexOf('schlepp') >= 0) return 'Schleppkettenprotokoll';
    if (s.indexOf('pruef') >= 0 || s.indexOf('prüf') >= 0) return 'Prüfzertifikat';
    return 'Protokoll';
  }

  function skipKey(key) {
    var k = String(key || '').toLowerCase();
    if (!k) return true;
    if (k === 'ok' || k === 'id' || k === 'job_id' || k === 'technician_id') return true;
    if (k.indexOf('password') >= 0 || k.indexOf('dispo') >= 0) return true;
    if (k.slice(-5) === '_html') return true;
    return false;
  }

  function renderValue(key, val) {
    if (val == null || val === '') {
      return '<span class="akte-form-empty">—</span>';
    }
    if (looksLikeSignature(key, val)) {
      if (typeof val === 'string' && val.indexOf('data:image') === 0) {
        return '<img class="akte-form-sign" alt="Unterschrift" src="' + esc(val) + '">';
      }
      return '<span class="akte-form-empty">Unterschrift vorhanden</span>';
    }
    if (typeof val === 'boolean') {
      return val ? 'Ja' : 'Nein';
    }
    if (typeof val === 'number') {
      return esc(String(val));
    }
    if (typeof val === 'string') {
      if (isHtml(val)) {
        return '<div class="akte-form-rich">' + val + '</div>';
      }
      return esc(val).replace(/\n/g, '<br>');
    }
    if (Array.isArray(val)) {
      if (!val.length) return '<span class="akte-form-empty">—</span>';
      if (val.every(function (x) { return typeof x !== 'object' || x == null; })) {
        return esc(val.join(', '));
      }
      return renderRows(val);
    }
    if (typeof val === 'object') {
      return renderFields(val);
    }
    return esc(String(val));
  }

  function htmlPrefers(obj, key) {
    var htmlKey = key + '_html';
    if (obj && typeof obj === 'object' && obj[htmlKey]) return obj[htmlKey];
    return obj ? obj[key] : null;
  }

  function renderFields(obj, order) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    var keys = order && order.length ? order.filter(function (k) { return Object.prototype.hasOwnProperty.call(obj, k) || Object.prototype.hasOwnProperty.call(obj, k + '_html'); }) : Object.keys(obj);
    if (!order) {
      Object.keys(obj).forEach(function (k) {
        if (keys.indexOf(k) < 0) keys.push(k);
      });
    }
    var html = '<div class="akte-form-grid">';
    keys.forEach(function (key) {
      if (skipKey(key)) return;
      var val = htmlPrefers(obj, key);
      if (val == null && obj[key] == null) return;
      html += '<div class="akte-form-field"><div class="akte-form-label">' + esc(labelFor(key)) + '</div><div class="akte-form-value">' + renderValue(key, val) + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function renderRows(rows) {
    var html = '';
    rows.forEach(function (row, idx) {
      if (!row || typeof row !== 'object') {
        html += '<div class="akte-form-field"><div class="akte-form-value">' + esc(String(row)) + '</div></div>';
        return;
      }
      html += '<div class="akte-form-card"><div class="akte-form-card-title">Eintrag ' + (idx + 1) + '</div>' + renderFields(row) + '</div>';
    });
    return html;
  }

  function renderMontage(payload) {
    var html = '';
    html += '<fieldset class="akte-form-set" disabled><legend>Kopf</legend>';
    html += renderFields(payload, ['projekt', 'language', 'languages', 'grundDesEinsatzes']);
    html += '</fieldset>';
    var fabs = payload.fabBemerkungen || payload.fab_bemerkungen || [];
    if (Array.isArray(fabs) && fabs.length) {
      html += '<fieldset class="akte-form-set" disabled><legend>Anlagen</legend>';
      fabs.forEach(function (row) {
        var fn = row && (row.fabrikationsnummer || row.Fabrikationsnummer || '') || '';
        html += '<div class="akte-form-card"><div class="akte-form-card-title">F.N. ' + esc(fn) + '</div>' + renderFields(row, ['type', 'position', 'bemerkungen']) + '</div>';
      });
      html += '</fieldset>';
    }
    html += '<fieldset class="akte-form-set" disabled><legend>Bemerkungen</legend>';
    html += renderFields(payload, ['bemerkungen']);
    html += '</fieldset>';
    return html;
  }

  function renderService(payload) {
    var html = '<fieldset class="akte-form-set" disabled><legend>Kopfdaten</legend>';
    html += renderFields(payload, ['fabrikationsnummer', 'durchfuehrungsdatum', 'projekt', 'kopf_pos_nr', 'kopf_qmax', 'kopf_type', 'kopf_dwc']);
    html += '</fieldset>';
    if (payload.kopfdaten && typeof payload.kopfdaten === 'object') {
      html += '<fieldset class="akte-form-set" disabled><legend>Anlagenkopf</legend>' + renderFields(payload.kopfdaten) + '</fieldset>';
    }
    var steps = payload.arbeitsschritte;
    if (Array.isArray(steps) && steps.length) {
      html += '<fieldset class="akte-form-set" disabled><legend>Arbeitsschritte</legend>' + renderRows(steps) + '</fieldset>';
    }
    if (payload.messwerte && typeof payload.messwerte === 'object') {
      html += '<fieldset class="akte-form-set" disabled><legend>Messwerte</legend>' + renderFields(payload.messwerte) + '</fieldset>';
    }
    html += '<fieldset class="akte-form-set" disabled><legend>Bemerkungen</legend>' + renderFields(payload, ['bemerkungen']) + '</fieldset>';
    return html;
  }

  function renderGeneric(payload) {
    if (!payload || typeof payload !== 'object') {
      return '<pre class="akte-form-pre">' + esc(String(payload || '')) + '</pre>';
    }
    var html = '';
    var used = {};
    ['fabrikationsnummer', 'durchfuehrungsdatum', 'projekt', 'kopfdaten', 'arbeitsschritte', 'messwerte', 'fabBemerkungen', 'grundDesEinsatzes', 'bemerkungen'].forEach(function (k) {
      if (payload[k] == null && payload[k + '_html'] == null) return;
      used[k] = true;
    });
    if (payload.grundDesEinsatzes || payload.projekt || payload.fabBemerkungen) {
      return renderMontage(payload) + renderFields(payload, Object.keys(payload).filter(function (k) { return !used[k] && !skipKey(k); }));
    }
    if (payload.arbeitsschritte || payload.messwerte || payload.durchfuehrungsdatum) {
      html = renderService(payload);
      html += renderFields(payload, Object.keys(payload).filter(function (k) { return !used[k] && !skipKey(k); }));
      return html;
    }
    return '<fieldset class="akte-form-set" disabled><legend>Daten</legend>' + renderFields(payload) + '</fieldset>';
  }

  function render(payload, slug, table) {
    var s = String(slug || table || '').toLowerCase();
    var inner;
    if (s.indexOf('montage') >= 0) inner = renderMontage(payload || {});
    else if (s.indexOf('service') >= 0 || s.indexOf('kontroll') >= 0 || s.indexOf('schlepp') >= 0 || s.indexOf('wieg') >= 0) inner = renderService(payload || {});
    else inner = renderGeneric(payload || {});
    return '<form class="akte-form-readonly" onsubmit="return false;">' + inner +
      '<p class="akte-form-note">Nur Ansicht — Speichern ist deaktiviert.</p></form>';
  }

  global.kuklaAkteFormViewer = {
    render: render,
    titleForSlug: titleForSlug
  };
})(window);
