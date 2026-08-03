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
    const tid = resolveTechId();
    return {
      year: today.getFullYear(),
      monthNum: today.getMonth() + 1,
      month: today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0'),
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
    return `<link rel="stylesheet" href="css/abrechnung-web-parity.css">
<div class="page-abrechnung ab-sp-page">
  <div class="abrechnung-col ab-sp-col">
  <div class="sp-v2-topbar ab-sp-topbar">
    <h1 class="sp-v2-page-title"><img class="sp-v2-icon" src="icons/clipboard-service-green.svg" alt="" aria-hidden="true"> Abrechnung</h1>
  </div>

  <p class="ab-muted" id="abSyncHint" style="display:none;margin:0 0 12px 0;width:100%"></p>
  <div id="abFilterError" class="ab-banner" style="display:none"></div>
  <div id="abReadonlyBanner" class="ab-banner" style="display:none"></div>

  <div id="abStatusActionsWrap" class="ab-status-actions" style="display:none; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
    <button type="button" id="abAdminRevertBtn" class="btn" style="display:none;">Admin: Abgerechnet zurück auf Erledigt</button>
    <button type="button" id="abDispoInArbeitBtn" class="btn btn-primary" style="display:none;">Dispo: In Arbeit setzen</button>
  </div>

  <section class="sp-v2-section" aria-labelledby="abSecFilterTitle">
    <header class="sp-v2-section-head" id="abSecFilterTitle"><span class="sp-v2-num">1</span><img class="sp-v2-icon" src="icons/building2-green.svg" alt="" aria-hidden="true"> Auftrag &amp; Zeitraum</header>
    <div class="sp-v2-section-body">
      <form method="get" class="abrechnung-filters ab-sp-filters" id="abrechnungFilterForm" action="javascript:void(0)">
        <div class="sp-v2-grid-3">
          <label class="sp-v2-field">
            <span>Jahr</span>
            <select name="jahr" id="abYearSelect">${yearOptions(cfg)}</select>
          </label>
          <label class="sp-v2-field">
            <span>Monat</span>
            <select name="monat_num" id="abMonthNumSelect">${monthOptions(cfg)}</select>
          </label>
          <label class="sp-v2-field ab-filter-job">
            <span>Auftrag</span>
            <select name="id" id="abJobSelect">
              <option value="">— Monat wählen / laden …</option>
            </select>
          </label>
        </div>
        <label class="ab-filter-checkbox ab-sp-checkbox">
          <input type="checkbox" name="mit_abgerechnet" id="abShowAbgerechnet" value="1"${cfg.showAbgerechnet ? ' checked' : ''}>
          <span>Auch abgerechnete</span>
        </label>
      </form>
    </div>
  </section>

  <div class="sp-v2-form ab-sp-form" id="abMainBlocks" style="opacity:0.5;pointer-events:none">
    <div class="ab-card" data-bucket="dispo">
      <section class="sp-v2-section" aria-labelledby="abSecBillingTitle">
        <header class="sp-v2-section-head" id="abSecBillingTitle"><span class="sp-v2-num">2</span><img class="sp-v2-icon" src="icons/circle-check-green.svg" alt="" aria-hidden="true"> Fakturierung</header>
        <div class="sp-v2-section-body ab-billing-fields">
          <div class="ab-montage-billing-box">
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
      </section>

      <section class="sp-v2-section" aria-labelledby="abSecUploadTitle">
        <header class="sp-v2-section-head" id="abSecUploadTitle"><span class="sp-v2-num">3</span><img class="sp-v2-icon" src="icons/plus-green.svg" alt="" aria-hidden="true"> Belege hochladen</header>
        <div class="sp-v2-section-body">
          <div class="ab-beleg-upload" data-beleg-upload="dispo">
            <div class="ab-beleg-grid" data-beleg-grid="dispo"></div>
            <p class="ab-beleg-hint muted">Datei auf Icon ziehen oder Icon anklicken …</p>
          </div>
          <input type="file" class="ab-file-input hidden" data-bucket="dispo" multiple style="display:none">
        </div>
      </section>

      <section class="sp-v2-section" aria-labelledby="abSecFilesTitle">
        <header class="sp-v2-section-head" id="abSecFilesTitle"><span class="sp-v2-num">4</span><img class="sp-v2-icon" src="icons/clipboard-check-green.svg" alt="" aria-hidden="true"> Dateien</header>
        <div class="sp-v2-section-body">
          <ul class="ab-files" data-file-list="dispo"></ul>
        </div>
      </section>

      <section class="sp-v2-section" aria-labelledby="abSecCommentsTitle">
        <header class="sp-v2-section-head" id="abSecCommentsTitle"><span class="sp-v2-num">5</span><img class="sp-v2-icon" src="icons/pen-signature-green.svg" alt="" aria-hidden="true"> Kommentare</header>
        <div class="sp-v2-section-body ab-comments-block">
          <div class="ab-comment-list" data-comments-list="dispo"></div>
          <textarea class="ab-note" data-note="dispo" spellcheck="true" lang="de" placeholder="Neuen Kommentar eingeben …"></textarea>
          <div class="ab-note-actions">
            <button type="button" class="btn btn-primary ab-save-note" data-note-save="dispo" data-default-label="Kommentar hinzufügen">Kommentar hinzufügen</button>
            <button type="button" class="btn btn-ghost ab-cancel-note-edit" data-note-cancel="dispo" style="display:none">Abbrechen</button>
          </div>
        </div>
      </section>
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
    for (const k of ['job_id', 'id', 'jahr', 'monat_num', 'techniker', 'mit_abgerechnet']) {
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
        '/assets/js/dispo/job_subfolder_docs.js?v=20260802del',
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
