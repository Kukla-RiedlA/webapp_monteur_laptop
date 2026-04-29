'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.env.KUKLA_SKIP_VERSION_HOOK) {
  process.exit(0);
}

const RE_APP = /^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$/;

function gitShow(spec) {
  try {
    return execSync(`git show ${spec}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function parseAppVersion(str) {
  const m = String(str || '').trim().match(RE_APP);
  if (!m) return null;
  return { maj: parseInt(m[1], 10), rel: parseInt(m[2], 10), pat: parseInt(m[3], 10), raw: m[0].replace(/\s+/g, ' ').trim() };
}

function formatApp(v) {
  return `V ${v.maj}.${String(v.rel).padStart(3, '0')}.${String(v.pat).padStart(3, '0')}`;
}

function readVersionFromJson(content) {
  const j = JSON.parse(content);
  return parseAppVersion(j.version);
}

function readVersionFromPhp(content) {
  const m = String(content).match(/\$APP_VERSION\s*=\s*'([^']+)'/);
  if (!m) return null;
  return parseAppVersion(m[1]);
}

function appToSemver(s) {
  const p = parseAppVersion(s);
  if (!p) return '1.0.0';
  return `${p.maj}.${p.rel}.${p.pat}`;
}

function main() {
  const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  process.chdir(root);

  const jPath = 'electron/version.json';
  const pPath = 'config/version.php';
  const pkgPath = 'electron/package.json';

  const headJ = gitShow('HEAD:' + jPath);
  const headP = gitShow('HEAD:' + pPath);
  if (!headJ || !headP) {
    console.error('version-bump.cjs: HEAD fehlt fuer version-Dateien.');
    process.exit(1);
  }

  const headVj = readVersionFromJson(headJ);
  const headVp = readVersionFromPhp(headP);
  if (!headVj || !headVp) {
    console.error('version-bump.cjs: HEAD nicht im Format V major.release.patch – Hook uebersprungen (Migration).');
    process.exit(0);
  }
  const headStr = formatApp(headVj);
  if (formatApp(headVp) !== headStr) {
    console.error(`version-bump.cjs: HEAD inkonsistent (json ${headStr} vs php ${formatApp(headVp)}).`);
    process.exit(1);
  }

  if (headVj.pat >= 999) {
    console.error('version-bump.cjs: Patch >= 999.');
    process.exit(1);
  }

  const target = formatApp({ maj: headVj.maj, rel: headVj.rel, pat: headVj.pat + 1 });

  const idxJ = gitShow(':' + jPath) || fs.readFileSync(jPath, 'utf8');
  const idxP = gitShow(':' + pPath) || fs.readFileSync(pPath, 'utf8');
  const curJ = readVersionFromJson(idxJ);
  const curP = readVersionFromPhp(idxP);
  if (!curJ || !curP) {
    console.error('version-bump.cjs: Index/Working Tree nicht parsbar.');
    process.exit(1);
  }
  const curStrJ = formatApp(curJ);
  const curStrP = formatApp(curP);
  if (curStrJ !== curStrP) {
    console.error(`version-bump.cjs: Index inkonsistent (${curStrJ} vs ${curStrP}).`);
    process.exit(1);
  }

  if (curStrJ === target) {
    process.exit(0);
  }
  if (curStrJ !== headStr && curStrJ !== target) {
    console.error(`version-bump.cjs: Version widerspricht sich (HEAD ${headStr}, Ziel ${target}, Index ${curStrJ}).`);
    process.exit(1);
  }

  fs.writeFileSync(jPath, JSON.stringify({ version: target }, null, 4) + '\n', 'utf8');
  const newPhp = idxP.replace(/(\$APP_VERSION\s*=\s*')[^']+(')/, `$1${target}$2`);
  fs.writeFileSync(pPath, newPhp, 'utf8');

  let pkg = fs.readFileSync(pkgPath, 'utf8');
  const semver = appToSemver(target);
  pkg = pkg.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${semver}"`);
  fs.writeFileSync(pkgPath, pkg, 'utf8');

  execSync(`git add ${jPath} ${pPath} ${pkgPath}`, { stdio: 'inherit' });
}

main();
