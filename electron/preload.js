const { contextBridge, ipcRenderer } = require('electron');

/** Erlaubte IPC-Kanäle für generisches invoke (Fallback, falls expose-Inkompatibilität). */
const IPC_INVOKE_ALLOW = new Set(['anlagenstamm:search', 'anlagenstamm:save']);

contextBridge.exposeInMainWorld('monteurApp', {
  apiBase: 'http://127.0.0.1:' + 39678,
  platform: process.platform,
  chooseDienstreiseBasePath: () => ipcRenderer.invoke('dienstreise:choose-folder'),
  openPath: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
  copyPathToClipboard: (filePath) => ipcRenderer.invoke('dienstreise:copy-path', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  anlagenstammSearch: (payload) => ipcRenderer.invoke('anlagenstamm:search', payload),
  anlagenstammSave: (payload) => ipcRenderer.invoke('anlagenstamm:save', payload),
  ipcInvoke: (channel, payload) => {
    if (typeof channel !== 'string' || !IPC_INVOKE_ALLOW.has(channel)) {
      return Promise.reject(new Error('IPC channel nicht erlaubt.'));
    }
    return ipcRenderer.invoke(channel, payload);
  },
});
