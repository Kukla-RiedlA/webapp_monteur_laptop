const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const { createApp, getDb, getMonteurDb, PORT, performAnlagenstammSave, flushMonteurDb } = require('./server');
const { createImageGalleryWindowManager } = require('./lib/image-gallery-window');
const { createPdfViewerWindowManager } = require('./lib/pdf-viewer-window');
const { attachEditContextMenu } = require('./lib/edit-context-menu');
const { createAnlagenstammAkteWindowManager } = require('./lib/anlagenstamm-akte-window');
const { configureSpellCheckerSession } = require('./lib/spellcheck-session');
const { proxyAnlagenstammSearch } = require('./lib/anlagenstamm-dispo-proxy');
const {
  searchLocal: anlagenstammSearchLocal,
  rowCount: anlagenstammLocalRowCount,
} = require('./lib/anlagenstamm-local');
const {
  initLaptopUpdater,
  setUpdateFeedFromDispoBase,
  checkForUpdatesNow,
  startDownload,
  installUpdateNow,
  trustCertificateForUrl,
  isInsecureTlsAllowed,
} = require('./lib/laptop-updater');
const { installLocalGatewayWebRequest } = require('./lib/local-gateway-auth');

let mainWindow;
let updateCheckScheduled = false;
let imageGalleryWindows = null;
let pdfViewerWindows = null;
let anlagenstammAkteWindows = null;

function findWindowsUninstaller() {
  if (process.platform !== 'win32') return null;
  const installDir = path.dirname(process.execPath);
  const names = [
    'Uninstall Monteur WebApp.exe',
    'Uninstall monteur-webapp.exe',
    'Uninstall ' + app.getName() + '.exe',
  ];
  for (const name of names) {
    const candidate = path.join(installDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const match = fs
      .readdirSync(installDir)
      .find((name) => /^uninstall.*\.exe$/i.test(name));
    return match ? path.join(installDir, match) : null;
  } catch (_) {
    return null;
  }
}

function scheduleSelfUninstallAndDataRemoval() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Deinstallation ist nur unter Windows verfügbar.' };
  }
  if (!app.isPackaged) {
    return { ok: false, error: 'Deinstallation ist nur in der installierten App verfügbar.' };
  }
  const uninstaller = findWindowsUninstaller();
  if (!uninstaller) {
    return { ok: false, error: 'Windows-Uninstaller wurde nicht gefunden.' };
  }
  const userDataDir = app.getPath('userData');
  flushMonteurDb();
  const psScript = [
    '$pidToWait = [int]$args[0];',
    '$userDataDir = $args[1];',
    '$uninstaller = $args[2];',
    'try { Wait-Process -Id $pidToWait -Timeout 30 -ErrorAction SilentlyContinue } catch {}',
    'Start-Sleep -Seconds 1;',
    'if ($userDataDir -and (Test-Path -LiteralPath $userDataDir)) {',
    '  Remove-Item -LiteralPath $userDataDir -Recurse -Force -ErrorAction SilentlyContinue;',
    '}',
    'if ($uninstaller -and (Test-Path -LiteralPath $uninstaller)) {',
    '  Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait;',
    '}',
  ].join(' ');
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
        String(process.pid),
        userDataDir,
        uninstaller,
      ],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  setTimeout(() => {
    app.quit();
  }, 1200);
  return { ok: true };
}

