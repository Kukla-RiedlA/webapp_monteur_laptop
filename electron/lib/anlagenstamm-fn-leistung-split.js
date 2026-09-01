'use strict';

/**
 * Gleiche Heuristik wie dispo/inc/anlagenstamm_fn_leistung_split.php:
 * FN 4-stellig bis 9999, 5-stellig ab 10000. 99xxx = 4-stellige FN + Leistung.
 */

const UNIT_RE = /(?:t\/h|kg|m[³3]|cha|\/h)/iu;

function digitsOnly(s) {
  return String(s || '').replace(/\D+/g, '');
}

function normalizeFabText(fab) {
  let out = String(fab || '').replace(/\r\n|\r|\n/g, ' ');
  out = out.replace(/[∕⁄／]/g, '/');
  out = out.replace(/\s+/gu, ' ');
  return out.trim();
}

function restIsCapacity(rest) {
  const r = String(rest || '').trim();
  if (r === '') return false;
  if (UNIT_RE.test(r)) return true;
  if (/^[A-Za-z]([+\-/ ]*[A-Za-z])*$/u.test(r)) return false;
  if (/^-[A-Za-z0-9]+$/u.test(r)) return false;
  if (/^[\/.,;:_-]+$/u.test(r)) return false;
  if (/\d/u.test(r)) return true;
  return false;
}

function isUnitOnly(s) {
  const t = String(s || '').trim();
  if (t === '' || /\d/u.test(t)) return false;
  return restIsCapacity(t);
}

function gluedFnLen(leadingDigits, tail) {
  const n = leadingDigits.length;
  if (n <= 5) return n;
  const five = leadingDigits.slice(0, 5);
  const after = leadingDigits.slice(5) + String(tail || '');
  const afterDigits = digitsOnly(after);
  if (Number(five) >= 99000 || afterDigits === '' || /^0+$/.test(afterDigits)) {
    return 4;
  }
  return 5;
}

function trySplitMerged(fabrikationsnummer, defaultFnDigits = 5) {
  const fab = normalizeFabText(fabrikationsnummer);
  if (fab === '') return null;
  const max = defaultFnDigits > 0 ? defaultFnDigits : 5;

  const spaced = fab.match(new RegExp('^(\\d{1,' + max + '})\\s+(.+)$', 'u'));
  if (spaced) {
    const leist = spaced[2].trim();
    if (restIsCapacity(leist)) {
      return { fabrikationsnummer: spaced[1], leistung: leist };
    }
  }

  const glued = fab.match(/^(\d{6,})(.*)$/u);
  if (glued) {
    const digits = glued[1];
    const tail = glued[2].trim();
    const len = gluedFnLen(digits, tail);
    const fn = digits.slice(0, len);
    const restNum = digits.slice(len);
    let rest;
    if (tail === '') rest = restNum;
    else if (restNum === '' || tail.startsWith(',') || tail.startsWith('.')) rest = restNum + tail;
    else rest = (restNum + ' ' + tail).trim();
    rest = String(rest || '').trim();
    if (rest.startsWith(',')) rest = '0' + rest;
    if (rest !== '' && restIsCapacity(rest)) {
      return { fabrikationsnummer: fn, leistung: rest };
    }
  }

  const fivePlus = fab.match(new RegExp('^(\\d{' + max + '})(.+)$', 'u'));
  if (fivePlus) {
    let rest = fivePlus[2].trim();
    if (rest === '') return null;
    if (rest.startsWith(',')) rest = '0' + rest;
    if (!restIsCapacity(rest)) return null;
    return { fabrikationsnummer: fivePlus[1], leistung: rest };
  }

  return null;
}

function normalizeRow(fabrikationsnummer, leistung, defaultFnDigits = 5) {
  const fn = String(fabrikationsnummer || '').trim();
  let leist = String(leistung == null ? '' : leistung).trim();
  if (fn === '') return { fabrikationsnummer: '', leistung: leist };
  const split = trySplitMerged(fn, defaultFnDigits);
  if (!split) return { fabrikationsnummer: fn, leistung: leist };
  const newFn = String(split.fabrikationsnummer || '').trim();
  const splitLeist = String(split.leistung || '').trim();
  if (leist === '') {
    leist = splitLeist;
  } else if (isUnitOnly(leist) && /\d/u.test(splitLeist)) {
    if (UNIT_RE.test(splitLeist)) leist = splitLeist;
    else leist = (splitLeist + ' ' + leist).trim();
  }
  return {
    fabrikationsnummer: newFn !== '' ? newFn : fn,
    leistung: leist,
  };
}

function looksMerged(fabrikationsnummer) {
  const fab = String(fabrikationsnummer || '').trim();
  if (fab === '') return false;
  return trySplitMerged(fab) !== null;
}

module.exports = {
  digitsOnly,
  normalizeFabText,
  restIsCapacity,
  isUnitOnly,
  gluedFnLen,
  trySplitMerged,
  normalizeRow,
  looksMerged,
};
