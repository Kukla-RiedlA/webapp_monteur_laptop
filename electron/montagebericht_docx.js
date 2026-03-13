/**
 * Montagebericht-DOCX-Generator mit docx-Bibliothek
 * Erzeugt das Montagebericht-Dokument programmatisch (Calibri, feste Spaltenbreiten).
 */
const path = require('path');
const fs = require('fs');

/** JPG/JPEG-Buffer: weiße Pixel transparent machen, als PNG zurückgeben. Schwellwert 0–255 (z. B. 250 = fast weiß). */
async function makeWhiteTransparentPng(jpegBuffer, whiteThreshold = 250) {
  const sharp = require('sharp');
  const { data, info } = await sharp(jpegBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
      data[i + 3] = 0;
    }
  }
  return sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  VerticalAlign,
  TextRun,
  TableLayoutType,
  BorderStyle,
  HeightRule,
} = require('docx');

const sanitize = (v) => {
  if (v == null || v === undefined) return '';
  const s = String(v).trim();
  return (s === 'undefined' || s === 'null') ? '' : s;
};

function createFnTable(fn, L) {
  const textbausteine = Array.isArray(fn.textbausteine)
    ? fn.textbausteine.map((tb) => ({ text: sanitize(tb && tb.text != null ? tb.text : '') })).filter((t) => t.text)
    : [];
  const textbausteinParagraphs = textbausteine.length > 0
    ? textbausteine.map((tb) => new Paragraph({
        children: [new TextRun({ text: (tb.text || '').trim(), font: 'Calibri' })],
        bullet: { level: 0 },
      }))
    : [new Paragraph({ children: [new TextRun({ text: '', font: 'Calibri' })] })];

  // 3 Spalten: FN. | Type | Pos.Nr. (Bemerkungen-Spalte entfernt), gleichmäßig aufgeteilt
  const colW = Math.floor(10060 / 3);
  const colWidths = [colW, colW, 10060 - colW * 2];

  return new Table({
    width: { size: 10060, type: WidthType.DXA },
    columnWidths: colWidths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: `${L.fn}: ${fn.fabrikationsnummer || ''}`, font: 'Calibri', bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: `${L.type}: ${fn.type || ''}`, font: 'Calibri', bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: `${L.posNr}: ${fn.position || ''}`, font: 'Calibri', bold: true })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            columnSpan: 3,
            children: textbausteinParagraphs,
          }),
        ],
      }),
    ],
  });
}

async function getLogoCellContent(dirname) {
  const logoPaths = [
    path.join(dirname, 'public', 'assets', 'img', 'kukla_logo.png'),
    path.join(dirname, '..', '..', 'dispo', 'assets', 'templates', 'protokoll', '_extract_de', 'word', 'media', 'image1.jpeg'),
    path.join(dirname, 'public', 'assets', 'img', 'kukla_logo.jpg'),
  ];
  for (const logoPath of logoPaths) {
    if (fs.existsSync(logoPath)) {
      try {
        let logoData = fs.readFileSync(logoPath);
        const ext = path.extname(logoPath).toLowerCase();
        let mimeType = ext === '.png' ? 'png' : 'jpeg';
        // Bei JPG/JPEG: weißen Hintergrund transparent machen (als PNG einbetten)
        if (ext === '.jpg' || ext === '.jpeg') {
          try {
            logoData = await makeWhiteTransparentPng(logoData, 250);
            mimeType = 'png';
          } catch (imgErr) {
            console.warn('Logo Weiß→transparent fehlgeschlagen, verwende Original:', imgErr.message);
          }
        }
        // Logo als schwebendes Bild hinter die Zelle (behindDocument), damit der Zellenrahmen über dem Bild liegt
        return [
          new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [
              new ImageRun({
                type: mimeType,
                data: logoData,
                transformation: { width: 137, height: 92 },
                floating: {
                  behindDocument: true,
                  layoutInCell: true,
                  horizontalPosition: { relative: 'column', align: 'left', offset: 91440 },
                  verticalPosition: { relative: 'paragraph', align: 'top', offset: 45720 },
                },
              }),
            ],
          }),
        ];
      } catch (e) {
        console.warn('Logo konnte nicht geladen werden:', logoPath, e.message);
      }
    }
  }
  return [new Paragraph({ text: '' })];
}

function formatDatum(kopfdaten, jobRow) {
  const explicit = sanitize(kopfdaten.datum);
  if (explicit) return explicit;
  const start = jobRow && jobRow.start_datetime ? new Date(jobRow.start_datetime).toISOString().slice(0, 10) : null;
  const end = jobRow && jobRow.end_datetime ? new Date(jobRow.end_datetime).toISOString().slice(0, 10) : null;
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || new Date().toISOString().slice(0, 10);
}

