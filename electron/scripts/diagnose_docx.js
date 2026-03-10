/**
 * Diagnose: Warum öffnet Word die generierte DOCX nicht?
 * Test 1: Vorlage laden → sofort wieder speichern (ohne docxtemplater)
 * Test 2: Vorlage laden → docxtemplater render → speichern
 *
 * Ausführen: cd electron && node scripts/diagnose_docx.js
 */
const path = require('path');
const fs = require('fs');

const templatePath = path.join(__dirname, '..', 'templates', 'Montagebericht_DE.docx');
const out1 = path.join(__dirname, '..', 'Montagebericht_PASSTHROUGH.docx');  // nur PizZip roundtrip
const out2 = path.join(__dirname, '..', 'Montagebericht_TEST.docx');         // mit docxtemplater

if (!fs.existsSync(templatePath)) {
  console.error('Vorlage nicht gefunden:', templatePath);
  process.exit(1);
}

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const content = fs.readFileSync(templatePath, 'binary');

console.log('=== Test 1: Nur PizZip Roundtrip (ohne docxtemplater) ===');
try {
  const zip1 = new PizZip(content);
  const buf1 = zip1.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  fs.writeFileSync(out1, buf1);
  console.log('OK:', out1);
  console.log('  -> Bitte in Word öffnen. Öffnet sich die Datei?');
} catch (e) {
  console.error('Fehler:', e.message);
}

console.log('\n=== Test 2: Mit docxtemplater render ===');
try {
  const zip2 = new PizZip(content);
  const doc = new Docxtemplater(zip2, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
  });
  doc.hideDeprecations = true;
  doc.render({
    kunde: 'TEST',
    projekt: 'Projekt',
    datum: '2025-03-09',
    geliefert_ueber: '-',
    servicetechniker: '-',
    ansprechperson: '-',
    grund_des_einsatzes: '-',
    fn_list: '-',
    fabrikationsnummern: [],
    bemerkungen: '-',
  });
  const buf2 = doc.toBuffer();
  fs.writeFileSync(out2, buf2);
  console.log('OK:', out2);
  console.log('  -> Bitte in Word öffnen. Öffnet sich die Datei?');
} catch (e) {
  console.error('Fehler:', e.message);
}

console.log('\n=== Auswertung ===');
console.log('- Öffnet PASSTHROUGH in Word? -> Wenn NEIN: Vorlage oder PizZip-Problem.');
console.log('- Öffnet TEST in Word?         -> Wenn NEIN, PASSTHROUGH JA: docxtemplater korrigiert etwas falsch.');
