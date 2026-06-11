/**
 * Dispo-Basis-URLs: Port-Abgleich intern/extern, Erreichbarkeitswahl (intern bevorzugt im LAN).
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

function safeHostname(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch (e) {
    return '';
  }
}

/**
 * @param {string} [externalUrl]
 * @param {string} [internalUrl]
 * @returns {{ external: string, internal: string }}
 */
function normalizeDispoBasePair(externalUrl, internalUrl) {
  return {
    external: normalizeDispoBase(externalUrl),
    internal: normalizeDispoBase(internalUrl),
  };
}

/**
 * Reihenfolge für Fallback: zuerst erreichbare öffentliche Basis, LAN zuletzt.
 * (Verhindert 10s-Timeouts auf 10.x, wenn Monteur extern unterwegs ist.)
 *
 * @param {{ baseUrl?: string, externalUrl?: string, internalUrl?: string }} opts
 * @returns {string[]}
 */
function buildDispoBaseCandidates(opts) {
  const pair = normalizeDispoBasePair(opts && opts.externalUrl, opts && opts.internalUrl);
  const active = normalizeDispoBase(opts && opts.baseUrl);
  const ext = pair.external || normalizeDispoBase(opts && opts.externalUrl);
  const int = pair.internal || normalizeDispoBase(opts && opts.internalUrl);
  const activePrivate = active && isPrivateLanHostname(safeHostname(active));
  const out = [];
  const seen = new Set();
  function add(u) {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }
  if (active && !activePrivate) add(active);
  add(ext);
  if (activePrivate) add(active);
  add(int);
  return out;
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
 * Parallel prüfen; bei beiden OK interne Basis bevorzugen (Firmennetz).
 *
 * @param {{ externalUrl?: string, internalUrl?: string, probe: (url: string) => Promise<{ ok: boolean, error?: string }> }} opts
 */
async function pickReachableDispoBase(opts) {
  const pair = normalizeDispoBasePair(opts && opts.externalUrl, opts && opts.internalUrl);
  const ext = pair.external;
  const int = pair.internal;
  const probe = opts && opts.probe;
  if (typeof probe !== 'function') {
    return { ok: false, error: 'Probe fehlt.', tried: [] };
  }
  if (!ext && !int) {
    return { ok: false, error: 'Mindestens eine Dispo-Basis-URL erforderlich.', tried: [] };
  }
  if (ext && !int) {
    const r = await probe(ext);
    return {
      ok: r.ok,
      selected_base_url: r.ok ? ext : null,
      preferred_source: 'single',
      tried: [{ url: ext, ok: r.ok, error: r.ok ? undefined : r.error }],
      error: r.ok ? undefined : r.error,
    };
  }
  if (int && !ext) {
    const r = await probe(int);
    return {
      ok: r.ok,
      selected_base_url: r.ok ? int : null,
      preferred_source: 'single',
      tried: [{ url: int, ok: r.ok, error: r.ok ? undefined : r.error }],
      error: r.ok ? undefined : r.error,
    };
  }

  const preferInternal = !(opts && opts.preferInternal === false);
  const [rInt, rExt] = await Promise.all([probe(int), probe(ext)]);
  const tried = [
    { url: int, ok: rInt.ok, error: rInt.ok ? undefined : rInt.error },
    { url: ext, ok: rExt.ok, error: rExt.ok ? undefined : rExt.error },
  ];
  if (rInt.ok && rExt.ok) {
    return {
      ok: true,
      selected_base_url: preferInternal ? int : ext,
      preferred_source: preferInternal ? 'internal' : 'external',
      tried,
    };
  }
  if (rInt.ok) {
    return { ok: true, selected_base_url: int, preferred_source: 'internal', tried };
  }
  if (rExt.ok) {
    return { ok: true, selected_base_url: ext, preferred_source: 'external', tried };
  }
  const errParts = tried
    .filter((t) => !t.ok && t.error)
    .map((t) => t.url + ': ' + t.error);
  return {
    ok: false,
    error: errParts.length ? errParts.join(' · ') : 'Keine erreichbare Dispo-URL.',
    tried,
  };
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
  normalizeDispoBasePair,
  buildDispoBaseCandidates,
  isFetchNetworkError,
  isPrivateLanHostname,
  safeHostname,
  pickReachableDispoBase,
  tryDispoBasesInOrder,
};
