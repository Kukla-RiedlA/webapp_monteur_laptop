'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, app } = require('electron');

/**
 * Öffnet PDFs im Chromium-PDF-Viewer (eigenes Electron-Fenster).
 * Vermeidet Acrobat/Shell-Probleme mit langen OneDrive-/Sonderzeichen-Pfaden.
 */
function createPdfViewerWindowManager(getMainWindow) {
  const windows = new Set();

  function prepareReadablePdfPath(filePath) {
    const normalized = path.normalize(String(filePath || '').trim());
    if (!normalized) return null;
    if (!fs.existsSync(normalized)) return null;
    const needsCopy =
      normalized.length >= 200 ||
      /[^\x20-\x7E]/.test(normalized) ||
      /[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF\u00B7•▪◦●∙·]/.test(normalized);
    if (!needsCopy) return normalized;
    try {
      const tmpDir = app.getPath('temp');
      const base =
        String(path.basename(normalized, '.pdf'))
          .replace(/[^\w.\-()+]/gi, '_')
          .replace(/_+/g, '_')
          .slice(0, 60) || 'dokument';
      const tmpPath = path.join(tmpDir, `kukla_pdfview_${Date.now()}_${base}.pdf`);
      fs.copyFileSync(normalized, tmpPath);
      return tmpPath;
    } catch (_) {
      return normalized;
    }
  }

  async function openPdf(filePath) {
    const sourcePath = path.normalize(String(filePath || '').trim());
    const readable = prepareReadablePdfPath(sourcePath);
    if (!readable) {
      return { ok: false, error: 'PDF nicht gefunden: ' + (sourcePath || '') };
    }

    const title = path.basename(sourcePath || readable) || 'PDF';
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const win = new BrowserWindow({
      width: 1100,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      title,
      // Eigenes Fenster (nicht modal am Main) – parallel nutzbar
      parent: undefined,
      modal: false,
      backgroundColor: '#525659',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (main && !main.isDestroyed()) {
      try {
        const b = main.getBounds();
        win.setPosition(Math.max(40, b.x + 40), Math.max(40, b.y + 40));
      } catch (_) { /* ignore */ }
    }
    windows.add(win);
    win.on('closed', () => windows.delete(win));

    try {
      const { attachEditContextMenu } = require('./edit-context-menu');
      attachEditContextMenu(win.webContents);
    } catch (_) { /* optional */ }

    try {
      await win.loadURL(pathToFileURL(readable).href);
      if (win.isDestroyed()) return { ok: false, error: 'Fenster geschlossen.' };
      win.show();
      win.focus();
      return {
        ok: true,
        via: 'electron-pdf-viewer',
        path: sourcePath,
        viewPath: readable !== sourcePath ? readable : undefined,
      };
    } catch (e) {
      try {
        if (!win.isDestroyed()) win.close();
      } catch (_) { /* ignore */ }
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  return { openPdf };
}

module.exports = { createPdfViewerWindowManager };
