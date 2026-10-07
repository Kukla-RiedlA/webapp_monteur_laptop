interface NumberChipProps {
  value: string;
  subtitle?: string;
  active: boolean;
  included?: boolean;
  includeLabel?: string;
  onClick: () => void;
  onToggleInclude?: (included: boolean) => void;
}

export function NumberChip({
  value,
  subtitle,
  active,
  included = true,
  includeLabel,
  onClick,
  onToggleInclude,
}: NumberChipProps) {
  const selected = active && included;
  const typeText = String(subtitle || '').trim();
  const state = !included ? 'is-excluded' : selected ? 'is-active' : '';
  return (
    <div className={`fn-kartei-tab ${state}`}>
      <input
        type="checkbox"
        className="ml-2 mt-2 h-4 w-4 shrink-0 cursor-pointer accent-[#0e7b5a]"
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
        className={`flex min-h-[2.6rem] min-w-[4.5rem] flex-1 flex-col items-start justify-center px-2 py-1 text-left ${
          !included ? 'cursor-not-allowed text-[#6b7280]' : 'text-[#111827]'
        }`}
      >
        <span className="text-sm font-semibold leading-tight">{value}</span>
        {typeText ? (
          <span className="text-[0.7rem] font-normal leading-tight text-[#6b7280]">{typeText}</span>
        ) : null}
      </button>
    </div>
  );
}
