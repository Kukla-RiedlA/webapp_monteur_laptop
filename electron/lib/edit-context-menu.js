'use strict';

const { Menu, app } = require('electron');

/**
 * Standard-Edit-Kontextmenü (Kopieren/Einfügen …) mit festen deutschen Labels.
 * Renderer-Handler mit preventDefault (z. B. Dateilisten) unterdrücken das
 * Chromium-Default; dieses Menü erscheint nur, wenn Electron den Event liefert.
 */
function attachEditContextMenu(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.on('context-menu', (_event, params) => {
    if (!params || webContents.isDestroyed()) return;

    const flags = params.editFlags || {};
    const showInspect = !app.isPackaged || process.env.DEBUG === '1';
    const hasSelection = !!(params.selectionText && String(params.selectionText).trim());
    const isEditable = !!params.isEditable;

    // Kein leeres Menü auf reinen Flächen ohne Selektion/Edit (außer DevTools).
    if (!isEditable && !hasSelection && !showInspect) return;

    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [];

    if (isEditable) {
      template.push(
        { label: 'Rückgängig', role: 'undo', enabled: !!flags.canUndo },
        { label: 'Wiederholen', role: 'redo', enabled: !!flags.canRedo },
        { type: 'separator' },
        { label: 'Ausschneiden', role: 'cut', enabled: !!flags.canCut },
        { label: 'Kopieren', role: 'copy', enabled: !!flags.canCopy },
        { label: 'Einfügen', role: 'paste', enabled: !!flags.canPaste },
        { label: 'Alles auswählen', role: 'selectAll', enabled: !!flags.canSelectAll },
      );
    } else if (hasSelection) {
      template.push({ label: 'Kopieren', role: 'copy', enabled: !!flags.canCopy });
    }

    if (showInspect) {
      if (template.length) template.push({ type: 'separator' });
      template.push({
        label: 'Untersuchen',
        click: () => {
          webContents.inspectElement(params.x, params.y);
          if (!webContents.isDevToolsOpened()) webContents.openDevTools({ mode: 'detach' });
        },
      });
    }

    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: require('electron').BrowserWindow.fromWebContents(webContents) || undefined });
  });
}

module.exports = { attachEditContextMenu };
