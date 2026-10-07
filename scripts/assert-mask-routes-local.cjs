'use strict';

/**
 * Masken-Routen dürfen Dispo nicht auf dem Request-Pfad awaiten.
 * Neue Route: hier eintragen, sonst bleibt der Check blind.
 */
const fs = require('fs');
const path = require('path');
const localFirst = require(path.join(__dirname, '..', 'electron', 'lib', 'local_first.js'));

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'electron', 'server.js'), 'utf8');
const hinweiseSrc = fs.readFileSync(path.join(root, 'electron', 'lib', 'hinweise-routes.js'), 'utf8');
const zeitSrc = fs.readFileSync(path.join(root, 'electron', 'lib', 'zeitschreibung-routes.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'electron', 'public', 'app.js'), 'utf8');

const failures = [];

function fail(msg) {
  failures.push(msg);
}

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

if (localFirst.shouldDeferDispoSync({}) !== true) {
  fail('shouldDeferDispoSync() muss auf dem Maskenpfad true sein');
}
if (localFirst.shouldDeferDispoSync({ hasBaseUrl: true }) !== true) {
  fail('gesetzte Dispo-URL darf den Sync nicht mehr auf den Request ziehen');
}
if (localFirst.shouldDeferDispoSync({ explicitSync: true }) !== false) {
  fail('Hintergrund-Sync muss explicitSync setzen dürfen');
}

const serviceGet = sliceBetween(
  serverSrc,
  'async function handleServiceLikeProtokollGet',
  'app.get(\'/api/protokolle/serviceprotokoll\'',
);
if (!serviceGet) fail('handleServiceLikeProtokollGet nicht gefunden');
if (/syncServiceprotokollStoreWithDispo|getOrCreateDienstreiseFolderForJob|await fetch/.test(serviceGet)) {
  fail('Service/IBN-GET wartet noch auf Dispo oder den Reiseordner');
}

const jobFrom = sliceBetween(serverSrc, "app.post('/api/job_from_dispo'", "app.post('/api/dispo_signature_session_open'");
if (/resolveDispoWorkingBase|await fetch\(/.test(jobFrom)) {
  fail('job_from_dispo holt den Auftrag noch live');
}

const ted = sliceBetween(serverSrc, "app.post('/api/mechanik_ted_excel_from_dispo'", "app.post('/api/mechanik_ted_excel_pull_job'");
if (/await fetch\(/.test(ted)) {
  fail('TED-Liste wartet noch auf Dispo');
}

function sliceRoute(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\n {2}app\.(get|post|patch|delete)\(/);
  return next < 0 ? rest.slice(0, 4000) : rest.slice(0, next);
}

for (const route of [
  '/api/protokolle/montagebericht',
  '/api/protokolle/kontrollwiegung',
  '/api/protokolle/schleppketten',
  '/api/protokolle/pruefzertifikat',
]) {
  const block = sliceRoute(serverSrc, "app.get('" + route + "'");
  if (!block) fail('GET ' + route + ' nicht gefunden');
  if (/pullOneJsonDraftForJob/.test(block)) {
    fail('GET ' + route + ' zieht den Draft noch vor der Antwort');
  }
}

const sigGet = sliceBetween(serverSrc, "app.get('/api/technician/signature'", "app.post('/api/technician/signature'");
if (/syncWithDispo/.test(sigGet)) {
  fail('Signatur-GET synchronisiert noch vor der Antwort');
}

const mine = sliceBetween(hinweiseSrc, "app.get('/api/hinweise/mine'", "app.get('/api/hinweise'");
if (/fetchDispoJson|await fetch\(/.test(mine)) {
  fail('Hinweis-Lampe wartet noch auf Dispo');
}

const zeitGet = sliceBetween(zeitSrc, "app.get('/api/zeitschreibung'", "app.post('/api/zeitschreibung/save'");
if (/pullLohnLocksFromDispo|await fetch\(/.test(zeitGet)) {
  fail('Zeitschreibung-GET wartet noch auf Dispo');
}

if (/montagebericht\?job_id=.*baseUrl/.test(appSrc)) {
  fail('Montagebericht-Laden hängt noch baseUrl an');
}

if (failures.length) {
  console.error('Masken-Offline-Check fehlgeschlagen:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('OK  Masken-Routen antworten lokal (shouldDefer + Quell-Check)');
