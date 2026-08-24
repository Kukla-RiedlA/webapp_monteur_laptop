'use strict';

const fs = require('fs');
const path = require('path');
const {
  findMonteurFolderForFab,
  resolveCanonicalFolderFromDirList,
  isIgnorableDirEntry,
  isFnFolderAlias,
  isRangeFnFolderName,
  collectExactFnFolderMatches,
  folderNameMatchesFab,
  isDatePrefixedProjectFolderName,
  parseFnRangeFromFolderName,
  parseFabNumber,
  uniqueSortedNumericFabs,
  consecutiveNumericFabRuns,
} = require('./projekte-neu-local');
const { isMonteurDraftJsonBasename } = require('./multi-device-sync');

function sanitizeDienstreiseFolderPart(str, maxLen) {
  if (typeof str !== 'string') return '';
  const limit = Number.isFinite(maxLen) && maxLen > 8 ? Math.floor(maxLen) : 48;
  // Acrobat/Explorer scheitern oft still an Bullet/Sonderzeichen im Pfad (z. B. U+2022 „•“).
  // Zusätzlich Segmente kürzen: OneDrive-Pfade mit Firma+Ort+FN überschreiten sonst leicht MAX_PATH (~260).
  // Erlaubt: ASCII [A-Za-z0-9_] + DE-Umlaute — bewusst kein \w/\u (ņ/ū würden sonst bleiben
  // und vom Dispo-PHP divergieren → Doppelordner Transfer/Montage). Parität: job_project_sanitize_monteur_folder_part.
  let s = str
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF\u00B7\u2024\u2027\u2218•▪◦●∙·]/g, '-')
    .replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9_\-.,()ÄÖÜäöüß+&]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\-]+|[_.\-]+$/g, '')
    .replace(/\s+/g, '_')
    .trim();
  if (s.length > limit) {
    s = s.slice(0, limit).replace(/[_.\-]+$/g, '');
  }
  return s || 'x';
}

/**
 * Sanitize für PROJEKTE-NEU-Fallback: Leerzeichen und & bleiben.
 * Nur Windows-ungültige Zeichen / Steuerzeichen entfernen.
 */
function sanitizeFnProjekteFolderPart(str, maxLen) {
  if (typeof str !== 'string') return '';
  const limit = Number.isFinite(maxLen) && maxLen > 8 ? Math.floor(maxLen) : 80;
  let s = str
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF\u00B7\u2024\u2027\u2218•▪◦●∙·]/g, '-')
    .replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[ \t._-]+|[ \t._-]+$/g, '')
    .trim();
  if (s.length > limit) {
    s = s.slice(0, limit).replace(/[ \t._-]+$/g, '');
  }
  return s;
}

/**
 * Fallback-Ordnername wenn FN noch nicht unter PROJEKTE NEU:
 * FN_Kundenname_Ort_Länderkürzel, bei zusammenhängenden neuen FNs desselben Auftrags
 * „500 - 501_Kunde_Ort_LK“ (Parität Dispo).
 * @param {{ fab?: string|number, range_from?: number, range_to?: number, customer_name?: string, city?: string, country?: string }} meta
 */
function buildFnProjectFolderName(meta) {
  const rangeFrom = meta && meta.range_from != null ? Number(meta.range_from) : null;
  const rangeTo = meta && meta.range_to != null ? Number(meta.range_to) : null;
  let fnLabel = String(meta && meta.fab != null ? meta.fab : '').trim();
  if (Number.isFinite(rangeFrom) && Number.isFinite(rangeTo) && rangeFrom !== rangeTo) {
    const lo = Math.min(rangeFrom, rangeTo);
    const hi = Math.max(rangeFrom, rangeTo);
    fnLabel = lo + ' - ' + hi;
  }
  if (!fnLabel) return '';
  const parts = [fnLabel];
  const firm = sanitizeFnProjekteFolderPart(meta && meta.customer_name ? meta.customer_name : '');
  if (firm) parts.push(firm);
  const ort = sanitizeFnProjekteFolderPart(meta && meta.city ? meta.city : '', 48);
  if (ort) parts.push(ort);
  const lkRaw = String(meta && meta.country != null ? meta.country : '').trim();
  const lk = sanitizeFnProjekteFolderPart(lkRaw ? lkRaw.slice(0, 2).toUpperCase() : '', 8);
  if (lk) parts.push(lk);
  return parts.join('_');
}

