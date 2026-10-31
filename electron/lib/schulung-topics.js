'use strict';

/** Vorbereitete Schulungs-Sets. Jedes Preset ist der komplette Satz für den Typ. */

const GRUNDSTOCK = [
  ['Aufbau: Wägezellen, Funktion und Fehlersuche', 'Design: load cells, function and fault finding'],
  ['Waage: Mechanische Bauteile, Position und Wartung', 'Scale: mechanical parts, position and maintenance'],
  ['Elektronik: Funktion, Anschluss und Fehlersuche', 'Electronics: function, connection and fault finding'],
  ['Anzeige: Bedienoberfläche, Messwerte und Meldungen', 'Display: operator interface, readings and messages'],
  ['Bedienung: Start, Stopp, Störung quittieren', 'Operation: start, stop, acknowledge a fault'],
  ['Sollwert, Istwert und Zähler: Bedeutung und Ablesen', 'Setpoint, actual value and totalizer: meaning and reading'],
  ['Nullpunkt / Tara: Tarierung der Waage, Prüfung des Nullpunktes', 'Zero / tare: taring the scale and checking the zero point'],
  ['Prüfgewichtstest: Verwendung des Prüfgewichtes', 'Test weight: using the test weight'],
  ['Kalibrierung der Waage', 'Calibration of the scale'],
  ['Materialtest', 'Material test'],
  ['Alarme: Typische Meldungen und erste Maßnahme', 'Alarms: typical messages and the first action'],
  ['Regelmäßige Kontrolle: Sichtkontrolle und Reinigung im Betrieb', 'Regular check: visual inspection and cleaning in operation'],
  ['Störung: Eigenes Handeln und wann Kukla gerufen werden sollte', 'Fault: what to do and when to call Kukla'],
  ['Sicherheit: Quetschstellen, laufendes Band, Not-Aus', 'Safety: nip points, running belt, emergency stop'],
];

const BAND = [
  ['Fördergurt: Bandlauf, Bandspannung und Abstreifer', 'Conveyor belt: tracking, tension and scrapers'],
  ['Geschwindigkeit und Durchsatz: Anzeige und Bedeutung der Werte', 'Speed and throughput: display and meaning of the values'],
  ['Materialaufgabe: Schichthöhe, Überfüllung, Einfluss auf die Wägung', 'Material feed: bed depth, overfilling, effect on the weighing'],
  ['Tarieren: Tarieren bei leerem, frei laufendem Band', 'Taring: tare with an empty, freely running belt'],
  ['Dosieren: Sollwert, Regelung und Grenzen', 'Dosing: setpoint, control and limits'],
  ['Anbackungen und Schieflauf: Reinigen und Grenze zum Service', 'Build-up and mistracking: cleaning and when to call service'],
  ['Fehlbedienung: Tarieren bei belegtem Band, Überfüllung, Störung nicht quittiert', 'Misoperation: taring a loaded belt, overfilling, fault not acknowledged'],
];

const DDW = [
  ['Prinzip: Loss-in-Weight, Behältergewicht, Austrag, Nachfüllen', 'Principle: loss-in-weight, hopper weight, discharge, refill'],
  ['Dosieren und Nachfüllen: Gravimetrisch und Volumetrisch', 'Dosing and refill: gravimetric and volumetric'],
  ['Füllstand: Füllstände, Brückenbildung, Rührwerk', 'Level: fill levels, bridging, agitator'],
  ['Schnecke: Austragsorgan, Lage und Kontrolle', 'Screw: discharge unit, position and checks'],
  ['Sollwert und Schüttgewicht: Eingabe und Wirkung des Schüttgewichts', 'Setpoint and bulk density: entry and effect of the bulk density'],
  ['Produktwechsel: Entleeren und neu anfahren', 'Product change: emptying and restart'],
  ['Störungen: Brücke, Verstopfung, instabile Anzeige', 'Faults: bridging, blockage, unstable reading'],
  ['Reinigung: Reinigen ohne flexible Verbindungen zu verspannen', 'Cleaning: clean without straining flexible connections'],
];

const PRESETS = [
  { name: 'Bandwaage EBW', type_code: 'EBW', sort_order: 1, steps: GRUNDSTOCK.concat(BAND) },
  { name: 'Dosierbandwaage E-DBW', type_code: 'E-DBW', sort_order: 2, steps: GRUNDSTOCK.concat(BAND) },
  { name: 'Differentialdosierwaage DDW', type_code: 'DDW', sort_order: 3, steps: GRUNDSTOCK.concat(DDW) },
];

