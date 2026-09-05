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

/** Leerzeichen, Unterstriche und „, AT“ / „, _AT“ gelten als derselbe FN-Ordner. */
function fnFolderAliasKey(name) {
  return String(name || '')
    .trim()
    .replace(/,\s*_*/g, ',')
    .replace(/\s+/g, '_')
    .replace(/,+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function isFnFolderAlias(a, b) {
  const na = String(a || '').trim();
  const nb = String(b || '').trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return fnFolderAliasKey(na) === fnFolderAliasKey(nb);
}

function isRangeFnFolderName(name) {
  const n = String(name || '');
  return n.includes(' - ') || /\d+\s*-\s*\d+/.test(n);
}

/**
 * PROJEKTE-NEU-Projektkopf mit Datum: 30-2020-07-25_Kunde_Ort
 * Darf nicht als FN-Bereich „30 bis 2020“ gelesen werden.
 */
function isDatePrefixedProjectFolderName(name) {
  return /^\d{1,2}-\d{4}-\d{2}-\d{2}(?:[_-\s]|$)/.test(String(name || '').trim());
}

/**
 * FN-Bereich aus Ordnernamen (Dispo-Konvention).
 * Beispiele: 11952 - 11958, 11952-11958, 11952-58, 11952 - 58, 500-501.
 * @returns {{ from: number, to: number }|null}
 */
function parseFnRangeFromFolderName(dirName) {
  const n = String(dirName || '').trim();
  if (!n || isDatePrefixedProjectFolderName(n)) return null;
  const m = n.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  const after = n.slice(m.index + m[0].length);
  if (/^-\d{2}(?:-\d{2})?(?:[_-\s]|$)/.test(after)) return null;
  const fromStr = m[1];
  const toStr = m[2];
  if (fromStr.length < 3 || fromStr.length > 6) return null;
  if (toStr.length > 6) return null;
  let from = parseInt(fromStr, 10);
  let to = parseInt(toStr, 10);
  if (toStr.length < fromStr.length) {
    const prefix = fromStr.slice(0, fromStr.length - toStr.length);
    to = parseInt(prefix + toStr, 10);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  if (to - from > 1000) return null;
  return { from, to };
}

function pickFnRangeDir(dirNames, fab) {
  const digits = String(fab ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const fnNum = parseInt(digits, 10);
  if (!Number.isFinite(fnNum)) return null;
  for (const raw of dirNames || []) {
    const dirName = String(raw || '').trim();
    if (!dirName) continue;
    const range = parseFnRangeFromFolderName(dirName);
    if (range && fnNum >= range.from && fnNum <= range.to) return dirName;
  }
  return null;
}

function parseFabNumber(fab) {
  const s = String(fab ?? '').trim();
  if (!s) return null;
  const digits = /^\d+$/.test(s) ? s : s.replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Eindeutige numerische FNs, aufsteigend. Nicht-numerische werden weggelassen.
 * @param {Array<string|number>} fabList
 * @returns {Array<{ n: number, fab: string }>}
 */
function uniqueSortedNumericFabs(fabList) {
  const byN = new Map();
  for (const fab of fabList || []) {
    const n = parseFabNumber(fab);
    if (n == null) continue;
    const key = String(fab).trim();
    if (!byN.has(n)) byN.set(n, key || String(n));
  }
  return [...byN.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, fab]) => ({ n, fab }));
}

/**
 * Lückenlose Läufe (n, n+1, n+2, …).
 * @param {Array<{ n: number, fab: string }>} items
 */
function consecutiveNumericFabRuns(items) {
  const runs = [];
  let cur = [];
  for (const it of items || []) {
    if (!cur.length || it.n === cur[cur.length - 1].n + 1) cur.push(it);
    else {
      runs.push(cur);
      cur = [it];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** True, wenn der Ordnername exakt oder als FN-Bereich zu dieser Fabrikationsnummer gehört. */
function folderNameMatchesFab(folderName, fab) {
  const n = String(folderName || '').trim();
  if (!n) return false;
  if (pickPreferredExactFnDir([n], fab)) return true;
  const range = parseFnRangeFromFolderName(n);
  if (!range) return false;
  const digits = String(fab ?? '').replace(/\D/g, '');
  if (!digits) return false;
  const fnNum = parseInt(digits, 10);
  return Number.isFinite(fnNum) && fnNum >= range.from && fnNum <= range.to;
}

function collectExactFnFolderMatches(dirNames, fab) {
  const digits = String(fab ?? '').replace(/\D/g, '');
  if (!digits) return [];
  const fnNum = parseInt(digits, 10);
  if (!Number.isFinite(fnNum)) return [];
  const out = [];
  for (const raw of dirNames || []) {
    const n = String(raw || '').trim();
    if (!n || isRangeFnFolderName(n) || isDatePrefixedProjectFolderName(n)) continue;
    const digitsOnly = n.replace(/\D/g, '');
    if (digitsOnly && parseInt(digitsOnly, 10) === fnNum) out.push(n);
  }
  return out;
}

/** Bei mehreren Treffern: Fileserver-Stil (mit Leerzeichen) vor Unterstrich-Variante. */
function pickPreferredExactFnDir(dirNames, fab) {
  const exact = collectExactFnFolderMatches(dirNames, fab);
  if (!exact.length) return null;
  const withSpaces = exact.filter((n) => /\s/.test(n));
  if (withSpaces.length) return withSpaces[0];
  const nonBare = exact.filter((n) => !/^\d+$/.test(String(n).trim()));
  if (nonBare.length) return nonBare[0];
  return exact[0];
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
  if (!Number.isFinite(parseInt(digits, 10))) return null;
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

  const exact = pickPreferredExactFnDir(dirs, fab);
  if (exact) return exact;
  return pickFnRangeDir(dirs, fab);
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

/**
 * Kanonischer FN-Ordnername aus einer Liste (z. B. Dispo-Listing), ohne Dateisystem.
 * @param {string[]} dirNames
 * @param {string|number} fab
 * @returns {string|null}
 */
function resolveCanonicalFolderFromDirList(dirNames, fab) {
  const fabStr = String(fab ?? '').trim();
  const digits = fabStr.replace(/\D/g, '');
  if (!digits) return null;
  if (!Number.isFinite(parseInt(digits, 10))) return null;
  const dirs = (dirNames || []).map((n) => String(n || '').trim()).filter(Boolean);

  const exact = pickPreferredExactFnDir(dirs, fab);
  if (exact) return exact;
  return pickFnRangeDir(dirs, fab);
}

module.exports = {
  findMonteurFolderForFab,
  resolveCanonicalFolderFromDirList,
  fnFolderAliasKey,
  isFnFolderAlias,
  isRangeFnFolderName,
  isDatePrefixedProjectFolderName,
  parseFnRangeFromFolderName,
  folderNameMatchesFab,
  parseFabNumber,
  uniqueSortedNumericFabs,
  consecutiveNumericFabRuns,
  collectExactFnFolderMatches,
  pickPreferredExactFnDir,
  pickFnRangeDir,
  safeResolveUnderRoot,
  scanProjekteNeuTree,
  resolveProjekteNeuRoot,
  isIgnorableDirEntry,
};
