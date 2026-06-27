'use strict';

const fs = require('fs');
const path = require('path');
const { findMonteurFolderForFab, resolveCanonicalFolderFromDirList, isIgnorableDirEntry } = require('./projekte-neu-local');

function sanitizeDienstreiseFolderPart(str) {
  if (typeof str !== 'string') return '';
  const s = str.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').trim();
  return s || 'x';
}

/**
 * @param {{ start_datetime?: string, customer_name?: string, city?: string, country?: string }} jobRow
 * @param {string} technicianDisplayName
 */
function buildMonteurMontageFolderName(jobRow, technicianDisplayName) {
  const datePart = String(jobRow && jobRow.start_datetime ? jobRow.start_datetime : '')
    .trim()
    .slice(0, 10);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : '0000-00-00';
  const firm = sanitizeDienstreiseFolderPart(jobRow && jobRow.customer_name ? jobRow.customer_name : '');
  const ort = sanitizeDienstreiseFolderPart(jobRow && jobRow.city ? jobRow.city : '');
  const country = sanitizeDienstreiseFolderPart(jobRow && jobRow.country ? jobRow.country : '');
  const monteur = sanitizeDienstreiseFolderPart(technicianDisplayName || 'Monteur');
  return `${safeDate}_${firm}_${ort}_${country}_${monteur}`;
}

/**
 * Relativer Pfad Monteur-Arbeit:
 * Dokumente_Monteur/<Fileserver-FN>/Montage/<Auftragsordner>/…
 * @param {string} fnFolder kanonischer FN-Ordnername vom Fileserver (z. B. „7118 - 7123_Siniat, Lippendorf“)
 * @param {string} auftragsordner z. B. 2026-06-27_Test_x_DE_Mustermann
 * @param {string} [inner]
 */
function buildMonteurWorkRelPath(fnFolder, auftragsordner, inner) {
  const parts = ['Dokumente_Monteur', fnFolder, 'Montage', auftragsordner];
  if (inner) {
    const tail = String(inner).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (tail) parts.push(...tail.split('/').filter(Boolean));
  }
  return parts.join('/');
}

/**
 * @param {string} docMonteurBase
 * @param {string} fnFolder Fileserver-FN-Ordnername
 * @param {string} auftragsordner
 * @param {...string} inner
 */
function buildMonteurWorkAbsDir(docMonteurBase, fnFolder, auftragsordner, ...inner) {
  const parts = [docMonteurBase, fnFolder, 'Montage', auftragsordner, ...inner.filter(Boolean)];
  return path.join(...parts);
}

/**
 * Nur Pfade unter Dokumente_Monteur/<FN>/Montage/<Auftragsordner>/…
 */
function isMonteurWorkRelPath(relPath, auftragsordner) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const ao = String(auftragsordner || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!norm.startsWith('Dokumente_Monteur/') || !ao) return false;
  const parts = norm.split('/').filter(Boolean);
  return parts.length >= 4 && parts[0] === 'Dokumente_Monteur' && parts[2] === 'Montage' && parts[3] === ao;
}

/** Nur reine Ziffern (Fallback-Name) — nicht der Fileserver-Ordnername. */
function isBareFabFolderName(name) {
  const s = String(name || '').trim();
  return !!s && /^\d+$/.test(s);
}

/**
 * Entfernt falsches Layout: Dokumente_Monteur/<Auftragsordner>/Montage/… (Auftragsordner oben).
 */
function removeLegacyMonteurAuftragsordnerTopLevel(reiseDir, auftragsordner, fabFolderEntries) {
  const ao = String(auftragsordner || '').trim();
  if (!ao || !reiseDir) return;
  const fnNames = new Set(
    (fabFolderEntries || []).map((e) => String(e.folder_name_canonical || '').trim()).filter(Boolean),
  );
  if (fnNames.has(ao)) return;
  const legacyRoot = path.join(reiseDir, 'Dokumente_Monteur', ao);
  if (!fs.existsSync(legacyRoot)) return;
  const montageUnderLegacy = path.join(legacyRoot, 'Montage');
  if (!fs.existsSync(montageUnderLegacy)) return;
  try {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      '[monteur-paths] Altes Monteur-Layout (Auftragsordner oben) nicht entfernt:',
      legacyRoot,
      err && err.message ? err.message : err,
    );
  }
}

/**
 * Entfernt irrtümlich angelegte reine FN-Ziffern-Ordner (12300), wenn kanonischer Fileserver-Name existiert.
 */
function removeStaleBareFabMonteurDirs(reiseDir, fabFolderEntries) {
  migrateBareFabDirsUnder(reiseDir, 'Dokumente_Monteur', fabFolderEntries);
}

