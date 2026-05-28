/**
 * Gemeinsame Weiterleitung an Dispo anlagenstamm_monteur_* (für Express und IPC).
 */
const {
  buildDispoBaseCandidates,
  tryDispoBasesInOrder,
} = require('./dispo-base-fallback');
const {
  clampForDispoAnlagenstamm,
  stripEmptyStammFieldsForDispoPush,
} = require('./anlagenstamm-local');

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

async function proxyAnlagenstammSearchOnce(payload, base) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
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
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      dispoMonteurFetchHeaders(technicianId, authHeader)
    ),
    body: JSON.stringify(forward),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const apiErr = data && data.error ? data.error : '';
    const friendly = monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url);
    try {
      console.warn('[anlagenstamm-dispo-proxy] search HTTP', r.status, url);
    } catch (_) {}
    return Object.assign({}, data, { ok: false, error: friendly, _httpStatus: r.status });
  }
  return Object.assign({}, data, { _used_base_url: base });
}

async function proxyAnlagenstammSaveOnce(payload, base) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_save.php';
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const savePayload = stripEmptyStammFieldsForDispoPush(clampForDispoAnlagenstamm(Object.assign({}, payload)), null);
  delete savePayload.baseUrl;
  delete savePayload.externalUrl;
  delete savePayload.internalUrl;
  delete savePayload.serverUsername;
  delete savePayload.serverPassword;
  delete savePayload.technician_id;
  delete savePayload.technicianId;
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      dispoMonteurFetchHeaders(technicianId, authHeader)
    ),
    body: JSON.stringify(savePayload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const apiErr = data && data.error ? data.error : '';
    const friendly = monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url);
    try {
      console.warn('[anlagenstamm-dispo-proxy] save HTTP', r.status, url, apiErr || '');
    } catch (_) {}
    return Object.assign({}, data, { ok: false, error: friendly, _httpStatus: r.status });
  }
  return Object.assign({}, data, { _used_base_url: base });
}

/**
 * @param {Record<string, unknown>} payload
 */
function dispoAuthRequirementError(payload, technicianId) {
  if (!technicianId) {
    return 'Monteur-ID fehlt (Einstellungen: Dispo-Login).';
  }
  const candidates = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  if (candidates.length === 0) {
    return 'Dispo-Basis-URL fehlt (Einstellungen: extern oder intern).';
  }
  return null;
}

async function proxyAnlagenstammSearch(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const reqErr = dispoAuthRequirementError(payload, technicianId);
  if (reqErr) {
    return { ok: false, error: reqErr };
  }
  const candidates = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_search.php';
  const tried = await tryDispoBasesInOrder(candidates, (base) => proxyAnlagenstammSearchOnce(payload, base));
  if (tried.error) {
    return {
      ok: false,
      error:
        'Keine Verbindung zur Dispo (Netzwerk/TLS): ' +
        tried.error +
        '. Ziel ohne Query: ' +
        (candidates[0] || '') +
        relativePhp +
        (candidates.length > 1 ? ' (auch ' + candidates.slice(1).join(', ') + ' probiert)' : ''),
    };
  }
  return tried.result;
}

/**
 * @param {Record<string, unknown>} payload
 */
async function proxyAnlagenstammSave(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const reqErr = dispoAuthRequirementError(payload, technicianId);
  if (reqErr) {
    return { ok: false, error: reqErr };
  }
  const candidates = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  const relativePhp = '/dispo_api/api/anlagenstamm_monteur_save.php';
  const tried = await tryDispoBasesInOrder(candidates, (base) => proxyAnlagenstammSaveOnce(payload, base));
  if (tried.error) {
    return {
      ok: false,
      error:
        'Keine Verbindung zur Dispo (Netzwerk/TLS): ' +
        tried.error +
        '. Ziel ohne Query: ' +
        (candidates[0] || '') +
        relativePhp +
        (candidates.length > 1 ? ' (auch ' + candidates.slice(1).join(', ') + ' probiert)' : ''),
    };
  }
  return tried.result;
}

