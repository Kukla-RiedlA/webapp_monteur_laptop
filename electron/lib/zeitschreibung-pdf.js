'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const calc = require('./zeitschreibung-calc');

function fmtHours(n) {
  const v = calc.num(n);
  if (!v) return '';
  return String(Math.round(v * 1000) / 1000).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
}

function fmtHoursAlways(n) {
  const v = calc.round2(n);
  if (Math.abs(v) < 1e-9) return '0';
  return String(v);
}

function fillRgbForDay(d) {
  const kind = calc.rowColorKind(d);
  if (!kind || !calc.ROW_COLORS[kind]) return null;
  const c = calc.ROW_COLORS[kind].rgb;
  return rgb(c[0], c[1], c[2]);
}

function fillRgbForSumme(daySumValue) {
  const kind = calc.summeAlertKind(daySumValue);
  if (!kind || !calc.SUMME_ALERT_COLORS[kind]) return null;
  const c = calc.SUMME_ALERT_COLORS[kind].rgb;
  return rgb(c[0], c[1], c[2]);
}

/**
 * Excel-ähnliches Querformat-PDF der Monatszeitschreibung.
 * @returns {Promise<Buffer>}
 */
async function generateZeitschreibungPdfBuffer(payload) {
  const year = Number(payload.year);
  const month = Number(payload.month);
  const name = String(payload.technicianName || '');
  const days = (Array.isArray(payload.days) ? payload.days : []).map(calc.enrichDay);
  const sums = payload.sums || calc.columnSums(days);
  const gesamt = payload.gesamt != null ? calc.num(payload.gesamt) : calc.gesamtSum(sums);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 841.89;
  const pageH = 595.28;
  const margin = 28;
  const page = doc.addPage([pageW, pageH]);

  let y = pageH - margin;
  page.drawText('Stundenaufzeichnung', {
    x: margin,
    y: y - 14,
    size: 16,
    font: fontBold,
    color: rgb(0.05, 0.48, 0.35),
  });
  y -= 34;

  const monLabel = calc.MONTH_NAMES[month] || String(month);
  page.drawText(`${monLabel}  ${year}  ${name}`, {
    x: margin,
    y: y - 10,
    size: 11,
    font: fontBold,
  });
  y -= 22;

  const headers = [
    'Datum',
    'Tag',
    'Feiert.',
    'Anw.',
    'Montage',
    'Ü/50%',
    'Ü/100%',
    'Weg',
    'Urlaub',
    'ZA+',
    'ZA-',
    'Krank',
    'Arzt',
    'Summe',
    'Bemerkung',
  ];
  const colW = [58, 28, 62, 40, 48, 42, 46, 36, 42, 36, 36, 42, 42, 42, 150];
  const tableLeft = margin;
  const rowH = 14;
  const headerH = 16;
  const fontSize = 7.5;

  function drawRow(cells, yy, bold, fillColor, cellFills) {
    let x = tableLeft;
    const f = bold ? fontBold : font;
    const defaultBg = fillColor || (bold ? rgb(0.93, 0.96, 0.94) : rgb(1, 1, 1));
    for (let i = 0; i < headers.length; i++) {
      const w = colW[i];
      const bg = (cellFills && cellFills[i]) || defaultBg;
      page.drawRectangle({
        x,
        y: yy - rowH + 2,
        width: w,
        height: rowH,
        color: bg,
        borderWidth: 0,
      });
      page.drawRectangle({
        x,
        y: yy - rowH + 2,
        width: w,
        height: rowH,
        borderColor: rgb(0.55, 0.55, 0.55),
        borderWidth: 0.4,
      });
      const text = String(cells[i] ?? '');
      const maxW = w - 4;
      let draw = text;
      while (draw.length > 1 && f.widthOfTextAtSize(draw, fontSize) > maxW) {
        draw = draw.slice(0, -1);
      }
      if (draw) {
        page.drawText(draw, {
          x: x + 2,
          y: yy - rowH + 5,
          size: fontSize,
          font: f,
          color: rgb(0.05, 0.05, 0.05),
        });
      }
      x += w;
    }
  }

  drawRow(headers, y, true, rgb(0.93, 0.96, 0.94));
  y -= headerH;

  const SUMME_COL = 13;
  for (const d of days) {
    if (y < margin + 40) break;
    const dk = String(d.day_date || '');
    const dateDe = dk.length >= 10 ? `${dk.slice(8, 10)}.${dk.slice(5, 7)}.${dk.slice(0, 4)}` : dk;
    const daySumVal = d.day_sum != null ? d.day_sum : calc.daySum(d);
    const summeFill = fillRgbForSumme(daySumVal);
    const cellFills = summeFill ? { [SUMME_COL]: summeFill } : null;
    drawRow(
      [
        dateDe,
        d.weekday || '',
        d.holiday_label || '',
        fmtHours(d.anw),
        fmtHours(d.montage),
        fmtHours(d.ue50),
        fmtHours(d.ue100),
        fmtHours(d.weg),
        fmtHours(d.urlaub),
        fmtHours(d.za_plus),
        fmtHours(d.za_minus),
        fmtHours(d.krank),
        fmtHours(d.arzt),
        fmtHours(daySumVal),
        d.bemerkung || '',
      ],
      y,
      false,
      fillRgbForDay(d),
      cellFills,
    );
    y -= rowH;
  }

  y -= 4;
  drawRow(
    [
      'Gesamt',
      fmtHoursAlways(gesamt),
      '',
      fmtHoursAlways(sums.anw),
      fmtHoursAlways(sums.montage),
      fmtHoursAlways(sums.ue50),
      fmtHoursAlways(sums.ue100),
      fmtHoursAlways(sums.weg),
      fmtHoursAlways(sums.urlaub),
      fmtHoursAlways(sums.za_plus),
      fmtHoursAlways(sums.za_minus),
      fmtHoursAlways(sums.krank),
      fmtHoursAlways(sums.arzt),
      fmtHoursAlways(sums.day_sum),
      '',
    ],
    y,
    true,
    rgb(0.91, 0.91, 0.91),
  );

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { generateZeitschreibungPdfBuffer };
