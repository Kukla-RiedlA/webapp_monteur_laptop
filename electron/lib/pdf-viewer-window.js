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

  function win32LongPath(filePath) {
    const n = path.resolve(String(filePath || ''));
    if (process.platform !== 'win32' || !n) return n;
    if (n.startsWith('\\\\?\\')) return n;
    if (n.startsWith('\\\\')) return '\\\\?\\UNC\\' + n.slice(2);
    return '\\\\?\\' + n;
  }

  function existingPdfPath(filePath) {
    const normalized = path.normalize(String(filePath || '').trim());
    if (!normalized) return null;
    const candidates = [normalized];
    if (process.platform === 'win32') candidates.push(win32LongPath(normalized));
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) { /* continue */ }
    }
    return null;
  }

  function prepareReadablePdfPath(filePath) {
    const existing = existingPdfPath(filePath);
    if (!existing) return null;
    try {
      const tmpDir = app.getPath('temp');
      const base =
        String(path.basename(String(filePath || existing), '.pdf'))
          .replace(/[^\w.\-()+]/gi, '_')
          .replace(/_+/g, '_')
          .slice(0, 60) || 'dokument';
      const tmpPath = path.join(tmpDir, `kukla_pdfview_${Date.now()}_${base}.pdf`);
      fs.copyFileSync(existing, tmpPath);
      return tmpPath;
    } catch (e) {
      console.warn('[pdf-viewer] temp-Kopie fehlgeschlagen:', e && e.message ? e.message : e);
      return existing.startsWith('\\\\?\\') ? path.normalize(String(filePath || '').trim()) : existing;
    }
  }

  async function openPdf(filePath) {
    const sourcePath = path.normalize(String(filePath || '').trim());
    console.log('[pdf-viewer] open', sourcePath);
    const readable = prepareReadablePdfPath(sourcePath);
    if (!readable) {
      const err = 'PDF nicht gefunden: ' + (sourcePath || '');
      console.warn('[pdf-viewer]', err);
      return { ok: false, error: err };
    }

    const title = path.basename(sourcePath || readable) || 'PDF';
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const win = new BrowserWindow({
      width: 1100,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      title,
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
        const cascade = 40 + windows.size * 28;
        win.setPosition(Math.max(40, b.x + cascade), Math.max(40, b.y + cascade));
      } catch (_) { /* ignore */ }
    }
    windows.add(win);
    win.on('closed', () => windows.delete(win));

    try {
      const { attachEditContextMenu } = require('./edit-context-menu');
      attachEditContextMenu(win.webContents);
    } catch (_) { /* optional */ }

    function bringToFront() {
      if (win.isDestroyed()) return;
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.moveTop();
        win.focus();
      } catch (_) { /* ignore */ }
    }

    try {
      await win.loadURL(pathToFileURL(readable).href);
      if (win.isDestroyed()) return { ok: false, error: 'Fenster geschlossen.' };
      bringToFront();
      setTimeout(bringToFront, 120);
      console.log('[pdf-viewer] ok', title);
      return {
        ok: true,
        via: 'electron-pdf-viewer',
        path: sourcePath,
        viewPath: readable !== sourcePath ? readable : undefined,
      };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.warn('[pdf-viewer] loadURL fehlgeschlagen:', msg);
      try {
        if (!win.isDestroyed()) win.close();
      } catch (_) { /* ignore */ }
      return { ok: false, error: msg };
    }
  }

  return { openPdf };
}

module.exports = { createPdfViewerWindowManager };
