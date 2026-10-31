'use strict';

/**
 * Entscheidet, ob ein ausgefülltes Protokoll ein aktuelles PDF hat.
 * Fachinhalt wird gehasht, PDF-Pfade und Zeitstempel zählen nicht mit.
 */

const crypto = require('crypto');
const { protocolDraftHasContent } = require('./protocol-drafts-local');

const PDF_TOLERANCE_MS = 15000;

const PDF_WRITERS = new Set([
  'serviceprotokoll',
  'inbetriebnahme',
  'montagebericht',
  'kontrollwiegung',
  'schleppkette',
  'pruefzertifikat',
  'schulungsprotokoll',
  'arbeitsnachweis',
]);

const KIND_LABELS = {
  serviceprotokoll: 'Service',
  inbetriebnahme: 'Inbetriebnahme',
  montagebericht: 'Montagebericht',
  kontrollwiegung: 'Kontrollwiegung',
  schleppkette: 'Schleppketten-Test',
  pruefzertifikat: 'Prüfzertifikat',
  schulungsprotokoll: 'Schulung',
  arbeitsnachweis: 'Arbeitsnachweis',
};

const IGNORE_EXACT = new Set([
  'last_pdf_rel',
  'last_pdf_paths',
  'last_pdf_abs',
  'pdf_rel',
  'pdf_rels',
  'pdf_path',
  'pdf_paths',
  'pdf_content_hash',
  'pdf_created_at',
  'saved_pdf',
  'saved_pdfs',
  'updated_at',
  'updatedAt',
  'gespeichert_am',
  'server_updated_at',
  'revision',
  'local_id',
  'nextLocalId',
  'serverPassword',
  'dispoPassword',
  'dispo_password',
  'serverUsername',
  'dispoUsername',
  'dispoBaseUrl',
  'base_url',
  'baseUrl',
  'technician_signature_png',
  'signature_override_png',
  'customer_signature_png',
]);

function isIgnoredKey(key) {
  const name = String(key || '');
  if (!name || IGNORE_EXACT.has(name)) return true;
  if (name.indexOf('pdf_') === 0 || name.indexOf('last_pdf_') === 0) return true;
  return false;
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value)
    .filter((key) => !isIgnoredKey(key) && value[key] !== undefined)
    .sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function contentHash(draft) {
  return crypto.createHash('sha256').update(stableStringify(draft && typeof draft === 'object' ? draft : {}), 'utf8').digest('hex');
}

function parseTimeMs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formUpdatedMs(draft, fallback) {
  const times = [
    draft && draft.updated_at,
    draft && draft.updatedAt,
    draft && draft.gespeichert_am,
    fallback,
  ];
  let max = null;
  times.forEach((value) => {
    const ms = parseTimeMs(value);
    if (ms != null && (max == null || ms > max)) max = ms;
  });
  return max;
}

function wantedLanguages(draft) {
  const languages = [];
  const pushLang = (value) => {
    const lang = String(value || '').toLowerCase().slice(0, 2);
    if ((lang === 'de' || lang === 'en') && languages.indexOf(lang) === -1) languages.push(lang);
  };
  const body = draft && typeof draft === 'object' ? draft : {};
  const raw = Array.isArray(body.languages) && body.languages.length
    ? body.languages
    : (Array.isArray(body.pdf_languages) ? body.pdf_languages : null);
  if (raw && raw.length) raw.forEach(pushLang);
  else if (body.language) pushLang(body.language);
  if (!languages.length) languages.push('de');
  return languages;
}

function langFromPdfName(name) {
  const base = String(name || '').split(/[/\\]/).pop();
  if (/_DE\.pdf$/i.test(base)) return 'de';
  if (/_(EN|GB)\.pdf$/i.test(base)) return 'en';
  return '';
}

function collectStoredPdfRefs(draft) {
  const refs = [];
  const seen = new Set();
  const add = (rel, lang) => {
    const value = String(rel || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    const detected = String(lang || '').trim().toLowerCase().slice(0, 2);
    refs.push({
      rel: value,
      lang: detected === 'de' || detected === 'en' ? detected : langFromPdfName(value),
    });
  };
  if (!draft || typeof draft !== 'object') return refs;
  add(draft.pdf_rel, '');
  add(draft.last_pdf_rel, '');
  add(draft.last_pdf_abs, '');
  [draft.pdf_rels, draft.last_pdf_paths, draft.pdf_paths, draft.saved_pdfs].forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((item) => {
      if (typeof item === 'string') add(item, '');
      else if (item && typeof item === 'object') add(item.rel || item.path || item.name, item.lang);
    });
  });
  return refs;
}

