/**
 * Erstellt minimale DOCX-Vorlagen für Montagebericht (DE/EN) mit poi-tl Platzhaltern.
 * Schreibt nach dispo/assets/templates/protokoll/
 * Ausführen: node scripts/create_protokoll_templates.js
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const dispoRoot = path.join(__dirname, '..', '..', 'dispo');
const templatesDir = path.join(dispoRoot, 'assets', 'templates', 'protokoll');
if (!fs.existsSync(templatesDir)) {
  fs.mkdirSync(templatesDir, { recursive: true });
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
`;

function createDocumentXml(lang, usePoiTl) {
  const title = lang === 'de' ? 'Montagebericht' : 'Assembly report';
  const labels = lang === 'de'
    ? ['Kunde:', 'Projekt:', 'Datum:', 'Geliefert über:', 'Servicetechniker:', 'Ansprechperson:', 'Grund des Einsatzes:', 'FN.', 'Type', 'Pos.Nr.']
    : ['Customer:', 'Project:', 'Date:', 'Delivered via:', 'Service engineer:', 'Contact person:', 'Purpose of visit:', 'FN.', 'Type', 'Pos.No.'];
  const [lKunde, lProjekt, lDatum, lGeliefert, lTech, lAnsprech, lGrund, lFn, lType, lPos] = labels;
  const loopStart = usePoiTl ? '{{?fabrikationsnummern}}' : '{{#fabrikationsnummern}}';
  const loopEnd = usePoiTl ? '{{/fabrikationsnummern}}' : '{{/fabrikationsnummern}}';
  const tbLoopStart = usePoiTl ? '{{?textbausteine}}' : '{{#textbausteine}}';
  const tbLoopEnd = usePoiTl ? '{{/textbausteine}}' : '{{/textbausteine}}';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>${title}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lKunde} {{kunde}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lProjekt} {{projekt}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lDatum} {{datum}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lGeliefert} {{geliefert_ueber}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lTech} {{servicetechniker}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lAnsprech} {{ansprechperson}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lGrund} {{grund_des_einsatzes}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${loopStart}</w:t></w:r></w:p>
<w:p><w:r><w:t>${lFn} {{fabrikationsnummer}} | ${lType} {{type}} | ${lPos} {{position}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${tbLoopStart}</w:t></w:r></w:p>
<w:p><w:r><w:t>• {{text}}</w:t></w:r></w:p>
<w:p><w:r><w:t>${tbLoopEnd}</w:t></w:r></w:p>
<w:p><w:r><w:t>${loopEnd}</w:t></w:r></w:p>
<w:p><w:r/></w:p>
</w:body>
</w:document>`;
}

function createDocx(lang, filename) {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(templatesDir, '_tmp_' + lang);
    fs.mkdirSync(path.join(tmpDir, 'word', '_rels'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '_rels'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, '[Content_Types].xml'), contentTypes);
    fs.writeFileSync(path.join(tmpDir, '_rels', '.rels'), rels);
    fs.writeFileSync(path.join(tmpDir, 'word', '_rels', 'document.xml.rels'), docRels);
    fs.writeFileSync(path.join(tmpDir, 'word', 'document.xml'), createDocumentXml(lang, filename.includes('_poi')));

    const outPath = path.join(templatesDir, filename);
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(tmpDir, false);
    archive.finalize();

    output.on('close', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
    archive.on('error', reject);
  });
}

async function main() {
  try {
    await createDocx('de', 'Montagebericht_DE_poi.docx');
    console.log('Erstellt: Montagebericht_DE_poi.docx');
    await createDocx('en', 'Montagebericht_EN_poi.docx');
    console.log('Erstellt: Montagebericht_EN_poi.docx');
    try {
      await createDocx('de', 'Montagebericht_DE.docx');
      console.log('Erstellt: Montagebericht_DE.docx');
      await createDocx('en', 'Montagebericht_EN.docx');
      console.log('Erstellt: Montagebericht_EN.docx');
    } catch (e) {
      if (e && (e.code === 'EBUSY' || e.errno === -4082)) console.warn('Montagebericht_DE/EN.docx übersprungen (Datei gesperrt)');
      else throw e;
    }
    console.log('Fertig.');
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