function scheduleUpdateCheck() {
  if (updateCheckScheduled || !app.isPackaged) return;
  updateCheckScheduled = true;
  // Erst nach UI-Zeit (syncUpdateFeedToMain) — sonst Feed/TLS noch nicht gesetzt.
  setTimeout(() => {
    checkForUpdatesNow({ source: 'startup' }).catch((e) => {
      console.warn('[laptop-updater] check:', e && e.message ? e.message : e);
    });
  }, 12000);
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
    icon: path.join(__dirname, 'public', 'icon.png'),
  });

  let shown = false;
  function showMainWindow(reason) {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    if (reason) console.warn('[startup] Fenster anzeigen:', reason);
    mainWindow.show();
    mainWindow.maximize();
    mainWindow.focus();
    if (process.env.DEBUG === '1' || process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  }

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.once('ready-to-show', () => {
    showMainWindow();
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[startup] did-fail-load', errorCode, errorDescription, validatedURL);
    showMainWindow('did-fail-load ' + errorCode);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[startup] render-process-gone', details && details.reason, details && details.exitCode);
  });
  setTimeout(() => {
    showMainWindow('Timeout — ready-to-show ausgeblieben');
  }, 4000);
  mainWindow.on('closed', () => { mainWindow = null; });
  attachEditContextMenu(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      if (local && anlagenstammAkteWindows && (u.searchParams.get('popup') === '1' || /anlagenstamm-akte-window/i.test(u.pathname))) {
        void anlagenstammAkteWindows.openAnlagenstammAkteWindow({
          id: u.searchParams.get('id') || null,
          fab: u.searchParams.get('fab') || '',
        });
        return { action: 'deny' };
      }
    } catch (_) { /* ignore */ }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

ipcMain.handle('anlagenstamm:search', async (event, payload) => {
  const body = payload || {};
  try {
    await getDb();
    const db = getMonteurDb();
    if (db && anlagenstammLocalRowCount(db) > 0) {
      const local = anlagenstammSearchLocal(db, body);
      if (local.ok) return local;
    }
    return await proxyAnlagenstammSearch(body);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('anlagenstamm:save', async (event, payload) => {
  try {
    await getDb();
    const body = payload || {};
    const technicianId = parseInt(String(body.technician_id ?? body.technicianId ?? '0'), 10);
    return await performAnlagenstammSave(body, technicianId);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('anlagenstamm:open-akte-window', async (_event, opts) => {
  if (!anlagenstammAkteWindows) return { ok: false, error: 'not_ready' };
  return anlagenstammAkteWindows.openAnlagenstammAkteWindow(opts || {});
});
ipcMain.handle('anlagenstamm:notify-saved', async (_event, payload) => {
  if (anlagenstammAkteWindows) anlagenstammAkteWindows.notifyListSaved(payload || {});
  return { ok: true };
});

ipcMain.handle('dienstreise:choose-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ordner wählen',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});

async function openDienstreisePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: 'Pfad fehlt.' };
  const raw = filePath.trim();
  const normalized = path.normalize(raw);
  const win = process.platform === 'win32';
  const openTrace = [];
  function trace(step, info) {
    const line = '[open-path] ' + step + (info ? ' | ' + info : '');
    openTrace.push(line);
    try { console.log(line); } catch (_) {}
  }
  function isExcelFile(targetPath) {
    const ext = String(path.extname(targetPath || '')).toLowerCase();
    return ext === '.xls' || ext === '.xlsx' || ext === '.xlsm' || ext === '.xlsb' || ext === '.csv';
  }
  function pathNeedsAcrobatSafeCopy(targetPath) {
    const p = String(targetPath || '');
    if (!p) return false;
    // Acrobat/ShellExecute: Bullet & Co., sehr lange Pfade (MAX_PATH ~260),
    // und tief verschachtelte OneDrive-Pfade mit Nicht-ASCII – PDF24 ist oft toleranter.
    if (p.length >= 240) return true;
    if (/[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25CF\u00B7\u2024\u2027\u2218•▪◦●∙·]/.test(p)) {
      return true;
    }
    // Steuerzeichen / Zero-Width / NBSP etc.
    if (/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/.test(p)) return true;
    return false;
  }
  function openPdfViaTempAsciiCopy(targetPath) {
    const ext = String(path.extname(targetPath || '')).toLowerCase();
    if (ext !== '.pdf') return null;
    if (!pathNeedsAcrobatSafeCopy(targetPath)) return null;
    try {
      const tmpDir = app.getPath('temp');
      const safeBase =
        String(path.basename(targetPath, ext))
          .replace(/[^\w.\-()+]/gi, '_')
          .replace(/_+/g, '_')
          .slice(0, 60) || 'dokument';
      const tmpPath = path.join(tmpDir, `kukla_${Date.now()}_${safeBase}${ext}`);
      fs.copyFileSync(targetPath, tmpPath);
      trace('pdf.tempCopy', `len=${String(targetPath).length}->${tmpPath.length} ${tmpPath}`);
      return tmpPath;
    } catch (e) {
      trace('pdf.tempCopy.fail', e && e.message ? e.message : String(e));
      return null;
    }
  }
  function tryLaunchExcelDirect(targetPath) {
    if (!win || !isExcelFile(targetPath)) return false;
    trace('tryLaunchExcelDirect', targetPath);
    const candidates = [
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\Office16\\EXCEL.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\Office16\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\Office15\\EXCEL.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\Office15\\EXCEL.EXE'
    ];
    const exe = candidates.find((p) => {
      try { return fs.existsSync(p); } catch (_) { return false; }
    });
    if (!exe) return false;
    try {
      const p = spawn(exe, [targetPath], { windowsHide: true, detached: true, stdio: 'ignore' });
      p.unref();
      trace('tryLaunchExcelDirect.ok', exe);
      return true;
    } catch (_) {
      trace('tryLaunchExcelDirect.fail');
      return false;
    }
  }
  function tryLaunchExcelByCom(targetPath) {
    if (!win || !isExcelFile(targetPath)) return false;
    trace('tryLaunchExcelByCom', targetPath);
    try {
      const ps = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        '$p=$args[0];',
        'try {',
        '  $excel = New-Object -ComObject Excel.Application;',
        '  $excel.Visible = $true;',
        '  $excel.DisplayAlerts = $false;',
        '  $null = $excel.Workbooks.Open($p);',
        '  exit 0;',
        '} catch {',
        '  exit 1;',
        '}'
      ];
      const p = spawn('powershell.exe', ps.concat([targetPath]), {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      p.unref();
      trace('tryLaunchExcelByCom.started');
      return true;
    } catch (_) {
      trace('tryLaunchExcelByCom.fail');
      return false;
    }
  }
  function tryWindowsStartProcess(targetPath) {
    try {
      trace('tryWindowsStartProcess', targetPath);
      // LiteralPath verhindert Probleme mit Sonderzeichen/Leerzeichen.
      const p = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        'Start-Process -LiteralPath $args[0]',
        targetPath
      ], { windowsHide: true, detached: true, stdio: 'ignore' });
      p.unref();
      trace('tryWindowsStartProcess.started');
      return true;
    } catch (_) {
      trace('tryWindowsStartProcess.fail');
      return false;
    }
  }
  function tryWindowsCmdStart(targetPath) {
    try {
      trace('tryWindowsCmdStart', targetPath);
      const p = spawn('cmd.exe', ['/c', 'start', '', `"${targetPath}"`], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      p.unref();
      trace('tryWindowsCmdStart.started');
      return true;
    } catch (_) {
      trace('tryWindowsCmdStart.fail');
      return false;
    }
  }
  function tryOpenExcelFirst(targetPath) {
    if (!win || !isExcelFile(targetPath)) return false;
    trace('tryOpenExcelFirst', targetPath);
    if (tryLaunchExcelDirect(targetPath)) return true;
    if (tryLaunchExcelByCom(targetPath)) return true;
    if (tryWindowsStartProcess(targetPath) || tryWindowsCmdStart(targetPath)) return true;
    return false;
  }
  try {
    trace('start', normalized);
    if (!fs.existsSync(normalized)) {
      trace('missing', normalized);
      return { ok: false, error: 'Datei nicht gefunden: ' + normalized };
    }
    trace('exists', normalized);
    // PDFs immer im Electron-Chromium-Viewer – Acrobat scheitert an langen OneDrive-Pfaden.
    if (String(path.extname(normalized)).toLowerCase() === '.pdf') {
      if (!pdfViewerWindows) {
        pdfViewerWindows = createPdfViewerWindowManager(() => mainWindow);
      }
      const pdfResult = await pdfViewerWindows.openPdf(normalized);
      trace('pdf.electronViewer', pdfResult && pdfResult.ok ? 'ok' : (pdfResult && pdfResult.error) || 'fail');
      return pdfResult;
    }
    // TED/Excel: zuerst EXCEL.EXE bzw. COM – nicht Browser oder generische Standard-App.
    if (tryOpenExcelFirst(normalized)) {
      trace('excel-first.ok');
      return { ok: true, via: 'excel' };
    }
    const openTarget = openPdfViaTempAsciiCopy(normalized) || normalized;
    const openResult = await shell.openPath(openTarget);
    trace('shell.openPath.result', String(openResult || 'ok'));
    if (typeof openResult === 'string' && openResult.trim()) {
      if (isExcelFile(normalized) && tryOpenExcelFirst(normalized)) {
        return { ok: true, fallback: true, warning: openResult.trim(), via: 'excel' };
      }
      if (!isExcelFile(normalized)) {
        try {
          await shell.openExternal(pathToFileURL(openTarget).toString());
          trace('shell.openExternal.fileurl.ok');
          return { ok: true, fallback: true, warning: openResult.trim() };
        } catch (_) { /* weiter unten */ }
      }
      if (win && (tryWindowsStartProcess(openTarget) || tryWindowsCmdStart(openTarget))) {
        return { ok: true, fallback: true, warning: openResult.trim() };
      }
      trace('all-fallbacks-failed', openResult.trim());
      return { ok: false, error: openResult.trim() };
    }
    trace('shell.openPath.ok');
    return { ok: true, via: openTarget !== normalized ? 'pdf-temp-copy' : 'shell' };
  } catch (e) {
    trace('exception', e && e.message ? e.message : String(e));
    if (tryOpenExcelFirst(normalized)) {
      return { ok: true, fallback: true, warning: e && e.message ? e.message : String(e), via: 'excel' };
    }
    if (win && fs.existsSync(normalized) && (tryWindowsStartProcess(normalized) || tryWindowsCmdStart(normalized))) {
      return { ok: true, fallback: true, warning: e && e.message ? e.message : String(e) };
    }
    trace('exception-no-fallback', e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

ipcMain.handle('dienstreise:open-path', async (_event, filePath) => openDienstreisePath(filePath));

ipcMain.handle('pdf:open-viewer', async (_event, filePath) => {
  if (!pdfViewerWindows) {
    pdfViewerWindows = createPdfViewerWindowManager(() => mainWindow);
  }
  return pdfViewerWindows.openPdf(filePath);
});

function openWithDialogMonteur(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: 'Pfad fehlt.' };
  const normalized = path.normalize(filePath.trim());
  if (!fs.existsSync(normalized)) return { ok: false, error: 'file_not_found' };
  if (process.platform !== 'win32') {
    return shell.openPath(normalized).then((r) => (r ? { ok: false, error: r } : { ok: true }));
  }
  const rundll = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'rundll32.exe');
  try {
    const p = spawn(rundll, ['shell32.dll,OpenAs_RunDLL', normalized], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    p.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

ipcMain.handle('dienstreise:open-with-dialog', async (_event, filePath) => openWithDialogMonteur(filePath));

ipcMain.handle('dienstreise:save-file-as', async (event, filePath, defaultName) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: 'Pfad fehlt.' };
  const normalized = path.normalize(filePath.trim());
  if (!fs.existsSync(normalized)) return { ok: false, error: 'file_not_found' };
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win || undefined, {
    defaultPath: defaultName || path.basename(normalized),
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.copyFileSync(normalized, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('dienstreise:show-in-folder', async (_event, filePath) => {
  if (typeof filePath === 'string' && filePath.trim()) {
    shell.showItemInFolder(path.normalize(filePath.trim()));
  }
  return { ok: true };
});

ipcMain.handle('dienstreise:file-context-menu', async (event, spec) => {
  const filePath = spec && spec.localPath;
  const fileName = (spec && spec.fileName) || (filePath ? path.basename(filePath) : 'Datei');
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'file_not_found' };
  const win = BrowserWindow.fromWebContents(event.sender);
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Öffnen',
        click: () => {
          void openDienstreisePath(filePath);
        },
      },
      {
        label: 'Öffnen mit…',
        click: () => {
          void openWithDialogMonteur(filePath);
        },
      },
      {
        label: 'Speichern unter…',
        click: async () => {
          const result = await dialog.showSaveDialog(win || undefined, { defaultPath: fileName });
          if (!result.canceled && result.filePath) {
            try {
              fs.copyFileSync(filePath, result.filePath);
            } catch (_) {
              /* ignore */
            }
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Im Explorer anzeigen',
        click: () => {
          shell.showItemInFolder(filePath);
        },
      },
    ]);
    menu.popup({ window: win || undefined, callback: () => resolve({ ok: true }) });
  });
});

ipcMain.handle('dienstreise:copy-path', async (event, filePath) => {
  if (typeof filePath !== 'string') return;
  clipboard.writeText(filePath.trim());
});

/**
 * Remote-Bilder aus E-Mail-HTML (https://…) ohne Renderer-CORS laden.
 * Rückgabe: { ok, dataUrl } – dataUrl ist raw data:…; Kompression im Renderer.
 */
ipcMain.handle('dienstreise:fetch-image-data-url', async (_event, rawUrl) => {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  try {
    const { net } = require('electron');
    let referer = '';
    try {
      referer = new URL(url).origin + '/';
    } catch (_) {
      referer = '';
    }
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const headerVariants = [
      { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'User-Agent': ua },
      {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': ua,
        ...(referer ? { Referer: referer } : {}),
      },
      {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': ua,
        Referer: 'https://outlook.office.com/',
      },
    ];
    let lastErr = 'fetch_failed';
    for (const headers of headerVariants) {
      try {
        const response = await net.fetch(url, { method: 'GET', headers });
        if (!response.ok) {
          lastErr = 'http_' + response.status;
          continue;
        }
        const contentType = String(response.headers.get('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const ab = await response.arrayBuffer();
        const buf = Buffer.from(ab);
        if (!buf.length || buf.length > 12 * 1024 * 1024) {
          lastErr = 'size';
          continue;
        }
        const looksLikeImage =
          (buf[0] === 0xff && buf[1] === 0xd8) ||
          (buf[0] === 0x89 && buf[1] === 0x50) ||
          (buf[0] === 0x47 && buf[1] === 0x49) ||
          (buf[0] === 0x52 && buf[1] === 0x49);
        if (
          contentType &&
          !/^image\//i.test(contentType) &&
          contentType !== 'application/octet-stream' &&
          !looksLikeImage
        ) {
          lastErr = 'not_image:' + contentType;
          continue;
        }
        let mime = contentType && /^image\//i.test(contentType) ? contentType : 'image/png';
        if (mime === 'application/octet-stream' || !/^image\//i.test(mime)) {
          if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
          else if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
          else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
          else if (buf[0] === 0x52 && buf[1] === 0x49) mime = 'image/webp';
          else mime = 'image/png';
        }
        return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
      } catch (inner) {
        lastErr = inner && inner.message ? inner.message : String(inner);
      }
    }
    console.warn('[fetch-image]', url.slice(0, 100), '→', lastErr);
    return { ok: false, error: lastErr };
  } catch (e) {
    console.warn('[fetch-image] exception', e && e.message ? e.message : e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

/** Outlook/Windows: Bild direkt aus der nativen Zwischenablage. */
ipcMain.handle('dienstreise:clipboard-read-image', async () => {
  try {
    const img = clipboard.readImage();
    if (!img || typeof img.isEmpty !== 'function' || img.isEmpty()) {
      return { ok: false, error: 'empty' };
    }
    const size = img.getSize ? img.getSize() : { width: 0, height: 0 };
    if (!size.width || !size.height) return { ok: false, error: 'empty_size' };
    const dataUrl = img.toDataURL();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) return { ok: false, error: 'no_data' };
    return { ok: true, dataUrl: dataUrl, width: size.width, height: size.height };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

/** file://-Pfade aus Outlook-HTML (lokaler Bild-Cache). */
ipcMain.handle('dienstreise:read-local-image', async (_event, fileUrlOrPath) => {
  try {
    let p = typeof fileUrlOrPath === 'string' ? fileUrlOrPath.trim() : '';
    if (!p) return { ok: false, error: 'empty' };
    if (/^file:/i.test(p)) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, '').replace(/^localhost\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));
      } catch (_) {
        p = p.replace(/^file:\/\/\/?/i, '').replace(/^localhost\//i, '').replace(/^\/([A-Za-z]:)/, '$1');
      }
    }
    p = path.normalize(p);
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return { ok: false, error: 'not_found' };
    }
    const buf = fs.readFileSync(p);
    if (!buf.length || buf.length > 12 * 1024 * 1024) return { ok: false, error: 'size' };
    const ext = path.extname(p).toLowerCase();
    let mime = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
    else if (ext === '.gif') mime = 'image/gif';
    else if (ext === '.webp') mime = 'image/webp';
    else if (ext === '.bmp') mime = 'image/bmp';
    else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('open-external', async (event, url) => {
  if (typeof url !== 'string' || !url.trim()) return;
  await shell.openExternal(url.trim());
});

ipcMain.handle('image-gallery:open', async (_event, payload) => {
  if (!imageGalleryWindows) {
    imageGalleryWindows = createImageGalleryWindowManager(() => mainWindow, () => PORT);
  }
  return imageGalleryWindows.openImageGallery(payload || {});
});

ipcMain.handle('laptop:set-update-feed', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const base = (p.dispoBaseUrl || p.baseUrl || '').trim();
  const insecure = !!(p.allowInsecureTls || p.insecureTls);
  return setUpdateFeedFromDispoBase(base, insecure);
});

ipcMain.handle('laptop:update-check-now', async (_event, opts) => checkForUpdatesNow(opts));

ipcMain.handle('laptop:update-start-download', async () => {
  await startDownload();
  return { ok: true };
});

ipcMain.handle('laptop:update-install-now', async () => {
  installUpdateNow();
  return { ok: true };
});

ipcMain.handle('app:self-uninstall-remove-data', async () => scheduleSelfUninstallAndDataRemoval());

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (trustCertificateForUrl(url) || isInsecureTlsAllowed()) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  Menu.setApplicationMenu(null);
  installLocalGatewayWebRequest(PORT);
  configureSpellCheckerSession();
  imageGalleryWindows = createImageGalleryWindowManager(() => mainWindow, () => PORT);
  pdfViewerWindows = createPdfViewerWindowManager(() => mainWindow);
  anlagenstammAkteWindows = createAnlagenstammAkteWindowManager(() => mainWindow, () => PORT);
  initLaptopUpdater({ getMainWindow: () => mainWindow });
  getDb().then((db) => {
    const serverApp = createApp(db);
    const http = require('http');
    const server = http.createServer(serverApp);
    server.on('error', (err) => {
      console.error('Server-Start fehlgeschlagen:', err);
      const busy = err && err.code === 'EADDRINUSE';
      dialog.showErrorBox(
        'Monteur WebApp',
        busy
          ? 'Port 39678 ist belegt. Die App läuft vermutlich schon — bitte vorhandenes Fenster prüfen oder den Prozess in der Taskleiste beenden.'
          : ('Lokaler Server konnte nicht starten: ' + ((err && err.message) || String(err))),
      );
      app.quit();
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Monteur WebApp lokal auf http://127.0.0.1:' + PORT);
      console.log('[monteur] Lokaler API-Server: Anlagenstamm POST /api/anlagenstamm_search – nach Update App neu starten, falls 404.');
      createWindow();
      scheduleUpdateCheck();
    });
  }).catch((err) => {
    console.error('DB-Start fehlgeschlagen:', err);
    dialog.showErrorBox('Monteur WebApp', 'Datenbank konnte nicht geöffnet werden: ' + ((err && err.message) || String(err)));
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  flushMonteurDb();
});

app.on('window-all-closed', () => {
  flushMonteurDb();
  app.quit();
});
