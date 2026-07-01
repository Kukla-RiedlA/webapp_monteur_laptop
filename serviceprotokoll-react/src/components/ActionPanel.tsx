interface ActionPanelProps {
  pdfDe: boolean;
  pdfEn: boolean;
  onPdfDeChange: (v: boolean) => void;
  onPdfEnChange: (v: boolean) => void;
  onPdfCreate: () => void;
  onPdfCreateAll: () => void;
  onSaveData: () => void;
  onCancel: () => void;
}

export function ActionPanel({
  pdfDe,
  pdfEn,
  onPdfDeChange,
  onPdfEnChange,
  onPdfCreate,
  onPdfCreateAll,
  onSaveData,
  onCancel,
}: ActionPanelProps) {
  return (
    <div className="rounded-xl border border-kukla-border bg-white p-4 shadow-card">
      <p className="text-sm text-[#4b5563]">PDF-Sprache(n) für „PDF erstellen“:</p>
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <label className="inline-flex items-center gap-2 font-normal">
          <input type="checkbox" checked={pdfDe} onChange={(e) => onPdfDeChange(e.target.checked)} />
          Deutsch (DE)
        </label>
        <label className="inline-flex items-center gap-2 font-normal">
          <input type="checkbox" checked={pdfEn} onChange={(e) => onPdfEnChange(e.target.checked)} />
          Englisch (EN)
        </label>
      </div>
      <h3 className="mb-3 mt-4 text-sm font-semibold text-[#111827]">Aktionen</h3>
      <div className="flex flex-col gap-2">
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreate}>
          PDF erstellen
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreateAll}>
          Alle PDF erstellen
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onSaveData}>
          Speichern (nur Daten)
        </button>
        <button type="button" className="sp-btn-outline w-full" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
