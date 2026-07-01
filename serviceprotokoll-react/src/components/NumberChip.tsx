import { SpIcon } from './SpIcon';

interface NumberChipProps {
  value: string;
  active: boolean;
  onClick: () => void;
}

export function NumberChip({ value, active, onClick }: NumberChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-[38px] min-w-[4.5rem] items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition ${
        active
          ? 'border-kukla-green bg-kukla-green text-white shadow-card'
          : 'border-kukla-border bg-white text-[#111827] hover:bg-kukla-mint'
      }`}
    >
      {active ? <SpIcon name="Check" className="h-4 w-4" /> : null}
      {value}
    </button>
  );
}
