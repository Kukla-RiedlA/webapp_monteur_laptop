import type { SpBridgePayload } from './hooks/useElectronBridge';
import {
  DEFAULT_TEST_LOAD,
  DEFAULT_WORK_STEPS,
  EMPTY_FORM,
  EMPTY_MEASUREMENTS,
  emptyMotorRow,
  MOTOR_FIELD_KEYS,
  type MeasurementRow,
  type MotorRow,
  type ServiceProtocolFormState,
  type StepResult,
  type TestLoadValues,
  type WorkStep,
} from './types';

export function isoToDisplayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return iso || '';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function displayToIsoDate(display: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(display || '').trim());
  if (!m) return display || '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function cloneMeasurements(rows?: MeasurementRow[] | null): MeasurementRow[] {
  const src = Array.isArray(rows) && rows.length ? rows : EMPTY_MEASUREMENTS;
  return EMPTY_MEASUREMENTS.map((def, i) => {
    const r = src[i] || src.find((x) => x.id === def.id) || def;
    return {
      id: def.id,
      label: r.label || def.label,
      labelDe: r.labelDe || def.labelDe,
      labelEn: r.labelEn || def.labelEn,
      kg: r.kg || '',
      mv: r.mv || '',
      ma: r.ma || '',
      g: r.g || '',
    };
  });
}

export function defaultBridgePayload(): SpBridgePayload {
  return emptyBridgePayload();
}

/** Leerer Zustand beim Auftragswechsel – keine Demo- oder Alt-Daten. */
export function emptyBridgePayload(jobs: SpBridgePayload['jobs'] = []): SpBridgePayload {
  return {
    jobId: '',
    jobs: jobs.slice(),
    fabNumbers: [],
    form: {
      ...EMPTY_FORM,
      loadCells: EMPTY_FORM.loadCells.map((c) => ({
        ...c,
        measurements: cloneMeasurements(c.measurements),
      })),
      motors: [],
    },
    measurements: EMPTY_MEASUREMENTS.map((r) => ({ ...r })),
    testLoad: { ...DEFAULT_TEST_LOAD },
    workSteps: DEFAULT_WORK_STEPS.map((r) => ({ ...r, result: 'na' as StepResult, remark: '' })),
  };
}

export function mapStepStatus(raw: string): StepResult {
  if (raw === 'ok' || raw === 'nok' || raw === 'na') return raw;
  return 'na';
}

function cloneMotor(row: Partial<MotorRow> | null | undefined, i: number): MotorRow {
  const base = emptyMotorRow(row && row.id ? String(row.id) : String(i + 1));
  MOTOR_FIELD_KEYS.forEach((k) => {
    base[k] = row && row[k] != null ? String(row[k]) : '';
  });
  base.anlagenstammMotorId = row && row.anlagenstammMotorId != null ? String(row.anlagenstammMotorId) : '';
  return base;
}

export function mergeBridgePayload(base: SpBridgePayload, patch: Partial<SpBridgePayload>): SpBridgePayload {
  const form = patch.form ? { ...base.form, ...patch.form } : base.form;
  if (patch.form && Array.isArray(patch.form.loadCells)) {
    form.loadCells = patch.form.loadCells.map((c, i) => ({
      id: c.id || String(i + 1),
      type: c.type || '',
      serialNumber: c.serialNumber || '',
      position: c.position || '',
      supplyVoltage: c.supplyVoltage || '',
      sensitivity: c.sensitivity || '',
      measurements: cloneMeasurements(c.measurements),
    }));
    if (form.loadCells[0]) {
      form.supplyVoltage = form.loadCells[0].supplyVoltage || form.supplyVoltage || '';
      form.sensitivity = form.loadCells[0].sensitivity || form.sensitivity || '';
      form.loadcellType = form.loadCells[0].type || form.loadcellType || '';
      form.serialNumber = form.loadCells[0].serialNumber || form.serialNumber || '';
    }
  } else if (!Array.isArray(form.loadCells) || !form.loadCells.length) {
    form.loadCells = [
      {
        id: '1',
        type: form.loadcellType || '',
        serialNumber: form.serialNumber || '',
        position: '',
        supplyVoltage: form.supplyVoltage || '',
        sensitivity: form.sensitivity || '',
        measurements: cloneMeasurements(patch.measurements ?? base.measurements),
      },
    ];
  }
  if (patch.form && Array.isArray(patch.form.motors)) {
    form.motors = patch.form.motors.map((m, i) => cloneMotor(m, i));
  } else if (!Array.isArray(form.motors)) {
    form.motors = [];
  }
  const measurements =
    form.loadCells[0]?.measurements?.length
      ? cloneMeasurements(form.loadCells[0].measurements)
      : patch.measurements ?? base.measurements;
  return {
    ...base,
    ...patch,
    form,
    measurements,
    testLoad: patch.testLoad ? { ...base.testLoad, ...patch.testLoad } : base.testLoad,
    workSteps: patch.workSteps ?? base.workSteps,
    jobs: patch.jobs ?? base.jobs,
    fabNumbers: patch.fabNumbers ?? base.fabNumbers,
  };
}

export { cloneMeasurements, EMPTY_MEASUREMENTS };
export type { ServiceProtocolFormState, MeasurementRow, TestLoadValues, WorkStep };
