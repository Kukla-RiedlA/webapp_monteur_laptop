import type { TestLoadValues } from '../types';

interface TestLoadFieldsProps {
  values: TestLoadValues;
  onChange: (field: keyof TestLoadValues, value: string) => void;
}

export function TestLoadFields({ values, onChange }: TestLoadFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <input
        className="sp-input h-[38px] text-sm"
        inputMode="decimal"
        aria-label="Prüfgewicht (kg)"
        value={values.weight}
        onChange={(e) => onChange('weight', e.target.value)}
      />
      <input
        className="sp-input h-[38px] text-sm"
        inputMode="decimal"
        aria-label="Anzeige (mV)"
        value={values.display}
        onChange={(e) => onChange('display', e.target.value)}
      />
      <input
        className="sp-input h-[38px] text-sm"
        inputMode="decimal"
        aria-label="Abweichung (%)"
        value={values.deviation}
        onChange={(e) => onChange('deviation', e.target.value)}
      />
      <input
        className="sp-input h-[38px] text-sm"
        type="text"
        inputMode="decimal"
        aria-label="Prüfgewichtstest Feld 4"
        value={values.value4}
        onChange={(e) => onChange('value4', e.target.value)}
      />
    </div>
  );
}
