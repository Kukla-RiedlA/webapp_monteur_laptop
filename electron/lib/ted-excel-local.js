'use strict';

const fs = require('fs');
const path = require('path');

const EXCEL_EXT = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb']);

/**
 * Anzeige-/Fallback-Dateiname aus Server-Name oder rel_path.
 * @param {string} rawName
 * @param {string} relPath
 */
function safeTedFileName(rawName, relPath) {
  let rawNameStr =
    String(rawName || '').trim() || String(relPath || '').split(/[/\\]/).pop() || 'ted.xlsx';
  if (!/\.(xlsx|xlsm|xls|xlsb)$/i.test(rawNameStr)) {
    const relExt = path.extname(String(relPath || ''));
    if (/^\.(xlsx|xlsm|xls|xlsb)$/i.test(relExt)) {
      rawNameStr = path.basename(rawNameStr, path.extname(rawNameStr)) + relExt;
    } else if (!path.extname(rawNameStr)) {
      rawNameStr += '.xlsx';
    }
  }
  return String(rawNameStr).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'ted.xlsx';
}

function sanitizeTedFabPrefix(fab) {
  return String(fab || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

/**
 * Lokaler Dateiname unter Reiseordner/TED/: Server-Dateiname (z. B. 1218001DF-Schenck-U.xls).
 * Die Dateinamen sind pro FN bereits eindeutig – kein FN-Präfix.
 * @param {{ rel_path?: string, file_name?: string, fab?: string }} ent
 * @param {Set<string>} [usedNames] bereits vergebene Namen in diesem Lauf
 */
function safeTedLocalFileName(ent, usedNames) {
  const rel = String((ent && ent.rel_path) || '')
    .trim()
    .replace(/\\/g, '/');
  let base = safeTedFileName(ent && ent.file_name, rel);
  const used = usedNames || null;
  if (!used) return base;
  const key = base.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return base;
  }
  const ext = path.extname(base) || '.xlsx';
  const root = path.basename(base, ext);
  let n = 2;
  while (used.has((root + '_' + n + ext).toLowerCase())) n++;
  base = root + '_' + n + ext;
  used.add(base.toLowerCase());
  return base;
}

/**
 * @param {string} targetPath
 */
function isExcelFilePath(targetPath) {
  return EXCEL_EXT.has(path.extname(String(targetPath || '')).toLowerCase());
}

/**
 * @param {string} relPath
 * @returns {string[]}
 */
function tedRelPathVariants(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!norm || norm.includes('..')) return [];
  const out = [norm];
  const stripped = norm.replace(/^(WIN\/ted|WIN\/TED|win\/ted)\/?/i, '');
  if (stripped && stripped !== norm) out.push(stripped);
  return [...new Set(out)];
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string|null}
 */
function resolveUnderRoot(root, rel) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (_) {
    return null;
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) return null;
  const target = path.resolve(rootReal, ...parts);
  try {
    const targetReal = fs.realpathSync(target);
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null;
    if (fs.statSync(targetReal).isFile() && isExcelFilePath(targetReal)) return targetReal;
  } catch (_) {}
  return null;
}

/**
 * @param {string} dir
 * @param {string} baseName
 * @param {{ maxDepth?: number, maxVisited?: number, _depth?: number, _visited?: { n: number } }} opts
 * @returns {string|null}
 */
function findExcelByBasename(dir, baseName, opts) {
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 10;
  const maxVisited = opts.maxVisited != null ? opts.maxVisited : 4000;
  const depth = opts._depth != null ? opts._depth : 0;
  const visited = opts._visited || { n: 0 };
  if (depth > maxDepth || visited.n > maxVisited) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const want = String(baseName || '').toLowerCase();
  for (const ent of entries) {
    if (visited.n > maxVisited) break;
    visited.n += 1;
    const full = path.join(dir, ent.name);
    if (ent.isFile()) {
      if (want && ent.name.toLowerCase() === want && isExcelFilePath(full)) return full;
      continue;
    }
    if (!ent.isDirectory()) continue;
    const hit = findExcelByBasename(full, baseName, {
      maxDepth,
      maxVisited,
      _depth: depth + 1,
      _visited: visited,
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {string} dir
 * @param {string} fab
 * @param {{ maxDepth?: number }} opts
 * @returns {string|null}
 */
function findExcelByFabInName(dir, fab, opts) {
  const needle = String(fab || '').trim();
  if (!needle) return null;
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 8;
  let best = null;
  let bestMtime = 0;
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isFile() && isExcelFilePath(full) && ent.name.includes(needle)) {
        try {
          const mt = fs.statSync(full).mtimeMs;
          if (mt >= bestMtime) {
            bestMtime = mt;
            best = full;
          }
        } catch (_) {}
      } else if (ent.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }
  walk(dir, 0);
  return best;
}

/**
 * @returns {string[]}
 */
function defaultWindowsTedRoots() {
  const roots = [];
  const env = process.env.KUKLA_MECHANIK_TED_ROOT || process.env.KUKLA_FILESERVER_MECHANIK_ROOT;
  if (env) roots.push(env);
  const guesses = [
    'P:\\Mechanik\\WIN\\TED',
    'P:\\Mechanik\\WIN\\ted',
    'P:\\Fileserver\\Mechanik\\WIN\\TED',
    'P:\\KUKLA\\Mechanik\\WIN\\TED',
    '\\\\fileserver\\Mechanik\\WIN\\TED',
  ];
  for (const g of guesses) {
    try {
      if (fs.existsSync(g)) roots.push(g);
    } catch (_) {}
  }
  return [...new Set(roots.map((r) => r.trim()).filter(Boolean))];
}

/**
 * @param {{ reiseDir?: string|null, relPath: string, fab?: string, extraRoots?: string[] }} opts
 * @returns {string|null}
 */
function resolveTedExcelLocal(opts) {
  const relPath = String(opts.relPath || '').trim();
  if (!relPath) return null;
  const baseName = path.basename(relPath.replace(/\\/g, '/'));
  const variants = tedRelPathVariants(relPath);
  const roots = [...(opts.extraRoots || []), ...defaultWindowsTedRoots()];
  const reiseDir = opts.reiseDir;
  if (reiseDir) {
    try {
      if (fs.existsSync(reiseDir) && fs.statSync(reiseDir).isDirectory()) {
        roots.unshift(reiseDir);
        const ent = {
          rel_path: relPath,
          file_name: opts.fileName,
          fab: opts.fab,
        };
        const nameCandidates = [safeTedLocalFileName(ent, null)];
        for (const nm of [...new Set(nameCandidates)]) {
          const tedCached = path.join(reiseDir, 'TED', nm);
          if (fs.existsSync(tedCached) && isExcelFilePath(tedCached)) return tedCached;
        }
      }
    } catch (_) {}
  }
  for (const root of roots) {
    for (const rel of variants) {
      const hit = resolveUnderRoot(root, rel);
      if (hit) return hit;
    }
    if (baseName) {
      const byName = findExcelByBasename(root, baseName, { maxDepth: 12 });
      if (byName) return byName;
    }
    if (opts.fab) {
      const byFab = findExcelByFabInName(root, opts.fab, { maxDepth: 10 });
      if (byFab) return byFab;
    }
  }
  return null;
}

module.exports = {
  resolveTedExcelLocal,
  isExcelFilePath,
  tedRelPathVariants,
  safeTedFileName,
  safeTedLocalFileName,
};
