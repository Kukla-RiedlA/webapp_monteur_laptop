import type { StepResult, WorkStep } from '../types';
import { SpIcon } from './SpIcon';
import { t, type UiLang } from '../i18n';

interface WorkStepsTableProps {
  steps: WorkStep[];
  displayLang: UiLang;
  onResultChange: (id: string, result: StepResult) => void;
  onRemarkChange: (id: string, remark: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onReset: () => void;
}

function stepLabel(step: WorkStep, displayLang: UiLang): string {
  const de = String(step.labelDe || '').trim();
  const en = String(step.labelEn || '').trim();
  if (displayLang === 'en') return en || de || step.label;
  return de || en || step.label;
}

const RESULTS: { key: StepResult; label: string }[] = [
  { key: 'ok', label: 'OK' },
  { key: 'nok', label: 'n.i.O.' },
  { key: 'na', label: 'n.a.' },
];

export function WorkStepsTable({ steps, displayLang, onResultChange, onRemarkChange, onDelete, onAdd, onReset }: WorkStepsTableProps) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="sp-table-head">
              <th className="sp-table-cell w-10">{t(displayLang, 'no')}</th>
              <th className="sp-table-cell w-[9.5rem]">{t(displayLang, 'result')}</th>
              <th className="sp-table-cell w-[22%]">{t(displayLang, 'workStep')}</th>
              <th className="sp-table-cell">{t(displayLang, 'remark')}</th>
              <th className="sp-table-cell w-12 text-center"> </th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => (
              <tr key={step.id}>
                <td className="sp-table-cell text-center font-semibold text-[#4b5563]">{index + 1}</td>
                <td className="sp-table-cell p-1">
                  <div className="inline-flex overflow-hidden rounded-md border border-kukla-border">
                    {RESULTS.map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => onResultChange(step.id, r.key)}
                        className={`px-2.5 py-1 text-xs font-semibold ${
                          step.result === r.key
                            ? r.key === 'ok'
                              ? 'bg-kukla-green text-white'
                              : 'bg-kukla-mint text-[#111827]'
                            : 'bg-white text-[#4b5563] hover:bg-kukla-mint/60'
                        } ${r.key !== 'ok' ? 'border-l border-kukla-border' : ''}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="sp-table-cell text-sm font-medium text-[#111827]">{stepLabel(step, displayLang)}</td>
                <td className="sp-table-cell p-1">
                  <input
                    className="sp-input h-8 text-xs"
                    placeholder="optional"
                    value={step.remark}
                    onChange={(e) => onRemarkChange(step.id, e.target.value)}
                  />
                </td>
                <td className="sp-table-cell p-1 text-center">
                  <button
                    type="button"
                    aria-label={t(displayLang, 'deleteRow')}
                    onClick={() => onDelete(step.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-kukla-border bg-white hover:bg-kukla-mint"
                  >
                    <SpIcon name="X" className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-md border border-kukla-border bg-white px-3 py-1.5 text-sm font-semibold text-kukla-green hover:bg-kukla-mint/50"
        >
          <SpIcon name="Plus" className="h-4 w-4" />
          {t(displayLang, 'addStep')}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1.5 rounded-md border border-kukla-border bg-white px-3 py-1.5 text-sm font-semibold text-[#4b5563] hover:bg-kukla-mint/50"
        >
          {t(displayLang, 'resetList')}
        </button>
      </div>
    </div>
  );
}
