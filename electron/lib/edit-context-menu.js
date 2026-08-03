'use strict';

const { Menu, app } = require('electron');

/**
 * Standard-Edit-Kontextmenü (Kopieren/Einfügen …) mit festen deutschen Labels
 * und Rechtschreibvorschlägen (Chromium Spellchecker).
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
    const misspelled = params.misspelledWord ? String(params.misspelledWord) : '';
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.filter((s) => s && String(s).trim())
      : [];

    // Kein leeres Menü auf reinen Flächen ohne Selektion/Edit (außer DevTools).
    if (!isEditable && !hasSelection && !showInspect) return;

    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [];

    if (isEditable && misspelled) {
      if (suggestions.length) {
        for (const suggestion of suggestions) {
          const label = String(suggestion);
          template.push({
            label,
            click: () => {
              if (!webContents.isDestroyed()) webContents.replaceMisspelling(label);
            },
          });
        }
      } else {
        template.push({ label: 'Keine Vorschläge', enabled: false });
      }
      template.push({
        label: 'Zum Wörterbuch hinzufügen',
        click: () => {
          if (webContents.isDestroyed()) return;
          try {
            webContents.session.addWordToSpellCheckerDictionary(misspelled);
          } catch (e) {
            console.warn('[spellcheck] addWord failed:', e && e.message ? e.message : e);
          }
        },
      });
      template.push({ type: 'separator' });
    }

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
