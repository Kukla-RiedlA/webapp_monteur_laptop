import type { MeasurementRow } from '../types';

interface MeasurementTableProps {
  rows: MeasurementRow[];
  onChange: (id: string, field: keyof Omit<MeasurementRow, 'id' | 'label'>, value: string) => void;
}

export function MeasurementTable({ rows, onChange }: MeasurementTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="sp-table-head">
            <th className="sp-table-cell w-[36%] text-left">Messpunkt</th>
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
                {row.label}
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
}
