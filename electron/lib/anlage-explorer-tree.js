'use strict';

const path = require('path');
const fs = require('fs');

const ANLAGE_PREFIX = 'Dokumente_Anlage';

function normRel(r) {
  return String(r || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function normFabKey(fab) {
  return String(fab || '')
    .trim()
    .replace(/\D/g, '');
}

/**
 * @param {string} subpath
 * @returns {{ kind: 'root'|'fn'|'inner', folderName?: string, innerRel?: string }|null}
 */
function parseAnlageExplorerSubpath(subpath) {
  const norm = normRel(subpath);
  if (norm === ANLAGE_PREFIX) return { kind: 'root' };
  if (!norm.startsWith(`${ANLAGE_PREFIX}/`)) return null;
  const rest = norm.slice(ANLAGE_PREFIX.length + 1);
  const parts = rest.split('/').filter(Boolean);
  if (!parts.length) return { kind: 'root' };
  const folderName = parts[0];
  const innerRel = parts.slice(1).join('/');
  return innerRel ? { kind: 'inner', folderName, innerRel } : { kind: 'fn', folderName, innerRel: '' };
}

function isAnlageDbExplorerSubpath(subpath) {
  return parseAnlageExplorerSubpath(subpath) != null;
}

function fabForFolderName(fabMap, folderName) {
  const name = String(folderName || '').trim();
  if (!name) return null;
  for (const e of fabMap || []) {
    if (String(e.folder_name_canonical || '').trim() === name) {
      return String(e.fab || '').trim();
    }
  }
  for (const e of fabMap || []) {
    if (String(e.fab || '').trim() === name) {
      return String(e.fab || '').trim();
    }
  }
  return null;
}

function folderNameForFab(fabMap, fab) {
  const f = String(fab || '').trim();
  for (const e of fabMap || []) {
    if (String(e.fab || '').trim() === f) {
      return String(e.folder_name_canonical || e.fab || f).trim();
    }
  }
  return f;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} localJobId
 */
function getTedRelSetByFab(db, localJobId) {
  let rows = [];
  try {
    rows = db.prepare('SELECT fab, rel_path FROM job_ted_index WHERE local_job_id = ?').all(localJobId);
  } catch (_) {
    rows = [];
  }
  const byFab = new Map();
  for (const r of rows) {
    const fab = String(r.fab || '').trim();
    const rel = normRel(r.rel_path);
    if (!rel) continue;
    const keys = new Set([fab, normFabKey(fab), '_any']);
    for (const k of keys) {
      if (!k) continue;
      if (!byFab.has(k)) byFab.set(k, new Set());
      byFab.get(k).add(rel);
    }
  }
  return byFab;
}

function isTedProjekteNeuPath(fab, pnRel, tedByFab) {
  const rel = normRel(pnRel);
  if (!rel) return false;
  if (/^TED(\/|$)/i.test(rel)) return true;
  const keys = [String(fab || '').trim(), normFabKey(fab), '_any'];
  for (const k of keys) {
    const set = tedByFab.get(k);
    if (set && set.has(rel)) return true;
  }
  const base = path.posix.basename(rel);
  for (const set of tedByFab.values()) {
    for (const tedRel of set) {
      if (path.posix.basename(tedRel) === base && base.toLowerCase().endsWith('.xlsx')) {
        return true;
      }
    }
  }
  return false;
}

function nodeRel(node) {
  return normRel(node && (node.rel != null ? node.rel : node.name));
}

function findTreeNodesAt(tree, innerRel) {
  const target = normRel(innerRel);
  if (!target) return Array.isArray(tree) ? tree : [];
  const parts = target.split('/').filter(Boolean);
  let nodes = Array.isArray(tree) ? tree : [];
  for (const part of parts) {
    let dir = null;
    for (const n of nodes) {
      if (!n || n.type !== 'dir') continue;
      if (n.name === part || nodeRel(n) === part || nodeRel(n).endsWith(`/${part}`)) {
        dir = n;
        break;
      }
    }
    if (!dir || !Array.isArray(dir.children)) return [];
    nodes = dir.children;
  }
  return nodes;
}

function filterTedFromNodes(nodes, fab, tedByFab) {
  const out = [];
  for (const n of nodes || []) {
    if (!n || !n.type) continue;
    if (n.type === 'file') {
      const rel = nodeRel(n);
      if (isTedProjekteNeuPath(fab, rel, tedByFab)) continue;
      out.push(n);
      continue;
    }
    if (n.type === 'dir') {
      const rel = nodeRel(n);
      if (isTedProjekteNeuPath(fab, rel, tedByFab)) continue;
      const copy = { ...n };
      if (Array.isArray(n.children)) {
        copy.children = filterTedFromNodes(n.children, fab, tedByFab);
      }
      out.push(copy);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {number} opts.localJobId
 * @param {string} opts.reiseDir
 * @param {string} opts.subpath
 * @param {Array<{fab:string,folder_name_canonical:string}>} opts.fabMap
 * @param {function(string,string): object|null} opts.readTreeCache
 * @param {function(number,string,string): string|null} opts.resolveLocalFile
 * @param {import('better-sqlite3').Database} opts.db
 */
function buildAnlageExplorerEntries(opts) {
  const parsed = parseAnlageExplorerSubpath(opts.subpath);
  if (!parsed) return null;

  const reiseDir = opts.reiseDir;
  const fabMap = opts.fabMap || [];
  const tedByFab = getTedRelSetByFab(opts.db, opts.localJobId);
  const resolveLocal = opts.resolveLocalFile || (() => null);

  if (parsed.kind === 'root') {
    const seen = new Set();
    const entries = [];
    for (const e of fabMap) {
      const folderName = String(e.folder_name_canonical || e.fab || '').trim();
      if (!folderName || seen.has(folderName.toLowerCase())) continue;
      seen.add(folderName.toLowerCase());
      const relativePath = path.posix.join(ANLAGE_PREFIX, folderName);
      const fullPath = path.join(reiseDir, ...relativePath.split('/'));
      let isDirectory = true;
      try {
        isDirectory = fs.existsSync(fullPath) ? fs.statSync(fullPath).isDirectory() : true;
      } catch (_) {
        isDirectory = true;
      }
      entries.push({
        name: folderName,
        relativePath,
        fullPath: fs.existsSync(fullPath) ? fullPath : fullPath,
        isDirectory: true,
        size: null,
        mtime: null,
        isAnlageDb: true,
        fab: String(e.fab || '').trim(),
        pnRel: '',
        isOffline: fs.existsSync(fullPath),
      });
    }
    entries.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    return { entries, anlageDb: true };
  }

  const folderName = parsed.folderName;
  const fab = fabForFolderName(fabMap, folderName) || folderName;
  const cached = opts.readTreeCache(fab);
  let tree = cached && Array.isArray(cached.tree) ? cached.tree : [];
  tree = filterTedFromNodes(tree, fab, tedByFab);

  const nodes = findTreeNodesAt(tree, parsed.innerRel || '');
  const subPrefix = path.posix.join(ANLAGE_PREFIX, folderName, parsed.innerRel || '').replace(/\/+$/, '');

  const entries = [];
  for (const n of nodes) {
    if (!n || !n.type) continue;
    const pnRel = nodeRel(n);
    if (!pnRel) continue;
    const name = String(n.name || path.posix.basename(pnRel));
    const relativePath = subPrefix ? `${subPrefix}/${name}` : path.posix.join(ANLAGE_PREFIX, folderName, name);
    const isDirectory = n.type === 'dir';
    let fullPath = '';
    let size = null;
    let mtime = null;
    let isOffline = false;

    if (!isDirectory) {
      const localHit = resolveLocal(opts.localJobId, fab, pnRel);
      if (localHit) {
        fullPath = localHit;
        isOffline = true;
        try {
          const st = fs.statSync(localHit);
          size = st.size;
          mtime = st.mtime ? st.mtime.toISOString() : null;
        } catch (_) {}
      } else if (n.size != null) {
        size = n.size;
      }
      if (n.mtime != null && !mtime) {
        const ts = Number(n.mtime);
        if (Number.isFinite(ts) && ts > 0) {
          mtime = new Date(ts * 1000).toISOString();
        }
      }
    } else {
      const dirAbs = path.join(reiseDir, ...relativePath.split('/'));
      isOffline = fs.existsSync(dirAbs) && fs.statSync(dirAbs).isDirectory();
      fullPath = dirAbs;
    }

    entries.push({
      name,
      relativePath,
      fullPath,
      isDirectory,
      size,
      mtime,
      isAnlageDb: true,
      fab,
      pnRel,
      isOffline,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  });

  return { entries, anlageDb: true, fab, treeEmpty: tree.length === 0 };
}

module.exports = {
  ANLAGE_PREFIX,
  parseAnlageExplorerSubpath,
  isAnlageDbExplorerSubpath,
  fabForFolderName,
  folderNameForFab,
  buildAnlageExplorerEntries,
  isTedProjekteNeuPath,
  filterTedFromNodes,
};
