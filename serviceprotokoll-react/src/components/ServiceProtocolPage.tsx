import { useCallback, useEffect, useState } from 'react';
import { cloneMeasurements, defaultBridgePayload, emptyBridgePayload, mergeBridgePayload } from '../bridge-utils';
import type { SpBridgePayload } from '../hooks/useElectronBridge';
import { useElectronBridge, useEmbeddedMode } from '../hooks/useElectronBridge';
import { ActionPanel } from './ActionPanel';
import { MeasurementTable } from './MeasurementTable';
import { NumberChip } from './NumberChip';
import { SectionCard } from './SectionCard';
import { SignatureBox } from './SignatureBox';
import { SpIcon } from './SpIcon';
import { SelectInput, TextInput } from './TextInput';
import { TestLoadFields } from './TestLoadFields';
import { WorkStepsTable } from './WorkStepsTable';
import type { LoadCellRow, MeasurementRow, MotorRow, ServiceProtocolFormState, StepResult } from '../types';
import { EMPTY_MEASUREMENTS, FAB_NUMBERS, emptyMotorRow } from '../types';
import { localizeAutosaveHint, maskLangFromPdf, motorFieldLabel, t, type UiLang } from '../i18n';
import { isFuAnlaufart } from '../motor-utils';

function ensureLoadCells(form: ServiceProtocolFormState, fallbackMeasurements?: MeasurementRow[]): LoadCellRow[] {
  if (Array.isArray(form.loadCells) && form.loadCells.length) return form.loadCells;
  const fallback = cloneMeasurements(fallbackMeasurements);
  return [
    {
      id: '1',
      type: form.loadcellType || '',
      serialNumber: form.serialNumber || '',
      position: '',
      supplyVoltage: form.supplyVoltage || '',
      sensitivity: form.sensitivity || '',
      measurements: fallback,
    },
  ];
}

