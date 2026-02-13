/**
 * Lädt alle Länderfahnen von flagcdn.com und speichert sie unter public/flags/.
 * Die App zeigt diese lokalen Dateien in „Meine Aufträge“ an (offline nutzbar).
 * Aufruf (im Ordner electron/): node scripts/download-flags.cjs
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://flagcdn.com/w40/';
const OUT_DIR = path.join(__dirname, '..', 'public', 'flags');

// ISO 3166-1 alpha-2 Länderkürzel (alle gängigen)
const COUNTRY_CODES = [
  'ad', 'ae', 'af', 'ag', 'al', 'am', 'ao', 'ar', 'at', 'au', 'az', 'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj',
  'bn', 'bo', 'br', 'bs', 'bt', 'bw', 'by', 'bz', 'ca', 'cd', 'cf', 'cg', 'ch', 'ci', 'cl', 'cm', 'cn', 'co', 'cr', 'cu',
  'cv', 'cy', 'cz', 'de', 'dj', 'dk', 'dm', 'do', 'dz', 'ec', 'ee', 'eg', 'er', 'es', 'et', 'fi', 'fj', 'fm', 'fr', 'ga',
  'gb', 'gd', 'ge', 'gh', 'gm', 'gn', 'gq', 'gr', 'gt', 'gw', 'gy', 'hk', 'hn', 'hr', 'ht', 'hu', 'id', 'ie', 'il', 'in',
  'iq', 'ir', 'is', 'it', 'jm', 'jo', 'jp', 'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'kz', 'la', 'lb', 'lc',
  'li', 'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly', 'ma', 'mc', 'md', 'me', 'mg', 'mh', 'mk', 'ml', 'mm', 'mn', 'mr', 'mt',
  'mu', 'mv', 'mw', 'mx', 'my', 'mz', 'na', 'ne', 'ng', 'ni', 'nl', 'no', 'np', 'nz', 'om', 'pa', 'pe', 'pg', 'ph', 'pk',
  'pl', 'pt', 'pw', 'py', 'qa', 'ro', 'rs', 'ru', 'rw', 'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn',
  'so', 'sr', 'ss', 'st', 'sv', 'sy', 'sz', 'td', 'tg', 'th', 'tj', 'tl', 'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tw', 'tz',
  'ua', 'ug', 'us', 'uy', 'uz', 'va', 'vc', 've', 'vn', 'vu', 'ws', 'ye', 'za', 'zm', 'zw'
];

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(url + ' → ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log('Ordner erstellt: ' + OUT_DIR);
  }
  let ok = 0;
  let fail = 0;
  for (const code of COUNTRY_CODES) {
    const url = BASE_URL + code + '.png';
    const outFile = path.join(OUT_DIR, code + '.png');
    try {
      const buf = await download(url);
      fs.writeFileSync(outFile, buf);
      ok++;
      process.stdout.write('.');
    } catch (e) {
      fail++;
      console.log('\nFehler ' + code + ': ' + e.message);
    }
  }
  console.log('\nFertig: ' + ok + ' Fahnen gespeichert, ' + fail + ' Fehler.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
