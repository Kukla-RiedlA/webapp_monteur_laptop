'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shellLoopsForSearch } = require('./kukpit-shell-loops');

const KEYS = ['bootSync', 'syncInterval', 'connectionProbe', 'onlineSync', 'jobPoll'];

function flags(search) {
  const loops = shellLoopsForSearch(search);
  return KEYS.map((key) => loops[key]);
}

describe('shellLoopsForSearch', () => {
  it('lässt die fünf Schleifen im Hauptfenster an', () => {
    assert.deepEqual(flags(''), [true, true, true, true, true]);
    assert.deepEqual(flags('?view=start'), [true, true, true, true, true]);
  });

  it('schaltet sie im Popout aus', () => {
    assert.deepEqual(flags('?popout=1&view=protokolle-service'), [false, false, false, false, false]);
  });
});
