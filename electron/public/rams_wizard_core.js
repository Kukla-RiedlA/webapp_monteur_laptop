/**
 * RAMS Quiz-Wizard Core (Vanilla JS, kein Build-Step).
 *
 * Single Source of Truth fuer den Step-by-Step Quiz-Wizard, der ein
 * RAMS-Dokument ausschliesslich per Multiple-Choice / Checkbox befuellt.
 * Wird in PWA (webapp_handy) und Electron-Laptop (webapp_monteur_laptop)
 * 1:1 verwendet. Adapter-Funktionen kapseln die jeweilige Auth (Token vs.
 * Cookie) und die Signatur-Aufruf-Konvention.
 *
 * Veroeffentlicht als window.RamsWizardCore mit der Methode open(opts).
 *
 * opts (Pflicht: doc, catalog, container, onSavePayload, onSubmit, onSign, onCompletionPreview):
 *   container: HTMLElement              -> Container zum Rendern
 *   doc:       object                   -> aktuelles Dokument (action=document)
 *   catalog:   object                   -> aktueller Katalog (action=catalog)
 *   lang:      'de'|'en'                -> Default 'de'
 *   onLanguageChange(newLang) -> Promise<{ doc, catalog }>
 *   onSavePayload(payload) -> Promise<savedDoc>
 *   onSubmit(id) -> Promise<submittedDoc>
 *   onSign(savedDoc) -> Promise<docNachSignLink>
 *   onCompletionPreview(docNachSign) -> Promise<boolean>
 *                          true = RAMS uebernehmen (approved); false = verworfen (Adapter ruft onClose)
 *   onClose() -> void
 *   onError(err) -> void
 */
