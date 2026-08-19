'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const { attachEditContextMenu } = require('./edit-context-menu');

function windowKey(opts) {
  const id = opts && opts.id != null && String(opts.id).trim() !== '' ? String(opts.id).trim() : '';
  const fab = opts && opts.fab ? String(opts.fab).trim() : '';
  if (id) return 'id:' + id;
  if (fab) return 'fab:' + fab.toLowerCase();
  return 'new';
}

function createAnlagenstammAkteWindowManager(getMainWindow, getPort) {
  const windows = new Map();

  function notifyListSaved(payload) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    if (main && !main.isDestroyed()) {
      main.webContents.send('anlagenstamm-saved', payload || {});
    }
  }

  async function openAnlagenstammAkteWindow(opts = {}) {
    const key = windowKey(opts);
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { ok: true, focused: true };
    }

    const port = typeof getPort === 'function' ? getPort() : getPort;
    const qs = new URLSearchParams();
    qs.set('akte_window', '1');
    if (opts.id != null && String(opts.id).trim() !== '') qs.set('id', String(opts.id).trim());
    if (opts.fab) qs.set('fab', String(opts.fab).trim());
    if (opts.readOnly) qs.set('ro', '1');
    const url = `http://127.0.0.1:${port}/anlagenstamm-akte-window.html?${qs.toString()}`;

    const main = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    const win = new BrowserWindow({
      width: 1100,
      height: 900,
      title: opts.fab ? ('Anlagenakte · ' + opts.fab) : 'Anlagenakte',
      parent: main || undefined,
      modal: false,
      backgroundColor: '#f5f5f5',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    windows.set(key, win);
    win.on('closed', () => {
      if (windows.get(key) === win) windows.delete(key);
    });
    attachEditContextMenu(win.webContents);
    await win.loadURL(url);
    return { ok: true };
  }

  return { openAnlagenstammAkteWindow, notifyListSaved };
}

module.exports = { createAnlagenstammAkteWindowManager, windowKey };
