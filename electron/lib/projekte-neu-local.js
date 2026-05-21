'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_DEPTH = 25;
const DEFAULT_MAX_ENTRIES = 15000;

function isIgnorableDirEntry(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..') return true;
  if (n.startsWith('.')) return true;
  const lower = n.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini';
}

/**
 * FN-Ordner unter Dokumente_Monteur (exakt oder Bereich „von - bis“).
 * @param {string} dokumenteMonteurPath
 * @param {string|number} fab
 * @returns {string|null}
 */
function findMonteurFolderForFab(dokumenteMonteurPath, fab) {
  const fabStr = String(fab ?? '').trim();
  const digits = fabStr.replace(/\D/g, '');
  if (!digits) return null;
  const fnNum = parseInt(digits, 10);
  if (!Number.isFinite(fnNum)) return null;
  if (!fs.existsSync(dokumenteMonteurPath) || !fs.statSync(dokumenteMonteurPath).isDirectory()) {
    return null;
  }
  let names;
  try {
    names = fs.readdirSync(dokumenteMonteurPath, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const dirs = names
    .filter((e) => e.isDirectory() && !isIgnorableDirEntry(e.name))
    .map((e) => e.name);

  for (const dirName of dirs) {
    if (dirName.includes(' - ')) continue;
    const digitsOnly = dirName.replace(/\D/g, '');
    if (digitsOnly && parseInt(digitsOnly, 10) === fnNum) return dirName;
  }

  const rangeRe = /(\d+)\s*-\s*(\d+)/;
  for (const dirName of dirs) {
    const m = dirName.match(rangeRe);
    if (!m) continue;
    let from = parseInt(m[1], 10);
    let to = parseInt(m[2], 10);
    const fromStr = m[1];
    const toStr = m[2];
    if (toStr.length < fromStr.length) {
      const prefix = fromStr.slice(0, fromStr.length - toStr.length);
      to = parseInt(prefix + toStr, 10);
    }
    if (fnNum >= from && fnNum <= to) return dirName;
  }
  return null;
}

/**
 * @param {string} root
 * @param {string} relPath
 * @returns {string|null}
 */
function safeResolveUnderRoot(root, relPath) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (_) {
    return null;
  }
  const norm = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (norm.includes('..')) return null;
  const target = path.resolve(rootReal, ...norm.split('/').filter(Boolean));
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) return null;
  return target;
}

/**
 * @param {string} absRoot
 * @param {{ maxDepth?: number, maxEntries?: number, relPrefix?: string, depth?: number, _counter?: { n: number } }} opts
 * @returns {{ tree: object[], truncated: boolean }}
 */
function scanProjekteNeuTree(absRoot, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxDepth = o.maxDepth != null ? o.maxDepth : DEFAULT_MAX_DEPTH;
  const maxEntries = o.maxEntries != null ? o.maxEntries : DEFAULT_MAX_ENTRIES;
  const relPrefix = o.relPrefix != null ? String(o.relPrefix) : '';
  const depth = o.depth != null ? o.depth : 0;
  const counter = o._counter || { n: 0 };
  let truncated = false;

  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    return { tree: [], truncated: false };
  }

  let names;
  try {
    names = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch (_) {
    return { tree: [], truncated: false };
  }

  const tree = [];
  names.sort((a, b) => {
    const ad = a.isDirectory();
    const bd = b.isDirectory();
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  for (const ent of names) {
    if (isIgnorableDirEntry(ent.name)) continue;
    if (counter.n >= maxEntries) {
      truncated = true;
      break;
    }
    counter.n += 1;
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    const full = path.join(absRoot, ent.name);
    if (ent.isDirectory()) {
      const node = { type: 'dir', name: ent.name, rel };
      if (depth < maxDepth) {
        const sub = scanProjekteNeuTree(full, {
          maxDepth,
          maxEntries,
          relPrefix: rel,
          depth: depth + 1,
          _counter: counter,
        });
        if (sub.tree.length) node.children = sub.tree;
        if (sub.truncated) truncated = true;
      }
      tree.push(node);
    } else if (ent.isFile()) {
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = Math.floor(st.mtimeMs / 1000);
      } catch (_) {}
      tree.push({ type: 'file', name: ent.name, rel, size, mtime });
    }
  }

  return { tree, truncated };
}

/**
 * @param {string} dokumenteMonteurPath
 * @param {string} fab
 * @returns {{ root: string, folderName: string }|null}
 */
function resolveProjekteNeuRoot(dokumenteMonteurPath, fab) {
  const folderName = findMonteurFolderForFab(dokumenteMonteurPath, fab);
  if (!folderName) return null;
  const root = path.join(dokumenteMonteurPath, folderName);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  return { root, folderName };
}

module.exports = {
  findMonteurFolderForFab,
  safeResolveUnderRoot,
  scanProjekteNeuTree,
  resolveProjekteNeuRoot,
  isIgnorableDirEntry,
};
