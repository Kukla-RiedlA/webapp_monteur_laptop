export type StepResult = 'ok' | 'nok' | 'na';

export interface WorkStep {
  id: string;
  label: string;
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
  { id: '1', label: 'Kontrolle Wägebrücke', result: 'ok', remark: '' },
  { id: '2', label: 'Kontrolle Fördergut', result: 'ok', remark: '' },
  { id: '3', label: 'Reinigen Waage', result: 'ok', remark: '' },
  { id: '4', label: 'Rollen & Rollenflucht', result: 'ok', remark: '' },
  { id: '5', label: 'Zustand Bandabstreifer', result: 'ok', remark: '' },
  { id: '6', label: 'Trommelkratzer', result: 'ok', remark: '' },
  { id: '7', label: 'Bandspannung', result: 'ok', remark: '' },
];

/** Leere Messwert-Zeilen für neue Wägezellen-Blöcke */
export const EMPTY_MEASUREMENTS: MeasurementRow[] = [
  { id: 'dms', label: 'DMS entlastet / released', kg: '', mv: '', ma: '', g: '' },
  { id: 'tara', label: 'Tara / tare', kg: '', mv: '', ma: '', g: '' },
  { id: 'pg', label: 'Prüfgewicht / test load', kg: '', mv: '', ma: '', g: '' },
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

export const DEFAULT_FORM: ServiceProtocolFormState = {
  order: 'Etex Building Performance GmbH, Siniat-Werk Lippendorf',
  project: 'Etex Lippendorf Vorbereitungsstation',
  date: '29.06.2026',
  activeFab: '7118',
  plantType: 'E-DBW-H-I-800/2600D-ZS-320/390',
  qmax: '25',
  qmaxUnit: 'kg/h',
  vmax: '',
  position: 'Stuckgips',
  dwc: 'DWC-7C',
  loadcellType: '',
  serialNumber: '',
  loadCells: DEFAULT_LOAD_CELLS.map((r) => ({
    ...r,
    measurements: (r.measurements || EMPTY_MEASUREMENTS).map((m) => ({ ...m })),
  })),
  supplyVoltage: '',
  sensitivity: '',
  generalRemarks: '',
  status: 'geprueft',
  monteur: '',
  closingRemarks: '',
  pdfDe: true,
  pdfEn: false,
};
