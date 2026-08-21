'use strict';

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

function walkRasterFiles(nodes, out) {
  (nodes || []).forEach((n) => {
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
      walkRasterFiles(children, out);
      return;
    }
    const name = String(n.name || n.label || n.basename || '').trim();
    const rel = String(n.rel || n.path || n.rel_path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();
    if (!rel || !isRasterName(name || rel)) return;
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

/**
 * Galerie-Index aus lokalem PROJEKTE-NEU-Tree (kein Dispo-Scan).
 * @returns {Array<object>}
 */
function buildLocalAnlagenstammGallery(fab, tree, opts) {
  const fabNorm = String(fab || '').trim();
  if (!fabNorm) return [];
  const files = [];
  walkRasterFiles(Array.isArray(tree) ? tree : [], files);
  const max = opts && opts.max != null ? Number(opts.max) : GALLERY_MAX;
  const tid = opts && opts.technicianId ? String(opts.technicianId) : '';
  const extra = tid ? { technician_id: tid } : {};
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (out.length >= max) break;
    const rel = f.rel;
    const key = 'pn:' + rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const parent = galleryParentFolder(rel);
    out.push({
      key,
      title: parent && parent !== 'Stamm' ? parent + ' / ' + f.name : f.name,
      parent_folder: parent || 'Stamm',
      source: 'projekte_neu',
      rel_path: rel,
      thumb_url:
        '/api/anlagenstamm_file_download.php?' +
        downloadQuery(fabNorm, rel, Object.assign({ thumb: '1', thumb_max: '256', prefer_cache: '1' }, extra)),
      full_url:
        '/api/anlagenstamm_file_download.php?' +
        downloadQuery(fabNorm, rel, Object.assign({ inline: '1' }, extra)),
      is_title: false,
    });
  }
  return out;
}

module.exports = {
  GALLERY_MAX,
  isRasterName,
  galleryParentFolder,
  walkRasterFiles,
  buildLocalAnlagenstammGallery,
};
