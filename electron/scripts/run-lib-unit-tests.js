'use strict';

/**
 * Schnelle Lib-Tests: alle electron/lib/**\/*.test.js
 * PDF-Skripte unter electron/scripts bleiben manuell.
 * Aufruf aus electron/: node scripts/run-lib-unit-tests.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronRoot = path.join(__dirname, '..');
const libDir = path.join(electronRoot, 'lib');

function collect(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.test.js')) out.push(full);
  }
}

const files = [];
collect(libDir, files);
files.sort();
if (files.length === 0) {
  console.error('run-lib-unit-tests: keine lib/**/*.test.js');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: electronRoot,
});
process.exit(result.status === null ? 1 : result.status);
