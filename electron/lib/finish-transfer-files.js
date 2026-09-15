'use strict';

const fs = require('fs');
const path = require('path');
const { isMonteurWorkRelPath, isMonteurPhotoCategoryRel } = require('./monteur-montage-paths');

const SIDECAR_NAME = '.kukla_transfer_rel_paths.json';

function normRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function stripDokumenteMonteurPrefix(rel) {
  const n = normRel(rel);
  return n.replace(/^Dokumente_Monteur\//i, '');
}

function montageTail(rel) {
  const n = stripDokumenteMonteurPrefix(rel).toLowerCase();
  const i = n.indexOf('/montage/');
  if (i >= 0) return n.slice(i);
  if (n.startsWith('montage/')) return '/' + n;
  return n;
}

function shouldSkipFinishTransferFile(rel, baseName) {
  const base = String(baseName || path.basename(rel || '')).trim();
  const baseLower = base.toLowerCase();
  const relLower = normRel(rel).toLowerCase();
  if (!baseLower || baseLower === '.' || baseLower === '..') return true;
  if (baseLower.startsWith('.')) return true;
  if (baseLower.includes('debug')) return true;
  if (/\.(json|tmp|temp|bak|part|crdownload|ds_store)$/i.test(baseLower)) return true;
  if (baseLower === 'thumbs.db' || baseLower === 'desktop.ini') return true;
  if (/^montagebericht_(de|en)\.docx$/i.test(baseLower) && !relLower.includes('/montage/')) return true;
  return false;
}

function isFinishUploadRelPath(relPath, auftragsordner) {
  const ao = String(auftragsordner || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const norm = normRel(relPath);
  if (isMonteurWorkRelPath(norm, ao)) return true;
  if (!isMonteurPhotoCategoryRel(norm)) return false;
  const parts = norm.split('/').filter(Boolean);
  if (parts[1] && parts[1].toLowerCase() === 'montage') {
    return !!ao && parts[2] === ao;
  }
  if (parts[2] && parts[2].toLowerCase() === 'montage') {
    return !!ao && parts[3] === ao;
  }
  return false;
}

function isSonstigesRel(relPath) {
  return /\/Sonstiges(\/|$)/i.test(normRel(relPath));
}

function folderLabelFromRel(relPath) {
  const n = stripDokumenteMonteurPrefix(relPath);
  const parts = n.split('/').filter(Boolean);
  if (!parts.length) return '';
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.includes('sonstiges')) return 'Sonstiges';
  if (lower.includes('protokolle')) return 'Protokolle';
  if (lower.includes('bilder')) return 'Bilder';
  if (lower.includes('parameter') || lower.includes('parameterlisten')) return 'Parameter';
  const lastDir = parts.length >= 2 ? parts[parts.length - 2] : '';
  if (!lastDir) return '';
  if (/^montage$/i.test(lastDir)) return '';
  return lastDir;
}

function fnLabelFromRel(relPath) {
  const n = stripDokumenteMonteurPrefix(relPath);
  const parts = n.split('/').filter(Boolean);
  if (!parts.length) return 'Ohne FN';
  const first = parts[0];
  if (/^(montage|bilder)$/i.test(first)) return 'Ohne FN';
  return first;
}

function parseOptionalTransferRelPaths(body) {
  if (!body || typeof body !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, 'transfer_rel_paths')) return undefined;
  const raw = body.transfer_rel_paths;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const n = normRel(item);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function transferRelMatches(candidate, whitelist) {
  if (whitelist == null) return true;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  const candNorm = stripDokumenteMonteurPrefix(candidate).toLowerCase();
  const candTail = montageTail(candidate);
  const candBase = path.posix.basename(candNorm);
  for (const w of whitelist) {
    const wNorm = stripDokumenteMonteurPrefix(w).toLowerCase();
    const wTail = montageTail(w);
    if (candNorm === wNorm) return true;
    if (candTail && wTail && candTail === wTail) return true;
    if (candBase && candBase === path.posix.basename(wNorm) && candTail && wTail && candTail === wTail) {
      return true;
    }
  }
  return false;
}

function uniqueTargetName(dir, desiredName) {
  const base = path.basename(String(desiredName || 'datei'));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = stem + '_' + n + ext;
    n += 1;
    if (n > 9999) throw new Error('Zu viele Namenskollisionen: ' + base);
  }
  return candidate;
}

