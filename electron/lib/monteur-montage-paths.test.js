'use strict';

/**
 * Lazy-mkdir: Layout darf keine leeren FN-/Montage-/Foto-Ordner anlegen.
 * node --test lib/monteur-montage-paths.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ensureAnlageFnDirs,
  ensureMonteurMontageDirs,
  ensureMonteurPhotoCategoryDirs,
  alignMonteurMontageDirs,
  migrateAliasFnFolders,
  migrateTopLevelMontageIntoFnFolders,
  expandTopLevelMontageRelToFnFolders,
  mapServerManifestPathToLocalAnlageRel,
} = require('./monteur-montage-paths');

function tmpReise() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-montage-'));
  fs.mkdirSync(path.join(dir, 'Dokumente_Monteur'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Dokumente_Anlage'), { recursive: true });
  return dir;
}

function listDirs(base) {
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('monteur-montage-paths lazy mkdir', () => {
  let reiseDir;
  beforeEach(() => {
    reiseDir = tmpReise();
  });
  afterEach(() => {
    try {
      fs.rmSync(reiseDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('ensureAnlageFnDirs legt keine leeren FN-Ordner an', async () => {
    await ensureAnlageFnDirs(reiseDir, [
      { fab: '7118', folder_name_canonical: '7118_Kunde_Ort_DE' },
    ]);
    assert.deepEqual(listDirs(path.join(reiseDir, 'Dokumente_Anlage')), []);
  });

  it('ensureMonteurPhotoCategoryDirs legt Allgemein/Angebot nicht an', () => {
    ensureMonteurPhotoCategoryDirs(reiseDir, '2026-06-01_Firma_Ort_DE_Monteur');
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', 'Montage')), false);
  });

  it('ensureMonteurMontageDirs legt keine leeren FN-Montage-Bäume an', async () => {
    await ensureMonteurMontageDirs(
      reiseDir,
      [{ fab: '7118', folder_name_canonical: '7118_Kunde_Ort_DE' }],
      '2026-06-01_Firma_Ort_DE_Mustermann',
      { technicianDisplayName: 'Mustermann' },
    );
    assert.deepEqual(listDirs(path.join(reiseDir, 'Dokumente_Monteur')), []);
  });

  it('align benennt vorhandenen Auftragsordner um statt einen zweiten anzulegen', async () => {
    const fn = '7118_Kunde_Ort_DE';
    const montage = path.join(reiseDir, 'Dokumente_Monteur', fn, 'Montage');
    const oldAo = '2026-06-01_Alt_Ort_DE_Mustermann';
    const desired = '2026-06-01_Neu_Ort_DE_Mustermann';
    fs.mkdirSync(path.join(montage, oldAo, 'Protokolle'), { recursive: true });
    fs.writeFileSync(path.join(montage, oldAo, 'Protokolle', 'x.pdf'), 'pdf');

    await alignMonteurMontageDirs(
      reiseDir,
      [{ fab: '7118', folder_name_canonical: fn }],
      desired,
      { technicianDisplayName: 'Mustermann', previousName: oldAo },
    );

    assert.equal(fs.existsSync(path.join(montage, oldAo)), false);
    assert.equal(fs.existsSync(path.join(montage, desired, 'Protokolle', 'x.pdf')), true);
    assert.equal(fs.existsSync(path.join(montage, desired, 'Bilder')), false);
    assert.equal(fs.existsSync(path.join(montage, desired, 'Parameter')), false);
  });

  it('leeres Top-Level-Montage wird entfernt statt neben FN zu stehen', async () => {
    const fn = '12304_IPS_Makina_Merkez_Aksaray_TR';
    const ao = '2026-08-31_IPS_Makina_Merkez_Aksaray_TR_Riedl_Alois';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle'), { recursive: true });
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', 'Montage', ao, 'Bilder', 'Allgemein'), { recursive: true });
    await migrateTopLevelMontageIntoFnFolders(reiseDir, [{ fab: '12304', folder_name_canonical: fn }]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', 'Montage')), false);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle')), true);
  });

  it('PWA-Fotos aus Top-Level-Montage wandern unter die FN', async () => {
    const fn = '12304_IPS_Makina_Merkez_Aksaray_TR';
    const ao = '2026-08-31_IPS_Makina_Merkez_Aksaray_TR_Riedl_Alois';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle'), { recursive: true });
    const src = path.join(reiseDir, 'Dokumente_Monteur', 'Montage', ao, 'Bilder', 'Allgemein');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'Allgemein_2026-09-02.jpg'), 'img');
    await migrateTopLevelMontageIntoFnFolders(reiseDir, [{ fab: '12304', folder_name_canonical: fn }]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', 'Montage')), false);
    assert.equal(
      fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', fn, 'Montage', ao, 'Bilder', 'Allgemein', 'Allgemein_2026-09-02.jpg')),
      true,
    );
  });

  it('expandTopLevelMontageRelToFnFolders mappt PWA-Pfad auf FN', () => {
    const rels = expandTopLevelMontageRelToFnFolders(
      'Dokumente_Monteur/Montage/2026-08-31_AO/Bilder/Allgemein/x.jpg',
      [{ fab: '12304', folder_name_canonical: '12304_Kunde_Ort_TR' }],
    );
    assert.deepEqual(rels, [
      'Dokumente_Monteur/12304_Kunde_Ort_TR/Montage/2026-08-31_AO/Bilder/Allgemein/x.jpg',
    ]);
  });

  it('Bereichs-FN-Fotos werden auf den kanonischen FN-Ordner gemappt', () => {
    const mapped = mapServerManifestPathToLocalAnlageRel(
      'Dokumente_Monteur/12304 - 12313_IPS/Montage/2026-08-31_AO/Bilder/Allgemein/x.jpg',
      [{ fab: '12304', folder_name_canonical: '12304_IPS Makina_Merkez_Aksaray_TR' }],
    );
    assert.equal(
      mapped,
      'Dokumente_Monteur/12304_IPS Makina_Merkez_Aksaray_TR/Montage/2026-08-31_AO/Bilder/Allgemein/x.jpg',
    );
  });

  it('FN-Alias-Migration bleibt (Leerzeichen → kanonisch)', async () => {
    const anlage = path.join(reiseDir, 'Dokumente_Anlage');
    const stale = path.join(anlage, '7118 Kunde Ort DE');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'a.txt'), 'ok');
    await migrateAliasFnFolders(reiseDir, [
      { fab: '7118', folder_name_canonical: '7118_Kunde_Ort_DE' },
    ]);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(path.join(anlage, '7118_Kunde_Ort_DE', 'a.txt')), true);
  });

  it('leerer FN-Alias-Ordner wird entfernt ohne Merge-Log', async () => {
    const anlage = path.join(reiseDir, 'Dokumente_Anlage');
    const can = '7118_Kunde_Ort_DE';
    fs.mkdirSync(path.join(anlage, can), { recursive: true });
    fs.writeFileSync(path.join(anlage, can, 'keep.txt'), 'x');
    fs.mkdirSync(path.join(anlage, '7118'), { recursive: true });
    await migrateAliasFnFolders(reiseDir, [{ fab: '7118', folder_name_canonical: can }]);
    assert.equal(fs.existsSync(path.join(anlage, '7118')), false);
    assert.equal(fs.existsSync(path.join(anlage, can, 'keep.txt')), true);
  });
});