/**
 * Erzeugt den Montagebericht als DOCX-Buffer.
 * @param {Object} options
 * @param {Object} options.kopfdaten - { kunde, projekt, datum, geliefertUeber, servicetechniker, ansprechperson, bemerkungen }
 * @param {Array} options.tableRows - [{ fabrikationsnummer, type, position, textbausteine }]
 * @param {string} options.language - 'de' oder 'en'
 * @param {Object} options.jobRow - { customer_name, job_number, description, start_datetime, end_datetime }
 * @param {string} options.grundDesEinsatzes
 * @param {string} options.freitext
 * @returns {Promise<Buffer>}
 */
async function buildMontageberichtDocx(options) {
  const { kopfdaten = {}, tableRows = [], language = 'de', jobRow = {}, grundDesEinsatzes = '', freitext = '' } = options;
  const isEn = language === 'en';
  const L = {
    title: isEn ? 'Assembly report' : 'Montagebericht',
    kunde: isEn ? 'customer:' : 'Kunde:',
    geliefertUeber: isEn ? 'delivered via:' : 'geliefert über:',
    projekt: isEn ? 'project:' : 'Projekt:',
    datum: isEn ? 'date:' : 'Datum:',
    fn: isEn ? 'FN.' : 'FN.',
    type: isEn ? 'type:' : 'Type:',
    posNr: isEn ? 'pos.No.:' : 'Pos.Nr.:',
    bemerkungen: isEn ? 'Remarks' : 'Bemerkungen',
    servicetechniker: isEn ? 'service engineer:' : 'Servicetechniker:',
    ansprechperson: isEn ? 'contact person:' : 'Ansprechperson:',
    grundDesEinsatzes: isEn ? 'purpose of visit:' : 'Grund des Einsatzes:',
  };

  const kunde = sanitize(kopfdaten.kunde ?? jobRow.customer_name ?? '');
  const projekt = sanitize(kopfdaten.projekt ?? jobRow.job_number ?? jobRow.description ?? '');
  const datumStr = formatDatum(kopfdaten, jobRow);
  const geliefertUeber = sanitize(kopfdaten.geliefertUeber ?? '');
  const servicetechniker = sanitize(kopfdaten.servicetechniker ?? '');
  const ansprechperson = sanitize(kopfdaten.ansprechperson ?? '');
  const grundVal = sanitize(grundDesEinsatzes) + (freitext ? ' ' + sanitize(freitext) : '');
  const fnList = tableRows.map((r) => r.fabrikationsnummer).filter(Boolean).join(', ');
  const bemerkungen = sanitize(kopfdaten.bemerkungen ?? '');

  const logoCellContent = await getLogoCellContent(__dirname);

  const headerTable = new Table({
    width: { size: 10060, type: WidthType.DXA },
    columnWidths: [3353, 3354, 3353],
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        height: { value: 1390, rule: HeightRule.EXACT }, // max 2,45 cm (Logo ~2,43 cm), in 1/20 pt (2,45 cm ≈ 69,5 pt)
        children: [
          new TableCell({
            children: logoCellContent,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
              left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
              right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            },
          }),
          new TableCell({
            columnSpan: 2,
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: L.title, font: 'Calibri', bold: true, size: 50 }),
                ],
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.kunde, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: kunde, font: 'Calibri', size: 24 })] })],
          }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: L.geliefertUeber + ' ', font: 'Calibri', bold: true, size: 24 }),
                  new TextRun({ text: geliefertUeber, font: 'Calibri', size: 24 }),
                ],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.projekt, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: projekt, font: 'Calibri', size: 24 })] })],
          }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: L.datum + ' ', font: 'Calibri', bold: true, size: 24 }),
                  new TextRun({ text: datumStr, font: 'Calibri', size: 24 }),
                ],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.fn + ':', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: fnList, font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.servicetechniker, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: servicetechniker, font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.ansprechperson, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: ansprechperson, font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: L.grundDesEinsatzes, font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: grundVal, font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
    ],
  });

  const tableSpacing = new Paragraph({ text: '', spacing: { before: 100 } });

  const children = [
    headerTable,
    tableSpacing,
    ...tableRows.flatMap((fn, i) =>
      i === 0 ? [createFnTable(fn, L)] : [tableSpacing, createFnTable(fn, L)]
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: L.bemerkungen + ':', font: 'Calibri', bold: true })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: bemerkungen, font: 'Calibri' })] }),
    new Paragraph({ text: '' }),
  ];

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildMontageberichtDocx };
