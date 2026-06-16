/**
 * Gemeinsamer Loader für Web-1:1-Views (Shell + Dispo-JS).
 */
(function (global) {
  const loadedScripts = new Set();

  global.kuklaDesktopPageReload = function kuklaDesktopPageReload() {
    document.dispatchEvent(new CustomEvent('kukla-page-reload'));
  };

  function loadScript(src, force) {
    if (!force && loadedScripts.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      document.querySelectorAll(`script[data-kukla-src="${src}"]`).forEach((el) => el.remove());
      loadedScripts.delete(src);
      fetch(src, { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((code) => {
          const s = document.createElement('script');
          s.dataset.kuklaSrc = src;
          const exportGlobals = [
            'if(typeof closeModal==="function")window.closeModal=closeModal;',
            'if(typeof loadList==="function")window.loadList=loadList;',
            'if(typeof initAnlagenColumnPanel==="function")window.initAnlagenColumnPanel=initAnlagenColumnPanel;',
            'if(typeof applyAnlagenColumnVisibility==="function")window.applyAnlagenColumnVisibility=applyAnlagenColumnVisibility;',
          ].join('');
          s.textContent = `(function(){\n${code}\n${exportGlobals}\n})();`;
          document.body.appendChild(s);
          // Inline-Skripte laufen synchron; onload feuert in Electron/Chromium oft nicht.
          loadedScripts.add(src);
          resolve();
        })
        .catch(reject);
    });
  }

  async function mount(host, options) {
    const { html, scripts = [], reloadHandler } = options;
    host.innerHTML = html;
    for (const src of scripts) {
      await loadScript(src, true);
    }
    if (reloadHandler && !host.dataset.reloadBound) {
      document.addEventListener('kukla-page-reload', reloadHandler);
      host.dataset.reloadBound = '1';
    }
  }

  global.kuklaWebPage = { loadScript, mount };
})(window);
