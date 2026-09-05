/**
 * Authentifizierter Reverse-Proxy zu Dispo-PHP-Seiten (Session-Cookies).
 * Ermöglicht iframe-Einbettung unter /dispo-remote/* mit gleicher Origin.
 */
const express = require('express');
const PROXY_PREFIX = '/dispo-remote';
const { setDispoPingResult } = require('./connection-state');
const { getLocalDataStats } = require('./local-data');

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
]);

function shouldRewriteContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html')
    || ct.includes('text/css')
    || ct.includes('javascript')
    || ct.includes('application/json')
    || ct.includes('text/xml')
    || ct.includes('application/xml')
  );
}

function rewriteAbsoluteUrls(text) {
  let out = text;
  const patterns = [
    [/(\b(?:href|src|action)\s*=\s*["'])\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    [/(\burl\s*\(\s*["']?)\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    [/(\bfetch\s*\(\s*["'])\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    [/(\bwindow\.open\s*\(\s*["'])\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    [/(\blocation\.(?:href|assign|replace)\s*=\s*["'])\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    [/(\bLocation:\s*)\/(?!\/)/gi, `$1${PROXY_PREFIX}/`],
    /* JS: var url = '/api/…' (z. B. Abrechnung-Download-Links in job_subfolder_docs.js) */
    [/([("'=+\s])\/(?!dispo-remote\/)(?=api\/)/gi, `$1${PROXY_PREFIX}/`],
  ];
  for (const [re, repl] of patterns) {
    out = out.replace(re, repl);
  }
  out = out.split(`${PROXY_PREFIX}${PROXY_PREFIX}`).join(PROXY_PREFIX);
  return out;
}

function injectEmbedChromeHide(html) {
  const style = '<style id="dispo-desktop-embed">'
    + '.app-header-nav-sticky,header.app-header,nav.app-nav,.nav-btn-logout,'
    + 'details.nav-admin-dropdown,.nav-dropdown-details{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}'
    + 'body,html{margin:0!important;padding:0!important;overflow:auto!important;width:100%!important;max-width:none!important;height:auto!important;min-height:100%!important}'
    + 'body.has-sticky-header{padding-top:0!important}'
    + '.page,.page-abrechnung,.job-page,.oi-page,.dispatch-board,main{'
    + 'max-width:none!important;width:100%!important;margin-left:0!important;margin-right:0!important;box-sizing:border-box!important}'
    + 'main.dispatch-board,.dispatch-board{'
    + 'height:auto!important;min-height:100%!important;max-height:none!important;margin:0!important}'
    + '.dispatch-board .jobs-open,.dispatch-board .calendar-section,.dispatch-board .calendar{min-height:0;overflow:visible}'
    + '.job-sticky-toolbar,.job-page .job-sticky-toolbar{top:0!important}'
    + '.page{padding-top:0!important;margin-top:0!important}'
    + 'body>.page,body>main{margin-top:0!important}'
  /* Anlagenstamm: Parität zu anlagenstamm.php im Desktop-Embed */
    + 'body{background:#fff!important;color:#1a1a1a!important;font-family:Kanit,system-ui,sans-serif!important}'
    + 'html body .page,body .page{'
    + 'padding:8px 12px!important;max-width:none!important;width:100%!important;margin:0!important;'
    + 'background:#fff!important;box-sizing:border-box!important}'
    + '.anlagen-page-head{width:100%!important;max-width:none!important;box-sizing:border-box!important}'
    + '.anlagen-page-head-left h2{color:#0e7b5a!important;margin:0 0 8px 0!important}'
    + '.anlagen-table-scroll{'
    + 'width:100%!important;max-width:none!important;'
    + 'height:calc(100vh - 200px)!important;min-height:280px!important;margin-top:8px!important;'
    + 'border:1px solid #ddd!important;border-radius:4px!important;background:#fff!important;box-sizing:border-box!important}'
    + '.anlagen-table-scroll table{width:100%!important;min-width:100%!important;font-size:12px!important}'
    + '.filter-row input{max-width:none!important;width:100%!important;min-width:0!important}'
    + '.anlagen-table-scroll th,.anlagen-table-scroll td{padding:6px 8px!important;font-size:12px!important}'
    + '.anlagen-table-scroll thead tr:first-child th{background:#f0f0f0!important}'
    + '.anlagen-table-scroll thead tr.filter-row th{background:#f0f0f0!important;top:26px!important}'
    + '.filter-row input{font-size:12px!important;border:1px solid #ccc!important;border-radius:4px!important}'
    + '.anlagen-column-panel{background:#f9fafb!important;border:1px solid #ddd!important}'
    + '#anlagenPagination{margin:8px 0!important}'
    + '</style>';
  const script = '<script id="dispo-desktop-embed-js">'
    + '(function(){var P="/dispo-remote";function rw(u){if(typeof u!=="string")return u;'
    + 'if(u.charAt(0)==="/"&&u.indexOf(P)!==0)return P+u;return u;}'
    + 'var _f=window.fetch;window.fetch=function(i,n){'
    + 'if(typeof i==="string")i=rw(i);else if(i&&typeof i.url==="string")i=new Request(rw(i.url),i);'
    + 'return _f.call(this,i,n);};'
    + 'var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){'
    + 'arguments[1]=rw(u);return _o.apply(this,arguments);};})();'
    + 'document.body.classList.remove("has-sticky-header");'
    + 'document.querySelectorAll(".app-header-nav-sticky,nav.app-nav").forEach(function(el){el.remove();});'
    + 'document.addEventListener("click",function(ev){'
    + 'var a=ev.target&&ev.target.closest?ev.target.closest("a[href]"):null;'
    + 'if(!a)return;var href=a.getAttribute("href");if(!href)return;'
    + 'var abs;try{abs=new URL(href,location.href).href;}catch(_){return;}'
    + 'var low=abs.toLowerCase();'
    + 'var pdf=low.indexOf(".pdf")>=0||/file_download|files_download|project_file_download|beleg.*download|anlagenstamm.*download/i.test(low);'
    + 'if(!pdf)return;ev.preventDefault();ev.stopPropagation();'
    + 'window.parent.postMessage({type:"dispo-desktop-open-pdf",url:abs},window.location.origin);'
    + '},true);'
    + '</script>';
  let out = html;
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${style}</head>`);
  } else {
    out = style + out;
  }
  if (out.includes('</body>')) {
    out = out.replace('</body>', `${script}</body>`);
  } else {
    out += script;
  }
  return out;
}

/** Jeder /dispo-remote-Aufruf ist Desktop-Embed — Parameter an Redirects anhängen. */
function ensureEmbedQuery(suffix) {
  const raw = suffix || '/';
  const qPos = raw.indexOf('?');
  const path = qPos >= 0 ? raw.slice(0, qPos) : raw;
  if (/^\/api\//i.test(path)) return raw;
  const params = new URLSearchParams(qPos >= 0 ? raw.slice(qPos + 1) : '');
  if (!params.has('desktop_embed')) params.set('desktop_embed', '1');
  if (/\.php$/i.test(path) && !params.has('popup')
    && !/\/index\.php$/i.test(path) && !/\/abrechnung\.php$/i.test(path)
    && !/\/belege\.php$/i.test(path) && !/\/outlook_import\.php$/i.test(path)
    && !/\/anlagenstamm\.php$/i.test(path)
    && !/\/monteure\.php$/i.test(path)) {
    params.set('popup', '1');
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function addEmbedToLocation(location) {
  if (!location || !location.startsWith(PROXY_PREFIX)) return location;
  const qPos = location.indexOf('?');
  const path = qPos >= 0 ? location.slice(0, qPos) : location;
  const params = new URLSearchParams(qPos >= 0 ? location.slice(qPos + 1) : '');
  if (!params.has('desktop_embed')) params.set('desktop_embed', '1');
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function rewriteLocation(location, dispoBase) {
  if (!location) return location;
  try {
    if (location.startsWith(PROXY_PREFIX)) return location;
    if (location.startsWith('/')) return PROXY_PREFIX + location;
    const u = new URL(location);
    const base = new URL(dispoBase);
    if (u.origin === base.origin) {
      return PROXY_PREFIX + u.pathname + u.search + u.hash;
    }
  } catch (_) {}
  return location;
}

function copyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
}

function filterRequestHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function createDispoHtmlProxyHandler(ctx) {
  return async function dispoHtmlProxyHandler(req, res) {
    if (!ctx.dispoProxy) {
      return res.status(503).send('Dispo-Proxy nicht bereit');
    }
    const suffix = ensureEmbedQuery(req.proxySuffix || req.originalUrl.replace(/^\/dispo-remote/, '') || '/');
    const init = {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      redirect: 'manual',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length) {
      init.body = req.body;
    }
    try {
      const { res: upstream, base } = await ctx.dispoProxy.fetchDispo(suffix, init);

      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const loc = upstream.headers.get('location');
        if (loc) {
          let target = rewriteLocation(loc, base);
          target = addEmbedToLocation(target);
          return res.redirect(upstream.status, target);
        }
      }

      const contentType = upstream.headers.get('content-type') || '';
      let body = Buffer.from(await upstream.arrayBuffer());

      if (shouldRewriteContentType(contentType)) {
        let text = body.toString('utf8');
        text = rewriteAbsoluteUrls(text);
        if (contentType.toLowerCase().includes('text/html')) {
          text = injectEmbedChromeHide(text);
        }
        body = Buffer.from(text, 'utf8');
      }

      res.status(upstream.status);
      copyResponseHeaders(upstream, res);
      res.send(body);
    } catch (e) {
      res.status(502).send(`Dispo-Proxy: ${e.message || 'fetch failed'}`);
    }
  };
}

/** Lokale Laptop-/Desktop-APIs (nicht an Dispo-Server proxen). req.path ist relativ zu /api-Mount. */
const LOCAL_API_PHP_PREFIXES = [
  '/abrechnung_',
  '/job_billing_',
  '/job_status_',
  '/mechanik_ted_excel_',
  '/anlagenstamm_file_download.php',
  '/anlagenstamm_gallery.php',
  '/anlagenstamm_documents_list.php',
];

function isLocalPhpApi(req) {
  const p = String(req.path || '');
  return LOCAL_API_PHP_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function registerDispoApiPhpProxyRoutes(app, ctx) {
  const handler = createDispoHtmlProxyHandler(ctx);
  const rawBody = express.raw({ type: () => true, limit: '128mb' });
  app.use('/api', (req, res, next) => {
    if (!/\.php$/i.test(req.path || '')) return next();
    if (isLocalPhpApi(req)) return next();
    rawBody(req, res, (err) => {
      if (err) return next(err);
      req.proxySuffix = req.originalUrl || req.url;
      return handler(req, res);
    });
  });
}

function registerDispoHtmlProxyRoutes(app, ctx) {
  app.get('/api/dispo/web-base', (_req, res) => {
    res.json({ ok: true, prefix: PROXY_PREFIX });
  });
  app.get('/api/dispo/ping', async (_req, res) => {
    const localStats = getLocalDataStats();
    try {
      if (!ctx.dispoProxy) {
        setDispoPingResult({ online: false, localStats });
        return res.json({ ok: false, online: false, localStats, localMode: localStats.has_usable_data });
      }
      if (ctx.applyDispoConnection) {
        const conn = await ctx.applyDispoConnection();
        if (!conn.auth.authenticated) {
          setDispoPingResult({ online: false, localStats });
          return res.json({
            ok: false,
            online: false,
            needLogin: !!conn.auth.needLogin,
            base: conn.base,
            hint: conn.auth.needLogin ? 'Anmeldung nötig' : conn.auth.error,
            localStats,
            localMode: localStats.has_usable_data,
          });
        }
        setDispoPingResult({ online: true, localStats });
        return res.json({
          ok: true,
          online: true,
          base: conn.base,
          source: conn.preferredSource,
          authReauth: conn.auth.reauth,
          localStats,
        });
      }
      await ctx.dispoProxy.getJson('/api/desktop/ping.php');
      setDispoPingResult({ online: true, localStats });
      res.json({ ok: true, online: true, localStats });
    } catch (e) {
      setDispoPingResult({ online: false, localStats });
      res.json({
        ok: false,
        online: false,
        error: e.message,
        hint: e.hint || null,
        localStats,
        localMode: localStats.has_usable_data,
      });
    }
  });

  app.get('/api/local/status', (_req, res) => {
    const localStats = getLocalDataStats();
    res.json({ ok: true, ...localStats, online: require('./connection-state').isDispoOnline() });
  });
}

module.exports = {
  createDispoHtmlProxyHandler,
  registerDispoHtmlProxyRoutes,
  registerDispoApiPhpProxyRoutes,
  PROXY_PREFIX,
};