const LEGACY_DE = [
  'Aufbau: Wägezelle, Rahmen, Elektronik, Anzeige',
  'Bedienung: Start, Stopp, Störung quittieren',
  'Sollwert, Istwert und Zähler',
  'Nullpunkt: Waage muss leer und frei laufen',
  'Alarme und typische Meldungen',
  'Tägliche Sichtkontrolle und Reinigung',
  'Verhalten bei Störung',
  'Sicherheit: Quetschstellen, laufendes Band, Not-Aus',
  'Bandlauf, Bandspannung und Abstreifer – worauf der Betreiber achtet',
  'Geschwindigkeit und Durchsatzanzeige',
  'Materialaufgabe, Schichthöhe, Überfüllung',
  'Tarieren der Waage',
  'Dosieren: Sollwert vorgeben, Regelung beobachten, Grenzen',
  'Anbackungen und Schieflauf: wann reinigen, wann Service',
  'Typische Fehlbedienung',
  'Prinzip Loss-in-Weight: Behältergewicht, Austrag, Nachfüllen',
  'Dosierphase und Nachfüllphase',
  'Füllstände, Brückenbildung, Rührwerk',
  'Austragsorgan Schnecke',
  'Sollwert und Schüttgewicht in der Bedienung',
  'Produktwechsel und Entleeren',
  'Störungen: Brücke, Verstopfung, instabile Anzeige',
  'Reinigung, ohne flexible Verbindungen zu verspannen',
];

function compact(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_.\/]+/g, '');
}

function typeContainsCode(anlagenType, typeCode) {
  const hay = compact(anlagenType);
  const code = compact(typeCode);
  if (!hay || !code) return false;
  return hay.indexOf(code) !== -1;
}

function matchPreset(anlagenType) {
  let best = null;
  let bestLen = -1;
  PRESETS.forEach(function (preset) {
    if (!typeContainsCode(anlagenType, preset.type_code)) return;
    const len = compact(preset.type_code).length;
    if (len > bestLen) {
      best = preset;
      bestLen = len;
    }
  });
  if (best) return best;
  if (compact(anlagenType).indexOf('dbw') !== -1) {
    return PRESETS.filter(function (preset) { return preset.type_code === 'E-DBW'; })[0] || null;
  }
  return null;
}

function presetsForTypes(types) {
  const seen = {};
  const out = [];
  (types || []).forEach(function (anlagenType) {
    const preset = matchPreset(anlagenType);
    if (!preset || seen[preset.type_code]) return;
    seen[preset.type_code] = 1;
    out.push(preset);
  });
  return out;
}

function splitHeading(text) {
  const value = String(text || '').trim();
  const idx = value.indexOf(': ');
  if (idx <= 0) return { title: value, body: value };
  const title = value.slice(0, idx).trim();
  const body = value.slice(idx + 2).trim();
  return { title: title || value, body: body || title || value };
}

function toRows(pairs) {
  const seen = {};
  const out = [];
  (pairs || []).forEach(function (pair) {
    const de = String(pair[0] || '').trim();
    if (!de || seen[de]) return;
    seen[de] = 1;
    const deParts = splitHeading(de);
    const enParts = splitHeading(pair[1]);
    out.push({
      sort_order: out.length + 1,
      bezeichnung_de: deParts.title,
      bezeichnung_en: enParts.title,
      erklaerung_de: deParts.body,
      erklaerung_en: enParts.body,
      status: 'na',
      bemerkung: '',
    });
  });
  return out;
}

function stepsForTypes(types) {
  const matched = presetsForTypes(types);
  if (!matched.length) return toRows(GRUNDSTOCK);
  const pairs = [];
  matched.forEach(function (preset) {
    preset.steps.forEach(function (pair) { pairs.push(pair); });
  });
  return toRows(pairs);
}

function allCatalogSteps() {
  const pairs = GRUNDSTOCK.concat(BAND).concat(DDW);
  return pairs.map(function (pair, index) {
    return { de: pair[0], en: pair[1], sort_order: index + 1 };
  });
}

module.exports = {
  GRUNDSTOCK,
  BAND,
  DDW,
  PRESETS,
  LEGACY_DE,
  compact,
  typeContainsCode,
  presetsForTypes,
  stepsForTypes,
  allCatalogSteps,
  splitHeading,
};
