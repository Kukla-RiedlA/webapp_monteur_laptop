'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readTreeCachePn, getAnlagenstammExtrasResponse } = require('./anlagenstamm-php-local');

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
    assert.match(post[0], /localOnlyKw \? null/);
    assert.match(post[0], /pushJsonDraft\(draftPushOpts\)/);
  });

  it('GET zieht Draft ohne Dienstreise-Ordner anzulegen', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const get = src.match(
      /app\.get\('\/api\/protokolle\/kontrollwiegung'[\s\S]*?app\.post\('\/api\/protokolle\/kontrollwiegung'/,
    );
    assert.ok(get, 'GET kontrollwiegung nicht gefunden');
    assert.equal(get[0].includes('getOrCreateDienstreiseFolderForJob'), false);
    assert.match(get[0], /pullOneJsonDraftForJob/);
  });

  it('Draft-Pull braucht keinen Dienstreise-Ordner', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.match(
      /async function pullOneJsonDraftForJob\([\s\S]*?\n  \/\*\* Schreibzugriff blockiert/,
    );
    assert.ok(fn, 'pullOneJsonDraftForJob nicht gefunden');
    assert.equal(/!technicianId \|\| !reiseDir/.test(fn[0]), false);
    assert.match(fn[0], /reiseDir \? resolveMonteurDraftJsonPath/);
  });
});

describe('Montagebericht Draft-IO', () => {
  it('GET legt keinen Dienstreise-Ordner an', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const get = src.match(
      /app\.get\('\/api\/protokolle\/montagebericht'[\s\S]*?app\.post\('\/api\/protokolle\/montagebericht'/,
    );
    assert.ok(get, 'GET montagebericht nicht gefunden');
    assert.match(get[0], /const reiseDir = null/);
    assert.equal(get[0].includes('getOrCreateDienstreiseFolderForJob'), false);
  });

  it('local_only Autosave legt keinen Dienstreise-Ordner an', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const post = src.match(
      /app\.post\('\/api\/protokolle\/montagebericht'[\s\S]*?app\.get\('\/api\/montagebericht_pdf'/,
    );
    assert.ok(post, 'POST montagebericht nicht gefunden');
    assert.match(post[0], /wantsLocalOnlyRequest\(body\) \? null/);
  });
});

describe('Sync-Push Service/IBN', () => {
  it('SERVICE_LIKE_PROTOCOL liegt auf Modulebene fuer pushToServer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const constIdx = src.indexOf('const SERVICE_LIKE_PROTOCOL');
    const createIdx = src.indexOf('function createApp(db)');
    const pushIdx = src.indexOf('async function pushToServer');
    assert.ok(constIdx >= 0 && createIdx > constIdx);
    assert.ok(pushIdx > createIdx);
    assert.match(src.slice(constIdx, createIdx), /inbetriebnahme_save\.php/);
    assert.match(src.slice(pushIdx), /SERVICE_LIKE_PROTOCOL\.inbetriebnahme/);
  });
});

describe('Dokumente: Raster nicht unter Montagebericht', () => {
  it('Frontend entfernt JPG/PNG aus Dokumenten-Kategorien (Galerie)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'assets', 'js', 'dispo', 'anlagenstamm_documents.js'),
      'utf8',
    );
    assert.match(src, /function relocateRasterDocuments/);
    assert.match(src, /relocateRasterDocuments\(data\.categories/);
  });

  it('documents_list.php lädt Dispo-Liste und fällt auf local_fast zurück', () => {
    const src = fs.readFileSync(path.join(__dirname, 'anlagenstamm-php-routes.js'), 'utf8');
    assert.match(src, /app\.get\('\/api\/anlagenstamm_documents_list\.php'/);
    assert.match(src, /fetchDispoApiDocumentsList/);
    assert.match(src, /mergeRemoteDocumentsList/);
    assert.match(src, /source: 'local_fast'/);
    const proxy = fs.readFileSync(path.join(__dirname, 'dispo-html-proxy.js'), 'utf8');
    assert.match(proxy, /\/anlagenstamm_documents_list\.php/);
  });

  it('PHP erkennt Bilder-Ordner und Raster vor Montage-Ordner', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'dispo', 'inc', 'anlagenstamm_doc_categories.php'),
      'utf8',
    );
    assert.match(src, /function anlagenstamm_doc_is_raster/);
    const guess = src.match(/function anlagenstamm_doc_guess_slug[\s\S]*?function anlagenstamm_doc_fn_dir_safe/);
    assert.ok(guess, 'guess_slug nicht gefunden');
    const bilderIdx = guess[0].indexOf("return 'bild'");
    const montageLoop = guess[0].indexOf('$folderMap[$low]');
    assert.ok(bilderIdx >= 0 && montageLoop > bilderIdx);
  });
});

