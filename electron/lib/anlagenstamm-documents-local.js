'use strict';

const { listParameterFilesByFab, normalizeFabDigits } = require('./anlagenstamm-local');
const { resolveDisplayDatetime } = require('./anlagenstamm-filename-datetime');

const KIND_TO_SLUG = {
  kontrollwiegung: 'wiegeprotokoll',
  schleppkette: 'wiegeprotokoll',
  pruefzertifikat: 'inbetriebnahme',
};

const REAL_DOC_EXT = /\.(pdf|docx?|xlsx?|xlsm|odt|ods|rtf|csv|txt)$/i;

function emptyCategories() {
  return [
    { slug: 'montagebericht', label: 'Montageberichte', is_image: false, documents: [] },
    { slug: 'parameterliste', label: 'Parameterlisten', is_image: false, documents: [] },
    { slug: 'wiegeprotokoll', label: 'Wiegeprotokolle', is_image: false, documents: [] },
    { slug: 'serviceprotokoll', label: 'Serviceprotokolle', is_image: false, documents: [] },
    { slug: 'inbetriebnahme', label: 'Inbetriebnahmeprotokolle', is_image: false, documents: [] },
    { slug: 'bild', label: 'Bilder', is_image: true, documents: [] },
    { slug: 'sonstiges', label: 'Sonstiges', is_image: false, documents: [] },
  ];
}

function fabDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function fabDigitSetFromJobRaw(raw) {
  const set = new Set();
  const add = (v) => {
    const d = fabDigits(v);
    if (!d) return;
    const n = parseInt(d, 10);
    if (Number.isFinite(n) && n > 0) set.add(String(n));
  };
  if (raw == null || raw === '') return set;
  const s = String(raw).trim();
  if (!s) return set;
  try {
    const parsed = JSON.parse(s);
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    for (const row of rows) {
      if (row && typeof row === 'object') {
        add(row.fabrikationsnummer != null ? row.fabrikationsnummer : row.Fabrikationsnummer);
      } else {
        add(row);
      }
    }
    if (set.size > 0) return set;
  } catch (_) {
    /* Komma-/Semikolon-Liste */
  }
  for (const part of s.split(/[\s;,]+/)) {
    if (part.trim()) add(part);
  }
  return set;
}

function jobHasFab(fabrikationsnummern, fabNorm) {
  const want = fabDigits(fabNorm) || String(fabNorm || '').trim();
  if (!want) return false;
  return fabDigitSetFromJobRaw(fabrikationsnummern).has(want);
}

function isRealListedDocument(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.view_kind === 'form_json') return false;
  if (String(doc.mime || '').toLowerCase().includes('json')) return false;
  const name = String(doc.original_name || doc.display_name || doc.file_path || '');
  if (doc.parameter_file_id) {
    return Number(doc.size_bytes) > 0 || REAL_DOC_EXT.test(name);
  }
  if (!(Number(doc.size_bytes) > 0)) return false;
  return REAL_DOC_EXT.test(name);
}

function mapParameterDocs(db, fabNorm) {
  const rows = listParameterFilesByFab(db, fabNorm) || [];
  return rows.map((row) => {
    const source = String(row.source || 'upload');
    const sourceLabel = source === 'projekte_neu' ? 'Projekte neu' : 'Upload';
    const tech = String(row.technician_name || '').trim();
    const n = Number(row.entry_count) || 0;
    let notes = sourceLabel;
    if (tech) notes += ' · ' + tech;
    if (n > 0) notes += ' · ' + n + ' Werte';
    if (String(row.source_file_status || '') === 'original_deleted') notes += ' · Originaldatei gelöscht';
      const name = String(row.original_filename || 'Parameterliste');
    const display = resolveDisplayDatetime({
      filename: name,
      fallbackDatetime: row.uploaded_at,
    }) || String(row.uploaded_at || '');
    const serverId = row.server_file_id != null ? Number(row.server_file_id) : 0;
    return {
      id: 0,
      parameter_file_id: serverId > 0 ? serverId : row.id,
      document_type: 'parameterliste',
      file_path: String(row.storage_relpath || row.source_path || ''),
      original_name: name,
      display_name: name,
      mime: String(row.mime || 'application/octet-stream'),
      size_bytes: row.size != null ? Number(row.size) : 0,
      notes,
      document_date: display.slice(0, 10),
      created_at: display,
      display_datetime: display,
      job_id: null,
      created_by: row.technician_id != null ? Number(row.technician_id) : null,
      uploaded_by_username: tech,
      legacy: false,
      view_kind: 'parameter',
      parameter_source: source,
      source_file_status: row.source_file_status || 'present',
    };
  });
}

