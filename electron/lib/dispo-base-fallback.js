/**
 * Dispo-Basis-URLs: bei Netzwerkfehler nächste Kandidatin (extern vor intern).
 */

function normalizeDispoBase(url) {
  return (url || '').toString().trim().replace(/\/$/, '');
}

function isPrivateLanHostname(hostname) {
  const h = (hostname || '').toString().trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Reihenfolge: aktive Basis, dann extern (wenn anders), dann intern.
 *
 * @param {{ baseUrl?: string, externalUrl?: string, internalUrl?: string }} opts
 * @returns {string[]}
 */
function buildDispoBaseCandidates(opts) {
  const active = normalizeDispoBase(opts && opts.baseUrl);
  const ext = normalizeDispoBase(opts && opts.externalUrl);
  const int = normalizeDispoBase(opts && opts.internalUrl);
  const out = [];
  const seen = new Set();
  function add(u) {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }
  add(active);
  if (ext && active && isPrivateLanHostname(safeHostname(active))) {
    add(ext);
    add(int);
  } else {
    add(ext);
    add(int);
  }
  return out;
}

function safeHostname(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch (e) {
    return '';
  }
}

function isFetchNetworkError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    err.name === 'AbortError' ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('ehostunreach') ||
    msg.includes('certificate') ||
    msg.includes('tls')
  );
}

/**
 * @template T
 * @param {string[]} candidates
 * @param {(base: string) => Promise<T>} runForBase
 * @returns {Promise<{ result: T, base: string } | { error: string, tried: string[] }>}
 */
async function tryDispoBasesInOrder(candidates, runForBase) {
  const tried = [];
  let lastNetErr = null;
  for (const base of candidates) {
    tried.push(base);
    try {
      const result = await runForBase(base);
      return { result, base };
    } catch (err) {
      if (isFetchNetworkError(err)) {
        lastNetErr = err;
        continue;
      }
      throw err;
    }
  }
  const msg =
    lastNetErr && lastNetErr.message
      ? lastNetErr.message
      : 'Keine erreichbare Dispo-Basis-URL.';
  return { error: msg, tried };
}

module.exports = {
  normalizeDispoBase,
  buildDispoBaseCandidates,
  isFetchNetworkError,
  isPrivateLanHostname,
  tryDispoBasesInOrder,
};