/**
 * Dateiname für PDF/DOCX: gleiche Regeln, zusätzlich Endung schützen.
 * Kurzer Base-Name, damit Montage-PDFs unter langen Reiseordnern Acrobat öffnen können.
 */
function sanitizeExportFileBase(str) {
  const base = String(str || '')
    .replace(/\.pdf$/i, '')
    .replace(/\.docx$/i, '');
  return sanitizeDienstreiseFolderPart(base, 72) || 'Dokument';
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

function isNonBareFnFolderName(name) {
  const s = String(name || '').trim();
  return !!s && !isBareFabFolderName(s);
}

function isUsableFnHauptordnerName(name, fab) {
  const n = String(name || '').trim();
  if (!n || isDatePrefixedProjectFolderName(n)) return false;
  if (fab && !folderNameMatchesFab(n, fab)) return false;
  return true;
}

/**
 * Ein Ordner je FN: Fileserver-Name (Leerzeichen) vor Dispo-Unterstrich-Variante.
 * Datums-Unterordner (30-2020-07-25_…) werden nicht als Hauptordner verwendet.
 * @param {string[]} matches
 * @param {{ fab?: string|number, cache?: string, built?: string, existing?: string }} [hints]
 */
function pickPreferredFnFolderName(matches, hints) {
  const fab = String((hints && hints.fab) || '').trim();
  const cache = String((hints && hints.cache) || '').trim();
  const built = String((hints && hints.built) || '').trim();
  const existing = String((hints && hints.existing) || '').trim();
  const singleFb = String((hints && hints.single_fallback) || '').trim();
  const list = (matches || []).map((n) => String(n || '').trim()).filter((n) => isUsableFnHauptordnerName(n, fab));
  const builtRange = parseFnRangeFromFolderName(built);
  const builtIsMultiRange = !!(builtRange && builtRange.from !== builtRange.to);
  function isGeneratedSingle(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (fab && (n === fab || isBareFabFolderName(n))) return true;
    return !!(singleFb && isFnFolderAlias(n, singleFb));
  }
  const cacheUsable = isUsableFnHauptordnerName(cache, fab) && isNonBareFnFolderName(cache);
  if (cacheUsable && !(isGeneratedSingle(cache) && builtIsMultiRange)) return cache;
  const spaceMatch = list.find((n) => /\s/.test(n) && isNonBareFnFolderName(n) && !isGeneratedSingle(n));
  if (spaceMatch) return spaceMatch;
  const existingRange = parseFnRangeFromFolderName(existing);
  const existingIsMultiRange = !!(existingRange && existingRange.from !== existingRange.to);
  if (
    existingIsMultiRange &&
    isUsableFnHauptordnerName(existing, fab) &&
    isNonBareFnFolderName(existing) &&
    !(isGeneratedSingle(existing) && builtIsMultiRange)
  ) {
    return existing;
  }
  if (isUsableFnHauptordnerName(built, fab) && isNonBareFnFolderName(built)) return built;
  if (isUsableFnHauptordnerName(existing, fab) && isNonBareFnFolderName(existing) && !(isGeneratedSingle(existing) && builtIsMultiRange)) {
    return existing;
  }
  const nonBareMatch = list.find((n) => isNonBareFnFolderName(n));
  if (nonBareMatch) return nonBareMatch;
  return list[0] || (isUsableFnHauptordnerName(built, fab) ? built : '') || '';
}

function leadingFabDigits(name) {
  const m = String(name || '').trim().match(/^(\d+)/);
  return m ? m[1] : '';
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
 * @param {{ customer_name?: string, city?: string, country?: string }|null} [jobMeta]
 */
function resolveFabMapLocal(reiseDir, fabMapIn, jobFabNums, readRootFolderName, jobMeta) {
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
  const meta = jobMeta && typeof jobMeta === 'object' ? jobMeta : null;
  const metaParts = {
    customer_name: meta && meta.customer_name,
    city: meta && meta.city,
    country: meta && meta.country,
  };
  const perFab = new Map();
  const needsNewNums = new Set();
  for (const fab of fabNums) {
    const existing = byFab.get(fab);
    const existingCanonical =
      existing && existing.folder_name_canonical != null
        ? String(existing.folder_name_canonical).trim()
        : '';
    const fromCache =
      typeof readRootFolderName === 'function'
        ? String(readRootFolderName(fab) || '').trim()
        : '';
    const fromDirs =
      pickNonBareCanonicalDirName(dirNames, fab) ||
      resolveCanonicalProjekteNeuFolderName(dirNames, fab) ||
      '';
    const diskMatches = collectExactFnFolderMatches(dirNames, fab);
    const singleBuilt = buildFnProjectFolderName(Object.assign({ fab }, metaParts));
    const n = parseFabNumber(fab);
    const candidates = [fromCache, fromDirs, existingCanonical].concat(diskMatches);
    let hasReal = false;
    for (const name of candidates) {
      const nm = String(name || '').trim();
      if (!nm || !isUsableFnHauptordnerName(nm, fab) || isBareFabFolderName(nm)) continue;
      if (isFnFolderAlias(nm, singleBuilt) || nm === fab) continue;
      hasReal = true;
      break;
    }
    if (n != null && !hasReal) needsNewNums.add(n);
    perFab.set(fab, {
      existingCanonical,
      fromCache,
      fromDirs,
      diskMatches,
      singleBuilt,
      n,
    });
  }
  const newItems = uniqueSortedNumericFabs(fabNums).filter((it) => needsNewNums.has(it.n));
  const runByN = new Map();
  for (const run of consecutiveNumericFabRuns(newItems)) {
    for (const it of run) runByN.set(it.n, run);
  }
  for (const fab of fabNums) {
    const info = perFab.get(fab);
    const run = info && info.n != null ? runByN.get(info.n) : null;
    let built = info ? info.singleBuilt : buildFnProjectFolderName(Object.assign({ fab }, metaParts));
    if (run && run.length >= 2) {
      built = buildFnProjectFolderName(
        Object.assign(
          {
            fab,
            range_from: run[0].n,
            range_to: run[run.length - 1].n,
          },
          metaParts,
        ),
      );
    }
    let folder_name_canonical = pickPreferredFnFolderName(info ? info.diskMatches : [], {
      fab,
      cache: info ? info.fromCache : '',
      built,
      existing: info ? info.existingCanonical || info.fromDirs : '',
      single_fallback: info ? info.singleBuilt : '',
    });
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
 * Führt Leerzeichen- und Unterstrich-Varianten derselben FN in den kanonischen Ordner zusammen.
 */
function migrateAliasFnFoldersUnder(reiseDir, subfolder, fabFolderEntries) {
  const base = path.join(reiseDir, subfolder);
  if (!fs.existsSync(base)) return;
  const dirNames = listSubdirNames(base);
  for (const entry of fabFolderEntries || []) {
    const fab = String(entry.fab || '').trim();
    const can = String(entry.folder_name_canonical || '').trim();
    if (!fab) continue;
    const matches = collectExactFnFolderMatches(dirNames, fab);
    const preferred = can || pickPreferredFnFolderName(matches, {});
    if (!preferred) continue;
    const target = path.join(base, preferred);
    for (const name of matches) {
      if (name === preferred) continue;
      const stale = path.join(base, name);
      if (!fs.existsSync(stale)) continue;
      try {
        if (!fs.existsSync(target)) {
          fs.renameSync(stale, target);
        } else {
          mergeDirContentsInto(stale, target);
          fs.rmSync(stale, { recursive: true, force: true });
        }
        console.warn('[monteur-paths] FN-Alias zusammengeführt', subfolder, name, '->', preferred);
      } catch (err) {
        console.warn(
          '[monteur-paths] FN-Alias-Migration',
          subfolder,
          name,
          '->',
          preferred,
          err && err.message ? err.message : err,
        );
      }
    }
  }
}

function migrateAliasFnFolders(reiseDir, fabFolderEntries) {
  migrateAliasFnFoldersUnder(reiseDir, 'Dokumente_Monteur', fabFolderEntries);
  migrateAliasFnFoldersUnder(reiseDir, 'Dokumente_Anlage', fabFolderEntries);
}

/**
 * Zieht Manifest-Pfade auf den kanonischen FN-Ordner (Leerzeichen- vs. Unterstrich-Alias).
 * @param {string} relPath
 * @param {Array<{ fab?: string|number, folder_name_canonical?: string }>} [fabMap]
 */
function rewriteFnFolderSegmentInRel(relPath, fabMap) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 2) return norm;
  if (parts[0] !== 'Dokumente_Monteur' && parts[0] !== 'Dokumente_Anlage') return norm;
  const fnFolder = parts[1];
  if (!fnFolder || isRangeFnFolderName(fnFolder)) return norm;
  const fabDigits = leadingFabDigits(fnFolder);
  for (const entry of fabMap || []) {
    const can = String(entry.folder_name_canonical || '').trim();
    const fab = String(entry.fab || '').trim();
    if (!can) continue;
    if (fnFolder === can || isFnFolderAlias(fnFolder, can)) {
      parts[1] = can;
      return parts.join('/');
    }
    const entryDigits = String(fab).replace(/\D/g, '');
    if (fabDigits && entryDigits && fabDigits === entryDigits && !isRangeFnFolderName(fnFolder)) {
      parts[1] = can;
      return parts.join('/');
    }
  }
  return norm;
}

/**
 * @param {string} reiseDir
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabFolderEntries
 */
function ensureAnlageFnDirs(reiseDir, fabFolderEntries) {
  migrateAliasFnFolders(reiseDir, fabFolderEntries);
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
 * Vor mkdir: Geschwister derselben Identität (Datum+Monteur) bzw. previousName → Desired umbenennen/mergen.
 *
 * @param {string} reiseDir
 * @param {Array<{ fab: string|number, folder_name_canonical: string }>} fabFolderEntries
 * @param {string} auftragsordner Desired-Name
 * @param {{ technicianDisplayName?: string, previousName?: string|null }} [opts]
 */
function ensureMonteurMontageDirs(reiseDir, fabFolderEntries, auftragsordner, opts) {
  alignMonteurMontageDirs(reiseDir, fabFolderEntries, auftragsordner, opts);
}

/**
 * @param {string} name
 * @param {string} desired
 * @param {string} datePrefix e.g. 2026-07-22_
 * @param {string} monteurSuffix e.g. _Riedl_Alois
 */
function isMonteurMontageIdentitySibling(name, desired, datePrefix, monteurSuffix) {
  const n = String(name || '').trim();
  const d = String(desired || '').trim();
  if (!n || n === d) return false;
  if (datePrefix && !n.startsWith(datePrefix)) return false;
  if (monteurSuffix && !n.endsWith(monteurSuffix)) return false;
  return true;
}

/**
 * Bestehende Auftragsordner umbenennen/mergen statt neu anzulegen.
 * @returns {string} Desired-Name
 */
function alignMonteurMontageDirs(reiseDir, fabFolderEntries, desiredName, opts) {
  migrateAliasFnFolders(reiseDir, fabFolderEntries);
  const desired = String(desiredName || '').trim();
  const monteurBase = path.join(reiseDir, 'Dokumente_Monteur');
  if (!fs.existsSync(monteurBase)) fs.mkdirSync(monteurBase, { recursive: true });
  if (!desired) return desired;

  const techName = opts && opts.technicianDisplayName != null ? String(opts.technicianDisplayName) : '';
  const previousName = opts && opts.previousName != null ? String(opts.previousName).trim() : '';
  const monteurPart = sanitizeDienstreiseFolderPart(techName || 'Monteur') || 'Monteur';
  const monteurSuffix = '_' + monteurPart;
  const dateMatch = desired.match(/^(\d{4}-\d{2}-\d{2})_/);
  const datePrefix = dateMatch ? dateMatch[1] + '_' : '';

  const fnFolders = new Set();
  const canonicals = [];
  for (const entry of fabFolderEntries || []) {
    const fnFolder = String(entry.folder_name_canonical || '').trim();
    if (fnFolder) {
      fnFolders.add(fnFolder);
      canonicals.push(fnFolder);
    }
  }
  // Bestehende FN-Ordner ohne fab_map (keine Alias eines kanonischen Namens).
  for (const name of listSubdirNames(monteurBase)) {
    if (canonicals.some((c) => c === name || isFnFolderAlias(c, name))) continue;
    fnFolders.add(name);
  }

  for (const fnFolder of fnFolders) {
    const montageDir = path.join(monteurBase, fnFolder, 'Montage');
    if (!fs.existsSync(montageDir)) {
      fs.mkdirSync(montageDir, { recursive: true });
    }
    let children = [];
    try {
      children = fs
        .readdirSync(montageDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !isIgnorableDirEntry(e.name))
        .map((e) => e.name);
    } catch (_) {
      children = [];
    }
    const candidates = [];
    for (const child of children) {
      if (child === desired) continue;
      if (previousName && child === previousName) {
        candidates.push(child);
        continue;
      }
      if (isMonteurMontageIdentitySibling(child, desired, datePrefix, monteurSuffix)) {
        candidates.push(child);
      }
    }
    const desiredPath = path.join(montageDir, desired);
    for (const oldName of candidates) {
      const oldPath = path.join(montageDir, oldName);
      if (!fs.existsSync(oldPath)) continue;
      try {
        if (!fs.existsSync(desiredPath)) {
          fs.renameSync(oldPath, desiredPath);
        } else {
          mergeDirContentsInto(oldPath, desiredPath);
          fs.rmSync(oldPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn(
          '[monteur-paths] Auftragsordner-Align',
          oldName,
          '->',
          desired,
          err && err.message ? err.message : err,
        );
      }
    }
    if (!fs.existsSync(desiredPath)) {
      try {
        fs.mkdirSync(desiredPath, { recursive: true });
      } catch (err) {
        console.warn(
          '[monteur-paths] mkdir Auftragsordner',
          desiredPath,
          err && err.message ? err.message : err,
        );
      }
    }
    const bilderPath = path.join(desiredPath, 'Bilder');
    if (!fs.existsSync(bilderPath)) {
      try {
        fs.mkdirSync(bilderPath, { recursive: true });
      } catch (err) {
        console.warn(
          '[monteur-paths] mkdir Bilder',
          bilderPath,
          err && err.message ? err.message : err,
        );
      }
    }
    for (const sub of ['Parameter', 'Protokolle']) {
      const subPath = path.join(desiredPath, sub);
      if (!fs.existsSync(subPath)) {
        try {
          fs.mkdirSync(subPath, { recursive: true });
        } catch (err) {
          console.warn(
            '[monteur-paths] mkdir ' + sub,
            subPath,
            err && err.message ? err.message : err,
          );
        }
      }
    }
  }
  return desired;
}

/**
 * PWA-/Monteur-Fotos und Montage-Arbeitsordner bleiben unter Dokumente_Monteur
 * (nicht nach Dokumente_Anlage spiegeln).
 */
function isDokumenteMonteurKeepLocalRel(normPath) {
  const norm = String(normPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const prefix = 'Dokumente_Monteur/';
  if (!norm.startsWith(prefix)) return false;
  const tail = norm.slice(prefix.length);
  if (tail === 'Bilder' || tail.startsWith('Bilder/')) return true;
  // …/<FN|Parent>/Montage/<Auftrag>/… (inkl. …/Bilder/)
  if (/^[^/]+\/Montage(\/|$)/i.test(tail)) return true;
  // ohne FN: Bilddatei direkt unter Dokumente_Monteur/
  if (/^[^/]+\.(jpe?g|png|webp)$/i.test(tail)) return true;
  // Protokoll-Zwischenstände: flach unter Dokumente_Monteur/{name}.json — nicht nach Anlage spiegeln.
  if (tail.indexOf('/') < 0 && isMonteurDraftJsonBasename(tail)) return true;
  return false;
}

/**
 * Server-Manifest: Dokumente_Monteur/<FN>/… → lokales Spiegel-Layout unter Dokumente_Anlage.
 * Ausnahme: Fotos/Montage bleiben unter Dokumente_Monteur.
 */
function mapServerManifestPathToLocalAnlageRel(serverRelPath, fabMap) {
  const norm = String(serverRelPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const prefix = 'Dokumente_Monteur/';
  const mapped = !norm.startsWith(prefix)
    ? norm
    : isDokumenteMonteurKeepLocalRel(norm)
      ? norm
      : 'Dokumente_Anlage/' + norm.slice(prefix.length);
  return rewriteFnFolderSegmentInRel(mapped, fabMap);
}

/** @deprecated Alias — Downloads gehören nach Dokumente_Anlage. */
function mapServerManifestPathToLocalRel(serverRelPath, fabMap) {
  return mapServerManifestPathToLocalAnlageRel(serverRelPath, fabMap);
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

function resolveOfflinePreviewNodeRel(node, parentRel) {
  const name = String(node && node.name != null ? node.name : '').trim();
  const parent = normRelPath(parentRel);
  const raw = normRelPath(node && node.rel != null ? node.rel : name);
  if (raw && raw.includes('/')) return raw;
  if (parent) return parent + '/' + (raw || name);
  return raw || name;
}

function buildOfflinePreviewTree(tree, parentRel) {
  const out = [];
  for (const node of tree || []) {
    if (!node || typeof node !== 'object') continue;
    const type = String(node.type || 'dir').toLowerCase();
    const name = String(node.name || '').trim();
    if (!name) continue;
    const rel = resolveOfflinePreviewNodeRel(node, parentRel);
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
      children: buildOfflinePreviewTree(node.children || [], rel),
    });
  }
  return out;
}

module.exports = {
  sanitizeDienstreiseFolderPart,
  sanitizeFnProjekteFolderPart,
  sanitizeExportFileBase,
  buildFnProjectFolderName,
  buildMonteurMontageFolderName,
  buildMonteurWorkRelPath,
  buildMonteurWorkAbsDir,
  isMonteurWorkRelPath,
  isBareFabFolderName,
  ensureAnlageFnDirs,
  ensureMonteurMontageDirs,
  alignMonteurMontageDirs,
  isMonteurMontageIdentitySibling,
  removeLegacyMonteurAuftragsordnerTopLevel,
  removeStaleBareFabMonteurDirs,
  migrateBareFabAnlageDirs,
  collectReiseFnDirNames,
  pickNonBareCanonicalDirName,
  resolveFabMapLocal,
  migrateAliasFnFolders,
  rewriteFnFolderSegmentInRel,
  isFnFolderAlias,
  isDokumenteMonteurKeepLocalRel,
  mapServerManifestPathToLocalAnlageRel,
  mapServerManifestPathToLocalRel,
  getMonteurWorkRoot,
  buildTedAnlageRelPath,
  resolveCanonicalProjekteNeuFolderName,
  buildOfflinePreviewTree,
};
