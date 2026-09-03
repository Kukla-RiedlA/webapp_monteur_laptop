'use strict';

const {
  isDatePrefixedProjectFolderName,
  parseFnRangeFromFolderName,
  folderNameMatchesFab,
} = require('./projekte-neu-local');

const RASTER_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);
const GALLERY_MAX = 150;

function isRasterName(name) {
  const m = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return !!(m && RASTER_EXT.has(m[1]));
}

function galleryParentFolder(relPath) {
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!rel) return 'Stamm';
  const m = rel.match(/(?:^|\/)(Montage\/[^/]+)/i);
  if (m) return m[1];
  if (rel.indexOf('/') < 0) return 'Stamm';
  const parts = rel.split('/');
  return parts[parts.length - 2] || 'Stamm';
}

function parseFabNumberDigits(fab) {
  const digits = String(fab ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** FN-Hinweis eines Ordners: exakte Zahl oder Bereich, nicht Datums-Projektkopf. */
function folderFnSpan(name) {
  const n = String(name || '').trim();
  if (!n || isDatePrefixedProjectFolderName(n)) return null;
  const range = parseFnRangeFromFolderName(n);
  if (range) return range;
  const m = n.match(/^(\d{4,6})(?:\D|$)/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!Number.isFinite(num)) return null;
  return { from: num, to: num };
}

function folderMatchesSelectedFab(name, fab) {
  if (folderNameMatchesFab(name, fab)) return true;
  const span = folderFnSpan(name);
  const our = parseFabNumberDigits(fab);
  if (!span || our == null) return false;
  return our >= span.from && our <= span.to;
}

function folderMatchesOtherFab(name, fab) {
  if (folderMatchesSelectedFab(name, fab)) return false;
  return folderFnSpan(name) != null;
}

/**
 * own = eindeutig diese FN, other = eindeutig andere FN, unassigned = keine FN im Pfad.
 * @returns {'own'|'other'|'unassigned'}
 */
function classifyGalleryRel(rel, fab) {
  const relNorm = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const parts = relNorm.split('/').filter(Boolean);
  if (parts.length) parts.pop();
  let own = false;
  let other = false;
  for (const part of parts) {
    if (folderMatchesSelectedFab(part, fab)) own = true;
    else if (folderMatchesOtherFab(part, fab)) other = true;
  }
  if (own) return 'own';
  if (other) return 'other';
  return 'unassigned';
}

function walkRasterFiles(nodes, out, max, skipDir) {
  const limit = Number.isFinite(max) && max > 0 ? max : 0;
  (nodes || []).forEach((n) => {
    if (limit && out.length >= limit) return;
    if (!n || typeof n !== 'object') return;
    const type = String(n.type || n.kind || '').toLowerCase();
    const children = n.children || n.items || n.nodes || [];
    const isDir =
      type === 'dir' ||
      type === 'folder' ||
      type === 'directory' ||
      n.isDir === true ||
      n.is_directory === true ||
      (Array.isArray(children) && children.length > 0);
    if (isDir) {
      const dirName = String(n.name || n.label || n.basename || '').trim();
      if (typeof skipDir === 'function' && skipDir(dirName)) return;
      walkRasterFiles(children, out, max, skipDir);
      return;
    }
    const name = String(n.name || n.label || n.basename || '').trim();
    const rel = String(n.rel || n.path || n.rel_path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();
    if (!rel || !isRasterName(name || rel)) return;
    if (limit && out.length >= limit) return;
    out.push({ name: name || rel.split('/').pop() || rel, rel });
  });
}

function downloadQuery(fab, rel, extra) {
  const q = new URLSearchParams({
    fabrikationsnummer: fab,
    fab,
    source: 'projekte_neu',
    path: rel,
  });
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach((k) => {
      if (extra[k] != null && extra[k] !== '') q.set(k, String(extra[k]));
    });
  }
  return q.toString();
}

function mapGalleryItem(fabNorm, file, extra) {
  const parent = galleryParentFolder(file.rel);
  return {
    key: 'pn:' + file.rel.toLowerCase(),
    title: parent && parent !== 'Stamm' ? parent + ' / ' + file.name : file.name,
    parent_folder: parent || 'Stamm',
    source: 'projekte_neu',
    rel_path: file.rel,
    thumb_url:
      '/api/anlagenstamm_file_download.php?' +
      downloadQuery(fabNorm, file.rel, Object.assign({ thumb: '1', thumb_max: '256', prefer_cache: '1' }, extra)),
    full_url:
      '/api/anlagenstamm_file_download.php?' +
      downloadQuery(fabNorm, file.rel, Object.assign({ inline: '1' }, extra)),
    is_title: false,
  };
}

/**
 * Galerie-Index aus lokalem PROJEKTE-NEU-Tree (kein Dispo-Scan).
 * Nur Bilder der gewählten FN; ohne eindeutige FN-Zuordnung (gemeinsamer Ordner) mit anzeigen.
 * @returns {Array<object>}
 */
function buildLocalAnlagenstammGallery(fab, tree, opts) {
  const fabNorm = String(fab || '').trim();
  if (!fabNorm) return [];
  const files = [];
  const max = opts && opts.max != null ? Number(opts.max) : GALLERY_MAX;
  walkRasterFiles(Array.isArray(tree) ? tree : [], files, 0, (dirName) =>
    folderMatchesOtherFab(dirName, fabNorm),
  );
  const own = [];
  const unassigned = [];
  const seen = new Set();
  for (const f of files) {
    const rel = f.rel;
    const key = 'pn:' + rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyGalleryRel(rel, fabNorm);
    if (kind === 'other') continue;
    if (kind === 'own') own.push(f);
    else unassigned.push(f);
  }
  const picked = own.length >= max ? own.slice(0, max) : own.concat(unassigned).slice(0, max);
  const tid = opts && opts.technicianId ? String(opts.technicianId) : '';
  const extra = tid ? { technician_id: tid } : {};
  return picked.map((f) => mapGalleryItem(fabNorm, f, extra));
}

module.exports = {
  GALLERY_MAX,
  isRasterName,
  galleryParentFolder,
  walkRasterFiles,
  classifyGalleryRel,
  folderMatchesOtherFab,
  buildLocalAnlagenstammGallery,
};
