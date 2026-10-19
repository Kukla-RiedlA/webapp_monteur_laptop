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

function sendFrame(handle, frame) {
  const sent = handle.send(frame, frame.length);
  if (sent === false) {
    const err = new Error('Der Adapter hat das Profinet-Paket nicht gesendet. Npcap im WinPcap-Modus prüfen.');
    err.code = 'send_failed';
    throw err;
  }
}

async function roundTrip(adapter, frame, xid, action) {
  const replies = [];
  const prime = dcp.buildIdentifyAll(adapter.mac, (xid + 7) >>> 0);
  await withCapture(adapter, async (handle, buffer) => {
    handle.on('packet', (nbytes) => {
      const copy = Buffer.from(buffer.subarray(0, nbytes));
      const parsed = dcp.parseSetResponse(copy);
      if (!parsed || parsed.xid !== xid) return;
      replies.push(parsed);
    });
    sendFrame(handle, prime);
    await delay(250);
    sendFrame(handle, frame);
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline && !replies.length) {
      await delay(40);
    }
  });
  if (!replies.length) {
    const err = new Error(action + ': das Gerät hat nicht geantwortet. Bitte erneut scannen und den Ethernet-Adapter direkt an der Anlage prüfen.');
    err.code = 'no_response';
    throw err;
  }
  const errors = [];
  replies.forEach((reply) => {
    (reply.errors || []).forEach((text) => errors.push(text));
  });
  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.code = 'device_rejected';
    throw err;
  }
  return { mac: dcp.normalizeMac(frame && frame.length >= 6 ? dcp.formatMac(frame, 0) : '') };
}

async function applySet(body) {
  const adapter = findAdapter(body);
  const mac = dcp.normalizeMac(body && body.mac);
  const name = body && body.station_name != null ? String(body.station_name).trim().toLowerCase() : '';
  const ip = body && body.ip_address ? String(body.ip_address).trim() : '';
  if (name) {
    const nameError = dcp.stationNameError(name);
    if (nameError) {
      const err = new Error(nameError);
      err.code = 'bad_name';
      throw err;
    }
  }
  if (!name && !ip) {
    const err = new Error('Name oder IP fehlt.');
    err.code = 'empty_set';
    throw err;
  }
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const frame = dcp.buildCombinedSet(adapter.mac, mac, xid, {
    name,
    ip,
    mask: body.subnet_mask,
    gateway: body.gateway,
  });
  await roundTrip(adapter, frame, xid, name ? 'Taufen' : 'IP setzen');
  return { mac };
}

async function signal(body) {
  const adapter = findAdapter(body);
  const mac = dcp.normalizeMac(body && body.mac);
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const frame = dcp.buildSignal(adapter.mac, mac, xid);
  await roundTrip(adapter, frame, xid, 'Blinken');
  return { mac };
}

module.exports = {
  listAdapters,
  scan,
  applySet,
  signal,
  parsePdPortDataReal: dcp.parsePdPortDataReal,
};
