/**
 * Dispo-Login für Desktop-Gateway: Desktop-API, Form-Login, Basic-Auth-Fallback.
 */
const { normalizeDispoBase } = require('./dispo-base-fallback');

function basicAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
}

function isLoginRedirectSuccess(status, location) {
  if (![301, 302, 303, 307, 308].includes(status)) return false;
  const loc = (location || '').toLowerCase();
  if (!loc) return false;
  if (/\/login\.php(?:\?|$)/.test(loc)) return false;
  return loc.includes('index.php');
}

function isProtocolUpgradeRedirect(location) {
  const loc = (location || '').toLowerCase();
  return loc.includes('login_action.php');
}

async function resolveDispoBaseUrl(proxy, baseUrl) {
  const normalized = normalizeDispoBase(baseUrl || '');
  if (!normalized) return normalized;
  try {
    const u = new URL(normalized);
    if (u.protocol === 'https:') return normalized;
    const { res, base } = await proxy.fetchDispo('/login.php', { method: 'GET', redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    if ([301, 302, 303, 307, 308].includes(res.status) && loc.toLowerCase().startsWith('https://')) {
      try {
        const httpsBase = normalizeDispoBase(new URL(loc).origin);
        if (httpsBase) return httpsBase;
      } catch (_) {}
    }
    if (res.status === 200 && base && base.startsWith('https://')) return base;
  } catch (_) {}
  return normalized.replace(/^http:\/\//i, 'https://');
}

async function loginViaDesktopApi(proxy, username, password) {
  return proxy.postJson('/api/desktop/login.php', { username, password });
}

async function loginViaFormAction(proxy, username, password) {
  const body = new URLSearchParams({ username: username || '', password: password || '' }).toString();
  const postInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  };

  let { res, base } = await proxy.fetchDispo('/login_action.php', postInit);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get('location') || '';
    if (isProtocolUpgradeRedirect(location)) {
      if (location.toLowerCase().startsWith('https://')) {
        try {
          base = normalizeDispoBase(new URL(location).origin);
          proxy.setConfig({ baseUrl: base, internalUrl: base });
        } catch (_) {}
      }
      ({ res, base } = await proxy.fetchDispo('/login_action.php', postInit));
      continue;
    }
    if (isLoginRedirectSuccess(res.status, location)) {
      return { base, via: 'form' };
    }
    throw new Error('Benutzername oder Passwort falsch');
  }

  if (!res.ok && res.status !== 302) {
    throw new Error('Login fehlgeschlagen (HTTP ' + res.status + ')');
  }
  return { base, via: 'form' };
}

async function loginViaBasicAuth(proxy, username, password) {
  const auth = basicAuthHeader(username, password);
  const { res } = await proxy.fetchDispo('/api/jobs_open.php', {
    method: 'GET',
    headers: { Authorization: auth },
    redirect: 'manual',
  });
  if (res.status === 401) {
    throw new Error('Benutzername oder Passwort falsch');
  }
  if (!res.ok) {
    throw new Error('Login-Prüfung fehlgeschlagen (HTTP ' + res.status + ')');
  }
  return {
    ok: true,
    username: username || '',
    full_name: username || '',
    user_id: 0,
    perm_dispo: true,
    perm_buchhaltung: false,
    buchhaltung_only: false,
    auth_mode: 'basic',
    dispo_username: username || '',
    dispo_password: password || '',
  };
}

async function fetchSessionAfterFormLogin(proxy) {
  try {
    return await proxy.getJson('/api/desktop/auth_session.php');
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function performDispoLogin(proxy, { username, password, dispo_base }) {
  const resolvedBase = await resolveDispoBaseUrl(proxy, dispo_base);
  if (resolvedBase) {
    proxy.setConfig({ baseUrl: resolvedBase });
  }

  let sessionData = null;
  let base = resolvedBase || dispo_base || '';

  try {
    sessionData = await loginViaDesktopApi(proxy, username, password);
    base = proxy.config.baseUrl || base;
  } catch (desktopErr) {
    if (desktopErr.status && desktopErr.status !== 404 && desktopErr.status !== 405) {
      if (desktopErr.status === 401) throw new Error('Benutzername oder Passwort falsch');
      throw desktopErr;
    }
    try {
      const form = await loginViaFormAction(proxy, username, password);
      base = form.base || base;
      sessionData = await fetchSessionAfterFormLogin(proxy);
      if (!sessionData || sessionData.ok === false) {
        sessionData = await loginViaBasicAuth(proxy, username, password);
      }
    } catch (formErr) {
      sessionData = await loginViaBasicAuth(proxy, username, password);
      if (!sessionData) throw formErr;
      base = proxy.config.baseUrl || base;
    }
  }

  if (!sessionData || sessionData.ok === false) {
    throw new Error((sessionData && sessionData.error) || 'login_failed');
  }

  return { sessionData, base };
}

module.exports = {
  basicAuthHeader,
  resolveDispoBaseUrl,
  performDispoLogin,
  loginViaBasicAuth,
  isLoginRedirectSuccess,
  isProtocolUpgradeRedirect,
};
