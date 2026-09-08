import { SpIcon } from './SpIcon';

interface NumberChipProps {
  value: string;
  active: boolean;
  included?: boolean;
  includeLabel?: string;
  onClick: () => void;
  onToggleInclude?: (included: boolean) => void;
}

export function NumberChip({
  value,
  active,
  included = true,
  includeLabel,
  onClick,
  onToggleInclude,
}: NumberChipProps) {
  const selected = active && included;
  return (
    <div
      className={`inline-flex h-[38px] items-center rounded-lg border ${
        !included
          ? 'border-[#d1d5db] bg-[#e5e7eb] text-[#6b7280]'
          : selected
            ? 'border-kukla-green bg-kukla-green text-white shadow-card'
            : 'border-kukla-border bg-white text-[#111827]'
      }`}
    >
      <input
        type="checkbox"
        className="ml-2 h-4 w-4 shrink-0 cursor-pointer accent-[#0e7b5a]"
        checked={included}
        aria-label={includeLabel || value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (onToggleInclude) onToggleInclude(e.target.checked);
        }}
      />
      <button
        type="button"
        disabled={!included}
        onClick={onClick}
        className={`inline-flex h-full min-w-[3.5rem] items-center justify-center gap-1.5 px-3 text-sm font-semibold transition ${
          !included
            ? 'cursor-not-allowed text-[#6b7280]'
            : selected
              ? 'text-white'
              : 'hover:bg-kukla-mint'
        }`}
      >
        {selected ? <SpIcon name="Check" className="h-4 w-4" /> : null}
        {value}
      </button>
    </div>
  );
}
