const { contextBridge, ipcRenderer } = require('electron');

/** Erlaubte IPC-Kanäle für generisches invoke (Fallback, falls expose-Inkompatibilität). */
const IPC_INVOKE_ALLOW = new Set(['anlagenstamm:search', 'anlagenstamm:save', 'anlagenstamm:open-akte-window', 'anlagenstamm:notify-saved']);

contextBridge.exposeInMainWorld('monteurApp', {
  apiBase: 'http://127.0.0.1:' + 39678,
  platform: process.platform,
  chooseDienstreiseBasePath: () => ipcRenderer.invoke('dienstreise:choose-folder'),
  openPath: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
  /** TED/Mechanik-Excel: gleicher IPC, dokumentiert als Excel-Öffnen (EXCEL.EXE zuerst unter Windows). */
  openExcel: (filePath) => ipcRenderer.invoke('dienstreise:open-path', filePath),
  /** PDF im eigenen Electron-Fenster (Chromium-Viewer, ohne Acrobat). */
  openPdf: (filePath) => ipcRenderer.invoke('pdf:open-viewer', filePath),
  openWithDialog: (filePath) => ipcRenderer.invoke('dienstreise:open-with-dialog', filePath),
  saveFileAs: (filePath, defaultName) => ipcRenderer.invoke('dienstreise:save-file-as', filePath, defaultName),
  showFileContextMenu: (spec) => ipcRenderer.invoke('dienstreise:file-context-menu', spec),
  showItemInFolder: (filePath) => ipcRenderer.invoke('dienstreise:show-in-folder', filePath),
  copyPathToClipboard: (filePath) => ipcRenderer.invoke('dienstreise:copy-path', filePath),
  /** Native Zwischenablage-Bild (Outlook „Bild kopieren“) → Data-URL. */
  readClipboardImage: () => ipcRenderer.invoke('dienstreise:clipboard-read-image'),
  /** Lokale file://-Bilder aus Outlook-HTML lesen. */
  readLocalImageFile: (fileUrlOrPath) => ipcRenderer.invoke('dienstreise:read-local-image', fileUrlOrPath),
  /** Remote-Bild (z. B. aus E-Mail-HTML) ohne CORS laden → Data-URL. */
  fetchImageDataUrl: (url) => ipcRenderer.invoke('dienstreise:fetch-image-data-url', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openImageGallery: (payload) => ipcRenderer.invoke('image-gallery:open', payload),
  anlagenstammSearch: (payload) => ipcRenderer.invoke('anlagenstamm:search', payload),
  anlagenstammSave: (payload) => ipcRenderer.invoke('anlagenstamm:save', payload),
  openAnlagenstammAkteWindow: (opts) => ipcRenderer.invoke('anlagenstamm:open-akte-window', opts || {}),
  openBugReport: () => ipcRenderer.invoke('bug-report:open'),
  setBugReportAlwaysOnTop: (on) => ipcRenderer.invoke('bug-report:always-on-top', !!on),
  notifyAnlagenstammSaved: (payload) => ipcRenderer.invoke('anlagenstamm:notify-saved', payload || {}),
  onAnlagenstammSaved: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('anlagenstamm-saved', handler);
    return () => ipcRenderer.removeListener('anlagenstamm-saved', handler);
  },
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