/**
 * Benennt reine FN-Ziffern-Ordner (7118) in kanonische Fileserver-Namen um bzw. merged Inhalt.
 */
function migrateBareFabAnlageDirs(reiseDir, fabFolderEntries) {
  migrateBareFabDirsUnder(reiseDir, 'Dokumente_Anlage', fabFolderEntries);
}

function listSubdirNames(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) return [];
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isIgnorableDirEntry(e.name))
      .map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/** FN-Ordnernamen unter Dokumente_Monteur und Dokumente_Anlage (Union). */
function collectReiseFnDirNames(reiseDir) {
  const seen = new Set();
  const out = [];
  for (const sub of ['Dokumente_Monteur', 'Dokumente_Anlage']) {
    for (const name of listSubdirNames(path.join(reiseDir, sub))) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Bevorzugt langen Fileserver-Namen statt reiner Ziffer „7118“. */
function pickNonBareCanonicalDirName(dirNames, fab) {
  const nonBare = (dirNames || []).filter((n) => !isBareFabFolderName(n));
  if (!nonBare.length) return null;
  return resolveCanonicalFolderFromDirList(nonBare, fab) || null;
}

/**
 * fab_map mit kanonischen Ordnernamen anreichern (Cache, Platte, bestehende fab_map).
 * @param {(fab: string) => string|null|undefined} readRootFolderName
 */
function resolveFabMapLocal(reiseDir, fabMapIn, jobFabNums, readRootFolderName) {
  const dirNames = collectReiseFnDirNames(reiseDir);
  const byFab = new Map();
  for (const e of fabMapIn || []) {
    if (e && e.fab != null) byFab.set(String(e.fab).trim(), e);
  }
  const fabNums =
    jobFabNums && jobFabNums.length
      ? jobFabNums.map((f) => String(f).trim()).filter(Boolean)
      : [...byFab.keys()];
  const out = [];
  for (const fab of fabNums) {
    const existing = byFab.get(fab);
    let folder_name_canonical =
      existing && existing.folder_name_canonical != null
        ? String(existing.folder_name_canonical).trim()
        : '';

    if (
      (!folder_name_canonical ||
        folder_name_canonical === fab ||
        isBareFabFolderName(folder_name_canonical)) &&
      typeof readRootFolderName === 'function'
    ) {
      const fromCache = String(readRootFolderName(fab) || '').trim();
      if (fromCache && !isBareFabFolderName(fromCache)) folder_name_canonical = fromCache;
    }

    if (!folder_name_canonical || folder_name_canonical === fab || isBareFabFolderName(folder_name_canonical)) {
      const fromDirs =
        pickNonBareCanonicalDirName(dirNames, fab) ||
        resolveCanonicalProjekteNeuFolderName(dirNames, fab);
      if (fromDirs && !isBareFabFolderName(fromDirs)) folder_name_canonical = fromDirs;
    }

    if (!folder_name_canonical) folder_name_canonical = fab;
    out.push({ fab, folder_name_canonical });
  }
  return out;
}

function mergeDirContentsInto(srcDir, dstDir) {
  let names;
  try {
    names = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of names) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    try {
      if (ent.isDirectory()) {
        if (!fs.existsSync(dst)) {
          fs.renameSync(src, dst);
        } else {
          mergeDirContentsInto(src, dst);
          fs.rmSync(src, { recursive: true, force: true });
        }
      } else if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
      }
    } catch (err) {
      console.warn('[monteur-paths] merge', src, '->', dst, err && err.message ? err.message : err);
    }
  }
}

