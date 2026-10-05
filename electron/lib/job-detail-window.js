'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const { attachEditContextMenu } = require('./edit-context-menu');

function windowKey(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const viewOnly = p.viewOnly ? '1' : '0';
  const id = p.viewOnly
    ? String(p.serverJobId || p.jobId || '')
    : String(p.jobId || p.serverJobId || '');
  const tech = String(p.calendarTechnicianId || 0);
  return viewOnly + ':' + id + ':' + tech;
}

function createJobDetailWindowManager(getPort) {
  const windows = new Map();

  async function openJobDetailWindow(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const key = windowKey(p);
    const idNum = parseInt(p.viewOnly ? p.serverJobId || p.jobId : p.jobId || p.serverJobId, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) return { ok: false, error: 'job_id' };

    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { ok: true, focused: true };
    }

    const port = typeof getPort === 'function' ? getPort() : getPort;
    if (!port) return { ok: false, error: 'port_missing' };

    const qs = new URLSearchParams();
    qs.set('job_window', '1');
    if (p.jobId) qs.set('job_id', String(p.jobId));
    if (p.serverJobId) qs.set('server_id', String(p.serverJobId));
    if (p.viewOnly) qs.set('view_only', '1');
    if (p.calendarTechnicianId) qs.set('calendar_tech', String(p.calendarTechnicianId));
    const title = String(p.title || 'Auftrag').trim() || 'Auftrag';
    qs.set('title', title);

    const win = new BrowserWindow({
      width: 1240,
      height: 900,
      minWidth: 860,
      minHeight: 560,
      title: title,
      modal: false,
      show: true,
      backgroundColor: '#f4f7f5',
      autoHideMenuBar: true,
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
    const url = 'http://127.0.0.1:' + port + '/?' + qs.toString();
    win.loadURL(url).catch(() => {});
    return { ok: true };
  }

  return { openJobDetailWindow };
}

module.exports = { createJobDetailWindowManager, windowKey };
