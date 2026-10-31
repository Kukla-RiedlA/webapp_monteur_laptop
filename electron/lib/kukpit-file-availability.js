'use strict';

const fs = require('fs');
const path = require('path');
const { readCachedProjekteNeuFile } = require('./projekte-neu-file-cache');

function normRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function fileIsPresent(p) {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Bytes auf dem Laptop: Reiseordner (Dokumente_Anlage / TED) oder Hash-Cache.
 * Netzwerkpfade wie P:\\Mechanik zählen nicht als offline verfügbar.
 *
 * @param {object} opts
 * @param {string} [opts.resolvedPath]
 * @param {function} [opts.resolveReiseFile] (fab, rel) => string|null
 * @param {string} [opts.dbDir]
 * @param {string} [opts.fab]
 * @param {string} [opts.relPath]
 * @param {string} [opts.fileName]
 * @param {string} [opts.reiseDir]
 * @returns {string|null}
 */
function resolveKukpitOfflinePath(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (fileIsPresent(o.resolvedPath)) return o.resolvedPath;
  const rel = normRel(o.relPath);
  const fab = String(o.fab || '').trim();
  if (typeof o.resolveReiseFile === 'function') {
    try {
      const hit = o.resolveReiseFile(fab, rel);
      if (fileIsPresent(hit)) return hit;
    } catch (_) {}
  }
  if (o.dbDir && fab && rel) {
    try {
      const cached = readCachedProjekteNeuFile(o.dbDir, fab, rel);
      if (fileIsPresent(cached)) return cached;
    } catch (_) {}
  }
  const reiseDir = o.reiseDir ? String(o.reiseDir) : '';
  if (reiseDir) {
    for (const nm of stammTedCandidateNames(rel, o.fileName)) {
      const ted = path.join(reiseDir, 'TED', nm);
      if (fileIsPresent(ted)) return ted;
    }
  }
  if (o.dbDir && fab) {
    const stamm = resolveStammTedFile(o.dbDir, fab, rel, o.fileName);
    if (stamm) return stamm;
  }
  return null;
}

function stammTedFabDir(dbDir, fab) {
  const fabDir = String(fab || '').replace(/[^a-zA-Z0-9_\-]/g, '_') || '_';
  return path.join(String(dbDir || ''), 'anlagenstamm_ted', fabDir);
}

function stammTedCandidateNames(relPath, fileName) {
  const names = [];
  const rel = normRel(relPath);
  const named = String(fileName || '').trim();
  const base = rel ? path.posix.basename(rel) : '';
  if (named && !named.includes('..') && !/[\\/]/.test(named)) names.push(named);
  if (base && base !== '.' && base !== '..') names.push(base);
  const seen = new Set();
  const out = [];
  for (const nm of names) {
    const key = nm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(nm);
  }
  return out;
}

/** TED-Excel des Anlagenstamms, unabhängig vom angenommenen Auftrag. */
function resolveStammTedFile(dbDir, fab, relPath, fileName) {
  if (!dbDir || !String(fab || '').trim()) return null;
  const dir = stammTedFabDir(dbDir, fab);
  for (const nm of stammTedCandidateNames(relPath, fileName)) {
    const hit = path.join(dir, nm);
    if (fileIsPresent(hit)) return hit;
  }
  return null;
}

function isKukpitFileOffline(opts) {
  return !!resolveKukpitOfflinePath(opts);
}

/**
 * @param {object[]} nodes
 * @param {(rel: string, node: object) => boolean} probe
 */
function annotateTreeOffline(nodes, probe) {
  if (!Array.isArray(nodes)) return [];
  const ask = typeof probe === 'function' ? probe : () => false;
  return nodes.map((n) => {
    if (!n || typeof n !== 'object') return n;
    const copy = Object.assign({}, n);
    const type = String(copy.type || '');
    if (type === 'dir') {
      if (Array.isArray(copy.children)) copy.children = annotateTreeOffline(copy.children, ask);
      return copy;
    }
    if (type === 'file' || type === '') {
      const rel = normRel(copy.rel != null ? copy.rel : copy.path || copy.name);
      copy.is_offline = !!ask(rel, copy);
    }
    return copy;
  });
}

module.exports = {
  normRel,
  fileIsPresent,
  stammTedFabDir,
  stammTedCandidateNames,
  resolveStammTedFile,
  resolveKukpitOfflinePath,
  isKukpitFileOffline,
  annotateTreeOffline,
};
