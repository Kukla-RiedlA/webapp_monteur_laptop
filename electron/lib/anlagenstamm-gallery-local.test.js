'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  GALLERY_MAX,
  walkRasterFiles,
  classifyGalleryRel,
  galleryParentFolder,
  galleryFabKey,
  isMontageJobPhoto,
  folderMatchesOtherFab,
  listMontageRastersFromDokumenteMonteurPaths,
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

  it('ordnet Montage-Pfad und Kameraname der Gruppe Montage mit Datum zu', () => {
    assert.equal(
      galleryParentFolder(
        'Montage/2026-08-31_IPS_Kunde/Bilder/12304_2026-09-01_11-00-52.jpg',
        '12304_2026-09-01_11-00-52.jpg',
        '12304',
      ),
      'Montage / 2026-08-31',
    );
    assert.equal(
      galleryParentFolder('Bilder/12304/12304_2026-09-01_11-00-52.jpg', '12304_2026-09-01_11-00-52.jpg', '12304'),
      'Montage / 2026-09-01',
    );
    assert.equal(isMontageJobPhoto('Bilder/12304/IMG_8479.JPG', 'IMG_8479.JPG', '12304'), false);
    assert.equal(folderMatchesOtherFab('2026-08-31_IPS_Kunde', '12304'), false);
    assert.equal(folderMatchesOtherFab('Montage', '12304'), false);
    assert.equal(galleryFabKey('12304_IPS Makina'), '12304');
    const galSuff = buildLocalAnlagenstammGallery('12304 extra', [
      dirNode('Bilder', [dirNode('12304', [fileNode('IMG_1.JPG', 'Bilder/12304/IMG_1.JPG')])]),
    ]);
    assert.equal(galSuff.length, 1);
  });

  it('behaelt Montage-Fotos auch wenn das FN-Archiv GALLERY_MAX fuellt', () => {
    const ownKids = [];
    for (let i = 0; i < 20; i += 1) {
      ownKids.push(fileNode('own' + i + '.jpg', 'Bilder/12304/own' + i + '.jpg'));
    }
    const tree = [
      dirNode('Bilder', [dirNode('12304', ownKids)]),
      dirNode('Montage', [
        dirNode('2026-08-31_AO', [
          dirNode('Bilder', [
            fileNode(
              '12304_2026-09-01_11-00-52.jpg',
              'Montage/2026-08-31_AO/Bilder/12304_2026-09-01_11-00-52.jpg',
            ),
          ]),
        ]),
      ]),
    ];
    const gallery = buildLocalAnlagenstammGallery('12304', tree, { max: 8 });
    const montage = gallery.filter((g) => String(g.parent_folder || '').startsWith('Montage'));
    assert.equal(montage.length, 1);
    assert.equal(montage[0].parent_folder, 'Montage / 2026-08-31');
    assert.ok(gallery.some((g) => String(g.rel_path).startsWith('Bilder/12304/')));
  });

  it('nimmt lokale Auftragsfotos extraFiles und filtert fremde FN', () => {
    const extra = [
      {
        name: '12304_2026-09-01_11-00-52.jpg',
        rel: 'Dokumente_Monteur/12304_Kunde/Montage/2026-08-31_AO/Bilder/12304_2026-09-01_11-00-52.jpg',
      },
      {
        name: '12305_2026-09-02_09-57-08.jpg',
        rel: 'Dokumente_Monteur/12304_Kunde/Montage/2026-08-31_AO/Bilder/12305_2026-09-02_09-57-08.jpg',
      },
    ];
    const gallery = buildLocalAnlagenstammGallery('12304', [], { extraFiles: extra });
    assert.equal(gallery.length, 1);
    assert.equal(gallery[0].parent_folder, 'Montage / 2026-08-31');
    assert.ok(gallery[0].rel_path.includes('12304_2026-09-01'));
  });

  it('listet Montage-Bilder nur aus bekannten FN-Ordnern, ohne Tiefenscan', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kukla-gal-'));
    const dm = path.join(tmp, 'Dokumente_Monteur');
    const bilder = path.join(dm, '12304_Kunde', 'Montage', '2026-08-31_AO', 'Bilder');
    fs.mkdirSync(bilder, { recursive: true });
    fs.writeFileSync(path.join(bilder, '12304_2026-09-01_11-00-52.jpg'), 'x');
    fs.writeFileSync(path.join(bilder, '12305_2026-09-02_09-57-08.jpg'), 'x');
    const listed = listMontageRastersFromDokumenteMonteurPaths([{ dm, jobId: 166 }], '12304', { max: 80 });
    assert.equal(listed.length, 1);
    assert.ok(listed[0].rel.includes('12304_2026-09-01_11-00-52.jpg'));
    fs.rmSync(tmp, { recursive: true, force: true });
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
    assert.ok(fill[0].includes('skipDeepSearch: true'));
    assert.equal(fill[0].includes('skipDeepSearch: false'), false);
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
