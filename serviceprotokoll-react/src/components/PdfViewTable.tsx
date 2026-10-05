interface PdfViewTableProps {
  columns: string[];
  rows: string[][];
  footer?: string[];
  /** Spalten ohne Wert weglassen. */
  compact?: boolean;
}

export function PdfViewTable({ columns, rows, footer, compact = false }: PdfViewTableProps) {
  let idx = columns.map((label, i) => ({ label, i }));
  if (compact) {
    idx = idx.filter((c) => rows.some((r) => String(r[c.i] || '').trim()));
  }
  const body = rows.filter((r) => idx.some((c) => String(r[c.i] || '').trim()));
  if (!body.length || !idx.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-xs text-[#111827]">
        <thead>
          <tr className="bg-[#0e7b5a] text-left text-white">
            {idx.map((c) => (
              <th key={c.label + c.i} className="px-2 py-1.5 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-t border-kukla-border">
              {idx.map((c) => (
                <td key={c.i} className="px-2 py-1.5 align-top">
                  {String(row[c.i] || '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && footer.length ? (
          <tfoot>
            <tr className="border-t border-kukla-border bg-kukla-mint font-semibold text-[#0c6a4d]">
              {idx.map((c) => (
                <td key={c.i} className="px-2 py-1.5">
                  {footer[c.i] || ''}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
