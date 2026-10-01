'use strict';

/**
 * Kalendertag für den Dienstreise-Ordner (YYYY-MM-DD).
 * Dispo/Kalender liefern ISO, date-only oder deutsch „TT.MM.JJJJ[ HH:MM]“.
 * Fehlt ein gültiger Beginn, zählt das Ende — die Maske zeigt dann genau dieses Datum.
 */

function isRealCalendarDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1990 || y > 2100) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function coerceIsoDatePart(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (iso && isRealCalendarDate(iso[1], iso[2], iso[3])) {
    return iso[1] + '-' + iso[2] + '-' + iso[3];
  }
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/);
  if (de && isRealCalendarDate(de[3], de[2], de[1])) {
    return de[3] + '-' + String(de[2]).padStart(2, '0') + '-' + String(de[1]).padStart(2, '0');
  }
  return '';
}

function jobFolderDatePart(startRaw, endRaw) {
  return coerceIsoDatePart(startRaw) || coerceIsoDatePart(endRaw);
}

module.exports = {
  coerceIsoDatePart,
  jobFolderDatePart,
};
