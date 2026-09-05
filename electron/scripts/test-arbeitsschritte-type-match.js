'use strict';

const assert = require('assert');
const { compactTypeToken, typeTokenContainsCode } = require('../lib/arbeitsschritte-local');

assert.strictEqual(compactTypeToken('D-DW-1ASG-800'), 'ddw1asg800');
assert.strictEqual(compactTypeToken('DDW'), 'ddw');
assert.strictEqual(compactTypeToken('D-DW'), 'ddw');
assert.ok(typeTokenContainsCode('D-DW-1ASG-800', 'DDW'));
assert.ok(typeTokenContainsCode('D-DW-1ASG-800', 'D-DW'));
assert.ok(!typeTokenContainsCode('D-DW-1ASG-800', 'DFF'));
assert.ok(!typeTokenContainsCode('', 'DDW'));
assert.ok(!typeTokenContainsCode('D-DW-1ASG-800', ''));

console.log('ok: DDW matches D-DW-1ASG-800');
