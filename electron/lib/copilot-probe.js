'use strict';

/**
 * Copilot-Probe V1: Microsoft-365-Copilot Chat (Graph beta) für Montagebericht-Bemerkungen.
 * Token-Cache über Electron safeStorage. Kein Azure-OpenAI-Key, kein Client-Secret.
 */

const fs = require('fs');
const path = require('path');
const { sealPassword, unsealPassword, encryptionAvailable } = require('./credential-vault');

const GRAPH_BASE = 'https://graph.microsoft.com/beta';
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/People.Read.All',
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
  'https://graph.microsoft.com/Chat.Read',
  'https://graph.microsoft.com/ChannelMessage.Read.All',
  'https://graph.microsoft.com/ExternalItem.Read.All',
];
const CACHE_FILE = 'copilot-msal-cache.bin';
const REQUEST_TIMEOUT_MS = 90000;

function isProbeEnabled() {
  return String(process.env.KUKLA_COPILOT_PROBE || '').trim() === '1';
}

function readEnvId(name) {
  return String(process.env[name] || '').trim();
}

function isConfigured() {
  return !!(readEnvId('KUKLA_COPILOT_CLIENT_ID') && readEnvId('KUKLA_COPILOT_TENANT_ID'));
}

function entraMissingResult() {
  const hasClient = !!readEnvId('KUKLA_COPILOT_CLIENT_ID');
  const hasTenant = !!readEnvId('KUKLA_COPILOT_TENANT_ID');
  let hint = 'Entra-App fehlt.';
  if (!hasClient && !hasTenant) {
    hint += '\n\nIn electron/.env fehlen KUKLA_COPILOT_TENANT_ID und KUKLA_COPILOT_CLIENT_ID.';
  } else if (!hasClient) {
    hint += '\n\nIn electron/.env fehlt KUKLA_COPILOT_CLIENT_ID.';
  } else {
    hint += '\n\nIn electron/.env fehlt KUKLA_COPILOT_TENANT_ID.';
  }
  hint += '\nNeue App-Registrierung: öffentlicher Client (Desktop), Redirect http://localhost, Public client flows = Ja, kein Secret. Danach npm start neu starten.';
  return { ok: false, error: hint, code: 'entra_missing' };
}

function graphErrorMessage(status, body) {
  const err = body && body.error;
  if (err && typeof err === 'object') {
    const msg = String(err.message || err.code || '').trim();
    if (msg) return msg;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 800);
  return 'Copilot-Anfrage fehlgeschlagen (HTTP ' + status + ').';
}

function buildRewritePrompt(text) {
  return [
    'Du überarbeitest einen Montagebericht-Bemerkungstext für einen Servicetechniker.',
    '',
    'Regeln:',
    '- Nur sprachlich klären (Rechtschreibung, Grammatik, klare Formulierung).',
    '- Keine neuen Fakten, Zahlen, Namen oder technischen Aussagen hinzufügen.',
    '- Nichts weglassen, was fachlich im Original steht.',
    '- Antworte ausschließlich mit dem überarbeiteten Text, ohne Einleitung, Anführungszeichen oder Erklärung.',
    '',
    'Originaltext:',
    '"""',
    String(text || '').trim(),
    '"""',
  ].join('\n');
}

function extractSuggestion(payload, originalText) {
  const orig = String(originalText || '').trim();
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const texts = [];
  for (let i = 0; i < messages.length; i++) {
    const t = String((messages[i] && messages[i].text) || '').trim();
    if (t) texts.push(t);
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i] && texts[i] !== orig) return texts[i];
  }
  const top = payload && payload.text != null ? String(payload.text).trim() : '';
  return top && top !== orig ? top : '';
}

function stripOuterQuotes(text) {
  let s = String(text || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('„') && s.endsWith('“'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

async function graphJson(accessToken, url, body, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: method || 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body == null ? {} : body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, error: 'Zeitüberschreitung bei Copilot.', code: 'timeout' };
    }
    return { ok: false, error: (e && e.message) || String(e), code: 'network' };
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  const raw = await res.text();
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = raw;
    }
  }
  if (!res.ok) {
    const status = res.status;
    const code = status === 401 || status === 403 ? 'graph_' + status : 'graph_error';
    return { ok: false, error: graphErrorMessage(status, parsed), code: code, http_status: status };
  }
  return { ok: true, data: parsed && typeof parsed === 'object' ? parsed : {} };
}

