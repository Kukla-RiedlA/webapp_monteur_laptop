'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPdfAnnotatorSession,
  getPdfAnnotatorSession,
  dropPdfAnnotatorSession,
} = require('./pdf-annotator-sessions');

describe('PDF-Annotator-Sessions', () => {
  it('legt eine Session an und liefert sie wieder', () => {
    const id = createPdfAnnotatorSession({
      sourcePath: 'P:\\pläne\\a.pdf',
      viewPath: 'C:\\temp\\a.pdf',
      title: 'a.pdf',
    });
    assert.ok(id);
    const row = getPdfAnnotatorSession(id);
    assert.ok(row);
    assert.match(row.sourcePath, /a\.pdf$/i);
    dropPdfAnnotatorSession(id);
    assert.equal(getPdfAnnotatorSession(id), null);
  });

  it('lehnt leeren Pfad ab', () => {
    assert.equal(createPdfAnnotatorSession({ sourcePath: '  ' }), null);
  });
});
