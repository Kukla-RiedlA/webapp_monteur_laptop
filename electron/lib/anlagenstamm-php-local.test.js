'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readTreeCachePn } = require('./anlagenstamm-php-local');

describe('readTreeCachePn', () => {
  it('liest root_folder_name und parst kein tree_json', () => {
    let sql = '';
    const db = {
      prepare(s) {
        sql = s;
        return {
          get() {
            return { root_folder_name: 'Projekt FN 12229' };
          },
        };
      },
    };
    assert.equal(readTreeCachePn(db, '12229'), 'Projekt FN 12229');
    assert.match(sql, /root_folder_name/);
    assert.equal(/tree_json/.test(sql), false);
  });

  it('liefert leer ohne Parse wenn kein Name gesetzt ist', () => {
    const db = {
      prepare() {
        return { get() { return { root_folder_name: '' }; } };
      },
    };
    assert.equal(readTreeCachePn(db, '1'), '');
  });
});

describe('Akte-Fenster und files_list', () => {
  it('Akte-Fenster haengt nicht am Hauptfenster und wartet nicht auf loadURL', () => {
    const src = fs.readFileSync(path.join(__dirname, 'anlagenstamm-akte-window.js'), 'utf8');
    assert.equal(/parent:\s*main/.test(src), false);
    assert.equal(/await win\.loadURL/.test(src), false);
  });

  it('files_list schreibt Cache ohne saveDb auf dem Request-Pfad', () => {
    const src = fs.readFileSync(path.join(__dirname, 'anlagenstamm-php-routes.js'), 'utf8');
    const files = src.match(
      /app\.get\('\/api\/anlagenstamm_files_list\.php'[\s\S]*?app\.get\('\/api\/anlagenstamm_td_pdf_prefill\.php'/,
    );
    assert.ok(files, 'files_list-Handler nicht gefunden');
    assert.equal(files[0].includes('saveDb'), false);
  });

  it('Akte laedt Dateibaum erst wenn Dateien-Tab aktiv ist', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'assets', 'js', 'dispo', 'anlagenstamm.js'),
      'utf8',
    );
    const fn = src.match(/function loadModalFilesForFab\(fab\) \{[\s\S]*?\nfunction fillFormFromRow/);
    assert.ok(fn, 'loadModalFilesForFab nicht gefunden');
    assert.match(fn[0], /data-akte-panel="files"/);
    assert.match(fn[0], /kuklaEnsureAkteFilesLoaded/);
  });
});

describe('Kontrollwiegung Draft-IO', () => {
  it('local_only Autosave legt keinen Dienstreise-Ordner an', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const post = src.match(
      /app\.post\('\/api\/protokolle\/kontrollwiegung'[\s\S]*?app\.post\('\/api\/kontrollwiegungsprotokoll_save'/,
    );
    assert.ok(post, 'POST kontrollwiegung nicht gefunden');
    assert.match(post[0], /wantsLocalOnlyRequest\(body\) \? null/);
  });
});
