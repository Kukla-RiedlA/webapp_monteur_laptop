'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientFormatForServer, expandChannel } = require('./low-color');

test('32-Bit-Truecolor bleibt beim noVNC-Standard', () => {
  assert.equal(clientFormatForServer({
    bpp: 32,
    trueColor: 1,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift: 16,
    greenShift: 8,
    blueShift: 0,
  }), null);
});

test('Kukla-Terminal 8-Bit-Farbtabelle wird als 3-3-2-Truecolor angefordert', () => {
  assert.deepEqual(clientFormatForServer({
    bpp: 8,
    trueColor: 0,
    redMax: 7,
    greenMax: 7,
    blueMax: 3,
    redShift: 0,
    greenShift: 3,
    blueShift: 6,
  }), {
    bpp: 8,
    depth: 8,
    trueColor: 1,
    redMax: 7,
    greenMax: 7,
    blueMax: 3,
    redShift: 0,
    greenShift: 3,
    blueShift: 6,
  });
});

test('Weiss im 3-3-2-Pixel wird zu vollem RGB', () => {
  const pixel = 0xff;
  assert.equal(expandChannel(pixel, 0, 7), 255);
  assert.equal(expandChannel(pixel, 3, 7), 255);
  assert.equal(expandChannel(pixel, 6, 3), 255);
});
