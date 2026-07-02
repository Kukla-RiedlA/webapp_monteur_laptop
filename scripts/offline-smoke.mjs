#!/usr/bin/env node
'use strict';

/**
 * Offline-Smoke-Checks gegen den lokalen Monteur-API-Server (Port 39678).
 * Nutzung: node scripts/offline-smoke.mjs [--base http://127.0.0.1:39678] [--tech 1]
 */

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

async function getJson(path) {
  const r = await fetch(BASE + path, { headers });
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

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
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

async function main() {
  console.log('Offline-Smoke', BASE, 'tech', TECH_ID);
  let ok = 0;
  let total = 0;

  const tests = [
    ['health /api/status', async () => {
      const d = await getJson('/api/status');
      if (!d || typeof d !== 'object') throw new Error('leer');
    }],
    ['jobs_open_local', async () => {
      const d = await getJson('/api/jobs_open_local?technician_id=' + TECH_ID);
      if (!Array.isArray(d)) throw new Error('kein Array');
    }],
    ['jobs_open ohne base_url (local fallback)', async () => {
      const d = await getJson('/api/jobs_open?technician_id=' + TECH_ID);
      if (!Array.isArray(d)) throw new Error('kein Array');
    }],
    ['textbausteine_list lokal', async () => {
      const d = await getJson('/api/textbausteine_list?technician_id=' + TECH_ID);
      if (!d.ok || !Array.isArray(d.categories)) throw new Error('categories fehlt');
    }],
    ['anlagenstamm_tree_cached (leer ok)', async () => {
      await getJson('/api/anlagenstamm_tree_cached?fab=999999');
    }],
    ['pending_changes lesbar', async () => {
      const d = await getJson('/api/pending_changes');
      if (!Array.isArray(d)) throw new Error('kein Array');
    }],
    ['textbausteine Kategorie offline anlegen', async () => {
      const d = await postJson('/api/textbausteine_category_save', {
        technician_id: TECH_ID,
        name: 'Smoke ' + Date.now(),
        sort_order: 0,
      });
      if (!d.ok || d.id == null) throw new Error('id fehlt');
    }],
  ];

  for (const [name, fn] of tests) {
    total += 1;
    if (await check(name, fn)) ok += 1;
  }

  console.log('---');
  console.log(ok + '/' + total + ' bestanden');
  process.exit(ok === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
