'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLinePlaceholder,
  valuesEquivalentForCompare,
  compareParameterEntryLists,
} = require('./anlagenstamm-parameter-trend');

describe('parameter-trend dash placeholders', () => {
  it('erkennt Trennstriche', () => {
    assert.equal(isLinePlaceholder('---------'), true);
    assert.equal(isLinePlaceholder('__________'), true);
    assert.equal(isLinePlaceholder('12.5'), false);
    assert.equal(isLinePlaceholder('-'), false);
  });

  it('wertet unterschiedlich lange Striche nicht als Änderung', () => {
    assert.equal(valuesEquivalentForCompare('---------', '----------'), true);
    assert.equal(valuesEquivalentForCompare('---------', ''), true);
    assert.equal(valuesEquivalentForCompare('12.5', '---------'), false);
  });

  it('meldet Strich-Werte nicht als changed', () => {
    const diff = compareParameterEntryLists(
      [{ param_key: 'Offset', param_value: '---------', unit: '', line_no: 10 }],
      [{ param_key: 'Offset', param_value: '------', unit: '', line_no: 10 }],
    );
    assert.equal(diff.summary.changed, 0);
    assert.equal(diff.changes.filter((c) => c.status === 'changed').length, 0);
  });

  it('meldet echte Wertänderungen weiter', () => {
    const diff = compareParameterEntryLists(
      [{ param_key: 'Offset', param_value: '1.0', unit: '', line_no: 10 }],
      [{ param_key: 'Offset', param_value: '2.0', unit: '', line_no: 10 }],
    );
    assert.equal(diff.summary.changed, 1);
  });
});