function buildLocalAnlagenstammDocumentsList(db, fab) {
  const fabNorm = normalizeFabDigits(fab) || fabDigits(fab);
  const categories = emptyCategories();
  const bySlug = {};
  for (const cat of categories) bySlug[cat.slug] = cat;
  if (!fabNorm || !db) {
    return {
      ok: true,
      success: true,
      fab: String(fab || '').trim(),
      parameter_fab: fabNorm || '',
      categories,
      events: [],
      timeline: [],
      source: 'local_fast',
    };
  }
  try {
    for (const doc of mapParameterDocs(db, fabNorm)) {
      if (!isRealListedDocument(doc)) continue;
      bySlug.parameterliste.documents.push(doc);
    }
  } catch (_) {
    /* Tabelle fehlt */
  }
  return {
    ok: true,
    success: true,
    fab: String(fab || '').trim(),
    parameter_fab: fabNorm,
    categories,
    events: [],
    timeline: [],
    source: 'local_fast',
  };
}

function docIdentityKeys(doc) {
  const keys = [];
  const pid = Number(doc && doc.parameter_file_id) || 0;
  if (pid > 0) keys.push('p:' + pid);
  const did = Number(doc && doc.id) || 0;
  if (did > 0) keys.push('d:' + did);
  const name = String((doc && (doc.original_name || doc.display_name)) || '')
    .trim()
    .toLowerCase();
  const sz = Number(doc && doc.size_bytes) || 0;
  if (name) keys.push('n:' + name + ':' + sz);
  const pathRel = String((doc && doc.file_path) || '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
  if (pathRel) keys.push('f:' + pathRel);
  return keys;
}

function mergeRemoteDocumentsList(localPayload, remotePayload) {
  const local = localPayload && typeof localPayload === 'object' ? localPayload : {};
  const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : null;
  if (!remote || !Array.isArray(remote.categories)) {
    return local;
  }
  const ordered = emptyCategories();
  const bySlug = {};
  for (const cat of ordered) bySlug[cat.slug] = cat;
  const seen = new Set();
  function addDoc(slug, doc) {
    if (!doc || typeof doc !== 'object') return;
    const target = bySlug[slug] ? slug : 'sonstiges';
    if (!bySlug[target]) return;
    const keys = docIdentityKeys(doc);
    if (keys.some((k) => seen.has(k))) return;
    for (const k of keys) seen.add(k);
    bySlug[target].documents.push(doc);
  }
  for (const cat of remote.categories) {
    const slug = String((cat && cat.slug) || '');
    for (const doc of (cat && cat.documents) || []) {
      addDoc(slug, doc);
    }
  }
  for (const cat of local.categories || []) {
    const slug = String((cat && cat.slug) || '');
    for (const doc of (cat && cat.documents) || []) {
      addDoc(slug, doc);
    }
  }
  const remoteEvents = Array.isArray(remote.events) ? remote.events : [];
  const localEvents = Array.isArray(local.events) ? local.events : [];
  const evSeen = new Set();
  const events = [];
  for (const ev of remoteEvents.concat(localEvents)) {
    const id = ev && ev.id != null ? 'e:' + ev.id : 't:' + String((ev && ev.title) || '') + ':' + String((ev && ev.event_date) || '');
    if (evSeen.has(id)) continue;
    evSeen.add(id);
    events.push(ev);
  }
  const timeline = Array.isArray(remote.timeline) && remote.timeline.length ? remote.timeline : local.timeline || [];
  return {
    ok: true,
    success: true,
    fab: String(remote.fab || local.fab || '').trim(),
    parameter_fab: String(remote.parameter_fab || local.parameter_fab || '').trim(),
    categories: ordered,
    events,
    timeline,
    source: remote.source || 'dispo_api',
  };
}

module.exports = {
  buildLocalAnlagenstammDocumentsList,
  mergeRemoteDocumentsList,
  emptyCategories,
  isRealListedDocument,
  jobHasFab,
  fabDigitSetFromJobRaw,
  KIND_TO_SLUG,
};
