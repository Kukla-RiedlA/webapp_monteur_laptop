'use strict';

const path = require('path');
const fs = require('fs');
const { resolveMonteurDraftJsonPath } = require('./multi-device-sync');

function kontrollwiegungJsonPath(reiseDir) {
  return resolveMonteurDraftJsonPath(reiseDir, 'kontrollwiegungsprotokoll.json', true);
}

function readKontrollwiegungStore(reiseDir) {
  const p = kontrollwiegungJsonPath(reiseDir);
  if (!fs.existsSync(p)) return { byFab: {}, nextLocalId: 1 };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && typeof data === 'object') {
      if (!data.byFab) data.byFab = {};
      if (!data.nextLocalId) data.nextLocalId = 1;
      return data;
    }
  } catch (_) {}
  return { byFab: {}, nextLocalId: 1 };
}

function writeKontrollwiegungStore(reiseDir, store) {
  const p = kontrollwiegungJsonPath(reiseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
}

function saveKontrollwiegungLocal(reiseDir, fab, entry) {
  const fn = String(fab || '').trim();
  if (!fn) throw new Error('Fabrikationsnummer fehlt.');
  const store = readKontrollwiegungStore(reiseDir);
  const localId = store.nextLocalId || 1;
  store.nextLocalId = localId + 1;
  const record = Object.assign({}, entry, {
    local_id: localId,
    protokoll_id: 'local:' + localId,
    updated_at: new Date().toISOString(),
    gespeichert_am: new Date().toISOString(),
    fabrikationsnummer: fn,
  });
  store.byFab[fn] = record;
  writeKontrollwiegungStore(reiseDir, store);
  return record;
}

function getKontrollwiegungLocal(reiseDir, fab, localId) {
  const store = readKontrollwiegungStore(reiseDir);
  const fn = String(fab || '').trim();
  if (fn && store.byFab[fn]) return store.byFab[fn];
  if (localId != null) {
    const lid = String(localId).replace(/^local:/, '');
    for (const rec of Object.values(store.byFab)) {
      if (String(rec.local_id) === lid || rec.protokoll_id === 'local:' + lid) return rec;
    }
  }
  return null;
}

/** Legacy: flache Ablage unter Dokumente_Monteur/. Neu: …/Montage/<AO>/Protokolle/ (server.js). */
function localPdfPathForKontrollwiegung(reiseDir, fab, datum) {
  const safeFn = String(fab || '').replace(/[^\w.-]+/g, '_');
  const d = String(datum || '').replace(/-/g, '');
  const name = 'Kontrollwiegungsprotokoll_' + safeFn + '_' + d + '.pdf';
  return { full: path.join(reiseDir, 'Dokumente_Monteur', name), rel: 'Dokumente_Monteur/' + name, name };
}

module.exports = {
  kontrollwiegungJsonPath,
  readKontrollwiegungStore,
  writeKontrollwiegungStore,
  saveKontrollwiegungLocal,
  getKontrollwiegungLocal,
  localPdfPathForKontrollwiegung,
};
