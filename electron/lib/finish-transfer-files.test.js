'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  shouldSkipFinishTransferFile,
  isFinishUploadRelPath,
  folderLabelFromRel,
  parseOptionalTransferRelPaths,
  transferRelMatches,
  listFinishTransferFiles,
  saveFinishExtraFile,
  sanitizeIncomingFileName,
} = require('./finish-transfer-files');

const AO = '2026-09-07_Kunde_Ort_AT_Monteur';

function tmpReise() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-finish-'));
  fs.mkdirSync(path.join(dir, 'Dokumente_Monteur'), { recursive: true });
  return dir;
}

function writeRel(root, rel, content) {
  const abs = path.join(root, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe('finish-transfer-files', () => {
  let reise;

  beforeEach(() => {
    reise = tmpReise();
  });

  afterEach(() => {
    try {
      fs.rmSync(reise, { recursive: true, force: true });
    } catch (_) {}
  });

  it('skips json tmp debug', () => {
    assert.equal(shouldSkipFinishTransferFile('Dokumente_Monteur/a.json', 'a.json'), true);
    assert.equal(shouldSkipFinishTransferFile('x/debug-log.pdf', 'debug-log.pdf'), true);
    assert.equal(shouldSkipFinishTransferFile('x/bericht.pdf', 'bericht.pdf'), false);
  });

  it('lists only current AO work files and photo categories', () => {
    writeRel(reise, `Dokumente_Monteur/12304_Kunde/Montage/${AO}/Protokolle/bericht.pdf`, 'pdf');
    writeRel(reise, `Dokumente_Monteur/12304_Kunde/Montage/${AO}/draft.json`, '{}');
    writeRel(reise, 'Dokumente_Monteur/12304_Kunde/Montage/2022_05_12_HN_Service/plan.pdf', 'old');
    writeRel(reise, `Dokumente_Monteur/Montage/${AO}/Bilder/Allgemein/foto.jpg`, 'img');
    const listed = listFinishTransferFiles(reise, AO);
    const names = listed.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['bericht.pdf', 'foto.jpg']);
    const proto = listed.files.find((f) => f.name === 'bericht.pdf');
    assert.equal(proto.folder_label, 'Protokolle');
    assert.equal(proto.fn_label, '12304_Kunde');
  });

  it('matches whitelist with and without Dokumente_Monteur prefix', () => {
    const rel = `Dokumente_Monteur/12304_Kunde/Montage/${AO}/Protokolle/bericht.pdf`;
    const list = [`12304_Kunde/Montage/${AO}/Protokolle/bericht.pdf`];
    assert.equal(transferRelMatches(rel, list), true);
    assert.equal(transferRelMatches(rel, []), false);
    assert.equal(transferRelMatches(rel, null), true);
    assert.equal(transferRelMatches('other.pdf', list), false);
  });

  it('parses missing vs empty transfer_rel_paths', () => {
    assert.equal(parseOptionalTransferRelPaths({}), undefined);
    assert.deepEqual(parseOptionalTransferRelPaths({ transfer_rel_paths: [] }), []);
    assert.deepEqual(parseOptionalTransferRelPaths({ transfer_rel_paths: ['a/b.pdf'] }), ['a/b.pdf']);
  });

  it('saves extra file under Sonstiges with collision suffix', () => {
    writeRel(reise, `Dokumente_Monteur/12304_Kunde/Montage/${AO}/Protokolle/x.pdf`, 'x');
    const first = saveFinishExtraFile({
      reiseDir: reise,
      auftragsordner: AO,
      fnFolder: '12304_Kunde',
      filename: 'zusatz.pdf',
      buffer: Buffer.from('one'),
    });
    const second = saveFinishExtraFile({
      reiseDir: reise,
      auftragsordner: AO,
      fnFolder: '12304_Kunde',
      filename: 'zusatz.pdf',
      buffer: Buffer.from('two'),
    });
    assert.equal(first.name, 'zusatz.pdf');
    assert.equal(second.name, 'zusatz_2.pdf');
    assert.match(first.rel_path, /\/Sonstiges\/zusatz\.pdf$/);
    assert.equal(isFinishUploadRelPath(first.rel_path, AO), true);
    const listed = listFinishTransferFiles(reise, AO);
    assert.ok(listed.files.some((f) => f.name === 'zusatz.pdf'));
    assert.match(first.rel_path, new RegExp('Dokumente_Monteur/12304_Kunde/Montage/' + AO + '/Sonstiges/zusatz\\.pdf$'));
  });

  it('rejects extra json tmp debug files', () => {
    writeRel(reise, `Dokumente_Monteur/12304_Kunde/Montage/${AO}/Protokolle/x.pdf`, 'x');
    assert.throws(
      () =>
        saveFinishExtraFile({
          reiseDir: reise,
          auftragsordner: AO,
          fnFolder: '12304_Kunde',
          filename: 'notiz.json',
          buffer: Buffer.from('{}'),
        }),
      /nicht erlaubt/,
    );
  });

  it('modal CSS keeps list scrollable and footer visible', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const start = html.indexOf('#modalFinishJobFiles .finish-job-files-box');
    const end = html.indexOf('#modalSpCatalog.modal-overlay.active');
    assert.ok(start > 0 && end > start, 'finish modal CSS block present');
    const css = html.slice(start, end);
    assert.match(css, /max-width:\s*min\(96vw,\s*42rem\)/);
    assert.match(css, /max-height:\s*calc\(100vh - var\(--header-height/);
    assert.match(css, /\.finish-job-files-list[\s\S]*overflow:\s*auto/);
    assert.match(css, /\.finish-job-files-footer[\s\S]*flex-shrink:\s*0/);
    assert.match(css, /@media \(max-width:\s*720px\)/);
    assert.match(css, /@media \(max-height:\s*720px\)/);
  });

  it('double-click opens file but skips checkbox', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const start = js.indexOf('listEl.addEventListener(\'dblclick\'');
    assert.ok(start > 0, 'dblclick handler present');
    const snippet = js.slice(start, start + 500);
    assert.match(snippet, /closest\('\.finish-job-file-check'\)\) return/);
    assert.match(snippet, /openFinishJobListedFile\(row\.getAttribute\('data-abs'\)\)/);
    assert.match(js, /function openFinishJobListedFile/);
    assert.match(js.slice(js.indexOf('function openFinishJobListedFile'), js.indexOf('function openFinishJobListedFile') + 800), /app\.openPdf/);
    assert.match(js.slice(js.indexOf('function openFinishJobListedFile'), js.indexOf('function openFinishJobListedFile') + 800), /app\.openPath/);
  });

  it('sanitizes incoming names', () => {
    assert.equal(sanitizeIncomingFileName('..\\secret.pdf'), 'secret.pdf');
    assert.equal(sanitizeIncomingFileName(''), 'datei');
  });

  it('folder labels', () => {
    assert.equal(folderLabelFromRel(`Dokumente_Monteur/fn/Montage/${AO}/Bilder/Allgemein/a.jpg`), 'Bilder');
    assert.equal(folderLabelFromRel(`Dokumente_Monteur/fn/Montage/${AO}/Sonstiges/x.pdf`), 'Sonstiges');
  });
});
