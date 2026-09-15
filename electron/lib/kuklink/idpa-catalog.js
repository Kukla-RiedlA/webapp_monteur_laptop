'use strict';

/**
 * KUKLink-V2.0-Bezeichnungen und Wertformat (wie PAL-Download / 2007.pdf).
 * Roh-IdPa liefert Gerätnamen (Geschwindigk., SPRACHE/LANGU) und Rohwerte;
 * der Ausdruck nutzt diese Katalognamen.
 */

const LANG = {
  0: 'Deutsch',
  1: 'English',
  2: 'Francaise',
  3: 'Italiano',
  4: 'Espanol',
  5: 'Russian',
};

const COUNTER = {
  0: 'X.xxx kg',
  1: 'XX.xx kg',
  2: 'XX.xx t',
  3: 'XXX.x t',
  4: 'XXXX t',
};

const PULSE = {
  0: '50ms',
  1: '100ms',
  2: '200ms',
  3: '500ms',
  4: '1s',
};

/** Werte/Beschriftung wie KUKLink-2.8-PAL (nicht die alte C-Combobox). */
const OPTO = {
  3: 'Band laeuft',
  6: 'B=>0 Druck',
  7: 'C=>0 Druck',
};

const RELAIS = {
  0: 'Stoerung',
  2: 'MinBelegung',
};

const DA = {
  0: 'P1 Leistung',
};

const CATALOG = {
  100: { name: 'Nennleistung', unit: 'kg/h' },
  105: { name: 'Nennfrequenz', unit: 'Hz' },
  106: { name: 'Nenngeschwindigkeit', unit: 'mm/s' },
  107: { name: 'Bandlänge', unit: 'mm' },
  110: { name: 'Fabriknummer' },
  111: { name: 'Bedienungssprache', enums: LANG, enumStyle: 'eq-spaces' },
  116: { name: 'Software Version', format: 'swver' },
  120: { name: 'Minimale Belegung', unit: '%', scale: 100 },
  121: { name: 'Maximale Belegung', unit: '%', scale: 100 },
  122: { name: 'Waage leer', unit: '%', scale: 100 },
  123: { name: 'Zählsperre', unit: '%', scale: 100 },
  135: { name: 'Zählerimpuls', enums: COUNTER, enumStyle: 'eq' },
  136: { name: 'Zaehl-Multi.' },
  138: { name: 'Impulslänge', enums: PULSE, enumStyle: 'eq' },
  140: { name: 'Prüfgewicht', unit: '%', scale: 100 },
  200: { name: 'OFFSET Wiegekanal' },
  202: { name: 'SPAN Wiegekanal' },
  240: { name: 'ITG-Geschwindigkeit' },
  250: { name: 'ITG AD1' },
  400: { name: 'U1', enums: OPTO, enumStyle: 'eq-left' },
  401: { name: 'U2', enums: OPTO, enumStyle: 'eq-left' },
  402: { name: 'U3', enums: OPTO, enumStyle: 'eq-left' },
  403: { name: 'U4', enums: OPTO, enumStyle: 'eq-left' },
  404: { name: 'U5', enums: OPTO, enumStyle: 'eq-left' },
  405: { name: 'U6', enums: OPTO, enumStyle: 'eq-left' },
  409: { name: 'Invert OPTO', format: 'bit7' },
  420: { name: 'K1', enums: RELAIS, enumStyle: 'eq-left' },
  421: { name: 'K2', enums: RELAIS, enumStyle: 'eq-left' },
  422: { name: 'K3', enums: RELAIS, enumStyle: 'eq-left' },
  423: { name: 'K4', enums: RELAIS, enumStyle: 'eq-left' },
  429: { name: 'Invert RELAIS', format: 'bit7' },
  460: { name: 'DA-Offset', enums: DA, enumStyle: 'eq-left' },
  470: { name: 'DA1 OFFSET' },
  471: { name: 'DA1 SPAN' },
  522: { name: 'Tacho - Sim', unit: 'Hz' },
  700: { name: 'Bus-AdresseDP' },
  999: { name: 'Pruefsumme' },
};

function linName(parId) {
  if (parId >= 551 && parId <= 562) return 'Lin ' + (parId - 550) * 10 + '%';
  return '';
}

function catalogEntry(parId) {
  if (CATALOG[parId]) return CATALOG[parId];
  const lin = linName(parId);
  if (lin) return { name: lin };
  return null;
}

function formatSwVer(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return String(raw);
  const hex = n.toString(16).toUpperCase();
  if (hex.length < 3) return String(raw);
  return hex.slice(0, -2) + '.' + hex.slice(-2);
}

function formatBit7(raw) {
  if (/^&B/i.test(String(raw))) return String(raw);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return String(raw);
  return '&B' + n.toString(2).padStart(7, '0');
}

function scaleNum(raw, scale) {
  if (!scale) return String(raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  const v = n / scale;
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

function formatEnum(raw, enums, style) {
  if (!enums) return String(raw);
  const n = parseInt(raw, 10);
  const label = enums[n];
  if (!label) return String(raw);
  if (style === 'eq') return n + '=' + label;
  if (style === 'eq-left') return n + ' =' + label;
  return n + ' = ' + label;
}

function applyCatalog(row) {
  const entry = catalogEntry(row.parId);
  if (!entry) return row;
  const out = Object.assign({}, row);
  if (entry.name) out.name = entry.name;
  if (entry.unit) out.unit = entry.unit;
  if (entry.scale) {
    out.value = scaleNum(row.value, entry.scale);
    out.min = scaleNum(row.min, entry.scale);
    out.max = scaleNum(row.max, entry.scale);
  }
  if (entry.format === 'swver') out.value = formatSwVer(row.value);
  if (entry.format === 'bit7') out.value = formatBit7(row.value);
  if (entry.enums) out.value = formatEnum(out.value, entry.enums, entry.enumStyle);
  return out;
}

module.exports = {
  catalogEntry,
  applyCatalog,
  formatSwVer,
  formatBit7,
};