function matchPdf(pdfs, lang, languages) {
  const list = Array.isArray(pdfs) ? pdfs : [];
  const explicit = list.find((file) => file && file.exists && file.lang === lang);
  if (explicit) return explicit;
  if (lang === 'de' || (Array.isArray(languages) && languages.length === 1)) {
    const bare = list.find((file) => file && file.exists && !file.lang);
    if (bare) return bare;
  }
  return list.find((file) => file && file.lang === lang) || null;
}

function canWriteProtocolPdf(kind) {
  return PDF_WRITERS.has(String(kind || '').trim());
}

function labelForKind(kind) {
  const key = String(kind || '').trim();
  return KIND_LABELS[key] || key || 'Protokoll';
}

function gapReason(result) {
  if (!result || result.status === 'current') return '';
  if (result.status === 'unsupported') return 'PDF-Erzeugung für diese Art fehlt';
  const gaps = Array.isArray(result.gaps) ? result.gaps : [];
  const missing = gaps.filter((gap) => gap && gap.status === 'missing').map((gap) => String(gap.lang || '').toUpperCase());
  const stale = gaps.filter((gap) => gap && gap.status === 'stale').map((gap) => String(gap.lang || '').toUpperCase());
  const parts = [];
  if (missing.length) {
    const extra = missing.length === 1 && missing[0] === 'DE' && !stale.length ? '' : ' (' + missing.filter(Boolean).join(', ') + ')';
    parts.push('kein PDF' + extra);
  }
  if (stale.length) {
    const extra = stale.length === 1 && stale[0] === 'DE' ? '' : ' (' + stale.filter(Boolean).join(', ') + ')';
    parts.push('Formular danach geändert' + extra);
  }
  return parts.join('; ') || 'kein PDF';
}

/**
 * null, wenn der Entwurf leer ist und nicht geprüft wird.
 * Sonst status current | missing | stale | unsupported.
 */
function assessProtocolPdf(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const draft = options.draft && typeof options.draft === 'object' ? options.draft : {};
  if (!protocolDraftHasContent(draft)) return null;
  const languages = Array.isArray(options.languages) && options.languages.length
    ? options.languages
    : wantedLanguages(draft);
  const pdfs = Array.isArray(options.pdfs) ? options.pdfs : [];
  const currentHash = options.currentHash || contentHash(draft);
  const storedHash = String(options.storedHash != null ? options.storedHash : draft.pdf_content_hash || '').trim();
  const formUpdated = options.formUpdatedMs == null ? formUpdatedMs(draft) : Number(options.formUpdatedMs);
  const toleranceMs = options.toleranceMs == null ? PDF_TOLERANCE_MS : Number(options.toleranceMs);

  const gaps = [];
  languages.forEach((lang) => {
    const file = matchPdf(pdfs, lang, languages);
    if (!file || !file.exists) {
      gaps.push({ lang, status: 'missing' });
      return;
    }
    if (storedHash && storedHash === currentHash) return;
    if (storedHash && storedHash !== currentHash) {
      gaps.push({ lang, status: 'stale' });
      return;
    }
    const mtime = file.mtimeMs == null ? null : Number(file.mtimeMs);
    if (formUpdated == null || !Number.isFinite(formUpdated) || mtime == null || !Number.isFinite(mtime)) return;
    if (mtime + toleranceMs >= formUpdated) return;
    gaps.push({ lang, status: 'stale' });
  });

  const base = { hash: currentHash, languages, gaps };
  if (!gaps.length) return Object.assign({ status: 'current', reason: '' }, base);

  const unsupported = options.canWrite === false || (options.kind && !canWriteProtocolPdf(options.kind));
  if (unsupported) {
    return Object.assign({ status: 'unsupported', reason: gapReason({ status: 'unsupported' }) }, base);
  }
  const stale = gaps.some((gap) => gap.status === 'stale');
  const status = stale ? 'stale' : 'missing';
  const result = Object.assign({ status }, base);
  result.reason = gapReason(result);
  return result;
}

function archivPdfKind(kind) {
  return String(kind || '').trim() === 'schleppkette' ? 'schleppketten' : String(kind || '').trim();
}

module.exports = {
  PDF_TOLERANCE_MS,
  PDF_WRITERS,
  contentHash,
  parseTimeMs,
  formUpdatedMs,
  wantedLanguages,
  langFromPdfName,
  collectStoredPdfRefs,
  canWriteProtocolPdf,
  labelForKind,
  gapReason,
  assessProtocolPdf,
  archivPdfKind,
};
