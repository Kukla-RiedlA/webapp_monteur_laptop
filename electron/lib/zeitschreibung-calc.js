'use strict';

/** Monatsnamen wie in der Excel-Vorlage (österreichisch). */
const MONTH_NAMES = [
  '',
  'Jänner',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const HOUR_FIELDS = [
  'anw',
  'montage',
  'ue50',
  'ue100',
  'weg',
  'urlaub',
  'za_plus',
  'za_minus',
  'krank',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseDateKey(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

/** Katholisches Ostersonntag (Gregorianisch). */
function easterSunday(year) {
  const y = Number(year);
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year: y, month, day };
}

function addDays(ymd, days) {
  const dt = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

/**
 * AT-Feiertage inkl. beweglicher Feiertage (wie Excel-Blatt Ferienberechnung).
 * @returns {Map<string, string>} dateKey -> Kurzlabel
 */
function austrianHolidays(year) {
  const map = new Map();
  const put = (ymd, label) => {
    map.set(toDateKey(ymd.year, ymd.month, ymd.day), label);
  };
  const easter = easterSunday(year);
  put({ year, month: 1, day: 1 }, 'Neujahr');
  put({ year, month: 1, day: 6 }, 'Hl. Dreikönige');
  put(easter, 'Ostersonntag');
  put(addDays(easter, 1), 'Ostermontag');
  put({ year, month: 5, day: 1 }, 'Staatsfeiertag');
  put(addDays(easter, 39), 'Ch.Himmelf.');
  put(addDays(easter, 49), 'Pfingstsonntag');
  put(addDays(easter, 50), 'Pfingstsmon.');
  put(addDays(easter, 60), 'Frohenleichnam');
  put({ year, month: 8, day: 15 }, 'Maria Himmelf.');
  put({ year, month: 10, day: 26 }, 'Nationalfeiertag');
  put({ year, month: 11, day: 1 }, 'Allerheiligen');
  put({ year, month: 12, day: 8 }, 'Maria Empf.');
  put({ year, month: 12, day: 24 }, 'Heiliger Abend');
  put({ year, month: 12, day: 25 }, 'Weihnachten');
  put({ year, month: 12, day: 26 }, 'Stefani');
  put({ year, month: 12, day: 31 }, 'Silvester');
  return map;
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Tageszeile: SUM(Anw..Urlaub) + ZA- + Krank — ZA+ zählt nicht. */
function daySum(row) {
  const r = row || {};
  return (
    num(r.anw) +
    num(r.montage) +
    num(r.ue50) +
    num(r.ue100) +
    num(r.weg) +
    num(r.urlaub) +
    num(r.za_minus) +
    num(r.krank)
  );
}

function columnSums(rows) {
  const sums = {
    anw: 0,
    montage: 0,
    ue50: 0,
    ue100: 0,
    weg: 0,
    urlaub: 0,
    za_plus: 0,
    za_minus: 0,
    krank: 0,
    day_sum: 0,
  };
  for (const row of rows || []) {
    for (const f of HOUR_FIELDS) sums[f] += num(row[f]);
    sums.day_sum += daySum(row);
  }
  return sums;
}

/** Monat Gesamt: Anw+Montage+Ü50+Ü100+Weg − Urlaub + ZA+ − ZA− − Krank */
function gesamtSum(sums) {
  const s = sums || {};
  return (
    num(s.anw) +
    num(s.montage) +
    num(s.ue50) +
    num(s.ue100) +
    num(s.weg) -
    num(s.urlaub) +
    num(s.za_plus) -
    num(s.za_minus) -
    num(s.krank)
  );
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * @returns {Array<object>} leere Tageszeilen für den Monat
 */
function buildMonthDays(year, month, existingByDate) {
  const y = Number(year);
  const m = Number(month);
  const holidays = austrianHolidays(y);
  const byDate = existingByDate && typeof existingByDate === 'object' ? existingByDate : {};
  const out = [];
  const n = daysInMonth(y, m);
  for (let d = 1; d <= n; d++) {
    const dateKey = toDateKey(y, m, d);
    // JS: getUTCDay Sun=0 → ISO Mo=0..So=6
    const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const prev = byDate[dateKey] || {};
    const row = {
      day_date: dateKey,
      weekday: WEEKDAYS[wd],
      holiday_label: holidays.get(dateKey) || '',
      anw: num(prev.anw),
      montage: num(prev.montage),
      ue50: num(prev.ue50),
      ue100: num(prev.ue100),
      weg: num(prev.weg),
      urlaub: num(prev.urlaub),
      za_plus: num(prev.za_plus),
      za_minus: num(prev.za_minus),
      krank: num(prev.krank),
      bemerkung: prev.bemerkung != null ? String(prev.bemerkung) : '',
      lohn_gesperrt: prev.lohn_gesperrt ? 1 : 0,
    };
    row.day_sum = daySum(row);
    out.push(row);
  }
  return out;
}

function fileStem(year, month, fullName) {
  const mm = pad2(month);
  const mon = MONTH_NAMES[month] || String(month);
  const namePart = String(fullName || 'Monteur')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*]/g, '');
  return `${mm}_${mon}_${year}_${namePart}`;
}

function folderRel(year, month) {
  const mm = pad2(month);
  const mon = MONTH_NAMES[month] || String(month);
  return pathJoinSafe(`Zeitaufzeichnung ${year}`, `${mm}_${mon}`);
}

function pathJoinSafe(...parts) {
  return parts.filter(Boolean).join('/');
}

function round2(n) {
  return Math.round(num(n) * 1000) / 1000;
}

/**
 * Zeilenfarben wie Excel-Bedingte Formatierung (Hauptregel A8:N…):
 * Feiertag (Spalte C gefüllt) → #FF5050
 * Sonntag → #FF6600
 * Samstag → #FFFF00
 * Feiertag hat Vorrang vor Wochenende.
 * @returns {'holiday'|'so'|'sa'|null}
 */
function rowColorKind(day) {
  const d = day || {};
  if (String(d.holiday_label || '').trim()) return 'holiday';
  const wd = String(d.weekday || '').trim();
  if (wd === 'So') return 'so';
  if (wd === 'Sa') return 'sa';
  return null;
}

const ROW_COLORS = {
  holiday: { hex: '#FF5050', rgb: [1, 80 / 255, 80 / 255], cssClass: 'zs-row-holiday', argb: 'FFFF5050' },
  so: { hex: '#FF6600', rgb: [1, 102 / 255, 0], cssClass: 'zs-row-so', argb: 'FFFF6600' },
  sa: { hex: '#FFFF00', rgb: [1, 1, 0], cssClass: 'zs-row-sa', argb: 'FFFFFF00' },
};

/**
 * Excel CF auf Summe (M8:M38):
 * > 12.01 → rot #FF0000
 * > 10 → orange #FFC000
 * Rot hat Vorrang.
 * @returns {'sum_high'|'sum_warn'|null}
 */
function summeAlertKind(daySumValue) {
  const v = num(daySumValue);
  if (v > 12.01) return 'sum_high';
  if (v > 10) return 'sum_warn';
  return null;
}

const SUMME_ALERT_COLORS = {
  sum_high: { hex: '#FF0000', rgb: [1, 0, 0], cssClass: 'zs-sum-high', argb: 'FFFF0000' },
  sum_warn: { hex: '#FFC000', rgb: [1, 192 / 255, 0], cssClass: 'zs-sum-warn', argb: 'FFFFC000' },
};

/** weekday/holiday aus Datum nachziehen, falls fehlend. */
function enrichDay(d) {
  const row = d && typeof d === 'object' ? Object.assign({}, d) : {};
  const parsed = parseDateKey(row.day_date);
  if (!parsed) return row;
  const built = buildMonthDays(parsed.year, parsed.month, { [row.day_date]: row });
  const one = built.find((x) => x.day_date === row.day_date);
  if (!one) return row;
  return Object.assign({}, row, {
    weekday: one.weekday,
    holiday_label: one.holiday_label || row.holiday_label || '',
    day_sum: row.day_sum != null ? row.day_sum : one.day_sum,
  });
}

module.exports = {
  MONTH_NAMES,
  WEEKDAYS,
  HOUR_FIELDS,
  pad2,
  toDateKey,
  parseDateKey,
  easterSunday,
  austrianHolidays,
  num,
  daySum,
  columnSums,
  gesamtSum,
  daysInMonth,
  buildMonthDays,
  fileStem,
  folderRel,
  round2,
  rowColorKind,
  ROW_COLORS,
  summeAlertKind,
  SUMME_ALERT_COLORS,
  enrichDay,
};
