'use strict';

/**
 * Protokoll-PDF-Dateinamen: Typ (übersetzt) zuerst, dann Auftrag/FN/Datum, dann DE|GB.
 * Montagebericht: Montage_Bericht_2026-09-06_Test_Sunstwo_AT_DE.pdf
 *                 Assembly_report_2026-09-06_Test_Sunstwo_AT_GB.pdf
 */

const PROTOCOL_PDF_LABELS = {
  montagebericht: { de: 'Montage_Bericht', en: 'Assembly_report' },
  serviceprotokoll: { de: 'Serviceprotokoll', en: 'Service_protocol' },
  inbetriebnahme: { de: 'Inbetriebnahmeprotokoll', en: 'Commissioning_report' },
  kontrollwiegung: { de: 'Kontrollwiegungsprotokoll', en: 'Calibration_protocol' },
  schleppketten: { de: 'Schleppketten_Test', en: 'Chain_calibration' },
  pruefzertifikat: { de: 'Pruefzertifikat', en: 'Inspection_certificate' },
  arbeitsnachweis: { de: 'Arbeitsnachweis', en: 'Working_report' },
};

function protocolLangCode(lang) {
  return String(lang || 'de').toLowerCase() === 'en' ? 'GB' : 'DE';
}

function protocolPdfTypeLabel(kind, lang) {
  const labels = PROTOCOL_PDF_LABELS[String(kind || '')];
  const isEn = String(lang || '').toLowerCase() === 'en';
  if (!labels) return isEn ? 'Protocol' : 'Protokoll';
  return isEn ? labels.en : labels.de;
}

function compactProtocolDate(datum) {
  return String(datum || '').replace(/-/g, '');
}

function safeProtocolFab(fab) {
  return String(fab || '').replace(/[^\w.-]+/g, '_') || 'ohneFN';
}

/** Stem ohne .pdf: Montage_Bericht_<fileBase>_DE */
function montageberichtExportStem(fileBase, lang) {
  const base = String(fileBase || '')
    .replace(/\.pdf$/i, '')
    .replace(/\.docx$/i, '')
    .trim() || 'Dokument';
  return protocolPdfTypeLabel('montagebericht', lang) + '_' + base + '_' + protocolLangCode(lang);
}

function montageberichtPdfFilename(fileBase, lang) {
  return montageberichtExportStem(fileBase, lang) + '.pdf';
}

function isCurrentMontageberichtExportName(name) {
  return /^(Montage_Bericht_|Assembly_report_).+_(DE|GB)\.(pdf|docx)$/i.test(String(name || ''));
}

function isMontageberichtExportName(name) {
  const n = String(name || '');
  if (isCurrentMontageberichtExportName(n)) return true;
  return (
    /_Montage_DE\.(pdf|docx)$/i.test(n) ||
    /_Assembly_report_GB\.(pdf|docx)$/i.test(n) ||
    /_report_GB\.(pdf|docx)$/i.test(n) ||
    /^Montagebericht_(DE|EN)\.(pdf|docx)$/i.test(n)
  );
}

function isLegacyMontageberichtExportName(name) {
  const n = String(name || '');
  if (!n || isCurrentMontageberichtExportName(n)) return false;
  return isMontageberichtExportName(n);
}

/** FN-Protokolle: Type_FN_YYYYMMDD_DE.pdf */
function fnProtocolPdfFilename(kind, fab, datum, lang) {
  return (
    protocolPdfTypeLabel(kind, lang) +
    '_' +
    safeProtocolFab(fab) +
    '_' +
    compactProtocolDate(datum) +
    '_' +
    protocolLangCode(lang) +
    '.pdf'
  );
}

function labeledProtocolPdfFilename(kind, ident, lang) {
  const id = String(ident || '').replace(/[^\w.-]+/g, '_') || 'Dokument';
  return protocolPdfTypeLabel(kind, lang) + '_' + id + '_' + protocolLangCode(lang) + '.pdf';
}

function serviceLikePdfKind(spec) {
  const key = String((spec && (spec.routeKey || spec.entityType)) || '').toLowerCase();
  if (key.indexOf('inbetriebnahme') >= 0) return 'inbetriebnahme';
  return 'serviceprotokoll';
}

module.exports = {
  PROTOCOL_PDF_LABELS,
  protocolLangCode,
  protocolPdfTypeLabel,
  montageberichtExportStem,
  montageberichtPdfFilename,
  isCurrentMontageberichtExportName,
  isMontageberichtExportName,
  isLegacyMontageberichtExportName,
  fnProtocolPdfFilename,
  labeledProtocolPdfFilename,
  serviceLikePdfKind,
};
