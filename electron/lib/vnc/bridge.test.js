'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { WebSocket } = require('ws');
const { attachVncBridge } = require('./bridge');
const sessions = require('./sessions');
const { getLocalGatewayToken, HEADER } = require('../local-gateway-auth');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('Brücke kopiert Bytes in beide Richtungen und die Sitzung ist einmalig', async () => {
  sessions.resetForTests();
  const echo = net.createServer((sock) => {
    sock.on('data', (buf) => sock.write(buf));
  });
  const echoPort = await listen(echo);
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachVncBridge(httpServer);
  const httpPort = await listen(httpServer);
  const id = sessions.createSession('127.0.0.1', echoPort);
  const ws = new WebSocket(
    'ws://127.0.0.1:' + httpPort + '/api/vnc/ws?session=' + id,
    ['binary'],
    { headers: { [HEADER]: getLocalGatewayToken() } },
  );
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const reply = new Promise((resolve) => ws.once('message', resolve));
    ws.send(Buffer.from('RFB 003.008\n'));
    const msg = await reply;
    assert.equal(Buffer.from(msg).toString(), 'RFB 003.008\n');
    const second = new WebSocket(
      'ws://127.0.0.1:' + httpPort + '/api/vnc/ws?session=' + id,
      ['binary'],
      { headers: { [HEADER]: getLocalGatewayToken() } },
    );
    const rejected = await new Promise((resolve) => {
      second.once('error', () => resolve('error'));
      second.once('unexpected-response', () => resolve('unexpected-response'));
      second.once('open', () => resolve('open'));
    });
    assert.notEqual(rejected, 'open');
    try { second.terminate(); } catch (_) { /* zu */ }
  } finally {
    try { ws.close(); } catch (_) { /* zu */ }
    await closeServer(httpServer);
    await closeServer(echo);
    sessions.resetForTests();
  }
});

test('WebSocket ohne Gateway-Token wird abgelehnt', async () => {
  sessions.resetForTests();
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachVncBridge(httpServer);
  const httpPort = await listen(httpServer);
  const id = sessions.createSession('127.0.0.1', 9);
  const ws = new WebSocket('ws://127.0.0.1:' + httpPort + '/api/vnc/ws?session=' + id, ['binary']);
  try {
    const result = await new Promise((resolve) => {
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => resolve('open'));
    });
    assert.notEqual(result, 'open');
  } finally {
    try { ws.terminate(); } catch (_) { /* zu */ }
    await closeServer(httpServer);
    sessions.resetForTests();
  }
});
