export type UiLang = 'de' | 'en';

export function maskLangFromPdf(pdfDe: boolean, pdfEn: boolean): UiLang {
  return pdfEn && !pdfDe ? 'en' : 'de';
}

const STRINGS = {
  title: { de: 'Serviceprotokoll', en: 'Service protocol' },
  titleIbn: { de: 'Inbetriebnahme Protokoll', en: 'Commissioning report' },
  lastSavedDash: { de: 'Zuletzt gespeichert: –', en: 'Last saved: –' },
  saveJson: { de: 'Speichern', en: 'Save' },
  singlePdf: { de: 'einzel PDF', en: 'Single PDF' },
  allPdf: { de: 'Alle PDF', en: 'All PDFs' },
  menu: { de: 'Menü', en: 'Menu' },
  secJob: { de: 'Auftrag & Identifikation', en: 'Job & identification' },
  job: { de: 'Auftrag', en: 'Job' },
  pleaseSelect: { de: '– Bitte wählen –', en: '– Please select –' },
  project: { de: 'Projekt', en: 'Project' },
  date: { de: 'Datum', en: 'Date' },
  language: { de: 'Sprache', en: 'Language' },
  german: { de: 'Deutsch', en: 'German' },
  english: { de: 'Englisch', en: 'English' },
  serialNumber: { de: 'Fabrikationsnummer', en: 'Serial number' },
  plantData: { de: 'Anlagendaten', en: 'Equipment data' },
  type: { de: 'Type', en: 'Type' },
  qmaxPh: { de: 'z.B. 30 t/h', en: 'e.g. 30 t/h' },
  vmaxPh: { de: 'aus Anlagenstamm', en: 'from equipment master' },
  behaelterNenninhalt: { de: 'Behälter Nenninhalt', en: 'Vessel nom. capacity' },
  posNr: { de: 'Pos.-Nr.', en: 'Pos. no.' },
  loadCell: { de: 'Wägezelle & Messwerte', en: 'Load cell & readings' },
  motorDrive: { de: 'Motor / Frequenzumrichter', en: 'Motor / frequency converter' },
  addMotor: { de: 'Motor hinzufügen', en: 'Add motor' },
  addMotorTitle: { de: 'Weiteren Motor hinzufügen', en: 'Add another motor' },
  loadMotors: { de: 'Aus Motorliste laden', en: 'Load from motor list' },
  loadMotorsTitle: { de: 'Motordaten aus Motorliste-PDF einlesen', en: 'Read motor data from the motor list PDF' },
  removeMotor: { de: 'Motor entfernen', en: 'Remove motor' },
  noMotors: { de: 'Keine Motoren. Über + anlegen oder „Aus Motorliste laden“.', en: 'No motors. Add via + or load from motor list.' },
  motorAssign: { de: 'Zuordnung', en: 'Assignment' },
  motorData: { de: 'Motordaten', en: 'Motor data' },
  motorAccessories: { de: 'Zubehör', en: 'Accessories' },
  motorFc: { de: 'Frequenzumrichter', en: 'Frequency converter' },
  addLoadCell: { de: 'Wägezelle hinzufügen', en: 'Add load cell' },
  addLoadCellTitle: { de: 'Weitere Wägezelle hinzufügen', en: 'Add another load cell' },
  removeLoadCell: { de: 'Wägezelle entfernen', en: 'Remove load cell' },
  serial: { de: 'Seriennummer', en: 'Serial number' },
  pos: { de: 'Pos.', en: 'Pos.' },
  supplyV: { de: 'Vers. V', en: 'Supply V' },
  supplyVTitle: { de: 'Versorgungsspannung V', en: 'Supply voltage V' },
  sens: { de: 'Sens. mV/V', en: 'Sens. mV/V' },
  sensTitle: { de: 'Sensitivität mV/V', en: 'Sensitivity mV/V' },
  point: { de: 'Messpunkt', en: 'Point' },
  testLoad: { de: 'Prüfgewichtstest — Abweichung (%)', en: 'Test with test load — deviation (%)' },
  deviation: { de: 'Abweichung', en: 'Deviation' },
  workSteps: { de: 'Arbeitsschritte', en: 'Work steps' },
  copyStepsFromType: { de: 'Von gleicher Type übernehmen', en: 'Copy from same type' },
  copyStepsFromTypeTitle: {
    de: 'Arbeitsschritte der vorherigen FN gleicher Type übernehmen (ohne Haken)',
    en: 'Take over work steps from the previous serial number of the same type (unchecked)',
  },
  no: { de: 'Nr', en: 'No.' },
  result: { de: 'Ergebnis', en: 'Result' },
  workStep: { de: 'Arbeitsschritt (kurz)', en: 'Work step' },
  remark: { de: 'Bemerkung', en: 'Remark' },
  deleteRow: { de: 'Zeile löschen', en: 'Delete row' },
  addStep: { de: 'weiteren Arbeitsschritt hinzufügen', en: 'Add another work step' },
  resetList: { de: 'Liste zurücksetzen', en: 'Reset list' },
  generalRemarks: { de: 'Allgemeine Bemerkungen', en: 'General remarks' },
  remarksPh: { de: 'Bemerkungen eingeben …', en: 'Enter remarks …' },
  closing: { de: 'Abschluss', en: 'Closing' },
  status: { de: 'Status', en: 'Status' },
  checked: { de: 'Geprüft', en: 'Checked' },
  adjusted: { de: 'Justiert', en: 'Adjusted' },
  defect: { de: 'Mangel festgestellt', en: 'Defect found' },
  technician: { de: 'Monteur', en: 'Technician' },
  selectName: { de: 'Name auswählen', en: 'Select name' },
  profileSig: { de: 'Profil-Unterschrift (Einstellungen)', en: 'Profile signature (Settings)' },
  profileSigHint: {
    de: 'Unterschrift unter Einstellungen hinterlegen. Finales PDF nur mit Profil-Unterschrift.',
    en: 'Add the signature under Settings. Final PDF only with a profile signature.',
  },
  remarks: { de: 'Bemerkungen', en: 'Remarks' },
  actions: { de: 'Aktionen', en: 'Actions' },
  cancel: { de: 'Abbrechen', en: 'Cancel' },
} as const;

