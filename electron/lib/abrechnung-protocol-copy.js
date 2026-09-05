'use strict';

const fs = require('fs');
const path = require('path');
const { applyBelegPrefix, stripKnownBelegPrefix } = require('./abrechnung-php-local');
const { isMontageberichtExportName } = require('./protocol-pdf-names');

function isIgnorableName(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || n.startsWith('.')) return true;
  const lower = n.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store';
}

function isMontageberichtSourceName(name) {
  return isMontageberichtExportName(name);
}

function isArbeitsnachweisSourceRel(rel, name) {
  if (!/\.(pdf|docx)$/i.test(String(name || ''))) return false;
  const r = String(rel || '').replace(/\\/g, '/');
  return /(?:^|\/)Arbeitsnachweise(?:\/|$)/i.test(r);
}

function abrechnungStemKey(filename) {
  let base = path.basename(String(filename || ''), path.extname(String(filename || '')));
  base = stripKnownBelegPrefix(base);
  return base.toLowerCase().trim();
}

function walkFiles(absDir, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (isIgnorableName(e.name)) continue;
    const full = path.join(absDir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) walkFiles(full, rel, out);
    else if (e.isFile()) out.push({ abs: full, rel, name: e.name });
  }
}

function destHasStem(targetDir, stemKey) {
  if (!stemKey || !targetDir || !fs.existsSync(targetDir)) return false;
  let names;
  try {
    names = fs.readdirSync(targetDir);
  } catch (_) {
    return false;
  }
  for (const name of names) {
    if (isIgnorableName(name)) continue;
    const full = path.join(targetDir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch (_) {
      continue;
    }
    if (abrechnungStemKey(name) === stemKey) return true;
  }
  return false;
}

function uniqueStoredName(targetDir, stored) {
  const ext = path.extname(stored);
  const baseName = ext ? stored.slice(0, -ext.length) : stored;
  let candidate = stored;
  let counter = 1;
  while (targetDir && fs.existsSync(path.join(targetDir, candidate))) {
    candidate = `${baseName}-${counter}${ext}`;
    counter += 1;
    if (counter > 999) break;
  }
  return candidate;
}

/**
 * Kopiert Arbeitsnachweis- und Montagebericht-Dateien nach Dokumente_Dispo
 * mit Abrechnungs-Prefix. Quelle bleibt in Dokumente_Monteur.
 *
 * @param {string} reiseDir
 * @returns {Array<{destRel:string,destAbs:string,storedName:string,prefix:string,origName:string}>}
 */
function copyProtocolsToLocalAbrechnung(reiseDir) {
  const copied = [];
  if (!reiseDir || !fs.existsSync(reiseDir)) return copied;
  const monteurRoot = path.join(reiseDir, 'Dokumente_Monteur');
  const targetDir = path.join(reiseDir, 'Dokumente_Dispo');
  const found = [];
  if (fs.existsSync(monteurRoot)) {
    walkFiles(monteurRoot, 'Dokumente_Monteur', found);
  }
  const sources = [];
  const seen = new Set();
  for (const f of found) {
    let prefix = '';
    if (isArbeitsnachweisSourceRel(f.rel, f.name)) prefix = 'Arbeitsnachweis';
    else if (isMontageberichtSourceName(f.name)) prefix = 'Montagebericht';
    if (!prefix) continue;
    let size = 0;
    try {
      size = fs.statSync(f.abs).size;
    } catch (_) {
      continue;
    }
    const key = `${prefix}|${abrechnungStemKey(f.name)}|${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ abs: f.abs, name: f.name, prefix, size });
  }
  if (!sources.length) return copied;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  for (const src of sources) {
    const stemKey = abrechnungStemKey(src.name);
    if (destHasStem(targetDir, stemKey)) continue;
    const stored = uniqueStoredName(targetDir, applyBelegPrefix(src.name, src.prefix));
    const destAbs = path.join(targetDir, stored);
    try {
      fs.copyFileSync(src.abs, destAbs);
    } catch (e) {
      console.warn('[abrechnung-protocol-copy] copy failed:', src.abs, e && e.message ? e.message : e);
      continue;
    }
    copied.push({
      destRel: 'Dokumente_Dispo/' + stored,
      destAbs,
      storedName: stored,
      prefix: src.prefix,
      origName: src.name,
    });
  }
  return copied;
}

module.exports = {
  isMontageberichtSourceName,
  isArbeitsnachweisSourceRel,
  abrechnungStemKey,
  copyProtocolsToLocalAbrechnung,
};
