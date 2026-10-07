'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const { attachEditContextMenu } = require('./edit-context-menu');

const VIEWS = new Set([
  'start',
  'dienstreise',
  'abrechnung',
  'zeitschreibung',
  'protokolle-arbeitsnachweis',
  'protokolle-montagebericht',
  'protokolle-parameterlisten',
  'protokolle-kontrollwiegungen',
  'protokolle-schleppketten',
  'protokolle-pruefzertifikat',
  'protokolle-inbetriebnahme',
  'protokolle-service',
  'protokolle-kunden',
  'anlagenstamm',
  'abwesenheiten',
  'archiv',
  'einstellungen',
  'textbausteine',
  'arbeitsschritte',
  'arbeitsschritte-ibn',
  'projektdaten',
]);

function windowKey(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const view = String(p.view || '');
  if (view === 'projektdaten') {
    const viewOnly = p.viewOnly ? '1' : '0';
    const id = p.viewOnly
      ? String(p.serverJobId || p.jobId || '')
      : String(p.jobId || p.serverJobId || '');
    return 'projektdaten:' + viewOnly + ':' + id + ':' + String(p.calendarTechnicianId || 0);
  }
  return 'view:' + view;
}

function createPopoutWindowManager(getPort) {
  const windows = new Map();

  async function openPopoutWindow(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const view = String(p.view || '').trim();
    if (!VIEWS.has(view)) return { ok: false, error: 'view' };

    if (view === 'projektdaten') {
      const idNum = parseInt(p.viewOnly ? p.serverJobId || p.jobId : p.jobId || p.serverJobId, 10);
      if (!Number.isFinite(idNum) || idNum <= 0) return { ok: false, error: 'job_id' };
    }

    const key = windowKey(p);
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { ok: true, focused: true };
    }

    const port = typeof getPort === 'function' ? getPort() : getPort;
    if (!port) return { ok: false, error: 'port_missing' };

    const title = String(p.title || 'KUKpit').trim().slice(0, 120) || 'KUKpit';
    const qs = new URLSearchParams();
    qs.set('popout', '1');
    qs.set('view', view);
    qs.set('title', title);
    if (view === 'projektdaten') {
      if (p.jobId) qs.set('job_id', String(p.jobId));
      if (p.serverJobId) qs.set('server_id', String(p.serverJobId));
      if (p.viewOnly) qs.set('view_only', '1');
      if (p.calendarTechnicianId) qs.set('calendar_tech', String(p.calendarTechnicianId));
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
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
    win.loadURL('http://127.0.0.1:' + port + '/?' + qs.toString()).catch(() => {});
    return { ok: true };
  }

  return { openPopoutWindow };
}

module.exports = { createPopoutWindowManager, windowKey };
