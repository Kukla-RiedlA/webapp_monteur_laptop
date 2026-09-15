'use strict';

const kuklink = require('./session');

function registerKuklinkRoutes(app, ctx) {
  app.get('/api/kuklink/ports', async (req, res) => {
    try {
      const ports = await kuklink.listPorts();
      const list = (ports || []).map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        friendlyName: p.friendlyName || p.path,
      }));
      res.json({ ok: true, ports: list, status: kuklink.publicStatus() });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e && e.message ? e.message : String(e),
        code: e && e.code,
      });
    }
  });

  app.get('/api/kuklink/status', (req, res) => {
    res.json({ ok: true, status: kuklink.publicStatus() });
  });

  app.get('/api/kuklink/terminal', (req, res) => {
    const after = parseInt(String(req.query.after || '0'), 10) || 0;
    const generation = parseInt(String(req.query.generation || '0'), 10) || 0;
    const snap = kuklink.terminalSince(after, generation);
    res.json({
      ok: true,
      status: kuklink.publicStatus(),
      generation: snap.generation,
      seq: snap.seq,
      chunk: snap.chunk,
      reset: !!snap.reset,
      rxBytes: snap.rxBytes,
    });
  });

  app.post('/api/kuklink/connect', async (req, res) => {
    try {
      const body = req.body || {};
      const path = String(body.path || body.port || '').trim();
      if (!path) return res.status(400).json({ ok: false, error: 'COM-Port fehlt.' });
      const settings = {
        path,
        baudRate: body.baudRate,
        dataBits: body.dataBits,
        parity: body.parity,
        stopBits: body.stopBits,
      };
      const result = await kuklink.connect(path, {
        settings,
        trigger: body.trigger,
        family: body.family,
        label: body.label,
      });
      if (!result.ok) {
        return res.json(result);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/kuklink/disconnect', async (req, res) => {
    try {
      await kuklink.disconnect();
      res.json({ ok: true, status: kuklink.publicStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/kuklink/dump', async (req, res) => {
    try {
      const result = await kuklink.dumpAgain();
      if (!result.ok) return res.json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/api/kuklink/save', async (req, res) => {
    try {
      const dump = kuklink.currentDump();
      if (!dump || !dump.text) {
        return res.json({ ok: false, error: 'Kein Dump. Bitte zuerst verbinden bzw. Parameterliste holen.' });
      }
      if (typeof ctx.saveDumpToJob !== 'function') {
        return res.status(500).json({ ok: false, error: 'Speichern nicht konfiguriert.' });
      }
      const body = req.body || {};
      const saved = await ctx.saveDumpToJob({
        req,
        dump,
        jobId: body.job_id != null ? body.job_id : body.jobId,
        fabOverride: body.fab,
        baseUrl: body.baseUrl,
        externalUrl: body.externalUrl,
        internalUrl: body.internalUrl,
        serverUsername: body.serverUsername,
        serverPassword: body.serverPassword,
      });
      res.json(saved);
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

module.exports = { registerKuklinkRoutes };