export type I18nKey = keyof typeof STRINGS;

export function t(lang: UiLang, key: I18nKey): string {
  const row = STRINGS[key];
  return (lang === 'en' ? row.en : row.de) || row.de;
}

const MOTOR_FIELD_LABELS: Record<string, { de: string; en: string }> = {
  bezeichnung: { de: 'Bezeichnung', en: 'Designation' },
  positionsnummer: { de: 'Positionsnummer', en: 'Position no.' },
  hersteller: { de: 'Hersteller', en: 'Manufacturer' },
  type: { de: 'Type', en: 'Type' },
  seriennummer: { de: 'Seriennummer', en: 'Serial number' },
  nennleistung_kw: { de: 'Nennleistung kW', en: 'Rated output kW' },
  leistungsfaktor: { de: 'cos φ', en: 'cos φ' },
  nenndrehzahl: { de: 'Nenndrehzahl min-1', en: 'Rated speed min-1' },
  nennstrom: { de: 'Nennstrom A', en: 'Rated current A' },
  getriebeuebersetzung: { de: 'Übersetzung 1:', en: 'Gear ratio 1:' },
  getriebedrehzahl: { de: 'Nenndrehzahl Getriebe min-1', en: 'Gear rated speed min-1' },
  nennspannung: { de: 'Nennspannung V', en: 'Rated voltage V' },
  nennfrequenz: { de: 'Nennfrequenz Hz', en: 'Rated frequency Hz' },
  bauform: { de: 'Bauform', en: 'Construction' },
  schaltung: { de: 'Schaltung Y/∆', en: 'Connection Y/∆' },
  isolationsklasse: { de: 'Isolationsklasse', en: 'Insulation class' },
  schutzart: { de: 'Schutzart', en: 'Protection' },
  leerlaufstrom_50hz: { de: 'Leerlaufstrom 50 Hz A', en: 'No-load current 50 Hz A' },
  anlaufart: { de: 'Anlaufart', en: 'Starting' },
  fu_hersteller: { de: 'FU Hersteller', en: 'FC manufacturer' },
  fu_type: { de: 'FU Type', en: 'FC type' },
  fu_nennstrom: { de: 'Nennstrom A', en: 'Rated current A' },
  fu_nennstrom_eingestellt: { de: 'eingestellt A', en: 'Set current A' },
  fu_max_speed: { de: 'max. Speed min-1', en: 'max. Speed min-1' },
  fu_max_frequency: { de: 'max. Frequency Hz', en: 'max. Frequency Hz' },
  laststrom_calculated: { de: 'Laststrom calculated A', en: 'Load current calculated A' },
  laststrom_fat: { de: 'Laststrom FAT A', en: 'Load current FAT A' },
  laststrom_sat: { de: 'Laststrom SAT A', en: 'Load current SAT A' },
};

export function motorFieldLabel(lang: UiLang, key: string): string {
  const row = MOTOR_FIELD_LABELS[key];
  if (!row) return key;
  return lang === 'en' ? row.en : row.de;
}

export function localizeAutosaveHint(hint: string, lang: UiLang): string {
  if (!hint) return t(lang, 'lastSavedDash');
  if (lang !== 'en') return hint;
  return hint
    .replace(/^Zuletzt gespeichert:/, 'Last saved:')
    .replace(/^Speichern fehlgeschlagen/, 'Save failed');
}
