/**
 * Eigenes Electron-Fenster: nur die Anlagenakte (kein SPA-Overlay).
 */
(function (global) {
  async function boot() {
    global.KUKLA_ANLAGENSTAMM_AKTE_WINDOW = true;
    global.KUKLA_MONTEUR_LAPTOP = true;
    const params = new URLSearchParams(global.location.search);
    if (params.get('ro') === '1') global.ANLAGENSTAMM_READ_ONLY = true;
    const host = document.getElementById('anlagenstamm-akte-host');
    if (!host || !global.kuklaWebPage) return;
    const shellRes = await fetch('/templates/anlagenstamm-akte-form.html?v=20260819akte');
    const shell = await shellRes.text();
    const scripts = [
      '/js/monteur-image-gallery.js',
      '/js/anlagenstamm-thumb-loader.js?v=20260909thumbs',
      '/assets/js/dispo/anlagenstamm_file_lists.js?v=20260904hang',
      '/assets/js/dispo/anlagenstamm_documents.js?v=20260904hang',
      '/assets/js/dispo/anlagenakte-form-viewer.js?v=20260819akte',
      '/assets/js/dispo/anlagenakte.js?v=20260909thumbs',
      '/js/anlagenstamm-parameter-tab.js?v=20260911param',
      '/js/parameter-text-compare.js?v=20260911param',
      '/assets/js/dispo/anlagenstamm_kraftaufnehmer_rows.js?v=20260819akte',
      '/assets/js/dispo/anlagenstamm_motor_rows.js?v=20260904motor3',
      '/assets/js/dispo/anlagenstamm.js?v=20260906ml',
      '/js/anlagenstamm-laptop-bridge.js?v=20260908csv2',
    ];
    await global.kuklaWebPage.mount(host, { html: shell, scripts: scripts });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot().catch(function (e) { console.error(e); }); });
  } else {
    boot().catch(function (e) { console.error(e); });
  }
})(window);
