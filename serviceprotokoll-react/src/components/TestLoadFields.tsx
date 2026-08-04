import type { TestLoadValues } from '../types';

interface TestLoadFieldsProps {
  values: TestLoadValues;
  onChange: (field: keyof TestLoadValues, value: string) => void;
}

const FIELDS: { key: keyof TestLoadValues; label: string }[] = [
  { key: 'weight', label: '1 (%)' },
  { key: 'display', label: '2 (%)' },
  { key: 'deviation', label: '3 (%)' },
  { key: 'value4', label: '4 (%)' },
];

export function TestLoadFields({ values, onChange }: TestLoadFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {FIELDS.map(({ key, label }) => (
        <label key={key} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.72rem] font-semibold text-neutral-500">{label}</span>
          <input
            className="sp-input h-[38px] text-sm"
            inputMode="decimal"
            aria-label={`Abweichung ${label}`}
            value={values[key]}
            onChange={(e) => onChange(key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
