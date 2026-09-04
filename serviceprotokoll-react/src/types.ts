export type StepResult = 'ok' | 'nok' | 'na';

export interface WorkStep {
  id: string;
  label: string;
  labelDe?: string;
  labelEn?: string;
  result: StepResult;
  remark: string;
}

export interface TestLoadValues {
  weight: string;
  display: string;
  deviation: string;
  value4: string;
}

export interface MeasurementRow {
  id: string;
  label: string;
  labelDe?: string;
  labelEn?: string;
  kg: string;
  mv: string;
  ma: string;
  g: string;
}

export interface LoadCellRow {
  id: string;
  type: string;
  serialNumber: string;
  position: string;
  supplyVoltage: string;
  sensitivity: string;
  /** Messwerte (DMS/Tara/Prüfgewicht) zu dieser Wägezelle */
  measurements?: MeasurementRow[];
}

export interface MotorRow {
  id: string;
  anlagenstammMotorId?: string;
  bezeichnung: string;
  positionsnummer: string;
  hersteller: string;
  type: string;
  seriennummer: string;
  nennleistung_kw: string;
  leistungsfaktor: string;
  nenndrehzahl: string;
  nennstrom: string;
  getriebeuebersetzung: string;
  getriebedrehzahl: string;
  nennspannung: string;
  nennfrequenz: string;
  bauform: string;
  schaltung: string;
  isolationsklasse: string;
  schutzart: string;
  leerlaufstrom_50hz: string;
  anlaufart: string;
  fu_hersteller: string;
  fu_type: string;
  fu_nennstrom: string;
  fu_nennstrom_eingestellt: string;
  fu_max_speed: string;
  fu_max_frequency: string;
  laststrom_calculated: string;
  laststrom_fat: string;
  laststrom_sat: string;
}

export const MOTOR_FIELD_KEYS: Array<keyof Omit<MotorRow, 'id' | 'anlagenstammMotorId'>> = [
  'bezeichnung', 'positionsnummer', 'hersteller', 'type', 'seriennummer',
  'nennleistung_kw', 'leistungsfaktor', 'nenndrehzahl', 'nennstrom',
  'getriebeuebersetzung', 'getriebedrehzahl', 'nennspannung', 'nennfrequenz',
  'bauform', 'schaltung', 'isolationsklasse', 'schutzart', 'leerlaufstrom_50hz',
  'anlaufart', 'fu_hersteller', 'fu_type', 'fu_nennstrom', 'fu_nennstrom_eingestellt',
  'fu_max_speed', 'fu_max_frequency', 'laststrom_calculated', 'laststrom_fat', 'laststrom_sat',
];

export function emptyMotorRow(id: string): MotorRow {
  return {
    id,
    anlagenstammMotorId: '',
    bezeichnung: '',
    positionsnummer: '',
    hersteller: '',
    type: '',
    seriennummer: '',
    nennleistung_kw: '',
    leistungsfaktor: '',
    nenndrehzahl: '',
    nennstrom: '',
    getriebeuebersetzung: '',
    getriebedrehzahl: '',
    nennspannung: '',
    nennfrequenz: '',
    bauform: '',
    schaltung: '',
    isolationsklasse: '',
    schutzart: '',
    leerlaufstrom_50hz: '',
    anlaufart: '',
    fu_hersteller: '',
    fu_type: '',
    fu_nennstrom: '',
    fu_nennstrom_eingestellt: '',
    fu_max_speed: '',
    fu_max_frequency: '',
    laststrom_calculated: '',
    laststrom_fat: '',
    laststrom_sat: '',
  };
}

export interface ServiceProtocolFormState {
  order: string;
  project: string;
  date: string;
  activeFab: string;
  plantType: string;
  qmax: string;
  qmaxUnit: string;
  vmax: string;
  position: string;
  dwc: string;
  /** @deprecated use loadCells[0] — kept for Bridge-Kompatibilität */
  loadcellType: string;
  /** @deprecated use loadCells[0] */
  serialNumber: string;
  loadCells: LoadCellRow[];
  motors: MotorRow[];
  supplyVoltage: string;
  sensitivity: string;
  generalRemarks: string;
  status: 'geprueft' | 'justiert' | 'mangel';
  monteur: string;
  closingRemarks: string;
  pdfDe: boolean;
  pdfEn: boolean;
}

export const FAB_NUMBERS = ['7118', '7119', '7120', '7123', '10612', '10616', '12435'];

