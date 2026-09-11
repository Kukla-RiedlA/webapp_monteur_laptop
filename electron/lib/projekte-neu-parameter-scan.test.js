'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProjekteNeuParameterFiles } = require('./projekte-neu-local');
const { isSupportedParameterFileName } = require('./anlagenstamm-parameter-parser');

describe('scanProjekteNeuParameterFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pn-param-'));
  const montage = path.join(root, 'Montage', '2026-02-02_KnaufInsulation_Zalaegerszeg_HU');
  const bilder = path.join(root, 'Bilder');

  fs.mkdirSync(montage, { recursive: true });
  fs.mkdirSync(bilder, { recursive: true });
  fs.writeFileSync(path.join(root, 'FN09751_PA7_EN_20221006_1608.CSV'), 'a;1\n');
  fs.writeFileSync(path.join(root, 'FN09751_PA7_EN_20221006_0920.CSV'), 'a;1\n');
  fs.writeFileSync(path.join(root, 'FN09751_PA7_EN_20190612_1547.CSV'), 'a;1\n');
  fs.writeFileSync(path.join(montage, 'FN09751_PA7_EN_20260201_0433.CSV'), 'a;1\n');
  fs.writeFileSync(path.join(montage, 'notes.pal'), 'PAL\n');
  fs.writeFileSync(path.join(root, 'backup.pa3'), 'PA3\n');
  fs.writeFileSync(path.join(bilder, 'foto.jpg'), 'nope');
  fs.writeFileSync(path.join(montage, 'bericht.docx'), 'nope');

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('findet CSV/PAL/PA3 auch in Montage, ignoriert Bilder und Office', () => {
    const found = scanProjekteNeuParameterFiles(root);
    const names = found.map((f) => f.name).sort();
    assert.deepEqual(names, [
      'FN09751_PA7_EN_20190612_1547.CSV',
      'FN09751_PA7_EN_20221006_0920.CSV',
      'FN09751_PA7_EN_20221006_1608.CSV',
      'FN09751_PA7_EN_20260201_0433.CSV',
      'backup.pa3',
      'notes.pal',
    ]);
    const montageHit = found.find((f) => f.name === 'FN09751_PA7_EN_20260201_0433.CSV');
    assert.ok(montageHit);
    assert.match(montageHit.rel.replace(/\\/g, '/'), /Montage\//);
  });

  it('erkennt die vereinbarten Parameter-Endungen', () => {
    assert.equal(isSupportedParameterFileName('x.csv'), true);
    assert.equal(isSupportedParameterFileName('x.PAL'), true);
    assert.equal(isSupportedParameterFileName('x.pa3'), true);
    assert.equal(isSupportedParameterFileName('x.pa5'), true);
    assert.equal(isSupportedParameterFileName('x.jpg'), false);
  });
});
