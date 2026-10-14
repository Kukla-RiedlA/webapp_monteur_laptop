'use strict';

const os = require('os');
const dcp = require('./dcp');
const { detectNpcap } = require('./npcap-detect');

let busy = null;

function listAdapters() {
  const nics = os.networkInterfaces();
  const out = [];
  Object.keys(nics).forEach((name) => {
    (nics[name] || []).forEach((addr) => {
      const v4 = addr.family === 'IPv4' || addr.family === 4;
      if (!v4 || addr.internal) return;
      out.push({
        name,
        address: addr.address,
        mac: String(addr.mac || '').toLowerCase(),
        netmask: addr.netmask || '',
      });
    });
  });
  return out;
}

function assertReady() {
  const status = detectNpcap();
  if (!status.ready) {
    const err = new Error(status.message || 'Npcap fehlt');
    err.code = 'npcap_missing';
    err.status = status;
    throw err;
  }
  return status;
}

function findAdapter(body) {
  const list = listAdapters();
  const name = String((body && body.name) || '').trim();
  const address = String((body && (body.address || body.ip)) || '').trim();
  const mac = String((body && body.mac) || '').trim().toLowerCase();
  const hit = list.find((a) => (name && a.name === name) || (address && a.address === address) || (mac && a.mac === mac));
  if (!hit) {
    const err = new Error('Netzwerkadapter fehlt oder ist kein Ethernet mit IPv4.');
    err.code = 'no_adapter';
    throw err;
  }
  if (!hit.mac || hit.mac === '00:00:00:00:00:00') {
    const err = new Error('Die MAC des Adapters ist nicht lesbar.');
    err.code = 'no_mac';
    throw err;
  }
  return hit;
}

async function withCapture(adapter, fn) {
  if (busy) {
    const err = new Error('Es läuft bereits ein Profinet-Vorgang.');
    err.code = 'busy';
    throw err;
  }
  assertReady();
  const capMod = require('cap');
  const Cap = capMod.Cap;
  const device = Cap.findDevice(adapter.address);
  if (!device) {
    const err = new Error('Npcap findet den Adapter nicht.');
    err.code = 'no_device';
    throw err;
  }
  const handle = new Cap();
  const buffer = Buffer.alloc(65535);
  busy = handle;
  try {
    handle.open(device, 'ether proto 0x8892', 10 * 1024 * 1024, buffer);
    if (typeof handle.setMinBytes === 'function') handle.setMinBytes(0);
    return await fn(handle, buffer);
  } finally {
    try { handle.close(); } catch (_) { /* already closed */ }
    busy = null;
  }
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function scan(body) {
  const adapter = findAdapter(body);
  const wait = Math.min(5000, Math.max(400, Number(body && body.timeout_ms) || 2000));
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const frame = dcp.buildIdentifyAll(adapter.mac, xid);
  const devices = new Map();
  await withCapture(adapter, (handle, buffer) => new Promise((resolve) => {
    handle.on('packet', (nbytes) => {
      const copy = Buffer.from(buffer.subarray(0, nbytes));
      const dev = dcp.parseIdentifyResponse(copy);
      if (!dev || dev.xid !== xid) return;
      devices.set(dev.mac, dev);
    });
    handle.send(frame, frame.length);
    setTimeout(resolve, wait);
  }));
  const teilnehmer = Array.from(devices.values()).map((dev) => ({
    mac: dev.mac,
    station_name: dev.station_name,
    ip_address: dev.ip_address,
    subnet_mask: dev.subnet_mask,
    gateway: dev.gateway,
    vendor: dev.vendor,
    unbaptized: dcp.isUnbaptized(dev),
  }));
  // Leitungen kommen aus parsePdPortDataReal, sobald ein Read-Implicit-Puffer vorliegt.
  // Ohne lesbare IP bleibt die Liste in der Gruppe ohne Verbindung.
  return { adapter, teilnehmer, links: [] };
}

async function applySet(body) {
  const adapter = findAdapter(body);
  const mac = dcp.normalizeMac(body && body.mac);
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const frames = [];
  if (body && body.station_name != null) {
    frames.push(dcp.buildSetName(adapter.mac, mac, body.station_name, xid));
  }
  if (body && body.ip_address) {
    frames.push(dcp.buildSetIp(
      adapter.mac,
      mac,
      body.ip_address,
      body.subnet_mask,
      body.gateway,
      (xid + 1) >>> 0,
    ));
  }
  if (!frames.length) {
    const err = new Error('Name oder IP fehlt.');
    err.code = 'empty_set';
    throw err;
  }
  await withCapture(adapter, async (handle) => {
    for (let i = 0; i < frames.length; i += 1) {
      handle.send(frames[i], frames[i].length);
      await delay(250);
    }
  });
  return { mac };
}

async function signal(body) {
  const adapter = findAdapter(body);
  const mac = dcp.normalizeMac(body && body.mac);
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const frame = dcp.buildSignal(adapter.mac, mac, xid);
  await withCapture(adapter, async (handle) => {
    handle.send(frame, frame.length);
    await delay(200);
  });
  return { mac };
}

module.exports = {
  listAdapters,
  scan,
  applySet,
  signal,
  parsePdPortDataReal: dcp.parsePdPortDataReal,
};
