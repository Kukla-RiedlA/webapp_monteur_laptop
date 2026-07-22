'use strict';

/**
 * DOCX → PDF für die gepackte Electron-App.
 *
 * docx2pdf-converter startet PowerShell mit convert.ps1 aus __dirname.
 * In der EXE zeigt __dirname auf app.asar\… – PowerShell kann dort keine
 * Skripte lesen. Deshalb: eigenes Temp-.ps1 (Windows) bzw. Fallback mit
 * asar.unpacked-Pfad-Korrektur.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWindowsPs1(inputPath, outputPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$inputPath = ${psSingleQuote(inputPath)}`,
    `$outputPath = ${psSingleQuote(outputPath)}`,
    '$word = $null',
    '$doc = $null',
    'try {',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    '  $doc = $word.Documents.Open($inputPath, $false, $true)',
    '  $doc.ExportAsFixedFormat($outputPath, 17)',
    '  $doc.Close($false)',
    '  $doc = $null',
    '  if (-not (Test-Path -LiteralPath $outputPath)) {',
    "    throw 'PDF wurde nicht erzeugt. Bitte Microsoft Word oeffnen und die Office-Lizenz/Aktivierung pruefen.'",
    '  }',
    '} catch {',
    '  throw $_.Exception.Message',
    '} finally {',
    '  if ($null -ne $doc) { try { $doc.Close($false) } catch {} }',
    '  if ($null -ne $word) {',
    '    try { $word.Quit() } catch {}',
    '    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}',
    '  }',
    '}',
    '',
  ].join('\n');
}

function convertWindows(inputPath, outputPath, timeoutMs) {
  const inPath = path.resolve(inputPath);
  const outPath = path.resolve(outputPath);
  if (!fs.existsSync(inPath)) {
    throw new Error(`DOCX nicht gefunden: ${inPath}`);
  }
  if (fs.existsSync(outPath)) {
    try {
      fs.unlinkSync(outPath);
    } catch (_) {
      /* ignore */
    }
  }

  const ps1Path = path.join(os.tmpdir(), `kukla_docx2pdf_${process.pid}_${Date.now()}.ps1`);
  fs.writeFileSync(ps1Path, buildWindowsPs1(inPath, outPath), 'utf8');
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      {
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const stdout = err && err.stdout ? String(err.stdout).trim() : '';
    const detail = stderr || stdout || (err && err.message) || String(err);
    throw new Error(detail);
  } finally {
    try {
      fs.unlinkSync(ps1Path);
    } catch (_) {
      /* ignore */
    }
  }

  if (!fs.existsSync(outPath)) {
    throw new Error(
      'PDF wurde nicht erzeugt. Microsoft Word muss installiert und aktiviert sein.'
    );
  }
}

/**
 * Fallback für macOS/Linux: docx2pdf-converter, aber Skriptpfad aus asar.unpacked.
 */
function convertViaDocx2pdfUnpacked(inputPath, outputPath, timeoutMs) {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('docx2pdf-converter/package.json'));
  } catch (err) {
    throw new Error(`docx2pdf-converter nicht ladbar: ${err.message}`);
  }

  const unpackedDir = pkgDir.includes(`${path.sep}app.asar${path.sep}`)
    ? pkgDir.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : pkgDir;

  if (process.platform === 'darwin') {
    const scriptPath = path.join(unpackedDir, 'convert.sh');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`convert.sh nicht gefunden: ${scriptPath}`);
    }
    execFileSync('sh', [scriptPath, path.resolve(inputPath), path.resolve(outputPath), 'false'], {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  }

  // Linux: unoconv wie im Upstream-Paket
  execSync(`unoconv -f pdf -o "${path.resolve(outputPath)}" "${path.resolve(inputPath)}"`, {
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Word-Export (Hybrid-XRef / XRefStm) für Acrobat neu schreiben.
 * Andere Reader sind oft toleranter; Acrobat scheitert still häufiger.
 * @param {string} pdfPath
 */
async function normalizePdfForAcrobat(pdfPath) {
  const resolved = path.resolve(pdfPath);
  if (!fs.existsSync(resolved)) return;
  let PDFDocument;
  try {
    ({ PDFDocument } = require('pdf-lib'));
  } catch (_) {
    return;
  }
  const raw = fs.readFileSync(resolved);
  const doc = await PDFDocument.load(raw, { ignoreEncryption: true, updateMetadata: false });
  // Klassische xref-Tabelle ohne Object-Streams – besser Acrobat-kompatibel.
  const cleaned = await doc.save({ useObjectStreams: false });
  fs.writeFileSync(resolved, cleaned);
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ timeoutMs?: number, normalizeForAcrobat?: boolean }} [options]
 */
async function convertDocxToPdf(inputPath, outputPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
  const doNormalize = options.normalizeForAcrobat !== false;
  if (process.platform === 'win32') {
    convertWindows(inputPath, outputPath, timeoutMs);
  } else {
    convertViaDocx2pdfUnpacked(inputPath, outputPath, timeoutMs);
    if (!fs.existsSync(path.resolve(outputPath))) {
      throw new Error('PDF wurde nicht erzeugt.');
    }
  }
  if (doNormalize) {
    try {
      await normalizePdfForAcrobat(outputPath);
    } catch (err) {
      // Roh-PDF behalten – besser unnormalisiert als Konvertierung abbrechen.
      console.warn(
        '[docx-to-pdf] Acrobat-Normalisierung übersprungen:',
        err && err.message ? err.message : String(err)
      );
    }
  }
}

module.exports = {
  convertDocxToPdf,
  normalizePdfForAcrobat,
};
