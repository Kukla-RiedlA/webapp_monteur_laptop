'use strict';

const path = require('path');
const fs = require('fs');
const { resolveMonteurDraftJsonPath } = require('./multi-device-sync');

function parseLocaleNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Excel-Regeln:
 * pruefkette_t = kg/m * Geschw. * Messzeit / 1000
 * fehler_% = (Bandwaage - Prüfkette) / Prüfkette * 100
 * leistung_th = Prüfkette / Messzeit * 3600
 * leer wenn Messzeit < 1
 */
function computeMessungFields(row) {
  const band = parseLocaleNumber(row && row.bandwaage_t);
  const kgm = parseLocaleNumber(row && row.kg_pro_m);
  const geschw = parseLocaleNumber(row && row.geschwindigkeit_ms);
  const messzeit = parseLocaleNumber(row && row.messzeit_s);
  let pruefkette_t = '';
  let fehler_prozent = '';
  let leistung_th = '';
  if (messzeit != null && messzeit >= 1 && kgm != null && geschw != null) {
    const pk = (kgm * geschw * messzeit) / 1000;
    pruefkette_t = pk;
    if (band != null && pk !== 0) {
      fehler_prozent = ((band - pk) / pk) * 100;
    }
    leistung_th = (pk / messzeit) * 3600;
  }
  return {
    pruefkette_t: pruefkette_t === '' ? '' : pruefkette_t,
    fehler_prozent: fehler_prozent === '' ? '' : fehler_prozent,
    leistung_th: leistung_th === '' ? '' : leistung_th,
  };
}

function enrichMessungen(messungen) {
  const list = Array.isArray(messungen) ? messungen : [];
  return list.map((row, idx) => {
    const base = Object.assign({}, row || {});
    const computed = computeMessungFields(base);
    if (base.in_summe === undefined) {
      base.in_summe = true;
    }
    return Object.assign(base, computed);
  });
}

function schleppkettenJsonPath(reiseDir) {
  return resolveMonteurDraftJsonPath(reiseDir, 'schleppkettenprotokoll.json', true);
}

function readSchleppkettenStore(reiseDir) {
  const p = schleppkettenJsonPath(reiseDir);
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

function writeSchleppkettenStore(reiseDir, store) {
  const p = schleppkettenJsonPath(reiseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
}

function saveSchleppkettenLocal(reiseDir, fab, entry) {
  const fn = String(fab || '').trim();
  if (!fn) throw new Error('Fabrikationsnummer fehlt.');
  const store = readSchleppkettenStore(reiseDir);
  const localId = store.nextLocalId || 1;
  store.nextLocalId = localId + 1;
  const messungen = enrichMessungen(entry && entry.messungen);
  const record = Object.assign({}, entry, {
    local_id: localId,
    protokoll_id: 'local:' + localId,
    updated_at: new Date().toISOString(),
    gespeichert_am: new Date().toISOString(),
    fabrikationsnummer: fn,
    messungen,
  });
  store.byFab[fn] = record;
  writeSchleppkettenStore(reiseDir, store);
  return record;
}

function getSchleppkettenLocal(reiseDir, fab, localId) {
  const store = readSchleppkettenStore(reiseDir);
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

module.exports = {
  parseLocaleNumber,
  computeMessungFields,
  enrichMessungen,
  schleppkettenJsonPath,
  readSchleppkettenStore,
  writeSchleppkettenStore,
  saveSchleppkettenLocal,
  getSchleppkettenLocal,
};
