const { app, BrowserWindow } = require('electron');
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
