'use strict';

const net = require('net');
const { WebSocketServer } = require('ws');
const { takeSession } = require('./sessions');
const { getLocalGatewayToken, HEADER } = require('../local-gateway-auth');

const WS_PATH = '/api/vnc/ws';
const CONNECT_TIMEOUT_MS = 8000;

function headerToken(req) {
  const headers = req && req.headers ? req.headers : {};
  return String(headers[HEADER] || headers[HEADER.toLowerCase()] || headers['x-kukla-local-token'] || '');
}

function rejectUpgrade(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  socket.end(
    'HTTP/1.1 ' + status + ' ' + reason + '\r\n'
    + 'Connection: close\r\n'
    + 'Content-Length: 0\r\n\r\n',
  );
}

function pipeSession(ws, target) {
  const tcp = net.connect({ host: target.host, port: target.port });
  const pending = [];
  let opened = false;

  function shutdown() {
    if (!tcp.destroyed) tcp.destroy();
    if (ws.readyState === ws.OPEN) {
      try { ws.close(); } catch (_) { /* bereits zu */ }
    }
  }

  tcp.setTimeout(CONNECT_TIMEOUT_MS);
  tcp.on('timeout', () => {
    if (!opened) shutdown();
  });
  tcp.on('connect', () => {
    opened = true;
    tcp.setTimeout(0);
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
  });
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!opened) pending.push(buf);
    else if (!tcp.destroyed) tcp.write(buf);
  });
  tcp.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on('error', shutdown);
  tcp.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      try { ws.close(); } catch (_) { /* bereits zu */ }
    }
  });
  ws.on('close', () => {
    if (!tcp.destroyed) tcp.destroy();
  });
  ws.on('error', shutdown);
}

function attachVncBridge(httpServer) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      if (protocols && protocols.has && protocols.has('binary')) return 'binary';
      return undefined;
    },
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_) {
      return;
    }
    if (url.pathname !== WS_PATH) return;

    if (headerToken(req) !== getLocalGatewayToken()) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const target = takeSession(url.searchParams.get('session') || '');
    if (!target) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pipeSession(ws, target);
    });
  });

  return wss;
}

module.exports = {
  attachVncBridge,
  WS_PATH,
};
