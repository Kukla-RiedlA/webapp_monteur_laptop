'use strict';

/**
 * Setzt core.hooksPath auf githooks/. Laeuft per npm "prepare" nach npm install.
 * Ueberspringen: CI=true oder SKIP_INSTALL_GITHOOKS=1
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.env.CI === 'true' || process.env.SKIP_INSTALL_GITHOOKS === '1') {
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const preCommit = path.join(root, 'githooks', 'pre-commit');

if (!fs.existsSync(preCommit)) {
  process.exit(0);
}

try {
  execSync('git rev-parse --show-toplevel', { cwd: root, stdio: 'pipe' });
} catch {
  process.exit(0);
}

const want = 'githooks';
try {
  const cur = execSync('git config core.hooksPath', { cwd: root, encoding: 'utf8' }).trim();
  if (cur === want) {
    process.exit(0);
  }
} catch {
  /* unset */
}

execSync(`git config core.hooksPath ${want}`, { cwd: root, stdio: 'inherit' });