describe('Anlagenstamm-Links aus lokalem Cache', () => {
  it('zeigt Ordnernamen und TED ohne tree_json und ohne Dateisystem', () => {
    const sqls = [];
    const db = {
      prepare(sql) {
        sqls.push(sql);
        if (/PRAGMA table_info\(anlagenstamm_tree_cache\)/.test(sql)) {
          return {
            all() {
              return [
                { name: 'fab' },
                { name: 'root_folder_name' },
                { name: 'content_signature' },
                { name: 'truncated' },
              ];
            },
            run() {},
          };
        }
        if (/FROM anlagenstamm_local/.test(sql)) {
          return {
            all() {
              return [{ fabrikationsnummer: '12346', pn_root_name: '', ted_mechanik: '' }];
            },
            get() {
              return undefined;
            },
            run() {},
          };
        }
        if (/root_folder_name FROM anlagenstamm_tree_cache/.test(sql)) {
          return {
            all() {
              return [{ fab: '12346', root_folder_name: 'Mayrische Hochöfen AG' }];
            },
            run() {},
          };
        }
        if (/job_ted_index/.test(sql)) {
          return {
            all() {
              return [{ fab: '12346', rel_path: 'ted/12446.pdf', file_name: '12446.Pdf' }];
            },
            run() {},
          };
        }
        return { all() { return []; }, get() { return undefined; }, run() {} };
      },
    };
    const res = getAnlagenstammExtrasResponse(db, { fabs: ['12346'] });
    assert.equal(res.success, true);
    assert.equal(res.pn_by_fab['12346'], 'Mayrische Hochöfen AG');
    assert.equal(res.ted_by_fab['12346'][0].file_name, '12446.Pdf');
    assert.equal(sqls.some((s) => /SELECT[\s\S]*tree_json/.test(s)), false);
  });

  it('lädt den Ordnerbaum nur aus dem Sync-Cache', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'anlagenstamm-laptop-bridge.js'),
      'utf8',
    );
    const fn = src.match(/async function fetchPnTreeData\(fab, opts\) \{[\s\S]*?\n  function prefetchPnTree/);
    assert.ok(fn, 'fetchPnTreeData nicht gefunden');
    assert.match(fn[0], /cache_only=1/);
    assert.equal(fn[0].includes('refreshPnTreeInBackground'), false);
    assert.equal(/return fetchPnTreeFromServer\(fabNorm\)/.test(fn[0]), false);
  });

  it('Auftrag zur FN kommt aus der DB, nicht aus jedem OneDrive-Ordner', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.match(/function resolveLocalJobIdForFab\(technicianId, fab\) \{[\s\S]*?\n  \}/);
    assert.ok(fn, 'resolveLocalJobIdForFab nicht gefunden');
    assert.match(fn[0], /fabrikationsnummern/);
    assert.match(fn[0], /matched\.length >= 3/);
    assert.equal(fn[0].includes('dienstreise_pull'), false);
  });

  it('Sync holt TED und Ordnernamen über die Mobile-API', () => {
    const src = fs.readFileSync(path.join(__dirname, 'anlagenstamm-local.js'), 'utf8');
    assert.match(src, /\/api\/mobile\/anlagenstamm_sync_extras\.php/);
    assert.match(src, /function syncAnlagenstammListExtrasFromDispo/);
    assert.match(src, /withListExtras\(/);
  });
});
