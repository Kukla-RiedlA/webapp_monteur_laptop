const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('monteurApp', {
  apiBase: 'http://127.0.0.1:' + 39678,
  platform: process.platform,
});
