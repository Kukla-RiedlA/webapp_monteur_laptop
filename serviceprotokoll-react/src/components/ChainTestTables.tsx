import type { ChainMessRow, ChainRow } from '../types';
import { chainMessHasData, chainRowHasData, emptyChainMessRow, emptyChainRow } from '../types';
import { t, type UiLang } from '../i18n';

function parseNum(raw: string): number | null {
  const s = String(raw || '').trim().replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number, digits: number): string {
  return n.toFixed(digits);
}

function fmtPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2);
}

export function recalcChainRow(row: ChainRow, recalcMeter: boolean): ChainRow {
  const next = { ...row };
  if (recalcMeter) {
    const laenge = parseNum(row.laenge);
    const gewicht = parseNum(row.gewicht_pro_kette);
    next.gewicht_pro_meter = '';
    if (laenge != null && laenge !== 0 && gewicht != null) next.gewicht_pro_meter = fmt(gewicht / laenge, 4);
  }
  return next;
}

export function recalcChainMess(row: ChainMessRow): ChainMessRow {
  const next = { ...row, pruefkette_t: '', fehler_prozent: '', leistung_th: '' };
  const band = parseNum(row.bandwaage_t);
  const kgm = parseNum(row.kg_pro_m);
  const geschw = parseNum(row.geschwindigkeit_ms);
  const messzeit = parseNum(row.messzeit_s);
  if (messzeit != null && messzeit >= 1 && kgm != null && geschw != null) {
    const pk = (kgm * geschw * messzeit) / 1000;
    next.pruefkette_t = fmt(pk, 4);
    if (band != null && pk !== 0) next.fehler_prozent = fmtPct(((band - pk) / pk) * 100);
    next.leistung_th = fmt((pk / messzeit) * 3600, 1);
  }
  return next;
}

function meterFromChains(rows: ChainRow[]): string {
  const marked = rows.filter((r) => r.in_summe !== false && chainRowHasData(r));
  let sumLaenge = 0;
  let sumGewicht = 0;
  let sumMeter = 0;
  let nLaenge = 0;
  let nGewicht = 0;
  let nMeter = 0;
  marked.forEach((k) => {
    const laenge = parseNum(k.laenge);
    const gewicht = parseNum(k.gewicht_pro_kette);
    const meter = parseNum(k.gewicht_pro_meter);
    if (laenge != null) {
      sumLaenge += laenge;
      nLaenge += 1;
    }
    if (gewicht != null) {
      sumGewicht += gewicht;
      nGewicht += 1;
    }
    if (meter != null) {
      sumMeter += meter;
      nMeter += 1;
    }
  });
  if (nMeter) return fmt(sumMeter, 4);
  if (nLaenge && nGewicht && sumLaenge !== 0) return fmt(sumGewicht / sumLaenge, 4);
  return '';
}

function applyMeterToMess(mess: ChainMessRow[], meter: string): ChainMessRow[] {
  if (!meter) return mess;
  return mess.map((m) => recalcChainMess({ ...m, kg_pro_m: meter }));
}

const CHAIN_COLS: Array<{ key: keyof ChainRow; de: string; en: string }> = [
  { key: 'tag', de: 'Tag', en: 'Tag' },
  { key: 'ketten_type', de: 'Ketten Type', en: 'Chain type' },
  { key: 'laenge', de: 'Länge', en: 'Length' },
  { key: 'gewicht_pro_kette', de: 'Gewicht / Kette', en: 'Weight / chain' },
  { key: 'gewicht_pro_meter', de: 'Gewicht / Meter', en: 'Weight / metre' },
];

const MESS_COLS: Array<{ key: keyof ChainMessRow; de: string; en: string }> = [
  { key: 'bandwaage_t', de: 'Bandwaage [t]', en: 'Belt [t]' },
  { key: 'pruefkette_t', de: 'Prüfkette [t]', en: 'Test chain [t]' },
  { key: 'kg_pro_m', de: 'kg/m', en: 'kg/m' },
  { key: 'geschwindigkeit_ms', de: 'Geschw. [m/s]', en: 'Speed [m/s]' },
  { key: 'messzeit_s', de: 'Messzeit [s]', en: 'Time [s]' },
  { key: 'fehler_prozent', de: 'Fehler [%]', en: 'Error [%]' },
  { key: 'leistung_th', de: 'Leistung [t/h]', en: 'Capacity [t/h]' },
  { key: 'bemerkung', de: 'Bemerkung', en: 'Remark' },
];

