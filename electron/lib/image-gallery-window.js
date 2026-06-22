'use strict';

const { BrowserWindow } = require('electron');
const { createImageGallerySession } = require('./image-gallery-sessions');

function createImageGalleryWindowManager(getMainWindow, getPort) {
  const windows = new Set();

  async function openImageGallery(payload) {
    const images = payload && payload.images;
    const index = Math.max(0, parseInt(payload && payload.index, 10) || 0);
    const title = String((payload && payload.title) || 'Bildergalerie').trim() || 'Bildergalerie';
    const sessionId =
      payload && payload.sessionId
        ? String(payload.sessionId).trim()
        : createImageGallerySession(images);
    if (!sessionId) return { ok: false, error: 'no_images' };

    const port = typeof getPort === 'function' ? getPort() : getPort;
    if (!port) return { ok: false, error: 'port_missing' };

    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      title,
      parent: main || undefined,
      backgroundColor: '#141414',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.add(win);
    win.on('closed', () => windows.delete(win));

    const url =
      'http://127.0.0.1:' +
      port +
      '/image-gallery.html?id=' +
      encodeURIComponent(sessionId) +
      '&index=' +
      encodeURIComponent(String(index));
    try {
      await win.loadURL(url);
      return { ok: true, sessionId };
    } catch (e) {
      win.close();
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  return { openImageGallery };
}

module.exports = { createImageGalleryWindowManager };
