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
  posNr: { de: 'Pos.-Nr.', en: 'Pos. no.' },
  loadCell: { de: 'Wägezelle & Messwerte', en: 'Load cell & readings' },
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

export function localizeAutosaveHint(hint: string, lang: UiLang): string {
  if (!hint) return t(lang, 'lastSavedDash');
  if (lang !== 'en') return hint;
  return hint
    .replace(/^Zuletzt gespeichert:/, 'Last saved:')
    .replace(/^Speichern fehlgeschlagen/, 'Save failed');
}
