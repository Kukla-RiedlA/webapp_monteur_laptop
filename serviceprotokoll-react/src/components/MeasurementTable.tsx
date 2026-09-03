import { memo } from 'react';
import type { MeasurementRow } from '../types';
import { t, type UiLang } from '../i18n';

interface MeasurementTableProps {
  rows: MeasurementRow[];
  displayLang?: UiLang;
  onChange: (id: string, field: keyof Omit<MeasurementRow, 'id' | 'label' | 'labelDe' | 'labelEn'>, value: string) => void;
}

function measurementLabel(row: MeasurementRow, displayLang: UiLang): string {
  const de = String(row.labelDe || '').trim();
  const en = String(row.labelEn || '').trim();
  if (displayLang === 'en') return en || de || row.label;
  return de || en || row.label;
}

export const MeasurementTable = memo(function MeasurementTable({ rows, displayLang = 'de', onChange }: MeasurementTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="sp-table-head">
            <th className="sp-table-cell w-[36%] text-left">{t(displayLang, 'point')}</th>
            <th className="sp-table-cell text-center">kg</th>
            <th className="sp-table-cell text-center">mV</th>
            <th className="sp-table-cell text-center">mA</th>
            <th className="sp-table-cell text-center">g %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="sp-table-cell bg-kukla-mint/40 text-left text-xs font-semibold text-[#4b5563]">
                {measurementLabel(row, displayLang)}
              </th>
              {(['kg', 'mv', 'ma', 'g'] as const).map((field) => (
                <td key={field} className="sp-table-cell p-1">
                  <input
                    className="sp-input h-8 w-full text-center text-sm"
                    value={row[field]}
                    onChange={(e) => onChange(row.id, field, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
