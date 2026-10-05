import type { WeighingRow } from '../types';
import { emptyWeighingRow, weighingRowHasData } from '../types';
import { t, type UiLang } from '../i18n';

function parseNum(raw: string): number | null {
  const s = String(raw || '').trim().replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/** Kontrollwaage aus Brutto − Tara, Fehler aus Bandwaage − Kontrollwaage. */
export function recalcWeighing(row: WeighingRow, fromTaraBrutto: boolean): WeighingRow {
  const next = { ...row };
  if (fromTaraBrutto) {
    const tara = parseNum(row.tara_kg);
    const brutto = parseNum(row.brutto_kg);
    if (tara != null && brutto != null) next.kontrollwaage_kg = fmt(brutto - tara);
  }
  const band = parseNum(next.bandwaage_kg);
  const kontr = parseNum(next.kontrollwaage_kg);
  if (band == null || kontr == null) {
    next.fehler_kg = '';
    next.fehler_prozent = '';
  } else {
    const fk = band - kontr;
    next.fehler_kg = fmt(fk);
    next.fehler_prozent = kontr !== 0 ? fmt((fk / kontr) * 100) : '';
  }
  return next;
}

const VIEW_COLS: Array<{ key: keyof WeighingRow; de: string; en: string }> = [
  { key: 'bandwaage_kg', de: 'Band', en: 'Belt' },
  { key: 'kontrollwaage_kg', de: 'Kontr.', en: 'Ctrl' },
  { key: 'fehler_kg', de: 'kg', en: 'kg' },
  { key: 'fehler_prozent', de: '%', en: '%' },
  { key: 'leistung_th', de: 't/h', en: 't/h' },
  { key: 'tara_kg', de: 'Tara', en: 'Tare' },
  { key: 'brutto_kg', de: 'Brutto', en: 'Gross' },
  { key: 'bemerkung', de: 'Bemerkung', en: 'Remark' },
];

function weighingSums(rows: WeighingRow[]): Record<string, string> {
  const included = rows.filter((r) => r.in_summe !== false && weighingRowHasData(r));
  const sums: Record<string, string> = {};
  (['bandwaage_kg', 'kontrollwaage_kg', 'fehler_kg', 'leistung_th', 'tara_kg', 'brutto_kg'] as Array<keyof WeighingRow>).forEach((k) => {
    const nums = included.map((r) => parseNum(String(r[k] || ''))).filter((n): n is number => n != null);
    if (!nums.length) sums[k] = '';
    else if (k === 'leistung_th') sums[k] = fmt(nums.reduce((a, b) => a + b, 0) / nums.length);
    else sums[k] = fmt(nums.reduce((a, b) => a + b, 0));
  });
  let sumBand = 0;
  let sumKontr = 0;
  let hasPair = false;
  included.forEach((r) => {
    const b = parseNum(r.bandwaage_kg);
    const k = parseNum(r.kontrollwaage_kg);
    if (b != null && k != null) {
      sumBand += b;
      sumKontr += k;
      hasPair = true;
    }
  });
  if (hasPair) sums.fehler_kg = fmt(sumBand - sumKontr);
  sums.fehler_prozent = hasPair && sumKontr !== 0 ? fmt(((sumBand - sumKontr) / sumKontr) * 100) : '';
  return sums;
}

export function weighingSummary(rows: WeighingRow[], lang: UiLang) {
  const filled = rows.filter(weighingRowHasData);
  if (!filled.length) return null;
  const sums = weighingSums(filled);
  const de = lang !== 'en';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-xs text-[#111827]">
        <thead>
          <tr className="bg-[#0e7b5a] text-left text-white">
            <th className="px-2 py-1.5 font-semibold">#</th>
            {VIEW_COLS.map((c) => (
              <th key={c.key} className="px-2 py-1.5 font-semibold">
                {de ? c.de : c.en}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filled.map((row, i) => (
            <tr key={i} className="border-t border-kukla-border">
              <td className="px-2 py-1.5 font-semibold">{i + 1}</td>
              {VIEW_COLS.map((c) => (
                <td key={c.key} className="px-2 py-1.5">
                  {String(row[c.key] || '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-kukla-border bg-kukla-mint font-semibold text-[#0c6a4d]">
            <td className="px-2 py-1.5">Σ</td>
            {VIEW_COLS.map((c) => (
              <td key={c.key} className="px-2 py-1.5">
                {c.key === 'bemerkung' ? (de ? 'Summe' : 'Total') : sums[c.key] || ''}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

interface WeighingsTableProps {
  lang: UiLang;
  rows: WeighingRow[];
  onChange: (rows: WeighingRow[]) => void;
}

export function WeighingsTable({ lang, rows, onChange }: WeighingsTableProps) {
  const list = rows.length ? rows : [emptyWeighingRow()];

  function patch(idx: number, partial: Partial<WeighingRow>, fromTaraBrutto: boolean) {
    const next = list.map((r, i) => (i === idx ? recalcWeighing({ ...r, ...partial }, fromTaraBrutto) : r));
    onChange(next);
  }

  function remove(idx: number) {
    if (list.length <= 1) {
      onChange([emptyWeighingRow()]);
      return;
    }
    onChange(list.filter((_, i) => i !== idx));
  }

  const sums = weighingSums(list);
  const dash = (v: string) => v || '–';

  const headers = [
    '#',
    t(lang, 'beltScale'),
    t(lang, 'controlScale'),
    t(lang, 'errorKg'),
    t(lang, 'errorPct'),
    t(lang, 'rateTh'),
    t(lang, 'tareKg'),
    t(lang, 'grossKg'),
    t(lang, 'remark'),
  ];

  return (
    <div>
      <button
        type="button"
        className="mb-3 inline-flex h-8 items-center rounded-lg border border-kukla-border bg-white px-3 text-xs font-semibold text-[#0c6a4d] hover:bg-kukla-mint"
        onClick={() => onChange([...list, emptyWeighingRow()])}
      >
        {t(lang, 'addWeighing')}
      </button>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-xs">
          <thead>
            <tr className="bg-kukla-mint text-left text-[#0c6a4d]">
              {headers.map((h) => (
                <th key={h} className="px-1 py-1 font-semibold">
                  {h}
                </th>
              ))}
              <th className="px-1 py-1 font-semibold">Σ / PDF / ×</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row, idx) => (
              <tr key={idx} className="border-t border-kukla-border">
                <td className="px-1 py-1 font-semibold">{idx + 1}</td>
                {(
                  [
                    ['bandwaage_kg', false],
                    ['kontrollwaage_kg', false],
                    ['fehler_kg', false],
                    ['fehler_prozent', false],
                    ['leistung_th', false],
                    ['tara_kg', true],
                    ['brutto_kg', true],
                  ] as Array<[keyof WeighingRow, boolean]>
                ).map(([key, tara]) => (
                  <td key={key} className="px-1 py-1">
                    <input
                      className="h-8 w-full rounded border border-kukla-border px-1"
                      inputMode="decimal"
                      value={String(row[key] || '')}
                      onChange={(e) => patch(idx, { [key]: e.target.value }, tara)}
                    />
                  </td>
                ))}
                <td className="px-1 py-1">
                  <input
                    className="h-8 w-full rounded border border-kukla-border px-1"
                    value={row.bemerkung}
                    onChange={(e) => patch(idx, { bemerkung: e.target.value }, false)}
                  />
                </td>
                <td className="px-1 py-1">
                  <div className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={row.in_summe !== false}
                      title={t(lang, 'inSum')}
                      aria-label={t(lang, 'inSum')}
                      onChange={(e) => {
                        const on = e.target.checked;
                        patch(idx, { in_summe: on, in_pdf: on ? true : row.in_pdf }, false);
                      }}
                    />
                    <input
                      type="checkbox"
                      checked={row.in_pdf !== false}
                      title={t(lang, 'inPdf')}
                      aria-label={t(lang, 'inPdf')}
                      onChange={(e) => patch(idx, { in_pdf: e.target.checked }, false)}
                    />
                    <button type="button" className="px-1 text-base leading-none" title={t(lang, 'removeWeighing')} onClick={() => remove(idx)}>
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-kukla-border bg-kukla-mint/60 font-semibold">
              <td className="px-1 py-1">Σ</td>
              <td className="px-1 py-1">{dash(sums.bandwaage_kg)}</td>
              <td className="px-1 py-1">{dash(sums.kontrollwaage_kg)}</td>
              <td className="px-1 py-1">{dash(sums.fehler_kg)}</td>
              <td className="px-1 py-1">{dash(sums.fehler_prozent)}</td>
              <td className="px-1 py-1">{dash(sums.leistung_th)}</td>
              <td className="px-1 py-1">{dash(sums.tara_kg)}</td>
              <td className="px-1 py-1">{dash(sums.brutto_kg)}</td>
              <td className="px-1 py-1" colSpan={2}>
                {t(lang, 'sumMarked')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
