'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, app, screen, shell, dialog } = require('electron');
const {
  createPdfAnnotatorSession,
  dropPdfAnnotatorSession,
} = require('./pdf-annotator-sessions');

const MAX_WINDOWS = 4;
const COPY_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 12000;

function isAnnotatorUrl(win) {
  try {
    return /\/pdf-annotator\.html(?:\?|$)/.test(String(win.webContents.getURL() || ''));
  } catch (_) {
    return false;
  }
}

async function runInAnnotator(win, source) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await win.webContents.executeJavaScript(source, true);
  } catch (_) {
    return null;
  }
}

async function confirmClosePdfWindow(win) {
  if (!isAnnotatorUrl(win)) return true;
  const dirty = await runInAnnotator(
    win,
    'typeof window.__pdfAnnotatorHasUnsavedChanges === "function" && window.__pdfAnnotatorHasUnsavedChanges() === true',
  );
  if (!dirty) return true;
  let choice;
  try {
    choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Speichern', 'Verwerfen', 'Abbrechen'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'PDF schließen',
      message: 'Die Markierungen wurden noch nicht gespeichert.',
      detail: 'Möchten Sie die Änderungen speichern oder verwerfen?',
    });
  } catch (_) {
    return false;
  }
  if (!choice || choice.response === 2) return false;
  if (choice.response === 1) {
    await runInAnnotator(
      win,
      'typeof window.__pdfAnnotatorDiscardChanges === "function" && window.__pdfAnnotatorDiscardChanges()',
    );
    return true;
  }
  const saved = await runInAnnotator(
    win,
    '(async function () { if (typeof window.__pdfAnnotatorSaveForClose !== "function") return false; return await window.__pdfAnnotatorSaveForClose(); })()',
  );
  return saved === true;
}

function attachUnsavedCloseGuard(win) {
  let closing = false;
  let prompting = false;
  win.on('close', (ev) => {
    if (closing || win.isDestroyed()) return;
    ev.preventDefault();
    if (prompting) return;
    prompting = true;
    confirmClosePdfWindow(win)
      .then((allow) => {
        prompting = false;
        if (!allow || win.isDestroyed()) return;
        closing = true;
        win.close();
      })
      .catch(() => {
        prompting = false;
      });
  });
}

/**
 * Öffnet PDFs im eingebauten Viewer (Skizze + Text).
 * Fallback: Chromium-PDF-Anzeige, danach System-App.
 */
