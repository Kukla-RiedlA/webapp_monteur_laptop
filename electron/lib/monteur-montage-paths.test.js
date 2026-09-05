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
  looksLikeStaleFnOrProjectHeaderDir,
  removeUnrelatedTopLevelProjectFolders,
  isUsableFnHauptordnerName,
  resolveFabMapLocal,
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

describe('verwaiste Projektköpfe / FN-Ordner', () => {
  let reiseDir;
  beforeEach(() => {
    reiseDir = tmpReise();
  });
  afterEach(() => {
    fs.rmSync(reiseDir, { recursive: true, force: true });
  });

  it('Gyproc-Datumsordner ist Projektkopf, kein FN-Hauptordner', () => {
    const gyproc = '30-2020-07-25_Saint_Gobain_Gyproc_Alekto_NO';
    assert.equal(looksLikeStaleFnOrProjectHeaderDir(gyproc), true);
    assert.equal(isUsableFnHauptordnerName(gyproc), false);
  });

  it('entfernt Datums-Projektköpfe ohne Bezug zur aktuellen FN-Liste', async () => {
    const gyproc = '30-2020-07-25_Saint_Gobain_Gyproc_Alekto_NO';
    const keep = '7118_Kunde_Ort_DE';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', gyproc), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', gyproc, 'x.txt'), 'x');
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', keep), { recursive: true });
    await removeUnrelatedTopLevelProjectFolders(reiseDir, [
      { fab: '7118', folder_name_canonical: keep },
    ]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', gyproc)), false);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', keep)), true);
  });

  it('lässt gültige FN-Bereichsordner der aktuellen FNs stehen', async () => {
    const range = '20500-20501_Test Sunstwo, AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', range), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt'), 'x');
    await removeUnrelatedTopLevelProjectFolders(reiseDir, [
      { fab: '20500', folder_name_canonical: range },
      { fab: '20501', folder_name_canonical: range },
    ]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt')), true);
  });

  it('löscht ohne FN-Liste nichts (leere fab_map)', async () => {
    const range = '20500-20501_Test Sunstwo, AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', range), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt'), 'x');
    await removeUnrelatedTopLevelProjectFolders(reiseDir, []);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt')), true);
  });
});

describe('FN-Bereich vs. Einzelordner', () => {
  let reiseDir;
  beforeEach(() => {
    reiseDir = tmpReise();
  });
  afterEach(() => {
    fs.rmSync(reiseDir, { recursive: true, force: true });
  });

  it('resolveFabMapLocal nutzt den Fileserver-Bereich für beide FNs', () => {
    const range = '20500-20501_Test Sunstwo, AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', range), { recursive: true });
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', '20501_Test_Sunstwo_AT'), { recursive: true });
    const map = resolveFabMapLocal(
      reiseDir,
      [
        { fab: '20500', folder_name_canonical: range },
        { fab: '20501', folder_name_canonical: '20501_Test_Sunstwo_AT' },
      ],
      ['20500', '20501'],
      (fab) => (fab === '20501' ? '20501_Test_Sunstwo_AT' : range),
      { customer_name: 'Test', city: 'Sunstwo', country: 'AT' },
    );
    assert.equal(map.length, 2);
    assert.equal(map[0].folder_name_canonical, range);
    assert.equal(map[1].folder_name_canonical, range);
  });

  it('migrateAlias führt Einzel-FN in den Bereichsordner, nicht umgekehrt', async () => {
    const range = '20500-20501_Test Sunstwo, AT';
    const single = '20501_Test_Sunstwo_AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'Montage'), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt'), 'range');
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', single), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', single, 'extra.txt'), 'single');
    await migrateAliasFnFolders(reiseDir, [
      { fab: '20500', folder_name_canonical: range },
      { fab: '20501', folder_name_canonical: range },
    ]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', single)), false);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'extra.txt')), true);
  });

  it('migrateAlias löscht keinen Bereichsordner zugunsten eines Einzel-FN-Namens', async () => {
    const range = '20500-20501_Test Sunstwo, AT';
    const single = '20500_Test_Sunstwo_AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', range), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'range.txt'), 'x');
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', single), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', single, 'single.txt'), 'y');
    await migrateAliasFnFolders(reiseDir, [
      { fab: '20500', folder_name_canonical: single },
      { fab: '20501', folder_name_canonical: '20501_Test_Sunstwo_AT' },
    ]);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', range, 'range.txt')), true);
  });

  it('führt „, AT“ und „, _AT“ in den Fileserver-Namen zusammen', async () => {
    const fileserver = '20500-20501_Test Sunstwo, AT';
    const localUgly = '20500-20501_Test Sunstwo, _AT';
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', fileserver), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', fileserver, 'keep.txt'), 'ok');
    fs.mkdirSync(path.join(reiseDir, 'Dokumente_Monteur', localUgly), { recursive: true });
    fs.writeFileSync(path.join(reiseDir, 'Dokumente_Monteur', localUgly, 'extra.txt'), 'x');
    const map = resolveFabMapLocal(
      reiseDir,
      [
        { fab: '20500', folder_name_canonical: localUgly },
        { fab: '20501', folder_name_canonical: localUgly },
      ],
      ['20500', '20501'],
      () => localUgly,
      { customer_name: 'Test', city: 'Sunstwo', country: 'AT' },
    );
    assert.equal(map[0].folder_name_canonical, fileserver);
    assert.equal(map[1].folder_name_canonical, fileserver);
    await migrateAliasFnFolders(reiseDir, map);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', localUgly)), false);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', fileserver, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(reiseDir, 'Dokumente_Monteur', fileserver, 'extra.txt')), true);
  });
});

