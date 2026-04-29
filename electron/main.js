const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { createApp, getDb, PORT } = require('./server');

let mainWindow;
let updateCheckStarted = false;

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

function resolveUpdateCheckUrl() {
  const envUrl = (process.env.KUKLA_LAPTOP_UPDATE_CHECK_URL || '').trim();
  if (envUrl) return envUrl;

  // Nutzer-spezifische Konfiguration (auch in installierter App beschreibbar)
  const userConfigPath = path.join(app.getPath('userData'), 'app_config.json');
  const userCfg = readJsonFileSafe(userConfigPath);
  const userUrl = userCfg && typeof userCfg.laptopUpdateCheckUrl === 'string'
    ? userCfg.laptopUpdateCheckUrl.trim()
    : '';
  if (userUrl) return userUrl;

  // Fallback für lokale Entwicklung im Repo
  const localConfigPath = path.join(__dirname, 'db', 'app_config.json');
  const localCfg = readJsonFileSafe(localConfigPath);
  const localUrl = localCfg && typeof localCfg.laptopUpdateCheckUrl === 'string'
    ? localCfg.laptopUpdateCheckUrl.trim()
    : '';
  if (localUrl) return localUrl;

  return '';
}

function readAppVersionLabel() {
  try {
    const file = path.join(__dirname, 'version.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const v = data && typeof data.version === 'string' ? data.version.trim() : '';
    return v || 'V 0.000';
  } catch (e) {
    return 'V 0.000';
  }
}

async function checkForServerInstallerUpdate() {
  if (updateCheckStarted) return;
  updateCheckStarted = true;
  const checkUrlRaw = resolveUpdateCheckUrl();
  if (!checkUrlRaw || typeof fetch !== 'function') return;
  const appVersion = readAppVersionLabel();
  const sep = checkUrlRaw.includes('?') ? '&' : '?';
  const checkUrl = checkUrlRaw + sep + 'current_version=' + encodeURIComponent(appVersion);
  try {
    const r = await fetch(checkUrl, { method: 'GET' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data || data.ok !== true || data.update_available !== true || !data.download_url) return;
    const btn = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      buttons: ['Jetzt herunterladen', 'Später'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update verfügbar',
      message: 'Eine neuere Installer-Version ist verfügbar.',
      detail: 'Installiert: ' + appVersion + '\nNeu: ' + String(data.latest_version || 'unbekannt'),
    });
    if (btn && btn.response === 0) {
      await shell.openExternal(String(data.download_url));
    }
  } catch (e) {
    // kein Abbruch der App bei fehlendem Update-Check
  }
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
  try {
    trace('start', normalized);
    if (!fs.existsSync(normalized)) {
      trace('missing', normalized);
      return { ok: false, error: 'Datei nicht gefunden: ' + normalized };
    }
    trace('exists', normalized);
    const openResult = await shell.openPath(normalized);
    trace('shell.openPath.result', String(openResult || 'ok'));
    if (typeof openResult === 'string' && openResult.trim()) {
      try {
        await shell.openExternal(pathToFileURL(normalized).toString());
        trace('shell.openExternal.fileurl.ok');
        return { ok: true, fallback: true, warning: openResult.trim() };
      } catch (_) {
        if (tryLaunchExcelByCom(normalized)) {
          return { ok: true, fallback: true, warning: openResult.trim() };
        }
        if (tryLaunchExcelDirect(normalized)) {
          return { ok: true, fallback: true, warning: openResult.trim() };
        }
        // Zusätzliche robuste Windows-Fallbacks über Shell-Dateizuordnung.
        if (win && (tryWindowsStartProcess(normalized) || tryWindowsCmdStart(normalized))) {
          return { ok: true, fallback: true, warning: openResult.trim() };
        }
        trace('all-fallbacks-failed', openResult.trim());
        return { ok: false, error: openResult.trim() };
      }
    }
    trace('shell.openPath.ok');
    return { ok: true };
  } catch (e) {
    trace('exception', e && e.message ? e.message : String(e));
    if (tryLaunchExcelByCom(normalized)) {
      return { ok: true, fallback: true, warning: e && e.message ? e.message : String(e) };
    }
    if (tryLaunchExcelDirect(normalized)) {
      return { ok: true, fallback: true, warning: e && e.message ? e.message : String(e) };
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

app.whenReady().then(() => {
  getDb().then((db) => {
    const serverApp = createApp(db);
    const http = require('http');
    const server = http.createServer(serverApp);
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Monteur WebApp lokal auf http://127.0.0.1:' + PORT);
      createWindow();
      setTimeout(checkForServerInstallerUpdate, 6000);
    });
  }).catch((err) => {
    console.error('DB-Start fehlgeschlagen:', err);
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
