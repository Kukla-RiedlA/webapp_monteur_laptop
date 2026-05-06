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
 * @param {Record<string, unknown>} payload
 */
async function proxyAnlagenstammSearch(payload) {
  const technicianId = parseInt(String(payload.technician_id ?? payload.technicianId ?? '0'), 10);
  const base = (payload.baseUrl || '').toString().trim().replace(/\/$/, '');
  if (!technicianId || !base) {
    return { ok: false, error: 'baseUrl und technician_id erforderlich.' };
  }
  const authHeader = authHeaderFromCredentials(payload.serverUsername, payload.serverPassword);
  const url = `${base}/dispo_api/api/anlagenstamm_monteur_search.php?technician_id=${encodeURIComponent(technicianId)}`;
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
    return Object.assign(
      { ok: false, error: (data && data.error) ? data.error : r.statusText, _httpStatus: r.status },
      data
    );
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
  const url = `${base}/dispo_api/api/anlagenstamm_monteur_save.php?technician_id=${encodeURIComponent(technicianId)}`;
  const savePayload = Object.assign({}, payload);
  delete savePayload.baseUrl;
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
    return Object.assign(
      { ok: false, error: (data && data.error) ? data.error : r.statusText, _httpStatus: r.status },
      data
    );
  }
  return data;
}

module.exports = {
  proxyAnlagenstammSearch,
  proxyAnlagenstammSave,
  authHeaderFromCredentials,
  dispoMonteurFetchHeaders,
};