describe('pickPreferredExactFnDir', () => {
  const { pickPreferredExactFnDir } = require('./projekte-neu-local');

  it('bevorzugt den langen FN-Ordner vor der reinen Ziffer', () => {
    const picked = pickPreferredExactFnDir(
      ['20500', '20500_Test_Sunstwo_AT', '20501_Test_Sunstwo_AT'],
      '20500',
    );
    assert.equal(picked, '20500_Test_Sunstwo_AT');
  });

  it('nimmt die Ziffer nur wenn kein langer Name existiert', () => {
    assert.equal(pickPreferredExactFnDir(['20500', 'anderes'], '20500'), '20500');
  });
});

describe('Montagebericht-Dateiname', () => {
  const {
    montageberichtExportStem,
    isLegacyMontageberichtEnExportName,
    cleanupLegacyMontageberichtEnPdfLocal,
  } = require('./monteur-montage-paths');

  it('DE und EN: Typ zuerst, dann Auftrag, dann Sprache', () => {
    const base = '2026-09-06_Test_Sunstwo_AT';
    assert.equal(montageberichtExportStem(base, 'de'), 'Montage_Bericht_2026-09-06_Test_Sunstwo_AT_DE');
    assert.equal(montageberichtExportStem(base, 'en'), 'Assembly_report_2026-09-06_Test_Sunstwo_AT_GB');
  });

  it('erkennt alte Dateinamen als Legacy, neue nicht', () => {
    assert.equal(isLegacyMontageberichtEnExportName('2026-09-06_Test_Sunstwo_AT_report_GB.pdf'), true);
    assert.equal(isLegacyMontageberichtEnExportName('2026-09-06_Test_Sunstwo_AT_Montage_DE.pdf'), true);
    assert.equal(isLegacyMontageberichtEnExportName('2026-09-06_Test_Sunstwo_AT_Assembly_report_GB.pdf'), true);
    assert.equal(isLegacyMontageberichtEnExportName('Assembly_report_2026-09-06_Test_Sunstwo_AT_GB.pdf'), false);
    assert.equal(isLegacyMontageberichtEnExportName('Montage_Bericht_2026-09-06_Test_Sunstwo_AT_DE.pdf'), false);
  });

  it('entfernt alte Montagebericht-PDFs nach neuem Export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-mb-en-'));
    const base = '2026-09-06_Test_Sunstwo_AT';
    try {
      fs.writeFileSync(path.join(dir, base + '_report_GB.pdf'), 'old-en');
      fs.writeFileSync(path.join(dir, base + '_Montage_DE.pdf'), 'old-de');
      fs.writeFileSync(path.join(dir, 'Montage_Bericht_' + base + '_DE.pdf'), 'new');
      cleanupLegacyMontageberichtEnPdfLocal(dir, base);
      assert.equal(fs.existsSync(path.join(dir, base + '_report_GB.pdf')), false);
      assert.equal(fs.existsSync(path.join(dir, base + '_Montage_DE.pdf')), false);
      assert.equal(fs.existsSync(path.join(dir, 'Montage_Bericht_' + base + '_DE.pdf')), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
