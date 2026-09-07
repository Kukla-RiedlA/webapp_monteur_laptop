'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const {
  suggestedAnnotatedPath,
  resolveMonteurMontagePdfDir,
  normalizeMarkup,
  flattenPdfMarkup,
} = require('./pdf-flatten-markup');

describe('PDF-Kommentare flatten', () => {
  it('legt Cache-PDFs unter Montage/<Auftragsordner>/PDF ab', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-cache-'));
    const fn = '11603_Knauf Enginnering GmbH Iphofen';
    const ao = '2026-09-06_Knauf_(UK)_Sittingbourne_GB_Riedl_Alois';
    try {
      fs.mkdirSync(path.join(root, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle'), { recursive: true });
      const src = path.join(root, 'anlagenstamm_open', '20260907134037_11603_Kna_EN.pdf');
      const dest = suggestedAnnotatedPath(src, { reiseDirs: [root] }).replace(/\\/g, '/');
      assert.match(
        dest,
        /Dokumente_Monteur\/11603_Knauf Enginnering GmbH Iphofen\/Montage\/2026-09-06_Knauf_\(UK\)_Sittingbourne_GB_Riedl_Alois\/PDF\/11603_Kna_EN_kommentiert\.pdf$/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('legt _kommentiert neben das Original ohne Projektordner', () => {
    const dest = suggestedAnnotatedPath(path.join('/docs', 'Halle_A.pdf'));
    assert.equal(path.basename(dest), 'Halle_A_kommentiert.pdf');
    assert.equal(path.dirname(dest), path.normalize(path.join('/docs')));
  });

  it('speichert neben Protokolle unter Montage/<Auftragsordner>/PDF', () => {
    const ao = '2026-05-12_Knauf_Sittingbourne_UK_Riedl';
    const src = path.join(
      '/reise',
      'Dokumente_Monteur',
      '10066_Knauf UK, Sittingbourne',
      'Montage',
      ao,
      'Protokolle',
      'plan.pdf',
    );
    const dest = suggestedAnnotatedPath(src).replace(/\\/g, '/');
    assert.match(
      dest,
      /Dokumente_Monteur\/10066_Knauf UK, Sittingbourne\/Montage\/2026-05-12_Knauf_Sittingbourne_UK_Riedl\/PDF\/plan_kommentiert\.pdf$/,
    );
  });

  it('nimmt den bestehenden Auftragsordner wenn die PDF höher liegt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-ao-'));
    const fn = '10066_Knauf UK, Sittingbourne';
    const ao = '2026-05-12_Knauf_Sittingbourne_UK_Riedl';
    try {
      fs.mkdirSync(path.join(root, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle'), { recursive: true });
      const src = path.join(root, 'Dokumente_Monteur', fn, 'Zeichnung.pdf');
      const dest = suggestedAnnotatedPath(src).replace(/\\/g, '/');
      assert.match(dest, new RegExp(ao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/PDF/Zeichnung_kommentiert\\.pdf$'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('verwendet keinen PROJEKTE-NEU-Montageordner als Ziel', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-pn-'));
    const fn = '10066_Knauf UK, Sittingbourne';
    const ao = '2026-05-12_Knauf_Sittingbourne_UK_Riedl';
    const pn = '2022_05_12_HN_Service';
    try {
      fs.mkdirSync(path.join(root, 'Dokumente_Monteur', fn, 'Montage', ao, 'Protokolle'), { recursive: true });
      const src = path.join(root, 'Dokumente_Monteur', fn, 'Montage', pn, 'plan.pdf');
      const dest = suggestedAnnotatedPath(src).replace(/\\/g, '/');
      assert.match(dest, new RegExp(ao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/PDF/plan_kommentiert\\.pdf$'));
      assert.equal(dest.includes(pn), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('überschreibt bereits kommentierte Dateien am selben Namen', () => {
    const src = path.join('/docs', 'Halle_A_kommentiert.pdf');
    assert.equal(suggestedAnnotatedPath(src), path.normalize(src));
  });

  it('verwirft leere und zu kurze Striche', () => {
    const got = normalizeMarkup({
      strokes: [{ page: 0, points: [[0.1, 0.1]] }],
      texts: [{ page: 0, text: '   ' }],
    });
    assert.equal(got.strokes.length, 0);
    assert.equal(got.texts.length, 0);
  });

  it('behält Strich und Kreis', () => {
    const got = normalizeMarkup({
      strokes: [
        { kind: 'line', page: 0, points: [[0.1, 0.1], [0.2, 0.2], [0.9, 0.4]] },
        { kind: 'circle', page: 1, points: [[0.5, 0.5], [0.7, 0.6]] },
      ],
    });
    assert.equal(got.strokes[0].kind, 'line');
    assert.deepEqual(got.strokes[0].points, [[0.1, 0.1], [0.9, 0.4]]);
    assert.equal(got.strokes[1].kind, 'circle');
  });

  it('brennt Strich und Text in eine Kopie', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-markup-'));
    const src = path.join(dir, 'plan.pdf');
    const dest = path.join(dir, 'plan_kommentiert.pdf');
    try {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 300]);
      page.drawText('Plan', { x: 20, y: 260, size: 18 });
      fs.writeFileSync(src, await doc.save());
      await flattenPdfMarkup({
        sourcePath: src,
        destPath: dest,
        markup: {
          strokes: [{
            page: 0,
            color: '#c1121f',
            widthPt: 3,
            points: [[0.1, 0.2], [0.4, 0.25], [0.7, 0.3]],
          }, {
            kind: 'line',
            page: 0,
            color: '#1a1a1a',
            widthPt: 2,
            points: [[0.2, 0.8], [0.8, 0.85]],
          }, {
            kind: 'circle',
            page: 0,
            color: '#c1121f',
            widthPt: 2,
            points: [[0.5, 0.5], [0.62, 0.55]],
          }],
          texts: [{
            page: 0,
            color: '#0e7b5a',
            sizePt: 14,
            x: 0.15,
            y: 0.5,
            text: 'Motor hier',
          }],
        },
      });
      assert.equal(fs.existsSync(dest), true);
      const out = await PDFDocument.load(fs.readFileSync(dest));
      assert.equal(out.getPageCount(), 1);
      assert.ok(fs.statSync(dest).size > fs.statSync(src).size);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
