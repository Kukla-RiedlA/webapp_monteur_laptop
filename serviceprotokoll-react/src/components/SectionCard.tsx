import type { ReactNode } from 'react';
import { SpIcon, type SpIconName } from './SpIcon';

interface SectionCardProps {
  number: number;
  title: string;
  icon?: SpIconName;
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}

export function SectionCard({ number, title, icon, headerExtra, children, className = '', compact = false }: SectionCardProps) {
  return (
    <section className={`overflow-hidden rounded-xl border border-kukla-border bg-white shadow-card ${className}`}>
      <header
        className={`flex items-center justify-between gap-2 border-b border-kukla-border bg-kukla-mint ${compact ? 'px-3 py-2' : 'px-4 py-2.5'}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex shrink-0 items-center justify-center rounded-full bg-kukla-green font-bold text-white ${compact ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-xs'}`}
          >
            {number}
          </span>
          {icon ? <SpIcon name={icon} className={compact ? 'h-4 w-4 shrink-0' : 'h-5 w-5 shrink-0'} /> : null}
          <h2 className={`truncate font-semibold text-[#111827] ${compact ? 'text-xs' : 'text-sm'}`}>{title}</h2>
        </div>
        {headerExtra ? <div className="shrink-0">{headerExtra}</div> : null}
      </header>
      <div className={compact ? 'p-3' : 'p-4'}>{children}</div>
    </section>
  );
}
