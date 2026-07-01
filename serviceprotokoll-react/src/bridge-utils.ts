import type { SpBridgePayload } from './hooks/useElectronBridge';
import {
  DEFAULT_FORM,
  DEFAULT_MEASUREMENTS,
  DEFAULT_TEST_LOAD,
  DEFAULT_WORK_STEPS,
  type MeasurementRow,
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

export function defaultBridgePayload(): SpBridgePayload {
  return {
    jobId: '',
    jobs: [],
    fabNumbers: [],
    form: { ...DEFAULT_FORM },
    measurements: DEFAULT_MEASUREMENTS.map((r) => ({ ...r })),
    testLoad: { ...DEFAULT_TEST_LOAD },
    workSteps: DEFAULT_WORK_STEPS.map((r) => ({ ...r })),
  };
}

export function mapStepStatus(raw: string): StepResult {
  if (raw === 'ok' || raw === 'nok' || raw === 'na') return raw;
  return 'na';
}

export function mergeBridgePayload(base: SpBridgePayload, patch: Partial<SpBridgePayload>): SpBridgePayload {
  return {
    ...base,
    ...patch,
    form: patch.form ? { ...base.form, ...patch.form } : base.form,
    measurements: patch.measurements ?? base.measurements,
    testLoad: patch.testLoad ? { ...base.testLoad, ...patch.testLoad } : base.testLoad,
    workSteps: patch.workSteps ?? base.workSteps,
    jobs: patch.jobs ?? base.jobs,
    fabNumbers: patch.fabNumbers ?? base.fabNumbers,
  };
}

export type { ServiceProtocolFormState, MeasurementRow, TestLoadValues, WorkStep };
