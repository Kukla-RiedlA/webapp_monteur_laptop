'use strict';

/** Freigegebener Startkatalog Schulung. Gleicher Wortlaut wie die Dispo-Seed-Migration. */

const GRUNDSTOCK = [
  ['Aufbau: Wägezelle, Rahmen, Elektronik, Anzeige', 'Design: load cell, frame, electronics, display'],
  ['Bedienung: Start, Stopp, Störung quittieren', 'Operation: start, stop, acknowledge a fault'],
  ['Sollwert, Istwert und Zähler', 'Setpoint, actual value and totalizer'],
  ['Nullpunkt: Waage muss leer und frei laufen', 'Zero point: the scale must run empty and freely'],
  ['Alarme und typische Meldungen', 'Alarms and typical messages'],
  ['Tägliche Sichtkontrolle und Reinigung', 'Daily visual inspection and cleaning'],
  ['Verhalten bei Störung', 'Behaviour in the event of a fault'],
  ['Sicherheit: Quetschstellen, laufendes Band, Not-Aus', 'Safety: nip points, running belt, emergency stop'],
];

const BAND = [
  ['Bandlauf, Bandspannung und Abstreifer – worauf der Betreiber achtet', 'Belt tracking, belt tension and belt cleaners – what the operator watches for'],
  ['Geschwindigkeit und Durchsatzanzeige', 'Speed and flow-rate display'],
  ['Materialaufgabe, Schichthöhe, Überfüllung', 'Material feed, bed depth, overfilling'],
  ['Tarieren der Waage', 'Taring the scale'],
  ['Dosieren: Sollwert vorgeben, Regelung beobachten, Grenzen', 'Dosing: enter the setpoint, watch the control loop, limits'],
  ['Anbackungen und Schieflauf: wann reinigen, wann Service', 'Build-up and belt misalignment: when to clean, when to call service'],
  ['Typische Fehlbedienung', 'Typical operating mistakes'],
];

const DDW = [
  ['Prinzip Loss-in-Weight: Behältergewicht, Austrag, Nachfüllen', 'Loss-in-weight principle: hopper weight, discharge, refilling'],
  ['Dosierphase und Nachfüllphase', 'Dosing phase and refill phase'],
  ['Füllstände, Brückenbildung, Rührwerk', 'Fill levels, bridging, agitator'],
  ['Austragsorgan Schnecke', 'Discharge unit, screw'],
  ['Sollwert und Schüttgewicht in der Bedienung', 'Setpoint and bulk density during operation'],
  ['Produktwechsel und Entleeren', 'Product changeover and emptying'],
  ['Störungen: Brücke, Verstopfung, instabile Anzeige', 'Faults: bridging, blockage, unstable reading'],
  ['Reinigung, ohne flexible Verbindungen zu verspannen', 'Cleaning without straining flexible connections'],
];

function compact(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_.\/]+/g, '');
}

function codesForTypes(types) {
  let band = false;
  let ddw = false;
  (types || []).forEach(function (anlagenType) {
    const hay = compact(anlagenType);
    if (!hay) return;
    if (hay.indexOf('ebw') !== -1 || hay.indexOf('dbw') !== -1) band = true;
    if (hay.indexOf('ddw') !== -1) ddw = true;
  });
  const codes = [];
  if (band) codes.push('BAND');
  if (ddw) codes.push('DDW');
  return codes;
}

function stepsForTypes(types) {
  const rows = GRUNDSTOCK.slice();
  codesForTypes(types).forEach(function (code) {
    (code === 'DDW' ? DDW : BAND).forEach(function (pair) { rows.push(pair); });
  });
  const seen = {};
  const out = [];
  rows.forEach(function (pair) {
    const de = String(pair[0] || '').trim();
    if (!de || seen[de]) return;
    seen[de] = 1;
    out.push({
      sort_order: out.length + 1,
      bezeichnung_de: de,
      bezeichnung_en: String(pair[1] || '').trim(),
      status: 'na',
      bemerkung: '',
    });
  });
  return out;
}

module.exports = {
  GRUNDSTOCK,
  BAND,
  DDW,
  codesForTypes,
  stepsForTypes,
};
