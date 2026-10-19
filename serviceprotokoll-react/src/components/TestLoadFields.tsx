import type { TestLoadValues } from '../types';
import { t, type UiLang } from '../i18n';
import { PriorInput } from './TextInput';

interface TestLoadFieldsProps {
  values: TestLoadValues;
  prior?: TestLoadValues | null;
  lang?: UiLang;
  onChange: (field: keyof TestLoadValues, value: string) => void;
}

const FIELDS: { key: keyof TestLoadValues; label: string }[] = [
  { key: 'weight', label: '1 (%)' },
  { key: 'display', label: '2 (%)' },
  { key: 'deviation', label: '3 (%)' },
  { key: 'value4', label: '4 (%)' },
];

export function TestLoadFields({ values, prior, lang = 'de', onChange }: TestLoadFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {FIELDS.map(({ key, label }) => (
        <label key={key} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.72rem] font-semibold text-neutral-500">{label}</span>
          <PriorInput
            className="sp-input h-[38px] text-sm"
            inputMode="decimal"
            priorPrefix={t(lang, 'lastValue')}
            prior={prior ? prior[key] : ''}
            aria-label={`${t(lang, 'deviation')} ${label}`}
            value={values[key]}
            onChange={(e) => onChange(key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
