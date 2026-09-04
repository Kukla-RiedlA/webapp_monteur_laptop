/** Anlaufart zählt als Frequenzumrichter (DE/EN, ML-PDF „Frequency converter“). */
export function isFuAnlaufart(value: unknown): boolean {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/ü/g, 'u')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return false;
  if (raw === 'fu' || raw === 'fc') return true;
  if (raw.includes('frequenzumrichter')) return true;
  if (raw.includes('frequency converter')) return true;
  return /\bfreq\b/.test(raw) && /\bconv/.test(raw);
}