function createPdfViewerWindowManager(getMainWindow, getPort) {
  const windows = [];

  function resolvePort() {
    if (typeof getPort === 'function') return getPort();
    return getPort;
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

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

  async function prepareReadablePdfPath(filePath) {
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
      await withTimeout(fs.promises.copyFile(existing, tmpPath), COPY_TIMEOUT_MS, 'PDF-Kopie Timeout');
      return tmpPath;
    } catch (e) {
      console.warn('[pdf-viewer] temp-Kopie fehlgeschlagen:', e && e.message ? e.message : e);
      return existing.startsWith('\\\\?\\') ? path.normalize(String(filePath || '').trim()) : existing;
    }
  }

  function pruneDestroyed() {
    for (let i = windows.length - 1; i >= 0; i -= 1) {
      if (!windows[i] || windows[i].isDestroyed()) windows.splice(i, 1);
    }
  }

  function closeOldestIfNeeded() {
    pruneDestroyed();
    while (windows.length >= MAX_WINDOWS) {
      const old = windows.shift();
      try {
        if (old && !old.isDestroyed()) old.close();
      } catch (_) { /* ignore */ }
    }
  }

  function placeOnScreen(win, main) {
    try {
      const display = main && !main.isDestroyed()
        ? screen.getDisplayMatching(main.getBounds())
        : screen.getPrimaryDisplay();
      const a = display.workArea || display.bounds;
      const cascade = 36 + windows.length * 24;
      let x = a.x + 40 + cascade;
      let y = a.y + 40 + cascade;
      if (main && !main.isDestroyed()) {
        const b = main.getBounds();
        x = Math.max(a.x, b.x + cascade);
        y = Math.max(a.y, b.y + cascade);
      }
      const w = Math.min(1200, a.width - 24);
      const h = Math.min(920, a.height - 24);
      if (x + w > a.x + a.width) x = a.x + Math.max(0, a.width - w);
      if (y + h > a.y + a.height) y = a.y + Math.max(0, a.height - h);
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    } catch (_) { /* ignore */ }
  }

  async function openViaShell(filePath) {
    try {
      const err = await shell.openPath(String(filePath || ''));
      if (err) return { ok: false, error: String(err) };
      return { ok: true, via: 'shell-fallback', path: filePath };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function createWindow(title) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    closeOldestIfNeeded();
    const win = new BrowserWindow({
      width: 1200,
      height: 920,
      minWidth: 720,
      minHeight: 520,
      title,
      parent: undefined,
      modal: false,
      backgroundColor: '#eefaf5',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    placeOnScreen(win, main);
    try {
      win.webContents.setVisualZoomLevelLimits(1, 1);
    } catch (_) { /* ignore */ }
    windows.push(win);
    try {
      const { attachEditContextMenu } = require('./edit-context-menu');
      attachEditContextMenu(win.webContents);
    } catch (_) { /* optional */ }
    return win;
  }

  function bringToFront(win) {
    if (!win || win.isDestroyed()) return;
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (_) { /* ignore */ }
  }

  async function openChromiumViewer(win, readable, sourcePath, title) {
    await withTimeout(win.loadURL(pathToFileURL(readable).href), LOAD_TIMEOUT_MS, 'PDF-Laden Timeout');
    if (win.isDestroyed()) return { ok: false, error: 'Fenster geschlossen.' };
    bringToFront(win);
    return {
      ok: true,
      via: 'electron-pdf-viewer',
      path: sourcePath,
      viewPath: readable !== sourcePath ? readable : undefined,
    };
  }

  async function openPdf(filePath) {
    const sourcePath = path.normalize(String(filePath || '').trim());
    console.log('[pdf-viewer] open', sourcePath);
    const readable = await prepareReadablePdfPath(sourcePath);
    if (!readable) {
      const err = 'PDF nicht gefunden: ' + (sourcePath || '');
      console.warn('[pdf-viewer]', err);
      return { ok: false, error: err };
    }

    const title = path.basename(sourcePath || readable) || 'PDF';
    const sessionId = createPdfAnnotatorSession({
      sourcePath,
      viewPath: readable,
      title,
    });
    const win = createWindow(title);
    attachUnsavedCloseGuard(win);
    win.on('closed', () => {
      const idx = windows.indexOf(win);
      if (idx >= 0) windows.splice(idx, 1);
      if (sessionId) dropPdfAnnotatorSession(sessionId);
    });

    const port = parseInt(String(resolvePort() || ''), 10);
    if (sessionId && port) {
      const url =
        'http://127.0.0.1:' +
        port +
        '/pdf-annotator.html?id=' +
        encodeURIComponent(sessionId);
      try {
        await withTimeout(win.loadURL(url), LOAD_TIMEOUT_MS, 'PDF-Viewer Timeout');
        if (win.isDestroyed()) return { ok: false, error: 'Fenster geschlossen.' };
        bringToFront(win);
        console.log('[pdf-viewer] annotator', title);
        return {
          ok: true,
          via: 'pdf-annotator',
          path: sourcePath,
          sessionId,
          viewPath: readable !== sourcePath ? readable : undefined,
        };
      } catch (e) {
        console.warn('[pdf-viewer] Annotator fehlgeschlagen, Chromium-Fallback:', e && e.message ? e.message : e);
      }
    }

    try {
      const result = await openChromiumViewer(win, readable, sourcePath, title);
      console.log('[pdf-viewer] ok', title);
      return result;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.warn('[pdf-viewer] loadURL fehlgeschlagen, Shell-Fallback:', msg);
      try {
        if (!win.isDestroyed()) win.close();
      } catch (_) { /* ignore */ }
      const fallback = await openViaShell(readable);
      if (fallback.ok) return fallback;
      return { ok: false, error: msg };
    }
  }

  return { openPdf };
}

module.exports = { createPdfViewerWindowManager };
