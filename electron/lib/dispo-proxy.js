/**
 * HTTP client to Dispo with session cookie jar.
 */
const fs = require('fs');
const path = require('path');
const { buildDispoBaseCandidates, tryDispoBasesInOrder, normalizeDispoBase, isFetchNetworkError } = require('./dispo-base-fallback');
const { formatFetchError } = require('./dispo-tls');

function createCookieJar() {
  const cookies = new Map();
  return {
    setFromResponse(res, baseUrl) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const single = res.headers.get('set-cookie');
      const list = raw.length ? raw : single ? [single] : [];
      const host = new URL(baseUrl).hostname;
      for (const line of list) {
        const part = line.split(';')[0];
        const eq = part.indexOf('=');
        if (eq > 0) {
          cookies.set(`${host}:${part.slice(0, eq)}`, part);
        }
      }
    },
    headerFor(baseUrl) {
      const host = new URL(baseUrl).hostname;
      const parts = [];
      for (const [key, val] of cookies) {
        if (key.startsWith(host + ':')) parts.push(val);
      }
      return parts.join('; ');
    },
    toJSON() {
      return Object.fromEntries(cookies);
    },
    loadJSON(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) cookies.set(k, v);
    },
  };
}

function createDispoProxy(options = {}) {
  const jar = options.cookieJar || createCookieJar();
  const config = {
    baseUrl: normalizeDispoBase(options.baseUrl || ''),
    externalUrl: normalizeDispoBase(options.externalUrl || ''),
    internalUrl: normalizeDispoBase(options.internalUrl || ''),
    urlMode: options.urlMode || 'auto',
    allowInsecureTls: !!options.allowInsecureTls,
    dispoUsername: options.dispoUsername || '',
    dispoPassword: options.dispoPassword || '',
  };

  function bases() {
    return buildDispoBaseCandidates(config).filter(Boolean);
  }

  function httpsAltBase(base) {
    try {
      const u = new URL(base);
      if (u.protocol === 'http:') return `https://${u.host}${u.pathname.replace(/\/$/, '')}`;
      if (u.protocol === 'https:') return `http://${u.host}${u.pathname.replace(/\/$/, '')}`;
    } catch (_) {}
    return '';
  }

  async function fetchDispo(pathSuffix, init = {}) {
    const suffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
    const candidateBases = [...bases()];
    for (const b of [...candidateBases]) {
      const alt = httpsAltBase(b);
      if (alt && !candidateBases.includes(alt)) candidateBases.push(alt);
    }
    return tryDispoBasesInOrder(candidateBases, async (base) => {
      const url = base + suffix;
      const headers = { ...(init.headers || {}) };
      const cookie = jar.headerFor(base);
      if (cookie) headers.Cookie = cookie;
      if (!headers.Authorization && config.dispoUsername) {
        headers.Authorization =
          'Basic ' + Buffer.from(`${config.dispoUsername}:${config.dispoPassword || ''}`).toString('base64');
      }
      let res;
      try {
        res = await fetch(url, { ...init, headers, redirect: init.redirect || 'follow' });
      } catch (err) {
        const wrapped = new Error(formatFetchError(err, base));
        wrapped.cause = err;
        throw wrapped;
      }
      jar.setFromResponse(res, base);
      return { res, base };
    });
  }

  async function getJson(pathSuffix) {
    const { res } = await fetchDispo(pathSuffix, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function postJson(pathSuffix, body) {
    const { res } = await fetchDispo(pathSuffix, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return { jar, config, fetchDispo, getJson, postJson, setConfig(patch) {
    Object.assign(config, patch);
  }};
}

function sessionFilePath(userDataDir) {
  return path.join(userDataDir, 'session.json');
}

function loadSession(userDataDir) {
  const p = sessionFilePath(userDataDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveSession(userDataDir, data) {
  const p = sessionFilePath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  createDispoProxy,
  createCookieJar,
  loadSession,
  saveSession,
  sessionFilePath,
};
