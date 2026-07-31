'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPrintDocumentHtml } = require('./zeitschreibung-print-html');

/**
 * PDF 1:1 wie Browser-Druck: gleiche HTML/CSS-Vorlage via Electron printToPDF.
 * @returns {Promise<Buffer>}
 */
async function generateZeitschreibungPdfBuffer(payload) {
  const html = buildPrintDocumentHtml(payload || {});
  return renderHtmlToPdfBuffer(html);
}

async function renderHtmlToPdfBuffer(html) {
  let BrowserWindow;
  try {
    ({ BrowserWindow } = require('electron'));
  } catch (e) {
    throw new Error('Zeitschreibung-PDF benötigt Electron (printToPDF).');
  }
  if (!BrowserWindow) {
    throw new Error('Zeitschreibung-PDF: BrowserWindow nicht verfügbar.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-print-'));
  const tmpHtml = path.join(tmpDir, 'zeitschreibung.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(tmpHtml);
    // Kurze Pause, damit Layout/Farben stabil sind
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: true,
      pageSize: 'A4',
      margins: {
        marginType: 'none',
      },
    });
    return Buffer.from(pdfData);
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpHtml);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { generateZeitschreibungPdfBuffer, renderHtmlToPdfBuffer };