function chainSums(rows: ChainRow[]): Record<string, string> {
  const included = rows.filter((r) => r.in_summe !== false && chainRowHasData(r));
  let sumLaenge = 0;
  let sumGewicht = 0;
  let nLaenge = 0;
  let nGewicht = 0;
  included.forEach((k) => {
    const laenge = parseNum(k.laenge);
    const gewicht = parseNum(k.gewicht_pro_kette);
    if (laenge != null) {
      sumLaenge += laenge;
      nLaenge += 1;
    }
    if (gewicht != null) {
      sumGewicht += gewicht;
      nGewicht += 1;
    }
  });
  return {
    laenge: nLaenge ? fmt(sumLaenge, 3) : '',
    gewicht_pro_kette: nGewicht ? fmt(sumGewicht, 3) : '',
    gewicht_pro_meter: meterFromChains(rows),
  };
}

function messSums(rows: ChainMessRow[]): Record<string, string> {
  const included = rows.filter((r) => r.in_summe !== false && chainMessHasData(r));
  let sumBand = 0;
  let sumPk = 0;
  let sumKgm = 0;
  let sumZeit = 0;
  let sumLeist = 0;
  let nLeist = 0;
  let nBand = 0;
  let nPk = 0;
  let nKgm = 0;
  let nZeit = 0;
  included.forEach((m) => {
    const band = parseNum(m.bandwaage_t);
    const pk = parseNum(m.pruefkette_t);
    const kgm = parseNum(m.kg_pro_m);
    const zeit = parseNum(m.messzeit_s);
    const leist = parseNum(m.leistung_th);
    if (band != null) {
      sumBand += band;
      nBand += 1;
    }
    if (pk != null) {
      sumPk += pk;
      nPk += 1;
    }
    if (kgm != null) {
      sumKgm += kgm;
      nKgm += 1;
    }
    if (zeit != null) {
      sumZeit += zeit;
      nZeit += 1;
    }
    if (leist != null) {
      sumLeist += leist;
      nLeist += 1;
    }
  });
  return {
    bandwaage_t: nBand ? fmt(sumBand, 3) : '',
    pruefkette_t: nPk ? fmt(sumPk, 3) : '',
    kg_pro_m: nKgm ? fmt(sumKgm, 4) : '',
    messzeit_s: nZeit ? fmt(sumZeit, 0) : '',
    fehler_prozent: nPk && sumPk !== 0 ? fmtPct(((sumBand - sumPk) / sumPk) * 100) : '',
    leistung_th: nLeist ? fmt(sumLeist / nLeist, 1) : '',
  };
}

