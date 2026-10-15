'use strict';

/**
 * Kukla-Wägeterminals melden RFB 3.3 mit 8-Bit-Farbtabelle (trueColor=0,
 * Kanäle 3-3-2). noVNC fordert danach 32-Bit-Truecolor an; das Gerät
 * setzt die TCP-Verbindung daraufhin zurück. Das hier gewählte Format
 * ist 8-Bit-Truecolor in der vom Server gemeldeten Kanalaufteilung.
 * Für normale 16/32-Bit-Server kommt null zurück, noVNC bleibt bei 24 Bit.
 */
function clientFormatForServer(fmt) {
  const bpp = Number(fmt && fmt.bpp);
  const trueColor = Number(fmt && fmt.trueColor) ? 1 : 0;
  if (bpp > 8) return null;
  if (!Number.isFinite(bpp) || bpp < 1) return null;
  const advertised = Number(fmt.redMax) > 0 && Number(fmt.greenMax) > 0 && Number(fmt.blueMax) > 0;
  if (!advertised) {
    return {
      bpp: 8,
      depth: 8,
      trueColor: 1,
      redMax: 7,
      greenMax: 7,
      blueMax: 3,
      redShift: 0,
      greenShift: 3,
      blueShift: 6,
    };
  }
  return {
    bpp: 8,
    depth: 8,
    trueColor: 1,
    redMax: Number(fmt.redMax) & 0xffff,
    greenMax: Number(fmt.greenMax) & 0xffff,
    blueMax: Number(fmt.blueMax) & 0xffff,
    redShift: Number(fmt.redShift) & 0xff,
    greenShift: Number(fmt.greenShift) & 0xff,
    blueShift: Number(fmt.blueShift) & 0xff,
  };
}

function expandChannel(pixel, shift, max) {
  if (!max) return 0;
  return ((pixel >>> shift) & max) * 255 / max;
}

module.exports = {
  clientFormatForServer,
  expandChannel,
};
