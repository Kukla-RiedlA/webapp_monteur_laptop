'use strict';

/**
 * Gemeinsame Druck-HTML für Zeitschreibung (Browser-Druck und Freigabe-PDF).
 * Layout/CSS 1:1 wie openPrintWindow in view-zeitschreibung.js.
 */

const calc = require('./zeitschreibung-calc');

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtHours(n) {
  const v = calc.num(n);
  if (!v) return '';
  return String(Math.round(v * 1000) / 1000);
}

function fmtHoursAlways(n) {
  return String(Math.round(calc.num(n) * 1000) / 1000);
}

function summeAlertClass(daySumValue) {
  const v = calc.num(daySumValue);
  if (v > 12.01) return ' zs-sum-high';
  if (v > 10) return ' zs-sum-warn';
  return '';
}

function rowClassForDay(d) {
  let rowClass = '';
  if (String(d.holiday_label || '').trim()) rowClass = ' zs-row-holiday';
  else if (d.weekday === 'So') rowClass = ' zs-row-so';
  else if (d.weekday === 'Sa') rowClass = ' zs-row-sa';
  if (Number(d.lohn_gesperrt)) rowClass += ' zs-row-locked';
  return rowClass.trim();
}

/** CSS-Block wie im Druckfenster (A4 Querformat). */
function getPrintCss() {
  return (
    '@page{size:A4 landscape;margin:14mm 3mm 3mm 3mm;}' +
    'html,body{margin:0;padding:0;background:#fff;}' +
    'body{padding:0;font-family:Segoe UI,system-ui,sans-serif;color:#111;}' +
    '*,*::before,*::after{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important;}' +
    'h1{margin:0 0 2mm;font-size:12pt;font-weight:700;}' +
    'table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt;line-height:1.2;}' +
    'th,td{border:1px solid #94a3b8;padding:1px 2px;vertical-align:middle;white-space:nowrap;box-sizing:border-box;overflow:visible;}' +
    'thead tr.zs-head-groups th{background:#e3f5ed!important;color:#007a4d!important;font-size:7.5pt;text-align:center;}' +
    'thead tr.zs-head-cols th{background:#eefaf5!important;color:#007a4d!important;font-weight:600;font-size:7.5pt;}' +
    'tfoot th,tfoot td{background:#eefaf5!important;color:#007a4d!important;font-weight:700;}' +
    'tfoot td[colspan]{text-align:left;overflow:visible;padding-left:3px;}' +
    'tbody tr.zs-row-sa td{background:#fff8d6!important;}' +
    'tbody tr.zs-row-so td{background:#fde9df!important;}' +
    'tbody tr.zs-row-holiday td{background:#ffb3b3!important;}' +
    'tbody tr.zs-row-locked:not(.zs-row-sa):not(.zs-row-so):not(.zs-row-holiday) td{background:#eefaf5!important;}' +
    'td.zs-sum,th.zs-col-sum,.zs-col-hour{text-align:center;}' +
    'th[data-col="tag"],td[data-col="tag"],th[data-col="wt"],td[data-col="wt"]{text-align:center;}' +
    '.zs-col-bemerkung,.zs-col-lohn{white-space:normal!important;overflow:hidden;text-overflow:ellipsis;}' +
    '.zs-col-status{text-align:center;}' +
    '.zs-sep-after{border-right:3px solid #334155!important;}' +
    '.zs-lock-check-icon,.no-print{display:none!important;}' +
    '.zs-print-status{display:inline!important;font-weight:700;color:#007a4d!important;}' +
    '@media print{body{padding:0;}}'
  );
}

function buildColgroupHtml() {
  const fixedLeft = 8 + 8 + 24;
  const hourCols = calc.HOUR_FIELDS.length + 1;
  const fixedHours = hourCols * 11;
  const fixedSta = 8;
  const usable = 291;
  let rest = usable - fixedLeft - fixedHours - fixedSta;
  if (rest < 60) rest = 60;
  const bemMm = Math.round(rest * 0.48);
  const lohnMm = rest - bemMm;
  const colWidths = [8, 8, 24];
  for (let i = 0; i < hourCols; i++) colWidths.push(11);
  colWidths.push(bemMm);
  colWidths.push(lohnMm);
  colWidths.push(8);
  return (
    '<colgroup>' +
    colWidths.map((mm) => '<col style="width:' + mm + 'mm">').join('') +
    '</colgroup>'
  );
}

