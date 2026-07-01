import type { InputHTMLAttributes, ReactNode } from 'react';

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  suffix?: ReactNode;
  icon?: ReactNode;
}

export function TextInput({ label, suffix, icon, className = '', ...props }: TextInputProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-[#111827]">{label}</span>
      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <input className={`sp-input ${icon ? 'pr-9' : ''} ${className}`} {...props} />
          {icon ? <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">{icon}</span> : null}
        </div>
        {suffix}
      </div>
    </label>
  );
}

interface SelectInputProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: { value: string; label: string }[];
}

export function SelectInput({ label, options, className = '', ...props }: SelectInputProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-[#111827]">{label}</span>
      <select className={`sp-input ${className}`} {...props}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
