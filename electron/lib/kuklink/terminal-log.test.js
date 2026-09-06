'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const term = require('./terminal-log');

describe('kuklink terminal-log', () => {
  it('formatiert RX lesbar und liefert Deltas', () => {
    term.clear();
    assert.equal(term.formatRx(Buffer.from([0x02, 0x41, 0x0a, 0x00])), '<STX>A\n');
    const g0 = term.snapshot().generation;
    term.rx(Buffer.from('Hallo', 'latin1'));
    const a = term.since(0, g0);
    assert.equal(a.reset, false);
    assert.match(a.chunk, /Hallo/);
    const b = term.since(a.seq, a.generation);
    assert.equal(b.chunk, '');
    term.clear();
    const c = term.since(a.seq, a.generation);
    assert.equal(c.reset, true);
  });
});
