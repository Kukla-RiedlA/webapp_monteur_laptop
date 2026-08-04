'use strict';

const path = require('path');
const fs = require('fs');
const { resolveMonteurDraftJsonPath } = require('./multi-device-sync');

function pruefzertifikatJsonPath(reiseDir) {
  return resolveMonteurDraftJsonPath(reiseDir, 'pruefzertifikat.json', true);
}

function readPruefzertifikatStore(reiseDir) {
  const p = pruefzertifikatJsonPath(reiseDir);
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

function writePruefzertifikatStore(reiseDir, store) {
  const p = pruefzertifikatJsonPath(reiseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
}

function savePruefzertifikatLocal(reiseDir, fab, entry) {
  const fn = String(fab || '').trim();
  if (!fn) throw new Error('Fabrikationsnummer fehlt.');
  const store = readPruefzertifikatStore(reiseDir);
  const localId = store.nextLocalId || 1;
  store.nextLocalId = localId + 1;
  const record = Object.assign({}, entry, {
    local_id: localId,
    protokoll_id: 'local:' + localId,
    zertifikat_id: entry.zertifikat_id || 'local:' + localId,
    updated_at: new Date().toISOString(),
    gespeichert_am: new Date().toISOString(),
    fabrikationsnummer: fn,
  });
  store.byFab[fn] = record;
  writePruefzertifikatStore(reiseDir, store);
  return record;
}

function getPruefzertifikatLocal(reiseDir, fab, localId) {
  const store = readPruefzertifikatStore(reiseDir);
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

/** Prefill from local KW / SK / Service drafts when Dispo prefill unavailable. */
function prefillFromLocalDrafts(reiseDir, fab, jobMeta) {
  const fn = String(fab || '').trim();
  const out = {
    fabrikationsnummer: fn,
    pruefdatum: new Date().toISOString().slice(0, 10),
    zulaessige_abweichung_pct: 0.5,
    verfahren: { kontrollwiegung: false, schleppketten: false, service: false },
    ergebnisse: {},
    projekt: (jobMeta && jobMeta.job_number) || '',
    kunde: (jobMeta && (jobMeta.endkunde || jobMeta.customer_name)) || '',
    monteur_name: (jobMeta && jobMeta.technician_name) || '',
  };
  const n = new Date(out.pruefdatum);
  n.setMonth(n.getMonth() + 12);
  out.naechste_pruefung = n.toISOString().slice(0, 10);
  out.zertifikat_nr = 'PZ-' + fn + '-' + out.pruefdatum.replace(/-/g, '');

  try {
    const kwLocal = require('./kontrollwiegung-local');
    const kw = kwLocal.getKontrollwiegungLocal
      ? kwLocal.getKontrollwiegungLocal(reiseDir, fn)
      : (kwLocal.readKontrollwiegungStore(reiseDir).byFab || {})[fn];
    if (kw) {
      out.verfahren.kontrollwiegung = true;
      out.pruefdatum = kw.durchfuehrungsdatum || out.pruefdatum;
      out.type = out.type || kw.type || '';
      out.elektronik = out.elektronik || kw.elektronik || '';
      out.nennleistung = out.nennleistung || kw.leistung || '';
      out.letzte_eichung_kontrollwaage = kw.letzte_eichung || '';
      const rows = (Array.isArray(kw.wiegungen) ? kw.wiegungen : []).filter((r) => r && r.in_summe !== false);
      let sumBand = 0;
      let sumKontr = 0;
      let nRows = 0;
      rows.forEach((r) => {
        const b = parseFloat(String(r.bandwaage_kg || '').replace(',', '.'));
        const k = parseFloat(String(r.kontrollwaage_kg || '').replace(',', '.'));
        if (Number.isFinite(b) && Number.isFinite(k)) {
          sumBand += b;
          sumKontr += k;
          nRows += 1;
        }
      });
      out.ergebnisse.kontrollwiegung = {
        anzahl: nRows,
        fehler_prozent: nRows && sumKontr ? ((sumBand - sumKontr) / sumKontr) * 100 : null,
        datum: kw.durchfuehrungsdatum || '',
      };
    }
  } catch (_) {}

  try {
    const skLocal = require('./schleppketten-local');
    const sk = skLocal.getSchleppkettenLocal(reiseDir, fn);
    if (sk) {
      out.verfahren.schleppketten = true;
      out.pruefdatum = out.pruefdatum || sk.durchfuehrungsdatum;
      out.type = out.type || sk.type || '';
      out.elektronik = out.elektronik || sk.elektronik || sk.dwc || '';
      out.nennleistung = out.nennleistung || sk.leistung || sk.nennleistung || '';
      out.waagenart = sk.waagenart || out.waagenart || 'Bandwaage';
      out.pos_nr = out.pos_nr || sk.pos_nr || '';
      out.monteur_name = out.monteur_name || sk.monteur_name || '';
      const mess = skLocal.enrichMessungen(sk.messungen || []).filter((r) => r && r.in_summe !== false);
      let sumBand = 0;
      let sumPk = 0;
      let nRows = 0;
      mess.forEach((r) => {
        const b = parseFloat(String(r.bandwaage_t || '').replace(',', '.'));
        const p = parseFloat(String(r.pruefkette_t || '').replace(',', '.'));
        if (Number.isFinite(b) && Number.isFinite(p)) {
          sumBand += b;
          sumPk += p;
          nRows += 1;
        }
      });
      out.ergebnisse.schleppketten = {
        anzahl: nRows,
        fehler_prozent: nRows && sumPk ? ((sumBand - sumPk) / sumPk) * 100 : null,
        datum: sk.durchfuehrungsdatum || '',
      };
      const mittel = [];
      if (sk.ketten_type) mittel.push('Schleppkette ' + sk.ketten_type);
      if (sk.gewicht_pro_meter) mittel.push(String(sk.gewicht_pro_meter) + ' kg/m');
      if (mittel.length) out.pruefmittel = mittel.join(', ');
    }
  } catch (_) {}

  try {
    const spPath = resolveMonteurDraftJsonPath(reiseDir, 'serviceprotokoll.json', true);
    if (fs.existsSync(spPath)) {
      const spStore = JSON.parse(fs.readFileSync(spPath, 'utf8'));
      const sp = spStore && spStore.byFab && spStore.byFab[fn];
      if (sp) {
        out.verfahren.service = true;
        out.type = out.type || sp.kopf_type || sp.type || '';
        out.elektronik = out.elektronik || sp.kopf_dwc || sp.dwc || '';
        out.pos_nr = out.pos_nr || sp.kopf_pos_nr || sp.pos_nr || '';
        out.nennleistung = out.nennleistung || sp.kopf_qmax || '';
        if (sp.durchfuehrungsdatum && !out.verfahren.kontrollwiegung && !out.verfahren.schleppketten) {
          out.pruefdatum = sp.durchfuehrungsdatum;
        }
      }
    }
  } catch (_) {}

  out.zertifikat_nr = 'PZ-' + fn + '-' + String(out.pruefdatum || '').replace(/-/g, '');
  const errs = [];
  if (out.ergebnisse.kontrollwiegung && out.ergebnisse.kontrollwiegung.fehler_prozent != null) {
    errs.push(Math.abs(out.ergebnisse.kontrollwiegung.fehler_prozent));
  }
  if (out.ergebnisse.schleppketten && out.ergebnisse.schleppketten.fehler_prozent != null) {
    errs.push(Math.abs(out.ergebnisse.schleppketten.fehler_prozent));
  }
  out.status_bestanden = errs.length ? Math.max.apply(null, errs) <= Number(out.zulaessige_abweichung_pct) : null;
  out.konformitaet_text =
    'Die Anlage wurde nach dem Herstellerverfahren der KUKLA Waagenfabrik GmbH & Co KG einer wiederkehrenden Überprüfung unterzogen. '
    + 'Dieses Hersteller-Prüfzertifikat (Manufacturer Inspection Certificate) dient als Nachweis der Qualitätssicherung der Messeinrichtung '
    + 'im Sinne von Art. 60 der Verordnung (EU) 2018/2066 (MRR). Es handelt sich nicht um eine akkreditierte Kalibrierung nach EN ISO/IEC 17025 '
    + 'und nicht um eine behördliche Eichung.';
  return out;
}

module.exports = {
  pruefzertifikatJsonPath,
  readPruefzertifikatStore,
  writePruefzertifikatStore,
  savePruefzertifikatLocal,
  getPruefzertifikatLocal,
  prefillFromLocalDrafts,
};
