/**
 * Anlagenstamm — Web-1:1 wie Dispo Desktop (offline-first, lokale API).
 */
(function (global) {
  async function load(host, readOnly) {
    global.ANLAGENSTAMM_READ_ONLY = !!readOnly;
    const shellRes = await fetch('/templates/anlagenstamm-shell.html?v=20260819akte');
    const shell = await shellRes.text();
    const reload = () => {
      if (host) delete host.dataset.inited;
      return load(host, readOnly);
    };
    await global.kuklaWebPage.mount(host, {
      html: shell,
      scripts: [
        '/js/monteur-image-gallery.js',
        '/js/anlagenstamm-thumb-loader.js?v=20260901thumb',
        '/assets/js/dispo/anlagenstamm_file_lists.js?v=20260901thumb',
        '/assets/js/dispo/anlagenstamm_documents.js?v=20260819akte',
        '/assets/js/dispo/anlagenakte-form-viewer.js?v=20260817c',
        '/assets/js/dispo/anlagenakte.js?v=20260901thumb',
        '/assets/js/dispo/anlagenstamm_kraftaufnehmer_rows.js?v=20260819akte',
        '/assets/js/dispo/anlagenstamm_motor_rows.js?v=20260904motor',
        '/assets/js/dispo/anlagenstamm.js?v=20260904motor',
        '/js/anlagenstamm-laptop-bridge.js?v=20260901thumb',
      ],
      reloadHandler: reload,
    });
  }

  global.monteurAnlagenstamm = { load };
})(window);