function MiniTable({
  columns,
  rows,
  footer,
}: {
  columns: string[];
  rows: string[][];
  footer: string[];
}) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-xs text-[#111827]">
        <thead>
          <tr className="bg-[#0e7b5a] text-left text-white">
            <th className="px-2 py-1.5 font-semibold">#</th>
            {columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-kukla-border">
              <td className="px-2 py-1.5 font-semibold">{i + 1}</td>
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-kukla-border bg-kukla-mint font-semibold text-[#0c6a4d]">
            {footer.map((cell, i) => (
              <td key={i} className="px-2 py-1.5">
                {cell}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function chainTestSummary(chains: ChainRow[], mess: ChainMessRow[], lang: UiLang) {
  const filledChains = chains.filter(chainRowHasData);
  const filledMess = mess.filter(chainMessHasData);
  if (!filledChains.length && !filledMess.length) return null;
  const de = lang !== 'en';
  const cSums = chainSums(filledChains);
  const mSums = messSums(filledMess);
  return (
    <div className="space-y-3">
      {filledChains.length ? (
        <div>
          <div className="mb-1 text-sm font-bold text-[#0c6a4d]">{t(lang, 'chainData')}</div>
          <MiniTable
            columns={CHAIN_COLS.map((c) => (de ? c.de : c.en))}
            rows={filledChains.map((row) => CHAIN_COLS.map((c) => String(row[c.key] || '')))}
            footer={[
              'Σ',
              de ? 'Summe' : 'Total',
              '',
              cSums.laenge,
              cSums.gewicht_pro_kette,
              cSums.gewicht_pro_meter,
            ]}
          />
        </div>
      ) : null}
      {filledMess.length ? (
        <div>
          <div className="mb-1 text-sm font-bold text-[#0c6a4d]">{t(lang, 'chainMeasurements')}</div>
          <MiniTable
            columns={MESS_COLS.map((c) => (de ? c.de : c.en))}
            rows={filledMess.map((row) => MESS_COLS.map((c) => String(row[c.key] || '')))}
            footer={[
              'Σ',
              mSums.bandwaage_t,
              mSums.pruefkette_t,
              mSums.kg_pro_m,
              '',
              mSums.messzeit_s,
              mSums.fehler_prozent,
              mSums.leistung_th,
              de ? 'Summe' : 'Total',
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

interface ChainTestTablesProps {
  lang: UiLang;
  chains: ChainRow[];
  measurements: ChainMessRow[];
  onChange: (chains: ChainRow[], measurements: ChainMessRow[]) => void;
}

export function ChainTestTables({ lang, chains, measurements, onChange }: ChainTestTablesProps) {
  const chainList = chains.length ? chains : [emptyChainRow()];
  const messList = measurements.length ? measurements : [emptyChainMessRow()];
  const cSums = chainSums(chainList);
  const mSums = messSums(messList);
  const dash = (v: string) => v || '–';

  function commit(nextChains: ChainRow[], nextMess: ChainMessRow[], pushMeter: boolean) {
    const meter = pushMeter ? meterFromChains(nextChains) : '';
    onChange(nextChains, pushMeter ? applyMeterToMess(nextMess, meter) : nextMess);
  }

  function patchChain(idx: number, partial: Partial<ChainRow>, recalcMeter: boolean) {
    const next = chainList.map((r, i) => (i === idx ? recalcChainRow({ ...r, ...partial }, recalcMeter) : r));
    commit(next, messList, true);
  }

  function patchMess(idx: number, partial: Partial<ChainMessRow>) {
    const next = messList.map((r, i) => (i === idx ? recalcChainMess({ ...r, ...partial }) : r));
    onChange(chainList, next);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-bold text-[#0c6a4d]">{t(lang, 'chainData')}</div>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-kukla-border bg-white px-3 text-xs font-semibold text-[#0c6a4d] hover:bg-kukla-mint"
            onClick={() => onChange([...chainList, emptyChainRow()], messList)}
          >
            {t(lang, 'addChain')}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-xs">
            <thead>
              <tr className="bg-kukla-mint text-left text-[#0c6a4d]">
                {['#', t(lang, 'chainTag'), t(lang, 'chainType'), t(lang, 'chainLength'), t(lang, 'chainWeight'), t(lang, 'chainPerMeter'), 'Σ / ×'].map(
                  (h) => (
                    <th key={h} className="px-1 py-1 font-semibold">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {chainList.map((row, idx) => (
                <tr key={idx} className="border-t border-kukla-border">
                  <td className="px-1 py-1 font-semibold">{idx + 1}</td>
                  <td className="px-1 py-1">
                    <input className="h-8 w-full rounded border border-kukla-border px-1" value={row.tag} onChange={(e) => patchChain(idx, { tag: e.target.value }, false)} />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      className="h-8 w-full min-w-[10rem] rounded border border-kukla-border px-1"
                      value={row.ketten_type}
                      onChange={(e) => patchChain(idx, { ketten_type: e.target.value }, false)}
                    />
                  </td>
                  {(
                    [
                      ['laenge', true],
                      ['gewicht_pro_kette', true],
                    ] as Array<[keyof ChainRow, boolean]>
                  ).map(([key, calc]) => (
                    <td key={key} className="px-1 py-1">
                      <input
                        className="h-8 w-full rounded border border-kukla-border px-1"
                        inputMode="decimal"
                        value={String(row[key] || '')}
                        onChange={(e) => patchChain(idx, { [key]: e.target.value }, calc)}
                      />
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    <input
                      className="h-8 w-full rounded border border-kukla-border px-1"
                      inputMode="decimal"
                      title={lang === 'en' ? 'Calculated from weight/length, still editable' : 'Wird aus Gewicht/Länge berechnet, ist aber editierbar'}
                      value={row.gewicht_pro_meter}
                      onChange={(e) => patchChain(idx, { gewicht_pro_meter: e.target.value }, false)}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={row.in_summe !== false}
                        title={t(lang, 'inSum')}
                        aria-label={t(lang, 'inSum')}
                        onChange={(e) => patchChain(idx, { in_summe: e.target.checked }, false)}
                      />
                      <button
                        type="button"
                        className="px-1 text-base leading-none"
                        title={t(lang, 'removeChain')}
                        onClick={() => {
                          const next = chainList.length <= 1 ? [emptyChainRow()] : chainList.filter((_, i) => i !== idx);
                          commit(next, messList, true);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-kukla-border bg-kukla-mint font-semibold text-[#0c6a4d]">
                <td className="px-1 py-1">Σ</td>
                <td className="px-1 py-1" colSpan={2}>
                  {t(lang, 'chainSum')}
                </td>
                <td className="px-1 py-1">{dash(cSums.laenge)}</td>
                <td className="px-1 py-1">{dash(cSums.gewicht_pro_kette)}</td>
                <td className="px-1 py-1">{dash(cSums.gewicht_pro_meter)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-bold text-[#0c6a4d]">{t(lang, 'chainMeasurements')}</div>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-kukla-border bg-white px-3 text-xs font-semibold text-[#0c6a4d] hover:bg-kukla-mint"
            onClick={() => {
              const meter = meterFromChains(chainList);
              const blank = recalcChainMess({ ...emptyChainMessRow(), kg_pro_m: meter });
              onChange(chainList, [...messList, blank]);
            }}
          >
            {t(lang, 'addChainMeasurement')}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-xs">
            <thead>
              <tr className="bg-kukla-mint text-left text-[#0c6a4d]">
                {[
                  '#',
                  t(lang, 'chainBelt'),
                  t(lang, 'chainProof'),
                  t(lang, 'chainKgM'),
                  t(lang, 'chainSpeed'),
                  t(lang, 'chainTime'),
                  t(lang, 'errorPct'),
                  t(lang, 'rateTh'),
                  t(lang, 'remark'),
                  'Σ / PDF / ×',
                ].map((h) => (
                  <th key={h} className="px-1 py-1 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {messList.map((row, idx) => (
                <tr key={idx} className="border-t border-kukla-border">
                  <td className="px-1 py-1 font-semibold">{idx + 1}</td>
                  {(
                    [
                      ['bandwaage_t', false],
                      ['pruefkette_t', true],
                      ['kg_pro_m', false],
                      ['geschwindigkeit_ms', false],
                      ['messzeit_s', false],
                      ['fehler_prozent', true],
                      ['leistung_th', true],
                    ] as Array<[keyof ChainMessRow, boolean]>
                  ).map(([key, readonly]) => (
                    <td key={key} className="px-1 py-1">
                      <input
                        className="h-8 w-full rounded border border-kukla-border px-1 read-only:bg-[#f3f4f6]"
                        inputMode="decimal"
                        readOnly={readonly}
                        tabIndex={readonly ? -1 : undefined}
                        value={String(row[key] || '')}
                        onChange={(e) => patchMess(idx, { [key]: e.target.value })}
                      />
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    <input
                      className="h-8 w-full rounded border border-kukla-border px-1"
                      value={row.bemerkung}
                      onChange={(e) => patchMess(idx, { bemerkung: e.target.value })}
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
                          patchMess(idx, { in_summe: on, in_pdf: on ? true : row.in_pdf });
                        }}
                      />
                      <input
                        type="checkbox"
                        checked={row.in_pdf !== false}
                        title={t(lang, 'inPdf')}
                        aria-label={t(lang, 'inPdf')}
                        onChange={(e) => patchMess(idx, { in_pdf: e.target.checked })}
                      />
                      <button
                        type="button"
                        className="px-1 text-base leading-none"
                        title={t(lang, 'removeChainMeasurement')}
                        onClick={() => {
                          const next = messList.length <= 1 ? [emptyChainMessRow()] : messList.filter((_, i) => i !== idx);
                          onChange(chainList, next);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-kukla-border bg-kukla-mint font-semibold text-[#0c6a4d]">
                <td className="px-1 py-1">Σ</td>
                <td className="px-1 py-1">{dash(mSums.bandwaage_t)}</td>
                <td className="px-1 py-1">{dash(mSums.pruefkette_t)}</td>
                <td className="px-1 py-1">{dash(mSums.kg_pro_m)}</td>
                <td className="px-1 py-1">–</td>
                <td className="px-1 py-1">{dash(mSums.messzeit_s)}</td>
                <td className="px-1 py-1">{dash(mSums.fehler_prozent)}</td>
                <td className="px-1 py-1">{dash(mSums.leistung_th)}</td>
                <td className="px-1 py-1" colSpan={2}>
                  {t(lang, 'chainMessSum')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
