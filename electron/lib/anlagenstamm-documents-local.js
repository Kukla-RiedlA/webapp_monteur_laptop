'use strict';

const { listParameterFilesByFab, normalizeFabDigits } = require('./anlagenstamm-local');

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

function jobHasFab(fabrikationsnummern, fabNorm) {
  const raw = String(fabrikationsnummern || '');
  if (!fabNorm || !raw) return false;
  const parts = raw.split(/[,;\s]+/).map((p) => fabDigits(p)).filter(Boolean);
  return parts.includes(fabNorm);
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
    return {
      id: 0,
      parameter_file_id: row.id,
      document_type: 'parameterliste',
      file_path: String(row.storage_relpath || row.source_path || ''),
      original_name: name,
      display_name: name,
      mime: String(row.mime || 'application/octet-stream'),
      size_bytes: row.size != null ? Number(row.size) : 0,
      notes,
      document_date: String(row.uploaded_at || '').slice(0, 10),
      created_at: String(row.uploaded_at || ''),
      display_datetime: String(row.uploaded_at || ''),
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

module.exports = {
  buildLocalAnlagenstammDocumentsList,
  emptyCategories,
  isRealListedDocument,
  jobHasFab,
  KIND_TO_SLUG,
};
