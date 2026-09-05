'use strict';

/**
 * Types D-DW / V-DG-1 (inkl. Varianten wie D-DW-1ASG-800) haben Behälter-Nenninhalt.
 * @param {unknown} type
 * @returns {boolean}
 */
function anlagenstammTypeHasBehaelterNenninhalt(type) {
  const t = String(type || '')
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!t) return false;
  if (/^D-?DW(?:$|[^A-Z])/.test(t)) return true;
  if (/V-?DG-?1(?:$|[^0-9])/.test(t)) return true;
  return false;
}

/**
 * Protokoll-Kopf v-max: bei D-DW / V-DG-1 aus Behälter-Nenninhalt, sonst Nenngeschwindigkeit.
 * @param {{ type?: unknown, behaelter_nenninhalt?: unknown, nenngeschwindigkeit?: unknown }|null|undefined} row
 * @returns {string}
 */
function anlagenstammVmaxValueFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  if (anlagenstammTypeHasBehaelterNenninhalt(row.type)) {
    return row.behaelter_nenninhalt != null ? String(row.behaelter_nenninhalt).trim() : '';
  }
  return row.nenngeschwindigkeit != null ? String(row.nenngeschwindigkeit).trim() : '';
}

function anlagenstammVmaxLabel(type, lang) {
  const en = String(lang || '').toLowerCase() === 'en';
  if (anlagenstammTypeHasBehaelterNenninhalt(type)) {
    return en ? 'Vessel nom. capacity' : 'Behälter Nenninhalt';
  }
  return 'v max';
}

module.exports = {
  anlagenstammTypeHasBehaelterNenninhalt,
  anlagenstammVmaxValueFromRow,
  anlagenstammVmaxLabel,
};
