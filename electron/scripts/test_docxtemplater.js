/**
 * Standalone-Test für docxtemplater mit Montagebericht-Vorlage.
 * Ausführen: cd electron && node scripts/test_docxtemplater.js
 *
 * Prüft, ob die Vorlage korrekt geladen wird und Platzhalter ersetzt werden.
 */
const path = require('path');
const fs = require('fs');

const dispoPath = path.join(__dirname, '..', '..', '..', 'dispo', 'assets', 'templates', 'protokoll', 'Montagebericht_DE.docx');
const templatePath = path.join(__dirname, '..', 'templates', 'Montagebericht_DE.docx');
const templatePathToUse = fs.existsSync(dispoPath) ? dispoPath : templatePath;
const outputPath = path.join(__dirname, '..', 'Montagebericht_TEST.docx');

if (!fs.existsSync(templatePathToUse)) {
  console.error('Vorlage nicht gefunden:', templatePathToUse);
  console.error('Bitte zuerst pack_protokoll_templates.ps1 ausführen und Vorlage nach electron/templates/ kopieren.');
  process.exit(1);
}

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const content = fs.readFileSync(templatePathToUse, 'binary');
const zip = new PizZip(content);
const doc = new Docxtemplater(zip, {
  delimiters: { start: '{{', end: '}}' },
  paragraphLoop: false,
  nullGetter: () => '',
  linebreaks: true,
});

const docData = {
  kunde: 'TEST-KUNDE GmbH',
  projekt: 'Projekt 12345',
  datum: '2025-03-09',
  geliefert_ueber: 'Spedition Müller',
  servicetechniker: 'Max Mustermann',
  ansprechperson: 'Anna Schmidt',
  grund_des_einsatzes: 'Wartung und Kalibrierung',
  fn_list: 'FN-001, FN-002',
  fabrikationsnummern: [
    { fabrikationsnummer: 'FN-001', type: 'Waage', position: '1', textbausteine: [{ text: 'Montage durchgeführt.' }], bemerkungen_cell: 'Montage durchgeführt.' },
    { fabrikationsnummer: 'FN-002', type: 'Waage', position: '2', textbausteine: [{ text: 'Inbetriebnahme OK.' }], bemerkungen_cell: 'Inbetriebnahme OK.' },
  ],
  bemerkungen: 'Alles in Ordnung.',
  'grund des einsatzes': 'Wartung und Kalibrierung',
  'geliefert ueber': 'Spedition Müller',
};

console.log('Test-Daten:', JSON.stringify(docData, null, 2));

try {
  doc.render(docData);
  const buf = doc.toBuffer();
  fs.writeFileSync(outputPath, buf);
  console.log('OK: Test-DOCX gespeichert unter', outputPath);
  console.log('Bitte Datei öffnen und prüfen, ob alle Felder ausgefüllt sind.');
} catch (err) {
  console.error('Fehler:', err.message);
  if (err.properties) console.error('Properties:', JSON.stringify(err.properties, null, 2));
  process.exit(1);
}
