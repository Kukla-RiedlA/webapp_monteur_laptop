'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  GALLERY_MAX,
  walkRasterFiles,
  classifyGalleryRel,
  buildLocalAnlagenstammGallery,
} = require('./anlagenstamm-gallery-local');
const { registerAnlagenstammPhpRoutes } = require('./anlagenstamm-php-routes');

function fileNode(name, rel) {
  return { type: 'file', name, rel };
}

function dirNode(name, children) {
  return { type: 'dir', name, children };
}

function mockApp() {
  const handlers = {};
  return {
    handlers,
    get(p, h) {
      handlers[p] = h;
    },
    post(p, h) {
      handlers[p] = h;
    },
  };
}

function jsonRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('Anlagenstamm-Galerie lokal', () => {
  it('classifyGalleryRel unterscheidet own/other/unassigned', () => {
    assert.equal(classifyGalleryRel('10584/IMG_9100.JPG', '10584'), 'own');
    assert.equal(classifyGalleryRel('10583/IMG_9032.JPG', '10584'), 'other');
    assert.equal(classifyGalleryRel('Fotos/gemeinsam.JPG', '10584'), 'unassigned');
  });

  it('zeigt nur die gewaehlte FN, Geschwister-FNs nicht', () => {
    const tree = [
      dirNode('Projekt', [
        dirNode('10582', [fileNode('IMG_9016.JPG', '10582/IMG_9016.JPG')]),
        dirNode('10583', [fileNode('IMG_9032.JPG', '10583/IMG_9032.JPG')]),
        dirNode('10584', [fileNode('IMG_9100.JPG', '10584/IMG_9100.JPG')]),
        dirNode('Fotos', [fileNode('gemeinsam.JPG', 'Fotos/gemeinsam.JPG')]),
      ]),
    ];
    const gallery = buildLocalAnlagenstammGallery('10584', tree);
    const rels = gallery.map((g) => g.rel_path).sort();
    assert.deepEqual(rels, ['10584/IMG_9100.JPG', 'Fotos/gemeinsam.JPG']);
  });

  it('Bereichsordner der FN bleibt, fremder Bereich nicht', () => {
    const tree = [
      dirNode('10582 - 10584', [fileNode('a.JPG', '10582 - 10584/a.JPG')]),
      dirNode('10590 - 10592', [fileNode('b.JPG', '10590 - 10592/b.JPG')]),
    ];
    const gallery = buildLocalAnlagenstammGallery('10584', tree);
    assert.deepEqual(
      gallery.map((g) => g.rel_path),
      ['10582 - 10584/a.JPG'],
    );
  });

  it('bevorzugt FN-Bilder vor unzugeordneten bis GALLERY_MAX', () => {
    const ownKids = [];
    for (let i = 0; i < 8; i += 1) {
      ownKids.push(fileNode('own' + i + '.jpg', '10584/own' + i + '.jpg'));
    }
    const otherKids = [];
    for (let i = 0; i < 40; i += 1) {
      otherKids.push(fileNode('o' + i + '.jpg', '10583/o' + i + '.jpg'));
    }
    const tree = [dirNode('10583', otherKids), dirNode('10584', ownKids)];
    const gallery = buildLocalAnlagenstammGallery('10584', tree, { max: 8 });
    assert.equal(gallery.length, 8);
    assert.ok(gallery.every((g) => String(g.rel_path).startsWith('10584/')));
  });

  it('bricht den Raster-Walk bei GALLERY_MAX ab', () => {
    const children = [];
    for (let i = 0; i < GALLERY_MAX + 40; i += 1) {
      children.push(fileNode('img' + i + '.jpg', 'Montage/A/img' + i + '.jpg'));
    }
    const tree = [dirNode('Stamm', children)];
    const files = [];
    walkRasterFiles(tree, files, GALLERY_MAX);
    assert.equal(files.length, GALLERY_MAX);
    const gallery = buildLocalAnlagenstammGallery('12304', tree);
    assert.equal(gallery.length, GALLERY_MAX);
  });

  it('Galerie-Route nutzt nur den SQLite-Cache, keinen OneDrive-Scan', () => {
    const app = mockApp();
    let buildCalls = 0;
    registerAnlagenstammPhpRoutes(app, {
      db: {},
      getTechnicianId: () => '14',
      readAnlagenstammTreeCache: () => ({
        tree: [fileNode('foto.jpg', 'Montage/A/foto.jpg')],
      }),
      buildLocalProjekteNeuTreeForFab: () => {
        buildCalls += 1;
        throw new Error('onedrive_scan_forbidden');
      },
    });
    const res = jsonRes();
    app.handlers['/api/anlagenstamm_gallery.php']({ query: { fab: '12304' } }, res);
    assert.equal(buildCalls, 0);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source, 'local_cache');
    assert.equal(res.body.gallery.length, 1);
  });

  it('leerer Cache liefert leere Galerie ohne Tree-Builder', () => {
    const app = mockApp();
    let buildCalls = 0;
    registerAnlagenstammPhpRoutes(app, {
      db: {},
      getTechnicianId: () => '14',
      readAnlagenstammTreeCache: () => null,
      buildLocalProjekteNeuTreeForFab: () => {
        buildCalls += 1;
        throw new Error('onedrive_scan_forbidden');
      },
    });
    const res = jsonRes();
    app.handlers['/api/anlagenstamm_gallery.php']({ query: { fab: '12304' } }, res);
    assert.equal(buildCalls, 0);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source, 'local_cache_empty');
    assert.equal(res.body.gallery.length, 0);
  });
});

describe('Galerie-Request-Pfad ohne OneDrive', () => {
  it('server.js fuellt Thumbs nicht aus OneDrive-Vollbildern', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fill = serverSrc.match(
      /async function fillProjekteNeuThumbCache[\s\S]*?\n  function enqueueProjekteNeuThumbFill/,
    );
    assert.ok(fill, 'fillProjekteNeuThumbCache nicht gefunden');
    assert.equal(fill[0].includes('resolveProjekteNeuLocalFilePathAll'), false);
    const cacheFn = serverSrc.match(
      /function cacheProjekteNeuTreesForJob[\s\S]*?\n  function resolveLocalJobIdForFab/,
    );
    assert.ok(cacheFn, 'cacheProjekteNeuTreesForJob nicht gefunden');
    assert.equal(cacheFn[0].includes('scanProjekteNeuTree'), false);
  });

  it('gallery.php-Handler ruft keinen lokalen Tree-Scan auf', () => {
    const routesSrc = fs.readFileSync(path.join(__dirname, 'anlagenstamm-php-routes.js'), 'utf8');
    const gallery = routesSrc.match(
      /app\.get\('\/api\/anlagenstamm_gallery\.php'[\s\S]*?app\.get\('\/api\/anlagenstamm_files_list\.php'/,
    );
    assert.ok(gallery, 'gallery-Handler nicht gefunden');
    assert.equal(gallery[0].includes('buildLocalProjekteNeuTreeForFab'), false);
  });
});
