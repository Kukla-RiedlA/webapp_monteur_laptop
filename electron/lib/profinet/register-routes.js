'use strict';

const capture = require('./capture');
const store = require('./store');
const { detectNpcap } = require('./npcap-detect');
const { buildDispoMonteurHeaders } = require('../dispo-monteur-headers');
const { getOrCreateDeviceId } = require('../device-id');

function fabOf(req) {
  const q = req.query || {};
  const b = req.body || {};
  return String(q.fabrikationsnummer || b.fabrikationsnummer || '').trim();
}

function rowsOf(body) {
  const b = body || {};
  return {
    teilnehmer: Array.isArray(b.teilnehmer) ? b.teilnehmer : [],
    links: Array.isArray(b.links) ? b.links : [],
  };
}

async function pushToDispo(body, saved, deviceId) {
  const base = String(body.base_url || body.baseUrl || '').trim().replace(/\/+$/, '');
  const user = String(body.server_username || body.serverUsername || '').trim();
  const pass = body.server_password != null ? String(body.server_password) : (body.serverPassword != null ? String(body.serverPassword) : '');
  if (!base || !user || !pass) return { pushed: false, reason: 'offline_or_no_session' };
  const url = base + '/api/anlagenstamm_profinet.php';
  const auth = 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: buildDispoMonteurHeaders({
      authHeader: { Authorization: auth },
      deviceId,
      extra: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }),
    body: JSON.stringify({
      fabrikationsnummer: body.fabrikationsnummer,
      teilnehmer: saved.teilnehmer,
      links: saved.links,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || data.ok === false) {
    return { pushed: false, error: (data && data.error) || ('HTTP ' + res.status) };
  }
  return { pushed: true };
}

function registerProfinetRoutes(app, ctx) {
  const db = ctx && ctx.db;
  const dbDir = ctx && (ctx.dbDir || ctx.DB_DIR) ? String(ctx.dbDir || ctx.DB_DIR) : '';
  if (db) store.ensureSchema(db);

  function fail(res, e) {
    const code = e && e.code;
    const status = code === 'npcap_missing' ? 200 : 400;
    res.status(code === 'npcap_missing' ? 200 : status).json({
      ok: false,
      error: e && e.message ? e.message : String(e),
      code: code || undefined,
      npcap: code === 'npcap_missing' ? e.status : undefined,
    });
  }

  app.get('/api/profinet/status', (req, res) => {
    res.json({ ok: true, npcap: detectNpcap() });
  });

  app.get('/api/profinet/adapters', (req, res) => {
    const npcap = detectNpcap();
    res.json({ ok: true, npcap, adapters: npcap.ready ? capture.listAdapters() : [] });
  });

  app.post('/api/profinet/scan', async (req, res) => {
    try {
      const result = await capture.scan(req.body || {});
      res.json({ ok: true, adapter: result.adapter, teilnehmer: result.teilnehmer, links: result.links });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/profinet/set', async (req, res) => {
    try {
      const result = await capture.applySet(req.body || {});
      res.json({ ok: true, mac: result.mac });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/profinet/signal', async (req, res) => {
    try {
      const result = await capture.signal(req.body || {});
      res.json({ ok: true, mac: result.mac });
    } catch (e) {
      fail(res, e);
    }
  });

  function readSaved(req, res) {
    try {
      const data = store.listByFab(db, fabOf(req));
      res.json({ ok: true, fabrikationsnummer: fabOf(req), teilnehmer: data.teilnehmer, links: data.links });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  async function writeSaved(req, res) {
    try {
      const body = req.body || {};
      const fab = fabOf(req);
      const rows = rowsOf(body);
      const saved = store.replaceSet(db, fab, rows.teilnehmer, rows.links, { dirty: 1 });
      if (typeof db.save === 'function') db.save();
      let sync = { pushed: false };
      try {
        const deviceId = dbDir ? getOrCreateDeviceId(dbDir) : '';
        sync = await pushToDispo(Object.assign({ fabrikationsnummer: fab }, body), saved, deviceId);
        if (sync.pushed) store.markClean(db, fab);
      } catch (e) {
        sync = { pushed: false, error: e && e.message ? e.message : String(e) };
      }
      res.json({
        ok: true,
        fabrikationsnummer: fab,
        teilnehmer: saved.teilnehmer,
        links: saved.links,
        sync,
      });
    } catch (e) {
      const status = e && e.code === 'missing_fab' ? 400 : 500;
      res.status(status).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  app.get('/api/profinet/teilnehmer', readSaved);
  app.get('/api/profinet/links', (req, res) => {
    try {
      const data = store.listByFab(db, fabOf(req));
      res.json({ ok: true, fabrikationsnummer: fabOf(req), links: data.links });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
  app.post('/api/profinet/teilnehmer', writeSaved);
  app.get('/api/anlagenstamm_profinet.php', readSaved);
  app.post('/api/anlagenstamm_profinet.php', writeSaved);
}

module.exports = { registerProfinetRoutes };
