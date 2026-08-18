interface ActionPanelProps {
  onPdfCreate: () => void;
  onPdfCreateAll: () => void;
  onSaveData: () => void;
  onCancel: () => void;
}

export function ActionPanel({
  onPdfCreate,
  onPdfCreateAll,
  onSaveData,
  onCancel,
}: ActionPanelProps) {
  return (
    <div className="rounded-xl border border-kukla-border bg-white p-4 shadow-card">
      <h3 className="mb-3 text-sm font-semibold text-[#111827]">Aktionen</h3>
      <div className="flex flex-col gap-2">
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreate}>
          einzel PDF
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreateAll}>
          Alle PDF
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onSaveData}>
          Speichern (JSON)
        </button>
        <button type="button" className="sp-btn-outline w-full" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
