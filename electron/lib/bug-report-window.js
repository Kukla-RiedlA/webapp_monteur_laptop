'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');
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

function isBoundsOnScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  const w = Number(b.width) || 480;
  const h = Number(b.height) || 720;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea || d.bounds;
    const overlapX = b.x < a.x + a.width && b.x + w > a.x;
    const overlapY = b.y < a.y + a.height && b.y + h > a.y;
    const visibleW = Math.min(b.x + w, a.x + a.width) - Math.max(b.x, a.x);
    const visibleH = Math.min(b.y + h, a.y + a.height) - Math.max(b.y, a.y);
    return overlapX && overlapY && visibleW >= 80 && visibleH >= 80;
  });
}

function clampToWorkArea(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    const a = d.workArea;
    const w = Math.min(Math.max(400, b.width), a.width);
    const h = Math.min(Math.max(560, b.height), a.height);
    const x = Math.max(a.x, Math.min(b.x, a.x + a.width - w));
    const y = Math.max(a.y, Math.min(b.y, a.y + a.height - h));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  } catch (_) { /* ignore */ }
}

function placeBesideMain(target, getMainWindow) {
  const main = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
  if (!target || target.isDestroyed()) return;
  try {
    const tb = target.getBounds();
    const display = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
    const a = display.workArea;
    const w = Math.min(Math.max(400, tb.width), a.width);
    const h = Math.min(Math.max(560, tb.height), a.height);
    let x = a.x + a.width - w - 12;
    let y = a.y + 48;
    if (main && !main.isDestroyed()) {
      const b = main.getBounds();
      const right = b.x + b.width + 8;
      const left = b.x - w - 8;
      y = Math.max(a.y, Math.min(b.y + 40, a.y + a.height - h));
      if (right + w <= a.x + a.width) {
        x = right;
      } else if (left >= a.x) {
        x = left;
      }
    }
    target.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  } catch (_) {
    clampToWorkArea(target);
  }
}

function raiseWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  clampToWorkArea(win);
  win.show();
  win.moveTop();
  win.focus();
}

function createBugReportWindowManager(getMainWindow, getPort, getUserDataDir) {
  let win = null;

  async function openBugReportWindow() {
    const port = typeof getPort === 'function' ? getPort() : getPort;
    const url = `http://127.0.0.1:${port}/bug-report.html`;
    const userDataDir = typeof getUserDataDir === 'function' ? getUserDataDir() : getUserDataDir;

    if (win && !win.isDestroyed()) {
      raiseWindow(win);
      return { ok: true, focused: true };
    }

    const saved = userDataDir ? loadBounds(userDataDir) : null;
    const useSaved = !!(saved && isBoundsOnScreen(saved));
    win = new BrowserWindow({
      width: saved && saved.width ? saved.width : 480,
      height: saved && saved.height ? saved.height : 720,
      minWidth: 400,
      minHeight: 560,
      x: useSaved ? saved.x : undefined,
      y: useSaved ? saved.y : undefined,
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
    try {
      await win.loadURL(url);
    } catch (e) {
      console.error('[bug-report] loadURL', e && e.message ? e.message : e);
    }
    if (useSaved) {
      clampToWorkArea(win);
    } else {
      placeBesideMain(win, getMainWindow);
    }
    if (saved && saved.pin) {
      win.setAlwaysOnTop(true, 'floating');
    }
    raiseWindow(win);
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
