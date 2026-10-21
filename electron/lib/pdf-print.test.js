'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { markupHasContent, writePrintSource, isCancelReason } = require('./pdf-print');

describe('PDF-Viewer Druck', () => {
  it('erkennt leere Markierung', () => {
    assert.equal(markupHasContent(null), false);
    assert.equal(markupHasContent({ strokes: [], texts: [] }), false);
    assert.equal(markupHasContent({
      strokes: [{ page: 0, points: [[0.1, 0.2], [0.4, 0.5]] }],
    }), true);
  });

  it('behandelt Abbruch im Druckdialog als Abbruch', () => {
    assert.equal(isCancelReason(''), true);
    assert.equal(isCancelReason('cancelled'), true);
    assert.equal(isCancelReason('Print job canceled'), true);
    assert.equal(isCancelReason('failed'), false);
  });

  it('druckt ohne Markierung die Originaldatei', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-print-'));
    const src = path.join(dir, 'bericht.pdf');
    try {
      const doc = await PDFDocument.create();
      doc.addPage([400, 300]);
      fs.writeFileSync(src, await doc.save());
      const prepared = await writePrintSource(src, { strokes: [], texts: [] });
      assert.equal(prepared.temporary, false);
      assert.equal(prepared.filePath, path.normalize(src));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legt mit Markierung eine temporäre Kopie an', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-pdf-print-'));
    const src = path.join(dir, 'bericht.pdf');
    try {
      const doc = await PDFDocument.create();
      doc.addPage([400, 300]);
      fs.writeFileSync(src, await doc.save());
      const before = fs.readFileSync(src);
      const prepared = await writePrintSource(src, {
        strokes: [{
          page: 0,
          color: '#c1121f',
          widthPt: 2,
          points: [[0.1, 0.2], [0.6, 0.4]],
        }],
        texts: [{ page: 0, color: '#0e7b5a', sizePt: 14, x: 0.2, y: 0.3, text: 'Hinweis' }],
      });
      assert.equal(prepared.temporary, true);
      assert.notEqual(prepared.filePath, path.normalize(src));
      assert.equal(fs.existsSync(prepared.filePath), true);
      assert.deepEqual(fs.readFileSync(src), before);
      const out = await PDFDocument.load(fs.readFileSync(prepared.filePath));
      assert.equal(out.getPageCount(), 1);
      fs.rmSync(prepared.filePath, { force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
