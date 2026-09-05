'use strict';

const assert = require('assert');
const {
  anlagenstammTypeHasBehaelterNenninhalt,
  anlagenstammVmaxValueFromRow,
  anlagenstammVmaxLabel,
} = require('../lib/anlagenstamm-type');

assert.ok(anlagenstammTypeHasBehaelterNenninhalt('D-DW'));
assert.ok(anlagenstammTypeHasBehaelterNenninhalt('DDW'));
assert.ok(anlagenstammTypeHasBehaelterNenninhalt('D-DW-1ASG-800'));
assert.ok(anlagenstammTypeHasBehaelterNenninhalt('V-DG-1'));
assert.ok(anlagenstammTypeHasBehaelterNenninhalt('VDG1'));
assert.ok(anlagenstammTypeHasBehaelterNenninhalt('V-DG-1ASG'));
assert.ok(!anlagenstammTypeHasBehaelterNenninhalt('V-DG-10'));
assert.ok(!anlagenstammTypeHasBehaelterNenninhalt('EBW'));
assert.ok(!anlagenstammTypeHasBehaelterNenninhalt(''));
assert.ok(!anlagenstammTypeHasBehaelterNenninhalt(null));

assert.strictEqual(
  anlagenstammVmaxValueFromRow({ type: 'D-DW', behaelter_nenninhalt: '12 m³', nenngeschwindigkeit: '1.2' }),
  '12 m³',
);
assert.strictEqual(
  anlagenstammVmaxValueFromRow({ type: 'EBW', behaelter_nenninhalt: '12 m³', nenngeschwindigkeit: '1.2' }),
  '1.2',
);
assert.strictEqual(anlagenstammVmaxLabel('D-DW', 'de'), 'Behälter Nenninhalt');
assert.strictEqual(anlagenstammVmaxLabel('D-DW', 'en'), 'Vessel nom. capacity');
assert.strictEqual(anlagenstammVmaxLabel('EBW', 'de'), 'v max');

console.log('ok: anlagenstamm type D-DW / V-DG-1');
