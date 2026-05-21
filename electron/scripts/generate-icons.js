/**
 * Erzeugt public/icon.png (512x512) aus assets/kukla-logo-source.png fuer Fenster und electron-builder.
 * Aufruf: node scripts/generate-icons.js
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'assets', 'kukla-logo-source.png');
const outPng = path.join(root, 'public', 'icon.png');

async function main() {
  if (!fs.existsSync(src)) {
    console.error('Quelle fehlt:', src);
    process.exit(1);
  }
  await sharp(src)
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toFile(outPng);
  console.log('OK', outPng);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
