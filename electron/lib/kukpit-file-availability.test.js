'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isKukpitFileOffline,
  annotateTreeOffline,
} = require('./kukpit-file-availability');
const { writeCachedProjekteNeuFile } = require('./projekte-neu-file-cache');

describe('kukpit-file-availability', () => {
  it('TED im Reiseordner ist offline, eine fehlende Datei nicht', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukpit-av-'));
    fs.mkdirSync(path.join(dir, 'TED'));
    fs.writeFileSync(path.join(dir, 'TED', '12180.xlsx'), 'x');
    assert.equal(
      isKukpitFileOffline({ reiseDir: dir, fab: '12180', relPath: 'TED/12180.xlsx', fileName: '12180.xlsx' }),
      true,
    );
    assert.equal(
      isKukpitFileOffline({ reiseDir: dir, fab: '12180', relPath: 'fehlt.xlsx', fileName: 'fehlt.xlsx' }),
      false,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Hash-Cache zählt als offline, auch ohne Reiseordner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukpit-av-cache-'));
    writeCachedProjekteNeuFile(dir, '99', 'Zeichnung/plan.pdf', Buffer.from('pdf'));
    assert.equal(
      isKukpitFileOffline({ dbDir: dir, fab: '99', relPath: 'Zeichnung/plan.pdf' }),
      true,
    );
    assert.equal(isKukpitFileOffline({ dbDir: dir, fab: '99', relPath: 'Zeichnung/nein.pdf' }), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Anlagenstamm-TED-Cache gilt ohne Reiseordner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukpit-av-stamm-'));
    const tedDir = path.join(dir, 'anlagenstamm_ted', '12180');
    fs.mkdirSync(tedDir, { recursive: true });
    fs.writeFileSync(path.join(tedDir, '12180.xlsx'), 'x');
    assert.equal(
      isKukpitFileOffline({
        dbDir: dir,
        fab: '12180',
        relPath: 'WIN/TED/12180.xlsx',
        fileName: '12180.xlsx',
      }),
      true,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('annotateTreeOffline setzt is_offline nur an Dateien', () => {
    const tree = annotateTreeOffline(
      [
        {
          type: 'dir',
          name: 'A',
          children: [{ type: 'file', name: 'a.pdf', rel: 'A/a.pdf' }],
        },
        { type: 'file', name: 'b.pdf', rel: 'b.pdf' },
      ],
      (rel) => rel === 'A/a.pdf',
    );
    assert.equal(tree[0].is_offline, undefined);
    assert.equal(tree[0].children[0].is_offline, true);
    assert.equal(tree[1].is_offline, false);
  });
});
