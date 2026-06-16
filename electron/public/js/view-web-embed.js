/**
 * Dispo-Web-Embed wie Dispo Desktop (iframe über /dispo-remote).
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';
  const EMBED = 'desktop_embed=1';

  let webPrefix = '/dispo-remote';
  let online = true;
  let forceNative = false;

  const VIEW_PATHS = {
  };

  const WEB_VIEWS = new Set(Object.keys(VIEW_PATHS));

  async function refreshOnline() {
    try {
      const r = await fetch(api + '/api/dispo/ping');
      const d = await r.json();
      online = !!d.online;
    } catch (_) {
      online = false;
    }
    return online;
  }

  function resolvePath(viewName) {
    return VIEW_PATHS[viewName] || null;
  }

  function viewPanel(viewName) {
    return document.querySelector('[data-view="' + viewName + '"]');
  }

  function hostForView(viewName) {
    const panel = viewPanel(viewName);
    if (!panel) return null;
    let host = panel.querySelector('.web-embed-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'web-embed-host';
      panel.appendChild(host);
    }
    return host;
  }

  function hideNativeContent(viewName) {
    const panel = viewPanel(viewName);
    if (!panel) return;
    panel.classList.add('view-web-active');
    panel.querySelectorAll(':scope > *:not(.web-embed-host)').forEach(function (el) {
      el.dataset.webEmbedHidden = '1';
      el.hidden = true;
    });
  }

  function showNativeContent(viewName) {
    const panel = viewPanel(viewName);
    if (!panel) return;
    panel.classList.remove('view-web-active');
    panel.querySelectorAll('[data-web-embed-hidden]').forEach(function (el) {
      el.hidden = false;
      delete el.dataset.webEmbedHidden;
    });
    const host = panel.querySelector('.web-embed-host');
    if (host) {
      host.innerHTML = '';
      host.remove();
    }
  }

  function mountIframe(host, path) {
    const src = webPrefix + path;
    host.innerHTML =
      '<iframe class="web-embed-frame" title="Anlagenstamm (Dispo)" src="' +
      src +
      '" referrerpolicy="no-referrer"></iframe>';
  }

  async function shouldUseWeb(viewName) {
    if (forceNative || !WEB_VIEWS.has(viewName)) return false;
    await refreshOnline();
    return online;
  }

  async function show(viewName) {
    const p = resolvePath(viewName);
    if (!p) return false;
    const host = hostForView(viewName);
    if (!host) return false;
    hideNativeContent(viewName);
    mountIframe(host, p);
    return true;
  }

  async function init() {
    try {
      const r = await fetch(api + '/api/dispo/web-base');
      const d = await r.json();
      if (d.prefix) webPrefix = d.prefix;
    } catch (_) {}
    await refreshOnline();
  }

  global.monteurWebEmbed = {
    init,
    show,
    shouldUseWeb,
    showNativeContent,
    setForceNative: function (v) {
      forceNative = !!v;
    },
    isOnline: function () {
      return online;
    },
    refreshOnline,
  };
})(window);
