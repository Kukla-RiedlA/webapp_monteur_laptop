/**
 * Gemeinsame Weiterleitung an Dispo anlagenstamm_monteur_* (für Express und IPC).
 */
function authHeaderFromCredentials(username, password) {
  const u = (username || '').toString().trim();
  if (!u) return undefined;
  const p = (password || '').toString();
  return { Authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') };
}

function dispoMonteurFetchHeaders(technicianId, authHeader) {
  const h = Object.assign({ 'X-Technician-Id': String(technicianId) }, authHeader || {});
  const a = authHeader && authHeader.Authorization;
  if (a) {
    h['X-Kukla-Authorization'] = a;
  }
  return h;
}

/**
 * Lesbare Fehlermeldung statt nur „Not Found“ (404 vom Webserver, wenn PHP nicht unter diesem Pfad liegt).
 */
function monteurUpstreamHttpError(status, statusText, jsonError, relativePhpPath, attemptedUrl) {
  const detail = (jsonError && String(jsonError).trim()) || statusText || '';
  if (status === 404) {
    return (
      'Dispo meldet HTTP 404: Die Monteur-API-Datei wurde unter dieser Basis-URL nicht gefunden ' +
        '(Deploy oder Pfad prüfen). Erwarteter Pfad: …' +
        relativePhpPath +
        '. Basis-URL in den Einstellungen testen. ' +
        (attemptedUrl ? 'Aufgerufen: ' + attemptedUrl + '. ' : '') +
        (detail ? '(' + detail + ')' : '')
    );
  }
  if (status === 403) {
    return (
      (detail || 'Zugriff verweigert') +
        ' — Monteur-ID muss in Dispo als aktiver Monteur existieren (users.role = monteur).'
    );
  }
  if (status >= 500) {
    return (detail || statusText || 'Serverfehler') + ' (HTTP ' + status + ').';
  }
  return detail || statusText || 'HTTP ' + status;
}

/**
 * @param {Record<string, unknown>} payload
 */
async function proxyAnlagenstammSearch(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const base = (payload.baseUrl || '').toString().trim().replace(/\/$/, '');
  if (!technicianId || !base) {
    return { ok: false, error: 'baseUrl und technician_id erforderlich.' };
  }
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_search.php';
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const forward = {
    filter_fn: payload.filter_fn,
    filter_type: payload.filter_type,
    filter_aktueller_kunde: payload.filter_aktueller_kunde,
    filter_land: payload.filter_land,
    page: payload.page,
    page_size: payload.page_size,
  };
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        dispoMonteurFetchHeaders(technicianId, authHeader)
      ),
      body: JSON.stringify(forward),
    });
  } catch (netErr) {
    const msg = netErr && netErr.message ? netErr.message : String(netErr);
    return {
      ok: false,
      error:
        'Keine Verbindung zur Dispo (Netzwerk/TLS): ' +
        msg +
        '. Ziel ohne Query: ' +
        base +
        relativePhp,
    };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const apiErr = data && data.error ? data.error : '';
    const friendly = monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url);
    try {
      console.warn('[anlagenstamm-dispo-proxy] search HTTP', r.status, url);
    } catch (_) {}
    return Object.assign({}, data, { ok: false, error: friendly, _httpStatus: r.status });
  }
  return data;
}

/**
 * @param {Record<string, unknown>} payload
 */
async function proxyAnlagenstammSave(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const base = (payload.baseUrl || '').toString().trim().replace(/\/$/, '');
  if (!technicianId || !base) {
    return { ok: false, error: 'baseUrl und technician_id erforderlich.' };
  }
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_save.php';
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const savePayload = Object.assign({}, payload);
  delete savePayload.baseUrl;
  delete savePayload.serverUsername;
  delete savePayload.serverPassword;
  delete savePayload.technician_id;
  delete savePayload.technicianId;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        dispoMonteurFetchHeaders(technicianId, authHeader)
      ),
      body: JSON.stringify(savePayload),
    });
  } catch (netErr) {
    const msg = netErr && netErr.message ? netErr.message : String(netErr);
    return {
      ok: false,
      error:
        'Keine Verbindung zur Dispo (Netzwerk/TLS): ' +
        msg +
        '. Ziel ohne Query: ' +
        base +
        relativePhp,
    };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const apiErr = data && data.error ? data.error : '';
    const friendly = monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url);
    try {
      console.warn('[anlagenstamm-dispo-proxy] save HTTP', r.status, url);
    } catch (_) {}
    return Object.assign({}, data, { ok: false, error: friendly, _httpStatus: r.status });
  }
  return data;
}

module.exports = {
  proxyAnlagenstammSearch,
  proxyAnlagenstammSave,
  authHeaderFromCredentials,
  dispoMonteurFetchHeaders,
};
