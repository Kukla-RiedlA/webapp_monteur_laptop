'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KUNDEN_DOC_FOLDER = 'Kunden Dokumentation';
const DOC_EXTS = new Set(['.pdf', '.csv', '.pa', '.txt']);
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const LEGACY_DOC_RE =
  /^(Serviceprotokoll_|Service_protocol_|Inbetriebnahmeprotokoll_|Commissioning_report_|Kontrollwiegungsprotokoll_|Calibration_protocol_|Schleppketten_Test_|Chain_calibration_|Pruefzertifikat_|Inspection_certificate_|Montage_Bericht_|Assembly_report_|.*_Montage_DE|.*_Assembly_report_GB|.*_report_GB)/i;

const { isMontageberichtExportName } = require('./protocol-pdf-names');

function isIgnorableName(name) {
  const n = String(name || '');
  return !n || n === '.' || n === '..' || n.startsWith('.') || n === 'Thumbs.db' || n === 'desktop.ini';
}

function safeFabPrefix(fab) {
  const s = String(fab || '')
    .trim()
    .replace(/[^\w.-]+/g, '_');
  return s || 'ohneFN';
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

function targetNameForItem(item) {
  const original = path.basename(String(item.name || item.absPath || 'datei'));
  if (item.kind === 'photo') {
    const fab = safeFabPrefix(item.fab);
    if (original.toLowerCase().startsWith(fab.toLowerCase() + '_')) return original;
    return fab + '_' + original;
  }
  return original;
}

function listDirFiles(dir, exts) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return out;
  }
  for (const name of names) {
    if (isIgnorableName(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (exts && !exts.has(ext)) continue;
    out.push({ name, full, size: st.size, mtime: st.mtime ? st.mtime.toISOString() : null });
  }
  return out;
}

function isMontageberichtName(name) {
  return isMontageberichtExportName(name);
}

function classifyDocumentType(name) {
  const n = String(name || '');
  if (/^Serviceprotokoll_/i.test(n) || /^Service_protocol_/i.test(n)) return 'Serviceprotokoll';
  if (/^Inbetriebnahmeprotokoll_/i.test(n) || /^Commissioning_report_/i.test(n)) return 'Inbetriebnahme Protokoll';
  if (/^Kontrollwiegungsprotokoll_/i.test(n) || /^Calibration_protocol_/i.test(n)) return 'Kontrollwiegung';
  if (/^Schleppketten_Test_/i.test(n) || /^Chain_calibration_/i.test(n)) return 'Schleppketten-Test';
  if (/^Pruefzertifikat_/i.test(n) || /^Inspection_certificate_/i.test(n)) return 'Prüfzertifikat';
  if (isMontageberichtName(n)) return 'Montagebericht';
  if (/\.csv$/i.test(n)) return 'Parameter CSV';
  if (/\.pa$/i.test(n)) return 'Parameter PA';
  if (/\.txt$/i.test(n)) return 'Textdatei';
  if (/\.pdf$/i.test(n)) return 'Parameter / Protokoll PDF';
  return 'Dokument';
}

/**
 * Montagebericht gilt für den ganzen Auftrag (alle FN) – nur einmal listen, auch wenn
 * die Datei unter mehreren FN-Ordnern liegt.
 */
function dedupeMontageberichtDocuments(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const seenNames = new Set();
  const out = [];
  for (const doc of list) {
    const type = doc && doc.type ? String(doc.type) : classifyDocumentType(doc && doc.name);
    if (type === 'Montagebericht' || isMontageberichtName(doc && doc.name)) {
      const key = String(doc.name || '')
        .trim()
        .toLowerCase();
      if (!key) continue;
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      out.push(Object.assign({}, doc, { type: 'Montagebericht', fab: '' }));
      continue;
    }
    out.push(doc);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.reiseDir
 * @param {string[]} opts.fabs
 * @param {(fab: string) => { folderName: string, montageFolderName: string, protokolleDir: string, parameterDir: string, bilderDir: string, relBase: string } | null} opts.resolveFabDirs
 * @param {(relPath: string) => string} opts.previewUrlForRel
 */
function scanKundenDokumentation(opts) {
  const reiseDir = opts && opts.reiseDir ? String(opts.reiseDir) : '';
  const fabs = Array.isArray(opts && opts.fabs) ? opts.fabs : [];
  const resolveFabDirs = opts && opts.resolveFabDirs;
  const previewUrlForRel = opts && opts.previewUrlForRel;
  const documents = [];
  const photos = [];
  const seenAbs = new Set();

  function pushDoc(entry, fab, kindHint) {
    const abs = path.resolve(entry.full);
    if (seenAbs.has(abs)) return;
    seenAbs.add(abs);
    const rel = path
      .relative(reiseDir, abs)
      .split(path.sep)
      .join('/');
    documents.push({
      id: 'doc:' + rel,
      kind: 'document',
      type: kindHint || classifyDocumentType(entry.name),
      name: entry.name,
      fab: fab || '',
      absPath: abs,
      relPath: rel,
      size: entry.size,
      mtime: entry.mtime,
    });
  }

  function pushPhoto(entry, fab) {
    const abs = path.resolve(entry.full);
    if (seenAbs.has(abs)) return;
    seenAbs.add(abs);
    const rel = path
      .relative(reiseDir, abs)
      .split(path.sep)
      .join('/');
    photos.push({
      id: 'photo:' + rel,
      kind: 'photo',
      type: 'Bild',
      name: entry.name,
      fab: fab || '',
      absPath: abs,
      relPath: rel,
      size: entry.size,
      mtime: entry.mtime,
      previewUrl:
        typeof previewUrlForRel === 'function'
          ? previewUrlForRel(rel)
          : '/api/dienstreise/project_file?path=' + encodeURIComponent(rel) + '&thumb=1&inline=1',
    });
  }

  for (const fab of fabs) {
    if (!fab || typeof resolveFabDirs !== 'function') continue;
    let dirs = null;
    try {
      dirs = resolveFabDirs(String(fab));
    } catch (_) {
      dirs = null;
    }
    if (!dirs) continue;
    listDirFiles(dirs.protokolleDir, DOC_EXTS).forEach((e) => pushDoc(e, fab));
    listDirFiles(dirs.parameterDir, DOC_EXTS).forEach((e) => pushDoc(e, fab));
    listDirFiles(dirs.bilderDir, IMG_EXTS).forEach((e) => pushPhoto(e, fab));
  }

  // Legacy: flache Docs unter Dokumente_Monteur
  const docMonteur = path.join(reiseDir, 'Dokumente_Monteur');
  if (fs.existsSync(docMonteur)) {
    listDirFiles(docMonteur, DOC_EXTS).forEach((e) => {
      if (!LEGACY_DOC_RE.test(e.name) && !/\.(csv|pa|txt)$/i.test(e.name)) return;
      pushDoc(e, '', classifyDocumentType(e.name));
    });
  }

  const documentsDeduped = dedupeMontageberichtDocuments(documents);
  documentsDeduped.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')) || a.name.localeCompare(b.name, 'de'));
  photos.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')) || a.name.localeCompare(b.name, 'de'));

  return { documents: documentsDeduped, photos, targetRel: 'Dokumente_Monteur/' + KUNDEN_DOC_FOLDER };
}

function ensureKundenDocDir(reiseDir) {
  const targetDir = path.join(reiseDir, 'Dokumente_Monteur', KUNDEN_DOC_FOLDER);
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function assertPathUnderReise(reiseDir, absPath) {
  const root = path.resolve(reiseDir);
  const full = path.resolve(absPath);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Pfad außerhalb des Reiseordners: ' + absPath);
  }
  return full;
}

/**
 * @param {object} opts
 * @param {string} opts.reiseDir
 * @param {Array<{ absPath: string, name?: string, kind?: string, fab?: string }>} opts.items
 */
function copyKundenDokumentationItems(opts) {
  const reiseDir = opts.reiseDir;
  const items = Array.isArray(opts.items) ? opts.items : [];
  const targetDir = ensureKundenDocDir(reiseDir);
  const copied = [];
  const errors = [];

  for (const item of items) {
    try {
      const src = assertPathUnderReise(reiseDir, item.absPath);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        errors.push({ path: item.absPath, error: 'Datei nicht gefunden' });
        continue;
      }
      const desired = targetNameForItem(item);
      const destName = uniqueTargetName(targetDir, desired);
      const dest = path.join(targetDir, destName);
      fs.copyFileSync(src, dest);
      copied.push({
        from: src,
        to: dest,
        name: destName,
        relPath: ('Dokumente_Monteur/' + KUNDEN_DOC_FOLDER + '/' + destName).replace(/\\/g, '/'),
        kind: item.kind || 'document',
      });
    } catch (err) {
      errors.push({ path: item.absPath, error: err && err.message ? err.message : String(err) });
    }
  }

  return {
    ok: errors.length === 0,
    targetDir,
    targetRel: 'Dokumente_Monteur/' + KUNDEN_DOC_FOLDER,
    copied,
    errors,
  };
}

function buildZipName(jobNumber) {
  const jn = String(jobNumber || 'Auftrag')
    .trim()
    .replace(/[^\w.-]+/g, '_') || 'Auftrag';
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return 'Kunden_Dokumentation_' + jn + '_' + y + m + day + '.zip';
}

function createZipFromCopied(targetDir, copiedFiles, jobNumber) {
  const zipName = uniqueTargetName(targetDir, buildZipName(jobNumber));
  const zipPath = path.join(targetDir, zipName);
  const staging = path.join(targetDir, '.zip_stage_' + Date.now());
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const c of copiedFiles) {
      const dest = path.join(staging, c.name);
      fs.copyFileSync(c.to, dest);
    }
    const ps = `
$ErrorActionPreference = 'Stop'
$src = ${JSON.stringify(staging + path.sep + '*')}
$dest = ${JSON.stringify(zipPath)}
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
Compress-Archive -Path $src -DestinationPath $dest -Force
`;
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, encoding: 'utf8', timeout: 120000 },
    );
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || 'Compress-Archive fehlgeschlagen').toString().trim();
      throw new Error(msg || 'ZIP-Erzeugung fehlgeschlagen');
    }
    if (!fs.existsSync(zipPath)) throw new Error('ZIP wurde nicht erzeugt');
    return { zipPath, zipName };
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

