'use strict';

/**
 * Vergleichswerte aus einem älteren Serviceprotokoll.
 * Nur Anzeige. Diese Struktur wird nicht gespeichert und nicht ins PDF geschrieben.
 */

function cellText(value) {
  return value == null ? '' : String(value).trim();
}

function rowHas(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  return keys.some((key) => cellText(obj[key]) !== '');
}

function matrixHas(matrix) {
  if (!matrix || typeof matrix !== 'object') return false;
  return ['dms', 'tara', 'pruefgewicht'].some((key) =>
    rowHas(matrix[key], ['kg', 'mv', 'ma', 'g_prozent', 'g']),
  );
}

function priorHasComparisonValues(messwerte) {
  const mess = messwerte && typeof messwerte === 'object' ? messwerte : null;
  if (!mess) return false;
  if (cellText(mess.vers_spannung) || cellText(mess.sensitivitaet)) return true;
  if (matrixHas(mess.mess_matrix)) return true;
  if (Array.isArray(mess.waegezellen)) {
    const hit = mess.waegezellen.some(
      (cell) =>
        matrixHas(cell && cell.mess_matrix) ||
        cellText(cell && (cell.supplyVoltage || cell.vers_spannung)) ||
        cellText(cell && (cell.sensitivity || cell.sensitivitaet)),
    );
    if (hit) return true;
  }
  if (Array.isArray(mess.pruefgewichtstest) && mess.pruefgewichtstest.some((item) => cellText(item))) return true;
  if (
    Array.isArray(mess.wiegungen) &&
    mess.wiegungen.some((row) =>
      rowHas(row, ['bandwaage_kg', 'kontrollwaage_kg', 'fehler_kg', 'fehler_prozent', 'leistung_th', 'tara_kg', 'brutto_kg', 'bemerkung']),
    )
  ) {
    return true;
  }
  if (
    Array.isArray(mess.ketten) &&
    mess.ketten.some((row) => rowHas(row, ['tag', 'ketten_type', 'laenge', 'gewicht_pro_kette', 'gewicht_pro_meter']))
  ) {
    return true;
  }
  if (
    Array.isArray(mess.ketten_messungen) &&
    mess.ketten_messungen.some((row) =>
      rowHas(row, ['bandwaage_t', 'kg_pro_m', 'geschwindigkeit_ms', 'messzeit_s', 'bemerkung', 'pruefkette_t', 'fehler_prozent', 'leistung_th']),
    )
  ) {
    return true;
  }
  return false;
}

function messwerteFromDraftPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const mess = payload.messwerte;
  if (!mess || typeof mess !== 'object' || Array.isArray(mess)) return null;
  return mess;
}

function priorSortKey(record) {
  return cellText(record && record.datum).replace('T', ' ').slice(0, 19);
}

function chooseServiceprotokollPrior(localPrior, cachedPrior) {
  const local = localPrior && priorHasComparisonValues(localPrior.messwerte) ? localPrior : null;
  const cached = cachedPrior && priorHasComparisonValues(cachedPrior.messwerte) ? cachedPrior : null;
  if (!local) return cached;
  if (!cached) return local;
  if (priorSortKey(cached) > priorSortKey(local)) return cached;
  return local;
}

module.exports = {
  cellText,
  priorHasComparisonValues,
  messwerteFromDraftPayload,
  priorSortKey,
  chooseServiceprotokollPrior,
};
