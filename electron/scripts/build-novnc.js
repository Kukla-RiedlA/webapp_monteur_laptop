'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const tla = 'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();';
const sync = 'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false;';

const depthBlock = [
  '      this._fbDepth = 24;',
  '      if (this._fbName === "Intel(r) AMT KVM") {',
  '        Log.Warn("Intel AMT KVM only supports 8/16 bit depths. Using low color mode.");',
  '        this._fbDepth = 8;',
  '      }',
  '      RFB.messages.pixelFormat(this._sock, this._fbDepth, true);',
].join('\n');

const depthReplacement = [
  '      this._fbDepth = 24;',
  '      this._kuklaChannel = null;',
  '      if (this._fbName === "Intel(r) AMT KVM") {',
  '        Log.Warn("Intel AMT KVM only supports 8/16 bit depths. Using low color mode.");',
  '        this._fbDepth = 8;',
  '      }',
  '      var kuklaFmt = kuklaClientFormat({',
  '        bpp: bpp,',
  '        trueColor: trueColor,',
  '        redMax: redMax,',
  '        greenMax: greenMax,',
  '        blueMax: blueMax,',
  '        redShift: redShift,',
  '        greenShift: greenShift,',
  '        blueShift: blueShift',
  '      });',
  '      if (kuklaFmt) {',
  '        this._fbDepth = kuklaFmt.depth;',
  '        this._kuklaChannel = kuklaFmt;',
  '        this._display._kuklaChannel = kuklaFmt;',
  '        RFB.messages.pixelFormatChannels(this._sock, kuklaFmt.bpp, kuklaFmt.depth, kuklaFmt.redMax, kuklaFmt.greenMax, kuklaFmt.blueMax, kuklaFmt.redShift, kuklaFmt.greenShift, kuklaFmt.blueShift);',
  '      } else {',
  '        RFB.messages.pixelFormat(this._sock, this._fbDepth, true);',
  '      }',
].join('\n');

const pixelFormatAnchor = '  pixelFormat: function pixelFormat(sock, depth, trueColor) {';
const pixelFormatChannels = [
  '  pixelFormatChannels: function pixelFormatChannels(sock, bpp, depth, redMax, greenMax, blueMax, redShift, greenShift, blueShift) {',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(bpp);',
  '    sock.sQpush8(depth);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(1);',
  '    sock.sQpush16(redMax);',
  '    sock.sQpush16(greenMax);',
  '    sock.sQpush16(blueMax);',
  '    sock.sQpush8(redShift);',
  '    sock.sQpush8(greenShift);',
  '    sock.sQpush8(blueShift);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(0);',
  '    sock.sQpush8(0);',
  '    sock.flush();',
  '  },',
  pixelFormatAnchor,
].join('\n');

const rawLoop = [
  '        if (depth == 8) {',
  '          var newdata = new Uint8Array(width * 4);',
  '          for (var i = 0; i < width; i++) {',
  '            newdata[i * 4 + 0] = (data[i] >> 0 & 0x3) * 255 / 3;',
  '            newdata[i * 4 + 1] = (data[i] >> 2 & 0x3) * 255 / 3;',
  '            newdata[i * 4 + 2] = (data[i] >> 4 & 0x3) * 255 / 3;',
  '            newdata[i * 4 + 3] = 255;',
  '          }',
  '          data = newdata;',
  '        }',
].join('\n');

const rawLoopReplacement = [
  '        if (depth == 8) {',
  '          var ch = display && display._kuklaChannel;',
  '          var redMax = ch ? ch.redMax : 3;',
  '          var greenMax = ch ? ch.greenMax : 3;',
  '          var blueMax = ch ? ch.blueMax : 3;',
  '          var redShift = ch ? ch.redShift : 0;',
  '          var greenShift = ch ? ch.greenShift : 2;',
  '          var blueShift = ch ? ch.blueShift : 4;',
  '          var newdata = new Uint8Array(width * 4);',
  '          for (var i = 0; i < width; i++) {',
  '            newdata[i * 4 + 0] = kuklaExpandChannel(data[i], redShift, redMax);',
  '            newdata[i * 4 + 1] = kuklaExpandChannel(data[i], greenShift, greenMax);',
  '            newdata[i * 4 + 2] = kuklaExpandChannel(data[i], blueShift, blueMax);',
  '            newdata[i * 4 + 3] = 255;',
  '          }',
  '          data = newdata;',
  '        }',
].join('\n');

esbuild.build({
  entryPoints: ['node_modules/@novnc/novnc/lib/rfb.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'public/vendor/novnc/rfb.js',
  legalComments: 'none',
  plugins: [{
    name: 'novnc-kukla',
    setup(build) {
      build.onResolve({ filter: /^kukla-vnc-low-color$/ }, () => ({
        path: path.join(__dirname, '..', 'lib', 'vnc', 'low-color.js'),
      }));
      build.onLoad({ filter: /[\\/]util[\\/]browser\.js$/ }, (args) => {
        const code = fs.readFileSync(args.path, 'utf8');
        if (!code.includes(tla)) {
          throw new Error('noVNC browser.js hat kein bekanntes Top-Level-await mehr');
        }
        return { contents: code.replace(tla, sync), loader: 'js' };
      });
      build.onLoad({ filter: /[\\/]novnc[\\/]lib[\\/]rfb\.js$/ }, (args) => {
        let code = fs.readFileSync(args.path, 'utf8');
        if (!code.includes(depthBlock) || !code.includes(pixelFormatAnchor)) {
          throw new Error('noVNC rfb.js hat die erwartete Pixelformat-Stelle nicht mehr');
        }
        code = 'var kuklaClientFormat = require("kukla-vnc-low-color").clientFormatForServer;\n' + code;
        code = code.replace(depthBlock, depthReplacement);
        code = code.replace(pixelFormatAnchor, pixelFormatChannels);
        return { contents: code, loader: 'js' };
      });
      build.onLoad({ filter: /[\\/]decoders[\\/]raw\.js$/ }, (args) => {
        let code = fs.readFileSync(args.path, 'utf8');
        if (!code.includes(rawLoop)) {
          throw new Error('noVNC raw.js hat die erwartete 8-Bit-Schleife nicht mehr');
        }
        code = 'var kuklaExpandChannel = require("kukla-vnc-low-color").expandChannel;\n' + code;
        code = code.replace(rawLoop, rawLoopReplacement);
        return { contents: code, loader: 'js' };
      });
    },
  }],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
