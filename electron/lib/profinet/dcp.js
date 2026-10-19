'use strict';

const ETHERTYPE = 0x8892;
const MULTICAST_MAC = '01:0e:cf:00:00:00';
const FRAME_IDENTIFY_REQ = 0xfefe;
const FRAME_IDENTIFY_RES = 0xfeff;
const FRAME_GETSET_REQ = 0xfefd;
const FRAME_GETSET_RES = 0xfefc;
const SERVICE_SET = 4;
const SERVICE_IDENTIFY = 5;
const SERVICE_REQUEST = 0;

function parseMac(mac) {
  const parts = String(mac || '').trim().toLowerCase().split(/[:\-]/);
  if (parts.length !== 6) throw new Error('MAC ungültig');
  const buf = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    const n = parseInt(parts[i], 16);
    if (!Number.isFinite(n) || n < 0 || n > 255) throw new Error('MAC ungültig');
    buf[i] = n;
  }
  return buf;
}

function formatMac(buf, offset) {
  const o = offset || 0;
  const parts = [];
  for (let i = 0; i < 6; i += 1) parts.push(buf[o + i].toString(16).padStart(2, '0'));
  return parts.join(':');
}

function normalizeMac(mac) {
  return formatMac(parseMac(mac));
}

function ipv4ToBuf(ip) {
  const p = String(ip || '0.0.0.0').trim().split('.');
  if (p.length !== 4) throw new Error('IP ungültig');
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) {
    const n = parseInt(p[i], 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) throw new Error('IP ungültig');
    buf[i] = n;
  }
  return buf;
}

function bufToIpv4(buf, offset) {
  const o = offset || 0;
  return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]].join('.');
}

function writeBlock(chunks, option, suboption, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const header = Buffer.alloc(4);
  header[0] = option & 0xff;
  header[1] = suboption & 0xff;
  header.writeUInt16BE(payload.length, 2);
  chunks.push(header, payload);
  if (payload.length % 2) chunks.push(Buffer.alloc(1));
}

function buildDcp(frameId, serviceId, serviceType, xid, responseDelay, blocks) {
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(frameId, 0);
  head[2] = serviceId & 0xff;
  head[3] = serviceType & 0xff;
  head.writeUInt32BE(xid >>> 0, 4);
  head.writeUInt16BE(responseDelay & 0xffff, 8);
  head.writeUInt16BE(body.length, 10);
  return Buffer.concat([head, body]);
}

function buildEthernet(dstMac, srcMac, payload) {
  const eth = Buffer.alloc(14);
  parseMac(dstMac).copy(eth, 0);
  parseMac(srcMac).copy(eth, 6);
  eth.writeUInt16BE(ETHERTYPE, 12);
  const frame = Buffer.concat([eth, payload]);
  // Npcap verwirft Rahmen unter 60 Byte. Kurze Set-/Blink-Rahmen kamen deshalb nie am Gerät an.
  if (frame.length >= 60) return frame;
  return Buffer.concat([frame, Buffer.alloc(60 - frame.length)]);
}

function looksPrintableName(buf) {
  let seen = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0) continue;
    seen += 1;
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return seen > 0;
}

/** NameOfStation und Hersteller: BlockInfo (2 Byte, meist 0x0000) steht vor dem Text. */
function decodeVisible(data) {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length >= 2 && buf[0] === 0 && buf[1] <= 1 && looksPrintableName(buf.subarray(2))) {
    buf = buf.subarray(2);
  }
  return buf.toString('latin1').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function stationNameError(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) return 'Stationsname fehlt.';
  if (name.length > 240) return 'Stationsname ist zu lang (max. 240 Zeichen).';
  if (!/^[a-z0-9.-]+$/.test(name)) {
    return 'Stationsname darf nur a–z, 0–9, Punkt und Bindestrich enthalten. Umlaute und andere Sonderzeichen nimmt das Gerät nicht an.';
  }
  if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) {
    return 'Stationsname darf nicht mit einem Punkt beginnen oder enden.';
  }
  const labels = name.split('.');
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) {
      return 'Jeder Namensteil darf 1–63 Zeichen haben und nicht mit einem Bindestrich beginnen oder enden.';
    }
  }
  return '';
}

function blockErrorText(code) {
  switch (code) {
    case 1: return 'Das Gerät unterstützt dieses Feld nicht.';
    case 2: return 'Das Gerät unterstützt diesen Wert nicht.';
    case 3: return 'Der Wert wurde nicht übernommen.';
    case 4: return 'Das Gerät hat den Namen oder die IP abgelehnt.';
    case 5: return 'Setzen ist an diesem Gerät gerade nicht möglich.';
    case 6: return 'Das Gerät ist in Betrieb. Taufen geht erst, wenn der IO-Controller die Verbindung gelöst hat.';
    default: return 'Das Gerät hat die Anfrage abgelehnt (Fehler ' + code + ').';
  }
}