function sanitizeIncomingFileName(name) {
  let base = path.basename(String(name || 'datei').replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  if (!base || base === '.' || base === '..') base = 'datei';
  return base;
}

function walkFiles(absDir, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (!e || !e.name || e.name === '.' || e.name === '..') continue;
    if (e.name.startsWith('.')) continue;
    const full = path.join(absDir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) {
      walkFiles(full, rel, out);
    } else if (e.isFile()) {
      out.push({ absPath: full, relPath: rel, name: e.name });
    }
  }
}

function listFinishTransferFiles(reiseDir, auftragsordner) {
  const root = path.resolve(String(reiseDir || ''));
  const ao = String(auftragsordner || '').trim();
  const dm = path.join(root, 'Dokumente_Monteur');
  const files = [];
  const walked = [];
  if (fs.existsSync(dm)) walkFiles(dm, 'Dokumente_Monteur', walked);
  for (const item of walked) {
    const rel = normRel(item.relPath);
    if (shouldSkipFinishTransferFile(rel, item.name)) continue;
    if (!isFinishUploadRelPath(rel, ao)) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(item.absPath).size;
    } catch (_) {
      sizeBytes = 0;
    }
    files.push({
      rel_path: rel,
      abs_path: item.absPath,
      name: item.name,
      folder_label: folderLabelFromRel(rel),
      fn_label: fnLabelFromRel(rel),
      size_bytes: sizeBytes,
    });
  }
  files.sort((a, b) => {
    const g = String(a.fn_label).localeCompare(String(b.fn_label), 'de');
    if (g) return g;
    const f = String(a.folder_label).localeCompare(String(b.folder_label), 'de');
    if (f) return f;
    return String(a.name).localeCompare(String(b.name), 'de');
  });
  const groupMap = new Map();
  for (const f of files) {
    const key = f.fn_label || 'Ohne FN';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(f);
  }
  const groups = Array.from(groupMap.entries()).map(([fn_label, items]) => ({ fn_label, files: items }));
  const fnOptions = groups.map((g) => g.fn_label).filter((n) => n && n !== 'Ohne FN');
  return { files, groups, fn_options: fnOptions };
}

function saveFinishExtraFile(opts) {
  const reiseDir = path.resolve(String(opts.reiseDir || ''));
  const ao = String(opts.auftragsordner || '').trim();
  let fnFolder = String(opts.fnFolder || opts.fn_folder || '').trim();
  if (!fnFolder || fnFolder === 'Ohne FN') {
    const listed = listFinishTransferFiles(reiseDir, ao);
    fnFolder = listed.fn_options[0] || '';
  }
  if (!fnFolder) throw new Error('Keine Fabrikationsnummer für Zusatzdatei.');
  if (!ao) throw new Error('Auftragsordner fehlt.');
  const destDir = path.join(reiseDir, 'Dokumente_Monteur', fnFolder, 'Montage', ao, 'Sonstiges');
  fs.mkdirSync(destDir, { recursive: true });
  const destName = uniqueTargetName(destDir, sanitizeIncomingFileName(opts.filename));
  if (shouldSkipFinishTransferFile(destName, destName)) {
    throw new Error('Dateityp nicht erlaubt: ' + destName);
  }
  const destAbs = path.join(destDir, destName);
  if (Buffer.isBuffer(opts.buffer)) {
    fs.writeFileSync(destAbs, opts.buffer);
  } else if (opts.sourcePath) {
    fs.copyFileSync(String(opts.sourcePath), destAbs);
  } else {
    throw new Error('Keine Dateidaten.');
  }
  const rel = normRel(path.relative(reiseDir, destAbs));
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(destAbs).size;
  } catch (_) {}
  return {
    rel_path: rel,
    abs_path: destAbs,
    name: destName,
    folder_label: 'Sonstiges',
    fn_label: fnFolder,
    size_bytes: sizeBytes,
  };
}

module.exports = {
  SIDECAR_NAME,
  normRel,
  stripDokumenteMonteurPrefix,
  montageTail,
  shouldSkipFinishTransferFile,
  isFinishUploadRelPath,
  isSonstigesRel,
  folderLabelFromRel,
  fnLabelFromRel,
  parseOptionalTransferRelPaths,
  transferRelMatches,
  uniqueTargetName,
  sanitizeIncomingFileName,
  listFinishTransferFiles,
  saveFinishExtraFile,
};
