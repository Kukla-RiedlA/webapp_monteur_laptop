import type { InputHTMLAttributes, ReactNode } from 'react';

interface PriorInputProps extends InputHTMLAttributes<HTMLInputElement> {
  prior?: string;
  align?: 'left' | 'center';
  priorPrefix?: string;
}

/** Alter Wert hellblau im Feld. Der echte value bleibt leer, bis jemand tippt. */
export function PriorInput({
  value,
  prior,
  align = 'left',
  priorPrefix = 'Zuletzt',
  className = '',
  title,
  ...props
}: PriorInputProps) {
  const current = value == null ? '' : String(value);
  const old = String(prior || '').trim();
  const showGhost = old !== '' && current.trim() === '';
  const showDelta = old !== '' && current.trim() !== '' && current.trim() !== old;
  const alignClass = align === 'center' ? 'justify-center text-center' : 'justify-start text-left';
  const tip = old ? (title ? `${title} · ${priorPrefix}: ${old}` : `${priorPrefix}: ${old}`) : title;
  return (
    <div className={`relative min-w-0 w-full ${showDelta ? 'pb-3' : ''}`}>
      {showGhost ? (
        <span className={`pointer-events-none absolute inset-0 flex items-center truncate px-1 text-[#5B9BD5] ${alignClass}`}>{old}</span>
      ) : null}
      <input
        {...props}
        value={current}
        title={tip}
        className={`${className} ${showGhost ? 'bg-transparent text-transparent caret-[#111827]' : ''}`}
      />
      {showDelta ? (
        <span className={`pointer-events-none absolute inset-x-0 bottom-0 truncate px-1 text-[10px] leading-3 text-[#5B9BD5] ${alignClass}`}>{old}</span>
      ) : null}
    </div>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  suffix?: ReactNode;
  icon?: ReactNode;
  prior?: string;
  priorPrefix?: string;
}

export function TextInput({ label, suffix, icon, className = '', title, prior, priorPrefix, ...props }: TextInputProps) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5" title={title || label}>
      <span className="truncate text-xs font-semibold text-[#111827]">{label}</span>
      <div className="flex min-w-0 items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <PriorInput
            className={`sp-input ${icon ? 'pr-9' : ''} ${className}`}
            title={title}
            prior={prior}
            priorPrefix={priorPrefix}
            {...props}
          />
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
