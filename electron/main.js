const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { createApp, getDb, PORT } = require('./server');

let mainWindow;
let updateCheckStarted = false;

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
  const checkUrlRaw = (process.env.KUKLA_LAPTOP_UPDATE_CHECK_URL || '').trim();
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
  if (typeof filePath !== 'string' || !filePath.trim()) return;
  await shell.openPath(filePath.trim());
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