(function () {
  'use strict';

  var TXT = {
    de: {
      title: 'RAMS Quiz',
      cancel: 'Abbrechen',
      back: 'Zurueck',
      next: 'Weiter',
      finish: 'Speichern und signieren',
      saving: 'Speichern ...',
      submitting: 'Einreichen ...',
      signing: 'Signatur ...',
      langDe: 'DE',
      langEn: 'EN',
      step: 'Schritt',
      of: 'von',
      stepEquipment: 'Anlage und Auftragsart',
      stepEquipmentSub: 'Waehle Equipment-Typ und Auftragsart aus.',
      lblOrderType: 'Auftragsart',
      lblEquipment: 'Equipment-Typ',
      stepActivities: 'Taetigkeiten',
      stepActivitiesSub: 'Welche Taetigkeiten werden ausgefuehrt? (mind. 1)',
      stepHazards: 'Gefaehrdungen',
      stepHazardsSub: 'Welche Gefaehrdungen sind moeglich? (mind. 1)',
      stepRisks: 'Risikobewertung',
      stepRisksSub: 'Pro Gefaehrdung Initial- und Restrisiko bewerten. Restrisiko muss strikt kleiner als Initialrisiko sein.',
      stepControls: 'Schutzmassnahmen',
      stepControlsSub: 'Pro Gefaehrdung mindestens eine Schutzmassnahme auswaehlen.',
      stepPpe: 'Persoenliche Schutzausruestung (PSA)',
      stepPpeSub: 'Welche PSA wird benoetigt? (mind. 1)',
      stepEmergency: 'Notfallmassnahmen',
      stepEmergencySub: 'Welche Notfallmassnahmen sind relevant? (mind. 1)',
      stepConfirm: 'Bestaetigung',
      stepConfirmSub: 'Bitte vor dem Signieren alle Pflichtpunkte bestaetigen.',
      chk1: 'Arbeitsumfang gelesen und verstanden',
      chk2: 'Gefaehrdungen und Massnahmen vor Ort geprueft',
      chk3: 'Notwendige PSA ist verfuegbar und wird getragen',
      chk4: 'Notfallwege und Ansprechpartner sind bekannt',
      noteOptional: 'Kommentar (optional, ohne Eingabezwang) - leer lassen',
      validationFailed: 'Bitte alle Pflichtpunkte bestaetigen, bevor signiert wird.',
      hazardInitial: 'Initialrisiko',
      hazardResidual: 'Restrisiko',
      hazardLikelihood: 'Wahrscheinlichkeit',
      hazardSeverity: 'Schwere',
      hazardScore: 'Score',
      residualMustBeLower: 'Restrisiko muss strikt kleiner sein als Initialrisiko.',
      noControlForHazard: 'Mind. eine Schutzmassnahme pro Gefaehrdung waehlen.',
      orderTypes: ['Wartung', 'Reparatur', 'Inspektion', 'Umbau', 'Notfall-Einsatz'],
      scopePattern: '%ORDER% an %EQUIPMENT%',
      categoryGroup: 'Kategorie',
      noCatalog: 'Katalog nicht verfuegbar.',
      saveErr: 'Speichern fehlgeschlagen',
      submitErr: 'Einreichen fehlgeschlagen',
      signErr: 'Signatur fehlgeschlagen',
      hazardsHeader: 'Gefaehrdung',
      controlsHeader: 'Massnahmen',
      genericErr: 'Fehler',
      finishedTitle: 'RAMS abgeschlossen',
      finishedMsg: 'Das RAMS wurde gespeichert und signiert.'
    },
    en: {
      title: 'RAMS Quiz',
      cancel: 'Cancel',
      back: 'Back',
      next: 'Next',
      finish: 'Save and sign',
      saving: 'Saving ...',
      submitting: 'Submitting ...',
      signing: 'Signing ...',
      langDe: 'DE',
      langEn: 'EN',
      step: 'Step',
      of: 'of',
      stepEquipment: 'Equipment and order type',
      stepEquipmentSub: 'Choose equipment type and order type.',
      lblOrderType: 'Order type',
      lblEquipment: 'Equipment type',
      stepActivities: 'Activities',
      stepActivitiesSub: 'Which activities are performed? (at least 1)',
      stepHazards: 'Hazards',
      stepHazardsSub: 'Which hazards are possible? (at least 1)',
      stepRisks: 'Risk assessment',
      stepRisksSub: 'Per hazard rate initial and residual risk. Residual must be strictly lower than initial.',
      stepControls: 'Controls',
      stepControlsSub: 'At least one control per hazard.',
      stepPpe: 'Personal protective equipment (PPE)',
      stepPpeSub: 'Which PPE is required? (at least 1)',
      stepEmergency: 'Emergency measures',
      stepEmergencySub: 'Which emergency measures are relevant? (at least 1)',
      stepConfirm: 'Confirmation',
      stepConfirmSub: 'Please confirm all mandatory items before signing.',
      chk1: 'Scope of work read and understood',
      chk2: 'Hazards and measures checked on site',
      chk3: 'Required PPE is available and will be worn',
      chk4: 'Emergency routes and contacts are known',
      noteOptional: 'Comment (optional, no input required) - leave empty',
      validationFailed: 'Please confirm all mandatory items before signing.',
      hazardInitial: 'Initial risk',
      hazardResidual: 'Residual risk',
      hazardLikelihood: 'Likelihood',
      hazardSeverity: 'Severity',
      hazardScore: 'Score',
      residualMustBeLower: 'Residual must be strictly lower than initial.',
      noControlForHazard: 'At least one control per hazard.',
      orderTypes: ['Maintenance', 'Repair', 'Inspection', 'Modification', 'Emergency'],
      scopePattern: '%ORDER% on %EQUIPMENT%',
      categoryGroup: 'Category',
      noCatalog: 'Catalog not available.',
      saveErr: 'Save failed',
      submitErr: 'Submit failed',
      signErr: 'Signing failed',
      hazardsHeader: 'Hazard',
      controlsHeader: 'Controls',
      genericErr: 'Error',
      finishedTitle: 'RAMS completed',
      finishedMsg: 'The RAMS has been saved and signed.'
    }
  };

  function htmlEscape(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function open(opts) {
    opts = opts || {};
    var state = {
      container: opts.container,
      doc: opts.doc,
      catalog: opts.catalog,
      lang: (opts.lang === 'en' ? 'en' : 'de'),
      currentStep: 0,
      // Quiz-Auswahl
      selectedEquipmentKey: opts.doc && opts.doc.equipment_type_key ? opts.doc.equipment_type_key : '',
      selectedOrderTypeIdx: 0,
      selectedActivityKeys: {},
      selectedHazardKeys: {},
      hazardRisk: {}, // { key: { il, is, rl, rs } }
      hazardControls: {}, // { hazardKey: { controlKey: true } }
      selectedPpeKeys: {},
      selectedEmergencyKeys: {},
      checklistAnswers: { scope_understood: false, hazards_checked: false, ppe_ready: false, emergency_known: false },
      // Internes
      busy: false
    };

    if (!state.container) {
      throw new Error('RamsWizardCore.open: container missing');
    }
    if (!state.catalog) {
      state.container.innerHTML = '<div class="kukla-rams-wizard__error">' + htmlEscape(t('noCatalog')) + '</div>';
      return;
    }

    function t(key) {
      var pack = TXT[state.lang] || TXT.de;
      return pack[key] !== undefined ? pack[key] : key;
    }

    // Defaults aus doc uebernehmen, falls vorhanden
    if (state.doc && Array.isArray(state.doc.hazards)) {
      state.doc.hazards.forEach(function (h) {
        if (h && h.catalog_hazard_key) {
          state.selectedHazardKeys[h.catalog_hazard_key] = true;
          state.hazardRisk[h.catalog_hazard_key] = {
            il: h.initial && typeof h.initial.l !== 'undefined' ? h.initial.l : (h.initial_likelihood || 3),
            is: h.initial && typeof h.initial.s !== 'undefined' ? h.initial.s : (h.initial_severity || 3),
            rl: h.residual && typeof h.residual.l !== 'undefined' ? h.residual.l : (h.residual_likelihood || 2),
            rs: h.residual && typeof h.residual.s !== 'undefined' ? h.residual.s : (h.residual_severity || 2)
          };
          if (Array.isArray(h.controls)) {
            state.hazardControls[h.catalog_hazard_key] = state.hazardControls[h.catalog_hazard_key] || {};
            h.controls.forEach(function (c) {
              if (c && c.catalog_control_key) {
                state.hazardControls[h.catalog_hazard_key][c.catalog_control_key] = true;
              }
            });
          }
        }
      });
    }
    if (state.doc && Array.isArray(state.doc.activities)) {
      state.doc.activities.forEach(function (a) {
        if (a && a.activity_type_key) state.selectedActivityKeys[a.activity_type_key] = true;
      });
    }
    if (state.doc && Array.isArray(state.doc.ppe)) {
      state.doc.ppe.forEach(function (p) { if (p && p.ppe_key) state.selectedPpeKeys[p.ppe_key] = true; });
    }
    if (state.doc && Array.isArray(state.doc.emergency)) {
      state.doc.emergency.forEach(function (e) { if (e && e.topic_key) state.selectedEmergencyKeys[e.topic_key] = true; });
    }

    var STEPS = [
      'equipment',  // 0
      'activities', // 1
      'hazards',    // 2
      'risks',      // 3
      'controls',   // 4
      'ppe',        // 5
      'emergency',  // 6
      'confirm'     // 7
    ];

    function render() {
      var stepKey = STEPS[state.currentStep];
      var totalSteps = STEPS.length;
      var html = '';
      html += '<div class="kukla-rams-wizard">';
      html += '  <div class="kukla-rams-wizard__header">';
      html += '    <div class="kukla-rams-wizard__title">' + htmlEscape(t('title')) + '</div>';
      html += '    <div class="kukla-rams-wizard__lang">';
      html += '      <button type="button" class="kukla-rams-wizard__lang-btn ' + (state.lang === 'de' ? 'is-active' : '') + '" data-lang="de">' + htmlEscape(t('langDe')) + '</button>';
      html += '      <button type="button" class="kukla-rams-wizard__lang-btn ' + (state.lang === 'en' ? 'is-active' : '') + '" data-lang="en">' + htmlEscape(t('langEn')) + '</button>';
      html += '    </div>';
      html += '    <button type="button" class="kukla-rams-wizard__close" data-action="cancel">&times;</button>';
      html += '  </div>';
      html += '  <div class="kukla-rams-wizard__progress">' + htmlEscape(t('step')) + ' ' + (state.currentStep + 1) + ' ' + htmlEscape(t('of')) + ' ' + totalSteps + '</div>';
      html += '  <div class="kukla-rams-wizard__body" id="ramsWizardBody"></div>';
      html += '  <div class="kukla-rams-wizard__error" id="ramsWizardError" style="display:none"></div>';
      html += '  <div class="kukla-rams-wizard__footer">';
      html += '    <button type="button" class="kukla-rams-wizard__btn" data-action="cancel">' + htmlEscape(t('cancel')) + '</button>';
      html += '    <button type="button" class="kukla-rams-wizard__btn" data-action="back" ' + (state.currentStep === 0 ? 'disabled' : '') + '>' + htmlEscape(t('back')) + '</button>';
      var nextLabel = (state.currentStep === STEPS.length - 1) ? t('finish') : t('next');
      html += '    <button type="button" class="kukla-rams-wizard__btn kukla-rams-wizard__btn--primary" data-action="next">' + htmlEscape(nextLabel) + '</button>';
      html += '  </div>';
      html += '</div>';
      state.container.innerHTML = html;

      // Body je Step
      var body = state.container.querySelector('#ramsWizardBody');
      switch (stepKey) {
        case 'equipment': renderEquipment(body); break;
        case 'activities': renderActivities(body); break;
        case 'hazards': renderHazards(body); break;
        case 'risks': renderRisks(body); break;
        case 'controls': renderControls(body); break;
        case 'ppe': renderPpe(body); break;
        case 'emergency': renderEmergency(body); break;
        case 'confirm': renderConfirm(body); break;
      }
      bindEvents();
    }

    function renderEquipment(body) {
      var orderTypes = TXT[state.lang].orderTypes;
      var html = '';
      html += '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepEquipment')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepEquipmentSub')) + '</p>';
      html += '<div class="kukla-rams-wizard__field"><label>' + htmlEscape(t('lblOrderType')) + '</label>';
      html += '  <div class="kukla-rams-wizard__choices kukla-rams-wizard__choices--single">';
      orderTypes.forEach(function (label, idx) {
        html += '<button type="button" class="kukla-rams-wizard__choice ' + (state.selectedOrderTypeIdx === idx ? 'is-selected' : '') + '" data-order-idx="' + idx + '">' + htmlEscape(label) + '</button>';
      });
      html += '  </div>';
      html += '</div>';

      html += '<div class="kukla-rams-wizard__field"><label>' + htmlEscape(t('lblEquipment')) + '</label>';
      html += '  <div class="kukla-rams-wizard__choices">';
      var eqs = (state.catalog.equipment_types || []).slice().sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0);
      });
      eqs.forEach(function (eq) {
        html += '<button type="button" class="kukla-rams-wizard__choice ' + (state.selectedEquipmentKey === eq.key ? 'is-selected' : '') + '" data-equipment="' + htmlEscape(eq.key) + '">' + htmlEscape(eq.label || eq.key) + '</button>';
      });
      html += '  </div>';
      html += '</div>';
      body.innerHTML = html;
    }

    function renderActivities(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepActivities')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepActivitiesSub')) + '</p>';
      html += '<div class="kukla-rams-wizard__choices">';
      var acts = (state.catalog.activity_types || []).slice().sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0);
      });
      acts.forEach(function (a) {
        var sel = !!state.selectedActivityKeys[a.key];
        html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-activity="' + htmlEscape(a.key) + '" ' + (sel ? 'checked' : '') + '> <span>' + htmlEscape(a.label || a.key) + '</span></label>';
      });
      html += '</div>';
      body.innerHTML = html;
    }

    function renderHazards(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepHazards')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepHazardsSub')) + '</p>';
      var hazards = (state.catalog.hazards || []).slice().sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0);
      });
      var byCat = {};
      hazards.forEach(function (h) {
        var cat = h.category || '';
        if (!byCat[cat]) byCat[cat] = [];
        byCat[cat].push(h);
      });
      Object.keys(byCat).sort().forEach(function (cat) {
        html += '<div class="kukla-rams-wizard__group">';
        html += '<div class="kukla-rams-wizard__group-title">' + htmlEscape(cat || t('categoryGroup')) + '</div>';
        html += '<div class="kukla-rams-wizard__choices">';
        byCat[cat].forEach(function (h) {
          var sel = !!state.selectedHazardKeys[h.key];
          html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-hazard="' + htmlEscape(h.key) + '" ' + (sel ? 'checked' : '') + '> <span>' + htmlEscape(h.label || h.key) + '</span></label>';
        });
        html += '</div></div>';
      });
      body.innerHTML = html;
    }

    function renderRisks(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepRisks')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepRisksSub')) + '</p>';
      var picked = Object.keys(state.selectedHazardKeys).filter(function (k) { return state.selectedHazardKeys[k]; });
      var hazardsByKey = {};
      (state.catalog.hazards || []).forEach(function (h) { hazardsByKey[h.key] = h; });
      picked.forEach(function (key) {
        var h = hazardsByKey[key];
        if (!h) return;
        if (!state.hazardRisk[key]) {
          state.hazardRisk[key] = {
            il: h.default_initial_likelihood || 3,
            is: h.default_initial_severity || 3,
            rl: Math.max(1, (h.default_initial_likelihood || 3) - 1),
            rs: Math.max(1, (h.default_initial_severity || 3) - 1)
          };
        }
        var r = state.hazardRisk[key];
        var initialScore = r.il * r.is;
        var residualScore = r.rl * r.rs;
        var residualOk = residualScore < initialScore;
        html += '<div class="kukla-rams-wizard__hazard">';
        html += '<div class="kukla-rams-wizard__hazard-title">' + htmlEscape(h.label || h.key) + '</div>';
        html += renderRiskRow(t('hazardInitial'), key, 'il', 'is', r.il, r.is);
        html += renderRiskRow(t('hazardResidual'), key, 'rl', 'rs', r.rl, r.rs);
        html += '<div class="kukla-rams-wizard__hazard-score">' + htmlEscape(t('hazardScore')) + ': ' + initialScore + ' &rarr; ' + residualScore;
        if (!residualOk) {
          html += ' <span class="kukla-rams-wizard__warn">' + htmlEscape(t('residualMustBeLower')) + '</span>';
        }
        html += '</div>';
        html += '</div>';
      });
      body.innerHTML = html;
    }

    function renderRiskRow(label, hazardKey, lField, sField, lVal, sVal) {
      var html = '<div class="kukla-rams-wizard__risk-row">';
      html += '<div class="kukla-rams-wizard__risk-label">' + htmlEscape(label) + '</div>';
      html += '<div class="kukla-rams-wizard__risk-pills">';
      html += '<span class="kukla-rams-wizard__risk-axis">' + htmlEscape(t('hazardLikelihood')) + '</span>';
      for (var i = 1; i <= 5; i++) {
        html += '<button type="button" class="kukla-rams-wizard__pill ' + (lVal === i ? 'is-selected' : '') + '" data-risk="' + htmlEscape(hazardKey) + '" data-axis="' + lField + '" data-val="' + i + '">' + i + '</button>';
      }
      html += '</div>';
      html += '<div class="kukla-rams-wizard__risk-pills">';
      html += '<span class="kukla-rams-wizard__risk-axis">' + htmlEscape(t('hazardSeverity')) + '</span>';
      for (var j = 1; j <= 5; j++) {
        html += '<button type="button" class="kukla-rams-wizard__pill ' + (sVal === j ? 'is-selected' : '') + '" data-risk="' + htmlEscape(hazardKey) + '" data-axis="' + sField + '" data-val="' + j + '">' + j + '</button>';
      }
      html += '</div>';
      html += '</div>';
      return html;
    }

    function renderControls(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepControls')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepControlsSub')) + '</p>';
      var picked = Object.keys(state.selectedHazardKeys).filter(function (k) { return state.selectedHazardKeys[k]; });
      var hazardsByKey = {};
      (state.catalog.hazards || []).forEach(function (h) { hazardsByKey[h.key] = h; });
      picked.forEach(function (key) {
        var h = hazardsByKey[key];
        if (!h) return;
        var ctrls = (state.catalog.controls || []).filter(function (c) {
          if (!Array.isArray(c.applies_to_hazard_keys) || c.applies_to_hazard_keys.length === 0) return true;
          return c.applies_to_hazard_keys.indexOf(key) !== -1;
        });
        ctrls.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
        if (!state.hazardControls[key]) state.hazardControls[key] = {};
        html += '<div class="kukla-rams-wizard__hazard">';
        html += '<div class="kukla-rams-wizard__hazard-title">' + htmlEscape(h.label || h.key) + '</div>';
        html += '<div class="kukla-rams-wizard__choices">';
        ctrls.forEach(function (c) {
          var sel = !!state.hazardControls[key][c.key];
          html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-hazard-control="' + htmlEscape(key) + '" data-control="' + htmlEscape(c.key) + '" ' + (sel ? 'checked' : '') + '> <span>[' + htmlEscape(c.hierarchy || '') + '] ' + htmlEscape(c.label || c.key) + '</span></label>';
        });
        html += '</div></div>';
      });
      body.innerHTML = html;
    }

    function renderPpe(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepPpe')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepPpeSub')) + '</p>';
      html += '<div class="kukla-rams-wizard__choices">';
      var items = (state.catalog.ppe || []).slice().sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
      items.forEach(function (p) {
        var sel = !!state.selectedPpeKeys[p.key];
        html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-ppe="' + htmlEscape(p.key) + '" ' + (sel ? 'checked' : '') + '> <span>' + htmlEscape(p.label || p.key) + '</span></label>';
      });
      html += '</div>';
      body.innerHTML = html;
    }

    function renderEmergency(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepEmergency')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepEmergencySub')) + '</p>';
      html += '<div class="kukla-rams-wizard__choices">';
      var items = (state.catalog.emergency || []).slice().sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
      items.forEach(function (e) {
        var sel = !!state.selectedEmergencyKeys[e.topic_key || e.key];
        html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-emergency="' + htmlEscape(e.topic_key || e.key) + '" data-emergency-key="' + htmlEscape(e.key) + '" ' + (sel ? 'checked' : '') + '> <span>' + htmlEscape(e.label || e.topic_key || e.key) + '</span></label>';
      });
      html += '</div>';
      body.innerHTML = html;
    }

    function renderConfirm(body) {
      var html = '<h3 class="kukla-rams-wizard__step-title">' + htmlEscape(t('stepConfirm')) + '</h3>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('stepConfirmSub')) + '</p>';
      html += '<div class="kukla-rams-wizard__checklist">';
      [
        ['scope_understood', 'chk1'],
        ['hazards_checked', 'chk2'],
        ['ppe_ready', 'chk3'],
        ['emergency_known', 'chk4']
      ].forEach(function (row) {
        var key = row[0]; var label = t(row[1]);
        var sel = !!state.checklistAnswers[key];
        html += '<label class="kukla-rams-wizard__check ' + (sel ? 'is-selected' : '') + '"><input type="checkbox" data-checklist="' + key + '" ' + (sel ? 'checked' : '') + '> <span>' + htmlEscape(label) + '</span></label>';
      });
      html += '</div>';
      html += '<p class="kukla-rams-wizard__step-sub">' + htmlEscape(t('noteOptional')) + '</p>';
      body.innerHTML = html;
    }

    // Validierung pro Step
    function validateStep() {
      var key = STEPS[state.currentStep];
      switch (key) {
        case 'equipment':
          return !!state.selectedEquipmentKey;
        case 'activities':
          return Object.keys(state.selectedActivityKeys).some(function (k) { return state.selectedActivityKeys[k]; });
        case 'hazards':
          return Object.keys(state.selectedHazardKeys).some(function (k) { return state.selectedHazardKeys[k]; });
        case 'risks':
          var ok = true;
          Object.keys(state.selectedHazardKeys).forEach(function (k) {
            if (!state.selectedHazardKeys[k]) return;
            var r = state.hazardRisk[k];
            if (!r) { ok = false; return; }
            if (r.il < 1 || r.il > 5 || r.is < 1 || r.is > 5 || r.rl < 1 || r.rl > 5 || r.rs < 1 || r.rs > 5) { ok = false; return; }
            if (r.rl * r.rs >= r.il * r.is) ok = false;
          });
          return ok;
        case 'controls':
          var allOk = true;
          Object.keys(state.selectedHazardKeys).forEach(function (k) {
            if (!state.selectedHazardKeys[k]) return;
            var ctrls = state.hazardControls[k] || {};
            var anyPicked = Object.keys(ctrls).some(function (c) { return ctrls[c]; });
            if (!anyPicked) allOk = false;
          });
          return allOk;
        case 'ppe':
          return Object.keys(state.selectedPpeKeys).some(function (k) { return state.selectedPpeKeys[k]; });
        case 'emergency':
          return Object.keys(state.selectedEmergencyKeys).some(function (k) { return state.selectedEmergencyKeys[k]; });
        case 'confirm':
          return state.checklistAnswers.scope_understood
              && state.checklistAnswers.hazards_checked
              && state.checklistAnswers.ppe_ready
              && state.checklistAnswers.emergency_known;
      }
      return true;
    }

    function showError(msg) {
      var el = state.container.querySelector('#ramsWizardError');
      if (!el) return;
      if (!msg) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      var s = String(msg);
      var chunks = s.split(/\n\n+/);
      if (chunks.length < 2) {
        el.textContent = s;
        return;
      }
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
      var lead = document.createElement('strong');
      lead.className = 'kukla-rams-wizard__error-lead';
      lead.textContent = chunks[0].trim();
      el.appendChild(lead);
      var detail = document.createElement('div');
      detail.className = 'kukla-rams-wizard__error-detail';
      detail.textContent = chunks.slice(1).join('\n\n').trim();
      el.appendChild(detail);
    }

    function bindEvents() {
      var c = state.container;
      // Lang
      Array.prototype.forEach.call(c.querySelectorAll('[data-lang]'), function (b) {
        b.addEventListener('click', function () {
          var newLang = b.getAttribute('data-lang');
          if (newLang === state.lang) return;
          if (state.busy) return;
          if (typeof opts.onLanguageChange === 'function') {
            state.busy = true;
            Promise.resolve(opts.onLanguageChange(newLang)).then(function (res) {
              if (res && res.catalog) state.catalog = res.catalog;
              if (res && res.doc) state.doc = res.doc;
              state.lang = newLang;
              state.busy = false;
              render();
            }).catch(function (e) {
              state.busy = false;
              showError((e && e.message) ? e.message : t('genericErr'));
            });
          } else {
            state.lang = newLang;
            render();
          }
        });
      });
      // Cancel
      Array.prototype.forEach.call(c.querySelectorAll('[data-action="cancel"]'), function (b) {
        b.addEventListener('click', function () {
          if (typeof opts.onClose === 'function') opts.onClose();
        });
      });
      // Back
      var btnBack = c.querySelector('[data-action="back"]');
      if (btnBack) {
        btnBack.addEventListener('click', function () {
          if (state.busy) return;
          if (state.currentStep > 0) {
            state.currentStep--;
            render();
          }
        });
      }
      // Next
      var btnNext = c.querySelector('[data-action="next"]');
      if (btnNext) {
        btnNext.addEventListener('click', function () {
          if (state.busy) return;
          if (!validateStep()) {
            showError(stepErrorMessage());
            return;
          }
          showError(null);
          if (state.currentStep < STEPS.length - 1) {
            state.currentStep++;
            render();
          } else {
            finishWizard();
          }
        });
      }

      // Step-specific bindings
      Array.prototype.forEach.call(c.querySelectorAll('[data-order-idx]'), function (b) {
        b.addEventListener('click', function () {
          state.selectedOrderTypeIdx = parseInt(b.getAttribute('data-order-idx'), 10) || 0;
          render();
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-equipment]'), function (b) {
        b.addEventListener('click', function () {
          state.selectedEquipmentKey = b.getAttribute('data-equipment');
          render();
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-activity]'), function (i) {
        i.addEventListener('change', function () {
          var k = i.getAttribute('data-activity');
          state.selectedActivityKeys[k] = !!i.checked;
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-hazard]'), function (i) {
        i.addEventListener('change', function () {
          var k = i.getAttribute('data-hazard');
          state.selectedHazardKeys[k] = !!i.checked;
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-risk]'), function (b) {
        b.addEventListener('click', function () {
          var k = b.getAttribute('data-risk');
          var axis = b.getAttribute('data-axis');
          var val = clamp(parseInt(b.getAttribute('data-val'), 10) || 1, 1, 5);
          if (!state.hazardRisk[k]) state.hazardRisk[k] = { il: 3, is: 3, rl: 2, rs: 2 };
          state.hazardRisk[k][axis] = val;
          render();
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-hazard-control]'), function (i) {
        i.addEventListener('change', function () {
          var hk = i.getAttribute('data-hazard-control');
          var ck = i.getAttribute('data-control');
          if (!state.hazardControls[hk]) state.hazardControls[hk] = {};
          state.hazardControls[hk][ck] = !!i.checked;
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-ppe]'), function (i) {
        i.addEventListener('change', function () {
          state.selectedPpeKeys[i.getAttribute('data-ppe')] = !!i.checked;
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-emergency]'), function (i) {
        i.addEventListener('change', function () {
          state.selectedEmergencyKeys[i.getAttribute('data-emergency')] = !!i.checked;
        });
      });
      Array.prototype.forEach.call(c.querySelectorAll('[data-checklist]'), function (i) {
        i.addEventListener('change', function () {
          state.checklistAnswers[i.getAttribute('data-checklist')] = !!i.checked;
        });
      });
    }

    function stepErrorMessage() {
      var key = STEPS[state.currentStep];
      switch (key) {
        case 'risks': return t('residualMustBeLower');
        case 'controls': return t('noControlForHazard');
        case 'confirm': return t('validationFailed');
        default: return t('validationFailed');
      }
    }

    function buildPayload() {
      var orderTypes = TXT[state.lang].orderTypes;
      var orderType = orderTypes[clamp(state.selectedOrderTypeIdx, 0, orderTypes.length - 1)] || '';
      var eqLabel = '';
      (state.catalog.equipment_types || []).forEach(function (eq) {
        if (eq.key === state.selectedEquipmentKey) eqLabel = eq.label || eq.key;
      });
      var pattern = TXT[state.lang].scopePattern;
      var scopeText = pattern.replace('%ORDER%', orderType).replace('%EQUIPMENT%', eqLabel);

      // Activities
      var actTypes = state.catalog.activity_types || [];
      var actByKey = {};
      actTypes.forEach(function (a) { actByKey[a.key] = a; });
      var activities = Object.keys(state.selectedActivityKeys).filter(function (k) {
        return state.selectedActivityKeys[k];
      }).map(function (k, idx) {
        var a = actByKey[k];
        return {
          sort_order: (idx + 1) * 10,
          activity_type_key: k,
          description: (a && a.label) ? a.label : k
        };
      });

      // Hazards + embedded controls
      var hazardsByKey = {};
      (state.catalog.hazards || []).forEach(function (h) { hazardsByKey[h.key] = h; });
      var controlsByKey = {};
      (state.catalog.controls || []).forEach(function (c) { controlsByKey[c.key] = c; });

      var hazards = Object.keys(state.selectedHazardKeys).filter(function (k) {
        return state.selectedHazardKeys[k];
      }).map(function (k, idx) {
        var h = hazardsByKey[k] || {};
        var r = state.hazardRisk[k] || { il: 3, is: 3, rl: 2, rs: 2 };
        var picked = state.hazardControls[k] || {};
        var controls = Object.keys(picked).filter(function (ck) { return picked[ck]; }).map(function (ck, cidx) {
          var c = controlsByKey[ck] || {};
          return {
            sort_order: (cidx + 1) * 10,
            hierarchy: c.hierarchy || 'administrative',
            description: c.label || ck,
            catalog_control_key: ck
          };
        });
        return {
          sort_order: (idx + 1) * 10,
          category: h.category || 'general',
          subtype_key: h.subtype_key || null,
          description: h.label || k,
          possible_consequences: h.default_consequences || null,
          catalog_hazard_key: k,
          initial: { l: r.il, s: r.is },
          residual: { l: r.rl, s: r.rs },
          controls: controls
        };
      });

      // PPE
      var ppeByKey = {};
      (state.catalog.ppe || []).forEach(function (p) { ppeByKey[p.key] = p; });
      var ppe = Object.keys(state.selectedPpeKeys).filter(function (k) {
        return state.selectedPpeKeys[k];
      }).map(function (k, idx) {
        return { sort_order: (idx + 1) * 10, ppe_key: k };
      });

      // Emergency
      var emItems = (state.catalog.emergency || []);
      var emByTopic = {};
      emItems.forEach(function (e) {
        if (e && e.topic_key) emByTopic[e.topic_key] = e;
      });
      var emergency = Object.keys(state.selectedEmergencyKeys).filter(function (k) {
        return state.selectedEmergencyKeys[k];
      }).map(function (topicKey, idx) {
        var e = emByTopic[topicKey] || {};
        return {
          sort_order: (idx + 1) * 10,
          topic_key: topicKey,
          description: e.default_text || e.label || topicKey
        };
      });

      var payload = {
        id: state.doc && state.doc.id ? state.doc.id : null,
        document_id: state.doc ? state.doc.document_id : null,
        job_id: state.doc ? state.doc.job_id : null,
        revision: state.doc && state.doc.revision ? state.doc.revision : '1',
        revision_date: state.doc && state.doc.revision_date ? state.doc.revision_date : (new Date()).toISOString().slice(0, 10),
        language: state.lang,
        equipment_type_key: state.selectedEquipmentKey,
        scope_text: scopeText,
        activities: activities,
        hazards: hazards,
        ppe: ppe,
        emergency: emergency
      };
      // Authorizations werden vom Server (create_blank) bereits gesetzt;
      // hier nicht erneut mitschicken, sonst ueberschreibt save() die Slots.
      return payload;
    }

    function finishWizard() {
      if (state.busy) return;
      state.busy = true;
      showError(null);
      var payload = buildPayload();
      var saved = null;
      Promise.resolve().then(function () {
        return opts.onSavePayload(payload);
      }).then(function (savedDoc) {
        saved = savedDoc || { id: payload.id };
        return opts.onSubmit(saved.id || payload.id);
      }).then(function () {
        return opts.onSign(saved);
      }).then(function (signedDoc) {
        if (signedDoc && typeof signedDoc === 'object') {
          saved = signedDoc;
        }
        if (typeof opts.onCompletionPreview !== 'function') {
          throw new Error('RamsWizardCore: onCompletionPreview fehlt');
        }
        return opts.onCompletionPreview(saved);
      }).then(function (accepted) {
        state.busy = false;
        if (accepted === false) {
          if (typeof opts.onClose === 'function') {
            opts.onClose();
          }
          return;
        }
        renderFinished();
      }).catch(function (err) {
        state.busy = false;
        var msg = (err && err.message) ? err.message : t('genericErr');
        showError(msg);
        if (typeof opts.onError === 'function') opts.onError(err);
      });
    }

    function renderFinished() {
      var html = '<div class="kukla-rams-wizard">';
      html += '<div class="kukla-rams-wizard__header"><div class="kukla-rams-wizard__title">' + htmlEscape(t('finishedTitle')) + '</div></div>';
      html += '<div class="kukla-rams-wizard__body"><p>' + htmlEscape(t('finishedMsg')) + '</p></div>';
      html += '<div class="kukla-rams-wizard__footer">';
      html += '<button type="button" class="kukla-rams-wizard__btn kukla-rams-wizard__btn--primary" data-action="cancel">' + htmlEscape(t('cancel')) + '</button>';
      html += '</div></div>';
      state.container.innerHTML = html;
      bindEvents();
    }

    render();
  }

  window.RamsWizardCore = { open: open };
})();