function createCopilotProbe(opts) {
  const userDataDir = opts && opts.userDataDir ? String(opts.userDataDir) : '';
  const openBrowserFn = opts && typeof opts.openBrowser === 'function' ? opts.openBrowser : null;
  const cachePath = userDataDir ? path.join(userDataDir, CACHE_FILE) : '';
  let pca = null;

  function loadCacheString() {
    if (!cachePath || !fs.existsSync(cachePath)) return '';
    try {
      const enc = fs.readFileSync(cachePath, 'utf8');
      return unsealPassword(enc) || '';
    } catch (_) {
      return '';
    }
  }

  function saveCacheString(serialized) {
    if (!cachePath || !serialized) return;
    if (!encryptionAvailable()) return;
    const enc = sealPassword(serialized);
    if (!enc) return;
    try {
      fs.writeFileSync(cachePath, enc, { encoding: 'utf8', mode: 0o600 });
    } catch (_) { /* ignore */ }
  }

  function getPca() {
    if (pca) return pca;
    const { PublicClientApplication } = require('@azure/msal-node');
    const cachePlugin = {
      beforeCacheAccess: async (cacheContext) => {
        const data = loadCacheString();
        if (data) cacheContext.tokenCache.deserialize(data);
      },
      afterCacheAccess: async (cacheContext) => {
        if (cacheContext.cacheHasChanged) {
          saveCacheString(cacheContext.tokenCache.serialize());
        }
      },
    };
    pca = new PublicClientApplication({
      auth: {
        clientId: readEnvId('KUKLA_COPILOT_CLIENT_ID'),
        authority: 'https://login.microsoftonline.com/' + readEnvId('KUKLA_COPILOT_TENANT_ID'),
      },
      cache: { cachePlugin: cachePlugin },
    });
    return pca;
  }

  async function hasCachedAccount() {
    if (!isConfigured()) return false;
    try {
      const accounts = await getPca().getTokenCache().getAllAccounts();
      return !!(accounts && accounts.length);
    } catch (_) {
      return false;
    }
  }

  async function acquireAccessToken() {
    const client = getPca();
    const accounts = await client.getTokenCache().getAllAccounts();
    if (accounts && accounts.length) {
      try {
        const silent = await client.acquireTokenSilent({
          account: accounts[0],
          scopes: GRAPH_SCOPES,
        });
        if (silent && silent.accessToken) return { ok: true, access_token: silent.accessToken };
      } catch (_) {
        /* interaktiv fortsetzen */
      }
    }
    if (!openBrowserFn) {
      return { ok: false, error: 'Microsoft-Anmeldung ist nicht verfügbar.', code: 'no_browser' };
    }
    try {
      console.log('[copilot-probe] Microsoft-Anmeldung: Browser öffnen');
      const interactive = await client.acquireTokenInteractive({
        scopes: GRAPH_SCOPES,
        prompt: 'select_account',
        openBrowser: async (url) => {
          await openBrowserFn(url);
        },
        successTemplate: 'Anmeldung erfolgreich. Dieses Fenster kann geschlossen werden.',
        errorTemplate: 'Anmeldung fehlgeschlagen. Dieses Fenster kann geschlossen werden.',
      });
      if (interactive && interactive.accessToken) {
        return { ok: true, access_token: interactive.accessToken };
      }
      return { ok: false, error: 'Microsoft-Anmeldung lieferte kein Token.', code: 'no_token' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), code: 'msal' };
    }
  }

  return {
    isEnabled: isProbeEnabled,
    isConfigured: isConfigured,

    async status() {
      return {
        ok: true,
        enabled: isProbeEnabled(),
        configured: isConfigured(),
        signed_in: isProbeEnabled() && isConfigured() ? await hasCachedAccount() : false,
      };
    },

    async checkText(rawText) {
      if (!isProbeEnabled()) {
        return { ok: false, error: 'Copilot-Probe ist nicht aktiv.', code: 'disabled' };
      }
      if (!isConfigured()) return entraMissingResult();
      const text = String(rawText || '').trim();
      if (!text) {
        return { ok: false, error: 'Bitte zuerst einen Text in Bemerkungen eingeben.', code: 'empty' };
      }
      const tokenRes = await acquireAccessToken();
      if (!tokenRes.ok) return tokenRes;
      const created = await graphJson(tokenRes.access_token, GRAPH_BASE + '/copilot/conversations', {});
      if (!created.ok) return created;
      const conversationId = created.data && created.data.id ? String(created.data.id) : '';
      if (!conversationId) {
        return { ok: false, error: 'Copilot hat keine Unterhaltung erzeugt.', code: 'no_conversation' };
      }
      const chat = await graphJson(
        tokenRes.access_token,
        GRAPH_BASE + '/copilot/conversations/' + encodeURIComponent(conversationId) + '/chat',
        {
          message: { text: buildRewritePrompt(text) },
          locationHint: { timeZone: 'Europe/Vienna' },
          contextualResources: { webContext: { isWebEnabled: false } },
        },
      );
      if (!chat.ok) return chat;
      const suggestion = stripOuterQuotes(extractSuggestion(chat.data, text));
      if (!suggestion) {
        return { ok: false, error: 'Copilot hat keinen Vorschlagstext geliefert.', code: 'empty_suggestion' };
      }
      return { ok: true, text: suggestion };
    },

    async signOut() {
      try {
        if (isConfigured()) {
          const client = getPca();
          const accounts = await client.getTokenCache().getAllAccounts();
          for (let i = 0; i < (accounts || []).length; i++) {
            await client.getTokenCache().removeAccount(accounts[i]);
          }
        }
      } catch (_) { /* ignore */ }
      pca = null;
      if (cachePath) {
        try { fs.unlinkSync(cachePath); } catch (_) { /* ignore */ }
      }
      return { ok: true };
    },
  };
}

module.exports = {
  createCopilotProbe,
  isProbeEnabled,
  isConfigured,
  extractSuggestion,
  entraMissingResult,
};
