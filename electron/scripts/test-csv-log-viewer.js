'use strict';

var assert = require('assert');
var api = require('../public/js/csv-log-viewer.js');

function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, label + ' — got ' + JSON.stringify(actual));
}

eq(api.detectDelimiter('Date;Time;U\n01.01.2024;08:00:00;1,5\n'), ';', 'semicolon');
eq(api.detectDelimiter('Date,Time,U\n01.01.2024,08:00:00,1.5\n'), ',', 'comma');
eq(api.parseNumber('1,5'), 1.5, 'decimal comma');
eq(api.parseNumber('1.5'), 1.5, 'decimal dot');
eq(api.parseNumber('1.234,56'), 1234.56, 'thousands dot');
eq(api.parseNumber('1,234.56'), 1234.56, 'thousands comma');
eq(api.parseNumber('08:00:00'), null, 'time is not a number');
eq(api.parseNumber(''), null, 'empty');

var quoted = api.parseCsv('Date;Time;Note;U\n01.01.2024;08:00:00;"a;b";1,0\n', ';');
eq(quoted[1][2], 'a;b', 'quoted semicolon stays in the field');
eq(quoted[1].length, 4, 'quoted row width');

var data = api.buildDataset([
  {
    name: 'b.csv',
    text: 'Date;Time;U;I;Unnamed: 0\n02.01.2024;10:00:00;1,5;2;9\n01.01.2024;08:00:00;3,5;4;8\n'
  },
  {
    name: 'a.csv',
    text: 'Date;Time;U;P\n01.01.2024;12:00:00;9,0;1,25\n'
  }
]);
assert.strictEqual(data.ok, true, 'dataset ok');
assert.deepStrictEqual(data.headers, ['Date', 'Time', 'U', 'I', 'P']);
assert.deepStrictEqual(data.seriesNames, ['U', 'I', 'P']);
assert.strictEqual(data.xIsTime, true);
eq(data.rows.length, 3, 'three rows');
eq(data.rows[0].y[0], 3.5, 'sorted first U');
eq(data.rows[1].y[0], 9, 'middle U');
eq(data.rows[1].y[2], 1.25, 'P on middle row');
eq(data.rows[2].y[0], 1.5, 'last U');
eq(data.rows[0].cells[2], '3,5', 'table keeps original text');
var day = 86400000;
eq(data.rows[1].x - data.rows[0].x, 4 * 3600000, 'four hours between first and second');
eq(data.rows[2].x - data.rows[0].x, day + 2 * 3600000, '26 hours to the third sample');

var quotedSet = api.buildDataset([{
  name: 'q.csv',
  text: 'Date;Time;Note;U\n01.01.2024;08:00:00;"a;b";1,0\n'
}]);
assert.deepStrictEqual(quotedSet.seriesNames, ['U']);
eq(quotedSet.rows[0].cells[2], 'a;b', 'note kept');
eq(quotedSet.rows[0].y[0], 1, 'U parsed');

var single = api.buildDataset([{
  name: 'one.csv',
  text: 'Wert\n1,5\n2,5\n4\n'
}]);
assert.strictEqual(single.ok, true, 'single column plots against index');
assert.deepStrictEqual(single.seriesNames, ['Wert']);
eq(single.rows[0].x, 0, 'index x');
eq(single.rows[2].y[0], 4, 'third value');
assert.strictEqual(single.xIsTime, false);

var commaFile = api.buildDataset([{
  name: 'en.csv',
  text: 'Timestamp,Power\n2024-01-01 08:00:00,1.5\n2024-01-01 09:00:00,2.25\n'
}]);
assert.strictEqual(commaFile.ok, true);
eq(commaFile.rows[0].y[0], 1.5, 'dot decimal');
eq(commaFile.rows[1].x - commaFile.rows[0].x, 3600000, 'one hour');

var xs = [10, 20, 30, 40];
eq(api.nearestIndex(xs, 4, 20), 1, 'exact nearest');
eq(api.nearestIndex(xs, 4, 24), 1, 'closer to 20');
eq(api.nearestIndex(xs, 4, 26), 2, 'closer to 30');
eq(api.nearestIndex(xs, 4, -5), 0, 'below range');
eq(api.nearestIndex(xs, 4, 99), 3, 'above range');

var none = api.buildDataset([{ name: 'x.csv', text: 'Name;Ort\nA;B\n' }]);
assert.strictEqual(none.ok, false);
eq(none.error, 'nonum', 'text only');

console.log('csv-log-viewer tests ok');
