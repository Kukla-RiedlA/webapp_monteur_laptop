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

/**
 * better-sqlite3 liegt fuer Electron (ABI 145) vor, nicht fuer das System-Node (ABI 137).
 * ELECTRON_RUN_AS_NODE nutzt dieselbe Binary wie die App, ohne sie neu zu bauen.
 */
function testRuntime() {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const electronExe = path.join(electronRoot, 'node_modules', 'electron', 'dist', exeName);
  if (fs.existsSync(electronExe)) {
    return {
      execPath: electronExe,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    };
  }
  console.error('run-lib-unit-tests: electron.exe fehlt, System-Node. SQLite-Tests koennen uebersprungen werden.');
  return { execPath: process.execPath, env: process.env };
}

const runtime = testRuntime();
const result = spawnSync(runtime.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: electronRoot,
  env: runtime.env,
});
process.exit(result.status === null ? 1 : result.status);