function escapePsSingleQuoted(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function copyAttachmentForOutlook(src) {
  const abs = path.resolve(String(src || ''));
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    const tmpDir = path.join(os.tmpdir(), 'kukla-outlook-attach');
    fs.mkdirSync(tmpDir, { recursive: true });
    const dest = path.join(tmpDir, Date.now() + '-' + path.basename(abs));
    fs.copyFileSync(abs, dest);
    return fs.existsSync(dest) ? dest : abs;
  } catch (_) {
    return abs;
  }
}

/**
 * Öffnet klassischen Outlook-Entwurf mit Empfängern und Anhängen.
 */
function openOutlookDraft(opts) {
  const recipients = Array.isArray(opts.recipients)
    ? opts.recipients.map((e) => String(e || '').trim()).filter(Boolean)
    : [];
  const attachments = Array.isArray(opts.attachments)
    ? opts.attachments.map((p) => copyAttachmentForOutlook(p)).filter(Boolean)
    : [];
  const subject = String(opts.subject || 'Kundendokumentation');
  const body = String(opts.body || '');
  const htmlBody = opts.htmlBody != null ? String(opts.htmlBody) : '';

  const recipList = recipients.map((e) => "'" + escapePsSingleQuoted(e) + "'").join(',');
  const attList = attachments.map((p) => "'" + escapePsSingleQuoted(p) + "'").join(',');

  const htmlEscaped = htmlBody.replace(/'@/g, "'@ ");
  const useHtml = htmlEscaped.trim() !== '';

  const bodyAssign = useHtml
    ? `
$inspector = $mail.GetInspector
$signatureHtml = [string]$mail.HTMLBody
$html = @'
${htmlEscaped}
'@
$mail.HTMLBody = $html + $signatureHtml
`
    : `$mail.Body = '${escapePsSingleQuoted(body)}'`;

  const ps = `
$ErrorActionPreference = 'Stop'
try {
  $outlook = New-Object -ComObject Outlook.Application
} catch {
  throw "Outlook COM nicht verfügbar (klassisches Desktop-Outlook erforderlich)."
}
$mail = $outlook.CreateItem(0)
$mail.Subject = '${escapePsSingleQuoted(subject)}'
${bodyAssign}
$recipients = @(${recipList})
foreach ($r in $recipients) {
  if ($r -and $r.Trim() -ne '') { [void]$mail.Recipients.Add($r.Trim()) }
}
[void]$mail.Recipients.ResolveAll()
$attachments = @(${attList})
foreach ($a in $attachments) {
  if ($a -and (Test-Path -LiteralPath $a)) { [void]$mail.Attachments.Add($a) }
}
$mail.Display()
`;

  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 },
  );
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || 'Outlook konnte nicht geöffnet werden').toString().trim();
    throw new Error(msg);
  }
  return { ok: true, recipients, attachmentCount: attachments.length };
}

function collectRecipientEmails(contactRows) {
  const out = [];
  const seen = new Set();
  (Array.isArray(contactRows) ? contactRows : []).forEach((c) => {
    const email = String((c && (c.email || c.contact_email)) || '')
      .trim()
      .toLowerCase();
    if (!email || !email.includes('@')) return;
    if (seen.has(email)) return;
    seen.add(email);
    out.push(String((c && (c.email || c.contact_email)) || '').trim());
  });
  return out;
}

module.exports = {
  KUNDEN_DOC_FOLDER,
  scanKundenDokumentation,
  copyKundenDokumentationItems,
  createZipFromCopied,
  openOutlookDraft,
  collectRecipientEmails,
  ensureKundenDocDir,
  targetNameForItem,
  uniqueTargetName,
  assertPathUnderReise,
};
