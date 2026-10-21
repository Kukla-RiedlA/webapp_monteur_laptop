'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeMarkup, flattenPdfMarkup } = require('./pdf-flatten-markup');

const PRINT_READY_MS = 600;
const DIALOG_TIMEOUT_MS = 30 * 60 * 1000;

function markupHasContent(markup) {
  const normalized = normalizeMarkup(markup);
  return normalized.strokes.length > 0 || normalized.texts.length > 0;
}

/**
 * Ohne Markierung die Originaldatei. Mit Markierung eine temporäre Kopie,
 * damit Drucken die Datei auf der Platte nicht verändert.
 */
async function writePrintSource(sourcePath, markup) {
  const filePath = path.normalize(String(sourcePath || '').trim());
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('PDF nicht gefunden.');
  }
  if (!markupHasContent(markup)) {
    return { filePath, temporary: false };
  }
  const tempPath = path.join(
    os.tmpdir(),
    'kukla-pdf-print-' + crypto.randomBytes(8).toString('hex') + '.pdf',
  );
  await flattenPdfMarkup({ sourcePath: filePath, destPath: tempPath, markup });
  return { filePath: tempPath, temporary: true };
}

function scheduleUnlink(filePath) {
  if (!filePath) return;
  const attempt = (left) => {
    fs.promises.unlink(filePath).catch(() => {
      if (left > 0) setTimeout(() => attempt(left - 1), 2000);
    });
  };
  setTimeout(() => attempt(4), 1500);
}

function isCancelReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return true;
  return /cancel/i.test(text);
}

/**
 * System-Druckdialog für eine lokale PDF. Das Fenster bleibt unsichtbar;
 * Chromium druckt die PDF-Seiten, nicht die Annotator-Oberfläche.
 */
function printPdfFile(filePath) {
  const { BrowserWindow } = require('electron');
  const resolved = path.normalize(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return Promise.reject(new Error('PDF nicht gefunden.'));
  }
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        plugins: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    let finished = false;
    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch (_) { /* ignore */ }
      }, 400);
      if (err) reject(err);
      else resolve(result || { ok: true, cancelled: false });
    };
    const watchdog = setTimeout(() => {
      finish(new Error('Druckdialog Zeitüberschreitung.'));
    }, DIALOG_TIMEOUT_MS);
    win.webContents.once('did-fail-load', (_event, _code, desc) => {
      finish(new Error(desc || 'PDF für den Druck nicht geladen.'));
    });
    win.loadFile(resolved).then(() => {
      setTimeout(() => {
        if (win.isDestroyed()) {
          finish(new Error('Druckfenster geschlossen.'));
          return;
        }
        try {
          win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
            if (!success && !isCancelReason(failureReason)) {
              finish(new Error(String(failureReason || 'Drucken fehlgeschlagen.')));
              return;
            }
            finish(null, { ok: true, cancelled: !success });
          });
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      }, PRINT_READY_MS);
    }).catch((e) => {
      finish(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

async function printAnnotatorPdf(opts) {
  const sourcePath = opts && opts.sourcePath;
  const prepared = await writePrintSource(sourcePath, opts && opts.markup);
  try {
    return await printPdfFile(prepared.filePath);
  } finally {
    if (prepared.temporary) scheduleUnlink(prepared.filePath);
  }
}

module.exports = {
  markupHasContent,
  writePrintSource,
  printPdfFile,
  printAnnotatorPdf,
  isCancelReason,
};
