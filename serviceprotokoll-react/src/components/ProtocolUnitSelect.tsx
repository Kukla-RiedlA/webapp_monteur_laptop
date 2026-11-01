interface ProtocolUnitSelectProps {
  kind: 'mass' | 'rate';
  value: string;
  label: string;
  onChange: (value: string) => void;
}

export function ProtocolUnitSelect({ kind, value, label, onChange }: ProtocolUnitSelectProps) {
  const options = kind === 'rate' ? ['t/h', 'kg/h'] : ['t', 'kg', 'g'];
  return (
    <select
      className="mt-0.5 block h-6 w-full max-w-[4.6rem] rounded border border-kukla-border bg-white px-0.5 text-[0.72rem] font-bold text-[#0c6a4d]"
      aria-label={label}
      value={options.includes(value) ? value : options[0]}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
