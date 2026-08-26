'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow } = require('electron');
const { attachEditContextMenu } = require('./edit-context-menu');

function boundsPath(userDataDir) {
  return path.join(userDataDir, 'bug-report-window.json');
}

function loadBounds(userDataDir) {
  try {
    const p = boundsPath(userDataDir);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch (_) {
    return null;
  }
}

function saveBounds(userDataDir, win) {
  if (!userDataDir || !win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    fs.writeFileSync(
      boundsPath(userDataDir),
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, pin: !!win.isAlwaysOnTop() }),
    );
  } catch (_) { /* ignore */ }
}

function createBugReportWindowManager(getMainWindow, getPort, getUserDataDir) {
  let win = null;

  function placeBesideMain(target) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    if (!main || main.isDestroyed()) return;
    try {
      const b = main.getBounds();
      const w = target.getBounds();
      let x = b.x + b.width + 8;
      let y = Math.max(40, b.y + 40);
      if (x + w.width > b.x + b.width + 2000) {
        x = Math.max(40, b.x - w.width - 8);
      }
      target.setPosition(Math.round(x), Math.round(y));
    } catch (_) { /* ignore */ }
  }

  async function openBugReportWindow() {
    const port = typeof getPort === 'function' ? getPort() : getPort;
    const url = `http://127.0.0.1:${port}/bug-report.html`;
    const userDataDir = typeof getUserDataDir === 'function' ? getUserDataDir() : getUserDataDir;

    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return { ok: true, focused: true };
    }

    const saved = userDataDir ? loadBounds(userDataDir) : null;
    win = new BrowserWindow({
      width: saved && saved.width ? saved.width : 480,
      height: saved && saved.height ? saved.height : 720,
      minWidth: 400,
      minHeight: 560,
      x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
      y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
      title: 'Bugreport',
      parent: undefined,
      modal: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f5f5',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    win.on('closed', () => {
      win = null;
    });
    win.on('close', () => saveBounds(userDataDir, win));
    try {
      attachEditContextMenu(win.webContents);
    } catch (_) { /* optional */ }
    await win.loadURL(url);
    if (!(saved && Number.isFinite(saved.x))) {
      placeBesideMain(win);
    }
    if (saved && saved.pin) {
      win.setAlwaysOnTop(true, 'floating');
    }
    win.show();
    return { ok: true };
  }

  function setAlwaysOnTop(on) {
    if (!win || win.isDestroyed()) return { ok: false };
    win.setAlwaysOnTop(!!on, 'floating');
    return { ok: true, pin: !!win.isAlwaysOnTop() };
  }

  return { openBugReportWindow, setAlwaysOnTop };
}

module.exports = { createBugReportWindowManager };