function buildTableHtml(days, sums) {
  const hourHeaders = calc.HOUR_FIELDS.map((f) => {
    const sep = f === 'weg' || f === 'arzt' ? ' zs-sep-after' : '';
    const labels = {
      anw: 'Anw.',
      montage: 'Montage',
      ue50: 'Ü 50 %',
      ue100: 'Ü 100 %',
      weg: 'Weg',
      urlaub: 'Urlaub',
      za_plus: 'ZA +',
      za_minus: 'ZA −',
      krank: 'Krank',
      arzt: 'Arzt',
    };
    return (
      '<th class="zs-col-hour' +
      sep +
      '" data-col="' +
      f +
      '">' +
      escapeHtml(labels[f] || f) +
      '</th>'
    );
  }).join('');

  let body = '';
  for (const d of days || []) {
    const locked = !!Number(d.lohn_gesperrt);
    const sumVal = d.day_sum != null ? d.day_sum : calc.daySumEffective(d);
    const sumCls = summeAlertClass(sumVal);
    const dk = String(d.day_date || '');
    const dayNum = dk.length >= 10 ? String(parseInt(dk.slice(8, 10), 10)) : dk;
    const hours = calc.HOUR_FIELDS.map((f) => {
      const sep = f === 'weg' || f === 'arzt' ? ' zs-sep-after' : '';
      return (
        '<td class="zs-col-hour' +
        sep +
        '" data-col="' +
        f +
        '">' +
        escapeHtml(fmtHours(d[f])) +
        '</td>'
      );
    }).join('');
    const status = locked
      ? '<td class="zs-col-status zs-print-status" data-col="status">✓</td>'
      : '<td class="zs-col-status zs-print-status" data-col="status">–</td>';
    body +=
      '<tr class="' +
      escapeHtml(rowClassForDay(d)) +
      '" data-day-date="' +
      escapeHtml(dk) +
      '">' +
      '<td data-col="tag">' +
      escapeHtml(dayNum) +
      '</td>' +
      '<td data-col="wt">' +
      escapeHtml(d.weekday || '') +
      '</td>' +
      '<td class="zs-sep-after" data-col="feiertag">' +
      escapeHtml(d.holiday_label || '') +
      '</td>' +
      hours +
      '<td class="zs-sum zs-sep-after' +
      sumCls +
      '" data-col="summe">' +
      escapeHtml(fmtHours(sumVal)) +
      '</td>' +
      '<td class="zs-col-bemerkung" data-col="bemerkung">' +
      escapeHtml(d.bemerkung || '') +
      '</td>' +
      '<td class="zs-col-lohn" data-col="lohn_kommentar">' +
      escapeHtml(d.lohn_kommentar || '') +
      '</td>' +
      status +
      '</tr>';
  }

  const footHours = calc.HOUR_FIELDS.map((f) => {
    const sep = f === 'weg' || f === 'arzt' ? ' zs-sep-after' : '';
    return (
      '<td class="zs-col-hour' +
      sep +
      '">' +
      escapeHtml(fmtHoursAlways(sums[f])) +
      '</td>'
    );
  }).join('');

  return (
    '<table class="zs-table">' +
    buildColgroupHtml() +
    '<thead>' +
    '<tr class="zs-head-groups">' +
    '<th colspan="3" scope="colgroup">Datum</th>' +
    '<th colspan="5" scope="colgroup">Arbeits- und Reisezeit</th>' +
    '<th colspan="5" scope="colgroup">Abwesenheit und Zeitkonto</th>' +
    '<th colspan="1" scope="colgroup">Ergebnis</th>' +
    '<th colspan="3" scope="colgroup">Informationen</th>' +
    '</tr>' +
    '<tr class="zs-head-cols">' +
    '<th data-col="tag">Tag</th>' +
    '<th data-col="wt">WT</th>' +
    '<th class="zs-sep-after" data-col="feiertag">Feiertag</th>' +
    hourHeaders +
    '<th class="zs-col-sum zs-sep-after" data-col="summe">Summe</th>' +
    '<th data-col="bemerkung">Bemerkung</th>' +
    '<th class="zs-col-lohn" data-col="lohn_kommentar">Komm. BH</th>' +
    '<th class="zs-col-status" data-col="status">STA</th>' +
    '</tr>' +
    '</thead>' +
    '<tbody>' +
    body +
    '</tbody>' +
    '<tfoot><tr>' +
    '<td colspan="3">Monatssumme</td>' +
    footHours +
    '<td class="zs-col-sum zs-sep-after">' +
    escapeHtml(fmtHoursAlways(sums.day_sum)) +
    '</td>' +
    '<td></td><td class="zs-col-lohn"></td><td class="zs-col-status"></td>' +
    '</tr></tfoot>' +
    '</table>'
  );
}

/**
 * Vollständiges HTML-Dokument wie im Druckfenster.
 * @param {{ title?: string, year?: number, month?: number, technicianName?: string, days?: object[], sums?: object, gesamt?: number }} payload
 */
function buildPrintDocumentHtml(payload) {
  const year = Number(payload.year);
  const month = Number(payload.month);
  const name = String(payload.technicianName || '');
  const days = (Array.isArray(payload.days) ? payload.days : []).map(calc.enrichDay);
  const sums = payload.sums || calc.columnSumsEffective(days);
  const monLabel = calc.MONTH_NAMES[month] || String(month);
  const title =
    String(payload.title || '').trim() ||
    ('Monatsübersicht – ' + monLabel + ' ' + year + ' – ' + name);

  return (
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<title>' +
    escapeHtml(title) +
    '</title>' +
    '<style>' +
    getPrintCss() +
    '</style></head><body>' +
    '<h1>' +
    escapeHtml(title) +
    '</h1>' +
    buildTableHtml(days, sums) +
    '</body></html>'
  );
}

module.exports = {
  getPrintCss,
  buildPrintDocumentHtml,
  buildTableHtml,
  escapeHtml,
};
