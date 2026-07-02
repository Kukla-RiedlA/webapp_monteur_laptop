import { useCallback, useState } from 'react';
import { defaultBridgePayload, mergeBridgePayload } from '../bridge-utils';
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
import type { ServiceProtocolFormState, StepResult } from '../types';
import { FAB_NUMBERS } from '../types';

export function ServiceProtocolPage() {
  const embedded = useEmbeddedMode();
  const [bridgeState, setBridgeState] = useState<SpBridgePayload>(defaultBridgePayload);

  const { form, measurements, testLoad, workSteps, jobs, jobId, fabNumbers } = bridgeState;

  const fabChips = fabNumbers.length ? fabNumbers : embedded ? [] : FAB_NUMBERS;

  const patchForm = useCallback((patch: Partial<ServiceProtocolFormState>) => {
    setBridgeState((prev) => mergeBridgePayload(prev, { form: { ...prev.form, ...patch } }));
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
    setBridgeState((prev) =>
      mergeBridgePayload(prev, {
        jobId: nextJobId,
        form: { ...prev.form, order: job ? job.label : prev.form.order },
      }),
    );
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
          className={`mb-5 flex flex-wrap items-center justify-between gap-3 ${embedded ? '' : 'sticky top-0 z-20 -mx-4 bg-kukla-page/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6'}`}
        >
          <div className="flex items-center gap-3">
            <SpIcon name="ClipboardList" className="h-8 w-8 shrink-0" />
            <h1 className="text-2xl font-bold text-[#111827] md:text-[1.75rem]">Serviceprotokoll</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-kukla-border bg-white px-3 py-2 text-sm text-[#111827] shadow-card">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-[var(--accent,#2d6a4f)]"
                checked={!!form.applyToAnlagenstamm}
                onChange={(e) => patchForm({ applyToAnlagenstamm: e.target.checked })}
              />
              <span>In Anlagenstamm übernehmen</span>
            </label>
            <button type="button" className="sp-btn-primary" onClick={() => sendAction('stickySave')}>
              <SpIcon name="Save" className="h-4 w-4" />
              Speichern
            </button>
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
                value={jobId || jobOptions[0]?.value || ''}
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
            <div className="grid gap-4 md:grid-cols-2">
              <SectionCard number={2} title="Anlagendaten" icon="Factory">
                <div className="grid gap-3">
                  <TextInput label="Type" value={form.plantType} onChange={(e) => patchForm({ plantType: e.target.value })} />
                  <TextInput
                    label="Qmax"
                    value={form.qmax}
                    onChange={(e) => patchForm({ qmax: e.target.value })}
                    suffix={
                      <select
                        className="sp-input w-20 shrink-0 px-2"
                        value={form.qmaxUnit}
                        onChange={(e) => patchForm({ qmaxUnit: e.target.value })}
                      >
                        <option value="t/h">t/h</option>
                      </select>
                    }
                  />
                  <TextInput label="Pos.-Nr." value={form.position} onChange={(e) => patchForm({ position: e.target.value })} />
                  <TextInput label="DWC" value={form.dwc} onChange={(e) => patchForm({ dwc: e.target.value })} />
                </div>
              </SectionCard>

              <SectionCard number={3} title="Wägezelle" icon="Scale">
                <div className="grid gap-3">
                  <TextInput label="Type" value={form.loadcellType} onChange={(e) => patchForm({ loadcellType: e.target.value })} />
                  <TextInput
                    label="Seriennummer"
                    value={form.serialNumber}
                    onChange={(e) => patchForm({ serialNumber: e.target.value })}
                  />
                  <TextInput
                    label="Versorgungsspannung"
                    value={form.supplyVoltage}
                    onChange={(e) => patchForm({ supplyVoltage: e.target.value })}
                    suffix={<span className="sp-input inline-flex w-12 shrink-0 items-center justify-center px-0">V</span>}
                  />
                </div>
              </SectionCard>
            </div>

            <SectionCard number={4} title="Messwerte Wägezelle" icon="LineChart">
              <MeasurementTable
                rows={measurements}
                onChange={(id, field, value) =>
                  setBridgeState((prev) => ({
                    ...prev,
                    measurements: prev.measurements.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
                  }))
                }
              />
            </SectionCard>
          </div>

          <SectionCard number={5} title="Prüfgewichtstest / test with test load" icon="LineChart">
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

          <SectionCard number={6} title="Arbeitsschritte" icon="ClipboardCheck">
            <WorkStepsTable
              steps={workSteps}
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
            <SectionCard number={7} title="Abschluss" icon="ClipboardCheck">
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
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <SignatureBox label="Unterschrift Monteur" />
                    <SignatureBox label="Unterschrift Kunde" />
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
              pdfDe={form.pdfDe}
              pdfEn={form.pdfEn}
              onPdfDeChange={(v) => patchForm({ pdfDe: v })}
              onPdfEnChange={(v) => patchForm({ pdfEn: v })}
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
