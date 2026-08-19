import { useCallback, useState } from 'react';
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
import type { LoadCellRow, MeasurementRow, ServiceProtocolFormState, StepResult } from '../types';
import { EMPTY_MEASUREMENTS, FAB_NUMBERS } from '../types';

function ensureLoadCells(form: ServiceProtocolFormState, fallbackMeasurements?: MeasurementRow[]): LoadCellRow[] {
  const fallback = cloneMeasurements(fallbackMeasurements);
  if (Array.isArray(form.loadCells) && form.loadCells.length) {
    return form.loadCells.map((c, i) => ({
      id: c.id || String(i + 1),
      type: c.type || '',
      serialNumber: c.serialNumber || '',
      position: c.position || '',
      supplyVoltage: c.supplyVoltage ?? (i === 0 ? form.supplyVoltage || '' : ''),
      sensitivity: c.sensitivity ?? (i === 0 ? form.sensitivity || '' : ''),
      measurements: cloneMeasurements(
        c.measurements && c.measurements.length ? c.measurements : i === 0 ? fallback : EMPTY_MEASUREMENTS,
      ),
    }));
  }
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

  const fabChips = fabNumbers.length ? fabNumbers : embedded ? [] : FAB_NUMBERS;
  const displayLang: 'de' | 'en' | 'both' = form.pdfEn && !form.pdfDe ? 'en' : form.pdfDe && form.pdfEn ? 'both' : 'de';

  const patchForm = useCallback((patch: Partial<ServiceProtocolFormState>) => {
    setBridgeState((prev) => {
      const nextForm = { ...prev.form, ...patch };
      if (Array.isArray(patch.loadCells) && patch.loadCells.length) {
        nextForm.loadcellType = patch.loadCells[0].type || '';
        nextForm.serialNumber = patch.loadCells[0].serialNumber || '';
        nextForm.supplyVoltage = patch.loadCells[0].supplyVoltage || '';
        nextForm.sensitivity = patch.loadCells[0].sensitivity || '';
      }
      return mergeBridgePayload(prev, { form: nextForm });
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

  const logPayload = useCallback(
    (action: string) => {
      console.log(action, bridgeState);
    },
    [bridgeState],
  );

  const { sendAction } = useElectronBridge(bridgeState, setBridgeState, logPayload);

  const jobOptions =
    jobs.length > 0
      ? jobs.map((j) => ({ value: j.id, label: j.label }))
      : form.order
        ? [{ value: jobId || form.order, label: form.order }]
        : [];

  const handleJobChange = (nextJobId: string) => {
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
    if (embedded) {
      window.parent.postMessage({ type: 'SP_JOB_CHANGE', jobId: nextJobId }, '*');
    }
  };

  const handleFabChange = (fab: string) => {
    if (embedded) {
      setBridgeState((prev) =>
        mergeBridgePayload(prev, { form: { ...prev.form, activeFab: fab } }),
      );
      window.parent.postMessage({ type: 'SP_FAB_CHANGE', fab }, '*');
      return;
    }
    patchForm({ activeFab: fab });
  };

  return (
    <div className={embedded ? 'bg-kukla-page pb-6' : 'min-h-screen bg-kukla-page pb-10'}>
      <div className="mx-auto max-w-[1280px] px-4 py-4 md:px-6">
        <header
          className={`mb-5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20 -mx-4 bg-kukla-page/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6`}
        >
          <div className="flex items-center gap-3">
            <SpIcon name="ClipboardList" className="h-8 w-8 shrink-0" />
            <h1 className="text-2xl font-bold text-[#111827] md:text-[1.75rem]">Serviceprotokoll</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="sp-btn-primary" onClick={() => sendAction('stickySave')}>
              <SpIcon name="Save" className="h-4 w-4" />
              Speichern (JSON)
            </button>
            <button type="button" className="sp-btn-primary" onClick={() => sendAction('pdf')}>
              einzel PDF
            </button>
            {fabChips.length >= 2 ? (
              <button type="button" className="sp-btn-primary" onClick={() => sendAction('pdfAll')}>
                Alle PDF
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Menü"
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-kukla-border bg-white shadow-card hover:bg-kukla-mint"
            >
              <SpIcon name="MoreVertical" className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="space-y-4">
          <SectionCard number={1} title="Auftrag & Identifikation" icon="Building2">
            <div className="grid gap-4">
              <SelectInput
                label="Auftrag"
                value={jobId || ''}
                onChange={(e) => handleJobChange(e.target.value)}
                options={jobOptions.length ? jobOptions : [{ value: '', label: '– Bitte wählen –' }]}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <TextInput label="Projekt" value={form.project} onChange={(e) => patchForm({ project: e.target.value })} />
                <TextInput
                  label="Datum"
                  value={form.date}
                  onChange={(e) => patchForm({ date: e.target.value })}
                  icon={<SpIcon name="Calendar" className="h-4 w-4" />}
                />
              </div>
              <div>
                <span className="text-sm font-semibold text-[#111827]">Sprache</span>
                <div className="mt-1 flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Sprache">
                  <label className="inline-flex items-center gap-2 text-sm font-normal text-[#111827]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#007a4d]"
                      checked={form.pdfDe}
                      onChange={(e) => patchForm({ pdfDe: e.target.checked })}
                    />
                    Deutsch
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm font-normal text-[#111827]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#007a4d]"
                      checked={form.pdfEn}
                      onChange={(e) => patchForm({ pdfEn: e.target.checked })}
                    />
                    Englisch
                  </label>
                </div>
              </div>
            </div>
            {(fabChips.length ? fabChips : []).length > 0 ? (
              <div className="mt-4">
                <span className="mb-2 block text-sm font-semibold text-[#111827]">Fabrikationsnummer</span>
                <div className="flex flex-wrap gap-2">
                  {fabChips.map((fab) => (
                    <NumberChip
                      key={fab}
                      value={fab}
                      active={form.activeFab === fab}
                      onClick={() => handleFabChange(fab)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </SectionCard>

          <div className="space-y-4">
            <SectionCard number={2} title="Anlagendaten" icon="Factory">
              <div className="grid gap-3 md:grid-cols-2">
                <TextInput label="Type" value={form.plantType} onChange={(e) => patchForm({ plantType: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="Qmax"
                    value={form.qmax}
                    inputMode="text"
                    maxLength={100}
                    autoComplete="off"
                    placeholder="z.B. 30 t/h"
                    onChange={(e) => patchForm({ qmax: e.target.value })}
                  />
                  <TextInput
                    label="v max"
                    value={form.vmax || ''}
                    onChange={(e) => patchForm({ vmax: e.target.value })}
                    placeholder="aus Anlagenstamm"
                  />
                </div>
                <TextInput label="Pos.-Nr." value={form.position} onChange={(e) => patchForm({ position: e.target.value })} />
                <TextInput label="DWC" value={form.dwc} onChange={(e) => patchForm({ dwc: e.target.value })} />
              </div>
            </SectionCard>

            <SectionCard number={3} title="Wägezelle & Messwerte" icon="Scale">
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
                          aria-label="Wägezelle hinzufügen"
                          title="Weitere Wägezelle hinzufügen"
                          onClick={addLoadCell}
                        >
                          <SpIcon name="Plus" className="h-4 w-4" />
                        </button>
                      ) : null}
                      {loadCells.length > 1 ? (
                        <button
                          type="button"
                          className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-lg border border-kukla-border bg-white hover:bg-kukla-mint"
                          aria-label="Wägezelle entfernen"
                          title="Wägezelle entfernen"
                          onClick={() => removeLoadCell(cell.id)}
                        >
                          <SpIcon name="X" className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(3.25rem,0.48fr)_minmax(3.25rem,0.48fr)] gap-2 pr-20">
                      <TextInput
                        label="Type"
                        className="h-8 text-sm"
                        value={cell.type}
                        onChange={(e) => patchLoadCell(cell.id, { type: e.target.value })}
                      />
                      <TextInput
                        label="Seriennummer"
                        className="h-8 text-sm"
                        value={cell.serialNumber}
                        onChange={(e) => patchLoadCell(cell.id, { serialNumber: e.target.value })}
                      />
                      <TextInput
                        label="Pos."
                        className="h-8 text-sm"
                        value={cell.position}
                        onChange={(e) => patchLoadCell(cell.id, { position: e.target.value })}
                      />
                      <TextInput
                        label="Vers. V"
                        title="Versorgungsspannung V"
                        className="h-8 text-sm"
                        value={cell.supplyVoltage || ''}
                        inputMode="decimal"
                        onChange={(e) => patchLoadCell(cell.id, { supplyVoltage: e.target.value })}
                      />
                      <TextInput
                        label="Sens. mV/V"
                        title="Sensitivität mV/V"
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
          </div>

          <SectionCard number={4} title="Prüfgewichtstest — Abweichung (%)" icon="LineChart">
            <TestLoadFields
              values={testLoad}
              onChange={(field, value) =>
                setBridgeState((prev) => ({
                  ...prev,
                  testLoad: { ...prev.testLoad, [field]: value },
                }))
              }
            />
          </SectionCard>

          <SectionCard number={5} title="Arbeitsschritte" icon="ClipboardCheck">
            <WorkStepsTable
              steps={workSteps}
              displayLang={displayLang}
              onResultChange={(id, result: StepResult) =>
                setBridgeState((prev) => ({
                  ...prev,
                  workSteps: prev.workSteps.map((s) => (s.id === id ? { ...s, result } : s)),
                }))
              }
              onRemarkChange={(id, remark) =>
                setBridgeState((prev) => ({
                  ...prev,
                  workSteps: prev.workSteps.map((s) => (s.id === id ? { ...s, remark } : s)),
                }))
              }
              onDelete={(id) =>
                setBridgeState((prev) => ({
                  ...prev,
                  workSteps: prev.workSteps.filter((s) => s.id !== id),
                }))
              }
              onAdd={() => sendAction('openStepPicker')}
              onReset={() => sendAction('resetWorkSteps')}
            />
            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-semibold text-[#111827]">Allgemeine Bemerkungen</span>
              <textarea
                className="sp-textarea min-h-[80px]"
                placeholder="Bemerkungen eingeben …"
                value={form.generalRemarks}
                onChange={(e) => patchForm({ generalRemarks: e.target.value })}
              />
            </label>
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-[1fr_min(280px,36%)]">
            <SectionCard number={6} title="Abschluss" icon="ClipboardCheck">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <fieldset className="space-y-2 border-0 p-0">
                    <legend className="mb-1 text-sm font-semibold">Status</legend>
                    {[
                      { value: 'geprueft', label: 'Geprüft' },
                      { value: 'justiert', label: 'Justiert' },
                      { value: 'mangel', label: 'Mangel festgestellt' },
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
                    <span className="text-sm font-semibold">Monteur</span>
                    <select className="sp-input" value={form.monteur} onChange={(e) => patchForm({ monteur: e.target.value })}>
                      <option value="">Name auswählen</option>
                      {form.monteur ? <option value={form.monteur}>{form.monteur}</option> : null}
                    </select>
                  </label>
                  <div className="mt-4">
                    <SignatureBox label="Profil-Unterschrift (Einstellungen)" />
                    <p className="mt-1 text-xs text-[#6b7280]">
                      Unterschrift unter Einstellungen hinterlegen. Finales PDF nur mit Profil-Unterschrift.
                    </p>
                  </div>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">Bemerkungen</span>
                  <textarea
                    className="sp-textarea min-h-[140px]"
                    placeholder="Bemerkungen eingeben …"
                    value={form.closingRemarks}
                    onChange={(e) => patchForm({ closingRemarks: e.target.value })}
                  />
                </label>
              </div>
            </SectionCard>

            <ActionPanel
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
