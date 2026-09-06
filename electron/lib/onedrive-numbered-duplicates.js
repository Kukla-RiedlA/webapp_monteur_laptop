'use strict';

const fs = require('fs');
const path = require('path');

/** OneDrive/Windows „Keep both“: Datei.pdf → Datei-1.pdf (Zahl direkt vor der Endung). */
const NUMBERED_COPY_RE = /^(.*)-(\d{1,2})(\.[^.]+)$/i;

function parseOnedriveNumberedCopy(name) {
  const n = String(name || '');
  const m = n.match(NUMBERED_COPY_RE);
  if (!m) return null;
  return { stem: m[1], n: parseInt(m[2], 10), ext: m[3], canonical: m[1] + m[3] };
}

function stripOnedriveCopySuffix(name) {
  const parsed = parseOnedriveNumberedCopy(name);
  return parsed ? parsed.canonical : String(name || '');
}

function isOnedriveNumberedCopyName(name) {
  return !!parseOnedriveNumberedCopy(name);
}

function fileNameSet(names) {
  const set = new Set();
  for (const n of names || []) set.add(String(n));
  for (const n of names || []) set.add(String(n).toLowerCase());
  return set;
}

function hasName(set, name) {
  const n = String(name || '');
  return set.has(n) || set.has(n.toLowerCase());
}

function unlinkQuietFile(abs) {
  try {
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.unlinkSync(abs);
    return true;
  } catch (_) {
    return false;
  }
}

function renameQuietFile(src, dst) {
  try {
    if (!src || !dst || src === dst) return false;
    if (!fs.existsSync(src)) return false;
    fs.renameSync(src, dst);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Entfernt OneDrive-Kopien `-1`/`-2` im Ordner, sobald die kanonische Datei existiert.
 * Liegt nur die nummerierte Kopie vor, wird sie auf den Originalnamen zurückbenannt.
 * @param {string} dir
 * @returns {string[]} entfernte oder umbenannte Dateinamen
 */
function sweepOnedriveNumberedDuplicates(dir) {
  const changed = [];
  if (!dir || !fs.existsSync(dir)) return changed;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return changed;
  }
  const set = fileNameSet(names);
  const numbered = [];
  for (const name of names) {
    const parsed = parseOnedriveNumberedCopy(name);
    if (!parsed) continue;
    numbered.push({ name, parsed });
  }
  numbered.sort((a, b) => a.parsed.n - b.parsed.n);

  const byStem = new Map();
  for (const item of numbered) {
    const key = item.parsed.stem.toLowerCase() + '\0' + item.parsed.ext.toLowerCase();
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key).push(item);
  }

  for (const group of byStem.values()) {
    const first = group[0];
    const canonical = first.parsed.canonical;
    const langDe = first.parsed.stem + '_DE' + first.parsed.ext;
    const langGb = first.parsed.stem + '_GB' + first.parsed.ext;
    const canonicalExists = hasName(set, canonical);
    const langExists = hasName(set, langDe) || hasName(set, langGb);

    if (canonicalExists || langExists) {
      for (const item of group) {
        if (unlinkQuietFile(path.join(dir, item.name))) {
          changed.push(item.name);
          set.delete(item.name);
          set.delete(item.name.toLowerCase());
        }
      }
      continue;
    }

    const restore = group[0];
    const dest = path.join(dir, canonical);
    if (renameQuietFile(path.join(dir, restore.name), dest)) {
      changed.push(restore.name + '->' + canonical);
      set.add(canonical);
      set.add(canonical.toLowerCase());
      set.delete(restore.name);
      set.delete(restore.name.toLowerCase());
    }
    for (const item of group.slice(1)) {
      if (unlinkQuietFile(path.join(dir, item.name))) {
        changed.push(item.name);
        set.delete(item.name);
        set.delete(item.name.toLowerCase());
      }
    }
  }
  return changed;
}

function sweepOnedriveNumberedDuplicatesTree(rootDir) {
  const changed = [];
  if (!rootDir || !fs.existsSync(rootDir)) return changed;
  changed.push(...sweepOnedriveNumberedDuplicates(rootDir));
  let names;
  try {
    names = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return changed;
  }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const n = String(ent.name || '');
    if (!n || n === '.' || n === '..' || n.startsWith('.')) continue;
    changed.push(...sweepOnedriveNumberedDuplicatesTree(path.join(rootDir, n)));
  }
  return changed;
}

module.exports = {
  parseOnedriveNumberedCopy,
  stripOnedriveCopySuffix,
  isOnedriveNumberedCopyName,
  sweepOnedriveNumberedDuplicates,
  sweepOnedriveNumberedDuplicatesTree,
};