function buildIdentifyAll(srcMac, xid) {
  const blocks = [];
  writeBlock(blocks, 0xff, 0xff, Buffer.alloc(0));
  const dcp = buildDcp(FRAME_IDENTIFY_REQ, SERVICE_IDENTIFY, SERVICE_REQUEST, xid, 1, blocks);
  return buildEthernet(MULTICAST_MAC, srcMac, dcp);
}

function pushNameBlock(blocks, name) {
  const nameBuf = Buffer.from(String(name || ''), 'latin1');
  const data = Buffer.alloc(2 + nameBuf.length);
  data.writeUInt16BE(1, 0);
  nameBuf.copy(data, 2);
  writeBlock(blocks, 2, 2, data);
}

function pushIpBlock(blocks, ip, mask, gateway) {
  const data = Buffer.alloc(14);
  data.writeUInt16BE(1, 0);
  ipv4ToBuf(ip).copy(data, 2);
  ipv4ToBuf(mask || '255.255.255.0').copy(data, 6);
  ipv4ToBuf(gateway || '0.0.0.0').copy(data, 10);
  writeBlock(blocks, 1, 2, data);
}

function buildSetName(srcMac, dstMac, name, xid) {
  const blocks = [];
  pushNameBlock(blocks, name);
  const dcp = buildDcp(FRAME_GETSET_REQ, SERVICE_SET, SERVICE_REQUEST, xid, 0, blocks);
  return buildEthernet(dstMac, srcMac, dcp);
}

function buildSetIp(srcMac, dstMac, ip, mask, gateway, xid) {
  const blocks = [];
  pushIpBlock(blocks, ip, mask, gateway);
  const dcp = buildDcp(FRAME_GETSET_REQ, SERVICE_SET, SERVICE_REQUEST, xid, 0, blocks);
  return buildEthernet(dstMac, srcMac, dcp);
}

function buildCombinedSet(srcMac, dstMac, xid, opts) {
  const blocks = [];
  const name = opts && opts.name ? String(opts.name) : '';
  const ip = opts && opts.ip ? String(opts.ip) : '';
  if (name) pushNameBlock(blocks, name);
  if (ip) pushIpBlock(blocks, ip, opts.mask, opts.gateway);
  if (!blocks.length) {
    const err = new Error('Name oder IP fehlt.');
    err.code = 'empty_set';
    throw err;
  }
  const dcp = buildDcp(FRAME_GETSET_REQ, SERVICE_SET, SERVICE_REQUEST, xid, 0, blocks);
  return buildEthernet(dstMac, srcMac, dcp);
}

function buildSignal(srcMac, dstMac, xid) {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(0, 0);
  data.writeUInt16BE(0x0100, 2);
  const blocks = [];
  writeBlock(blocks, 5, 3, data);
  const dcp = buildDcp(FRAME_GETSET_REQ, SERVICE_SET, SERVICE_REQUEST, xid, 0, blocks);
  return buildEthernet(dstMac, srcMac, dcp);
}

function readBlocks(buf, offset, end) {
  const blocks = [];
  let o = offset;
  while (o + 4 <= end) {
    const option = buf[o];
    const sub = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    const dataStart = o + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > end) break;
    blocks.push({ option, suboption: sub, data: buf.slice(dataStart, dataEnd) });
    o = dataEnd + (len % 2);
  }
  return blocks;
}

function parseIdentifyResponse(frame) {
  if (!frame || frame.length < 26) return null;
  if (frame.readUInt16BE(12) !== ETHERTYPE) return null;
  const srcMac = formatMac(frame, 6);
  const dcp = 14;
  const frameId = frame.readUInt16BE(dcp);
  if (frameId !== FRAME_IDENTIFY_RES && frameId !== FRAME_GETSET_RES) return null;
  const xid = frame.readUInt32BE(dcp + 4);
  const dataLen = frame.readUInt16BE(dcp + 10);
  const blocks = readBlocks(frame, dcp + 12, Math.min(frame.length, dcp + 12 + dataLen));
  const device = {
    mac: srcMac,
    xid,
    service_id: frame[dcp + 2],
    service_type: frame[dcp + 3],
    station_name: '',
    ip_address: '0.0.0.0',
    subnet_mask: '0.0.0.0',
    gateway: '0.0.0.0',
    vendor: '',
  };
  blocks.forEach((b) => {
    if (b.option === 2 && b.suboption === 2) {
      device.station_name = decodeVisible(b.data);
    } else if (b.option === 2 && b.suboption === 1) {
      device.vendor = decodeVisible(b.data);
    } else if (b.option === 1 && b.suboption === 2 && b.data.length >= 12) {
      const off = b.data.length >= 14 ? 2 : 0;
      if (b.data.length >= off + 12) {
        device.ip_address = bufToIpv4(b.data, off);
        device.subnet_mask = bufToIpv4(b.data, off + 4);
        device.gateway = bufToIpv4(b.data, off + 8);
      }
    }
  });
  return device;
}

