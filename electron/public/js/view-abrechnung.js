/**
 * Abrechnung — Web-1:1 wie Dispo (abrechnung.php + job_subfolder_docs.js).
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';
  const MONTH_NAMES = ['', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  function resolveTechId() {
    if (typeof global.getTechId === 'function') return global.getTechId();
    if (global.MonteurRamsBridge && typeof global.MonteurRamsBridge.getTechId === 'function') {
      return global.MonteurRamsBridge.getTechId();
    }
    try {
      const tid = localStorage.getItem('monteur_technicianId');
      return tid ? parseInt(tid, 10) : 0;
    } catch (_) {
      return 0;
    }
  }

  async function jfetch(path) {
    const headers = global.kuklaAbrechnungFetchHeaders
      ? global.kuklaAbrechnungFetchHeaders()
      : {};
    const r = await fetch(api + path, { credentials: 'same-origin', headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function defaultConfig() {
    const today = new Date();
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const tid = resolveTechId();
    return {
      year: prev.getFullYear(),
      monthNum: prev.getMonth() + 1,
      month: prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0'),
      technician: tid,
      hideTechnicianFilter: true,
      billingFlagsEditable: false,
      laptopMonthOnly: true,
      fromLaptopEmbed: true,
      techniciansForFilter: [],
      current_user_id: tid,
    };
  }

  function yearOptions(cfg) {
    const y = new Date().getFullYear();
    const min = y - 5;
    const max = y + 3;
    let html = '';
    for (let yr = min; yr <= max; yr++) {
      html += `<option value="${yr}"${cfg.year === yr ? ' selected' : ''}>${yr}</option>`;
    }
    return html;
  }

  function monthOptions(cfg) {
    let html = '';
    for (let m = 1; m <= 12; m++) {
      html += `<option value="${m}"${cfg.monthNum === m ? ' selected' : ''}>${MONTH_NAMES[m]}</option>`;
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderShell(cfg) {
    return `<style id="abrechnung-inline-parity">
#abrechnung-host .page-abrechnung{padding:20px;width:100%;max-width:none;margin:0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center}
#abrechnung-host .abrechnung-col{display:flex;flex-direction:column;align-items:stretch;width:fit-content;max-width:100%}
#abrechnung-host .abrechnung-col>h1{margin:0 0 16px 0;font-size:1.25rem;align-self:flex-start;width:100%}
#abrechnung-host .abrechnung-filters{display:flex;flex-wrap:nowrap;gap:12px;align-items:flex-end;margin-bottom:20px;width:100%;overflow-x:auto}
#abrechnung-host .abrechnung-filters label{display:flex;flex-direction:column;font-size:12px;gap:4px;margin:0;flex:0 0 auto;white-space:nowrap}
#abrechnung-host .abrechnung-filters label.ab-filter-job{flex:1 1 0;min-width:280px}
#abrechnung-host .abrechnung-filters select{min-width:200px;padding:6px 8px;width:auto;max-width:none;display:block;border:1px solid #ccc;border-radius:4px;font-size:13px;background:#fff;color:#1a1a1a;box-sizing:border-box}
#abrechnung-host #abJobSelect{width:100%;min-width:0}
#abrechnung-host .ab-grid{display:grid;grid-template-columns:1fr;gap:16px;width:100%;max-width:none;margin:0}
#abrechnung-host .ab-banner,#abrechnung-host .ab-status-actions{width:100%;box-sizing:border-box}
#abrechnung-host .ab-card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;width:100%;box-sizing:border-box}
#abrechnung-host .ab-card h2{margin:0;font-size:1rem;font-weight:700;color:#1a1a1a}
#abrechnung-host .ab-note{width:100%;min-height:90px;font-size:13px;padding:8px;box-sizing:border-box}
</style>
<div class="page-abrechnung">
  <div class="abrechnung-col">
  <h1>Abrechnung</h1>
  <form method="get" class="abrechnung-filters" id="abrechnungFilterForm" action="javascript:void(0)">
    <label>
      Jahr
      <select name="jahr" id="abYearSelect">${yearOptions(cfg)}</select>
    </label>
    <label>
      Monat
      <select name="monat_num" id="abMonthNumSelect">${monthOptions(cfg)}</select>
    </label>
    <label class="ab-filter-job">
      Auftrag
      <select name="id" id="abJobSelect">
        <option value="">— Monat wählen / laden …</option>
      </select>
    </label>
  </form>

  <p class="ab-muted" id="abSyncHint" style="display:none;margin:0 0 12px 0;width:100%"></p>
  <div id="abFilterError" class="ab-banner" style="display:none"></div>
  <div id="abReadonlyBanner" class="ab-banner" style="display:none"></div>

  <div id="abStatusActionsWrap" class="ab-status-actions" style="display:none; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
    <button type="button" id="abAdminRevertBtn" class="btn" style="display:none;">Admin: Abgerechnet zurück auf Erledigt</button>
    <button type="button" id="abDispoInArbeitBtn" class="btn btn-primary" style="display:none;">Dispo: In Arbeit setzen</button>
  </div>

  <div class="ab-grid" id="abMainBlocks" style="opacity:0.5;pointer-events:none">
    <div class="ab-card" data-bucket="dispo">
      <div class="ab-card-header">
        <h2>Abrechnung</h2>
      </div>
      <div class="ab-billing-fields">
        <div class="ab-montage-billing-box" style="border-top:none;padding-top:0">
          <div class="ab-montage-mv-block">
            <label class="ab-montage-mv-label" for="abBillingMontageVerrechnet">
              <input type="checkbox" id="abBillingMontageVerrechnet" value="1" disabled>
              <span>Fakturierung Montage</span>
            </label>
            <div class="ab-montage-meta-line" id="abMvMeta" style="display:none"></div>
          </div>
          <div class="ab-et-row" id="abEtRow">
            <label class="ab-montage-et-label" for="abBillingEt">
              <input type="checkbox" id="abBillingEt" value="1" disabled>
              <span>Fakturierung ET</span>
            </label>
            <div class="ab-montage-meta-line" id="abEtMeta" style="display:none"></div>
          </div>
        </div>
        <div class="ab-travel-box" id="abTravelMount"></div>
      </div>
      <div class="ab-dropzone" data-dropzone="dispo">Dateien hierher ziehen oder klicken …</div>
      <input type="file" class="ab-file-input hidden" data-bucket="dispo" multiple style="display:none">
      <ul class="ab-files" data-file-list="dispo"></ul>
      <div class="ab-comments-block">
      <label class="muted ab-comments-label">Kommentare</label>
      <div class="ab-comment-list" data-comments-list="dispo"></div>
      <textarea class="ab-note" data-note="dispo" placeholder="Neuen Kommentar eingeben …"></textarea>
      <div class="ab-note-actions">
        <button type="button" class="btn btn-primary ab-save-note" data-note-save="dispo" data-default-label="Kommentar hinzufügen">Kommentar hinzufügen</button>
        <button type="button" class="btn btn-ghost ab-cancel-note-edit" data-note-cancel="dispo" style="display:none">Abbrechen</button>
      </div>
      </div>
    </div>
  </div>
  <p class="ab-muted" id="abHintChoose">Bitte einen Auftrag wählen.</p>
  </div>
</div>`;
  }

  async function fetchPageConfig() {
    const u = new URL(global.location.href);
    const q = new URLSearchParams();
    const tid = resolveTechId();
    if (tid > 0) q.set('technician_id', String(tid));
    for (const k of ['job_id', 'id', 'jahr', 'monat_num', 'techniker']) {
      const v = u.searchParams.get(k);
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    try {
      const data = await jfetch('/api/abrechnung/page-config' + (qs ? `?${qs}` : ''));
      return data.config || defaultConfig();
    } catch (err) {
      console.warn('[abrechnung] page-config:', err);
      return defaultConfig();
    }
  }

  async function load(host) {
    if (!host) return;
    if (!global.kuklaWebPage || typeof global.kuklaWebPage.mount !== 'function') {
      host.innerHTML = '<p class="ab-muted">Abrechnungs-Loader nicht verfügbar (web-page-host.js).</p>';
      return;
    }

    const cfg = await fetchPageConfig();
    global.KUKLA_ABRECHNUNG = cfg;

    const reload = () => load(host);
    await global.kuklaWebPage.mount(host, {
      html: renderShell(cfg),
      scripts: [
        '/assets/js/dispo/job_subfolder_docs.js?v=20260616g',
      ],
      reloadHandler: reload,
    });
    if (typeof global.kuklaAbrechnungRunInitialJobList === 'function') {
      global.kuklaAbrechnungRunInitialJobList();
    } else if (typeof global.kuklaAbrechnungReapply === 'function') {
      global.kuklaAbrechnungReapply(cfg);
    }
    if (typeof global.kuklaAbrechnungAfterMount === 'function') {
      global.kuklaAbrechnungAfterMount(cfg);
    }
  }

  global.monteurAbrechnung = { load };
})(window);