export function ServiceProtocolPage() {
  const embedded = useEmbeddedMode();
  const [bridgeState, setBridgeState] = useState<SpBridgePayload>(defaultBridgePayload);

  const { form, testLoad, workSteps, jobs, jobId, fabNumbers } = bridgeState;
  const loadCells = ensureLoadCells(form, bridgeState.measurements);
  const motors: MotorRow[] = Array.isArray(form.motors) ? form.motors : [];

  const fabChips = fabNumbers.length ? fabNumbers : embedded ? [] : FAB_NUMBERS;
  const uiLang: UiLang = maskLangFromPdf(form.pdfDe, form.pdfEn);
  const displayLang = uiLang;
  const protocolKind = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('kind') === 'ibn' ? 'ibn' : 'service';
  const titleKey = protocolKind === 'ibn' ? 'titleIbn' : 'title';
  const plantTypeNorm = String(form.plantType || '').toUpperCase().replace(/\s+/g, '');
  const vmaxIsBehaelter = /^D-?DW(?:$|[^A-Z])/.test(plantTypeNorm) || /V-?DG-?1(?:$|[^0-9])/.test(plantTypeNorm);
  const [pendingFab, setPendingFab] = useState<string | null>(null);
  const activeFabVisual = pendingFab || form.activeFab || '';

  useEffect(() => {
    if (form.activeFab) setPendingFab(null);
  }, [form.activeFab]);

  const patchForm = useCallback((patch: Partial<ServiceProtocolFormState>) => {
    setBridgeState((prev) => {
      if (Array.isArray(patch.loadCells) && patch.loadCells.length) {
        const nextForm = { ...prev.form, ...patch };
        nextForm.loadcellType = patch.loadCells[0].type || '';
        nextForm.serialNumber = patch.loadCells[0].serialNumber || '';
        nextForm.supplyVoltage = patch.loadCells[0].supplyVoltage || '';
        nextForm.sensitivity = patch.loadCells[0].sensitivity || '';
        return mergeBridgePayload(prev, { form: nextForm });
      }
      return { ...prev, form: { ...prev.form, ...patch } };
    });
  }, []);

  const patchLoadCell = useCallback((id: string, patch: Partial<LoadCellRow>) => {
    setBridgeState((prev) => {
      const cells = ensureLoadCells(prev.form, prev.measurements).map((c) =>
        c.id === id ? { ...c, ...patch, measurements: patch.measurements ? cloneMeasurements(patch.measurements) : c.measurements } : c,
      );
      return mergeBridgePayload(prev, {
        form: {
          ...prev.form,
          loadCells: cells,
          loadcellType: cells[0]?.type || '',
          serialNumber: cells[0]?.serialNumber || '',
          supplyVoltage: cells[0]?.supplyVoltage || '',
          sensitivity: cells[0]?.sensitivity || '',
        },
        measurements: cloneMeasurements(cells[0]?.measurements),
      });
    });
  }, []);

  const patchLoadCellMeasurement = useCallback(
    (cellId: string, rowId: string, field: keyof Omit<MeasurementRow, 'id' | 'label' | 'labelDe' | 'labelEn'>, value: string) => {
      setBridgeState((prev) => {
        const cells = ensureLoadCells(prev.form, prev.measurements).map((c) => {
          if (c.id !== cellId) return c;
          const measurements = cloneMeasurements(c.measurements).map((r) =>
            r.id === rowId ? { ...r, [field]: value } : r,
          );
          return { ...c, measurements };
        });
        return mergeBridgePayload(prev, {
          form: {
            ...prev.form,
            loadCells: cells,
            loadcellType: cells[0]?.type || '',
            serialNumber: cells[0]?.serialNumber || '',
            supplyVoltage: cells[0]?.supplyVoltage || '',
            sensitivity: cells[0]?.sensitivity || '',
          },
          measurements: cloneMeasurements(cells[0]?.measurements),
        });
      });
    },
    [],
  );

  const addLoadCell = useCallback(() => {
    setBridgeState((prev) => {
      const cells = ensureLoadCells(prev.form, prev.measurements);
      const next = [
        ...cells,
        {
          id: String(Date.now()),
          type: '',
          serialNumber: '',
          position: '',
          supplyVoltage: '',
          sensitivity: '',
          measurements: cloneMeasurements(EMPTY_MEASUREMENTS),
        },
      ];
      return mergeBridgePayload(prev, {
        form: {
          ...prev.form,
          loadCells: next,
          loadcellType: next[0]?.type || '',
          serialNumber: next[0]?.serialNumber || '',
          supplyVoltage: next[0]?.supplyVoltage || '',
          sensitivity: next[0]?.sensitivity || '',
        },
        measurements: cloneMeasurements(next[0]?.measurements),
      });
    });
  }, []);

  const removeLoadCell = useCallback((id: string) => {
    setBridgeState((prev) => {
      const cells = ensureLoadCells(prev.form, prev.measurements);
      if (cells.length <= 1) return prev;
      const next = cells.filter((c) => c.id !== id);
      return mergeBridgePayload(prev, {
        form: {
          ...prev.form,
          loadCells: next,
          loadcellType: next[0]?.type || '',
          serialNumber: next[0]?.serialNumber || '',
          supplyVoltage: next[0]?.supplyVoltage || '',
          sensitivity: next[0]?.sensitivity || '',
        },
        measurements: cloneMeasurements(next[0]?.measurements),
      });
    });
  }, []);

  const patchMotor = useCallback((id: string, patch: Partial<MotorRow>) => {
    setBridgeState((prev) => {
      const list = (Array.isArray(prev.form.motors) ? prev.form.motors : []).map((m) =>
        m.id === id ? { ...m, ...patch } : m,
      );
      return mergeBridgePayload(prev, { form: { ...prev.form, motors: list } });
    });
  }, []);

  const addMotor = useCallback(() => {
    setBridgeState((prev) => {
      const list = Array.isArray(prev.form.motors) ? prev.form.motors.slice() : [];
      list.push(emptyMotorRow(String(Date.now())));
      return mergeBridgePayload(prev, { form: { ...prev.form, motors: list } });
    });
  }, []);

  const removeMotor = useCallback((id: string) => {
    setBridgeState((prev) => {
      const list = (Array.isArray(prev.form.motors) ? prev.form.motors : []).filter((m) => m.id !== id);
      return mergeBridgePayload(prev, { form: { ...prev.form, motors: list } });
    });
  }, []);

  const logPayload = useCallback(
    (action: string) => {
      console.log(action, bridgeState);
    },
    [bridgeState],
  );

  const onStepResultChange = useCallback((id: string, result: StepResult) => {
    setBridgeState((prev) => ({
      ...prev,
      workSteps: prev.workSteps.map((s) => (s.id === id ? { ...s, result } : s)),
    }));
  }, []);

  const onStepRemarkChange = useCallback((id: string, remark: string) => {
    setBridgeState((prev) => ({
      ...prev,
      workSteps: prev.workSteps.map((s) => (s.id === id ? { ...s, remark } : s)),
    }));
  }, []);

  const onStepDelete = useCallback((id: string) => {
    setBridgeState((prev) => ({
      ...prev,
      workSteps: prev.workSteps.filter((s) => s.id !== id),
    }));
  }, []);

  const { sendAction, autosaveHint, autosaveError } = useElectronBridge(bridgeState, setBridgeState, logPayload);
  const onAddStep = useCallback(() => sendAction('openStepPicker'), [sendAction]);
  const onResetSteps = useCallback(() => sendAction('resetWorkSteps'), [sendAction]);

  const jobOptions = [
    { value: '', label: t(uiLang, 'pleaseSelect') },
    ...jobs.map((j) => ({ value: j.id, label: j.label })),
  ];

  const handleJobChange = (nextJobId: string) => {
    if (nextJobId === (jobId || '')) return;
    const job = jobs.find((j) => j.id === nextJobId);
    setBridgeState((prev) => {
      const fresh = emptyBridgePayload(prev.jobs);
      return {
        ...fresh,
        jobId: nextJobId,
        form: {
          ...fresh.form,
          order: job ? job.label : '',
        },
      };
    });
    if (embedded && nextJobId) {
      window.parent.postMessage({ type: 'SP_JOB_CHANGE', jobId: nextJobId }, '*');
    }
  };

  const handleFabChange = (fab: string) => {
    if (!fab || fab === activeFabVisual) return;
    if (embedded) {
      // Nur Chip markieren. Formularfelder kommen ausschließlich vom Host (SP_SYNC_STATE),
      // sonst bleibt der alte Inhalt stehen und ein Debounce würde ihn zurückspielen.
      setPendingFab(fab);
      window.parent.postMessage({ type: 'SP_FAB_CHANGE', fab }, '*');
      return;
    }
    patchForm({ activeFab: fab });
  };

  return (
    <div className={embedded ? 'bg-kukla-page pb-6' : 'min-h-screen bg-kukla-page pb-10'} lang={uiLang}>
      <div className="mx-auto max-w-[1280px] px-4 py-4 md:px-6">
        <header
          className={`mb-5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20 -mx-4 bg-kukla-page/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6`}
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-3">
            <SpIcon name="ClipboardList" className="h-8 w-8 shrink-0" />
            <h1 className="text-2xl font-bold text-[#111827] md:text-[1.75rem]">{t(uiLang, titleKey)}</h1>
            <span className={`text-sm font-semibold ${autosaveError ? 'text-amber-700' : 'text-[#166534]'}`}>
              {localizeAutosaveHint(autosaveHint, uiLang)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="sp-btn-primary" onClick={() => sendAction('stickySave')}>
              <SpIcon name="Save" className="h-4 w-4" />
              {t(uiLang, 'saveJson')}
            </button>
            <button type="button" className="sp-btn-primary" onClick={() => sendAction('pdf')}>
              {t(uiLang, 'singlePdf')}
            </button>
            {fabChips.length >= 2 ? (
              <button type="button" className="sp-btn-primary" onClick={() => sendAction('pdfAll')}>
                {t(uiLang, 'allPdf')}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t(uiLang, 'menu')}
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-kukla-border bg-white shadow-card hover:bg-kukla-mint"
            >
              <SpIcon name="MoreVertical" className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="space-y-4">
          <SectionCard number={1} title={t(uiLang, 'secJob')} icon="Building2">
            <div className="grid gap-4">
              <SelectInput
                label={t(uiLang, 'job')}
                value={jobId || ''}
                onChange={(e) => handleJobChange(e.target.value)}
                options={jobOptions.length ? jobOptions : [{ value: '', label: t(uiLang, 'pleaseSelect') }]}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <TextInput label={t(uiLang, 'project')} value={form.project} onChange={(e) => patchForm({ project: e.target.value })} />
                <TextInput
                  label={t(uiLang, 'date')}
                  value={form.date}
                  onChange={(e) => patchForm({ date: e.target.value })}
                  icon={<SpIcon name="Calendar" className="h-4 w-4" />}
                />
              </div>
              <div>
                <span className="text-sm font-semibold text-[#111827]">{t(uiLang, 'language')}</span>
                <div className="mt-1 flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label={t(uiLang, 'language')}>
                  <label className="inline-flex items-center gap-2 text-sm font-normal text-[#111827]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#0e7b5a]"
                      checked={form.pdfDe}
                      onChange={(e) => patchForm({ pdfDe: e.target.checked })}
                    />
                    {t(uiLang, 'german')}
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm font-normal text-[#111827]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#0e7b5a]"
                      checked={form.pdfEn}
                      onChange={(e) => patchForm({ pdfEn: e.target.checked })}
                    />
                    {t(uiLang, 'english')}
                  </label>
                </div>
              </div>
            </div>
            {(fabChips.length ? fabChips : []).length > 0 ? (
              <div className="mt-4">
                <span className="mb-2 block text-sm font-semibold text-[#111827]">{t(uiLang, 'serialNumber')}</span>
                <div className="flex flex-wrap gap-2">
                  {fabChips.map((fab) => (
                    <NumberChip
                      key={fab}
                      value={fab}
                      active={activeFabVisual === fab}
                      onClick={() => handleFabChange(fab)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </SectionCard>

          <div className="space-y-4">
            <SectionCard number={2} title={t(uiLang, 'plantData')} icon="Factory">
              <div className="grid gap-3 md:grid-cols-2">
                <TextInput label={t(uiLang, 'type')} value={form.plantType} onChange={(e) => patchForm({ plantType: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="Qmax"
                    value={form.qmax}
                    inputMode="text"
                    maxLength={100}
                    autoComplete="off"
                    placeholder={t(uiLang, 'qmaxPh')}
                    onChange={(e) => patchForm({ qmax: e.target.value })}
                  />
                  <TextInput
                    label={vmaxIsBehaelter ? t(uiLang, 'behaelterNenninhalt') : 'v max'}
                    value={form.vmax || ''}
                    onChange={(e) => patchForm({ vmax: e.target.value })}
                    placeholder={t(uiLang, 'vmaxPh')}
                  />
                </div>
                <TextInput label={t(uiLang, 'posNr')} value={form.position} onChange={(e) => patchForm({ position: e.target.value })} />
                <TextInput label="DWC" value={form.dwc} onChange={(e) => patchForm({ dwc: e.target.value })} />
              </div>
            </SectionCard>

            <SectionCard number={3} title={t(uiLang, 'loadCell')} icon="Scale">
              <div className="grid gap-3">
                {loadCells.map((cell, idx) => (
                  <div
                    key={cell.id}
                    className="relative rounded-xl border border-kukla-border bg-white p-3 shadow-card"
                  >
                    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                      {idx === loadCells.length - 1 ? (
                        <button
                          type="button"
                          className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-lg border border-kukla-border bg-white hover:bg-kukla-mint"
                          aria-label={t(uiLang, 'addLoadCell')}
                          title={t(uiLang, 'addLoadCellTitle')}
                          onClick={addLoadCell}
                        >
                          <SpIcon name="Plus" className="h-4 w-4" />
                        </button>
                      ) : null}
                      {loadCells.length > 1 ? (
                        <button
                          type="button"
                          className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-lg border border-kukla-border bg-white hover:bg-kukla-mint"
                          aria-label={t(uiLang, 'removeLoadCell')}
                          title={t(uiLang, 'removeLoadCell')}
                          onClick={() => removeLoadCell(cell.id)}
                        >
                          <SpIcon name="X" className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(3.25rem,0.48fr)_minmax(3.25rem,0.48fr)] gap-2 pr-20">
                      <TextInput
                        label={t(uiLang, 'type')}
                        className="h-8 text-sm"
                        value={cell.type}
                        onChange={(e) => patchLoadCell(cell.id, { type: e.target.value })}
                      />
                      <TextInput
                        label={t(uiLang, 'serial')}
                        className="h-8 text-sm"
                        value={cell.serialNumber}
                        onChange={(e) => patchLoadCell(cell.id, { serialNumber: e.target.value })}
                      />
                      <TextInput
                        label={t(uiLang, 'pos')}
                        className="h-8 text-sm"
                        value={cell.position}
                        onChange={(e) => patchLoadCell(cell.id, { position: e.target.value })}
                      />
                      <TextInput
                        label={t(uiLang, 'supplyV')}
                        title={t(uiLang, 'supplyVTitle')}
                        className="h-8 text-sm"
                        value={cell.supplyVoltage || ''}
                        inputMode="decimal"
                        onChange={(e) => patchLoadCell(cell.id, { supplyVoltage: e.target.value })}
                      />
                      <TextInput
                        label={t(uiLang, 'sens')}
                        title={t(uiLang, 'sensTitle')}
                        className="h-8 text-sm"
                        value={cell.sensitivity || ''}
                        inputMode="decimal"
                        onChange={(e) => patchLoadCell(cell.id, { sensitivity: e.target.value })}
                      />
                    </div>
                    <div className="mt-3 w-full">
                      <MeasurementTable
                        rows={cell.measurements || EMPTY_MEASUREMENTS}
                        displayLang={displayLang}
                        onChange={(rowId, field, value) =>
                          patchLoadCellMeasurement(cell.id, rowId, field, value)
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              number={4}
              title={t(uiLang, 'motorDrive')}
              icon="Factory"
              headerExtra={
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex h-[32px] max-w-[11.5rem] items-center justify-center rounded-lg border border-kukla-border bg-white px-2 text-[11px] font-semibold leading-tight text-[#0c6a4d] hover:bg-kukla-mint"
                    aria-label={t(uiLang, 'loadMotors')}
                    title={t(uiLang, 'loadMotorsTitle')}
                    onClick={() => sendAction('loadMotorsFromMlPdf')}
                  >
                    {t(uiLang, 'loadMotors')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-lg border border-kukla-border bg-white hover:bg-kukla-mint"
                    aria-label={t(uiLang, 'addMotor')}
                    title={t(uiLang, 'addMotorTitle')}
                    onClick={addMotor}
                  >
                    <SpIcon name="Plus" className="h-4 w-4" />
                  </button>
                </div>
              }
            >
              {motors.length === 0 ? (
                <p className="text-sm text-[#6b7280]">{t(uiLang, 'noMotors')}</p>
              ) : (
                <div className="grid gap-3">
                  {motors.map((motor) => (
                    <div key={motor.id} className="relative rounded-xl border border-kukla-border bg-white p-3 shadow-card">
                      <div className="absolute right-2 top-2 z-10">
                        <button
                          type="button"
                          className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-lg border border-kukla-border bg-white hover:bg-kukla-mint"
                          aria-label={t(uiLang, 'removeMotor')}
                          title={t(uiLang, 'removeMotor')}
                          onClick={() => removeMotor(motor.id)}
                        >
                          <SpIcon name="X" className="h-4 w-4" />
                        </button>
                      </div>
                      {(
                        [
                          { title: t(uiLang, 'motorAssign'), keys: ['bezeichnung', 'positionsnummer'] },
                          {
                            title: t(uiLang, 'motorData'),
                            keys: [
                              'hersteller', 'type', 'seriennummer', 'nennleistung_kw', 'leistungsfaktor',
                              'nenndrehzahl', 'nennstrom', 'getriebeuebersetzung', 'getriebedrehzahl',
                              'nennspannung', 'nennfrequenz', 'bauform', 'schaltung', 'isolationsklasse',
                              'schutzart', 'leerlaufstrom_50hz',
                            ],
                          },
                          { title: t(uiLang, 'motorAccessories'), keys: ['anlaufart'] },
                          {
                            title: t(uiLang, 'motorFc'),
                            keys: [
                              'fu_hersteller', 'fu_type', 'fu_nennstrom', 'fu_nennstrom_eingestellt', 'fu_max_speed',
                              'fu_max_frequency', 'laststrom_calculated', 'laststrom_fat', 'laststrom_sat',
                            ],
                            fuOnly: true,
                          },
                        ] as Array<{ title: string; keys: Array<keyof MotorRow>; fuOnly?: boolean }>
                      )
                        .filter((group) => !group.fuOnly || isFuAnlaufart(motor.anlaufart))
                        .map((group) => (
                        <div key={group.title} className="mb-2 pr-10">
                          <div className="mb-1 text-[11px] font-bold text-[#0c6a4d]">{group.title}</div>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            {group.keys.map((key) => (
                              <TextInput
                                key={key}
                                label={motorFieldLabel(uiLang, String(key))}
                                className="h-8 text-sm"
                                value={String(motor[key] || '')}
                                onChange={(e) => patchMotor(motor.id, { [key]: e.target.value } as Partial<MotorRow>)}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard number={5} title={t(uiLang, 'testLoad')} icon="LineChart">
            <TestLoadFields
              lang={uiLang}
              values={testLoad}
              onChange={(field, value) =>
                setBridgeState((prev) => ({
                  ...prev,
                  testLoad: { ...prev.testLoad, [field]: value },
                }))
              }
            />
          </SectionCard>

          <SectionCard
            number={6}
            title={t(uiLang, 'workSteps')}
            icon="ClipboardCheck"
            headerExtra={
              <button
                type="button"
                className="inline-flex h-[32px] max-w-[14.5rem] items-center justify-center rounded-lg border border-kukla-border bg-white px-2 text-[11px] font-semibold leading-tight text-[#0c6a4d] hover:bg-kukla-mint"
                aria-label={t(uiLang, 'copyStepsFromType')}
                title={t(uiLang, 'copyStepsFromTypeTitle')}
                onClick={() => sendAction('copyWorkStepsFromPreviousType')}
              >
                {t(uiLang, 'copyStepsFromType')}
              </button>
            }
          >
            <WorkStepsTable
              steps={workSteps}
              displayLang={displayLang}
              onResultChange={onStepResultChange}
              onRemarkChange={onStepRemarkChange}
              onDelete={onStepDelete}
              onAdd={onAddStep}
              onReset={onResetSteps}
            />
            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-semibold text-[#111827]">{t(uiLang, 'generalRemarks')}</span>
              <textarea
                className="sp-textarea min-h-[80px]"
                placeholder={t(uiLang, 'remarksPh')}
                value={form.generalRemarks}
                onChange={(e) => patchForm({ generalRemarks: e.target.value })}
              />
            </label>
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-[1fr_min(280px,36%)]">
            <SectionCard number={7} title={t(uiLang, 'closing')} icon="ClipboardCheck">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <fieldset className="space-y-2 border-0 p-0">
                    <legend className="mb-1 text-sm font-semibold">{t(uiLang, 'status')}</legend>
                    {[
                      { value: 'geprueft', label: t(uiLang, 'checked') },
                      { value: 'justiert', label: t(uiLang, 'adjusted') },
                      { value: 'mangel', label: t(uiLang, 'defect') },
                    ].map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="status"
                          checked={form.status === opt.value}
                          onChange={() => patchForm({ status: opt.value as ServiceProtocolFormState['status'] })}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </fieldset>
                  <label className="mt-4 flex flex-col gap-1">
                    <span className="text-sm font-semibold">{t(uiLang, 'technician')}</span>
                    <select className="sp-input" value={form.monteur} onChange={(e) => patchForm({ monteur: e.target.value })}>
                      <option value="">{t(uiLang, 'selectName')}</option>
                      {form.monteur ? <option value={form.monteur}>{form.monteur}</option> : null}
                    </select>
                  </label>
                  <div className="mt-4">
                    <SignatureBox label={t(uiLang, 'profileSig')} />
                    <p className="mt-1 text-xs text-[#6b7280]">
                      {t(uiLang, 'profileSigHint')}
                    </p>
                  </div>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">{t(uiLang, 'remarks')}</span>
                  <textarea
                    className="sp-textarea min-h-[140px]"
                    placeholder={t(uiLang, 'remarksPh')}
                    value={form.closingRemarks}
                    onChange={(e) => patchForm({ closingRemarks: e.target.value })}
                  />
                </label>
              </div>
            </SectionCard>

            <ActionPanel
              lang={uiLang}
              onPdfCreate={() => sendAction('pdf')}
              onPdfCreateAll={() => sendAction('pdfAll')}
              onSaveData={() => sendAction('saveJson')}
              onCancel={() => sendAction('cancel')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