function parseSetResponse(frame) {
  if (!frame || frame.length < 26) return null;
  if (frame.readUInt16BE(12) !== ETHERTYPE) return null;
  const dcp = 14;
  const frameId = frame.readUInt16BE(dcp);
  if (frameId !== FRAME_GETSET_RES) return null;
  const serviceId = frame[dcp + 2];
  if (serviceId !== SERVICE_SET) return null;
  const serviceType = frame[dcp + 3];
  const xid = frame.readUInt32BE(dcp + 4);
  const dataLen = frame.readUInt16BE(dcp + 10);
  const blocks = readBlocks(frame, dcp + 12, Math.min(frame.length, dcp + 12 + dataLen));
  const errors = [];
  if (serviceType === 5) errors.push('Das Gerät unterstützt Taufen oder Blinken nicht.');
  blocks.forEach((block) => {
    let code = null;
    if (block.option === 5 && block.suboption === 4 && block.data.length >= 3) code = block.data[2];
    else if (block.data.length === 1) code = block.data[0];
    if (code) errors.push(blockErrorText(code));
  });
  return {
    mac: formatMac(frame, 6),
    xid,
    service_type: serviceType,
    errors,
  };
}

function isUnbaptized(device) {
  const name = String((device && device.station_name) || '').trim();
  const ip = String((device && device.ip_address) || '').trim();
  return !name || ip === '' || ip === '0.0.0.0';
}

/**
 * Nachbarschaft aus einem PDPortDataReal-Block (Blocktype 0x020F),
 * nachdem der RPC-Kopf schon abgeschnitten ist.
 * Layout: type u16, length u16, version u16, pad u16, count u16,
 * je Peer: MAC 6, portLen u8, port, nameLen u8, name, Pad auf gerade Länge.
 */
function parsePdPortDataReal(buf, localMac, localPort) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (data.length < 10 || data.readUInt16BE(0) !== 0x020f) return { nodes: [], links: [] };
  const count = data.readUInt16BE(8);
  let o = 10;
  const local = normalizeMac(localMac);
  const nodes = [{ mac: local, name: '', port: String(localPort || '') }];
  const links = [];
  for (let i = 0; i < count; i += 1) {
    if (o + 7 > data.length) break;
    const peerMac = formatMac(data, o);
    o += 6;
    const portLen = data[o];
    o += 1;
    if (o + portLen >= data.length) break;
    const peerPort = data.slice(o, o + portLen).toString('utf8');
    o += portLen;
    const nameLen = data[o];
    o += 1;
    if (o + nameLen > data.length) break;
    const peerName = data.slice(o, o + nameLen).toString('utf8');
    o += nameLen;
    if ((6 + 1 + portLen + 1 + nameLen) % 2) o += 1;
    nodes.push({ mac: peerMac, name: peerName, port: peerPort });
    links.push({
      local_mac: local,
      local_port: String(localPort || ''),
      peer_mac: peerMac,
      peer_port: peerPort,
      peer_name: peerName,
    });
  }
  return { nodes, links };
}

function buildPdPortFixture(peers) {
  const chunks = [];
  (peers || []).forEach((p) => {
    const mac = parseMac(p.mac);
    const port = Buffer.from(String(p.port || ''), 'utf8');
    const name = Buffer.from(String(p.name || ''), 'utf8');
    const rec = Buffer.alloc(6 + 1 + port.length + 1 + name.length);
    mac.copy(rec, 0);
    rec[6] = port.length;
    port.copy(rec, 7);
    const nameAt = 7 + port.length;
    rec[nameAt] = name.length;
    name.copy(rec, nameAt + 1);
    chunks.push(rec);
    if (rec.length % 2) chunks.push(Buffer.alloc(1));
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0x020f, 0);
  head.writeUInt16BE(6 + body.length, 2);
  head[4] = 1;
  head[5] = 0;
  head.writeUInt16BE(0, 6);
  head.writeUInt16BE((peers || []).length, 8);
  return Buffer.concat([head, body]);
}

module.exports = {
  ETHERTYPE,
  MULTICAST_MAC,
  FRAME_IDENTIFY_REQ,
  FRAME_GETSET_REQ,
  parseMac,
  formatMac,
  normalizeMac,
  buildIdentifyAll,
  buildSetName,
  buildSetIp,
  buildCombinedSet,
  buildSignal,
  parseIdentifyResponse,
  parseSetResponse,
  decodeVisible,
  stationNameError,
  isUnbaptized,
  parsePdPortDataReal,
  buildPdPortFixture,
};
