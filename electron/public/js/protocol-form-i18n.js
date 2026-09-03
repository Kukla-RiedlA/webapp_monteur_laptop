/**
 * Protokoll-Eingabemaske DE/EN.
 * Maskensprache: nur Englisch, wenn EN aktiv und DE nicht (DE+EN bleibt Deutsch).
 */
(function (global) {
  function maskLangFromChecks(deId, enId) {
    var deEl = document.getElementById(deId);
    var enEl = document.getElementById(enId);
    if (enEl && enEl.checked && !(deEl && deEl.checked)) return 'en';
    return 'de';
  }

  function maskLangFromRadios(name) {
    var r = document.querySelector('input[name="' + name + '"]:checked');
    return r && r.value === 'en' ? 'en' : 'de';
  }

  function t(lang, de, en) {
    return lang === 'en' ? (en != null && en !== '' ? en : de) : de;
  }

  function pleaseSelect(lang) {
    return t(lang, '– Bitte wählen –', '– Please select –');
  }

  function getNodeText(el) {
    if (!el) return '';
    if (!el.children.length) return String(el.textContent || '').trim();
    for (var n = el.lastChild; n; n = n.previousSibling) {
      if (n.nodeType === 3 && String(n.textContent || '').trim()) {
        return String(n.textContent).trim();
      }
    }
    return String(el.textContent || '').trim();
  }

  function setNodeText(el, text) {
    if (!el) return;
    if (!el.children.length) {
      el.textContent = text;
      return;
    }
    var lastText = null;
    for (var n = el.lastChild; n; n = n.previousSibling) {
      if (n.nodeType === 3 && String(n.textContent || '').trim()) {
        lastText = n;
        break;
      }
    }
    if (lastText) {
      lastText.textContent = (/^\s/.test(lastText.textContent) ? ' ' : '') + text;
      return;
    }
    el.appendChild(document.createTextNode(' ' + text));
  }

  function applyDataAttrs(root, lang) {
    if (!root) return;
    root.querySelectorAll('[data-i18n-en]').forEach(function (el) {
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (el.dataset.i18nDe == null) el.dataset.i18nDe = getNodeText(el);
      setNodeText(el, lang === 'en' ? el.getAttribute('data-i18n-en') : el.dataset.i18nDe);
    });
    root.querySelectorAll('[data-i18n-placeholder-en]').forEach(function (el) {
      if (el.dataset.i18nPlaceholderDe == null) el.dataset.i18nPlaceholderDe = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', lang === 'en' ? el.getAttribute('data-i18n-placeholder-en') : el.dataset.i18nPlaceholderDe);
    });
    root.querySelectorAll('[data-i18n-title-en]').forEach(function (el) {
      if (el.dataset.i18nTitleDe == null) el.dataset.i18nTitleDe = el.getAttribute('title') || '';
      el.setAttribute('title', lang === 'en' ? el.getAttribute('data-i18n-title-en') : el.dataset.i18nTitleDe);
    });
    root.querySelectorAll('[data-i18n-aria-en]').forEach(function (el) {
      if (el.dataset.i18nAriaDe == null) el.dataset.i18nAriaDe = el.getAttribute('aria-label') || '';
      el.setAttribute('aria-label', lang === 'en' ? el.getAttribute('data-i18n-aria-en') : el.dataset.i18nAriaDe);
    });
  }

  function applyEntry(root, lang, entry) {
    if (!root || !entry || !entry.sel) return;
    var nodes = root.querySelectorAll(entry.sel);
    var attr = entry.attr || 'text';
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (attr === 'placeholder') {
        if (el.dataset.i18nPlaceholderDe == null) el.dataset.i18nPlaceholderDe = el.getAttribute('placeholder') || '';
        el.setAttribute('placeholder', lang === 'en' ? entry.en : el.dataset.i18nPlaceholderDe);
      } else if (attr === 'title') {
        if (el.dataset.i18nTitleDe == null) el.dataset.i18nTitleDe = el.getAttribute('title') || '';
        el.setAttribute('title', lang === 'en' ? entry.en : el.dataset.i18nTitleDe);
      } else if (attr === 'aria') {
        if (el.dataset.i18nAriaDe == null) el.dataset.i18nAriaDe = el.getAttribute('aria-label') || '';
        el.setAttribute('aria-label', lang === 'en' ? entry.en : el.dataset.i18nAriaDe);
      } else {
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') continue;
        if (el.dataset.i18nDe == null) el.dataset.i18nDe = getNodeText(el);
        setNodeText(el, lang === 'en' ? entry.en : el.dataset.i18nDe);
      }
    }
  }

  var FORMS = {
    arbeitsnachweis: {
      root: 'viewProtokolleArbeitsnachweis',
      radios: 'anLang',
      map: [
        { sel: '#anSec1Title', en: 'Job & identification' },
        { sel: 'label[for="anJob"]', en: 'Job' },
        { sel: '#anLangCaption', en: 'Language' },
        { sel: '#anForm .an-hint', en: 'The job is only used for prefilling. No job number appears on the PDF. All serial numbers and types of the job are shown on the report.' },
        { sel: '#anSec2Title', en: 'Header data' },
        { sel: 'label[for="anCustomer"]', en: 'Customer' },
        { sel: 'label[for="anSite"]', en: 'Site' },
        { sel: 'label[for="anTech"]', en: 'KUKLA technician' },
        { sel: 'label[for="anCar"]', en: 'Car' },
        { sel: 'label[for="anLiving"]', en: 'Daily allowances' },
        { sel: '#anLiving', attr: 'placeholder', en: 'Free text' },
        { sel: 'label[for="anStartKm"]', en: 'Start km' },
        { sel: 'label[for="anEndKm"]', en: 'End km' },
        { sel: 'label[for="anTotalKm"]', en: 'Total km' },
        { sel: '#anOvernightCaption', en: 'Overnight accommodation provided' },
        { sel: '#anSec3Title', en: 'Work' },
        { sel: '#anWorkTable thead th:nth-child(1)', en: 'Date' },
        { sel: '#anWorkTable thead th:nth-child(2)', en: 'From' },
        { sel: '#anWorkTable thead th:nth-child(3)', en: 'To' },
        { sel: '#anWorkTable thead th:nth-child(4)', en: 'Work performed' },
        { sel: '#anWorkTable thead th:nth-child(5)', en: 'Regular hrs' },
        { sel: '#anWorkTable tfoot td:first-child', en: 'Total' },
        { sel: '#btnAnAddWork', en: '+ Work row' },
        { sel: '#anSec4Title', en: 'Spare parts' },
        { sel: '#anPartsTable thead th:nth-child(1)', en: 'Qty' },
        { sel: '#anPartsTable thead th:nth-child(2)', en: 'Description' },
        { sel: '#anPartsTable thead th:nth-child(4)', en: 'Comment' },
        { sel: '#btnAnAddPart', en: '+ Spare part' },
        { sel: '#anSec5Title', en: 'Remarks' },
        { sel: 'label[for="anRemarks"]', en: 'Remarks' },
        { sel: '#anSec6Title', en: 'Confirmation & signatures' },
        { sel: '#anSignerContactLabel', en: 'Site contact' },
        { sel: 'label[for="anSignerName"]', en: 'Customer name' },
        { sel: 'label[for="anSignerEmail"]', en: 'Email' },
        { sel: '#btnAnPreview', en: 'Customer preview' },
        { sel: '#anPreviewTitle', en: 'Customer preview' },
        { sel: '#anSigLabel', en: 'Customer signature' },
        { sel: '#btnAnSigClear', en: 'Clear signature' },
        { sel: '#btnAnSign', en: 'Sign' },
        { sel: '#btnAnPreviewClose', en: 'Close' },
        { sel: '#btnAnSave', en: 'Save' },
        { sel: '#btnAnPdf', en: 'PDF' },
        { sel: '#anConfirmText', en: 'The customer confirms the working hours, executed works and, where applicable, spare parts stated in this working report.' },
        { sel: '.sp-v2-page-title > span:first-of-type', en: 'Working report' }
      ]
    },
    montagebericht: {
      root: 'viewProtokolleMontagebericht',
      de: 'montageberichtLangDe',
      en: 'montageberichtLangEn',
      map: [
        { sel: '.sp-v2-page-title', en: 'Assembly report' },
        { sel: '#btnMontageberichtStickySave', en: 'Save (JSON)' },
        { sel: '#btnMontageberichtStickySave', attr: 'title', en: 'Save data only (JSON)' },
        { sel: '#btnMontageberichtStickyPdf', en: 'Single PDF' },
        { sel: '#btnMontageberichtStickyPdf', attr: 'title', en: 'Save data and generate PDF' },
        { sel: '#btnMontageberichtSaveAllPdfTop', en: 'All PDFs' },
        { sel: '#btnMontageberichtSaveAllPdfTop', attr: 'title', en: 'Write PDF into all FN folders' },
        { sel: '.mb-v2-tb-sidebar', attr: 'aria', en: 'Text modules' },
        { sel: '.mb-v2-tb-sidebar-head', en: 'Text modules' },
        { sel: '#montageberichtTbCategory', attr: 'aria', en: 'Text module category' },
        { sel: '#montageberichtTbCategory option[value=""]', en: 'All' },
        { sel: '#mbV2Sec1Title', en: 'Job & identification' },
        { sel: 'label[for="montageberichtJob"]', en: 'Job' },
        { sel: 'label[for="montageberichtProjekt"]', en: 'Project' },
        { sel: 'label[for="montageberichtProjekt"] .muted', en: '(required)' },
        { sel: '#montageberichtProjekt', attr: 'placeholder', en: 'From equipment master or manual' },
        { sel: '#montageberichtLangLabel', en: 'Language' },
        { sel: '#mbV2Sec1Title + .sp-v2-section-body > .mb-v2-hint-block', en: 'When saving, the project is set in the equipment master in Dispo for all serial numbers of the job.' },
        { sel: '#mbV2Sec2Title', en: 'Report content' },
        { sel: 'label[for="montageberichtGrund"]', en: 'Purpose of visit' },
        { sel: 'label[for="montageberichtBemerkungen"]', en: 'Remarks' },
        { sel: '#btnCopilotCheckText', en: 'Check text' },
        { sel: '#mbV2Sec3Title', en: 'Serial numbers' },
        { sel: '#mbToolbarFont', attr: 'title', en: 'Font' },
        { sel: '#mbToolbarSize', attr: 'title', en: 'Font size' },
        { sel: '[data-mb-cmd="bold"]', attr: 'title', en: 'Bold' },
        { sel: '[data-mb-cmd="italic"]', attr: 'title', en: 'Italic' },
        { sel: '[data-mb-cmd="underline"]', attr: 'title', en: 'Underline' },
        { sel: '[data-mb-cmd="insertUnorderedList"]', attr: 'title', en: 'Bullet list' },
        { sel: '[data-mb-cmd="insertUnorderedList"]', en: '• List' },
        { sel: '[data-mb-cmd="insertOrderedList"]', attr: 'title', en: 'Numbered list' },
        { sel: '[data-mb-cmd="insertOrderedList"]', en: '1. List' },
        { sel: '[data-mb-cmd="justifyLeft"]', attr: 'title', en: 'Align left' },
        { sel: '[data-mb-cmd="justifyLeft"]', en: 'Left' },
        { sel: '[data-mb-cmd="justifyCenter"]', attr: 'title', en: 'Center' },
        { sel: '[data-mb-cmd="justifyCenter"]', en: 'Center' },
        { sel: '[data-mb-cmd="justifyRight"]', attr: 'title', en: 'Align right' },
        { sel: '[data-mb-cmd="justifyRight"]', en: 'Right' },
        { sel: '[data-mb-img="insert"]', attr: 'title', en: 'Insert image from device' },
        { sel: '[data-mb-img="insert"]', en: 'Image' },
        { sel: '[data-mb-img="from-project"]', attr: 'title', en: 'Photos from the project folder (mobile PWA)' },
        { sel: '[data-mb-img="from-project"]', en: 'Project photo' },
        { sel: '[data-mb-img="25"]', attr: 'title', en: 'Image width 25 %' },
        { sel: '[data-mb-img="50"]', attr: 'title', en: 'Image width 50 %' },
        { sel: '[data-mb-img="100"]', attr: 'title', en: 'Image width 100 %' },
        { sel: '[data-mb-img="rotate"]', attr: 'title', en: 'Rotate image 90°' },
        { sel: '[data-mb-img="rotate"]', en: 'Rotate' },
        { sel: '[data-mb-img="remove"]', attr: 'title', en: 'Remove image' },
        { sel: '[data-mb-img="remove"]', en: 'Remove' },
        { sel: '#mbV2Sec4Title', en: 'Save' },
        { sel: '#btnMontageberichtSaveJson', en: 'Save (JSON)' },
        { sel: '#btnMontageberichtSaveJson', attr: 'title', en: 'Save data only (JSON)' },
        { sel: '#btnMontageberichtSavePdf', en: 'Single PDF' },
        { sel: '#btnMontageberichtSavePdf', attr: 'title', en: 'Save data and generate PDF' },
        { sel: '#btnMontageberichtSaveAllPdf', en: 'All PDFs' },
        { sel: '#btnMontageberichtPdf', en: 'Open PDF' },
        { sel: '#btnMontageberichtPdf', attr: 'title', en: 'Open PDF in the protocols folder' },
        { sel: '#btnMontageberichtAbbrechen', en: 'Cancel' }
      ]
    },
    kontrollwiegung: {
      root: 'viewProtokolleKontrollwiegungen',
      de: 'kontrollwiegungLangDe',
      en: 'kontrollwiegungLangEn',
      map: [
        { sel: '.sp-v2-page-title', en: 'Calibration protocol' },
        { sel: '#btnKontrollwiegungStickySave', en: 'Save (JSON)' },
        { sel: '#btnKontrollwiegungStickySave', attr: 'title', en: 'Save data only' },
        { sel: '#btnKontrollwiegungStickyPdf', en: 'Single PDF' },
        { sel: '#btnKontrollwiegungStickyPdf', attr: 'title', en: 'Save data and generate PDF' },
        { sel: '#btnKontrollwiegungSaveAllPdfTop', en: 'All PDFs' },
        { sel: '#kwV2Sec1Title', en: 'Job & identification' },
        { sel: 'label[for="kontrollwiegungJob"]', en: 'Job' },
        { sel: '#kontrollwiegungJob option[value=""]', en: '– Please select –' },
        { sel: 'label[for="kontrollwiegungProjekt"]', en: 'Project' },
        { sel: '#kontrollwiegungProjekt', attr: 'placeholder', en: 'From equipment master or manual' },
        { sel: 'label[for="kontrollwiegungDatum"]', en: 'Date' },
        { sel: '#kontrollwiegungLangLabel', en: 'Language' },
        { sel: '#kontrollwiegungFabGroup > label', en: 'Serial number' },
        { sel: '#kontrollwiegungFabButtons', attr: 'aria', en: 'Select serial number' },
        { sel: '#kwV2Sec2Title', en: 'Header data' },
        { sel: 'label[for="kontrollwiegungType"]', en: 'Type' },
        { sel: 'label[for="kontrollwiegungLeistung"]', en: 'Capacity' },
        { sel: 'label[for="kontrollwiegungElektronik"]', en: 'Electronics' },
        { sel: 'label[for="kontrollwiegungTeilung"]', en: 'Control scale division' },
        { sel: 'label[for="kontrollwiegungBereichMax"]', en: 'Range max' },
        { sel: 'label[for="kontrollwiegungLetzteEichung"]', en: 'Last verification' },
        { sel: '#kwV2Sec3Title', en: 'Weighings' },
        { sel: '#kontrollwiegungAddRow', en: '+ Add weighing' },
        { sel: '.kw-wiegung-table', attr: 'aria', en: 'Weighings' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(2)', en: 'Belt scale [kg]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(3)', en: 'Control scale [kg]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(4)', en: 'Error [kg]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(5)', en: 'Error [%]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(6)', en: 'Capacity [t/h]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(7)', en: 'Tare [kg]' },
        { sel: '.kw-wiegung-table thead th.kw-col-num:nth-of-type(8)', en: 'Gross [kg]' },
        { sel: '.kw-wiegung-table thead th.kw-col-bem', en: 'Remark' },
        { sel: '[data-kw-sum-label]', en: 'Sum of selected weighings' },
        { sel: '#kwV2Sec4Title', en: 'Save & export' },
        { sel: '#btnKontrollwiegungSaveJson', en: 'Save (JSON)' },
        { sel: '#btnKontrollwiegungSavePdf', en: 'Single PDF' },
        { sel: '#btnKontrollwiegungSaveAllPdf', en: 'All PDFs' },
        { sel: '#kontrollwiegungPdf', en: 'Open PDF' },
        { sel: '#kontrollwiegungAbbrechen', en: 'Cancel' }
      ]
    },
    schleppketten: {
      root: 'viewProtokolleSchleppketten',
      de: 'schleppkettenLangDe',
      en: 'schleppkettenLangEn',
      map: [
        { sel: '.sp-v2-page-title', en: 'Chain calibration' },
        { sel: '#btnSchleppkettenStickySave', en: 'Save (JSON)' },
        { sel: '#btnSchleppkettenStickyPdf', en: 'Single PDF' },
        { sel: '#btnSchleppkettenSaveAllPdf', en: 'All PDFs' },
        { sel: '#skV2Sec1Title', en: 'Job & identification' },
        { sel: 'label[for="schleppkettenJob"]', en: 'Job' },
        { sel: '#schleppkettenJob option[value=""]', en: '– Please select –' },
        { sel: 'label[for="schleppkettenProjekt"]', en: 'Project' },
        { sel: '#schleppkettenProjekt', attr: 'placeholder', en: 'From equipment master or manual' },
        { sel: 'label[for="schleppkettenDatum"]', en: 'Date' },
        { sel: '#schleppkettenLangLabel', en: 'Language' },
        { sel: '#schleppkettenFabGroup > label', en: 'Serial number' },
        { sel: '#skV2Sec2Title', en: 'Header data' },
        { sel: 'label[for="schleppkettenType"]', en: 'Type' },
        { sel: 'label[for="schleppkettenLeistung"]', en: 'Capacity' },
        { sel: 'label[for="schleppkettenElektronik"]', en: 'Electronics' },
        { sel: 'label[for="schleppkettenWaagenart"]', en: 'Scale type' },
        { sel: 'label[for="schleppkettenPosNr"]', en: 'Pos. no.' },
        { sel: 'label[for="schleppkettenGn"]', en: 'GN' },
        { sel: 'label[for="schleppkettenMonteur"]', en: 'Service engineer' },
        { sel: '#skV2Sec3Title', en: 'Chain data' },
        { sel: '#schleppkettenAddKette', en: '+ Add chain' },
        { sel: '.sk-ketten-table', attr: 'aria', en: 'Chain data' },
        { sel: '.sk-ketten-table thead th.sk-col-ketten-tag', en: 'Tag (name)' },
        { sel: '.sk-ketten-table thead th.sk-col-ketten-type', en: 'Chain type' },
        { sel: '.sk-ketten-table thead th.sk-col-num:nth-of-type(4)', en: 'Length' },
        { sel: '.sk-ketten-table thead th.sk-col-num:nth-of-type(5)', en: 'Weight / chain' },
        { sel: '.sk-ketten-table thead th.sk-col-num:nth-of-type(6)', en: 'Weight / metre' },
        { sel: '#schleppkettenKettenSummeRow td.sk-col-ketten-tag', en: 'Sum of selected chains' },
        { sel: '#skV2Sec4Title', en: 'Measurements' },
        { sel: '#schleppkettenAddRow', en: '+ Add measurement' },
        { sel: '.sk-mess-table:not(.sk-ketten-table)', attr: 'aria', en: 'Chain calibration measurements' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(2)', en: 'Belt scale [t]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(3)', en: 'Test chain [t]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(5)', en: 'Speed [m/s]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(6)', en: 'Measuring time [s]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(7)', en: 'Error [%]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-num:nth-of-type(8)', en: 'Capacity [t/h]' },
        { sel: '.sk-mess-table:not(.sk-ketten-table) thead th.sk-col-bem', en: 'Remark' },
        { sel: '#schleppkettenSummeRow td.sk-col-bem', en: 'Sum of selected measurements' },
        { sel: '#skV2Sec5Title', en: 'Save & export' },
        { sel: '#btnSchleppkettenSaveJson', en: 'Save (JSON)' },
        { sel: '#btnSchleppkettenSavePdf', en: 'Single PDF' },
        { sel: '#btnSchleppkettenSaveAllPdfFooter', en: 'All PDFs' },
        { sel: '#schleppkettenPdf', en: 'Open PDF' },
        { sel: '#schleppkettenAbbrechen', en: 'Cancel' }
      ]
    },
    pruefzertifikat: {
      root: 'viewProtokollePruefzertifikat',
      de: 'pzPdfDe',
      en: 'pzPdfEn',
      map: [
        { sel: '.sp-v2-page-title', en: 'Manufacturer Inspection Certificate' },
        { sel: '#btnPruefzertifikatPrefill', en: 'Prefill from protocols' },
        { sel: '#btnPruefzertifikatPrefill', attr: 'title', en: 'Take data from check weighing / chain test / service' },
        { sel: '#btnPruefzertifikatStickySave', en: 'Save (JSON)' },
        { sel: '#btnPruefzertifikatStickyPdf', en: 'Single PDF' },
        { sel: '#btnPruefzertifikatSaveAllPdfTop', en: 'All PDFs' },
        { sel: '#pzV2Sec1Title', en: 'Job & certificate' },
        { sel: 'label[for="pruefzertifikatJob"]', en: 'Job' },
        { sel: '#pruefzertifikatJob option[value=""]', en: '– Please select –' },
        { sel: 'label[for="pruefzertifikatNr"]', en: 'Certificate no.' },
        { sel: 'label[for="pruefzertifikatDatum"]', en: 'Inspection date' },
        { sel: 'label[for="pruefzertifikatNaechste"]', en: 'Next inspection' },
        { sel: 'label[for="pruefzertifikatProjekt"]', en: 'Project' },
        { sel: 'label[for="pruefzertifikatKunde"]', en: 'Customer' },
        { sel: 'label[for="pruefzertifikatStandort"]', en: 'Site' },
        { sel: '#pruefzertifikatLangLabel', en: 'Language' },
        { sel: '#pruefzertifikatFabGroup > label', en: 'Serial number' },
        { sel: '#pruefzertifikatFabGroup > label .muted', en: '(choose FN for certificate)' },
        { sel: '#pzV2Sec2Title', en: 'Equipment data' },
        { sel: 'label[for="pruefzertifikatType"]', en: 'Type' },
        { sel: 'label[for="pruefzertifikatPosNr"]', en: 'Pos. no.' },
        { sel: 'label[for="pruefzertifikatElektronik"]', en: 'Electronics / DWC' },
        { sel: 'label[for="pruefzertifikatLeistung"]', en: 'Rated capacity' },
        { sel: 'label[for="pruefzertifikatWaagenart"]', en: 'Scale type' },
        { sel: 'label[for="pruefzertifikatMonteur"]', en: 'Technician' },
        { sel: '#pzV2Sec3Title', en: 'Inspection methods & results' },
        { sel: '.pz-verfahren-toggles', attr: 'aria', en: 'Inspection methods' },
        { sel: '.pz-verfahren-toggles > span', en: 'Method' },
        { sel: '#pzBlockKw .pz-verfahren-block-title', en: 'Control weighing' },
        { sel: 'label[for="pzKwFehler"]', en: 'Error [%]' },
        { sel: 'label[for="pzKwAnzahl"]', en: 'Count' },
        { sel: 'label[for="pzKwDatum"]', en: 'Date' },
        { sel: 'label[for="pzLetzteEichung"]', en: 'Last verification of control scale' },
        { sel: '#pzBlockSk .pz-verfahren-block-title', en: 'Chain calibration test' },
        { sel: 'label[for="pzSkFehler"]', en: 'Error [%]' },
        { sel: 'label[for="pzSkAnzahl"]', en: 'Count' },
        { sel: 'label[for="pzSkDatum"]', en: 'Date' },
        { sel: '#pzBlockSp .pz-verfahren-block-title', en: 'Service protocol' },
        { sel: '#pzBlockSp .pz-verfahren-block-hint', en: 'Load cell readings and test-load test from the service protocol (editable).' },
        { sel: '#pzBlockSp .sp-mess-table', attr: 'aria', en: 'Load cell measurements' },
        { sel: '#pzBlockSp .sp-mess-table thead th:nth-child(1)', en: 'Point' },
        { sel: '#pzBlockSp .sp-mess-table tbody tr:nth-child(1) th', en: 'Load cell released' },
        { sel: '#pzBlockSp .sp-mess-table tbody tr:nth-child(2) th', en: 'Tare' },
        { sel: '#pzBlockSp .sp-mess-table tbody tr:nth-child(3) th', en: 'Test load' },
        { sel: '#pzBlockSp .sp-v2-pgtest-head', en: 'Test with test load — deviation (%)' },
        { sel: 'label[for="pzToleranz"]', en: 'Max. permissible error [%]' },
        { sel: 'label[for="pzStatus"]', en: 'Result' },
        { sel: '#pzStatus option[value=""]', en: '– n/a –' },
        { sel: '#pzStatus option[value="1"]', en: 'Passed' },
        { sel: '#pzStatus option[value="0"]', en: 'Failed' },
        { sel: 'label[for="pzPruefmittel"]', en: 'Test means / traceability' },
        { sel: '#pzPruefmittel', attr: 'placeholder', en: 'Control scale / test chain …' },
        { sel: 'label[for="pzBemerkungen"]', en: 'Remarks' },
        { sel: 'label[for="pzKonformitaet"]', en: 'Statement of conformity' },
        { sel: '#pzProfileSigEmpty', en: 'No profile signature' },
        { sel: '#btnPzSigOverrideClear', en: 'Clear' },
        { sel: '#pzV2Sec4Title', en: 'Save & PDF' },
        { sel: '#btnPruefzertifikatSaveData', en: 'Save (JSON)' },
        { sel: '#btnPruefzertifikatSavePdf', en: 'Single PDF' },
        { sel: '#btnPruefzertifikatSaveAllPdf', en: 'All PDFs' },
        { sel: '#pruefzertifikatAbbrechen', en: 'Cancel' }
      ]
    },
    service: {
      root: 'viewProtokolleService',
      de: 'spPdfDe',
      en: 'spPdfEn',
      map: [
        { sel: '.sp-v2-page-title', en: 'Service protocol' },
        { sel: '#btnServiceprotokollStickySave', en: 'Save' },
        { sel: '#btnServiceprotokollStickyPdf', en: 'Single PDF' },
        { sel: '#btnServiceprotokollSaveAllPdfTop', en: 'All PDFs' },
        { sel: '#spV2Sec1Title', en: 'Job & identification' },
        { sel: 'label[for="serviceprotokollJob"]', en: 'Job' },
        { sel: '#serviceprotokollJob option[value=""]', en: '– Please select –' },
        { sel: 'label[for="serviceprotokollProjekt"]', en: 'Project' },
        { sel: '#serviceprotokollProjekt', attr: 'placeholder', en: 'From equipment master or manual' },
        { sel: 'label[for="serviceprotokollDatum"]', en: 'Date' },
        { sel: '#serviceprotokollLangLabel', en: 'Language' },
        { sel: '#serviceprotokollFabGroup > label', en: 'Serial number' },
        { sel: '#spV2Sec2Title', en: 'Equipment data' },
        { sel: 'label[for="serviceprotokollType"]', en: 'Type' },
        { sel: 'label[for="serviceprotokollQmax"]', en: 'Qmax' },
        { sel: 'label[for="serviceprotokollVmax"]', en: 'v max' },
        { sel: 'label[for="serviceprotokollPos"]', en: 'Pos. no.' },
        { sel: 'label[for="serviceprotokollDwc"]', en: 'DWC' },
        { sel: '#serviceprotokollVmax', attr: 'placeholder', en: 'from equipment master' },
        { sel: '#spV2Sec3Title', en: 'Load cell & readings' },
        { sel: 'label[for="spMessSeriennummer"]', en: 'Serial number' },
        { sel: 'label[for="spMessVersSpannung"]', en: 'Supply voltage V' },
        { sel: 'label[for="spMessSensitivitaet"]', en: 'Sensitivity mV/V' },
        { sel: '#spV2Sec4Title', en: 'Test with test load' },
        { sel: '#serviceprotokollLegacyHost .sp-v2-pgtest-head', en: 'Test with test load — deviation (%)' },
        { sel: '#spV2Sec5Title', en: 'Work steps' },
        { sel: '#spV2Sec5Title + .sp-v2-section-body .sp-v2-steps-head strong', en: 'Check points' },
        { sel: '#spV2Sec5Title + .sp-v2-section-body .sp-v2-steps-head .muted', en: 'OK / n.i.O. / n.a. – remark if needed' },
        { sel: '.sp-steps-table', attr: 'aria', en: 'Work steps' },
        { sel: '.sp-steps-table thead th.sp-col-nr', en: 'No.' },
        { sel: '.sp-steps-table thead th.sp-col-status', en: 'Result' },
        { sel: '.sp-steps-table thead th.sp-col-text', en: 'Work step' },
        { sel: '.sp-steps-table thead th.sp-col-bem', en: 'Remark' },
        { sel: '#btnSpAddFromCatalog', en: '+ Step' },
        { sel: '#btnSpResetSteps', en: 'Reset list' },
        { sel: 'label[for="serviceprotokollBemerkungen"]', en: 'General remarks' },
        { sel: '#spV2Sec6Title', en: 'Closing' },
        { sel: '.sp-v2-status-group legend', en: 'Status' },
        { sel: 'label[for="serviceprotokollAbschlussBemerkungen"]', en: 'Remarks' },
        { sel: 'label[for="serviceprotokollMonteur"]', en: 'Technician' },
        { sel: '#spProfileSigEmpty', en: 'No profile signature – please add it under Settings' },
        { sel: '[data-sp-sig-clear]', en: 'Clear' },
        { sel: '#btnServiceprotokollSavePdf', en: 'Single PDF' },
        { sel: '#btnServiceprotokollSaveAllPdf', en: 'All PDFs' },
        { sel: '#btnServiceprotokollSaveJson', en: 'Save' },
        { sel: '#serviceprotokollAbbrechen', en: 'Cancel' }
      ]
    }
  };

  function langOf(cfg) {
    if (!cfg) return 'de';
    if (cfg.radios) return maskLangFromRadios(cfg.radios);
    if (cfg.de && cfg.en) return maskLangFromChecks(cfg.de, cfg.en);
    return 'de';
  }

  function applyForm(key) {
    var cfg = FORMS[key];
    if (!cfg) return 'de';
    var root = document.getElementById(cfg.root);
    if (!root) return 'de';
    var lang = langOf(cfg);
    root.setAttribute('data-form-lang', lang);
    root.setAttribute('lang', lang);
    applyDataAttrs(root, lang);
    var map = cfg.map || [];
    for (var i = 0; i < map.length; i++) applyEntry(root, lang, map[i]);
    applyOvernightAndSaveContact(root, lang, key);
    applyLangCheckLabels(root, lang);
    root.querySelectorAll('textarea, [contenteditable="true"]').forEach(function (el) {
      el.setAttribute('lang', lang);
    });
    return lang;
  }

  function applyOvernightAndSaveContact(root, lang, key) {
    if (key !== 'arbeitsnachweis') return;
    var overnight = root.querySelectorAll('input[name="anOvernight"]');
    overnight.forEach(function (inp) {
      var lab = inp.closest('label');
      if (!lab) return;
      if (lab.dataset.i18nDe == null) lab.dataset.i18nDe = getNodeText(lab);
      setNodeText(lab, lang === 'en' ? (inp.value === '1' ? 'Yes' : 'No') : lab.dataset.i18nDe);
    });
    var save = root.querySelector('#anSaveContact');
    if (save) {
      var slab = save.closest('label');
      if (slab) {
        if (slab.dataset.i18nDe == null) slab.dataset.i18nDe = getNodeText(slab);
        setNodeText(slab, lang === 'en' ? 'Save as site contact' : slab.dataset.i18nDe);
      }
    }
  }

  function applyLangCheckLabels(root, lang) {
    var labels = root.querySelectorAll('.mb-lang-check, .an-radio-opts label');
    labels.forEach(function (lab) {
      var inp = lab.querySelector('input[type="checkbox"], input[type="radio"]');
      if (!inp) return;
      var v = String(inp.value || '').toLowerCase();
      if (v !== 'de' && v !== 'en') return;
      if (lab.dataset.i18nDe == null) lab.dataset.i18nDe = getNodeText(lab);
      setNodeText(lab, lang === 'en' ? (v === 'en' ? 'English' : 'German') : lab.dataset.i18nDe);
    });
    var verfahren = root.querySelectorAll('.pz-verfahren-toggles label');
    verfahren.forEach(function (lab) {
      var inp = lab.querySelector('input[type="checkbox"]');
      if (!inp) return;
      if (lab.dataset.i18nDe == null) lab.dataset.i18nDe = getNodeText(lab);
      var en = '';
      if (inp.id === 'pzVerfahrenKw') en = 'Control weighing';
      else if (inp.id === 'pzVerfahrenSk') en = 'Chain calibration test';
      else if (inp.id === 'pzVerfahrenSp') en = 'Service protocol';
      else if (inp.id === 'pzVerfahrenIbn') en = 'Commissioning';
      if (en) setNodeText(lab, lang === 'en' ? en : lab.dataset.i18nDe);
    });
    var statusLabs = root.querySelectorAll('input[name="serviceprotokollStatus"]');
    statusLabs.forEach(function (inp) {
      var lab = inp.closest('label');
      if (!lab) return;
      if (lab.dataset.i18nDe == null) lab.dataset.i18nDe = getNodeText(lab);
      var en = inp.value === 'justiert' ? 'Adjusted' : inp.value === 'mangel' ? 'Defect found' : 'Checked';
      setNodeText(lab, lang === 'en' ? en : lab.dataset.i18nDe);
    });
    var sigToggle = root.querySelectorAll('#pzSigOverrideToggle, #spSigOverrideToggle');
    sigToggle.forEach(function (inp) {
      var lab = inp.closest('label');
      if (!lab) return;
      if (lab.dataset.i18nDe == null) lab.dataset.i18nDe = getNodeText(lab);
      var en = inp.id === 'pzSigOverrideToggle' ? 'Redraw for this certificate' : 'Redraw for this protocol';
      setNodeText(lab, lang === 'en' ? en : lab.dataset.i18nDe);
    });
  }

  function applyByRootId(rootId) {
    var keys = Object.keys(FORMS);
    for (var i = 0; i < keys.length; i++) {
      if (FORMS[keys[i]].root === rootId) return applyForm(keys[i]);
    }
    return 'de';
  }

  function applyFromChecks(deId, enId) {
    var keys = Object.keys(FORMS);
    for (var i = 0; i < keys.length; i++) {
      var cfg = FORMS[keys[i]];
      if (cfg.de === deId && cfg.en === enId) return applyForm(keys[i]);
    }
    var deEl = document.getElementById(deId);
    var root = deEl && deEl.closest('.view-protokolle-sub, .view-protokolle');
    if (root) return applyByRootId(root.id);
    return maskLangFromChecks(deId, enId);
  }

  function autosaveHint(ok, lang, clock) {
    if (ok) return t(lang, 'Zuletzt gespeichert: ', 'Last saved: ') + (clock || '–');
    return t(lang, 'Speichern fehlgeschlagen', 'Save failed');
  }

  function langForView(viewId) {
    var keys = Object.keys(FORMS);
    for (var i = 0; i < keys.length; i++) {
      if (FORMS[keys[i]].root === viewId) return langOf(FORMS[keys[i]]);
    }
    return 'de';
  }

  function bindForm(key) {
    var cfg = FORMS[key];
    if (!cfg) return;
    function refresh() { applyForm(key); }
    if (cfg.de && cfg.en) {
      [cfg.de, cfg.en].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || el.dataset.formI18nBound) return;
        el.dataset.formI18nBound = '1';
        el.addEventListener('change', refresh);
      });
    }
    if (cfg.radios) {
      document.querySelectorAll('input[name="' + cfg.radios + '"]').forEach(function (el) {
        if (el.dataset.formI18nBound) return;
        el.dataset.formI18nBound = '1';
        el.addEventListener('change', refresh);
      });
    }
    refresh();
  }

  function bindAll() {
    Object.keys(FORMS).forEach(bindForm);
  }

  global.ProtocolFormI18n = {
    maskLangFromChecks: maskLangFromChecks,
    maskLangFromRadios: maskLangFromRadios,
    t: t,
    pleaseSelect: pleaseSelect,
    applyForm: applyForm,
    applyByRootId: applyByRootId,
    applyFromChecks: applyFromChecks,
    autosaveHint: autosaveHint,
    langForView: langForView,
    bindAll: bindAll,
    FORMS: FORMS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }
})(window);
