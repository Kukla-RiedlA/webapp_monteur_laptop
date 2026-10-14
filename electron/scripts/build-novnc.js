'use strict';

const fs = require('fs');
const esbuild = require('esbuild');

const tla = 'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();';
const sync = 'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false;';

esbuild.build({
  entryPoints: ['node_modules/@novnc/novnc/lib/rfb.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'public/vendor/novnc/rfb.js',
  legalComments: 'none',
  plugins: [{
    name: 'novnc-no-top-level-await',
    setup(build) {
      build.onLoad({ filter: /[\\/]util[\\/]browser\.js$/ }, (args) => {
        const code = fs.readFileSync(args.path, 'utf8');
        if (!code.includes(tla)) {
          throw new Error('noVNC browser.js hat kein bekanntes Top-Level-await mehr');
        }
        return { contents: code.replace(tla, sync), loader: 'js' };
      });
    },
  }],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
