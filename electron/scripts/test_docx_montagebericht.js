/**
 * Proof-of-Concept: Montagebericht mit docx-Bibliothek
 * Gewünschte Struktur: Pro Fabrikationsnummer eine eigene Tabelle mit 2 Zeilen:
 *   Zeile 1: FN.: xxxxxx | Type: xxxxxx | Pos.Nr.: xxxxxx
 *   Zeile 2: Eine zusammengeführte Zelle mit Textbausteinen als Aufzählung
 *
 * Ausführen (aus electron/): node scripts/test_docx_montagebericht.js
 * Oder aus Projektroot: cd electron; node scripts/test_docx_montagebericht.js
 */
const path = require('path');
const fs = require('fs');

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
} = require('docx');

function createFnTable(fn) {
  const textbausteine = fn.textbausteine || [];
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
            children: [new Paragraph({ children: [new TextRun({ text: `FN.: ${fn.fabrikationsnummer || ''}`, font: 'Calibri', bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: `Type: ${fn.type || ''}`, font: 'Calibri', bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: `Pos.Nr.: ${fn.position || ''}`, font: 'Calibri', bold: true })] })],
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

async function main() {
  // Logo aus Template (falls vorhanden)
  const logoPath = path.join(__dirname, '..', '..', '..', 'dispo', 'assets', 'templates', 'protokoll', '_extract_de', 'word', 'media', 'image1.jpeg');
  let logoCellContent = [new Paragraph({ text: '' })];
  if (fs.existsSync(logoPath)) {
    try {
      const logoData = fs.readFileSync(logoPath);
      logoCellContent = [
        new Paragraph({
          children: [
            new ImageRun({
              type: 'jpeg',
              data: logoData,
              transformation: { width: 137, height: 92 },
            }),
          ],
        }),
      ];
    } catch (e) {
      console.warn('Logo konnte nicht geladen werden:', e.message);
    }
  }

  const fabrikationsnummern = [
    { fabrikationsnummer: '12005', type: 'D-DW-1', position: '', textbausteine: [
      { text: 'Signal Check Kukla - Kukla' },
      { text: 'Tarieren der Waage' },
      { text: 'Signalcheck Kukla -> SPS' },
    ]},
    { fabrikationsnummer: '12006', type: 'D-DW-1', position: '', textbausteine: [
      { text: 'Signal Check Kukla - Kukla' },
      { text: 'Tarieren der Waage' },
      { text: 'Signalcheck Kukla -> SPS' },
    ]},
  ];

  // Kopftabelle: 3 Spalten, gesamte Breite gleichmäßig aufgeteilt (10060/3 ≈ 3353 DXA)
  // layout: FIXED verhindert, dass Word Spalten nach Inhalt automatisch anpasst
  const headerTable = new Table({
    width: { size: 10060, type: WidthType.DXA },
    columnWidths: [3353, 3354, 3353],
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: logoCellContent,
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'Montagebericht', font: 'Calibri', bold: true, size: 50 }), // 50 half-points = 25pt
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
            children: [new Paragraph({ children: [new TextRun({ text: 'Kunde:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Grenzebach', font: 'Calibri', size: 24 })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'geliefert über: ', font: 'Calibri', bold: true, size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Projekt:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'EP123458', font: 'Calibri', size: 24 })] })],
          }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'Datum: ', font: 'Calibri', bold: true, size: 24 }),
                  new TextRun({ text: '2026-03-17 – 2026-03-19', font: 'Calibri', size: 24 }),
                ],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'FN.:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: fabrikationsnummern.map((f) => f.fabrikationsnummer).join(', '), font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Servicetechniker:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: 'Riedl Alois', font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Ansprechperson:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: '', font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Grund des Einsatzes:', font: 'Calibri', bold: true, italics: true, size: 24 })] })],
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph({ children: [new TextRun({ text: 'Montage und Service', font: 'Calibri', size: 24 })] })],
          }),
        ],
      }),
    ],
  });

  // Einheitlicher Abstand zwischen allen Tabellen (100 twips ≈ 5 pt)
  const tableSpacing = new Paragraph({ text: '', spacing: { before: 100 } });

  const children = [
    headerTable,
    tableSpacing,
    ...fabrikationsnummern.flatMap((fn, i) =>
      i === 0 ? [createFnTable(fn)] : [tableSpacing, createFnTable(fn)]
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'Bemerkungen:', font: 'Calibri', bold: true })] }),
    new Paragraph({ text: '' }),
  ];

  const doc = new Document({
    sections: [{
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(__dirname, '..', 'Montagebericht_DOCX_KOPF.docx');
  fs.writeFileSync(outPath, buffer);
  console.log('OK: Montagebericht gespeichert unter', outPath);
  console.log('Bitte Datei öffnen und prüfen:');
  console.log('- Pro FN eine eigene Tabelle?');
  console.log('- Zeile 1: FN.: xxxxxx | Type: xxxxxx | Pos.Nr.: xxxxxx');
  console.log('- Zeile 2: Textbausteine als Aufzählung?');
}

main().catch((err) => {
  console.error('Fehler:', err);
  process.exit(1);
});
