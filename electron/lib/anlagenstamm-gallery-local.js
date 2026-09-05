'use strict';

const fs = require('fs');
const path = require('path');
const {
  isDatePrefixedProjectFolderName,
  parseFnRangeFromFolderName,
  folderNameMatchesFab,
  findMonteurFolderForFab,
  isIgnorableDirEntry,
} = require('./projekte-neu-local');

const RASTER_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);
const GALLERY_MAX = 150;
const MONTAGE_GALLERY_MAX = 80;

function isRasterName(name) {
  const m = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return !!(m && RASTER_EXT.has(m[1]));
}

function posixJoin(...parts) {
  return parts
    .map((p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function isMontagePath(rel) {
  return /(?:^|\/)Montage\//i.test(String(rel || '').replace(/\\/g, '/'));
}

function leadingFnFromName(name) {
  const base = String(name || '')
    .split(/[/\\]/)
    .pop() || '';
  const m = base.match(/^(\d{4,6})(?:[_\s.-]|$)/);
  return m ? m[1] : null;
}

function cameraNameForFab(name, fab) {
  const digits = String(fab || '').replace(/\D/g, '');
  if (!digits) return false;
  const base = String(name || '')
    .split(/[/\\]/)
    .pop() || '';
  return new RegExp('^' + digits + '_\\d{4}-\\d{2}-\\d{2}(?:[_\\s-]|\\.)', 'i').test(base);
}

function galleryFabKey(fab) {
  const s = String(fab || '').trim();
  if (!s) return '';
  if (/^\d{4,6}$/.test(s)) return s;
  const m = s.match(/(?:^|\D)(\d{4,6})(?!\d)/);
  return m ? m[1] : s;
}

function parseFabNumberDigits(fab) {
  const key = galleryFabKey(fab);
  const digits = String(key || '').replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function isIsoDatePrefixedFolderName(name) {
  return /^\d{4}-\d{2}-\d{2}(?:[_-\s]|$)/.test(String(name || '').trim());
}

/** FN-Hinweis eines Ordners: exakte Zahl oder Bereich, nicht Datums-Projektkopf. */
function folderFnSpan(name) {
  const n = String(name || '').trim();
  if (!n || isDatePrefixedProjectFolderName(n) || isIsoDatePrefixedFolderName(n)) return null;
  if (/^Montage$/i.test(n)) return null;
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

function shouldSkipGalleryDir(dirName, fab) {
  const n = String(dirName || '').trim();
  if (!n) return false;
  if (/^(Bilder|Montage|Fotos|Foto|Images|SCAN|Doku|Stamm)$/i.test(n)) return false;
  return folderMatchesOtherFab(n, fab);
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

/**
 * Auftragsfoto dieser FN: Montage-Pfad (lokal oder nach Abschluss in Projekte Neu)
 * oder Kameraname FN_YYYY-MM-DD_… (auch nach Flatten unter Bilder/<FN>/).
 */
function isMontageJobPhoto(rel, name, fab) {
  const digits = String(fab || '').replace(/\D/g, '');
  const lead = leadingFnFromName(name);
  if (lead && digits && lead !== digits) return false;
  if (isMontagePath(rel)) return true;
  return cameraNameForFab(name, fab);
}

function galleryMontageGroup(rel, name) {
  const relNorm = String(rel || '').replace(/\\/g, '/');
  const base = String(name || relNorm.split('/').pop() || '');
  const ao = relNorm.match(/(?:^|\/)Montage\/([^/]+)/i);
  let date = '';
  if (ao) {
    const d = String(ao[1]).match(/^(\d{4}-\d{2}-\d{2})/);
    if (d) date = d[1];
  }
  if (!date) {
    const fd = base.match(/(\d{4}-\d{2}-\d{2})/);
    if (fd) date = fd[1];
  }
  return date ? 'Montage / ' + date : 'Montage';
}

function galleryParentFolder(relPath, fileName, fab) {
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const name = String(fileName || rel.split('/').pop() || '');
  if (fab != null && String(fab).trim() !== '' && isMontageJobPhoto(rel, name, fab)) {
    return galleryMontageGroup(rel, name);
  }
  if (isMontagePath(rel)) return galleryMontageGroup(rel, name);
  if (!rel) return 'Stamm';
  if (rel.indexOf('/') < 0) return 'Stamm';
  const parts = rel.split('/');
  return parts[parts.length - 2] || 'Stamm';
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

function collectRastersLimited(absDir, relPrefix, out, max, depth, jobId, fab) {
  if (out.length >= max || depth < 0) return;
  let ents;
  try {
    ents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const ent of ents) {
    if (out.length >= max) return;
    if (isIgnorableDirEntry(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = posixJoin(relPrefix, ent.name);
    if (ent.isDirectory()) {
      collectRastersLimited(abs, rel, out, max, depth - 1, jobId, fab);
      continue;
    }
    if (!ent.isFile() || !isRasterName(ent.name)) continue;
    if (fab && !isMontageJobPhoto(rel, ent.name, fab)) continue;
    const item = { name: ent.name, rel };
    if (jobId) item.jobId = jobId;
    out.push(item);
  }
}

/**
 * Bounded listing: Dokumente_Monteur/<FN>/Montage/<AO>/Bilder (kein OneDrive-Tiefenscan).
 * @param {Array<{dm:string, jobId?:number}>} dmEntries
 * @returns {Array<{name:string, rel:string, jobId?:number}>}
 */
function listMontageRastersFromDokumenteMonteurPaths(dmEntries, fab, opts) {
  const max = opts && opts.max != null ? Number(opts.max) : MONTAGE_GALLERY_MAX;
  const out = [];
  const seen = new Set();
  for (const entry of dmEntries || []) {
    if (out.length >= max) break;
    const dm = entry && entry.dm;
    const jobId = entry && entry.jobId;
    if (!dm) continue;
    const folderName = findMonteurFolderForFab(dm, fab);
    const montageRoots = [];
    const seenRoots = new Set();
    const addMontageRoot = (folder) => {
      const abs = folder
        ? path.join(dm, folder, 'Montage')
        : path.join(dm, 'Montage');
      const key = String(abs).toLowerCase();
      if (seenRoots.has(key)) return;
      seenRoots.add(key);
      montageRoots.push({
        abs,
        rel: folder
          ? posixJoin('Dokumente_Monteur', folder, 'Montage')
          : posixJoin('Dokumente_Monteur', 'Montage'),
      });
    };
    addMontageRoot(folderName);
    addMontageRoot(null);
    let dmDirs = [];
    try {
      dmDirs = fs.readdirSync(dm, { withFileTypes: true });
    } catch (_) {
      dmDirs = [];
    }
    let extraFolders = 0;
    for (const ent of dmDirs) {
      if (extraFolders >= 12) break;
      if (!ent.isDirectory() || isIgnorableDirEntry(ent.name)) continue;
      if (folderName && ent.name === folderName) continue;
      extraFolders += 1;
      addMontageRoot(ent.name);
    }
    for (const root of montageRoots) {
      if (out.length >= max) break;
      let aos;
      try {
        if (!fs.existsSync(root.abs) || !fs.statSync(root.abs).isDirectory()) continue;
        aos = fs.readdirSync(root.abs, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      let aoN = 0;
      for (const ao of aos) {
        if (out.length >= max || aoN >= 8) break;
        if (!ao.isDirectory() || isIgnorableDirEntry(ao.name)) continue;
        aoN += 1;
        const bilderAbs = path.join(root.abs, ao.name, 'Bilder');
        const bilderRel = posixJoin(root.rel, ao.name, 'Bilder');
        collectRastersLimited(bilderAbs, bilderRel, out, max, 2, jobId, fab);
      }
    }
  }
  const uniq = [];
  for (const f of out) {
    const k = String(f.rel || '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
  }
  return uniq;
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
  const parent = galleryParentFolder(file.rel, file.name, fabNorm);
  const qExtra = Object.assign({}, extra);
  if (file.jobId) qExtra.job_id = String(file.jobId);
  return {
    key: 'pn:' + file.rel.toLowerCase(),
    title: parent && parent !== 'Stamm' ? parent + ' / ' + file.name : file.name,
    parent_folder: parent || 'Stamm',
    source: 'projekte_neu',
    rel_path: file.rel,
    thumb_url:
      '/api/anlagenstamm_file_download.php?' +
      downloadQuery(fabNorm, file.rel, Object.assign({ thumb: '1', thumb_max: '256', prefer_cache: '1' }, qExtra)),
    full_url:
      '/api/anlagenstamm_file_download.php?' +
      downloadQuery(fabNorm, file.rel, Object.assign({ inline: '1' }, qExtra)),
    is_title: false,
  };
}

/**
 * Galerie-Index aus lokalem PROJEKTE-NEU-Tree plus Auftrags-Montagefotos.
 * Montage-Fotos (Pfad oder Kameraname) haben Vorrang vor FN-Archivbildern.
 * @returns {Array<object>}
 */
function buildLocalAnlagenstammGallery(fab, tree, opts) {
  const fabRaw = String(fab || '').trim();
  const fabNorm = galleryFabKey(fabRaw) || fabRaw;
  if (!fabNorm) return [];
  const files = [];
  const max = opts && opts.max != null ? Number(opts.max) : GALLERY_MAX;
  const treeNodes = Array.isArray(tree) ? tree : [];
  walkRasterFiles(treeNodes, files, 0, (dirName) => shouldSkipGalleryDir(dirName, fabNorm));
  if (!files.length) {
    walkRasterFiles(treeNodes, files, 0, null);
  }
  for (const extra of Array.isArray(opts && opts.extraFiles) ? opts.extraFiles : []) {
    if (!extra || typeof extra !== 'object') continue;
    const rel = String(extra.rel || extra.path || extra.rel_path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();
    const name = String(extra.name || rel.split('/').pop() || '').trim();
    if (!rel || !isRasterName(name || rel)) continue;
    const item = { name: name || rel.split('/').pop() || rel, rel };
    if (extra.jobId) item.jobId = extra.jobId;
    files.push(item);
  }
  const montage = [];
  const own = [];
  const unassigned = [];
  const seen = new Set();
  for (const f of files) {
    const rel = f.rel;
    const key = 'pn:' + rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyGalleryRel(rel, fabNorm);
    const lead = leadingFnFromName(f.name);
    const digits = String(fabNorm).replace(/\D/g, '');
    if (lead && digits && lead !== digits) continue;
    if (isMontageJobPhoto(rel, f.name, fabNorm)) {
      montage.push(f);
      continue;
    }
    if (kind === 'other') continue;
    if (kind === 'own') own.push(f);
    else unassigned.push(f);
  }
  const pickedMontage = montage.slice(0, max);
  const rest = Math.max(0, max - pickedMontage.length);
  const pickedOwn = own.slice(0, rest);
  const pickedUn = unassigned.slice(0, Math.max(0, rest - pickedOwn.length));
  const picked = pickedMontage.concat(pickedOwn, pickedUn);
  const tid = opts && opts.technicianId ? String(opts.technicianId) : '';
  const extra = tid ? { technician_id: tid } : {};
  return picked.map((f) => mapGalleryItem(fabNorm, f, extra));
}

module.exports = {
  GALLERY_MAX,
  MONTAGE_GALLERY_MAX,
  isRasterName,
  isMontagePath,
  isMontageJobPhoto,
  galleryMontageGroup,
  galleryParentFolder,
  walkRasterFiles,
  classifyGalleryRel,
  galleryFabKey,
  shouldSkipGalleryDir,
  folderMatchesOtherFab,
  isIsoDatePrefixedFolderName,
  listMontageRastersFromDokumenteMonteurPaths,
  buildLocalAnlagenstammGallery,
};
