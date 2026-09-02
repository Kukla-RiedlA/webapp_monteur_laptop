import { t, type UiLang } from '../i18n';

interface ActionPanelProps {
  lang?: UiLang;
  onPdfCreate: () => void;
  onPdfCreateAll: () => void;
  onSaveData: () => void;
  onCancel: () => void;
}

export function ActionPanel({
  lang = 'de',
  onPdfCreate,
  onPdfCreateAll,
  onSaveData,
  onCancel,
}: ActionPanelProps) {
  return (
    <div className="rounded-xl border border-kukla-border bg-white p-4 shadow-card">
      <h3 className="mb-3 text-sm font-semibold text-[#111827]">{t(lang, 'actions')}</h3>
      <div className="flex flex-col gap-2">
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreate}>
          {t(lang, 'singlePdf')}
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onPdfCreateAll}>
          {t(lang, 'allPdf')}
        </button>
        <button type="button" className="sp-btn-primary w-full" onClick={onSaveData}>
          {t(lang, 'saveJson')}
        </button>
        <button type="button" className="sp-btn-outline w-full" onClick={onCancel}>
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  );
}
