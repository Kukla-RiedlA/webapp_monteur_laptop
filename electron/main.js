const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { createApp, getDb, getMonteurDb, PORT, performAnlagenstammSave, flushMonteurDb } = require('./server');
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
} = require('./lib/laptop-updater');

let mainWindow;
let updateCheckScheduled = false;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'public', 'icon.png'),
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    if (process.env.DEBUG === '1' || process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
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

ipcMain.handle('dienstreise:choose-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Speicherort für Dienstreisen wählen',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('dienstreise:open-path', async (event, filePath) => {
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
    // TED/Excel: zuerst EXCEL.EXE bzw. COM – nicht Browser oder generische Standard-App.
    if (tryOpenExcelFirst(normalized)) {
      trace('excel-first.ok');
      return { ok: true, via: 'excel' };
    }
    const openResult = await shell.openPath(normalized);
    trace('shell.openPath.result', String(openResult || 'ok'));
    if (typeof openResult === 'string' && openResult.trim()) {
      if (isExcelFile(normalized) && tryOpenExcelFirst(normalized)) {
        return { ok: true, fallback: true, warning: openResult.trim(), via: 'excel' };
      }
      if (!isExcelFile(normalized)) {
        try {
          await shell.openExternal(pathToFileURL(normalized).toString());
          trace('shell.openExternal.fileurl.ok');
          return { ok: true, fallback: true, warning: openResult.trim() };
        } catch (_) { /* weiter unten */ }
      }
      if (win && (tryWindowsStartProcess(normalized) || tryWindowsCmdStart(normalized))) {
        return { ok: true, fallback: true, warning: openResult.trim() };
      }
      trace('all-fallbacks-failed', openResult.trim());
      return { ok: false, error: openResult.trim() };
    }
    trace('shell.openPath.ok');
    return { ok: true };
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
});

ipcMain.handle('dienstreise:copy-path', async (event, filePath) => {
  if (typeof filePath !== 'string') return;
  clipboard.writeText(filePath.trim());
});

ipcMain.handle('open-external', async (event, url) => {
  if (typeof url !== 'string' || !url.trim()) return;
  await shell.openExternal(url.trim());
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
  if (trustCertificateForUrl(url)) {
    event.preventDefault();
    callback(true);
  }
});

app.whenReady().then(() => {
  initLaptopUpdater({ getMainWindow: () => mainWindow });
  getDb().then((db) => {
    const serverApp = createApp(db);
    const http = require('http');
    const server = http.createServer(serverApp);
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Monteur WebApp lokal auf http://127.0.0.1:' + PORT);
      console.log('[monteur] Lokaler API-Server: Anlagenstamm POST /api/anlagenstamm_search – nach Update App neu starten, falls 404.');
      createWindow();
      scheduleUpdateCheck();
    });
  }).catch((err) => {
    console.error('DB-Start fehlgeschlagen:', err);
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
