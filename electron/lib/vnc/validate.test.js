'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVncTarget } = require('./validate');

test('10.0.1.1 und Port 5900 sind gültig', () => {
  assert.deepEqual(parseVncTarget({ host: '10.0.1.1', port: 5900 }), {
    host: '10.0.1.1',
    port: 5900,
  });
});

test('fehlender Port wird 5900', () => {
  assert.deepEqual(parseVncTarget({ host: ' 10.0.1.1 ' }), {
    host: '10.0.1.1',
    port: 5900,
  });
});

test('Hostname und leere IP sind ungültig', () => {
  assert.throws(() => parseVncTarget({ host: 'waage.local' }), (err) => err.code === 'invalid_host');
  assert.throws(() => parseVncTarget({ host: '' }), (err) => err.code === 'invalid_host');
  assert.throws(() => parseVncTarget({}), (err) => err.code === 'invalid_host');
});

test('Port ausserhalb 1 bis 65535 ist ungültig', () => {
  assert.throws(() => parseVncTarget({ host: '10.0.1.1', port: 0 }), (err) => err.code === 'invalid_port');
  assert.throws(() => parseVncTarget({ host: '10.0.1.1', port: 65536 }), (err) => err.code === 'invalid_port');
  assert.throws(() => parseVncTarget({ host: '10.0.1.1', port: 'abc' }), (err) => err.code === 'invalid_port');
});
