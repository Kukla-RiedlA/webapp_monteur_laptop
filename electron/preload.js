const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monteurApp', {
  apiBase: 'http://127.0.0.1:' + 39678,
  platform: process.platform,
  chooseDienstreiseBasePath: () => ipcRenderer.invoke('dienstreise:choose-folder'),
  openPath: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
  copyPathToClipboard: (filePath) => ipcRenderer.invoke('dienstreise:copy-path', filePath),
});
