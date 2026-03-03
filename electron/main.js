const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const { createApp, getDb, PORT } = require('./server');

let mainWindow;

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
