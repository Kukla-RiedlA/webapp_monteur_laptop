export type MassUnit = 't' | 'kg' | 'g';
export type RateUnit = 't/h' | 'kg/h';

const MASS_TO_KG: Record<MassUnit, number> = { t: 1000, kg: 1, g: 0.001 };
const RATE_TO_TH: Record<RateUnit, number> = { 't/h': 1, 'kg/h': 0.001 };

export function normMassUnit(value: string | undefined, fallback: MassUnit): MassUnit {
  return value === 't' || value === 'kg' || value === 'g' ? value : fallback;
}

export function normRateUnit(value: string | undefined, fallback: RateUnit): RateUnit {
  return value === 't/h' || value === 'kg/h' ? value : fallback;
}

export function massFactor(fromU: MassUnit, toU: MassUnit): number {
  return MASS_TO_KG[fromU] / MASS_TO_KG[toU];
}

export function rateFactor(fromU: RateUnit, toU: RateUnit): number {
  return RATE_TO_TH[fromU] / RATE_TO_TH[toU];
}

export function scaleAmount(raw: string, factor: number): string {
  if (factor === 1) return raw == null ? '' : String(raw);
  const s = String(raw || '').trim();
  if (!s) return '';
  const n = parseFloat(s.replace(',', '.'));
  if (!Number.isFinite(n)) return s;
  const v = Math.round(n * factor * 1e6) / 1e6;
  const text = String(v);
  return s.indexOf(',') >= 0 ? text.replace('.', ',') : text;
}
