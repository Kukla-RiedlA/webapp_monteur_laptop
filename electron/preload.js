const { contextBridge, ipcRenderer } = require('electron');

/** Erlaubte IPC-Kanäle für generisches invoke (Fallback, falls expose-Inkompatibilität). */
const IPC_INVOKE_ALLOW = new Set(['anlagenstamm:search', 'anlagenstamm:save']);

contextBridge.exposeInMainWorld('monteurApp', {
  apiBase: 'http://127.0.0.1:' + 39678,
  platform: process.platform,
  chooseDienstreiseBasePath: () => ipcRenderer.invoke('dienstreise:choose-folder'),
  openPath: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
  /** TED/Mechanik-Excel: gleicher IPC, dokumentiert als Excel-Öffnen (EXCEL.EXE zuerst unter Windows). */
  openExcel: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
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
  setUpdateFeedBase: (dispoBaseUrl, allowInsecureTls) =>
    ipcRenderer.invoke('laptop:set-update-feed', {
      dispoBaseUrl: dispoBaseUrl,
      allowInsecureTls: !!allowInsecureTls,
    }),
  checkForAppUpdates: (opts) => ipcRenderer.invoke('laptop:update-check-now', opts || {}),
  startAppUpdateDownload: () => ipcRenderer.invoke('laptop:update-start-download'),
  installAppUpdateNow: () => ipcRenderer.invoke('laptop:update-install-now'),
  uninstallAppAndRemoveLocalData: () => ipcRenderer.invoke('app:self-uninstall-remove-data'),
  onAppUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('laptop:update-status', handler);
    return () => ipcRenderer.removeListener('laptop:update-status', handler);
  },
});
