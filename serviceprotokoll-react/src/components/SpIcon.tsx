import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  Calendar,
  Check,
  CircleCheck,
  ClipboardCheck,
  ClipboardList,
  Factory,
  LineChart,
  MoreVertical,
  PenLine,
  Plus,
  Save,
  Scale,
  X,
} from 'lucide-react';

/** Custom SVGs aus serviceprotokoll_icons_exakt_nachgebaut (grün), Lucide als Fallback. */
const CUSTOM_ICON: Partial<Record<string, string>> = {
  ClipboardList: '/icons/clipboard-title-green.svg',
  Factory: '/icons/factory-green.svg',
  Building2: '/icons/building2-green.svg',
  Scale: '/icons/scale-balance-green.svg',
  LineChart: '/icons/chart-up-green.svg',
  ClipboardCheck: '/icons/clipboard-check-green.svg',
  Save: '/icons/save-green.svg',
  Plus: '/icons/plus-green.svg',
  X: '/icons/x-delete-green.svg',
  Calendar: '/icons/calendar-green.svg',
  PenLine: '/icons/pen-signature-green.svg',
  MoreVertical: '/icons/dots-vertical-green.svg',
  Check: '/icons/check-green.svg',
  CircleCheck: '/icons/circle-check-green.svg',
};

const LUCIDE_MAP: Record<string, LucideIcon> = {
  ClipboardList,
  Factory,
  Building2,
  Scale,
  LineChart,
  ClipboardCheck,
  Save,
  Plus,
  X,
  Calendar,
  PenLine,
  MoreVertical,
  Check,
  CircleCheck,
};

export type SpIconName = keyof typeof LUCIDE_MAP;

interface SpIconProps {
  name: SpIconName;
  className?: string;
  title?: string;
}

export function SpIcon({ name, className = 'h-5 w-5', title }: SpIconProps) {
  const src = CUSTOM_ICON[name];
  if (src) {
    return <img src={src} alt="" aria-hidden={!title} title={title} className={className} />;
  }
  const Lucide = LUCIDE_MAP[name];
  return (
    <span className="inline-flex" title={title} aria-hidden={!title}>
      <Lucide className={className} />
    </span>
  );
}
