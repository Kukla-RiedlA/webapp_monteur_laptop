'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLinePlaceholder,
  valuesEquivalentForCompare,
  compareParameterEntryLists,
  compareParameterTextLines,
} = require('./anlagenstamm-parameter-trend');

describe('parameter-trend dash placeholders', () => {
  it('erkennt Trennstriche inkl. Klammern', () => {
    assert.equal(isLinePlaceholder('---------'), true);
    assert.equal(isLinePlaceholder('__________'), true);
    assert.equal(isLinePlaceholder('------------- [- -------------]'), true);
    assert.equal(isLinePlaceholder('-------------;[-];-------------'), true);
    assert.equal(isLinePlaceholder('12.5'), false);
    assert.equal(isLinePlaceholder('P1130 q3 - length'), false);
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

describe('parameter text line compare (Notepad++-Stil)', () => {
  it('behandelt unterschiedlich lange Strichzeilen als gleich', () => {
    const left = [
      'KUKLA GmbH&CoKG Parameter:;',
      '------------- [- -------------]',
      'P1130 q3 - length:; 500;mm;',
      '-------------',
    ].join('\n');
    const right = [
      'KUKLA GmbH&CoKG Parameter:;',
      '-------------',
      'P1130 q3 - length:; 650;mm;',
      '------------------',
    ].join('\n');
    const diff = compareParameterTextLines(left, right);
    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.removed, 0);
    assert.equal(diff.summary.changed, 1);
    const changed = diff.rows.filter((r) => r.type === 'changed');
    assert.equal(changed.length, 1);
    assert.match(changed[0].left_text, /500/);
    assert.match(changed[0].right_text, /650/);
  });

  it('markiert nur den geänderten Wert innerhalb der Zeile', () => {
    const diff = compareParameterTextLines(
      'P1130 q3 - length:; 500;mm;',
      'P1130 q3 - length:; 650;mm;',
    );
    assert.equal(diff.summary.changed, 1);
    const row = diff.rows[0];
    const leftChanged = (row.left_parts || []).filter((p) => p.changed).map((p) => p.text).join('');
    const rightChanged = (row.right_parts || []).filter((p) => p.changed).map((p) => p.text).join('');
    assert.equal(leftChanged, '500');
    assert.equal(rightChanged, '650');
  });

  it('zählt echte Zusatzzeilen als neu', () => {
    const diff = compareParameterTextLines('P100 Name:; A;\n', 'P100 Name:; A;\nP200 Extra:; 1;\n');
    assert.equal(diff.summary.added, 1);
    assert.equal(diff.summary.removed, 0);
  });
});