function migrateBareFabDirsUnder(reiseDir, subfolder, fabFolderEntries) {
  const base = path.join(reiseDir, subfolder);
  if (!fs.existsSync(base)) return;
  for (const entry of fabFolderEntries || []) {
    const can = String(entry.folder_name_canonical || '').trim();
    const fab = String(entry.fab || '').trim();
    if (!can || !fab || can === fab || !isBareFabFolderName(fab)) continue;
    const stale = path.join(base, fab);
    if (!fs.existsSync(stale)) continue;
    const target = path.join(base, can);
    try {
      if (!fs.existsSync(target)) {
        fs.renameSync(stale, target);
      } else {
        mergeDirContentsInto(stale, target);
        fs.rmSync(stale, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(
        '[monteur-paths] FN-Ordner-Migration',
        subfolder,
        fab,
        '->',
        can,
        err && err.message ? err.message : err,
      );
    }
  }
}

/**
 * @param {string} reiseDir
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabFolderEntries
 */
function ensureAnlageFnDirs(reiseDir, fabFolderEntries) {
  const anlageBase = path.join(reiseDir, 'Dokumente_Anlage');
  if (!fs.existsSync(anlageBase)) fs.mkdirSync(anlageBase, { recursive: true });
  for (const entry of fabFolderEntries || []) {
    const fnFolder = String(entry.folder_name_canonical || '').trim();
    if (!fnFolder) continue;
    const target = path.join(anlageBase, fnFolder);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  }
}

/**
 * Dokumente_Monteur/<Fileserver-FN>/Montage/<Auftragsordner>/ für Monteur-Dokumente.
 */
function ensureMonteurMontageDirs(reiseDir, fabFolderEntries, auftragsordner) {
  const monteurBase = path.join(reiseDir, 'Dokumente_Monteur');
  if (!fs.existsSync(monteurBase)) fs.mkdirSync(monteurBase, { recursive: true });
  if (!auftragsordner) return;
  for (const entry of fabFolderEntries || []) {
    const fnFolder = String(entry.folder_name_canonical || '').trim();
    if (!fnFolder) continue;
    const target = path.join(monteurBase, fnFolder, 'Montage', auftragsordner);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  }
}

/**
 * Server-Manifest: Dokumente_Monteur/<FN>/… → lokales Spiegel-Layout unter Dokumente_Anlage.
 */
function mapServerManifestPathToLocalAnlageRel(serverRelPath) {
  const norm = String(serverRelPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const prefix = 'Dokumente_Monteur/';
  if (!norm.startsWith(prefix)) return norm;
  return 'Dokumente_Anlage/' + norm.slice(prefix.length);
}

/** @deprecated Alias — Downloads gehören nach Dokumente_Anlage. */
function mapServerManifestPathToLocalRel(serverRelPath) {
  return mapServerManifestPathToLocalAnlageRel(serverRelPath);
}

/**
 * @param {string} dmPath Dokumente_Monteur absolut
 * @param {string|number} fab
 * @param {string|null} auftragsordner
 */
function getMonteurWorkRoot(dmPath, fab, auftragsordner) {
  if (!auftragsordner) return null;
  const folderName = findMonteurFolderForFab(dmPath, fab);
  if (!folderName) return null;
  const root = path.join(dmPath, folderName, 'Montage', auftragsordner);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  return { root, folderName, montageFolderName: auftragsordner };
}

function buildTedAnlageRelPath(fnFolder, relPath) {
  const fn = String(fnFolder || '').trim();
  const rel = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!fn || !rel || rel.includes('..')) return null;
  return path.posix.join('Dokumente_Anlage', fn, rel);
}

function resolveCanonicalProjekteNeuFolderName(dirNames, fab) {
  const hit = resolveCanonicalFolderFromDirList(dirNames, fab);
  if (hit) return hit;
  const digits = String(fab || '').replace(/\D/g, '');
  return digits || String(fab || '').trim() || null;
}

function normRelPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function buildOfflinePreviewTree(tree) {
  const out = [];
  for (const node of tree || []) {
    if (!node || typeof node !== 'object') continue;
    const type = String(node.type || 'dir').toLowerCase();
    const name = String(node.name || '').trim();
    if (!name) continue;
    const rel = normRelPath(node.rel || name);
    if (type === 'file') {
      out.push({
        name,
        rel,
        type: 'file',
        size: node.size != null ? Number(node.size) : null,
        is_ted: /^TED(\/|$)/i.test(rel),
      });
      continue;
    }
    out.push({
      name,
      rel,
      type: 'dir',
      is_ted: /^TED(\/|$)/i.test(rel),
      children: buildOfflinePreviewTree(node.children || []),
    });
  }
  return out;
}

module.exports = {
  sanitizeDienstreiseFolderPart,
  buildMonteurMontageFolderName,
  buildMonteurWorkRelPath,
  buildMonteurWorkAbsDir,
  isMonteurWorkRelPath,
  isBareFabFolderName,
  ensureAnlageFnDirs,
  ensureMonteurMontageDirs,
  removeLegacyMonteurAuftragsordnerTopLevel,
  removeStaleBareFabMonteurDirs,
  migrateBareFabAnlageDirs,
  collectReiseFnDirNames,
  pickNonBareCanonicalDirName,
  resolveFabMapLocal,
  mapServerManifestPathToLocalAnlageRel,
  mapServerManifestPathToLocalRel,
  getMonteurWorkRoot,
  buildTedAnlageRelPath,
  resolveCanonicalProjekteNeuFolderName,
  buildOfflinePreviewTree,
};
