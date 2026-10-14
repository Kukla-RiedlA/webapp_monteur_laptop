'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isParameterListBuffer } = require('./classify');

describe('ftp parameterlisten', () => {
  it('erkennt die Endung auch ohne Inhalt', () => {
    assert.equal(isParameterListBuffer('FN12186_alt.csv', Buffer.from('x')), true);
    assert.equal(isParameterListBuffer('liste.PAL', Buffer.from('')), true);
  });

  it('erkennt eine Parameterliste ohne passende Endung am Inhalt', () => {
    const text = [
      'DWC4 L2.10 FN: 2007',
      '110;Nennlast;1;kg',
      '111;Teilung;2;kg',
      '112;Null;3;kg',
    ].join('\n');
    assert.equal(isParameterListBuffer('dump.bin', Buffer.from(text, 'latin1')), true);
  });

  it('lässt andere Dateien liegen', () => {
    assert.equal(isParameterListBuffer('foto.jpg', Buffer.from('kein parametertext')), false);
    assert.equal(isParameterListBuffer('readme.md', Buffer.from('nur text ohne werte')), false);
    assert.equal(isParameterListBuffer('notiz.txt', Buffer.from('nur ein Hinweis')), false);
  });
});