async function proxyDispoPostJsonOnce(payload, base, relativePhp, forwardBody) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const url = `${base}${relativePhp}?technician_id=${encodeURIComponent(technicianId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      dispoMonteurFetchHeaders(technicianId, authHeader),
    ),
    body: JSON.stringify(forwardBody || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const apiErr = data && data.error ? data.error : '';
    const friendly = monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url);
    return Object.assign({}, data, { ok: false, error: friendly, _httpStatus: r.status });
  }
  return Object.assign({}, data, { _used_base_url: base });
}

async function proxyDispoPostJson(payload, relativePhp, forwardBody) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const reqErr = dispoAuthRequirementError(payload, technicianId);
  if (reqErr) {
    return { ok: false, error: reqErr };
  }
  const candidates = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  const tried = await tryDispoBasesInOrder(candidates, (base) =>
    proxyDispoPostJsonOnce(payload, base, relativePhp, forwardBody),
  );
  if (tried.error) {
    return {
      ok: false,
      error:
        'Keine Verbindung zur Dispo (Netzwerk/TLS): ' +
        tried.error +
        '. Ziel: ' +
        (candidates[0] || '') +
        relativePhp,
    };
  }
  return tried.result;
}

async function proxyAnlagenstammParameterFilesList(payload) {
  const fab = String(payload.fab || '').trim();
  return proxyDispoPostJson(
    payload,
    '/dispo_api/api/anlagenstamm_parameter_files_list.php',
    { fab },
  );
}

async function proxyAnlagenstammParameterTrend(payload) {
  const body = {
    fab: String(payload.fab || '').trim(),
    mode: payload.mode,
    from_file_id: payload.from_file_id,
    to_file_id: payload.to_file_id,
    chain: payload.chain,
  };
  return proxyDispoPostJson(payload, '/dispo_api/api/anlagenstamm_parameter_trend.php', body);
}

async function proxyAnlagenstammParameterIngest(payload) {
  const body = {
    filename: payload.filename,
    content: payload.content,
    source: payload.source || 'upload',
    storage_rel_path: payload.storage_rel_path,
    mime: payload.mime,
  };
  return proxyDispoPostJson(payload, '/dispo_api/api/anlagenstamm_parameter_ingest.php', body);
}

async function proxyAnlagenstammParameterDownloadOnce(payload, base) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const relativePhp = '/dispo_api/api/anlagenstamm_parameter_download.php';
  const q = new URLSearchParams({
    technician_id: String(technicianId),
    fab: String(payload.fab || '').trim(),
    file_id: String(payload.file_id || ''),
  });
  const url = `${base}${relativePhp}?${q.toString()}`;
  const r = await fetch(url, { headers: dispoMonteurFetchHeaders(technicianId, authHeader) });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const apiErr = data && data.error ? data.error : '';
    return {
      ok: false,
      error: monteurUpstreamHttpError(r.status, r.statusText, apiErr, relativePhp, url),
      _httpStatus: r.status,
    };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const disp =
    r.headers.get('content-disposition') ||
    r.headers.get('Content-Disposition') ||
    '';
  const xName = r.headers.get('x-download-filename') || r.headers.get('X-Download-Filename') || '';
  return {
    ok: true,
    buffer: buf,
    contentType: r.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: disp,
    xDownloadFilename: xName,
    _used_base_url: base,
  };
}

async function proxyAnlagenstammParameterDownload(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const reqErr = dispoAuthRequirementError(payload, technicianId);
  if (reqErr) {
    return { ok: false, error: reqErr };
  }
  if (!payload.file_id) {
    return { ok: false, error: 'file_id fehlt.' };
  }
  const candidates = buildDispoBaseCandidates({
    baseUrl: payload.baseUrl,
    externalUrl: payload.externalUrl,
    internalUrl: payload.internalUrl,
  });
  const tried = await tryDispoBasesInOrder(candidates, (base) =>
    proxyAnlagenstammParameterDownloadOnce(payload, base),
  );
  if (tried.error) {
    return { ok: false, error: 'Keine Verbindung zur Dispo: ' + tried.error };
  }
  return tried.result;
}

module.exports = {
  proxyAnlagenstammSearch,
  proxyAnlagenstammSave,
  proxyAnlagenstammParameterFilesList,
  proxyAnlagenstammParameterTrend,
  proxyAnlagenstammParameterIngest,
  proxyAnlagenstammParameterDownload,
  authHeaderFromCredentials,
  dispoMonteurFetchHeaders,
};
