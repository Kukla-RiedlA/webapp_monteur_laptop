'use strict';

/**
 * Pflicht-Layout für pdf-lib-Protokolle (Laptop).
 *
 * Neue PDFs in protocol_pdf.js (oder einem Nachfolger) müssen DIESE Farben
 * und die in protocol_pdf.js bereits vorhandenen Helfer nutzen:
 *   - embedLogo          PNG mit Alpha zuerst, sonst weißer/schwarzer Kasten
 *   - embedProtocolFonts Unicode (Arial/Calibri), sonst Helvetica
 *   - Headerband         Logo + Titel + Meta, auf jeder Seite
 *   - Footer             „Seite n“ / Datum, nicht in den Content zeichnen
 *   - Keep-together      FN-Leiste + Textanfang nicht allein am Seitenende
 *                        (siehe measureFnBlockKeepHeight / test-montagebericht-pdf-pagebreak.js)
 *
 * Keine neuen Grün-Hex-Werte. Keine zweite PDF-Engine.
 * Rule: .cursor/rules/formular-pdf-design.mdc
 */

const PAGE_A4_PORTRAIT = Object.freeze({ w: 595.28, h: 841.89 });
const PAGE_A4_LANDSCAPE = Object.freeze({ w: 841.89, h: 595.28 });

/**
 * @param {(r: number, g: number, b: number) => unknown} rgb  pdf-lib rgb()
 */
function kuklaPdfColors(rgb) {
  return {
    green: rgb(14 / 255, 123 / 255, 90 / 255),
    greenDark: rgb(12 / 255, 106 / 255, 77 / 255),
    greenSoft: rgb(207 / 255, 232 / 255, 209 / 255),
    greenHeader: rgb(232 / 255, 244 / 255, 236 / 255),
    grayText: rgb(0.25, 0.25, 0.25),
    grayMuted: rgb(0.45, 0.45, 0.45),
    lineGray: rgb(0.78, 0.82, 0.8),
    white: rgb(1, 1, 1),
    sumBg: rgb(0.93, 0.96, 0.94),
  };
}

module.exports = {
  PAGE_A4_PORTRAIT,
  PAGE_A4_LANDSCAPE,
  kuklaPdfColors,
};
