/**
 * Anlagenstamm — Web-1:1 wie Dispo Desktop (offline-first, lokale API).
 */
(function (global) {
  async function load(host, readOnly) {
    global.ANLAGENSTAMM_READ_ONLY = !!readOnly;
    const shellRes = await fetch('/templates/anlagenstamm-shell.html?v=20260817a');
    const shell = await shellRes.text();
    const reload = () => {
      if (host) delete host.dataset.inited;
      return load(host, readOnly);
    };
    await global.kuklaWebPage.mount(host, {
      html: shell,
      scripts: [
        '/js/monteur-image-gallery.js',
        '/assets/js/dispo/anlagenstamm_file_lists.js?v=20260701',
        '/assets/js/dispo/anlagenstamm_documents.js?v=20260817a',
        '/assets/js/dispo/anlagenakte.js?v=20260817a',
        '/assets/js/dispo/anlagenstamm_kraftaufnehmer_rows.js?v=20260701',
        '/assets/js/dispo/anlagenstamm.js?v=20260701',
        '/js/anlagenstamm-laptop-bridge.js?v=20260701',
      ],
      reloadHandler: reload,
    });
  }

  global.monteurAnlagenstamm = { load };
})(window);
