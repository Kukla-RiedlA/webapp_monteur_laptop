'use strict';

const { parseVncTarget } = require('./validate');
const { createSession } = require('./sessions');

function registerVncRoutes(app) {
  app.post('/api/vnc/session', (req, res) => {
    try {
      const target = parseVncTarget(req.body || {});
      const sessionId = createSession(target.host, target.port);
      res.json({
        ok: true,
        session_id: sessionId,
        ws_path: '/api/vnc/ws?session=' + encodeURIComponent(sessionId),
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e && e.message ? e.message : 'Ziel ungültig',
        code: (e && e.code) || 'invalid_target',
      });
    }
  });
}

module.exports = { registerVncRoutes };