export const DEFAULT_WORK_STEPS: WorkStep[] = [
  { id: '1', label: 'Kontrolle der Wägebrücke', labelDe: 'Kontrolle der Wägebrücke', labelEn: 'check of weighing bridge', result: 'na', remark: '' },
  { id: '2', label: 'Kontrolle des Fördergurtes', labelDe: 'Kontrolle des Fördergurtes', labelEn: 'check of conveyor belt', result: 'na', remark: '' },
  { id: '3', label: 'Reinigen der Waage', labelDe: 'Reinigen der Waage', labelEn: 'cleaning of the scale', result: 'na', remark: '' },
  { id: '4', label: 'Kontr. der Rollen & Rollenflucht', labelDe: 'Kontr. der Rollen & Rollenflucht', labelEn: 'check of rollers & roller aligment', result: 'na', remark: '' },
  { id: '5', label: 'Zustand der Bandabstreifer', labelDe: 'Zustand der Bandabstreifer', labelEn: 'condition of belt scrapers', result: 'na', remark: '' },
  { id: '6', label: 'Trommelkratzer', labelDe: 'Trommelkratzer', labelEn: 'drum scraper', result: 'na', remark: '' },
  { id: '7', label: 'Abstreifpflug', labelDe: 'Abstreifpflug', labelEn: 'scraper plough', result: 'na', remark: '' },
  { id: '8', label: 'Bandspannung', labelDe: 'Bandspannung', labelEn: 'belt tensioning', result: 'na', remark: '' },
  { id: '9', label: 'Bandlenkung', labelDe: 'Bandlenkung', labelEn: 'belt steering device', result: 'na', remark: '' },
  { id: '10', label: 'Schmierstellen', labelDe: 'Schmierstellen', labelEn: 'lubrication points', result: 'na', remark: '' },
  { id: '11', label: 'Kraftaufnehmer', labelDe: 'Kraftaufnehmer', labelEn: 'load cell', result: 'na', remark: '' },
  { id: '12', label: 'Tacho', labelDe: 'Tacho', labelEn: 'tacho', result: 'na', remark: '' },
  { id: '13', label: 'Schieflaufschalter', labelDe: 'Schieflaufschalter', labelEn: 'belt misalignment switch', result: 'na', remark: '' },
  { id: '14', label: 'Kettentriebe', labelDe: 'Kettentriebe', labelEn: 'chain drives', result: 'na', remark: '' },
  { id: '15', label: 'Überlastschutz', labelDe: 'Überlastschutz', labelEn: 'overload protection', result: 'na', remark: '' },
  { id: '16', label: 'Wiegeelektronik', labelDe: 'Wiegeelektronik', labelEn: 'weighing electronics', result: 'na', remark: '' },
  { id: '17', label: 'Tara', labelDe: 'Tara', labelEn: 'tare', result: 'na', remark: '' },
  { id: '18', label: 'PGW-Test', labelDe: 'PGW-Test', labelEn: 'test with test weight', result: 'na', remark: '' },
  { id: '19', label: 'Regelung & Dosierung', labelDe: 'Regelung & Dosierung', labelEn: 'control & dosing', result: 'na', remark: '' },
  { id: '20', label: 'Kontrollwiegungen', labelDe: 'Kontrollwiegungen', labelEn: 'check weighing procedures', result: 'na', remark: '' },
  { id: '21', label: 'Kontrolle der Zellenradschleuse', labelDe: 'Kontrolle der Zellenradschleuse', labelEn: 'check of rotary vane feeder', result: 'na', remark: '' },
];

/** Leere Messwert-Zeilen für neue Wägezellen-Blöcke */
export const EMPTY_MEASUREMENTS: MeasurementRow[] = [
  { id: 'dms', label: 'DMS entlastet / released', labelDe: 'DMS entlastet', labelEn: 'Load cell released', kg: '', mv: '', ma: '', g: '' },
  { id: 'tara', label: 'Tara / tare', labelDe: 'Tara', labelEn: 'Tare', kg: '', mv: '', ma: '', g: '' },
  { id: 'pg', label: 'Prüfgewicht / test load', labelDe: 'Prüfgewicht', labelEn: 'Test load', kg: '', mv: '', ma: '', g: '' },
];

export const DEFAULT_MEASUREMENTS: MeasurementRow[] = EMPTY_MEASUREMENTS.map((r) => ({ ...r }));

export const DEFAULT_TEST_LOAD: TestLoadValues = {
  weight: '',
  display: '',
  deviation: '',
  value4: '',
};

export const DEFAULT_LOAD_CELLS: LoadCellRow[] = [
  {
    id: '1',
    type: '',
    serialNumber: '',
    position: '',
    supplyVoltage: '',
    sensitivity: '',
    measurements: EMPTY_MEASUREMENTS.map((r) => ({ ...r })),
  },
];

/** Nur für isolierte Vite-Vorschau. Embedded Electron startet leer (siehe emptyBridgePayload). */
export const DEFAULT_FORM: ServiceProtocolFormState = {
  order: '',
  project: '',
  date: '',
  activeFab: '',
  plantType: '',
  qmax: '',
  qmaxUnit: 'kg/h',
  vmax: '',
  position: '',
  dwc: '',
  loadcellType: '',
  serialNumber: '',
  loadCells: DEFAULT_LOAD_CELLS.map((r) => ({
    ...r,
    measurements: (r.measurements || EMPTY_MEASUREMENTS).map((m) => ({ ...m })),
  })),
  motors: [],
  supplyVoltage: '',
  sensitivity: '',
  generalRemarks: '',
  status: 'geprueft',
  monteur: '',
  closingRemarks: '',
  pdfDe: true,
  pdfEn: false,
};

/** Leeres Formular für Auftrags-/FN-Wechsel (ohne Demo-Daten). */
export const EMPTY_FORM: ServiceProtocolFormState = {
  order: '',
  project: '',
  date: '',
  activeFab: '',
  plantType: '',
  qmax: '',
  qmaxUnit: 'kg/h',
  vmax: '',
  position: '',
  dwc: '',
  loadcellType: '',
  serialNumber: '',
  loadCells: DEFAULT_LOAD_CELLS.map((r) => ({
    ...r,
    type: '',
    serialNumber: '',
    position: '',
    supplyVoltage: '',
    sensitivity: '',
    measurements: EMPTY_MEASUREMENTS.map((m) => ({ ...m })),
  })),
  motors: [],
  supplyVoltage: '',
  sensitivity: '',
  generalRemarks: '',
  status: 'geprueft',
  monteur: '',
  closingRemarks: '',
  pdfDe: true,
  pdfEn: false,
};
