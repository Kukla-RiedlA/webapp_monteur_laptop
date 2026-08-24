'use strict';

/**
 * Zufälliges Token je App-Start. Der Renderer bekommt es über Chromium webRequest
 * (Main-Prozess), nicht über HTTP. Andere lokale Prozesse können die APIs damit nicht nutzen.
 * GET /api/health und GET auf Nicht-/api-Pfade (UI) bleiben ohne Token.
 */
const crypto = require('crypto');

const HEADER = 'X-Kukla-Local-Token';
const token = crypto.randomBytes(32).toString('hex');

function getLocalGatewayToken() {
  return token;
}

function isPublicLocalGet(method, pathname) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  const p = String(pathname || '');
  if (p === '/api/health' || p === '/health') return true;
  // UI (HTML/CSS/JS/Bilder) muss auch laden, wenn der Chromium-Interceptor
  // nach einem Network-Service-Crash das Token nicht anhängt.
  return !p.startsWith('/api/');
}

function localGatewayExpressMiddleware(req, res, next) {
  const p = String(req.path || '');
  if (isPublicLocalGet(req.method, p)) {
    return next();
  }
  const sent = String(req.get(HEADER) || req.get('x-kukla-local-token') || '');
  if (sent && sent === token) return next();
  res.status(403).json({ ok: false, error: 'local_gateway_forbidden' });
}

function installLocalGatewayWebRequest(port) {
  const { session } = require('electron');
  const n = parseInt(String(port), 10);
  if (!n) return;
  const filter = {
    urls: [
      `http://127.0.0.1:${n}/*`,
      `http://localhost:${n}/*`,
      `http://[::1]:${n}/*`,
    ],
  };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = Object.assign({}, details.requestHeaders || {});
    headers[HEADER] = token;
    callback({ requestHeaders: headers });
  });
}

module.exports = {
  HEADER,
  getLocalGatewayToken,
  localGatewayExpressMiddleware,
  installLocalGatewayWebRequest,
};
