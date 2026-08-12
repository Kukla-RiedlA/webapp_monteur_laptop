#!/usr/bin/env node
'use strict';

/**
 * Offline-Smoke-Checks gegen den lokalen Monteur-API-Server (Port 39678).
 * Nutzung: node scripts/offline-smoke.mjs [--base http://127.0.0.1:39678] [--tech 1]
 *
 * Enthält zusätzlich Unit-Checks für den Jobs-Pull-Lösch-Guard (ohne Dispo).
 */

const path = require('path');
const localFirst = require(path.join(__dirname, '..', 'electron', 'lib', 'local_first.js'));

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 ? String(process.argv[i + 1] || '').replace(/\/$/, '') : 'http://127.0.0.1:39678';
})();
const TECH_ID = (() => {
  const i = process.argv.indexOf('--tech');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 1;
})();

const headers = { 'X-Technician-Id': String(TECH_ID), Accept: 'application/json' };

async function check(name, fn) {
  try {
    await fn();
    console.log('OK  ', name);
    return true;
  } catch (e) {
    console.error('FAIL', name, '-', e.message || e);
    return false;
  }
}

async function getJson(apiPath) {
  const r = await fetch(BASE + apiPath, { headers });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('HTTP ' + r.status + ' kein JSON: ' + text.slice(0, 120));
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (data.error || text.slice(0, 120)));
  return data;
}

async function getJsonAllowError(apiPath) {
  const r = await fetch(BASE + apiPath, { headers });
  const text = await r.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('HTTP ' + r.status + ' kein JSON: ' + text.slice(0, 120));
  }
  return { status: r.status, data };
}

async function postJson(apiPath, body) {
  const r = await fetch(BASE + apiPath, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('HTTP ' + r.status + ' kein JSON');
  }
  if (!r.ok && !data.ok) throw new Error('HTTP ' + r.status + ': ' + (data.error || text.slice(0, 120)));
  return data;
}

async function postJsonAllowError(apiPath, body) {
  const r = await fetch(BASE + apiPath, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('HTTP ' + r.status + ' kein JSON');
  }
  return { status: r.status, data };
}

async function main() {
  console.log('Offline-Smoke', BASE, 'tech', TECH_ID);
  let ok = 0;
  let total = 0;

  const tests = [
    ['unit: pull-guard leerer Pull', async () => {
      const g = localFirst.evaluateJobPullRemovalGuard(5, 0);
      if (!g.skipRemoval) throw new Error('erwartet skipRemoval bei 0 received');
      if (!g.warning) throw new Error('warning fehlt');
    }],
    ['unit: pull-guard stark reduziert', async () => {
      const g = localFirst.evaluateJobPullRemovalGuard(10, 1);
      if (!g.skipRemoval) throw new Error('erwartet skipRemoval bei <20%');
    }],
    ['unit: pull-guard normal', async () => {
      const g = localFirst.evaluateJobPullRemovalGuard(5, 4);
      if (g.skipRemoval) throw new Error('kein skip bei normalem Pull');
    }],
    ['health /api/version', async () => {
      const d = await getJson('/api/version');
      if (!d || typeof d !== 'object') throw new Error('leer');
    }],
    ['my_jobs lokal', async () => {
      const d = await getJson('/api/my_jobs?technician_id=' + TECH_ID + '&assigned_only=1');
      if (!d.ok || !Array.isArray(d.jobs)) throw new Error('jobs fehlt');
    }],
    ['sync_status pull_warnings Feld', async () => {
      const d = await getJson('/api/sync_status');
      if (!d.ok) throw new Error('ok=false');
      if (d.last_sync_pull && d.last_sync_pull.pull_warnings != null && !Array.isArray(d.last_sync_pull.pull_warnings)) {
        throw new Error('pull_warnings kein Array');
      }
    }],
    ['jobs_open_local', async () => {
      const d = await getJson('/api/jobs_open_local?technician_id=' + TECH_ID);
      if (!Array.isArray(d)) throw new Error('kein Array');
    }],
    ['jobs_open ohne base_url (local fallback)', async () => {
      const d = await getJson('/api/jobs_open?technician_id=' + TECH_ID);
      if (!Array.isArray(d)) throw new Error('kein Array');
    }],
    ['textbausteine_list local_only', async () => {
      const d = await getJson('/api/textbausteine_list?technician_id=' + TECH_ID + '&local_only=1');
      if (!d.ok || !Array.isArray(d.categories)) throw new Error('categories fehlt');
    }],
    ['arbeitsschritte_list local_only', async () => {
      const d = await getJson('/api/arbeitsschritte_list?technician_id=' + TECH_ID + '&local_only=1');
      if (!d.ok || !Array.isArray(d.steps)) throw new Error('steps fehlt');
    }],
    ['calendar_cached ohne Dispo', async () => {
      const d = await getJson('/api/calendar_cached?start=2020-01-01&end=2030-12-31');
      if (!d.ok) throw new Error('ok=false');
    }],
    ['accept_offline_preview local_first', async () => {
      const res = await getJsonAllowError(
        '/api/dienstreise/accept_offline_preview?job_id=1&technician_id=' +
          TECH_ID +
          '&local_first=1',
      );
      if (!res.data || typeof res.data !== 'object') throw new Error('keine JSON-Antwort');
    }],
    ['anlagenstamm_tree_cached (leer ok)', async () => {
      await getJson('/api/anlagenstamm_tree_cached?fab=999999');
    }],
    ['anlagenstamm_files_list cache-first ohne baseUrl', async () => {
      const res = await postJsonAllowError('/api/anlagenstamm_files_list', { fab: '999999' });
      if (!res.data || typeof res.data !== 'object') throw new Error('keine JSON-Antwort');
      if (res.status >= 500 && res.status !== 503) {
        throw new Error('unerwarteter Serverfehler ' + res.status);
      }
    }],
    ['pending_changes lesbar', async () => {
      const d = await getJson('/api/pending_changes');
      if (!d.ok || !Array.isArray(d.pending)) throw new Error('pending fehlt');
    }],
    ['textbausteine Kategorie offline anlegen', async () => {
      try {
        const d = await postJson('/api/textbausteine_category_save', {
          technician_id: TECH_ID,
          name: 'Smoke ' + Date.now(),
          sort_order: 0,
        });
        if (!d.ok || d.id == null) throw new Error('id fehlt');
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (/FOREIGN KEY|technician/i.test(msg)) {
          console.log('SKIP textbausteine Kategorie (Techniker ' + TECH_ID + ' fehlt lokal)');
          return;
        }
        throw e;
      }
    }],
  ];

  for (const [name, fn] of tests) {
    total += 1;
    if (await check(name, fn)) ok += 1;
  }

  console.log('---');
  console.log(ok + '/' + total + ' bestanden');
  console.log('Repro-Checkliste: S1 Flugmodus | S2 Dispo down | S3 Auth fehlt | leerer Pull → Badge Sync-Probleme, Liste bleibt');
  process.exit(ok === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
